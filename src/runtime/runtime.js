import { randomUUID, createHash } from 'node:crypto';
import { ERROR_CODES, SwarmEnvError } from '../errors.js';
import { makeEnvelope } from '../protocol/envelope.js';
import { assertNewExecutionWork } from '../task/execution-budget.js';
import { BOT_COMPACTION_MESSAGE, buildBotNotification, buildBotContinuationMessage } from '../agent/bot-contract.js';
import { ExecutionWorkspace } from './execution-workspace.js';
import { publishWorkspace } from './workspace-publication.js';

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `${field} is required`);
  return value;
}

function operationId(prefix) {
  return `runtime:${prefix}:${randomUUID()}`;
}

const DEFAULT_WATCHDOG_TIMEOUT_MS = 120_000;
const DEFAULT_EXECUTION_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_HANDOFF_REMINDER_MS = 55 * 60 * 1000;

const ACTIVE_SESSION_PHASES = new Set(['turn', 'provider_retry', 'compaction']);

function classifySessionFailure(record) {
  if (record?.type === 'auto_retry_end' && record.success === false) {
    return /context|token|length/i.test(String(record.finalError ?? record.errorMessage ?? '')) ? 'context_overflow' : 'provider_failure';
  }
  if (record?.type === 'compaction_end' && !record.result && !record.aborted) return 'compaction_failure';
  if (record?.type === 'message_end') {
    const message = record.message ?? {};
    const error = String(message.errorMessage ?? message.error ?? '');
    if (/context|token|length/i.test(error)) return 'context_overflow';
  }
  return null;
}

function finitePositive(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function contextWindowRatio(record, session) {
  const usage = record?.usage ?? record?.result?.usage ?? record?.data?.usage ?? record?.message?.usage ?? {};
  const contextUsage = record?.contextUsage ?? record?.context_usage ?? record?.data?.contextUsage ?? null;
  const contextWindow = finitePositive(
    record?.context_window ?? record?.contextWindow ?? record?.model?.contextWindow ??
    record?.data?.model?.contextWindow ?? contextUsage?.contextWindow ?? contextUsage?.context_window ??
    session?.contextWindow,
  );
  const percent = Number.isFinite(contextUsage?.percent) ? contextUsage.percent : null;
  const tokens = finitePositive(
    record?.tokens ?? record?.token_count ?? record?.context_tokens ??
    record?.input_tokens ?? record?.result?.tokensBefore ?? record?.result?.tokens_before ??
    record?.tokensBefore ?? record?.tokens_before ?? contextUsage?.tokens ??
    usage.tokens ?? usage.total_tokens ?? usage.totalTokens ?? usage.input_tokens ??
    usage.prompt_tokens ?? usage.input,
  );
  if (contextWindow === null || tokens === null) {
    // Pi 1.3.0's get_session_stats may report only a percentage; a percentage
    // is still authoritative for the current window ratio.
    if (percent !== null) return { ratio: percent / 100, tokens: null, context_window: contextWindow, percent };
    return null;
  }
  return { ratio: tokens / contextWindow, tokens, context_window: contextWindow, ...(percent === null ? {} : { percent }) };
}

export class Runtime {
  constructor({ taskService, contextService, workspaceManager, missionWorkspace = null, missionWorkspaceId = null, missionSubmissionStore = null, workspaceProjectCheck = false, coordinationPermissions = [], workspaceMergeChecker = null, sandboxManager = null, maxWorkers = 1, coreIds = null, runtimeGeneration = 1, actorRef = 'runtime:local', logger = null, finishCleanupRetryMs = 1000, maxFinishCleanupRetries = 3, maxCompactions = 3, handoffWindowRatio = 0.8, watchdogTimeoutMs = DEFAULT_WATCHDOG_TIMEOUT_MS, executionTimeoutMs = DEFAULT_EXECUTION_TIMEOUT_MS, handoffReminderMs = DEFAULT_HANDOFF_REMINDER_MS, runDeadlineAt = null, clock = () => Date.now(), onCoreEvent = null }) {
    this.taskService = taskService;
    this.contextService = contextService;
    this.workspaceManager = workspaceManager;
    // Public Workspace revisions and final submission are Runtime-owned.
    this.missionWorkspace = missionWorkspace;
    this.missionWorkspaceId = missionWorkspaceId;
    this.workspaceProjectCheck = workspaceProjectCheck;
    this.missionSubmissionStore = missionSubmissionStore;
    this.coordinationPermissions = Object.freeze([...coordinationPermissions]);
    if (workspaceMergeChecker && (typeof workspaceMergeChecker.check !== 'function' ||
        !['checker_ref', 'checker_version', 'environment_ref'].every(key => typeof workspaceMergeChecker.identity?.[key] === 'string' && workspaceMergeChecker.identity[key]) ||
        !Number.isFinite(workspaceMergeChecker.timeoutMs) || workspaceMergeChecker.timeoutMs <= 0)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Workspace merge checker requires fixed identity and a positive timeout');
    }
    this.workspaceMergeChecker = workspaceMergeChecker ? { identity: Object.freeze(structuredClone(workspaceMergeChecker.identity)),
      timeoutMs: workspaceMergeChecker.timeoutMs, check: workspaceMergeChecker.check.bind(workspaceMergeChecker) } : null;
    this.activeWorkspaceCheck = null;
    this.sandboxManager = sandboxManager;
    this.executionWorkspace = missionWorkspace && sandboxManager ? new ExecutionWorkspace({ taskService, contextService, workspace: missionWorkspace, sandboxManager,
      guard: (identity, options) => this.#guardExecutionWorkspace(identity, options), onPending: id => this.#scheduleWorkspaceReconcile(id) }) : null;
    if (missionWorkspace && missionWorkspaceId) {
      taskService.setWorkspaceDeliveryReader(({ missionId, workspaceId, revision }) => workspaceId === missionWorkspaceId
        ? missionWorkspace.readDeliveryRevision({ workspaceId, missionId, revision }) : null);
    }
    this.maxWorkers = maxWorkers;
    this.runtimeGeneration = runtimeGeneration;
    this.actorRef = actorRef;
    this.logger = logger;
    if (!Number.isFinite(finishCleanupRetryMs) || finishCleanupRetryMs <= 0) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'finishCleanupRetryMs must be positive');
    if (!Number.isInteger(maxFinishCleanupRetries) || maxFinishCleanupRetries < 0) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'maxFinishCleanupRetries must be a non-negative integer');
    this.finishCleanupRetryMs = finishCleanupRetryMs;
    this.maxFinishCleanupRetries = maxFinishCleanupRetries;
    this.finishCleanupTimers = new Map();
    if (!Number.isInteger(maxCompactions) || maxCompactions < 0) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'maxCompactions must be a non-negative integer');
    if (!Number.isFinite(handoffWindowRatio) || handoffWindowRatio <= 0 || handoffWindowRatio > 1) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'handoffWindowRatio must be greater than 0 and at most 1');
    this.maxCompactions = maxCompactions;
    this.handoffWindowRatio = handoffWindowRatio;
    this.watchdogTimeoutMs = watchdogTimeoutMs;
    if (!Number.isFinite(executionTimeoutMs) || executionTimeoutMs <= 0) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'executionTimeoutMs must be positive');
    if (!Number.isFinite(handoffReminderMs) || handoffReminderMs <= 0 || handoffReminderMs >= executionTimeoutMs) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'handoffReminderMs must be positive and less than executionTimeoutMs');
    this.executionTimeoutMs = executionTimeoutMs;
    this.handoffReminderMs = handoffReminderMs;
    this.setRunDeadline(runDeadlineAt);
    this.clock = clock;
    this.onCoreEvent = onCoreEvent;
    this.activeProcesses = new Map();
    this.botBindings = new Map();
    this.workspaceReconcileTimers = new Map();
    this.botStopPromises = new Map();
    this.coreStates = new Map();
    // Compaction count belongs to the reusable identity/lane, not to one
    // Execution. An ordinary Task handoff keeps the count; an explicit
    // identity rotation resets it.
    this.identityCompactionCounts = new Map();
    // Reusable identity Sessions remain owned by Runtime even while no
    // Execution is bound. Shutdown must stop them too.
    this.identitySessions = new Set();
    const configuredCoreIds = Array.isArray(coreIds)
      ? coreIds
      : Array.from({ length: Math.max(0, maxWorkers) }, (_, index) => `core-${index + 1}`);
    for (const coreId of configuredCoreIds) this.registerCore(coreId);
    this.reminderPromises = new Map();
    this.pendingFailurePromises = new Set();
    this.pendingReleasePromises = new Set();
    this.resourceReleasePromises = new Map();
    this.startupPromises = new Set();
    this.stopping = false;
    this.executionStateUnsubscribe = typeof this.taskService?.subscribeExecutionState === 'function'
      ? this.taskService.subscribeExecutionState((event) => this.#onExecutionState(event))
      : null;
    this.notificationUnsubscribe = typeof this.taskService?.subscribeNotifications === 'function'
      ? this.taskService.subscribeNotifications((notification) => this.#onNotification(notification))
      : null;
  }

  startBot(options) {
    return this.#trackStartup(() => this.#startBot(options));
  }

  async #startBot({ missionId, coreId, selectionTimeoutMs = 300_000, maxLifetimeMs = selectionTimeoutMs + this.executionTimeoutMs, startSession, readyTimeoutMs = 30_000 }) {
    if (typeof startSession !== 'function' || !Number.isFinite(selectionTimeoutMs) || selectionTimeoutMs <= 0 || selectionTimeoutMs > 2_147_483_647 ||
        !Number.isFinite(readyTimeoutMs) || readyTimeoutMs <= 0 || !Number.isInteger(maxLifetimeMs) || maxLifetimeMs < 2 || maxLifetimeMs > 2_147_483_647) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Bot requires a Session factory and finite selection and lifetime limits');
    }
    if (this.stopping) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Runtime stopped during Bot startup');
    if (this.getCoreStatus(coreId)?.state !== 'IDLE' || this.taskService.getActiveExecutionForCore(coreId)) {
      throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Core is occupied');
    }
    const startedAt = Date.now();
    const hardDeadlineAt = Math.min(startedAt + maxLifetimeMs, this.runDeadlineAt ?? Infinity);
    if (hardDeadlineAt <= startedAt) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Mission run deadline already elapsed');
    const bot = this.taskService.registerBot({ missionId, coreId, coordinationPermissions: this.coordinationPermissions, selectionDeadline: new Date(Math.min(startedAt + selectionTimeoutMs, hardDeadlineAt)).toISOString(), hardDeadline: new Date(hardDeadlineAt).toISOString() });
    const binding = { botId: bot.bot_id, coreId, session: null, starting: true, selectionTimer: null, hardTimer: null };
    this.botBindings.set(bot.bot_id, binding);
    this.#setCoreState(coreId, { state: 'STARTING', bot_id: bot.bot_id, execution_id: null, task_id: null });
    const controller = new AbortController();
    binding.cancelStartup = () => controller.abort(new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bot startup was stopped'));
    const cancelled = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }));
    void cancelled.catch(() => undefined);
    const stopUnbound = (reason) => {
      const current = this.taskService.getBot(bot.bot_id);
      if (current?.state === 'PREPARING' && current.execution_id) {
        if (binding.closing) return;
        this.#prepareBotExecutionStop(current.execution_id, 'FAILED', reason);
        this.#startFinishCleanup(current.execution_id);
        return;
      }
      if (!current || !['STARTING', 'UNBOUND'].includes(current.state) || current.execution_id) return;
      this.taskService.requestBotStop(bot.bot_id, reason);
      binding.cancelStartup();
      this.#startFinishCleanup(bot.bot_id, 0, true);
    };
    binding.armDeadline = (deadlineAt, reason) => {
      clearTimeout(binding.hardTimer);
      binding.hardTimer = setTimeout(() => {
        const current = this.taskService.getBot(bot.bot_id);
        if (current?.execution_id && ['PREPARING', 'ACTIVE'].includes(current.state)) {
          this.#prepareBotExecutionStop(current.execution_id, 'FAILED', reason);
          this.#startFinishCleanup(current.execution_id);
        } else stopUnbound(reason);
      }, Math.max(1, deadlineAt - Date.now()));
      binding.hardTimer.unref?.();
    };
    binding.armDeadline(hardDeadlineAt, 'bot-lifetime-budget');
    // Selection is capped by the hard deadline. Equal-deadline timers may
    // dispatch in either order, so both must retain the hard-budget reason.
    const selectionStopReason = Date.parse(bot.selection_deadline) === hardDeadlineAt ? 'bot-lifetime-budget' : 'selection-budget';
    binding.selectionTimer = setTimeout(() => stopUnbound(selectionStopReason), Math.max(1, Date.parse(bot.selection_deadline) - Date.now()));
    binding.selectionTimer.unref?.();
    const assertRuntimeStartupOpen = () => {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (this.stopping || Date.now() >= (this.runDeadlineAt ?? Infinity)) {
        throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Runtime stopped during Bot startup');
      }
    };
    const assertStartupAllowed = () => {
      assertRuntimeStartupOpen();
      this.taskService.assertBotStartupAllowed(bot.bot_id);
    };
    const factory = Promise.resolve().then(() => startSession({ bot, signal: controller.signal, assertStartupAllowed,
      onSandboxCreateDispatch: (resource) => {
        assertRuntimeStartupOpen();
        this.taskService.recordBotSandboxDispatch(bot.bot_id,
          { provider: resource.provider, timeoutSeconds: resource.timeout_seconds });
      },
      onSandboxCreateRejected: () => this.taskService.recordBotSandboxRejection(bot.bot_id),
      onSandboxCreated: (resource) => this.taskService.recordBotSandbox(bot.bot_id,
        { provider: resource.provider ?? 'opensandbox', sandboxId: resource.sandbox_id, expiresAt: resource.expires_at }) }));
    const prepared = factory.then((session) => {
      binding.session = session;
      binding.starting = false;
      if (!session || typeof session.stop !== 'function') throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Bot Session must support confirmed stop');
      this.identitySessions.add(session);
      session.on?.('close', () => stopUnbound('process-exited'));
      session.on?.('processError', () => stopUnbound('process-error'));
      return session;
    }, (error) => { binding.starting = false; throw error; });
    // A non-cooperative factory can settle after the caller's deadline. Its
    // late resource still belongs to this retained Bot, never a successor.
    void prepared.then(() => {
      if (controller.signal.aborted) this.#startFinishCleanup(bot.bot_id, 0, true);
    }, () => {
      if (controller.signal.aborted) this.#startFinishCleanup(bot.bot_id, 0, true);
    });
    try {
      const session = await Promise.race([prepared, cancelled]);
      if (session.closed) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bot startup was stopped');
      assertStartupAllowed();
      await Promise.race([(async () => {
        await session.waitForReady({ timeoutMs: readyTimeoutMs });
        assertStartupAllowed();
        await session.setAutoCompaction?.(true);
        assertStartupAllowed();
        await session.setAutoRetry?.(true);
      })(), cancelled]);
      if (session.closed) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bot startup was stopped');
      assertRuntimeStartupOpen();
      const ready = this.taskService.markBotReady(bot.bot_id);
      this.#setCoreState(coreId, { state: 'DISCOVERING', session_id: session.sessionId ?? null });
      return { bot: ready, session };
    } catch (error) {
      this.taskService.requestBotStop(bot.bot_id, 'startup-failed');
      binding.cancelStartup();
      try { await this.releaseBot(bot.bot_id); }
      catch (cleanupError) { this.logger?.append({ event: 'runtime.bot_cleanup_pending', bot_id: bot.bot_id, error_class: cleanupError?.code ?? cleanupError?.name }); }
      throw error;
    }
  }

  async releaseBot(botId) {
    const pending = this.resourceReleasePromises.get(botId);
    if (pending) return pending;
    const release = this.#releaseBotResources(botId).finally(() => this.resourceReleasePromises.delete(botId));
    this.resourceReleasePromises.set(botId, release);
    return release;
  }

  async #releaseBotResources(botId) {
    const bot = this.taskService.getBot(botId);
    const binding = this.botBindings.get(botId);
    if (bot?.state === 'CLOSED' && !binding) return { bot };
    if (!bot || !binding || bot.state !== 'CLOSING' || bot.execution_id) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'unbound Bot cleanup requires its retained resource binding');
    }
    this.#setCoreState(binding.coreId, { state: 'CLOSING' });
    const stoppedSession = binding.session;
    await stoppedSession?.stop?.();
    if (stoppedSession?.closed === false) throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Bot stop was not confirmed');
    const stopped = await this.sandboxManager?.stopExecution(bot.resource_key);
    if (stopped === false && this.taskService.getBot(botId)?.sandbox_create_state === 'UNKNOWN') {
      throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Unknown sandbox creation requires confirmed cleanup');
    }
    if (binding.session !== stoppedSession || this.taskService.getBot(botId).sandbox_id !== bot.sandbox_id) return this.#releaseBotResources(botId);
    if (binding.starting) throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Bot factory has not settled; late resources remain owned');
    const closed = this.taskService.finalizeBotClose(botId);
    clearTimeout(binding.selectionTimer);
    clearTimeout(binding.hardTimer);
    this.identitySessions.delete(binding.session);
    clearTimeout(this.finishCleanupTimers.get(botId));
    this.finishCleanupTimers.delete(botId);
    this.botBindings.delete(botId);
    if (this.getCoreStatus(binding.coreId)?.bot_id === botId) {
      this.#setCoreState(binding.coreId, { state: 'IDLE', bot_id: null, execution_id: null, task_id: null, session_id: null });
    }
    return { bot: closed };
  }

  getActiveProcessCount() {
    return this.activeProcesses.size;
  }

  /**
   * Register a reusable Core with the execution substrate. Core Daemons own
   * discovery and selection; Runtime only records the execution occupancy
   * that follows a successful take.
   */
  registerCore(coreId) {
    const id = requireString(coreId, 'core_id');
    if (!this.coreStates.has(id)) {
      this.coreStates.set(id, {
        core_id: id,
        state: 'IDLE',
        execution_id: null,
        task_id: null,
        session_id: null,
        updated_at: new Date(this.clock()).toISOString(),
      });
    }
    return this.getCoreStatus(id);
  }

  getCoreStatus(coreId) {
    const id = requireString(coreId, 'core_id');
    const state = this.coreStates.get(id);
    if (!state) return null;
    return { ...state };
  }

  listCoreStatus() {
    return [...this.coreStates.values()].map((state) => ({ ...state }));
  }

  /** A Runtime capacity view that never performs Task selection. */
  getCapacityStatus() {
    const cores = this.listCoreStatus();
    return {
      core_count: this.maxWorkers,
      active_core_count: cores.filter((core) => core.state === 'RUNNING').length,
      idle_core_count: cores.filter((core) => core.state === 'IDLE').length,
      cores,
    };
  }

  hasActiveExecution(executionId) {
    return this.activeProcesses.has(executionId);
  }

  async waitForSettled() {
    for (;;) {
      const pending = [...this.pendingFailurePromises, ...this.pendingReleasePromises];
      if (this.activeWorkspaceCheck) pending.push(this.activeWorkspaceCheck.promise);
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  /** Wait until Runtime no longer owns an Execution process. */
  async waitForExecutionRelease(executionId, { timeoutMs = Number.POSITIVE_INFINITY, pollMs = 25, signal = null } = {}) {
    const id = requireString(executionId, 'execution_id');
    if (timeoutMs !== Number.POSITIVE_INFINITY && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'timeoutMs must be non-negative or Infinity');
    if (!Number.isFinite(pollMs) || pollMs <= 0) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'pollMs must be positive');
    const startedAt = this.clock();
    let current = this.taskService.getExecution(id);
    while (this.activeProcesses.has(id) || ['CREATED', 'RUNNING', 'CLOSING'].includes(current?.state)) {
      if (signal?.aborted) return { released: false, aborted: true, execution: current, elapsed_ms: this.clock() - startedAt };
      if (timeoutMs !== Number.POSITIVE_INFINITY && this.clock() - startedAt >= timeoutMs) {
        return { released: false, execution: current, elapsed_ms: this.clock() - startedAt };
      }
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = () => finish();
        const timer = setTimeout(finish, pollMs);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
      current = this.taskService.getExecution(id);
    }
    return { released: true, execution: current, elapsed_ms: this.clock() - startedAt };
  }

  /**
   * Stop every live process owned by this Runtime before its store is closed.
   * The benchmark uses this seam for terminal cleanup so it never has to
   * mutate Runtime ownership maps or recovery flags directly.
   */
  async shutdown({ terminalState = 'FAILED', terminalReason = 'runtime_shutdown' } = {}) {
    this.stopping = true;
    this.activeWorkspaceCheck?.controller.abort();
    for (const entry of this.workspaceReconcileTimers.values()) clearTimeout(entry.timer);
    this.workspaceReconcileTimers.clear();
    for (const timer of this.finishCleanupTimers.values()) clearTimeout(timer);
    this.finishCleanupTimers.clear();
    for (const [botId, binding] of this.botBindings) {
      const bot = this.taskService.getBot(botId);
      if (bot && !['CLOSING', 'CLOSED'].includes(bot.state)) this.taskService.requestBotStop(botId, terminalReason, { terminalState });
      if (!bot?.execution_id) binding.cancelStartup?.();
    }
    const pendingStarts = [...this.startupPromises];
    this.executionStateUnsubscribe?.();
    this.executionStateUnsubscribe = null;
    this.notificationUnsubscribe?.();
    this.notificationUnsubscribe = null;
    const executionIds = [...this.activeProcesses.keys()];
    // A reusable identity Session is intentionally preserved on a normal
    // release, but shutdown owns every live process. Capture them before the
    // release path detaches the Execution binding.
    const ownedSessions = new Set([...this.activeProcesses.values()].map((active) => active.session).filter(Boolean));
    for (const session of this.identitySessions) ownedSessions.add(session);
    const stopOwnedExecution = async executionId => {
      const execution = this.taskService.getExecution(executionId);
      try {
        if (execution && ['CREATED', 'RUNNING'].includes(execution.state)) {
          await this.stopExecution(executionId, terminalState, terminalReason);
        } else {
          await this.releaseExecution(executionId);
        }
      } catch (error) {
        this.logger?.append({ event: 'runtime.shutdown_cleanup_pending', execution_id: executionId, error_class: error?.code ?? error?.name });
      }
    };
    const stoppingExecutions = executionIds.map(stopOwnedExecution);
    const stoppingBots = [...this.botBindings.keys()].map(async botId => {
      const bot = this.taskService.getBot(botId);
      if (bot?.execution_id) return;
      try {
        this.taskService.requestBotStop(botId, terminalReason);
        await this.releaseBot(botId);
      } catch (error) { this.logger?.append({ event: 'runtime.bot_cleanup_pending', bot_id: botId, error_class: error?.code ?? error?.name }); }
    });
    await Promise.allSettled([...pendingStarts, ...stoppingExecutions, ...stoppingBots]);
    // A launch already in flight can register its rejected Session only when
    // it returns. Join and stop that late ownership as well.
    await Promise.allSettled([...this.activeProcesses.keys()].filter(id => !executionIds.includes(id)).map(stopOwnedExecution));
    for (const session of this.identitySessions) ownedSessions.add(session);
    for (const session of ownedSessions) {
      if ([...this.activeProcesses.values()].some((active) => active.session === session)) continue;
      try {
        await session.stop?.();
        if (session.closed === false) throw new Error('Bot process stop was not confirmed');
        this.identitySessions.delete(session);
      } catch (error) {
        this.identitySessions.add(session);
        this.logger?.append({ event: 'runtime.shutdown_session_cleanup_pending', session_id: session.sessionId ?? null, error_class: error?.code ?? error?.name });
      }
    }
    await this.waitForSettled();
    return { active_process_count: this.activeProcesses.size, cleanup_pending_execution_ids: [...this.activeProcesses.keys()], cleanup_pending_session_count: this.identitySessions.size, cleanup_pending_bot_ids: [...this.botBindings.keys()] };
  }

  #guardExecutionWorkspace({ actorRef, taskId, executionId, fencingVersion }, { receiptOnly = false, newWork = false } = {}) {
    const execution = this.taskService.getExecution(executionId);
    if (newWork && execution) this.taskService.assertMissionResearchOpen(this.taskService.getTask(execution.task_id)?.mission_id);
    const bot = this.taskService.getBot(actorRef);
    const task = execution && this.taskService.getTask(execution.task_id);
    if (!bot || !execution || execution.owner_ref !== actorRef || execution.task_id !== taskId ||
        bot.mission_id !== task?.mission_id || execution.workspace_input?.workspace_id !== this.missionWorkspaceId) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Workspace request must match its durable Bot, Task and Mission');
    }
    if (receiptOnly) return execution;
    const binding = this.botBindings.get(actorRef);
    const active = this.activeProcesses.get(executionId);
    if (this.stopping || bot.state !== 'ACTIVE' || bot.execution_id !== executionId || execution.state !== 'RUNNING' ||
        execution.fencing_version !== fencingVersion || !binding || binding.closing || !binding.session || binding.session.closed ||
        !active || active.closing || active.session !== binding.session || execution.core_id !== bot.core_id) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Workspace contribution requires the current active Bot binding');
    }
    this.taskService.assertBotDeadline(actorRef);
    return execution;
  }

  async dispatchExecutionWorkspace(operation, input, identity) {
    if (!this.executionWorkspace) throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Execution Workspace control is unavailable');
    return this.executionWorkspace.dispatch(operation, input, identity);
  }

  async readWorkspaceCheckSource(input, identity) {
    this.#guardExecutionWorkspace(identity);
    const allowed = new Set(['workspace_id', 'revision', 'path', 'request_key', 'check_mode']);
    const checkMode = input?.check_mode ?? 'lean-project';
    const hasPath = input?.path !== undefined;
    if (!input || !['lean-project', 'lean-module'].includes(checkMode) ||
        (checkMode === 'lean-module' && (!this.workspaceProjectCheck || !hasPath || typeof input.path !== 'string' || !input.path.endsWith('.lean'))) ||
        Object.keys(input).some(key => !allowed.has(key)) || !/^\d+\.\d+$/.test(input.revision ?? '') ||
        (!hasPath && !this.workspaceProjectCheck) ||
        (hasPath && (typeof input.path !== 'string' || !input.path || input.path.startsWith('/') || input.path.includes('\\') || input.path.split('/').some(part => !part || part === '.' || part === '..')))) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, this.workspaceProjectCheck
        ? 'Judge check requires a fixed public revision and a valid optional file path; save the project first'
        : 'Judge check requires a fixed public revision and path; save the project first');
    }
    if (input.workspace_id !== undefined && input.workspace_id !== this.missionWorkspaceId) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Judge input must belong to the Bot Mission Workspace');
    if (this.workspaceProjectCheck) return { workspace_id: this.missionWorkspaceId, revision: input.revision,
      ...(hasPath ? { path: input.path } : {}), check_mode: checkMode };
    const snapshot = await this.missionWorkspace.exportRevision({ workspaceId: this.missionWorkspaceId, revision: input.revision });
    this.#guardExecutionWorkspace(identity);
    if (!Object.hasOwn(snapshot.files, input.path)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Judge file is unavailable at the fixed public revision');
    const bytes = Buffer.from(snapshot.files[input.path]);
    const content = bytes.toString('utf8');
    if (!Buffer.from(content).equals(bytes) || bytes.includes(0)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Configured source checker requires a complete UTF-8 text file');
    return { workspace_id: snapshot.workspace_id, revision: snapshot.revision, workspace_revision: snapshot.revision,
      path: input.path, content, content_hash: createHash('sha256').update(bytes).digest('hex'),
      git_commit: snapshot.git_commit, git_tree: snapshot.git_tree, tree_content_hash: snapshot.content_hash };
  }

  #scheduleWorkspaceReconcile(executionId, attempt = 0) {
    if (this.stopping || this.workspaceReconcileTimers.has(executionId)) return;
    const reconcile = async () => {
      let retry = false;
      try { await this.executionWorkspace.reconcile(executionId); }
      catch (error) {
        this.logger?.append({ event: 'runtime.workspace_apply_pending', execution_id: executionId, attempt, error_class: error.code ?? error.name });
        if (attempt < 10) retry = true;
        else {
          try { await this.stopExecution(executionId, 'FAILED', 'workspace_apply_reconciliation_failed'); }
          catch (stopError) { this.logger?.append({ event: 'runtime.workspace_apply_cleanup_pending', execution_id: executionId, error_class: stopError.code ?? stopError.name }); }
        }
      } finally {
        this.workspaceReconcileTimers.delete(executionId);
        if (retry) this.#scheduleWorkspaceReconcile(executionId, attempt + 1);
      }
    };
    const entry = { timer: null };
    entry.timer = setTimeout(() => {
      const pending = reconcile().finally(() => this.pendingReleasePromises.delete(pending));
      this.pendingReleasePromises.add(pending);
      pending.catch(() => {});
    }, 1000);
    this.workspaceReconcileTimers.set(executionId, entry);
  }

  async mergeExecutionWorkspace(input, identity) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'from') || !/^\d+\.\d+$/.test(input.from ?? '')) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Workspace merge requires --from a fixed public revision');
    }
    if (typeof identity.requestId !== 'string' || !identity.requestId) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Merge requires a stable request ID');
    const initial = this.#guardExecutionWorkspace(identity, { receiptOnly: true });
    const task = this.taskService.getTask(initial.task_id);
    const requiredCheck = this.taskService.getMission(task.mission_id).merge_required_check;
    const delivery = task.completion_contract?.workspace_delivery;
    const deliveryCheck = delivery?.require_main ? delivery.check : null;
    const adapter = this.workspaceMergeChecker;
    const requirements = [requiredCheck, deliveryCheck].filter(value => value !== undefined && value !== null);
    const unavailableCheck = requirements.some(requirement => !requirement || typeof requirement !== 'object' || Array.isArray(requirement) ||
      !requirement.checker_ref || !requirement.checker_version || !adapter || Object.entries(requirement).some(([key, value]) => adapter.identity[key] !== value));
    const checkPolicy = { policy_version: 'workspace-merge-v2', mission: requiredCheck ?? null,
      task: { spec_version: task.spec_version, delivery_check: deliveryCheck ?? null }, configured: requirements.length ? adapter?.identity ?? null : null };
    const guard = () => {
      const execution = this.#guardExecutionWorkspace(identity, { newWork: true });
      assertNewExecutionWork(execution);
      return execution;
    };
    return this.missionWorkspace.merge({ workspaceId: this.missionWorkspaceId, fromRevision: input.from,
      requestId: `execution:${identity.executionId}:merge:${identity.requestId}`,
      source: { operation: 'merge', mission_id: task.mission_id, task_id: task.task_id, execution_id: initial.execution_id, bot_id: initial.owner_ref, fencing_version: identity.fencingVersion },
      checkPolicy, guard,
      checker: unavailableCheck ? async () => { throw new SwarmEnvError(ERROR_CODES.SERVICE_NOT_READY, 'Mission or Task requires an unavailable trusted final-tree checker', { policy: checkPolicy }); } : requirements.length ? async plan => {
        const execution = guard();
        if (this.activeWorkspaceCheck) throw new SwarmEnvError(ERROR_CODES.WORKSPACE_BUSY, 'Previous final-tree checker has not confirmed completion; use a new attempt after it settles');
        const remaining = Math.min(adapter.timeoutMs, Date.parse(execution.handoff_deadline ?? execution.execution_deadline) - Date.now());
        if (!Number.isFinite(remaining) || remaining <= 0) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'No final-tree check budget remains');
        const controller = new AbortController();
        const deadline = Date.now() + remaining;
        // Timeout requests cancellation. The slot and shutdown join retain
        // the checker until its promise confirms resource cleanup.
        const check = Promise.resolve().then(() => adapter.check({
          ...plan, signal: controller.signal, identity: adapter.identity,
          source: { task_id: task.task_id, execution_id: initial.execution_id }, deadline,
          startProcess: launch => this.taskService.withServiceLifecycleWrite(() => {
            guard();
            return launch();
          }),
        }));
        const active = { controller, promise: check.finally(() => {
          if (this.activeWorkspaceCheck === active) this.activeWorkspaceCheck = null;
        }) };
        this.activeWorkspaceCheck = active;
        let timer;
        try {
          const result = await Promise.race([active.promise,
            new Promise((_, reject) => { timer = setTimeout(() => { reject(new SwarmEnvError('SERVICE_TIMEOUT', 'Final-tree check exceeded its deadline')); controller.abort(); }, remaining); })]);
          if (Date.now() >= deadline) throw new SwarmEnvError('SERVICE_TIMEOUT', 'Final-tree check exceeded its deadline');
          if (result?.check_mode === 'lean-module' || result?.scope === 'module') {
            throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Workspace merge requires a complete check; module-scoped evidence is insufficient');
          }
          const checkedPaths = Array.isArray(result?.checked_paths) ? result.checked_paths : [];
          return { verdict: result?.verdict, check_result_id: typeof result?.check_result_id === 'string' ? result.check_result_id.slice(0, 256) : null,
            diagnostic: typeof result?.diagnostic === 'string' ? result.diagnostic.slice(0, 2048) : null,
            ...(result?.check_mode === 'lean-project' ? { check_mode: result.check_mode, checked_count: checkedPaths.length, checked_paths: checkedPaths } : {}),
            checked_tree: plan.tree, checker: adapter.identity, policy: checkPolicy };
        } finally { clearTimeout(timer); }
      } : null,
      withPublication: publish => publishWorkspace(this.taskService.db, publish),
    });
  }

  async submitMission(input = {}) {
    if (!this.missionSubmissionStore) throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Mission submission is not enabled');
    return this.missionSubmissionStore.submit(input);
  }

  async describeMissionSubmission({ missionId, submissionId = null }) {
    if (!this.missionSubmissionStore) throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Mission submission is not enabled');
    return this.missionSubmissionStore.describe({ missionId, submissionId, workspaceId: this.missionWorkspaceId,
      isStopped: () => this.stopping || this.clock() >= (this.runDeadlineAt ?? Infinity) || this.taskService.isMissionStopped(missionId) });
  }

  async #ensureSandbox(execution, workspace) {
    if (!this.sandboxManager) return;
    const bot = this.taskService.getBot(execution.owner_ref);
    if (!bot || !workspace?.public_workspace_input) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bot Sandbox preparation requires pinned public Workspace input');
    if (bot.execution_id !== execution.execution_id) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bot does not own this Execution');
    this.sandboxManager.bindBotExecution({ botId: bot.bot_id, executionId: execution.execution_id,
      workspaceRef: workspace.workspace_ref, bindingVersion: execution.fencing_version });
    await this.sandboxManager.syncWorkspace({ executionId: execution.execution_id, workspaceRef: workspace.workspace_ref, manifest: workspace.public_workspace_input.manifest });
    await this.sandboxManager.prepareBotProject({ executionId: execution.execution_id, manifest: workspace.public_workspace_input.manifest });
  }

  async #stopSandbox(executionId) {
    if (!this.sandboxManager || !executionId) return;
    try {
      await this.sandboxManager.stopExecution(executionId);
    } catch (error) {
      this.logger?.append({ event: 'runtime.sandbox_stop_error', execution_id: executionId, error_class: error?.code ?? error?.name ?? 'sandbox_stop_error' });
      throw error;
    }
  }

  #trackStartup(start) {
    if (this.stopping) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Runtime is stopping');
    const starting = start().finally(() => this.startupPromises.delete(starting));
    this.startupPromises.add(starting);
    return starting;
  }

  async bindAgentExecution(...args) {
    return this.#trackStartup(() => this.#bindAgentExecution(...args));
  }

  async #bindAgentExecution(executionId, session = null, { workspaceRef, coreId = null } = {}) {
    this.logger?.append({ event: 'runtime.bind_execution', execution_id: executionId });
    if (!session || typeof session.stop !== 'function') {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Original Bot Session is required');
    }
    const execution = this.#getExecution(executionId);
    if (execution.state !== 'CREATED') throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `Runtime can only bind CREATED executions, got ${execution.state}`);
    if (this.activeProcesses.size >= this.maxWorkers) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Runtime capacity is exhausted');
    const selectedCoreId = this.#resolveCoreId(execution, coreId);
    this.#assertCoreAvailable(selectedCoreId, execution.execution_id);
    let workspace = null;
    let current = execution;
    const registeredBot = this.taskService.getBot(execution.owner_ref);
    if (!registeredBot) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Execution startup requires a registered Bot');
    if (this.botBindings.get(registeredBot.bot_id)?.session !== session || registeredBot.core_id !== selectedCoreId) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Task take must bind its original Bot Session and Core');
    }
    const boundSession = session;
    let preparationLeaseTimer = null;
    let preparationLeaseError = null;
    const renewPreparationLease = () => {
      this.taskService.assertMissionResearchOpen(registeredBot.mission_id);
      this.taskService.assertBotDeadline(registeredBot.bot_id);
      const owner = this.taskService.getBot(registeredBot.bot_id);
      const reserved = this.#getExecution(executionId);
      if (this.stopping || owner?.state !== 'PREPARING' || owner.execution_id !== executionId ||
          reserved.state !== 'CREATED' || reserved.fencing_version !== execution.fencing_version) {
        throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bot preparation no longer owns its reservation');
      }
      this.heartbeat(executionId);
    };
    try {
      renewPreparationLease();
      preparationLeaseTimer = setInterval(() => {
        try { renewPreparationLease(); }
        catch (error) {
          preparationLeaseError = error;
          clearInterval(preparationLeaseTimer);
        }
      }, 10_000);
      workspace = await this.#prepareWorkspace(execution, workspaceRef);
      if (preparationLeaseError) throw preparationLeaseError;
      current = this.#getExecution(executionId);
      current = this.#saveWorkspaceReference(current, workspace);
      const bot = this.taskService.getBot(current.owner_ref);
      if (bot) {
        const retained = this.botBindings.get(bot.bot_id);
        if (!retained || retained.session !== boundSession || bot.core_id !== selectedCoreId || bot.state !== 'PREPARING') {
          throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Task take must bind its original Bot Session and Core');
        }
        clearTimeout(retained.selectionTimer);
        await this.#ensureSandbox(current, workspace);
        if (retained.closing || boundSession.closed || this.stopping || this.taskService.getBot(bot.bot_id)?.state !== 'PREPARING') {
          throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bot stopped during Task preparation');
        }
      }
      if (preparationLeaseError) throw preparationLeaseError;
      renewPreparationLease();
      clearInterval(preparationLeaseTimer);
      current = this.#getExecution(executionId);
      current = this.taskService.dispatch('start_execution', {
        ...this.#executionTimingPayload(this.clock(), current),
        ...(selectedCoreId ? { core_id: selectedCoreId } : {}),
      }, this.#executionEnvelope(current, operationId('bind'))).execution;
      if (bot) this.botBindings.get(bot.bot_id).armDeadline(Date.parse(current.execution_deadline),
        Date.parse(current.execution_deadline) < Date.parse(bot.hard_deadline) ? 'execution-timebox' : 'bot-lifetime-budget');
      if (bot && workspace.public_workspace_input && this.sandboxManager) {
        this.taskService.assertMissionResearchOpen(bot.mission_id);
        this.taskService.assertBotDeadline(bot.bot_id);
        await this.sandboxManager.grantBotProject({ executionId: current.execution_id });
        const latestBot = this.taskService.getBot(bot.bot_id);
        if (latestBot.state !== 'ACTIVE' || this.botBindings.get(bot.bot_id)?.closing || boundSession.closed || this.stopping) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bot stopped during project grant');
        this.taskService.assertMissionResearchOpen(bot.mission_id);
        this.taskService.assertBotDeadline(bot.bot_id);
      }
      if (this.stopping) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Runtime stopped during startup');
      this.#registerActiveProcess(current, workspace, boundSession, { coreId: selectedCoreId });
      // Selection already started the Bot turn. Deliver pending Task notices
      // after that turn settles using the existing Session queue.
      this.#queuePendingNotifications(this.activeProcesses.get(current.execution_id));
      return { execution: current, workspace, session: boundSession };
    } catch (error) {
      await this.stopExecution(executionId, 'FAILED', 'bind_prepare_failed');
      throw error;
    } finally {
      clearInterval(preparationLeaseTimer);
    }
  }

  /**
   * Reconcile durable Execution deadlines. The sweep is intentionally
   * idempotent: the reminder is persisted before it is sent, and timeout is a
   * durable Bot stop. Maintenance may call this on every poll.
   */
  async sweepExecutionTimeouts(at = new Date(this.clock()), { executionIds = null } = {}) {
    const atDate = at instanceof Date ? at : new Date(at);
    if (Number.isNaN(atDate.getTime())) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'timeout sweep time must be a valid Date');
    const executionFilter = executionIds === null ? null : new Set(executionIds);
    const events = [];
    for (const execution of this.taskService.listActiveExecutions()) {
      if (executionFilter && !executionFilter.has(execution.execution_id)) continue;
      if (!['CREATED', 'RUNNING'].includes(execution.state)) continue;
      const bot = this.taskService.getBot(execution.owner_ref);
      if (!bot || !this.botBindings.has(bot.bot_id)) continue;
      const startedMs = Date.parse(execution.started_at ?? '');
      if (Number.isNaN(startedMs)) continue;
      const reminderMs = Date.parse(execution.handoff_deadline ?? '') || startedMs + this.handoffReminderMs;
      const timeoutMs = Date.parse(execution.execution_deadline ?? '') || startedMs + this.executionTimeoutMs;
      if (atDate.getTime() >= timeoutMs) {
        const reason = Date.parse(bot.hard_deadline) <= atDate.getTime() ? 'bot-lifetime-budget' : 'execution-timebox';
        const result = await this.stopExecution(execution.execution_id, 'FAILED', reason);
        events.push({ kind: 'timeout', ...result });
      } else if (atDate.getTime() >= reminderMs && !execution.handoff_reminder_sent_at) {
        const reminder = await this.#sendHandoffReminder(execution.execution_id, atDate);
        if (reminder) events.push(reminder);
      }
    }
    return events;
  }

  async #sendHandoffReminder(executionId, at) {
    const inFlight = this.reminderPromises.get(executionId);
    if (inFlight) return inFlight;
    const promise = (async () => {
      const execution = this.#getExecution(executionId);
      if (!['CREATED', 'RUNNING'].includes(execution.state) || execution.handoff_reminder_sent_at) return null;
      const marked = this.taskService.dispatch('record_handoff_reminder', {
        reminded_at: new Date(at.getTime()).toISOString(),
      }, this.#executionEnvelope(execution, `runtime:handoff-reminder:${executionId}:${execution.state_version}`));
      const active = this.activeProcesses.get(executionId);
      if (active) active.execution = marked.execution;
      const task = this.taskService.getTask(execution.task_id);
      let notification = null;
      if (task?.mission_id && typeof this.taskService.enqueueNotification === 'function') {
        notification = this.taskService.enqueueNotification({
          deliveryKey: `handoff_warning:${executionId}:${marked.execution.execution_deadline ?? marked.execution.handoff_deadline ?? at.toISOString()}`,
          missionId: task.mission_id,
          recipientTaskId: task.task_id,
          recipientExecutionId: executionId,
          type: 'handoff_warning',
          payload: { execution_id: executionId, deadline: marked.execution.execution_deadline ?? null },
        });
        if (active) await active.promptChain.catch(() => undefined);
      }
      this.logger?.append({ event: 'runtime.handoff_reminder', execution_id: executionId, handoff_deadline: marked.execution.handoff_deadline ?? null });
      return { kind: 'handoff_reminder', execution: marked.execution, notification };
    })();
    this.reminderPromises.set(executionId, promise);
    try {
      return await promise;
    } finally {
      this.reminderPromises.delete(executionId);
    }
  }

  getSessionHealth(executionId) {
    const active = this.activeProcesses.get(executionId);
    if (!active) return null;
    return {
      execution_id: executionId,
      session_id: active.session?.sessionId ?? null,
      phase: active.closing ? 'closing' : active.phase,
      last_event_at: Number.isFinite(active.lastEventAt) ? new Date(active.lastEventAt).toISOString() : null,
      last_heartbeat_at: active.lastHeartbeatAt ? new Date(active.lastHeartbeatAt).toISOString() : null,
      last_completed_turn_at: active.lastCompletedTurnAt ? new Date(active.lastCompletedTurnAt).toISOString() : null,
      last_productive_at: Number.isFinite(active.lastProductiveAt) ? new Date(active.lastProductiveAt).toISOString() : null,
      last_failure_class: active.lastFailureClass,
    };
  }

  async sweepWatchdog(at = new Date(this.clock())) {
    const recovered = [];
    for (const [executionId, active] of [...this.activeProcesses.entries()]) {
      const execution = this.taskService.getExecution(executionId);
      if (active.closing || !execution || execution.state !== 'RUNNING' || ACTIVE_SESSION_PHASES.has(active.phase)) continue;
      if (at.getTime() - active.lastProductiveAt < this.watchdogTimeoutMs) continue;
      recovered.push(await this.#handleSessionFailure(executionId, 'watchdog_stall'));
    }
    return recovered.filter(Boolean);
  }

  heartbeat(executionId, payload = {}) {
    this.logger?.append({ event: 'runtime.heartbeat', execution_id: executionId });
    const execution = this.#getExecution(executionId);
    if (this.activeProcesses.get(executionId)?.closing) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Closing Execution cannot renew its lease');
    const result = this.taskService.dispatch('heartbeat', payload, this.#executionEnvelope(execution, operationId('heartbeat')));
    const active = this.activeProcesses.get(executionId);
    if (active) {
      active.execution = result.execution;
      active.lastHeartbeatAt = this.clock();
    }
    return result;
  }

  #prepareBotExecutionStop(executionId, terminalState, reason, { leaseExpiredAt = null } = {}) {
    const execution = this.#getExecution(executionId);
    const bot = this.taskService.getBot(execution.owner_ref);
    if (!bot) return;
    if (bot.state !== 'CLOSED' && !this.botBindings.has(bot.bot_id)) {
      throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Persisted Bot has no in-process resource owner; isolation remains unconfirmed');
    }
    const intent = this.taskService.requestBotStop(bot.bot_id, reason, { terminalState, leaseExpiredAt });
    if (!intent) return null;
    const binding = this.botBindings.get(bot.bot_id);
    if (binding) {
      binding.closing = true;
      this.#retainCleanupBinding(executionId, { session: binding.session, workspace: null, coreId: binding.coreId });
    }
    return intent;
  }

  async stopExecution(executionId, terminalState = 'CANCELLED', terminalReason = null) {
    if (this.botStopPromises.has(executionId)) return this.botStopPromises.get(executionId);
    const stopping = this.#stopExecution(executionId, terminalState, terminalReason).finally(() => this.botStopPromises.delete(executionId));
    this.botStopPromises.set(executionId, stopping);
    return stopping;
  }

  async #stopExecution(executionId, terminalState, terminalReason) {
    let reason = terminalReason ?? terminalState.toLowerCase();
    const intent = this.#prepareBotExecutionStop(executionId, terminalState, reason);
    terminalState = intent?.stop_terminal_state ?? terminalState;
    reason = intent?.stop_terminal_state ? intent.exit_reason : reason;
    this.logger?.append({ event: 'runtime.stop_execution', execution_id: executionId, terminal_state: terminalState, terminal_reason: reason });
    let execution = this.#getExecution(executionId);
    const active = this.activeProcesses.get(executionId);
    if (active) {
      // Drain ownership writes before fencing/releasing the Workspace.
      active.closing = true;
      await this.#drainCompactionFollowup(active);
      execution = this.#getExecution(executionId);
    }
    await this.#stopExecutionResources(executionId);
    await this.executionWorkspace?.reconcile(executionId, { closedConfirmed: true });
    execution = this.#getExecution(executionId);
    const result = ['CREATED', 'RUNNING'].includes(execution.state) ? this.taskService.dispatch('stop_execution', {
      terminal_state: terminalState,
      terminal_reason: reason,
    }, this.#executionEnvelope(execution, operationId('stop'))) : { execution };
    await this.releaseExecution(executionId);
    return result;
  }

  /** Stop resources, finalize any accepted finish, then release the Core. */
  async releaseExecution(executionId) {
    const id = requireString(executionId, 'execution_id');
    const pending = this.resourceReleasePromises.get(id);
    if (pending) return pending;
    const release = this.#releaseExecutionResources(id).finally(() => this.resourceReleasePromises.delete(id));
    this.resourceReleasePromises.set(id, release);
    return release;
  }

  #retainCleanupBinding(id, { session = null, workspace = null, coreId = null } = {}) {
    const execution = this.#getExecution(id);
    const active = this.activeProcesses.get(id) ?? { execution, session, workspace, coreId };
    active.closing = true;
    this.activeProcesses.set(id, active);
    if (this.#canUpdateExecutionCore(active.coreId, execution)) this.#setCoreState(active.coreId, { state: 'CLOSING', execution_id: id, task_id: execution.task_id, session_id: active.session?.sessionId ?? null });
  }

  async #stopExecutionResources(id) {
    const active = this.activeProcesses.get(id);
    const bot = this.taskService.getBot(this.#getExecution(id).owner_ref);
    const retainedBot = bot ? this.botBindings.get(bot.bot_id) : null;
    if (bot && bot.state !== 'CLOSED' && !retainedBot) {
      throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Persisted Bot has no in-process resource owner; isolation remains unconfirmed');
    }
    if (retainedBot) retainedBot.closing = true;
    if (active) {
      active.closing = true;
      if (this.#canUpdateExecutionCore(active.coreId, this.#getExecution(id))) this.#setCoreState(active.coreId, { state: 'CLOSING' });
      await this.#drainCompactionFollowup(active);
      await this.#releaseSessionBinding(active, id);
    }
    if (retainedBot?.session && retainedBot.session !== active?.session) {
      await retainedBot.session.stop();
      if (retainedBot.session.closed === false) throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Bot stop was not confirmed');
      this.identitySessions.delete(retainedBot.session);
    }
    await this.#stopSandbox(id);
    if (bot) await this.sandboxManager?.stopExecution(bot.resource_key);
  }

  async #releaseExecutionResources(id) {
    const before = this.#getExecution(id);
    if (before.state === 'CLOSING' && !this.activeProcesses.has(id)) {
      throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'closing Execution requires resource reconciliation before release');
    }
    await this.#stopExecutionResources(id);
    await this.executionWorkspace?.reconcile(id, { closedConfirmed: true });
    if (this.#getExecution(id).state === 'CLOSING') {
      if (!this.activeProcesses.has(id)) {
        throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'closing Execution requires resource reconciliation before release');
      }
      // Finish may commit while a pre-existing release awaits the provider.
      // Recheck it after stopping, including a reusable Session.
      if (before.state !== 'CLOSING') await this.#stopExecutionResources(id);
      this.taskService.finalizeExecutionFinish(id, { fencingVersion: this.#getExecution(id).fencing_version });
    }
    const execution = this.#getExecution(id);
    const active = this.activeProcesses.get(id);
    if (execution.workspace_ref) {
      const workspace = await this.workspaceManager.restoreWorkspace({ workspaceRef: execution.workspace_ref, executionId: id });
      if (workspace.fencing_version < execution.fencing_version) {
        await this.workspaceManager.fenceWorkspace({ workspaceRef: execution.workspace_ref, executionId: id,
          fencingVersion: workspace.fencing_version, newFencingVersion: execution.fencing_version });
      }
      await this.workspaceManager.releaseWorkspace({
        workspaceRef: execution.workspace_ref,
        executionId: id,
        fencingVersion: execution.fencing_version,
      });
    }
    // Workspace I/O also yields: a finish accepted during that interval must
    // complete before the final synchronous removal of this Core binding.
    if (this.#getExecution(id).state === 'CLOSING') return this.#releaseExecutionResources(id);
    const bot = this.taskService.getBot(execution.owner_ref);
    if (bot && bot.state !== 'CLOSED') {
      this.taskService.requestBotStop(bot.bot_id, execution.terminal_reason ?? 'execution-closed');
      this.taskService.finalizeBotClose(bot.bot_id);
      this.identitySessions.delete(this.botBindings.get(bot.bot_id)?.session);
      clearTimeout(this.botBindings.get(bot.bot_id)?.selectionTimer);
      clearTimeout(this.botBindings.get(bot.bot_id)?.hardTimer);
      this.botBindings.delete(bot.bot_id);
      if (this.getCoreStatus(bot.core_id)?.bot_id === bot.bot_id) this.#setCoreState(bot.core_id, { state: 'IDLE', bot_id: null, execution_id: null, task_id: null, session_id: null });
    }
    // Retain the binding and Core on any cleanup failure. A retry must still
    // know which resources it owns, and no successor may use this slot yet.
    if (active && this.activeProcesses.get(id) === active) {
      clearTimeout(this.finishCleanupTimers.get(id));
      this.finishCleanupTimers.delete(id);
      this.activeProcesses.delete(id);
      if (this.#canUpdateExecutionCore(active.coreId, execution)) this.#setCoreState(active.coreId, { state: 'IDLE', bot_id: null, execution_id: null, task_id: null, session_id: null });
    }
    this.sandboxManager?.forgetBotProjectInstalls?.({ executionId: id });
    return { execution };
  }

  async fenceExecution(executionId, { reason = 'fenced' } = {}) {
    this.logger?.append({ event: 'runtime.fence_execution', execution_id: executionId, terminal_reason: reason });
    let execution = this.#getExecution(executionId);
    this.#prepareBotExecutionStop(executionId, 'FAILED', reason);
    const activeBeforeFence = this.activeProcesses.get(executionId);
    if (activeBeforeFence) {
      activeBeforeFence.closing = true;
      this.#setCoreState(activeBeforeFence.coreId, { state: 'CLOSING' });
    }
    await this.#drainCompactionFollowup(activeBeforeFence);
    await this.#stopExecutionResources(executionId);
    await this.executionWorkspace?.reconcile(executionId, { closedConfirmed: true });
    execution = this.#getExecution(executionId);
    if (!['CREATED', 'RUNNING'].includes(execution.state)) return this.releaseExecution(executionId);
    const result = this.taskService.dispatch('fence_execution', {
      runtime_generation: this.runtimeGeneration,
      terminal_reason: reason,
    }, this.#executionEnvelope(execution, operationId('fence')));
    await this.#fenceWorkspaceBestEffort(execution, {
      newFencingVersion: result.execution.fencing_version,
      event: 'runtime.fence_workspace_error',
    });
    await this.releaseExecution(executionId);
    return result;
  }

  async sweepExpired(at = new Date()) {
    this.logger?.append({ event: 'runtime.sweep_expired', at: at.toISOString() });
    const expired = [];
    for (const botId of this.botBindings.keys()) {
      const bot = this.taskService.getBot(botId);
      if (bot?.state !== 'CLOSING') continue;
      try {
        if (bot.execution_id && bot.stop_terminal_state) await this.stopExecution(bot.execution_id, bot.stop_terminal_state, bot.exit_reason);
        else if (!bot.execution_id) await this.releaseBot(botId);
      }
      catch (error) { this.logger?.append({ event: 'runtime.bot_cleanup_pending', bot_id: botId, error_class: error?.code ?? error?.name }); }
    }
    // A finish may already be terminal while its Workspace release is still
    // pending. Durable active rows alone cannot enumerate retained resources.
    for (const id of [...this.activeProcesses.keys()]) {
      if (!this.taskService.getExecution(id)?.finish) continue;
      try { await this.releaseExecution(id); }
      catch (error) { this.logger?.append({ event: 'runtime.finish_cleanup_pending', execution_id: id, error_class: error?.code ?? error?.name }); }
    }
    for (const execution of this.taskService.listActiveExecutions()) {
      if (!['CREATED', 'RUNNING'].includes(execution.state) || Date.parse(execution.lease_expires_at) > at.getTime()) continue;
      const bot = this.taskService.getBot(execution.owner_ref);
      if (!bot || !this.botBindings.has(bot.bot_id)) continue;
      const intent = this.#prepareBotExecutionStop(execution.execution_id, 'EXPIRED', 'lease_expired', { leaseExpiredAt: at.toISOString() });
      if (intent) expired.push(await this.stopExecution(execution.execution_id, 'EXPIRED', 'lease_expired'));
    }
    return expired;
  }

  #getExecution(executionId) {
    const execution = this.taskService.getExecution(requireString(executionId, 'execution_id'));
    if (!execution) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown execution: ${executionId}`);
    return execution;
  }

  async #fenceWorkspaceBestEffort(execution, { newFencingVersion = execution?.fencing_version + 1, event = 'runtime.workspace_fence_error' } = {}) {
    if (!execution?.workspace_ref) return true;
    try {
      await this.workspaceManager.fenceWorkspace({
        workspaceRef: execution.workspace_ref,
        executionId: execution.execution_id,
        fencingVersion: execution.fencing_version,
        newFencingVersion,
      });
      return true;
    } catch (error) {
      this.logger?.append({
        event,
        execution_id: execution.execution_id,
        error_class: error?.code ?? error?.name ?? 'workspace_fence_error',
      });
      return false;
    }
  }

  async #prepareWorkspace(execution, workspaceRef = null) {
    const task = this.taskService.getTask(execution.task_id);
    if (!task) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `Task is missing for execution: ${execution.execution_id}`);
    if (execution.workspace_ref) {
      throw new SwarmEnvError(ERROR_CODES.FENCED, 'clean Execution preparation cannot replace an already recorded Workspace', {
        execution_id: execution.execution_id,
        workspace_ref: execution.workspace_ref,
      });
    }
    const workspaceManifest = {
      task_id: task.task_id,
      spec_version: execution.spec_version,
      spec_hash: execution.spec_hash,
      workspace_snapshot_hash: execution.input_snapshot_hash,
      material_refs: execution.input_material_refs,
      selection: { mode: 'clean', revision: null },
    };
    const inputSnapshotManifest = {
      workspace_snapshot_hash: execution.input_snapshot_hash,
      material_refs: execution.input_material_refs,
    };
    const freshWorkspaceRef = workspaceRef ?? this.workspaceManager.workspacePath(`${execution.execution_id}-fresh-${execution.fencing_version}`);
    const registeredBot = this.taskService.getBot(execution.owner_ref);
    const publicWorkspaceId = this.missionWorkspaceId ?? task.workspace?.workspace_id;
    if (!registeredBot || !this.missionWorkspace || !publicWorkspaceId) {
      throw new SwarmEnvError(ERROR_CODES.SERVICE_NOT_READY, 'Registered Bot take requires the authoritative Mission Workspace');
    }
    const publicSnapshot = await this.missionWorkspace.exportRevision({ workspaceId: publicWorkspaceId, revision: task.workspace?.revision ?? 'main' });
    if (publicSnapshot && (publicSnapshot.mission_id !== task.mission_id ||
        (task.workspace?.workspace_id && task.workspace.workspace_id !== publicSnapshot.workspace_id))) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Task Workspace inputs must belong to the Bot Mission');
    }
    if (publicSnapshot) {
      if (execution.input_material_refs.length && typeof this.contextService?.readTakeMaterialInputs !== 'function') {
        throw new SwarmEnvError(ERROR_CODES.SERVICE_NOT_READY, 'Task input Materials require the authoritative Context Service');
      }
      publicSnapshot.material_inputs = this.contextService?.readTakeMaterialInputs?.({
        missionId: registeredBot.mission_id, materialIds: execution.input_material_refs,
      }) ?? [];
    }
    const workspace = await this.workspaceManager.createWorkspace({
      executionId: execution.execution_id,
      fencingVersion: execution.fencing_version,
      task,
      publicSnapshot,
      ...(freshWorkspaceRef ? { workspaceRef: freshWorkspaceRef } : {}),
      workspaceManifest,
      inputSnapshotManifest,
      runtimeManifest: { runtime_generation: this.runtimeGeneration, actor_ref: this.actorRef },
    });
    return workspace;
  }

  #saveWorkspaceReference(execution, workspace, saveOperationId = operationId('workspace')) {
    // Workspace materialization is asynchronous. A Runtime heartbeat (or a
    // concurrent lifecycle write) can advance the Execution state version
    // while the filesystem operation is in flight. Refresh the envelope and
    // retry the metadata CAS instead of turning that expected race into a
    // failed startup. The Workspace Manager already committed this exact
    // revision, so retrying this idempotent reference update is safe.
    let current = execution;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return this.taskService.dispatch('save_workspace_revision', {
          workspace_ref: workspace.workspace_ref,
          workspace_revision: workspace.workspace_revision,
          workspace_content_hash: workspace.content_hash,
          ...(workspace.public_workspace_input ? { workspace_input: workspace.public_workspace_input } : {}),
        }, this.#executionEnvelope(current, saveOperationId)).execution;
      } catch (error) {
        if (error?.code !== ERROR_CODES.STALE_VERSION || attempt === 2) throw error;
        current = this.#getExecution(execution.execution_id);
      }
    }
    throw new SwarmEnvError(ERROR_CODES.STALE_VERSION, 'could not persist Workspace reference after concurrent updates');
  }

  #onNotification(notification) {
    if (!notification || notification.delivered_at) return;
    for (const [executionId, active] of this.activeProcesses.entries()) {
      if (active.closing || !active.session) continue;
      if (notification.recipient_execution_id && notification.recipient_execution_id !== executionId) continue;
      if (active.execution.task_id !== notification.recipient_task_id) continue;
      this.#deliverNotification(active, notification);
    }
  }

  #deliverNotification(active, notification) {
    if (!active || active.closing || !active.session) return Promise.resolve();
    if (!active?.notificationPromises) active.notificationPromises = new Map();
    const existing = active.notificationPromises.get(notification.notification_id);
    if (existing) return existing;
    const queuedAt = this.clock();
    const delivery = active.promptChain.catch(() => undefined).then(async () => {
      if (active.closing) return;
      const current = this.taskService.getExecution(active.execution.execution_id);
      if (!current || !['CREATED', 'RUNNING'].includes(current.state)) return;
      if (typeof active.session.waitForSettled === 'function') {
        try {
          await active.session.waitForSettled({ timeoutMs: 5_000 });
        } catch (error) {
          // Some Pi provider-retry paths emit turn_end/auto_retry_end but no
          // agent_settled. Once that boundary is durable, the follow-up is
          // safe to send; otherwise defer and retry at the next boundary.
          if (!active.lastTurnEndedAt || active.lastTurnEndedAt < queuedAt) {
            this.logger?.append({
              event: 'runtime.notification_delivery_deferred',
              execution_id: current.execution_id,
              notification_id: notification.notification_id,
              error_class: error?.code ?? error?.name ?? 'settled_timeout',
            });
            return;
          }
        }
      }
      this.taskService.recordNotificationAttempt?.(notification.notification_id);
      try {
        await active.session.prompt?.(buildBotNotification(notification), {
          timeoutMs: 30_000,
          streamingBehavior: 'followUp',
        });
        this.taskService.markNotificationDelivered?.(notification.notification_id, current.execution_id);
        this.logger?.append({ event: 'runtime.notification_delivered', execution_id: current.execution_id, notification_id: notification.notification_id, notification_type: notification.notification_type });
      } catch (error) {
        this.logger?.append({ event: 'runtime.notification_delivery_error', execution_id: current.execution_id, notification_id: notification.notification_id, notification_type: notification.notification_type, error_class: error?.code ?? error?.name ?? 'prompt_error' });
      }
    });
    active.promptChain = delivery.catch(() => undefined);
    active.notificationPromises.set(notification.notification_id, delivery);
    delivery.finally(() => {
      if (active.notificationPromises.get(notification.notification_id) === delivery) {
        active.notificationPromises.delete(notification.notification_id);
      }
    }).catch(() => undefined);
    return delivery;
  }

  #queuePendingNotifications(active) {
    if (!active) return;
    const notifications = this.taskService.listUnprocessedNotifications?.(
      active.execution.task_id,
      active.execution.execution_id,
    ) ?? [];
    for (const notification of notifications) {
      // At-least-once means once per recipient Execution, not once per turn.
      // A notification already delivered to this Execution stays unhandled
      // until task_feedback; re-prompting it at every turn_end (r13: 344
      // prompts for 3 notifications) reads to the Agent as new evidence.
      if (notification.recipient_delivery?.delivered_at) continue;
      this.#deliverNotification(active, notification);
    }
  }

  #identityKey(coreId, execution) {
    return coreId ?? execution?.core_id ?? execution?.owner_ref ?? execution?.execution_id ?? 'identity';
  }

  // A Bot owns one Session; release confirms its stop before freeing capacity.
  async #releaseSessionBinding(active, executionId) {
    if (!active?.session) return;
    await active.session.stop?.();
    if (active.session.closed === false) {
      throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Bot process stop was not confirmed', { execution_id: executionId });
    }
    if (active.session.boundExecutionId === executionId) active.session.boundExecutionId = null;
    if (active.session.identitySession === true) this.identitySessions.delete(active.session);
  }

  #registerActiveProcess(execution, workspace, session, { coreId = null } = {}) {
    const nowMs = this.clock();
    const active = {
      session,
      execution,
      workspace,
      coreId,
      phase: 'idle',
      lastEventAt: nowMs,
      lastHeartbeatAt: null,
      lastCompletedTurnAt: null,
      lastTurnEndedAt: null,
      lastProductiveAt: nowMs,
      lastFailureClass: null,
      failurePromise: null,
      closing: false,
      identityId: session.sessionId ?? randomUUID(),
      compactionCount: this.identityCompactionCounts.get(this.#identityKey(coreId, execution)) ?? 0,
      compactionFollowupPromise: null,
      rotationPromise: null,
      // Initial and follow-up prompts share one queue.  Pi can accept a
      // follow-up while a turn is active, but two concurrent prompt calls
      // would reorder lifecycle notifications and Agent work.
      promptChain: Promise.resolve(),
      notificationPromises: new Map(),
    };
    this.activeProcesses.set(execution.execution_id, active);
    this.#setCoreState(coreId, {
      state: 'RUNNING',
      execution_id: execution.execution_id,
      task_id: execution.task_id,
      session_id: session.sessionId ?? null,
    });
    // A reusable identity Session can be bound to several Executions over its
    // lifetime. Attach one listener set and read the current binding at event
    // time; re-binding must not multiply handlers or route late events to the
    // previous Execution.
    session.boundExecutionId = execution.execution_id;
    session.executionId = execution.execution_id;
    session.taskId = execution.task_id;
    session.coreId = coreId;
    if (session.identitySession === true) this.identitySessions.add(session);
    if (session.__swarmenvRuntimeBound !== true) {
      session.__swarmenvRuntimeBound = true;
      session.on('rpc', (record) => {
        const boundId = session.boundExecutionId;
        if (boundId) {
          void this.#handleSessionEvent(boundId, record).catch((error) => {
            // EventEmitter does not observe rejected async listeners. Keep a
            // provider/session timeout as durable Runtime evidence instead of
            // allowing an unhandled rejection to terminate the benchmark
            // before report and Execution cleanup can run.
            this.logger?.append({
              event: 'runtime.agent_event_error',
              execution_id: boundId,
              record_type: record?.type ?? null,
              error_class: error?.code ?? error?.name ?? 'agent_event_error',
            });
          });
        }
      });
      session.on('processError', () => {
        const boundId = session.boundExecutionId;
        if (boundId) void this.#handleSessionFailure(boundId, 'process_error').catch(() => undefined);
      });
      session.on('close', () => {
        const boundId = session.boundExecutionId;
        if (boundId) void this.#processExit(boundId).catch(() => undefined);
      });
    }
  }

  #startFinishCleanup(id, attempt = 0, isBot = false) {
    const bindings = isBot ? this.botBindings : this.activeProcesses;
    if ((this.stopping && !isBot) || !bindings.has(id)) return;
    const execution = isBot ? null : this.taskService.getExecution(id);
    const bot = execution ? this.taskService.getBot(execution.owner_ref) : null;
    const cleanup = isBot ? this.releaseBot(id) : bot?.stop_terminal_state && !execution.finish
      ? this.stopExecution(id, bot.stop_terminal_state, bot.exit_reason) : this.releaseExecution(id);
    const promise = cleanup.catch((error) => {
      this.logger?.append({ event: isBot ? 'runtime.bot_cleanup_pending' : 'runtime.finish_cleanup_pending', ...(isBot ? { bot_id: id } : { execution_id: id }), attempt,
        retries_exhausted: attempt >= this.maxFinishCleanupRetries, error_class: error?.code ?? error?.name });
      if (this.stopping || !bindings.has(id) || attempt >= this.maxFinishCleanupRetries || this.finishCleanupTimers.has(id)) return;
      const delay = Math.min(30_000, this.finishCleanupRetryMs * (2 ** attempt));
      const timer = setTimeout(() => {
        this.finishCleanupTimers.delete(id);
        this.#startFinishCleanup(id, attempt + 1, isBot);
      }, delay);
      this.finishCleanupTimers.set(id, timer);
    }).finally(() => this.pendingReleasePromises.delete(promise));
    this.pendingReleasePromises.add(promise);
  }

  #onExecutionState(event) {
    if (event?.kind === 'bot_exit_accepted') {
      this.#startFinishCleanup(event.bot_id, 0, true);
      return;
    }
    if (event?.kind === 'execution_finish_accepted') {
      // Only the Runtime owning the live Bot can confirm its isolation.
      this.#startFinishCleanup(event.execution_id);
      return;
    }
    if (event?.kind !== 'executions_fenced' || !Array.isArray(event.execution_ids)) return;
    for (const executionId of event.execution_ids) {
      if (!executionId || executionId === event.excluded_execution_id || !this.activeProcesses.has(executionId)) continue;
      const promise = this.#releaseFencedProcess(executionId).finally(() => this.pendingReleasePromises.delete(promise));
      this.pendingReleasePromises.add(promise);
      void promise.catch((error) => this.logger?.append({ event: 'runtime.fenced_cleanup_pending', execution_id: executionId, error_class: error?.code ?? error?.name }));
    }
  }

  async #releaseFencedProcess(executionId) {
    const active = this.activeProcesses.get(executionId);
    if (!active) return;
    active.closing = true;
    await this.#drainCompactionFollowup(active);
    await this.#stopExecutionResources(executionId);
    const execution = this.taskService.getExecution(executionId);
    await this.#releaseSessionBinding(active, executionId);
    if (execution?.workspace_ref) {
      const oldFence = Math.max(0, execution.fencing_version - 1);
      await this.workspaceManager.fenceWorkspace({
        workspaceRef: execution.workspace_ref,
        executionId,
        fencingVersion: oldFence,
        newFencingVersion: execution.fencing_version,
      }).catch(() => undefined);
      await this.workspaceManager.releaseWorkspace({
        workspaceRef: execution.workspace_ref,
        executionId,
        fencingVersion: execution.fencing_version,
      }).catch(() => undefined);
    }
    // Keep the Core occupied until the old process has actually stopped and
    // its fenced Workspace is released. Durable fencing alone must not make a
    // reusable slot look idle while the sibling Session is still exiting.
    await this.releaseExecution(executionId);
    this.logger?.append({ event: 'runtime.execution_fenced_released', execution_id: executionId });
  }

  async #handleSessionEvent(executionId, record) {
    if (this.stopping) return;
    const active = this.activeProcesses.get(executionId);
    if (!active || active.closing) return;
    active.lastEventAt = this.clock();
    // Session events are handled concurrently. A start record bumps the
    // phase epoch synchronously, so a completion whose handler resumes after
    // an await cannot reset a newer turn/retry/compaction to idle (r15:
    // turn_end awaiting get_session_stats let the watchdog fence a Session
    // that was streaming the next reply).
    const startsPhase = record.type === 'turn_start' || record.type === 'auto_retry_start' || record.type === 'compaction_start';
    if (startsPhase) {
      active.phaseEpoch = (active.phaseEpoch ?? 0) + 1;
      active.phase = record.type === 'turn_start' ? 'turn' : record.type === 'auto_retry_start' ? 'provider_retry' : 'compaction';
    }
    const phaseEpoch = active.phaseEpoch ?? 0;
    this.logger?.append({ event: 'runtime.agent_event', execution_id: executionId, record_type: record.type, phase: active.phase });
    let usage = contextWindowRatio(record, active.session);
    // Pi's stream usage uses camelCase fields (`totalTokens`, `usage.input`)
    // and its authoritative window measurement is get_session_stats. Query it
    // at turn/compaction boundaries; never substitute zero for an unavailable
    // measurement.
    if ((record.type === 'turn_end' || record.type === 'compaction_end') && typeof active.session.getSessionStats === 'function') {
      try {
        const stats = await active.session.getSessionStats({ timeoutMs: 5_000 });
        const measured = contextWindowRatio(stats ?? {}, active.session);
        if (measured) usage = { ...measured, source: 'get_session_stats' };
      } catch {
        // Older/mock adapters may not implement the command. Keep the
        // event-derived value or null; unknown is handled conservatively.
      }
    }
    if (record.type === 'compaction_start') {
      this.logger?.append({
        event: 'runtime.compaction_started', execution_id: executionId, identity_id: active.identityId,
        compaction_count: active.compactionCount, max_compactions: this.maxCompactions,
        context_window: usage?.context_window ?? active.session.contextWindow ?? null,
        window_ratio: usage?.ratio ?? null, usage_source: usage ? 'event' : 'unknown',
      });
      // Bound compactions before closing the identity.
      // For Swarm the fourth compaction is prohibited at the adapter boundary.  A
      // start record is the earliest portable signal before Pi mutates its
      // context; close and fence the identity immediately instead of waiting
      // for a later report to discover that the limit was crossed.
      if (active.compactionCount >= this.maxCompactions) {
        await this.#rotateIdentity(executionId, {
          reason: 'compaction_limit',
          windowRatio: usage?.ratio ?? null,
          usageSource: usage ? 'event' : 'unknown',
        });
        return;
      }
    }
    if (record.type === 'turn_end') {
      active.lastCompletedTurnAt = this.clock();
      active.lastTurnEndedAt = active.lastCompletedTurnAt;
    }
    const completedProductiveEvent = record.type === 'turn_end' ||
      (record.type === 'tool_execution_end' && record.isError !== true) ||
      (record.type === 'compaction_end' && Boolean(record.result)) ||
      (record.type === 'auto_retry_end' && record.success === true);
    if (completedProductiveEvent) {
      active.lastProductiveAt = this.clock();
      if ((active.phaseEpoch ?? 0) === phaseEpoch) active.phase = 'idle';
      if (record.type === 'auto_retry_end' && record.success === true) active.lastTurnEndedAt = active.lastProductiveAt;
    }
    // Provider-retry paths may emit a completed turn boundary without ever
    // emitting Pi's agent_settled record. Retry pending notifications at each
    // such boundary instead of leaving them starved behind one stale Promise.
    if (record.type === 'turn_end' || (record.type === 'auto_retry_end' && record.success === true)) {
      this.#queuePendingNotifications(active);
    }
    if (record.type === 'compaction_end' && record.result && !record.aborted) {
      active.compactionCount += 1;
      this.identityCompactionCounts.set(this.#identityKey(active.coreId, active.execution), active.compactionCount);
      const estimatedTokensAfter = record.result?.estimatedTokensAfter ?? record.result?.estimated_tokens_after ?? null;
      const postCompactionUsage = estimatedTokensAfter !== null && estimatedTokensAfter !== undefined
        ? contextWindowRatio({ ...record, tokens: estimatedTokensAfter, result: { ...record.result, tokensBefore: undefined, tokens_before: undefined } }, active.session)
        : usage ?? contextWindowRatio(record.result, active.session);
      this.logger?.append({
        event: 'runtime.compaction_completed', execution_id: executionId, identity_id: active.identityId,
        compaction_count: active.compactionCount, max_compactions: this.maxCompactions,
        context_window: postCompactionUsage?.context_window ?? active.session.contextWindow ?? null,
        window_ratio: postCompactionUsage?.ratio ?? null,
        usage_source: postCompactionUsage ? 'event' : 'unknown',
      });
      // Queue one follow-up after each successful compaction and the current turn.
      this.#queueCompactionFollowup(active);
      if (active.compactionCount >= this.maxCompactions && !postCompactionUsage) {
        await this.#rotateIdentity(executionId, {
          reason: 'compaction_window_unknown', usageSource: 'unknown', windowRatio: null,
        });
        return;
      }
      if (active.compactionCount >= this.maxCompactions && postCompactionUsage?.ratio >= this.handoffWindowRatio) {
        await this.#rotateIdentity(executionId, {
          reason: 'compaction_window_threshold', usageSource: 'event', windowRatio: postCompactionUsage.ratio,
        });
        return;
      }
    }
    if (record.type === 'turn_end' && active.compactionCount >= this.maxCompactions) {
      if (!usage) {
        this.logger?.append({ event: 'runtime.compaction_window_unknown', execution_id: executionId, identity_id: active.identityId, compaction_count: active.compactionCount, action: 'continue_until_boundary' });
      } else if (usage.ratio >= this.handoffWindowRatio) {
        await this.#rotateIdentity(executionId, {
          reason: 'compaction_window_threshold', usageSource: 'event', windowRatio: usage.ratio,
        });
        return;
      }
    }
    const failureClass = classifySessionFailure(record);
    if (failureClass) {
      active.lastFailureClass = failureClass;
      await this.#handleSessionFailure(executionId, failureClass);
    }
  }

  #queueCompactionFollowup(active) {
    const executionId = active.execution.execution_id;
    // Serialize compaction follow-up in event order; public saves remain explicit.
    const previous = active.compactionFollowupPromise ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      try {
        if (typeof active.session.waitForSettled === 'function') {
          await active.session.waitForSettled({ timeoutMs: 30_000 });
        }
        const current = this.#getExecution(executionId);
        if (!['CREATED', 'RUNNING'].includes(current.state)) return { status: 'not_applicable', execution: current };
        const bot = this.taskService.getBot(current.owner_ref);
        if (bot) {
          if (bot.state !== 'ACTIVE' || bot.execution_id !== executionId) return { status: 'not_applicable', execution: current };
          this.taskService.assertBotDeadline(bot.bot_id);
          // Pi's private compaction is not a public Workspace save. In the
          // Bot path, only the explicit stable-snapshot API can publish files.
          if (!active.closing && !active.rotationPromise) {
            await active.session.prompt?.(buildBotContinuationMessage(current, { ordinary: BOT_COMPACTION_MESSAGE }), { timeoutMs: 30_000, streamingBehavior: 'followUp' });
          }
          this.logger?.append({ event: 'runtime.bot_compaction_recorded', execution_id: executionId, compaction_count: active.compactionCount, public_save: false });
          return { status: 'not_saved', execution: current };
        }
        return { status: 'not_applicable', execution: current };
      } catch (error) {
        this.logger?.append({ event: 'runtime.compaction_followup_failed', execution_id: executionId, identity_id: active.identityId, compaction_count: active.compactionCount, error_class: error?.code ?? error?.name ?? 'followup_failed' });
        return { status: 'followup_failed', error_class: error?.code ?? error?.name ?? 'followup_failed' };
      }
    });
    const queued = run.finally(() => {
      if (active.compactionFollowupPromise === queued) active.compactionFollowupPromise = null;
    });
    active.compactionFollowupPromise = queued;
    return queued;
  }

  async #drainCompactionFollowup(active) {
    if (!active?.compactionFollowupPromise) return;
    await active.compactionFollowupPromise.catch(() => undefined);
  }

  async #rotateIdentity(executionId, { reason, windowRatio = null, usageSource = 'unknown' } = {}) {
    const active = this.activeProcesses.get(executionId);
    if (!active) return null;
    if (active.rotationPromise) return active.rotationPromise;
    const previousIdentity = active.identityId;
    const previousCompactions = active.compactionCount;
    const rotation = (async () => {
      // A rotation raised at compaction_start must stop promptly; do not wait
      // for a new `agent_settled` event from the compaction that is being
      // aborted.  A successful compaction already queued its follow-up,
      // and only that in-flight follow-up is awaited here.
      if (active.compactionFollowupPromise) await active.compactionFollowupPromise.catch(() => undefined);
      this.logger?.append({
        event: 'runtime.identity_rotation_started', execution_id: executionId,
        old_identity_id: previousIdentity, compaction_count: previousCompactions,
        reason, window_ratio: windowRatio, usage_source: usageSource,
      });
      return this.stopExecution(executionId, 'HANDED_OFF', 'compaction_rotation');
    })();
    active.rotationPromise = rotation;
    try {
      return await rotation;
    } finally {
      active.rotationPromise = null;
    }
  }

  async #processExit(executionId) {
    const closedActive = this.activeProcesses.get(executionId);
    // The release owner must finish provider/workspace cleanup before this
    // close notification can make the Core available.
    if (closedActive?.closing) return;
    if (closedActive?.session) this.identitySessions.delete(closedActive.session);
    if (this.stopping) {
      await this.releaseExecution(executionId);
      return;
    }
    const active = this.activeProcesses.get(executionId);
    if (!active || this.stopping) return;
    const execution = this.#getExecution(executionId);
    if (execution.state === 'RUNNING') await this.#handleSessionFailure(executionId, 'process_exit');
    else {
      await this.releaseExecution(executionId);
    }
  }

  async #handleSessionFailure(executionId, failureClass) {
    if (this.stopping) {
      await this.releaseExecution(executionId);
      return null;
    }
    const active = this.activeProcesses.get(executionId);
    if (!active) return null;
    if (active.failurePromise) return active.failurePromise;
    active.lastFailureClass = failureClass;
    const failurePromise = (async () => {
      this.#prepareBotExecutionStop(executionId, 'FAILED', failureClass);
      this.#startFinishCleanup(executionId);
      return this.stopExecution(executionId, 'FAILED', failureClass);
    })();
    active.failurePromise = failurePromise;
    this.pendingFailurePromises.add(failurePromise);
    failurePromise.finally(() => this.pendingFailurePromises.delete(failurePromise)).catch(() => undefined);
    try {
      return await active.failurePromise;
    } finally {
      active.failurePromise = null;
    }
  }

  #executionEnvelope(execution, id, actorRef = this.actorRef) {
    return makeEnvelope({
      operationId: id,
      actorRef,
      taskId: execution.task_id,
      executionId: execution.execution_id,
      specVersion: execution.spec_version,
      stateVersion: execution.state_version,
      fencingVersion: execution.fencing_version,
    });
  }

  #resolveCoreId(execution, requestedCoreId) {
    const persisted = execution.core_id ?? execution.coreId ?? null;
    if (requestedCoreId !== null && requestedCoreId !== undefined) {
      const selected = requireString(requestedCoreId, 'core_id');
      if (persisted !== null && persisted !== selected) {
        throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Execution is bound to another Core', {
          execution_id: execution.execution_id,
          expected_core_id: persisted,
          received_core_id: selected,
        });
      }
      this.registerCore(selected);
      return selected;
    }
    if (persisted !== null) {
      this.registerCore(persisted);
      return persisted;
    }
    const idle = [...this.coreStates.values()].find((state) => state.state === 'IDLE');
    return idle?.core_id ?? null;
  }

  #canUpdateExecutionCore(coreId, execution) {
    const current = this.coreStates.get(coreId);
    return (!current?.bot_id || current.bot_id === execution.owner_ref) &&
      (!current?.execution_id || current.execution_id === execution.execution_id);
  }

  #assertCoreAvailable(coreId, executionId) {
    if (coreId === null) return;
    const current = this.coreStates.get(coreId);
    if (current?.bot_id && this.taskService.getBot(current.bot_id)?.execution_id !== executionId) {
      throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Core already owns a Bot', { core_id: coreId, bot_id: current.bot_id });
    }
    if (current && current.execution_id !== null && current.execution_id !== executionId) {
      throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Core already owns an active Execution', {
        core_id: coreId,
        execution_id: current.execution_id,
      });
    }
  }

  #setCoreState(coreId, patch) {
    if (coreId === null || coreId === undefined) return;
    const id = requireString(coreId, 'core_id');
    const current = this.coreStates.get(id) ?? {
      core_id: id,
      state: 'IDLE',
      execution_id: null,
      task_id: null,
      session_id: null,
      updated_at: null,
    };
    const next = { ...current, ...patch, core_id: id, updated_at: new Date(this.clock()).toISOString() };
    this.coreStates.set(id, next);
    try {
      this.onCoreEvent?.({ kind: 'core_occupancy', ...next });
    } catch {
      // Observability cannot change Runtime ownership behavior.
    }
  }

  /**
   * Bind every Execution deadline to the run's global deadline. The handoff
   * reminder keeps its lead time (executionTimeoutMs - handoffReminderMs)
   * before whichever deadline comes first, so a long Execution is reminded
   * only near the end of the run, not at a fixed offset from its start.
   */
  setRunDeadline(runDeadlineAt) {
    if (runDeadlineAt !== null && runDeadlineAt !== undefined && !Number.isFinite(runDeadlineAt)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'runDeadlineAt must be an epoch millisecond value');
    }
    this.runDeadlineAt = runDeadlineAt ?? null;
  }

  #executionTimingPayload(at = this.clock(), execution = null) {
    const task = execution?.task_id ? this.taskService.getTask(execution.task_id) : null;
    const taskTimeout = task?.mission_id && Number.isInteger(task.timebox_ms) ? task.timebox_ms : this.executionTimeoutMs;
    const leadMs = Math.max(1, this.executionTimeoutMs - this.handoffReminderMs);
    const untilRunDeadline = this.runDeadlineAt === null ? Number.POSITIVE_INFINITY : this.runDeadlineAt - at;
    const bot = execution?.owner_ref ? this.taskService.getBot(execution.owner_ref) : null;
    const untilBotDeadline = bot ? Date.parse(bot.hard_deadline) - at : Infinity;
    if (untilBotDeadline <= 0 || untilRunDeadline <= 0) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bot or Mission deadline elapsed before activation');
    const timeoutMs = Math.max(1, Math.min(taskTimeout, this.executionTimeoutMs, untilRunDeadline, untilBotDeadline));
    const reminderMs = Math.max(0, Math.min(timeoutMs - 1, timeoutMs - leadMs));
    const startedAt = new Date(at).toISOString();
    return {
      started_at: startedAt,
      handoff_deadline: new Date(at + reminderMs).toISOString(),
      execution_deadline: new Date(at + timeoutMs).toISOString(),
    };
  }
}

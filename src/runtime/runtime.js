import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ERROR_CODES, SwarmEnvError } from '../errors.js';
import { makeEnvelope } from '../protocol/envelope.js';
import { AGENT_ROLES, buildCapabilityProfile } from '../agent/capability-profile.js';
import { BOUND_AGENT_PROMPT, RECOVERY_AGENT_PROMPT, buildPromptSnapshot, composeAgentPrompt } from '../agent/agent-prompt.js';
import { runtimeCapabilityList } from './runtime-capabilities.js';
import { listServices, listTools } from '../sdk/service-catalog.js';

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
const PI_PROJECT_SETTINGS = Object.freeze({
  compaction: { enabled: true },
  retry: { enabled: true, maxRetries: 15, baseDelayMs: 2_000, maxAgentDelayMs: 60_000 },
});
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

function normalizeWaitFiles(files) {
  if (files === undefined || files === null) return {};
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'wait files must be a path-to-content object');
  }
  return Object.fromEntries(Object.entries(files).map(([path, content]) => {
    if (typeof content === 'string') return [path, content];
    if (content === undefined) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `wait file content must be text: ${path}`);
    return [path, JSON.stringify(content, null, 2)];
  }));
}

function normalizeProgress(progress) {
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)) {
    throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'progress must be an object');
  }
  for (const field of ['completed_work', 'findings', 'open_questions', 'next_step']) {
    if (!Object.hasOwn(progress, field)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `progress.${field} is required`);
  }
  return {
    completed_work: progress.completed_work,
    findings: progress.findings,
    open_questions: progress.open_questions,
    next_step: progress.next_step,
  };
}

function taskUsesJudge(task) {
  const contract = task?.completion_contract ?? {};
  return Boolean(contract.required_candidate || contract.required_check || task?.task_type === 'proof');
}

function taskUsesWorkspace(task) {
  const workspace = task?.workspace;
  const contract = task?.completion_contract ?? {};
  return Boolean((workspace && typeof workspace === 'object' && Object.keys(workspace).length > 0) ||
    contract.requires_workspace === true || contract.required_candidate?.workspace === true);
}

function modernTaskPromptProjection(task) {
  if (!task?.mission_id) return task;
  const contract = task.completion_contract ?? {};
  return {
    task_id: task.task_id,
    mission_id: task.mission_id,
    summary: task.summary,
    goal: task.goal,
    expected_output: task.expected_output,
    acceptance_conditions: task.acceptance_conditions,
    validation: {
      requires_candidate: Boolean(contract.required_candidate),
      requires_judge: Boolean(contract.required_check),
      checker: contract.required_check ? {
        checker_ref: contract.required_check.checker_ref ?? null,
        checker_version: contract.required_check.checker_version ?? null,
      } : null,
    },
    timebox_ms: task.timebox_ms,
    state: task.state,
    state_version: task.state_version,
    relations: task.relations,
    materials: task.materials,
  };
}

export class Runtime {
  constructor({ taskService, contextService, workspaceManager, missionWorkspace = null, missionWorkspaceId = null, missionSubmissionStore = null, agentAdapter, sandboxManager = null, cleanExecutionWorkspaces = false, freshBotPerExecution = true, maxWorkers = 1, coreIds = null, runtimeGeneration = 1, actorRef = 'runtime:local', logger = null, agentLogger = null, capabilityRegistry = null, runtimeCapabilities = runtimeCapabilityList(), maxRecoveryAttempts = 1, finishCleanupRetryMs = 1000, maxFinishCleanupRetries = 3, maxCompactions = 3, handoffWindowRatio = 0.8, watchdogTimeoutMs = DEFAULT_WATCHDOG_TIMEOUT_MS, executionTimeoutMs = DEFAULT_EXECUTION_TIMEOUT_MS, handoffReminderMs = DEFAULT_HANDOFF_REMINDER_MS, runDeadlineAt = null, compactionCheckpointReminder = true, clock = () => Date.now(), onSessionStarted = null, onCoreEvent = null }) {
    this.taskService = taskService;
    this.contextService = contextService;
    this.workspaceManager = workspaceManager;
    // Public Mission Workspace and final submission stores are optional so
    // existing execution-local deployments remain readable during migration.
    // When configured, these methods are the only Runtime seam that exposes
    // repository revisions to a Bot; Git itself remains Runtime-owned.
    this.missionWorkspace = missionWorkspace;
    this.missionWorkspaceId = missionWorkspaceId;
    this.missionSubmissionStore = missionSubmissionStore;
    this.agentAdapter = agentAdapter;
    this.sandboxManager = sandboxManager;
    this.cleanExecutionWorkspaces = cleanExecutionWorkspaces === true;
    this.freshBotPerExecution = freshBotPerExecution === true;
    this.maxWorkers = maxWorkers;
    this.runtimeGeneration = runtimeGeneration;
    this.actorRef = actorRef;
    this.logger = logger;
    this.agentLogger = agentLogger;
    this.capabilityRegistry = capabilityRegistry;
    // Never advertise a capability the deployment cannot execute. Sandbox
    // tools are visible only when a Sandbox manager is bound.
    this.runtimeCapabilities = (runtimeCapabilities ?? runtimeCapabilityList())
      .filter((capability) => sandboxManager || !['sandbox_exec', 'sandbox_job'].includes(capability.operation));
    this.maxRecoveryAttempts = maxRecoveryAttempts;
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
    this.compactionCheckpointReminder = compactionCheckpointReminder === true;
    this.clock = clock;
    this.onSessionStarted = onSessionStarted;
    this.onCoreEvent = onCoreEvent;
    this.activeProcesses = new Map();
    this.botBindings = new Map();
    this.botStopPromises = new Map();
    this.coreStates = new Map();
    // Compaction count belongs to the reusable identity/lane, not to one
    // Execution. An ordinary Task handoff keeps the count; an explicit
    // identity rotation resets it.
    this.identityCompactionCounts = new Map();
    // Reusable identity Sessions remain owned by Runtime even while no
    // Execution is bound. Shutdown/restart must stop them too.
    this.identitySessions = new Set();
    const configuredCoreIds = Array.isArray(coreIds)
      ? coreIds
      : Array.from({ length: Math.max(0, maxWorkers) }, (_, index) => `core-${index + 1}`);
    for (const coreId of configuredCoreIds) this.registerCore(coreId);
    this.recoveryAttempts = new Map();
    this.handoffPromises = new Map();
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
    if (this.getCoreStatus(coreId)?.state !== 'IDLE' || this.taskService.getActiveExecutionForCore(coreId)) {
      throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Core is occupied');
    }
    const startedAt = Date.now();
    const hardDeadlineAt = Math.min(startedAt + maxLifetimeMs, this.runDeadlineAt ?? Infinity);
    if (hardDeadlineAt <= startedAt) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Mission run deadline already elapsed');
    const bot = this.taskService.registerBot({ missionId, coreId, selectionDeadline: new Date(Math.min(startedAt + selectionTimeoutMs, hardDeadlineAt)).toISOString(), hardDeadline: new Date(hardDeadlineAt).toISOString() });
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
    binding.selectionTimer = setTimeout(() => stopUnbound('selection-budget'), Math.max(1, Date.parse(bot.selection_deadline) - Date.now()));
    binding.selectionTimer.unref?.();
    const factory = Promise.resolve().then(() => startSession({ bot, signal: controller.signal,
      onSandboxCreated: (resource) => this.taskService.recordBotSandbox(bot.bot_id,
        { provider: resource.provider ?? 'opensandbox', sandboxId: resource.sandbox_id }) }));
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
      if (this.stopping || session.closed || this.taskService.getBot(bot.bot_id).state !== 'STARTING') throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bot startup was stopped');
      await Promise.race([(async () => {
        await session.waitForReady({ timeoutMs: readyTimeoutMs });
        if (controller.signal.aborted) throw controller.signal.reason;
        await session.setAutoCompaction?.(true);
        if (controller.signal.aborted) throw controller.signal.reason;
        await session.setAutoRetry?.(true);
      })(), cancelled]);
      if (this.stopping || session.closed) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Runtime stopped during Bot startup');
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
    await this.sandboxManager?.stopExecution(bot.resource_key);
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
    while (this.pendingFailurePromises.size > 0) {
      await Promise.allSettled([...this.pendingFailurePromises]);
    }
    while (this.pendingReleasePromises.size > 0) {
      await Promise.allSettled([...this.pendingReleasePromises]);
    }
  }

  /** Reconcile provider-owned sandboxes against the durable Execution store. */
  async reconcileProviderExecutions({ executionIds = null } = {}) {
    if (typeof this.sandboxManager?.reconcileExecutions !== 'function') {
      return { provider: null, adopted: [] };
    }
    const ids = executionIds ?? this.taskService.listActiveExecutions().map((execution) => execution.execution_id);
    const result = await this.sandboxManager.reconcileExecutions({ executionIds: ids });
    this.logger?.append({
      event: 'runtime.provider_reconciled',
      provider: result.provider ?? null,
      requested_execution_count: ids.length,
      adopted_execution_count: result.adopted?.length ?? 0,
    });
    return result;
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
    for (const timer of this.finishCleanupTimers.values()) clearTimeout(timer);
    this.finishCleanupTimers.clear();
    for (const [botId, binding] of this.botBindings) {
      const bot = this.taskService.getBot(botId);
      if (bot && !bot.execution_id && !['CLOSING', 'CLOSED'].includes(bot.state)) this.taskService.requestBotStop(botId, terminalReason);
      if (!bot?.execution_id) binding.cancelStartup?.();
    }
    await Promise.allSettled([...this.startupPromises]);
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
    for (const executionId of executionIds) {
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
    }
    for (const botId of this.botBindings.keys()) {
      const bot = this.taskService.getBot(botId);
      if (bot?.execution_id) continue;
      try {
        this.taskService.requestBotStop(botId, terminalReason);
        await this.releaseBot(botId);
      } catch (error) { this.logger?.append({ event: 'runtime.bot_cleanup_pending', bot_id: botId, error_class: error?.code ?? error?.name }); }
    }
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

  getSchedulerStatus({ rootId = null, taskId = null, executionId = null, limit = 100 } = {}) {
    const readyTasks = this.taskService.listTasks({ rootId, limit, availableOnly: true });
    const executions = this.taskService.listActiveExecutions();
    const waitingExecutions = executions.filter((execution) => execution.state === 'WAITING');
    return {
      core_count: this.maxWorkers,
      active_core_count: this.activeProcesses.size,
      idle_core_count: Math.max(0, this.maxWorkers - this.activeProcesses.size),
      waiting_execution_count: waitingExecutions.length,
      ready_task_count: readyTasks.length,
      ready_task_ids: readyTasks.map((task) => task.task_id),
      ready_tasks: readyTasks,
      current_task_id: taskId,
      current_execution_id: executionId,
      current_root_id: rootId ?? (taskId ? this.taskService.getTask(taskId)?.root_id ?? null : null),
    };
  }

  async getWorkspace(executionId) {
    const execution = this.#getExecution(executionId);
    if (!execution.workspace_ref) return { workspace: null, revisions: [] };
    const workspace = await this.workspaceManager.restoreWorkspace({
      workspaceRef: execution.workspace_ref,
      executionId,
      fencingVersion: execution.fencing_version,
    });
    const revisions = await this.workspaceManager.listRevisions({
      workspaceRef: execution.workspace_ref,
      executionId,
      fencingVersion: execution.fencing_version,
    });
    return { workspace, revisions };
  }

  async listPublicWorkspaceFiles({ workspaceId, revision = undefined, path = '' } = {}) {
    if (!this.missionWorkspace) throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Mission Workspace is not enabled');
    return this.missionWorkspace.files({ workspaceId: requireString(workspaceId, 'workspace_id'), revision, prefix: path });
  }

  async readPublicWorkspaceFile({ workspaceId, revision = undefined, path, maxBytes = 1_000_000 } = {}) {
    if (!this.missionWorkspace) throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Mission Workspace is not enabled');
    return this.missionWorkspace.read({ workspaceId: requireString(workspaceId, 'workspace_id'), revision, path, maxBytes });
  }

  async searchPublicWorkspace({ workspaceId, revision = undefined, query, path = '', maxResults = 100 } = {}) {
    if (!this.missionWorkspace) throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Mission Workspace is not enabled');
    return this.missionWorkspace.search({ workspaceId: requireString(workspaceId, 'workspace_id'), revision, query, prefix: path, maxResults });
  }

  async savePublicWorkspaceRevision(input = {}) {
    if (!this.missionWorkspace) throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Mission Workspace is not enabled');
    return this.missionWorkspace.save(input);
  }

  async mergePublicWorkspaceRevision(input = {}) {
    if (!this.missionWorkspace) throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Mission Workspace is not enabled');
    return this.missionWorkspace.merge(input);
  }

  async submitMission(input = {}) {
    if (!this.missionSubmissionStore) throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Mission submission is not enabled');
    return this.missionSubmissionStore.submit(input);
  }

  async finishMissionSubmission(input = {}) {
    if (!this.missionSubmissionStore) throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Mission submission is not enabled');
    return this.missionSubmissionStore.finish(input);
  }

  async listWorkspaceFiles(executionId, { path = '' } = {}) {
    const execution = this.#getExecution(executionId);
    if (!execution.workspace_ref) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Execution has no materialized Workspace');
    return this.workspaceManager.listFiles({
      workspaceRef: execution.workspace_ref,
      executionId,
      fencingVersion: execution.fencing_version,
      path,
    });
  }

  async readWorkspaceFile(executionId, { path, maxBytes = 1_000_000 } = {}) {
    const execution = this.#getExecution(executionId);
    if (!execution.workspace_ref) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Execution has no materialized Workspace');
    return this.workspaceManager.readWorkspaceFile({
      workspaceRef: execution.workspace_ref,
      executionId,
      fencingVersion: execution.fencing_version,
      path,
      maxBytes,
    });
  }

  async writeWorkspaceFile(executionId, { path, content, expectedRevision = undefined, saveOperationId = null } = {}) {
    const execution = this.#getExecution(executionId);
    requireString(path, 'workspace file path');
    if (typeof content !== 'string') throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'workspace file content must be a string');
    if (!['CREATED', 'RUNNING'].includes(execution.state)) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `Workspace is not writable while Execution is ${execution.state}`);
    }
    if (!this.activeProcesses.has(executionId)) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Workspace writes require an active Runtime Execution');
    }
    if (!execution.workspace_ref) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Execution has no materialized Workspace');
    const revision = expectedRevision ?? execution.workspace_revision;
    if (!Number.isInteger(revision) || revision < 1) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'expected_revision is required after Workspace materialization');
    const workspace = await this.workspaceManager.saveWorkspaceRevision({
      workspaceRef: execution.workspace_ref,
      executionId,
      fencingVersion: execution.fencing_version,
      expectedRevision: revision,
      files: { [path]: content },
    });
    const current = this.#saveWorkspaceReference(execution, workspace, saveOperationId ?? operationId('workspace-write'));
    const active = this.activeProcesses.get(executionId);
    if (active) {
      active.execution = current;
      active.workspace = workspace;
    }
    const file = await this.readWorkspaceFile(executionId, { path });
    return {
      workspace,
      file,
      artifact_ref: {
        path: file.path,
        workspace_revision: file.workspace_revision,
        content_hash: file.content_hash,
      },
      diff: await this.workspaceDiff(executionId, { fromRevision: revision, toRevision: workspace.workspace_revision }),
      execution: current,
    };
  }

  async workspaceDiff(executionId, { fromRevision = null, toRevision = null } = {}) {
    const execution = this.#getExecution(executionId);
    if (!execution.workspace_ref) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Execution has no materialized Workspace');
    return this.workspaceManager.diff({
      workspaceRef: execution.workspace_ref,
      executionId,
      fencingVersion: execution.fencing_version,
      fromRevision,
      toRevision,
    });
  }

  /**
   * Run a bounded command in the Execution's Sandbox. The Sandbox is bound to
   * the same private Workspace as the file tools, so shell edits and
   * read/write tool edits share one file truth. Shell changes are not a saved
   * revision until execution_progress checkpoints them.
   */
  async sandboxExec(executionId, { command, cwd = '/workspace', timeout_ms: timeoutMs = undefined, env = {}, background = false } = {}) {
    const execution = this.#getExecution(executionId);
    if (this.taskService.getBot(execution.owner_ref)) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Registered Bots run shell commands through their non-root Pi Bash tool');
    if (!this.sandboxManager) throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Sandbox execution is not enabled');
    const active = this.activeProcesses.get(executionId);
    if (!active || active.closing || !['CREATED', 'RUNNING'].includes(execution.state)) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Sandbox commands require an active Execution binding');
    }
    if (!execution.workspace_ref) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Execution has no materialized Workspace');
    await this.sandboxManager.ensureExecution({
      executionId,
      workspaceRef: execution.workspace_ref,
      bindingVersion: execution.fencing_version,
    });
    return this.sandboxManager.exec({ executionId, command, cwd, timeoutMs, env, background });
  }

  async sandboxJob(executionId, { action, job_id: jobId } = {}) {
    const execution = this.#getExecution(executionId);
    if (!this.sandboxManager) throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Sandbox execution is not enabled');
    const active = this.activeProcesses.get(executionId);
    if (!active || active.closing || !['CREATED', 'RUNNING'].includes(execution.state)) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Sandbox jobs require an active Execution binding');
    }
    if (typeof jobId !== 'string' || jobId.length === 0) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'sandbox job_id is required');
    // A job belongs to the Execution that created it. rebinding or release
    // fences the Sandbox, so a late query cannot reach a successor.
    if (action === 'cancel') return this.sandboxManager.cancelJob(executionId, jobId);
    return this.sandboxManager.jobStatus(executionId, jobId);
  }

  async #ensureSandbox(execution, workspace) {
    if (!this.sandboxManager) return;
    const bot = this.taskService.getBot(execution.owner_ref);
    if (bot) {
      if (!workspace?.public_workspace_input) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bot Sandbox preparation requires pinned public Workspace input');
      if (bot.execution_id !== execution.execution_id) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bot does not own this Execution');
      this.sandboxManager.bindBotExecution({ botId: bot.bot_id, executionId: execution.execution_id,
        workspaceRef: workspace?.workspace_ref ?? execution.workspace_ref, bindingVersion: execution.fencing_version });
      await this.sandboxManager.syncWorkspace({ executionId: execution.execution_id, workspaceRef: workspace?.workspace_ref ?? execution.workspace_ref, manifest: workspace?.public_workspace_input?.manifest ?? null });
      if (workspace?.public_workspace_input) await this.sandboxManager.prepareBotProject({ executionId: execution.execution_id, manifest: workspace.public_workspace_input.manifest });
      return;
    }
    await this.sandboxManager.ensureExecution({
      executionId: execution.execution_id,
      workspaceRef: workspace?.workspace_ref ?? execution.workspace_ref,
      bindingVersion: execution.fencing_version,
    });
  }

  async #stopSandbox(executionId) {
    if (!this.sandboxManager || !executionId) return;
    try {
      const current = this.taskService.getExecution(executionId);
      if (!this.taskService.getBot(current?.owner_ref ?? 'unknown') && typeof this.sandboxManager.syncWorkspaceBack === 'function' && current?.workspace_ref) await this.sandboxManager.syncWorkspaceBack({ executionId, workspaceRef: current.workspace_ref });
    } catch (error) {
      this.logger?.append({
        event: 'runtime.sandbox_sync_error',
        execution_id: executionId,
        error_class: error?.code ?? error?.name ?? 'sandbox_stop_error',
      });
    }
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

  async startExecution(...args) {
    return this.#trackStartup(() => this.#startExecution(...args));
  }

  async #startExecution(executionId, { sessionReason = 'start', coreId = null } = {}) {
    this.logger?.append({ event: 'runtime.start_execution', execution_id: executionId, session_reason: sessionReason });
    const execution = this.#getExecution(executionId);
    if (this.taskService.getBot(execution.owner_ref)) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Registered Bot must bind its original Session with bindAgentExecution');
    if (execution.state !== 'CREATED') throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `Runtime can only start CREATED executions, got ${execution.state}`);
    if (this.activeProcesses.size >= this.maxWorkers) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Runtime capacity is exhausted');
    const selectedCoreId = this.#resolveCoreId(execution, coreId);
    this.#assertCoreAvailable(selectedCoreId, execution.execution_id);
    let workspace = null;
    let current = execution;
    let startedDurably = false;
    try {
      const recoverySession = sessionReason === 'recovery' || sessionReason === 'session_recovery' || sessionReason === 'wake';
      const freshWorkspace = this.cleanExecutionWorkspaces && !recoverySession;
      workspace = await this.#prepareWorkspace(execution, null, { fresh: freshWorkspace });
      // A recovery start restores the already persisted revision. Rewriting
      // that same revision would violate the Workspace Manager's monotonic
      // CAS rule.
      current = execution.workspace_ref && !freshWorkspace ? execution : this.#saveWorkspaceReference(execution, workspace);
      current = this.taskService.dispatch('start_execution', {
        ...this.#executionTimingPayload(this.clock(), current),
        ...(selectedCoreId ? { core_id: selectedCoreId } : {}),
      }, this.#executionEnvelope(current, operationId('start'))).execution;
      startedDurably = true;
      return await this.#launch(current, workspace, { sessionReason, coreId: selectedCoreId });
    } catch (error) {
      const active = this.activeProcesses.get(executionId);
      this.#retainCleanupBinding(executionId, { session: active?.session, workspace, coreId: active?.coreId ?? selectedCoreId });
      await this.#stopExecutionResources(executionId);
      if (this.stopping) throw error;
      const failed = this.#getExecution(executionId);
      if (!startedDurably && ['CREATED', 'RUNNING'].includes(failed.state)) {
        await this.fenceExecution(executionId, { reason: 'startup_prepare_failed' }).catch(() => undefined);
      } else if (!['FAILED', 'CANCELLED', 'FENCED', 'HANDED_OFF', 'SUPERSEDED'].includes(failed.state)) {
        this.taskService.dispatch('stop_execution', {
          terminal_state: 'FAILED',
          terminal_reason: 'startup_failed',
        }, this.#executionEnvelope(failed, operationId('start-failed')));
      }
      await this.releaseExecution(executionId);
      throw error;
    }
  }

  /**
   * Start an Execution that has already been selected and taken by a Core
   * Daemon. The method intentionally accepts no Task filters or ranking
   * inputs: Task choice belongs to the Daemon and the take is the handoff
   * boundary.
   */
  startTakenExecution(executionOrId, { coreId = null, sessionReason = 'taken' } = {}) {
    const executionId = typeof executionOrId === 'string' ? executionOrId : executionOrId?.execution_id;
    requireString(executionId, 'execution_id');
    return this.startExecution(executionId, { coreId, sessionReason });
  }

  runTakenExecution(executionOrId, options = {}) {
    return this.startTakenExecution(executionOrId, options);
  }

  async bindAgentExecution(...args) {
    return this.#trackStartup(() => this.#bindAgentExecution(...args));
  }

  async #bindAgentExecution(executionId, session = null, { workspaceRef, startSession = null, agentPrompt = null, promptSnapshot = null, capabilityProfile = null, promptContext = {}, coreId = null, sessionReason = 'bound', sendInitialPrompt = true } = {}) {
    this.logger?.append({ event: 'runtime.bind_execution', execution_id: executionId });
    if ((!session || typeof session.stop !== 'function') && typeof startSession !== 'function') {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Agent session or startSession is required');
    }
    const execution = this.#getExecution(executionId);
    if (execution.state !== 'CREATED') throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `Runtime can only bind CREATED executions, got ${execution.state}`);
    if (this.activeProcesses.size >= this.maxWorkers) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Runtime capacity is exhausted');
    const selectedCoreId = this.#resolveCoreId(execution, coreId);
    this.#assertCoreAvailable(selectedCoreId, execution.execution_id);
    let workspace = null;
    let current = execution;
    let initialPrompt = agentPrompt;
    let initialPromptSnapshot = promptSnapshot;
    const registeredBot = this.taskService.getBot(execution.owner_ref);
    if (registeredBot && (this.botBindings.get(registeredBot.bot_id)?.session !== session || registeredBot.core_id !== selectedCoreId)) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Task take must bind its original Bot Session and Core');
    }
    let boundSession = session;
    let startedDurably = false;
    try {
      const recoverySession = sessionReason === 'recovery' || sessionReason === 'session_recovery' || sessionReason === 'wake';
      const freshWorkspace = this.cleanExecutionWorkspaces && !recoverySession;
      workspace = await this.#prepareWorkspace(execution, workspaceRef, { fresh: freshWorkspace });
      current = execution.workspace_ref && !freshWorkspace ? execution : this.#saveWorkspaceReference(execution, workspace);
      if (!initialPromptSnapshot && capabilityProfile) {
        const role = sessionReason === 'recovery' || sessionReason === 'session_recovery' ? AGENT_ROLES.RECOVERY : AGENT_ROLES.BOUND;
        const rolePrompt = role === AGENT_ROLES.RECOVERY ? RECOVERY_AGENT_PROMPT : BOUND_AGENT_PROMPT;
        const staticSop = agentPrompt && agentPrompt.includes(rolePrompt)
          ? agentPrompt
          : [rolePrompt, agentPrompt].filter((value) => typeof value === 'string' && value.trim().length > 0).join('\n\n');
        initialPromptSnapshot = buildPromptSnapshot({
          role, profile: capabilityProfile, staticSop, task: this.taskService.getTask(current.task_id), execution: current, workspace,
          recovery: promptContext.recovery ?? null,
        });
        initialPrompt = initialPromptSnapshot.prompt;
      } else if (initialPromptSnapshot?.prompt) {
        initialPrompt = initialPromptSnapshot.prompt;
      }
      if (!capabilityProfile && this.capabilityRegistry) {
        const role = sessionReason === 'recovery' || sessionReason === 'session_recovery' ? AGENT_ROLES.RECOVERY : AGENT_ROLES.BOUND;
        const rolePrompt = role === AGENT_ROLES.RECOVERY ? RECOVERY_AGENT_PROMPT : BOUND_AGENT_PROMPT;
        const staticSop = agentPrompt && agentPrompt.includes(rolePrompt)
          ? agentPrompt
          : [rolePrompt, agentPrompt].filter((value) => typeof value === 'string' && value.trim().length > 0).join('\n\n');
        const profile = buildCapabilityProfile({ role, registry: this.capabilityRegistry, runtimeCapabilities: this.runtimeCapabilities, context: { task_id: current.task_id, execution_id: current.execution_id } });
        initialPromptSnapshot = buildPromptSnapshot({
          role, profile, staticSop, task: this.taskService.getTask(current.task_id), execution: current, workspace, recovery: promptContext.recovery ?? null,
        });
        initialPrompt = initialPromptSnapshot.prompt;
      }
      if (initialPromptSnapshot) {
        this.logger?.append({
          event: 'runtime.initial_prompt_composed', execution_id: current.execution_id,
          role: initialPromptSnapshot.role, prompt_version: initialPromptSnapshot.prompt_version,
          prompt_hash: initialPromptSnapshot.prompt_hash, profile_version: initialPromptSnapshot.profile_version,
          profile_hash: initialPromptSnapshot.profile_hash,
        });
      }
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
      current = this.taskService.dispatch('start_execution', {
        ...this.#executionTimingPayload(this.clock(), current),
        ...(selectedCoreId ? { core_id: selectedCoreId } : {}),
      }, this.#executionEnvelope(current, operationId('bind'))).execution;
      if (bot) this.botBindings.get(bot.bot_id).armDeadline(Date.parse(current.execution_deadline),
        Date.parse(current.execution_deadline) < Date.parse(bot.hard_deadline) ? 'execution-timebox' : 'bot-lifetime-budget');
      startedDurably = true;
      if (bot && workspace.public_workspace_input && this.sandboxManager) {
        this.taskService.assertBotDeadline(bot.bot_id);
        await this.sandboxManager.grantBotProject({ executionId: current.execution_id });
        const latestBot = this.taskService.getBot(bot.bot_id);
        if (latestBot.state !== 'ACTIVE' || this.botBindings.get(bot.bot_id)?.closing || boundSession.closed || this.stopping) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bot stopped during project grant');
        this.taskService.assertBotDeadline(bot.bot_id);
      }
      if (!boundSession) boundSession = await startSession({ execution: current, workspace });
      if (!boundSession || typeof boundSession.stop !== 'function') throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'startSession must return an Agent session');
      if (this.stopping) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Runtime stopped during startup');
      this.#registerActiveProcess(current, workspace, boundSession, { sessionReason, coreId: selectedCoreId });
      if (!bot) await this.#ensureSandbox(current, workspace);
      if (sendInitialPrompt !== false) {
        await this.#sendInitialPrompt(boundSession, initialPrompt, current, workspace);
      } else {
        // The benchmark's reusable identity path deliberately does not send a
        // second initial prompt while the current Agent turn is still active.
        // Task-level notifications created while this identity was unbound
        // still need a delivery opportunity. Queue them behind the Session's
        // settled boundary instead of losing them until a future restart.
        this.#queuePendingNotifications(this.activeProcesses.get(current.execution_id));
      }
      return { execution: current, workspace, session: boundSession };
    } catch (error) {
      if (registeredBot) {
        await this.stopExecution(executionId, 'FAILED', 'bind_prepare_failed');
        throw error;
      }
      this.#retainCleanupBinding(executionId, { session: boundSession, workspace, coreId: selectedCoreId });
      await this.#stopExecutionResources(executionId);
      const failed = this.#getExecution(executionId);
      if (!startedDurably && ['CREATED', 'RUNNING'].includes(failed.state)) {
        await this.fenceExecution(executionId, { reason: 'bind_prepare_failed' }).catch(() => undefined);
      } else if (!['FAILED', 'CANCELLED', 'FENCED', 'HANDED_OFF', 'SUPERSEDED'].includes(failed.state)) {
        this.taskService.dispatch('stop_execution', {
          terminal_state: 'FAILED',
          terminal_reason: 'bind_failed',
        }, this.#executionEnvelope(failed, operationId('bind-failed')));
      }
      await this.releaseExecution(executionId);
      throw error;
    }
  }

  /**
   * Restart only the process incarnation for an active Execution. The
   * durable Execution ID and Core binding remain stable; Task Service records
   * the fencing/session generation transition through recover_execution.
   */
  async restartSession(executionId, { reason = 'session_restart', agentPrompt = null } = {}) {
    const existing = this.#getExecution(executionId);
    if (this.taskService.getBot(existing.owner_ref)) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'A Bot cannot replace its Pi Session; end this Execution and start a successor Bot');
    }
    if (!['CREATED', 'RUNNING'].includes(existing.state)) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `Runtime can only restart CREATED or RUNNING executions, got ${existing.state}`);
    }
    const active = this.activeProcesses.get(executionId);
    if (active) {
      await this.#stopExecutionResources(executionId, { forceSessionStop: true });
    }
    let current = this.#getExecution(executionId);
    if (!['CREATED', 'RUNNING'].includes(current.state)) return this.releaseExecution(executionId);
    if (current.state === 'RUNNING') {
      if (current.workspace_ref) {
        await this.workspaceManager.fenceWorkspace({
          workspaceRef: current.workspace_ref,
          executionId,
          fencingVersion: current.fencing_version,
          newFencingVersion: current.fencing_version + 1,
        });
      }
      current = this.#getExecution(executionId);
      if (!['CREATED', 'RUNNING'].includes(current.state)) return this.releaseExecution(executionId);
      current = this.taskService.dispatch('recover_execution', {
        runtime_generation: this.runtimeGeneration,
        ...(agentPrompt ? { agent_prompt: agentPrompt } : {}),
      }, this.#executionEnvelope(current, operationId('session-restart'))).execution;
    }
    if (active && this.activeProcesses.get(executionId) === active) {
      this.activeProcesses.delete(executionId);
      this.identitySessions.delete(active.session);
      this.#setCoreState(active.coreId, { state: 'IDLE', execution_id: null, task_id: null, session_id: null });
    }
    const restarted = await this.startExecution(executionId, {
      coreId: current.core_id ?? null,
      sessionReason: reason,
    });
    return { previous_execution_id: executionId, execution: restarted.execution, workspace: restarted.workspace, session: restarted.session };
  }

  restartExecutionSession(executionId, options = {}) {
    return this.restartSession(executionId, options);
  }

  /**
   * End an Execution because it has reached a concrete external dependency.
   * Task Service performs the durable BLOCKED transition and Runtime then
   * stops the Session and releases the physical Workspace/Core.
   */
  async blockExecution(executionId, {
    reason,
    dependency = undefined,
    checkpoint = {},
    files = {},
    terminalState = 'FENCED',
  } = {}) {
    const active = this.activeProcesses.get(executionId);
    const execution = this.#getExecution(executionId);
    if (!active || !['CREATED', 'RUNNING'].includes(execution.state)) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'only a running Runtime Execution can be blocked');
    }
    active.closing = true;
    await this.#stopSandbox(executionId);
    requireString(reason, 'block_reason');
    const task = this.taskService.getTask(execution.task_id);
    if (task?.completion_contract?.normal_flow === true && dependency === undefined) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'normal_flow Tasks require execution_block with a typed dependency');
    }
    const normalizedFiles = normalizeWaitFiles(files);
    let current = execution;
    let workspace = null;
    let checkpointResult = null;
    if (current.workspace_ref) {
      workspace = await this.workspaceManager.saveWorkspaceRevision({
        workspaceRef: current.workspace_ref,
        executionId,
        fencingVersion: current.fencing_version,
        files: normalizedFiles,
      });
      current = this.#saveWorkspaceReference(current, workspace, operationId('block-workspace'));
      checkpointResult = await this.workspaceManager.saveCheckpoint({
        workspaceRef: workspace.workspace_ref,
        executionId,
        fencingVersion: current.fencing_version,
        checkpoint,
      });
      current = this.taskService.dispatch('save_checkpoint', checkpointResult, this.#executionEnvelope(current, operationId('block-checkpoint'))).execution;
    }
    const result = this.taskService.dispatch('block_task', {
      block_reason: reason,
      ...(dependency !== undefined ? { dependency } : {}),
      terminal_state: terminalState,
      checkpoint_ref: checkpointResult?.checkpoint_ref ?? current.checkpoint_ref,
      checkpoint_hash: checkpointResult?.checkpoint_hash ?? current.checkpoint_hash,
      workspace_ref: workspace?.workspace_ref ?? current.workspace_ref,
      workspace_revision: workspace?.workspace_revision ?? current.workspace_revision,
      workspace_content_hash: workspace?.content_hash ?? current.workspace_content_hash,
    }, this.#executionEnvelope(current, operationId('block')));
    // The Task Service transition is the logical ownership boundary. Fence the
    // physical Workspace only after block_task commits; otherwise a rejected
    // dependency contract leaves a RUNNING Execution with an unwritable
    // Workspace and traps the Agent in a repeated FENCED retry loop.
    const workspaceFenced = await this.#fenceWorkspaceBestEffort({
      ...current,
      workspace_ref: result.execution.workspace_ref ?? current.workspace_ref,
      fencing_version: current.fencing_version,
    }, {
      newFencingVersion: result.execution.fencing_version,
      event: 'runtime.block_workspace_fence_error',
    });
    await this.#releaseSessionBinding(active, executionId);
    if (workspaceFenced && result.execution.workspace_ref) {
      await this.workspaceManager.releaseWorkspace({
        workspaceRef: result.execution.workspace_ref,
        executionId,
        fencingVersion: result.execution.fencing_version,
      }).catch(() => undefined);
    }
    await this.#stopSandbox(executionId);
    this.activeProcesses.delete(executionId);
    this.#setCoreState(active.coreId, { state: 'IDLE', execution_id: null, task_id: null, session_id: null });
    this.logger?.append({ event: 'runtime.execution_blocked', execution_id: executionId, block_reason: reason, dependency });
    return { ...result, checkpoint: checkpointResult, workspace };
  }

  /**
   * Semantic Task handoff boundary used by the Agent-facing bridge.  The Task
   * Service commits HANDED_OFF/OPEN only after validating Handoff Material;
   * this method then performs the same physical Session/Workspace/Core
   * cleanup as the legacy Runtime handoff path.
   */
  async handoffTask(executionId, payload = {}) {
    return this.#semanticRelease(executionId, 'handoff_task', payload, 'handed_off');
  }

  /** Semantic typed block boundary used by the Agent-facing bridge. */
  async blockTask(executionId, payload = {}) {
    return this.#semanticRelease(executionId, 'block_task_semantic', payload, 'blocked');
  }

  async #semanticRelease(executionId, operation, payload, disposition) {
    const id = requireString(executionId, 'execution_id');
    const current = this.#getExecution(id);
    if (!['CREATED', 'RUNNING'].includes(current.state)) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `only an active Runtime Execution can ${operation === 'handoff_task' ? 'hand off' : 'block'} a Task`);
    }
    // Stop shell/job writes before the durable handoff/block snapshot so a
    // late Sandbox process cannot change the Workspace after the recorded
    // revision/fence.
    const activeBeforeRelease = this.activeProcesses.get(id);
    if (activeBeforeRelease) activeBeforeRelease.closing = true;
    await this.#stopSandbox(id);
    // The semantic Task transition is requested on behalf of the bound Agent.
    // Runtime still owns the physical Session/Workspace release below, but it
    // must not present its daemon actor as the Task owner.  Takes bind the
    // Execution to `owner_ref` (for example `agent:core-2`); using
    // `runtime:core-2` here made every normal handoff/block fail the Task
    // Service ownership check before Runtime could release the Core.
    let result;
    try {
      result = this.taskService.dispatch(operation, payload, this.#executionEnvelope(current, operationId(operation), current.owner_ref));
    } catch (error) {
      // Stopping Sandbox writes is a preparation step, not a committed
      // lifecycle transition. If Task Service rejects the semantic request
      // (missing handoff Material, duplicate dependency, stale version, ...),
      // keep the still-running Execution usable for a corrected retry. Leaving
      // `closing=true` here silently drops later Session events and strands a
      // RUNNING owner behind a failed handoff attempt.
      const stillActive = this.activeProcesses.get(id) === activeBeforeRelease;
      const latest = this.taskService.getExecution(id);
      if (activeBeforeRelease && stillActive && latest && ['CREATED', 'RUNNING'].includes(latest.state)) {
        activeBeforeRelease.closing = false;
        this.logger?.append({ event: 'runtime.semantic_release_rejected', execution_id: id, operation, error_class: error?.code ?? error?.name ?? 'semantic_release_rejected' });
      }
      throw error;
    }
    const workspaceRef = result.execution.workspace_ref ?? current.workspace_ref;
    await this.#fenceWorkspaceBestEffort({
      ...current,
      workspace_ref: workspaceRef,
      fencing_version: current.fencing_version,
    }, {
      newFencingVersion: result.execution.fencing_version,
      event: `runtime.${operation}_workspace_fence_error`,
    });
    await this.releaseExecution(id);
    this.logger?.append({ event: `runtime.execution_${disposition}`, execution_id: id, terminal_state: result.execution.state });
    return { ...result, disposition };
  }

  /**
   * Reconcile durable Execution deadlines. The sweep is intentionally
   * idempotent: the reminder is persisted before it is sent, and timeout is a
   * fenced Task Service transition. Schedulers may call this on every poll or
   * after a Runtime restart without creating another owner.
   */
  async sweepExecutionTimeouts(at = new Date(this.clock()), { executionIds = null } = {}) {
    const atDate = at instanceof Date ? at : new Date(at);
    if (Number.isNaN(atDate.getTime())) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'timeout sweep time must be a valid Date');
    const executionFilter = executionIds === null ? null : new Set(executionIds);
    const events = [];
    for (const execution of this.taskService.listActiveExecutions()) {
      if (executionFilter && !executionFilter.has(execution.execution_id)) continue;
      if (!['CREATED', 'RUNNING'].includes(execution.state)) continue;
      const startedMs = Date.parse(execution.started_at ?? '');
      if (Number.isNaN(startedMs)) continue;
      const reminderMs = Date.parse(execution.handoff_deadline ?? '') || startedMs + this.handoffReminderMs;
      const timeoutMs = Date.parse(execution.execution_deadline ?? '') || startedMs + this.executionTimeoutMs;
      if (atDate.getTime() >= timeoutMs) {
        const bot = this.taskService.getBot(execution.owner_ref);
        if (bot) {
          const reason = Date.parse(bot.hard_deadline) <= atDate.getTime() ? 'bot-lifetime-budget' : 'execution-timebox';
          const result = await this.stopExecution(execution.execution_id, 'FAILED', reason);
          events.push({ kind: 'timeout', ...result });
          continue;
        }
        const result = await this.handoffExecution(execution.execution_id, {
          terminalState: 'EXPIRED',
          // Preserve the existing terminal_reason string for legacy report
          // consumers; handoff_metadata.timeout_type carries the typed
          // TIMEBOX_EXPIRED classification for the new surface.
          reason: 'timeout',
          handoffKey: `timeout:${execution.execution_deadline ?? timeoutMs}`,
          at: atDate,
        });
        if (result.disposition !== 'already_terminal' && result.disposition !== 'already_waiting') events.push({ kind: 'timeout', ...result });
      } else if (atDate.getTime() >= reminderMs && !execution.handoff_reminder_sent_at) {
        const reminder = await this.#sendHandoffReminder(execution.execution_id, atDate);
        if (reminder) events.push(reminder);
      }
    }
    return events;
  }

  sweepTimeouts(at = new Date(this.clock()), options = {}) {
    return this.sweepExecutionTimeouts(at, options);
  }

  /**
   * Agent-facing progress boundary. Filesystem/checkpoint persistence is
   * attempted once, then one Progress Material records the exact handoff
   * state. A checkpoint failure leaves the Execution alive; a handoff failure
   * is recorded and still releases the old Execution so it cannot strand a
   * Core or take that unsaved work was persisted.
   */
  async executionProgress(executionId, {
    kind = 'checkpoint', progress, checkpoint = {}, files = {}, reason = 'progress_handoff', summary = null,
  } = {}) {
    const id = requireString(executionId, 'execution_id');
    if (!['checkpoint', 'handoff'].includes(kind)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'execution_progress kind must be checkpoint or handoff');
    const normalizedProgress = normalizeProgress(progress);
    let current = this.#getExecution(id);
    if (!['CREATED', 'RUNNING'].includes(current.state)) {
      return { execution: current, task: this.taskService.getTask(current.task_id), kind, disposition: 'already_terminal', save_status: 'not_applicable' };
    }
    const normalizedFiles = normalizeWaitFiles(files);
    let workspace = null;
    let checkpointResult = null;
    let saveStatus = 'not_applicable';
    let saveFailure = null;
    const lastValidSnapshot = current.workspace_ref ? {
      workspace_ref: current.workspace_ref,
      workspace_revision: current.workspace_revision,
      workspace_content_hash: current.workspace_content_hash,
      checkpoint_ref: current.checkpoint_ref,
      checkpoint_hash: current.checkpoint_hash,
    } : null;
    try {
      if (current.workspace_ref) {
        workspace = await this.workspaceManager.saveWorkspaceRevision({
          workspaceRef: current.workspace_ref,
          executionId: id,
          fencingVersion: current.fencing_version,
          files: normalizedFiles,
        });
        current = this.#saveWorkspaceReference(current, workspace, `runtime:progress-workspace:${id}:${current.state_version}`);
        checkpointResult = await this.workspaceManager.saveCheckpoint({
          workspaceRef: workspace.workspace_ref,
          executionId: id,
          fencingVersion: current.fencing_version,
          checkpoint: { ...checkpoint, progress: normalizedProgress },
        });
        current = this.taskService.dispatch('save_checkpoint', checkpointResult, this.#executionEnvelope(current, `runtime:progress-checkpoint:${id}:${current.state_version}`)).execution;
        saveStatus = 'saved';
      }
    } catch (error) {
      saveStatus = 'save_failed';
      saveFailure = { phase: workspace ? 'checkpoint' : 'workspace', error_class: error?.code ?? error?.name ?? 'save_failed' };
      this.logger?.append({ event: 'runtime.progress_save_failed', execution_id: id, phase: saveFailure.phase, error_class: saveFailure.error_class });
    }

    const recordedProgress = {
      ...normalizedProgress,
      workspace_revision: workspace?.workspace_revision ?? current.workspace_revision ?? null,
      workspace_commit: workspace?.git_commit ?? null,
    };
    let progressMaterial = null;
    let progressLink = null;
    try {
      const envelope = this.#executionEnvelope(current, `runtime:progress-material:${id}:${current.state_version}`, current.owner_ref);
      progressMaterial = this.contextService?.publishMaterialForTask
        ? this.contextService.publishMaterialForTask({
          kind: 'experience', role: 'experience', scope: 'execution_progress', evidence_state: 'observed',
          content: recordedProgress,
          provenance: {
            actor_ref: envelope.actor_ref,
            source_execution: id,
            save_status: saveStatus,
            workspace_commit: workspace?.git_commit ?? null,
            workspace_revision: workspace?.workspace_revision ?? current.workspace_revision ?? null,
          },
        }, envelope).material
        : null;
      if (progressMaterial) {
        progressLink = this.taskService.dispatch('link_material', {
          task_id: current.task_id, material_id: progressMaterial.material_id, role: 'experience',
        }, envelope).link;
      }
    } catch (error) {
      this.logger?.append({ event: 'runtime.progress_material_failed', execution_id: id, error_class: error?.code ?? error?.name ?? 'material_save_failed' });
      if (saveStatus === 'saved') saveStatus = 'save_failed';
      saveFailure ??= { phase: 'material', error_class: error?.code ?? error?.name ?? 'material_save_failed' };
    }

    const result = {
      kind,
      progress_material: progressMaterial,
      progress_link: progressLink,
      workspace: workspace ?? null,
      checkpoint: checkpointResult,
      save_status: saveStatus,
      last_valid_snapshot: lastValidSnapshot,
      loss: saveFailure ? { unsaved_progress: true, ...saveFailure } : { unsaved_progress: false },
    };
    if (kind === 'checkpoint') {
      return { ...result, execution: current, task: this.taskService.getTask(current.task_id), disposition: 'continued' };
    }
    const handed = await this.handoffExecution(id, {
      checkpoint: {}, files: {}, reason, summary,
      handoffMetadata: {
        summary,
        progress_material_id: progressMaterial?.material_id ?? null,
        save_status: saveStatus,
        last_valid_snapshot: lastValidSnapshot,
        loss: result.loss,
      },
      skipWorkspaceSave: true,
    });
    return { ...result, ...handed, save_status: saveStatus, last_valid_snapshot: lastValidSnapshot, loss: result.loss };
  }

  /**
   * End one unfinished Execution attempt and return its Task to the OPEN
   * (eligible/READY) projection. Checkpoint and Workspace writes happen
   * before the fence; the fence is durable before the old session is stopped.
   */
  async handoffExecution(executionId, {
    checkpoint = {},
    files = {},
    handoffMetadata = null,
    summary = null,
    reason = 'voluntary_handoff',
    terminalState = 'FENCED',
    handoffKey = null,
    at = new Date(this.clock()),
    skipWorkspaceSave = false,
  } = {}) {
    const id = requireString(executionId, 'execution_id');
    const existing = this.#getExecution(id);
    if (['SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED', 'FENCED', 'HANDED_OFF', 'SUPERSEDED'].includes(existing.state)) {
      return { execution: existing, task: this.taskService.getTask(existing.task_id), disposition: 'already_terminal' };
    }
    if (existing.state === 'WAITING') {
      return { execution: existing, task: this.taskService.getTask(existing.task_id), disposition: 'already_waiting' };
    }
    const inFlight = this.handoffPromises.get(id);
    if (inFlight) return inFlight;
    const promise = this.#performHandoff(id, {
      checkpoint,
      files,
      handoffMetadata,
      summary,
      reason,
      terminalState,
      handoffKey,
      at,
      skipWorkspaceSave,
    });
    this.handoffPromises.set(id, promise);
    try {
      return await promise;
    } finally {
      this.handoffPromises.delete(id);
    }
  }

  #hasLinkedHandoffMaterial(execution) {
    const links = this.taskService.listTaskMaterials?.(execution.task_id)?.links
      ?? this.taskService.getTask(execution.task_id)?.materials
      ?? [];
    return links.some((link) => link.role === 'handoff' &&
      link.material_id &&
      (link.producer_execution_id ?? link.material?.source_execution) === execution.execution_id);
  }

  async #performHandoff(executionId, { checkpoint, files, handoffMetadata, summary, reason, terminalState, handoffKey, at, skipWorkspaceSave = false }) {
    const started = this.#getExecution(executionId);
    if (!['CREATED', 'RUNNING'].includes(started.state)) {
      return { execution: started, task: this.taskService.getTask(started.task_id), disposition: started.state === 'WAITING' ? 'already_waiting' : 'already_terminal' };
    }
    if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'handoff checkpoint must be an object');
    }
    const normalizedFiles = normalizeWaitFiles(files);
    if (handoffMetadata !== null && (typeof handoffMetadata !== 'object' || Array.isArray(handoffMetadata))) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'handoff metadata must be an object');
    }
    const metadata = {
      ...(handoffMetadata ?? {}),
      summary: summary ?? handoffMetadata?.summary ?? null,
      reason,
      ...(terminalState === 'EXPIRED' ? {
        timeout_type: 'TIMEBOX_EXPIRED',
        handoff_missing: !this.#hasLinkedHandoffMaterial(started),
      } : {}),
      requested_at: new Date(at instanceof Date ? at.getTime() : at).toISOString(),
    };
    let current = started;
    const activeBeforeHandoff = this.activeProcesses.get(executionId);
    if (activeBeforeHandoff) activeBeforeHandoff.closing = true;
    await this.#drainCompactionCheckpoint(activeBeforeHandoff);
    // Freeze the Sandbox before saving the handoff snapshot.
    await this.#stopExecutionResources(executionId);
    current = this.#getExecution(executionId);
    let workspace = null;
    let checkpointResult = null;
    let saveStatus = skipWorkspaceSave ? (handoffMetadata?.save_status ?? 'not_applicable') : 'not_applicable';
    let saveFailure = null;
    const lastValidSnapshot = current.workspace_ref ? {
      workspace_ref: current.workspace_ref,
      workspace_revision: current.workspace_revision,
      workspace_content_hash: current.workspace_content_hash,
      checkpoint_ref: current.checkpoint_ref,
      checkpoint_hash: current.checkpoint_hash,
    } : null;
    if (current.workspace_ref && !skipWorkspaceSave) {
      // A handoff save is one bounded attempt. If Git/checkpoint persistence
      // fails, end the Execution from the last valid snapshot and report the
      // loss; never leave the old owner RUNNING or take the save as succeeded.
      try {
        workspace = await this.workspaceManager.saveWorkspaceRevision({
          workspaceRef: current.workspace_ref,
          executionId,
          fencingVersion: current.fencing_version,
          files: normalizedFiles,
        });
        current = this.#saveWorkspaceReference(current, workspace, `runtime:handoff-workspace:${executionId}:${current.state_version}`);
        const activeAfterWorkspace = this.activeProcesses.get(executionId);
        if (activeAfterWorkspace) {
          activeAfterWorkspace.execution = current;
          activeAfterWorkspace.workspace = workspace;
        }
        checkpointResult = await this.workspaceManager.saveCheckpoint({
          workspaceRef: workspace.workspace_ref,
          executionId,
          fencingVersion: current.fencing_version,
          checkpoint,
        });
        current = this.taskService.dispatch('save_checkpoint', checkpointResult, this.#executionEnvelope(current, `runtime:handoff-checkpoint:${executionId}:${current.state_version}`)).execution;
        const activeAfterCheckpoint = this.activeProcesses.get(executionId);
        if (activeAfterCheckpoint) activeAfterCheckpoint.execution = current;
        saveStatus = 'saved';
      } catch (error) {
        saveStatus = 'save_failed';
        saveFailure = { phase: workspace ? 'checkpoint' : 'workspace', error_class: error?.code ?? error?.name ?? 'save_failed' };
        this.logger?.append({ event: 'runtime.handoff_save_failed', execution_id: executionId, phase: saveFailure.phase, error_class: saveFailure.error_class });
        // Keep the last durably recorded Workspace/checkpoint pointers; the
        // fence still proceeds from that valid state.
        current = this.#getExecution(executionId);
      }
    }
    metadata.save_status = handoffMetadata?.save_status ?? saveStatus;
    metadata.last_valid_snapshot = handoffMetadata?.last_valid_snapshot ?? lastValidSnapshot;
    metadata.loss = handoffMetadata?.loss ?? (saveFailure ? { unsaved_progress: true, ...saveFailure } : { unsaved_progress: false });
    const handoffOperationId = `runtime:handoff:${executionId}:${handoffKey ?? `${reason}:${current.state_version}`}`;
    const oldFence = current.fencing_version;
    const result = this.taskService.dispatch('handoff_execution', {
      terminal_state: terminalState,
      terminal_reason: reason,
      checkpoint_ref: checkpointResult?.checkpoint_ref ?? current.checkpoint_ref,
      checkpoint_hash: checkpointResult?.checkpoint_hash ?? current.checkpoint_hash,
      workspace_ref: workspace?.workspace_ref ?? current.workspace_ref,
      workspace_revision: workspace?.workspace_revision ?? current.workspace_revision,
      workspace_content_hash: workspace?.content_hash ?? current.workspace_content_hash,
      handoff_metadata: metadata,
    }, this.#executionEnvelope(current, handoffOperationId));
    // Durable ownership ends before physical cleanup. A transient or stale
    // Workspace metadata error must not strand the Execution in RUNNING.
    await this.#fenceWorkspaceBestEffort({
      ...current,
      workspace_ref: result.execution.workspace_ref ?? current.workspace_ref,
      fencing_version: oldFence,
    }, { newFencingVersion: result.execution.fencing_version, event: 'runtime.handoff_workspace_fence_error' });
    await this.releaseExecution(executionId);
    this.logger?.append({ event: 'runtime.execution_handoff', execution_id: executionId, terminal_reason: reason, terminal_state: terminalState });
    return {
      ...result,
      disposition: 'handed_off',
      checkpoint: checkpointResult,
      workspace,
      save_status: metadata.save_status,
      last_valid_snapshot: metadata.last_valid_snapshot,
      loss: metadata.loss,
    };
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
      } else if (active) {
        const prompt = [
          'Execution handoff reminder: this bounded attempt is approaching its deadline.',
          'Publish durable Materials, save the current Workspace/checkpoint, summarize what was attempted and learned, list outstanding questions, and recommend the next step.',
          'Continue only if useful progress remains; otherwise call the Runtime handoff boundary.',
        ].join('\n');
        active.promptChain = active.promptChain.catch(() => undefined).then(() => active.session.prompt?.(prompt, { timeoutMs: 30_000, streamingBehavior: 'followUp' }));
        await active.promptChain.catch((error) => {
          this.logger?.append({ event: 'runtime.handoff_reminder_error', execution_id: executionId, error_class: error?.code ?? error?.name ?? 'prompt_error' });
        });
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
      last_successful_service_call_at: active.lastSuccessfulServiceCallAt ? new Date(active.lastSuccessfulServiceCallAt).toISOString() : null,
      last_productive_at: Number.isFinite(active.lastProductiveAt) ? new Date(active.lastProductiveAt).toISOString() : null,
      last_failure_class: active.lastFailureClass,
      recovery_attempt: this.recoveryAttempts.get(active.execution.task_id) ?? 0,
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

  #prepareBotExecutionStop(executionId, terminalState, reason) {
    const execution = this.#getExecution(executionId);
    const bot = this.taskService.getBot(execution.owner_ref);
    if (!bot) return;
    const intent = this.taskService.requestBotStop(bot.bot_id, reason, { terminalState });
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
      await this.#drainCompactionCheckpoint(active);
      execution = this.#getExecution(executionId);
    }
    await this.#stopExecutionResources(executionId);
    execution = this.#getExecution(executionId);
    const result = ['CREATED', 'RUNNING', 'WAITING'].includes(execution.state) ? this.taskService.dispatch('stop_execution', {
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

  async #stopExecutionResources(id, { forceSessionStop = false } = {}) {
    const active = this.activeProcesses.get(id);
    const bot = this.taskService.getBot(this.#getExecution(id).owner_ref);
    const retainedBot = bot ? this.botBindings.get(bot.bot_id) : null;
    if (retainedBot) retainedBot.closing = true;
    if (active) {
      active.closing = true;
      if (this.#canUpdateExecutionCore(active.coreId, this.#getExecution(id))) this.#setCoreState(active.coreId, { state: 'CLOSING' });
      await this.#drainCompactionCheckpoint(active);
      await this.#releaseSessionBinding(active, id, { forceStop: forceSessionStop || Boolean(bot) });
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
    await this.#stopExecutionResources(id, { forceSessionStop: before.state === 'CLOSING' });
    if (this.#getExecution(id).state === 'CLOSING') {
      if (!this.activeProcesses.has(id)) {
        throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'closing Execution requires resource reconciliation before release');
      }
      // Finish may commit while a pre-existing release awaits the provider.
      // Recheck it after stopping, including a compatibility reusable Session.
      if (before.state !== 'CLOSING') await this.#stopExecutionResources(id, { forceSessionStop: true });
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
    return { execution };
  }

  /**
   * Physical cleanup after task take committed a durable switch.
   * The Task Service already fenced the old Execution in the same
   * transaction that taken the new Task; Runtime only detaches the
   * process, Sandbox and Workspace writer so the identity Session can be
   * bound to the new Execution.
   */
  async detachSwitchedExecution(executionId, { previousFencingVersion } = {}) {
    const id = requireString(executionId, 'execution_id');
    const execution = this.#getExecution(id);
    const active = this.activeProcesses.get(id);
    if (active) {
      active.closing = true;
      await this.#drainCompactionCheckpoint(active);
    }
    await this.#stopSandbox(id);
    if (Number.isInteger(previousFencingVersion)) {
      await this.#fenceWorkspaceBestEffort({ ...execution, fencing_version: previousFencingVersion }, {
        newFencingVersion: execution.fencing_version,
        event: 'runtime.task_switch_workspace_fence_error',
      });
    }
    if (active) {
      await this.#releaseSessionBinding(active, id);
      this.activeProcesses.delete(id);
      this.#setCoreState(active.coreId, { state: 'IDLE', execution_id: null, task_id: null, session_id: null });
    }
    this.logger?.append({ event: 'runtime.task_switch_detached', execution_id: id, task_id: execution.task_id });
    return { execution };
  }

  async fenceExecution(executionId, { reason = 'fenced' } = {}) {
    this.logger?.append({ event: 'runtime.fence_execution', execution_id: executionId, terminal_reason: reason });
    let execution = this.#getExecution(executionId);
    const activeBeforeFence = this.activeProcesses.get(executionId);
    if (activeBeforeFence) {
      activeBeforeFence.closing = true;
      this.#setCoreState(activeBeforeFence.coreId, { state: 'CLOSING' });
    }
    await this.#drainCompactionCheckpoint(activeBeforeFence);
    await this.#stopExecutionResources(executionId);
    execution = this.#getExecution(executionId);
    if (!['CREATED', 'RUNNING', 'WAITING'].includes(execution.state)) return this.releaseExecution(executionId);
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
      await this.#stopExecutionResources(execution.execution_id);
      const current = this.#getExecution(execution.execution_id);
      if (!['CREATED', 'RUNNING'].includes(current.state)) {
        await this.releaseExecution(current.execution_id);
        continue;
      }
      if (Date.parse(current.lease_expires_at) > at.getTime()) {
        // A direct Service writer may still race local closing until the
        // persistent closing migration. The process is already stopped; do
        // not report an expired lease that was actually renewed.
        expired.push(await this.stopExecution(current.execution_id, 'FAILED', 'lease_changed_during_cleanup'));
        continue;
      }
      const result = this.taskService.dispatch('expire_execution', {
        runtime_generation: this.runtimeGeneration,
        terminal_reason: 'lease_expired',
      }, this.#executionEnvelope(current, operationId('expire')));
      await this.#fenceWorkspaceBestEffort(execution, {
        newFencingVersion: result.execution.fencing_version,
        event: 'runtime.expire_workspace_fence_error',
      });
      await this.releaseExecution(execution.execution_id);
      expired.push(result);
    }
    return expired;
  }

  async restart() {
    this.runtimeGeneration += 1;
    // Capture reusable identity Sessions before fenceExecution detaches them;
    // an explicit Runtime restart must actually replace the processes.
    const ownedSessions = new Set([...this.activeProcesses.values()].map((active) => active.session).filter(Boolean));
    for (const session of this.identitySessions) ownedSessions.add(session);
    for (const id of this.activeProcesses.keys()) {
      if (!['CREATED', 'RUNNING'].includes(this.#getExecution(id).state)) await this.releaseExecution(id);
    }
    for (const execution of this.taskService.listActiveExecutions()) {
      if (execution.state === 'RUNNING' || execution.state === 'CREATED') {
        await this.fenceExecution(execution.execution_id, { reason: 'runtime_restart' });
      }
    }
    for (const session of ownedSessions) {
      this.identitySessions.add(session);
      await session.stop?.();
      if (session.closed === false) throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Bot process stop was not confirmed');
      this.identitySessions.delete(session);
    }
    return { runtime_generation: this.runtimeGeneration, active_executions: this.taskService.listActiveExecutions() };
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

  async #prepareWorkspace(execution, workspaceRef = null, { fresh = false } = {}) {
    const task = this.taskService.getTask(execution.task_id);
    if (!task) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `Task is missing for execution: ${execution.execution_id}`);
    if (fresh && execution.workspace_ref) {
      throw new SwarmEnvError(ERROR_CODES.FENCED, 'clean Execution preparation cannot replace an already recorded Workspace', {
        execution_id: execution.execution_id,
        workspace_ref: execution.workspace_ref,
      });
    }
    if (execution.workspace_ref && !fresh) {
      const workspace = await this.workspaceManager.restoreWorkspace({
        workspaceRef: execution.workspace_ref,
        executionId: execution.execution_id,
        fencingVersion: execution.fencing_version,
      });
      return workspace.public_workspace_input ? workspace : this.#ensurePiSettings(execution, workspace);
    }
    const workspaceManifest = {
      task_id: task.task_id,
      spec_version: execution.spec_version,
      spec_hash: execution.spec_hash,
      workspace_snapshot_hash: execution.input_snapshot_hash,
      material_refs: execution.input_material_refs,
      selection: fresh ? { mode: 'clean', revision: null } : (execution.workspace_selection ?? { mode: 'clean', revision: null }),
    };
    const inputSnapshotManifest = {
      workspace_snapshot_hash: execution.input_snapshot_hash,
      material_refs: execution.input_material_refs,
    };
    const selection = fresh ? {} : (execution.workspace_selection ?? {});
    if (!fresh && selection.mode === 'resume' && selection.source_workspace_ref) {
      return this.workspaceManager.cloneWorkspace({
        sourceWorkspaceRef: selection.source_workspace_ref,
        targetWorkspaceRef: workspaceRef ?? this.workspaceManager.workspacePath(execution.execution_id),
        executionId: execution.execution_id,
        fencingVersion: execution.fencing_version,
        revision: selection.revision,
        task,
        workspaceManifest,
        inputSnapshotManifest,
        runtimeManifest: { runtime_generation: this.runtimeGeneration, actor_ref: this.actorRef },
      });
    }
    const freshWorkspaceRef = fresh
      ? this.workspaceManager.workspacePath(`${execution.execution_id}-fresh-${execution.fencing_version}`)
      : workspaceRef;
    const publicSnapshot = this.missionWorkspace && this.taskService.getBot(execution.owner_ref)
      ? await this.missionWorkspace.exportRevision({ workspaceId: requireString(this.missionWorkspaceId ?? task.workspace?.workspace_id, 'Mission workspace_id'), revision: task.workspace?.revision ?? 'main' })
      : null;
    if (publicSnapshot && (publicSnapshot.mission_id !== task.mission_id ||
        (task.workspace?.workspace_id && task.workspace.workspace_id !== publicSnapshot.workspace_id))) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Task Workspace inputs must belong to the Bot Mission');
    }
    const workspaceTask = publicSnapshot ? task : await this.#materializeMissionInputs(task);
    const workspace = await this.workspaceManager.createWorkspace({
      executionId: execution.execution_id,
      fencingVersion: execution.fencing_version,
      task: workspaceTask,
      publicSnapshot,
      ...(freshWorkspaceRef ? { workspaceRef: freshWorkspaceRef } : {}),
      workspaceManifest,
      inputSnapshotManifest,
      runtimeManifest: { runtime_generation: this.runtimeGeneration, actor_ref: this.actorRef },
    });
    return publicSnapshot ? workspace : this.#ensurePiSettings(execution, workspace);
  }

  async #materializeMissionInputs(task) {
    const workspace = task.workspace;
    if (!this.missionWorkspace || !workspace || typeof workspace !== 'object' ||
      typeof workspace.workspace_id !== 'string' || typeof workspace.problem_file !== 'string') {
      return task;
    }
    const input = await this.missionWorkspace.read({
      workspaceId: workspace.workspace_id,
      revision: 'main',
      path: workspace.problem_file,
      maxBytes: 10_000_000,
    });
    return {
      ...task,
      workspace: {
        ...workspace,
        formal_source: input.content,
      },
    };
  }

  async #ensurePiSettings(execution, workspace) {
    const files = await this.workspaceManager.listFiles({
      workspaceRef: workspace.workspace_ref,
      executionId: execution.execution_id,
      fencingVersion: execution.fencing_version,
      path: '',
    });
    if (files.files.some((file) => file.path === '.pi/settings.json')) return workspace;
    return this.workspaceManager.saveWorkspaceRevision({
      workspaceRef: workspace.workspace_ref,
      executionId: execution.execution_id,
      fencingVersion: execution.fencing_version,
      files: { '.pi/settings.json': JSON.stringify(PI_PROJECT_SETTINGS, null, 2) },
    });
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

  async #launch(execution, workspace, { beforePrompt = null, sessionReason = 'start', coreId = null } = {}) {
    // The extension fetches the profile from the Bridge before it registers
    // tools. Keep the child-process role in lockstep with the Runtime
    // lifecycle, including recovery restarts.
    const agentEnvironment = this.agentAdapter?.config?.env;
    if (agentEnvironment && typeof agentEnvironment === 'object' && !agentEnvironment.SWARMENV_AGENT_ROLE) {
      // A reusable Core's Bridge remains bound across Runtime recovery.  Do
      // not switch the child process to the recovery profile unless the
      // caller explicitly configured that role: the extension validates the
      // profile returned by that authenticated Bridge during startup, and a
      // recovery-only process on a bound Bridge fails before it can retry the
      // interrupted Execution.
      agentEnvironment.SWARMENV_AGENT_ROLE = AGENT_ROLES.BOUND;
    }
    const session = await this.agentAdapter.start({
      executionId: execution.execution_id,
      sessionId: randomUUID(),
      sessionDir: join(workspace.workspace_ref, '.swarm', 'pi-session'),
      cwd: workspace.workspace_ref,
      logger: this.agentLogger,
      coreId,
      taskId: execution.task_id,
      observationContext: { coreId, taskId: execution.task_id, executionId: execution.execution_id },
    });
    try {
      if (this.stopping) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Runtime stopped during startup');
      const manifestContent = JSON.stringify(session.manifest ?? {}, null, 2);
      const nextWorkspace = await this.workspaceManager.saveWorkspaceRevision({
        workspaceRef: workspace.workspace_ref,
        executionId: execution.execution_id,
        fencingVersion: execution.fencing_version,
        files: { 'runtime-manifest.json': manifestContent },
      });
      const current = this.#saveWorkspaceReference(execution, nextWorkspace);
      if (this.stopping) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Runtime stopped during preparation');
      this.#registerActiveProcess(current, nextWorkspace, session, { sessionReason, coreId });
      await this.#ensureSandbox(current, nextWorkspace);
      await beforePrompt?.({ execution: current, workspace: nextWorkspace, session });
      let initialPrompt = execution.agent_prompt;
      if (this.capabilityRegistry) {
        const role = sessionReason === 'recovery' || sessionReason === 'session_recovery'
          ? AGENT_ROLES.RECOVERY
          : AGENT_ROLES.BOUND;
        const profile = buildCapabilityProfile({
          role,
          registry: this.capabilityRegistry,
          runtimeCapabilities: this.runtimeCapabilities,
          context: { task_id: current.task_id, execution_id: current.execution_id },
        });
        const adapterHasSystemPrompt = Boolean(
          this.agentAdapter?.config?.systemPrompt || this.agentAdapter?.config?.systemPromptPath,
        );
        const staticSop = adapterHasSystemPrompt
          ? (execution.agent_prompt ?? '')
          : [
            role === AGENT_ROLES.RECOVERY ? RECOVERY_AGENT_PROMPT : BOUND_AGENT_PROMPT,
            execution.agent_prompt,
          ].filter((value) => typeof value === 'string' && value.trim().length > 0).join('\n\n');
        const promptSnapshot = buildPromptSnapshot({
          role,
          profile,
          staticSop,
          task: this.taskService.getTask(current.task_id),
          execution: current,
          workspace: nextWorkspace,
          recovery: role === AGENT_ROLES.RECOVERY
            ? { reason: current.block_reason ?? sessionReason, checkpoint: current.checkpoint_ref, dependency: current.wait_condition }
            : null,
        });
        initialPrompt = promptSnapshot.prompt;
        this.logger?.append({
          event: 'runtime.initial_prompt_composed',
          execution_id: current.execution_id,
          role: promptSnapshot.role,
          prompt_version: promptSnapshot.prompt_version,
          prompt_hash: promptSnapshot.prompt_hash,
          system_prompt_version: promptSnapshot.system_prompt_version,
          system_prompt_hash: promptSnapshot.system_prompt_hash,
          dynamic_prompt_hash: promptSnapshot.dynamic_prompt_hash,
          service_doc_hashes: promptSnapshot.service_doc_hashes,
          profile_version: promptSnapshot.profile_version,
          profile_hash: promptSnapshot.profile_hash,
        });
      }
      await this.#sendInitialPrompt(session, initialPrompt, current, nextWorkspace);
      const active = this.activeProcesses.get(execution.execution_id);
      return { execution: current, workspace: nextWorkspace, session };
    } catch (error) {
      this.#retainCleanupBinding(execution.execution_id, { session, workspace, coreId });
      throw error;
    }
  }

  #dynamicPromptContext(execution, workspace, promptOverride = null) {
    const task = this.taskService.getTask(execution.task_id);
    // Every research Execution must now belong to a Mission-scoped Task.
    if (!task?.mission_id) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Execution Task has no Mission binding');
    const mission = this.taskService.getMission?.(task.mission_id) ?? null;
    const judgeEnabled = taskUsesJudge(task);
    const workspaceEnabled = taskUsesWorkspace(task);
    const materials = task.materials
      ?? this.taskService.listTaskMaterials?.(task.task_id)?.links
      ?? [];
    const tasks = this.taskService.listMissionTasks?.({
      mission_id: task.mission_id,
      states: ['OPEN', 'BLOCKED', 'RUNNING', 'DONE', 'CLOSED', 'CANCELED'],
      limit: 32,
    })?.map((candidate) => ({
      task_id: candidate.task_id,
      summary: candidate.summary,
      state: candidate.state,
      goal: candidate.goal,
      expected_output: candidate.expected_output,
      relations: candidate.relations,
    })) ?? [];
    const notificationReader = typeof this.taskService.listUnprocessedNotifications === 'function'
      ? this.taskService.listUnprocessedNotifications.bind(this.taskService)
      : this.taskService.listPendingNotifications?.bind(this.taskService);
    const notifications = notificationReader?.(task.task_id, execution.execution_id) ?? [];
    const role = execution.session_reason === 'recovery' || execution.session_reason === 'session_recovery'
      ? AGENT_ROLES.RECOVERY
      : AGENT_ROLES.BOUND;
    const profile = this.capabilityRegistry
      ? buildCapabilityProfile({
        role,
        registry: this.capabilityRegistry,
        runtimeCapabilities: this.runtimeCapabilities,
        context: { task_id: task.task_id, execution_id: execution.execution_id },
      })
      : null;
    const services = profile?.services ?? listServices()
      .filter((service) => service.name !== 'workspace' && (service.name !== 'judge' || judgeEnabled))
      .map((service) => ({
        name: service.name,
        version: service.version,
        description: service.description,
        tools: listTools(service.name)
          .filter((tool) => workspaceEnabled || tool.capability !== 'workspace')
          .map((tool) => ({ name: tool.name, description: tool.description, scope: tool.scope })),
      }));
    return {
      prompt: composeAgentPrompt({
        staticPrompt: (promptOverride ?? execution.agent_prompt) || undefined,
        profile,
        mission,
        task: modernTaskPromptProjection(task),
        tasks,
        materials,
        notifications,
        deadline: {
          started_at: execution.started_at,
          handoff_deadline: execution.handoff_deadline,
          execution_deadline: execution.execution_deadline,
        },
        services,
        workspace: workspaceEnabled && workspace ? {
          workspace_ref: workspace.workspace_ref,
          workspace_revision: workspace.workspace_revision,
          content_hash: workspace.content_hash,
        } : null,
      }),
      notifications,
    };
  }

  async #sendInitialPrompt(session, prompt, execution = null, workspace = null) {
    if (typeof session.prompt !== 'function') return;
    const dynamic = execution ? this.#dynamicPromptContext(execution, workspace, prompt) : { prompt, notifications: [] };
    if (!dynamic.prompt) return;
    const send = async () => {
      await session.waitForReady?.({ timeoutMs: 30_000 });
      await session.setAutoCompaction?.(true);
      await session.setAutoRetry?.(true);
      this.logger?.append({
        event: 'runtime.session_configured',
        session_id: session.sessionId ?? null,
        context_window: session.contextWindow ?? null,
        auto_compaction: true,
        auto_retry: true,
        retry_max: PI_PROJECT_SETTINGS.retry.maxRetries,
        retry_base_delay_ms: PI_PROJECT_SETTINGS.retry.baseDelayMs,
        retry_max_delay_ms: PI_PROJECT_SETTINGS.retry.maxAgentDelayMs,
      });
      await session.prompt(dynamic.prompt, { timeoutMs: 30_000 });
      for (const notification of dynamic.notifications) {
        this.taskService.markNotificationDelivered?.(notification.notification_id, execution.execution_id);
      }
    };
    const active = execution ? this.activeProcesses.get(execution.execution_id) : null;
    if (active) {
      active.promptChain = active.promptChain.then(send);
      await active.promptChain;
    } else {
      await send();
    }
  }

  #notificationText(notification) {
    const payload = notification.payload ?? {};
    if (notification.notification_type === 'handoff_warning') {
      return `Execution deadline is approaching (notification_id ${notification.notification_id}). Publish and link Handoff Material now if the current Task is unfinished; this reminder is persisted.`;
    }
    if (notification.notification_type === 'material_available') {
      return `Response Material ${notification.material_id ?? payload.material_id ?? '<unknown>'} from Task ${notification.source_task_id ?? payload.producer_task_id ?? '<unknown>'} / Execution ${notification.source_execution_id ?? payload.producer_execution_id ?? '<unknown>'} is linked to this Task. Read it through Context Service and adapt your own work, then record your decision with task_feedback using notification_id ${notification.notification_id}. This notice is delivered once; it does not end your Execution or require a handoff. Call task.close only when your contract accepts the Response.`;
    }
    return `Task ${notification.recipient_task_id} is OPEN again because its typed dependency is satisfied; it is eligible when a Core is idle.`;
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
        await active.session.prompt?.(this.#notificationText(notification), {
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

  /**
   * Release one Execution's take on its Bot Session. The identity session
   * retains a reusable identity Session; freshBotPerExecution deliberately
   * stops and removes it so the next responsibility starts a new Bot.
   */
  async #releaseSessionBinding(active, executionId, { forceStop = false } = {}) {
    if (!active?.session) return;
    if (active.session.identitySession === true && !this.freshBotPerExecution && !forceStop) {
      if (active.session.boundExecutionId === executionId) active.session.boundExecutionId = null;
      this.identitySessions.add(active.session);
      return;
    }
    await active.session.stop?.();
    if (active.session.closed === false) {
      throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Bot process stop was not confirmed', { execution_id: executionId });
    }
    if (active.session.boundExecutionId === executionId) active.session.boundExecutionId = null;
    if (active.session.identitySession === true) this.identitySessions.delete(active.session);
  }

  #registerActiveProcess(execution, workspace, session, { sessionReason = 'start', coreId = null } = {}) {
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
      lastSuccessfulServiceCallAt: null,
      lastProductiveAt: nowMs,
      lastFailureClass: null,
      failurePromise: null,
      closing: false,
      identityId: session.sessionId ?? randomUUID(),
      compactionCount: this.identityCompactionCounts.get(this.#identityKey(coreId, execution)) ?? 0,
      compactionCheckpointPromise: null,
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
    this.#notifySessionStarted({ execution, workspace, session, sessionReason });
  }

  #notifySessionStarted({ execution, workspace, session, sessionReason }) {
    if (typeof this.onSessionStarted !== 'function') return;
    const notification = {
      execution,
      workspace,
      session,
      sessionReason,
      recovery: sessionReason === 'recovery',
    };
    try {
      const result = this.onSessionStarted(notification);
      if (result && typeof result.catch === 'function') {
        result.catch((error) => {
          this.logger?.append({
            event: 'runtime.session_observer_error',
            execution_id: execution.execution_id,
            session_id: session.sessionId ?? null,
            error_class: error?.code ?? error?.name ?? 'session_observer_error',
          });
        });
      }
    } catch (error) {
      this.logger?.append({
        event: 'runtime.session_observer_error',
        execution_id: execution.execution_id,
        session_id: session.sessionId ?? null,
        error_class: error?.code ?? error?.name ?? 'session_observer_error',
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
    await this.#drainCompactionCheckpoint(active);
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
      // The fourth compaction is prohibited at the adapter boundary.  A
      // start record is the earliest portable signal before Pi mutates its
      // context; fence/restart the identity immediately instead of waiting
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
    if (record.type === 'tool_execution_end' && record.isError !== true && String(record.toolName ?? '').startsWith('swarmenv_')) {
      active.lastSuccessfulServiceCallAt = this.clock();
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
      // Save exactly once for each successful compaction.  The helper waits
      // for the current turn to settle when the adapter exposes that signal;
      // it never starts a concurrent prompt or blocks identity rotation on a
      // failed filesystem/checkpoint write.
      this.#queueCompactionCheckpoint(active, record);
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

  #queueCompactionCheckpoint(active, record) {
    const executionId = active.execution.execution_id;
    const checkpoint = {
      kind: 'compaction',
      reason: record.reason ?? 'compaction',
      compaction_count: active.compactionCount,
      identity_id: active.identityId,
      tokens_before: record.result?.tokensBefore ?? record.result?.tokens_before ?? record.tokensBefore ?? null,
      estimated_tokens_after: record.result?.estimatedTokensAfter ?? record.result?.estimated_tokens_after ?? null,
    };
    // Pi can emit the next compaction event before the previous checkpoint
    // has finished saving. Queue every successful compaction in arrival order
    // instead of dropping events while one save is in flight.
    const previous = active.compactionCheckpointPromise ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      try {
        if (typeof active.session.waitForSettled === 'function') {
          await active.session.waitForSettled({ timeoutMs: 30_000 });
        }
        const current = this.#getExecution(executionId);
        if (!['CREATED', 'RUNNING'].includes(current.state)) return { status: 'not_applicable', execution: current };
        if (!current.workspace_ref) {
          this.logger?.append({ event: 'runtime.compaction_checkpoint_skipped', execution_id: executionId, identity_id: active.identityId, compaction_count: active.compactionCount, reason: 'no_workspace' });
          return { status: 'not_applicable', execution: current };
        }
        const workspace = await this.workspaceManager.saveWorkspaceRevision({
          workspaceRef: current.workspace_ref, executionId, fencingVersion: current.fencing_version, files: {},
        });
        const savedExecution = this.#saveWorkspaceReference(current, workspace, operationId('compaction-workspace'));
        const savedCheckpoint = await this.workspaceManager.saveCheckpoint({
          workspaceRef: workspace.workspace_ref, executionId, fencingVersion: savedExecution.fencing_version, checkpoint,
        });
        const checkpointResult = this.taskService.dispatch('save_checkpoint', savedCheckpoint, this.#executionEnvelope(savedExecution, operationId('compaction-checkpoint')));
        active.execution = checkpointResult.execution;
        active.workspace = workspace;
        this.logger?.append({ event: 'runtime.compaction_checkpoint_saved', execution_id: executionId, identity_id: active.identityId, compaction_count: active.compactionCount, workspace_revision: workspace.workspace_revision, checkpoint_ref: savedCheckpoint.checkpoint_ref });
        // Metadata alone is not research Progress. At this safe point ask the
        // current Bot to record substantive progress; the prompt is queued
        // only after the current turn settled and is skipped when this
        // identity is already due to rotate.
        if (this.compactionCheckpointReminder && !active.closing && !active.rotationPromise && typeof active.session.prompt === 'function') {
          const currentNow = this.#getExecution(executionId);
          if (['CREATED', 'RUNNING'].includes(currentNow.state)) {
            try {
              await active.session.prompt(
                'Compaction completed. Before continuing research, call execution_progress with kind=checkpoint and substantive completed_work, findings, open_questions, and next_step from the actual work. Do not record only token or compaction metadata.',
                { timeoutMs: 30_000, streamingBehavior: 'followUp' },
              );
            } catch (error) {
              this.logger?.append({ event: 'runtime.compaction_progress_reminder_failed', execution_id: executionId, identity_id: active.identityId, error_class: error?.code ?? error?.name ?? 'prompt_error' });
            }
          }
        }
        return { status: 'saved', execution: checkpointResult.execution, workspace, checkpoint: savedCheckpoint };
      } catch (error) {
        this.logger?.append({ event: 'runtime.compaction_checkpoint_failed', execution_id: executionId, identity_id: active.identityId, compaction_count: active.compactionCount, error_class: error?.code ?? error?.name ?? 'checkpoint_failed' });
        return { status: 'save_failed', error_class: error?.code ?? error?.name ?? 'checkpoint_failed' };
      }
    });
    const queued = run.finally(() => {
      if (active.compactionCheckpointPromise === queued) active.compactionCheckpointPromise = null;
    });
    active.compactionCheckpointPromise = queued;
    return queued;
  }

  async #drainCompactionCheckpoint(active) {
    if (!active?.compactionCheckpointPromise) return;
    await active.compactionCheckpointPromise.catch(() => undefined);
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
      // aborted.  A successful compaction already queued its one checkpoint,
      // and that in-flight save is the only save we await here.
      if (active.compactionCheckpointPromise) await active.compactionCheckpointPromise.catch(() => undefined);
      this.logger?.append({
        event: 'runtime.identity_rotation_started', execution_id: executionId,
        old_identity_id: previousIdentity, compaction_count: previousCompactions,
        reason, window_ratio: windowRatio, usage_source: usageSource,
      });
      if (this.taskService.getBot(this.#getExecution(executionId).owner_ref)) {
        return this.stopExecution(executionId, 'HANDED_OFF', 'compaction_rotation');
      }
      const restarted = await this.restartSession(executionId, { reason: 'compaction_rotation' });
      const replacement = this.activeProcesses.get(executionId);
      if (replacement) {
        replacement.compactionCount = 0;
        this.identityCompactionCounts.set(this.#identityKey(replacement.coreId, replacement.execution), 0);
      }
      this.logger?.append({
        event: 'runtime.identity_rotation_completed', execution_id: executionId,
        old_identity_id: previousIdentity, new_identity_id: replacement?.identityId ?? restarted.session?.sessionId ?? null,
        old_compaction_count: previousCompactions, new_compaction_count: replacement?.compactionCount ?? 0,
        reason,
      });
      return restarted;
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
      const coreId = active.coreId;
      if (this.taskService.getBot(this.#getExecution(executionId).owner_ref)) {
        this.#prepareBotExecutionStop(executionId, 'FAILED', failureClass);
        this.#startFinishCleanup(executionId);
        return this.stopExecution(executionId, 'FAILED', failureClass);
      }
      await this.#stopExecutionResources(executionId, { forceSessionStop: true });
      let execution = this.#getExecution(executionId);
      if (execution.state !== 'RUNNING') return this.releaseExecution(executionId);
      if (this.taskService.getBot(execution.owner_ref)) {
        this.taskService.dispatch('stop_execution', { terminal_state: 'FAILED', terminal_reason: failureClass }, this.#executionEnvelope(execution, operationId('bot-failed')));
        return this.releaseExecution(executionId);
      }
      this.identitySessions.delete(active.session);
      if (this.stopping) return { execution, disposition: 'stopping' };
      const recoveryAttempt = (this.recoveryAttempts.get(execution.task_id) ?? 0) + 1;
      this.recoveryAttempts.set(execution.task_id, recoveryAttempt);
      this.logger?.append({ event: 'runtime.session_failure', execution_id: executionId, failure_class: failureClass, recovery_attempt: recoveryAttempt });
      if (recoveryAttempt > this.maxRecoveryAttempts) {
        const fenced = await this.fenceExecution(executionId, { reason: 'recovery_exhausted' });
        this.logger?.append({ event: 'runtime.recovery_exhausted', execution_id: executionId, failure_class: failureClass, recovery_attempt: recoveryAttempt });
        return { execution: fenced.execution, recovery: null, disposition: 'exhausted' };
      }
      let task;
      try {
        task = this.taskService.getTask(execution.task_id);
      } catch (error) {
        // A shutdown may close the durable store while a process-exit event is
        // still being handled. Never keep recovery alive against a closed DB.
        if (this.stopping || error?.code === 'ERR_INVALID_STATE') return { execution, disposition: 'stopping' };
        throw error;
      }
      const recoveryPrompt = this.#recoveryPrompt(task, execution, failureClass, recoveryAttempt);
      const nextFencingVersion = execution.fencing_version + 1;
      if (execution.workspace_ref) {
        await this.workspaceManager.fenceWorkspace({
          workspaceRef: execution.workspace_ref,
          executionId: execution.execution_id,
          fencingVersion: execution.fencing_version,
          newFencingVersion: nextFencingVersion,
        });
      }
      execution = this.#getExecution(executionId);
      if (execution.state !== 'RUNNING') return this.releaseExecution(executionId);
      const recovered = this.taskService.dispatch('recover_execution', {
        runtime_generation: this.runtimeGeneration,
        agent_prompt: recoveryPrompt,
      }, this.#executionEnvelope(execution, operationId('recover')));
      // A recovered process is a fresh identity Session. Do not inherit the
      // failed Session's compaction count; only an ordinary handoff carries
      // the lane's count forward.
      this.identityCompactionCounts.delete(this.#identityKey(coreId, execution));
      if (this.activeProcesses.get(executionId) === active) {
        this.activeProcesses.delete(executionId);
        this.#setCoreState(coreId, { state: 'IDLE', execution_id: null, task_id: null, session_id: null });
      }
      const replacement = await this.startExecution(recovered.execution.execution_id, { sessionReason: 'recovery' });
      return { execution: execution, recovery: replacement.execution, disposition: 'recovered' };
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

  #recoveryPrompt(task, execution, failureClass, attempt) {
    return [
      'Resume the taken Task from its durable Workspace and checkpoint.',
      `Failure class: ${failureClass}. Recovery attempt: ${attempt}.`,
      `Task goal: ${task.goal}`,
      `Expected output: ${task.expected_output}`,
      `Workspace revision: ${execution.workspace_revision ?? 'none'}.`,
      `Checkpoint: ${execution.checkpoint_ref ?? 'none'}.`,
      'Do not assume the interrupted turn completed. Inspect the current Task, Execution, Workspace, and Materials before continuing.',
    ].join('\n');
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

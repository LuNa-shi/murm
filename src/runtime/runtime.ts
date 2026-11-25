import { randomUUID } from 'node:crypto';
import { ERROR_CODES, MurmError } from '../errors.js';
import { makeEnvelope } from '../protocol/envelope.js';
import { ExecutionWorkspace } from './execution-workspace.js';

function requireString(value: any, field: any) {
  if (typeof value !== 'string' || value.length === 0) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, `${field} is required`);
  return value;
}

function operationId(prefix: any) {
  return `runtime:${prefix}:${randomUUID()}`;
}

const DEFAULT_EXECUTION_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_HANDOFF_REMINDER_MS = 55 * 60 * 1000;

export class Runtime {
  declare taskService: any;
  declare contextService: any;
  declare workspaceManager: any;
  declare missionWorkspace: any;
  declare missionWorkspaceId: any;
  declare workspaceProjectCheck: any;
  declare coordinationPermissions: any;
  declare sandboxManager: any;
  declare executionWorkspace: any;
  declare maxWorkers: any;
  declare runtimeGeneration: any;
  declare actorRef: any;
  declare logger: any;
  declare finishCleanupRetryMs: any;
  declare maxFinishCleanupRetries: any;
  declare finishCleanupTimers: any;
  declare executionTimeoutMs: any;
  declare handoffReminderMs: any;
  declare clock: any;
  declare activeProcesses: any;
  declare botBindings: any;
  declare workspaceReconcileTimers: any;
  declare botStopPromises: any;
  declare coreStates: any;
  declare identitySessions: any;
  declare pendingFailurePromises: any;
  declare pendingReleasePromises: any;
  declare resourceReleasePromises: any;
  declare startupPromises: any;
  declare stopping: any;
  declare executionStateUnsubscribe: any;
  declare runDeadlineAt: any;

  constructor({ taskService, contextService, workspaceManager, missionWorkspace = null, missionWorkspaceId = null, workspaceProjectCheck = false, coordinationPermissions = [], sandboxManager = null, maxWorkers = 1, coreIds = null, runtimeGeneration = 1, actorRef = 'runtime:local', logger = null, finishCleanupRetryMs = 1000, maxFinishCleanupRetries = 3, executionTimeoutMs = DEFAULT_EXECUTION_TIMEOUT_MS, handoffReminderMs = DEFAULT_HANDOFF_REMINDER_MS, runDeadlineAt = null, clock = () => Date.now() }: any) {
    this.taskService = taskService;
    this.contextService = contextService;
    this.workspaceManager = workspaceManager;
    // Retained Execution preparation uses the configured public Workspace.
    this.missionWorkspace = missionWorkspace;
    this.missionWorkspaceId = missionWorkspaceId;
    this.workspaceProjectCheck = workspaceProjectCheck;
    this.coordinationPermissions = Object.freeze([...coordinationPermissions]);
    this.sandboxManager = sandboxManager;
    this.executionWorkspace = missionWorkspace && sandboxManager ? new ExecutionWorkspace({ taskService, contextService, workspace: missionWorkspace, sandboxManager,
      guard: (identity: any, options: any) => this.assertExecutionWorkspace(identity, options), onPending: (id: any) => this.#scheduleWorkspaceReconcile(id) }) : null;
    if (missionWorkspace && missionWorkspaceId) {
      taskService.setWorkspaceDeliveryReader(({ missionId, workspaceId, revision }: any) => workspaceId === missionWorkspaceId
        ? missionWorkspace.readDeliveryRevision({ workspaceId, missionId, revision }) : null);
    }
    this.maxWorkers = maxWorkers;
    this.runtimeGeneration = runtimeGeneration;
    this.actorRef = actorRef;
    this.logger = logger;
    if (!Number.isFinite(finishCleanupRetryMs) || finishCleanupRetryMs <= 0) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'finishCleanupRetryMs must be positive');
    if (!Number.isInteger(maxFinishCleanupRetries) || maxFinishCleanupRetries < 0) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'maxFinishCleanupRetries must be a non-negative integer');
    this.finishCleanupRetryMs = finishCleanupRetryMs;
    this.maxFinishCleanupRetries = maxFinishCleanupRetries;
    this.finishCleanupTimers = new Map<any, any>();
    if (!Number.isFinite(executionTimeoutMs) || executionTimeoutMs <= 0) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'executionTimeoutMs must be positive');
    if (!Number.isFinite(handoffReminderMs) || handoffReminderMs <= 0 || handoffReminderMs >= executionTimeoutMs) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'handoffReminderMs must be positive and less than executionTimeoutMs');
    this.executionTimeoutMs = executionTimeoutMs;
    this.handoffReminderMs = handoffReminderMs;
    this.setRunDeadline(runDeadlineAt);
    this.clock = clock;
    this.activeProcesses = new Map<any, any>();
    this.botBindings = new Map<any, any>();
    this.workspaceReconcileTimers = new Map<any, any>();
    this.botStopPromises = new Map<any, any>();
    this.coreStates = new Map<any, any>();
    // Reusable identity Sessions remain owned by Runtime even while no
    // Execution is bound. Shutdown must stop them too.
    this.identitySessions = new Set();
    const configuredCoreIds = Array.isArray(coreIds)
      ? coreIds
      : Array.from({ length: Math.max(0, maxWorkers) }, (_: any, index: any) => `core-${index + 1}`);
    for (const coreId of configuredCoreIds) this.registerCore(coreId);
    this.pendingFailurePromises = new Set();
    this.pendingReleasePromises = new Set();
    this.resourceReleasePromises = new Map<any, any>();
    this.startupPromises = new Set();
    this.stopping = false;
    this.executionStateUnsubscribe = typeof this.taskService?.subscribeExecutionState === 'function'
      ? this.taskService.subscribeExecutionState((event: any) => this.#onExecutionState(event))
      : null;
  }

  startBot(options: any) {
    return this.#trackStartup(() => this.#startBot(options));
  }

  async #startBot({ missionId, coreId, selectionTimeoutMs = 300_000, maxLifetimeMs = selectionTimeoutMs + this.executionTimeoutMs, startSession, readyTimeoutMs = 30_000 }: any) {
    if (typeof startSession !== 'function' || !Number.isFinite(selectionTimeoutMs) || selectionTimeoutMs <= 0 || selectionTimeoutMs > 2_147_483_647 ||
        !Number.isFinite(readyTimeoutMs) || readyTimeoutMs <= 0 || !Number.isInteger(maxLifetimeMs) || maxLifetimeMs < 2 || maxLifetimeMs > 2_147_483_647) {
      throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Bot requires a Session factory and finite selection and lifetime limits');
    }
    if (this.stopping) throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Runtime stopped during Bot startup');
    if (this.getCoreStatus(coreId)?.state !== 'IDLE' || this.taskService.getActiveExecutionForCore(coreId)) {
      throw new MurmError(ERROR_CODES.CONFLICT, 'Core is occupied');
    }
    const startedAt = Date.now();
    const hardDeadlineAt = Math.min(startedAt + maxLifetimeMs, this.runDeadlineAt ?? Infinity);
    if (hardDeadlineAt <= startedAt) throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Mission run deadline already elapsed');
    const bot = this.taskService.registerBot({ missionId, coreId, coordinationPermissions: this.coordinationPermissions, selectionDeadline: new Date(Math.min(startedAt + selectionTimeoutMs, hardDeadlineAt)).toISOString(), hardDeadline: new Date(hardDeadlineAt).toISOString() });
    const binding: any = { botId: bot.bot_id, coreId, session: null, starting: true, selectionTimer: null, hardTimer: null };
    this.botBindings.set(bot.bot_id, binding);
    this.#setCoreState(coreId, { state: 'STARTING', bot_id: bot.bot_id, execution_id: null, task_id: null });
    const controller = new AbortController();
    binding.cancelStartup = () => controller.abort(new MurmError(ERROR_CODES.NOT_ALLOWED, 'Bot startup was stopped'));
    const cancelled = new Promise<any>((_: any, reject: any) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }));
    void cancelled.catch(() => undefined);
    const stopUnbound = (reason: any) => {
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
    binding.armDeadline = (deadlineAt: any, reason: any) => {
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
        throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Runtime stopped during Bot startup');
      }
    };
    const assertStartupAllowed = () => {
      assertRuntimeStartupOpen();
      this.taskService.assertBotStartupAllowed(bot.bot_id);
    };
    const factory = Promise.resolve().then(() => startSession({ bot, signal: controller.signal, assertStartupAllowed,
      onSandboxCreateDispatch: (resource: any) => {
        assertRuntimeStartupOpen();
        this.taskService.recordBotSandboxDispatch(bot.bot_id,
          { provider: resource.provider, timeoutSeconds: resource.timeout_seconds });
      },
      onSandboxCreateRejected: () => this.taskService.recordBotSandboxRejection(bot.bot_id),
      onSandboxCreated: (resource: any) => this.taskService.recordBotSandbox(bot.bot_id,
        { provider: resource.provider ?? 'opensandbox', sandboxId: resource.sandbox_id, expiresAt: resource.expires_at }) }));
    const prepared = factory.then((session: any) => {
      binding.session = session;
      binding.starting = false;
      if (!session || typeof session.stop !== 'function') throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Bot Session must support confirmed stop');
      this.identitySessions.add(session);
      session.on?.('close', () => stopUnbound('process-exited'));
      session.on?.('processError', () => stopUnbound('process-error'));
      return session;
    }, (error: any) => { binding.starting = false; throw error; });
    // A non-cooperative factory can settle after the caller's deadline. Its
    // late resource still belongs to this retained Bot, never a successor.
    void prepared.then(() => {
      if (controller.signal.aborted) this.#startFinishCleanup(bot.bot_id, 0, true);
    }, () => {
      if (controller.signal.aborted) this.#startFinishCleanup(bot.bot_id, 0, true);
    });
    try {
      const session = await Promise.race([prepared, cancelled]);
      if (session.closed) throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Bot startup was stopped');
      assertStartupAllowed();
      await Promise.race([(async () => {
        await session.waitForReady({ timeoutMs: readyTimeoutMs });
        assertStartupAllowed();
        await session.setAutoCompaction?.(true);
        assertStartupAllowed();
        await session.setAutoRetry?.(true);
      })(), cancelled]);
      if (session.closed) throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Bot startup was stopped');
      assertRuntimeStartupOpen();
      const ready = this.taskService.markBotReady(bot.bot_id);
      this.#setCoreState(coreId, { state: 'DISCOVERING', session_id: session.sessionId ?? null });
      return { bot: ready, session };
    } catch (error: any) {
      this.taskService.requestBotStop(bot.bot_id, 'startup-failed');
      binding.cancelStartup();
      try { await this.releaseBot(bot.bot_id); }
      catch (cleanupError: any) { this.logger?.append({ event: 'runtime.bot_cleanup_pending', bot_id: bot.bot_id, error_class: cleanupError?.code ?? cleanupError?.name }); }
      throw error;
    }
  }

  async releaseBot(botId: any) {
    const pending = this.resourceReleasePromises.get(botId);
    if (pending) return pending;
    const release = this.#releaseBotResources(botId).finally(() => this.resourceReleasePromises.delete(botId));
    this.resourceReleasePromises.set(botId, release);
    return release;
  }

  async #releaseBotResources(botId: any): Promise<any> {
    const bot = this.taskService.getBot(botId);
    const binding: any = this.botBindings.get(botId);
    if (bot?.state === 'CLOSED' && !binding) return { bot };
    if (!bot || !binding || bot.state !== 'CLOSING' || bot.execution_id) {
      throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'unbound Bot cleanup requires its retained resource binding');
    }
    this.#setCoreState(binding.coreId, { state: 'CLOSING' });
    const stoppedSession = binding.session;
    await stoppedSession?.stop?.();
    if (stoppedSession?.closed === false) throw new MurmError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Bot stop was not confirmed');
    const stopped = await this.sandboxManager?.stopExecution(bot.resource_key);
    if (stopped === false && this.taskService.getBot(botId)?.sandbox_create_state === 'UNKNOWN') {
      throw new MurmError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Unknown sandbox creation requires confirmed cleanup');
    }
    if (binding.session !== stoppedSession || this.taskService.getBot(botId).sandbox_id !== bot.sandbox_id) return this.#releaseBotResources(botId);
    if (binding.starting) throw new MurmError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Bot factory has not settled; late resources remain owned');
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
  registerCore(coreId: any) {
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

  getCoreStatus(coreId: any) {
    const id = requireString(coreId, 'core_id');
    const state = this.coreStates.get(id);
    if (!state) return null;
    return { ...state };
  }

  hasActiveExecution(executionId: any) {
    return this.activeProcesses.has(executionId);
  }

  async waitForSettled() {
    for (;;) {
      const pending = [...this.pendingFailurePromises, ...this.pendingReleasePromises];
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  /** Stop every live process owned by this Runtime before its store is closed. */
  async shutdown({ terminalState = 'FAILED', terminalReason = 'runtime_shutdown' }: any = {}) {
    this.stopping = true;
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
    const executionIds = [...this.activeProcesses.keys()];
    // A reusable identity Session is intentionally preserved on a normal
    // release, but shutdown owns every live process. Capture them before the
    // release path detaches the Execution binding.
    const ownedSessions = new Set([...this.activeProcesses.values()].map((active: any) => active.session).filter(Boolean));
    for (const session of this.identitySessions) ownedSessions.add(session);
    const stopOwnedExecution = async (executionId: any) => {
      const execution = this.taskService.getExecution(executionId);
      try {
        if (execution && ['CREATED', 'RUNNING'].includes(execution.state)) {
          await this.stopExecution(executionId, terminalState, terminalReason);
        } else {
          await this.releaseExecution(executionId);
        }
      } catch (error: any) {
        this.logger?.append({ event: 'runtime.shutdown_cleanup_pending', execution_id: executionId, error_class: error?.code ?? error?.name });
      }
    };
    const stoppingExecutions = executionIds.map(stopOwnedExecution);
    const stoppingBots = [...this.botBindings.keys()].map(async (botId: any) => {
      const bot = this.taskService.getBot(botId);
      if (bot?.execution_id) return;
      try {
        this.taskService.requestBotStop(botId, terminalReason);
        await this.releaseBot(botId);
      } catch (error: any) { this.logger?.append({ event: 'runtime.bot_cleanup_pending', bot_id: botId, error_class: error?.code ?? error?.name }); }
    });
    await Promise.allSettled([...pendingStarts, ...stoppingExecutions, ...stoppingBots]);
    // A launch already in flight can register its rejected Session only when
    // it returns. Join and stop that late ownership as well.
    await Promise.allSettled([...this.activeProcesses.keys()].filter((id: any) => !executionIds.includes(id)).map(stopOwnedExecution));
    for (const session of this.identitySessions) ownedSessions.add(session);
    for (const session of ownedSessions) {
      if ([...this.activeProcesses.values()].some((active: any) => active.session === session)) continue;
      try {
        await session.stop?.();
        if (session.closed === false) throw new Error('Bot process stop was not confirmed');
        this.identitySessions.delete(session);
      } catch (error: any) {
        this.identitySessions.add(session);
        this.logger?.append({ event: 'runtime.shutdown_session_cleanup_pending', session_id: session.sessionId ?? null, error_class: error?.code ?? error?.name });
      }
    }
    await this.waitForSettled();
    return { active_process_count: this.activeProcesses.size, cleanup_pending_execution_ids: [...this.activeProcesses.keys()], cleanup_pending_session_count: this.identitySessions.size, cleanup_pending_bot_ids: [...this.botBindings.keys()] };
  }

  assertExecutionWorkspace({ actorRef, taskId, executionId, fencingVersion }: any, { receiptOnly = false, newWork = false }: any = {}) {
    const execution = this.taskService.getExecution(executionId);
    if (newWork && execution) this.taskService.assertMissionResearchOpen(this.taskService.getTask(execution.task_id)?.mission_id);
    const bot = this.taskService.getBot(actorRef);
    const task = execution && this.taskService.getTask(execution.task_id);
    if (!bot || !execution || execution.owner_ref !== actorRef || execution.task_id !== taskId ||
        bot.mission_id !== task?.mission_id || execution.workspace_input?.workspace_id !== this.missionWorkspaceId) {
      throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Workspace request must match its durable Bot, Task and Mission');
    }
    if (receiptOnly) return execution;
    const binding: any = this.botBindings.get(actorRef);
    const active = this.activeProcesses.get(executionId);
    if (this.stopping || bot.state !== 'ACTIVE' || bot.execution_id !== executionId || execution.state !== 'RUNNING' ||
        execution.fencing_version !== fencingVersion || !binding || binding.closing || !binding.session || binding.session.closed ||
        !active || active.closing || active.session !== binding.session || execution.core_id !== bot.core_id) {
      throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Workspace contribution requires the current active Bot binding');
    }
    this.taskService.assertBotDeadline(actorRef);
    return execution;
  }

  async dispatchExecutionWorkspace(operation: any, input: any, identity: any) {
    if (!this.executionWorkspace) throw new MurmError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Execution Workspace control is unavailable');
    return this.executionWorkspace.dispatch(operation, input, identity);
  }

  // Only retained pre-retirement install requests can schedule these retries.
  // New apply admission is absent; save recovery still runs at request/close boundaries.
  #scheduleWorkspaceReconcile(executionId: any, attempt: any = 0) {
    if (this.stopping || this.workspaceReconcileTimers.has(executionId)) return;
    const reconcile = async () => {
      let retry = false;
      try { await this.executionWorkspace.reconcile(executionId); }
      catch (error: any) {
        this.logger?.append({ event: 'runtime.workspace_apply_pending', execution_id: executionId, attempt, error_class: error.code ?? error.name });
        if (attempt < 10) retry = true;
        else {
          try { await this.stopExecution(executionId, 'FAILED', 'workspace_apply_reconciliation_failed'); }
          catch (stopError: any) { this.logger?.append({ event: 'runtime.workspace_apply_cleanup_pending', execution_id: executionId, error_class: stopError.code ?? stopError.name }); }
        }
      } finally {
        this.workspaceReconcileTimers.delete(executionId);
        if (retry) this.#scheduleWorkspaceReconcile(executionId, attempt + 1);
      }
    };
    const entry: any = { timer: null };
    entry.timer = setTimeout(() => {
      const pending = reconcile().finally(() => this.pendingReleasePromises.delete(pending));
      this.pendingReleasePromises.add(pending);
      pending.catch(() => {});
    }, 1000);
    this.workspaceReconcileTimers.set(executionId, entry);
  }

  async #ensureSandbox(execution: any, workspace: any) {
    if (!this.sandboxManager) return;
    const bot = this.taskService.getBot(execution.owner_ref);
    if (!bot || !workspace?.public_workspace_input) throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Bot Sandbox preparation requires pinned public Workspace input');
    if (bot.execution_id !== execution.execution_id) throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Bot does not own this Execution');
    this.sandboxManager.bindBotExecution({ botId: bot.bot_id, executionId: execution.execution_id,
      workspaceRef: workspace.workspace_ref, bindingVersion: execution.fencing_version });
    await this.sandboxManager.syncWorkspace({ executionId: execution.execution_id, workspaceRef: workspace.workspace_ref, manifest: workspace.public_workspace_input.manifest });
    await this.sandboxManager.prepareBotProject({ executionId: execution.execution_id, manifest: workspace.public_workspace_input.manifest });
  }

  async #stopSandbox(executionId: any) {
    if (!this.sandboxManager || !executionId) return;
    try {
      await this.sandboxManager.stopExecution(executionId);
    } catch (error: any) {
      this.logger?.append({ event: 'runtime.sandbox_stop_error', execution_id: executionId, error_class: error?.code ?? error?.name ?? 'sandbox_stop_error' });
      throw error;
    }
  }

  #trackStartup(start: any) {
    if (this.stopping) throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Runtime is stopping');
    const starting = start().finally(() => this.startupPromises.delete(starting));
    this.startupPromises.add(starting);
    return starting;
  }

  async bindAgentExecution(...args: any[]) {
    return this.#trackStartup(() => (this.#bindAgentExecution as any)(...args));
  }

  async #bindAgentExecution(executionId: any, session: any = null, { workspaceRef, coreId = null }: any = {}) {
    this.logger?.append({ event: 'runtime.bind_execution', execution_id: executionId });
    if (!session || typeof session.stop !== 'function') {
      throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Original Bot Session is required');
    }
    const execution = this.#getExecution(executionId);
    if (execution.state !== 'CREATED') throw new MurmError(ERROR_CODES.NOT_ALLOWED, `Runtime can only bind CREATED executions, got ${execution.state}`);
    if (this.activeProcesses.size >= this.maxWorkers) throw new MurmError(ERROR_CODES.CONFLICT, 'Runtime capacity is exhausted');
    const selectedCoreId = this.#resolveCoreId(execution, coreId);
    this.#assertCoreAvailable(selectedCoreId, execution.execution_id);
    let workspace: any = null;
    let current = execution;
    const registeredBot = this.taskService.getBot(execution.owner_ref);
    if (!registeredBot) throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Execution startup requires a registered Bot');
    if (this.botBindings.get(registeredBot.bot_id)?.session !== session || registeredBot.core_id !== selectedCoreId) {
      throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Task take must bind its original Bot Session and Core');
    }
    const boundSession = session;
    let preparationLeaseTimer: any = null;
    let preparationLeaseError: any = null;
    const renewPreparationLease = () => {
      this.taskService.assertMissionResearchOpen(registeredBot.mission_id);
      this.taskService.assertBotDeadline(registeredBot.bot_id);
      const owner = this.taskService.getBot(registeredBot.bot_id);
      const reserved = this.#getExecution(executionId);
      if (this.stopping || owner?.state !== 'PREPARING' || owner.execution_id !== executionId ||
          reserved.state !== 'CREATED' || reserved.fencing_version !== execution.fencing_version) {
        throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Bot preparation no longer owns its reservation');
      }
      this.heartbeat(executionId);
    };
    try {
      renewPreparationLease();
      preparationLeaseTimer = setInterval(() => {
        try { renewPreparationLease(); }
        catch (error: any) {
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
          throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Task take must bind its original Bot Session and Core');
        }
        clearTimeout(retained.selectionTimer);
        await this.#ensureSandbox(current, workspace);
        if (retained.closing || boundSession.closed || this.stopping || this.taskService.getBot(bot.bot_id)?.state !== 'PREPARING') {
          throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Bot stopped during Task preparation');
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
        if (latestBot.state !== 'ACTIVE' || this.botBindings.get(bot.bot_id)?.closing || boundSession.closed || this.stopping) throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Bot stopped during project grant');
        this.taskService.assertMissionResearchOpen(bot.mission_id);
        this.taskService.assertBotDeadline(bot.bot_id);
      }
      if (this.stopping) throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Runtime stopped during startup');
      this.#registerActiveProcess(current, workspace, boundSession, { coreId: selectedCoreId });
      return { execution: current, workspace, session: boundSession };
    } catch (error: any) {
      await this.stopExecution(executionId, 'FAILED', 'bind_prepare_failed');
      throw error;
    } finally {
      clearInterval(preparationLeaseTimer);
    }
  }

  /**
   * Reconcile durable Execution deadlines. The sweep is intentionally
   * idempotent: timeout is a durable Bot stop. Handoff warnings are owned by
   * the Flat controller. Maintenance may call this on every poll.
   */
  async sweepExecutionTimeouts(at: any = new Date(this.clock()), { executionIds = null }: any = {}) {
    const atDate = at instanceof Date ? at : new Date(at);
    if (Number.isNaN(atDate.getTime())) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'timeout sweep time must be a valid Date');
    const executionFilter = executionIds === null ? null : new Set(executionIds);
    const events: any[] = [];
    for (const execution of this.taskService.listActiveExecutions()) {
      if (executionFilter && !executionFilter.has(execution.execution_id)) continue;
      if (!['CREATED', 'RUNNING'].includes(execution.state)) continue;
      const bot = this.taskService.getBot(execution.owner_ref);
      if (!bot || !this.botBindings.has(bot.bot_id)) continue;
      const startedMs = Date.parse(execution.started_at ?? '');
      if (Number.isNaN(startedMs)) continue;
      const timeoutMs = Date.parse(execution.execution_deadline ?? '') || startedMs + this.executionTimeoutMs;
      if (atDate.getTime() >= timeoutMs) {
        const reason = Date.parse(bot.hard_deadline) <= atDate.getTime() ? 'bot-lifetime-budget' : 'execution-timebox';
        const result = await this.stopExecution(execution.execution_id, 'FAILED', reason);
        events.push({ kind: 'timeout', ...result });
      }
    }
    return events;
  }

  heartbeat(executionId: any, payload: any = {}) {
    this.logger?.append({ event: 'runtime.heartbeat', execution_id: executionId });
    const execution = this.#getExecution(executionId);
    if (this.activeProcesses.get(executionId)?.closing) throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Closing Execution cannot renew its lease');
    const result = this.taskService.dispatch('heartbeat', payload, this.#executionEnvelope(execution, operationId('heartbeat')));
    const active = this.activeProcesses.get(executionId);
    if (active) {
      active.execution = result.execution;
    }
    return result;
  }

  #prepareBotExecutionStop(executionId: any, terminalState: any, reason: any, { leaseExpiredAt = null }: any = {}) {
    const execution = this.#getExecution(executionId);
    const bot = this.taskService.getBot(execution.owner_ref);
    if (!bot) return;
    if (bot.state !== 'CLOSED' && !this.botBindings.has(bot.bot_id)) {
      throw new MurmError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Persisted Bot has no in-process resource owner; isolation remains unconfirmed');
    }
    const intent = this.taskService.requestBotStop(bot.bot_id, reason, { terminalState, leaseExpiredAt });
    if (!intent) return null;
    const binding: any = this.botBindings.get(bot.bot_id);
    if (binding) {
      binding.closing = true;
      this.#retainCleanupBinding(executionId, { session: binding.session, workspace: null, coreId: binding.coreId });
    }
    return intent;
  }

  async stopExecution(executionId: any, terminalState: any = 'CANCELLED', terminalReason: any = null) {
    if (this.botStopPromises.has(executionId)) return this.botStopPromises.get(executionId);
    const stopping = this.#stopExecution(executionId, terminalState, terminalReason).finally(() => this.botStopPromises.delete(executionId));
    this.botStopPromises.set(executionId, stopping);
    return stopping;
  }

  async #stopExecution(executionId: any, terminalState: any, terminalReason: any) {
    let reason = terminalReason ?? terminalState.toLowerCase();
    const intent = this.#prepareBotExecutionStop(executionId, terminalState, reason);
    terminalState = intent?.stop_terminal_state ?? terminalState;
    reason = intent?.stop_terminal_state ? intent.exit_reason : reason;
    this.logger?.append({ event: 'runtime.stop_execution', execution_id: executionId, terminal_state: terminalState, terminal_reason: reason });
    let execution = this.#getExecution(executionId);
    const active = this.activeProcesses.get(executionId);
    if (active) {
      // Close admission before fencing/releasing the Workspace.
      active.closing = true;
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
  async releaseExecution(executionId: any) {
    const id = requireString(executionId, 'execution_id');
    const pending = this.resourceReleasePromises.get(id);
    if (pending) return pending;
    const release = this.#releaseExecutionResources(id).finally(() => this.resourceReleasePromises.delete(id));
    this.resourceReleasePromises.set(id, release);
    return release;
  }

  #retainCleanupBinding(id: any, { session = null, workspace = null, coreId = null }: any = {}) {
    const execution = this.#getExecution(id);
    const active = this.activeProcesses.get(id) ?? { execution, session, workspace, coreId };
    active.closing = true;
    this.activeProcesses.set(id, active);
    if (this.#canUpdateExecutionCore(active.coreId, execution)) this.#setCoreState(active.coreId, { state: 'CLOSING', execution_id: id, task_id: execution.task_id, session_id: active.session?.sessionId ?? null });
  }

  async #stopExecutionResources(id: any) {
    const active = this.activeProcesses.get(id);
    const bot = this.taskService.getBot(this.#getExecution(id).owner_ref);
    const retainedBot = bot ? this.botBindings.get(bot.bot_id) : null;
    if (bot && bot.state !== 'CLOSED' && !retainedBot) {
      throw new MurmError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Persisted Bot has no in-process resource owner; isolation remains unconfirmed');
    }
    if (retainedBot) retainedBot.closing = true;
    if (active) {
      active.closing = true;
      if (this.#canUpdateExecutionCore(active.coreId, this.#getExecution(id))) this.#setCoreState(active.coreId, { state: 'CLOSING' });
      await this.#releaseSessionBinding(active, id);
    }
    if (retainedBot?.session && retainedBot.session !== active?.session) {
      await retainedBot.session.stop();
      if (retainedBot.session.closed === false) throw new MurmError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Bot stop was not confirmed');
      this.identitySessions.delete(retainedBot.session);
    }
    await this.#stopSandbox(id);
    if (bot) await this.sandboxManager?.stopExecution(bot.resource_key);
  }

  async #releaseExecutionResources(id: any): Promise<any> {
    const before = this.#getExecution(id);
    if (before.state === 'CLOSING' && !this.activeProcesses.has(id)) {
      throw new MurmError(ERROR_CODES.SERVICE_UNAVAILABLE, 'closing Execution requires resource reconciliation before release');
    }
    await this.#stopExecutionResources(id);
    await this.executionWorkspace?.reconcile(id, { closedConfirmed: true });
    if (this.#getExecution(id).state === 'CLOSING') {
      if (!this.activeProcesses.has(id)) {
        throw new MurmError(ERROR_CODES.SERVICE_UNAVAILABLE, 'closing Execution requires resource reconciliation before release');
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

  async fenceExecution(executionId: any, { reason = 'fenced' }: any = {}) {
    this.logger?.append({ event: 'runtime.fence_execution', execution_id: executionId, terminal_reason: reason });
    let execution = this.#getExecution(executionId);
    this.#prepareBotExecutionStop(executionId, 'FAILED', reason);
    const activeBeforeFence = this.activeProcesses.get(executionId);
    if (activeBeforeFence) {
      activeBeforeFence.closing = true;
      this.#setCoreState(activeBeforeFence.coreId, { state: 'CLOSING' });
    }
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

  async sweepExpired(at: any = new Date()) {
    this.logger?.append({ event: 'runtime.sweep_expired', at: at.toISOString() });
    const expired: any[] = [];
    for (const botId of this.botBindings.keys()) {
      const bot = this.taskService.getBot(botId);
      if (bot?.state !== 'CLOSING') continue;
      try {
        if (bot.execution_id && bot.stop_terminal_state) await this.stopExecution(bot.execution_id, bot.stop_terminal_state, bot.exit_reason);
        else if (!bot.execution_id) await this.releaseBot(botId);
      }
      catch (error: any) { this.logger?.append({ event: 'runtime.bot_cleanup_pending', bot_id: botId, error_class: error?.code ?? error?.name }); }
    }
    // A finish may already be terminal while its Workspace release is still
    // pending. Durable active rows alone cannot enumerate retained resources.
    for (const id of [...this.activeProcesses.keys()]) {
      if (!this.taskService.getExecution(id)?.finish) continue;
      try { await this.releaseExecution(id); }
      catch (error: any) { this.logger?.append({ event: 'runtime.finish_cleanup_pending', execution_id: id, error_class: error?.code ?? error?.name }); }
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

  #getExecution(executionId: any) {
    const execution = this.taskService.getExecution(requireString(executionId, 'execution_id'));
    if (!execution) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, `unknown execution: ${executionId}`);
    return execution;
  }

  async #fenceWorkspaceBestEffort(execution: any, { newFencingVersion = execution?.fencing_version + 1, event = 'runtime.workspace_fence_error' }: any = {}) {
    if (!execution?.workspace_ref) return true;
    try {
      await this.workspaceManager.fenceWorkspace({
        workspaceRef: execution.workspace_ref,
        executionId: execution.execution_id,
        fencingVersion: execution.fencing_version,
        newFencingVersion,
      });
      return true;
    } catch (error: any) {
      this.logger?.append({
        event,
        execution_id: execution.execution_id,
        error_class: error?.code ?? error?.name ?? 'workspace_fence_error',
      });
      return false;
    }
  }

  async #prepareWorkspace(execution: any, workspaceRef: any = null) {
    const task = this.taskService.getTask(execution.task_id);
    if (!task) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, `Task is missing for execution: ${execution.execution_id}`);
    if (execution.workspace_ref) {
      throw new MurmError(ERROR_CODES.FENCED, 'clean Execution preparation cannot replace an already recorded Workspace', {
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
      throw new MurmError(ERROR_CODES.SERVICE_NOT_READY, 'Registered Bot take requires the authoritative Mission Workspace');
    }
    const publicSnapshot = await this.missionWorkspace.exportRevision({ workspaceId: publicWorkspaceId, revision: task.workspace?.revision ?? 'main' });
    if (publicSnapshot && (publicSnapshot.mission_id !== task.mission_id ||
        (task.workspace?.workspace_id && task.workspace.workspace_id !== publicSnapshot.workspace_id))) {
      throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Task Workspace inputs must belong to the Bot Mission');
    }
    if (publicSnapshot) {
      if (execution.input_material_refs.length && typeof this.contextService?.readTakeMaterialInputs !== 'function') {
        throw new MurmError(ERROR_CODES.SERVICE_NOT_READY, 'Task input Materials require the authoritative Context Service');
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

  #saveWorkspaceReference(execution: any, workspace: any, saveOperationId: any = operationId('workspace')) {
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
      } catch (error: any) {
        if (error?.code !== ERROR_CODES.STALE_VERSION || attempt === 2) throw error;
        current = this.#getExecution(execution.execution_id);
      }
    }
    throw new MurmError(ERROR_CODES.STALE_VERSION, 'could not persist Workspace reference after concurrent updates');
  }

  // A Bot owns one Session; release confirms its stop before freeing capacity.
  async #releaseSessionBinding(active: any, executionId: any) {
    if (!active?.session) return;
    await active.session.stop?.();
    if (active.session.closed === false) {
      throw new MurmError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Bot process stop was not confirmed', { execution_id: executionId });
    }
    if (active.session.boundExecutionId === executionId) active.session.boundExecutionId = null;
    if (active.session.identitySession === true) this.identitySessions.delete(active.session);
  }

  #registerActiveProcess(execution: any, workspace: any, session: any, { coreId = null }: any = {}) {
    const active = {
      session,
      execution,
      workspace,
      coreId,
      failurePromise: null,
      closing: false,
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

  #startFinishCleanup(id: any, attempt: any = 0, isBot: any = false) {
    const bindings = isBot ? this.botBindings : this.activeProcesses;
    if ((this.stopping && !isBot) || !bindings.has(id)) return;
    const execution = isBot ? null : this.taskService.getExecution(id);
    const bot = execution ? this.taskService.getBot(execution.owner_ref) : null;
    const cleanup = isBot ? this.releaseBot(id) : bot?.stop_terminal_state && !execution.finish
      ? this.stopExecution(id, bot.stop_terminal_state, bot.exit_reason) : this.releaseExecution(id);
    const promise = cleanup.catch((error: any) => {
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

  #onExecutionState(event: any) {
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
      void promise.catch((error: any) => this.logger?.append({ event: 'runtime.fenced_cleanup_pending', execution_id: executionId, error_class: error?.code ?? error?.name }));
    }
  }

  async #releaseFencedProcess(executionId: any) {
    const active = this.activeProcesses.get(executionId);
    if (!active) return;
    active.closing = true;
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

  async #processExit(executionId: any) {
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

  async #handleSessionFailure(executionId: any, failureClass: any) {
    if (this.stopping) {
      await this.releaseExecution(executionId);
      return null;
    }
    const active = this.activeProcesses.get(executionId);
    if (!active) return null;
    if (active.failurePromise) return active.failurePromise;
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

  #executionEnvelope(execution: any, id: any, actorRef: any = this.actorRef) {
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

  #resolveCoreId(execution: any, requestedCoreId: any) {
    const persisted = execution.core_id ?? execution.coreId ?? null;
    if (requestedCoreId !== null && requestedCoreId !== undefined) {
      const selected = requireString(requestedCoreId, 'core_id');
      if (persisted !== null && persisted !== selected) {
        throw new MurmError(ERROR_CODES.CONFLICT, 'Execution is bound to another Core', {
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
    const idle = [...this.coreStates.values()].find((state: any) => state.state === 'IDLE');
    return idle?.core_id ?? null;
  }

  #canUpdateExecutionCore(coreId: any, execution: any) {
    const current = this.coreStates.get(coreId);
    return (!current?.bot_id || current.bot_id === execution.owner_ref) &&
      (!current?.execution_id || current.execution_id === execution.execution_id);
  }

  #assertCoreAvailable(coreId: any, executionId: any) {
    if (coreId === null) return;
    const current = this.coreStates.get(coreId);
    if (current?.bot_id && this.taskService.getBot(current.bot_id)?.execution_id !== executionId) {
      throw new MurmError(ERROR_CODES.CONFLICT, 'Core already owns a Bot', { core_id: coreId, bot_id: current.bot_id });
    }
    if (current && current.execution_id !== null && current.execution_id !== executionId) {
      throw new MurmError(ERROR_CODES.CONFLICT, 'Core already owns an active Execution', {
        core_id: coreId,
        execution_id: current.execution_id,
      });
    }
  }

  #setCoreState(coreId: any, patch: any) {
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
  }

  /**
   * Bind every Execution deadline to the run's global deadline. The handoff
   * reminder keeps its lead time (executionTimeoutMs - handoffReminderMs)
   * before whichever deadline comes first, so a long Execution is reminded
   * only near the end of the run, not at a fixed offset from its start.
   */
  setRunDeadline(runDeadlineAt: any) {
    if (runDeadlineAt !== null && runDeadlineAt !== undefined && !Number.isFinite(runDeadlineAt)) {
      throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'runDeadlineAt must be an epoch millisecond value');
    }
    this.runDeadlineAt = runDeadlineAt ?? null;
  }

  #executionTimingPayload(at: any = this.clock(), execution: any = null) {
    const task = execution?.task_id ? this.taskService.getTask(execution.task_id) : null;
    const taskTimeout = task?.mission_id && Number.isInteger(task.timebox_ms) ? task.timebox_ms : this.executionTimeoutMs;
    const leadMs = Math.max(1, this.executionTimeoutMs - this.handoffReminderMs);
    const untilRunDeadline = this.runDeadlineAt === null ? Number.POSITIVE_INFINITY : this.runDeadlineAt - at;
    const bot = execution?.owner_ref ? this.taskService.getBot(execution.owner_ref) : null;
    const untilBotDeadline = bot ? Date.parse(bot.hard_deadline) - at : Infinity;
    if (untilBotDeadline <= 0 || untilRunDeadline <= 0) throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Bot or Mission deadline elapsed before activation');
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

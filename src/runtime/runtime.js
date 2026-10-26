import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ERROR_CODES, SwarmEnvError } from '../errors.js';
import { makeEnvelope } from '../protocol/envelope.js';

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

export class Runtime {
  constructor({ taskService, contextService, workspaceManager, agentAdapter, maxWorkers = 1, coreIds = null, runtimeGeneration = 1, actorRef = 'runtime:local', logger = null, agentLogger = null, maxRecoveryAttempts = 1, watchdogTimeoutMs = DEFAULT_WATCHDOG_TIMEOUT_MS, executionTimeoutMs = DEFAULT_EXECUTION_TIMEOUT_MS, handoffReminderMs = DEFAULT_HANDOFF_REMINDER_MS, clock = () => Date.now(), onSessionStarted = null, onCoreEvent = null }) {
    this.taskService = taskService;
    this.contextService = contextService;
    this.workspaceManager = workspaceManager;
    this.agentAdapter = agentAdapter;
    this.maxWorkers = maxWorkers;
    this.runtimeGeneration = runtimeGeneration;
    this.actorRef = actorRef;
    this.logger = logger;
    this.agentLogger = agentLogger;
    this.maxRecoveryAttempts = maxRecoveryAttempts;
    this.watchdogTimeoutMs = watchdogTimeoutMs;
    if (!Number.isFinite(executionTimeoutMs) || executionTimeoutMs <= 0) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'executionTimeoutMs must be positive');
    if (!Number.isFinite(handoffReminderMs) || handoffReminderMs <= 0 || handoffReminderMs >= executionTimeoutMs) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'handoffReminderMs must be positive and less than executionTimeoutMs');
    this.executionTimeoutMs = executionTimeoutMs;
    this.handoffReminderMs = handoffReminderMs;
    this.clock = clock;
    this.onSessionStarted = onSessionStarted;
    this.onCoreEvent = onCoreEvent;
    this.activeProcesses = new Map();
    this.coreStates = new Map();
    const configuredCoreIds = Array.isArray(coreIds)
      ? coreIds
      : Array.from({ length: Math.max(0, maxWorkers) }, (_, index) => `core-${index + 1}`);
    for (const coreId of configuredCoreIds) this.registerCore(coreId);
    this.recoveryAttempts = new Map();
    this.handoffPromises = new Map();
    this.reminderPromises = new Map();
    this.pendingFailurePromises = new Set();
    this.pendingReleasePromises = new Set();
    this.stopping = false;
    this.executionStateUnsubscribe = typeof this.taskService?.subscribeExecutionState === 'function'
      ? this.taskService.subscribeExecutionState((event) => this.#onExecutionState(event))
      : null;
  }

  getActiveProcessCount() {
    return this.activeProcesses.size;
  }

  /**
   * Register a reusable Core with the execution substrate. Core Daemons own
   * discovery and selection; Runtime only records the execution occupancy
   * that follows a successful claim.
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

  /** Wait until Runtime no longer owns an Execution process. */
  async waitForExecutionRelease(executionId, { timeoutMs = Number.POSITIVE_INFINITY, pollMs = 25, signal = null } = {}) {
    const id = requireString(executionId, 'execution_id');
    if (timeoutMs !== Number.POSITIVE_INFINITY && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'timeoutMs must be non-negative or Infinity');
    if (!Number.isFinite(pollMs) || pollMs <= 0) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'pollMs must be positive');
    const startedAt = this.clock();
    let current = this.taskService.getExecution(id);
    while (this.activeProcesses.has(id) || ['CREATED', 'RUNNING'].includes(current?.state)) {
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
  async shutdown({ terminalState = 'FAILED' } = {}) {
    this.stopping = true;
    this.executionStateUnsubscribe?.();
    this.executionStateUnsubscribe = null;
    const executionIds = [...this.activeProcesses.keys()];
    for (const executionId of executionIds) {
      const execution = this.taskService.getExecution(executionId);
      if (execution && ['CREATED', 'RUNNING'].includes(execution.state)) {
        await this.stopExecution(executionId, terminalState).catch(() => undefined);
      } else {
        const active = this.activeProcesses.get(executionId);
        this.activeProcesses.delete(executionId);
        this.#setCoreState(active?.coreId, { state: 'IDLE', execution_id: null, task_id: null, session_id: null });
        await Promise.resolve(active?.session?.stop?.()).catch(() => undefined);
      }
    }
    await this.waitForSettled();
    return { active_process_count: this.activeProcesses.size };
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
    return {
      workspace,
      file: await this.readWorkspaceFile(executionId, { path }),
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

  async startExecution(executionId, { sessionReason = 'start', coreId = null } = {}) {
    this.logger?.append({ event: 'runtime.start_execution', execution_id: executionId, session_reason: sessionReason });
    const execution = this.#getExecution(executionId);
    if (execution.state !== 'CREATED') throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `Runtime can only start CREATED executions, got ${execution.state}`);
    if (this.activeProcesses.size >= this.maxWorkers) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Runtime capacity is exhausted');
    const selectedCoreId = this.#resolveCoreId(execution, coreId);
    this.#assertCoreAvailable(selectedCoreId, execution.execution_id);
    const workspace = await this.#prepareWorkspace(execution);
    // A recovery start restores the already persisted revision. Rewriting that
    // same revision would violate the Workspace Manager's monotonic CAS rule.
    let current = execution.workspace_ref ? execution : this.#saveWorkspaceReference(execution, workspace);
    const started = this.taskService.dispatch('start_execution', {
      ...this.#executionTimingPayload(),
      ...(selectedCoreId ? { core_id: selectedCoreId } : {}),
    }, this.#executionEnvelope(current, operationId('start')));
    current = started.execution;
    try {
      return await this.#launch(current, workspace, { sessionReason, coreId: selectedCoreId });
    } catch (error) {
      const active = this.activeProcesses.get(executionId);
      this.activeProcesses.delete(executionId);
      this.#setCoreState(active?.coreId ?? selectedCoreId, { state: 'IDLE', execution_id: null, task_id: null, session_id: null });
      await Promise.resolve(active?.session.stop?.()).catch(() => undefined);
      if (this.stopping) throw error;
      const failed = this.#getExecution(executionId);
      if (!['FAILED', 'CANCELLED', 'FENCED', 'SUPERSEDED'].includes(failed.state)) {
        this.taskService.dispatch('stop_execution', { terminal_state: 'FAILED' }, this.#executionEnvelope(failed, operationId('start-failed')));
      }
      throw error;
    }
  }

  /**
   * Start an Execution that has already been selected and claimed by a Core
   * Daemon. The method intentionally accepts no Task filters or ranking
   * inputs: Task choice belongs to the Daemon and the claim is the handoff
   * boundary.
   */
  startClaimedExecution(executionOrId, { coreId = null, sessionReason = 'claimed' } = {}) {
    const executionId = typeof executionOrId === 'string' ? executionOrId : executionOrId?.execution_id;
    requireString(executionId, 'execution_id');
    return this.startExecution(executionId, { coreId, sessionReason });
  }

  runClaimedExecution(executionOrId, options = {}) {
    return this.startClaimedExecution(executionOrId, options);
  }

  async bindAgentExecution(executionId, session = null, { workspaceRef, startSession = null, agentPrompt = null, coreId = null, sessionReason = 'bound' } = {}) {
    this.logger?.append({ event: 'runtime.bind_execution', execution_id: executionId });
    if ((!session || typeof session.stop !== 'function') && typeof startSession !== 'function') {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Agent session or startSession is required');
    }
    const execution = this.#getExecution(executionId);
    if (execution.state !== 'CREATED') throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `Runtime can only bind CREATED executions, got ${execution.state}`);
    if (this.activeProcesses.size >= this.maxWorkers) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Runtime capacity is exhausted');
    const selectedCoreId = this.#resolveCoreId(execution, coreId);
    this.#assertCoreAvailable(selectedCoreId, execution.execution_id);
    const workspace = await this.#prepareWorkspace(execution, workspaceRef);
    let current = execution.workspace_ref ? execution : this.#saveWorkspaceReference(execution, workspace);
    current = this.taskService.dispatch('start_execution', {
      ...this.#executionTimingPayload(),
      ...(selectedCoreId ? { core_id: selectedCoreId } : {}),
    }, this.#executionEnvelope(current, operationId('bind'))).execution;
    let boundSession = session;
    try {
      if (!boundSession) boundSession = await startSession({ execution: current, workspace });
      if (!boundSession || typeof boundSession.stop !== 'function') throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'startSession must return an Agent session');
      this.#registerActiveProcess(current, workspace, boundSession, { sessionReason, coreId: selectedCoreId });
      await this.#sendInitialPrompt(boundSession, agentPrompt);
      return { execution: current, workspace, session: boundSession };
    } catch (error) {
      this.activeProcesses.delete(executionId);
      this.#setCoreState(selectedCoreId, { state: 'IDLE', execution_id: null, task_id: null, session_id: null });
      await Promise.resolve(boundSession?.stop?.()).catch(() => undefined);
      const failed = this.#getExecution(executionId);
      if (!['FAILED', 'CANCELLED', 'FENCED', 'SUPERSEDED'].includes(failed.state)) {
        this.taskService.dispatch('stop_execution', { terminal_state: 'FAILED' }, this.#executionEnvelope(failed, operationId('bind-failed')));
      }
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
    if (!['CREATED', 'RUNNING'].includes(existing.state)) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `Runtime can only restart CREATED or RUNNING executions, got ${existing.state}`);
    }
    const active = this.activeProcesses.get(executionId);
    if (active) {
      this.activeProcesses.delete(executionId);
      await Promise.resolve(active.session.stop?.()).catch(() => undefined);
      this.#setCoreState(active.coreId, { state: 'IDLE', execution_id: null, task_id: null, session_id: null });
    }
    let current = this.#getExecution(executionId);
    if (current.state === 'RUNNING') {
      if (current.workspace_ref) {
        await this.workspaceManager.fenceWorkspace({
          workspaceRef: current.workspace_ref,
          executionId,
          fencingVersion: current.fencing_version,
          newFencingVersion: current.fencing_version + 1,
        });
      }
      current = this.taskService.dispatch('recover_execution', {
        runtime_generation: this.runtimeGeneration,
        ...(agentPrompt ? { agent_prompt: agentPrompt } : {}),
      }, this.#executionEnvelope(current, operationId('session-restart'))).execution;
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

  async wakeExecution(executionId, { wakeKey = null, beforePrompt = null } = {}) {
    this.logger?.append({ event: 'runtime.wake_execution', execution_id: executionId, wake_key: wakeKey });
    const waiting = this.#getExecution(executionId);
    const key = wakeKey ?? waiting.resume_token ?? `wake:${executionId}`;
    if (waiting.state !== 'WAITING') {
      const active = this.activeProcesses.get(executionId);
      if (active) return { execution: active.execution, workspace: active.workspace, session: active.session };
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `Runtime can only wake WAITING executions, got ${waiting.state}`);
    }
    if (this.activeProcesses.size >= this.maxWorkers) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Runtime capacity is exhausted');
    const wakeCoreId = this.#resolveCoreId(waiting, null);
    const resumed = this.taskService.dispatch('wake_execution', {
      wake_key: key,
      ...(wakeCoreId ? { core_id: wakeCoreId } : {}),
    }, this.#executionEnvelope(waiting, operationId('wake'))).execution;
    try {
      const workspace = await this.workspaceManager.restoreWorkspace({ workspaceRef: requireString(resumed.workspace_ref, 'workspace_ref'), executionId, fencingVersion: resumed.fencing_version });
      const coreId = this.#resolveCoreId(resumed, wakeCoreId);
      this.#assertCoreAvailable(coreId, executionId);
      return await this.#launch(resumed, workspace, { beforePrompt, sessionReason: 'wake', coreId });
    } catch (error) {
      const current = this.taskService.getExecution(executionId);
      if (current && ['CREATED', 'RUNNING'].includes(current.state)) {
        await this.fenceExecution(executionId).catch(() => undefined);
      }
      throw error;
    }
  }

  async requestWait(executionId, { waitCondition, checkpoint = {}, files = {}, deadline = null, waitKey = null }) {
    this.logger?.append({ event: 'runtime.request_wait', execution_id: executionId, wait_condition: waitCondition, deadline });
    const active = this.activeProcesses.get(executionId);
    const execution = this.#getExecution(executionId);
    if (!active || execution.state !== 'RUNNING') throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'only a running Runtime process can request wait');
    let validatedWait;
    try {
      validatedWait = this.taskService.validateWaitCondition?.(executionId, {
        waitCondition,
        waitDeadline: deadline ?? waitCondition?.deadline ?? null,
      });
    } catch (error) {
      // A dependency can become satisfied between the Agent's read and its
      // request_wait call. Keep the active Execution alive and let the
      // Session continue on its next turn; a stale wait request must not turn
      // into a failed claim or strand Core capacity.
      if (error?.code === ERROR_CODES.INVALID_CONTRACT && /condition is already satisfied/.test(error.message ?? '') &&
        this.taskService.isWaitConditionSatisfied?.(executionId, waitCondition)) {
        this.logger?.append({ event: 'runtime.wait_already_satisfied', execution_id: executionId, wait_condition: waitCondition });
        return { execution, task: this.taskService.getTask(execution.task_id), disposition: 'already_satisfied' };
      }
      throw error;
    }
    if (!validatedWait && (!waitCondition || typeof waitCondition !== 'object')) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'wait_condition is required');
    }
    if (this.taskService.isWaitConditionSatisfied?.(executionId, validatedWait?.wait_condition ?? waitCondition)) {
      this.logger?.append({ event: 'runtime.wait_already_satisfied', execution_id: executionId, wait_condition: waitCondition });
      return { execution, task: this.taskService.getTask(execution.task_id), disposition: 'already_satisfied' };
    }
    const workspace = await this.workspaceManager.saveWorkspaceRevision({
      workspaceRef: requireString(execution.workspace_ref, 'workspace_ref'), executionId, fencingVersion: execution.fencing_version, files: normalizeWaitFiles(files),
    });
    let current = this.#saveWorkspaceReference(execution, workspace);
    const savedCheckpoint = await this.workspaceManager.saveCheckpoint({
      workspaceRef: workspace.workspace_ref, executionId, fencingVersion: execution.fencing_version, checkpoint,
    });
    const checkpointResult = this.taskService.dispatch('save_checkpoint', savedCheckpoint, this.#executionEnvelope(current, operationId('checkpoint')));
    current = checkpointResult.execution;
    const waited = this.taskService.dispatch('request_wait', {
      ...(waitKey ? { wait_key: waitKey } : {}),
      checkpoint_ref: savedCheckpoint.checkpoint_ref,
      checkpoint_hash: savedCheckpoint.checkpoint_hash,
      workspace_ref: workspace.workspace_ref,
      workspace_revision: workspace.workspace_revision,
      workspace_content_hash: workspace.content_hash,
      wait_condition: waitCondition,
      wait_deadline: deadline ?? waitCondition?.deadline ?? null,
    }, this.#executionEnvelope(current, operationId('wait')));
    this.activeProcesses.delete(executionId);
    this.#setCoreState(active.coreId, { state: 'IDLE', execution_id: null, task_id: null, session_id: null });
    await Promise.resolve(active.session.stop()).catch(() => undefined);
    await this.workspaceManager.releaseWorkspace({ workspaceRef: workspace.workspace_ref, executionId, fencingVersion: execution.fencing_version });
    return waited;
  }

  /**
   * End an Execution because it has reached a concrete external dependency.
   * Task Service performs the durable BLOCKED transition and Runtime then
   * stops the Session and releases the physical Workspace/Core. The legacy
   * requestWait path remains available for reading old evidence, but new
   * orchestration code should use this boundary for dependency blocking.
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
    requireString(reason, 'block_reason');
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
      await this.workspaceManager.fenceWorkspace({
        workspaceRef: current.workspace_ref,
        executionId,
        fencingVersion: current.fencing_version,
        newFencingVersion: current.fencing_version + 1,
      });
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
    this.activeProcesses.delete(executionId);
    this.#setCoreState(active.coreId, { state: 'IDLE', execution_id: null, task_id: null, session_id: null });
    await Promise.resolve(active.session.stop?.()).catch(() => undefined);
    if (result.execution.workspace_ref) {
      await this.workspaceManager.releaseWorkspace({
        workspaceRef: result.execution.workspace_ref,
        executionId,
        fencingVersion: result.execution.fencing_version,
      }).catch(() => undefined);
    }
    this.logger?.append({ event: 'runtime.execution_blocked', execution_id: executionId, block_reason: reason });
    return { ...result, checkpoint: checkpointResult, workspace };
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
        const result = await this.handoffExecution(execution.execution_id, {
          terminalState: 'EXPIRED',
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
   * End one unfinished Execution attempt and return its Task to the OPEN
   * (claimable/READY) projection. Checkpoint and Workspace writes happen
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
  } = {}) {
    const id = requireString(executionId, 'execution_id');
    const existing = this.#getExecution(id);
    if (['SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED', 'FENCED', 'SUPERSEDED'].includes(existing.state)) {
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
    });
    this.handoffPromises.set(id, promise);
    try {
      return await promise;
    } finally {
      this.handoffPromises.delete(id);
    }
  }

  async #performHandoff(executionId, { checkpoint, files, handoffMetadata, summary, reason, terminalState, handoffKey, at }) {
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
      requested_at: new Date(at instanceof Date ? at.getTime() : at).toISOString(),
    };
    let current = started;
    let workspace = null;
    let checkpointResult = null;
    if (current.workspace_ref) {
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
    }
    const handoffOperationId = `runtime:handoff:${executionId}:${handoffKey ?? `${reason}:${current.state_version}`}`;
    const oldFence = current.fencing_version;
    if (current.workspace_ref) {
      await this.workspaceManager.fenceWorkspace({
        workspaceRef: current.workspace_ref,
        executionId,
        fencingVersion: oldFence,
        newFencingVersion: oldFence + 1,
      });
    }
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
    const active = this.activeProcesses.get(executionId);
    if (active) {
      active.closing = true;
      await Promise.resolve(active.session.stop?.()).catch((error) => {
        this.logger?.append({ event: 'runtime.handoff_stop_error', execution_id: executionId, error_class: error?.code ?? error?.name ?? 'session_stop_error' });
      });
      this.activeProcesses.delete(executionId);
      this.#setCoreState(active.coreId, { state: 'IDLE', execution_id: null, task_id: null, session_id: null });
    }
    if (result.execution.workspace_ref) {
      await this.workspaceManager.releaseWorkspace({
        workspaceRef: result.execution.workspace_ref,
        executionId,
        fencingVersion: result.execution.fencing_version,
      }).catch((error) => {
        this.logger?.append({ event: 'runtime.handoff_release_error', execution_id: executionId, error_class: error?.code ?? error?.name ?? 'workspace_release_error' });
      });
    }
    this.logger?.append({ event: 'runtime.execution_handoff', execution_id: executionId, terminal_reason: reason, terminal_state: terminalState });
    return { ...result, disposition: 'handed_off', checkpoint: checkpointResult, workspace };
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
      if (active) {
        active.execution = marked.execution;
        const prompt = [
          'Execution handoff reminder: this bounded attempt is approaching its deadline.',
          'Publish durable Materials, save the current Workspace/checkpoint, summarize what was attempted and learned, list outstanding questions, and recommend the next step.',
          'Continue only if useful progress remains; otherwise call the Runtime handoff boundary.',
        ].join('\n');
        // Follow-up is queued by Pi when the Agent is already in a turn. A
        // reminder must never race the Agent's current prompt and create a
        // second concurrent turn.
        await Promise.resolve(active.session.prompt?.(prompt, { timeoutMs: 30_000, streamingBehavior: 'followUp' })).catch((error) => {
          this.logger?.append({ event: 'runtime.handoff_reminder_error', execution_id: executionId, error_class: error?.code ?? error?.name ?? 'prompt_error' });
        });
      }
      this.logger?.append({ event: 'runtime.handoff_reminder', execution_id: executionId, handoff_deadline: marked.execution.handoff_deadline ?? null });
      return { kind: 'handoff_reminder', execution: marked.execution };
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
      session_id: active.session.sessionId ?? null,
      phase: active.phase,
      last_event_at: new Date(active.lastEventAt).toISOString(),
      last_heartbeat_at: active.lastHeartbeatAt ? new Date(active.lastHeartbeatAt).toISOString() : null,
      last_completed_turn_at: active.lastCompletedTurnAt ? new Date(active.lastCompletedTurnAt).toISOString() : null,
      last_successful_service_call_at: active.lastSuccessfulServiceCallAt ? new Date(active.lastSuccessfulServiceCallAt).toISOString() : null,
      last_productive_at: new Date(active.lastProductiveAt).toISOString(),
      last_failure_class: active.lastFailureClass,
      recovery_attempt: this.recoveryAttempts.get(active.execution.task_id) ?? 0,
    };
  }

  async sweepWatchdog(at = new Date(this.clock())) {
    const recovered = [];
    for (const [executionId, active] of [...this.activeProcesses.entries()]) {
      const execution = this.taskService.getExecution(executionId);
      if (!execution || execution.state !== 'RUNNING' || ACTIVE_SESSION_PHASES.has(active.phase)) continue;
      if (at.getTime() - active.lastProductiveAt < this.watchdogTimeoutMs) continue;
      recovered.push(await this.#handleSessionFailure(executionId, 'watchdog_stall'));
    }
    return recovered.filter(Boolean);
  }

  heartbeat(executionId, payload = {}) {
    this.logger?.append({ event: 'runtime.heartbeat', execution_id: executionId });
    const execution = this.#getExecution(executionId);
    const result = this.taskService.dispatch('heartbeat', payload, this.#executionEnvelope(execution, operationId('heartbeat')));
    const active = this.activeProcesses.get(executionId);
    if (active) {
      active.execution = result.execution;
      active.lastHeartbeatAt = this.clock();
    }
    return result;
  }

  async stopExecution(executionId, terminalState = 'CANCELLED') {
    this.logger?.append({ event: 'runtime.stop_execution', execution_id: executionId, terminal_state: terminalState });
    const execution = this.#getExecution(executionId);
    const active = this.activeProcesses.get(executionId);
    if (active) {
      this.activeProcesses.delete(executionId);
      await Promise.resolve(active.session.stop()).catch(() => undefined);
      this.#setCoreState(active.coreId, { state: 'IDLE', execution_id: null, task_id: null, session_id: null });
    }
    const result = this.taskService.dispatch('stop_execution', { terminal_state: terminalState }, this.#executionEnvelope(execution, operationId('stop')));
    if (execution.workspace_ref) {
      await this.workspaceManager.releaseWorkspace({ workspaceRef: execution.workspace_ref, executionId, fencingVersion: execution.fencing_version });
    }
    return result;
  }

  /** Release a process and its Workspace after Task Service already reached a
   * terminal state. This preserves Runtime ownership without another Task
   * state transition.
   */
  async releaseExecution(executionId) {
    const id = requireString(executionId, 'execution_id');
    const execution = this.#getExecution(id);
    const active = this.activeProcesses.get(id);
    if (active) {
      this.activeProcesses.delete(id);
      await Promise.resolve(active.session.stop()).catch(() => undefined);
      this.#setCoreState(active.coreId, { state: 'IDLE', execution_id: null, task_id: null, session_id: null });
    }
    if (execution.workspace_ref) {
      await this.workspaceManager.releaseWorkspace({
        workspaceRef: execution.workspace_ref,
        executionId: id,
        fencingVersion: execution.fencing_version,
      });
    }
    return { execution };
  }

  async fenceExecution(executionId) {
    this.logger?.append({ event: 'runtime.fence_execution', execution_id: executionId });
    const execution = this.#getExecution(executionId);
    const newFencingVersion = execution.fencing_version + 1;
    if (execution.workspace_ref) {
      await this.workspaceManager.fenceWorkspace({ workspaceRef: execution.workspace_ref, executionId, fencingVersion: execution.fencing_version, newFencingVersion });
    }
    const result = this.taskService.dispatch('fence_execution', { runtime_generation: this.runtimeGeneration }, this.#executionEnvelope(execution, operationId('fence')));
    const active = this.activeProcesses.get(executionId);
    if (active) {
      this.activeProcesses.delete(executionId);
      await Promise.resolve(active.session.stop()).catch(() => undefined);
      this.#setCoreState(active.coreId, { state: 'IDLE', execution_id: null, task_id: null, session_id: null });
    }
    return result;
  }

  async sweepExpired(at = new Date()) {
    this.logger?.append({ event: 'runtime.sweep_expired', at: at.toISOString() });
    const expired = [];
    for (const execution of this.taskService.listActiveExecutions()) {
      if (!['CREATED', 'RUNNING'].includes(execution.state) || Date.parse(execution.lease_expires_at) > at.getTime()) continue;
      if (execution.workspace_ref) {
        await this.workspaceManager.fenceWorkspace({ workspaceRef: execution.workspace_ref, executionId: execution.execution_id, fencingVersion: execution.fencing_version, newFencingVersion: execution.fencing_version + 1 });
      }
      const result = this.taskService.dispatch('expire_execution', { runtime_generation: this.runtimeGeneration }, this.#executionEnvelope(execution, operationId('expire')));
      const active = this.activeProcesses.get(execution.execution_id);
      if (active) {
        this.activeProcesses.delete(execution.execution_id);
        await Promise.resolve(active.session.stop()).catch(() => undefined);
        this.#setCoreState(active.coreId, { state: 'IDLE', execution_id: null, task_id: null, session_id: null });
      }
      expired.push(result);
    }
    return expired;
  }

  async restart() {
    this.runtimeGeneration += 1;
    for (const execution of this.taskService.listActiveExecutions()) {
      if (execution.state === 'RUNNING' || execution.state === 'CREATED') {
        await this.fenceExecution(execution.execution_id);
      }
    }
    await Promise.all([...this.activeProcesses.values()].map((active) => Promise.resolve(active.session.stop()).catch(() => undefined)));
    this.activeProcesses.clear();
    return { runtime_generation: this.runtimeGeneration, active_executions: this.taskService.listActiveExecutions() };
  }

  #getExecution(executionId) {
    const execution = this.taskService.getExecution(requireString(executionId, 'execution_id'));
    if (!execution) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown execution: ${executionId}`);
    return execution;
  }

  async #prepareWorkspace(execution, workspaceRef = null) {
    const task = this.taskService.getTask(execution.task_id);
    if (!task) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `Task is missing for execution: ${execution.execution_id}`);
    if (execution.workspace_ref) {
      const workspace = await this.workspaceManager.restoreWorkspace({
        workspaceRef: execution.workspace_ref,
        executionId: execution.execution_id,
        fencingVersion: execution.fencing_version,
      });
      return this.#ensurePiSettings(execution, workspace);
    }
    const workspaceManifest = {
      task_id: task.task_id,
      spec_version: execution.spec_version,
      spec_hash: execution.spec_hash,
      workspace_snapshot_hash: execution.input_snapshot_hash,
      material_refs: execution.input_material_refs,
      selection: execution.workspace_selection ?? { mode: 'clean', revision: null },
    };
    const inputSnapshotManifest = {
      workspace_snapshot_hash: execution.input_snapshot_hash,
      material_refs: execution.input_material_refs,
    };
    const selection = execution.workspace_selection ?? {};
    if (selection.mode === 'resume' && selection.source_workspace_ref) {
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
    const workspace = await this.workspaceManager.createWorkspace({
      executionId: execution.execution_id,
      fencingVersion: execution.fencing_version,
      task,
      ...(workspaceRef ? { workspaceRef } : {}),
      workspaceManifest,
      inputSnapshotManifest,
      runtimeManifest: { runtime_generation: this.runtimeGeneration, actor_ref: this.actorRef },
    });
    return this.#ensurePiSettings(execution, workspace);
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
        }, this.#executionEnvelope(current, saveOperationId)).execution;
      } catch (error) {
        if (error?.code !== ERROR_CODES.STALE_VERSION || attempt === 2) throw error;
        current = this.#getExecution(execution.execution_id);
      }
    }
    throw new SwarmEnvError(ERROR_CODES.STALE_VERSION, 'could not persist Workspace reference after concurrent updates');
  }

  async #launch(execution, workspace, { beforePrompt = null, sessionReason = 'start', coreId = null } = {}) {
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
    const manifestContent = JSON.stringify(session.manifest ?? {}, null, 2);
    const nextWorkspace = await this.workspaceManager.saveWorkspaceRevision({
      workspaceRef: workspace.workspace_ref,
      executionId: execution.execution_id,
      fencingVersion: execution.fencing_version,
      files: { 'runtime-manifest.json': manifestContent },
    });
    const current = this.#saveWorkspaceReference(execution, nextWorkspace);
    this.#registerActiveProcess(current, nextWorkspace, session, { sessionReason, coreId });
    await beforePrompt?.({ execution: current, workspace: nextWorkspace, session });
    await this.#sendInitialPrompt(session, execution.agent_prompt);
    const active = this.activeProcesses.get(execution.execution_id);
    return { execution: current, workspace: nextWorkspace, session };
  }

  async #sendInitialPrompt(session, prompt) {
    if (!prompt || typeof session.prompt !== 'function') return;
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
    await session.prompt(prompt, { timeoutMs: 30_000 });
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
      lastSuccessfulServiceCallAt: null,
      lastProductiveAt: nowMs,
      lastFailureClass: null,
      failurePromise: null,
    };
    this.activeProcesses.set(execution.execution_id, active);
    this.#setCoreState(coreId, {
      state: 'RUNNING',
      execution_id: execution.execution_id,
      task_id: execution.task_id,
      session_id: session.sessionId ?? null,
    });
    session.on('rpc', (record) => {
      void this.#handleSessionEvent(execution.execution_id, record);
    });
    session.on('processError', () => {
      void this.#handleSessionFailure(execution.execution_id, 'process_error');
    });
    session.on('close', () => {
      void this.#processExit(execution.execution_id);
    });
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

  #onExecutionState(event) {
    if (event?.kind !== 'executions_fenced' || !Array.isArray(event.execution_ids)) return;
    for (const executionId of event.execution_ids) {
      if (!executionId || executionId === event.excluded_execution_id || !this.activeProcesses.has(executionId)) continue;
      const promise = this.#releaseFencedProcess(executionId).finally(() => this.pendingReleasePromises.delete(promise));
      this.pendingReleasePromises.add(promise);
    }
  }

  async #releaseFencedProcess(executionId) {
    const active = this.activeProcesses.get(executionId);
    if (!active) return;
    this.activeProcesses.delete(executionId);
    const execution = this.taskService.getExecution(executionId);
    await Promise.resolve(active.session.stop?.()).catch(() => undefined);
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
    this.#setCoreState(active.coreId, { state: 'IDLE', execution_id: null, task_id: null, session_id: null });
    this.logger?.append({ event: 'runtime.execution_fenced_released', execution_id: executionId });
  }

  async #handleSessionEvent(executionId, record) {
    if (this.stopping) return;
    const active = this.activeProcesses.get(executionId);
    if (!active) return;
    active.lastEventAt = this.clock();
    this.logger?.append({ event: 'runtime.agent_event', execution_id: executionId, record_type: record.type, phase: active.phase });
    if (record.type === 'turn_start' || record.type === 'auto_retry_start' || record.type === 'compaction_start') {
      active.phase = record.type === 'turn_start' ? 'turn' : record.type === 'auto_retry_start' ? 'provider_retry' : 'compaction';
    }
    if (record.type === 'turn_end') active.lastCompletedTurnAt = this.clock();
    if (record.type === 'tool_execution_end' && record.isError !== true && String(record.toolName ?? '').startsWith('swarmenv_')) {
      active.lastSuccessfulServiceCallAt = this.clock();
    }
    const completedProductiveEvent = record.type === 'turn_end' ||
      (record.type === 'tool_execution_end' && record.isError !== true) ||
      (record.type === 'compaction_end' && Boolean(record.result)) ||
      (record.type === 'auto_retry_end' && record.success === true);
    if (completedProductiveEvent) {
      active.lastProductiveAt = this.clock();
      active.phase = 'idle';
    }
    const failureClass = classifySessionFailure(record);
    if (failureClass) {
      active.lastFailureClass = failureClass;
      await this.#handleSessionFailure(executionId, failureClass);
    }
  }

  async #processExit(executionId) {
    if (this.stopping) {
      this.activeProcesses.delete(executionId);
      return;
    }
    const active = this.activeProcesses.get(executionId);
    if (!active || this.stopping) return;
    const execution = this.#getExecution(executionId);
    if (execution.state === 'RUNNING') await this.#handleSessionFailure(executionId, 'process_exit');
    else {
      this.activeProcesses.delete(executionId);
      this.#setCoreState(active.coreId, { state: 'IDLE', execution_id: null, task_id: null, session_id: null });
    }
  }

  async #handleSessionFailure(executionId, failureClass) {
    if (this.stopping) {
      this.activeProcesses.delete(executionId);
      return null;
    }
    const active = this.activeProcesses.get(executionId);
    if (!active) return null;
    if (active.failurePromise) return active.failurePromise;
    active.lastFailureClass = failureClass;
    const failurePromise = (async () => {
      const coreId = active.coreId;
      this.activeProcesses.delete(executionId);
      this.#setCoreState(coreId, { state: 'IDLE', execution_id: null, task_id: null, session_id: null });
      const execution = this.#getExecution(executionId);
      if (execution.state !== 'RUNNING') return { execution };
      await Promise.resolve(active.session.stop?.()).catch(() => undefined);
      if (this.stopping) return { execution, disposition: 'stopping' };
      const recoveryAttempt = (this.recoveryAttempts.get(execution.task_id) ?? 0) + 1;
      this.recoveryAttempts.set(execution.task_id, recoveryAttempt);
      this.logger?.append({ event: 'runtime.session_failure', execution_id: executionId, failure_class: failureClass, recovery_attempt: recoveryAttempt });
      if (recoveryAttempt > this.maxRecoveryAttempts) {
        const fenced = await this.fenceExecution(executionId);
        this.logger?.append({ event: 'runtime.recovery_exhausted', execution_id: executionId, failure_class: failureClass, recovery_attempt: recoveryAttempt });
        return { execution: fenced.execution, recovery: null, disposition: 'exhausted' };
      }
      const task = this.taskService.getTask(execution.task_id);
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
      const recovered = this.taskService.dispatch('recover_execution', {
        runtime_generation: this.runtimeGeneration,
        agent_prompt: recoveryPrompt,
      }, this.#executionEnvelope(execution, operationId('recover')));
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
      'Resume the claimed Task from its durable Workspace and checkpoint.',
      `Failure class: ${failureClass}. Recovery attempt: ${attempt}.`,
      `Task goal: ${task.goal}`,
      `Expected output: ${task.expected_output}`,
      `Workspace revision: ${execution.workspace_revision ?? 'none'}.`,
      `Checkpoint: ${execution.checkpoint_ref ?? 'none'}.`,
      'Do not assume the interrupted turn completed. Inspect the current Task, Execution, Workspace, and Materials before continuing.',
    ].join('\n');
  }

  #executionEnvelope(execution, id) {
    return makeEnvelope({
      operationId: id,
      actorRef: this.actorRef,
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

  #assertCoreAvailable(coreId, executionId) {
    if (coreId === null) return;
    const current = this.coreStates.get(coreId);
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

  #executionTimingPayload(at = this.clock()) {
    const startedAt = new Date(at).toISOString();
    return {
      started_at: startedAt,
      handoff_deadline: new Date(at + this.handoffReminderMs).toISOString(),
      execution_deadline: new Date(at + this.executionTimeoutMs).toISOString(),
    };
  }
}

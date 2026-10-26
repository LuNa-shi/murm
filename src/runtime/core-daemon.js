import { ERROR_CODES, SwarmEnvError } from '../errors.js';

export const CORE_DAEMON_STATES = Object.freeze({
  IDLE: 'IDLE',
  DISCOVERING: 'DISCOVERING',
  SELECTING: 'SELECTING',
  RUNNING: 'RUNNING',
  STOPPING: 'STOPPING',
  FAILED: 'FAILED',
});

export const SELECTION_AGENT_PROMPT = [
  'You are a stateless Task selection turn for one reusable Core.',
  'Use the bounded list_tasks result as your complete candidate set.',
  'select exactly one task_id from that result, then call claim(task_id) once.',
  'Never guess an ID, issue concurrent claims, or read claimed-only state before claim succeeds.',
  'A claim conflict means another Core won; end this turn so the Daemon can rescan once.',
].join('\n');

const CONFLICT_CODE = ERROR_CODES.CONFLICT ?? 'CONFLICT';

function taskId(task) {
  return task?.task_id ?? task?.taskId ?? task?.id ?? null;
}

function asArray(value, keys = []) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const key of keys) if (Array.isArray(value[key])) return value[key];
  return [];
}

function isConflict(error) {
  return error?.code === CONFLICT_CODE || error?.code === 'CONFLICT' || error?.code === 'CLAIM_CONFLICT';
}

function normalizeSelection(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return null;
  return value.task_id ?? value.taskId ?? value.id ?? value.selected_task_id ?? null;
}

function errorView(error) {
  return {
    name: error?.name ?? 'Error',
    code: error?.code ?? 'DAEMON_ERROR',
    message: error?.message ?? String(error),
    details: error?.details,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Long-lived supervisor for one reusable Core slot.
 *
 * CoreDaemon owns the discovery/selection/claim loop. Task Service remains the
 * claim authority, while Runtime is invoked only after a successful claim.
 * The daemon keeps no durable responsibility for a Task and never exposes a
 * semantic WAITING Core state.
 */
export class CoreDaemon {
  constructor({
    coreId,
    taskService = null,
    listClaimableTasks = null,
    shortlistLimit = 8,
    selectTask,
    selectionPrompt = SELECTION_AGENT_PROMPT,
    claimTask = null,
    runtime = null,
    runExecution = null,
    maxClaimRescans = 1,
    idleBackoffMs = 100,
    waitForSignal = null,
    now = () => Date.now(),
    onEvent = null,
  } = {}) {
    if (typeof coreId !== 'string' || coreId.length === 0) throw new TypeError('CoreDaemon requires coreId');
    const serviceList = taskService?.listClaimableTasks?.bind(taskService)
      ?? taskService?.listTasks?.bind(taskService);
    if (typeof listClaimableTasks !== 'function' && typeof serviceList !== 'function') {
      throw new TypeError('CoreDaemon requires listClaimableTasks or taskService queue API');
    }
    if (typeof selectTask !== 'function') throw new TypeError('CoreDaemon requires selectTask');
    const serviceClaim = taskService?.claimTask?.bind(taskService);
    if (typeof claimTask !== 'function' && typeof serviceClaim !== 'function') {
      throw new TypeError('CoreDaemon requires claimTask or taskService.claimTask');
    }
    if (!Number.isInteger(shortlistLimit) || shortlistLimit < 1 || shortlistLimit > 100) throw new TypeError('shortlistLimit must be an integer between 1 and 100');
    if (!Number.isInteger(maxClaimRescans) || maxClaimRescans < 0 || maxClaimRescans > 10) throw new TypeError('maxClaimRescans must be an integer between 0 and 10');
    if (!Number.isFinite(idleBackoffMs) || idleBackoffMs < 0) throw new TypeError('idleBackoffMs must be non-negative');
    if (typeof now !== 'function') throw new TypeError('CoreDaemon requires now');
    this.coreId = coreId;
    this.taskService = taskService;
    this.listClaimableTasks = listClaimableTasks ?? (async () => {
      const result = await serviceList({ states: ['OPEN'], limit: shortlistLimit, availableOnly: true });
      return asArray(result, ['claimable_tasks', 'ready_tasks', 'tasks']);
    });
    this.shortlistLimit = shortlistLimit;
    this.selectTask = selectTask;
    this.selectionPrompt = selectionPrompt;
    this.claimTask = claimTask ?? ((selectedTaskId, context) => serviceClaim(selectedTaskId, context));
    this.runtime = runtime;
    this.runExecution = runExecution;
    this.maxClaimRescans = maxClaimRescans;
    this.idleBackoffMs = idleBackoffMs;
    this.waitForSignal = waitForSignal;
    this.now = now;
    this.onEvent = onEvent;
    this.stopped = false;
    this.loopPromise = null;
    this.turnPromise = null;
    this.waiters = new Set();
    this.state = CORE_DAEMON_STATES.IDLE;
    this.executionId = null;
    this.taskId = null;
    this.selectionTurnCount = 0;
    this.discoveryCount = 0;
    this.claimAttemptCount = 0;
    this.claimCount = 0;
    this.claimConflictCount = 0;
    this.rescanCount = 0;
    this.lastError = null;
    this.lastEventAt = this.now();
    this.stateHistory = [{ state: this.state, at: this.lastEventAt }];
  }

  snapshot() {
    return {
      core_id: this.coreId,
      state: this.state,
      task_id: this.taskId,
      execution_id: this.executionId,
      selection_turn_count: this.selectionTurnCount,
      discovery_count: this.discoveryCount,
      claim_attempt_count: this.claimAttemptCount,
      claim_count: this.claimCount,
      claim_conflict_count: this.claimConflictCount,
      rescan_count: this.rescanCount,
      last_error: this.lastError,
      last_event_at: this.lastEventAt,
      state_history: this.stateHistory.map((entry) => ({ ...entry })),
      stopped: this.stopped,
    };
  }

  /** Wake an idle Daemon after Task Controller observes new claimable work. */
  notify(reason = 'event') {
    this.#emit({ kind: 'daemon_wake_requested', core_id: this.coreId, reason, timestamp: this.now() });
    for (const resolve of this.waiters) resolve(reason);
    this.waiters.clear();
    return this.snapshot();
  }

  wake(reason = 'event') {
    return this.notify(reason);
  }

  stop() {
    if (this.stopped) return this.snapshot();
    this.stopped = true;
    this.#setState(CORE_DAEMON_STATES.STOPPING, { reason: 'stop' });
    for (const resolve of this.waiters) resolve('stopped');
    this.waiters.clear();
    return this.snapshot();
  }

  async runOnce({ reason = 'discovery' } = {}) {
    if (this.stopped) return { disposition: 'stopped', snapshot: this.snapshot() };
    if (this.turnPromise) return this.turnPromise;
    this.turnPromise = this.#runOnce(reason).finally(() => { this.turnPromise = null; });
    return this.turnPromise;
  }

  async run({ signal = null, maxTurns = Number.POSITIVE_INFINITY } = {}) {
    if (this.stopped) return { disposition: 'stopped', turns: 0, snapshot: this.snapshot() };
    if (!Number.isInteger(maxTurns) && maxTurns !== Number.POSITIVE_INFINITY) throw new TypeError('maxTurns must be an integer or Infinity');
    if (maxTurns < 1 && maxTurns !== Number.POSITIVE_INFINITY) return { disposition: 'complete', turns: 0, snapshot: this.snapshot() };
    if (this.loopPromise) return this.loopPromise;
    this.loopPromise = (async () => {
      let turns = 0;
      let last = null;
      while (!this.stopped && turns < maxTurns && !(signal?.aborted)) {
        last = await this.runOnce({ reason: turns === 0 ? 'initial' : 'wake' });
        turns += 1;
        if (this.stopped || signal?.aborted || turns >= maxTurns) break;
        if (last.disposition === 'completed') continue;
        await this.#wait(signal);
      }
      if (!this.stopped && signal?.aborted) this.#emit({ kind: 'daemon_run_aborted', core_id: this.coreId, timestamp: this.now() });
      return { disposition: this.stopped ? 'stopped' : 'complete', turns, last, snapshot: this.snapshot() };
    })().finally(() => { this.loopPromise = null; });
    return this.loopPromise;
  }

  async #runOnce(reason) {
    let rescans = 0;
    while (!this.stopped) {
      this.#setState(CORE_DAEMON_STATES.DISCOVERING, { reason });
      this.discoveryCount += 1;
      const discovered = asArray(await this.listClaimableTasks({ core_id: this.coreId, limit: this.shortlistLimit, reason }), ['claimable_tasks', 'ready_tasks', 'tasks']);
      const candidates = discovered.slice(0, this.shortlistLimit);
      this.#emit({ kind: 'daemon_discovery', core_id: this.coreId, reason, candidate_count: candidates.length, task_ids: candidates.map(taskId).filter(Boolean), timestamp: this.now() });
      if (candidates.length === 0) {
        this.#setIdle({ reason: 'no_claimable_task' });
        return { disposition: 'idle', reason, candidates: [], snapshot: this.snapshot() };
      }
      this.#setState(CORE_DAEMON_STATES.SELECTING, { reason });
      this.selectionTurnCount += 1;
      const candidateView = candidates.map((candidate) => Object.freeze({ ...candidate }));
      let selection;
      try {
        selection = await this.selectTask({
          core_id: this.coreId,
          candidates: Object.freeze(candidateView),
          prompt: this.selectionPrompt,
          reason,
          rescan: rescans,
        });
      } catch (error) {
        this.lastError = errorView(error);
        this.#emit({ kind: 'daemon_selection_failed', core_id: this.coreId, reason, error: this.lastError, timestamp: this.now() });
        this.#setIdle({ reason: 'selection_failed' });
        return { disposition: 'selection_failed', error: this.lastError, snapshot: this.snapshot() };
      }
      const selectedId = normalizeSelection(selection);
      const selected = candidates.find((candidate) => String(taskId(candidate)) === String(selectedId));
      if (!selected) {
        const error = new SwarmEnvError('SELECTION_INVALID', 'selection must choose one task_id from the bounded shortlist', { task_id: selectedId, candidate_task_ids: candidates.map(taskId) });
        this.lastError = errorView(error);
        this.#emit({ kind: 'daemon_selection_invalid', core_id: this.coreId, reason, error: this.lastError, timestamp: this.now() });
        this.#setIdle({ reason: 'selection_invalid' });
        return { disposition: 'selection_invalid', error: this.lastError, snapshot: this.snapshot() };
      }
      this.claimAttemptCount += 1;
      this.#emit({ kind: 'daemon_claim_started', core_id: this.coreId, task_id: taskId(selected), reason, rescan: rescans, timestamp: this.now() });
      let claim;
      try {
        const selectedTaskId = taskId(selected);
        claim = await this.claimTask(selectedTaskId, {
          task_id: selectedTaskId,
          core_id: this.coreId,
          claim_key: `${this.coreId}:${selectedTaskId}:${rescans}`,
          owner_ref: `daemon:${this.coreId}`,
          task: selected,
          candidates: candidateView,
          reason,
          rescan: rescans,
        });
      } catch (error) {
        if (isConflict(error)) {
          this.claimConflictCount += 1;
          this.#emit({ kind: 'daemon_claim_conflict', core_id: this.coreId, task_id: taskId(selected), reason, rescan: rescans, error: errorView(error), timestamp: this.now() });
          if (rescans >= this.maxClaimRescans) {
            this.#setIdle({ reason: 'claim_conflict' });
            return { disposition: 'claim_conflict', task_id: taskId(selected), rescans, snapshot: this.snapshot() };
          }
          rescans += 1;
          this.rescanCount += 1;
          continue;
        }
        this.lastError = errorView(error);
        this.#emit({ kind: 'daemon_claim_failed', core_id: this.coreId, task_id: taskId(selected), reason, error: this.lastError, timestamp: this.now() });
        this.#setIdle({ reason: 'claim_failed' });
        return { disposition: 'claim_failed', task_id: taskId(selected), error: this.lastError, snapshot: this.snapshot() };
      }
      const execution = claim?.execution ?? claim?.result?.execution ?? null;
      if (!execution?.execution_id) {
        const error = new SwarmEnvError('CLAIM_INVALID', 'claim must return an Execution identity');
        this.lastError = errorView(error);
        this.#emit({ kind: 'daemon_claim_invalid', core_id: this.coreId, task_id: taskId(selected), error: this.lastError, timestamp: this.now() });
        this.#setIdle({ reason: 'claim_invalid' });
        return { disposition: 'claim_invalid', task_id: taskId(selected), error: this.lastError, snapshot: this.snapshot() };
      }
      this.claimCount += 1;
      this.taskId = taskId(selected);
      this.executionId = execution.execution_id;
      this.#setState(CORE_DAEMON_STATES.RUNNING, { task_id: this.taskId, execution_id: this.executionId, reason });
      this.#emit({ kind: 'daemon_claim_succeeded', core_id: this.coreId, task_id: this.taskId, execution_id: this.executionId, reason, timestamp: this.now() });
      let runtimeResult = null;
      try {
        runtimeResult = await this.#handoff(claim, { task: selected, reason });
      } catch (error) {
        this.lastError = errorView(error);
        this.#emit({ kind: 'daemon_runtime_failed', core_id: this.coreId, task_id: this.taskId, execution_id: this.executionId, error: this.lastError, timestamp: this.now() });
        this.#setIdle({ reason: 'runtime_failed' });
        return { disposition: 'runtime_failed', claim, error: this.lastError, snapshot: this.snapshot() };
      }
      this.#emit({ kind: 'daemon_execution_released', core_id: this.coreId, task_id: this.taskId, execution_id: this.executionId, execution_state: runtimeResult?.execution?.state ?? execution.state ?? null, timestamp: this.now() });
      const result = { disposition: 'completed', claim, runtime: runtimeResult, rescans, snapshot: null };
      this.#setIdle({ reason: 'execution_released' });
      result.snapshot = this.snapshot();
      return result;
    }
    this.#setIdle({ reason: 'stopped' });
    return { disposition: 'stopped', snapshot: this.snapshot() };
  }

  async #handoff(claim, context) {
    if (typeof this.runExecution === 'function') return this.runExecution(claim, { ...context, core_id: this.coreId });
    if (typeof this.runtime?.runClaimedExecution === 'function') return this.runtime.runClaimedExecution(claim.execution, { ...context, coreId: this.coreId });
    if (typeof this.runtime?.startClaimedExecution === 'function') return this.runtime.startClaimedExecution(claim.execution, { ...context, coreId: this.coreId });
    if (typeof this.runtime?.startExecution === 'function') return this.runtime.startExecution(claim.execution.execution_id, { coreId: this.coreId, sessionReason: 'daemon_claim' });
    return { execution: claim.execution };
  }

  async #wait(signal) {
    if (this.stopped || signal?.aborted) return;
    if (typeof this.waitForSignal === 'function') {
      await Promise.race([Promise.resolve(this.waitForSignal({ core_id: this.coreId, signal })), this.#abortPromise(signal)]);
      return;
    }
    await Promise.race([sleep(this.idleBackoffMs), this.#abortPromise(signal)]);
  }

  #abortPromise(signal) {
    if (!signal) return new Promise(() => {});
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
  }

  #setIdle({ reason }) {
    this.taskId = null;
    this.executionId = null;
    if (!this.stopped) this.#setState(CORE_DAEMON_STATES.IDLE, { reason });
  }

  #setState(state, payload = {}) {
    if (this.state !== state) {
      this.state = state;
      this.lastEventAt = this.now();
      this.stateHistory.push({ state, at: this.lastEventAt });
    }
    this.#emit({ kind: 'daemon_state_changed', core_id: this.coreId, state, ...payload, timestamp: this.now() });
  }

  #emit(event) {
    try { this.onEvent?.(event); } catch { /* observations cannot break the Core loop */ }
  }
}

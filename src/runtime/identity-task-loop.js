import { ERROR_CODES, SwarmEnvError } from '../errors.js';
import { makeEnvelope } from '../protocol/envelope.js';

export const IDENTITY_LOOP_STATES = Object.freeze({
  IDLE: 'IDLE',
  DISCOVERING: 'DISCOVERING',
  TAKING: 'TAKING',
  RUNNING: 'RUNNING',
  STOPPING: 'STOPPING',
  FAILED: 'FAILED',
});

export const IDENTITY_TAKE_PROMPT = 'Read the Mission and relevant public Tasks, Materials, and Workspace files within the selection budget. Prefer suitable existing work. If the Mission is unfinished and no suitable Task exists, identify a concrete gap and propose a bounded Task with a verifiable deliverable. Call canonical task_take and continue in the same Bot Session after success. An empty queue does not end discovery. Respect actual Bot and run deadlines; stop expanding work after Mission acceptance or stop.';

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
  return error?.code === CONFLICT_CODE || error?.code === 'CONFLICT' || error?.code === 'TAKE_CONFLICT' || error?.code === 'FAIRNESS_REQUIRED';
}

function directTake(value) {
  const candidate = value?.take ?? value;
  return candidate?.task?.task_id && candidate?.execution?.execution_id ? candidate : null;
}

function errorView(error) {
  return {
    name: error?.name ?? 'Error',
    code: error?.code ?? 'DAEMON_ERROR',
    message: error?.message ?? String(error),
    details: error?.details,
  };
}

/**
 * Long-lived supervisor for one reusable Core slot.
 *
 * IdentityTaskLoop supervises discovery and the accepted Bot take receipt. Task Service remains the
 * take authority, while Runtime is invoked only after a successful take.
 * The identity loop keeps no durable responsibility for a Task and never exposes a
 * semantic blocked Core state; typed dependencies release the Core to IDLE.
 */
export class IdentityTaskLoop {
  constructor({
    coreId,
    taskService = null,
    listEligibleTasks = null,
    shortlistLimit = 8,
    takeTask,
    takePrompt = IDENTITY_TAKE_PROMPT,
    runtime = null,
    runExecution = null,
    releaseExecution = null,
    maxTakeRescans = 1,
    maxTakeAttempts = 3,
    takeRetryCooldownMs = 30_000,
    handoffTimeoutMs = Number.POSITIVE_INFINITY,
    handoffPollMs = 25,
    idleBackoffMs = 5_000,
    discoveryRetryMs = 30_000,
    firstDiscoveryAt = null,
    waitForSignal = null,
    now = () => Date.now(),
    onEvent = null,
  } = {}) {
    if (typeof coreId !== 'string' || coreId.length === 0) throw new TypeError('IdentityTaskLoop requires coreId');
    const serviceList = taskService?.listEligibleTasks?.bind(taskService)
      ?? taskService?.listTasks?.bind(taskService);
    if (typeof listEligibleTasks !== 'function' && typeof serviceList !== 'function') {
      throw new TypeError('IdentityTaskLoop requires listEligibleTasks or taskService queue API');
    }
    if (typeof takeTask !== 'function') throw new TypeError('IdentityTaskLoop requires takeTask');
    if (!Number.isInteger(shortlistLimit) || shortlistLimit < 1 || shortlistLimit > 100) throw new TypeError('shortlistLimit must be an integer between 1 and 100');
    if (!Number.isInteger(maxTakeRescans) || maxTakeRescans < 0 || maxTakeRescans > 10) throw new TypeError('maxTakeRescans must be an integer between 0 and 10');
    if (!Number.isInteger(maxTakeAttempts) || maxTakeAttempts < 1 || maxTakeAttempts > 10) throw new TypeError('maxTakeAttempts must be an integer between 1 and 10');
    if (!Number.isFinite(takeRetryCooldownMs) || takeRetryCooldownMs < 0) throw new TypeError('takeRetryCooldownMs must be non-negative');
    if (firstDiscoveryAt !== null && !Number.isSafeInteger(firstDiscoveryAt)) throw new TypeError('IdentityTaskLoop firstDiscoveryAt must be epoch milliseconds');
    if (!Number.isSafeInteger(discoveryRetryMs) || discoveryRetryMs <= 0 || discoveryRetryMs > 2_147_483_647) throw new TypeError('IdentityTaskLoop discoveryRetryMs must be a positive timer interval');
    if (!Number.isFinite(idleBackoffMs) || idleBackoffMs < 0) throw new TypeError('idleBackoffMs must be non-negative');
    if (handoffTimeoutMs !== Number.POSITIVE_INFINITY && (!Number.isFinite(handoffTimeoutMs) || handoffTimeoutMs < 0)) throw new TypeError('handoffTimeoutMs must be non-negative or Infinity');
    if (!Number.isFinite(handoffPollMs) || handoffPollMs <= 0) throw new TypeError('handoffPollMs must be positive');
    if (typeof now !== 'function') throw new TypeError('IdentityTaskLoop requires now');
    this.coreId = coreId;
    this.taskService = taskService;
    this.listEligibleTasks = listEligibleTasks ?? (async () => {
      const result = await serviceList({ states: ['OPEN'], limit: shortlistLimit, availableOnly: true });
      return asArray(result, ['eligible_tasks', 'ready_tasks', 'tasks']);
    });
    this.shortlistLimit = shortlistLimit;
    this.takeTask = takeTask;
    this.takePrompt = takePrompt;
    this.runtime = runtime;
    this.runExecution = runExecution;
    this.releaseExecution = releaseExecution;
    this.maxTakeRescans = maxTakeRescans;
    this.maxTakeAttempts = maxTakeAttempts;
    this.takeRetryCooldownMs = takeRetryCooldownMs;
    this.handoffTimeoutMs = handoffTimeoutMs;
    this.handoffPollMs = handoffPollMs;
    this.idleBackoffMs = idleBackoffMs;
    this.firstDiscoveryAt = firstDiscoveryAt;
    this.discoveryRetryMs = discoveryRetryMs;
    this.discoveryRetryAt = null;
    this.workSignalVersion = 0;
    this.waitForSignal = waitForSignal;
    this.now = now;
    this.onEvent = onEvent;
    this.stopped = false;
    this.loopPromise = null;
    this.turnPromise = null;
    this.waiters = new Set();
    this.pendingWake = false;
    this.state = IDENTITY_LOOP_STATES.IDLE;
    this.executionId = null;
    this.taskId = null;
    this.takeTurnCount = 0;
    this.discoveryCount = 0;
    this.takeAttemptCount = 0;
    this.takeCount = 0;
    this.takeConflictCount = 0;
    this.rescanCount = 0;
    this.takeFailureCount = 0;
    this.takeExhausted = false;
    this.takeRetryAt = null;
    this.lastError = null;
    this.lastEventAt = this.now();
    // Monotonic identity for completed retryable idle attempts.  A Core can
    // return to IDLE without the Controller observing the intermediate
    // TAKING or RUNNING state; the Controller uses this value to
    // distinguish that new retry from an untouched idle view. A deferred
    // take is a handoff race, not a retry, and must remain deduplicated.
    this.idleGeneration = 0;
    this.stateHistory = [{ state: this.state, at: this.lastEventAt }];
    this.handoffAbortController = null;
  }

  snapshot() {
    return {
      core_id: this.coreId,
      state: this.state,
      task_id: this.taskId,
      execution_id: this.executionId,
      take_turn_count: this.takeTurnCount,
      discovery_count: this.discoveryCount,
      take_attempt_count: this.takeAttemptCount,
      take_count: this.takeCount,
      take_conflict_count: this.takeConflictCount,
      rescan_count: this.rescanCount,
      take_failure_count: this.takeFailureCount,
      take_exhausted: this.takeExhausted,
      take_retry_at: this.takeRetryAt,
      idle_backoff_ms: this.idleBackoffMs,
      waiting_for_work: this.discoveryRetryAt !== null,
      discovery_retry_at: this.discoveryRetryAt,
      first_discovery_at: this.firstDiscoveryAt,
      idle_generation: this.idleGeneration,
      last_error: this.lastError,
      last_event_at: this.lastEventAt,
      state_history: this.stateHistory.map((entry) => ({ ...entry })),
      stopped: this.stopped,
    };
  }

  /** Wake an idle identity loop after Task Controller observes new eligible work. */
  notifyPublicChange(event = {}) {
    const publicOperations = ['create_task', 'finish_task', 'finish_closed', 'stop_execution', 'fence_execution', 'expire_execution', 'reopen_task', 'handoff_execution', 'link_material', 'publish_material', 'dispute_material', 'supersede_material', 'unsupersede_material', 'workspace_save', 'workspace_merge'];
    if (event.changed === false || (!publicOperations.includes(event.operation) && event.kind !== 'material_published')) return this.snapshot();
    return this.notify(event.kind ?? event.operation);
  }

  /** A controller signal permits another bounded discovery turn. */
  notify(reason = 'event') {
    this.discoveryRetryAt = null;
    this.workSignalVersion += 1;
    this.#rearmTakeIfDue(reason);
    // A bounded take retry cooldown is an intentional backoff.  A wake
    // delivered after the final failed attempt must not turn that cooldown
    // into a tight loop of exhausted turns; a later signal after the deadline
    // will re-arm the selector above.
    if (this.takeExhausted) {
      this.pendingWake = false;
      this.#emit({ kind: 'identity_loop_wake_deferred', core_id: this.coreId, reason, retry_at: this.takeRetryAt, timestamp: this.now() });
      return this.snapshot();
    }
    // A wake received while a take or handoff is already in flight is
    // already covered by that turn. Remember it only for an idle identity loop,
    // where the signal can otherwise land just before #wait registers.
    if (this.state === IDENTITY_LOOP_STATES.IDLE) this.pendingWake = true;
    this.#emit({ kind: 'identity_loop_wake_requested', core_id: this.coreId, reason, timestamp: this.now() });
    for (const resolve of this.waiters) resolve(reason);
    this.waiters.clear();
    return this.snapshot();
  }

  #rearmTakeIfDue(reason) {
    if (this.takeExhausted && (this.takeRetryAt === null || this.now() >= this.takeRetryAt)) {
      this.takeExhausted = false;
      this.takeFailureCount = 0;
      this.lastError = null;
      this.takeRetryAt = null;
      this.#emit({ kind: 'identity_loop_take_rearmed', core_id: this.coreId, reason, timestamp: this.now() });
    }
  }

  wake(reason = 'event') {
    return this.notify(reason);
  }


  stop() {
    if (this.stopped) return this.snapshot();
    this.stopped = true;
    this.handoffAbortController?.abort();
    // Stopping a loop must not leave an operating-system/runtime Execution
    // alive merely because its wait hook had not been installed yet.
    if (this.executionId && typeof this.runtime?.fenceExecution === 'function') {
      void Promise.resolve(this.runtime.fenceExecution(this.executionId, { reason: 'identity_loop_stopped' })).catch(() => undefined);
    }
    this.#setState(IDENTITY_LOOP_STATES.STOPPING, { reason: 'stop' });
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
        // A completed handoff still needs a bounded idle interval. The Task
        // Controller will wake this supervisor when a dependency, child
        // result, or newly opened Task changes the durable queue; spinning
        // immediately here lets one Core monopolize a burst of work and
        // races the parent-review wake path.
        await this.#wait(signal);
      }
      if (!this.stopped && signal?.aborted) this.#emit({ kind: 'identity_loop_run_aborted', core_id: this.coreId, timestamp: this.now() });
      return { disposition: this.stopped ? 'stopped' : 'complete', turns, last, snapshot: this.snapshot() };
    })().finally(() => { this.loopPromise = null; });
    return this.loopPromise;
  }

  async #runOnce(reason) {
    if (this.firstDiscoveryAt !== null) {
      if (this.now() < this.firstDiscoveryAt) return { disposition: 'idle', reason: 'initial_stagger', snapshot: this.snapshot() };
      this.firstDiscoveryAt = null;
    }
    if (this.discoveryRetryAt !== null) {
      if (this.now() < this.discoveryRetryAt) return { disposition: 'idle', reason: 'discovery_backoff', snapshot: this.snapshot() };
      this.discoveryRetryAt = null;
    }
    this.#rearmTakeIfDue(reason);
    if (this.takeExhausted) {
      this.#setIdle({ reason: 'take_attempts_exhausted' });
      return { disposition: 'take_exhausted', snapshot: this.snapshot() };
    }
    let rescans = 0;
    while (!this.stopped) {
      const discoverySignalVersion = this.workSignalVersion;
      this.#setState(IDENTITY_LOOP_STATES.DISCOVERING, { reason });
      this.discoveryCount += 1;
      const discovered = asArray(await this.listEligibleTasks({ core_id: this.coreId, limit: this.shortlistLimit, reason }), ['eligible_tasks', 'ready_tasks', 'tasks']);
      const candidates = discovered.slice(0, this.shortlistLimit);
      this.#emit({ kind: 'identity_loop_discovery', core_id: this.coreId, reason, candidate_count: candidates.length, task_ids: candidates.map(taskId).filter(Boolean), timestamp: this.now() });
      this.#setState(IDENTITY_LOOP_STATES.TAKING, { reason });
      this.takeTurnCount += 1;
      const candidateView = candidates.map((candidate) => Object.freeze({ ...candidate }));
      let selection;
      try {
        selection = await this.takeTask({
          core_id: this.coreId,
          candidates: Object.freeze(candidateView),
          prompt: this.takePrompt,
          reason,
          rescan: rescans,
        });
      } catch (error) {
        this.takeFailureCount += 1;
        this.lastError = errorView(error);
        this.#emit({ kind: 'identity_loop_take_failed', core_id: this.coreId, reason, error: this.lastError, timestamp: this.now() });
        this.#setIdle({ reason: 'take_failed' });
        if (this.takeFailureCount >= this.maxTakeAttempts) {
          this.takeExhausted = true;
          this.takeRetryAt = this.now() + this.takeRetryCooldownMs;
        }
        return { disposition: 'take_failed', error: this.lastError, snapshot: this.snapshot() };
      }
      const taken = directTake(selection);
      const selectedId = taken?.task?.task_id ?? null;
      if (!taken && selection?.no_work === true) {
        if (discoverySignalVersion === this.workSignalVersion) this.discoveryRetryAt = this.now() + this.discoveryRetryMs;
        this.#setIdle({ reason: 'no_work' });
        return { disposition: 'idle', reason: 'no_work', snapshot: this.snapshot() };
      }
      if (selection && typeof selection === 'object' && selection.take_deferred === true) {
        this.#setIdle({ reason: 'take_deferred' });
        return { disposition: 'take_deferred', snapshot: this.snapshot() };
      }
      // A failed take is a normal take race: the Agent chose a real Task but
      // another identity won it, or the Task became unavailable. It is not an
      // invalid model choice and must not consume the bounded take attempts.
      if (selection && typeof selection === 'object' && selection.take_failed === true) {
        const takeError = selection.error ?? {};
        // A Task take conflict is a bounded rescan. Provider/session and
        // other infrastructure failures must use the same bounded retry
        // cooldown as a failed selection; treating every `take_failed` as a
        // conflict lets an unavailable provider retake the same Task in a
        // tight loop and can exhaust an external sandbox's resources.
        if (!isConflict(takeError)) {
          this.takeFailureCount += 1;
          this.lastError = errorView(takeError);
          this.#emit({ kind: 'identity_loop_take_failed', core_id: this.coreId, reason, error: this.lastError, timestamp: this.now() });
          this.#setIdle({ reason: 'take_failed' });
          if (this.takeFailureCount >= this.maxTakeAttempts) {
            this.takeExhausted = true;
            this.takeRetryAt = this.now() + this.takeRetryCooldownMs;
          }
          return { disposition: 'take_failed', error: this.lastError, snapshot: this.snapshot() };
        }
        this.takeConflictCount += 1;
        this.#emit({ kind: 'identity_loop_take_conflict', core_id: this.coreId, reason, rescan: rescans, operation_id: takeError.operation_id ?? null, error: errorView(takeError), timestamp: this.now() });
        if (rescans >= this.maxTakeRescans) {
          this.#setIdle({ reason: 'take_conflict' });
          return { disposition: 'take_conflict', rescans, snapshot: this.snapshot() };
        }
        rescans += 1;
        this.rescanCount += 1;
        continue;
      }
      // The page is discovery context, not an admission allowlist. A Bot can
      // find or propose other work through the public services during its turn.
      // A take returned by the trusted tool transport already has Task Service
      // authority; do not abandon its live Execution because the page is stale.
      const selected = taken?.task;
      if (!selected) {
        this.takeFailureCount += 1;
        const error = new SwarmEnvError('TAKE_INVALID', 'discovery must return the accepted Task Service take from the Bot transport; a selected Task ID is not a take', { task_id: selectedId });
        this.lastError = errorView(error);
        this.#emit({ kind: 'identity_loop_take_invalid', core_id: this.coreId, reason, error: this.lastError, timestamp: this.now() });
        this.#setIdle({ reason: 'take_invalid' });
        if (this.takeFailureCount >= this.maxTakeAttempts) {
          this.takeExhausted = true;
          this.takeRetryAt = this.now() + this.takeRetryCooldownMs;
        }
        return { disposition: 'take_invalid', error: this.lastError, snapshot: this.snapshot() };
      }
      this.takeAttemptCount += 1;
      this.#emit({ kind: 'identity_loop_take_started', core_id: this.coreId, task_id: taskId(selected), reason, rescan: rescans, timestamp: this.now() });
      const take = taken;
      const execution = take?.execution ?? take?.result?.execution ?? null;
      if (!execution?.execution_id) {
        const error = new SwarmEnvError('TAKE_INVALID', 'take must return an Execution identity');
        this.lastError = errorView(error);
        this.#emit({ kind: 'identity_loop_take_invalid', core_id: this.coreId, task_id: taskId(selected), error: this.lastError, timestamp: this.now() });
        this.#setIdle({ reason: 'take_invalid' });
        return { disposition: 'take_invalid', task_id: taskId(selected), error: this.lastError, snapshot: this.snapshot() };
      }
      this.takeCount += 1;
      this.takeFailureCount = 0;
      this.takeExhausted = false;
      this.takeRetryAt = null;
      this.taskId = taskId(selected);
      this.executionId = execution.execution_id;
      this.#setState(IDENTITY_LOOP_STATES.RUNNING, { task_id: this.taskId, execution_id: this.executionId, reason });
      this.#emit({ kind: 'identity_loop_take_succeeded', core_id: this.coreId, task_id: this.taskId, execution_id: this.executionId, reason, timestamp: this.now() });
      let runtimeResult = null;
      try {
        runtimeResult = await this.#handoff(take, { task: selected, reason });
      } catch (error) {
        const release = await this.#releaseFailedTake(take, error);
        this.lastError = errorView(error);
        const releaseView = release instanceof Error ? errorView(release) : release?.error ? errorView(release.error) : release ? { disposition: release.disposition ?? null, execution_id: release.execution?.execution_id ?? take.execution.execution_id } : null;
        this.#emit({ kind: 'identity_loop_runtime_failed', core_id: this.coreId, task_id: this.taskId, execution_id: this.executionId, error: this.lastError, release: releaseView, timestamp: this.now() });
        const releasedExecution = release?.execution ?? release?.result?.execution ?? release;
        this.#emit({
          kind: 'identity_loop_execution_released',
          core_id: this.coreId,
          task_id: this.taskId,
          execution_id: this.executionId,
          execution_state: releasedExecution?.state ?? null,
          reason: 'runtime_failed',
          timestamp: this.now(),
        });
        this.#setIdle({ reason: 'runtime_failed' });
        return { disposition: 'runtime_failed', take, error: this.lastError, release, snapshot: this.snapshot() };
      }
      this.#emit({ kind: 'identity_loop_execution_released', core_id: this.coreId, task_id: this.taskId, execution_id: this.executionId, execution_state: runtimeResult?.execution?.state ?? execution.state ?? null, timestamp: this.now() });
      const result = { disposition: 'completed', take, runtime: runtimeResult, rescans, snapshot: null };
      this.#setIdle({ reason: 'execution_released' });
      result.snapshot = this.snapshot();
      return result;
    }
    this.#setIdle({ reason: 'stopped' });
    return { disposition: 'stopped', snapshot: this.snapshot() };
  }

  async #handoff(take, context) {
    let result;
    if (typeof this.runExecution === 'function') result = await this.runExecution(take, { ...context, core_id: this.coreId });
    else if (typeof this.runtime?.runTakenExecution === 'function') result = await this.runtime.runTakenExecution(take.execution, { ...context, coreId: this.coreId });
    else if (typeof this.runtime?.startTakenExecution === 'function') result = await this.runtime.startTakenExecution(take.execution, { ...context, coreId: this.coreId });
    else if (typeof this.runtime?.startExecution === 'function') result = await this.runtime.startExecution(take.execution.execution_id, { coreId: this.coreId, sessionReason: 'identity_loop_take' });
    else throw new SwarmEnvError(ERROR_CODES.RUNTIME_HANDOFF_REQUIRED, 'IdentityTaskLoop requires a Runtime handoff after take');
    if (typeof this.runtime?.waitForExecutionRelease === 'function' && take.execution?.execution_id) {
      this.handoffAbortController = new AbortController();
      // stop() may land between a successful take and this wait. Abort here
      // as well so a late-arriving shutdown cannot leave the loop awaiting an
      // Execution that Runtime is already tearing down.
      if (this.stopped) this.handoffAbortController.abort();
      const settled = await this.runtime.waitForExecutionRelease(take.execution.execution_id, {
        timeoutMs: this.handoffTimeoutMs,
        pollMs: this.handoffPollMs,
        signal: this.handoffAbortController.signal,
      });
      this.handoffAbortController = null;
      if (!settled.released) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Runtime did not release the taken Execution before the handoff deadline', { execution_id: take.execution.execution_id });
      result = { ...(result ?? {}), execution: settled.execution ?? result?.execution ?? take.execution, release: settled };
    }
    return result;
  }

  async #releaseFailedTake(take, originalError) {
    const execution = take?.execution;
    if (!execution?.execution_id) return null;
    const errorText = `${originalError?.code ?? ''} ${originalError?.message ?? ''}`;
    const terminalReason = /handoff deadline|did not release/i.test(errorText)
      ? 'handoff_timeout'
      : 'runtime_handoff_failed';
    try {
      if (typeof this.releaseExecution === 'function') return await this.releaseExecution(execution, { error: originalError, coreId: this.coreId });
      if (typeof this.runtime?.fenceExecution === 'function') {
        return await this.runtime.fenceExecution(execution.execution_id, { reason: terminalReason });
      }
      if (typeof this.taskService?.dispatch === 'function') {
        return this.taskService.dispatch('fence_execution', {
          runtime_generation: execution.runtime_generation ?? 1,
          terminal_reason: terminalReason,
        }, makeEnvelope({
          actorRef: `identity:${this.coreId}`,
          taskId: execution.task_id,
          executionId: execution.execution_id,
          specVersion: execution.spec_version,
          stateVersion: execution.state_version,
          fencingVersion: execution.fencing_version,
        }));
      }
      return null;
    } catch (error) {
      this.#emit({ kind: 'identity_loop_take_release_failed', core_id: this.coreId, execution_id: execution.execution_id, error: errorView(error), timestamp: this.now() });
      return error;
    }
  }

  async #wait(signal) {
    if (this.stopped || signal?.aborted) return;
    // A Controller signal can arrive in the small handoff window after the
    // identity loop returned IDLE but before this loop registered its waiter. Keep a
    // one-shot pending bit so that wake is not lost in that race.
    if (this.pendingWake) {
      this.pendingWake = false;
      return;
    }
    // A quiet public state cannot wake itself. The discovery retry has its
    // own finite timer, including for callers with a custom waiter.
    const discoveryAt = this.firstDiscoveryAt ?? this.discoveryRetryAt;
    const retryDelay = discoveryAt === null ? Infinity : Math.max(0, discoveryAt - this.now());
    if (typeof this.waitForSignal === 'function') {
      let resolveWake;
      const wake = new Promise((resolve) => {
        resolveWake = resolve;
        this.waiters.add(resolve);
      });
      const waitAbort = new AbortController();
      let abortHandler;
      const aborted = new Promise(resolve => {
        abortHandler = () => {
          resolve('aborted');
          waitAbort.abort(signal?.reason);
        };
        signal?.addEventListener('abort', abortHandler, { once: true });
        if (signal?.aborted) abortHandler();
      });
      const external = Promise.resolve().then(() => this.waitForSignal({ core_id: this.coreId, signal: waitAbort.signal }));
      let retryTimer;
      const retry = Number.isFinite(retryDelay)
        ? new Promise(resolve => { retryTimer = setTimeout(resolve, retryDelay); })
        : new Promise(() => {});
      try {
        const result = await Promise.race([external, wake.then(() => 'notified'), retry, aborted]);
        if (result === 'notified') this.pendingWake = false;
      } finally {
        clearTimeout(retryTimer);
        signal?.removeEventListener('abort', abortHandler);
        this.waiters.delete(resolveWake);
        waitAbort.abort();
      }
      return;
    }
    // Prefer an explicit wake over polling while retaining a bounded repair
    // interval for callers that do not have an event source.  The previous
    // sleep-only path meant notify() could not wake an idle identity loop until the
    // backoff elapsed, while the runner also notified every identity loop on each
    // poll.  Registering the waiter here makes the Controller signal the
    // single low-latency path without allowing an empty queue to spin.
    let resolveWake;
    let timeoutId;
    let abortHandler;
    const wake = new Promise((resolve) => {
      resolveWake = resolve;
      this.waiters.add(resolve);
    });
    const timeout = new Promise((resolve) => {
      timeoutId = setTimeout(() => resolve('backoff'), Number.isFinite(retryDelay) ? retryDelay : this.idleBackoffMs);
    });
    const aborted = signal
      ? new Promise((resolve) => {
        abortHandler = () => resolve('aborted');
        signal.addEventListener('abort', abortHandler, { once: true });
      })
      : new Promise(() => {});
    try {
      const result = await Promise.race([wake.then(() => 'notified'), timeout, aborted]);
      if (result === 'notified') this.pendingWake = false;
    } finally {
      clearTimeout(timeoutId);
      if (abortHandler) signal.removeEventListener('abort', abortHandler);
      this.waiters.delete(resolveWake);
    }
  }

  #setIdle({ reason }) {
    this.taskId = null;
    this.executionId = null;
    if (!this.stopped) {
      if (!['take_deferred', 'take_attempts_exhausted', 'no_work', 'stopped'].includes(reason)) this.idleGeneration += 1;
      this.#setState(IDENTITY_LOOP_STATES.IDLE, { reason });
    }
  }

  #setState(state, payload = {}) {
    const changed = this.state !== state;
    if (changed) {
      this.state = state;
      this.lastEventAt = this.now();
      this.stateHistory.push({ state, at: this.lastEventAt });
    }
    this.#emit({ kind: 'identity_loop_state_changed', core_id: this.coreId, state, changed, ...payload, timestamp: this.now() });
  }

  #emit(event) {
    try { this.onEvent?.(event); } catch { /* observations cannot break the Core loop */ }
  }
}

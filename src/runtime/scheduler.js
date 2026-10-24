import { GENERIC_AGENT_PROMPT } from '../agent/agent-prompt.js';

const DEFAULT_MAX_STARTUP_ATTEMPTS = 3;
const DEFAULT_RETRY_BACKOFF_MS = 1_000;
const DEFAULT_DISPATCH_BACKOFF_MS = 1_000;

function nonNegativeInteger(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function coreKey(core, index) {
  return String(core?.core_id ?? core?.coreId ?? core?.id ?? core?.index ?? `core-${index + 1}`);
}

function readySignature(tasks) {
  const ids = tasks.map((task) => task?.task_id ?? task?.taskId ?? task?.id).filter((id) => id !== undefined && id !== null);
  if (ids.length === tasks.length) return [...new Set(ids.map(String))].sort().join('|');
  return `count:${tasks.length}`;
}

function normalizeList(value, keys) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const key of keys) if (Array.isArray(value[key])) return value[key];
  return [];
}

function errorClass(error) {
  const text = String(error?.message ?? error ?? '');
  if (/timeout|timed out/i.test(text)) return 'startup_timeout';
  if (/provider|auth|account|model|nurouter|pi/i.test(text)) return 'provider_failure';
  return 'startup_failure';
}

/**
 * Demand-driven capacity coordinator.
 *
 * Scheduler only decides whether an unbound worker may be started. It never
 * receives or selects a Task. The worker's generic prompt is responsible for
 * discovering and claiming a READY Task through Task Service.
 */
export class Scheduler {
  constructor({
    listReadyTasks,
    listCores,
    startUnboundSession,
    isCoreAvailable = (core) => !core?.taskId && !core?.executionId && !core?.waitingExecutionId &&
      !core?.turnInFlight && !core?.dispatchReserved && !core?.stopping,
    now = () => Date.now(),
    maxStartupAttempts = DEFAULT_MAX_STARTUP_ATTEMPTS,
    retryBackoffMs = DEFAULT_RETRY_BACKOFF_MS,
    dispatchBackoffMs = DEFAULT_DISPATCH_BACKOFF_MS,
    onEvent = null,
  } = {}) {
    if (typeof listReadyTasks !== 'function') throw new TypeError('Scheduler requires listReadyTasks');
    if (typeof listCores !== 'function') throw new TypeError('Scheduler requires listCores');
    if (typeof startUnboundSession !== 'function') throw new TypeError('Scheduler requires startUnboundSession');
    if (typeof isCoreAvailable !== 'function') throw new TypeError('Scheduler requires isCoreAvailable');
    if (typeof now !== 'function') throw new TypeError('Scheduler requires now');
    this.listReadyTasks = listReadyTasks;
    this.listCores = listCores;
    this.startUnboundSession = startUnboundSession;
    this.isCoreAvailable = isCoreAvailable;
    this.now = now;
    this.maxStartupAttempts = Math.max(1, nonNegativeInteger(maxStartupAttempts, DEFAULT_MAX_STARTUP_ATTEMPTS));
    this.retryBackoffMs = nonNegativeInteger(retryBackoffMs, DEFAULT_RETRY_BACKOFF_MS);
    this.dispatchBackoffMs = nonNegativeInteger(dispatchBackoffMs, DEFAULT_DISPATCH_BACKOFF_MS);
    this.onEvent = onEvent;
    this.stopped = false;
    this.reconcilePromise = null;
    this.reconcileRequested = false;
    this.nextReason = null;
    this.readySignature = null;
    this.readyCount = 0;
    this.firstReadyAt = null;
    this.lastReadyAt = null;
    this.lastReconciledAt = null;
    this.dispatchCount = 0;
    this.startupAttemptCount = 0;
    this.startupFailureCount = 0;
    this.boundedStartupExhaustedCount = 0;
    this.dispatchLatenciesMs = [];
    this.states = new Map();
  }

  /**
   * Reconcile READY supply against free capacity. Calls are serialized, so a
   * readiness event arriving while a provider starts cannot create a second
   * start for the same Core.
   */
  reconcile({ reason = 'reconcile' } = {}) {
    if (this.stopped) return Promise.resolve(this.snapshot());
    if (this.reconcilePromise) {
      this.reconcileRequested = true;
      this.nextReason = reason;
      return this.reconcilePromise;
    }
    this.reconcilePromise = this.#reconcile(reason).finally(async () => {
      const rerun = this.reconcileRequested && !this.stopped;
      const rerunReason = this.nextReason ?? 'queued-event';
      this.reconcileRequested = false;
      this.nextReason = null;
      this.reconcilePromise = null;
      if (rerun) await this.reconcile({ reason: rerunReason });
    });
    return this.reconcilePromise;
  }

  /** Notify Scheduler that queue or capacity facts may have changed. */
  notify(reason = 'event') {
    return this.reconcile({ reason });
  }

  stop() {
    this.stopped = true;
    this.reconcileRequested = false;
    this.nextReason = null;
    return this.reconcilePromise ?? Promise.resolve(this.snapshot());
  }

  snapshot() {
    return {
      ready_count: this.readyCount,
      ready_signature: this.readySignature,
      first_ready_at: this.firstReadyAt,
      last_ready_at: this.lastReadyAt,
      last_reconciled_at: this.lastReconciledAt,
      dispatch_count: this.dispatchCount,
      startup_attempt_count: this.startupAttemptCount,
      startup_failure_count: this.startupFailureCount,
      bounded_startup_exhausted_count: this.boundedStartupExhaustedCount,
      dispatch_latencies_ms: [...this.dispatchLatenciesMs],
      in_flight_core_ids: [...this.states.entries()].filter(([, state]) => state.inFlight).map(([key]) => key),
      stopped: this.stopped,
    };
  }

  async #reconcile(reason) {
    const reconciledAt = this.now();
    const readyTasks = normalizeList(await this.listReadyTasks(), ['ready_tasks', 'tasks']);
    const cores = normalizeList(await this.listCores(), ['cores']);
    const signature = readySignature(readyTasks);
    if (signature !== this.readySignature) {
      this.readySignature = signature;
      this.firstReadyAt = readyTasks.length > 0 ? reconciledAt : null;
      for (const state of this.states.values()) {
        state.attempts = 0;
        state.nextRetryAt = 0;
        state.exhausted = false;
        state.lastDispatchSignature = null;
      }
    }
    this.readyCount = readyTasks.length;
    this.lastReadyAt = readyTasks.length > 0 ? reconciledAt : this.lastReadyAt;
    this.lastReconciledAt = reconciledAt;
    const availableCores = [];
    for (let index = 0; index < cores.length; index += 1) {
      const core = cores[index];
      const key = coreKey(core, index);
      const state = this.#state(key);
      if (state.inFlight || !this.isCoreAvailable(core, { key, scheduler: this })) continue;
      availableCores.push({ core, key, state });
    }
    this.#emit({
      kind: 'scheduler_reconcile',
      reason,
      ready_count: readyTasks.length,
      free_core_count: availableCores.length,
      timestamp: reconciledAt,
    });
    if (readyTasks.length === 0 || availableCores.length === 0) return this.snapshot();
    const dispatches = [];
    for (const { core, key, state } of availableCores.slice(0, readyTasks.length)) {
      if (state.exhausted || reconciledAt < state.nextRetryAt) continue;
      if (state.lastDispatchSignature === signature && state.lastDispatchAt !== null &&
        reconciledAt < state.lastDispatchAt + this.dispatchBackoffMs) continue;
      state.inFlight = true;
      state.lastDispatchSignature = signature;
      state.lastDispatchAt = reconciledAt;
      state.attempts += 1;
      this.startupAttemptCount += 1;
      const request = {
        core,
        core_id: key,
        prompt: GENERIC_AGENT_PROMPT,
        ready_count: readyTasks.length,
        reason,
        ready_at: this.firstReadyAt,
        started_at: reconciledAt,
      };
      this.#emit({
        kind: 'scheduler_dispatch_started',
        core_id: key,
        ready_count: readyTasks.length,
        ready_to_dispatch_ms: this.firstReadyAt === null ? null : Math.max(0, reconciledAt - this.firstReadyAt),
        reason,
        timestamp: reconciledAt,
      });
      dispatches.push(this.#dispatch(request, state, signature));
    }
    if (dispatches.length > 0) await Promise.all(dispatches);
    return this.snapshot();
  }

  #state(key) {
    let state = this.states.get(key);
    if (!state) {
      state = {
        attempts: 0,
        exhausted: false,
        inFlight: false,
        nextRetryAt: 0,
        lastDispatchAt: null,
        lastDispatchSignature: null,
      };
      this.states.set(key, state);
    }
    return state;
  }

  async #dispatch(request, state, signature) {
    const completedAt = this.now();
    try {
      const result = await this.startUnboundSession(request);
      if (result === false || (result && result.started === false)) throw new Error('unbound session did not start');
      this.dispatchCount += 1;
      this.dispatchLatenciesMs.push(Math.max(0, completedAt - (this.firstReadyAt ?? completedAt)));
      this.#emit({
        kind: 'scheduler_dispatch_succeeded',
        core_id: request.core_id,
        ready_count: request.ready_count,
        startup_attempt: state.attempts,
        timestamp: this.now(),
      });
      return true;
    } catch (error) {
      this.startupFailureCount += 1;
      if (state.attempts >= this.maxStartupAttempts) {
        state.exhausted = true;
        this.boundedStartupExhaustedCount += 1;
      } else {
        state.nextRetryAt = this.now() + this.retryBackoffMs;
      }
      this.#emit({
        kind: 'scheduler_dispatch_failed',
        core_id: request.core_id,
        ready_count: request.ready_count,
        startup_attempt: state.attempts,
        retryable: !state.exhausted,
        error_code: error?.code ?? error?.name ?? 'STARTUP_FAILURE',
        error_class: errorClass(error),
        timestamp: this.now(),
      });
      return false;
    } finally {
      state.inFlight = false;
      // The signature is intentionally retained after a failed startup. A
      // duplicate readiness event must wait for the bounded retry policy.
      if (state.lastDispatchSignature !== signature) state.lastDispatchSignature = signature;
    }
  }

  #emit(event) {
    try {
      this.onEvent?.(event);
    } catch {
      // Observability must never break scheduling or turn a provider failure
      // into a scheduler failure.
    }
  }
}

export const SCHEDULER_DEFAULTS = Object.freeze({
  maxStartupAttempts: DEFAULT_MAX_STARTUP_ATTEMPTS,
  retryBackoffMs: DEFAULT_RETRY_BACKOFF_MS,
  dispatchBackoffMs: DEFAULT_DISPATCH_BACKOFF_MS,
});

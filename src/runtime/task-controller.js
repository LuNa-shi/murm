/**
 * Deterministic reconciliation for Task readiness and reusable Core identity loops.
 *
 * TaskController observes durable Task Service state. It may ask an injected
 * reconciliation adapter to refresh a blocked Task and may wake an idle Core
 * identity loop, but it never chooses or claims a Task. Task choice belongs to
 * the identity loop after it receives a bounded eligible view.
 */

const DEFAULT_SHORTLIST_LIMIT = 16;
const DEFAULT_SWEEP_INTERVAL_MS = 5_000;

function asArray(value, keys = []) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const key of keys) if (Array.isArray(value[key])) return value[key];
  return [];
}

function loopId(loop, index) {
  return String(loop?.core_id ?? loop?.coreId ?? loop?.id ?? loop?.name ?? `core-${index + 1}`);
}

function loopState(loop) {
  if (typeof loop?.snapshot === 'function') {
    try {
      const snapshot = loop.snapshot();
      if (snapshot && typeof snapshot === 'object') return snapshot;
    } catch {
      // A health snapshot is advisory. The Controller still treats an
      // uninspectable identity loop as unhealthy below.
    }
  }
  return loop ?? {};
}

function isIdle(loop) {
  const state = String(loop?.state ?? '').toUpperCase();
  return loop?.idle === true || state === 'IDLE';
}

function isHealthy(loop) {
  if (loop?.healthy === false || loop?.health === 'unhealthy' || loop?.status === 'failed') return false;
  const state = String(loop?.state ?? '').toUpperCase();
  return !['FAILED', 'STOPPING', 'STOPPED'].includes(state);
}

function takeRetryDeferred(loop, at) {
  if (loop?.take_exhausted !== true && loop?.takeExhausted !== true) return false;
  const retryAt = loop?.take_retry_at ?? loop?.takeRetryAt;
  return retryAt !== null && retryAt !== undefined && Number(retryAt) > at;
}

function idleGeneration(loop) {
  if (loop?.idle_generation !== undefined) return loop.idle_generation;
  if (loop?.idleGeneration !== undefined) return loop.idleGeneration;
  if (loop?.last_event_at !== undefined) return loop.last_event_at;
  if (Array.isArray(loop?.state_history)) return loop.state_history.length;
  return null;
}

function taskId(task) {
  return task?.task_id ?? task?.taskId ?? task?.id ?? null;
}

function taskSignature(tasks) {
  return tasks
    .map((task) => String(taskId(task) ?? `anonymous:${JSON.stringify(task)}`))
    .sort()
    .join('|');
}

export class TaskController {
  constructor({
    taskService = null,
    listEligibleTasks = null,
    listBlockedTasks = null,
    reconcileTask = null,
    listIdentityLoops = () => [],
    signalIdleIdentity = null,
    requestIdentityRecovery = null,
    shortlistLimit = DEFAULT_SHORTLIST_LIMIT,
    sweepIntervalMs = DEFAULT_SWEEP_INTERVAL_MS,
    now = () => Date.now(),
    onEvent = null,
  } = {}) {
    const serviceList = taskService?.listTasks?.bind(taskService);
    const serviceListEligible = taskService?.listEligibleTasks?.bind(taskService);
    const serviceListBlocked = taskService?.listBlockedTasks?.bind(taskService);
    if (typeof listEligibleTasks !== 'function' && typeof serviceListEligible !== 'function' && typeof serviceList !== 'function') {
      throw new TypeError('TaskController requires listEligibleTasks or taskService.listTasks');
    }
    if (typeof listIdentityLoops !== 'function') throw new TypeError('TaskController requires listIdentityLoops');
    if (typeof now !== 'function') throw new TypeError('TaskController requires now');
    if (!Number.isInteger(shortlistLimit) || shortlistLimit < 1 || shortlistLimit > 100) {
      throw new TypeError('TaskController shortlistLimit must be an integer between 1 and 100');
    }
    if (!Number.isFinite(sweepIntervalMs) || sweepIntervalMs < 0) throw new TypeError('TaskController sweepIntervalMs must be non-negative');
    this.taskService = taskService;
    this.listEligibleTasks = listEligibleTasks
      ?? (serviceListEligible
        ? (() => serviceListEligible({ limit: shortlistLimit }))
        : (() => serviceList({ states: ['OPEN'], limit: shortlistLimit, availableOnly: true })));
    this.listBlockedTasks = listBlockedTasks ?? (serviceListBlocked
      ? (() => serviceListBlocked({ limit: 100, includeOpen: true }))
      : serviceList
        ? (() => serviceList({
          // Include OPEN Tasks here so reconciliation can persist an explicit
          // dependency blocker instead of leaving a hidden OPEN-but-uneligible
          // row in the queue.
          states: ['OPEN', 'BLOCKED'], limit: 100, availableOnly: false,
        }))
        : (() => []));
    this.usesTaskServiceReconcile = reconcileTask === null && typeof taskService?.reconcileTask === 'function';
    this.reconcileTask = reconcileTask
      ?? (this.usesTaskServiceReconcile ? (taskId) => taskService.reconcileTask(taskId) : null);
    this.listIdentityLoops = listIdentityLoops;
    this.signalIdleIdentity = signalIdleIdentity;
    this.requestIdentityRecovery = requestIdentityRecovery;
    this.shortlistLimit = shortlistLimit;
    this.sweepIntervalMs = sweepIntervalMs;
    this.now = now;
    this.onEvent = onEvent;
    this.timer = null;
    this.stopped = false;
    this.reconcilePromise = null;
    this.reconcileRequested = false;
    this.nextReason = null;
    this.loopSignals = new Map();
    this.blockedSignals = new Map();
    this.lastSnapshot = {
      reason: null,
      eligible_count: 0,
      eligible_task_ids: [],
      blocked_count: 0,
      blocked_task_ids: [],
      healthy_loop_count: 0,
      idle_loop_count: 0,
      signaled_loop_count: 0,
      recovery_requested_count: 0,
      reconciled_at: null,
      claim_count: 0,
    };
  }

  start() {
    if (this.stopped) throw new Error('TaskController has been stopped');
    if (this.timer || this.sweepIntervalMs === 0) return this;
    this.timer = setInterval(() => {
      void this.reconcile({ reason: 'periodic_sweep' }).catch((error) => this.#emit({
        kind: 'controller_reconcile_failed', reason: 'periodic_sweep', error: this.#error(error), timestamp: this.now(),
      }));
    }, this.sweepIntervalMs);
    this.timer.unref?.();
    return this;
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.reconcilePromise) await this.reconcilePromise.catch(() => undefined);
    return this.snapshot();
  }

  snapshot() {
    return {
      ...this.lastSnapshot,
      eligible_task_ids: [...this.lastSnapshot.eligible_task_ids],
      blocked_task_ids: [...this.lastSnapshot.blocked_task_ids],
      stopped: this.stopped,
    };
  }

  /** Reconcile in response to a durable Task/dependency event. */
  notify(event = 'event') {
    const reason = typeof event === 'string' ? event : event?.reason ?? event?.type ?? 'event';
    return this.reconcile({ reason });
  }

  /** Alias used by event adapters that deliver dependency notifications. */
  onDependencyEvent(event) {
    return this.notify(event);
  }

  reconcile({ reason = 'reconcile' } = {}) {
    if (this.stopped) return Promise.resolve(this.snapshot());
    if (this.reconcilePromise) {
      this.reconcileRequested = true;
      this.nextReason = reason;
      return this.reconcilePromise;
    }
    this.reconcilePromise = this.#runReconcile(reason).finally(async () => {
      const rerun = this.reconcileRequested && !this.stopped;
      const rerunReason = this.nextReason ?? 'queued_event';
      this.reconcileRequested = false;
      this.nextReason = null;
      this.reconcilePromise = null;
      if (rerun) await this.reconcile({ reason: rerunReason });
    });
    return this.reconcilePromise;
  }

  async #runReconcile(reason) {
    const reconciledAt = this.now();
    const reconciliationTasks = asArray(await this.listBlockedTasks(), ['blocked_tasks', 'tasks']);
    const repairs = [];
    for (const task of reconciliationTasks) {
      const id = taskId(task);
      if (!id || typeof this.reconcileTask !== 'function') continue;
      try {
        const result = await this.reconcileTask(this.usesTaskServiceReconcile ? id : task, { reason, at: reconciledAt });
        if (result !== undefined && result !== null) repairs.push({ task_id: id, result });
        // A periodic sweep commonly returns changed:false for a stable
        // terminal or dependency state. Persisted Task events and the
        // controller snapshot already describe that no-op; emitting one
        // projection per sweep made a quiet queue look like active work.
        if (result === undefined || result === null || result.changed !== false) {
          this.#emit({ kind: 'controller_task_reconciled', task_id: id, reason, result: result ?? null, timestamp: this.now() });
        }
      } catch (error) {
        this.#emit({ kind: 'controller_task_reconcile_failed', task_id: id, reason, error: this.#error(error), timestamp: this.now() });
      }
    }
    const blocked = asArray(await this.listBlockedTasks(), ['blocked_tasks', 'tasks'])
      .filter((task) => task?.state === undefined || task.state === 'BLOCKED');
    const eligible = asArray(await this.listEligibleTasks(), ['eligible_tasks', 'ready_tasks', 'tasks']).slice(0, this.shortlistLimit);
    const identityLoops = asArray(await this.listIdentityLoops(), ['identity_loops', 'cores']);
    const idle = [];
    const healthy = [];
    const recovery = [];
    for (let index = 0; index < identityLoops.length; index += 1) {
      const loop = identityLoops[index];
      const view = loopState(loop);
      const id = loopId(view, index);
      if (isHealthy(view)) healthy.push(id);
      else {
        this.loopSignals.delete(id);
        recovery.push(id);
        if (typeof this.requestIdentityRecovery === 'function') {
          await this.requestIdentityRecovery(loop, { core_id: id, reason, at: reconciledAt });
          this.#emit({ kind: 'controller_loop_recovery_requested', core_id: id, reason, timestamp: this.now() });
        }
        this.#emit({ kind: 'controller_loop_unhealthy', core_id: id, reason, timestamp: this.now() });
        continue;
      }
      if (isIdle(view) && !takeRetryDeferred(view, reconciledAt)) idle.push({ loop, view, id });
      else this.loopSignals.delete(id);
    }
    const signature = taskSignature(eligible);
    let signaled = 0;
    if (eligible.length > 0 && typeof this.signalIdleIdentity === 'function') {
      // A single eligible Task needs one selector. Waking every idle Core for
      // that same shortlist creates a thundering-herd of valid but losing
      // claim attempts. Keep one wake slot per distinct eligible Task so
      // multiple independent Tasks can still use the available Cores.
      let signalBudget = eligible.length;
      for (const { loop, view, id } of idle) {
        if (signalBudget <= 0) break;
        signalBudget -= 1;
        // Include the identity loop's idle epoch so a completed failed/invalid
        // take attempt can be woken again even when the Controller never saw a
        // non-IDLE snapshot between attempts.  The task signature and state
        // still suppress duplicate signals for an untouched idle view.
        const signalKey = `${signature}:${String(view.state ?? 'IDLE')}:${String(idleGeneration(view))}`;
        if (this.loopSignals.get(id) === signalKey) continue;
        await this.signalIdleIdentity(loop, { core_id: id, reason, eligible_tasks: eligible, at: reconciledAt });
        this.loopSignals.set(id, signalKey);
        signaled += 1;
        this.#emit({ kind: 'controller_loop_signaled', core_id: id, reason, eligible_count: eligible.length, timestamp: this.now() });
      }
    }
    for (const { id } of idle) if (eligible.length === 0) this.loopSignals.delete(id);
    const snapshot = {
      reason,
      eligible_count: eligible.length,
      eligible_task_ids: eligible.map(taskId).filter(Boolean),
      blocked_count: blocked.length,
      blocked_task_ids: blocked.map(taskId).filter(Boolean),
      healthy_loop_count: healthy.length,
      idle_loop_count: idle.length,
      signaled_loop_count: signaled,
      recovery_requested_count: recovery.length,
      repaired_task_count: repairs.length,
      reconciled_at: new Date(reconciledAt).toISOString(),
      claim_count: 0,
    };
    this.lastSnapshot = snapshot;
    this.#emit({ kind: 'controller_reconcile', ...snapshot, timestamp: this.now() });
    for (const task of eligible) this.#emit({ kind: 'controller_task_eligible', task_id: taskId(task), timestamp: this.now() });
    const blockedIds = new Set();
    for (const task of blocked) {
      const id = taskId(task);
      if (!id) continue;
      blockedIds.add(id);
      const signal = `${String(task.state ?? 'BLOCKED')}:${String(task.block_reason ?? '')}`;
      if (this.blockedSignals.get(id) === signal) continue;
      this.blockedSignals.set(id, signal);
      this.#emit({ kind: 'controller_task_blocked', task_id: id, block_reason: task.block_reason ?? null, timestamp: this.now() });
    }
    for (const id of this.blockedSignals.keys()) if (!blockedIds.has(id)) this.blockedSignals.delete(id);
    return this.snapshot();
  }

  #emit(event) {
    try { this.onEvent?.(event); } catch { /* observability must not affect reconciliation */ }
  }

  #error(error) {
    return { name: error?.name ?? 'Error', code: error?.code ?? 'CONTROLLER_ERROR', message: error?.message ?? String(error) };
  }
}

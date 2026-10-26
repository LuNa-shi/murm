/**
 * Deterministic reconciliation for Task readiness and reusable Core Daemons.
 *
 * TaskController observes durable Task Service state. It may ask an injected
 * reconciliation adapter to refresh a blocked Task and may wake an idle Core
 * Daemon, but it never chooses or claims a Task. Value selection belongs to a
 * CoreDaemon after it receives a bounded claimable view.
 */

const DEFAULT_SHORTLIST_LIMIT = 16;
const DEFAULT_SWEEP_INTERVAL_MS = 5_000;

function asArray(value, keys = []) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const key of keys) if (Array.isArray(value[key])) return value[key];
  return [];
}

function daemonId(daemon, index) {
  return String(daemon?.core_id ?? daemon?.coreId ?? daemon?.id ?? daemon?.name ?? `core-${index + 1}`);
}

function daemonState(daemon) {
  if (typeof daemon?.snapshot === 'function') {
    try {
      const snapshot = daemon.snapshot();
      if (snapshot && typeof snapshot === 'object') return snapshot;
    } catch {
      // A health snapshot is advisory. The Controller still treats an
      // uninspectable Daemon as unhealthy below.
    }
  }
  return daemon ?? {};
}

function isIdle(daemon) {
  const state = String(daemon?.state ?? '').toUpperCase();
  return daemon?.idle === true || state === 'IDLE' || state === 'DISCOVERING';
}

function isHealthy(daemon) {
  if (daemon?.healthy === false || daemon?.health === 'unhealthy' || daemon?.status === 'failed') return false;
  const state = String(daemon?.state ?? '').toUpperCase();
  return !['FAILED', 'STOPPING', 'STOPPED'].includes(state);
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
    listClaimableTasks = null,
    listBlockedTasks = null,
    reconcileTask = null,
    listDaemons = () => [],
    signalIdleDaemon = null,
    requestDaemonRecovery = null,
    shortlistLimit = DEFAULT_SHORTLIST_LIMIT,
    sweepIntervalMs = DEFAULT_SWEEP_INTERVAL_MS,
    now = () => Date.now(),
    onEvent = null,
  } = {}) {
    const serviceList = taskService?.listTasks?.bind(taskService);
    if (typeof listClaimableTasks !== 'function' && typeof serviceList !== 'function') {
      throw new TypeError('TaskController requires listClaimableTasks or taskService.listTasks');
    }
    if (typeof listDaemons !== 'function') throw new TypeError('TaskController requires listDaemons');
    if (typeof now !== 'function') throw new TypeError('TaskController requires now');
    if (!Number.isInteger(shortlistLimit) || shortlistLimit < 1 || shortlistLimit > 100) {
      throw new TypeError('TaskController shortlistLimit must be an integer between 1 and 100');
    }
    if (!Number.isFinite(sweepIntervalMs) || sweepIntervalMs < 0) throw new TypeError('TaskController sweepIntervalMs must be non-negative');
    this.taskService = taskService;
    this.listClaimableTasks = listClaimableTasks ?? (() => serviceList({
      states: ['OPEN'], limit: shortlistLimit, availableOnly: true,
    }));
    this.listBlockedTasks = listBlockedTasks ?? (() => serviceList({
      states: ['BLOCKED'], limit: 100, availableOnly: false,
    }));
    this.usesTaskServiceReconcile = reconcileTask === null && typeof taskService?.reconcileTask === 'function';
    this.reconcileTask = reconcileTask
      ?? (this.usesTaskServiceReconcile ? taskService.reconcileTask.bind(taskService) : null);
    this.listDaemons = listDaemons;
    this.signalIdleDaemon = signalIdleDaemon;
    this.requestDaemonRecovery = requestDaemonRecovery;
    this.shortlistLimit = shortlistLimit;
    this.sweepIntervalMs = sweepIntervalMs;
    this.now = now;
    this.onEvent = onEvent;
    this.timer = null;
    this.stopped = false;
    this.reconcilePromise = null;
    this.reconcileRequested = false;
    this.nextReason = null;
    this.daemonSignals = new Map();
    this.lastSnapshot = {
      reason: null,
      claimable_count: 0,
      claimable_task_ids: [],
      blocked_count: 0,
      blocked_task_ids: [],
      healthy_daemon_count: 0,
      idle_daemon_count: 0,
      signaled_daemon_count: 0,
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
      claimable_task_ids: [...this.lastSnapshot.claimable_task_ids],
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
    const blocked = asArray(await this.listBlockedTasks(), ['blocked_tasks', 'tasks']);
    const repairs = [];
    for (const task of blocked) {
      const id = taskId(task);
      if (!id || typeof this.reconcileTask !== 'function') continue;
      try {
        const result = await this.reconcileTask(this.usesTaskServiceReconcile ? id : task, { reason, at: reconciledAt });
        if (result !== undefined && result !== null) repairs.push({ task_id: id, result });
        this.#emit({ kind: 'controller_task_reconciled', task_id: id, reason, result: result ?? null, timestamp: this.now() });
      } catch (error) {
        this.#emit({ kind: 'controller_task_reconcile_failed', task_id: id, reason, error: this.#error(error), timestamp: this.now() });
      }
    }
    const claimable = asArray(await this.listClaimableTasks(), ['claimable_tasks', 'ready_tasks', 'tasks']).slice(0, this.shortlistLimit);
    const daemons = asArray(await this.listDaemons(), ['daemons', 'cores']);
    const idle = [];
    const healthy = [];
    const recovery = [];
    for (let index = 0; index < daemons.length; index += 1) {
      const daemon = daemons[index];
      const view = daemonState(daemon);
      const id = daemonId(view, index);
      if (isHealthy(view)) healthy.push(id);
      else {
        recovery.push(id);
        if (typeof this.requestDaemonRecovery === 'function') {
          await this.requestDaemonRecovery(daemon, { core_id: id, reason, at: reconciledAt });
          this.#emit({ kind: 'controller_daemon_recovery_requested', core_id: id, reason, timestamp: this.now() });
        }
        this.#emit({ kind: 'controller_daemon_unhealthy', core_id: id, reason, timestamp: this.now() });
        continue;
      }
      if (isIdle(view)) idle.push({ daemon, view, id });
    }
    const signature = taskSignature(claimable);
    let signaled = 0;
    if (claimable.length > 0 && typeof this.signalIdleDaemon === 'function') {
      for (const { daemon, view, id } of idle) {
        const signalKey = `${signature}:${String(view.state ?? 'IDLE')}`;
        if (this.daemonSignals.get(id) === signalKey) continue;
        await this.signalIdleDaemon(daemon, { core_id: id, reason, claimable_tasks: claimable, at: reconciledAt });
        this.daemonSignals.set(id, signalKey);
        signaled += 1;
        this.#emit({ kind: 'controller_daemon_signaled', core_id: id, reason, claimable_count: claimable.length, timestamp: this.now() });
      }
    }
    for (const { id } of idle) if (claimable.length === 0) this.daemonSignals.delete(id);
    const snapshot = {
      reason,
      claimable_count: claimable.length,
      claimable_task_ids: claimable.map(taskId).filter(Boolean),
      blocked_count: blocked.length,
      blocked_task_ids: blocked.map(taskId).filter(Boolean),
      healthy_daemon_count: healthy.length,
      idle_daemon_count: idle.length,
      signaled_daemon_count: signaled,
      recovery_requested_count: recovery.length,
      repaired_task_count: repairs.length,
      reconciled_at: new Date(reconciledAt).toISOString(),
      claim_count: 0,
    };
    this.lastSnapshot = snapshot;
    this.#emit({ kind: 'controller_reconcile', ...snapshot, timestamp: this.now() });
    for (const task of claimable) this.#emit({ kind: 'controller_task_claimable', task_id: taskId(task), timestamp: this.now() });
    for (const task of blocked) this.#emit({ kind: 'controller_task_blocked', task_id: taskId(task), block_reason: task.block_reason ?? null, timestamp: this.now() });
    return this.snapshot();
  }

  #emit(event) {
    try { this.onEvent?.(event); } catch { /* observability must not affect reconciliation */ }
  }

  #error(error) {
    return { name: error?.name ?? 'Error', code: error?.code ?? 'CONTROLLER_ERROR', message: error?.message ?? String(error) };
  }
}

import { createHash } from 'node:crypto';
import { stableStringify } from '../protocol/envelope.js';

export const CORE_SLOT_STATES = Object.freeze(['IDLE', 'ASSIGNED', 'RUNNING', 'WAITING', 'STOPPING']);

function assertCore(core, coreCount) {
  if (!Number.isInteger(core) || core < 1 || core > coreCount) {
    throw new TypeError(`core must be an integer between 1 and ${coreCount}`);
  }
}

function assertState(state) {
  if (!CORE_SLOT_STATES.includes(state)) throw new TypeError(`unknown Core slot state: ${state}`);
}

function timestamp(value) {
  const result = value ?? Date.now();
  if (!Number.isFinite(result)) throw new TypeError('timestamp must be finite');
  return result;
}

function clamp(value, lower, upper) {
  return Math.max(lower, Math.min(value, upper));
}

function hash(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function toIso(ms) {
  return new Date(ms).toISOString();
}

function addDuration(map, key, duration) {
  if (duration <= 0) return;
  map[key] = (map[key] ?? 0) + duration;
}

function histogramWithRunningIntervals(intervals, startedAt, endedAt) {
  const events = new Map();
  for (const interval of intervals) {
    if (interval.state !== 'RUNNING') continue;
    const start = clamp(interval.start_ms, startedAt, endedAt);
    const end = clamp(interval.end_ms, startedAt, endedAt);
    if (end <= start) continue;
    events.set(start, (events.get(start) ?? 0) + 1);
    events.set(end, (events.get(end) ?? 0) - 1);
  }
  const ordered = [...events.entries()].sort(([left], [right]) => left - right);
  const histogram = {};
  let active = 0;
  let previous = startedAt;
  for (const [at, delta] of ordered) {
    if (at > previous) addDuration(histogram, active, at - previous);
    active += delta;
    previous = at;
  }
  if (previous < endedAt) addDuration(histogram, active, endedAt - previous);
  return histogram;
}

function sampleDurations(samples, startedAt, endedAt) {
  const ordered = samples
    .map((sample) => ({ ...sample, at_ms: clamp(sample.at_ms, startedAt, endedAt) }))
    .filter((sample) => sample.at_ms <= endedAt)
    .sort((left, right) => left.at_ms - right.at_ms);
  const result = { readyWorkMs: 0, readyUnassignedMs: 0 };
  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered[index];
    const nextAt = ordered[index + 1]?.at_ms ?? endedAt;
    const duration = Math.max(0, nextAt - current.at_ms);
    if (current.ready_count > 0) result.readyWorkMs += duration;
    if (current.ready_count > current.idle_core_count) result.readyUnassignedMs += duration;
  }
  return result;
}

function normalizeIntervals(intervals, startedAt, endedAt) {
  return intervals
    .map((interval) => ({
      ...interval,
      start_ms: clamp(interval.start_ms, startedAt, endedAt),
      end_ms: clamp(interval.end_ms, startedAt, endedAt),
    }))
    .filter((interval) => interval.end_ms > interval.start_ms)
    .sort((left, right) => left.core - right.core || left.start_ms - right.start_ms);
}

export class CoreParallelismTracker {
  constructor({ coreCount, startedAt = Date.now() } = {}) {
    if (!Number.isInteger(coreCount) || coreCount < 1) throw new TypeError('coreCount must be a positive integer');
    this.coreCount = coreCount;
    this.startedAt = timestamp(startedAt);
    this.closedIntervals = [];
    this.openIntervals = new Map();
    this.readySamples = [];
    this.schedulerPollMs = 0;
    this.claimConflictCount = 0;
    this.judgeTimeMs = 0;
    this.turnOccupancyMs = 0;
    this.workUnits = [];
    this.workUnitCounter = 0;
    for (let core = 1; core <= coreCount; core += 1) {
      this.openIntervals.set(core, {
        core,
        state: 'IDLE',
        task_id: null,
        execution_id: null,
        reason: 'slot_created',
        start_ms: this.startedAt,
      });
    }
  }

  transition(core, state, details = {}, at = Date.now()) {
    assertCore(core, this.coreCount);
    assertState(state);
    const eventAt = timestamp(at);
    const current = this.openIntervals.get(core);
    if (eventAt < current.start_ms) throw new RangeError('Core state transition moves backwards in time');
    const next = {
      task_id: details.task_id ?? null,
      execution_id: details.execution_id ?? null,
      reason: details.reason ?? null,
    };
    const same = current.state === state && current.task_id === next.task_id && current.execution_id === next.execution_id && current.reason === next.reason;
    if (same) return;
    this.#close(core, eventAt);
    this.openIntervals.set(core, { core, state, ...next, start_ms: eventAt });
  }

  recordReadyWork({ readyCount, idleCoreCount, at = Date.now() } = {}) {
    if (!Number.isInteger(readyCount) || readyCount < 0) throw new TypeError('readyCount must be a non-negative integer');
    if (!Number.isInteger(idleCoreCount) || idleCoreCount < 0) throw new TypeError('idleCoreCount must be a non-negative integer');
    this.readySamples.push({ at_ms: timestamp(at), ready_count: readyCount, idle_core_count: idleCoreCount });
  }

  recordSchedulerPoll(durationMs) {
    if (!Number.isFinite(durationMs) || durationMs < 0) throw new TypeError('scheduler poll duration must be non-negative');
    this.schedulerPollMs += durationMs;
  }

  recordClaimConflict() {
    this.claimConflictCount += 1;
  }

  recordJudgeTime(durationMs) {
    if (!Number.isFinite(durationMs) || durationMs < 0) throw new TypeError('Judge duration must be non-negative');
    this.judgeTimeMs += durationMs;
  }

  recordTurnTime(durationMs) {
    if (!Number.isFinite(durationMs) || durationMs < 0) throw new TypeError('turn duration must be non-negative');
    this.turnOccupancyMs += durationMs;
  }

  start(at = Date.now()) {
    const startAt = timestamp(at);
    if (startAt < this.startedAt) throw new RangeError('tracker cannot start before its creation time');
    this.closedIntervals = this.closedIntervals
      .filter((interval) => interval.end_ms > startAt)
      .map((interval) => ({ ...interval, start_ms: Math.max(interval.start_ms, startAt) }));
    this.readySamples = this.readySamples.filter((sample) => sample.at_ms >= startAt);
    for (const [core, interval] of this.openIntervals.entries()) {
      this.openIntervals.set(core, { ...interval, start_ms: Math.max(interval.start_ms, startAt) });
    }
    this.startedAt = startAt;
  }

  recordWorkUnit({
    work_unit_id: workUnitId = null,
    task_id: taskId = null,
    execution_id: executionId = null,
    core = null,
    progress_kind: progressKind,
    input_snapshot_hash: inputSnapshotHash = null,
    goal_fingerprint: goalFingerprint = null,
    output_fingerprint: outputFingerprint = null,
    duplicate_key: duplicateKey = null,
    at = Date.now(),
  } = {}) {
    if (typeof progressKind !== 'string' || progressKind.length === 0) throw new TypeError('progress_kind is required');
    if (core !== null) assertCore(core, this.coreCount);
    const atMs = timestamp(at);
    const dedupeKey = duplicateKey ?? (outputFingerprint
      ? hash({ progressKind, outputFingerprint })
      : hash({ taskId, inputSnapshotHash, goalFingerprint, progressKind }));
    const duplicate = this.workUnits.find((unit) => unit.dedupe_key === dedupeKey) ?? null;
    const unit = {
      work_unit_id: workUnitId ?? `work-unit-${++this.workUnitCounter}`,
      task_id: taskId,
      execution_id: executionId,
      core,
      progress_kind: progressKind,
      input_snapshot_hash: inputSnapshotHash,
      goal_fingerprint: goalFingerprint,
      output_fingerprint: outputFingerprint,
      duplicate_of: duplicate?.work_unit_id ?? null,
      dedupe_key: dedupeKey,
      started_at: toIso(atMs),
      ended_at: toIso(atMs),
      started_at_ms: atMs,
      ended_at_ms: atMs,
    };
    this.workUnits.push(unit);
    return { ...unit };
  }

  snapshot({ endedAt = Date.now() } = {}) {
    const end = timestamp(endedAt);
    if (end < this.startedAt) throw new RangeError('snapshot end precedes tracker start');
    const elapsedMs = end - this.startedAt;
    const intervals = normalizeIntervals([
      ...this.closedIntervals,
      ...[...this.openIntervals.values()].map((interval) => ({ ...interval, end_ms: end })),
    ], this.startedAt, end);
    const byState = {};
    const waitingMsByCore = {};
    const idleMsByCore = {};
    for (let core = 1; core <= this.coreCount; core += 1) {
      waitingMsByCore[core] = 0;
      idleMsByCore[core] = 0;
    }
    let agentTimeMs = 0;
    for (const interval of intervals) {
      const duration = interval.end_ms - interval.start_ms;
      addDuration(byState, interval.state, duration);
      if (interval.state === 'RUNNING') agentTimeMs += duration;
      if (interval.state === 'WAITING') addDuration(waitingMsByCore, interval.core, duration);
      if (interval.state === 'IDLE') addDuration(idleMsByCore, interval.core, duration);
    }
    const histogram = histogramWithRunningIntervals(intervals, this.startedAt, end);
    const activeCounts = Object.entries(histogram).filter(([, duration]) => duration > 0).map(([count]) => Number(count));
    const samples = sampleDurations(this.readySamples, this.startedAt, end);
    const workUnits = this.workUnits.map(({ dedupe_key: _dedupeKey, started_at_ms: _startedAtMs, ended_at_ms: _endedAtMs, ...unit }) => unit);
    return {
      core_count: this.coreCount,
      elapsed_ms: elapsedMs,
      total_core_capacity_ms: this.coreCount * elapsedMs,
      agent_time_ms: agentTimeMs,
      agent_time_utilization_v0: elapsedMs === 0 ? 0 : agentTimeMs / (this.coreCount * elapsedMs),
      mean_active_core_count: elapsedMs === 0 ? 0 : agentTimeMs / elapsedMs,
      max_active_core_count: activeCounts.length === 0 ? 0 : Math.max(...activeCounts),
      concurrency_histogram_ms: histogram,
      ready_work_ms: samples.readyWorkMs,
      ready_unassigned_ms: samples.readyUnassignedMs,
      waiting_ms_by_core: waitingMsByCore,
      idle_ms_by_core: idleMsByCore,
      scheduler_poll_ms: this.schedulerPollMs,
      claim_conflict_count: this.claimConflictCount,
      judge_time_ms: this.judgeTimeMs,
      turn_occupancy_ms: this.turnOccupancyMs,
      turn_occupancy_ratio_v0: this.coreCount * elapsedMs === 0 ? 0 : this.turnOccupancyMs / (this.coreCount * elapsedMs),
      state_time_ms: byState,
      core_state_intervals: intervals,
      work_units: workUnits,
    };
  }

  #close(core, endMs) {
    const current = this.openIntervals.get(core);
    if (endMs > current.start_ms) this.closedIntervals.push({ ...current, end_ms: endMs });
  }
}

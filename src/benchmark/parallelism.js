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

function eligibleIntervalsFromSamples(samples, coreCount, startedAt, endedAt) {
  const ordered = samples
    .map((sample) => ({ ...sample, at_ms: clamp(sample.at_ms, startedAt, endedAt) }))
    .filter((sample) => sample.at_ms <= endedAt)
    .sort((left, right) => left.at_ms - right.at_ms);
  const intervals = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered[index];
    const nextAt = ordered[index + 1]?.at_ms ?? endedAt;
    if (nextAt <= current.at_ms || current.eligible_work_count < coreCount) continue;
    const previous = intervals.at(-1);
    if (previous && previous.end_ms === current.at_ms && previous.eligible_work_count === current.eligible_work_count) {
      previous.end_ms = nextAt;
    } else {
      intervals.push({
        start_ms: current.at_ms,
        end_ms: nextAt,
        eligible_work_count: current.eligible_work_count,
      });
    }
  }
  return intervals;
}

function histogramWithinWindows(intervals, windows) {
  const histogram = {};
  for (const window of windows) {
    const events = new Map();
    for (const interval of intervals) {
      const start = Math.max(interval.start_ms, window.start_ms);
      const end = Math.min(interval.end_ms, window.end_ms);
      if (end <= start) continue;
      events.set(start, (events.get(start) ?? 0) + 1);
      events.set(end, (events.get(end) ?? 0) - 1);
    }
    const ordered = [...events.entries()].sort(([left], [right]) => left - right);
    let active = 0;
    let previous = window.start_ms;
    for (const [at, delta] of ordered) {
      if (at > previous) addDuration(histogram, active, at - previous);
      active += delta;
      previous = at;
    }
    if (previous < window.end_ms) addDuration(histogram, active, window.end_ms - previous);
  }
  return histogram;
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
    this.agentTurnIntervals = [];
    this.openAgentTurns = new Map();
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

  beginAgentTurn(core, details = {}, at = Date.now()) {
    assertCore(core, this.coreCount);
    const eventAt = timestamp(at);
    if (eventAt < this.startedAt) throw new RangeError('Agent turn cannot start before tracker creation');
    if (this.openAgentTurns.has(core)) throw new Error(`Core ${core} already has an active Agent turn`);
    this.openAgentTurns.set(core, {
      core,
      state: 'RUNNING',
      task_id: details.task_id ?? null,
      execution_id: details.execution_id ?? null,
      reason: details.reason ?? 'agent_turn_started',
      start_ms: eventAt,
    });
  }

  endAgentTurn(core, at = Date.now(), reason = 'agent_turn_completed') {
    assertCore(core, this.coreCount);
    const eventAt = timestamp(at);
    const current = this.openAgentTurns.get(core);
    if (!current) return false;
    if (eventAt < current.start_ms) throw new RangeError('Agent turn end moves backwards in time');
    if (eventAt > current.start_ms) {
      this.agentTurnIntervals.push({ ...current, end_ms: eventAt, reason_end: reason });
    }
    this.openAgentTurns.delete(core);
    return true;
  }

  recordReadyWork({ readyCount, idleCoreCount, eligibleWorkCount = 0, at = Date.now() } = {}) {
    if (!Number.isInteger(readyCount) || readyCount < 0) throw new TypeError('readyCount must be a non-negative integer');
    if (!Number.isInteger(idleCoreCount) || idleCoreCount < 0) throw new TypeError('idleCoreCount must be a non-negative integer');
    if (!Number.isInteger(eligibleWorkCount) || eligibleWorkCount < 0) throw new TypeError('eligibleWorkCount must be a non-negative integer');
    this.readySamples.push({ at_ms: timestamp(at), ready_count: readyCount, idle_core_count: idleCoreCount, eligible_work_count: eligibleWorkCount });
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
    this.agentTurnIntervals = this.agentTurnIntervals
      .filter((interval) => interval.end_ms > startAt)
      .map((interval) => ({ ...interval, start_ms: Math.max(interval.start_ms, startAt) }));
    for (const [core, interval] of this.openAgentTurns.entries()) {
      this.openAgentTurns.set(core, { ...interval, start_ms: Math.max(interval.start_ms, startAt) });
    }
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
    at = Date.now(),
  } = {}) {
    if (typeof progressKind !== 'string' || progressKind.length === 0) throw new TypeError('progress_kind is required');
    if (core !== null) assertCore(core, this.coreCount);
    const atMs = timestamp(at);
    const unit = {
      work_unit_id: workUnitId ?? `work-unit-${++this.workUnitCounter}`,
      task_id: taskId,
      execution_id: executionId,
      core,
      progress_kind: progressKind,
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
    for (const interval of intervals) {
      const duration = interval.end_ms - interval.start_ms;
      addDuration(byState, interval.state, duration);
      if (interval.state === 'WAITING') addDuration(waitingMsByCore, interval.core, duration);
      if (interval.state === 'IDLE') addDuration(idleMsByCore, interval.core, duration);
    }
    const hasAgentTurnEvidence = this.agentTurnIntervals.length > 0 || this.openAgentTurns.size > 0;
    const agentIntervals = normalizeIntervals([
      ...this.agentTurnIntervals,
      ...[...this.openAgentTurns.values()].map((interval) => ({ ...interval, end_ms: end })),
    ], this.startedAt, end);
    // Keep the transition-derived fallback for direct users of the tracker and
    // older reports. The benchmark runner records explicit Agent turn evidence,
    // which excludes discovery, polling, WAITING, and Judge-only time.
    const effectiveAgentIntervals = hasAgentTurnEvidence
      ? agentIntervals
      : intervals.filter((interval) => interval.state === 'RUNNING');
    const agentTimeMs = effectiveAgentIntervals.reduce((total, interval) => total + interval.end_ms - interval.start_ms, 0);
    const histogram = histogramWithRunningIntervals(effectiveAgentIntervals, this.startedAt, end);
    const activeCounts = Object.entries(histogram).filter(([, duration]) => duration > 0).map(([count]) => Number(count));
    const samples = sampleDurations(this.readySamples, this.startedAt, end);
    const eligibleIntervals = eligibleIntervalsFromSamples(this.readySamples, this.coreCount, this.startedAt, end);
    const eligibleWindowMs = eligibleIntervals.reduce((total, interval) => total + interval.end_ms - interval.start_ms, 0);
    const eligibleConcurrencyHistogram = histogramWithinWindows(effectiveAgentIntervals, eligibleIntervals);
    const eligibleAgentTimeMs = Object.entries(eligibleConcurrencyHistogram)
      .reduce((total, [activeCoreCount, duration]) => total + Number(activeCoreCount) * duration, 0);
    const workUnits = this.workUnits.map(({ started_at_ms: _startedAtMs, ended_at_ms: _endedAtMs, ...unit }) => unit);
    return {
      core_count: this.coreCount,
      elapsed_ms: elapsedMs,
      total_core_capacity_ms: this.coreCount * elapsedMs,
      agent_time_ms: agentTimeMs,
      agent_time_utilization_v0: elapsedMs === 0 ? 0 : agentTimeMs / (this.coreCount * elapsedMs),
      mean_active_core_count: elapsedMs === 0 ? 0 : agentTimeMs / elapsedMs,
      max_active_core_count: activeCounts.length === 0 ? 0 : Math.max(...activeCounts),
      concurrency_histogram_ms: histogram,
      eligible_intervals: eligibleIntervals,
      eligible_window_ms: eligibleWindowMs,
      eligible_agent_time_ms: eligibleAgentTimeMs,
      eligible_mean_active_core_count: eligibleWindowMs === 0 ? null : eligibleAgentTimeMs / eligibleWindowMs,
      eligible_concurrency_histogram_ms: eligibleConcurrencyHistogram,
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
      agent_turn_intervals: effectiveAgentIntervals,
      work_units: workUnits,
    };
  }

  #close(core, endMs) {
    const current = this.openIntervals.get(core);
    if (endMs > current.start_ms) this.closedIntervals.push({ ...current, end_ms: endMs });
  }
}

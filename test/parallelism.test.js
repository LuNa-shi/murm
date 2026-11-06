import test from 'node:test';
import assert from 'node:assert/strict';
import { CoreParallelismTracker } from '../src/benchmark/parallelism.js';

function fullRun(coreCount) {
  const tracker = new CoreParallelismTracker({ coreCount, startedAt: 0 });
  for (let core = 1; core <= coreCount; core += 1) {
    tracker.transition(core, 'RUNNING', { task_id: `task-${core}`, execution_id: `execution-${core}` }, 0);
  }
  return tracker.snapshot({ endedAt: 10_000 });
}

test('four Core RUNNING intervals produce full utilization', () => {
  const summary = fullRun(4);

  assert.equal(summary.agent_time_ms, 40_000);
  assert.equal(summary.total_core_capacity_ms, 40_000);
  assert.equal(summary.agent_time_utilization_v0, 1);
  assert.equal(summary.mean_active_core_count, 4);
  assert.equal(summary.max_active_core_count, 4);
  assert.deepEqual(summary.concurrency_histogram_ms, { 4: 10_000 });
});

test('two full Core intervals produce one half utilization', () => {
  const tracker = new CoreParallelismTracker({ coreCount: 4, startedAt: 0 });
  tracker.transition(1, 'RUNNING', { task_id: 'task-1', execution_id: 'execution-1' }, 0);
  tracker.transition(2, 'RUNNING', { task_id: 'task-2', execution_id: 'execution-2' }, 0);

  const summary = tracker.snapshot({ endedAt: 10_000 });

  assert.equal(summary.agent_time_ms, 20_000);
  assert.equal(summary.total_core_capacity_ms, 40_000);
  assert.equal(summary.agent_time_utilization_v0, 0.5);
  assert.deepEqual(summary.concurrency_histogram_ms, { 2: 10_000 });
});

test('one Core handing work between executions remains one quarter utilization', () => {
  const tracker = new CoreParallelismTracker({ coreCount: 4, startedAt: 0 });
  tracker.transition(1, 'RUNNING', { task_id: 'task-1', execution_id: 'execution-1' }, 0);
  tracker.transition(1, 'IDLE', { reason: 'wait' }, 5_000);
  tracker.transition(1, 'RUNNING', { task_id: 'task-2', execution_id: 'execution-2' }, 5_000);

  const summary = tracker.snapshot({ endedAt: 10_000 });

  assert.equal(summary.agent_time_ms, 10_000);
  assert.equal(summary.agent_time_utilization_v0, 0.25);
  assert.deepEqual(summary.concurrency_histogram_ms, { 1: 10_000 });
});

test('WAITING and idle intervals are excluded and state intervals do not overlap', () => {
  const tracker = new CoreParallelismTracker({ coreCount: 2, startedAt: 100 });
  tracker.transition(1, 'RUNNING', { task_id: 'task-1', execution_id: 'execution-1' }, 100);
  tracker.transition(1, 'WAITING', { task_id: 'task-1', execution_id: 'execution-1', reason: 'check_result' }, 1_100);
  tracker.transition(1, 'RUNNING', { task_id: 'task-1', execution_id: 'execution-1' }, 2_100);
  tracker.transition(1, 'IDLE', { reason: 'terminal' }, 3_100);

  const summary = tracker.snapshot({ endedAt: 4_100 });
  const intervals = summary.core_state_intervals.filter((interval) => interval.core === 1);

  assert.equal(summary.agent_time_ms, 2_000);
  assert.equal(summary.waiting_ms_by_core[1], 1_000);
  assert.equal(summary.idle_ms_by_core[1], 1_000);
  const recomputedAgentTime = summary.core_state_intervals
    .filter((interval) => interval.state === 'RUNNING')
    .reduce((total, interval) => total + interval.end_ms - interval.start_ms, 0);
  const recomputedCapacity = summary.core_state_intervals
    .reduce((total, interval) => total + interval.end_ms - interval.start_ms, 0);
  assert.equal(recomputedAgentTime, summary.agent_time_ms);
  assert.equal(recomputedCapacity, summary.total_core_capacity_ms);
  for (let index = 1; index < intervals.length; index += 1) {
    assert.ok(intervals[index - 1].end_ms <= intervals[index].start_ms);
  }
});

test('explicit Agent turn intervals exclude idle gaps from Agent Time', () => {
  const tracker = new CoreParallelismTracker({ coreCount: 4, startedAt: 0 });
  tracker.transition(1, 'RUNNING', { task_id: 'task-1', execution_id: 'execution-1' }, 0);
  tracker.beginAgentTurn(1, { task_id: 'task-1', execution_id: 'execution-1' }, 1_000);
  tracker.endAgentTurn(1, 2_000);
  tracker.beginAgentTurn(1, { task_id: 'task-1', execution_id: 'execution-1' }, 5_000);
  tracker.endAgentTurn(1, 6_000);

  const summary = tracker.snapshot({ endedAt: 10_000 });

  assert.equal(summary.agent_time_ms, 2_000);
  assert.equal(summary.agent_time_utilization_v0, 2_000 / 40_000);
  assert.deepEqual(summary.concurrency_histogram_ms, { 0: 8_000, 1: 2_000 });
  assert.equal(summary.agent_turn_intervals.length, 2);
});

test('turn occupancy is reported separately from RUNNING Agent Time', () => {
  const tracker = new CoreParallelismTracker({ coreCount: 4, startedAt: 0 });
  tracker.transition(1, 'RUNNING', { task_id: 'task-1', execution_id: 'execution-1' }, 0);
  tracker.recordTurnTime(7_000);
  tracker.transition(1, 'WAITING', { task_id: 'task-1', execution_id: 'execution-1' }, 2_000);

  const summary = tracker.snapshot({ endedAt: 4_000 });

  assert.equal(summary.agent_time_ms, 2_000);
  assert.equal(summary.turn_occupancy_ms, 7_000);
  assert.equal(summary.turn_occupancy_ratio_v0, 7_000 / 16_000);
});

test('claim conflicts deduplicate repeated event delivery by provenance key', () => {
  const tracker = new CoreParallelismTracker({ coreCount: 1, startedAt: 0 });

  assert.equal(tracker.recordClaimConflict('daemon:core-1:task-1:initial:0:10'), true);
  assert.equal(tracker.recordClaimConflict('daemon:core-1:task-1:initial:0:10'), false);
  assert.equal(tracker.recordClaimConflict(), true);
  assert.equal(tracker.snapshot({ endedAt: 1 }).claim_conflict_count, 2);
});

test('work units retain Task provenance without semantic deduplication fields', () => {
  const tracker = new CoreParallelismTracker({ coreCount: 1, startedAt: 0 });
  const first = tracker.recordWorkUnit({
    task_id: 'task-1',
    execution_id: 'execution-1',
    core: 1,
    progress_kind: 'candidate_check',
    at: 1_000,
  });

  assert.equal(first.task_id, 'task-1');
  assert.equal(first.execution_id, 'execution-1');
  assert.equal(Object.hasOwn(first, 'input_snapshot_hash'), false);
  assert.equal(Object.hasOwn(first, 'goal_fingerprint'), false);
  assert.equal(Object.hasOwn(first, 'output_fingerprint'), false);
  assert.equal(Object.hasOwn(first, 'duplicate_of'), false);
  assert.equal(tracker.snapshot({ endedAt: 3_000 }).work_units.length, 1);
});

test('eligible windows report overlapping Agent turns only while enough work is supplied', () => {
  const tracker = new CoreParallelismTracker({ coreCount: 4, startedAt: 0 });
  tracker.recordReadyWork({ readyCount: 4, idleCoreCount: 4, eligibleWorkCount: 4, at: 0 });
  for (let core = 1; core <= 4; core += 1) {
    tracker.beginAgentTurn(core, { task_id: `task-${core}`, execution_id: `execution-${core}` }, 0);
    tracker.endAgentTurn(core, 1_000);
  }
  tracker.recordReadyWork({ readyCount: 1, idleCoreCount: 1, eligibleWorkCount: 1, at: 1_000 });

  const summary = tracker.snapshot({ endedAt: 2_000 });

  assert.equal(summary.eligible_window_ms, 1_000);
  assert.equal(summary.eligible_agent_time_ms, 4_000);
  assert.equal(summary.eligible_mean_active_core_count, 4);
  assert.deepEqual(summary.eligible_intervals, [{
    start_ms: 0,
    end_ms: 1_000,
    eligible_work_count: 4,
  }]);
  assert.deepEqual(summary.eligible_concurrency_histogram_ms, { 4: 1_000 });
});

test('insufficient work produces no eligible window and does not invent a utilization failure', () => {
  const tracker = new CoreParallelismTracker({ coreCount: 4, startedAt: 0 });
  tracker.recordReadyWork({ readyCount: 2, idleCoreCount: 2, eligibleWorkCount: 2, at: 0 });
  tracker.recordReadyWork({ readyCount: 0, idleCoreCount: 4, eligibleWorkCount: 0, at: 1_000 });

  const summary = tracker.snapshot({ endedAt: 2_000 });

  assert.equal(summary.eligible_window_ms, 0);
  assert.equal(summary.eligible_agent_time_ms, 0);
  assert.equal(summary.eligible_mean_active_core_count, null);
  assert.deepEqual(summary.eligible_intervals, []);
});

test('all Cores idle with no claimable work is reported as a Mission stall (r12)', () => {
  const tracker = new CoreParallelismTracker({ coreCount: 4, startedAt: 0 });
  tracker.recordReadyWork({ readyCount: 1, idleCoreCount: 0, at: 0 });
  tracker.recordReadyWork({ readyCount: 0, idleCoreCount: 4, at: 2_000 });
  tracker.recordReadyWork({ readyCount: 0, idleCoreCount: 4, at: 4_000 });
  // Idle Cores with claimable work is a scheduling gap, not a stall.
  tracker.recordReadyWork({ readyCount: 1, idleCoreCount: 4, at: 7_000 });
  tracker.recordReadyWork({ readyCount: 0, idleCoreCount: 3, at: 8_000 });

  const summary = tracker.snapshot({ endedAt: 10_000 });

  assert.equal(summary.mission_stall_ms, 5_000);
  assert.equal(summary.mission_stall_ratio, 0.5);
  assert.deepEqual(summary.mission_stall_intervals.map((interval) => interval.duration_ms), [5_000]);
});

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

test('work units link identical outputs to their first occurrence', () => {
  const tracker = new CoreParallelismTracker({ coreCount: 1, startedAt: 0 });
  const first = tracker.recordWorkUnit({
    task_id: 'task-1',
    execution_id: 'execution-1',
    core: 1,
    progress_kind: 'candidate_check',
    input_snapshot_hash: 'input-a',
    goal_fingerprint: 'goal-a',
    output_fingerprint: 'output-a',
    at: 1_000,
  });
  const second = tracker.recordWorkUnit({
    task_id: 'task-2',
    execution_id: 'execution-2',
    core: 1,
    progress_kind: 'candidate_check',
    input_snapshot_hash: 'input-a',
    goal_fingerprint: 'goal-a',
    output_fingerprint: 'output-a',
    at: 2_000,
  });

  assert.equal(first.duplicate_of, null);
  assert.equal(second.duplicate_of, first.work_unit_id);
  assert.equal(tracker.snapshot({ endedAt: 3_000 }).work_units.length, 2);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildModel, coreTraceData, extractToolCalls, queueTasks } from '../src/observability/observation-projection.js';

function fixtureEvents() {
  return [
    { sequence: 1, source: 'runtime', kind: 'execution_assigned', core_id: 'core-1', task_id: 'task-root', execution_id: 'exec-root', session_id: 'session-1', occurred_at: '2026-10-20T00:00:00.000Z', payload: { state: 'RUNNING' } },
    { sequence: 2, source: 'runtime', kind: 'core_state_changed', core_id: 'core-1', task_id: 'task-root', execution_id: 'exec-root', occurred_at: '2026-10-20T00:00:01.000Z', payload: { state: 'RUNNING' } },
    { sequence: 3, source: 'task-service', kind: 'dispatch.complete', task_id: 'task-root', execution_id: 'exec-root', occurred_at: '2026-10-20T00:00:02.000Z', payload: { result: { task: { task_id: 'task-root', goal: 'Coordinate fixture', state: 'SUCCEEDED' }, execution: { execution_id: 'exec-root', task_id: 'task-root', state: 'SUCCEEDED' } } } },
    { sequence: 4, source: 'task-service', kind: 'dispatch.complete', task_id: 'task-wait', execution_id: 'exec-wait', occurred_at: '2026-10-20T00:00:03.000Z', payload: { result: { task: { task_id: 'task-wait', goal: 'Wait for dependency', state: 'BLOCKED' }, execution: { execution_id: 'exec-wait', task_id: 'task-wait', state: 'CLOSING', wait_condition: { type: 'dependency' } } } } },
    { sequence: 5, source: 'agent', kind: 'rpc_record', core_id: 'core-1', task_id: 'task-root', execution_id: 'exec-root', occurred_at: '2026-10-20T00:00:04.000Z', payload: { record: { type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'murm_task_list', args: { available_only: true } } } },
    { sequence: 6, source: 'agent', kind: 'rpc_record', core_id: 'core-1', task_id: 'task-root', execution_id: 'exec-root', occurred_at: '2026-10-20T00:00:05.000Z', payload: { record: { type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'murm_task_list', result: { tasks: [] }, isError: false } } },
    { sequence: 7, source: 'judge', kind: 'judge_check_finished', core_id: 'core-1', task_id: 'task-root', execution_id: 'exec-root', occurred_at: '2026-10-20T00:00:06.000Z', payload: { verdict: 'PASS' } },
  ];
}

test('observation projection derives durable queues, tools, and Core traces from bounded events', () => {
  const events = fixtureEvents();
  const timeline = { lanes: [{ core_id: 'core-1', states: [{ state: 'RUNNING', started_at: '2026-10-20T00:00:00.000Z', ended_at: null }], segments: [{ execution_id: 'exec-root', task_id: 'task-root', started_at: '2026-10-20T00:00:00.000Z', ended_at: null, state: 'RUNNING' }] }] };
  const model = buildModel(events, timeline, { 'exec-root': 1 });
  assert.equal(model.tasks.length, 2);
  assert.equal(model.executions.length, 2);
  assert.equal(model.tasks.find((task) => task.task_id === 'task-wait').block_reason, 'dependency');
  assert.equal(queueTasks(model).length, 1);
  assert.equal(extractToolCalls(events).length, 1);
  const traces = coreTraceData(events, timeline, model);
  assert.equal(traces.length, 1);
  assert.equal(traces[0].executions[0].execution_id, 'exec-root');
  assert.equal(traces[0].tools[0].tool_name, 'murm_task_list');
  assert.equal(traces[0].checks[0].label, 'Judge check');
});

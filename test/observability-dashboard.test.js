import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildModel, coreTraceData, extractToolCalls, queueTasks } from '../src/observability/client/lib/observation.js';

const dashboardSource = await readFile(new URL('../src/observability/public/app.js', import.meta.url), 'utf8');
const stylesheet = await readFile(new URL('../src/observability/public/styles.css', import.meta.url), 'utf8');
const page = await readFile(new URL('../src/observability/public/index.html', import.meta.url), 'utf8');
const observationHook = await readFile(new URL('../src/observability/client/hooks/use-observation.js', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../src/observability/client/App.jsx', import.meta.url), 'utf8');
const traceSource = await readFile(new URL('../src/observability/client/components/ui/trace.jsx', import.meta.url), 'utf8');

function fixtureEvents() {
  return [
    { sequence: 1, source: 'runtime', kind: 'execution_assigned', core_id: 'core-1', task_id: 'task-root', execution_id: 'exec-root', session_id: 'session-1', occurred_at: '2026-10-20T00:00:00.000Z', payload: { state: 'RUNNING' } },
    { sequence: 2, source: 'runtime', kind: 'core_state_changed', core_id: 'core-1', task_id: 'task-root', execution_id: 'exec-root', occurred_at: '2026-10-20T00:00:01.000Z', payload: { state: 'RUNNING' } },
    { sequence: 3, source: 'task-service', kind: 'dispatch.complete', task_id: 'task-root', execution_id: 'exec-root', occurred_at: '2026-10-20T00:00:02.000Z', payload: { result: { task: { task_id: 'task-root', goal: 'Coordinate fixture', state: 'SUCCEEDED' }, execution: { execution_id: 'exec-root', task_id: 'task-root', state: 'SUCCEEDED' } } } },
    { sequence: 4, source: 'task-service', kind: 'dispatch.complete', task_id: 'task-wait', execution_id: 'exec-wait', occurred_at: '2026-10-20T00:00:03.000Z', payload: { result: { task: { task_id: 'task-wait', goal: 'Wait for dependency', state: 'BLOCKED' }, execution: { execution_id: 'exec-wait', task_id: 'task-wait', state: 'CLOSING', wait_condition: { type: 'dependency' } } } } },
    { sequence: 5, source: 'agent', kind: 'rpc_record', core_id: 'core-1', task_id: 'task-root', execution_id: 'exec-root', occurred_at: '2026-10-20T00:00:04.000Z', payload: { record: { type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'swarmenv_task_list', args: { available_only: true } } } },
    { sequence: 6, source: 'agent', kind: 'rpc_record', core_id: 'core-1', task_id: 'task-root', execution_id: 'exec-root', occurred_at: '2026-10-20T00:00:05.000Z', payload: { record: { type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'swarmenv_task_list', result: { tasks: [] }, isError: false } } },
    { sequence: 7, source: 'judge', kind: 'judge_check_finished', core_id: 'core-1', task_id: 'task-root', execution_id: 'exec-root', occurred_at: '2026-10-20T00:00:06.000Z', payload: { verdict: 'PASS' } },
  ];
}

test('React observation model derives durable queues, tools, and Core traces from bounded events', () => {
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
  assert.equal(traces[0].tools[0].tool_name, 'swarmenv_task_list');
  assert.equal(traces[0].checks[0].label, 'Judge check');
});
test('generated Observation frontend keeps the server contract and redacted UI boundary', () => {
  assert.match(page, /id="root"/);
  assert.match(page, /src="\/app\.js"/);
  assert.match(page, /localStorage\.getItem\('swarmenv-theme'\)/);
  assert.ok(dashboardSource.length > 100_000, 'React production bundle should be present');
  assert.match(dashboardSource, /Observation plane/);
  assert.match(dashboardSource, /EventSource/);
  assert.match(dashboardSource, /\/api\/experiments\/stream/);
  assert.match(dashboardSource, /\/api\/experiments\/changes/);
  assert.doesNotMatch(observationHook, /setInterval\(/, 'registry updates should use SSE or a long-change request, not short polling');
  assert.match(dashboardSource, /Registry updates arrive over live SSE/);
  assert.match(dashboardSource, /trace-span/);
  for (const path of ['executions', 'tasks', 'materials', 'diagnostics', 'services']) assert.match(appSource, new RegExp(`'${path}'`));
  assert.match(appSource, /selectExperiment/);
  assert.match(appSource, /swarmenv-theme/);
  assert.match(appSource, /onExecution/);
  assert.match(traceSource, /trace-span/);
  assert.match(stylesheet, /--primary/);
  assert.match(stylesheet, /\.data-table/);
  assert.match(stylesheet, /\.trace-span/);
});

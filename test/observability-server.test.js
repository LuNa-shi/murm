import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { ObservationStore } from '../src/observability/observation-store.js';
import { ObservabilityServer } from '../src/observability/observability-server.js';

test('ObservabilityServer serves experiment queries and reconstructs Core execution segments', async () => {
  const store = new ObservationStore();
  store.registerExperiment({ experimentId: 'run-http', rootTaskId: 'root' });
  store.append({ experimentId: 'run-http', source: 'runtime', kind: 'core_state_changed', coreId: 'core-1', taskId: 'task-1', executionId: 'exec-1', occurredAt: '2026-10-20T00:00:00.000Z', payload: { state: 'RUNNING', reason: 'execution_bound', ended_at_ms: Date.parse('2026-10-20T00:00:02.000Z') } });
  store.append({ experimentId: 'run-http', source: 'runtime', kind: 'execution_assigned', coreId: 'core-1', taskId: 'task-1', executionId: 'exec-1', sessionId: 'session-1', occurredAt: '2026-10-20T00:00:00.000Z', payload: { state: 'RUNNING' } });
  store.append({ experimentId: 'run-http', source: 'agent', kind: 'tool_call_started', coreId: 'core-1', executionId: 'exec-1', sessionId: 'session-1', occurredAt: '2026-10-20T00:00:01.000Z', payload: { tool: 'task_list' } });
  store.append({ experimentId: 'run-http', source: 'runtime', kind: 'execution_released', coreId: 'core-1', taskId: 'task-1', executionId: 'exec-1', sessionId: 'session-1', occurredAt: '2026-10-20T00:00:02.000Z', payload: { state: 'WAITING' } });
  store.append({ experimentId: 'run-http', source: 'runtime', kind: 'core_state_changed', coreId: 'core-1', taskId: 'task-1', executionId: 'exec-1', occurredAt: '2026-10-20T00:00:02.000Z', payload: { state: 'WAITING', reason: 'execution_waiting' } });
  const server = new ObservabilityServer({ observationStore: store });
  const { url } = await server.start();
  const summary = await fetch(`${url}/api/experiments/run-http`).then((response) => response.json());
  assert.equal(summary.event_count, 5);
  const timeline = await fetch(`${url}/api/experiments/run-http/timeline`).then((response) => response.json());
  assert.deepEqual(timeline.lanes[0].segments[0], {
    execution_id: 'exec-1', task_id: 'task-1', session_id: 'session-1', started_at: '2026-10-20T00:00:00.000Z', ended_at: '2026-10-20T00:00:02.000Z', state: 'WAITING',
  });
  assert.deepEqual(timeline.lanes[0].states, [
    { state: 'RUNNING', reason: 'execution_bound', task_id: 'task-1', execution_id: 'exec-1', started_at: '2026-10-20T00:00:00.000Z', ended_at: '2026-10-20T00:00:02.000Z' },
    { state: 'WAITING', reason: 'execution_waiting', task_id: 'task-1', execution_id: 'exec-1', started_at: '2026-10-20T00:00:02.000Z', ended_at: null },
  ]);
  const overview = await fetch(`${url}/api/experiments/run-http/overview?view=agent`).then((response) => response.json());
  assert.equal(overview.events.length, 4);
  assert.equal(overview.timeline.lanes.length, 1);
  const derivedExecution = await fetch(`${url}/api/executions/exec-1?experiment_id=run-http`).then((response) => response.json());
  assert.equal(derivedExecution.execution.state, 'WAITING');
  const derivedTask = await fetch(`${url}/api/tasks/task-1?experiment_id=run-http`).then((response) => response.json());
  assert.equal(derivedTask.task.state, 'WAITING');
  const taskDetail = await fetch(`${url}/api/experiments/run-http/tasks/task-1`).then((response) => response.json());
  assert.equal(taskDetail.task.task_id, 'task-1');
  assert.equal(taskDetail.task.fields.task_id, 'task-1');
  assert.equal(taskDetail.observed_events, 4);
  const executionDetail = await fetch(`${url}/api/experiments/run-http/execution-detail?execution_id=exec-1`).then((response) => response.json());
  assert.equal(executionDetail.observed_events, 5);
  assert.equal(executionDetail.events.length, 4);
  const staticResponse = await fetch(`${url}/`);
  assert.equal(staticResponse.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(staticResponse.headers.get('content-disposition'), null);
  const staticPage = await staticResponse.text();
  assert.match(staticPage, /Experiment monitor/);
  assert.match(staticPage, /href="#home"/);
  assert.match(staticPage, /href="#executions"/);
  assert.match(staticPage, /href="#tasks"/);
  assert.match(staticPage, /href="#materials"/);
  assert.match(staticPage, /href="#diagnostics"/);
  assert.match(staticPage, /href="#services"/);
  assert.match(staticPage, /id="theme-select"/);
  assert.match(staticPage, /localStorage\.getItem\('swarmenv-theme'\)/);
  const [appResponse, stylesResponse] = await Promise.all([
    fetch(`${url}/app.js`),
    fetch(`${url}/styles.css`),
  ]);
  assert.equal(appResponse.status, 200);
  assert.equal(stylesResponse.status, 200);
  const [appSource, stylesSource] = await Promise.all([appResponse.text(), stylesResponse.text()]);
  assert.match(appSource, /function renderTimeline/);
  assert.match(appSource, /function renderExecutionInsight/);
  assert.match(stylesSource, /\.timeline-segment/);
  assert.match(stylesSource, /\.material-content-summary/);
  await server.stop();
  store.close();
});

test('ObservabilityServer exposes a live SSE stream for a registered Experiment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swarmenv-observability-stream-'));
  const writer = new ObservationStore(join(root, 'observability.sqlite'));
  const readerStore = new ObservationStore(join(root, 'observability.sqlite'));
  writer.registerExperiment({ experimentId: 'run-stream' });
  const server = new ObservabilityServer({ observationStore: readerStore });
  const { url } = await server.start();
  const response = await fetch(`${url}/api/experiments/run-stream/stream`);
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = response.body.getReader();
  writer.append({ experimentId: 'run-stream', source: 'runtime', kind: 'session_started', coreId: 'core-1', payload: { session: 's1' } });
  let text = '';
  const deadline = Date.now() + 2_000;
  while (!text.includes('session_started') && Date.now() < deadline) {
    const result = await Promise.race([reader.read(), new Promise((resolve) => setTimeout(() => resolve({ done: true, value: new Uint8Array() }), 500))]);
    text += new TextDecoder().decode(result.value ?? new Uint8Array());
    if (result.done) break;
  }
  assert.match(text, /session_started/);
  await server.stop();
  await reader.cancel().catch(() => undefined);
  readerStore.close();
  writer.close();
});

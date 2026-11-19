import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp } from 'node:fs/promises';
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
  const resumedTimeline = await fetch(`${url}/api/experiments/run-http/timeline?after_sequence=2`).then((response) => response.json());
  assert.deepEqual(resumedTimeline.lanes[0].events.map((event) => event.sequence), [4, 5]);
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
  assert.match(staticPage, /id="root"/);
  assert.match(staticPage, /src="\/app\.js"/);
  assert.match(staticPage, /localStorage\.getItem\('swarmenv-theme'\)/);
  const [appResponse, stylesResponse] = await Promise.all([
    fetch(`${url}/app.js`),
    fetch(`${url}/styles.css`),
  ]);
  assert.equal(appResponse.status, 200);
  assert.equal(stylesResponse.status, 200);
  const [appSource, stylesSource] = await Promise.all([appResponse.text(), stylesResponse.text()]);
  assert.match(appSource, /createRoot/);
  assert.match(appSource, /EventSource/);
  assert.match(appSource, /Core activity/);
  assert.match(stylesSource, /\.trace-span/);
  assert.match(stylesSource, /\.data-table/);
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

test('ObservabilityServer pushes cross-process Experiment registry updates over SSE', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swarmenv-observability-registry-'));
  await mkdir(join(root, '.observability'), { recursive: true });
  const database = join(root, '.observability', 'observability.sqlite');
  const writer = new ObservationStore(database);
  const readerStore = new ObservationStore(database);
  writer.registerExperiment({ experimentId: 'run-registry-first', status: 'RUNNING' });
  const server = new ObservabilityServer({ observationStore: readerStore, experimentRoot: root });
  const { url } = await server.start();
  const response = await fetch(`${url}/api/experiments/stream`);
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = response.body.getReader();
  let text = '';
  const readUntil = async (needle) => {
    const deadline = Date.now() + 3_000;
    while (!text.includes(needle) && Date.now() < deadline) {
      const result = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve({ done: true, value: new Uint8Array() }), 500)),
      ]);
      text += new TextDecoder().decode(result.value ?? new Uint8Array());
      if (result.done) break;
    }
    assert.match(text, new RegExp(needle));
  };
  await readUntil('run-registry-first');
  writer.registerExperiment({ experimentId: 'run-registry-second', status: 'CREATED' });
  await readUntil('run-registry-second');
  const registry = await fetch(`${url}/api/experiments`).then((result) => result.json());
  const pendingChanges = fetch(`${url}/api/experiments/changes?since=${encodeURIComponent(registry.revision)}`).then((result) => result.json());
  writer.registerExperiment({ experimentId: 'run-registry-third', status: 'RUNNING' });
  const changes = await pendingChanges;
  assert.equal(changes.changed, true);
  assert.ok(changes.experiments.some((experiment) => experiment.experiment_id === 'run-registry-third'));
  await server.stop();
  await reader.cancel().catch(() => undefined);
  readerStore.close();
  writer.close();
});

test('ObservabilityServer keeps imported lifecycle facts and root-array projections usable', async () => {
  const store = new ObservationStore();
  store.registerExperiment({ experimentId: 'run-imported', rootTaskId: 'task-root' });
  const append = (event) => store.append({ experimentId: 'run-imported', ...event });
  append({ source: 'runtime', kind: 'execution_assigned', taskId: 'task-root', executionId: 'exec-root', coreId: 'core-1', payload: { state: 'RUNNING' } });
  append({ source: 'runtime', kind: 'execution_observed', taskId: 'task-root', executionId: 'exec-root', payload: { task_state: 'WAITING', execution_state: 'WAITING' } });
  append({ source: 'agent', kind: 'agent_turn_started', taskId: 'task-root', executionId: 'exec-root', payload: { state: 'RUNNING' } });
  append({ source: 'workspace', kind: 'workspace_revision_saved', taskId: 'task-root', executionId: 'exec-root', payload: { path: 'README.md', workspace_revision: 2 } });
  append({ source: 'judge', kind: 'judge_check_finished', taskId: 'task-root', executionId: 'exec-root', payload: { workspace_source_id: 'material-1', verdict: 'FAIL' } });
  append({ source: 'task-service', kind: 'dispatch.complete', taskId: 'task-root', executionId: 'exec-root', payload: { result: [{ task_id: 'task-root', goal: 'Imported task', state: 'WAITING' }, { material_id: 'material-1', kind: 'artifact', summary: 'Imported proof note' }] } });
  append({ source: 'agent', kind: 'rpc_record', taskId: 'task-root', executionId: 'exec-root', payload: { record: { type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'swarmenv_context_publish', args: { kind: 'artifact' } } } });
  append({ source: 'agent', kind: 'rpc_record', taskId: 'task-root', executionId: 'exec-root', payload: { record: { type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'swarmenv_context_publish', result: { details: { material: { material_id: 'material-1', kind: 'artifact', summary: 'Imported proof note', content: { summary: 'Readable material', proof: 'PROOFSECRET' }, source_task: 'task-root', source_execution: 'exec-root' } } } } } });
  append({ source: 'agent', kind: 'rpc_record', taskId: 'task-root', executionId: 'exec-root', payload: { record: { type: 'tool_execution_start', toolCallId: 'call-task-view', toolName: 'swarmenv_task_view', args: { task_id: 'task-root' } } } });
  append({ source: 'agent', kind: 'rpc_record', taskId: 'task-root', executionId: 'exec-root', payload: { record: { type: 'tool_execution_end', toolCallId: 'call-task-view', toolName: 'swarmenv_task_view', args: { task_id: 'task-root' }, result: { details: { task: { task_id: 'task-root', goal: 'Current task', task_instructions: 'PRIVATE INSTRUCTIONS', state: 'WAITING' } } } } } });
  const server = new ObservabilityServer({ observationStore: store });
  const { url } = await server.start();
  try {
    const overview = await fetch(`${url}/api/experiments/run-imported/overview`).then((response) => response.json());
    assert.equal(overview.overview_truncated, false);
    assert.ok(overview.overview_bytes > 0);
    assert.ok(overview.events.some((event) => event.kind === 'agent_turn_started'));
    assert.ok(overview.events.some((event) => event.kind === 'workspace_revision_saved'));
    const arrayResult = overview.events.find((event) => event.kind === 'dispatch.complete').payload.result;
    assert.equal(arrayResult[0].task_id, 'task-root');
    assert.equal(arrayResult[1].material_id, 'material-1');
    assert.ok(overview.events.some((event) => event.payload.record?.toolName === 'swarmenv_context_publish'));
    assert.equal(overview.tool_counts['exec-root'], 2);

    const material = await fetch(`${url}/api/experiments/run-imported/materials/material-1`).then((response) => response.json());
    assert.equal(material.available, true);
    assert.equal(material.content_summary, 'Imported proof note');
    assert.equal(material.content_preview.proof, '[redacted]');
    assert.doesNotMatch(JSON.stringify(material), /PROOFSECRET/);
    const task = await fetch(`${url}/api/experiments/run-imported/tasks/task-root`).then((response) => response.json());
    assert.equal(task.task.fields.goal, 'Current task');
    assert.equal(task.task.fields.task_instructions, '[redacted]');
    const detail = await fetch(`${url}/api/experiments/run-imported/execution-detail?execution_id=exec-root`).then((response) => response.json());
    assert.ok(detail.events.some((event) => event.payload.record?.toolName === 'swarmenv_context_publish'));
    assert.equal(detail.truncated, false);
  } finally {
    await server.stop();
    store.close();
  }
});

test('ObservabilityServer marks oversized Execution detail projections as truncated', async () => {
  const store = new ObservationStore();
  store.registerExperiment({ experimentId: 'run-large-detail' });
  for (let sequence = 1; sequence <= 10_001; sequence += 1) {
    store.append({
      experimentId: 'run-large-detail',
      sequence,
      source: 'runtime',
      kind: 'execution_observed',
      executionId: 'exec-large',
      payload: { execution_state: sequence % 2 ? 'RUNNING' : 'WAITING' },
    });
  }
  const server = new ObservabilityServer({ observationStore: store });
  const { url } = await server.start();
  try {
    const detail = await fetch(`${url}/api/experiments/run-large-detail/execution-detail?execution_id=exec-large`).then((response) => response.json());
    assert.ok(detail.returned_events > 0 && detail.returned_events <= 10_000);
    assert.equal(detail.events.length, detail.returned_events);
    assert.equal(detail.truncated, true);
  } finally {
    await server.stop();
    store.close();
  }
});

test('ObservabilityServer caps oversized overview projections', async () => {
  const store = new ObservationStore();
  store.registerExperiment({ experimentId: 'run-large-overview' });
  const args = { payload: 'x'.repeat(8_000) };
  for (let sequence = 1; sequence <= 1_000; sequence += 1) {
    store.append({
      experimentId: 'run-large-overview',
      sequence,
      source: 'agent',
      kind: 'rpc_record',
      executionId: 'exec-large-overview',
      payload: { record: { type: 'tool_execution_start', toolCallId: `call-${sequence}`, toolName: 'swarmenv_context_publish', args } },
    });
  }
  const server = new ObservabilityServer({ observationStore: store });
  const { url } = await server.start();
  try {
    const overview = await fetch(`${url}/api/experiments/run-large-overview/overview`).then((response) => response.json());
    assert.equal(overview.overview_truncated, true);
    assert.ok(overview.overview_bytes <= 4_000_000);
    assert.ok(overview.events.length < 1_000);
  } finally {
    await server.stop();
    store.close();
  }
});

test('ObservabilityServer serves a recent overview window for large Experiments', async () => {
  const store = new ObservationStore();
  store.registerExperiment({ experimentId: 'run-recent-overview' });
  for (let sequence = 1; sequence <= 2_500; sequence += 1) {
    store.append({
      experimentId: 'run-recent-overview', sequence, source: 'runtime', kind: 'execution_observed',
      coreId: `core-${sequence % 4}`, executionId: `execution-${sequence % 8}`, payload: { state: 'RUNNING' },
    });
  }
  const server = new ObservabilityServer({ observationStore: store });
  const { url } = await server.start();
  try {
    const overview = await fetch(`${url}/api/experiments/run-recent-overview/overview`).then((response) => response.json());
    assert.ok(overview.events.length <= 2_000);
    assert.equal(overview.overview_history_truncated, true);
    assert.ok(overview.overview_start_sequence > 1);
    assert.equal(overview.overview_end_sequence, 2_500);
  } finally {
    await server.stop();
    store.close();
  }
});

test('ObservabilityServer preserves active Core lanes beyond the recent timeline window', async () => {
  const store = new ObservationStore();
  store.registerExperiment({ experimentId: 'run-active-lane' });
  store.append({
    experimentId: 'run-active-lane', sequence: 1, source: 'runtime', kind: 'execution_assigned',
    coreId: 'core-1', taskId: 'task-1', executionId: 'execution-1', sessionId: 'session-1', payload: { state: 'RUNNING' },
  });
  for (let sequence = 2; sequence <= 1_002; sequence += 1) {
    store.append({
      experimentId: 'run-active-lane', sequence, source: 'runtime', kind: 'core_state_changed',
      coreId: 'core-1', taskId: 'task-1', executionId: 'execution-1', payload: { state: 'RUNNING' },
    });
  }
  const server = new ObservabilityServer({ observationStore: store });
  const { url } = await server.start();
  try {
    const timeline = await fetch(`${url}/api/experiments/run-active-lane/timeline`).then((response) => response.json());
    assert.equal(timeline.lanes.length, 1);
    assert.deepEqual(timeline.lanes[0].segments, [{
      execution_id: 'execution-1', task_id: 'task-1', session_id: 'session-1',
      started_at: timeline.lanes[0].segments[0].started_at, ended_at: null, state: 'RUNNING',
    }]);
    const overview = await fetch(`${url}/api/experiments/run-active-lane/overview`).then((response) => response.json());
    assert.equal(overview.timeline.lanes[0].segments[0].execution_id, 'execution-1');
    assert.equal(overview.timeline.lanes[0].segments[0].ended_at, null);
  } finally {
    await server.stop();
    store.close();
  }
});

test('Observer refuses anonymous remote binds and rejects forwarded or cross-site local API requests', async t => {
  const store = new ObservationStore(':memory:');
  t.after(() => store.close());
  assert.throws(() => new ObservabilityServer({ observationStore: store, host: '0.0.0.0' }),
    /requires explicit operator authentication/);
  const server = new ObservabilityServer({ observationStore: store });
  const { url } = await server.start();
  t.after(() => server.stop());
  assert.equal((await fetch(`${url}/api/experiments`)).status, 200);
  assert.equal((await fetch(`${url}/api/experiments`, { headers: { 'x-forwarded-host': 'remote.example' } })).status, 403);
});

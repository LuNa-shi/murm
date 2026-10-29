import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ObservationStore, ObservationStoreCollection } from '../src/observability/observation-store.js';

test('ObservationStore persists experiment facts and returns cursor pages in event order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swarmenv-observability-'));
  const databasePath = join(root, 'observations.sqlite');
  const first = new ObservationStore(databasePath);
  first.registerExperiment({ experimentId: 'run-1', rootTaskId: 'task-root', metadata: { problem: 'demo' } });
  const firstEvent = first.append({
    experimentId: 'run-1', source: 'runtime', kind: 'experiment_started', payload: { mode: 'fixture' },
  });
  const secondEvent = first.append({
    experimentId: 'run-1', source: 'agent', kind: 'tool_call_started', executionId: 'exec-1',
    payload: { operation: 'read_materials' },
  });
  const thirdEvent = first.append({
    experimentId: 'run-1', source: 'agent', kind: 'tool_call_finished', executionId: 'exec-1',
    payload: { operation: 'read_materials', result: ['material-1'] },
  });
  assert.deepEqual([firstEvent.sequence, secondEvent.sequence, thirdEvent.sequence], [1, 2, 3]);
  assert.equal(first.countEvents('run-1'), 3);
  assert.deepEqual(first.listEvents({ experimentId: 'run-1', limit: 2 }), {
    events: [firstEvent, secondEvent],
    next_cursor: 2,
    has_more: true,
  });
  assert.deepEqual(first.listEvents({ experimentId: 'run-1', afterSequence: 2, executionId: 'exec-1' }).events, [thirdEvent]);
  first.finishExperiment('run-1', { status: 'FINISHED', endedAt: '2026-10-20T00:00:00.000Z' });
  first.close();

  const reopened = new ObservationStore(databasePath);
  assert.equal(reopened.getExperiment('run-1').status, 'FINISHED');
  assert.deepEqual(reopened.getEvent(secondEvent.event_id), secondEvent);
  reopened.close();
  await rm(root, { recursive: true, force: true });
});

test('ObservationStore returns recent windows and indexed summary data without payload replay', () => {
  const store = new ObservationStore();
  store.registerExperiment({ experimentId: 'run-window' });
  for (let sequence = 1; sequence <= 20; sequence += 1) {
    store.append({
      experimentId: 'run-window', sequence, source: 'runtime', kind: sequence % 2 ? 'execution_assigned' : 'core_state_changed',
      coreId: `core-${sequence % 2}`, payload: { state: 'RUNNING', large: 'x'.repeat(1_000) },
    });
  }
  assert.equal(store.latestSequence('run-window'), 20);
  assert.deepEqual(store.listCoreIds('run-window'), ['core-0', 'core-1']);
  assert.deepEqual(store.listRecentEvents({ experimentId: 'run-window', limit: 3 }).events.map((event) => event.sequence), [18, 19, 20]);
  assert.equal(store.listRecentEvents({ experimentId: 'run-window', limit: 2_000 }).events.length, 20);
  assert.deepEqual(store.listLatestEntityEvents({ experimentId: 'run-window', kinds: ['execution_assigned'], limit: 10 }).events.map((event) => event.sequence), [19]);
  store.close();
});

test('ObservationStore publishes live events and keeps Agent payloads bounded and redacted', () => {
  const store = new ObservationStore();
  store.registerExperiment({ experimentId: 'run-live' });
  const received = [];
  const unsubscribe = store.subscribe('run-live', (event) => received.push(event));
  const event = store.append({
    experimentId: 'run-live', source: 'agent', kind: 'rpc_record', visibility: 'private',
    payload: {
      raw_transcript: 'do not expose this',
      message: 'a'.repeat(4_100),
      tool_name: 'context_read',
    },
  });
  assert.equal(received.length, 1);
  assert.equal(received[0].event_id, event.event_id);
  const agentEvent = store.getEvent(event.event_id, { view: 'agent' });
  assert.equal(agentEvent.payload.raw_transcript.redacted, true);
  assert.notEqual(agentEvent.payload.raw_transcript.sha256, event.payload_hash);
  assert.equal(agentEvent.payload.message.endsWith('[agent payload truncated]'), true);
  assert.equal(agentEvent.payload.tool_name, 'context_read');
  assert.deepEqual(store.listEvents({ experimentId: 'run-live', view: 'agent' }).events, [agentEvent]);
  unsubscribe();
  store.close();
});

test('ObservationStore rejects events outside a registered Experiment and duplicate sequence numbers', () => {
  const store = new ObservationStore();
  assert.throws(() => store.append({ experimentId: 'unknown', source: 'runtime', kind: 'x' }), /unknown experiment/);
  store.registerExperiment({ experimentId: 'run-duplicate' });
  store.append({ experimentId: 'run-duplicate', source: 'runtime', kind: 'x', sequence: 7 });
  assert.throws(() => store.append({ experimentId: 'run-duplicate', source: 'runtime', kind: 'y', sequence: 7 }), /UNIQUE constraint/);
  store.close();
});

test('ObservationStoreCollection merges experiments and routes events across worktree databases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swarmenv-observability-collection-'));
  await mkdir(join(root, 'worktree-a', '.observability'), { recursive: true });
  await mkdir(join(root, 'worktree-b', '.observability'), { recursive: true });
  const first = new ObservationStore(join(root, 'worktree-a', '.observability', 'observability.sqlite'));
  const second = new ObservationStore(join(root, 'worktree-b', '.observability', 'observability.sqlite'));
  first.registerExperiment({ experimentId: 'worktree-a-run', status: 'RUNNING' });
  first.append({ experimentId: 'worktree-a-run', source: 'runtime', kind: 'session_started', payload: {} });
  first.append({ experimentId: 'worktree-a-run', source: 'runtime', kind: 'execution_assigned', coreId: 'core-a', executionId: 'execution-a', payload: { state: 'RUNNING' } });
  second.registerExperiment({ experimentId: 'worktree-b-run', status: 'CREATED' });
  second.append({ experimentId: 'worktree-b-run', source: 'runtime', kind: 'experiment_started', payload: {} });
  const collection = new ObservationStoreCollection({ stores: [first, second] });
  assert.deepEqual(collection.listExperiments({ limit: 10 }).map((experiment) => experiment.experiment_id).sort(), ['worktree-a-run', 'worktree-b-run']);
  assert.equal(collection.countEvents('worktree-a-run'), 2);
  assert.equal(collection.listActiveTimelineEvents({ experimentId: 'worktree-a-run' }).events[0].kind, 'execution_assigned');
  assert.equal(collection.listEvents({ experimentId: 'worktree-b-run' }).events[0].kind, 'experiment_started');
  assert.ok(collection.watchPaths().some((path) => path.endsWith('worktree-a/.observability')));
  collection.close();
  await rm(root, { recursive: true, force: true });
});

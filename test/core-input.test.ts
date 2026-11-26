import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { ServiceRegistry } from '@murm/core/services';
import { transport } from './fixtures/core-input-backend.js';

// Replace the external backend boundary, leaving the public Runtime and its
// state/receipt/event implementation intact. No production injection API.
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === './pi-opensandbox-backend.js' && context.parentURL?.endsWith('/src/core/index.js')) {
    return { url: new URL('./fixtures/core-input-backend.js', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
} });
const { createRuntime } = await import('@murm/core');
hooks.deregister();

async function setup(t) {
  transport.reset();
  const outputDir = await mkdtemp(join(tmpdir(), 'core-input-'));
  const runtime = await createRuntime({ backend: {}, profiles: { worker: {
    prompt: 'fixed', model: 'default', image: 'test', writable: true, services: {},
  } }, services: new ServiceRegistry(), maxAgents: 3, outputDir });
  t.after(async () => { await runtime.close(); await rm(outputDir, { recursive: true, force: true }); });
  const agent = await runtime.spawn({ profile: 'worker', requestId: 'spawn' });
  return { runtime, agent, outputDir };
}

test('unknown input receipt can gain evidence without a second submission', async t => {
  const { runtime, agent } = await setup(t);
  const first = await runtime.send(agent.id, 'fixed', { requestId: 'one' });
  assert.equal(first.status, 'unknown');
  transport.confirm(first.inputId, 'started');
  const resolved = await runtime.send(agent.id, 'fixed', { requestId: 'one', mode: 'steer' });
  assert.deepEqual(resolved, { inputId: first.inputId, status: 'accepted', disposition: 'started' });
  assert.equal(transport.submissions.size, 1);
  await assert.rejects(runtime.send(agent.id, 'different', { requestId: 'one' }), { code: 'CONFLICT' });
});

test('concurrent inputs preserve scope, default mode and pre-receipt settled snapshots', async t => {
  const { runtime, agent } = await setup(t);
  const second = await runtime.spawn({ profile: 'worker', requestId: 'spawn-two' });
  const observed = [];
  runtime.onEvent(() => { throw new Error('subscriber failure'); });
  runtime.onEvent(event => { observed.push({ event, snapshot: runtime.get(event.agentId) }); });
  let release;
  transport.next = async id => {
    transport.listeners.get(agent.id)({ type: 'settled', outcome: 'completed', output: 'round one' });
    await new Promise(resolve => { release = resolve; });
    transport.confirm(id, 'started');
  };
  const first = runtime.send(agent.id, 'fixed', { requestId: 'same' });
  const repeated = runtime.send(agent.id, 'fixed', { requestId: 'same', mode: 'steer' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(observed.length, 1);
  const snapshot = await observed[0].snapshot;
  assert.equal(snapshot.status, 'idle');
  assert.equal(snapshot.cursor, observed[0].event.seq);
  assert.equal(snapshot.latestOutput, 'round one');
  release();
  assert.deepEqual(await first, await repeated);
  assert.equal(transport.submissions.size, 1);
  await runtime.send(second.id, 'fixed', { requestId: 'same' });
  assert.equal(transport.submissions.size, 2);
  transport.listeners.get(agent.id)({ type: 'settled', outcome: 'aborted', error: { code: 'ABORTED', message: 'aborted', retryable: false } });
  const final = await runtime.get(agent.id);
  assert.equal(final.latestOutput, undefined);
  assert.equal(final.lastError.code, 'ABORTED');
  assert.equal(final.cursor, 2);
});

test('host send wait is bounded while its original submission stays in flight', async t => {
  const { runtime, agent } = await setup(t);
  let release;
  transport.next = id => new Promise(resolve => { release = () => { transport.confirm(id, 'started'); resolve(); }; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = runtime.send(agent.id, 'fixed', { requestId: 'bounded' });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(60_000);
  const first = await pending;
  assert.equal(first.status, 'unknown');
  const repeated = runtime.send(agent.id, 'fixed', { requestId: 'bounded' });
  release();
  const confirmed = await repeated;
  assert.equal(confirmed.status, 'accepted');
  assert.equal(confirmed.inputId, first.inputId);
  assert.equal(transport.submissions.size, 1);
  t.mock.timers.reset();
});

test('handled receipts do not imply execution and fresh sends reject exited and closed Agents', async t => {
  const { runtime, agent } = await setup(t);
  transport.next = async id => transport.confirm(id, 'handled');
  const receipt = await runtime.send(agent.id, '/local-command', { requestId: 'handled' });
  assert.equal(receipt.disposition, 'handled');
  assert.equal((await runtime.get(agent.id)).status, 'idle');
  transport.listeners.get(agent.id)({ type: 'error', fatal: true, error: { code: 'PROCESS_EXITED', message: 'fatal', retryable: false } });
  transport.listeners.get(agent.id)({ type: 'exit', reason: 'unexpected', expected: false });
  assert.equal((await runtime.get(agent.id)).status, 'exited');
  await assert.rejects(runtime.send(agent.id, 'new', { requestId: 'exited' }), { code: 'NOT_ALLOWED' });
  await runtime.stop(agent.id);
  await assert.rejects(runtime.send(agent.id, 'new', { requestId: 'closed' }), { code: 'NOT_ALLOWED' });
});

test('handled local output restores idle without erasing its output snapshot', async t => {
  const { runtime, agent } = await setup(t);
  transport.next = async id => {
    transport.listeners.get(agent.id)({ type: 'output', text: 'Local command handled' });
    transport.confirm(id, 'handled');
  };
  const receipt = await runtime.send(agent.id, '/local-command', { requestId: 'local-output' });
  assert.equal(receipt.disposition, 'handled');
  const snapshot = await runtime.get(agent.id);
  assert.equal(snapshot.status, 'idle');
  assert.equal(snapshot.latestOutput, 'Local command handled');
  assert.equal(snapshot.cursor, 1);
});

test('handled receipt preserves existing execution and newer input activity', async t => {
  const { runtime, agent } = await setup(t);
  let release;
  transport.next = id => new Promise(resolve => { release = () => { transport.confirm(id, 'handled'); resolve(); }; });
  const earlier = runtime.send(agent.id, '/local-command', { requestId: 'earlier-handled' });
  await new Promise(resolve => setImmediate(resolve));
  transport.next = async id => transport.confirm(id, 'started');
  await runtime.send(agent.id, 'new work', { requestId: 'newer-execution' });
  release();
  assert.equal((await earlier).disposition, 'handled');
  assert.equal((await runtime.get(agent.id)).status, 'running');
  transport.next = async id => {
    transport.listeners.get(agent.id)({ type: 'output', text: 'Handled while busy' });
    transport.confirm(id, 'handled');
  };
  assert.equal((await runtime.send(agent.id, '/local-command', { requestId: 'handled-while-busy' })).disposition, 'handled');
  assert.equal((await runtime.get(agent.id)).status, 'running');
});

for (const resolution of ['handled', 'rejected']) test(`overlapping local inputs release running after reverse-order ${resolution} receipt`, async t => {
  const { runtime, agent } = await setup(t);
  const release = [];
  const queue = (outcome = 'handled') => {
    transport.next = id => new Promise((resolve, reject) => { release.push(() => {
      if (outcome === 'rejected') reject(Object.assign(new Error('Local command rejected'), { code: 'INVALID_CONTRACT' }));
      else { transport.confirm(id, 'handled'); resolve(); }
    }); });
  };
  queue(resolution);
  const first = runtime.send(agent.id, '/first-command', { requestId: 'first-local' });
  await new Promise(resolve => setImmediate(resolve));
  queue();
  const second = runtime.send(agent.id, '/second-command', { requestId: 'second-local' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await runtime.get(agent.id)).status, 'running');
  release[1]();
  assert.equal((await second).disposition, 'handled');
  assert.equal((await runtime.get(agent.id)).status, 'running');
  release[0]();
  if (resolution === 'rejected') await assert.rejects(first, { code: 'INVALID_CONTRACT' });
  else assert.equal((await first).disposition, 'handled');
  assert.equal((await runtime.get(agent.id)).status, 'idle');
});

test('older unknown keeps running until native settlement and late receipt evidence does not resurrect the execution', async t => {
  const { runtime, agent } = await setup(t);
  const original = await runtime.send(agent.id, 'uncertain original', { requestId: 'original-unknown' });
  assert.equal(original.status, 'unknown');
  transport.next = async id => transport.confirm(id, 'handled');
  await runtime.send(agent.id, '/local-command', { requestId: 'newer-handled' });
  assert.equal((await runtime.get(agent.id)).status, 'running');
  assert.deepEqual(await runtime.send(agent.id, 'uncertain original', { requestId: 'original-unknown' }), original);
  assert.equal((await runtime.get(agent.id)).status, 'running');
  transport.listeners.get(agent.id)({ type: 'settled', outcome: 'completed', output: 'Session execution settled' });
  assert.equal((await runtime.get(agent.id)).status, 'idle');
  assert.deepEqual(await runtime.send(agent.id, 'uncertain original', { requestId: 'original-unknown' }), original);
  assert.equal((await runtime.get(agent.id)).status, 'idle');
  transport.confirm(original.inputId, 'started');
  const accepted = await runtime.send(agent.id, 'uncertain original', { requestId: 'original-unknown' });
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.inputId, original.inputId);
  assert.equal((await runtime.get(agent.id)).status, 'idle');
  assert.equal(transport.submissions.size, 2);
});

test('lists every registered Agent and filters by parent and observed status', async t => {
  const { runtime, agent } = await setup(t);
  const child = await runtime.spawn({ profile: 'worker', parentId: agent.id, requestId: 'child' });
  const starting = runtime.spawn({ profile: 'worker', requestId: 'starting' });
  let rows = await runtime.list();
  assert.deepEqual(rows.map(row => row.status), ['idle', 'idle', 'starting']);
  const third = await starting;
  assert.deepEqual(await runtime.list({ parentId: agent.id }), [child]);
  assert.deepEqual(await runtime.list({ parentId: null }), [agent, third]);
  await runtime.send(agent.id, 'work', { requestId: 'list-work' });
  transport.listeners.get(child.id)({ type: 'exit', expected: false, reason: 'exited' });
  const stopping = runtime.stop(third.id);
  const closing = (await runtime.list({ status: 'closing' }))[0];
  assert.equal(closing.lastStop.cleanup, 'pending');
  await stopping;
  rows = await runtime.list({ status: ['running', 'exited', 'closed'] });
  assert.deepEqual(rows.map(row => row.status), ['running', 'exited', 'closed']);
  rows[0].status = 'closed';
  assert.equal((await runtime.get(agent.id)).status, 'running');
  assert.deepEqual(await runtime.list({ status: 'starting' }), []);
  for (const status of ['pending', null, 123, {}, ['idle', null]]) {
    await assert.rejects(runtime.list({ status }), { code: 'INVALID_CONTRACT', operation: 'list' });
  }
});

test('send independently selects timing and waking, and audits the trusted host source', async t => {
  const { runtime, agent, outputDir } = await setup(t);
  transport.next = async id => transport.confirm(id, 'started');
  const started = await runtime.start(agent.id, 'first phase', { requestId: 'start' });
  assert.equal(started.disposition, 'started');
  assert.deepEqual(await runtime.send(agent.id, 'first phase', { requestId: 'start', mode: 'followUp', wakeIfIdle: true }), started);
  transport.next = async id => transport.confirm(id, 'queued');
  const legacy = { requestId: 'legacy-steer', source: 'external-message-service', steeringMode: 'all' };
  const legacySteer = await runtime.steer(agent.id, 'steer as before', legacy);
  assert.deepEqual(await runtime.send(agent.id, 'steer as before', legacy), legacySteer);
  transport.next = async id => transport.confirm(id, 'queued');
  const options = { requestId: 'push', source: 'external-message-service', steeringMode: 'all', wakeIfIdle: false };
  const steered = await runtime.send(agent.id, 'push now', options);
  assert.equal(steered.disposition, 'queued');
  assert.equal(transport.submissions.get(steered.inputId).wakeIfIdle, false);
  assert.equal(transport.submissions.get(steered.inputId).steeringMode, 'all');
  assert.deepEqual(await runtime.send(agent.id, 'push now', { ...options, mode: 'steer' }), steered);
  await assert.rejects(runtime.send(agent.id, 'push now', { ...options, wakeIfIdle: true }), { code: 'CONFLICT' });
  await assert.rejects(runtime.send(agent.id, 'push now', { ...options, source: 'different' }), { code: 'CONFLICT' });
  await assert.rejects(runtime.send(agent.id, 'push now', { ...options, steeringMode: 'one-at-a-time' }), { code: 'CONFLICT' });
  await assert.rejects(runtime.send(agent.id, 'bad mode', { requestId: 'bad', steeringMode: 'all-at-once' }), { code: 'INVALID_CONTRACT' });
  await runtime.close();
  const rows = (await readFile(join(outputDir, runtime.id, 'evidence.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(rows.some(row => row.type === 'input' && row.inputId === steered.inputId &&
    row.state === 'accepted' && row.caller === 'host' && row.source === 'external-message-service' &&
    row.steeringMode === 'all' && row.wakeIfIdle === false));
});

test('interrupt fences new inputs until the old execution settles and replays the same receipt', async t => {
  const { runtime, agent } = await setup(t);
  transport.next = async id => transport.confirm(id, 'started');
  await runtime.send(agent.id, 'old execution', { mode: 'followUp', requestId: 'old' });
  let finish;
  transport.onInterrupt = () => new Promise(resolve => { finish = resolve; });
  const observed = [];
  runtime.onEvent(event => observed.push(event));
  const first = runtime.interrupt(agent.id, { requestId: 'interrupt' });
  await new Promise(resolve => setImmediate(resolve));
  const repeat = runtime.interrupt(agent.id, { requestId: 'interrupt' });
  await assert.rejects(runtime.interrupt(agent.id, { requestId: 'other-interrupt' }), { code: 'CONFLICT' });
  await assert.rejects(runtime.send(agent.id, 'blocked execution', { mode: 'followUp', requestId: 'new' }), { code: 'NOT_ALLOWED' });
  transport.listeners.get(agent.id)({ type: 'settled', outcome: 'aborted' });
  finish({ status: 'interrupted' });
  const receipt = await first;
  assert.equal(receipt.status, 'interrupted');
  assert.deepEqual(await repeat, receipt);
  assert.equal((await runtime.get(agent.id)).status, 'idle');
  transport.next = async id => transport.confirm(id, 'started');
  await runtime.send(agent.id, 'new execution', { mode: 'followUp', requestId: 'new' });
  assert.deepEqual(await runtime.interrupt(agent.id, { requestId: 'interrupt' }), receipt);
  assert.equal((await runtime.get(agent.id)).status, 'running');
  assert.equal(transport.interruptCalls.length, 1);
  assert.equal(transport.submissions.size, 2);
  assert.deepEqual(observed.map(x => [x.type, x.outcome]), [['settled', 'aborted']]);
});

test('an uncertain interrupt cannot reach a later execution and the same request can confirm the fence', async t => {
  const { runtime, agent } = await setup(t);
  transport.onInterrupt = async () => ({ status: 'unknown' });
  const request = { requestId: 'lost-interrupt' };
  const first = await runtime.interrupt(agent.id, request);
  assert.equal(first.status, 'unknown');
  await assert.rejects(runtime.send(agent.id, 'too soon', { requestId: 'blocked' }), { code: 'NOT_ALLOWED' });
  transport.onInterrupt = async () => ({ status: 'interrupted' });
  const second = await runtime.interrupt(agent.id, request);
  assert.equal(second.status, 'interrupted');
  assert.equal(second.interruptId, first.interruptId);
  assert.deepEqual(transport.interruptCalls.map(call => call.executionEpoch), [1, 1]);
  await runtime.stop(agent.id);
  assert.deepEqual(await runtime.interrupt(agent.id, request), second);
});

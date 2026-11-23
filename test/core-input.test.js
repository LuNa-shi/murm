import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { ServiceRegistry } from '@swarmenv/core/services';
import { transport } from './fixtures/core-input-backend.js';

// Replace the external backend boundary, leaving the public Runtime and its
// state/receipt/event implementation intact. No production injection API.
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === './pi-opensandbox-backend.js' && context.parentURL?.endsWith('/src/core/index.js')) {
    return { url: new URL('./fixtures/core-input-backend.js', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
} });
const { createRuntime } = await import('@swarmenv/core');
hooks.deregister();

async function setup(t) {
  transport.reset();
  const outputDir = await mkdtemp(join(tmpdir(), 'core-input-'));
  const runtime = await createRuntime({ backend: {}, profiles: { worker: {
    prompt: 'fixed', model: 'default', image: 'test', writable: true, services: {},
  } }, services: new ServiceRegistry(), maxBots: 3, outputDir });
  t.after(async () => { await runtime.close(); await rm(outputDir, { recursive: true, force: true }); });
  const bot = await runtime.spawn({ profile: 'worker', requestId: 'spawn' });
  return { runtime, bot };
}

test('unknown input receipt can gain evidence without a second submission', async t => {
  const { runtime, bot } = await setup(t);
  const first = await runtime.send(bot.id, 'fixed', { requestId: 'one' });
  assert.equal(first.status, 'unknown');
  transport.confirm(first.inputId, 'started');
  const resolved = await runtime.send(bot.id, 'fixed', { requestId: 'one', mode: 'steer' });
  assert.deepEqual(resolved, { inputId: first.inputId, status: 'accepted', disposition: 'started' });
  assert.equal(transport.submissions.size, 1);
  await assert.rejects(runtime.send(bot.id, 'different', { requestId: 'one' }), { code: 'CONFLICT' });
});

test('concurrent inputs preserve scope, default mode and pre-receipt settled snapshots', async t => {
  const { runtime, bot } = await setup(t);
  const second = await runtime.spawn({ profile: 'worker', requestId: 'spawn-two' });
  const observed = [];
  runtime.onEvent(() => { throw new Error('subscriber failure'); });
  runtime.onEvent(event => { observed.push({ event, snapshot: runtime.get(event.botId) }); });
  let release;
  transport.next = async id => {
    transport.listeners.get(bot.id)({ type: 'settled', outcome: 'completed', output: 'round one' });
    await new Promise(resolve => { release = resolve; });
    transport.confirm(id, 'started');
  };
  const first = runtime.send(bot.id, 'fixed', { requestId: 'same' });
  const repeated = runtime.send(bot.id, 'fixed', { requestId: 'same', mode: 'steer' });
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
  transport.listeners.get(bot.id)({ type: 'settled', outcome: 'aborted', error: { code: 'ABORTED', message: 'aborted', retryable: false } });
  const final = await runtime.get(bot.id);
  assert.equal(final.latestOutput, undefined);
  assert.equal(final.lastError.code, 'ABORTED');
  assert.equal(final.cursor, 2);
});

test('host send wait is bounded while its original submission stays in flight', async t => {
  const { runtime, bot } = await setup(t);
  let release;
  transport.next = id => new Promise(resolve => { release = () => { transport.confirm(id, 'started'); resolve(); }; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = runtime.send(bot.id, 'fixed', { requestId: 'bounded' });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(60_000);
  const first = await pending;
  assert.equal(first.status, 'unknown');
  const repeated = runtime.send(bot.id, 'fixed', { requestId: 'bounded' });
  release();
  const confirmed = await repeated;
  assert.equal(confirmed.status, 'accepted');
  assert.equal(confirmed.inputId, first.inputId);
  assert.equal(transport.submissions.size, 1);
  t.mock.timers.reset();
});

test('handled receipts do not imply execution and fresh sends reject exited and closed Bots', async t => {
  const { runtime, bot } = await setup(t);
  transport.next = async id => transport.confirm(id, 'handled');
  const receipt = await runtime.send(bot.id, '/local-command', { requestId: 'handled' });
  assert.equal(receipt.disposition, 'handled');
  assert.equal((await runtime.get(bot.id)).status, 'idle');
  transport.listeners.get(bot.id)({ type: 'error', fatal: true, error: { code: 'PROCESS_EXITED', message: 'fatal', retryable: false } });
  transport.listeners.get(bot.id)({ type: 'exit', reason: 'unexpected', expected: false });
  assert.equal((await runtime.get(bot.id)).status, 'exited');
  await assert.rejects(runtime.send(bot.id, 'new', { requestId: 'exited' }), { code: 'NOT_ALLOWED' });
  await runtime.stop(bot.id);
  await assert.rejects(runtime.send(bot.id, 'new', { requestId: 'closed' }), { code: 'NOT_ALLOWED' });
});

test('handled local output restores idle without erasing its output snapshot', async t => {
  const { runtime, bot } = await setup(t);
  transport.next = async id => {
    transport.listeners.get(bot.id)({ type: 'output', text: 'Local command handled' });
    transport.confirm(id, 'handled');
  };
  const receipt = await runtime.send(bot.id, '/local-command', { requestId: 'local-output' });
  assert.equal(receipt.disposition, 'handled');
  const snapshot = await runtime.get(bot.id);
  assert.equal(snapshot.status, 'idle');
  assert.equal(snapshot.latestOutput, 'Local command handled');
  assert.equal(snapshot.cursor, 1);
});

test('handled receipt preserves existing execution and newer input activity', async t => {
  const { runtime, bot } = await setup(t);
  let release;
  transport.next = id => new Promise(resolve => { release = () => { transport.confirm(id, 'handled'); resolve(); }; });
  const earlier = runtime.send(bot.id, '/local-command', { requestId: 'earlier-handled' });
  await new Promise(resolve => setImmediate(resolve));
  transport.next = async id => transport.confirm(id, 'started');
  await runtime.send(bot.id, 'new work', { requestId: 'newer-execution' });
  release();
  assert.equal((await earlier).disposition, 'handled');
  assert.equal((await runtime.get(bot.id)).status, 'running');
  transport.next = async id => {
    transport.listeners.get(bot.id)({ type: 'output', text: 'Handled while busy' });
    transport.confirm(id, 'handled');
  };
  assert.equal((await runtime.send(bot.id, '/local-command', { requestId: 'handled-while-busy' })).disposition, 'handled');
  assert.equal((await runtime.get(bot.id)).status, 'running');
});

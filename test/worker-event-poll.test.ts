import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as drain } from 'node:timers/promises';
import { createWorkerEventPoll } from '../src/core/worker-event-poll.js';

test('quiet reads back off, fresh work wakes immediately, and active reads stay fast', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const poll = createWorkerEventPoll();
  t.after(() => poll.stop());
  const reads: number[] = [];
  let quiet = true;
  let time = 0;
  const advance = async (ms: number) => {
    time += ms;
    t.mock.timers.tick(ms);
    await drain();
  };
  const work = poll.run(async () => { reads.push(time); return quiet; });
  await drain();
  await advance(200);
  await advance(400);
  await advance(800);
  await advance(999);
  assert.deepEqual(reads, [0, 200, 600, 1400]);
  await advance(1);
  assert.equal(reads.at(-1), 2400);

  quiet = false;
  poll.wake();
  await drain();
  assert.equal(reads.filter(value => value === 2400).length, 2);
  await advance(100);
  assert.equal(reads.at(-1), 2500);
  poll.stop();
  await work;
  await advance(1000);
  assert.equal(reads.at(-1), 2500);
});

test('wake during a pending read requests another read once, and stopping aborts its transport', async () => {
  const poll = createWorkerEventPoll();
  let reads = 0;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let sawAbort = false;
  const work = poll.run(async signal => {
    if (++reads === 1) await pending;
    else await new Promise<void>(resolve => signal.addEventListener('abort', () => { sawAbort = true; resolve(); }, { once: true }));
    return true;
  });
  poll.wake();
  poll.wake();
  assert.equal(reads, 1);
  release();
  await drain();
  assert.equal(reads, 2);
  poll.stop();
  await work;
  assert.equal(sawAbort, true);
  assert.equal(reads, 2);
});

test('a bounded Worker history request times out at the transport and is abortable by its owner', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { createOpenSandboxManager } = await import('../src/runtime/opensandbox-manager.js');
  let active = 0;
  const manager = createOpenSandboxManager({
    lifecycleBaseUrl: 'http://127.0.0.1:8080/v1',
    image: 'probe-image',
    fetchImpl: (_url, { signal }) => new Promise((_, reject) => {
      active++;
      signal.addEventListener('abort', () => {
        active--;
        reject(signal.reason);
      }, { once: true });
    }),
  });
  manager.executions.set('agent', { agent: { endpoint: 'http://127.0.0.1:8090', token: 'probe' } });
  const read = (signal?: AbortSignal) => manager.agentRpc('agent', { type: 'get_state', since: 3 }, {
    timeoutMs: 2000, transportTimeoutMs: 2000, signal,
  });
  const timeout = assert.rejects(read(), { code: 'SERVICE_TIMEOUT' });
  t.mock.timers.tick(1999);
  assert.equal(active, 1);
  t.mock.timers.tick(1);
  await timeout;
  assert.equal(active, 0);

  const owner = new AbortController();
  const stopped = assert.rejects(read(owner.signal), { code: 'SERVICE_UNAVAILABLE' });
  owner.abort();
  await stopped;
  assert.equal(active, 0);
});

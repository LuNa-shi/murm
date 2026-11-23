import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeadline, createWorkGate } from './fixtures/agensh-deadline.js';
import { createLocalAgenshStack } from './fixtures/agensh-local-stack.js';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('setup caps each Docker allocation and retains an uncertain network for cleanup after expiry', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agensh-deadline-')); t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const stack = await createLocalAgenshStack({ directory: join(root, 'data'), setupMs: 100,
    executeCommand: async (_command, args, options) => {
      calls.push({ args, timeout: options.timeout });
      if (args[0] === 'network' && args[1] === 'create') { await delay(120); return { stdout: 'uncertain-network' }; }
      if (args[0] === 'network' && args[1] === 'ls') return { stdout: 'owned-network' };
      return { stdout: '' };
    } });
  await assert.rejects(stack.start(), { code: 'LOCAL_FACILITY_SETUP_EXPIRED' });
  const setupCalls = [...calls];
  assert.equal(setupCalls.at(-1).args[1], 'create');
  assert.ok(setupCalls.every(call => call.timeout > 0 && call.timeout <= 100));
  assert.equal(setupCalls.some(call => call.args[0] === 'run'), false);
  assert.equal((await stack.close()).cleanup, 'complete');
  assert.ok(calls.some(call => call.args[0] === 'network' && call.args[1] === 'rm' && call.args[2] === 'owned-network'));
});

test('setup signal aborts a pending HTTP operation and prohibits the next allocation', async () => {
  const setup = createDeadline(15, 'SETUP_EXPIRED');
  try {
    await assert.rejects(setup.step(({ signal, timeoutMs }) => {
      assert.ok(timeoutMs <= 15);
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }), { code: 'SETUP_EXPIRED' });
    let dispatched = false;
    await assert.rejects(setup.step(() => { dispatched = true; }), { code: 'SETUP_EXPIRED' });
    assert.equal(dispatched, false);
  } finally { setup.dispose(); }
});

test('a late Environment is adopted only for cleanup and dispatches zero input', async () => {
  const work = createWorkGate(10); let closed = 0; let inputs = 0;
  try {
    await assert.rejects(work.create(async () => { await delay(25); return {
      close: async () => { closed++; }, runInput: async () => { inputs++; },
    }; }), { code: 'ACTUAL_PEER_WORK_EXPIRED' });
    assert.ok(work.environment()); assert.equal(closed, 1);
    assert.throws(() => work.runInput('fixed', { timeoutMs: 100 }), { code: 'ACTUAL_PEER_WORK_EXPIRED' });
    assert.equal(inputs, 0); assert.equal(work.expired(), true);
  } finally { work.dispose(); }
});

test('both turns check remaining time and pending input receives abort on first fixture failure', async () => {
  const work = createWorkGate(100); let inputSignal; let inputs = 0; let closed = 0;
  try {
    await work.create(async () => ({ close: async () => { closed++; }, runInput: async (_input, options) => {
      inputs++; inputSignal = options.signal; assert.ok(options.timeoutMs <= 100);
      return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    } }));
    const first = work.runInput('fixed-first', { timeoutMs: 75_000 });
    work.abort();
    await assert.rejects(first, { code: 'ACTUAL_PEER_WORK_EXPIRED' });
    assert.equal(inputSignal.aborted, true); assert.equal(closed, 1);
    assert.throws(() => work.runInput('fixed-second', { timeoutMs: 30_000 }), { code: 'ACTUAL_PEER_WORK_EXPIRED' });
    assert.equal(inputs, 1);
  } finally { work.dispose(); }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeadline, createWorkGate, createCleanupBudget } from './fixtures/agensh-deadline.js';
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
    assert.equal(work.ownership().state, 'pending');
    const creation = await work.awaitCreation();
    assert.equal(creation.state, 'owned'); assert.equal(closed, 0);
    await work.cleanup.step(({ timeoutMs }) => creation.environment.close({ timeoutMs }));
    assert.equal(closed, 1);
    assert.throws(() => work.runInput('fixed', { timeoutMs: 100 }), { code: 'ACTUAL_PEER_WORK_EXPIRED' });
    assert.equal(inputs, 0); assert.equal(work.expired(), true);
  } finally { work.dispose(); work.cleanup.dispose(); }
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
    assert.equal(inputSignal.aborted, true); assert.equal(closed, 0);
    await work.cleanup.step(({ timeoutMs }) => work.environment().close({ timeoutMs }));
    assert.equal(closed, 1);
    assert.throws(() => work.runInput('fixed-second', { timeoutMs: 30_000 }), { code: 'ACTUAL_PEER_WORK_EXPIRED' });
    assert.equal(inputs, 1);
  } finally { work.dispose(); work.cleanup.dispose(); }
});

test('pending factory owns dependencies after the shared cleanup deadline; late resolution dispatches no cleanup', async () => {
  const cleanup = createCleanupBudget(35), work = createWorkGate(10, 'WORK_EXPIRED', cleanup);
  const late = Promise.withResolvers(); let closed = 0;
  const started = Date.now();
  try {
    await assert.rejects(work.create(() => late.promise), { code: 'WORK_EXPIRED' });
    assert.equal(work.ownership().state, 'pending');
    // Entering cleanup later must not restart the budget from this point.
    await delay(15);
    const creation = await work.awaitCreation();
    assert.equal(creation.state, 'pending');
    assert.ok(Date.now() - started < 90, 'Host wait is bounded by work10 + cleanup35, with scheduling tolerance');
    assert.equal(cleanup.receipt().deadlineAt, work.deadlineAt + 35);
    let dispatched = false;
    await assert.rejects(cleanup.step(() => { dispatched = true; }), { code: 'ACTUAL_PEER_CLEANUP_EXPIRED' });
    assert.equal(dispatched, false);
    late.resolve({ close: async () => { closed++; } }); await delay(1);
    assert.equal(work.ownership().state, 'owned'); assert.equal(closed, 0);
  } finally { work.dispose(); cleanup.dispose(); }
});

test('late factory failure and following teardown consume one budget rather than adding fresh waits', async () => {
  const cleanup = createCleanupBudget(50), work = createWorkGate(10, 'WORK_EXPIRED', cleanup);
  const started = Date.now(); let facilityFinished = false;
  try {
    await assert.rejects(work.create(async () => { await delay(30); throw Object.assign(new Error('safe'), { cleanup: 'complete' }); }), { code: 'WORK_EXPIRED' });
    const creation = await work.awaitCreation();
    assert.equal(creation.state, 'failed'); assert.equal(creation.error.cleanup, 'complete');
    await assert.rejects(cleanup.step(async ({ timeoutMs, signal }) => {
      assert.ok(timeoutMs < 40);
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      facilityFinished = true;
    }), { code: 'ACTUAL_PEER_CLEANUP_EXPIRED' });
    assert.equal(facilityFinished, false);
    assert.ok(Date.now() - started < 100, 'Factory wait and teardown share work10 + cleanup50');
  } finally { work.dispose(); cleanup.dispose(); }
});

test('success finalization freezes the work observation and does not restart cleanup', async () => {
  const cleanup = createCleanupBudget(20), work = createWorkGate(10, 'WORK_EXPIRED', cleanup);
  try {
    await work.create(async () => ({})); work.finish(); const end = cleanup.receipt().deadlineAt;
    await delay(15); work.finish();
    assert.equal(work.expired(), false); assert.equal(cleanup.receipt().deadlineAt, end);
  } finally { work.dispose(); cleanup.dispose(); }
});

test('facility cleanup Docker steps use remaining absolute time and dispatch nothing after it expires', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agensh-cleanup-')); t.after(() => rm(root, { recursive: true, force: true }));
  let closing = false; const cleanupCalls = [];
  const stack = await createLocalAgenshStack({ directory: join(root, 'data'), setupMs: 100,
    executeCommand: async (_command, args, options) => {
      if (closing) {
        cleanupCalls.push({ args, timeout: options.timeout });
        // Deliberately ignore cancellation, like an unavailable CLI. No later
        // network remove or inspection can start after the host budget expires.
        await delay(35); return { stdout: 'owned-network' };
      }
      if (args[0] === 'network' && args[1] === 'create') throw new Error('uncertain create');
      return { stdout: '' };
    } });
  await assert.rejects(stack.start()); closing = true;
  const cleanup = createCleanupBudget(15).start();
  try {
    const started = Date.now(); const receipt = await stack.close(cleanup);
    assert.equal(receipt.cleanup, 'pending'); assert.equal(receipt.networkCleanup, 'pending');
    assert.equal(cleanupCalls.length, 1); assert.equal(cleanupCalls[0].args[1], 'ls');
    assert.ok(cleanupCalls[0].timeout <= 15); assert.ok(Date.now() - started < 65);
    await delay(40); assert.equal(cleanupCalls.length, 1);
  } finally { cleanup.dispose(); }
});

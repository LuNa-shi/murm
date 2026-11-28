import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorkerControl } from '../src/core/worker-control.js';

const request = { requestId: 'takeover-1', workerInstanceId: 'worker', expectedEpoch: 0, nextEpoch: 1 };

test('takeover persists the fence and receipt together and replays the same request', async () => {
  const states: unknown[] = [];
  const control = createWorkerControl({ workerInstanceId: 'worker', persist: async state => { states.push(structuredClone(state)); } });
  const first = await control.takeover(request);
  assert.equal(control.controllerEpoch, 1);
  assert.deepEqual(await control.takeover(request), first);
  assert.equal(states.length, 1);
  assert.deepEqual(states[0], { workerInstanceId: 'worker', controllerEpoch: 1, receipts: [first] });
  assert.throws(() => control.assertEpoch(0), { code: 'NOT_ALLOWED' });
  assert.equal(await control.run(1, async () => 'accepted'), 'accepted');
  await assert.rejects(control.takeover({ ...request, nextEpoch: 2, expectedEpoch: 1 }), { code: 'CONFLICT' });
});

test('lost takeover response can be replayed after a subsequent epoch advance', async () => {
  const control = createWorkerControl({ workerInstanceId: 'worker' });
  const original = await control.takeover(request);
  await control.takeover({ ...request, requestId: 'takeover-2', expectedEpoch: 1, nextEpoch: 2 });
  assert.deepEqual(await control.takeover(request), original);
  assert.equal(control.controllerEpoch, 2);
  assert.throws(() => control.assertEpoch(original.controllerEpoch), { code: 'NOT_ALLOWED' });
});

test('takeover waits for admitted mutation completion and refuses old commands while draining', async () => {
  const control = createWorkerControl({ workerInstanceId: 'worker' });
  const gate = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const active = control.run(0, async () => { started.resolve(); await gate.promise; return 'complete'; });
  await started.promise;
  const takeover = control.takeover(request);
  await Promise.resolve();
  assert.throws(() => control.assertEpoch(0), { code: 'NOT_ALLOWED' });
  assert.equal(control.controllerEpoch, 0);
  gate.resolve();
  assert.equal(await active, 'complete');
  assert.equal((await takeover).controllerEpoch, 1);
});

test('a failed durable write preserves the old epoch and permits an exact retry', async () => {
  let fail = true;
  const control = createWorkerControl({ workerInstanceId: 'worker', persist: async () => { if (fail) throw new Error('disk full'); } });
  await assert.rejects(control.takeover(request), /disk full/);
  assert.equal(control.controllerEpoch, 0);
  assert.throws(() => control.assertEpoch(0), { code: 'NOT_ALLOWED' });
  fail = false;
  assert.equal((await control.takeover(request)).controllerEpoch, 1);
});

test('a stalled mutation bounds takeover and retains the existing controller epoch', async () => {
  const gate = Promise.withResolvers<void>();
  const control = createWorkerControl({ workerInstanceId: 'worker', drainTimeoutMs: 5 });
  const active = control.run(0, () => gate.promise);
  await assert.rejects(control.takeover(request), { code: 'SERVICE_UNAVAILABLE' });
  assert.equal(control.controllerEpoch, 0);
  gate.resolve();
  await active;
  assert.equal((await control.takeover(request)).controllerEpoch, 1);
});

test('takeover validates Worker instance and monotonically increasing epochs', async () => {
  const control = createWorkerControl({ workerInstanceId: 'worker' });
  for (const override of [{ workerInstanceId: 'replacement' }, { expectedEpoch: -1 }, { nextEpoch: 0 }, { requestId: '' }]) {
    await assert.rejects(control.takeover({ ...request, ...override }), { code: 'INVALID_CONTRACT' });
  }
  const results = await Promise.allSettled([control.takeover(request), control.takeover({ ...request, requestId: 'conflicting' })]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
});

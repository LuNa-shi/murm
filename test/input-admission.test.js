import assert from 'node:assert/strict';
import test from 'node:test';
import { createInputAdmission } from '../src/environments/shared/input-admission.js';

test('permits bound actual inputs and are released before later peer lifecycle waits', async () => {
  const controller = new AbortController(), admission = createInputAdmission({ maxConcurrent: 2, maxPending: 6, signal: controller.signal });
  const held = Array.from({length: 6}, () => Promise.withResolvers());
  let active = 0, peak = 0; const started = [];
  const work = held.map((row, index) => admission.run(async () => { started.push(index); active++; peak = Math.max(peak, active); await row.promise; active--; }));
  await new Promise(setImmediate); assert.deepEqual(started, [0, 1]);
  held[0].resolve(); await new Promise(setImmediate); assert.deepEqual(started, [0, 1, 2]);
  for (const row of held) row.resolve(); await Promise.all(work);
  assert.equal(peak, 2); assert.equal(admission.snapshot().active, 0); admission.close();
});
test('unknown work fences queued inputs before releasing, and cancellation never dispatches a waiter', async () => {
  const controller = new AbortController(), admission = createInputAdmission({ maxConcurrent: 1, maxPending: 4, signal: controller.signal });
  const held = Promise.withResolvers(); let later = 0;
  const first = admission.run(async () => { await held.promise; throw Object.assign(new Error('unknown'), {code:'input_unknown'}); });
  const second = admission.run(() => { later++; });
  const results = Promise.allSettled([first, second]); held.resolve();
  assert.ok((await results).every(row => row.status === 'rejected')); assert.equal(later, 0);
  const next = createInputAdmission({ maxConcurrent: 1, maxPending: 4, signal: controller.signal });
  const release = Promise.withResolvers(), running = next.run(() => release.promise);
  await new Promise(setImmediate);
  const cancelled = next.run(() => { later++; }); const failure = assert.rejects(cancelled, {code:'INPUT_ADMISSION_ABORTED'});
  controller.abort(); release.resolve(); await Promise.all([running, failure]); assert.equal(later, 0);
});

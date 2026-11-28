import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { finishCleanup } from '../benchmarks/kubernetes/cleanup.js';

const deleting = { cleanup: 'pending', errors: [{ retryable: true }] } as const;
const complete = { cleanup: 'complete', errors: [] } as const;

test('benchmark cleanup retries an accepted asynchronous deletion within the original budget', async () => {
  const timeouts: number[] = [];
  const receipt = await finishCleanup(async timeout => {
    timeouts.push(timeout);
    return timeouts.length === 1 ? deleting : complete;
  }, performance.now() + 2_000);
  assert.equal(receipt, complete);
  assert.equal(timeouts.length, 2);
  assert.ok(timeouts[1] > 0 && timeouts[1] < timeouts[0]);
});

test('benchmark cleanup preserves pending evidence after the deadline', async () => {
  let attempts = 0;
  const receipt = await finishCleanup(async () => {
    attempts++;
    return deleting;
  }, performance.now() - 1);
  assert.equal(receipt, deleting);
  assert.equal(attempts, 1);
});

test('benchmark cleanup preserves a nonretryable export failure', async () => {
  const exportFailed = { cleanup: 'pending', errors: [{ retryable: false }] } as const;
  let attempts = 0;
  const receipt = await finishCleanup(async () => {
    attempts++;
    return exportFailed;
  }, performance.now() + 2_000);
  assert.equal(receipt, exportFailed);
  assert.equal(attempts, 1);
});

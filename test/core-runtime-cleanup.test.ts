import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanupRuntimes } from './fixtures/core-runtime-cleanup.js';

test('acceptance cleanup attempts every Runtime concurrently and retains redacted failures and prior evidence', async () => {
  const entered = [];
  let release;
  const both = new Promise(resolve => { release = resolve; });
  const runtimes = ['first', 'second'].map(id => ({ id, async close() {
    entered.push(id);
    if (entered.length === 2) release();
    await both;
    if (id === 'first') throw new Error('private failure payload');
    return { cleanup: 'complete', bots: [] };
  } }));
  const resources = { first: { beforeSpawnCount: 0, afterSpawnCount: 2 } };
  const receipts = await cleanupRuntimes(runtimes, { resources, inspect: async id => {
    if (id === 'first') throw new Error('private inspection payload');
    return [];
  }, timeoutMs: 100 });
  assert.deepEqual(entered, ['first', 'second']);
  assert.deepEqual(receipts, [{ runtimeId: 'first', cleanup: 'pending', bots: [], error: 'CLOSE_FAILED' },
    { runtimeId: 'second', cleanup: 'complete', bots: [] }]);
  assert.deepEqual(resources.first, { beforeSpawnCount: 0, afterSpawnCount: 2, empty: false, error: 'RESOURCE_INSPECTION_FAILED' });
  assert.equal(resources.second.empty, true);
  assert.equal(JSON.stringify({ resources, receipts }).includes('private'), false);
});

test('acceptance cleanup bounds a hung Runtime without delaying the others indefinitely', async () => {
  const resources = {};
  const receipts = await cleanupRuntimes([{ id: 'hung', close: () => new Promise(() => {}) },
    { id: 'healthy', close: async () => ({ cleanup: 'complete', bots: [] }) }],
  { resources, inspect: async () => [], timeoutMs: 30 });
  assert.equal(receipts[0].error, 'CLOSE_FAILED');
  assert.equal(receipts[1].cleanup, 'complete');
  assert.equal(resources.healthy.empty, true);
});

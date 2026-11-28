import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOwnedResources } from '../src/harness/owned-resources.js';

test('owned cleanup gives every resource a bounded chance, preserves shared data and retries pending', async () => {
  const resources = createOwnedResources({ timeoutMs: 15 }); const attempts = []; let allow = false; let release;
  resources.own({ kind: 'repository', id: 'run-repo', retained: true });
  resources.own({ kind: 'account', id: 'peer', close: async () => { attempts.push('account'); if (!allow) throw new Error('secret must not enter receipt'); } });
  resources.own({ kind: 'process', id: 'board', close: () => new Promise(resolve => { release = resolve; }) });
  const first = await resources.close();
  assert.equal(first.cleanup, 'pending'); assert.equal(first.pending.length, 2);
  assert.equal(JSON.stringify(first).includes('secret'), false);
  assert.equal(resources.snapshot().find(row => row.id === 'run-repo').state, 'retained');
  allow = true; release();
  assert.equal((await resources.close()).cleanup, 'complete');
  assert.deepEqual(attempts, ['account', 'account']);
});

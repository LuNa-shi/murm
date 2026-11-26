import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSubstrateService } from '../src/harnesses/substrate/substrate.js';

async function fixture(t, runId = 'fixed') {
  const directory = await mkdtemp(join(tmpdir(), 'substrate-'));
  const service = createSubstrateService({ databasePath: join(directory, 'content.sqlite'), runId });
  service.bindRuntime('runtime-one'); service.bindPeer('peer-a'); service.bindPeer('peer-b');
  t.after(() => { service.close(); return rm(directory, { recursive: true, force: true }); });
  const call = (operation, input, id = 'request', agentId = 'peer-a', runtimeId = 'runtime-one') => service.adapter.invoke({
    capability: { operation }, input, caller: { runtimeId, agentId, profile: 'peer' }, envelope: { operation_id: id }, signal: new AbortController().signal,
  });
  return { service, call, directory };
}

test('substrate publishes immutable original bytes and references atomically under trusted author and stable request identity', async t => {
  const { service, call } = await fixture(t);
  const original = await call('publish', { content: 'Fixed λ finding\n', references: [] }, 'first');
  assert.equal(original.author, 'peer-a'); assert.equal(original.version, 1);
  assert.deepEqual(await call('publish', { content: 'Fixed λ finding\n', references: [] }, 'first'), original);
  await assert.rejects(call('publish', { content: 'different', references: [] }, 'first'), { code: 'CONFLICT' });
  await assert.rejects(call('publish', { content: 'bad', references: ['unknown'] }, 'bad'), { code: 'NOT_FOUND' });
  const successor = await call('publish', { content: 'Adopted: Fixed λ finding\n', references: [original.address] }, 'second', 'peer-b');
  assert.notEqual(successor.address, original.address);
  assert.deepEqual(await call('visit', { address: original.address }, 'read', 'peer-b'), original);
  assert.deepEqual(successor.references, [original.address]);
  assert.equal(service.snapshot().contents.length, 2);
});

test('search enforces its limit and ranks text first, citations second, and stable address last', async t => {
  const { call, service } = await fixture(t);
  const a = await call('publish', { content: 'algebra', references: [] }, 'a');
  const b = await call('publish', { content: 'algebra', references: [] }, 'b');
  const c = await call('publish', { content: 'algebra algebra', references: [] }, 'c');
  await call('publish', { content: 'adoption', references: [b.address] }, 'adoption', 'peer-b');
  const result = await call('search', { query: 'Algebra', limit: 2 }, 'search', 'peer-b');
  assert.deepEqual(result.results.map(row => row.address), [c.address, b.address]);
  assert.deepEqual(result.results.map(row => [row.rank.textOccurrences, row.rank.incomingReferences]), [[2, 0], [1, 1]]);
  assert.equal(result.limit, 2); assert.equal(result.results[0].summary, 'algebra algebra');
  await assert.rejects(call('search', { query: 'algebra', limit: 9 }), { code: 'INVALID_CONTRACT' });
  assert.equal((await call('search', { query: 'unknown', limit: 8 })).results.length, 0);
  const tied = await call('publish', { content: 'algebra', references: [] }, 'tie');
  const sorted = (await call('search', { query: 'algebra', limit: 8 })).results.map(row => row.address);
  assert.deepEqual(sorted.slice(2), [a.address, tied.address].sort());
  assert.equal(service.snapshot().reads.filter(row => row.operation === 'search').length, 3);
});

test('durable publications survive close; another run cannot visit or reference them and identity is never supplied by input', async t => {
  const { service, call, directory } = await fixture(t);
  const first = await call('publish', { content: 'persistent proof', references: [] }, 'persist');
  await assert.rejects(call('publish', { content: 'forged', author: 'peer-b' }, 'forge'), { code: 'INVALID_CONTRACT' });
  await assert.rejects(call('visit', { address: first.address }, 'wrong', 'peer-a', 'other-runtime'), { code: 'NOT_ALLOWED' });
  await assert.rejects(call('visit', { address: first.address }, 'wrong', 'stranger'), { code: 'NOT_ALLOWED' });
  await assert.rejects(call('search', { limit: 1 }), { code: 'INVALID_CONTRACT' });
  service.close();
  const reopened = createSubstrateService({ databasePath: join(directory, 'content.sqlite'), runId: 'fixed' });
  t.after(() => reopened.close()); reopened.bindRuntime('runtime-one'); reopened.bindPeer('peer-a');
  assert.deepEqual(reopened.snapshot().contents, [first]);
  const other = createSubstrateService({ databasePath: join(directory, 'content.sqlite'), runId: 'other-run' });
  t.after(() => other.close()); other.bindRuntime('other-runtime'); other.bindPeer('peer-a');
  const invoke = (operation, input) => other.adapter.invoke({ capability: { operation }, input, caller: { runtimeId: 'other-runtime', agentId: 'peer-a', profile: 'peer' }, envelope: { operation_id: 'other' } });
  await assert.rejects(invoke('visit', { address: first.address }), { code: 'NOT_FOUND' });
  await assert.rejects(invoke('publish', { content: 'bad cross-run citation', references: [first.address] }), { code: 'NOT_FOUND' });
  assert.equal(other.snapshot().contents.length, 0);
});

test('publication rejects malformed Unicode instead of silently changing original text on persistence', async t => {
  const { call, service } = await fixture(t);
  await assert.rejects(call('publish', { content: 'broken \ud800', references: [] }, 'bad-text'), { code: 'INVALID_CONTRACT' });
  assert.equal(service.snapshot().contents.length, 0);
});

test('failed reference validation retains request identity without committing a partial body or relation', async t => {
  const { call, service } = await fixture(t);
  await assert.rejects(call('publish', { content: 'orphan', references: ['not-visible'] }, 'failed-request'), { code: 'NOT_FOUND' });
  await assert.rejects(call('publish', { content: 'replacement', references: [] }, 'failed-request'), { code: 'CONFLICT' });
  await assert.rejects(call('publish', { content: 'orphan', references: ['not-visible'] }, 'failed-request'), { code: 'NOT_FOUND' });
  assert.equal(service.snapshot().contents.length, 0);
});

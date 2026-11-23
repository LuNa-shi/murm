import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSubstrateService } from '../src/environments/scalemas/substrate.js';

async function fixture(t, runId = 'fixed') {
  const directory = await mkdtemp(join(tmpdir(), 'substrate-'));
  const service = createSubstrateService({ databasePath: join(directory, 'content.sqlite'), runId });
  service.bindRuntime('runtime-one'); service.bindPeer('peer-a'); service.bindPeer('peer-b');
  t.after(() => { service.close(); return rm(directory, { recursive: true, force: true }); });
  const call = (operation, input, id = 'request', botId = 'peer-a', runtimeId = 'runtime-one') => service.adapter.invoke({
    capability: { operation }, input, caller: { runtimeId, botId, profile: 'peer' }, envelope: { operation_id: id }, signal: new AbortController().signal,
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

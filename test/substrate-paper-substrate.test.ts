import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { invokeService, ServiceRegistry, snapshotServiceRegistry } from '@murm/core/services';
import { createPaperSubstrate } from '../src/harnesses/substrate/paper-substrate.js';

async function fixture(t, mode = 'shared') {
  const dir = await mkdtemp(join(tmpdir(), 'paper-substrate-'));
  const retired = new Set();
  const services = new ServiceRegistry();
  const store = createPaperSubstrate({
    databasePath: join(dir, 'content.sqlite'), runId: 'paper-run', mode, services,
    authorize(caller) {
      if (caller.runtimeId !== 'runtime' || !['a', 'b'].includes(caller.agentId) || retired.has(caller.agentId)) {
        throw Object.assign(new Error('Closed caller'), { code: 'NOT_ALLOWED' });
      }
    },
    resourceExists: (_agentId, address) => address === 'fate:1',
  });
  store.bindRuntime('runtime');
  t.after(() => { store.close(); return rm(dir, { recursive: true, force: true }); });
  const registration = snapshotServiceRegistry(services).get('substrate');
  const call = (operation, input, id, agentId = 'a', runtimeId = 'runtime') => invokeService(registration,
    { operation, input, envelope: { operation_id: id }, caller: { agentId, runtimeId, profile: 'peer' } });
  const publish = (artifact, id, agentId = 'a', refs = []) => call('publish', {
    sub_task: 'Explore', artifact, rationale: refs.length ? refs.map(ref => `${ref} contributes the proof idea.`).join('\n') : 'Derived directly.', refs,
  }, id, agentId);
  return { store, retired, call, publish };
}

test('an anonymous citation can overtake a better lexical result and survives the author retiring', async t => {
  const { store, retired, call, publish } = await fixture(t);
  const low = await publish('algebra algebra lemma', 'low');
  const high = await publish('algebra algebra algebra', 'high');
  const query = { query: 'algebra', limit: 8 };
  const search = async id => (await call('search', query, id, 'b')).results;
  assert.deepEqual((await search('first')).map(row => row.address), [high.address, low.address]);

  const citing = await publish('Refinement', 'cite', 'b', [low.address, 'fate:1']);
  assert.deepEqual(await publish('Refinement', 'cite', 'b', [low.address, 'fate:1']), citing);
  retired.add('a');
  const visited = (await call('visit', { addresses: [low.address, citing.address] }, 'visit', 'b')).results;
  assert.equal(visited[0].artifact, 'algebra algebra lemma');
  assert.deepEqual(visited[0].incoming_refs, [citing.address]);
  assert.deepEqual(visited[1].refs, [low.address, 'fate:1']);
  assert.equal('author' in visited[0], false);
  assert.equal('citation_weight' in visited[0], false);
  assert.deepEqual((await search('after')).map(row => row.address), [low.address, high.address]);
  assert.deepEqual((await search('first')).map(row => row.address), [high.address, low.address]);
  const snapshot = store.snapshot();
  assert.equal(snapshot.contents.find(row => row.address === low.address).author, 'a');
  assert.equal(snapshot.contents.length, 3);
  assert.equal(snapshot.ticks[0].tick, 6);
});

test('private peers have independent query results, clocks, citations and address visibility', async t => {
  const { store, call, publish } = await fixture(t, 'private');
  const first = await publish('algebra', 'first', 'a');
  const before = await call('search', { query: 'algebra', limit: 8 }, 'before', 'a');
  await publish('algebra algebra', 'secret', 'b');
  await assert.rejects(call('visit', { addresses: [first.address] }, 'visit', 'b'), { code: 'NOT_FOUND' });
  await assert.rejects(publish('copied', 'cite', 'b', [first.address]), { code: 'NOT_FOUND' });
  await assert.rejects(call('visit', { addresses: [first.address] }, 'visit', 'a', 'other'), { code: 'NOT_ALLOWED' });
  assert.deepEqual(await call('search', { query: 'algebra', limit: 8 }, 'after', 'a'), before);
  assert.deepEqual(store.snapshot().ticks.map(row => [row.scope, row.tick]), [['a', 3], ['b', 3]]);
});

test('public content and read receipts remain bounded and preserve their original Runtime identity after reopen', async t => {
  const { store, call, publish } = await fixture(t);
  const source = await publish('original exact λ\n', 'source');
  const citations = [];
  for (let i = 0; i < 9; i++) citations.push(await publish(`consequence ${i}`, `cite-${i}`, 'b', [source.address]));
  const visited = await call('visit', { addresses: [source.address, ...citations.slice(0, 7).map(row => row.address)] }, 'bounded', 'b');
  assert.equal(visited.results.length, 8);
  assert.deepEqual(visited.results[0].incoming_refs, citations.slice(-8).reverse().map(row => row.address));
  await assert.rejects(call('visit', { addresses: citations.map(row => row.address) }, 'over-limit', 'b'), { code: 'SERVICE_INPUT_INVALID' });
  await assert.rejects(call('search', { query: 'consequence', limit: 9 }, 'over-search', 'b'), { code: 'SERVICE_INPUT_INVALID' });
  assert.deepEqual(await call('search', { query: 'unmatched', limit: 8 }, 'unmatched', 'b'), { results: [] });

  await assert.rejects(call('publish', { sub_task: 'bad', artifact: 'bad', rationale: 'Missing citation explanation', refs: [source.address] }, 'bad-ref'), { code: 'INVALID_CONTRACT' });
  await assert.rejects(publish('different retry', 'bad-ref'), { code: 'CONFLICT' });
  await assert.rejects(publish(' word'.repeat(1024), 'oversized'), { code: 'INVALID_CONTRACT' });
  assert.equal(store.snapshot().contents.length, 10);

  const directory = await mkdtemp(join(tmpdir(), 'paper-reopen-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const open = runId => {
    const services = new ServiceRegistry();
    const persist = createPaperSubstrate({ databasePath: join(directory, 'shared.sqlite'), runId, mode: 'shared', services,
      authorize() {}, resourceExists: () => false });
    const registration = snapshotServiceRegistry(services).get('substrate');
    const call = (runtimeId, operation, input) => invokeService(registration, { operation, input, envelope: { operation_id: 'request' },
      caller: { runtimeId, agentId: 'a', profile: 'peer' } });
    return { persist, call };
  };
  const first = open('persistent');
  first.persist.bindRuntime('owner');
  const message = await first.call('owner', 'publish', { sub_task: 'Persistent content', artifact: source.artifact, rationale: 'Read only.', refs: [] });
  first.persist.close();
  const reopened = open('persistent');
  t.after(() => reopened.persist.close());
  assert.throws(() => reopened.persist.bindRuntime('other'), { code: 'CONFLICT' });
  reopened.persist.bindRuntime('owner');
  assert.equal(reopened.persist.snapshot().contents[0].artifact, message.artifact);
  const other = open('unrelated');
  t.after(() => other.persist.close());
  other.persist.bindRuntime('other');
  await assert.rejects(other.call('other', 'visit', { addresses: [message.address] }), { code: 'NOT_FOUND' });
});

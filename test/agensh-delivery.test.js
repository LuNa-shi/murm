import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createAgenshDelivery } from '../src/environments/agensh/delivery.js';

test('host merge admits only pinned own PR and repeats reuse one write receipt including unknown', async t => {
  let writes = 0; let merged = false;
  const server = createServer((request, response) => {
    request.resume(); response.setHeader('content-type', 'application/json');
    assert.equal(request.headers.authorization, 'token host-private');
    if (request.method === 'POST') { writes++; merged = true; return response.end('{}'); }
    response.end(JSON.stringify({ user: { id: 1 }, head: { ref: 'branch-a', sha: 'a'.repeat(40) }, base: { ref: 'main' }, merged, merge_commit_sha: 'b'.repeat(40) }));
  }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const delivery = createAgenshDelivery({ facilities: { endpoints: { gitea: `http://127.0.0.1:${server.address().port}` }, repository: { owner: 'owner', name: 'repo' }, peers: [{ key: 'a', branch: 'branch-a', gitea: { accountId: '1' } }] }, adminToken: 'host-private' });
  await assert.rejects(delivery.merge({ peerKey: 'a', number: 1, headSha: 'c'.repeat(40) }), { code: 'DELIVERY_INVALID' }); assert.equal(writes, 0);
  const input = { peerKey: 'a', number: 2, headSha: 'a'.repeat(40) };
  const result = await delivery.merge(input); assert.equal(result.mergeSha, 'b'.repeat(40)); assert.deepEqual(await delivery.merge(input), result); assert.equal(writes, 1);
  await assert.rejects(delivery.merge({ ...input, headSha: 'c'.repeat(40) }), { code: 'DELIVERY_CONFLICT' });
});

test('an unknown merge response is retained and an identical invocation cannot issue another merge', async t => {
  let writes = 0;
  const server = createServer((request, response) => {
    request.resume();
    if (request.method === 'POST') { writes++; return response.destroy(); }
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ user: { id: 1 }, head: { ref: 'a', sha: 'a'.repeat(40) }, base: { ref: 'main' }, merged: false }));
  }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const delivery = createAgenshDelivery({ facilities: { endpoints: { gitea: `http://127.0.0.1:${server.address().port}` }, repository: { owner: 'owner', name: 'repo' }, peers: [{ key: 'a', branch: 'a', gitea: { accountId: '1' } }] }, adminToken: 'host-private' });
  const input = { peerKey: 'a', number: 1, headSha: 'a'.repeat(40) };
  await assert.rejects(delivery.merge(input), { code: 'DELIVERY_MERGE_UNKNOWN' }); await assert.rejects(delivery.merge(input), { code: 'DELIVERY_MERGE_UNKNOWN' });
  assert.equal(writes, 1); assert.equal(delivery.snapshot()[0].state, 'unknown');
});

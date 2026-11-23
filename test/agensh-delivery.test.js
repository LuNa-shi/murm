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
  assert.equal(delivery.snapshot().find(row => row.number === 1).state, 'rejected');
  assert.equal(delivery.snapshot().find(row => row.number === 2).state, 'merged');
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

async function mainReader(t, { branch, content }) {
  const seen = [];
  const server = createServer((request, response) => {
    request.resume(); seen.push({ method: request.method, path: request.url, authorization: request.headers.authorization });
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/v1/repos/owner/repo/branches/main') return response.end(JSON.stringify(branch));
    if (request.url.startsWith('/api/v1/repos/owner/repo/contents/')) return response.end(JSON.stringify(content));
    response.writeHead(404); response.end('{}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { seen, delivery: createAgenshDelivery({ facilities: { endpoints: { gitea: `http://127.0.0.1:${server.address().port}` },
    repository: { owner: 'owner', name: 'repo' }, peers: [] }, adminToken: 'host-private' }) };
}

test('main file resolves the native branch DTO and fetches bytes only at that exact immutable commit', async t => {
  const sha = 'd'.repeat(40), data = Buffer.from('T15_RIGHT_ADOPTED\n');
  const f = await mainReader(t, { branch: { name: 'main', commit: { id: sha, message: 'Actual Gitea Branch DTO' }, protected: false },
    content: { type: 'file', path: 'nested/right.txt', encoding: 'base64', content: data.toString('base64'), size: data.length } });
  const result = await f.delivery.readMainFile('nested/right.txt');
  assert.equal(result.commit, sha); assert.equal(result.path, 'nested/right.txt'); assert.deepEqual(result.data, data);
  assert.deepEqual(f.seen, [
    { method: 'GET', path: '/api/v1/repos/owner/repo/branches/main', authorization: 'token host-private' },
    { method: 'GET', path: `/api/v1/repos/owner/repo/contents/nested/right.txt?ref=${sha}`, authorization: 'token host-private' },
  ]);
});

test('malformed or other branch identities cannot initiate any content request', async t => {
  for (const branch of [null, [], { name: 'other', commit: { id: 'd'.repeat(40) } }, { commit: { id: 'd'.repeat(40) } },
    { name: 'main', commit: { id: 'short' } }, { name: 'main', commit: { id: ['d'.repeat(40)] } }, { name: 'main', commit: { sha: 'd'.repeat(40) } },
    { object: { sha: 'd'.repeat(40) } }]) {
    const f = await mainReader(t, { branch, content: {} });
    await assert.rejects(f.delivery.readMainFile('right.txt'), { code: 'DELIVERY_INVALID' });
    assert.equal(f.seen.length, 1); assert.equal(f.seen[0].path, '/api/v1/repos/owner/repo/branches/main');
    assert.deepEqual(f.delivery.snapshot(), []);
  }
});

test('immutable content with a different path or invalid file metadata cannot pass main verification', async t => {
  const valid = { type: 'file', path: 'right.txt', encoding: 'base64', content: Buffer.from('x').toString('base64'), size: 1 };
  for (const changes of [{ path: 'other.txt' }, { type: 'dir' }, { encoding: 'text' }, { size: 2 }]) {
    const f = await mainReader(t, { branch: { name: 'main', commit: { id: 'e'.repeat(40) } }, content: { ...valid, ...changes } });
    await assert.rejects(f.delivery.readMainFile('right.txt'), { code: 'DELIVERY_INVALID' });
    assert.equal(f.seen.length, 2); assert.match(f.seen[1].path, /\?ref=e{40}$/);
  }
});

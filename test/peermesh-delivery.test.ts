import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createPeerMeshDelivery } from '../src/harnesses/peermesh/delivery.js';

test('host merge admits only pinned own PR and repeats reuse one write receipt including unknown', async t => {
  let writes = 0; let merged = false;
  const server = createServer((request, response) => {
    request.resume(); response.setHeader('content-type', 'application/json');
    assert.equal(request.headers.authorization, 'token host-private');
    if (request.method === 'POST') { writes++; merged = true; return response.end('{}'); }
    response.end(JSON.stringify({ user: { id: 1 }, head: { ref: 'branch-a', sha: 'a'.repeat(40) }, base: { ref: 'main' }, mergeable: true, merged, merge_commit_sha: 'b'.repeat(40) }));
  }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const delivery = createPeerMeshDelivery({ facilities: { endpoints: { gitea: `http://127.0.0.1:${server.address().port}` }, repository: { owner: 'owner', name: 'repo' }, peers: [{ key: 'a', branch: 'branch-a', gitea: { accountId: '1' } }] }, adminToken: 'host-private' });
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
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ user: { id: 1 }, head: { ref: 'a', sha: 'a'.repeat(40) }, base: { ref: 'main' }, mergeable: true, merged: false }));
  }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const delivery = createPeerMeshDelivery({ facilities: { endpoints: { gitea: `http://127.0.0.1:${server.address().port}` }, repository: { owner: 'owner', name: 'repo' }, peers: [{ key: 'a', branch: 'a', gitea: { accountId: '1' } }] }, adminToken: 'host-private' });
  const input = { peerKey: 'a', number: 1, headSha: 'a'.repeat(40) };
  await assert.rejects(delivery.merge(input), { code: 'DELIVERY_MERGE_UNKNOWN' }); await assert.rejects(delivery.merge(input), { code: 'DELIVERY_MERGE_UNKNOWN' });
  assert.equal(writes, 1); assert.equal(delivery.snapshot()[0].state, 'unknown');
});

test('the second fixed-head merge waits through read-only rechecking after main advances and accepts empty HTTP 200', async t => {
  let firstMerged = false, secondMerged = false, secondReads = 0, writes = 0;
  const server = createServer((request, response) => {
    request.resume(); const second = request.url.includes('/pulls/2');
    const ready = !second || firstMerged && secondReads >= 3;
    if (request.method === 'POST') {
      writes++;
      if (!ready) { response.writeHead(405); return response.end(JSON.stringify({ message: 'Please try again later' })); }
      if (second) secondMerged = true; else firstMerged = true;
      response.writeHead(200); return response.end();
    }
    if (second) secondReads++;
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ user: { id: second ? 2 : 1 },
      head: { ref: second ? 'branch-b' : 'branch-a', sha: (second ? 'b' : 'a').repeat(40) }, base: { ref: 'main' },
      mergeable: ready, merged: second ? secondMerged : firstMerged, merge_commit_sha: 'c'.repeat(40) }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const delivery = createPeerMeshDelivery({ facilities: { endpoints: { gitea: `http://127.0.0.1:${server.address().port}` }, repository: { owner: 'owner', name: 'repo' },
    peers: [{ key: 'a', branch: 'branch-a', gitea: { accountId: '1' } }, { key: 'b', branch: 'branch-b', gitea: { accountId: '2' } }] }, adminToken: 'host', readinessIntervalMs: 1 });
  await delivery.merge({ peerKey: 'a', number: 1, headSha: 'a'.repeat(40) });
  await delivery.merge({ peerKey: 'b', number: 2, headSha: 'b'.repeat(40) });
  assert.equal(writes, 2); assert.equal(secondMerged, true); assert.ok(secondReads >= 4);
  assert.ok(delivery.snapshot().every(row => row.state === 'merged'));
});

test('readiness and post-submit failures preserve their phase and never replay a merge', async t => {
  for (const scenario of ['never-ready', 'changed-head', 'submit-405', 'readback-503', 'wrong-observation']) {
    let reads = 0, writes = 0;
    const server = createServer((request, response) => {
      request.resume(); response.setHeader('content-type', 'application/json');
      if (request.method === 'POST') {
        writes++; response.writeHead(scenario === 'submit-405' ? 405 : 200); return response.end();
      }
      reads++;
      if (writes && scenario === 'readback-503') { response.writeHead(503); return response.end('{}'); }
      response.end(JSON.stringify({ user: { id: 1 }, head: { ref: 'a', sha: (scenario === 'changed-head' && reads > 1 || writes && scenario === 'wrong-observation' ? 'b' : 'a').repeat(40) },
        base: { ref: 'main' }, mergeable: !['never-ready', 'changed-head'].includes(scenario), merged: writes > 0 && scenario !== 'submit-405', merge_commit_sha: 'c'.repeat(40) }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const delivery = createPeerMeshDelivery({ facilities: { endpoints: { gitea: `http://127.0.0.1:${server.address().port}` }, repository: { owner: 'owner', name: 'repo' },
      peers: [{ key: 'a', branch: 'a', gitea: { accountId: '1' } }] }, adminToken: 'private', maxReadinessReads: 2, readinessIntervalMs: 1 });
    const input = { peerKey: 'a', number: 1, headSha: 'a'.repeat(40) };
    const code = ['never-ready', 'submit-405'].includes(scenario) ? 'DELIVERY_NOT_READY' : scenario === 'changed-head' ? 'DELIVERY_INVALID' : 'DELIVERY_MERGE_UNKNOWN';
    await assert.rejects(delivery.merge(input), { code }); await assert.rejects(delivery.merge(input), { code });
    const receipt = delivery.snapshot()[0];
    assert.equal(writes, ['never-ready', 'changed-head'].includes(scenario) ? 0 : 1);
    assert.equal(receipt.state, writes && scenario !== 'submit-405' ? 'unknown' : 'rejected');
    assert.equal(receipt.failure.phase, !writes ? 'preflight' : scenario === 'submit-405' ? 'submit' : 'readback');
    if (scenario === 'submit-405') assert.equal(receipt.failure.status, 405);
    if (scenario === 'readback-503') assert.equal(receipt.failure.status, 503);
    if (scenario === 'wrong-observation') assert.equal(receipt.observation.headMatches, false);
    assert.ok(!JSON.stringify(receipt).includes('private'));
  }
});

test('a lost merge acknowledgement can be confirmed by one authoritative read without any repeated write', async t => {
  let writes = 0;
  const server = createServer((request, response) => {
    request.resume();
    if (request.method === 'POST') { writes++; return response.destroy(); }
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ user: { id: 1 }, head: { ref: 'a', sha: 'a'.repeat(40) },
      base: { ref: 'main' }, mergeable: true, merged: writes > 0, merge_commit_sha: writes ? 'b'.repeat(40) : null }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const delivery = createPeerMeshDelivery({ facilities: { endpoints: { gitea: `http://127.0.0.1:${server.address().port}` }, repository: { owner: 'owner', name: 'repo' },
    peers: [{ key: 'a', branch: 'a', gitea: { accountId: '1' } }] }, adminToken: 'host' });
  const input = { peerKey: 'a', number: 1, headSha: 'a'.repeat(40) }, result = await delivery.merge(input);
  assert.equal(result.mergeSha, 'b'.repeat(40)); assert.deepEqual(await delivery.merge(input), result); assert.equal(writes, 1);
  const row = delivery.snapshot()[0]; assert.equal(row.state, 'merged'); assert.equal(row.acknowledgement, 'unknown'); assert.equal(row.failure.phase, 'submit');
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
  return { seen, delivery: createPeerMeshDelivery({ facilities: { endpoints: { gitea: `http://127.0.0.1:${server.address().port}` },
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

test('a peer can correct a PR head and then merge another PR on its work branch', async t => {
  let head = 'a'.repeat(40);
  const merged = new Set();
  const server = createServer((request, response) => {
    request.resume();
    const number = Number(request.url.match(/pulls\/(\d+)/)[1]);
    if (request.method === 'POST') {
      merged.add(number);
      response.writeHead(204);
      return response.end();
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ user: { id: 1 }, head: { ref: 'branch-a', sha: head },
      base: { ref: 'main' }, mergeable: head !== 'a'.repeat(40), merged: merged.has(number), merge_commit_sha: 'd'.repeat(40) }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const delivery = createPeerMeshDelivery({ facilities: { endpoints: { gitea: `http://127.0.0.1:${server.address().port}` },
    repository: { owner: 'owner', name: 'repo' }, peers: [{ key: 'a', branch: 'branch-a', gitea: { accountId: '1' } }] },
    adminToken: 'host', maxReadinessReads: 1 });
  await assert.rejects(delivery.merge({ peerKey: 'a', number: 1, headSha: head }), { code: 'DELIVERY_NOT_READY' });
  head = 'b'.repeat(40);
  await delivery.merge({ peerKey: 'a', number: 1, headSha: head });
  head = 'c'.repeat(40);
  await delivery.merge({ peerKey: 'a', number: 2, headSha: head });
  assert.deepEqual([...merged], [1, 2]);
});

test('fresh Service requests can retry readiness and reconcile the original parent after a lost merge receipt', async t => {
  const originalHead = 'a'.repeat(40);
  const newerHead = 'b'.repeat(40);
  const mergeSha = 'c'.repeat(40);
  let ready = false, writes = 0;
  const server = createServer((request, response) => {
    request.resume();
    response.setHeader('content-type', 'application/json');
    if (request.method === 'POST') {
      writes++;
      return response.destroy();
    }
    if (request.url.endsWith('/git/commits/' + mergeSha)) {
      return response.end(JSON.stringify({ sha: mergeSha, parents: [{ sha: 'd'.repeat(40) }, { sha: originalHead }] }));
    }
    response.end(JSON.stringify({ user: { id: 1 }, head: { ref: 'branch-a', sha: writes ? newerHead : originalHead, repo: { full_name: 'owner/repo' } },
      base: { ref: 'main' }, mergeable: ready, merged: writes > 0, merge_commit_sha: writes ? mergeSha : null }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const delivery = createPeerMeshDelivery({ facilities: { project: true, endpoints: { gitea: `http://127.0.0.1:${server.address().port}` },
    repository: { owner: 'owner', name: 'repo' }, peers: [{ key: 'a', branch: 'branch-a', gitea: { accountId: '1' } }] },
    adminToken: 'host', maxReadinessReads: 1 });
  const input = { peerKey: 'a', number: 1, headSha: originalHead };
  await assert.rejects(delivery.merge({ ...input, requestId: 'first' }), { code: 'DELIVERY_NOT_READY' });
  ready = true;
  await assert.rejects(delivery.merge({ ...input, requestId: 'first' }), { code: 'DELIVERY_NOT_READY' });
  const result = await delivery.merge({ ...input, requestId: 'second' });
  assert.equal(result.mergeSha, mergeSha);
  assert.deepEqual(await delivery.merge({ ...input, requestId: 'repeat' }), result);
  await assert.rejects(delivery.merge({ ...input, headSha: newerHead, requestId: 'repeat' }), { code: 'DELIVERY_CONFLICT' });
  assert.equal(writes, 1);
  assert.equal(delivery.snapshot().at(-1).observation.headMatches, false);
  assert.equal(delivery.snapshot().at(-1).observation.mergeIncludesHead, true);
});

test('a failed archive download keeps the already fixed main revision for close retry', async t => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { gzipSync } = await import('node:zlib');
  const directory = await mkdtemp(join(tmpdir(), 'agensh-delivery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let branchReads = 0;
  const archivePaths = [];
  const archive = gzipSync('fixture archive bytes');
  const server = createServer((request, response) => {
    if (request.url.endsWith('/branches/main')) {
      branchReads++;
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify({ name: 'main', commit: { id: (branchReads === 1 ? 'a' : 'b').repeat(40) } }));
    }
    archivePaths.push(request.url);
    if (archivePaths.length === 1) return response.writeHead(503).end();
    response.end(archive);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const delivery = createPeerMeshDelivery({ facilities: { endpoints: { gitea: `http://127.0.0.1:${server.address().port}` },
    repository: { owner: 'owner', name: 'repo' }, peers: [] }, adminToken: 'host' });
  await assert.rejects(delivery.finalize(directory, AbortSignal.timeout(5000)), { code: 'DELIVERY_EXPORT_FAILED',
    pin: { commit: 'a'.repeat(40), stable: true } });
  const result = await delivery.finalize(directory, AbortSignal.timeout(5000));
  assert.equal(result.commit, 'a'.repeat(40));
  assert.equal(branchReads, 1);
  assert.equal(archivePaths[0], archivePaths[1]);
  assert.deepEqual(await readFile(result.archive), archive);
});

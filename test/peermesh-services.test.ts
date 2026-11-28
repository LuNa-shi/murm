import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createPeerMeshServices } from '../examples/peermesh/harness/services.js';
import { snapshotServiceRegistry, invokeService } from '../src/core/services.js';

test('all three Services resolve only their own trusted account and fix board identity', async t => {
  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    seen.push({ path: req.url, method: req.method, auth: req.headers.authorization, body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined });
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 'object', number: 1, head: { sha: 'a'.repeat(40) }, user_id: 'mm-user', channel_id: 'channel', rendered: 'FACT', status: 'admitted', entries: [], total: 0 }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const service = createPeerMeshServices({ runId: 'run', repository: { owner: 'owner', name: 'repo' }, channelId: 'channel', boardId: 'board',
    endpoints: { gitea: origin, message: origin, board: origin },
    peer: { gitea: { binding: 'git-binding', accountId: 'git-user', token: 'git-secret' }, message: { binding: 'mm-binding', accountId: 'mm-user', token: 'mm-secret' }, board: { binding: 'board-binding', workerId: 'different-worker' } } });
  service.bindAgent({ runtimeId: 'runtime', agentId: 'agent' });
  const registry = snapshotServiceRegistry(service.services);
  let counter = 0;
  const call = (id, operation, input, binding = service.bindings[id]) => invokeService(registry.get(id), {
    operation, input, caller: { runtimeId: 'runtime', agentId: 'agent', profile: 'peer', binding }, envelope: { operation_id: `op-${++counter}` },
  });
  await call('gitea', 'issue_read', { owner: 'owner', repo: 'repo', method: 'get', index: 1 });
  await call('gitea', 'issue_write', { owner: 'owner', repo: 'repo', method: 'create', title: 'fixed', body: 'body' });
  await call('gitea', 'pull_request_write', { owner: 'owner', repo: 'repo', method: 'create', head: 'peer-branch', base: 'main', title: 'fixed' });
  await call('message', 'post_message', { channel_id: 'channel', message: 'fixed' });
  await call('peermesh-context', 'board_read', { board_id: 'board' });
  await call('peermesh-context', 'board_write', { board_id: 'board', type: 'FACT', content: 'fixed', detail: 'detail' });
  await call('peermesh-context', 'board_grep', { board_id: 'board', words: 'fixed', limit: 10 });
  await call('peermesh-context', 'board_unfold', { board_id: 'board', labels: ['G1'] });
  assert.equal(seen.length, 8);
  assert.ok(seen.slice(0, 3).every(row => row.auth === 'token git-secret'));
  assert.equal(seen[3].auth, 'Bearer mm-secret');
  assert.equal(seen[5].body.thread_id, 'different-worker');
  assert.ok(seen.filter(row => row.method === 'GET' && row.path.startsWith('/board')).every(row => new URL(row.path, origin).searchParams.get('viewer') === 'different-worker'));
  await assert.rejects(call('peermesh-context', 'board_write', { board_id: 'board', type: 'FACT', content: 'fake', thread_id: 'attacker' }), { code: 'SERVICE_INPUT_INVALID' });
  await assert.rejects(call('peermesh-context', 'board_read', { board_id: 'other' }), { code: 'SERVICE_INPUT_INVALID' });
  await assert.rejects(call('gitea', 'issue_read', { owner: 'other', repo: 'repo', method: 'get', index: 1 }), { code: 'SERVICE_INPUT_INVALID' });
  await assert.rejects(call('message', 'post_message', { channel_id: 'channel', message: 'fake' }, 'git-binding'), { code: 'NOT_ALLOWED' });
  assert.equal(seen.length, 8);
  assert.equal(JSON.stringify(service.identities()).includes('secret'), false);
});

test('one registry selects each peer token and board identity from its trusted Agent binding', async t => {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    requests.push({ auth: request.headers.authorization, path: request.url, body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : null });
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ number: 1, rendered: 'shared', status: 'admitted' }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const peers = ['a', 'b'].map(name => ({ key: name, gitea: { binding: `git-${name}`, accountId: name, token: `git-token-${name}` },
    message: { binding: `mm-${name}`, accountId: name, token: `mm-token-${name}` }, board: { binding: `board-${name}`, workerId: `worker-${name}` } }));
  const service = createPeerMeshServices({ runId: 'team', repository: { owner: 'owner', name: 'repo' }, channelId: 'channel', boardId: 'board', endpoints: { gitea: origin, message: origin, board: origin }, peers });
  for (const peer of peers) service.bindAgent({ runtimeId: 'runtime', agentId: `agent-${peer.key}`, peerKey: peer.key });
  const registry = snapshotServiceRegistry(service.services);
  const call = (key, id, operation, input, binding) => invokeService(registry.get(id), { operation, input,
    caller: { runtimeId: 'runtime', agentId: `agent-${key}`, profile: 'peer', binding }, envelope: { operation_id: `${key}-${operation}` } });
  for (const key of ['a', 'b']) {
    await call(key, 'gitea', 'issue_read', { owner: 'owner', repo: 'repo', method: 'get', index: 1 }, `git-${key}`);
    await call(key, 'peermesh-context', 'board_write', { board_id: 'board', type: 'CLAIM', content: 'same work' }, `board-${key}`);
  }
  assert.deepEqual(requests.filter(row => row.auth).map(row => row.auth), ['token git-token-a', 'token git-token-b']);
  assert.deepEqual(requests.filter(row => row.body).map(row => row.body.thread_id), ['worker-a', 'worker-b']);
  await assert.rejects(call('b', 'gitea', 'issue_read', { owner: 'owner', repo: 'repo', method: 'get', index: 1 }, 'git-a'), { code: 'NOT_ALLOWED' });
  assert.equal(requests.length, 4);
});

test('project peers can open and merge a PR from a self-chosen branch in their run repository', async t => {
  const checked = 'b'.repeat(40);
  const later = 'd'.repeat(40);
  const merged = 'c'.repeat(40);
  const head = { ref: 'fix/pandoc-reader', sha: checked, repo: { full_name: 'owner/repo' } };
  let didMerge = false;
  let mergeable = false;
  const posts: unknown[] = [];
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    const data = { number: 2, user: { id: 1 }, base: { ref: 'main' }, head, mergeable, merged: didMerge, merge_commit_sha: merged };
    if (req.method === 'POST') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      posts.push(JSON.parse(Buffer.concat(chunks).toString()));
      if (req.url.endsWith('/merge')) didMerge = true;
    }
    res.end(JSON.stringify(req.url.includes('/git/commits/') ? { sha: merged, parents: [{ sha: 'a'.repeat(40) }, { sha: later }] } : data));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const facilities = { project: true, runId: 'run', repository: { owner: 'owner', name: 'repo' }, channelId: 'channel', boardId: 'board',
    endpoints: { gitea: origin, message: origin, board: origin }, peers: [{ key: 'a', branch: 'peer-run-a', gitea: { binding: 'git', accountId: '1', token: 'git-secret' },
      message: { binding: 'mm', accountId: 'm', token: 'mm-secret' }, board: { binding: 'board', workerId: 'worker-a' } }] };
  const { createPeerMeshDelivery } = await import('../examples/peermesh/harness/delivery.js');
  const service = createPeerMeshServices(facilities, createPeerMeshDelivery({ facilities, adminToken: 'host', maxReadinessReads: 1 }));
  service.bindAgent({ runtimeId: 'runtime', agentId: 'agent', peerKey: 'a', profile: 'peer-a' });
  const registry = snapshotServiceRegistry(service.services);
  let counter = 0;
  const call = (operation, input) => invokeService(registry.get('gitea'), {
    operation, input: { owner: 'owner', repo: 'repo', ...input }, caller: { runtimeId: 'runtime', agentId: 'agent', profile: 'peer-a', binding: 'git' }, envelope: { operation_id: `op-${++counter}` },
  });
  const open = branch => call('pull_request_write', { method: 'create', head: branch, base: 'main', title: 'Pandoc reader fix' });
  for (const branch of ['main', 'foreign:branch']) await assert.rejects(open(branch), { code: 'NOT_ALLOWED' });
  const pr = await open(head.ref);
  await assert.rejects(call('pull_request_merge', { index: pr.number, head_sha: checked }), { code: 'DELIVERY_NOT_READY' });
  head.sha = later;
  mergeable = true;
  head.repo.full_name = 'other/repo';
  await assert.rejects(call('pull_request_merge', { index: pr.number, head_sha: later }), { code: 'DELIVERY_INVALID' });
  head.repo.full_name = 'owner/repo';
  assert.deepEqual(await call('pull_request_merge', { index: pr.number, head_sha: later }), { peerKey: 'a', number: 2, headSha: later, mergeSha: merged });
  assert.deepEqual(posts, [{ title: 'Pandoc reader fix', head: 'fix/pandoc-reader', base: 'main' }, { Do: 'merge', head_commit_id: later }]);
});

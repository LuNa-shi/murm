import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createAgenshServices } from '../src/environments/agensh/services.js';
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
  const service = createAgenshServices({ runId: 'run', repository: { owner: 'owner', name: 'repo' }, channelId: 'channel', boardId: 'board',
    endpoints: { gitea: origin, message: origin, board: origin },
    peer: { gitea: { binding: 'git-binding', accountId: 'git-user', token: 'git-secret' }, message: { binding: 'mm-binding', accountId: 'mm-user', token: 'mm-secret' }, board: { binding: 'board-binding', workerId: 'different-worker' } } });
  service.bindBot({ runtimeId: 'runtime', botId: 'bot' });
  const registry = snapshotServiceRegistry(service.services);
  let counter = 0;
  const call = (id, operation, input, binding = service.bindings[id]) => invokeService(registry.get(id), {
    operation, input, caller: { runtimeId: 'runtime', botId: 'bot', profile: 'peer', binding }, envelope: { operation_id: `op-${++counter}` },
  });
  await call('gitea', 'issue_read', { owner: 'owner', repo: 'repo', method: 'get', index: 1 });
  await call('gitea', 'issue_write', { owner: 'owner', repo: 'repo', method: 'create', title: 'fixed', body: 'body' });
  await call('gitea', 'pull_request_write', { owner: 'owner', repo: 'repo', method: 'create', head: 'peer-branch', base: 'main', title: 'fixed' });
  await call('message', 'post_message', { channel_id: 'channel', message: 'fixed' });
  await call('agensh-context', 'board_read', { board_id: 'board' });
  await call('agensh-context', 'board_write', { board_id: 'board', type: 'FACT', content: 'fixed', detail: 'detail' });
  await call('agensh-context', 'board_grep', { board_id: 'board', words: 'fixed', limit: 10 });
  await call('agensh-context', 'board_unfold', { board_id: 'board', labels: ['G1'] });
  assert.equal(seen.length, 8);
  assert.ok(seen.slice(0, 3).every(row => row.auth === 'token git-secret'));
  assert.equal(seen[3].auth, 'Bearer mm-secret');
  assert.equal(seen[5].body.thread_id, 'different-worker');
  assert.ok(seen.filter(row => row.method === 'GET' && row.path.startsWith('/board')).every(row => new URL(row.path, origin).searchParams.get('viewer') === 'different-worker'));
  await assert.rejects(call('agensh-context', 'board_write', { board_id: 'board', type: 'FACT', content: 'fake', thread_id: 'attacker' }), { code: 'SERVICE_INPUT_INVALID' });
  await assert.rejects(call('agensh-context', 'board_read', { board_id: 'other' }), { code: 'SERVICE_INPUT_INVALID' });
  await assert.rejects(call('gitea', 'issue_read', { owner: 'other', repo: 'repo', method: 'get', index: 1 }), { code: 'SERVICE_INPUT_INVALID' });
  await assert.rejects(call('message', 'post_message', { channel_id: 'channel', message: 'fake' }, 'git-binding'), { code: 'NOT_ALLOWED' });
  assert.equal(seen.length, 8);
  assert.equal(JSON.stringify(service.identities()).includes('secret'), false);
});

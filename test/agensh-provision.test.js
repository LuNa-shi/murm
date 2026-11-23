import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { prepareAgenshFacilities } from '../src/environments/agensh/provision.js';
import { createOwnedResources } from '../src/environments/agensh/resources.js';

test('single-peer provisioning creates independent account mappings and retains shared data on cleanup', async t => {
  const seen = []; const users = new Map();
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
    seen.push({ method: request.method, path: request.url, body });
    let result = {};
    if (request.method === 'GET' && request.url.includes('/tokens')) result = [];
    else if (request.method === 'POST' && request.url === '/api/v1/admin/users') { users.set(body.username, body); result = { id: 101, login: body.username }; }
    else if (request.method === 'GET' && request.url.startsWith('/api/v1/users/')) result = users.get(request.url.split('/').at(-1)) ?? {};
    else if (request.url.endsWith('/tokens') && request.method === 'POST') result = request.url.startsWith('/api/v1/') ? { id: 201, sha1: 'git-private' } : { id: 'mm-token', token: 'mm-private' };
    else if (request.url === '/api/v4/users' && request.method === 'POST') result = { id: 'mm-user', username: body.username };
    else if (request.url === '/api/v4/channels' && request.method === 'POST') result = { id: 'run-channel' };
    else if (request.url.includes('/issues') && request.method === 'POST') result = { number: 1 };
    else if (request.url === '/api/v1/user') result = { login: 'owner' };
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(result));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const resources = createOwnedResources(); let boardStopped = false;
  const facilities = await prepareAgenshFacilities({ runId: 'fixed-run', gitea: { origin, adminToken: 'admin-secret', owner: 'owner' },
    mattermost: { origin, adminToken: 'mm-admin-secret', teamId: 'team' }, resources,
    startBoard: async ({ boardId, workerId, own }) => { assert.notEqual(boardId, workerId); own({ kind: 'board-process', id: boardId, close: () => { boardStopped = true; } }); return { origin }; } });
  assert.equal(facilities.peer.gitea.accountId, '101');
  assert.equal(facilities.peer.message.accountId, 'mm-user');
  assert.equal(facilities.peer.board.workerId, 'worker-fixed-run');
  assert.equal(facilities.peer.gitea.token, 'git-private');
  assert.ok(seen.some(row => row.path.includes('/contents/acceptance.txt') && row.body.branch === 'main'));
  assert.equal((await resources.close()).cleanup, 'complete'); assert.equal(boardStopped, true);
  assert.ok(seen.some(row => row.method === 'PATCH' && row.body?.prohibit_login === true));
  assert.ok(seen.some(row => row.path === '/api/v4/users/mm-user/active' && row.body.active === false));
  assert.ok(!seen.some(row => row.method === 'DELETE' && /repos|channels/.test(row.path)));
});

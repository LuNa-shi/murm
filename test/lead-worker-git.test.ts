import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { ServiceRegistry, snapshotServiceRegistry, invokeService } from '../src/core/services.js';
import { createLeadWorkerGit, prepareLeadWorkerGit } from '../src/harnesses/lead-worker/git.js';
import { createOwnedResources } from '../src/harnesses/peermesh/resources.js';

async function server(t, callback) {
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    try { const result = await callback(request, chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined); response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(result)); } catch { response.writeHead(400).end('{}'); }
  }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })); return `http://127.0.0.1:${server.address().port}`;
}
const actors = () => Object.fromEntries(['lead', 'helper1', 'helper2'].map(role => [role, { accountId: role, username: role, branch: role, token: `secret-${role}`, binding: role }]));

test('Git proof checks own branch head and actual bytes; PR cannot forge identity, branch or repository', async t => {
  let requests = 0; let wrongHead = false; let wrongFile = false;
  const content = Buffer.from('actual bytes\n'); const commit = 'a'.repeat(40); const sha256 = createHash('sha256').update(content).digest('hex');
  const origin = await server(t, (request, input) => {
    requests++; assert.equal(request.headers.authorization, 'token secret-helper1');
    if (request.url.includes('/branches/')) return { commit: { id: wrongHead ? 'b'.repeat(40) : commit } };
    if (request.url.includes('/contents/')) return { type: 'file', path: 'result.txt', encoding: 'base64', size: content.length, content: (wrongFile ? Buffer.from('forged') : content).toString('base64') };
    assert.equal(request.url, '/api/v1/repos/owner/repo/pulls'); assert.equal(input.head, 'helper1'); return { number: 1 };
  });
  const git = createLeadWorkerGit({ origin, repository: { owner: 'owner', name: 'repo' }, repositoryUrl: `${origin}/owner/repo.git`, actors: actors() });
  git.bindTeam('runtime', { lead: 'lead-id', helper1: 'one', helper2: 'two' });
  const proof = { commit, path: 'result.txt', bytes: content.length, sha256 };
  assert.equal((await git.verifyDelivery({ actor: 'one', delivery: proof })).verified, true);
  wrongHead = true; await assert.rejects(git.verifyDelivery({ actor: 'one', delivery: proof }), { code: 'DELIVERY_INVALID' }); wrongHead = false;
  await assert.rejects(git.verifyDelivery({ actor: 'one', delivery: proof, direction: { seq: 2, text: 'Changed direction absent from bytes' }, requireDirectionText: true }), { code: 'DELIVERY_INVALID' });
  wrongFile = true; await assert.rejects(git.verifyDelivery({ actor: 'one', delivery: proof }), { code: 'DELIVERY_INVALID' }); wrongFile = false;
  const registry = new ServiceRegistry(); git.register(registry); const registration = snapshotServiceRegistry(registry).get('gitea');
  const input = { owner: 'owner', repo: 'repo', method: 'create', head: 'helper1', base: 'main', title: 'Verified result' };
  const caller = { runtimeId: 'runtime', agentId: 'one', profile: 'helper1', binding: 'helper1' };
  const invoke = (payload, identity = caller) => invokeService(registration, { operation: 'pull_request_write', input: payload, caller: identity, envelope: { operation_id: 'pr' } });
  const before = requests;
  await assert.rejects(invoke({ ...input, head: 'helper2' }), { code: 'NOT_ALLOWED' });
  await assert.rejects(invoke(input, { ...caller, runtimeId: 'foreign' }), { code: 'NOT_ALLOWED' });
  await assert.rejects(invoke({ ...input, repo: 'foreign' }), { code: 'SERVICE_INPUT_INVALID' });
  assert.equal(requests, before); assert.deepEqual(await invoke(input), { number: 1 });
  assert.equal(JSON.stringify(git.identities()).includes('secret'), false);
});

for (const configuration of [{ count: 3 }, { count: 8, helperCount: 7 }]) {
  test(`provisioning creates ${configuration.count} restricted accounts and retains the project at close`, async t => {
    const users = new Map(); const seen = []; let serial = 0;
    const origin = await server(t, (request, body) => {
      seen.push({ method: request.method, path: request.url, body });
      if (request.url === '/api/v1/user') return { login: 'owner' };
      if (request.url === '/api/v1/admin/users' && request.method === 'POST') { const user = { ...body, id: ++serial }; users.set(body.username, user); return user; }
      if (request.url.endsWith('/tokens') && request.method === 'POST') return { sha1: `token-${serial}` };
      if (request.url.endsWith('/tokens')) return [];
      return {};
    });
    const resources = createOwnedResources(); const value = await prepareLeadWorkerGit({ runId: 'a'.repeat(32), gitea: { origin, owner: 'owner', adminToken: 'admin' }, resources, helperCount: configuration.helperCount });
    assert.equal(Object.keys(value.actors).length, configuration.count); assert.equal(new Set(Object.values(value.actors).map(row => row.token)).size, configuration.count);
    assert.ok([...users.values()].every(row => row.restricted && row.max_repo_creation === 0 && row.allow_create_organization === false && row.username.length <= 40));
    assert.equal((await resources.close()).cleanup, 'complete');
    assert.equal(seen.filter(row => row.method === 'PATCH' && row.body?.prohibit_login).length, configuration.count);
    assert.ok(!seen.some(row => row.method === 'DELETE' && row.path.includes('/repos/')));
  });
}

test('Git accepts a new Profile identity only after its registered member is ready', async t => {
  let ready = false;
  const origin = await server(t, request => {
    assert.equal(request.headers.authorization, 'token checker-token');
    return { number: 1 };
  });
  const git = createLeadWorkerGit({
    origin, repository: { owner: 'owner', name: 'repo' },
    repositoryUrl: `${origin}/owner/repo.git`, actors: actors(),
  }, 2, { isReady: id => id !== 'checker-id' || ready });
  const registry = new ServiceRegistry();
  git.register(registry);
  git.bindTeam('runtime', { lead: 'lead-id', helper1: 'one', helper2: 'two' });
  const registration = snapshotServiceRegistry(registry).get('gitea');
  const input = { owner: 'owner', repo: 'repo', method: 'create', head: 'check-branch', base: 'main', title: 'Verified result' };
  const caller = { runtimeId: 'runtime', agentId: 'checker-id', profile: 'orders-checker', binding: 'checker-binding' };
  const invoke = identity => invokeService(registration, { operation: 'pull_request_write', input, caller: identity, envelope: { operation_id: 'pr' } });
  await assert.rejects(invoke(caller), { code: 'NOT_ALLOWED' });
  git.addMember({ agentId: 'checker-id', profile: 'orders-checker', actor: {
    accountId: '4', username: 'checker-account', branch: 'check-branch', token: 'checker-token', binding: 'checker-binding',
  } });
  await assert.rejects(invoke(caller), { code: 'NOT_ALLOWED' });
  ready = true;
  await assert.rejects(invoke({ ...caller, profile: 'helper1' }), { code: 'NOT_ALLOWED' });
  assert.deepEqual(await invoke(caller), { number: 1 });
  assert.equal(git.identities()['orders-checker'].username, 'checker-account');
  assert.equal(JSON.stringify(git.identities()).includes('checker-token'), false);
});

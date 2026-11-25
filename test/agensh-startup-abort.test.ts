import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createPeerMeshHarness } from '../src/harnesses/peermesh/index.js';
import { preparePeerMeshFacilities } from '../src/harnesses/peermesh/provision.js';
import { createWorkGate } from './fixtures/agensh-deadline.js';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

for (const phase of ['readiness', 'account', 'repository']) test(`actual production factory stops after work deadline during ${phase}, with no later startup writes`, async t => {
  let gate, account; const rows = []; const pending = new Set(); let boardStarts = 0;
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
    const row = { method: request.method, path: request.url, expired: gate.expired(), cleanup: Boolean(body?.prohibit_login), body }; rows.push(row);
    let result = {};
    if (request.url === '/api/v1/user') result = { login: 'owner' };
    if (request.url === '/api/v1/admin/users' && request.method === 'POST') { account = { ...body, id: 101 }; result = account; }
    if (request.url === '/api/v1/users/peer-abort') result = account;
    if (request.url.endsWith('/tokens')) result = [];
    const held = phase === 'readiness' && request.url === '/api/v1/version' || phase === 'account' && request.method === 'POST' && request.url === '/api/v1/admin/users' || phase === 'repository' && request.method === 'POST' && request.url.endsWith('/repos');
    if (held) { const work = delay(100); pending.add(work); await work; pending.delete(work); }
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(result));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { gate.dispose(); gate.cleanup.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await Promise.all(pending); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  gate = createWorkGate(60);
  let thrown;
  await assert.rejects(gate.create(() => createPeerMeshHarness({ runId: 'abort', image: 'unused', exportLimit: 1024, signal: gate.signal,
    gitea: { origin, adminToken: 'private-admin', owner: 'owner' }, mattermost: { origin, adminToken: 'private-mm-admin', teamId: 'team' },
    startBoard: async () => { boardStarts++; throw new Error('Unexpected board start'); },
  })), error => ['ENVIRONMENT_START_ABORTED', 'ACTUAL_PEER_WORK_EXPIRED'].includes(error.code));
  const creation = await gate.awaitCreation(); thrown = creation.error;
  assert.equal(creation.state, 'failed'); assert.equal(thrown.code, 'ENVIRONMENT_START_ABORTED'); assert.equal(thrown.cleanup, 'complete');
  await Promise.all(pending);
  assert.equal(gate.expired(), true); assert.equal(boardStarts, 0); assert.equal(gate.environment(), undefined);
  const writes = rows.filter(row => row.method !== 'GET' && !row.cleanup);
  assert.equal(writes.filter(row => row.expired).length, 0);
  assert.equal(writes.length, { readiness: 0, account: 1, repository: 2 }[phase]);
  if (phase !== 'readiness') {
    assert.ok(rows.some(row => row.cleanup && row.expired), 'Owned in-flight account can still be disabled after abort');
    assert.ok(thrown.details.some(row => row.resources?.some(resource => resource.kind === 'gitea-account' && resource.state === 'closed')));
  }
  if (phase === 'repository') assert.ok(thrown.details.some(row => row.resources?.some(resource => resource.kind === 'repository-create-intent' && resource.state === 'retained')));
  assert.equal(JSON.stringify(thrown).includes('private-admin'), false);
});

test('Environment and production provisioner reject nonstring run IDs before any work', async () => {
  for (const runId of [undefined, null, true, 123, {}, { toString() { throw new Error('Must not coerce runId'); } }]) {
    let prepared = false;
    await assert.rejects(createPeerMeshHarness({ runId, image: 'unused', exportLimit: 1024, prepare: async () => { prepared = true; } }), TypeError);
    await assert.rejects(preparePeerMeshFacilities({ runId, startBoard() {} }), TypeError);
    assert.equal(prepared, false);
  }
});

test('an already aborted startup never calls preparation and exposes a constant cancellation code', async () => {
  const controller = new AbortController(); controller.abort(); let prepared = false;
  await assert.rejects(createPeerMeshHarness({ runId: 'aborted', image: 'unused', exportLimit: 1024, signal: controller.signal,
    prepare: async () => { prepared = true; },
  }), { code: 'ENVIRONMENT_START_ABORTED', cleanup: 'complete' });
  assert.equal(prepared, false);
});

test('an aborted account write absent from reconciliation stays pending until its late commit is known', async t => {
  let gate; let created = false; let pending; let startupWrites = 0;
  const server = createServer(async (request, response) => {
    request.resume();
    if (request.method === 'POST') {
      startupWrites++;
      pending = delay(100).then(() => { created = true; response.end('{"id":101}'); });
      return;
    }
    if (request.url === '/api/v1/user') return response.end('{"login":"owner"}');
    if (request.url === '/api/v1/users/peer-late') { response.writeHead(404); return response.end('{}'); }
    response.end('{}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { gate.dispose(); gate.cleanup.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await pending; });
  const origin = `http://127.0.0.1:${server.address().port}`; gate = createWorkGate(60);
  await assert.rejects(gate.create(() => createPeerMeshHarness({ runId: 'late', image: 'unused', exportLimit: 1024, signal: gate.signal,
    gitea: { origin, adminToken: 'private', owner: 'owner' }, mattermost: { origin, adminToken: 'private', teamId: 'team' }, startBoard() { throw new Error('must not start'); },
  })), error => ['ENVIRONMENT_START_ABORTED', 'ACTUAL_PEER_WORK_EXPIRED'].includes(error.code));
  const creation = await gate.awaitCreation(); assert.equal(creation.state, 'failed');
  assert.equal(creation.error.code, 'ENVIRONMENT_START_ABORTED'); assert.equal(creation.error.cleanup, 'pending');
  assert.ok(creation.error.details.some(row => row.resources?.some(resource => resource.kind === 'gitea-account' && resource.state === 'pending')));
  assert.equal(created, false); await pending;
  assert.equal(created, true); assert.equal(startupWrites, 1);
});

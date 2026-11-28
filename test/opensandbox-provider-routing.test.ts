import { runtimeSettings } from './fixtures/core-runtime-settings.js';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test, type TestContext } from 'node:test';
import { claimOpenSandboxBackend, openOpenSandboxBackend } from '../src/core/sandbox/opensandbox-backend.js';
import { OpenSandboxManager } from '../src/core/sandbox/opensandbox-manager.js';
import { getExecutorCapabilities } from '../src/core/sandbox/executor-driver.js';

async function endpoint(t: TestContext, id: string, version: number,
  rpc?: (message: Record<string, unknown>) => Promise<unknown>,
) {
  const calls: string[] = [];
  const quota = { bytes: 32 * 1024 ** 2, inodes: 2048 };
  let metadata: Record<string, string> | undefined;
  let loseCreateResponse = false;
  let rejectStart = false;
  let origin: string;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, origin);
    const route = `${request.method} ${url.pathname}`;
    calls.push(route);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const json = (data: unknown, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(data));
    };
    if (route === 'POST /v1/sandboxes') {
      metadata = input.metadata;
      if (loseCreateResponse) { request.socket.destroy(); return; }
      json({ id: 'same-sandbox' }, 202);
    } else if (route === 'GET /v1/sandboxes') json(metadata ? [{ id: 'same-sandbox', metadata }] : []);
    else if (route === 'DELETE /v1/sandboxes/same-sandbox') { metadata = undefined; json({}, 202); }
    else if (route === 'GET /v1/sandboxes/same-sandbox') json({}, metadata ? 200 : 404);
    else if (route === 'GET /v1/sandboxes/same-sandbox/endpoints/44772') json({ endpoint: `${origin}/execd` });
    else if (route.startsWith('GET /v1/sandboxes/same-sandbox/endpoints/')) json({ endpoint: `${origin}/worker` });
    else if (route === 'GET /worker/health' || route === 'GET /execd/ready') json({});
    else if (route === 'POST /execd/command') json({ exit_code: 0, stdout: JSON.stringify(input).includes('pi') ? '1.3.0' : 'v24.21.0' });
    else if (route === 'GET /worker/core/contract') json({ result: { file_protocol: 'file-tree-v1' } });
    else if (route === 'POST /worker/start' && rejectStart) json({ ok: false, code: 'FILE_SPACE_INSUFFICIENT' }, 400);
    else if (route === 'POST /worker/start') json({ result: { contract: { version: 'murm-core-v1', file_protocol: 'file-tree-v1', resources: [] },
      project_quota: quota, project_files: { version: 0, writable: false } } });
    else if (route === 'POST /worker/rpc') json({ result: rpc ? await rpc(input.message) : { response: { command: 'get_state', success: true }, records: [] } });
    else if (route === 'POST /worker/core/files/snapshot') json({ result: { version } });
    else if (route === 'POST /worker/stop') json({ result: { stopped: true } });
    else json({}, 404);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
  return { id, origin, calls, quota, occupied: () => Boolean(metadata), loseCreate: () => { loseCreateResponse = true; },
    exhaustFileSpace: () => { loseCreateResponse = false; rejectStart = true; },
    openManager: (image: string) => new OpenSandboxManager({ image, lifecycleBaseUrl: `${origin}/v1` }),
    async prepareSandbox() { return quota; },
    async createSharedWorkspace() { assert.fail('The fixture only supports private directories'); },
    async deleteSharedWorkspace() { assert.fail('The fixture only supports private directories'); },
  };
}

test('one Backend routes identical sandbox IDs and lost creates to their original OpenSandbox endpoints', { timeout: 15_000 }, async t => {
  const first = await endpoint(t, 'first', 11);
  const second = await endpoint(t, 'second', 22);
  const settings = runtimeSettings({
    sandbox: { lifecycleBaseUrl: `${first.origin}/v1` },
    bridge: { host: '127.0.0.1', publicUrl: 'http://172.17.0.1:{port}' },
    modelGateway: { host: '127.0.0.1', advertiseHost: '172.17.0.1' },
    models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: `${first.origin}/v1/responses`, headers: {} } } },
    isolation: { network: 'local-docker', disk: first.quota },
  });
  const config = claimOpenSandboxBackend(settings.sandbox, settings);
  const publicUrl = 'http://172.17.0.1:9000';
  const backend = await openOpenSandboxBackend(config, {
    runtimeId: 'provider-ownership-test', outputDir: '', providers: [first, second],
    bridge: { publicUrl, visibleServices: () => [], credentialsForAgent: () => ({ environment: {}, secretEnvironment: {} }) },
    modelAccess: { credentialsForAgent: () => ({ baseUrl: publicUrl, environment: {}, secretEnvironment: {} }) },
  });
  const allocations: Array<{ agentId: string; state: string; providerId: string; resourceKey: string; sandboxId?: string; observation?: string }> = [];
  const spawn = (agentId: string) => backend.spawn({ agentId, onEvent() {}, recordAllocation(allocation) {
    allocations.push({ ...allocation, agentId });
  }, profile: { model: 'default', image: 'test-image', writable: false, services: {} } });
  const stop = async (agentId: string) => { await backend.stopExecution(agentId); await backend.destroy(agentId); };

  assert.equal((await spawn('one')).sandboxId, 'same-sandbox');
  assert.equal((await spawn('two')).sandboxId, 'same-sandbox');
  assert.equal((await backend.snapshotFiles('one', { requestId: 'file-one' })).version, 11);
  assert.equal((await backend.snapshotFiles('two', { requestId: 'file-two' })).version, 22);
  assert.equal(backend.resource('one')?.providerId, 'first');
  assert.equal(backend.resource('two')?.providerId, 'second');
  assert.equal(first.calls.includes('POST /worker/rpc'), true);
  assert.equal(second.calls.includes('POST /worker/rpc'), true);
  await stop('one');
  assert.equal(first.occupied(), false);
  assert.equal(second.occupied(), true);

  first.loseCreate();
  await assert.rejects(spawn('lost'), { code: 'SERVICE_UNAVAILABLE' });
  assert.deepEqual(backend.resource('lost'), { providerId: 'first', resourceKey: 'lost', creation: 'pending', executionStopped: false });
  await stop('lost');
  assert.equal(first.occupied(), false);
  assert.equal(second.occupied(), true);
  assert.equal(first.calls.filter(call => call === 'POST /v1/sandboxes').length, 2);
  assert.equal(second.calls.filter(call => call === 'POST /v1/sandboxes').length, 1);
  assert.equal(first.calls.filter(call => call === 'GET /v1/sandboxes').length, 1);
  assert.equal(second.calls.includes('GET /v1/sandboxes'), false);
  assert.deepEqual(allocations.map(({ agentId, providerId, resourceKey, state, sandboxId, observation }) =>
    [agentId, providerId, resourceKey, state, sandboxId, observation]), [
    ['one', 'first', 'one', 'allocation-dispatched', undefined, undefined],
    ['one', 'first', 'one', 'allocation-observed', 'same-sandbox', 'create-response'],
    ['two', 'second', 'two', 'allocation-dispatched', undefined, undefined],
    ['two', 'second', 'two', 'allocation-observed', 'same-sandbox', 'create-response'],
    ['lost', 'first', 'lost', 'allocation-dispatched', undefined, undefined],
    ['lost', 'first', 'lost', 'allocation-observed', 'same-sandbox', 'cleanup-lookup'],
  ]);
  await stop('two');
  assert.equal(second.occupied(), false);

  second.exhaustFileSpace();
  await assert.rejects(spawn('no-space'), { code: 'FILE_SPACE_INSUFFICIENT' });
  assert.deepEqual(await backend.stopExecution('no-space'), { collectable: false });
  await backend.destroy('no-space');
  assert.equal(second.occupied(), false);
  await backend.close();
});

test('Host Session reads release every large reply and stop at a Worker history gap', { timeout: 15_000 }, async t => {
  const messagesCommand = 'core_session_get_messages';
  const barrier = Promise.withResolvers<void>();
  let pageRequests = 0;
  let attest = true;
  let failRead = false;
  let gap = false;
  const capabilities = getExecutorCapabilities('pi').session;
  const provider = await endpoint(t, 'session-reads', 1, async message => {
    const { type, id, limit } = message;
    const records = [];
    if (attest) {
      attest = false;
      records.push({ type: 'core_session_ready', worker_sequence: 1, version: '1.3.0', capabilities });
    }
    if (type === messagesCommand) {
      pageRequests++;
      if (id === 'held') await barrier.promise;
      if (failRead) return { records };
      if (gap) records.push({ type: 'agent_settled', worker_sequence: 3 });
    }
    return { records, response: { command: type, id, success: true,
      ...(type === messagesCommand ? { data: { messages: [{ content: '読'.repeat(22_000) }], limit } } : {}) } };
  });
  const publicUrl = 'http://172.17.0.1:9000';
  const settings = runtimeSettings({ sandbox: { lifecycleBaseUrl: `${provider.origin}/v1` },
    models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: `${provider.origin}/v1/responses`, headers: {} } } },
    isolation: { network: 'local-docker', disk: provider.quota },
  });
  const backend = await openOpenSandboxBackend(claimOpenSandboxBackend(settings.sandbox, settings), {
    runtimeId: 'session-reads-test', outputDir: '', providers: [provider],
    bridge: { publicUrl, visibleServices: () => [], credentialsForAgent: () => ({ environment: {}, secretEnvironment: {} }) },
    modelAccess: { credentialsForAgent: () => ({ baseUrl: publicUrl, environment: {}, secretEnvironment: {} }) },
  });
  const events = [];
  t.after(async () => { barrier.resolve(); await backend.close(); });
  await backend.spawn({ agentId: 'reader', onEvent: event => events.push(event), recordAllocation() {},
    profile: { model: 'default', image: 'test-image', writable: false, services: {} } });
  assert.deepEqual(backend.sessionCapabilities('reader'), capabilities);
  const read = (id: string, limit: number) => backend.sessionCommand('reader', messagesCommand, { id, limit }, false);
  const held = read('held', 4);
  const joined = read('held', 4);
  await assert.rejects(read('held', 9), { code: 'CONFLICT' });
  barrier.resolve();
  assert.deepEqual(await held, await joined);
  assert.equal(pageRequests, 1);
  for (let index = 0; index < 100; index++) {
    const id = `read-${index}`;
    const page = await read(id, 1) as { messages: { content: string }[] };
    assert.equal(Buffer.byteLength(page.messages[0].content), 66_000);
  }
  // Every completed identity can be reused with new arguments. A retained
  // fingerprint would conflict, and a retained response would have limit 1.
  for (let index = 0; index < 100; index++) {
    assert.equal((await read(`read-${index}`, 2) as { limit: number }).limit, 2);
  }
  assert.equal(pageRequests, 201);
  failRead = true;
  assert.deepEqual(await read('rejected', 1), { status: 'unknown' });
  failRead = false;
  assert.equal((await read('rejected', 2) as { limit: number }).limit, 2);
  gap = true;
  assert.deepEqual(await read('gap', 1), { status: 'unknown' });
  assert.ok(events.some(event => event.type === 'error' && event.fatal && event.error.message.includes('history has a gap')));
  await assert.rejects(read('new-after-gap', 1), { code: 'SESSION_UNAVAILABLE' });
  assert.equal(pageRequests, 204);
});

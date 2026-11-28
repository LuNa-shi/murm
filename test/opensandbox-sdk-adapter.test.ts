import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpenSandboxManager } from '../src/core/sandbox/opensandbox-manager.js';

function fixture({ endpointFailure = false, createFailure = false } = {}) {
  const calls: string[] = [];
  const expiresAt = new Date(Date.now() + 3_600_000);
  const sandboxes = {
    async createSandbox(request: any) {
      calls.push('create');
      assert.equal(request.networkPolicy?.defaultAction, 'deny');
      if (createFailure) throw new Error('response lost');
      return { id: 'owned-sandbox', createdAt: new Date(), expiresAt };
    },
    async getSandboxEndpoint() {
      calls.push('endpoint');
      if (endpointFailure) throw new Error('endpoint unavailable');
      return { endpoint: 'https://sandbox.test/execd', headers: { 'X-Route': 'owned' } };
    },
    async getSandbox() { calls.push('get'); return { id: 'owned-sandbox', expiresAt }; },
    async renewSandboxExpiration(_id: string, { expiresAt: requested }: any) {
      calls.push('renew');
      expiresAt.setTime(new Date(requested).getTime());
      return { expiresAt };
    },
  };
  const factory = {
    createLifecycleStack() { return { sandboxes }; },
    createExecdStack() { return { commands: {}, health: {} }; },
  };
  return { calls, factory, expiresAt };
}

test('SDK adapter records creation before endpoint work and retains the ID on registration failure', async () => {
  const { calls, factory } = fixture();
  const manager = createOpenSandboxManager({ lifecycleBaseUrl: 'https://lifecycle.test/v1', image: 'worker', adapterFactory: factory, waitForExecdReady: false });
  await assert.rejects(manager.ensureExecution({ executionId: 'resource', agentId: 'agent', cleanupOnFailure: false,
    networkPolicy: { defaultAction: 'deny' }, onCreated() { calls.push('record'); throw new Error('storage failed'); } }), /storage failed/);
  assert.deepEqual(calls, ['create', 'record']);
  assert.equal(manager.coreResource('resource').sandboxId, 'owned-sandbox');
});

test('SDK endpoint failure preserves registered ownership without another create', async () => {
  const { calls, factory } = fixture({ endpointFailure: true });
  const manager = createOpenSandboxManager({ lifecycleBaseUrl: 'https://lifecycle.test/v1', image: 'worker', adapterFactory: factory, waitForExecdReady: false });
  const input = { executionId: 'resource', agentId: 'agent', cleanupOnFailure: false, networkPolicy: { defaultAction: 'deny' }, onCreated() { calls.push('record'); } };
  await assert.rejects(manager.ensureExecution(input));
  await assert.rejects(manager.ensureExecution(input), /pending/);
  assert.deepEqual(calls, ['create', 'record', 'endpoint']);
});

test('SDK lost create response keeps the resource pending and prevents redispatch', async () => {
  const { calls, factory } = fixture({ createFailure: true });
  const manager = createOpenSandboxManager({ lifecycleBaseUrl: 'https://lifecycle.test/v1', image: 'worker', adapterFactory: factory, waitForExecdReady: false });
  const input = { executionId: 'resource', agentId: 'agent', networkPolicy: { defaultAction: 'deny' } };
  await assert.rejects(manager.ensureExecution(input));
  await assert.rejects(manager.ensureExecution(input), /pending/);
  assert.equal(manager.coreResource('resource').creation, 'pending');
  assert.deepEqual(calls, ['create']);
});

test('SDK renewal confirms a requested minimum without shortening an existing lease', async () => {
  const { calls, factory, expiresAt } = fixture();
  const manager = createOpenSandboxManager({ lifecycleBaseUrl: 'https://lifecycle.test/v1', image: 'worker', adapterFactory: factory, waitForExecdReady: false });
  await manager.ensureExecution({ executionId: 'resource', agentId: 'agent', networkPolicy: { defaultAction: 'deny' } });
  const existing = expiresAt.getTime();
  assert.equal((await manager.renewExecution('resource', existing - 1000)).expiresAt, new Date(existing).toISOString());
  assert.equal(calls.includes('renew'), false);
  assert.equal((await manager.renewExecution('resource', existing + 60_000)).expiresAt, new Date(existing + 60_000).toISOString());
  assert.deepEqual(calls.slice(-3), ['get', 'renew', 'get']);
});

test('lost renewal response is reconciled against actual expiry', async () => {
  const { calls, factory, expiresAt } = fixture();
  const original = factory.createLifecycleStack;
  factory.createLifecycleStack = () => {
    const stack = original();
    stack.sandboxes.renewSandboxExpiration = async (_id: string, { expiresAt: requested }: any) => {
      expiresAt.setTime(new Date(requested).getTime());
      calls.push('renew-lost');
      throw new Error('renewal response lost');
    };
    return stack;
  };
  const manager = createOpenSandboxManager({ lifecycleBaseUrl: 'https://lifecycle.test/v1', image: 'worker', adapterFactory: factory, waitForExecdReady: false });
  await manager.ensureExecution({ executionId: 'resource', agentId: 'agent', networkPolicy: { defaultAction: 'deny' } });
  const minimum = expiresAt.getTime() + 60_000;
  assert.equal((await manager.renewExecution('resource', minimum)).expiresAt, new Date(minimum).toISOString());
  assert.deepEqual(calls.slice(-3), ['get', 'renew-lost', 'get']);
});

test('official SDK transport rejects lifecycle and Execd redirects before credentials reach another origin', async () => {
  const { createServer } = await import('node:http');
  let foreignRequests = 0;
  const foreign = createServer((_request, response) => { foreignRequests += 1; response.end('{}'); });
  const redirect = createServer((_request, response) => {
    response.writeHead(307, { location: `http://127.0.0.1:${(foreign.address() as any).port}/foreign` });
    response.end();
  });
  const listen = (server: any) => new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  await listen(foreign);
  await listen(redirect);
  const { OpenSandboxSdk, sdkOperation } = await import('../src/core/sandbox/opensandbox-sdk.js');
  const origin = `http://127.0.0.1:${(redirect.address() as any).port}`;
  const sdk = new OpenSandboxSdk({ lifecycleBaseUrl: `${origin}/v1`, apiKey: 'private-lifecycle-key', useServerProxy: false, fetchImpl: globalThis.fetch });
  try {
    await assert.rejects(sdkOperation('preflight', () => sdk.sandboxes.listSandboxes()));
    const execd = sdk.execd({ url: origin, headers: { 'X-EXECD-ACCESS-TOKEN': 'private-execd-key', 'X-Route': 'private-route' } });
    await assert.rejects(sdkOperation('execute', () => execd.commands.run('true')));
    assert.equal(foreignRequests, 0);
  } finally {
    await sdk.close();
    await Promise.all([new Promise<void>(resolve => foreign.close(() => resolve())), new Promise<void>(resolve => redirect.close(() => resolve()))]);
  }
});

test('duplicate creation resources are all registered before any deletion', async () => {
  const { openSandboxAgentKey, openSandboxRuntimeKey } = await import('../src/core/sandbox/opensandbox-metadata.js');
  const calls: string[] = [];
  const metadata = { runtime_key: openSandboxRuntimeKey('runtime'), agent_key: openSandboxAgentKey('agent'), resource_key: openSandboxAgentKey('resource') };
  const factory = {
    createLifecycleStack() {
      return { sandboxes: {
        async listSandboxes() { return { items: ['first', 'second'].map(id => ({ id, metadata })) }; },
        async deleteSandbox(id: string) { calls.push(`delete ${id}`); },
        async getSandbox() { const { SandboxApiException } = await import('@alibaba-group/opensandbox'); throw new SandboxApiException({ statusCode: 404 }); },
      } };
    },
  };
  const manager = createOpenSandboxManager({ lifecycleBaseUrl: 'https://lifecycle.test/v1', image: 'worker', adapterFactory: factory });
  const result = await manager.reconcileExecutions({ runtimeId: 'runtime', agents: [{ runtime_id: 'runtime', agent_id: 'agent', resource_key: 'resource' }],
    onSandboxDiscovered(_agent: unknown, id: string) { calls.push(`record ${id}`); } });
  assert.deepEqual(calls, ['record first', 'record second', 'delete first', 'delete second']);
  assert.deepEqual(result.confirmed_agent_ids, ['agent']);
  assert.deepEqual(result.pending, []);
});

test('known Sandbox omitted by metadata filter is verified before deletion', async () => {
  const calls: string[] = [];
  const factory = { createLifecycleStack() { return { sandboxes: {
    async listSandboxes() { return { items: [] }; },
    async getSandbox() { calls.push('get'); return { metadata: { runtime_key: 'someone-else' } }; },
    async deleteSandbox() { calls.push('delete'); },
  } }; } };
  const manager = createOpenSandboxManager({ lifecycleBaseUrl: 'https://lifecycle.test/v1', image: 'worker', adapterFactory: factory });
  const result = await manager.reconcileExecutions({ runtimeId: 'runtime', agents: [{ runtime_id: 'runtime', agent_id: 'agent', resource_key: 'resource', sandbox_id: 'foreign' }] });
  assert.deepEqual(calls, ['get']);
  assert.equal(result.pending[0].reason, 'provider_identity_mismatch');
});

test('SDK preserves HTTPS endpoint path and scoped route headers without sending the Lifecycle key', async () => {
  const requests: Request[] = [];
  const manager = createOpenSandboxManager({ lifecycleBaseUrl: 'https://management.test/gateway/v1', image: 'worker', apiKey: 'lifecycle-private', waitForExecdReady: false,
    fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url.endsWith('/sandboxes')) return Response.json({ id: 'owned', createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' }, { status: 202 });
      if (request.url.includes('/endpoints/')) return Response.json({ endpoint: 'https://worker.test/prefix/proxy/44772', headers: { 'X-Route': 'sandbox-owned', 'X-EXECD-ACCESS-TOKEN': 'endpoint-private' } });
      if (request.url === 'https://worker.test/prefix/proxy/44772/command') return new Response('{"type":"stdout","text":"ok"}\n{"type":"execution_complete"}\n');
      throw new Error('Unexpected test request');
    } });
  try {
    await manager.ensureExecution({ executionId: 'resource', agentId: 'agent' });
    assert.equal((await manager.exec({ executionId: 'resource', command: ['printf', 'ok'] })).stdout, 'ok');
    assert.equal(requests[0].headers.get('open-sandbox-api-key'), 'lifecycle-private');
    const data = requests.at(-1)!;
    assert.equal(data.headers.get('open-sandbox-api-key'), null);
    assert.equal(data.headers.get('x-route'), 'sandbox-owned');
    assert.equal(data.headers.get('x-execd-access-token'), 'endpoint-private');
    assert.equal(JSON.stringify(manager.snapshot()).includes('endpoint-private'), false);
  } finally { await manager.close(); }
});

test('WorkerClient rejects an older Worker before sending Agent startup', async () => {
  const { WorkerClient } = await import('../src/core/sandbox/worker-client.js');
  const { fileProtocol } = await import('../src/core/files/core-file-seed.js');
  const calls: string[] = [];
  const worker = new WorkerClient({
    executions: new Map([['agent', { agentId: 'agent', workerToken: 'worker-private' }]]), projectInstallReceipts: new Map(),
    resolveEndpoint: async () => ({ url: 'https://worker.test', headers: {} }), checkAgentBoundary: async () => ({}),
    requireManagementAuth: false, useServerProxy: false, workerPort: 44100, commandTimeoutMs: 10_000, logger: null, now: Date.now,
    fetch: async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/health')) return Response.json({ ok: true });
      if (url.endsWith('/core/contract')) return Response.json({ result: { worker_protocol: 'retired-worker', file_protocol: fileProtocol } });
      throw new Error('Startup must not be sent');
    },
  });
  await assert.rejects(worker.startAgent({ executionId: 'agent', command: 'pi', resources: [], requireCoreFileProtocol: true }),
    { code: 'AGENT_STARTUP_CONTRACT' });
  assert.deepEqual(calls, ['https://worker.test/health', 'https://worker.test/core/contract']);
});

test('Worker endpoint route Authorization and Worker token remain independent', async () => {
  const { WorkerClient } = await import('../src/core/sandbox/worker-client.js');
  const { WORKER_PROTOCOL } = await import('../src/core/worker-image.js');
  const received: Headers[] = [];
  const worker = new WorkerClient({
    executions: new Map([['agent', { agentId: 'agent', workerToken: 'worker-private' }]]), projectInstallReceipts: new Map(),
    resolveEndpoint: async () => ({ url: 'https://worker.test', headers: { authorization: 'Bearer route-private' } }), checkAgentBoundary: async () => ({}),
    requireManagementAuth: false, useServerProxy: false, workerPort: 44100, commandTimeoutMs: 10_000, logger: null, now: Date.now,
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      received.push(new Headers(init?.headers));
      if (String(input).endsWith('/health')) return Response.json({ ok: true });
      return Response.json({ result: { contract: { version: WORKER_PROTOCOL, resources: [] }, project_files: { version: 0, writable: false } } });
    },
  });
  await worker.startAgent({ executionId: 'agent', command: 'pi', resources: [] });
  for (const headers of received) {
    assert.equal(headers.get('authorization'), 'Bearer route-private');
    assert.equal(headers.get('x-murm-worker-token'), 'worker-private');
  }
});

test('invalid SDK expiry cannot erase a successfully returned Sandbox ID', async () => {
  const { factory } = fixture();
  const original = factory.createLifecycleStack;
  factory.createLifecycleStack = () => {
    const stack = original();
    const create = stack.sandboxes.createSandbox;
    stack.sandboxes.createSandbox = async (request: unknown) => ({ ...(await create(request)), expiresAt: new Date(Number.NaN) });
    return stack;
  };
  const recorded: unknown[] = [];
  const manager = createOpenSandboxManager({ lifecycleBaseUrl: 'https://lifecycle.test/v1', image: 'worker', adapterFactory: factory, waitForExecdReady: false });
  const resource = await manager.ensureExecution({ executionId: 'resource', agentId: 'agent', networkPolicy: { defaultAction: 'deny' }, onCreated: (value: unknown) => { recorded.push(value); } });
  assert.equal(resource.sandbox_id, 'owned-sandbox');
  assert.equal(resource.expires_at, null);
  assert.equal((recorded[0] as any).sandbox_id, 'owned-sandbox');
  assert.equal(manager.coreResource('resource').creation, 'created');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  ContextService,
  ERROR_CODES,
  JudgeService,
  ServiceRegistry,
  ServicesRouter,
  SwarmEnvError,
  TaskService,
  builtInServiceManifest,
  createBuiltinServiceRegistry,
  createHttpJsonAdapter,
  createServiceHost,
  createServiceManifest,
  makeEnvelope,
} from '../src/index.js';

function schema(properties = {}) {
  return { type: 'object', properties, additionalProperties: false };
}

function manifest({ id = 'fake', endpoint = { transport: 'in-process' }, audience = ['bound', 'recovery'], name = 'echo' } = {}) {
  return createServiceManifest({
    id,
    title: `${id} provider`,
    purpose: `Provider for ${id} tests`,
    provider_version: '1.0.0',
    contract_version: '1',
    endpoint,
    capabilities: [{
      name,
      description: `Run ${name}`,
      input_schema: schema({ value: { type: 'string' } }),
      output_schema: schema({ value: { type: 'string' } }),
      audience,
      side_effect: 'read',
      idempotent: true,
      context: [],
      help: { when: `When ${name} is needed`, ref: `${id}.${name}` },
    }],
  });
}

test('Service Manifest rejects open-ended schemas and duplicate capabilities', () => {
  assert.throws(
    () => createServiceManifest({
      ...manifest(),
      capabilities: [{
        ...manifest().capabilities[0],
        input_schema: { type: 'object', properties: {}, additionalProperties: true },
      }],
    }),
    (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.SERVICE_MANIFEST_INVALID,
  );
  const first = manifest().capabilities[0];
  assert.throws(
    () => createServiceManifest({ ...manifest(), capabilities: [first, first] }),
    (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.SERVICE_MANIFEST_INVALID,
  );
});

test('Service Registry is the source for metadata, role profiles, and invocation', async () => {
  const registry = new ServiceRegistry();
  registry.registerService({
    manifest: manifest({ audience: ['selection'] }),
    adapter: { invoke: async ({ input, envelope }) => ({ value: input.value, operation_id: envelope.operation_id }) },
  });
  registry.registerService({
    manifest: manifest({ id: 'bound-only', audience: ['bound', 'recovery'] }),
    adapter: { invoke: async ({ input }) => ({ value: input.value }) },
  });

  assert.deepEqual(registry.listServices().map((service) => service.service_id), ['bound-only', 'fake']);
  assert.deepEqual(registry.listTools().map((tool) => `${tool.service_id}.${tool.name}`), ['bound-only.echo', 'fake.echo']);
  const selection = registry.getCapabilityProfile('selection');
  assert.equal(selection.capabilities.length, 1);
  assert.equal(selection.capabilities[0].service_id, 'fake');
  assert.equal(selection.profileHash, selection.profile_hash);
  assert.equal(selection.profileHash, registry.getCapabilityProfile('selection').profileHash);
  assert.equal(registry.getCapabilityProfile('bound').capabilities[0].service_id, 'bound-only');
  const envelope = makeEnvelope({ operationId: 'echo-1', actorRef: 'agent:selection' });
  assert.deepEqual(await registry.invoke({ serviceId: 'fake', capability: 'echo', input: { value: 'ok' }, envelope, role: 'selection' }), { value: 'ok', operation_id: 'echo-1' });
  await assert.rejects(
    registry.invoke({ serviceId: 'fake', capability: 'echo', input: { value: 'no' }, envelope, role: 'bound' }),
    (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.SERVICE_CAPABILITY_NOT_ALLOWED,
  );
});

test('HTTP ServiceHost and adapter expose manifest, health, readiness, and structured invocation', async () => {
  const initial = manifest({ id: 'remote', endpoint: { transport: 'http-json', url: 'http://127.0.0.1:0' }, audience: ['selection'] });
  const host = createServiceHost({
    manifest: initial,
    token: 'test-token',
    handler: async ({ capability, input, envelope }) => ({ capability: capability.name, value: input.value, operation_id: envelope.operation_id }),
  });
  const environment = await host.start();
  try {
    const remote = createServiceManifest({ ...initial, endpoint: { transport: 'http-json', url: environment.url } });
    const adapter = createHttpJsonAdapter({ token: 'test-token' });
    const registry = new ServiceRegistry();
    registry.registerService({ manifest: remote, adapter });
    assert.deepEqual((await adapter.health(remote)).ok, true);
    assert.deepEqual((await adapter.readiness(remote)).ok, true);
    const envelope = makeEnvelope({ operationId: 'remote-1', actorRef: 'agent:selection' });
    assert.deepEqual(await registry.invoke({ serviceId: 'remote', capability: 'echo', input: { value: 'remote' }, envelope, role: 'selection' }), { capability: 'echo', value: 'remote', operation_id: 'remote-1' });
    const router = new ServicesRouter({ registry });
    assert.throws(
      () => router.dispatch('echo', { value: 'sync-remote' }, envelope),
      (error) => error.code === ERROR_CODES.SERVICE_UNAVAILABLE && error.details.dispatch === 'dispatchAsync',
    );
    assert.deepEqual(await router.dispatchAsync('echo', { value: 'async-remote' }, envelope), { capability: 'echo', value: 'async-remote', operation_id: 'remote-1' });
    const manifestResponse = await fetch(`${environment.url}/v1/manifest`);
    assert.equal(manifestResponse.status, 200);
    const manifestBody = await manifestResponse.json();
    assert.equal(manifestBody.result.service_id, 'remote');
    const unauthorized = await fetch(`${environment.url}/v1/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ envelope, input: { value: 'no' } }) });
    assert.equal(unauthorized.status, 401);
    const invalid = await fetch(`${environment.url}/v1/echo`, { method: 'POST', headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' }, body: JSON.stringify({ envelope: { actor_ref: 'missing-operation-id' }, input: {}, role: 'selection' }) });
    assert.equal(invalid.status, 400);
    const invalidBody = await invalid.json();
    assert.equal(invalidBody.error.code, ERROR_CODES.INVALID_CONTRACT);

    const missingRole = await fetch(`${environment.url}/v1/echo`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ envelope, input: { value: 'no-role' } }),
    });
    assert.equal(missingRole.status, 403);
    assert.equal((await missingRole.json()).error.code, ERROR_CODES.SERVICE_CAPABILITY_NOT_ALLOWED);

    const mismatchedRole = await fetch(`${environment.url}/v1/echo`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ envelope, input: { value: 'wrong-role' }, role: 'bound' }),
    });
    assert.equal(mismatchedRole.status, 403);
    assert.equal((await mismatchedRole.json()).error.code, ERROR_CODES.SERVICE_CAPABILITY_NOT_ALLOWED);
  } finally {
    await host.stop();
  }
});

test('Registry verifies a remote manifest and readiness before its first invocation', async () => {
  const initial = manifest({ id: 'verified-remote', endpoint: { transport: 'http-json', url: 'http://127.0.0.1:0' }, audience: ['selection'] });
  let ready = true;
  let calls = 0;
  const host = createServiceHost({
    manifest: initial,
    readiness: async () => ready,
    handler: async ({ input }) => {
      calls += 1;
      return { value: input.value };
    },
  });
  const environment = await host.start();
  try {
    const expected = createServiceManifest({ ...initial, endpoint: { transport: 'http-json', url: environment.url } });
    const registry = new ServiceRegistry();
    registry.registerService({ manifest: expected, adapter: createHttpJsonAdapter() });
    const envelope = makeEnvelope({ operationId: 'verified-remote-1', actorRef: 'agent:selection' });
    assert.deepEqual(await registry.invoke({ serviceId: 'verified-remote', capability: 'echo', input: { value: 'ok' }, envelope, role: 'selection' }), { value: 'ok' });
    assert.equal(calls, 1);
    assert.equal(registry.getService('verified-remote').ready, true);

    ready = false;
    await assert.rejects(
      registry.checkReadiness('verified-remote'),
      (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.SERVICE_NOT_READY,
    );
  } finally {
    await host.stop();
  }
});

test('Registry refuses a remote provider whose advertised manifest differs from the registered contract', async () => {
  const initial = manifest({ id: 'untruthful-remote', endpoint: { transport: 'http-json', url: 'http://127.0.0.1:0' }, audience: ['selection'] });
  const host = createServiceHost({ manifest: initial, handler: async () => ({ ok: true }) });
  const environment = await host.start();
  try {
    const mismatched = createServiceManifest({
      ...initial,
      title: 'a different provider',
      endpoint: { transport: 'http-json', url: environment.url },
    });
    const registry = new ServiceRegistry();
    registry.registerService({ manifest: mismatched, adapter: createHttpJsonAdapter() });
    const envelope = makeEnvelope({ operationId: 'untruthful-remote-1', actorRef: 'agent:selection' });
    await assert.rejects(
      registry.invoke({ serviceId: 'untruthful-remote', capability: 'echo', input: {}, envelope, role: 'selection' }),
      (error) => error instanceof SwarmEnvError
        && error.code === ERROR_CODES.SERVICE_MANIFEST_INVALID
        && error.details?.expected_manifest_hash === mismatched.manifest_hash,
    );
  } finally {
    await host.stop();
  }
});

test('built-in Task, Context, Judge, and Catalog providers can all be replaced by independent HTTP hosts', async () => {
  const domain = [
    { id: 'task', token: 'task-token' },
    { id: 'context', token: 'context-token' },
    { id: 'judge', token: 'judge-token' },
    { id: 'catalog', token: 'catalog-token' },
  ];
  const databases = domain.slice(0, 3).map(() => new DatabaseSync(':memory:'));
  const taskService = new TaskService(databases[0]);
  const contextService = new ContextService(databases[1]);
  const judgeService = new JudgeService(databases[2], { checker: { async check() { return { verdict: 'PASS' }; } } });
  const services = { task: taskService, context: contextService, judge: judgeService };
  const hosts = [];
  const endpoints = {};
  try {
    for (const { id, token } of domain) {
      const initial = builtInServiceManifest(id, { endpoint: { transport: 'http-json', url: 'http://127.0.0.1:0' } });
      const host = createServiceHost({
        manifest: initial,
        token,
        trusted: true,
        handler: async ({ capability, input, envelope }) => {
          if (id === 'catalog') {
            if (capability.operation === 'list_services') return { services: [] };
            if (capability.operation === 'list_tools') return { tools: [] };
            return null;
          }
          return services[id].dispatch(capability.operation, input, envelope);
        },
      });
      const environment = await host.start();
      hosts.push(host);
      const manifestResponse = await fetch(`${environment.url}/v1/manifest`);
      assert.equal(manifestResponse.status, 200);
      assert.equal((await manifestResponse.json()).result.service_id, id);
      endpoints[id] = {
        url: environment.url,
        token,
        manifest: builtInServiceManifest(id, { endpoint: { transport: 'http-json', url: environment.url } }),
      };
    }

    const registry = createBuiltinServiceRegistry({ taskService, contextService, judgeService, serviceEndpoints: endpoints });
    assert.deepEqual(registry.listServices().map((service) => service.service_id), ['catalog', 'context', 'judge', 'task']);
    for (const id of ['task', 'context', 'judge', 'catalog']) {
      assert.equal(registry.getService(id).adapter.kind, 'http-json');
      assert.equal((await registry.checkHealth(id)).ok, true);
      assert.equal((await registry.checkReadiness(id)).ok, true);
    }
    const taskResult = await registry.invoke({
      serviceId: 'task', capability: 'list_tasks', input: { limit: 1 },
      envelope: makeEnvelope({ operationId: 'remote-task-list', actorRef: 'agent:selection' }), role: 'selection',
    });
    assert.ok(Array.isArray(taskResult));
    const contextResult = await registry.invoke({
      serviceId: 'context', capability: 'read_materials', input: {},
      envelope: makeEnvelope({ operationId: 'remote-context-read', actorRef: 'agent:bound', taskId: 'task-1', executionId: 'exec-1' }), role: 'bound',
    });
    assert.ok(Array.isArray(contextResult.materials ?? contextResult));
    const judgeResult = await registry.invoke({
      serviceId: 'judge', capability: 'get_check_result', input: { check_result_id: 'missing-check' },
      envelope: makeEnvelope({ operationId: 'remote-judge-read', actorRef: 'agent:bound', taskId: 'task-1', executionId: 'exec-1' }), role: 'bound',
    });
    assert.equal(judgeResult, null);
    const catalogResult = await registry.invoke({
      serviceId: 'catalog', capability: 'list_tools', input: {},
      envelope: makeEnvelope({ operationId: 'remote-catalog-list', actorRef: 'agent:selection' }), role: 'selection',
    });
    assert.deepEqual(catalogResult, { tools: [] });
  } finally {
    await Promise.all(hosts.map((host) => host.stop()));
    judgeService.close();
    contextService.close();
    taskService.close();
    databases.forEach((database) => { try { database.close(); } catch {} });
  }
});

test('capability IDs keep same-operation providers addressable without namespace guessing', async () => {
  const alphaBase = manifest({ id: 'alpha', name: 'search', audience: ['selection'] });
  const alpha = createServiceManifest({
    ...alphaBase,
    capabilities: [{ ...alphaBase.capabilities[0], operation: 'echo' }],
  });
  const beta = createServiceManifest({
    ...alpha,
    id: 'beta',
    title: 'beta provider',
    capabilities: [{ ...alpha.capabilities[0], name: 'search_beta', operation: 'echo' }],
  });
  const calls = [];
  const registry = new ServiceRegistry();
  registry.registerService({ manifest: alpha, adapter: { invoke: async () => { calls.push('alpha'); return 'a'; } } });
  registry.registerService({ manifest: beta, adapter: { invoke: async () => { calls.push('beta'); return 'b'; } } });
  const envelope = makeEnvelope({ operationId: 'capability-id', actorRef: 'agent:selection' });
  assert.equal(await registry.invoke({ capability_id: 'beta.search_beta', input: {}, envelope, role: 'selection' }), 'b');
  assert.deepEqual(calls, ['beta']);
  assert.deepEqual(registry.getCapabilityById('alpha.search').capability.name, 'search');
});

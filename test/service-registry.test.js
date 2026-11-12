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

const directJudgeFixture = {
  fixture_id: 'direct-judge-http',
  putnambench_commit: 'a'.repeat(40),
  problem_file: 'src/problem.lean',
  problem_file_hash: 'b'.repeat(64),
  lean_toolchain: 'leanprover/lean4:v4.33.1',
  mathlib_version: 'test-mathlib',
  checker_ref: 'lean',
  checker_version: 'mvp-1',
  environment_ref: 'env:direct-http',
  project_root: '/tmp/direct-judge-http',
};

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
    manifest: manifest({ audience: ['recovery'] }),
    adapter: { invoke: async ({ input, envelope }) => ({ value: input.value, operation_id: envelope.operation_id }) },
  });
  registry.registerService({
    manifest: manifest({ id: 'bound-only', audience: ['bound', 'recovery'] }),
    adapter: { invoke: async ({ input }) => ({ value: input.value }) },
  });

  assert.deepEqual(registry.listServices().map((service) => service.service_id), ['bound-only', 'fake']);
  assert.deepEqual(registry.listTools().map((tool) => `${tool.service_id}.${tool.name}`), ['bound-only.echo', 'fake.echo']);
  const boundProfile = registry.getCapabilityProfile('bound');
  assert.equal(boundProfile.capabilities.length, 1);
  assert.equal(boundProfile.capabilities[0].service_id, 'bound-only');
  assert.equal(boundProfile.profileHash, boundProfile.profile_hash);
  assert.equal(boundProfile.profileHash, registry.getCapabilityProfile('bound').profileHash);
  const recoveryProfile = registry.getCapabilityProfile('recovery');
  assert.deepEqual(recoveryProfile.capabilities.map((capability) => capability.service_id), ['bound-only', 'fake']);
  const envelope = makeEnvelope({ operationId: 'echo-1', actorRef: 'agent:recovery' });
  assert.deepEqual(await registry.invoke({ serviceId: 'fake', capability: 'echo', input: { value: 'ok' }, envelope, role: 'recovery' }), { value: 'ok', operation_id: 'echo-1' });
  await assert.rejects(
    registry.invoke({ serviceId: 'fake', capability: 'echo', input: { value: 'no' }, envelope: makeEnvelope({ operationId: 'echo-no', actorRef: 'agent:bound' }), role: 'bound' }),
    (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.SERVICE_CAPABILITY_NOT_ALLOWED,
  );
});

test('HTTP ServiceHost and adapter expose manifest, health, readiness, and structured invocation', async () => {
  const initial = manifest({ id: 'remote', endpoint: { transport: 'http-json', url: 'http://127.0.0.1:0' }, audience: ['bound'] });
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
    const envelope = makeEnvelope({ operationId: 'remote-1', actorRef: 'agent:bound' });
    assert.deepEqual(await registry.invoke({ serviceId: 'remote', capability: 'echo', input: { value: 'remote' }, envelope, role: 'bound' }), { capability: 'echo', value: 'remote', operation_id: 'remote-1' });
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
    const invalid = await fetch(`${environment.url}/v1/echo`, { method: 'POST', headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' }, body: JSON.stringify({ envelope: { actor_ref: 'missing-operation-id' }, input: {}, role: 'bound' }) });
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
      body: JSON.stringify({ envelope, input: { value: 'wrong-role' }, role: 'recovery' }),
    });
    assert.equal(mismatchedRole.status, 403);
    assert.equal((await mismatchedRole.json()).error.code, ERROR_CODES.SERVICE_CAPABILITY_NOT_ALLOWED);
  } finally {
    await host.stop();
  }
});

test('Registry verifies a remote manifest and readiness before its first invocation', async () => {
  const initial = manifest({ id: 'verified-remote', endpoint: { transport: 'http-json', url: 'http://127.0.0.1:0' }, audience: ['bound'] });
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
    const envelope = makeEnvelope({ operationId: 'verified-remote-1', actorRef: 'agent:bound' });
    assert.deepEqual(await registry.invoke({ serviceId: 'verified-remote', capability: 'echo', input: { value: 'ok' }, envelope, role: 'bound' }), { value: 'ok' });
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
  const initial = manifest({ id: 'untruthful-remote', endpoint: { transport: 'http-json', url: 'http://127.0.0.1:0' }, audience: ['bound'] });
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
    const envelope = makeEnvelope({ operationId: 'untruthful-remote-1', actorRef: 'agent:bound' });
    await assert.rejects(
      registry.invoke({ serviceId: 'untruthful-remote', capability: 'echo', input: {}, envelope, role: 'bound' }),
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
    const boundProfile = registry.getCapabilityProfile('bound');
    assert.ok(boundProfile.capabilities.some((capability) => capability.service_id === 'task' && capability.operation === 'task_block'));
    for (const id of ['task', 'context', 'judge', 'catalog']) {
      assert.equal(registry.getService(id).adapter.kind, 'http-json');
      assert.equal((await registry.checkHealth(id)).ok, true);
      assert.equal((await registry.checkReadiness(id)).ok, true);
    }
    const taskResult = await registry.invoke({
      serviceId: 'task', capability: 'list_tasks', input: { limit: 1 },
      envelope: makeEnvelope({ operationId: 'remote-task-list', actorRef: 'agent:bound' }), role: 'bound',
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
      envelope: makeEnvelope({ operationId: 'remote-catalog-list', actorRef: 'agent:bound' }), role: 'bound',
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

test('hosted Judge accepts the same direct Workspace source contract as in-process Judge', async () => {
  const judge = new JudgeService(new DatabaseSync(':memory:'), {
    fixtureManifest: directJudgeFixture,
    checker: {
      preflight: async () => ({ status: 'healthy', checker_process_status: 'completed', evidence: {} }),
      check: async () => ({ verdict: 'PASS', evidence: { checker_started: true, exit_code: 0 } }),
    },
  });
  const token = 'direct-judge-token';
  const initial = builtInServiceManifest('judge', { endpoint: { transport: 'http-json', url: 'http://127.0.0.1:0' } });
  const host = createServiceHost({
    manifest: initial,
    token,
    handler: ({ capability, input, envelope }) => judge.dispatch(capability.operation, input, envelope),
  });
  const environment = await host.start();
  const registeredManifest = createServiceManifest({ ...initial, endpoint: { transport: 'http-json', url: environment.url } });
  const registry = new ServiceRegistry();
  registry.registerService({ manifest: registeredManifest, adapter: createHttpJsonAdapter({ token }), trusted: true });
  try {
    const result = await registry.invoke({
      serviceId: 'judge',
      capability: 'judge_submit_candidate',
      input: { source: { path: 'Candidate.lean', workspace_revision: 1, content: 'theorem direct : True := by trivial' } },
      envelope: makeEnvelope({ operationId: 'direct-judge-http-submit', actorRef: 'agent:bound', taskId: 'task:http', executionId: 'execution:http', specVersion: 1, stateVersion: 1, fencingVersion: 1 }),
      role: 'bound',
    });
    assert.equal(result.verdict, 'PASS');
    assert.equal(result.result_class, 'PASS');
  } finally {
    await host.stop();
    judge.close();
  }
});

test('capability IDs keep same-operation providers addressable without namespace guessing', async () => {
  const alphaBase = manifest({ id: 'alpha', name: 'search', audience: ['bound'] });
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
  const envelope = makeEnvelope({ operationId: 'capability-id', actorRef: 'agent:bound' });
  assert.equal(await registry.invoke({ capability_id: 'beta.search_beta', input: {}, envelope, role: 'bound' }), 'b');
  assert.deepEqual(calls, ['beta']);
  assert.deepEqual(registry.getCapabilityById('alpha.search').capability.name, 'search');
});

test('registry resolves bounded service help and rejects arbitrary paths', () => {
  const serviceManifest = createServiceManifest({
    id: 'doc-service', title: 'Documented service', purpose: 'A test capability',
    provider_version: '1.2.3', endpoint: { transport: 'in-process' },
    capabilities: [{
      name: 'lookup', operation: 'lookup', description: 'Look up a value',
      audience: ['bound'], side_effect: 'read', idempotent: true, context: ['task'],
      help: { when: 'Use for lookup', ref: 'service://doc-service/lookup', text: 'Use the locked index; retry only on RETRYABLE.' },
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
      output_schema: { type: 'object', properties: {}, additionalProperties: false },
    }],
  });
  const registry = new ServiceRegistry();
  registry.registerService({ manifest: serviceManifest, adapter: { invoke: async () => ({}) } });
  const resolved = registry.resolveHelpRef('service://doc-service/lookup');
  assert.equal(resolved.text, 'Use the locked index; retry only on RETRYABLE.');
  assert.equal(resolved.provider_version, '1.2.3');
  assert.throws(() => registry.resolveHelpRef('/etc/passwd'), /service:\/\//);
  assert.throws(() => registry.resolveHelpRef('service://doc-service/../secret'), /invalid service resource path/);
});

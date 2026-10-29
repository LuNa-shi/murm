import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  AGENT_ROLES,
  ServicesBridge,
  ServiceRegistry,
  createHttpJsonAdapter,
  createMathlibSearchManifest,
  createMathlibSearchService,
  createServiceManifest,
  createServiceHost,
  buildCapabilityProfile,
  composeAgentPrompt,
  makeEnvelope,
  registerUserService,
  createBuiltinServiceRegistry,
  runtimeCapabilityList,
} from '../src/index.js';
import swarmenvExtension from '../src/agent/swarmenv-extension.mjs';

async function sourceFixture() {
  const root = await mkdtemp(join(tmpdir(), 'swarmenv-mathlib-'));
  await writeFile(join(root, 'Algebra.lean'), [
    'namespace Mathlib',
    'theorem add_comm_demo (a b : Nat) : a + b = b + a := by omega',
    'def add_helper (a b : Nat) := a + b',
    'end Mathlib',
  ].join('\n'));
  await writeFile(join(root, 'Geometry.lean'), 'theorem distance_nonneg_demo (x : Nat) : 0 ≤ x := by omega\n');
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('Mathlib Search Service indexes a locked Lean source root with a bounded stable result shape', async () => {
  const fixture = await sourceFixture();
  try {
    const provider = createMathlibSearchService({ sourceRoot: fixture.root, mathlibRevision: 'mathlib-test', leanVersion: 'lean-test' });
    assert.equal(provider.manifest.service_id, 'mathlib-search');
    assert.equal(provider.manifest.capabilities[0].name, 'mathlib_search');
    assert.deepEqual(await provider.readiness(), true);
    const result = await provider.service.search({ query: 'add_comm', max_results: 1 });
    assert.equal(result.backend, 'source-index');
    assert.equal(result.result_count, 1);
    assert.equal(result.results[0].name, 'add_comm_demo');
    assert.equal(result.mathlib_revision, 'mathlib-test');
    await assert.rejects(() => provider.service.search({ query: 'x', max_results: 0 }), /max_results/);
    await assert.rejects(() => provider.service.search({ query: '' }), /query is required/);
  } finally {
    await fixture.cleanup();
  }
});

test('Mathlib Search Service crosses the independent HTTP Host and Registry adapter boundary', async () => {
  const fixture = await sourceFixture();
  const provider = createMathlibSearchService({
    sourceRoot: fixture.root,
    endpoint: { transport: 'http-json', url: 'http://127.0.0.1:0' },
    mathlibRevision: 'mathlib-http-test',
  });
  const host = createServiceHost({ manifest: provider.manifest, handler: provider.handler, readiness: provider.readiness, token: 'mathlib-test-token' });
  const environment = await host.start();
  try {
    const manifest = createMathlibSearchManifest({
      endpoint: { transport: 'http-json', url: environment.url },
      mathlibRevision: 'mathlib-http-test',
    });
    const registry = new ServiceRegistry();
    registerUserService(registry, { manifest, adapter: createHttpJsonAdapter({ token: 'mathlib-test-token' }) });
    const profile = buildCapabilityProfile({ role: AGENT_ROLES.BOUND, registry });
    assert.deepEqual(profile.capabilities.map((capability) => capability.name), ['mathlib_search']);
    const prompt = composeAgentPrompt({ role: AGENT_ROLES.BOUND, profile });
    assert.match(prompt, /Mathlib Search/);
    assert.match(prompt, /mathlib_search/);
    assert.match(prompt, /before proposing a proof/);
    const registeredTools = [];
    await swarmenvExtension({ registerTool(tool) { registeredTools.push(tool); } }, { profile });
    assert.deepEqual(registeredTools.map((tool) => tool.name), ['swarmenv_mathlib_search']);
    assert.ok(!registeredTools.some((tool) => tool.name === 'swarmenv_call'));
    const result = await registry.invoke({
      serviceId: 'mathlib-search',
      capability: 'mathlib_search',
      input: { query: 'distance_nonneg', max_results: 2 },
      envelope: makeEnvelope({ operationId: 'mathlib-http-1', actorRef: 'agent:bound', taskId: 'task-1', executionId: 'execution-1' }),
      role: AGENT_ROLES.BOUND,
    });
    assert.equal(result.backend, 'source-index');
    assert.equal(result.results[0].name, 'distance_nonneg_demo');
    await assert.rejects(
      registry.invoke({ serviceId: 'mathlib-search', capability: 'mathlib_search', input: { query: 'x' }, envelope: makeEnvelope({ operationId: 'mathlib-selection-1', actorRef: 'agent:selection' }), role: AGENT_ROLES.SELECTION }),
      /not available to role selection/,
    );
    const manifestResponse = await fetch(`${environment.url}/v1/manifest`);
    assert.equal(manifestResponse.status, 200);
    assert.equal((await manifestResponse.json()).result.service_id, 'mathlib-search');
  } finally {
    await host.stop();
    await fixture.cleanup();
  }
});

test('Registry controls multiple independently hosted Services through separate adapters', async () => {
  const calls = [];
  const manifestFor = (id, name) => createServiceManifest({
    id,
    title: `${id} provider`,
    purpose: `Independent ${id} capability provider`,
    provider_version: 'test-1',
    contract_version: '1',
    endpoint: { transport: 'http-json', url: 'http://127.0.0.1:0' },
    capabilities: [{
      name,
      description: `Invoke ${id}`,
      audience: ['bound', 'recovery'],
      side_effect: 'read',
      idempotent: true,
      context: ['task'],
      help: { when: `Use ${id}`, ref: `service://${id}/${name}` },
      input_schema: { type: 'object', properties: { value: { type: 'string' } }, additionalProperties: false },
      output_schema: { type: 'object', properties: { service_id: { type: 'string' }, value: { type: 'string' } }, additionalProperties: false },
      path: `/v1/${name}`,
    }],
  });
  const definitions = [
    { id: 'user-task', name: 'discover', result: 'task-service' },
    { id: 'user-context', name: 'read', result: 'context-service' },
    { id: 'user-judge', name: 'check', result: 'judge-service' },
  ];
  const hosts = [];
  const registry = new ServiceRegistry();
  try {
    for (const definition of definitions) {
      const initial = manifestFor(definition.id, definition.name);
      const host = createServiceHost({
        manifest: initial,
        token: `${definition.id}-token`,
        handler: async ({ manifest, input }) => {
          calls.push({ service_id: manifest.service_id, value: input.value });
          return { service_id: manifest.service_id, value: definition.result };
        },
      });
      const environment = await host.start();
      hosts.push(host);
      const manifest = createServiceManifest({ ...initial, endpoint: { transport: 'http-json', url: environment.url } });
      registerUserService(registry, { manifest, token: `${definition.id}-token` });
      assert.equal((await registry.checkHealth(definition.id)).ok, true);
      assert.equal((await registry.checkReadiness(definition.id)).ok, true);
    }

    const profile = buildCapabilityProfile({ role: AGENT_ROLES.BOUND, registry });
    assert.deepEqual(profile.capabilities.map((capability) => capability.name), ['read', 'check', 'discover']);
    const envelope = makeEnvelope({ operationId: 'multi-service-1', actorRef: 'agent:bound', taskId: 'task-1', executionId: 'execution-1' });
    const results = await Promise.all(definitions.map((definition) => registry.invoke({
      serviceId: definition.id,
      capability: definition.name,
      input: { value: 'same request shape' },
      envelope: { ...envelope, operation_id: `multi-service-${definition.id}` },
      role: AGENT_ROLES.BOUND,
    })));
    assert.deepEqual(results.map((result) => result.service_id), ['user-task', 'user-context', 'user-judge']);
    assert.deepEqual(calls, [
      { service_id: 'user-task', value: 'same request shape' },
      { service_id: 'user-context', value: 'same request shape' },
      { service_id: 'user-judge', value: 'same request shape' },
    ]);
  } finally {
    await Promise.all(hosts.map((host) => host.stop()));
  }
});

test('Bound Agent Bridge invokes a registered user Service without a generic service-call tool', async () => {
  const registry = new ServiceRegistry();
  registry.registerService({
    manifest: createMathlibSearchManifest({ endpoint: { transport: 'in-process' } }),
    adapter: {
      async invoke({ input, envelope }) {
        return { result: [{ name: 'Nat.add_comm' }], query: input.query, actor_ref: envelope.actor_ref };
      },
    },
  });
  const taskService = {
    getTask: () => ({ task_id: 'task-1', spec_version: 1, state_version: 2 }),
    getExecution: () => ({ execution_id: 'execution-1', task_id: 'task-1', spec_version: 1, state_version: 3, fencing_version: 1 }),
  };
  const bridge = new ServicesBridge({
    taskService,
    contextService: {},
    runtime: {},
    registry,
    taskId: 'task-1',
    executionId: 'execution-1',
    actorRef: 'agent:bound',
    runtimeCapabilities: [],
  });
  try {
    const profile = bridge.getCapabilityProfile();
    assert.deepEqual(profile.capabilities.map((capability) => capability.name), ['mathlib_search']);
    const result = await bridge.call({ operation: 'mathlib_search', payload: { query: 'commutativity' } });
    assert.equal(result.query, 'commutativity');
    assert.equal(result.result[0].name, 'Nat.add_comm');
    assert.equal(result.actor_ref, 'agent:bound');
    await assert.rejects(() => bridge.call({ operation: 'swarmenv_call', payload: {} }), /not available/);
  } finally {
    await bridge.stop();
  }
});

test('Built-in Registry exposes the current Task contract without legacy lifecycle capabilities', () => {
  const fake = { dispatch() { return {}; } };
  const registry = createBuiltinServiceRegistry({ taskService: fake, contextService: fake, judgeService: fake });
  const profile = buildCapabilityProfile({ role: AGENT_ROLES.BOUND, registry, runtimeCapabilities: runtimeCapabilityList() });
  const names = profile.capabilities.map((capability) => capability.name);
  assert.ok(names.includes('task_complete'));
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.includes('task_view'));
  assert.ok(!names.some((name) => /wait|wake|rework|select_task/i.test(name)));
  assert.doesNotMatch(JSON.stringify(profile), /WAITING|request_wait|parent_review|wake_execution/i);

  const selectionProfile = buildCapabilityProfile({ role: AGENT_ROLES.SELECTION, registry });
  const selectionNames = selectionProfile.capabilities.map((capability) => capability.name);
  assert.ok(selectionNames.includes('task_discover'));
  assert.ok(selectionNames.includes('task_view'));
  assert.ok(selectionNames.includes('task_claim'));
  assert.ok(!selectionNames.includes('task_list_executions'));
  assert.ok(!selectionNames.includes('context_read'));
  assert.ok(!selectionNames.includes('judge_get_check_result'));
});


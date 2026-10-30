import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  ContextService,
  AGENT_ROLES,
  JudgeService,
  ServiceRegistry,
  ServicesBridge,
  ServicesRouter,
  ServicesSDK,
  TaskService,
  createBuiltinServiceRegistry,
  createHttpJsonAdapter,
  createServiceHost,
  createServiceManifest,
} from '../src/index.js';
import { makeEnvelope } from '../src/protocol/envelope.js';

function fixture() {
  return {
    fixture_id: 'putnam-1966-a1',
    putnambench_commit: 'a635813f5edf297d928f9bd5ef8324a26bdde09c',
    problem_file: 'lean4/src/putnam_1966_a1.lean',
    problem_file_hash: '4b1bd530669e71e5909398d54caddeb65eb33a708850e25ba4f1d7fc88ba0cad',
    lean_toolchain: 'leanprover/lean4:v4.33.1',
    mathlib_version: '0df444a360eaa60ab8c11dca51a86af692955474',
    checker_ref: 'lean', checker_version: 'mvp-1', environment_ref: 'putnambench-lean4@a635813f5edf297d928f9bd5ef8324a26bdde09c',
  };
}

test('ServicesBridge exposes public SDK calls over a loopback token and keeps Runtime lifecycle internal', async () => {
  const database = new DatabaseSync(':memory:');
  const contextService = new ContextService(database);
  const taskService = new TaskService(database, { contextService });
  contextService.taskService = taskService;
  const router = new ServicesRouter({ taskService, contextService });
  const owner = new ServicesSDK(router, { actorRef: 'owner:root' });
  const task = owner.proposeTask({
    task_type: 'proof', goal: 'bridge test', expected_output: 'artifact', acceptance_conditions: {}, owner_ref: 'owner:root',
    completion_contract: { required_candidate: { kind: 'artifact', scope: 'proof_relevant' }, required_check: { checker_ref: 'lean', checker_version: 'mvp-1', environment_ref: fixture().environment_ref } },
  }, { operationId: 'bridge:propose' }).task;
  owner.withContext({ taskId: task.task_id, specVersion: task.spec_version, stateVersion: task.state_version }).claim({
    execution_id: 'bridge-execution', claim_key: 'bridge:claim', owner_ref: 'agent:bridge', agent_prompt: 'bridge', input_material_refs: [],
  }, { operationId: 'bridge:claim' });
  const runtime = {};
  const bridge = new ServicesBridge({ taskService, contextService, runtime, router, taskId: task.task_id, executionId: 'bridge-execution' });
  const environment = await bridge.start();
  try {
    const unauthorized = await fetch(`${environment.SWARMENV_BRIDGE_URL}/call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'get_task', payload: {} }) });
    assert.equal(unauthorized.status, 401);
    const read = await fetch(`${environment.SWARMENV_BRIDGE_URL}/call`, { method: 'POST', headers: { authorization: `Bearer ${environment.SWARMENV_BRIDGE_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'get_execution', payload: {} }) });
    assert.equal(read.status, 200);
    assert.equal((await read.json()).result.execution_id, 'bridge-execution');
    const published = await fetch(`${environment.SWARMENV_BRIDGE_URL}/call`, { method: 'POST', headers: { authorization: `Bearer ${environment.SWARMENV_BRIDGE_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'publish_material', payload: { kind: 'artifact', scope: 'proof_relevant', content: 'theorem bridge : True := by trivial' } }) });
    const publishedBody = await published.json();
    assert.equal(published.status, 200);
    assert.equal(publishedBody.result.material.kind, 'artifact');
    const consumed = await fetch(`${environment.SWARMENV_BRIDGE_URL}/call`, { method: 'POST', headers: { authorization: `Bearer ${environment.SWARMENV_BRIDGE_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'consume_materials', payload: { material_ids: [publishedBody.result.material.material_id], action: 'task', action_ref: 'bridge-test' } }) });
    const consumedBody = await consumed.json();
    assert.equal(consumed.status, 200);
    assert.deepEqual(consumedBody.result.material_ids, [publishedBody.result.material.material_id]);
    assert.equal(bridge.taskId, task.task_id);
    assert.equal(bridge.executionId, 'bridge-execution');
  } finally {
    await bridge.stop();
    taskService.close();
  }
});

test('ServicesBridge releases the original binding when bindClaim handoff fails', async () => {
  const database = new DatabaseSync(':memory:');
  const contextService = new ContextService(database);
  const taskService = new TaskService(database, { contextService });
  contextService.taskService = taskService;
  const released = [];
  const bridge = new ServicesBridge({
    taskService,
    contextService,
    runtime: {},
    router: new ServicesRouter({ taskService, contextService }),
    onClaim: async () => { throw new Error('handoff failed'); },
    onRelease: async (value) => released.push(value),
  });
  try {
    await assert.rejects(
      () => bridge.bindClaim({ task: { task_id: 'bind-failure-task' }, execution: { execution_id: 'bind-failure-execution' } }),
      /handoff failed/,
    );
    assert.equal(bridge.taskId, null);
    assert.equal(bridge.executionId, null);
    assert.deepEqual(released, [{ taskId: 'bind-failure-task', executionId: 'bind-failure-execution', result: null }]);
  } finally {
    await bridge.stop();
    taskService.close();
  }
});

test('ServicesBridge returns structured tool errors and exposes them to audit hooks', async () => {
  const database = new DatabaseSync(':memory:');
  const contextService = new ContextService(database);
  const taskService = new TaskService(database, { contextService });
  contextService.taskService = taskService;
  const errors = [];
  const bridge = new ServicesBridge({
    taskService,
    contextService,
    runtime: {},
    router: new ServicesRouter({ taskService, contextService }),
    onError: async (error) => errors.push(error),
  });
  try {
    await assert.rejects(() => bridge.call({ operation: 'host_shell', payload: {} }), (error) => error.code === 'NOT_ALLOWED');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].operation, 'host_shell');
    assert.equal(errors[0].error.code, 'NOT_ALLOWED');
  } finally {
    await bridge.stop();
    taskService.close();
  }
});

test('ServicesBridge invokes a registered HTTP capability through its adapter', async () => {
  const initial = createServiceManifest({
    id: 'remote_math',
    title: 'Remote Math Service',
    purpose: 'Remote capability used by the bound Agent.',
    provider_version: '1.0.0',
    contract_version: '1',
    endpoint: { transport: 'http-json', url: 'http://127.0.0.1:0' },
    capabilities: [{
      name: 'remote_echo', operation: 'remote_echo', description: 'Echo a bounded value.',
      input_schema: { type: 'object', properties: { value: { type: 'string' } }, additionalProperties: false },
      output_schema: { type: 'object', properties: { value: { type: 'string' } }, additionalProperties: false },
      audience: ['bound'], side_effect: 'read', idempotent: true, context: ['task', 'execution'],
      help: { when: 'Use for the remote capability smoke test.', ref: 'service://remote_math/remote_echo' },
    }],
  });
  const host = createServiceHost({
    manifest: initial,
    token: 'remote-token',
    handler: async ({ input, envelope }) => ({ value: input.value, operation_id: envelope.operation_id }),
  });
  const environment = await host.start();
  const manifest = createServiceManifest({ ...initial, endpoint: { transport: 'http-json', url: environment.url } });
  const registry = new ServiceRegistry();
  registry.registerService({ manifest, adapter: createHttpJsonAdapter({ token: 'remote-token' }) });
  const bridge = new ServicesBridge({
    taskService: { getTask: () => null, getExecution: () => null },
    contextService: {},
    runtime: {},
    registry,
    taskId: 'task-remote',
    executionId: 'execution-remote',
  });
  try {
    const result = await bridge.call({ operation: 'remote_echo', payload: { value: 'through-http' } });
    assert.deepEqual(result, { value: 'through-http', operation_id: result.operation_id });
    assert.match(result.operation_id, /^bridge:remote_echo:/);
  } finally {
    await bridge.stop();
    await host.stop();
  }
});

test('ServicesBridge invokes registered Task completion by capability ID after profile name disambiguation', async () => {
  const calls = [];
  const registry = createBuiltinServiceRegistry({
    taskService: { dispatch: () => ({}) },
    contextService: { dispatch: () => ({}) },
    serviceEndpoints: {
      task: {
        endpoint: { transport: 'in-process' },
        adapter: {
      invoke: async ({ capability, envelope }) => {
        calls.push({ name: capability.name, operation: capability.operation, task_id: envelope.task_id });
        return { remote: true, task_id: envelope.task_id };
      },
        },
      },
    },
  });
  const released = [];
  const bridge = new ServicesBridge({
    taskService: {
      getTask: () => ({ task_id: 'task-remote-complete', mission_id: 'mission-remote-complete' }),
      getExecution: () => ({ execution_id: 'execution-remote-complete', task_id: 'task-remote-complete', state: 'RUNNING' }),
    },
    contextService: {},
    runtime: {},
    registry,
    taskId: 'task-remote-complete',
    executionId: 'execution-remote-complete',
    onRelease: async (value) => released.push(value),
  });
  try {
    const result = await bridge.call({ operation: 'task_complete', payload: {} });
    assert.deepEqual(result, { remote: true, task_id: 'task-remote-complete' });
    assert.deepEqual(calls, [{ name: 'task_complete', operation: 'task_complete', task_id: 'task-remote-complete' }]);
    assert.equal(released.length, 1);
    assert.equal(bridge.taskId, null);
    assert.equal(bridge.executionId, null);
  } finally {
    await bridge.stop();
  }
});

test('ServicesBridge routes modern task_block through Runtime lifecycle cleanup', async () => {
  const database = new DatabaseSync(':memory:');
  const contextService = new ContextService(database);
  const taskService = new TaskService(database, { contextService });
  contextService.taskService = taskService;
  const router = new ServicesRouter({ taskService, contextService });
  const owner = new ServicesSDK(router, { actorRef: 'owner:modern-block' });
  const mission = owner.createMission({
    mission_id: 'mission:modern-block',
    goal: 'exercise modern typed blocking',
    acceptance_conditions: { route: 'modern-block' },
  }, { operationId: 'modern-block:mission' }).mission;
  const task = owner.createTask({
    mission_id: mission.mission_id,
    summary: 'Coordinate a modern typed dependency block for the proof route',
    task_type: 'research',
    goal: 'wait for a prerequisite Task',
    expected_output: 'a bounded route result',
    acceptance_conditions: { route: 'modern-block-task' },
    completion_contract: { normal_flow: true },
  }, { operationId: 'modern-block:task' }).task;
  const claim = owner.withContext({ taskId: task.task_id, specVersion: task.spec_version, stateVersion: task.state_version }).claim({
    execution_id: 'modern-block-execution',
    claim_key: 'modern-block:claim',
    owner_ref: 'agent:modern-block',
    agent_prompt: 'bridge',
    input_material_refs: [],
  }, { operationId: 'modern-block:claim' });
  const started = taskService.dispatch('start_execution', {}, makeEnvelope({
    operationId: 'modern-block:start', actorRef: 'runtime:test', taskId: task.task_id,
    executionId: claim.execution.execution_id, specVersion: claim.execution.spec_version,
    stateVersion: claim.execution.state_version, fencingVersion: claim.execution.fencing_version,
  }));
  const agent = owner.withContext({
    actorRef: 'agent:modern-block', taskId: task.task_id, executionId: claim.execution.execution_id,
    specVersion: started.execution.spec_version, stateVersion: started.execution.state_version,
    fencingVersion: started.execution.fencing_version,
  });
  const handoff = agent.publishCollaborationMaterial({
    role: 'handoff', kind: 'failure', scope: 'proof_relevant', content: { blocker: 'prerequisite' },
  }, { operationId: 'modern-block:handoff' }).material;
  const lifecycle = [];
  const released = [];
  const bridge = new ServicesBridge({
    taskService,
    contextService,
    runtime: {
      blockTask: async (executionId, payload) => {
        lifecycle.push({ executionId, payload });
        return { execution: { ...started.execution, execution_id: executionId, state: 'HANDED_OFF' }, task: { ...task, state: 'BLOCKED' }, disposition: 'blocked', dependency: payload.dependency };
      },
    },
    router,
    taskId: task.task_id,
    executionId: claim.execution.execution_id,
    onRelease: async (release) => released.push(release),
  });
  try {
    const result = await bridge.call({ operation: 'task_block', payload: {
      blocker: { reason: 'prerequisite is still running' },
      dependency: { dependency_kind: 'TASK', prerequisite_task_id: 'prerequisite-task' },
      handoff_material_id: handoff.material_id,
    } });
    assert.equal(result.disposition, 'blocked');
    assert.equal(lifecycle.length, 1);
    assert.equal(lifecycle[0].payload.handoff_material_id, handoff.material_id);
    assert.equal(released.length, 1);
    assert.equal(bridge.taskId, null);
    assert.equal(bridge.executionId, null);
  } finally {
    await bridge.stop();
    taskService.close();
  }
});

test('ServicesBridge refreshes the profile when a Service is registered after startup', async () => {
  const registry = new ServiceRegistry();
  const bridge = new ServicesBridge({
    taskService: { getTask: () => null, getExecution: () => null },
    contextService: {},
    runtime: {},
    registry,
    taskId: 'task-dynamic',
    executionId: 'execution-dynamic',
  });
  try {
    assert.equal(bridge.getCapabilityProfile().capabilities.some((capability) => capability.service_id === 'dynamic'), false);
    registry.registerService({
      manifest: createServiceManifest({
        id: 'dynamic', title: 'Dynamic Service', purpose: 'Registered after the Bridge was created.',
        provider_version: '1.0.0', contract_version: '1', endpoint: { transport: 'in-process' },
        capabilities: [{
          name: 'dynamic_read', operation: 'dynamic_read', description: 'Read dynamic state.',
          input_schema: { type: 'object', properties: {}, additionalProperties: false },
          output_schema: { type: 'object', properties: {}, additionalProperties: false },
          audience: ['bound'], side_effect: 'read', idempotent: true, context: ['task', 'execution'],
          help: { when: 'Use the dynamic provider.', ref: 'service://dynamic/dynamic_read' },
        }],
      }),
      adapter: { invoke: async () => ({ ok: true }) },
    });
    assert.equal(bridge.getCapabilityProfile().capabilities.some((capability) => capability.service_id === 'dynamic'), true);
  } finally {
    await bridge.stop();
  }
});

test('ServicesBridge exposes only the bounded selection shortlist and lets Selection claim exactly once', async () => {
  const database = new DatabaseSync(':memory:');
  const contextService = new ContextService(database);
  const taskService = new TaskService(database, { contextService });
  contextService.taskService = taskService;
  const router = new ServicesRouter({ taskService, contextService });
  const owner = new ServicesSDK(router, { actorRef: 'owner:shortlist' });
  const task = owner.proposeTask({
    task_type: 'research', goal: 'bounded selection', expected_output: 'one task', acceptance_conditions: {}, owner_ref: 'owner:shortlist',
  }, { operationId: 'shortlist:propose' }).task;
  const bridge = new ServicesBridge({
    taskService,
    contextService,
    runtime: {},
    router,
  });
  try {
    bridge.setSelectionCandidates([{
      task_id: task.task_id,
      goal: 'bounded selection',
      expected_output: 'one task',
      workspace: { secret: 'must not cross selection boundary' },
      completion_contract: { normal_flow: true },
      selection_rank: 1,
    }]);
    const listed = await bridge.call({ operation: 'list_tasks', payload: { limit: 100 } });
    assert.deepEqual(listed.map((candidate) => candidate.task_id), [task.task_id]);
    assert.equal(listed[0].workspace, undefined);
    const viewed = await bridge.call({ operation: 'get_task', payload: { task_id: task.task_id } });
    assert.equal(viewed.task_id, task.task_id);
    assert.equal(viewed.workspace, undefined);
    await assert.rejects(
      () => bridge.call({ operation: 'get_task', payload: { task_id: 'task-outside-shortlist' } }),
      (error) => error.code === 'INVALID_CONTRACT' && /bounded shortlist/.test(error.message),
    );
    const result = await bridge.call({ operation: 'claim', payload: { task_id: task.task_id, claim_key: 'shortlist-claim' } });
    assert.equal(result.task.task_id, task.task_id);
    assert.equal(bridge.role, 'bound');
    const outside = new ServicesBridge({ taskService, contextService, runtime: {} });
    outside.setSelectionCandidates([{ task_id: task.task_id }]);
    await assert.rejects(
      () => outside.call({ operation: 'claim', payload: { task_id: 'task-outside-shortlist', claim_key: 'outside-shortlist' } }),
      (error) => error.code === 'INVALID_CONTRACT' && /bounded shortlist/.test(error.message),
    );
    await outside.stop();
    const bound = new ServicesBridge({ taskService, contextService, runtime: {}, taskId: task.task_id, executionId: result.execution.execution_id });
    await assert.rejects(
      () => bound.call({ operation: 'claim', payload: { task_id: task.task_id, claim_key: 'second-claim' } }),
      (error) => error.code === 'NOT_ALLOWED',
    );
    await bound.stop();
  } finally {
    await bridge.stop();
    taskService.close();
  }
});

test('Selection task discovery requires an injected bounded shortlist on every task discovery route', async () => {
  const calls = [];
  const taskDiscoveryCapabilities = [
    'list_tasks',
    'list_claimable_tasks',
    'get_task',
    'list_executions',
    'get_task_structure',
    'explain_task_readiness',
  ].map((operation) => ({
    id: `task.${operation}`,
    name: operation,
    operation,
    service_id: 'task',
    service_title: 'Task Service',
    service_purpose: 'Task discovery',
    description: `Discover through ${operation}`,
    audience: ['selection'],
    side_effect: 'read',
    idempotent: true,
    context: [],
  }));
  const registry = {
    getRevision: () => 1,
    getCapabilityProfile: () => ({ profile_version: 'test', profile_hash: 'selection-test', capabilities: taskDiscoveryCapabilities }),
    invoke: async (request) => {
      calls.push(request);
      return [];
    },
  };
  const bridge = new ServicesBridge({
    taskService: { getTask: () => null, getExecution: () => null },
    contextService: {},
    runtime: {},
    registry,
    role: AGENT_ROLES.SELECTION,
  });
  try {
    const payloads = {
      list_tasks: {},
      list_claimable_tasks: {},
      get_task: { task_id: 'task-1' },
      list_executions: { task_id: 'task-1' },
      get_task_structure: { task_id: 'task-1' },
      explain_task_readiness: { task_id: 'task-1' },
    };
    for (const operation of Object.keys(payloads)) {
      await assert.rejects(
        () => bridge.call({ operation, payload: payloads[operation] }),
        (error) => error.code === 'NOT_ALLOWED' && /bounded shortlist/.test(error.message),
        operation,
      );
    }
    assert.equal(calls.length, 0);
  } finally {
    await bridge.stop();
  }
});

test('Selection task discovery keeps every task id inside the injected shortlist', async () => {
  const calls = [];
  const operations = ['list_executions', 'get_task_structure', 'explain_task_readiness'];
  const capabilities = operations.map((operation) => ({
    id: `task.${operation}`,
    name: operation,
    operation,
    service_id: 'task',
    service_title: 'Task Service',
    service_purpose: 'Task discovery',
    description: `Discover through ${operation}`,
    audience: ['selection'],
    side_effect: 'read',
    idempotent: true,
    context: [],
  }));
  const registry = {
    getRevision: () => 1,
    getCapabilityProfile: () => ({ profile_hash: 'selection-membership-test', capabilities }),
    invoke: async (request) => {
      calls.push(request);
      return { unexpected: true };
    },
  };
  const bridge = new ServicesBridge({
    taskService: { getTask: () => null, getExecution: () => null },
    contextService: {},
    runtime: {},
    registry,
    role: AGENT_ROLES.SELECTION,
  });
  bridge.setSelectionCandidates([{ task_id: 'task-in-shortlist', goal: 'bounded task' }]);
  try {
    for (const operation of operations) {
      await assert.rejects(
        () => bridge.call({ operation, payload: { task_id: 'task-outside-shortlist' } }),
        (error) => error.code === 'INVALID_CONTRACT' && /bounded shortlist/.test(error.message),
        operation,
      );
    }
    assert.equal(calls.length, 0);
  } finally {
    await bridge.stop();
  }
});

test('ServicesBridge exposes controlled Workspace file operations with snake_case payloads', async () => {
  const database = new DatabaseSync(':memory:');
  const contextService = new ContextService(database);
  const taskService = new TaskService(database, { contextService });
  contextService.taskService = taskService;
  const router = new ServicesRouter({ taskService, contextService });
  const owner = new ServicesSDK(router, { actorRef: 'owner:root' });
  const task = owner.proposeTask({
    task_type: 'proof', goal: 'bridge workspace', expected_output: 'artifact', acceptance_conditions: {}, owner_ref: 'owner:root',
  }, { operationId: 'bridge:workspace:propose' }).task;
  owner.withContext({ taskId: task.task_id, specVersion: task.spec_version, stateVersion: task.state_version }).claim({
    execution_id: 'bridge-workspace-execution', claim_key: 'bridge:workspace:claim', owner_ref: 'agent:workspace', agent_prompt: 'bridge', input_material_refs: [],
  }, { operationId: 'bridge:workspace:claim' });
  const calls = [];
  const runtime = {
    listWorkspaceFiles: async (executionId, payload) => { calls.push(['list', executionId, payload]); return { files: [{ path: 'README.md' }] }; },
    readWorkspaceFile: async (executionId, payload) => { calls.push(['read', executionId, payload]); return { path: payload.path, content: 'read back' }; },
    writeWorkspaceFile: async (executionId, payload) => { calls.push(['write', executionId, payload]); return { workspace: { workspace_revision: 3 }, file: { path: payload.path, content: payload.content } }; },
    workspaceDiff: async (executionId, payload) => { calls.push(['diff', executionId, payload]); return { changed_files: [{ path: 'notes.md', status: 'added' }] }; },
    requestWait: async () => ({}),
  };
  const bridge = new ServicesBridge({ taskService, contextService, runtime, router, taskId: task.task_id, executionId: 'bridge-workspace-execution' });
  const environment = await bridge.start();
  const call = async (operation, payload) => {
    const response = await fetch(`${environment.SWARMENV_BRIDGE_URL}/call`, {
      method: 'POST',
      headers: { authorization: `Bearer ${environment.SWARMENV_BRIDGE_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ operation, payload }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    return body.result;
  };
  try {
    await call('list_workspace_files', { path: 'notes' });
    await call('read_workspace_file', { path: 'README.md', max_bytes: 200 });
    await call('write_workspace_file', { path: 'notes.md', content: 'changed', expected_revision: 2 });
    await call('workspace_diff', { from_revision: 2, to_revision: 3 });
    assert.deepEqual(calls, [
      ['list', 'bridge-workspace-execution', { path: 'notes' }],
      ['read', 'bridge-workspace-execution', { path: 'README.md', maxBytes: 200 }],
      ['write', 'bridge-workspace-execution', { path: 'notes.md', content: 'changed', expectedRevision: 2, saveOperationId: calls[2]?.[2]?.saveOperationId }],
      ['diff', 'bridge-workspace-execution', { fromRevision: 2, toRevision: 3 }],
    ]);
    assert.match(calls[2][2].saveOperationId, /^bridge:write_workspace_file:/);
  } finally {
    await bridge.stop();
    taskService.close();
  }
});

test('ServicesBridge routes Judge feedback through the named Judge Service tool', async () => {
  const database = new DatabaseSync(':memory:');
  const contextService = new ContextService(database);
  const taskService = new TaskService(database, { contextService });
  const judgeService = new JudgeService(database);
  contextService.taskService = taskService;
  const router = new ServicesRouter({ taskService, contextService, judgeService });
  const owner = new ServicesSDK(router, { actorRef: 'owner:judge-route' });
  const task = owner.proposeTask({
    task_type: 'proof', goal: 'judge route', expected_output: 'artifact', acceptance_conditions: {}, owner_ref: 'owner:judge-route',
  }, { operationId: 'bridge:judge-route:propose' }).task;
  owner.withContext({ taskId: task.task_id, specVersion: task.spec_version, stateVersion: task.state_version }).claim({
    execution_id: 'bridge-judge-route-execution', claim_key: 'bridge:judge-route:claim', owner_ref: 'agent:judge-route', agent_prompt: 'bridge', input_material_refs: [],
  }, { operationId: 'bridge:judge-route:claim' });
  const timestamp = new Date().toISOString();
  judgeService.db.prepare(`INSERT INTO check_results (
    check_result_id, request_key, request_hash, candidate_material_id, target_task_id, target_spec_version,
    execution_id, input_snapshot_hash, checker_ref, checker_version, environment_ref, status, verdict, evidence_json,
    applied_task_state_version, applied_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RECEIVED', ?, ?, NULL, NULL, ?, ?)`).run(
    'judge-route-result', 'judge-route-request', 'judge-route-hash', 'candidate-material', task.task_id, task.spec_version,
    'bridge-judge-route-execution', 'input-hash', 'lean', 'mvp-1', 'test-env', 'FAIL', JSON.stringify({ diagnostic: 'controlled feedback' }), timestamp, timestamp,
  );
  const bridge = new ServicesBridge({
    taskService,
    contextService,
    runtime: { requestWait: async () => ({}) },
    router,
    taskId: task.task_id,
    executionId: 'bridge-judge-route-execution',
  });
  try {
    const result = await bridge.call({ operation: 'get_check_result', payload: { check_result_id: 'judge-route-result' } });
    assert.equal(result.check_result_id, 'judge-route-result');
    assert.equal(result.verdict, 'FAIL');
    assert.equal(result.diagnostic_excerpt, 'controlled feedback');
    assert.deepEqual(result.diagnostic_location, null);
    assert.equal(result.evidence, undefined);
    assert.equal(result.process_evidence.exit_code, null);
  } finally {
    await bridge.stop();
    taskService.close();
  }
});

test('ServicesBridge keeps the same binding for a source failure so the Agent can revise synchronously', async () => {
  const database = new DatabaseSync(':memory:');
  const contextService = new ContextService(database);
  const taskService = new TaskService(database, { contextService });
  contextService.taskService = taskService;
  const router = new ServicesRouter({ taskService, contextService });
  const owner = new ServicesSDK(router, { actorRef: 'owner:source-failure' });
  const task = owner.proposeTask({
    task_type: 'proof', goal: 'source failure bridge', expected_output: 'artifact', acceptance_conditions: {}, owner_ref: 'owner:source-failure',
    completion_contract: { required_candidate: { kind: 'artifact', scope: 'proof_relevant' }, required_check: { checker_ref: 'lean', checker_version: 'mvp-1', environment_ref: fixture().environment_ref } },
  }, { operationId: 'bridge:source-failure:propose' }).task;
  const claim = owner.withContext({ taskId: task.task_id, specVersion: task.spec_version, stateVersion: task.state_version }).claim({
    execution_id: 'bridge-source-failure-execution', claim_key: 'bridge:source-failure:claim', owner_ref: 'agent:source-failure', agent_prompt: 'bridge', input_material_refs: [],
  });
  const started = taskService.dispatch('start_execution', {}, makeEnvelope({
    operationId: 'bridge:source-failure:start', actorRef: 'runtime:test', taskId: task.task_id,
    executionId: claim.execution.execution_id, specVersion: claim.execution.spec_version,
    stateVersion: claim.execution.state_version, fencingVersion: claim.execution.fencing_version,
  }));
  const released = [];
  let waitCalls = 0;
  let submissions = 0;
  const bridge = new ServicesBridge({
    taskService,
    contextService,
    runtime: { requestWait: async () => { waitCalls += 1; throw new Error('source failure must not request wait'); } },
    router,
    taskId: task.task_id,
    executionId: claim.execution.execution_id,
    onSubmitCandidate: async ({ executionId }) => {
      submissions += 1;
      const execution = taskService.getExecution(executionId);
      return {
        check_result: {
          result_class: 'source_failure',
          mathematical_outcome: 'FAIL',
          checker_process_status: 'completed',
          diagnostic_code: 'source_failure',
          evidence: { diagnostic: 'type mismatch at line 3, column 7', exit_code: 1 },
        },
        applied: { execution, task: taskService.getTask(task.task_id) },
      };
    },
    onRelease: async (release) => released.push(release),
  });
  try {
    const agent = owner.withContext({
      actorRef: 'agent:source-failure', taskId: task.task_id, executionId: claim.execution.execution_id,
      specVersion: started.execution.spec_version, stateVersion: started.execution.state_version, fencingVersion: started.execution.fencing_version,
    });
    const first = agent.publishMaterial({ kind: 'artifact', scope: 'proof_relevant', content: 'invalid candidate' }, { operationId: 'bridge:source-failure:material-1' }).material;
    const firstResult = await bridge.call({ operation: 'submit_candidate', payload: { candidate_material_id: first.material_id } });
    assert.equal(firstResult.check_result.result_class, 'source_failure');
    assert.equal(firstResult.applied.execution.state, 'RUNNING');
    assert.equal(bridge.taskId, task.task_id);
    assert.equal(bridge.executionId, claim.execution.execution_id);
    assert.equal(waitCalls, 0);
    assert.equal(released.length, 0);

    const current = taskService.getExecution(claim.execution.execution_id);
    const second = owner.withContext({
      actorRef: 'agent:source-failure', taskId: task.task_id, executionId: claim.execution.execution_id,
      specVersion: current.spec_version, stateVersion: current.state_version, fencingVersion: current.fencing_version,
    }).publishMaterial({ kind: 'artifact', scope: 'proof_relevant', content: 'revised candidate', supersedes: first.material_id }, { operationId: 'bridge:source-failure:material-2' }).material;
    const secondResult = await bridge.call({ operation: 'submit_candidate', payload: { candidate_material_id: second.material_id } });
    assert.equal(secondResult.check_result.result_class, 'source_failure');
    assert.equal(submissions, 2);
    assert.equal(taskService.getExecution(claim.execution.execution_id).state, 'RUNNING');
    assert.equal(bridge.taskId, task.task_id);
    assert.equal(bridge.executionId, claim.execution.execution_id);
    assert.equal(waitCalls, 0);
    assert.equal(released.length, 0);
  } finally {
    await bridge.stop();
    taskService.close();
  }
});

test('ServicesBridge returns checker feedback before applying a deferred typed block', async () => {
  const database = new DatabaseSync(':memory:');
  const contextService = new ContextService(database);
  const taskService = new TaskService(database, { contextService });
  contextService.taskService = taskService;
  const router = new ServicesRouter({ taskService, contextService });
  const owner = new ServicesSDK(router, { actorRef: 'owner:typed-block' });
  const task = owner.proposeTask({
    task_type: 'proof', goal: 'typed checker block', expected_output: 'artifact', acceptance_conditions: {}, owner_ref: 'owner:typed-block',
    completion_contract: { required_candidate: { kind: 'artifact', scope: 'proof_relevant' }, required_check: { checker_ref: 'lean', checker_version: 'mvp-1', environment_ref: fixture().environment_ref } },
  }, { operationId: 'bridge:typed-block:propose' }).task;
  const claim = owner.withContext({ taskId: task.task_id, specVersion: task.spec_version, stateVersion: task.state_version }).claim({
    execution_id: 'bridge-typed-block-execution', claim_key: 'bridge:typed-block:claim', owner_ref: 'agent:typed-block', agent_prompt: 'bridge', input_material_refs: [],
  }, { operationId: 'bridge:typed-block:claim' });
  const started = taskService.dispatch('start_execution', {}, makeEnvelope({
    operationId: 'bridge:typed-block:start', actorRef: 'runtime:test', taskId: task.task_id,
    executionId: claim.execution.execution_id, specVersion: claim.execution.spec_version,
    stateVersion: claim.execution.state_version, fencingVersion: claim.execution.fencing_version,
  }));
  const lifecycle = [];
  const released = [];
  const bridge = new ServicesBridge({
    taskService,
    contextService,
    runtime: {
      blockExecution: async (executionId, block) => {
        lifecycle.push({ executionId, block });
        return {
          execution: { ...started.execution, execution_id: executionId, state: 'FAILED' },
          task: { ...task, state: 'BLOCKED' },
        };
      },
    },
    router,
    taskId: task.task_id,
    executionId: claim.execution.execution_id,
    onSubmitCandidate: async ({ executionId }) => ({
      check_result: { result_class: 'infrastructure_failure', mathematical_outcome: 'unassessed', diagnostic_code: 'checker_unavailable' },
      applied: { execution: taskService.getExecution(executionId), task: taskService.getTask(task.task_id) },
      deferred_block: {
        reason: 'checker health unavailable',
        dependency: { dependency_kind: 'CHECK_RESULT', check_result_id: 'check-typed-block' },
        checkpoint: { phase: 'checker_unavailable' },
        terminal_state: 'FAILED',
      },
    }),
    onRelease: async (release) => released.push(release),
  });
  try {
    const agent = owner.withContext({
      actorRef: 'agent:typed-block', taskId: task.task_id, executionId: claim.execution.execution_id,
      specVersion: started.execution.spec_version, stateVersion: started.execution.state_version, fencingVersion: started.execution.fencing_version,
    });
    const material = agent.publishMaterial({ kind: 'artifact', scope: 'proof_relevant', content: 'candidate' }, { operationId: 'bridge:typed-block:material' }).material;
    const result = await bridge.call({ operation: 'submit_candidate', payload: { candidate_material_id: material.material_id } });
    assert.equal(result.check_result.result_class, 'infrastructure_failure');
    assert.equal(lifecycle.length, 0);
    assert.equal(bridge.taskId, task.task_id);
    await bridge.flushDeferredLifecycle();
    assert.equal(lifecycle.length, 1);
    assert.equal(lifecycle[0].block.dependency.dependency_kind, 'CHECK_RESULT');
    assert.equal(bridge.taskId, null);
    assert.equal(bridge.executionId, null);
    assert.equal(released.length, 1);
  } finally {
    await bridge.stop();
    taskService.close();
  }
});

test('ServicesBridge binds an explicit claim to the bridge Agent and keeps the reusable prompt', async () => {
  const database = new DatabaseSync(':memory:');
  const contextService = new ContextService(database);
  const taskService = new TaskService(database, { contextService });
  contextService.taskService = taskService;
  const router = new ServicesRouter({ taskService, contextService });
  const owner = new ServicesSDK(router, { actorRef: 'owner:root' });
  const task = owner.proposeTask({
    task_type: 'proof', goal: 'bridge claim identity', expected_output: 'artifact', acceptance_conditions: {}, owner_ref: 'owner:root',
    task_instructions: 'Task-specific instructions belong to this Task.',
    completion_contract: { required_candidate: { kind: 'artifact', scope: 'proof_relevant' }, required_check: { checker_ref: 'lean', checker_version: 'mvp-1', environment_ref: fixture().environment_ref } },
  }, { operationId: 'bridge:identity:propose' }).task;
  let claimed;
  const bridge = new ServicesBridge({
    taskService,
    contextService,
    runtime: { requestWait: async () => ({}) },
    router,
    actorRef: 'agent:bridge-identity',
    agentPrompt: 'shared worker prompt',
    onClaim: async (result) => { claimed = result; },
  });
  try {
    bridge.setSelectionCandidates([{ task_id: task.task_id }]);
    const result = await bridge.call({ operation: 'claim', payload: {
      task_id: task.task_id,
      claim_key: 'bridge:identity:claim',
      owner_ref: 'agent:forged',
      agent_prompt: 'task-specific prompt smuggled through transport',
      workspace_mode: 'clean',
    } });
    assert.equal(result.execution.owner_ref, 'agent:bridge-identity');
    assert.equal(result.execution.agent_prompt, 'shared worker prompt');
    assert.equal(result.handoff_required, true);
    assert.equal(claimed.execution.execution_id, result.execution.execution_id);
  } finally {
    await bridge.stop();
    taskService.close();
  }
});

test('ServicesBridge rolls back a Task claim when Runtime handoff fails', async () => {
  const database = new DatabaseSync(':memory:');
  const contextService = new ContextService(database);
  const taskService = new TaskService(database, { contextService });
  contextService.taskService = taskService;
  const router = new ServicesRouter({ taskService, contextService });
  const owner = new ServicesSDK(router, { actorRef: 'owner:root' });
  const task = owner.proposeTask({
    task_type: 'proof', goal: 'rollback handoff', expected_output: 'artifact', acceptance_conditions: {}, owner_ref: 'owner:root',
    completion_contract: { required_candidate: { kind: 'artifact', scope: 'proof_relevant' }, required_check: { checker_ref: 'lean', checker_version: 'mvp-1', environment_ref: fixture().environment_ref } },
  }, { operationId: 'bridge:rollback:propose' }).task;
  const bridge = new ServicesBridge({
    taskService,
    contextService,
    runtime: { requestWait: async () => ({}) },
    router,
    actorRef: 'agent:rollback',
    onClaim: async () => { throw new Error('controlled handoff failure'); },
  });
  try {
    bridge.setSelectionCandidates([{ task_id: task.task_id }]);
    await assert.rejects(() => bridge.call({ operation: 'claim', payload: { task_id: task.task_id, claim_key: 'bridge:rollback:claim', workspace_mode: 'clean' } }), /controlled handoff failure/);
    assert.equal(bridge.taskId, null);
    assert.equal(bridge.executionId, null);
    assert.equal(taskService.listActiveExecutions().length, 0);
    assert.equal(taskService.getTask(task.task_id).state, 'OPEN');
  } finally {
    await bridge.stop();
    taskService.close();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  ContextService,
  JudgeService,
  ServicesBridge,
  ServicesRouter,
  ServicesSDK,
  TaskService,
} from '../src/index.js';

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

test('ServicesBridge exposes public SDK calls over a loopback token and keeps Runtime wait internal', async () => {
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
  const runtime = { requestWait: async (executionId, payload) => ({ executionId, payload }) };
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
    const waited = await fetch(`${environment.SWARMENV_BRIDGE_URL}/call`, { method: 'POST', headers: { authorization: `Bearer ${environment.SWARMENV_BRIDGE_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'request_wait', payload: { waitCondition: { type: 'timer', deadline: new Date(Date.now() + 1_000).toISOString() }, checkpoint: { phase: 'bridge' }, files: {} } }) });
    const waitedBody = await waited.json();
    assert.equal(waited.status, 200);
    assert.equal(waitedBody.result.executionId, 'bridge-execution');
    assert.deepEqual(waitedBody.result.payload.checkpoint, { phase: 'bridge' });
    assert.equal(bridge.taskId, null);
    assert.equal(bridge.executionId, null);
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

test('root-only ServicesBridge rejects child creation even if the model calls the hidden operation', async () => {
  const database = new DatabaseSync(':memory:');
  const contextService = new ContextService(database);
  const taskService = new TaskService(database, { contextService });
  contextService.taskService = taskService;
  const router = new ServicesRouter({ taskService, contextService });
  const owner = new ServicesSDK(router, { actorRef: 'owner:root' });
  const task = owner.proposeTask({
    task_type: 'proof', goal: 'root-only bridge test', expected_output: 'artifact', acceptance_conditions: {}, owner_ref: 'owner:root',
  }, { operationId: 'root-only:propose' }).task;
  owner.withContext({ taskId: task.task_id, specVersion: task.spec_version, stateVersion: task.state_version }).claim({
    execution_id: 'root-only-execution', claim_key: 'root-only:claim', owner_ref: 'agent:root-only', agent_prompt: 'root-only', input_material_refs: [],
  }, { operationId: 'root-only:claim' });
  const bridge = new ServicesBridge({
    taskService,
    contextService,
    runtime: {},
    router,
    taskId: task.task_id,
    executionId: 'root-only-execution',
    allowChildTasks: false,
  });
  try {
    await assert.rejects(() => bridge.call({
      operation: 'create_child_task',
      payload: {
        child_creation_key: 'forbidden-child',
        task_type: 'research',
        goal: 'forbidden',
        expected_output: 'none',
        acceptance_conditions: {},
      },
    }), (error) => error.code === 'NOT_ALLOWED');
    assert.equal(taskService.listTasks({ rootId: task.task_id, availableOnly: false, limit: 20 }).length, 1);
  } finally {
    taskService.close();
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
    assert.equal(result.evidence.diagnostic, 'controlled feedback');
  } finally {
    await bridge.stop();
    taskService.close();
  }
});

test('ServicesBridge rejects candidate-result waits because candidate checking is synchronous', async () => {
  const database = new DatabaseSync(':memory:');
  const contextService = new ContextService(database);
  const taskService = new TaskService(database, { contextService });
  contextService.taskService = taskService;
  const router = new ServicesRouter({ taskService, contextService });
  const owner = new ServicesSDK(router, { actorRef: 'owner:root' });
  const task = owner.proposeTask({
    task_type: 'proof', goal: 'bridge snake case wait', expected_output: 'artifact', acceptance_conditions: {}, owner_ref: 'owner:root',
    completion_contract: { required_candidate: { kind: 'artifact', scope: 'proof_relevant' }, required_check: { checker_ref: 'lean', checker_version: 'mvp-1', environment_ref: fixture().environment_ref } },
  }, { operationId: 'bridge:snake:propose' }).task;
  owner.withContext({ taskId: task.task_id, specVersion: task.spec_version, stateVersion: task.state_version }).claim({
    execution_id: 'bridge-execution-snake', claim_key: 'bridge:snake:claim', owner_ref: 'agent:bridge', agent_prompt: 'bridge', input_material_refs: [],
  }, { operationId: 'bridge:snake:claim' });
  const runtime = { requestWait: async (executionId, payload) => ({ executionId, payload }) };
  const bridge = new ServicesBridge({ taskService, contextService, runtime, router, taskId: task.task_id, executionId: 'bridge-execution-snake' });
  const environment = await bridge.start();
  try {
    const response = await fetch(`${environment.SWARMENV_BRIDGE_URL}/call`, {
      method: 'POST',
      headers: { authorization: `Bearer ${environment.SWARMENV_BRIDGE_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'request_wait', payload: {
        wait_condition: { kind: 'judge_result' },
        checkpoint: { phase: 'snake-case', candidate_material_id: 'candidate-for-judge-wait' },
        files: {},
      } }),
    });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'NOT_ALLOWED');
    assert.match(body.error.message, /synchronous submit_candidate/);
    assert.equal(bridge.taskId, task.task_id);
    assert.equal(bridge.executionId, 'bridge-execution-snake');
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

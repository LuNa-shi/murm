import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  ContextService,
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

test('ServicesBridge accepts the named execution_wait snake_case payload and releases the binding', async () => {
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
    assert.equal(response.status, 200);
    assert.equal(body.result.executionId, 'bridge-execution-snake');
    assert.equal(body.result.payload.waitCondition.type, 'check_result_arrived');
    assert.equal(body.result.payload.waitCondition.check_request_key, 'candidate-for-judge-wait');
    assert.equal(bridge.taskId, null);
    assert.equal(bridge.executionId, null);
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

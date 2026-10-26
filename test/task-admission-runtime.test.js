import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ERROR_CODES, makeEnvelope, ServicesSDK, SwarmEnvError, TaskService } from '../src/index.js';
import { SCHEMA_SQL } from '../src/storage/schema.js';

function rootInput(overrides = {}) {
  return {
    task_type: 'default',
    goal: 'coordinate bounded work',
    expected_output: 'a durable result',
    acceptance_conditions: { result: true },
    owner_ref: 'owner:root',
    ...overrides,
  };
}

function service(options = {}) {
  const taskService = new TaskService(new DatabaseSync(':memory:'), options);
  const sdk = new ServicesSDK(taskService, { actorRef: 'owner:root' });
  return { taskService, sdk };
}

test('claimTask binds one Core and rejects a second active owner', () => {
  const { taskService, sdk } = service();
  const first = sdk.proposeTask(rootInput(), { operationId: 'core-root-1' }).task;
  const firstClaim = taskService.claimTask(first.task_id, { claim_key: 'core-claim-1', owner_ref: 'daemon:one', core_id: 'core-1' });
  assert.equal(firstClaim.execution.core_id, 'core-1');
  assert.equal(taskService.getActiveExecutionForCore('core-1').execution_id, firstClaim.execution.execution_id);

  const second = sdk.proposeTask(rootInput({ goal: 'second work' }), { operationId: 'core-root-2' }).task;
  assert.throws(
    () => taskService.claimTask(second.task_id, { claim_key: 'core-claim-2', owner_ref: 'daemon:two', core_id: 'core-1' }),
    (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.CONFLICT,
  );
  taskService.close();
});

test('Task Service emits committed lifecycle events without replay duplicates', () => {
  const { taskService, sdk } = service();
  const events = [];
  const unsubscribe = taskService.subscribeTaskEvents((event) => events.push(event));
  const task = sdk.proposeTask(rootInput(), { operationId: 'task-events-propose' }).task;
  const claimEnvelope = makeEnvelope({
    operationId: 'task-events-claim-op', actorRef: 'daemon:events', taskId: task.task_id,
    specVersion: task.spec_version, stateVersion: task.state_version,
  });
  const claim = taskService.claimTask(task.task_id, { claim_key: 'task-events-claim', owner_ref: 'daemon:events' }, claimEnvelope);
  taskService.claimTask(task.task_id, { claim_key: 'task-events-claim', owner_ref: 'daemon:events' }, claimEnvelope);
  assert.deepEqual(events.map((event) => event.operation), ['propose_task', 'claim']);
  assert.equal(events[1].execution_id, claim.execution.execution_id);
  unsubscribe();
  taskService.close();
});

test('session recovery keeps Execution identity and increments session generation', () => {
  const { taskService, sdk } = service();
  const task = sdk.proposeTask(rootInput(), { operationId: 'recovery-root' }).task;
  const claim = taskService.claimTask(task.task_id, { claim_key: 'recovery-claim', owner_ref: 'daemon:one', core_id: 'core-1' });
  const started = taskService.dispatch('start_execution', {}, makeEnvelope({
    operationId: 'recovery-start', actorRef: 'daemon:one', taskId: task.task_id, executionId: claim.execution.execution_id,
    specVersion: task.spec_version, stateVersion: claim.execution.state_version, fencingVersion: claim.execution.fencing_version,
  }));
  const recovered = taskService.dispatch('recover_execution', { runtime_generation: 2, agent_prompt: 'resume' }, makeEnvelope({
    operationId: 'recovery-recover', actorRef: 'daemon:one', taskId: task.task_id, executionId: claim.execution.execution_id,
    specVersion: task.spec_version, stateVersion: started.execution.state_version, fencingVersion: started.execution.fencing_version,
  }));
  assert.equal(recovered.execution.execution_id, claim.execution.execution_id);
  assert.equal(recovered.execution.core_id, 'core-1');
  assert.equal(recovered.execution.session_generation, 2);
  taskService.close();
});

test('blocking ends the Execution and Controller reopening is idempotent', () => {
  const { taskService, sdk } = service();
  const task = sdk.proposeTask(rootInput(), { operationId: 'block-root' }).task;
  const claim = taskService.claimTask(task.task_id, { claim_key: 'block-claim', owner_ref: 'daemon:one', core_id: 'core-1' });
  const blocked = taskService.blockTask({ block_reason: 'child_task_terminal:child-1' }, makeEnvelope({
    operationId: 'block-op', actorRef: 'daemon:one', taskId: task.task_id, executionId: claim.execution.execution_id,
    specVersion: task.spec_version, stateVersion: claim.execution.state_version, fencingVersion: claim.execution.fencing_version,
  }));
  assert.equal(blocked.task.state, 'BLOCKED');
  assert.equal(blocked.execution.state, 'FENCED');
  assert.equal(taskService.getActiveExecutionForCore('core-1'), null);
  const reopened = taskService.reopenTask(task.task_id);
  assert.equal(reopened.task.state, 'OPEN');
  const replay = taskService.reopenTask(task.task_id);
  assert.equal(replay.changed, false);
  taskService.close();
});

test('normal-flow blocking ends the Execution and leaves the Task reusable', () => {
  const { taskService, sdk } = service();
  const task = sdk.proposeTask(rootInput({ normal_flow: true }), { operationId: 'normal-block-root' }).task;
  const claim = taskService.claimTask(task.task_id, {
    claim_key: 'normal-block-claim', owner_ref: 'daemon:one', core_id: 'core-normal-block',
  });
  const blocked = taskService.blockTask({ block_reason: 'external dependency' }, makeEnvelope({
    operationId: 'normal-block-op', actorRef: 'daemon:one', taskId: task.task_id, executionId: claim.execution.execution_id,
    specVersion: task.spec_version, stateVersion: claim.execution.state_version, fencingVersion: claim.execution.fencing_version,
  }));
  assert.equal(blocked.task.state, 'BLOCKED');
  assert.equal(blocked.execution.state, 'FENCED');
  assert.equal(taskService.getActiveExecutionForCore('core-normal-block'), null);
  const reopened = taskService.reopenTask(task.task_id);
  assert.equal(reopened.task.state, 'OPEN');
  assert.equal(taskService.reopenTask(task.task_id).changed, false);
  taskService.close();
});

test('typed dependency blocking records the condition and reopens only after satisfaction', () => {
  const { taskService, sdk } = service();
  const prerequisite = sdk.proposeTask(rootInput({ goal: 'finish prerequisite' }), { operationId: 'typed-block-prerequisite' }).task;
  const task = sdk.proposeTask(rootInput({ goal: 'resume after prerequisite', normal_flow: true }), { operationId: 'typed-block-task' }).task;
  const claim = taskService.claimTask(task.task_id, { claim_key: 'typed-block-claim', owner_ref: 'daemon:one', core_id: 'core-typed-block' });
  const blocked = taskService.blockTask({
    block_reason: 'prerequisite is incomplete',
    dependency: { dependency_kind: 'TASK', prerequisite_task_id: prerequisite.task_id },
  }, makeEnvelope({
    operationId: 'typed-block-op', actorRef: 'daemon:one', taskId: task.task_id, executionId: claim.execution.execution_id,
    specVersion: task.spec_version, stateVersion: claim.execution.state_version, fencingVersion: claim.execution.fencing_version,
  }));
  assert.equal(blocked.task.state, 'BLOCKED');
  assert.match(blocked.task.block_reason, /^dependency:/);
  assert.equal(blocked.dependency.dependency_kind, 'TASK');
  assert.equal(taskService.reconcileTask(task.task_id).changed, false);

  const prerequisiteClaim = taskService.claimTask(prerequisite.task_id, { claim_key: 'typed-block-prerequisite-claim', owner_ref: 'owner:root' });
  const prerequisiteTask = taskService.getTask(prerequisite.task_id);
  const prerequisiteSdk = sdk.withContext({
    actorRef: 'owner:root', taskId: prerequisite.task_id, executionId: prerequisiteClaim.execution.execution_id,
    specVersion: prerequisite.spec_version, stateVersion: prerequisiteClaim.execution.state_version,
    fencingVersion: prerequisiteClaim.execution.fencing_version,
  });
  const completed = prerequisiteSdk.acceptTask({ target_task_id: prerequisite.task_id, target_state_version: prerequisiteTask.state_version }, { operationId: 'typed-block-prerequisite-accept' });
  assert.equal(completed.task.state, 'SATISFIED');
  const reopened = taskService.reconcileTask(task.task_id);
  assert.equal(reopened.changed, true);
  assert.equal(reopened.task.state, 'OPEN');
  taskService.close();
});

test('persistent MVP databases migrate the Task lifecycle CHECK before DONE writes', () => {
  const database = new DatabaseSync(':memory:');
  database.exec(SCHEMA_SQL.replace("'DONE', 'CLOSED', 'CANCELED', ", ''));
  const taskService = new TaskService(database);
  const sdk = new ServicesSDK(taskService, { actorRef: 'owner:root' });
  const task = sdk.proposeTask({
    task_type: 'default', goal: 'migrate lifecycle state', expected_output: 'DONE', acceptance_conditions: {},
    owner_ref: 'owner:root', normal_flow: true,
  }, { operationId: 'migrate-lifecycle-propose' }).task;
  const claim = taskService.claimTask(task.task_id, { claim_key: 'migrate-lifecycle-claim', owner_ref: 'owner:root' });
  const completed = sdk.withContext({
    taskId: task.task_id,
    executionId: claim.execution.execution_id,
    specVersion: claim.execution.spec_version,
    stateVersion: claim.execution.state_version,
    taskStateVersion: taskService.getTask(task.task_id).state_version,
    fencingVersion: claim.execution.fencing_version,
  }).acceptTask({ target_task_id: task.task_id, target_state_version: taskService.getTask(task.task_id).state_version }, { operationId: 'migrate-lifecycle-accept' });
  assert.equal(completed.task.state, 'DONE');
  assert.deepEqual(taskService.db.prepare('PRAGMA foreign_key_check').all(), []);
  taskService.close();
});

test('blocking a parallel Task fences every active Execution before marking it BLOCKED', () => {
  const { taskService, sdk } = service();
  const task = sdk.proposeTask(rootInput({ parallel_quota: 2 }), { operationId: 'parallel-block-root' }).task;
  const first = taskService.claimTask(task.task_id, { claim_key: 'parallel-block-claim-1', owner_ref: 'daemon:one', core_id: 'core-1' });
  const second = taskService.claimTask(task.task_id, { claim_key: 'parallel-block-claim-2', owner_ref: 'daemon:two', core_id: 'core-2' });
  const blocked = taskService.blockTask({ block_reason: 'external dependency' }, makeEnvelope({
    operationId: 'parallel-block-op', actorRef: 'daemon:one', taskId: task.task_id, executionId: first.execution.execution_id,
    specVersion: task.spec_version, stateVersion: first.execution.state_version, fencingVersion: first.execution.fencing_version,
  }));
  assert.equal(blocked.task.state, 'BLOCKED');
  assert.equal(blocked.fenced_execution_count, 1);
  assert.equal(taskService.getExecution(second.execution.execution_id).state, 'FENCED');
  assert.equal(taskService.listActiveExecutions().filter((execution) => execution.task_id === task.task_id && ['CREATED', 'RUNNING'].includes(execution.state)).length, 0);
  taskService.close();
});

test('bounded admission returns typed backpressure and duplicate responsibility', () => {
  const { taskService, sdk } = service({ admission: { max_children_per_execution: 2, max_unfinished_tasks: 10, max_open_tasks: 10, require_responsibility_key: true } });
  const root = sdk.proposeTask(rootInput({ max_children: 10 }), { operationId: 'admission-root' }).task;
  const claim = taskService.claimTask(root.task_id, { claim_key: 'admission-claim', owner_ref: 'owner:root' });
  const owner = sdk.withContext({
    actorRef: 'owner:root', taskId: root.task_id, executionId: claim.execution.execution_id,
    specVersion: root.spec_version, stateVersion: claim.task.state_version, fencingVersion: claim.execution.fencing_version,
  });
  const childInput = { task_type: 'research', goal: 'independent route', expected_output: 'a material', acceptance_conditions: {}, responsibility_key: 'route-a' };
  assert.throws(
    () => owner.createChildTask({ ...childInput, responsibility_key: undefined, child_creation_key: 'admission-child-missing-key' }, { operationId: 'admission-child-missing-key' }),
    (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.INVALID_TASK_CONTRACT,
  );
  const first = owner.createChildTask({ ...childInput, child_creation_key: 'admission-child-a' }, { operationId: 'admission-child-a' });
  assert.equal(first.task.responsibility_key, 'route-a');
  const duplicate = owner.withContext({ stateVersion: taskService.getTask(root.task_id).state_version }).createChildTask({ ...childInput, child_creation_key: 'admission-child-a-retry' }, { operationId: 'admission-child-a-retry' });
  assert.equal(duplicate.admission.code, ERROR_CODES.DUPLICATE_RESPONSIBILITY);
  const second = owner.withContext({ stateVersion: taskService.getTask(root.task_id).state_version }).createChildTask({ ...childInput, responsibility_key: 'route-b', child_creation_key: 'admission-child-b' }, { operationId: 'admission-child-b' });
  assert.equal(second.task.responsibility_key, 'route-b');
  assert.throws(
    () => owner.withContext({ stateVersion: taskService.getTask(root.task_id).state_version }).createChildTask({ ...childInput, responsibility_key: 'route-c', child_creation_key: 'admission-child-c' }, { operationId: 'admission-child-c' }),
    (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.BACKPRESSURE_EXECUTION_CHILD_LIMIT,
  );
  taskService.close();
});

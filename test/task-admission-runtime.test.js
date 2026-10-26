import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ERROR_CODES, makeEnvelope, ServicesSDK, SwarmEnvError, TaskService } from '../src/index.js';

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
  assert.equal(taskService.db.prepare('SELECT child_count FROM execution_admission_counters WHERE execution_id = ?').get(claim.execution.execution_id).child_count, 1);
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


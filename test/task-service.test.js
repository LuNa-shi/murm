import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ERROR_CODES, ServicesSDK, SwarmEnvError, TaskService } from '../src/index.js';

function rootService() {
  const service = new TaskService(new DatabaseSync(':memory:'));
  const sdk = new ServicesSDK(service, { actorRef: 'owner:root' });
  return { service, sdk };
}

function proofInput(overrides = {}) {
  return {
    task_type: 'proof',
    goal: 'Prove the locked fixture theorem',
    expected_output: 'A Lean proof artifact',
    acceptance_conditions: { fixture: 'putnam-1966-a1' },
    owner_ref: 'owner:root',
    ...overrides,
  };
}

test('registered proof root Task persists its contract and rejects incomplete proposals', () => {
  const { service, sdk } = rootService();
  const result = sdk.proposeTask(proofInput(), { operationId: 'propose-proof-1', actorRef: 'owner:root' });
  assert.equal(result.task.task_type, 'proof');
  assert.equal(result.task.task_type_version, '1.0');
  assert.equal(result.task.state, 'OPEN');
  assert.deepEqual(result.task.completion_contract.required_candidate, { kind: 'artifact' });
  assert.equal(result.task.completion_contract.required_check.checker_ref, 'lean');
  assert.match(result.task.spec_hash, /^[0-9a-f]{64}$/);

  assert.throws(
    () => sdk.proposeTask({ task_type: 'proof', goal: 'missing output', acceptance_conditions: 'x', owner_ref: 'owner:root' }, { operationId: 'bad-proposal' }),
    (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.INVALID_CONTRACT,
  );
  assert.throws(
    () => sdk.proposeTask({ ...proofInput(), task_type: 'unknown' }, { operationId: 'unknown-type' }),
    (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.INVALID_CONTRACT,
  );
  service.close();
});

test('claim atomically creates one active Execution and is idempotent by operation and claim key', () => {
  const { service, sdk } = rootService();
  const proposed = sdk.proposeTask(proofInput(), { operationId: 'propose-claim' });
  const task = proposed.task;
  const context = sdk.withContext({ taskId: task.task_id, specVersion: task.spec_version, stateVersion: task.state_version });
  const claim = context.claim({
    claim_key: 'claim-key-1',
    owner_ref: 'runtime:one',
    initial_prompt: 'Solve the fixture',
    initial_context_ref: 'context://execution-1',
    input_snapshot_hash: 'snapshot-hash-1',
    input_material_refs: [],
  }, { operationId: 'claim-1' });
  assert.equal(claim.task.state, 'RUNNING');
  assert.equal(claim.execution.state, 'CREATED');
  assert.equal(claim.execution.fencing_version, 1);
  assert.equal(claim.execution.spec_hash, task.spec_hash);
  assert.equal(claim.execution.initial_context_ref, 'context://execution-1');

  const replay = context.claim({
    claim_key: 'claim-key-1', owner_ref: 'runtime:one', initial_prompt: 'Solve the fixture',
    initial_context_ref: 'context://execution-1', input_snapshot_hash: 'snapshot-hash-1', input_material_refs: [],
  }, { operationId: 'claim-1' });
  assert.equal(replay.execution.execution_id, claim.execution.execution_id);

  const freshContext = sdk.withContext({ taskId: task.task_id, specVersion: task.spec_version, stateVersion: claim.task.state_version });
  assert.throws(
    () => freshContext.claim({
      claim_key: 'claim-key-2', owner_ref: 'runtime:two', initial_prompt: 'another', initial_context_ref: 'context://two',
      input_snapshot_hash: 'snapshot-two', input_material_refs: [],
    }, { operationId: 'claim-2' }),
    (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.CONFLICT,
  );
  assert.equal(service.db.prepare("SELECT COUNT(*) AS count FROM executions WHERE task_id = ? AND state IN ('CREATED','RUNNING','WAITING')").get(task.task_id).count, 1);
  service.close();
});

test('execution heartbeat and lifecycle writes enforce state and fencing versions', () => {
  const { service, sdk } = rootService();
  const task = sdk.proposeTask(proofInput(), { operationId: 'propose-lifecycle' }).task;
  const taskSdk = sdk.withContext({ taskId: task.task_id, specVersion: 1, stateVersion: 0 });
  const claimed = taskSdk.claim({ claim_key: 'claim-lifecycle', owner_ref: 'runtime:one', initial_prompt: 'p', initial_context_ref: 'context://x', input_snapshot_hash: 'hash', input_material_refs: [] }, { operationId: 'claim-lifecycle' });
  const execSdk = sdk.withContext({ taskId: task.task_id, executionId: claimed.execution.execution_id, specVersion: 1, stateVersion: 0, fencingVersion: 1 });
  const started = execSdk.startExecution({}, { operationId: 'start-lifecycle' });
  assert.equal(started.execution.state, 'RUNNING');
  assert.equal(started.execution.state_version, 1);
  const runningSdk = execSdk.withContext({ stateVersion: 1 });
  const heartbeat = runningSdk.heartbeat({}, { operationId: 'heartbeat-lifecycle' });
  assert.equal(heartbeat.execution.state_version, 2);
  assert.throws(
    () => execSdk.heartbeat({}, { operationId: 'old-heartbeat' }),
    (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.STALE_VERSION,
  );
  const fenced = runningSdk.withContext({ stateVersion: 2 }).fenceExecution({}, { operationId: 'fence-lifecycle' });
  assert.equal(fenced.execution.state, 'FENCED');
  assert.equal(fenced.execution.fencing_version, 2);
  assert.throws(
    () => runningSdk.heartbeat({}, { operationId: 'late-heartbeat' }),
    (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.FENCED,
  );
  service.close();
});

test('child creation requires a registered type and parent execution owner, then deduplicates its key', () => {
  const { service, sdk } = rootService();
  const parent = sdk.proposeTask({ ...proofInput(), task_type: 'default', completion_contract: { required_children: [] } }, { operationId: 'propose-parent' }).task;
  const parentSdk = sdk.withContext({ taskId: parent.task_id, specVersion: 1, stateVersion: 0 });
  const claim = parentSdk.claim({ claim_key: 'parent-claim', owner_ref: 'owner:root', initial_prompt: 'parent', initial_context_ref: 'context://parent', input_snapshot_hash: 'parent-hash', input_material_refs: [] }, { operationId: 'parent-claim-op' });
  const childSdk = sdk.withContext({ taskId: parent.task_id, specVersion: 1, stateVersion: claim.task.state_version });
  const child = childSdk.createChildTask({
    child_creation_key: 'child-key-1', task_type: 'research', goal: 'Find a useful lemma', expected_output: 'Sourced material',
    acceptance_conditions: { sources: true }, owner_ref: 'researcher:one',
  }, { operationId: 'create-child-1' });
  assert.equal(child.task.parent_id, parent.task_id);
  assert.equal(child.task.root_id, parent.root_id);
  const replay = childSdk.createChildTask({
    child_creation_key: 'child-key-1', task_type: 'research', goal: 'Find a useful lemma', expected_output: 'Sourced material',
    acceptance_conditions: { sources: true }, owner_ref: 'researcher:one',
  }, { operationId: 'create-child-1' });
  assert.equal(replay.task.task_id, child.task.task_id);
  assert.equal(service.listChildren(parent.task_id).length, 1);
  service.close();
});

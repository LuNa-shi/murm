import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ERROR_CODES, makeEnvelope, ServicesSDK, SwarmEnvError, TaskService } from '../src/index.js';

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
    workspace_manifest_ref: 'context://execution-1',
    input_snapshot_hash: 'snapshot-hash-1',
    input_material_refs: [],
  }, { operationId: 'claim-1' });
  assert.equal(claim.task.state, 'RUNNING');
  assert.equal(claim.execution.state, 'CREATED');
  assert.equal(claim.execution.fencing_version, 1);
  assert.equal(claim.execution.spec_hash, task.spec_hash);
  assert.equal(claim.execution.workspace_manifest_ref, 'context://execution-1');

  const replay = context.claim({
    claim_key: 'claim-key-1', owner_ref: 'runtime:one', initial_prompt: 'Solve the fixture',
    workspace_manifest_ref: 'context://execution-1', input_snapshot_hash: 'snapshot-hash-1', input_material_refs: [],
  }, { operationId: 'claim-1' });
  assert.equal(replay.execution.execution_id, claim.execution.execution_id);

  const freshContext = sdk.withContext({ taskId: task.task_id, specVersion: task.spec_version, stateVersion: claim.task.state_version });
  assert.throws(
    () => freshContext.claim({
      claim_key: 'claim-key-2', owner_ref: 'runtime:two', initial_prompt: 'another', workspace_manifest_ref: 'context://two',
      input_snapshot_hash: 'snapshot-two', input_material_refs: [],
    }, { operationId: 'claim-2' }),
    (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.CONFLICT,
  );
  assert.equal(service.db.prepare("SELECT COUNT(*) AS count FROM executions WHERE task_id = ? AND state IN ('CREATED','RUNNING','WAITING')").get(task.task_id).count, 1);
  service.close();
});

test('a Task can expose multiple parallel Executions up to its quota', () => {
  const { service, sdk } = rootService();
  const task = sdk.proposeTask(proofInput({ parallel_quota: 2 }), { operationId: 'propose-parallel' }).task;
  const first = sdk.withContext({ taskId: task.task_id, specVersion: task.spec_version, stateVersion: task.state_version }).claim({
    claim_key: 'parallel-claim-one', owner_ref: 'agent:one', workspace_mode: 'clean',
  }, { operationId: 'parallel-claim-one' });
  const available = sdk.withContext({ actorRef: 'agent:two' }).listTasks({ limit: 10 });
  assert.equal(available[0].task_id, task.task_id);
  const second = sdk.withContext({ taskId: task.task_id, specVersion: task.spec_version, stateVersion: first.task.state_version }).claim({
    claim_key: 'parallel-claim-two', owner_ref: 'agent:two', workspace_mode: 'clean',
  }, { operationId: 'parallel-claim-two' });
  assert.notEqual(second.execution.execution_id, first.execution.execution_id);
  assert.equal(service.listExecutions(task.task_id, { includeTerminal: false }).length, 2);
  assert.equal(service.listTasks({ limit: 10 }).length, 0);
  assert.throws(
    () => sdk.withContext({ taskId: task.task_id, specVersion: task.spec_version, stateVersion: second.task.state_version }).claim({
      claim_key: 'parallel-claim-three', owner_ref: 'agent:three', workspace_mode: 'clean',
    }, { operationId: 'parallel-claim-three' }),
    (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.CONFLICT,
  );
  service.close();
});

test('workers browse prioritized Tasks and explicitly claim the selected Task', () => {
  const { service, sdk } = rootService();
  const root = sdk.proposeTask({
    ...proofInput({ task_type: 'default' }),
    max_children: 4,
  }, { operationId: 'browse-root' }).task;
  const rootRun = sdk.withContext({ taskId: root.task_id, specVersion: root.spec_version, stateVersion: root.state_version }).claim({
    claim_key: 'browse-root-claim', owner_ref: 'agent:planner', agent_prompt: 'generic agent prompt',
  }, { operationId: 'browse-root-claim' });
  const rootOwner = sdk.withContext({
    actorRef: 'agent:planner', taskId: root.task_id, executionId: rootRun.execution.execution_id,
    specVersion: rootRun.execution.spec_version, stateVersion: rootRun.execution.state_version, fencingVersion: rootRun.execution.fencing_version,
  });
  const low = rootOwner.withContext({ stateVersion: service.getTask(root.task_id).state_version }).createChildTask({
    child_creation_key: 'browse-low', task_type: 'research', goal: 'low priority research', expected_output: 'material', acceptance_conditions: {}, priority: 10,
  }, { operationId: 'browse-low' }).task;
  const high = rootOwner.withContext({ stateVersion: service.getTask(root.task_id).state_version }).createChildTask({
    child_creation_key: 'browse-high', task_type: 'research', goal: 'high priority research', expected_output: 'material', acceptance_conditions: {}, priority: 90,
  }, { operationId: 'browse-high' }).task;
  const listed = sdk.withContext({ actorRef: 'agent:worker' }).listTasks({ root_id: root.task_id, limit: 10 });
  assert.deepEqual(listed.map((task) => task.task_id), [high.task_id, low.task_id]);
  assert.equal(listed[0].latest_execution, null);
  const selected = listed[0];
  const claimed = sdk.withContext({ actorRef: 'agent:worker', taskId: selected.task_id, specVersion: selected.spec_version, stateVersion: selected.state_version }).claim({
    claim_key: 'browse-explicit-claim', owner_ref: 'agent:worker', workspace_mode: 'clean',
  }, { operationId: 'browse-explicit-claim' });
  assert.equal(claimed.task.task_id, high.task_id);
  assert.equal(service.listTasks({ rootId: root.task_id, limit: 10 }).length, 1);
  assert.equal(service.listExecutions(high.task_id)[0].workspace_selection.mode, 'clean');
  service.close();
});

test('execution heartbeat and lifecycle writes enforce state and fencing versions', () => {
  const { service, sdk } = rootService();
  const task = sdk.proposeTask(proofInput(), { operationId: 'propose-lifecycle' }).task;
  const taskSdk = sdk.withContext({ taskId: task.task_id, specVersion: 1, stateVersion: 0 });
  const claimed = taskSdk.claim({ claim_key: 'claim-lifecycle', owner_ref: 'runtime:one', initial_prompt: 'p', workspace_manifest_ref: 'context://x', input_snapshot_hash: 'hash', input_material_refs: [] }, { operationId: 'claim-lifecycle' });
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

test('an expired waiting Execution is visible and explicit claim hands it to the next Agent', () => {
  const { service, sdk } = rootService();
  const task = sdk.proposeTask(proofInput(), { operationId: 'propose-wait-takeover' }).task;
  const claimed = sdk.withContext({ taskId: task.task_id, specVersion: 1, stateVersion: 0 }).claim({
    claim_key: 'wait-takeover-first', owner_ref: 'agent:first', workspace_mode: 'clean',
  }, { operationId: 'wait-takeover-first' });
  const started = service.dispatch('start_execution', {}, makeEnvelope({
    operationId: 'wait-takeover-start', actorRef: 'agent:first', taskId: task.task_id, executionId: claimed.execution.execution_id,
    specVersion: 1, stateVersion: 0, fencingVersion: 1,
  }));
  const checkpointed = service.dispatch('save_checkpoint', {
    checkpoint_ref: 'checkpoint:wait-takeover', checkpoint_hash: 'hash:wait-takeover', workspace_revision: null,
  }, makeEnvelope({
    operationId: 'wait-takeover-checkpoint', actorRef: 'agent:first', taskId: task.task_id, executionId: claimed.execution.execution_id,
    specVersion: 1, stateVersion: started.execution.state_version, fencingVersion: 1,
  }));
  const waited = service.dispatch('request_wait', {
    checkpoint_ref: checkpointed.execution.checkpoint_ref, checkpoint_hash: checkpointed.execution.checkpoint_hash,
    wait_condition: { type: 'timer', deadline: new Date(Date.now() - 1000).toISOString() },
  }, makeEnvelope({
    operationId: 'wait-takeover-wait', actorRef: 'agent:first', taskId: task.task_id, executionId: claimed.execution.execution_id,
    specVersion: 1, stateVersion: checkpointed.execution.state_version, fencingVersion: 1,
  }));
  const listed = sdk.withContext({ actorRef: 'agent:second' }).listTasks({ limit: 10 });
  assert.equal(listed[0].task_id, task.task_id);
  assert.equal(listed[0].latest_execution.state, 'WAITING');
  const resumed = sdk.withContext({ actorRef: 'agent:second', taskId: task.task_id, specVersion: 1, stateVersion: waited.task.state_version }).claim({
    claim_key: 'wait-takeover-second', workspace_mode: 'resume',
  }, { operationId: 'wait-takeover-second' });
  assert.equal(resumed.execution.execution_id, claimed.execution.execution_id);
  assert.equal(resumed.execution.owner_ref, 'agent:second');
  assert.equal(resumed.execution.state, 'CREATED');
  assert.equal(resumed.execution.attempt_no, 2);
  service.close();
});

test('a checker waiting Execution stays unavailable until its CheckResult arrives', () => {
  const { service, sdk } = rootService();
  const task = sdk.proposeTask(proofInput(), { operationId: 'propose-check-wait' }).task;
  const claimed = sdk.withContext({ taskId: task.task_id, specVersion: 1, stateVersion: 0 }).claim({
    claim_key: 'check-wait-claim', owner_ref: 'agent:checker', workspace_mode: 'clean',
  }, { operationId: 'check-wait-claim' });
  const started = service.dispatch('start_execution', {}, makeEnvelope({
    operationId: 'check-wait-start', actorRef: 'agent:checker', taskId: task.task_id, executionId: claimed.execution.execution_id,
    specVersion: 1, stateVersion: claimed.execution.state_version, fencingVersion: 1,
  }));
  const checkpointed = service.dispatch('save_checkpoint', {
    checkpoint_ref: 'checkpoint:check-wait', checkpoint_hash: 'hash:check-wait', workspace_revision: null,
  }, makeEnvelope({
    operationId: 'check-wait-checkpoint', actorRef: 'agent:checker', taskId: task.task_id, executionId: claimed.execution.execution_id,
    specVersion: 1, stateVersion: started.execution.state_version, fencingVersion: 1,
  }));
  service.dispatch('request_wait', {
    checkpoint_ref: checkpointed.execution.checkpoint_ref, checkpoint_hash: checkpointed.execution.checkpoint_hash,
    wait_condition: { type: 'check_result_arrived', check_request_key: 'check:arrives-later' },
  }, makeEnvelope({
    operationId: 'check-wait-request', actorRef: 'agent:checker', taskId: task.task_id, executionId: claimed.execution.execution_id,
    specVersion: 1, stateVersion: checkpointed.execution.state_version, fencingVersion: 1,
  }));
  assert.equal(sdk.withContext({ actorRef: 'agent:next' }).listTasks({ limit: 10 }).length, 0);
  const timestamp = new Date().toISOString();
  service.db.prepare(`INSERT INTO check_results (
    check_result_id, request_key, request_hash, candidate_material_id, target_task_id, target_spec_version,
    execution_id, input_snapshot_hash, checker_ref, checker_version, environment_ref, status, verdict, evidence_json,
    applied_task_state_version, applied_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RECEIVED', 'FAIL', ?, NULL, NULL, ?, ?)`).run(
    'check-result-later', 'check:arrives-later', 'request-hash', 'candidate-material', task.task_id, task.spec_version,
    claimed.execution.execution_id, claimed.execution.input_snapshot_hash, 'lean', 'mvp-1', 'putnambench-test', '{}', timestamp, timestamp,
  );
  assert.equal(sdk.withContext({ actorRef: 'agent:next' }).listTasks({ limit: 10 })[0].task_id, task.task_id);
  service.close();
});

test('child creation requires a registered type and parent execution owner, then deduplicates its key', () => {
  const { service, sdk } = rootService();
  const parent = sdk.proposeTask({ ...proofInput(), task_type: 'default', completion_contract: { required_children: [] } }, { operationId: 'propose-parent' }).task;
  const parentSdk = sdk.withContext({ taskId: parent.task_id, specVersion: 1, stateVersion: 0 });
  const claim = parentSdk.claim({ claim_key: 'parent-claim', owner_ref: 'owner:root', initial_prompt: 'parent', workspace_manifest_ref: 'context://parent', input_snapshot_hash: 'parent-hash', input_material_refs: [] }, { operationId: 'parent-claim-op' });
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

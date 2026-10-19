import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  ContextService,
  JudgeService,
  ServicesRouter,
  ServicesSDK,
  SwarmEnvError,
  TaskService,
  ERROR_CODES,
  makeEnvelope,
} from '../src/index.js';

const fixtureManifest = {
  fixture_id: 'putnam-1966-a1',
  putnambench_commit: 'a635813f5edf297d928f9bd5ef8324a26bdde09c',
  problem_file: 'lean4/src/putnam_1966_a1.lean',
  problem_file_hash: '4b1bd530669e71e5909398d54caddeb65eb33a708850e25ba4f1d7fc88ba0cad',
  lean_toolchain: 'leanprover/lean4:v4.33.1',
  mathlib_version: '0df444a360eaa60ab8c11dca51a86af692955474',
  checker_ref: 'lean',
  checker_version: 'mvp-1',
  environment_ref: 'putnambench-lean4@a635813f5edf297d928f9bd5ef8324a26bdde09c',
};

function environment({ checker = null } = {}) {
  const database = new DatabaseSync(':memory:');
  const contextService = new ContextService(database);
  const taskService = new TaskService(database, { contextService });
  contextService.taskService = taskService;
  const judgeService = new JudgeService(database, { checker: checker ?? { check: async () => ({ verdict: 'PASS', evidence: { exit_code: 0 } }) } });
  const router = new ServicesRouter({ taskService, contextService });
  const sdk = new ServicesSDK(router, { actorRef: 'owner:root' });
  return { database, contextService, taskService, judgeService, router, sdk };
}

function proofInput(overrides = {}) {
  return {
    task_type: 'proof', goal: 'prove the fixture theorem', expected_output: 'proof artifact',
    acceptance_conditions: { fixture: 'putnam-1966-a1' }, owner_ref: 'owner:root', ...overrides,
  };
}

function researchInput(overrides = {}) {
  return {
    task_type: 'research', goal: 'find a useful lemma', expected_output: 'sourced material',
    acceptance_conditions: { sources: true }, owner_ref: 'researcher:one', ...overrides,
  };
}

function claimTask(env, task, { executionId, actorRef, ownerRef = actorRef, prompt = 'work on the task' }) {
  const actor = env.sdk.withContext({ actorRef });
  const claim = actor.withContext({ taskId: task.task_id, specVersion: task.spec_version, stateVersion: task.state_version }).claim({
    execution_id: executionId, claim_key: `claim:${executionId}`, owner_ref: ownerRef, agent_prompt: prompt, input_material_refs: [],
  }, { operationId: `claim-op:${executionId}` });
  const workspace = { task_id: task.task_id, execution_id: executionId, input_snapshot_hash: claim.execution.input_snapshot_hash };
  return { workspace, claim, sdk: env.sdk.withContext({ actorRef, taskId: task.task_id, executionId, specVersion: task.spec_version, stateVersion: claim.execution.state_version, fencingVersion: claim.execution.fencing_version }) };
}

function saveCheckpoint(env, execution, checkpointRef = `checkpoint:${execution.execution_id}`) {
  let current = execution;
  if (current.workspace_revision === null) {
    current = env.taskService.dispatch('save_workspace_revision', {
      workspace_ref: `workspace:${execution.execution_id}`, workspace_revision: 1, workspace_content_hash: `workspace-hash:${execution.execution_id}`,
    }, makeEnvelope({ operationId: `workspace-op:${checkpointRef}`, actorRef: execution.owner_ref, taskId: execution.task_id, executionId: execution.execution_id, specVersion: execution.spec_version, stateVersion: execution.state_version, fencingVersion: execution.fencing_version })).execution;
  }
  return env.taskService.dispatch('save_checkpoint', {
    checkpoint_ref: checkpointRef, checkpoint_hash: `hash:${checkpointRef}`, workspace_ref: current.workspace_ref, workspace_revision: current.workspace_revision,
  }, makeEnvelope({ operationId: `checkpoint-op:${checkpointRef}`, actorRef: execution.owner_ref, taskId: execution.task_id, executionId: execution.execution_id, specVersion: execution.spec_version, stateVersion: current.state_version, fencingVersion: current.fencing_version })).execution;
}

function waitWithCheckpoint(env, sdk, execution, type, waitKey, checkpointRef = `checkpoint:${execution.execution_id}`) {
  const checkpointed = execution.checkpoint_ref === checkpointRef ? execution : saveCheckpoint(env, execution, checkpointRef);
  const currentSdk = sdk.withContext({ stateVersion: checkpointed.state_version });
  return {
    checkpointed,
    waited: currentSdk.requestWait({
      wait_key: waitKey, checkpoint_ref: checkpointed.checkpoint_ref, checkpoint_hash: checkpointed.checkpoint_hash,
      wait_condition: { type },
    }, { operationId: `wait-op:${waitKey}` }),
  };
}

function close(env) {
  env.taskService.close();
}

test('research child review accepts delivered Material and never invokes Judge', () => {
  let checks = 0;
  const env = environment({ checker: { check: async () => { checks += 1; return { verdict: 'PASS', evidence: {} }; } } });
  const parent = env.sdk.proposeTask({ task_type: 'default', goal: 'coordinate research', expected_output: 'child result', acceptance_conditions: {}, owner_ref: 'owner:root' }, { operationId: 'parent-propose' }).task;
  const parentRun = claimTask(env, parent, { executionId: 'parent-execution', actorRef: 'owner:root' });
  const child = parentRun.sdk.withContext({ taskId: parent.task_id, executionId: null, stateVersion: parentRun.claim.task.state_version }).createChildTask({
    child_creation_key: 'research-child', ...researchInput(), owner_ref: 'researcher:one',
  }, { operationId: 'child-create' }).task;
  const childRun = claimTask(env, child, { executionId: 'child-execution', actorRef: 'researcher:one' });
  const material = childRun.sdk.publishMaterial({ kind: 'fact', scope: 'proof_relevant', content: { lemma: 'useful' } }, { operationId: 'research-material' }).material;
  assert.equal(material.source_task, child.task_id);
  const checkpointed = saveCheckpoint(env, childRun.claim.execution, 'research-checkpoint');
  const waited = childRun.sdk.withContext({ stateVersion: checkpointed.state_version }).requestWait({
    wait_key: 'research-review', checkpoint_ref: checkpointed.checkpoint_ref, checkpoint_hash: checkpointed.checkpoint_hash,
    wait_condition: { type: 'parent_review' },
  }, { operationId: 'research-wait' });
  assert.equal(waited.execution.state, 'WAITING');
  const accepted = parentRun.sdk.acceptTask({ target_task_id: child.task_id, target_state_version: waited.task.state_version }, { operationId: 'research-accept' });
  assert.equal(accepted.task.state, 'SATISFIED');
  assert.equal(accepted.execution.state, 'SUCCEEDED');
  assert.equal(env.taskService.getTask(parent.task_id).state, 'RUNNING', 'child acceptance must not close the Parent Task');
  assert.equal(checks, 0);
  assert.equal(env.taskService.db.prepare('SELECT COUNT(*) AS count FROM check_results').get().count, 0);
  close(env);
});

test('root owner acceptance completes an unchecked research Task', () => {
  const env = environment();
  const task = env.sdk.proposeTask({ ...researchInput(), owner_ref: 'owner:root', goal: 'root research' }, { operationId: 'root-research-propose' }).task;
  const run = claimTask(env, task, { executionId: 'root-research-execution', actorRef: 'owner:root' });
  run.sdk.publishMaterial({ kind: 'fact', scope: 'operational', content: { source: 'primary source' } }, { operationId: 'root-research-material' });
  assert.throws(() => env.sdk.withContext({ actorRef: 'agent:other', taskId: task.task_id }).acceptTask({ target_task_id: task.task_id }, { operationId: 'root-research-bad-owner' }), (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.NOT_ALLOWED);
  const accepted = run.sdk.acceptTask({ target_task_id: task.task_id, target_state_version: run.claim.task.state_version }, { operationId: 'root-research-accept' });
  assert.equal(accepted.task.state, 'SATISFIED');
  assert.equal(accepted.execution.state, 'SUCCEEDED');
  assert.equal(env.taskService.db.prepare('SELECT COUNT(*) AS count FROM check_results').get().count, 0);
  close(env);
});

test('parent request_rework appends steer and preserves child workspace, context, and checkpoint lineage', () => {
  const env = environment();
  const parent = env.sdk.proposeTask({ task_type: 'default', goal: 'coordinate rework', expected_output: 'child result', acceptance_conditions: {}, owner_ref: 'owner:root' }, { operationId: 'rework-parent' }).task;
  const parentRun = claimTask(env, parent, { executionId: 'rework-parent-execution', actorRef: 'owner:root' });
  const child = parentRun.sdk.withContext({ taskId: parent.task_id, executionId: null, stateVersion: parentRun.claim.task.state_version }).createChildTask({
    child_creation_key: 'rework-child', ...researchInput(), owner_ref: 'researcher:one',
  }, { operationId: 'rework-child-create' }).task;
  const childRun = claimTask(env, child, { executionId: 'rework-child-execution', actorRef: 'researcher:one' });
  childRun.sdk.publishMaterial({ kind: 'fact', scope: 'proof_relevant', content: { lemma: 'needs revision' } }, { operationId: 'rework-material' });
  const checkpointed = saveCheckpoint(env, childRun.claim.execution, 'rework-checkpoint');
  const waited = childRun.sdk.withContext({ stateVersion: checkpointed.state_version }).requestWait({
    wait_key: 'rework-review', checkpoint_ref: checkpointed.checkpoint_ref, checkpoint_hash: checkpointed.checkpoint_hash,
    wait_condition: { type: 'parent_review' },
  }, { operationId: 'rework-wait' });
  const result = parentRun.sdk.requestRework({ target_task_id: child.task_id, instruction: 'Add the missing source comparison.' }, { operationId: 'rework-request' });
  assert.equal(result.task.state, 'RUNNING');
  assert.equal(result.execution.execution_id, childRun.claim.execution.execution_id);
  assert.equal(result.execution.state, 'CREATED');
  assert.equal(result.execution.workspace_manifest_ref, waited.execution.workspace_manifest_ref);
  assert.equal(result.execution.workspace_ref, waited.execution.workspace_ref);
  assert.equal(result.execution.checkpoint_ref, waited.execution.checkpoint_ref);
  assert.equal(result.execution.instruction_version, 2);
  assert.equal(result.execution.steer_material_refs.length, 1);
  assert.equal(env.contextService.getMaterial(result.execution.steer_material_refs[0]).kind, 'steer');
  close(env);
});

test('parent request_rework creates a new Execution after the child is fenced', () => {
  const env = environment();
  const parent = env.sdk.proposeTask({ task_type: 'default', goal: 'coordinate fenced rework', expected_output: 'child result', acceptance_conditions: {}, owner_ref: 'owner:root' }, { operationId: 'fenced-parent' }).task;
  const parentRun = claimTask(env, parent, { executionId: 'fenced-parent-execution', actorRef: 'owner:root' });
  const child = parentRun.sdk.withContext({ taskId: parent.task_id, executionId: null, stateVersion: parentRun.claim.task.state_version }).createChildTask({
    child_creation_key: 'fenced-child', ...researchInput(), owner_ref: 'researcher:one',
  }, { operationId: 'fenced-child-create' }).task;
  const childRun = claimTask(env, child, { executionId: 'fenced-child-execution', actorRef: 'researcher:one' });
  const checkpointed = saveCheckpoint(env, childRun.claim.execution, 'fenced-checkpoint');
  const waited = childRun.sdk.withContext({ stateVersion: checkpointed.state_version }).requestWait({
    wait_key: 'fenced-review', checkpoint_ref: checkpointed.checkpoint_ref, checkpoint_hash: checkpointed.checkpoint_hash,
    wait_condition: { type: 'parent_review' },
  }, { operationId: 'fenced-wait' });
  const fenced = childRun.sdk.withContext({ stateVersion: waited.execution.state_version }).fenceExecution({}, { operationId: 'fence-child' });
  const result = parentRun.sdk.requestRework({ target_task_id: child.task_id, instruction: 'Resume from the saved checkpoint.' }, { operationId: 'fenced-rework' });
  assert.equal(fenced.execution.state, 'FENCED');
  assert.notEqual(result.execution.execution_id, fenced.execution.execution_id);
  assert.equal(result.execution.attempt_no, 2);
  assert.equal(result.execution.workspace_manifest_ref, fenced.execution.workspace_manifest_ref);
  assert.equal(result.execution.workspace_ref, fenced.execution.workspace_ref);
  assert.equal(result.execution.checkpoint_ref, fenced.execution.checkpoint_ref);
  close(env);
});

test('proof FAIL is retained and recoverable, then matching PASS completes the Task', async () => {
  let verdict = 'FAIL';
  const env = environment({ checker: { check: async () => ({ verdict, evidence: { diagnostic: verdict === 'FAIL' ? 'type mismatch' : 'compiled' } }) } });
  const task = env.sdk.proposeTask(proofInput(), { operationId: 'proof-propose' }).task;
  const run = claimTask(env, task, { executionId: 'proof-execution', actorRef: 'owner:root' });
  const workspace = ({ task_id: task.task_id, execution_id: run.claim.execution.execution_id, input_snapshot_hash: run.claim.execution.input_snapshot_hash });
  const firstCandidate = run.sdk.publishMaterial({ kind: 'artifact', scope: 'proof_relevant', content: { source: 'bad proof' } }, { operationId: 'proof-candidate-1' }).material;
  let current = run.sdk.submitCandidate({ candidate_material_id: firstCandidate.material_id }, { operationId: 'submit-candidate-1' });
  let checkpointed = saveCheckpoint(env, current.execution, 'proof-checkpoint-1');
  let currentSdk = run.sdk.withContext({ stateVersion: current.execution.state_version });
  let waited = currentSdk.withContext({ stateVersion: checkpointed.state_version }).requestWait({
    wait_key: 'proof-check-1', checkpoint_ref: checkpointed.checkpoint_ref, checkpoint_hash: checkpointed.checkpoint_hash,
    wait_condition: { type: 'check_result_arrived', check_request_key: 'proof-request-1' },
  }, { operationId: 'proof-wait-1' });
  const firstResult = await env.judgeService.judgeCandidate({
    request_key: 'proof-request-1', candidate_material_id: firstCandidate.material_id, target_task_id: task.task_id, target_spec_version: task.spec_version,
    input_snapshot_hash: workspace.input_snapshot_hash, checker_ref: fixtureManifest.checker_ref, checker_version: fixtureManifest.checker_version,
    environment_ref: fixtureManifest.environment_ref, execution_id: waited.execution.execution_id, state_version: waited.execution.state_version,
    candidate: { material_id: firstCandidate.material_id, content: 'bad proof' }, target_task: env.taskService.getTask(task.task_id), workspace: workspace,
    fixture_manifest: fixtureManifest,
  });
  current = waited.execution;
  const failed = env.sdk.withContext({ taskId: task.task_id, executionId: current.execution_id, specVersion: current.spec_version, stateVersion: current.state_version, fencingVersion: current.fencing_version })
    .applyCheckResult({ check_result_id: firstResult.check_result_id }, { operationId: 'apply-fail' });
  assert.equal(failed.check_result.verdict, 'FAIL');
  assert.equal(failed.check_result.status, 'APPLIED');
  assert.equal(failed.task.state, 'WAITING');
  assert.equal(failed.execution.state, 'WAITING');

  verdict = 'PASS';
  const secondMaterial = env.contextService.dispatch('publish_material', { kind: 'artifact', scope: 'proof_relevant', content: { source: 'fixed proof' } }, makeEnvelope({
    operationId: 'proof-candidate-2', actorRef: 'owner:root', taskId: task.task_id, executionId: failed.execution.execution_id,
    specVersion: failed.execution.spec_version, stateVersion: failed.execution.state_version, fencingVersion: failed.execution.fencing_version,
  })).material;
  currentSdk = env.sdk.withContext({ taskId: task.task_id, executionId: failed.execution.execution_id, specVersion: 1, stateVersion: failed.execution.state_version, fencingVersion: 1 });
  current = currentSdk
    .submitCandidate({ candidate_material_id: secondMaterial.material_id }, { operationId: 'submit-candidate-2' });
  checkpointed = saveCheckpoint(env, current.execution, 'proof-checkpoint-2');
  waited = currentSdk.withContext({ stateVersion: checkpointed.state_version }).requestWait({
    wait_key: 'proof-check-2', checkpoint_ref: checkpointed.checkpoint_ref, checkpoint_hash: checkpointed.checkpoint_hash,
    wait_condition: { type: 'check_result_arrived', check_request_key: 'proof-request-2' },
  }, { operationId: 'proof-wait-2' });
  const secondResult = await env.judgeService.judgeCandidate({
    request_key: 'proof-request-2', candidate_material_id: secondMaterial.material_id, target_task_id: task.task_id, target_spec_version: 1,
    input_snapshot_hash: workspace.input_snapshot_hash, checker_ref: fixtureManifest.checker_ref, checker_version: fixtureManifest.checker_version,
    environment_ref: fixtureManifest.environment_ref, execution_id: waited.execution.execution_id, state_version: waited.execution.state_version,
    candidate: { material_id: secondMaterial.material_id, content: 'fixed proof' }, target_task: env.taskService.getTask(task.task_id), workspace: workspace,
    fixture_manifest: fixtureManifest,
  });
  const completed = env.sdk.withContext({ taskId: task.task_id, executionId: waited.execution.execution_id, specVersion: 1, stateVersion: waited.execution.state_version, fencingVersion: 1 })
    .applyCheckResult({ check_result_id: secondResult.check_result_id }, { operationId: 'apply-pass' });
  assert.equal(completed.check_result.verdict, 'PASS');
  assert.equal(completed.task.state, 'SATISFIED');
  assert.equal(completed.execution.state, 'SUCCEEDED');
  close(env);
});

test('wait requires a saved checkpoint and wake is idempotent by wake_key', () => {
  const env = environment();
  const task = env.sdk.proposeTask(proofInput(), { operationId: 'wake-propose' }).task;
  const run = claimTask(env, task, { executionId: 'wake-execution', actorRef: 'owner:root' });
  assert.throws(() => run.sdk.requestWait({ wait_key: 'missing-checkpoint', checkpoint_ref: 'missing', checkpoint_hash: 'missing', wait_condition: { type: 'timer', deadline: new Date(Date.now() + 1000).toISOString() } }, { operationId: 'missing-checkpoint-op' }), (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.INVALID_CONTRACT);
  const checkpointed = saveCheckpoint(env, run.claim.execution, 'wake-checkpoint');
  const waitingSdk = run.sdk.withContext({ stateVersion: checkpointed.state_version });
  const waited = waitingSdk.requestWait({ wait_key: 'wake-request', checkpoint_ref: checkpointed.checkpoint_ref, checkpoint_hash: checkpointed.checkpoint_hash, wait_condition: { type: 'timer', deadline: new Date(Date.now() + 1000).toISOString() } }, { operationId: 'wake-wait' });
  const wakeSdk = waitingSdk.withContext({ stateVersion: waited.execution.state_version });
  const first = wakeSdk.wakeExecution({ wake_key: 'wake-once' }, { operationId: 'wake-1' });
  const replay = wakeSdk.wakeExecution({ wake_key: 'wake-once' }, { operationId: 'wake-2' });
  assert.equal(first.execution.state, 'RUNNING');
  assert.equal(replay.execution.execution_id, waited.execution.execution_id);
  assert.equal(replay.execution.state, 'RUNNING');
  assert.equal(env.taskService.db.prepare('SELECT COUNT(*) AS count FROM wake_keys').get().count, 1);
  close(env);
});

test('fenced and cancelled Executions cannot be revived by late CheckResults', async () => {
  const env = environment({ checker: { check: async () => ({ verdict: 'PASS', evidence: { exit_code: 0 } }) } });
  const task = env.sdk.proposeTask(proofInput(), { operationId: 'late-propose' }).task;
  const run = claimTask(env, task, { executionId: 'late-execution', actorRef: 'owner:root' });
  const material = run.sdk.publishMaterial({ kind: 'artifact', scope: 'proof_relevant', content: { source: 'late candidate' } }, { operationId: 'late-candidate' }).material;
  const submitted = run.sdk.submitCandidate({ candidate_material_id: material.material_id }, { operationId: 'late-submit' });
  const workspace = ({ task_id: task.task_id, execution_id: run.claim.execution.execution_id, input_snapshot_hash: run.claim.execution.input_snapshot_hash });
  const result = await env.judgeService.judgeCandidate({
    request_key: 'late-request', candidate_material_id: material.material_id, target_task_id: task.task_id, target_spec_version: 1,
    input_snapshot_hash: workspace.input_snapshot_hash, checker_ref: fixtureManifest.checker_ref, checker_version: fixtureManifest.checker_version,
    environment_ref: fixtureManifest.environment_ref, execution_id: submitted.execution.execution_id, state_version: submitted.execution.state_version,
    candidate: { material_id: material.material_id, content: 'late candidate' }, target_task: env.taskService.getTask(task.task_id), workspace: workspace,
    fixture_manifest: fixtureManifest,
  });
  const oldSdk = env.sdk.withContext({ taskId: task.task_id, executionId: submitted.execution.execution_id, specVersion: 1, stateVersion: submitted.execution.state_version, fencingVersion: 1 });
  const fenced = oldSdk.fenceExecution({}, { operationId: 'late-fence' });
  assert.throws(() => oldSdk.applyCheckResult({ check_result_id: result.check_result_id }, { operationId: 'late-apply-fenced' }), (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.FENCED);
  assert.equal(fenced.task.state, 'OPEN');

  const cancelledTask = env.sdk.proposeTask(proofInput({ goal: 'cancelled late result' }), { operationId: 'cancelled-propose' }).task;
  const cancelledRun = claimTask(env, cancelledTask, { executionId: 'cancelled-execution', actorRef: 'owner:root' });
  const cancelledMaterial = cancelledRun.sdk.publishMaterial({ kind: 'artifact', scope: 'proof_relevant', content: { source: 'cancelled candidate' } }, { operationId: 'cancelled-candidate' }).material;
  const cancelledSubmitted = cancelledRun.sdk.submitCandidate({ candidate_material_id: cancelledMaterial.material_id }, { operationId: 'cancelled-submit' });
  const cancelledWorkspace = ({ task_id: cancelledTask.task_id, execution_id: cancelledRun.claim.execution.execution_id, input_snapshot_hash: cancelledRun.claim.execution.input_snapshot_hash });
  const cancelledResult = await env.judgeService.judgeCandidate({
    request_key: 'cancelled-request', candidate_material_id: cancelledMaterial.material_id, target_task_id: cancelledTask.task_id, target_spec_version: 1,
    input_snapshot_hash: cancelledWorkspace.input_snapshot_hash, checker_ref: fixtureManifest.checker_ref, checker_version: fixtureManifest.checker_version,
    environment_ref: fixtureManifest.environment_ref, execution_id: cancelledSubmitted.execution.execution_id, state_version: cancelledSubmitted.execution.state_version,
    candidate: { material_id: cancelledMaterial.material_id, content: 'cancelled candidate' }, target_task: env.taskService.getTask(cancelledTask.task_id), workspace: cancelledWorkspace,
    fixture_manifest: fixtureManifest,
  });
  const cancelledSdk = env.sdk.withContext({ taskId: cancelledTask.task_id, executionId: cancelledSubmitted.execution.execution_id, specVersion: 1, stateVersion: cancelledSubmitted.execution.state_version, fencingVersion: 1 });
  cancelledSdk.abort({}, { operationId: 'cancelled-abort' });
  const ignored = env.taskService.dispatch('apply_check_result', { check_result_id: cancelledResult.check_result_id }, makeEnvelope({ operationId: 'cancelled-late-apply', actorRef: 'system:task-flow', taskId: cancelledTask.task_id, specVersion: 1 }));
  assert.equal(ignored.task.state, 'CANCELLED');
  assert.equal(ignored.check_result.status, 'IGNORED');
  close(env);
});

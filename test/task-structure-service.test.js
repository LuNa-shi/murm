import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ERROR_CODES, ServicesSDK, SwarmEnvError, TaskService } from '../src/index.js';

function fixture() {
  const service = new TaskService(new DatabaseSync(':memory:'));
  const sdk = new ServicesSDK(service, { actorRef: 'owner:root' });
  const task = sdk.proposeTask({
    task_type: 'default', goal: 'coordinate work', expected_output: 'a result', acceptance_conditions: {},
    max_children: 12,
  }, { operationId: 'structure-root' }).task;
  const claim = sdk.withContext({ taskId: task.task_id, specVersion: task.spec_version, stateVersion: task.state_version }).claim({
    claim_key: 'structure-claim', owner_ref: 'owner:root', workspace_mode: 'clean',
  }, { operationId: 'structure-claim' });
  const owner = sdk.withContext({
    actorRef: 'owner:root', taskId: task.task_id, executionId: claim.execution.execution_id,
    specVersion: claim.execution.spec_version, stateVersion: claim.execution.state_version,
    fencingVersion: claim.execution.fencing_version,
  });
  return { service, sdk, task, claim, owner };
}

test('branch groups are ordinary independently claimable Tasks and Branch Tasks cannot nest branches', () => {
  const { service, sdk, task, owner } = fixture();
  const result = owner.createBranchGroup({
    parent_task_id: task.task_id,
    group_id: 'alternatives',
    branch_tasks: [
      { task_id: 'branch-a', task_type: 'research', goal: 'try route A', expected_output: 'route A material', acceptance_conditions: {} },
      { task_id: 'branch-b', task_type: 'research', goal: 'try route B', expected_output: 'route B material', acceptance_conditions: {} },
    ],
  }, { operationId: 'create-alternatives' });
  assert.deepEqual(result.group.member_task_ids, ['branch-a', 'branch-b']);
  assert.deepEqual(service.listTasks({ limit: 10 }).map((candidate) => candidate.task_id), ['branch-a', 'branch-b']);

  const branchClaim = sdk.withContext({ taskId: 'branch-a', specVersion: 1, stateVersion: 0 }).claim({
    claim_key: 'branch-a-claim', owner_ref: 'agent:branch', workspace_mode: 'clean',
  }, { operationId: 'branch-a-claim' });
  const branchOwner = sdk.withContext({
    actorRef: 'agent:branch', taskId: 'branch-a', executionId: branchClaim.execution.execution_id,
    specVersion: 1, stateVersion: branchClaim.execution.state_version, fencingVersion: 1,
  });
  assert.throws(
    () => branchOwner.createBranchGroup({ parent_task_id: 'branch-a', branch_tasks: [{ goal: 'nested', expected_output: 'x', acceptance_conditions: {} }] }, { operationId: 'nested-branch' }),
    (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.BRANCH_TASK_CANNOT_CREATE_BRANCH,
  );
  service.close();
});

test('required subtasks are concurrent and structure/readiness views preserve membership versus dependency', () => {
  const { service, task, owner } = fixture();
  const first = owner.addRequiredSubtask({
    owner_task_id: task.task_id,
    group_id: 'required-work',
    subtask: { task_id: 'required-a', task_type: 'research', goal: 'check A', expected_output: 'A', acceptance_conditions: {} },
  }, { operationId: 'required-a' });
  const currentTask = service.getTask(task.task_id);
  const secondOwner = owner.withContext({ stateVersion: currentTask.state_version });
  const second = secondOwner.addRequiredSubtask({
    owner_task_id: task.task_id,
    group_id: first.group.group_id,
    subtask: { task_id: 'required-b', task_type: 'research', goal: 'check B', expected_output: 'B', acceptance_conditions: {} },
  }, { operationId: 'required-b' });
  assert.deepEqual(second.group.member_task_ids, ['required-a', 'required-b']);
  assert.equal(service.explainTaskReadiness('required-a').ready, true);
  const structure = service.getTaskStructure(task.task_id);
  assert.equal(structure.required_subtask_groups.length, 1);
  assert.deepEqual(structure.required_subtask_groups[0].member_task_ids, ['required-a', 'required-b']);
  assert.equal(structure.dependencies.length, 0);
  assert.equal(service.getTask(task.task_id).state, 'RUNNING', 'membership does not put the creator in a parent wait state');
  void first;
  service.close();
});

test('explicit Task dependencies explain BLOCKED/READY while rework creates linked evidence', () => {
  const { service, sdk, task, owner } = fixture();
  const prerequisite = owner.addRequiredSubtask({
    owner_task_id: task.task_id,
    subtask: { task_id: 'prerequisite', task_type: 'default', goal: 'prepare input', expected_output: 'input', acceptance_conditions: {} },
  }, { operationId: 'prerequisite' }).subtask;
  const dependent = owner.addRequiredSubtask({
    owner_task_id: task.task_id,
    subtask: { task_id: 'dependent', task_type: 'default', goal: 'consume input', expected_output: 'output', acceptance_conditions: {} },
  }, { operationId: 'dependent' }).subtask;
  const afterMembers = service.getTask(task.task_id);
  const dependentOwner = owner.withContext({ stateVersion: afterMembers.state_version });
  dependentOwner.proposeStructureChange({
    task_id: task.task_id,
    change: { kind: 'add_dependency', dependency_kind: 'TASK', task_id: dependent.task_id, prerequisite_task_id: prerequisite.task_id },
  }, { operationId: 'dependency' });
  // A dependency targets the dependent Task, so inspect its structure even
  // though the owner Task remains the bound mutation authority.
  const dependency = service.db.prepare('SELECT * FROM task_structure_dependencies WHERE task_id = ?').get(dependent.task_id);
  assert.ok(dependency);
  assert.equal(service.explainTaskReadiness(dependent.task_id).status, 'BLOCKED');

  const rework = owner.createReworkTask({ prior_task_id: task.task_id, instruction: 'include the missing evidence', input_material_refs: ['material:prior'] }, { operationId: 'rework' });
  assert.equal(rework.rework_task.task_id !== task.task_id, true);
  const reworkLink = service.db.prepare('SELECT * FROM task_rework_links WHERE rework_task_id = ?').get(rework.rework_task.task_id);
  assert.equal(reworkLink.prior_task_id, task.task_id);
  assert.deepEqual(JSON.parse(reworkLink.source_material_refs_json), ['material:prior']);
  assert.equal(service.getTaskStructure(rework.rework_task.task_id).provenance.creation_kind, 'REWORK');
  void sdk;
  service.close();
});

test('structure and readiness reads do not backfill durable structure rows', () => {
  const { service, task } = fixture();
  service.db.prepare('DELETE FROM task_creation_provenance WHERE task_id = ?').run(task.task_id);
  service.db.prepare('DELETE FROM task_structure_versions WHERE task_id = ?').run(task.task_id);

  const readiness = service.explainTaskReadiness(task.task_id);
  const structure = service.getTaskStructure(task.task_id);

  assert.equal(readiness.ready, true);
  assert.equal(structure.structural_version, 1);
  assert.equal(service.db.prepare('SELECT COUNT(*) AS count FROM task_creation_provenance WHERE task_id = ?').get(task.task_id).count, 0);
  assert.equal(service.db.prepare('SELECT COUNT(*) AS count FROM task_structure_versions WHERE task_id = ?').get(task.task_id).count, 0);
  service.close();
});

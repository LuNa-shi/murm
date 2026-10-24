import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ERROR_CODES, ServicesSDK, SwarmEnvError, TaskService } from '../src/index.js';

function environment() {
  const service = new TaskService(new DatabaseSync(':memory:'));
  const sdk = new ServicesSDK(service, { actorRef: 'owner:root' });
  return { service, sdk };
}

function propose(sdk, operationId, overrides = {}) {
  return sdk.proposeTask({
    task_type: 'default', goal: 'coordinate work', expected_output: 'a completed responsibility', acceptance_conditions: {}, owner_ref: 'owner:root',
    ...overrides,
  }, { operationId }).task;
}

function claim(sdk, task, actorRef, operationId) {
  return sdk.withContext({ actorRef, taskId: task.task_id, specVersion: task.spec_version, stateVersion: task.state_version }).claim({
    claim_key: operationId, owner_ref: actorRef, workspace_mode: 'clean',
  }, { operationId });
}

function bound(sdk, task, result, actorRef = 'owner:root') {
  return sdk.withContext({
    actorRef, taskId: task.task_id, executionId: result.execution.execution_id,
    specVersion: result.execution.spec_version, stateVersion: result.execution.state_version,
    fencingVersion: result.execution.fencing_version, taskStateVersion: result.task?.state_version ?? task.state_version,
  });
}

test('a root exposes alternative ordinary Tasks that are independently claimable', () => {
  const { service, sdk } = environment();
  const root = propose(sdk, 'root-branches');
  const rootRun = claim(sdk, root, 'owner:root', 'root-branches-claim');
  const rootSdk = bound(sdk, root, rootRun);
  const created = rootSdk.createBranchGroup({
    branch_tasks: [
      { task_type: 'default', goal: 'try route A', expected_output: 'route A result', acceptance_conditions: {}, completion_contract: {} },
      { task_type: 'default', goal: 'try route B', expected_output: 'route B result', acceptance_conditions: {}, completion_contract: {} },
    ],
  }, { operationId: 'root-branches-create' });
  const listed = sdk.withContext({ actorRef: 'worker:one' }).listTasks({ root_id: root.root_id, limit: 10 });
  assert.deepEqual(new Set(listed.map((task) => task.task_id)), new Set(created.tasks.map((task) => task.task_id)));
  assert.equal(rootRun.execution.state, 'CREATED');
  assert.equal(service.getExecution(rootRun.execution.execution_id).state, 'CREATED');
  const first = claim(sdk, created.tasks[0], 'worker:one', 'branch-a-claim');
  const second = claim(sdk, created.tasks[1], 'worker:two', 'branch-b-claim');
  assert.notEqual(first.execution.execution_id, second.execution.execution_id);
  service.close();
});

test('a Branch Task cannot create another Branch group but can add required subtasks', () => {
  const { service, sdk } = environment();
  const root = propose(sdk, 'nested-branch-root');
  const rootRun = claim(sdk, root, 'owner:root', 'nested-branch-root-claim');
  const branch = bound(sdk, root, rootRun).createBranchGroup({
    branch_tasks: [{ task_type: 'default', goal: 'alternative', expected_output: 'result', acceptance_conditions: {}, completion_contract: {} }],
  }, { operationId: 'nested-branch-create' }).tasks[0];
  const branchRun = claim(sdk, branch, 'worker:branch', 'nested-branch-claim');
  const branchSdk = bound(sdk, branch, branchRun, 'worker:branch');
  assert.throws(() => branchSdk.createBranchGroup({
    branch_tasks: [{ task_type: 'default', goal: 'nested', expected_output: 'result', acceptance_conditions: {}, completion_contract: {} }],
  }, { operationId: 'nested-branch-rejected' }), (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.BRANCH_TASK_CANNOT_CREATE_BRANCH);
  const first = branchSdk.addRequiredSubtask({
    subtask: { task_type: 'default', goal: 'required one', expected_output: 'one', acceptance_conditions: {}, completion_contract: {} },
  }, { operationId: 'required-one' });
  const second = branchSdk.addRequiredSubtask({
    group_id: first.group.group_id, expected_structural_version: 2,
    subtask: { task_type: 'default', goal: 'required two', expected_output: 'two', acceptance_conditions: {}, completion_contract: {} },
  }, { operationId: 'required-two' });
  assert.equal(second.group.members.length, 2);
  assert.deepEqual(second.group.members.map((member) => member.satisfied), [false, false]);
  assert.deepEqual(new Set(sdk.withContext({ actorRef: 'worker:other' }).listTasks({ root_id: root.root_id, limit: 10 }).map((task) => task.goal)), new Set(['required one', 'required two']));
  service.close();
});

test('structure readiness distinguishes explicit dependencies from branch/subtask membership', () => {
  const { service, sdk } = environment();
  const root = propose(sdk, 'readiness-root');
  const rootRun = claim(sdk, root, 'owner:root', 'readiness-root-claim');
  const rootSdk = bound(sdk, root, rootRun);
  const group = rootSdk.createBranchGroup({ branch_tasks: [
    { task_type: 'default', goal: 'prerequisite', expected_output: 'evidence', acceptance_conditions: {}, completion_contract: {} },
    { task_type: 'default', goal: 'dependent', expected_output: 'result', acceptance_conditions: {}, completion_contract: {} },
  ] }, { operationId: 'readiness-group' });
  const dependentTask = group.tasks.find((task) => task.goal === 'dependent');
  const prerequisiteTask = group.tasks.find((task) => task.goal === 'prerequisite');
  const dependentRun = claim(sdk, dependentTask, 'worker:dependent', 'readiness-dependent-claim');
  const structure = bound(sdk, dependentTask, dependentRun, 'worker:dependent').proposeStructureChange({
    task_id: dependentTask.task_id, expected_structural_version: 1,
    change: { kind: 'add_dependency', dependency: { dependency_kind: 'TASK', prerequisite_task_id: prerequisiteTask.task_id } },
  }, { operationId: 'readiness-dependency' });
  assert.equal(structure.structure.dependencies.length, 1);
  assert.equal(sdk.explainTaskReadiness(dependentTask.task_id).readiness, 'BLOCKED');
  assert.equal(sdk.withContext({ actorRef: 'worker:ready' }).listTasks({ root_id: root.root_id, limit: 10 }).some((task) => task.task_id === dependentTask.task_id), false);
  assert.equal(sdk.explainTaskReadiness(prerequisiteTask.task_id).readiness, 'READY');
  service.close();
});

test('branch satisfaction and required-subtask satisfaction remain separate, and root completion remains explicit', () => {
  const { service, sdk } = environment();
  const root = propose(sdk, 'satisfaction-root');
  const rootRun = claim(sdk, root, 'owner:root', 'satisfaction-root-claim');
  const rootSdk = bound(sdk, root, rootRun);
  const created = rootSdk.createBranchGroup({ branch_tasks: [
    { task_type: 'default', goal: 'branch one', expected_output: 'one', acceptance_conditions: {}, completion_contract: {} },
    { task_type: 'default', goal: 'branch two', expected_output: 'two', acceptance_conditions: {}, completion_contract: {} },
  ] }, { operationId: 'satisfaction-branches' });
  const branchRun = claim(sdk, created.tasks[0], 'worker:branch', 'satisfaction-branch-claim');
  const branchSdk = bound(sdk, created.tasks[0], branchRun, 'worker:branch');
  const required = branchSdk.addRequiredSubtask({ subtask: { task_type: 'default', goal: 'must also finish', expected_output: 'required', acceptance_conditions: {}, completion_contract: {} } }, { operationId: 'satisfaction-required' });
  const accepted = branchSdk.acceptTask({ target_task_id: created.tasks[0].task_id }, { operationId: 'satisfaction-branch-accept' });
  assert.equal(accepted.task.state, 'SATISFIED');
  const structure = service.getTaskStructure(root.task_id);
  assert.equal(structure.branch_groups[0].satisfied, true);
  assert.equal(structure.required_subtask_groups.length, 0);
  const branchStructure = service.getTaskStructure(created.tasks[0].task_id);
  assert.equal(branchStructure.required_subtask_groups[0].satisfied, false);
  assert.equal(service.getTask(root.task_id).state, 'RUNNING');
  assert.equal(required.task.state, 'OPEN');
  service.close();
});

test('report rework creates a new evidence-linked Task instead of reopening the prior Execution', () => {
  const { service, sdk } = environment();
  const root = propose(sdk, 'rework-root');
  const rootRun = claim(sdk, root, 'owner:root', 'rework-root-claim');
  const child = bound(sdk, root, rootRun).createChildTask({
    child_creation_key: 'report-child', task_type: 'default', goal: 'publish report', expected_output: 'report', acceptance_conditions: {}, owner_ref: 'owner:root', completion_contract: {},
  }, { operationId: 'report-child-create' }).task;
  const childRun = claim(sdk, child, 'owner:root', 'report-child-claim');
  const result = bound(sdk, child, childRun).createReworkTask({ prior_task_id: child.task_id, instruction: 'add the missing comparison', input_material_refs: ['material:prior'] }, { operationId: 'report-rework' });
  assert.notEqual(result.task.task_id, child.task_id);
  assert.equal(result.provenance.creation_kind, 'REWORK');
  assert.equal(result.provenance.prior_task_id, child.task_id);
  assert.equal(result.rework_link.feedback, 'add the missing comparison');
  assert.equal(service.getTask(child.task_id).state, 'RUNNING');
  assert.equal(service.listExecutions(child.task_id, { includeTerminal: false }).length, 1);
  const structure = service.getTaskStructure(result.task.task_id);
  assert.equal(structure.provenance.source_material_refs[0], 'material:prior');
  service.close();
});

test('a child without a parent_review contract can complete from its own execution contract', () => {
  const { service, sdk } = environment();
  const root = propose(sdk, 'owner-completion-root');
  const rootRun = claim(sdk, root, 'owner:root', 'owner-completion-root-claim');
  const child = bound(sdk, root, rootRun).createChildTask({
    child_creation_key: 'owner-complete-child', task_type: 'default', goal: 'self complete', expected_output: 'done', acceptance_conditions: {}, owner_ref: 'worker:self', completion_contract: {},
  }, { operationId: 'owner-complete-child-create' }).task;
  const childRun = claim(sdk, child, 'worker:self', 'owner-complete-child-claim');
  const accepted = bound(sdk, child, childRun, 'worker:self').acceptTask({ target_task_id: child.task_id }, { operationId: 'owner-complete-child-accept' });
  assert.equal(accepted.task.state, 'SATISFIED');
  assert.throws(() => bound(sdk, root, rootRun).acceptTask({ target_task_id: child.task_id }, { operationId: 'owner-cannot-reapprove' }), (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.NOT_ALLOWED);
  service.close();
});

test('explicit branch and required-subtask groups drive completion independently', () => {
  const { service, sdk } = environment();
  const root = propose(sdk, 'contracted-structure-root', {
    completion_contract: {
      required_branch_groups: ['alternatives-1'],
      required_subtask_groups: ['required-1'],
    },
  });
  const rootRun = claim(sdk, root, 'owner:root', 'contracted-structure-root-claim');
  const rootSdk = bound(sdk, root, rootRun);
  const alternatives = rootSdk.createBranchGroup({
    group_id: 'alternatives-1',
    branch_tasks: [
      { task_type: 'default', goal: 'alternative A', expected_output: 'A', acceptance_conditions: {}, completion_contract: {} },
      { task_type: 'default', goal: 'alternative B', expected_output: 'B', acceptance_conditions: {}, completion_contract: {} },
    ],
  }, { operationId: 'contracted-alternatives' });
  const requiredOne = rootSdk.addRequiredSubtask({
    group_id: 'required-1',
    subtask: { task_type: 'default', goal: 'required A', expected_output: 'A', acceptance_conditions: {}, completion_contract: {} },
  }, { operationId: 'contracted-required-a' });
  const requiredTwo = rootSdk.addRequiredSubtask({
    group_id: 'required-1',
    expected_structural_version: 3,
    subtask: { task_type: 'default', goal: 'required B', expected_output: 'B', acceptance_conditions: {}, completion_contract: {} },
  }, { operationId: 'contracted-required-b' });
  const alternativeRun = claim(sdk, alternatives.tasks[0], 'worker:alternative', 'contracted-alternative-claim');
  const requiredOneRun = claim(sdk, requiredOne.task, 'worker:required-a', 'contracted-required-a-claim');
  const requiredTwoRun = claim(sdk, requiredTwo.task, 'worker:required-b', 'contracted-required-b-claim');
  bound(sdk, alternatives.tasks[0], alternativeRun, 'worker:alternative').acceptTask({ target_task_id: alternatives.tasks[0].task_id }, { operationId: 'contracted-alternative-accept' });
  bound(sdk, requiredOne.task, requiredOneRun, 'worker:required-a').acceptTask({ target_task_id: requiredOne.task.task_id }, { operationId: 'contracted-required-a-accept' });
  assert.equal(service.getTask(root.task_id).state, 'RUNNING');
  const beforeLast = service.explainTaskReadiness(root.task_id);
  assert.equal(beforeLast.readiness, 'BLOCKED');
  assert.equal(beforeLast.structure.satisfaction.required_subtask_groups[0].satisfied, false);
  bound(sdk, requiredTwo.task, requiredTwoRun, 'worker:required-b').acceptTask({ target_task_id: requiredTwo.task.task_id }, { operationId: 'contracted-required-b-accept' });
  const completed = rootSdk.acceptTask({ target_task_id: root.task_id }, { operationId: 'contracted-root-accept' });
  assert.equal(completed.task.state, 'SATISFIED');
  assert.equal(service.getTask(root.task_id).state, 'SATISFIED');
  assert.equal(service.getTaskStructure(root.task_id).satisfaction.satisfied, true);
  service.close();
});

test('structure versions reject stale writes and dependency cycles with stable conflicts', () => {
  const { service, sdk } = environment();
  const root = propose(sdk, 'versioned-structure-root');
  const rootRun = claim(sdk, root, 'owner:root', 'versioned-structure-root-claim');
  const rootSdk = bound(sdk, root, rootRun);
  const first = rootSdk.addRequiredSubtask({
    group_id: 'versioned-required',
    subtask: { task_type: 'default', goal: 'first', expected_output: 'first', acceptance_conditions: {}, completion_contract: {} },
  }, { operationId: 'versioned-first' });
  assert.throws(() => rootSdk.addRequiredSubtask({
    group_id: 'versioned-required', expected_structural_version: 1,
    subtask: { task_type: 'default', goal: 'stale', expected_output: 'stale', acceptance_conditions: {}, completion_contract: {} },
  }, { operationId: 'versioned-stale' }), (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.STALE_VERSION);
  const second = rootSdk.addRequiredSubtask({
    group_id: 'versioned-required', expected_structural_version: 2,
    subtask: { task_type: 'default', goal: 'second', expected_output: 'second', acceptance_conditions: {}, completion_contract: {} },
  }, { operationId: 'versioned-second' });
  const firstRun = claim(sdk, first.task, 'worker:first', 'cycle-first-claim');
  const firstSdk = bound(sdk, first.task, firstRun, 'worker:first');
  firstSdk.proposeStructureChange({
    task_id: first.task.task_id, expected_structural_version: 1,
    change: { kind: 'add_dependency', dependency: { dependency_kind: 'TASK', prerequisite_task_id: second.task.task_id } },
  }, { operationId: 'cycle-first-edge' });
  const secondRun = claim(sdk, second.task, 'worker:second', 'cycle-second-claim');
  const secondSdk = bound(sdk, second.task, secondRun, 'worker:second');
  assert.throws(() => secondSdk.proposeStructureChange({
    task_id: second.task.task_id, expected_structural_version: 1,
    change: { kind: 'add_dependency', dependency: { dependency_kind: 'TASK', prerequisite_task_id: first.task.task_id } },
  }, { operationId: 'cycle-second-edge' }), (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.INVALID_CONTRACT);
  service.close();
});

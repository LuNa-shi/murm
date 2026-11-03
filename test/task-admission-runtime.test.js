import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ContextService, ERROR_CODES, makeEnvelope, ServicesSDK, SwarmEnvError, TaskController, TaskService } from '../src/index.js';
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

test('normal-flow blocking requires a typed dependency', () => {
  const { taskService, sdk } = service();
  const task = sdk.proposeTask(rootInput({ normal_flow: true }), { operationId: 'normal-block-root' }).task;
  const claim = taskService.claimTask(task.task_id, {
    claim_key: 'normal-block-claim', owner_ref: 'daemon:one', core_id: 'core-normal-block',
  });
  assert.throws(() => taskService.blockTask({ block_reason: 'external dependency' }, makeEnvelope({
    operationId: 'normal-block-op', actorRef: 'daemon:one', taskId: task.task_id, executionId: claim.execution.execution_id,
    specVersion: task.spec_version, stateVersion: claim.execution.state_version, fencingVersion: claim.execution.fencing_version,
  })), (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.NOT_ALLOWED && /typed dependency/.test(error.message));
  taskService.close();
});

test('semantic blocking records an external capability and removes the Task from claims', () => {
  const database = new DatabaseSync(':memory:');
  const contextService = new ContextService(database);
  const taskService = new TaskService(database, { contextService });
  contextService.taskService = taskService;
  const owner = new ServicesSDK(taskService, { actorRef: 'owner:root' });
  const mission = owner.createMission({
    mission_id: 'mission:capability-block',
    goal: 'record a missing research capability',
    acceptance_conditions: { blocker: true },
  }, { operationId: 'capability-block:mission' }).mission;
  const task = owner.createTask({
    mission_id: mission.mission_id,
    summary: 'Record a typed external capability blocker for the research route.',
    task_type: 'research',
    expected_output: 'a durable capability handoff',
    acceptance_conditions: { blocker: true },
    completion_contract: { normal_flow: true },
  }, { operationId: 'capability-block:task' }).task;
  const claim = taskService.claimTask(task.task_id, { claim_key: 'capability-block:claim', owner_ref: 'agent:research', core_id: 'core-capability' });
  const handoff = new ServicesSDK(contextService, {
    actorRef: 'agent:research', taskId: task.task_id, executionId: claim.execution.execution_id,
    specVersion: task.spec_version, stateVersion: claim.execution.state_version,
    fencingVersion: claim.execution.fencing_version,
  }).publishMaterial({ kind: 'failure', role: 'handoff', scope: 'proof_relevant', content: { blocker: 'mathlib_search' } }, { operationId: 'capability-block:handoff' }).material;
  const blocked = taskService.blockTaskSemantic({
    blocker: { kind: 'capability', capability_id: 'mathlib_search', reason: 'no registered locked-project search service' },
    dependency: { dependency_kind: 'CAPABILITY', capability_id: 'mathlib_search', scope: 'locked-project', retryable: false },
    handoff_material_id: handoff.material_id,
  }, makeEnvelope({
    operationId: 'capability-block:block', actorRef: 'agent:research', taskId: task.task_id,
    executionId: claim.execution.execution_id, specVersion: task.spec_version,
    stateVersion: claim.execution.state_version, fencingVersion: claim.execution.fencing_version,
  }));
  assert.equal(blocked.task.state, 'BLOCKED');
  assert.equal(blocked.execution.state, 'HANDED_OFF');
  assert.deepEqual(blocked.dependency, {
    dependency_kind: 'CAPABILITY', capability_id: 'mathlib_search', scope: 'locked-project', retryable: false, resolution: 'explicit_reopen',
  });
  assert.equal(taskService.listClaimableTasks({ missionId: mission.mission_id }).length, 0);
  assert.throws(
    () => taskService.claimTask(task.task_id, { claim_key: 'capability-block:retry', owner_ref: 'agent:other' }),
    (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.NOT_ALLOWED,
  );
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

test('normal-flow Tasks reject legacy Execution WAITING', () => {
  const { taskService, sdk } = service();
  const task = sdk.proposeTask(rootInput({ normal_flow: true }), { operationId: 'normal-wait-reject-task' }).task;
  const claim = taskService.claimTask(task.task_id, { claim_key: 'normal-wait-reject-claim', owner_ref: 'daemon:one' });
  assert.throws(
    () => taskService.validateWaitCondition(claim.execution.execution_id, {
      waitCondition: { type: 'timer', deadline: new Date(Date.now() + 60_000).toISOString() },
    }),
    (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.NOT_ALLOWED && /execution_block/.test(error.message),
  );
  taskService.close();
});

test('a future Material dependency remains blocked until a qualifying Material is published', () => {
  const database = new DatabaseSync(':memory:');
  const contextService = new ContextService(database);
  const taskService = new TaskService(database, { contextService });
  contextService.taskService = taskService;
  const sdk = new ServicesSDK(taskService, { actorRef: 'owner:root' });
  const task = sdk.proposeTask(rootInput({ normal_flow: true }), { operationId: 'material-block-task' }).task;
  const claim = taskService.claimTask(task.task_id, { claim_key: 'material-block-claim', owner_ref: 'daemon:one' });
  const blocked = taskService.blockTask({
    block_reason: 'awaiting research material',
    dependency: { dependency_kind: 'MATERIAL', material_id: 'future-material', requirement: { kind: 'fact', scope: 'proof_relevant' } },
  }, makeEnvelope({
    operationId: 'material-block-op', actorRef: 'daemon:one', taskId: task.task_id, executionId: claim.execution.execution_id,
    specVersion: task.spec_version, stateVersion: claim.execution.state_version, fencingVersion: claim.execution.fencing_version,
  }));
  assert.equal(blocked.task.state, 'BLOCKED');
  assert.equal(taskService.reconcileTask(task.task_id).changed, false);
  new ServicesSDK(contextService, { actorRef: 'system:material' }).publishMaterial({
    material_id: 'future-material', kind: 'fact', scope: 'proof_relevant', content: { result: 'ready' },
  }, { operationId: 'material-block-publish' });
  const reopened = taskService.reconcileTask(task.task_id);
  assert.equal(reopened.changed, true);
  assert.equal(reopened.task.state, 'OPEN');
  taskService.close();
});

test('normal-flow root consumes two child results across Cores and Controller reopens a typed block', async () => {
  const database = new DatabaseSync(':memory:');
  const contextService = new ContextService(database);
  const taskService = new TaskService(database, { contextService });
  contextService.taskService = taskService;
  const owner = new ServicesSDK(taskService, { actorRef: 'owner:root' });
  const root = owner.proposeTask(rootInput({ normal_flow: true }), { operationId: 'integrated-root-propose' }).task;
  const rootClaim = taskService.claimTask(root.task_id, { claim_key: 'integrated-root-claim', owner_ref: 'daemon:root', core_id: 'core-root' });

  const taskSdk = (task, execution, actorRef) => new ServicesSDK(taskService, {
    actorRef,
    taskId: task.task_id,
    executionId: execution.execution_id,
    specVersion: task.spec_version,
    stateVersion: execution.state_version,
    fencingVersion: execution.fencing_version,
  });
  const childProposal = (key, goal) => ({
    child_task_id: key,
    child_creation_key: key,
    task_type: 'default',
    goal,
    expected_output: 'a child result Material',
    acceptance_conditions: { route: key },
    completion_contract: {},
  });
  let currentRoot = taskService.getTask(root.task_id);
  let currentRootExecution = taskService.getExecution(rootClaim.execution.execution_id);
  const rootAgent = () => taskSdk(currentRoot = taskService.getTask(root.task_id), currentRootExecution = taskService.getExecution(rootClaim.execution.execution_id), 'daemon:root');
  const childOne = rootAgent().createChildTask(childProposal('integrated-child-one', 'produce first result'), { operationId: 'integrated-child-one-create' }).task;
  const childTwo = rootAgent().createChildTask(childProposal('integrated-child-two', 'produce second result'), { operationId: 'integrated-child-two-create' }).task;
  assert.equal(childOne.completion_contract.normal_flow, true);
  assert.equal(childTwo.completion_contract.normal_flow, true);

  const childOneClaim = taskService.claimTask(childOne.task_id, { claim_key: 'integrated-child-one-claim', owner_ref: 'daemon:one', core_id: 'core-one' });
  const childTwoClaim = taskService.claimTask(childTwo.task_id, { claim_key: 'integrated-child-two-claim', owner_ref: 'daemon:two', core_id: 'core-two' });
  const childOneAgent = taskSdk(childOne, childOneClaim.execution, 'daemon:one');
  const childTwoAgent = taskSdk(childTwo, childTwoClaim.execution, 'daemon:two');
  const childOneMaterial = new ServicesSDK(contextService, {
    actorRef: 'daemon:one', taskId: childOne.task_id, executionId: childOneClaim.execution.execution_id,
    specVersion: childOne.spec_version, stateVersion: childOneClaim.execution.state_version,
    fencingVersion: childOneClaim.execution.fencing_version,
  }).publishMaterial({ kind: 'fact', scope: 'proof_relevant', content: { route: 'one' } }, { operationId: 'integrated-child-one-material' }).material;

  const blocked = taskService.blockTask({
    block_reason: 'awaiting second child result',
    dependency: { dependency_kind: 'MATERIAL', material_id: 'integrated-child-two-material', requirement: { kind: 'fact', scope: 'proof_relevant' } },
  }, makeEnvelope({
    operationId: 'integrated-child-two-block', actorRef: 'daemon:two', taskId: childTwo.task_id,
    executionId: childTwoClaim.execution.execution_id, specVersion: childTwo.spec_version,
    stateVersion: childTwoClaim.execution.state_version, fencingVersion: childTwoClaim.execution.fencing_version,
  }));
  assert.equal(blocked.task.state, 'BLOCKED');
  assert.equal(blocked.execution.state, 'FENCED');
  assert.equal(taskService.getActiveExecutionForCore('core-two'), null);
  new ServicesSDK(contextService, {
    actorRef: 'daemon:one', taskId: childOne.task_id, executionId: childOneClaim.execution.execution_id,
    specVersion: childOne.spec_version, stateVersion: childOneClaim.execution.state_version,
    fencingVersion: childOneClaim.execution.fencing_version,
  }).publishMaterial({
    material_id: 'integrated-child-two-material', kind: 'fact', scope: 'proof_relevant', content: { route: 'handoff' },
  }, { operationId: 'integrated-child-two-material' });
  const childOneTask = taskService.getTask(childOne.task_id);
  const childOneFinished = childOneAgent.withContext({ stateVersion: taskService.getExecution(childOneClaim.execution.execution_id).state_version }).acceptTask({
    target_task_id: childOne.task_id,
    target_state_version: childOneTask.state_version,
  }, { operationId: 'integrated-child-one-done' });
  assert.equal(childOneFinished.task.state, 'DONE');
  assert.equal(taskService.getActiveExecutionForCore('core-one'), null);
  const controller = new TaskController({ taskService, listDaemons: () => [] });
  const reconciliation = await controller.reconcile({ reason: 'material-published' });
  assert.equal(reconciliation.repaired_task_count, 1);
  assert.equal(taskService.getTask(childTwo.task_id).state, 'OPEN');
  const childTwoRetry = taskService.claimTask(childTwo.task_id, { claim_key: 'integrated-child-two-retry', owner_ref: 'daemon:two', core_id: 'core-two' });
  const childTwoRetryTask = taskService.getTask(childTwo.task_id);
  const childTwoRetryAgent = taskSdk(childTwoRetryTask, childTwoRetry.execution, 'daemon:two');
  new ServicesSDK(contextService, {
    actorRef: 'daemon:two', taskId: childTwoRetryTask.task_id, executionId: childTwoRetry.execution.execution_id,
    specVersion: childTwoRetryTask.spec_version, stateVersion: childTwoRetry.execution.state_version,
    fencingVersion: childTwoRetry.execution.fencing_version,
  }).publishMaterial({ kind: 'fact', scope: 'proof_relevant', content: { route: 'two' } }, { operationId: 'integrated-child-two-output' });
  const childTwoDone = childTwoRetryAgent.acceptTask({ target_task_id: childTwo.task_id, target_state_version: childTwoRetryTask.state_version }, { operationId: 'integrated-child-two-done' });
  assert.equal(childTwoDone.task.state, 'DONE');
  const childOneMaterials = new ServicesSDK(contextService, { actorRef: 'owner:root' }).readMaterials({ source_task: childOne.task_id });
  const childTwoMaterials = new ServicesSDK(contextService, { actorRef: 'owner:root' }).readMaterials({ source_task: childTwo.task_id });
  assert.equal(childOneMaterials.some((material) => material.material_id === childOneMaterial.material_id), true);
  assert.equal(childTwoMaterials.some((material) => material.kind === 'fact' && material.scope === 'proof_relevant'), true);

  currentRoot = taskService.getTask(root.task_id);
  currentRootExecution = taskService.getExecution(rootClaim.execution.execution_id);
  const rootDone = taskSdk(currentRoot, currentRootExecution, 'daemon:root').acceptTask({
    target_task_id: root.task_id,
    target_state_version: currentRoot.state_version,
  }, { operationId: 'integrated-root-done' });
  assert.equal(rootDone.task.state, 'DONE');
  assert.deepEqual(new Set([childOneClaim.execution.core_id, childTwoClaim.execution.core_id]), new Set(['core-one', 'core-two']));
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

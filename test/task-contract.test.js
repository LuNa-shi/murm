import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { makeEnvelope, SwarmEnvError, TaskService, ERROR_CODES, ServicesSDK } from '../src/index.js';

function env() {
  const service = new TaskService(new DatabaseSync(':memory:'));
  return { service, actor: 'agent:test' };
}

function op(operationId, actorRef, extra = {}) {
  return makeEnvelope({ operationId, actorRef, ...extra });
}

function createMission(service, missionId = 'mission:test') {
  return service.dispatch('mission_create', {
    mission_id: missionId,
    goal: 'Solve one shared problem',
    acceptance_conditions: ['a durable result exists'],
  }, op(`mission:${missionId}`, 'operator:test')).mission;
}

function createTask(service, missionId, taskId, extra = {}, envelope = null) {
  return service.dispatch('task_create', {
    mission_id: missionId,
    task_id: taskId,
    summary: `Investigate ${taskId} without duplicating other work.`,
    goal: `Answer ${taskId}`,
    expected_output: 'A useful written result',
    acceptance_conditions: ['result is documented'],
    ...extra,
  }, envelope ?? op(`task:${taskId}`, 'agent:test')).task;
}

test('Mission creates a Task pool with explicit proposal and dependency relations', () => {
  const { service } = env();
  const mission = createMission(service);
  const first = createTask(service, mission.mission_id, 'task:first');
  const second = createTask(service, mission.mission_id, 'task:second', {
    depends_on: [first.task_id],
  });

  assert.equal(first.mission_id, mission.mission_id);
  assert.equal(first.summary.includes('task:first'), true);
  assert.deepEqual(second.relations.depends_on.map((row) => row.related_task_id), [first.task_id]);
  assert.deepEqual(service.dispatch('task_list', { mission_id: mission.mission_id, available_only: false }, op('task:list', 'agent:test')).tasks.map((task) => task.task_id), [first.task_id, second.task_id]);
  assert.equal(service.dispatch('task_view', { task_id: second.task_id }, op('task:view', 'agent:test')).task.relations.depends_on[0].related_task_id, first.task_id);
  service.close();
});

test('ServicesSDK exposes the Mission-scoped Task seam without parent-specific methods', () => {
  const { service } = env();
  const sdk = new ServicesSDK(service, { actorRef: 'agent:sdk' });
  const mission = sdk.createMission({ mission_id: 'mission:sdk', goal: 'SDK mission' }, { operationId: 'sdk:mission' }).mission;
  const task = sdk.createTask({
    mission_id: mission.mission_id,
    summary: 'Find one independent route',
    expected_output: 'A route note',
    acceptance_conditions: ['note exists'],
  }, { operationId: 'sdk:task' }).task;
  assert.equal(sdk.listMissionTasks({ mission_id: mission.mission_id }).tasks.length, 1);
  assert.equal(sdk.viewTask(task.task_id).task.summary, 'Find one independent route');
  for (const method of ['proposeTask', 'createChildTask', 'createBranchGroup', 'addRequiredSubtask', 'getTaskStructure', 'createReworkTask']) {
    assert.equal(typeof sdk[method], 'undefined', `retired SDK method ${method} must not be reachable`);
  }
  assert.throws(() => service.dispatch('propose_task', {}, op('sdk:legacy', 'agent:sdk')), /unsupported Task Service operation/);
  service.close();
});

test('canonical task supply seam proposes work and takes it', () => {
  const { service } = env();
  const sdk = new ServicesSDK(service, { actorRef: 'agent:canonical', coreId: 'core:canonical' });
  const mission = sdk.createMission({ mission_id: 'mission:canonical', goal: 'canonical task supply' }, { operationId: 'canonical:mission' }).mission;

  const initial = sdk.taskStatus({ mission_id: mission.mission_id });
  assert.equal(initial.mission.mission_id, mission.mission_id);
  assert.equal(initial.counts.total, 0);
  assert.deepEqual(initial.tasks, []);

  const registered = sdk.createTask({
    mission_id: mission.mission_id,
    task_id: 'task:canonical',
    summary: 'Find one independent route',
    goal: 'find one independent route',
    expected_output: 'a route note',
    acceptance_conditions: ['note exists'],
    collaboration_reason: 'another identity can verify this route',
  }, { operationId: 'canonical:register' });
  assert.equal(registered.task.task_id, 'task:canonical');

  const status = sdk.taskStatus({ mission_id: mission.mission_id });
  assert.equal(status.counts.total, 1);
  assert.equal(status.counts.eligible, 1);
  assert.equal(status.tasks[0].task_id, 'task:canonical');

  const taken = sdk.taskTake({
    task_id: registered.task.task_id,
    take_key: 'canonical:take',
    core_id: 'core:canonical',
  }, { operationId: 'canonical:take' });
  assert.equal(taken.task.task_id, registered.task.task_id);
  assert.equal(taken.execution.owner_ref, 'agent:canonical');
  assert.equal(taken.execution.core_id, 'core:canonical');
  service.close();
});

test('every Mission Task is exclusive and the Mission has no shared take entry', () => {
  const { service } = env();
  const mission = createMission(service, 'mission:shared-entry');
  const shared = createTask(service, mission.mission_id, 'task:shared-entry');
  const first = service.dispatch('task_take', {
    task_id: shared.task_id, take_key: 'shared:one', owner_ref: 'agent:one', core_id: 'core:one', workspace_mode: 'clean',
  }, op('shared:one', 'agent:one', { taskId: shared.task_id, specVersion: shared.spec_version, stateVersion: shared.state_version })).execution;
  const current = service.getTask(shared.task_id);
  assert.throws(() => service.dispatch('task_take', {
    task_id: shared.task_id, take_key: 'shared:two', owner_ref: 'agent:two', core_id: 'core:two', workspace_mode: 'clean',
  }, op('shared:two', 'agent:two', { taskId: shared.task_id, specVersion: current.spec_version, stateVersion: current.state_version })), /active Execution quota/);

  assert.equal(service.listExecutions(shared.task_id, { includeTerminal: false }).length, 1);
  const status = service.taskStatus({ mission_id: mission.mission_id, limit: 1 });
  assert.equal(status.counts.total, 1);
  assert.equal(status.counts.running, 1);
  assert.equal(status.counts.eligible, 0);
  assert.deepEqual(status.eligible_tasks, []);
  service.close();
});

test('ordinary Mission Tasks stay exclusive while registration has no queue-size cap', () => {
  const { service } = env();
  const mission = createMission(service, 'mission:ordinary-exclusive');
  const first = createTask(service, mission.mission_id, 'task:first-ordinary');
  const second = createTask(service, mission.mission_id, 'task:second-ordinary');
  const taken = service.dispatch('task_take', {
    task_id: second.task_id, take_key: 'ordinary:one', owner_ref: 'agent:one', core_id: 'core:one', workspace_mode: 'clean',
  }, op('ordinary:one', 'agent:one', { taskId: second.task_id, specVersion: second.spec_version, stateVersion: second.state_version }));
  const current = service.getTask(second.task_id);
  assert.throws(() => service.dispatch('task_take', {
    task_id: second.task_id, take_key: 'ordinary:two', owner_ref: 'agent:two', core_id: 'core:two', workspace_mode: 'clean',
  }, op('ordinary:two', 'agent:two', { taskId: second.task_id, specVersion: current.spec_version, stateVersion: current.state_version })), /active Execution quota/);
  for (let index = 0; index < 12; index += 1) {
    const registered = service.createTask({
      mission_id: mission.mission_id,
      task_id: `task:unbounded-${index}`,
      summary: `Register independent responsibility ${index} without a queue quota.`,
      goal: `Explore route ${index}`,
      expected_output: 'a bounded note',
      acceptance_conditions: ['the note is durable'],
    }, op(`create:unbounded:${index}`, 'agent:one'));
    assert.equal(registered.task.owner_ref, 'agent:one');
  }
  assert.equal(service.taskStatus({ mission_id: mission.mission_id }).counts.total, 14);
  service.close();
});

test('Mission Task creation carries a bounded dynamic contract and deduplicates responsibility keys', () => {
  const { service } = env();
  const mission = createMission(service, 'mission:dynamic-contract');
  const first = createTask(service, mission.mission_id, 'task:feedback-route', {
    task_type: 'research',
    task_instructions: 'Read the feedback Material and produce one bounded route result.',
    completion_contract: { required_materials: [{ kinds: ['fact'], scope: 'proof_relevant', min_count: 1 }] },
    input_material_refs: ['material:feedback'],
    priority: 'high',
    responsibility_key: 'flat:proof-feedback:check-1',
    timebox_ms: 30 * 60_000,
  });
  const duplicate = service.dispatch('task_create', {
    mission_id: mission.mission_id,
    task_id: 'task:duplicate-id',
    summary: 'Investigate task:feedback-route without duplicating other work.',
    task_type: 'research',
    task_instructions: 'Read the feedback Material and produce one bounded route result.',
    goal: 'Answer task:feedback-route',
    expected_output: 'A useful written result',
    acceptance_conditions: ['result is documented'],
    completion_contract: { required_materials: [{ kinds: ['fact'], scope: 'proof_relevant', min_count: 1 }] },
    input_material_refs: ['material:feedback'],
    priority: 'high',
    timebox_ms: 30 * 60_000,
    responsibility_key: 'flat:proof-feedback:check-1',
  }, op('task:feedback-route:duplicate', 'agent:test'));

  assert.equal(first.task_type, 'research');
  assert.equal(first.responsibility_key, 'flat:proof-feedback:check-1');
  assert.equal(first.timebox_ms, 30 * 60_000);
  assert.equal(duplicate.task.task_id, first.task_id);
  assert.equal(duplicate.deduplicated, true);
  service.close();
});

test('Task responsibility deduplication requires matching Workspace and Material inputs', t => {
  const { service } = env();
  t.after(() => service.close());
  const mission = createMission(service);
  const proposal = { mission_id: mission.mission_id, summary: 'Investigate a domain boundary with fixed input',
    expected_output: 'Reproducible boundary result', acceptance_conditions: ['Explain the case'],
    base_revision: '0.2', input_material_refs: ['material:a', 'material:b'], responsibility_key: 'fixed-inputs' };
  const submit = (input, key) => service.dispatch('task_create', input, op(key, 'agent:test'));
  const created = submit(proposal, 'original-proposal');
  const { base_revision: revision, ...legacyInput } = proposal;
  const compatible = { ...legacyInput, workspace: { revision }, input_material_refs: ['material:b', 'material:a'] };
  assert.equal(submit(compatible, 'compatible-inputs').task.task_id, created.task.task_id);
  assert.throws(() => submit({ ...proposal, workspace: { revision: '0.3' } }, 'aliases-conflict'), { code: 'INVALID_CONTRACT' });
  assert.throws(() => submit({ ...proposal, base_revision: 'main' }, 'mutable-revision'), { code: 'INVALID_CONTRACT' });
  assert.equal(submit(compatible, 'repeat').deduplicated, true);
  assert.throws(() => submit({ ...proposal, base_revision: '0.3' }, 'different-workspace'), { code: 'CONFLICT' });
  assert.throws(() => submit({ ...proposal, input_material_refs: ['material:c'] }, 'different-material'), { code: 'CONFLICT' });
  assert.equal(submit(proposal, 'original-proposal').task.task_id, created.task.task_id);
});

test('only depends_on gates the flat eligible view and cycles are rejected', () => {
  const { service } = env();
  const mission = createMission(service, 'mission:takeability');
  const prerequisite = createTask(service, mission.mission_id, 'task:prerequisite');
  const dependent = createTask(service, mission.mission_id, 'task:dependent', { depends_on: [prerequisite.task_id] });
  const independent = createTask(service, mission.mission_id, 'task:independent');

  const available = service.dispatch('task_list', { mission_id: mission.mission_id, available_only: true }, op('task:available:one', 'agent:test'));
  assert.deepEqual(available.tasks.map((task) => task.task_id), [prerequisite.task_id, independent.task_id]);
  assert.deepEqual(service.listEligibleTasks({ missionId: mission.mission_id, limit: 10 }).map((task) => task.task_id), [prerequisite.task_id, independent.task_id]);

  assert.throws(() => service.dispatch('task_create', {
    mission_id: mission.mission_id,
    task_id: 'task:cycle',
    summary: 'cycle', goal: 'cycle', expected_output: 'cycle', acceptance_conditions: [],
    depends_on: ['task:cycle'],
  }, op('task:cycle', 'agent:test')), (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.INVALID_CONTRACT);
  service.close();
});

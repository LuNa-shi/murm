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
  return service.dispatch('mission.create', {
    mission_id: missionId,
    goal: 'Solve one shared problem',
    acceptance_conditions: ['a durable result exists'],
  }, op(`mission:${missionId}`, 'operator:test')).mission;
}

function createTask(service, missionId, taskId, extra = {}, envelope = null) {
  return service.dispatch('task.create', {
    mission_id: missionId,
    task_id: taskId,
    summary: `Investigate ${taskId} without duplicating other work.`,
    goal: `Answer ${taskId}`,
    expected_output: 'A useful written result',
    acceptance_conditions: ['result is documented'],
    ...extra,
  }, envelope ?? op(`task:${taskId}`, 'agent:test')).task;
}

test('Mission creates a flat Task pool with explicit proposal and dependency relations', () => {
  const { service } = env();
  const mission = createMission(service);
  const first = createTask(service, mission.mission_id, 'task:first');
  const second = createTask(service, mission.mission_id, 'task:second', {
    spawned_from: first.task_id,
    depends_on: [first.task_id],
  });

  assert.equal(first.mission_id, mission.mission_id);
  assert.equal(first.parent_id, null);
  assert.equal(first.summary.includes('task:first'), true);
  assert.deepEqual(second.relations.spawned_from.map((row) => row.related_task_id), [first.task_id]);
  assert.deepEqual(second.relations.depends_on.map((row) => row.related_task_id), [first.task_id]);
  assert.deepEqual(service.dispatch('task.list', { mission_id: mission.mission_id, available_only: false }, op('task:list', 'agent:test')).map((task) => task.task_id), [first.task_id, second.task_id]);
  assert.equal(service.dispatch('task.view', { task_id: second.task_id }, op('task:view', 'agent:test')).task.relations.depends_on[0].related_task_id, first.task_id);
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
  assert.equal(sdk.listMissionTasks({ mission_id: mission.mission_id }).length, 1);
  assert.equal(sdk.viewTask(task.task_id).task.summary, 'Find one independent route');
  service.close();
});

test('only depends_on gates the flat claimable view and cycles are rejected', () => {
  const { service } = env();
  const mission = createMission(service, 'mission:claimability');
  const prerequisite = createTask(service, mission.mission_id, 'task:prerequisite');
  const dependent = createTask(service, mission.mission_id, 'task:dependent', { depends_on: [prerequisite.task_id] });
  const spawnedOnly = createTask(service, mission.mission_id, 'task:spawned-only', { spawned_from: prerequisite.task_id });

  const available = service.dispatch('task.list', { mission_id: mission.mission_id, available_only: true }, op('task:available:one', 'agent:test'));
  assert.deepEqual(available.map((task) => task.task_id), [prerequisite.task_id, spawnedOnly.task_id]);
  assert.deepEqual(service.listClaimableTasks({ missionId: mission.mission_id, limit: 10 }).map((task) => task.task_id), [prerequisite.task_id, spawnedOnly.task_id]);

  assert.throws(() => service.dispatch('task.create', {
    mission_id: mission.mission_id,
    task_id: 'task:cycle',
    summary: 'cycle', goal: 'cycle', expected_output: 'cycle', acceptance_conditions: [],
    depends_on: ['task:cycle'],
  }, op('task:cycle', 'agent:test')), (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.INVALID_CONTRACT);
  service.close();
});

test('creating a Task from a running Execution leaves the current work running', () => {
  const { service } = env();
  const mission = createMission(service, 'mission:running');
  const current = createTask(service, mission.mission_id, 'task:current');
  const claimed = service.dispatch('claim', { claim_key: 'claim:current', owner_ref: 'agent:test' }, op('claim:current', 'agent:test', {
    taskId: current.task_id,
    specVersion: current.spec_version,
    stateVersion: current.state_version,
  }));
  const created = createTask(service, mission.mission_id, 'task:new', { spawned_from: current.task_id }, op('task:new:bound', 'agent:test', {
    taskId: current.task_id,
    executionId: claimed.execution.execution_id,
    specVersion: claimed.execution.spec_version,
    stateVersion: claimed.execution.state_version,
    fencingVersion: claimed.execution.fencing_version,
  }));

  assert.equal(created.state, 'OPEN');
  assert.equal(service.getTask(current.task_id).state, 'RUNNING');
  assert.equal(service.getExecution(claimed.execution.execution_id).state, 'CREATED');
  assert.equal(service.getTask(current.task_id).state_version, claimed.task.state_version);
  service.close();
});

test('a modern Task with no specialized contract still needs a linked durable result', () => {
  const { service } = env();
  const mission = createMission(service, 'mission:completion');
  const task = createTask(service, mission.mission_id, 'task:completion');
  const claimed = service.dispatch('claim', {
    claim_key: 'claim:completion', owner_ref: 'agent:test',
  }, op('claim:completion', 'agent:test', {
    taskId: task.task_id, specVersion: task.spec_version, stateVersion: task.state_version,
  }));
  assert.throws(() => service.dispatch('task.complete', {}, op('complete:empty', 'agent:test', {
    taskId: task.task_id, executionId: claimed.execution.execution_id,
    specVersion: claimed.execution.spec_version, stateVersion: claimed.execution.state_version,
    fencingVersion: claimed.execution.fencing_version,
  })), (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.INVALID_CONTRACT);
  service.close();
});

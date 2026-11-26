import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { makeEnvelope } from '../src/protocol/envelope.js';
import { MurmError, ERROR_CODES } from '../src/errors.js';
import { TaskService } from '../src/task/task-service.js';

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

test('canonical task supply seam proposes work and takes it', () => {
  const { service } = env();
  const call = (operation, payload, options = {}) => service.dispatch(operation, payload, makeEnvelope({ actorRef: 'agent:canonical', coreId: 'core:canonical', ...options }));
  const mission = call('mission_create', { mission_id: 'mission:canonical', goal: 'canonical task supply' }, { operationId: 'canonical:mission' }).mission;

  const initial = call('task_status', { mission_id: mission.mission_id });
  assert.equal(initial.mission.mission_id, mission.mission_id);
  assert.equal(initial.counts.total, 0);
  assert.deepEqual(initial.tasks, []);

  const registered = call('task_create', {
    mission_id: mission.mission_id,
    task_id: 'task:canonical',
    summary: 'Find one independent route',
    goal: 'find one independent route',
    expected_output: 'a route note',
    acceptance_conditions: ['note exists'],
    collaboration_reason: 'another identity can verify this route',
  }, { operationId: 'canonical:register' });
  assert.equal(registered.task.task_id, 'task:canonical');

  const status = call('task_status', { mission_id: mission.mission_id });
  assert.equal(status.counts.total, 1);
  assert.equal(status.counts.eligible, 1);
  assert.equal(status.tasks[0].task_id, 'task:canonical');

  const taken = call('task_take', {
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
    task_id: shared.task_id, take_key: 'shared:one', owner_ref: 'agent:one', core_id: 'core:one',
  }, op('shared:one', 'agent:one', { taskId: shared.task_id, specVersion: shared.spec_version, stateVersion: shared.state_version })).execution;
  const current = service.getTask(shared.task_id);
  assert.throws(() => service.dispatch('task_take', {
    task_id: shared.task_id, take_key: 'shared:two', owner_ref: 'agent:two', core_id: 'core:two',
  }, op('shared:two', 'agent:two', { taskId: shared.task_id, specVersion: current.spec_version, stateVersion: current.state_version })), /already has an active Execution/);

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
    task_id: second.task_id, take_key: 'ordinary:one', owner_ref: 'agent:one', core_id: 'core:one',
  }, op('ordinary:one', 'agent:one', { taskId: second.task_id, specVersion: second.spec_version, stateVersion: second.state_version }));
  const current = service.getTask(second.task_id);
  assert.throws(() => service.dispatch('task_take', {
    task_id: second.task_id, take_key: 'ordinary:two', owner_ref: 'agent:two', core_id: 'core:two',
  }, op('ordinary:two', 'agent:two', { taskId: second.task_id, specVersion: current.spec_version, stateVersion: current.state_version })), /already has an active Execution/);
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
    task_instructions: 'Read the feedback Material and produce one bounded route result.',
    completion_contract: { required_materials: [{ role: 'experience', min_count: 1 }] },
    input_material_refs: ['material:feedback'],
    priority: 'high',
    responsibility_key: 'taskpool:proof-feedback:check-1',
    timebox_ms: 30 * 60_000,
  });
  const duplicate = service.dispatch('task_create', {
    mission_id: mission.mission_id,
    task_id: 'task:duplicate-id',
    summary: 'Investigate task:feedback-route without duplicating other work.',
    task_instructions: 'Read the feedback Material and produce one bounded route result.',
    goal: 'Answer task:feedback-route',
    expected_output: 'A useful written result',
    acceptance_conditions: ['result is documented'],
    completion_contract: { required_materials: [{ role: 'experience', min_count: 1 }] },
    input_material_refs: ['material:feedback'],
    priority: 'high',
    timebox_ms: 30 * 60_000,
    responsibility_key: 'taskpool:proof-feedback:check-1',
  }, op('task:feedback-route:duplicate', 'agent:test'));

  assert.equal(first.responsibility_key, 'taskpool:proof-feedback:check-1');
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
  }, op('task:cycle', 'agent:test')), (error) => error instanceof MurmError && error.code === ERROR_CODES.INVALID_CONTRACT);
  service.close();
});


test('Task proposals reject removed variants, quotas, retry policies and capability aliases', t => {
  const { service } = env();
  t.after(() => service.close());
  const mission = createMission(service);
  for (const [field, value] of Object.entries({ task_type: 'proof', task_type_version: '2', parallel_quota: 2,
    max_attempts: 2, retry_policy: {}, capability_requirements: [], capabilityRequirements: [] })) {
    assert.throws(() => createTask(service, mission.mission_id, `removed:${field}`, { [field]: value }),
      error => error.code === ERROR_CODES.INVALID_TASK_CONTRACT && error.details.unsupported_fields.includes(field));
  }
  const columns = service.db.prepare('PRAGMA table_info(tasks)').all().map(row => row.name);
  assert.ok(!columns.some(field => /task_type|parallel_quota|max_attempts|retry_policy/.test(field)));
});

test('a Task has one exclusive Execution through preparation, work and cleanup', t => {
  const { service } = env();
  t.after(() => service.close());
  const mission = createMission(service);
  for (const state of ['CREATED', 'RUNNING', 'CLOSING']) {
    const task = createTask(service, mission.mission_id, `exclusive:${state}`);
    const first = service.takeTask(task.task_id, { owner_ref: `agent:first:${state}`, take_key: `first:${state}` }).execution;
    service.db.prepare('UPDATE executions SET state = ? WHERE execution_id = ?').run(state, first.execution_id);
    assert.throws(() => service.takeTask(task.task_id, { owner_ref: 'agent:second', take_key: `second:${state}` }),
      error => error.code === ERROR_CODES.CONFLICT && error.details.condition === 'task_occupied' &&
        error.details.execution_id === first.execution_id && error.details.execution_state === state);
    assert.equal(service.listExecutions(task.task_id).length, 1);
    assert.equal(service.listEligibleTasks({ missionId: mission.mission_id }).some(candidate => candidate.task_id === task.task_id), false);
  }
});

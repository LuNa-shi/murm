import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextService } from '../src/context/context-service.js';
import { TaskService } from '../src/task/task-service.js';
import { makeEnvelope, operationPayload } from '../src/protocol/envelope.js';

function fixture(t, database, taskContract = {}) {
  const service = new TaskService(database);
  t.after(() => service.close());
  const actor = 'agent:finish';
  const mission = service.createMission({ mission_id: 'mission:finish', goal: 'Complete independent local responsibilities' }, makeEnvelope({ actorRef: 'operator:test' })).mission;
  const create = (taskId, extra = {}) => service.createTask({ mission_id: mission.mission_id, task_id: taskId, summary: `Investigate the independent responsibility ${taskId}`, goal: `Resolve ${taskId}`, expected_output: 'A reusable result', acceptance_conditions: ['The result addresses this local question'], ...extra }, makeEnvelope({ actorRef: actor })).task;
  const task = create('task:first', taskContract);
  const execution = service.takeTask(task.task_id, { owner_ref: actor, core_id: 'core-1', take_key: 'first' }).execution;
  const envelope = (operationId) => {
    const current = service.getExecution(execution.execution_id);
    return makeEnvelope({ operationId, actorRef: actor, taskId: task.task_id, executionId: current.execution_id, specVersion: current.spec_version, stateVersion: current.state_version, fencingVersion: current.fencing_version });
  };
  return { service, task, execution, envelope, create };
}

test('accepted finish retains durable Task ownership and rejects new writes until cleanup is confirmed', (t) => {
  const { service, task, execution, envelope } = fixture(t);
  const request = envelope('finish:first');
  const payload = { outcome: 'incomplete', reason: 'Hand over the saved local result' };
  const accepted = service.dispatch('task_finish', payload, request);
  assert.equal(accepted.execution.state, 'CLOSING');
  assert.equal(service.getTask(task.task_id).state, 'RUNNING');
  assert.equal(service.getActiveExecutionForCore('core-1').execution_id, execution.execution_id);
  assert.equal(service.listEligibleTasks().length, 0);
  assert.throws(() => service.takeTask(task.task_id, { owner_ref: 'agent:successor', core_id: 'core-2', take_key: 'second' }), (error) => error.code === 'CONFLICT');
  assert.throws(() => service.dispatch('heartbeat', {}, envelope('after-finish')), (error) => error.code === 'NOT_ALLOWED');
  assert.deepEqual(service.dispatch('task_finish', payload, request), accepted);
});

test('done is accepted durably before the Task becomes done', (t) => {
  const { service, task, execution, envelope } = fixture(t);
  const accepted = service.dispatch('task_finish', { outcome: 'done' }, envelope('finish:done'));
  assert.equal(accepted.execution.state, 'CLOSING');
  assert.equal(service.getTask(task.task_id).state, 'RUNNING');
  assert.equal(service.getExecutionFinish(execution.execution_id).outcome, 'done');
  service.finalizeExecutionFinish(execution.execution_id, { fencingVersion: execution.fencing_version });
  assert.equal(service.getExecution(execution.execution_id).state, 'SUCCEEDED');
  assert.equal(service.getTask(task.task_id).state, 'DONE');
});

test('blocked finish records a public dependency atomically and recomputes it after cleanup', (t) => {
  const { service, task, execution, envelope, create } = fixture(t);
  const prerequisite = create('task:prerequisite');
  service.dispatch('task_finish', { outcome: 'blocked', wait_for: prerequisite.task_id, reason: 'Need the prerequisite result' }, envelope('finish:blocked'));
  assert.equal(service.getExecution(execution.execution_id).state, 'CLOSING');
  assert.deepEqual(service.getTask(task.task_id).relations.depends_on.map((relation) => relation.related_task_id), [prerequisite.task_id]);
  assert.equal(service.getTask(task.task_id).state, 'RUNNING');
  service.finalizeExecutionFinish(execution.execution_id, { fencingVersion: execution.fencing_version });
  assert.equal(service.getTask(task.task_id).state, 'BLOCKED');
  const prerequisiteExecution = service.takeTask(prerequisite.task_id, { owner_ref: 'agent:prerequisite', core_id: 'core-2', take_key: 'prerequisite' }).execution;
  service.dispatch('task_finish', { outcome: 'done' }, makeEnvelope({ actorRef: prerequisiteExecution.owner_ref, taskId: prerequisite.task_id,
    executionId: prerequisiteExecution.execution_id, specVersion: prerequisiteExecution.spec_version,
    stateVersion: prerequisiteExecution.state_version, fencingVersion: prerequisiteExecution.fencing_version }));
  service.finalizeExecutionFinish(prerequisiteExecution.execution_id, { fencingVersion: prerequisiteExecution.fencing_version });
  assert.equal(service.getTask(task.task_id).state, 'OPEN');
  assert.ok(service.listEligibleTasks().some((candidate) => candidate.task_id === task.task_id));
});

test('cancelled finish preserves replacement intent while closing and rejects a replacement cycle', (t) => {
  const { service, task, execution, envelope, create } = fixture(t);
  const replacement = create('task:replacement');
  service.dispatch('task_finish', { outcome: 'cancelled', reason: 'Use the more precise responsibility', replacement_task_id: replacement.task_id }, envelope('finish:cancelled'));
  assert.equal(service.getTask(task.task_id).state, 'RUNNING');
  assert.equal(service.getExecution(execution.execution_id).state, 'CLOSING');
  assert.equal(service.getExecutionFinish(execution.execution_id).replacement_task_id, replacement.task_id);
  const next = service.takeTask(replacement.task_id, { owner_ref: 'agent:replacement', core_id: 'core-2', take_key: 'replacement' }).execution;
  const request = makeEnvelope({ actorRef: next.owner_ref, taskId: replacement.task_id, executionId: next.execution_id,
    specVersion: next.spec_version, stateVersion: next.state_version, fencingVersion: next.fencing_version });
  assert.throws(() => service.dispatch('task_finish', { outcome: 'cancelled', reason: 'Invalid loop', replacement_task_id: task.task_id }, request), (error) => error.code === 'INVALID_CONTRACT');
  assert.equal(service.getExecution(next.execution_id).state, 'CREATED');
  assert.equal(service.getExecutionFinish(next.execution_id), null);
  service.finalizeExecutionFinish(execution.execution_id, { fencingVersion: execution.fencing_version });
  assert.equal(service.getTask(task.task_id).state, 'CANCELED');
  assert.ok(service.listMissionTasks({ mission_id: task.mission_id }).some((item) => item.task_id === task.task_id));
  assert.equal(service.taskStatus({ mission_id: task.mission_id }).counts.terminal, 1);
  assert.equal(service.getExecution(execution.execution_id).state, 'CANCELLED');
});


test('an accepted finish survives reopening the database and replays with a refreshed envelope', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'swarm-finish-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'task.sqlite');
  const { service, task, execution, envelope } = fixture(t, path);
  const payload = { outcome: 'incomplete', reason: 'Durable work remains' };
  const accepted = service.dispatch('task_finish', payload, envelope('finish:reopen'));
  const reopened = new TaskService(path);
  t.after(() => reopened.close());
  assert.equal(reopened.getExecution(execution.execution_id).state, 'CLOSING');
  assert.equal(reopened.getTask(task.task_id).state, 'RUNNING');
  assert.deepEqual(reopened.dispatch('task_finish', payload, envelope('finish:reopen')), accepted);
  reopened.finalizeExecutionFinish(execution.execution_id, { fencingVersion: execution.fencing_version });
  assert.deepEqual(reopened.dispatch('task_finish', payload, envelope('finish:reopen')), accepted);
  assert.throws(() => reopened.dispatch('task_finish', { ...payload, outcome: 'done' }, envelope('finish:reopen')), (error) => error.code === 'CONFLICT');
});

test('a closing Execution cannot publish new Materials even with refreshed versions', (t) => {
  const { service, envelope } = fixture(t);
  const context = new ContextService(':memory:', { taskService: service });
  t.after(() => context.close());
  const payload = { content: 'A public conclusion' };
  const before = context.dispatch('context_publish_material', payload, envelope('publish:before'));
  service.dispatch('task_finish', { outcome: 'incomplete' }, envelope('finish:publish'));
  assert.throws(() => context.dispatch('context_publish_material', payload, envelope('publish:after')), (error) => error.code === 'NOT_ALLOWED');
  assert.equal(context.getMaterial(before.material.material_id).content, 'A public conclusion');
});

test('blocked validation rolls back invalid owner, cancelled prerequisite and mixed dependency cycles', (t) => {
  const { service, task, execution, envelope, create } = fixture(t);
  const dependent = create('task:dependent', { depends_on: [task.task_id] });
  assert.throws(() => service.dispatch('task_finish', { outcome: 'blocked', wait_for: dependent.task_id, reason: 'Invalid cycle' }, envelope('finish:cycle')), (error) => error.code === 'INVALID_CONTRACT');
  const available = create('task:available');
  assert.throws(() => service.dispatch('task_finish', { outcome: 'blocked', wait_for: available.task_id, reason: 'Wrong owner' }, { ...envelope('finish:owner'), actor_ref: 'agent:stranger' }), (error) => error.code === 'NOT_ALLOWED');
  const cancelled = service.takeTask(available.task_id, { owner_ref: 'agent:available', core_id: 'core-2', take_key: 'available' }).execution;
  service.dispatch('task_finish', { outcome: 'cancelled', reason: 'Responsibility is withdrawn' }, makeEnvelope({ actorRef: cancelled.owner_ref, taskId: available.task_id, executionId: cancelled.execution_id,
    specVersion: cancelled.spec_version, stateVersion: cancelled.state_version, fencingVersion: cancelled.fencing_version }));
  service.finalizeExecutionFinish(cancelled.execution_id, { fencingVersion: cancelled.fencing_version });
  assert.throws(() => service.dispatch('task_finish', { outcome: 'blocked', wait_for: available.task_id, reason: 'Invalid prerequisite' }, envelope('finish:cancelled-prerequisite')), (error) => error.code === 'INVALID_CONTRACT');
  assert.equal(service.getExecution(execution.execution_id).state, 'CREATED');
  assert.equal(service.getExecutionFinish(execution.execution_id), null);
  assert.deepEqual(service.getTask(task.task_id).relations.depends_on, []);
});

test('cleanup recomputes a prerequisite that completed while the owner was closing', (t) => {
  const { service, task, execution, envelope, create } = fixture(t);
  const prerequisite = create('task:during-close');
  service.dispatch('task_finish', { outcome: 'blocked', wait_for: prerequisite.task_id, reason: 'Await the result' }, envelope('finish:during-close'));
  const other = service.takeTask(prerequisite.task_id, { owner_ref: 'agent:other', core_id: 'core-2', take_key: 'during-close' }).execution;
  service.dispatch('task_finish', { outcome: 'done' }, makeEnvelope({ actorRef: other.owner_ref, taskId: prerequisite.task_id, executionId: other.execution_id,
    specVersion: other.spec_version, stateVersion: other.state_version, fencingVersion: other.fencing_version }));
  service.finalizeExecutionFinish(other.execution_id, { fencingVersion: other.fencing_version });
  service.finalizeExecutionFinish(execution.execution_id, { fencingVersion: execution.fencing_version });
  assert.equal(service.getTask(task.task_id).state, 'OPEN');
});

test('Task detail exposes durable finish records after the Agent is gone', (t) => {
  const { service, task, execution, envelope } = fixture(t);
  service.dispatch('task_finish', { outcome: 'incomplete', reason: 'No result was saved' }, envelope('finish:detail'));
  service.finalizeExecutionFinish(execution.execution_id, { fencingVersion: execution.fencing_version });
  const detail = service.viewTaskRecord(task.task_id);
  assert.equal(detail.finishes[0].request_id, 'finish:detail');
  assert.equal(detail.finishes[0].outcome, 'incomplete');
  assert.equal(detail.finishes[0].reason, 'No result was saved');
  assert.ok(detail.finishes[0].closed_at);
});


test('Task completion uses link purpose while handoff keeps producer provenance', t => {
  const { service, task, execution, envelope } = fixture(t);
  const context = new ContextService(':memory:', { taskService: service });
  service.contextService = context;
  t.after(() => context.close());
  const material = context.dispatch('context_publish_material', { content: 'Public handoff result' }, envelope('handoff:publish')).material;
  const result = service.dispatch('task_finish', { outcome: 'incomplete', handoff_material_id: material.material_id }, envelope('handoff:finish'));
  assert.equal(result.execution.state, 'CLOSING');
  const link = service.db.prepare("SELECT * FROM task_material_links WHERE task_id = ? AND material_id = ? AND role = 'handoff'").get(task.task_id, material.material_id);
  assert.equal(link.producer_execution_id, execution.execution_id);
  assert.equal(Object.hasOwn(context.getMaterial(material.material_id), 'role'), false);
});


test('Material completion counts distinct links with the required Task purpose', t => {
  const { service, task, envelope } = fixture(t, undefined, { completion_contract: { required_materials: [{ role: 'experience', min_count: 1 }] } });
  const context = new ContextService(':memory:', { taskService: service });
  service.contextService = context;
  t.after(() => context.close());
  const material = context.dispatch('context_publish_material', { content: 'A reusable result' }, envelope('required:publish')).material;
  service.dispatch('task_link_material', { material_id: material.material_id, role: 'handoff' }, envelope('required:handoff'));
  assert.throws(() => service.dispatch('task_finish', { outcome: 'done' }, envelope('required:missing')), error =>
    error.code === 'INVALID_CONTRACT' && error.details.missing.includes('materials:experience'));
  service.dispatch('task_link_material', { material_id: material.material_id, role: 'experience' }, envelope('required:experience'));
  const result = service.dispatch('task_finish', { outcome: 'done' }, envelope('required:done'));
  assert.equal(result.execution.state, 'CLOSING');
  assert.equal(service.getTask(task.task_id).state, 'RUNNING');
});

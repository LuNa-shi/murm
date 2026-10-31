import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  ContextService,
  ERROR_CODES,
  makeEnvelope,
  SwarmEnvError,
  TaskService,
} from '../src/index.js';

function environment() {
  const database = new DatabaseSync(':memory:');
  const contextService = new ContextService(database);
  const taskService = new TaskService(database, { contextService });
  contextService.taskService = taskService;
  return { database, contextService, taskService };
}

function envelope(operationId, actorRef, fields = {}) {
  return makeEnvelope({ operationId, actorRef, ...fields });
}

function createMission(taskService, missionId = 'mission:materials') {
  return taskService.dispatch('mission.create', {
    mission_id: missionId,
    goal: 'produce and accept shared work',
    acceptance_conditions: ['a durable result is accepted'],
  }, envelope(`mission:${missionId}`, 'operator:test')).mission;
}

function createTask(taskService, missionId, taskId, overrides = {}) {
  return taskService.dispatch('task.create', {
    mission_id: missionId,
    task_id: taskId,
    summary: `Work on ${taskId} without duplicating another Task.`,
    goal: `Answer ${taskId}`,
    expected_output: 'A useful Material',
    acceptance_conditions: ['the result is documented'],
    ...overrides,
  }, envelope(`task:${taskId}`, 'operator:test')).task;
}

function claim(taskService, task, executionId, actorRef) {
  const result = taskService.dispatch('claim', {
    claim_key: `claim:${executionId}`,
    execution_id: executionId,
    owner_ref: actorRef,
  }, envelope(`claim:${executionId}`, actorRef, {
    taskId: task.task_id,
    specVersion: task.spec_version,
    stateVersion: task.state_version,
  }));
  assert.equal(result.execution.execution_id, executionId);
  return result;
}

function bound(operationId, actorRef, task, execution) {
  return envelope(operationId, actorRef, {
    taskId: task.task_id,
    executionId: execution.execution_id,
    specVersion: execution.spec_version,
    stateVersion: execution.state_version,
    fencingVersion: execution.fencing_version,
  });
}

test('Context Materials retain collaboration role and producer provenance', () => {
  const { contextService, taskService } = environment();
  const mission = createMission(taskService, 'mission:roles');
  const task = createTask(taskService, mission.mission_id, 'task:producer');
  const claimed = claim(taskService, task, 'execution:producer', 'agent:producer');

  const response = contextService.dispatch('context.publish_material', {
    role: 'response',
    kind: 'fact',
    scope: 'mission',
    content: { finding: 'a useful result' },
  }, bound('material:response', 'agent:producer', task, claimed.execution));
  assert.equal(response.material.role, 'response');
  assert.equal(response.material.source_task, task.task_id);
  assert.equal(response.material.source_execution, claimed.execution.execution_id);

  const experience = contextService.dispatch('context.publish_material', {
    role: 'experience',
    kind: 'experience',
    scope: 'mission',
    content: { heuristic: 'share this with the swarm' },
  }, bound('material:experience', 'agent:producer', task, response.execution ?? claimed.execution));
  assert.equal(experience.material.role, 'experience');
  assert.equal(experience.material.source_task, task.task_id);
  assert.deepEqual(contextService.dispatch('context.search_materials', { role: 'experience', mission_id: mission.mission_id }, envelope('material:search', 'agent:reader')), [experience.material]);
  assert.equal(contextService.dispatch('context.get_material', { material_id: response.material.material_id }, envelope('material:get', 'agent:reader')).material.material_id, response.material.material_id);
  taskService.close();
});

test('response links are queryable and receiving Task closes a producer after DONE', () => {
  const { contextService, taskService } = environment();
  const mission = createMission(taskService, 'mission:close');
  const producer = createTask(taskService, mission.mission_id, 'task:producer');
  const receiver = createTask(taskService, mission.mission_id, 'task:receiver');
  const producerClaim = claim(taskService, producer, 'execution:producer-close', 'agent:producer');
  const response = contextService.dispatch('context.publish_material', {
    role: 'response', kind: 'fact', scope: 'mission',
    content: { answer: 'use this downstream' },
  }, bound('material:response-close', 'agent:producer', producer, producerClaim.execution));

  const link = taskService.dispatch('task.link_material', {
    task_id: receiver.task_id,
    material_id: response.material.material_id,
    role: 'response',
    receiving_task_id: receiver.task_id,
  }, bound('link:response-close', 'agent:producer', producer, producerClaim.execution));
  assert.equal(link.link.material_id, response.material.material_id);
  assert.equal(link.link.producer_task_id, producer.task_id);
  assert.equal(link.link.producer_execution_id, producerClaim.execution.execution_id);
  assert.equal(taskService.dispatch('task.materials', { task_id: receiver.task_id }, envelope('materials:receiver', 'agent:reader')).links[0].role, 'response');

  const completed = taskService.dispatch('task.complete', {}, bound('complete:producer-close', 'agent:producer', producer, producerClaim.execution));
  assert.equal(completed.task.state, 'DONE');
  assert.equal(completed.execution.state, 'SUCCEEDED');

  const receiverClaim = claim(taskService, receiver, 'execution:receiver-close', 'agent:receiver');
  const closed = taskService.dispatch('task.close', {
    producer_task_id: producer.task_id,
    material_id: response.material.material_id,
  }, bound('close:producer', 'agent:receiver', receiver, receiverClaim.execution));
  assert.equal(closed.task.state, 'CLOSED');
  assert.equal(closed.producer_task_id, producer.task_id);

  assert.throws(() => taskService.dispatch('task.close', {
    producer_task_id: producer.task_id,
    material_id: response.material.material_id,
  }, bound('close:self', 'agent:producer', producer, taskService.getExecution(producerClaim.execution.execution_id))), (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.NOT_ALLOWED);
  taskService.close();
});

test('a producer Task completes after delivering a required Response Material', () => {
  const { contextService, taskService } = environment();
  const mission = createMission(taskService, 'mission:required-response');
  const receiver = createTask(taskService, mission.mission_id, 'task:required-response-receiver');
  const producer = createTask(taskService, mission.mission_id, 'task:required-response-producer', {
    completion_contract: {
      required_response: [{ receiving_task_id: receiver.task_id, min_count: 1 }],
    },
  });
  const producerClaim = claim(taskService, producer, 'execution:required-response-producer', 'agent:producer');
  const response = contextService.dispatch('context.publish_material', {
    role: 'response', kind: 'fact', scope: 'mission',
    content: { answer: 'directed result' },
  }, bound('material:required-response', 'agent:producer', producer, producerClaim.execution));
  taskService.dispatch('task.link_material', {
    task_id: receiver.task_id,
    material_id: response.material.material_id,
    role: 'response',
    receiving_task_id: receiver.task_id,
  }, bound('link:required-response', 'agent:producer', producer, producerClaim.execution));

  const completed = taskService.dispatch('task.complete', {
    material_ids: [response.material.material_id],
  }, bound('complete:required-response', 'agent:producer', producer, producerClaim.execution));
  assert.equal(completed.task.state, 'DONE');
  assert.equal(completed.execution.state, 'SUCCEEDED');
  taskService.close();
});

test('a receiving Task may attach shared Experience Material without changing producer provenance', () => {
  const { contextService, taskService } = environment();
  const mission = createMission(taskService, 'mission:experience-link');
  const producer = createTask(taskService, mission.mission_id, 'task:experience-producer');
  const receiver = createTask(taskService, mission.mission_id, 'task:experience-receiver');
  const producerClaim = claim(taskService, producer, 'execution:experience-producer', 'agent:producer');
  const experience = contextService.dispatch('context.publish_material', {
    role: 'experience', kind: 'experience', scope: 'mission',
    content: { heuristic: 'share this with later work' },
  }, bound('material:experience-link', 'agent:producer', producer, producerClaim.execution));
  const receiverClaim = claim(taskService, receiver, 'execution:experience-receiver', 'agent:receiver');
  const link = taskService.dispatch('task.link_material', {
    task_id: receiver.task_id,
    material_id: experience.material.material_id,
    role: 'experience',
  }, bound('link:experience-receiver', 'agent:receiver', receiver, receiverClaim.execution));
  assert.equal(link.link.task_id, receiver.task_id);
  assert.equal(link.link.producer_task_id, producer.task_id);
  assert.equal(link.link.producer_execution_id, producerClaim.execution.execution_id);
  assert.equal(contextService.dispatch('context.search_materials', {
    mission_id: mission.mission_id,
    task_id: receiver.task_id,
  }, envelope('search:experience-receiver', 'agent:receiver')).some((material) => material.material_id === experience.material.material_id), true);
  taskService.close();
});

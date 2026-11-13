import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ContextService, ERROR_CODES, SwarmEnvError, TaskService, makeEnvelope } from '../src/index.js';

// Issue #122 removes the legacy shared Mission Task. A Mission can have zero
// Tasks, and every concrete Task has the ordinary exclusive lifecycle.

function env(operationId, actorRef, fields = {}) {
  return makeEnvelope({ operationId, actorRef, ...fields });
}

function setup() {
  const database = new DatabaseSync(':memory:');
  const contextService = new ContextService(database);
  const taskService = new TaskService(database, { contextService });
  contextService.taskService = taskService;
  taskService.dispatch('mission.create', { mission_id: 'mission:r12', goal: 'shared problem' }, env('mission', 'operator:test'));
  return { contextService, taskService };
}

function makeTask(taskService, taskId) {
  return taskService.dispatch('task.create', {
    mission_id: 'mission:r12',
    task_id: taskId,
    summary: `Investigate ${taskId} as an independently useful responsibility.`,
    goal: taskId,
    expected_output: 'durable Material',
    acceptance_conditions: ['publish a useful result'],
  }, env(`create:${taskId}`, 'operator:test')).task;
}

function claim(taskService, taskId, executionId, actorRef) {
  const task = taskService.getTask(taskId);
  return taskService.dispatch('claim', {
    claim_key: `claim:${executionId}`,
    execution_id: executionId,
    owner_ref: actorRef,
    agent_prompt: 'execute the current Task',
  }, env(`claim:${executionId}`, actorRef, {
    taskId, specVersion: task.spec_version, stateVersion: task.state_version,
  })).execution;
}

function bound(taskService, taskId, executionId, actorRef, operationId) {
  const execution = taskService.getExecution(executionId);
  return env(operationId, actorRef, {
    taskId,
    executionId,
    specVersion: execution.spec_version,
    stateVersion: execution.state_version,
    fencingVersion: execution.fencing_version,
  });
}

function blockWith(taskService, contextService, taskId, executionId, actorRef, dependency) {
  const material = contextService.dispatch('context.publish_material', {
    role: 'handoff', kind: 'failure', scope: 'mission', content: { blocker: 'branch prerequisite' },
  }, bound(taskService, taskId, executionId, actorRef, `material:${executionId}`));
  taskService.dispatch('task.link_material', {
    task_id: taskId, material_id: material.material.material_id, role: 'handoff',
  }, bound(taskService, taskId, executionId, actorRef, `link:${executionId}`));
  return taskService.dispatch('task.block', {
    blocker: { reason: 'branch prerequisite' },
    dependency,
    handoff_material_id: material.material.material_id,
  }, bound(taskService, taskId, executionId, actorRef, `block:${executionId}`));
}
test('a blocked Task remains blocked while the Mission itself has no claim entry', () => {
  const { contextService, taskService } = setup();
  try {
    const mission = makeTask(taskService, 'task:0-mission');
    const lemma = makeTask(taskService, 'task:lemma');
    claim(taskService, mission.task_id, 'execution:a', 'agent:a');
    const blocked = blockWith(taskService, contextService, mission.task_id, 'execution:a', 'agent:a', {
      dependency_kind: 'TASK', prerequisite_task_id: lemma.task_id,
    });
    assert.equal(blocked.execution.state, 'HANDED_OFF');
    assert.equal(blocked.task.state, 'BLOCKED');
    assert.match(blocked.task.block_reason, /^dependency:/);
    assert.ok(taskService.getTask(mission.task_id).blockers.length > 0);

    const claimable = taskService.listClaimableTasks({ missionId: 'mission:r12', limit: 10 }).map((task) => task.task_id);
    assert.equal(claimable.includes(mission.task_id), false);
    const listed = taskService.listTasks({ states: ['OPEN', 'RUNNING'], availableOnly: true }).map((task) => task.task_id);
    assert.equal(listed.includes(mission.task_id), false);

    const reconciled = taskService.dispatch('reconcile_task', { task_id: mission.task_id }, env('reconcile:mission', 'controller:test'));
    assert.equal(reconciled.task.state, 'BLOCKED');

    // task_status counts must agree with the claimable view (B06).
    const status = taskService.dispatch('task_status', { mission_id: 'mission:r12' }, env('status:mission', 'agent:b'));
    assert.equal(status.claimable_tasks.some((task) => task.task_id === mission.task_id), false);
    assert.equal(status.counts.claimable, status.claimable_tasks.length);
    assert.throws(() => claim(taskService, mission.task_id, 'execution:b', 'agent:b'), /blocked|claimable/i);
  } finally {
    taskService.close();
  }
});

test('a capability block applies to the concrete Task, not the Mission', () => {
  const { contextService, taskService } = setup();
  try {
    const mission = makeTask(taskService, 'task:0-mission');
    claim(taskService, mission.task_id, 'execution:a', 'agent:a');
    const blocked = blockWith(taskService, contextService, mission.task_id, 'execution:a', 'agent:a', {
      dependency_kind: 'CAPABILITY', capability_id: 'external.unregistered_prover',
    });
    assert.equal(blocked.execution.state, 'HANDED_OFF');
    assert.equal(blocked.task.state, 'BLOCKED');
    assert.throws(() => claim(taskService, mission.task_id, 'execution:b', 'agent:b'), /blocked|claimable/i);
  } finally {
    taskService.close();
  }
});

test('ordinary Task block keeps exclusive BLOCKED semantics', () => {
  const { contextService, taskService } = setup();
  try {
    makeTask(taskService, 'task:0-mission');
    const branch = makeTask(taskService, 'task:branch');
    const lemma = makeTask(taskService, 'task:lemma');
    claim(taskService, branch.task_id, 'execution:branch', 'agent:a');
    const blocked = blockWith(taskService, contextService, branch.task_id, 'execution:branch', 'agent:a', {
      dependency_kind: 'TASK', prerequisite_task_id: lemma.task_id,
    });
    assert.equal(blocked.task.state, 'BLOCKED');
    assert.throws(() => claim(taskService, branch.task_id, 'execution:other', 'agent:b'),
      (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.NOT_ALLOWED);
  } finally {
    taskService.close();
  }
});

test('a legacy BLOCKED Task is not reopened as a shared Mission Task', () => {
  const { contextService, taskService } = setup();
  try {
    const mission = makeTask(taskService, 'task:0-mission');
    claim(taskService, mission.task_id, 'execution:a', 'agent:a');
    blockWith(taskService, contextService, mission.task_id, 'execution:a', 'agent:a', {
      dependency_kind: 'CAPABILITY', capability_id: 'external.unregistered_prover',
    });
    // Simulate the r12 durable state written by the previous implementation.
    taskService.db.prepare("UPDATE tasks SET state = 'BLOCKED', block_reason = 'external:swarmenv_workspace_get' WHERE task_id = ?").run(mission.task_id);
    const reconciled = taskService.dispatch('reconcile_task', { task_id: mission.task_id }, env('reconcile:legacy', 'controller:test'));
    assert.equal(reconciled.task.state, 'BLOCKED');
    assert.equal(reconciled.changed, false);
  } finally {
    taskService.close();
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { ServicesBridge, ServicesRouter } from '../src/index.js';

function services() {
  const calls = [];
  const taskService = {
    dispatch(operation, payload, envelope) {
      calls.push({ service: 'task', operation, payload: structuredClone(payload), envelope: structuredClone(envelope) });
      if (operation === 'list_tasks') return [{ task_id: 'public-task', goal: 'bounded discovery' }];
      return { service: 'task', operation, payload };
    },
    getTask(taskId) {
      return { task_id: taskId, spec_version: 1, state_version: 3 };
    },
    getExecution(executionId) {
      return {
        execution_id: executionId,
        task_id: 'task-1',
        spec_version: 1,
        state_version: 7,
        fencing_version: 2,
        state: 'RUNNING',
      };
    },
  };
  const contextService = {
    dispatch(operation, payload, envelope) {
      calls.push({ service: 'context', operation, payload: structuredClone(payload), envelope: structuredClone(envelope) });
      return { service: 'context', operation, payload };
    },
  };
  return { calls, taskService, contextService };
}

test('ServicesRouter exposes the semantic Task structure operations', () => {
  const { calls, taskService, contextService } = services();
  const router = new ServicesRouter({ taskService, contextService });
  for (const operation of [
    'create_branch_group',
    'add_required_subtask',
    'get_task_structure',
    'propose_structure_change',
    'explain_task_readiness',
    'create_rework_task',
  ]) {
    const payload = { task_id: 'task-1', operation_marker: operation };
    const result = router.dispatch(operation, payload, { actor_ref: 'agent:test' });
    assert.equal(result.operation, operation);
  }
  assert.deepEqual(calls.map(({ service, operation }) => ({ service, operation })), [
    { service: 'task', operation: 'create_branch_group' },
    { service: 'task', operation: 'add_required_subtask' },
    { service: 'task', operation: 'get_task_structure' },
    { service: 'task', operation: 'propose_structure_change' },
    { service: 'task', operation: 'explain_task_readiness' },
    { service: 'task', operation: 'create_rework_task' },
  ]);
});

test('ServicesBridge exposes discovery and task work to one reusable Bound identity', async () => {
  const { calls, taskService, contextService } = services();
  const router = new ServicesRouter({ taskService, contextService });
  const bridge = new ServicesBridge({ taskService, contextService, runtime: {}, router, actorRef: 'agent:surface' });
  const tasks = await bridge.call({ operation: 'list_tasks', payload: { limit: 8 } });
  assert.deepEqual(tasks.map((task) => task.task_id), ['public-task']);
  assert.equal(bridge.taskId, null);

  const bound = new ServicesBridge({
    taskService,
    contextService,
    runtime: {},
    router,
    actorRef: 'agent:surface',
    taskId: 'task-1',
    executionId: 'execution-1',
  });
  try {
    await bound.call({ operation: 'create_child_task', payload: { task_type: 'research', goal: 'route A', expected_output: 'fact', acceptance_conditions: {} } });
  } finally {
    await bound.stop();
    await bridge.stop();
  }
  assert.deepEqual(calls.map(({ operation }) => operation), [
    'list_tasks',
    'create_child_task',
  ]);
  assert.equal(calls[1].envelope.actor_ref, 'agent:surface');
  assert.equal(calls[1].envelope.task_id, 'task-1');
  assert.equal(calls[1].envelope.execution_id, 'execution-1');
});

test('Runtime-only handoff transitions are not exposed as Agent Service tools', () => {
  const { taskService, contextService } = services();
  const router = new ServicesRouter({ taskService, contextService });
  assert.throws(() => router.dispatch('handoff_execution', {}, { actor_ref: 'agent:test' }), /no service route/);
  assert.throws(() => router.dispatch('record_handoff_reminder', {}, { actor_ref: 'agent:test' }), /no service route/);
});

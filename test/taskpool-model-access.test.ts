import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskService } from '../src/task/task-service.js';
import { makeEnvelope } from '../src/protocol/envelope.js';

function fixture(t) {
  const tasks = new TaskService();
  t.after(() => tasks.close());
  tasks.createMission({ mission_id: 'mission:flat', goal: 'Check trusted model authority' }, makeEnvelope({ actorRef: 'host' }));
  return tasks;
}

test('trusted Core readiness preserves returned identity and legacy capacity without inventing a sandbox', t => {
  const tasks = fixture(t);
  const deadline = new Date(Date.now() + 60_000).toISOString();
  const started = tasks.registerAgent({ agentId: 'core-returned-agent', missionId: 'mission:flat', legacySlotId: 'legacy-slot:1', selectionDeadline: deadline });
  assert.equal(started.core_id, 'legacy-slot:1');
  assert.throws(() => tasks.markAgentReady(started.agent_id), { code: 'NOT_ALLOWED' });
  const ready = tasks.markCoreAgentReady(started.agent_id);
  assert.equal(ready.agent_id, 'core-returned-agent');
  assert.equal(ready.state, 'UNBOUND');
  assert.equal(ready.sandbox_id, null);
  assert.equal(ready.provider, null);
  assert.equal(ready.sandbox_create_state, 'NOT_DISPATCHED');
  assert.deepEqual(tasks.markCoreAgentReady(ready.agent_id), ready);
  assert.throws(() => tasks.registerAgent({ agentId: 'other', missionId: 'mission:flat', legacySlotId: 'legacy-slot:1', selectionDeadline: deadline }), { code: 'CONFLICT' });
  assert.throws(() => tasks.registerAgent({ agentId: 'mixed', missionId: 'mission:flat', coreId: 'old', legacySlotId: 'different', selectionDeadline: deadline }), { code: 'INVALID_CONTRACT' });
});

test('trusted startup uses only Core returned Agent identity and keeps Runtime separate from legacy Slot', async t => {
  const { createTaskPoolAgentCoordinator } = await import('../src/harnesses/taskpool/agent-coordinator.js');
  const tasks = fixture(t);
  const requests = [];
  const runtime = { id: 'runtime:host', async spawn(options) { requests.push(options); return { id: 'core:actual', profile: 'readonly', status: 'idle' }; },
    async stop() { throw new Error('Unexpected cleanup'); } };
  const coordinator = createTaskPoolAgentCoordinator({ runtime, taskService: tasks, missionId: 'mission:flat' });
  const options = { requestId: 'spawn:1', profile: 'readonly', legacySlotId: 'legacy:1', selectionDeadline: new Date(Date.now() + 30_000).toISOString() };
  const agent = await coordinator.spawn(options);
  assert.equal(agent.id, 'core:actual');
  assert.equal(tasks.getAgent(agent.id).state, 'UNBOUND');
  assert.equal(tasks.getAgent(agent.id).core_id, 'legacy:1');
  assert.equal(tasks.getAgent(runtime.id), null);
  assert.deepEqual(requests, [{ requestId: 'spawn:1', profile: 'readonly' }]);
  assert.deepEqual(await coordinator.spawn(options), agent);
  assert.equal(requests.length, 1);
  await assert.rejects(coordinator.spawn({ ...options, legacySlotId: runtime.id }), { code: 'INVALID_CONTRACT' });
});

function executionEnvelope(execution, actorRef = execution.owner_ref) {
  return makeEnvelope({ actorRef, taskId: execution.task_id, executionId: execution.execution_id,
    specVersion: execution.spec_version, stateVersion: execution.state_version, fencingVersion: execution.fencing_version });
}

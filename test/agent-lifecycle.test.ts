import { openSandboxAgentKey } from '../src/runtime/opensandbox-metadata.js';
import { createOpenSandboxManager } from '../src/runtime/opensandbox-manager.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskService } from '../src/task/task-service.js';
import { makeEnvelope } from '../src/protocol/envelope.js';

function fixture(t) {
  const service = new TaskService();
  t.after(() => service.close());
  service.createMission({ mission_id: 'mission:agents', goal: 'Investigate independent responsibilities' }, makeEnvelope({ actorRef: 'operator:test' }));
  const start = (agentId, coreId = 'core-1') => service.registerAgent({ agentId, coreId, missionId: 'mission:agents', selectionDeadline: new Date(Date.now() + 60_000).toISOString() });
  return { service, start };
}

test('a Agent occupies its Core durably before any Task or Execution exists', (t) => {
  const { service, start } = fixture(t);
  const agent = start('agent:first');
  assert.equal(agent.state, 'STARTING');
  assert.equal(agent.execution_id, null);
  assert.equal(agent.mission_id, 'mission:agents');
  assert.equal(service.getAgent('agent:first').core_id, 'core-1');
  assert.equal(service.listMissionTasks({ mission_id: 'mission:agents' }).length, 0);
  assert.equal(service.listActiveExecutions().length, 0);
  assert.throws(() => start('agent:duplicate'), (error) => error.code === 'CONFLICT');
  assert.equal(start('agent:parallel', 'core-2').execution_id, null);
});

test('a registered Agent binds exactly one Execution and never takes a second Task', (t) => {
  const { service, start } = fixture(t);
  const agent = start('agent:one-task');
  service.recordAgentSandbox(agent.agent_id, { provider: 'controlled', sandboxId: 'sandbox:one-task' });
  service.markAgentReady(agent.agent_id);
  const create = (id) => service.createTask({ mission_id: agent.mission_id, task_id: id, gap: `The Mission needs an answer to independent question ${id}`, priority: 'medium', summary: `Investigate local question ${id}`,
    goal: `Resolve ${id}`, expected_output: 'Reusable conclusion', acceptance_conditions: ['Question answered'] }, makeEnvelope({ actorRef: agent.agent_id })).task;
  const first = create('task:first');
  const second = create('task:second');
  const taken = service.takeTask(first.task_id, { owner_ref: agent.agent_id, core_id: agent.core_id, take_key: 'take:first' });
  assert.equal(service.getAgent(agent.agent_id).execution_id, taken.execution.execution_id);
  assert.equal(service.getAgent(agent.agent_id).state, 'PREPARING');
  const preparing = taken.execution;
  const execution = service.dispatch('start_execution', {}, makeEnvelope({ actorRef: agent.agent_id, taskId: first.task_id, executionId: preparing.execution_id,
    specVersion: preparing.spec_version, stateVersion: preparing.state_version, fencingVersion: preparing.fencing_version })).execution;
  assert.equal(service.getAgent(agent.agent_id).state, 'ACTIVE');
  const finishEnvelope = makeEnvelope({ actorRef: agent.agent_id, taskId: first.task_id, executionId: execution.execution_id,
    specVersion: execution.spec_version, stateVersion: execution.state_version, fencingVersion: execution.fencing_version });
  const accepted = service.dispatch('task_finish', { outcome: 'incomplete' }, finishEnvelope);
  service.finalizeExecutionFinish(execution.execution_id, { fencingVersion: execution.fencing_version });
  assert.equal(service.getAgent(agent.agent_id).state, 'CLOSING');
  service.finalizeAgentClose(agent.agent_id);
  assert.equal(service.getAgent(agent.agent_id).state, 'CLOSED');
  assert.deepEqual(service.dispatch('task_finish', { outcome: 'incomplete' }, finishEnvelope), accepted);
  assert.throws(() => service.takeTask(second.task_id, { owner_ref: agent.agent_id, core_id: agent.core_id, take_key: 'take:second' }), (error) => error.code === 'NOT_ALLOWED');
  const next = start('agent:successor');
  assert.notEqual(next.agent_id, agent.agent_id);
  assert.equal(next.core_id, agent.core_id);
});

test('unbound exit is durable, creates no Execution, and releases the Core only after cleanup', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { service, start } = fixture(t);
  const agent = start('agent:no-work');
  service.recordAgentSandbox(agent.agent_id, { provider: 'controlled', sandboxId: 'sandbox:no-work' });
  service.markAgentReady(agent.agent_id);
  const request = makeEnvelope({ actorRef: agent.agent_id, operationId: 'agent:exit:first' });
  for (const reason of ['no-work', 'selection-budget']) {
    assert.throws(() => service.dispatch('agent_exit', { reason }, request),
      error => error.code === 'NOT_ALLOWED' && error.details.phase === 'discovery_required');
    assert.equal(service.getAgent(agent.agent_id).state, 'UNBOUND');
  }
  t.mock.timers.setTime(Date.parse(agent.selection_deadline));
  const accepted = service.dispatch('agent_exit', { reason: 'selection-budget' }, request);
  assert.equal(accepted.agent.state, 'CLOSING');
  assert.equal(accepted.agent.execution_id, null);
  assert.equal(service.listActiveExecutions().length, 0);
  assert.throws(() => start('agent:too-early'), (error) => error.code === 'CONFLICT');
  service.finalizeAgentClose(agent.agent_id);
  assert.deepEqual(service.dispatch('agent_exit', { reason: 'selection-budget' }, request), accepted);
  assert.equal(service.getAgent(agent.agent_id).exit_reason, 'selection-budget');
  assert.equal(start('agent:after-event').state, 'STARTING');
});

test('expired durable deadline denies a fresh Agent write even before a timer changes state', t => {
  const { service, start } = fixture(t);
  const agent = start('agent:expired');
  service.recordAgentSandbox(agent.agent_id, { provider: 'controlled', sandboxId: 'sandbox:expired' });
  service.markAgentReady(agent.agent_id);
  const past = new Date(Date.now() - 1).toISOString();
  service.db.prepare('UPDATE agents SET hard_deadline = ? WHERE agent_id = ?').run(past, agent.agent_id);
  assert.equal(service.getAgent(agent.agent_id).state, 'UNBOUND');
  assert.throws(() => service.createTask({ mission_id: agent.mission_id, gap: 'The Mission still lacks this late boundary observation', priority: 'medium', summary: 'Late proposal must be rejected at the write boundary', expected_output: 'Note', acceptance_conditions: ['Note'] }, makeEnvelope({ actorRef: agent.agent_id })), /hard deadline elapsed/);
});

test('trusted Runtime activation rechecks the Agent deadline inside the Task write transaction', t => {
  const { service, start } = fixture(t);
  const agent = start('agent:activate-expired');
  service.recordAgentSandbox(agent.agent_id, { provider: 'controlled', sandboxId: 'sandbox:activate-expired' });
  service.markAgentReady(agent.agent_id);
  const task = service.createTask({ mission_id: agent.mission_id, gap: 'The Mission needs evidence that expired activation is denied', priority: 'medium', summary: 'Verify the activation write boundary', expected_output: 'Note', acceptance_conditions: ['Note'] }, makeEnvelope({ actorRef: agent.agent_id })).task;
  const { execution } = service.takeTask(task.task_id, { owner_ref: agent.agent_id, core_id: agent.core_id, take_key: 'expired-activation' });
  service.db.prepare('UPDATE agents SET hard_deadline = ? WHERE agent_id = ?').run(new Date(Date.now() - 1).toISOString(), agent.agent_id);
  assert.throws(() => service.dispatch('start_execution', {}, makeEnvelope({ actorRef: 'runtime:trusted', taskId: task.task_id, executionId: execution.execution_id,
    specVersion: execution.spec_version, stateVersion: execution.state_version, fencingVersion: execution.fencing_version })), /hard deadline elapsed/);
  assert.equal(service.getExecution(execution.execution_id).state, 'CREATED');
});

test('a queued Runtime heartbeat cannot renew a registered Agent lease after expiry before sweep', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { service, start } = fixture(t);
  const agent = start('agent:late-heartbeat');
  service.recordAgentSandbox(agent.agent_id, { provider: 'controlled', sandboxId: 'sandbox:late-heartbeat' });
  service.markAgentReady(agent.agent_id);
  const task = service.createTask({ mission_id: agent.mission_id, gap: 'The Mission needs evidence that expired heartbeats cannot renew leases', priority: 'medium', summary: 'Observe delayed heartbeat admission',
    expected_output: 'Note', acceptance_conditions: ['Note'] }, makeEnvelope({ actorRef: agent.agent_id })).task;
  const { execution: preparing } = service.takeTask(task.task_id, { owner_ref: agent.agent_id, core_id: agent.core_id, take_key: 'late-heartbeat' });
  const envelope = (execution, actorRef = 'runtime:core-1') => makeEnvelope({ actorRef, taskId: execution.task_id,
    executionId: execution.execution_id, specVersion: execution.spec_version, stateVersion: execution.state_version,
    fencingVersion: execution.fencing_version });
  const { execution } = service.dispatch('start_execution', {}, envelope(preparing, agent.agent_id));
  const freshLease = new Date(Date.now() + 50).toISOString();
  const { execution: renewed } = service.dispatch('heartbeat', { lease_expires_at: freshLease }, envelope(execution));
  assert.equal(renewed.lease_expires_at, freshLease);

  // Advance clocks past the lease without running sweep or closing the Agent.
  // A due heartbeat can get the first callback after an event-loop stall.
  t.mock.timers.setTime(Date.parse(freshLease) + 1);
  assert.equal(service.getAgent(agent.agent_id).state, 'ACTIVE');
  assert.equal(service.getExecution(execution.execution_id).state, 'RUNNING');
  assert.throws(() => service.dispatch('heartbeat', {}, envelope(renewed)),
    error => error.code === 'NOT_ALLOWED' && /Execution lease has expired/.test(error.message));
  assert.deepEqual(service.getExecution(execution.execution_id), renewed);
});

test('provider persists intent before POST, sends a finite lifetime and only records definitive rejection', async t => {
  const tasks = new TaskService(':memory:');
  tasks.createMission({ mission_id: 'M', goal: 'Investigate' });
  t.after(() => tasks.close());
  let status = 400;
  const manager = createOpenSandboxManager({ lifecycleBaseUrl: 'http://provider.test/v1', image: 'fixture', fetchImpl: async (url, request) => {
    assert.equal(request.method, 'POST');
    const body = JSON.parse(request.body);
    const agent = tasks.listRecoverableAgents('M').find(candidate => openSandboxAgentKey(candidate.agent_id) === body.metadata.agent_key);
    assert.equal(agent.sandbox_create_state, 'UNKNOWN');
    assert.equal(agent.sandbox_timeout_seconds, 90);
    assert.equal(body.timeout, 90);
    return new Response('{}', { status });
  } });
  for (const [agentId, responseStatus, expected] of [['rejected', 400, 'REJECTED'], ['unknown', 502, 'UNKNOWN']]) {
    status = responseStatus;
    tasks.registerAgent({ agentId, missionId: 'M', coreId: agentId, selectionDeadline: new Date(Date.now() + 60_000).toISOString() });
    await assert.rejects(manager.ensureExecution({ executionId: agentId, agentId, timeoutSeconds: 90,
      onCreateDispatch: resource => tasks.recordAgentSandboxDispatch(agentId, { provider: resource.provider, timeoutSeconds: resource.timeout_seconds }),
      onCreateRejected: () => tasks.recordAgentSandboxRejection(agentId),
    }));
    assert.equal(tasks.getAgent(agentId).sandbox_create_state, expected);
    assert.equal(manager.ownsAgentResource(agentId), expected === 'UNKNOWN');
  }
});

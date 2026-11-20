import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskService } from '../src/task/task-service.js';
import { makeEnvelope } from '../src/protocol/envelope.js';

function fixture(t) {
  const service = new TaskService();
  t.after(() => service.close());
  service.createMission({ mission_id: 'mission:bots', goal: 'Investigate independent responsibilities' }, makeEnvelope({ actorRef: 'operator:test' }));
  const start = (botId, coreId = 'core-1') => service.registerBot({ botId, coreId, missionId: 'mission:bots', selectionDeadline: new Date(Date.now() + 60_000).toISOString() });
  return { service, start };
}

test('a Bot occupies its Core durably before any Task or Execution exists', (t) => {
  const { service, start } = fixture(t);
  const bot = start('bot:first');
  assert.equal(bot.state, 'STARTING');
  assert.equal(bot.execution_id, null);
  assert.equal(bot.mission_id, 'mission:bots');
  assert.equal(service.getBot('bot:first').core_id, 'core-1');
  assert.equal(service.listMissionTasks({ mission_id: 'mission:bots' }).length, 0);
  assert.equal(service.listActiveExecutions().length, 0);
  assert.throws(() => start('bot:duplicate'), (error) => error.code === 'CONFLICT');
  assert.equal(start('bot:parallel', 'core-2').execution_id, null);
});

test('a registered Bot binds exactly one Execution and never takes a second Task', (t) => {
  const { service, start } = fixture(t);
  const bot = start('bot:one-task');
  service.recordBotSandbox(bot.bot_id, { provider: 'controlled', sandboxId: 'sandbox:one-task' });
  service.markBotReady(bot.bot_id);
  const create = (id) => service.createTask({ mission_id: bot.mission_id, task_id: id, gap: `The Mission needs an answer to independent question ${id}`, priority: 'medium', summary: `Investigate local question ${id}`,
    goal: `Resolve ${id}`, expected_output: 'Reusable conclusion', acceptance_conditions: ['Question answered'] }, makeEnvelope({ actorRef: bot.bot_id })).task;
  const first = create('task:first');
  const second = create('task:second');
  const taken = service.takeTask(first.task_id, { owner_ref: bot.bot_id, core_id: bot.core_id, take_key: 'take:first' });
  assert.equal(service.getBot(bot.bot_id).execution_id, taken.execution.execution_id);
  assert.equal(service.getBot(bot.bot_id).state, 'PREPARING');
  const preparing = taken.execution;
  const execution = service.dispatch('start_execution', {}, makeEnvelope({ actorRef: bot.bot_id, taskId: first.task_id, executionId: preparing.execution_id,
    specVersion: preparing.spec_version, stateVersion: preparing.state_version, fencingVersion: preparing.fencing_version })).execution;
  assert.equal(service.getBot(bot.bot_id).state, 'ACTIVE');
  const finishEnvelope = makeEnvelope({ actorRef: bot.bot_id, taskId: first.task_id, executionId: execution.execution_id,
    specVersion: execution.spec_version, stateVersion: execution.state_version, fencingVersion: execution.fencing_version });
  const accepted = service.dispatch('task_finish', { outcome: 'incomplete' }, finishEnvelope);
  service.finalizeExecutionFinish(execution.execution_id, { fencingVersion: execution.fencing_version });
  assert.equal(service.getBot(bot.bot_id).state, 'CLOSING');
  service.finalizeBotClose(bot.bot_id);
  assert.equal(service.getBot(bot.bot_id).state, 'CLOSED');
  assert.deepEqual(service.dispatch('task_finish', { outcome: 'incomplete' }, finishEnvelope), accepted);
  assert.throws(() => service.takeTask(second.task_id, { owner_ref: bot.bot_id, core_id: bot.core_id, take_key: 'take:second' }), (error) => error.code === 'NOT_ALLOWED');
  const next = start('bot:successor');
  assert.notEqual(next.bot_id, bot.bot_id);
  assert.equal(next.core_id, bot.core_id);
});

test('unbound exit is durable, creates no Execution, and releases the Core only after cleanup', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { service, start } = fixture(t);
  const bot = start('bot:no-work');
  service.recordBotSandbox(bot.bot_id, { provider: 'controlled', sandboxId: 'sandbox:no-work' });
  service.markBotReady(bot.bot_id);
  const request = makeEnvelope({ actorRef: bot.bot_id, operationId: 'bot:exit:first' });
  for (const reason of ['no-work', 'selection-budget']) {
    assert.throws(() => service.dispatch('bot_exit', { reason }, request),
      error => error.code === 'NOT_ALLOWED' && error.details.phase === 'discovery_required');
    assert.equal(service.getBot(bot.bot_id).state, 'UNBOUND');
  }
  t.mock.timers.setTime(Date.parse(bot.selection_deadline));
  const accepted = service.dispatch('bot_exit', { reason: 'selection-budget' }, request);
  assert.equal(accepted.bot.state, 'CLOSING');
  assert.equal(accepted.bot.execution_id, null);
  assert.equal(service.listActiveExecutions().length, 0);
  assert.throws(() => start('bot:too-early'), (error) => error.code === 'CONFLICT');
  service.finalizeBotClose(bot.bot_id);
  assert.deepEqual(service.dispatch('bot_exit', { reason: 'selection-budget' }, request), accepted);
  assert.equal(service.getBot(bot.bot_id).exit_reason, 'selection-budget');
  assert.equal(start('bot:after-event').state, 'STARTING');
});

test('expired durable deadline denies a fresh Bot write even before a timer changes state', t => {
  const { service, start } = fixture(t);
  const bot = start('bot:expired');
  service.recordBotSandbox(bot.bot_id, { provider: 'controlled', sandboxId: 'sandbox:expired' });
  service.markBotReady(bot.bot_id);
  const past = new Date(Date.now() - 1).toISOString();
  service.db.prepare('UPDATE bots SET hard_deadline = ? WHERE bot_id = ?').run(past, bot.bot_id);
  assert.equal(service.getBot(bot.bot_id).state, 'UNBOUND');
  assert.throws(() => service.createTask({ mission_id: bot.mission_id, gap: 'The Mission still lacks this late boundary observation', priority: 'medium', summary: 'Late proposal must be rejected at the write boundary', expected_output: 'Note', acceptance_conditions: ['Note'] }, makeEnvelope({ actorRef: bot.bot_id })), /hard deadline elapsed/);
});

test('trusted Runtime activation rechecks the Bot deadline inside the Task write transaction', t => {
  const { service, start } = fixture(t);
  const bot = start('bot:activate-expired');
  service.recordBotSandbox(bot.bot_id, { provider: 'controlled', sandboxId: 'sandbox:activate-expired' });
  service.markBotReady(bot.bot_id);
  const task = service.createTask({ mission_id: bot.mission_id, gap: 'The Mission needs evidence that expired activation is denied', priority: 'medium', summary: 'Verify the activation write boundary', expected_output: 'Note', acceptance_conditions: ['Note'] }, makeEnvelope({ actorRef: bot.bot_id })).task;
  const { execution } = service.takeTask(task.task_id, { owner_ref: bot.bot_id, core_id: bot.core_id, take_key: 'expired-activation' });
  service.db.prepare('UPDATE bots SET hard_deadline = ? WHERE bot_id = ?').run(new Date(Date.now() - 1).toISOString(), bot.bot_id);
  assert.throws(() => service.dispatch('start_execution', {}, makeEnvelope({ actorRef: 'runtime:trusted', taskId: task.task_id, executionId: execution.execution_id,
    specVersion: execution.spec_version, stateVersion: execution.state_version, fencingVersion: execution.fencing_version })), /hard deadline elapsed/);
  assert.equal(service.getExecution(execution.execution_id).state, 'CREATED');
});

test('a queued Runtime heartbeat cannot renew a registered Bot lease after expiry before sweep', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { service, start } = fixture(t);
  const bot = start('bot:late-heartbeat');
  service.recordBotSandbox(bot.bot_id, { provider: 'controlled', sandboxId: 'sandbox:late-heartbeat' });
  service.markBotReady(bot.bot_id);
  const task = service.createTask({ mission_id: bot.mission_id, gap: 'The Mission needs evidence that expired heartbeats cannot renew leases', priority: 'medium', summary: 'Observe delayed heartbeat admission',
    expected_output: 'Note', acceptance_conditions: ['Note'] }, makeEnvelope({ actorRef: bot.bot_id })).task;
  const { execution: preparing } = service.takeTask(task.task_id, { owner_ref: bot.bot_id, core_id: bot.core_id, take_key: 'late-heartbeat' });
  const envelope = (execution, actorRef = 'runtime:core-1') => makeEnvelope({ actorRef, taskId: execution.task_id,
    executionId: execution.execution_id, specVersion: execution.spec_version, stateVersion: execution.state_version,
    fencingVersion: execution.fencing_version });
  const { execution } = service.dispatch('start_execution', {}, envelope(preparing, bot.bot_id));
  const freshLease = new Date(Date.now() + 50).toISOString();
  const { execution: renewed } = service.dispatch('heartbeat', { lease_expires_at: freshLease }, envelope(execution));
  assert.equal(renewed.lease_expires_at, freshLease);

  // Advance clocks past the lease without running sweep or closing the Bot.
  // A due heartbeat can get the first callback after an event-loop stall.
  t.mock.timers.setTime(Date.parse(freshLease) + 1);
  assert.equal(service.getBot(bot.bot_id).state, 'ACTIVE');
  assert.equal(service.getExecution(execution.execution_id).state, 'RUNNING');
  assert.throws(() => service.dispatch('heartbeat', {}, envelope(renewed)),
    error => error.code === 'NOT_ALLOWED' && /Execution lease has expired/.test(error.message));
  assert.deepEqual(service.getExecution(execution.execution_id), renewed);
});

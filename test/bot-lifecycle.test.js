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
  const create = (id) => service.createTask({ mission_id: bot.mission_id, task_id: id, summary: `Investigate local question ${id}`,
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
  const { service, start } = fixture(t);
  const bot = start('bot:no-work');
  service.recordBotSandbox(bot.bot_id, { provider: 'controlled', sandboxId: 'sandbox:no-work' });
  service.markBotReady(bot.bot_id);
  const request = makeEnvelope({ actorRef: bot.bot_id, operationId: 'bot:exit:first' });
  const accepted = service.dispatch('bot_exit', { reason: 'no-work' }, request);
  assert.equal(accepted.bot.state, 'CLOSING');
  assert.equal(accepted.bot.execution_id, null);
  assert.equal(service.listActiveExecutions().length, 0);
  assert.throws(() => start('bot:too-early'), (error) => error.code === 'CONFLICT');
  service.finalizeBotClose(bot.bot_id);
  assert.deepEqual(service.dispatch('bot_exit', { reason: 'no-work' }, request), accepted);
  assert.equal(service.getBot(bot.bot_id).exit_reason, 'no-work');
  assert.equal(start('bot:after-event').state, 'STARTING');
});

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
  const started = tasks.registerBot({ botId: 'core-returned-bot', missionId: 'mission:flat', legacySlotId: 'legacy-slot:1', selectionDeadline: deadline });
  assert.equal(started.core_id, 'legacy-slot:1');
  assert.throws(() => tasks.markBotReady(started.bot_id), { code: 'NOT_ALLOWED' });
  const ready = tasks.markCoreBotReady(started.bot_id);
  assert.equal(ready.bot_id, 'core-returned-bot');
  assert.equal(ready.state, 'UNBOUND');
  assert.equal(ready.sandbox_id, null);
  assert.equal(ready.provider, null);
  assert.equal(ready.sandbox_create_state, 'NOT_DISPATCHED');
  assert.deepEqual(tasks.markCoreBotReady(ready.bot_id), ready);
  assert.throws(() => tasks.registerBot({ botId: 'other', missionId: 'mission:flat', legacySlotId: 'legacy-slot:1', selectionDeadline: deadline }), { code: 'CONFLICT' });
  assert.throws(() => tasks.registerBot({ botId: 'mixed', missionId: 'mission:flat', coreId: 'old', legacySlotId: 'different', selectionDeadline: deadline }), { code: 'INVALID_CONTRACT' });
});

test('flat policy returns finite selection authority only for its trusted Runtime and unbound Bot', async t => {
  const { createFlatModelAccessPolicy } = await import('../src/environments/flat/model-access-policy.js');
  const tasks = fixture(t);
  const deadline = Date.now() + 60_000;
  tasks.registerBot({ botId: 'bot:selection', missionId: 'mission:flat', legacySlotId: 'slot', selectionDeadline: new Date(deadline - 1000).toISOString(), hardDeadline: new Date(deadline).toISOString() });
  const policy = createFlatModelAccessPolicy({ taskService: tasks, missionId: 'mission:flat', runtimeId: () => 'runtime:flat', deadline: () => deadline });
  const caller = { runtimeId: 'runtime:flat', botId: 'bot:selection', profile: 'readonly', model: 'default' };
  assert.equal(policy.authorize(caller), null);
  tasks.markCoreBotReady(caller.botId);
  assert.deepEqual(policy.authorize(caller), { phase: 'selection', deadlineAt: deadline - 1000 });
  assert.equal(policy.authorize({ ...caller, runtimeId: 'other' }), null);
  assert.equal(policy.authorize({ ...caller, botId: 'foreign' }), null);
  let calls = 0;
  assert.equal(policy.withCommit(() => { calls++; return 'committed'; }), 'committed');
  assert.equal(calls, 1);
  tasks.requestBotStop(caller.botId, 'host-stop');
  assert.equal(policy.authorize(caller), null);
});

test('trusted startup uses only Core returned Bot identity and keeps Runtime separate from legacy Slot', async t => {
  const { createFlatBotCoordinator } = await import('../src/environments/flat/bot-coordinator.js');
  const tasks = fixture(t);
  const requests = [];
  const runtime = { id: 'runtime:host', async spawn(options) { requests.push(options); return { id: 'core:actual', profile: 'readonly', status: 'idle' }; },
    async stop() { throw new Error('Unexpected cleanup'); } };
  const coordinator = createFlatBotCoordinator({ runtime, taskService: tasks, missionId: 'mission:flat' });
  const options = { requestId: 'spawn:1', profile: 'readonly', legacySlotId: 'legacy:1', selectionDeadline: new Date(Date.now() + 30_000).toISOString() };
  const bot = await coordinator.spawn(options);
  assert.equal(bot.id, 'core:actual');
  assert.equal(tasks.getBot(bot.id).state, 'UNBOUND');
  assert.equal(tasks.getBot(bot.id).core_id, 'legacy:1');
  assert.equal(tasks.getBot(runtime.id), null);
  assert.deepEqual(requests, [{ requestId: 'spawn:1', profile: 'readonly' }]);
  assert.deepEqual(await coordinator.spawn(options), bot);
  assert.equal(requests.length, 1);
  await assert.rejects(coordinator.spawn({ ...options, legacySlotId: runtime.id }), { code: 'INVALID_CONTRACT' });
});

function executionEnvelope(execution, actorRef = execution.owner_ref) {
  return makeEnvelope({ actorRef, taskId: execution.task_id, executionId: execution.execution_id,
    specVersion: execution.spec_version, stateVersion: execution.state_version, fencingVersion: execution.fencing_version });
}

test('real Task state maps work and closeout to the current Execution fence and renewed lease', async t => {
  const { createFlatModelAccessPolicy } = await import('../src/environments/flat/model-access-policy.js');
  const tasks = fixture(t);
  const deadlineAt = Date.now() + 60_000;
  for (const botId of ['owner', 'other']) {
    tasks.registerBot({ botId, missionId: 'mission:flat', legacySlotId: `slot:${botId}`, selectionDeadline: new Date(deadlineAt).toISOString() });
    tasks.markCoreBotReady(botId);
  }
  const task = tasks.createTask({ mission_id: 'mission:flat', gap: 'Check that model authority follows its actual Execution owner', priority: 'medium', summary: 'Model Execution ownership', expected_output: 'Verified boundary', acceptance_conditions: ['Ownership checked'] }, makeEnvelope({ actorRef: 'owner' })).task;
  const { execution: preparing } = tasks.takeTask(task.task_id, { owner_ref: 'owner', core_id: 'slot:owner', take_key: 'take' });
  const policy = createFlatModelAccessPolicy({ taskService: tasks, missionId: 'mission:flat', runtimeId: 'r', deadline: () => deadlineAt, closeoutDeadline: () => deadlineAt - 1000 });
  const caller = { runtimeId: 'r', botId: 'owner', profile: 'readonly', model: 'default', executionId: 'foreign' };
  assert.equal(policy.authorize(caller), null);
  let { execution } = tasks.dispatch('start_execution', {}, executionEnvelope(preparing));
  const permit = policy.authorize(caller);
  assert.equal(permit.phase, 'work');
  assert.deepEqual(permit.lease, { key: execution.execution_id, version: execution.fencing_version, expiresAt: Date.parse(execution.lease_expires_at) });
  const renewedUntil = new Date(Date.now() + 45_000).toISOString();
  ({ execution } = tasks.dispatch('heartbeat', { lease_expires_at: renewedUntil }, executionEnvelope(execution)));
  assert.equal(policy.authorize(caller).lease.expiresAt, Date.parse(renewedUntil));
  ({ execution } = tasks.dispatch('record_handoff_reminder', {}, executionEnvelope(execution)));
  assert.equal(policy.authorize(caller).phase, 'closeout');
  assert.ok(policy.authorize(caller).deadlineAt <= deadlineAt - 1000);
  // Caller-supplied Execution never upgrades the other Bot's selection permit.
  assert.equal(policy.authorize({ ...caller, botId: 'other', executionId: execution.execution_id }).phase, 'selection');
  tasks.requestBotStop('owner', 'host-stop', { terminalState: 'CANCELLED' });
  assert.equal(policy.authorize(caller), null);
});

test('selection deadline and Mission stop invalidate real Task state before cleanup timers run', async t => {
  const { createFlatModelAccessPolicy } = await import('../src/environments/flat/model-access-policy.js');
  const tasks = fixture(t);
  const start = Date.now();
  tasks.registerBot({ botId: 'b', missionId: 'mission:flat', legacySlotId: 'slot', selectionDeadline: new Date(start + 1000).toISOString(), hardDeadline: new Date(start + 2000).toISOString() });
  tasks.markCoreBotReady('b');
  const policy = createFlatModelAccessPolicy({ runtimeId: 'r', taskService: tasks, missionId: 'mission:flat', deadline: () => start + 3000 });
  const caller = { runtimeId: 'r', botId: 'b', profile: 'readonly', model: 'default' };
  assert.equal(policy.authorize(caller).deadlineAt, start + 1000);
  tasks.setMissionStopReader(() => true);
  assert.equal(policy.authorize(caller), null);
  tasks.setMissionStopReader(() => false);
  t.mock.timers.enable({ apis: ['Date'], now: start + 1000 });
  assert.equal(tasks.getBot('b').state, 'UNBOUND');
  assert.equal(policy.authorize(caller), null);
});

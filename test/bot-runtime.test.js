import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TaskService, fixedExecutionInputHash } from '../src/task/task-service.js';
import { Runtime } from '../src/runtime/runtime.js';
import { WorkspaceManager } from '../src/runtime/workspace-manager.js';
import { MissionWorkspace } from '../src/runtime/mission-workspace.js';
import { createMissionCoordination } from '../src/runtime/mission-coordination.js';
import { beginMissionCloseout, takeTaskWithAgent } from '../src/benchmark/putnam-runner.js';
import { IdentityTaskLoop } from '../src/runtime/identity-task-loop.js';
import { createOpenSandboxManager } from '../src/runtime/opensandbox-manager.js';
import { BOT_RESOURCES, BOT_PROTOCOL_VERSION, BOT_COMPACTION_MESSAGE } from '../src/agent/bot-contract.js';
import { makeEnvelope } from '../src/protocol/envelope.js';
import { stableStringify } from '../src/protocol/envelope.js';
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { ServicesBridge } from '../src/agent/services-bridge.js';
import { ContextService } from '../src/context/context-service.js';
import { createBuiltinServiceRegistry } from '../src/sdk/builtin-registry.js';
import { SwarmEnvError, ERROR_CODES } from '../src/errors.js';

async function fixture(t, runtimeOptions = {}, { persistent = false, acceptanceConditions = {}, mergeRequiredCheck = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'swarm-bot-'));
  const service = new TaskService(persistent ? join(root, 'state.sqlite') : ':memory:');
  service.createMission({ mission_id: 'mission:bots', goal: 'Inspect independent questions', acceptance_conditions: acceptanceConditions, merge_required_check: mergeRequiredCheck }, makeEnvelope({ actorRef: 'operator:test' }));
  const calls = [];
  let sandboxNumber = 0;
  const deletedSandboxes = new Set();
  const manager = createOpenSandboxManager({ lifecycleBaseUrl: 'http://provider.test', image: 'test:bot', waitForExecdReady: false,
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method });
      if (options.method === 'DELETE') { deletedSandboxes.add(url); return new Response('{}'); }
      if (options.method === 'GET' && deletedSandboxes.has(url)) return new Response('{}', { status: 404 });
      if (url.endsWith('/sandboxes')) return new Response(JSON.stringify({ id: `sandbox:${++sandboxNumber}` }), { status: 202 });
      if (url.includes('/endpoints/')) return new Response(JSON.stringify({ url: 'http://execd.test' }));
      if (url.endsWith('/start')) return new Response(JSON.stringify({ result: { contract: { version: BOT_PROTOCOL_VERSION, resources: BOT_RESOURCES } } }));
      if (url.includes('/project/')) {
        const input = JSON.parse(options.body);
        return new Response(JSON.stringify({ result: { state: url.endsWith('/prepare') ? 'PREPARED' : 'ACTIVE', execution_id: input.execution_id, binding_version: input.binding_version } }));
      }
      if (url.endsWith('/command')) return new Response('event: execution_complete\ndata: {"exit_code":0}\n\n');
      return new Response('{}');
    },
  });
  const missionWorkspace = new MissionWorkspace({ rootDir: join(root, 'default-public') });
  await missionWorkspace.create({ missionId: 'mission:bots', workspaceId: 'workspace-default', initialFiles: { 'input.txt': 'public project input' } });
  const runtime = new Runtime({ taskService: service, missionWorkspace, missionWorkspaceId: 'workspace-default', workspaceManager: new WorkspaceManager({ rootDir: root }), sandboxManager: manager, agentAdapter: {}, ...runtimeOptions });
  t.after(async () => { await runtime.missionSubmissionStore?.stop({ missionId: 'mission:bots' }); await runtime.shutdown(); service.close(); await rm(root, { recursive: true, force: true }); });
  const startSession = async ({ bot, onSandboxCreated }) => {
    const sandbox = await manager.ensureExecution({ executionId: bot.resource_key, botId: bot.bot_id, onCreated: onSandboxCreated });
    await manager.startAgent({ executionId: bot.resource_key, command: 'controlled-session', args: [] });
    const session = new EventEmitter();
    session.closed = false;
    session.waitForReady = async () => {};
    session.stop = async () => { session.closed = true; session.emit('close'); };
    return session;
  };
  return { root, service, runtime, manager, startSession, calls };
}

test('Runtime starts and cleans an unbound Bot without inventing an Execution', async (t) => {
  const { service, runtime, manager, startSession } = await fixture(t);
  const { bot, session } = await runtime.startBot({ missionId: 'mission:bots', coreId: 'core-1', selectionTimeoutMs: 60_000, startSession });
  assert.equal(bot.state, 'UNBOUND');
  assert.equal(runtime.getCoreStatus('core-1').bot_id, bot.bot_id);
  assert.equal(service.listActiveExecutions().length, 0);
  service.setMissionStopReader(id => id === bot.mission_id);
  const accepted = service.dispatch('bot_exit', { reason: 'no-work' }, makeEnvelope({ actorRef: bot.bot_id }));
  assert.equal(accepted.bot.execution_id, null);
  await runtime.releaseBot(bot.bot_id);
  assert.equal(session.closed, true);
  assert.equal(service.getBot(bot.bot_id).state, 'CLOSED');
  assert.equal(runtime.getCoreStatus('core-1').state, 'IDLE');
  assert.equal(manager.snapshot().executions.length, 0);
});

test('a quiet unfinished Mission discovers a new responsibility after all Tasks are done and final validation times out', async t => {
  const identity = { checker_ref: 'controlled', checker_version: '1', environment_ref: 'test' };
  const { service, runtime, startSession } = await fixture(t, { coordinationPermissions: ['mission_submit'] },
    { acceptanceConditions: { required_check: identity } });
  const context = new ContextService(':memory:', { taskService: service });
  t.after(() => context.close());
  const missionId = 'mission:bots';
  const coreId = 'core-1';
  const store = createMissionCoordination({ taskService: service, contextService: context, missionId,
    workspace: runtime.missionWorkspace, workspaceId: runtime.missionWorkspaceId,
    deadline: Date.now() + 60_000,
    checker: { identity, check: () => { throw new SwarmEnvError('SERVICE_TIMEOUT', 'controlled final-check timeout'); } },
  });
  runtime.missionSubmissionStore = store;
  const create = (summary, actorRef) => service.createTask({ mission_id: missionId, summary,
    expected_output: 'Reproducible result', acceptance_conditions: ['Evidence is published'] }, makeEnvelope({ actorRef })).task;
  const former = create('Check a completed responsibility', 'operator:test');
  const done = service.takeTask(former.task_id, { owner_ref: 'agent:earlier', core_id: 'core-earlier', take_key: 'earlier' }).execution;
  service.dispatch('task_finish', { outcome: 'done' }, makeEnvelope({ actorRef: done.owner_ref,
    taskId: done.task_id, executionId: done.execution_id, specVersion: done.spec_version,
    stateVersion: done.state_version, fencingVersion: done.fencing_version }));
  service.finalizeExecutionFinish(done.execution_id, { fencingVersion: done.fencing_version });
  assert.equal(service.getTask(former.task_id).state, 'DONE');

  const starter = () => runtime.startBot({ missionId, coreId, startSession });
  const first = await starter();
  const submission = await store.submit({ missionId, workspaceId: runtime.missionWorkspaceId,
    actorRef: first.bot.bot_id, materialIds: [], requestId: 'final-timeout' });
  await store.waitForIdle();
  assert.equal((await store.get({ missionId, submissionId: submission.submission_id })).state, 'timed_out');
  assert.equal((await runtime.missionWorkspace.get({ workspaceId: runtime.missionWorkspaceId })).frozen_submission_id, null);
  const retry = await store.submit({ missionId, workspaceId: runtime.missionWorkspaceId,
    actorRef: first.bot.bot_id, materialIds: [], requestId: 'same-snapshot' });
  assert.equal(retry.result.code, 'MISSION_RETRY_EXHAUSTED');

  let discoveries = 0, closedAt, proposed;
  const loop = new IdentityTaskLoop({ coreId, taskService: service, discoveryRetryMs: 50, idleBackoffMs: 10,
    takeTask: async ({ candidates }) => {
      assert.deepEqual(candidates, []);
      discoveries += 1;
      if (discoveries === 1) {
        // Model discovery ends by the trusted selector timeout. Do not emit or
        // inject any public-change notification to the Identity loop.
        service.requestBotStop(first.bot.bot_id, 'selection-budget');
        await runtime.releaseBot(first.bot.bot_id);
        closedAt = Date.now();
        return { no_work: true };
      }
      assert.ok(Date.now() - closedAt >= 45);
      assert.equal(first.session.closed, true);
      assert.equal(service.getBot(first.bot.bot_id).state, 'CLOSED');
      const second = await starter();
      assert.notEqual(second.bot.bot_id, first.bot.bot_id);
      assert.equal(second.bot.core_id, first.bot.core_id);
      proposed = create('Find a smaller proof that fits the final check budget', second.bot.bot_id);
      loop.stop();
      return { take_deferred: true };
    },
  });
  await loop.run({ maxTurns: 5 });
  assert.equal(discoveries, 2);
  assert.ok(proposed);
  assert.equal(service.getTask(former.task_id).state, 'DONE');
  assert.equal(service.listActiveExecutions().length, 0);
});

for (const boundary of ['accepted', 'stopped', 'deadline']) test(
  `discovery refuses to start a Bot after the ${boundary} boundary`, async t => {
    const { service, runtime } = await fixture(t);
    const mission = service.getMission('mission:bots');
    if (boundary === 'accepted') service.setMissionStopReader(() => true);
    const core = { runtime, stateRef: { mission, stopping: boundary === 'stopped',
      runDeadlineAt: boundary === 'deadline' ? Date.now() - 1 : Infinity } };
    assert.deepEqual(await takeTaskWithAgent(core, []), { take_deferred: true });
    assert.equal(runtime.getCoreStatus('core-1').state, 'IDLE');
  },
);

test('selection timeout closes an unbound Bot and releases no phantom Execution', async (t) => {
  const { service, runtime, startSession } = await fixture(t);
  const { bot } = await runtime.startBot({ missionId: 'mission:bots', coreId: 'core-1', selectionTimeoutMs: 30, startSession });
  await new Promise(resolve => setTimeout(resolve, 60));
  await runtime.releaseBot(bot.bot_id);
  assert.equal(service.getBot(bot.bot_id).state, 'CLOSED');
  assert.equal(service.getBot(bot.bot_id).exit_reason, 'selection-budget');
  assert.equal(service.listActiveExecutions().length, 0);
});

test('expired startup retains the Core until the late Session has been stopped', async (t) => {
  const { service, runtime, startSession } = await fixture(t);
  let resume;
  const gate = new Promise(resolve => { resume = resolve; });
  let botId;
  const starting = runtime.startBot({ missionId: 'mission:bots', coreId: 'core-1', selectionTimeoutMs: 30,
    startSession: async (options) => { botId = options.bot.bot_id; await gate; return startSession(options); },
  });
  const rejected = assert.rejects(starting, /stopped/);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(service.getBot(botId).state, 'CLOSING');
  await assert.rejects(runtime.startBot({ missionId: 'mission:bots', coreId: 'core-1', startSession }), /occupied/);
  await rejected;
  resume();
  await new Promise(resolve => setImmediate(resolve));
  await runtime.releaseBot(botId);
  assert.equal(service.getBot(botId).state, 'CLOSED');
  assert.equal(runtime.getCoreStatus('core-1').state, 'IDLE');
});

test('an unexpected unbound process exit ends the Bot instead of reviving its identity', async (t) => {
  const { service, runtime, startSession } = await fixture(t);
  const { bot, session } = await runtime.startBot({ missionId: 'mission:bots', coreId: 'core-1', startSession });
  session.closed = true;
  session.emit('close');
  await runtime.releaseBot(bot.bot_id);
  assert.equal(service.getBot(bot.bot_id).exit_reason, 'process-exited');
  assert.equal(service.getBot(bot.bot_id).state, 'CLOSED');
});

test('taken Bot keeps its original Sandbox and closes before a successor can use the Core', async (t) => {
  const { service, runtime, manager, startSession, calls } = await fixture(t);
  const { bot, session } = await runtime.startBot({ missionId: 'mission:bots', coreId: 'core-1', startSession });
  const task = service.createTask({ mission_id: bot.mission_id, summary: 'Inspect a local question', expected_output: 'Reusable note', acceptance_conditions: ['Question answered'] }, makeEnvelope({ actorRef: bot.bot_id })).task;
  const taken = service.takeTask(task.task_id, { owner_ref: bot.bot_id, core_id: bot.core_id, take_key: 'take:bound' });
  await runtime.bindAgentExecution(taken.execution.execution_id, session, { coreId: 'core-1', sendInitialPrompt: false });
  const execution = service.getExecution(taken.execution.execution_id);
  assert.equal(service.getBot(bot.bot_id).state, 'ACTIVE');
  assert.equal(manager.snapshot().executions.length, 1);
  assert.equal(calls.filter(call => call.method === 'POST' && call.url.endsWith('/sandboxes')).length, 1);
  await assert.rejects(runtime.restartSession(execution.execution_id), /cannot replace/);
  service.dispatch('task_finish', { outcome: 'incomplete' }, makeEnvelope({ actorRef: bot.bot_id, taskId: task.task_id, executionId: execution.execution_id,
    specVersion: execution.spec_version, stateVersion: execution.state_version, fencingVersion: execution.fencing_version }));
  await runtime.releaseExecution(execution.execution_id);
  assert.equal(service.getBot(bot.bot_id).state, 'CLOSED');
  assert.equal(session.closed, true);
  assert.equal(runtime.botBindings.size, 0);
  const next = await runtime.startBot({ missionId: 'mission:bots', coreId: 'core-1', startSession });
  assert.notEqual(next.bot.bot_id, bot.bot_id);
  assert.notEqual(next.bot.sandbox_id, bot.sandbox_id);
});

test('four Core Bots discover concurrently before any Task exists and can each propose and take work', async (t) => {
  const { service, runtime, startSession } = await fixture(t, { maxWorkers: 4 });
  let entered = 0;
  let release;
  const allStarted = new Promise(resolve => { release = resolve; });
  const bots = await Promise.all([1, 2, 3, 4].map(index => runtime.startBot({ missionId: 'mission:bots', coreId: `core-${index}`,
    startSession: async options => {
      entered += 1;
      if (entered === 4) release();
      await allStarted;
      assert.equal(service.listMissionTasks({ mission_id: 'mission:bots' }).length, 0);
      return startSession(options);
    },
  })));
  assert.equal(new Set(bots.map(({ bot }) => bot.bot_id)).size, 4);
  assert.equal(new Set(bots.map(({ bot }) => bot.sandbox_id)).size, 4);
  const taken = bots.map(({ bot }) => {
    const task = service.createTask({ mission_id: bot.mission_id, summary: `Independent question from ${bot.core_id}`, expected_output: 'Local result', acceptance_conditions: ['Question answered'] }, makeEnvelope({ actorRef: bot.bot_id })).task;
    return service.takeTask(task.task_id, { owner_ref: bot.bot_id, core_id: bot.core_id, take_key: `take:${bot.bot_id}` });
  });
  await Promise.all(taken.map(({ execution }, index) => runtime.bindAgentExecution(execution.execution_id, bots[index].session, { coreId: bots[index].bot.core_id, sendInitialPrompt: false })));
  assert.equal(runtime.getActiveProcessCount(), 4);
  assert.equal(service.listActiveExecutions().length, 4);
  assert.equal(service.listMissionTasks({ mission_id: 'mission:bots' }).length, 4);
});

test('four real CLI Bot paths propose then take with overlapping E ownership and stop before Core reuse', { timeout: 45000 }, async t => {
  const { service, runtime, manager, startSession } = await fixture(t, { maxWorkers: 4 });
  const context = new ContextService(service.db, { taskService: service });
  let started = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  const lanes = await Promise.all([1, 2, 3, 4].map(async index => {
    const coreId = `core-${index}`;
    let session, environment;
    const bridge = new ServicesBridge({ taskService: service, contextService: context, runtime, coreId,
      registry: createBuiltinServiceRegistry({ taskService: service, contextService: context, missionWorkspace: runtime.missionWorkspace }),
      onTake: result => runtime.bindAgentExecution(result.execution.execution_id, session, { coreId, sendInitialPrompt: false }),
    });
    await bridge.start(); t.after(() => bridge.stop());
    const startedBot = await runtime.startBot({ missionId: 'mission:bots', coreId, maxLifetimeMs: 60000, startSession: async input => {
      environment = bridge.startBotIdentity(input.bot.bot_id);
      started += 1; if (started === 4) release(); await barrier;
      session = await startSession(input); return session;
    } });
    const command = async (...args) => JSON.parse((await promisify(execFile)(process.execPath, ['scripts/swarm.mjs', ...args], {
      env: { PATH: process.env.PATH, ...environment }, timeout: 15000,
    })).stdout);
    return { index, coreId, bridge, session, bot: startedBot.bot, command };
  }));
  const initial = await Promise.all(lanes.map(lane => lane.command('task', 'list')));
  assert.ok(initial.every(page => page.tasks.length === 0));
  const proposals = await Promise.all(lanes.map(lane => lane.command('task', 'propose', '--summary', `Investigate the separate reproducible boundary for Core ${lane.index}`,
    '--expected-output', `An independently useful note for boundary ${lane.index}`, '--acceptance-conditions', '["Explain the boundary and evidence"]', '--request-id', `propose-${lane.index}`)));
  const takes = await Promise.all(lanes.map((lane, index) => lane.command('task', 'take', proposals[index].task.task_id, '--request-id', `take-${lane.index}`)));
  assert.equal(runtime.getActiveProcessCount(), 4);
  assert.equal(new Set(lanes.map(lane => service.getBot(lane.bot.bot_id).sandbox_id)).size, 4);
  assert.equal(new Set(takes.map(take => take.execution.execution_id)).size, 4);
  for (const [index, take] of takes.entries()) {
    assert.equal(take.execution.owner_ref, lanes[index].bot.bot_id);
    assert.equal(take.execution.task_id, proposals[index].task.task_id);
    assert.equal(service.getExecution(take.execution.execution_id).state, 'RUNNING');
  }
  const notes = await Promise.all(lanes.map(lane => lane.command('material', 'publish', '--content', `Controlled result for boundary ${lane.index}`, '--request-id', `note-${lane.index}`)));
  for (const [index, note] of notes.entries()) assert.equal(note.material.producer_execution_id, takes[index].execution.execution_id);
  await Promise.all(lanes.map(lane => lane.command('task', 'finish', '--outcome', 'incomplete', '--request-id', `finish-${lane.index}`)));
  assert.equal(runtime.getActiveProcessCount(), 0);
  assert.equal(manager.snapshot().executions.length, 0);
  for (const lane of lanes) {
    assert.equal(lane.session.closed, true);
    assert.equal(service.getBot(lane.bot.bot_id).state, 'CLOSED');
    assert.equal(runtime.getCoreStatus(lane.coreId).state, 'IDLE');
  }
  const successor = await runtime.startBot({ missionId: 'mission:bots', coreId: lanes[0].coreId, startSession });
  assert.ok(!lanes.some(lane => lane.bot.bot_id === successor.bot.bot_id));
  assert.ok(!lanes.some(lane => lane.session === successor.session));
  assert.equal(successor.bot.execution_id, null);
});

for (const cause of ['selection-budget', 'shutdown']) test(`startup ${cause} stops a visible Session even when readiness never settles`, async (t) => {
  const { service, runtime, startSession } = await fixture(t);
  let visible;
  let observed;
  const readyEntered = new Promise(resolve => { observed = resolve; });
  const starting = runtime.startBot({ missionId: 'mission:bots', coreId: 'core-1', selectionTimeoutMs: cause === 'shutdown' ? 60_000 : 40,
    startSession: async options => {
      visible = await startSession(options);
      visible.waitForReady = () => { observed(); return new Promise(() => {}); };
      return visible;
    },
  });
  const rejected = assert.rejects(starting, /stopped/);
  await readyEntered;
  if (cause === 'shutdown') await runtime.shutdown();
  else await new Promise(resolve => setTimeout(resolve, 70));
  await rejected;
  assert.equal(visible.closed, true);
  assert.equal(runtime.getCoreStatus('core-1').state, 'IDLE');
  assert.equal(service.db.prepare("SELECT state FROM bots").get().state, 'CLOSED');
});

test('pre-alias rollback stops the retained Bot Session and Sandbox', async (t) => {
  const { service, runtime, manager, startSession } = await fixture(t);
  const { bot, session } = await runtime.startBot({ missionId: 'mission:bots', coreId: 'core-1', startSession });
  const task = service.createTask({ mission_id: bot.mission_id, summary: 'Inspect one question while preparation is pending', expected_output: 'Note', acceptance_conditions: ['Reviewed'] }, makeEnvelope({ actorRef: bot.bot_id })).task;
  const { execution } = service.takeTask(task.task_id, { owner_ref: bot.bot_id, core_id: bot.core_id, take_key: 'take:pre-alias' });
  const foreign = { stop: async () => assert.fail('foreign Session must not become cleanup owner') };
  await assert.rejects(runtime.bindAgentExecution(execution.execution_id, foreign, { coreId: 'core-1' }), /original Bot/);
  await runtime.stopExecution(execution.execution_id, 'FAILED', 'prepare-rollback');
  assert.equal(session.closed, true);
  assert.equal(manager.snapshot().executions.length, 0);
  assert.equal(service.getBot(bot.bot_id).state, 'CLOSED');
  assert.equal(runtime.getCoreStatus('core-1').state, 'IDLE');
});

test('another owner cannot reserve a Task on the Core occupied by an unbound Bot', async (t) => {
  const { service, runtime, startSession } = await fixture(t);
  const { bot } = await runtime.startBot({ missionId: 'mission:bots', coreId: 'core-1', startSession });
  const task = service.createTask({ mission_id: bot.mission_id, summary: 'Inspect independent work on the occupied Core', expected_output: 'Note', acceptance_conditions: ['Reviewed'] }, makeEnvelope({ actorRef: bot.bot_id })).task;
  assert.throws(() => service.takeTask(task.task_id, { owner_ref: 'legacy:intruder', core_id: 'core-1', take_key: 'intruder' }), /another Bot/);
  assert.equal(service.listActiveExecutions().length, 0);
});

test('a Bot that closes during input preparation cannot become ACTIVE', async (t) => {
  const { service, runtime, manager, startSession } = await fixture(t);
  const { bot, session } = await runtime.startBot({ missionId: 'mission:bots', coreId: 'core-1', startSession });
  const task = service.createTask({ mission_id: bot.mission_id, summary: 'Inspect a question with delayed preparation', expected_output: 'Note', acceptance_conditions: ['Reviewed'] }, makeEnvelope({ actorRef: bot.bot_id })).task;
  const { execution } = service.takeTask(task.task_id, { owner_ref: bot.bot_id, core_id: bot.core_id, take_key: 'take:delayed' });
  let resume;
  let entered;
  const gate = new Promise(resolve => { resume = resolve; });
  const copying = new Promise(resolve => { entered = resolve; });
  const sync = manager.syncWorkspace.bind(manager);
  manager.syncWorkspace = async options => { entered(); await gate; return sync(options); };
  const binding = runtime.bindAgentExecution(execution.execution_id, session, { coreId: 'core-1', sendInitialPrompt: false });
  const rejected = assert.rejects(binding);
  await copying;
  session.closed = true;
  session.emit('close');
  await runtime.stopExecution(execution.execution_id, 'FAILED', 'process-exited');
  const successor = await runtime.startBot({ missionId: 'mission:bots', coreId: 'core-1', startSession });
  resume();
  await rejected;
  assert.notEqual(service.getExecution(execution.execution_id).state, 'RUNNING');
  assert.equal(service.getBot(bot.bot_id).state, 'CLOSED');
  assert.equal(manager.snapshot().executions.length, 1);
  assert.equal(runtime.getCoreStatus('core-1').bot_id, successor.bot.bot_id);
  assert.equal(runtime.getCoreStatus('core-1').state, 'DISCOVERING');
});

test('provider input-copy rejection fails preparation and cleans the original Bot resource', async (t) => {
  const { service, runtime, manager, startSession } = await fixture(t);
  const { bot, session } = await runtime.startBot({ missionId: 'mission:bots', coreId: 'core-1', startSession });
  const task = service.createTask({ mission_id: bot.mission_id, summary: 'Inspect one question with a rejected input copy', expected_output: 'Note', acceptance_conditions: ['Reviewed'] }, makeEnvelope({ actorRef: bot.bot_id })).task;
  const { execution } = service.takeTask(task.task_id, { owner_ref: bot.bot_id, core_id: bot.core_id, take_key: 'take:copy-failed' });
  const providerFetch = manager.fetch;
  manager.fetch = (url, options) => url.endsWith('/command')
    ? Promise.resolve(new Response('event: execution_complete\ndata: {"exit_code":1}\n\n')) : providerFetch(url, options);
  await assert.rejects(runtime.bindAgentExecution(execution.execution_id, session, { coreId: 'core-1', sendInitialPrompt: false }), /input copy failed/);
  assert.equal(session.closed, true);
  assert.equal(service.getBot(bot.bot_id).state, 'CLOSED');
  assert.equal(manager.snapshot().executions.length, 0);
  assert.notEqual(service.getExecution(execution.execution_id).state, 'RUNNING');
});

test('compaction limit closes a registered Bot instead of replacing Pi inside its Execution', async (t) => {
  const { service, runtime, startSession } = await fixture(t, { maxCompactions: 0 });
  const { bot, session } = await runtime.startBot({ missionId: 'mission:bots', coreId: 'core-1', startSession });
  const task = service.createTask({ mission_id: bot.mission_id, summary: 'Inspect the bounded compaction lifecycle', expected_output: 'Note', acceptance_conditions: ['Reviewed'] }, makeEnvelope({ actorRef: bot.bot_id })).task;
  const { execution } = service.takeTask(task.task_id, { owner_ref: bot.bot_id, core_id: bot.core_id, take_key: 'take:compact' });
  await runtime.bindAgentExecution(execution.execution_id, session, { coreId: 'core-1', sendInitialPrompt: false });
  session.emit('rpc', { type: 'compaction_start', reason: 'threshold' });
  await runtime.activeProcesses.get(execution.execution_id).rotationPromise;
  assert.equal(service.getBot(bot.bot_id).state, 'CLOSED');
  assert.equal(service.getExecution(execution.execution_id).state, 'HANDED_OFF');
  assert.equal(session.closed, true);
  assert.equal(runtime.getCoreStatus('core-1').state, 'IDLE');
});

test('preparing process exit retries a transient deletion failure without a bind caller', async (t) => {
  const { service, runtime, manager, startSession } = await fixture(t, { finishCleanupRetryMs: 10, maxFinishCleanupRetries: 2 });
  const { bot, session } = await runtime.startBot({ missionId: 'mission:bots', coreId: 'core-1', startSession });
  const task = service.createTask({ mission_id: bot.mission_id, summary: 'Inspect pre-alias process failure cleanup', expected_output: 'Note', acceptance_conditions: ['Reviewed'] }, makeEnvelope({ actorRef: bot.bot_id })).task;
  const { execution } = service.takeTask(task.task_id, { owner_ref: bot.bot_id, core_id: bot.core_id, take_key: 'take:retry' });
  const providerFetch = manager.fetch;
  let deletes = 0;
  let deleted;
  const removed = new Promise(resolve => { deleted = resolve; });
  manager.fetch = (url, options) => {
    if (options.method === 'DELETE') {
      deletes += 1;
      if (deletes === 1) return Promise.resolve(new Response('{}', { status: 503 }));
      deleted();
    }
    return providerFetch(url, options);
  };
  session.closed = true;
  session.emit('close');
  assert.equal(service.getBot(bot.bot_id).state, 'CLOSING');
  await removed;
  await runtime.stopExecution(execution.execution_id, 'FAILED', 'process-exited');
  assert.equal(deletes, 2);
  assert.equal(service.getBot(bot.bot_id).state, 'CLOSED');
  assert.equal(service.getExecution(execution.execution_id).state, 'FAILED');
  assert.equal(runtime.getCoreStatus('core-1').state, 'IDLE');
});

test('late factory Session is stopped even when it arrives inside a pending provider cleanup', async (t) => {
  const { service, runtime, manager, startSession } = await fixture(t);
  let allowSession;
  const sessionGate = new Promise(resolve => { allowSession = resolve; });
  let resourceReady;
  const resource = new Promise(resolve => { resourceReady = resolve; });
  let lateSession;
  const starting = runtime.startBot({ missionId: 'mission:bots', coreId: 'core-1', selectionTimeoutMs: 40,
    startSession: async options => {
      lateSession = await startSession(options);
      resourceReady();
      await sessionGate;
      return lateSession;
    },
  });
  const rejected = assert.rejects(starting, /stopped/);
  await resource;
  const providerFetch = manager.fetch;
  let remove;
  let deleting;
  const deletionGate = new Promise(resolve => { remove = resolve; });
  const deletionStarted = new Promise(resolve => { deleting = resolve; });
  manager.fetch = async (url, options) => {
    if (options.method === 'DELETE') { deleting(); await deletionGate; }
    return providerFetch(url, options);
  };
  await deletionStarted;
  allowSession();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lateSession.closed, false);
  remove();
  await rejected;
  assert.equal(lateSession.closed, true);
  assert.equal(service.db.prepare('SELECT state FROM bots').get().state, 'CLOSED');
  assert.equal(runtime.getCoreStatus('core-1').state, 'IDLE');
});

test('a new Bot finish cannot override a durable Runtime stop while provider deletion is pending', async (t) => {
  const { service, runtime, manager, startSession } = await fixture(t);
  const { bot, session } = await runtime.startBot({ missionId: 'mission:bots', coreId: 'core-1', startSession });
  const task = service.createTask({ mission_id: bot.mission_id, summary: 'Inspect competing terminal decisions safely', expected_output: 'Note', acceptance_conditions: ['Reviewed'] }, makeEnvelope({ actorRef: bot.bot_id })).task;
  const taken = service.takeTask(task.task_id, { owner_ref: bot.bot_id, core_id: bot.core_id, take_key: 'take:finish-race' });
  await runtime.bindAgentExecution(taken.execution.execution_id, session, { coreId: 'core-1', sendInitialPrompt: false });
  const execution = service.getExecution(taken.execution.execution_id);
  const providerFetch = manager.fetch;
  let remove;
  let deleting;
  const gate = new Promise(resolve => { remove = resolve; });
  const entered = new Promise(resolve => { deleting = resolve; });
  manager.fetch = async (url, options) => { if (options.method === 'DELETE') { deleting(); await gate; } return providerFetch(url, options); };
  const stopping = runtime.stopExecution(execution.execution_id, 'FAILED', 'operator-stop');
  await entered;
  try {
    assert.equal(service.getBot(bot.bot_id).state, 'CLOSING');
    assert.throws(() => service.dispatch('task_finish', { outcome: 'done' }, makeEnvelope({ actorRef: bot.bot_id, taskId: task.task_id, executionId: execution.execution_id,
      specVersion: execution.spec_version, stateVersion: execution.state_version, fencingVersion: execution.fencing_version })), /active Bot/);
    assert.equal(service.getExecutionFinish(execution.execution_id), null);
  } finally { remove(); }
  await stopping;
  assert.equal(service.getExecution(execution.execution_id).state, 'FAILED');
  assert.equal(service.getExecution(execution.execution_id).terminal_reason, 'operator-stop');
});

test('prepare rollback joins the original stop and preserves its terminal reason', async (t) => {
  const { service, runtime, manager, startSession } = await fixture(t);
  const { bot, session } = await runtime.startBot({ missionId: 'mission:bots', coreId: 'core-1', startSession });
  const task = service.createTask({ mission_id: bot.mission_id, summary: 'Inspect prepare rollback joining an existing stop', expected_output: 'Note', acceptance_conditions: ['Reviewed'] }, makeEnvelope({ actorRef: bot.bot_id })).task;
  const { execution } = service.takeTask(task.task_id, { owner_ref: bot.bot_id, core_id: bot.core_id, take_key: 'take:stop-race' });
  let copied;
  let resumeCopy;
  const entered = new Promise(resolve => { copied = resolve; });
  const copyGate = new Promise(resolve => { resumeCopy = resolve; });
  const sync = manager.syncWorkspace.bind(manager);
  let finishedCopy;
  const copyFinished = new Promise(resolve => { finishedCopy = resolve; });
  manager.syncWorkspace = async options => { copied(); await copyGate; const result = await sync(options); finishedCopy(); return result; };
  let allowStop;
  let stopEntered;
  let physicalStops = 0;
  const stopGate = new Promise(resolve => { allowStop = resolve; });
  const stoppingStarted = new Promise(resolve => { stopEntered = resolve; });
  session.stop = async () => { if (!session.closed) { physicalStops += 1; stopEntered(); await stopGate; session.closed = true; session.emit('close'); } };
  const binding = runtime.bindAgentExecution(execution.execution_id, session, { coreId: 'core-1', sendInitialPrompt: false });
  const rejected = assert.rejects(binding, /stopped during Task preparation/);
  await entered;
  const stopping = runtime.stopExecution(execution.execution_id, 'CANCELLED', 'explicit-user-stop');
  await stoppingStarted;
  resumeCopy();
  await copyFinished;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.getBot(bot.bot_id).state, 'CLOSING');
  allowStop();
  await Promise.all([rejected, stopping]);
  assert.equal(physicalStops, 1);
  assert.equal(service.getExecution(execution.execution_id).state, 'CANCELLED');
  assert.equal(service.getExecution(execution.execution_id).terminal_reason, 'explicit-user-stop');
});

test('Bot lifetime is fixed before take and caps the active Execution deadline', async t => {
  const { service, runtime, startSession } = await fixture(t, { executionTimeoutMs: 60_000, handoffReminderMs: 50_000 });
  const { bot, session } = await runtime.startBot({ missionId: 'mission:bots', coreId: 'core-1', maxLifetimeMs: 5000, startSession });
  const task = service.createTask({ mission_id: bot.mission_id, summary: 'Inspect a bounded independent research question', expected_output: 'Note', acceptance_conditions: ['Note written'], timebox_ms: 60_000 }, makeEnvelope({ actorRef: bot.bot_id })).task;
  const { execution } = service.takeTask(task.task_id, { owner_ref: bot.bot_id, core_id: bot.core_id, take_key: 'bounded-take' });
  await runtime.bindAgentExecution(execution.execution_id, session, { coreId: bot.core_id, sendInitialPrompt: false });
  assert.ok(Date.parse(service.getExecution(execution.execution_id).execution_deadline) <= Date.parse(bot.hard_deadline));
  await new Promise(resolve => setTimeout(resolve, Math.max(1, Date.parse(bot.hard_deadline) - Date.now() + 100)));
  await runtime.waitForExecutionRelease(execution.execution_id, { timeoutMs: 1_000 });
  assert.equal(service.getBot(bot.bot_id).state, 'CLOSED');
  assert.equal(session.closed, true);
  assert.equal(service.getExecution(execution.execution_id).terminal_reason, 'bot-lifetime-budget');
});

test('Bot lifetime stops a taken Bot even while Workspace preparation has not returned', async t => {
  const { service, runtime, startSession } = await fixture(t);
  const { bot, session } = await runtime.startBot({ missionId: 'mission:bots', coreId: 'core-1', selectionTimeoutMs: 60_000, maxLifetimeMs: 250, startSession });
  const task = service.createTask({ mission_id: bot.mission_id, summary: 'Prepare inputs for an independent research question', expected_output: 'Note', acceptance_conditions: ['Note'] }, makeEnvelope({ actorRef: bot.bot_id })).task;
  const { execution } = service.takeTask(task.task_id, { owner_ref: bot.bot_id, core_id: bot.core_id, take_key: 'prepare-budget' });
  const create = runtime.workspaceManager.createWorkspace.bind(runtime.workspaceManager);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  runtime.workspaceManager.createWorkspace = async options => { await gate; return create(options); };
  const binding = runtime.bindAgentExecution(execution.execution_id, session, { coreId: bot.core_id, sendInitialPrompt: false });
  const rejected = assert.rejects(binding);
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(session.closed, true);
  release();
  await rejected;
  assert.equal(service.getBot(bot.bot_id).state, 'CLOSED');
});

test('elapsed Mission deadline rejects Bot creation before a provider request', async t => {
  const { runtime, startSession, calls } = await fixture(t);
  runtime.setRunDeadline(Date.now() - 1);
  await assert.rejects(runtime.startBot({ missionId: 'mission:bots', coreId: 'core-1', startSession }), /deadline already elapsed/);
  assert.equal(calls.length, 0);
  for (const maxLifetimeMs of [0, -1, Infinity, 2_147_483_648]) {
    await assert.rejects(runtime.startBot({ missionId: 'mission:bots', coreId: 'core-1', maxLifetimeMs, startSession }), { code: 'INVALID_CONTRACT' });
  }
});

for (const boundary of ['task', 'bot']) test(`registered Bot ${boundary} timeout sweep uses hard stop without synthesizing a checkpoint`, async t => {
  const { service, runtime, startSession } = await fixture(t);
  const { bot, session } = await runtime.startBot({ missionId: 'mission:bots', coreId: 'core-1', maxLifetimeMs: 60_000, startSession });
  const task = service.createTask({ mission_id: bot.mission_id, summary: 'Inspect an independent deadline boundary', expected_output: 'Note', acceptance_conditions: ['Note'], timebox_ms: boundary === 'task' ? 30_000 : 120_000 }, makeEnvelope({ actorRef: bot.bot_id })).task;
  const { execution } = service.takeTask(task.task_id, { owner_ref: bot.bot_id, core_id: bot.core_id, take_key: `deadline:${boundary}` });
  await runtime.bindAgentExecution(execution.execution_id, session, { coreId: bot.core_id, sendInitialPrompt: false });
  runtime.workspaceManager.saveWorkspaceRevision = async () => assert.fail('hard stop must not create a new revision');
  runtime.workspaceManager.saveCheckpoint = async () => assert.fail('hard stop must not create a new checkpoint');
  runtime.sandboxManager.syncWorkspaceBack = async () => assert.fail('hard stop must not export unpersisted private data');
  const deadline = service.getExecution(execution.execution_id).execution_deadline;
  await runtime.sweepExecutionTimeouts(new Date(deadline));
  assert.equal(service.getBot(bot.bot_id).state, 'CLOSED');
  assert.equal(service.getExecution(execution.execution_id).terminal_reason, boundary === 'task' ? 'execution-timebox' : 'bot-lifetime-budget');
});

test('earlier Task hard deadline automatically stops a registered Bot without an external sweep', async t => {
  const { service, runtime, startSession } = await fixture(t);
  const { bot, session } = await runtime.startBot({ missionId: 'mission:bots', coreId: 'core-1', maxLifetimeMs: 60_000, startSession });
  const task = service.createTask({ mission_id: bot.mission_id, summary: 'Inspect a locally bounded question', expected_output: 'Note', acceptance_conditions: ['Note'], timebox_ms: 150 }, makeEnvelope({ actorRef: bot.bot_id })).task;
  const { execution } = service.takeTask(task.task_id, { owner_ref: bot.bot_id, core_id: bot.core_id, take_key: 'automatic-short-task' });
  await runtime.bindAgentExecution(execution.execution_id, session, { coreId: bot.core_id, sendInitialPrompt: false });
  await runtime.waitForExecutionRelease(execution.execution_id, { timeoutMs: 1_000 });
  assert.equal(session.closed, true);
  assert.equal(service.getBot(bot.bot_id).state, 'CLOSED');
  assert.equal(service.getExecution(execution.execution_id).terminal_reason, 'execution-timebox');
});


test('registered take pins the complete public tree even when main advances during preparation', async t => {
  const { root, service, runtime, startSession } = await fixture(t);
  const publicStore = new MissionWorkspace({ rootDir: join(root, 'public-repositories') });
  const files = Object.fromEntries([['README.md', 'Shared project description'], ['problem.lean', 'locked source'], ['config/settings.json', '{"setting":true}'], ['data/bytes.bin', Buffer.from([0, 255, 128])], ['.gitignore', 'scratch/\n'], ['__proto__', 'ordinary project data']]);
  await publicStore.create({ missionId: 'mission:bots', workspaceId: 'workspace-bots', initialFiles: files });
  runtime.missionWorkspace = publicStore;
  runtime.missionWorkspaceId = 'workspace-bots';
  const { bot, session } = await runtime.startBot({ missionId: 'mission:bots', coreId: 'core-1', startSession });
  const task = service.createTask({ mission_id: bot.mission_id, summary: 'Inspect the full shared project input', expected_output: 'Note', acceptance_conditions: ['Inputs inspected'] }, makeEnvelope({ actorRef: bot.bot_id })).task;
  const { execution } = service.takeTask(task.task_id, { owner_ref: bot.bot_id, core_id: bot.core_id, take_key: 'full-tree-input' });
  const create = runtime.workspaceManager.createWorkspace.bind(runtime.workspaceManager);
  runtime.workspaceManager.createWorkspace = async options => {
    const next = await publicStore.save({ workspaceId: 'workspace-bots', files: { ...files, 'later.txt': 'arrived after input resolution' } });
    await publicStore.merge({ workspaceId: 'workspace-bots', fromRevision: next.revision });
    return create(options);
  };
  const prepare = runtime.sandboxManager.prepareBotProject.bind(runtime.sandboxManager);
  const grant = runtime.sandboxManager.grantBotProject.bind(runtime.sandboxManager);
  const permissionOrder = [];
  runtime.sandboxManager.prepareBotProject = async input => {
    assert.equal(service.getBot(bot.bot_id).state, 'PREPARING');
    assert.equal(service.getExecution(execution.execution_id).state, 'CREATED');
    permissionOrder.push('prepare'); return prepare(input);
  };
  runtime.sandboxManager.grantBotProject = async input => {
    assert.equal(service.getBot(bot.bot_id).state, 'ACTIVE');
    assert.equal(service.getExecution(execution.execution_id).state, 'RUNNING');
    permissionOrder.push('grant'); return grant(input);
  };
  const { workspace } = await runtime.bindAgentExecution(execution.execution_id, session, { coreId: bot.core_id, sendInitialPrompt: false });
  const current = service.getExecution(execution.execution_id);
  assert.deepEqual(permissionOrder, ['prepare', 'grant']);
  assert.equal(current.workspace_input.revision, '0.1');
  assert.equal((await publicStore.get({ workspaceId: 'workspace-bots' })).main_revision, '0.3');
  assert.equal(current.workspace_input.git_commit, workspace.public_workspace_input.git_commit);
  assert.deepEqual(Object.keys(current.workspace_input.manifest).sort(), Object.keys(files).sort());
  for (const [path, content] of Object.entries(files)) assert.deepEqual(await readFile(join(workspace.workspace_ref, path)), Buffer.from(content));
  const names = await readdir(workspace.workspace_ref);
  for (const absent of ['later.txt', 'runtime-manifest.json', 'workspace-manifest.json', '.pi']) assert.equal(names.includes(absent), false);
  assert.throws(() => service.dispatch('save_workspace_revision', { workspace_ref: current.workspace_ref, workspace_revision: current.workspace_revision + 1,
    workspace_content_hash: 'next', workspace_input: { ...current.workspace_input, revision: '0.3' } }, makeEnvelope({ actorRef: 'runtime:test', taskId: task.task_id, executionId: current.execution_id,
      specVersion: current.spec_version, stateVersion: current.state_version, fencingVersion: current.fencing_version })), /immutable/);
  assert.equal(service.getExecution(execution.execution_id).workspace_input.revision, '0.1');
});

test('registered CLI take pins verified Material and warns when the trusted preview changes', async t => {
  const { service, runtime, startSession } = await fixture(t);
  const context = new ContextService(':memory:', { taskService: service });
  t.after(() => context.close());
  runtime.contextService = context;
  let session;
  const bridge = new ServicesBridge({ taskService: service, contextService: context, runtime, coreId: 'core-1',
    registry: createBuiltinServiceRegistry({ taskService: service, contextService: context, missionWorkspace: runtime.missionWorkspace }),
    onTake: async take => {
      const result = await runtime.bindAgentExecution(take.execution.execution_id, session, { coreId: 'core-1', sendInitialPrompt: false });
      take.execution = result.execution;
      take.workspace = result.workspace;
    } });
  await bridge.start();
  t.after(() => bridge.stop());
  let env;
  const { bot } = await runtime.startBot({ missionId: 'mission:bots', coreId: 'core-1', startSession: async input => {
    env = bridge.startBotIdentity(input.bot.bot_id);
    session = await startSession(input);
    return session;
  } });
  const workspaceId = runtime.missionWorkspaceId;
  runtime.recordBotWorkspacePreview({ botId: bot.bot_id, session, workspace: await runtime.missionWorkspace.get({ workspaceId }) });
  const saved = await runtime.missionWorkspace.save({ workspaceId, baseRevision: '0.1', files: { 'updated.txt': 'new main' } });
  const merged = await runtime.missionWorkspace.merge({ workspaceId, fromRevision: saved.revision });
  const writer = service.createTask({ mission_id: bot.mission_id, summary: 'Produce exact input for the independent Task', expected_output: 'Material', acceptance_conditions: ['Published'] }, makeEnvelope({ actorRef: 'operator:test' })).task;
  const producer = service.takeTask(writer.task_id, { owner_ref: 'diagnostic:producer', take_key: 'take-input-producer' }).execution;
  const material = context.dispatch('publish_material', { kind: 'fact', scope: 'mission', content: 'Immutable supporting note' },
    makeEnvelope({ actorRef: producer.owner_ref, taskId: producer.task_id, executionId: producer.execution_id,
      fencingVersion: producer.fencing_version, stateVersion: producer.state_version, specVersion: producer.spec_version })).material;
  const task = service.createTask({ mission_id: bot.mission_id, summary: 'Read the latest project and pinned input Material', expected_output: 'Independent note',
    acceptance_conditions: ['Uses fixed inputs'], input_material_refs: [material.material_id] }, makeEnvelope({ actorRef: bot.bot_id })).task;
  const command = async (...args) => JSON.parse((await promisify(execFile)(process.execPath, ['scripts/swarm.mjs', ...args], { env: { PATH: process.env.PATH, ...env }, timeout: 15_000 })).stdout);
  const take = () => command('task', 'take', task.task_id, '--input-material-refs', '[]', '--request-id', 'take-fixed-inputs');
  const result = await take();
  const actual = result.execution.workspace_input;
  assert.equal(actual.revision, merged.main_revision);
  assert.deepEqual(actual.preview, { workspace_id: workspaceId, revision: '0.1' });
  assert.equal(actual.preview_changed, true);
  assert.equal(actual.reread_required, true);
  assert.match(actual.reread_notice, /不同于预览 0.1.*请重读受影响内容/);
  assert.equal(result.execution.input_snapshot_hash, fixedExecutionInputHash(service.getTask(task.task_id), actual));
  assert.deepEqual(actual.preview_diff.changes.map(change => [change.path, change.change]), [['input.txt', 'deleted'], ['updated.txt', 'added']]);
  assert.deepEqual(actual.material_inputs, [{ material_id: material.material_id, version: material.version, content_hash: material.content_hash }]);
  assert.deepEqual(service.getExecution(result.execution.execution_id).workspace_input, actual);
  assert.deepEqual((await take()).execution.workspace_input, actual);
  assert.throws(() => context.readTakeMaterialInputs({ missionId: 'mission:wrong', materialIds: [material.material_id] }), { code: 'NOT_ALLOWED' });
  assert.throws(() => context.readTakeMaterialInputs({ missionId: bot.mission_id, materialIds: [{ material_id: material.material_id, content_hash: 'forged' }] }), { code: 'INVALID_CONTRACT' });
});

test('registered take fails closed when no authoritative Mission Workspace is wired', async t => {
  const { service, runtime, startSession } = await fixture(t);
  runtime.missionWorkspace = null;
  const { bot, session } = await runtime.startBot({ missionId: 'mission:bots', coreId: 'core-1', startSession });
  const task = service.createTask({ mission_id: bot.mission_id, summary: 'Try taking work without a trusted public input', expected_output: 'Note', acceptance_conditions: ['Note'] }, makeEnvelope({ actorRef: bot.bot_id })).task;
  const { execution } = service.takeTask(task.task_id, { owner_ref: bot.bot_id, core_id: bot.core_id, take_key: 'without-public-input' });
  await assert.rejects(runtime.bindAgentExecution(execution.execution_id, session, { sendInitialPrompt: false }), { code: 'SERVICE_NOT_READY' });
  assert.equal(service.getExecution(execution.execution_id).workspace_input, null);
  assert.equal(service.getBot(bot.bot_id).state, 'CLOSED');
});

test('a Task cannot materialize another Mission public Workspace', async t => {
  const { root, service, runtime, startSession } = await fixture(t);
  runtime.missionWorkspace = new MissionWorkspace({ rootDir: join(root, 'public-repositories') });
  runtime.missionWorkspaceId = null;
  await runtime.missionWorkspace.create({ missionId: 'mission:other', workspaceId: 'workspace-other', initialFiles: { 'other.txt': 'private to another Mission' } });
  const { bot, session } = await runtime.startBot({ missionId: 'mission:bots', coreId: 'core-1', startSession });
  const task = service.createTask({ mission_id: bot.mission_id, summary: 'Attempt a foreign project input', expected_output: 'Note', acceptance_conditions: ['Note'], workspace: { workspace_id: 'workspace-other' } }, makeEnvelope({ actorRef: bot.bot_id })).task;
  const { execution } = service.takeTask(task.task_id, { owner_ref: bot.bot_id, core_id: bot.core_id, take_key: 'foreign-input' });
  await assert.rejects(runtime.bindAgentExecution(execution.execution_id, session, { coreId: bot.core_id, sendInitialPrompt: false }), /must belong to the Bot Mission/);
  assert.equal(service.getExecution(execution.execution_id).workspace_input, null);
  assert.equal(service.getBot(bot.bot_id).state, 'CLOSED');
  assert.equal(session.closed, true);
});

test('a Task explicit public revision is used instead of the current main', async t => {
  const { root, service, runtime, startSession } = await fixture(t);
  runtime.missionWorkspace = new MissionWorkspace({ rootDir: join(root, 'public-repositories') });
  runtime.missionWorkspaceId = 'workspace-selected';
  await runtime.missionWorkspace.create({ missionId: 'mission:bots', workspaceId: 'workspace-selected', initialFiles: { 'input.txt': 'main' } });
  const saved = await runtime.missionWorkspace.save({ workspaceId: 'workspace-selected', files: { 'input.txt': 'selected saved revision' } });
  const { bot, session } = await runtime.startBot({ missionId: 'mission:bots', coreId: 'core-1', startSession });
  const task = service.createTask({ mission_id: bot.mission_id, summary: 'Inspect a specific public input revision', expected_output: 'Note', acceptance_conditions: ['Note'],
    workspace: { workspace_id: 'workspace-selected' }, base_revision: saved.revision }, makeEnvelope({ actorRef: bot.bot_id })).task;
  const { execution } = service.takeTask(task.task_id, { owner_ref: bot.bot_id, core_id: bot.core_id, take_key: 'selected-input' });
  const { workspace } = await runtime.bindAgentExecution(execution.execution_id, session, { coreId: bot.core_id, sendInitialPrompt: false });
  assert.equal(service.getExecution(execution.execution_id).workspace_input.revision, saved.revision);
  assert.equal(await readFile(join(workspace.workspace_ref, 'input.txt'), 'utf8'), 'selected saved revision');
});


test('a delayed project grant cannot return a successful binding after Bot stop', async t => {
  const { root, service, runtime, startSession } = await fixture(t);
  runtime.missionWorkspace = new MissionWorkspace({ rootDir: join(root, 'public-repositories') });
  runtime.missionWorkspaceId = 'workspace-late-grant';
  await runtime.missionWorkspace.create({ missionId: 'mission:bots', workspaceId: 'workspace-late-grant', initialFiles: { 'input.txt': 'input' } });
  const { bot, session } = await runtime.startBot({ missionId: 'mission:bots', coreId: 'core-1', startSession });
  const task = service.createTask({ mission_id: bot.mission_id, summary: 'Inspect a late permission transition', expected_output: 'Note', acceptance_conditions: ['Note'] }, makeEnvelope({ actorRef: bot.bot_id })).task;
  const { execution } = service.takeTask(task.task_id, { owner_ref: bot.bot_id, core_id: bot.core_id, take_key: 'late-grant' });
  let entered; let release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  runtime.sandboxManager.grantBotProject = async () => { entered(); await gate; return { state: 'ACTIVE' }; };
  const binding = runtime.bindAgentExecution(execution.execution_id, session, { coreId: bot.core_id, sendInitialPrompt: false });
  const rejected = assert.rejects(binding, /stopped during project grant/);
  await started;
  await runtime.stopExecution(execution.execution_id, 'FAILED', 'controlled-hard-stop');
  release(); await rejected;
  assert.equal(service.getBot(bot.bot_id).state, 'CLOSED');
  assert.equal(service.getExecution(execution.execution_id).terminal_reason, 'controlled-hard-stop');
  assert.equal(runtime.hasActiveExecution(execution.execution_id), false);
});


test('registered Bot compaction sends CLI guidance without saving the controller private tree', async t => {
  const { service, runtime, startSession } = await fixture(t, { maxCompactions: 3 });
  const { bot, session } = await runtime.startBot({ missionId: 'mission:bots', coreId: 'core-1', startSession });
  const task = service.createTask({ mission_id: bot.mission_id, summary: 'Inspect compaction without claiming file persistence', expected_output: 'Note', acceptance_conditions: ['Reviewed'] }, makeEnvelope({ actorRef: bot.bot_id })).task;
  const { execution } = service.takeTask(task.task_id, { owner_ref: bot.bot_id, core_id: bot.core_id, take_key: 'take:compact-message' });
  await runtime.bindAgentExecution(execution.execution_id, session, { coreId: bot.core_id, sendInitialPrompt: false });
  const before = service.getExecution(execution.execution_id);
  const messages = [];
  session.prompt = async message => { messages.push(message); };
  runtime.workspaceManager.saveWorkspaceRevision = async () => { throw new Error('compaction must not save private files'); };
  session.emit('rpc', { type: 'compaction_end', result: { tokensBefore: 1000, estimatedTokensAfter: 100 } });
  await runtime.activeProcesses.get(execution.execution_id).compactionCheckpointPromise;
  assert.deepEqual(messages, [BOT_COMPACTION_MESSAGE]);
  assert.equal(service.getExecution(execution.execution_id).workspace_revision, before.workspace_revision);
  assert.equal(service.getExecution(execution.execution_id).checkpoint_ref, before.checkpoint_ref);
});

async function workspaceFixture(t, options = {}) {
  const f = await fixture(t, options.runtimeOptions ?? {}, options);
  let session;
  let env;
  const context = new ContextService(f.service.db, { taskService: f.service });
  f.service.contextService = context;
  if (options.createMissionSubmissionStore) f.runtime.missionSubmissionStore = options.createMissionSubmissionStore({ ...f, context });
  const bridge = new ServicesBridge({ taskService: f.service, contextService: context, runtime: f.runtime, coreId: 'core-1',
    registry: createBuiltinServiceRegistry({ taskService: f.service, contextService: context, missionWorkspace: f.runtime.missionWorkspace, missionSubmissionStore: f.runtime.missionSubmissionStore, judgeService: options.createJudgeService?.(f.service) ?? options.judgeService }),
    onTake: result => f.runtime.bindAgentExecution(result.execution.execution_id, session, { coreId: 'core-1', sendInitialPrompt: false }) });
  await bridge.start();
  t.after(() => bridge.stop());
  const { bot } = await f.runtime.startBot({ missionId: 'mission:bots', coreId: 'core-1', startSession: async input => {
    env = bridge.startBotIdentity(input.bot.bot_id);
    session = await f.startSession(input);
    return session;
  } });
  const task = f.service.createTask({ mission_id: bot.mission_id, summary: 'Produce a reusable project artifact', expected_output: 'Public files', acceptance_conditions: ['Artifact saved'], completion_contract: options.completionContract ?? {} }, makeEnvelope({ actorRef: bot.bot_id })).task;
  await bridge.call({ operation: 'task_take', payload: { task_id: task.task_id }, operationId: 'workspace-take' });
  const execution = f.service.getExecution(bridge.executionId);
  const identity = { actorRef: bot.bot_id, taskId: task.task_id, executionId: execution.execution_id, fencingVersion: execution.fencing_version };
  const guest = { files: { 'input.txt': Buffer.from('public project input') }, captures: 0, before: null };
  f.manager.snapshotBotProject = async ({ executionId }) => {
    const current = f.service.getExecution(executionId);
    if (guest.held) throw new SwarmEnvError(ERROR_CODES.WORKSPACE_BUSY, 'controlled install hold');
    guest.captures += 1;
    await guest.before?.();
    const manifest = Object.fromEntries(Object.entries(guest.files).map(([path, bytes]) => [path, { bytes: bytes.length, content_hash: createHash('sha256').update(bytes).digest('hex') }]));
    return { state: 'ACTIVE', execution_id: current.execution_id, binding_version: current.fencing_version, manifest,
      files: Object.fromEntries(Object.entries(guest.files).map(([path, bytes]) => [path, bytes.toString('base64')])), content_hash: createHash('sha256').update(stableStringify(manifest)).digest('hex') };
  };
  guest.receipts = new Map();
  guest.installs = 0;
  guest.installHook = null;
  guest.confirmHook = null;
  f.manager.queryBotProjectInstall = async input => guest.receipts.get(input.request_id) ?? { execution_id: input.executionId,
    binding_version: f.service.getExecution(input.executionId).fencing_version, request_id: input.request_id, phase: 'not_found' };
  f.manager.installBotProject = async input => {
    guest.installs += 1;
    await guest.installHook?.(input);
    guest.files = Object.fromEntries(Object.entries(input.files).map(([path, value]) => [path, Buffer.from(value, 'base64')]));
    const receipt = { execution_id: input.executionId, binding_version: f.service.getExecution(input.executionId).fencing_version, request_id: input.request_id,
      phase: 'installed', content_hash: input.content_hash, fingerprint: createHash('sha256').update(stableStringify({ content_hash: input.content_hash, expected_content_hash: input.expected_content_hash })).digest('hex') };
    guest.receipts.set(input.request_id, receipt); guest.held = true;
    return receipt;
  };
  f.manager.confirmBotProjectInstall = async input => {
    await guest.confirmHook?.(input);
    const receipt = { ...guest.receipts.get(input.request_id), phase: 'committed' };
    guest.receipts.set(input.request_id, receipt); guest.held = false;
    return receipt;
  };
  const command = async (...args) => JSON.parse((await promisify(execFile)(process.execPath, ['scripts/swarm.mjs', ...args], { env: { PATH: process.env.PATH, ...env }, timeout: 15_000 })).stdout);
  const dispatch = (operation, requestId, input = {}) => f.runtime.dispatchExecutionWorkspace(operation, input, { ...identity, requestId });
  return { ...f, bot, bridge, execution, identity, guest, command, dispatch, context };
}

test('real CLI saves guest additions/deletions/binary files and chains immutable public revisions', async t => {
  const { runtime, command, dispatch, guest, execution, bridge } = await workspaceFixture(t);
  assert.equal((await command('workspace', 'status')).dirty, false);
  guest.files = { '2': Buffer.from([0, 255, 128]), '10': Buffer.from('ten'), 'nested/note.md': Buffer.from('first') };
  assert.deepEqual((await command('workspace', 'diff')).changed_paths, ['10', '2', 'input.txt', 'nested/note.md']);
  const saved = await command('workspace', 'save', '--request-id', 'save-one');
  assert.equal(saved.revision, '0.2');
  assert.deepEqual(saved.parents, ['0.1']);
  assert.equal((await command('workspace', 'view')).main_revision, '0.1');
  const exported = await runtime.missionWorkspace.exportRevision({ workspaceId: saved.workspace_id, revision: saved.revision });
  assert.deepEqual(exported.files['2'], Buffer.from([0, 255, 128]));
  assert.equal(exported.files['input.txt'], undefined);
  const captures = guest.captures;
  guest.files['nested/note.md'] = Buffer.from('second');
  assert.deepEqual(await command('workspace', 'save', '--request-id', 'save-one'), saved);
  assert.equal(guest.captures, captures);
  assert.equal((await command('workspace', 'status')).dirty, true);
  const next = await command('workspace', 'save', '--request-id', 'save-two');
  assert.deepEqual(next.parents, [saved.revision]);
  const status = await command('workspace', 'status');
  assert.equal(status.initial_revision, '0.1');
  assert.equal(status.last_saved_revision, next.revision);
  assert.equal(status.dirty, false);
  assert.equal((await command('workspace', 'history')).items.length, 1);
  const allHistory = await command('workspace', 'history', '--all');
  assert.equal(allHistory.items.length, 3);
  assert.equal(allHistory.items[0].reachable_from_main, false);
  assert.equal((await command('workspace', 'history', '--all', '--execution', execution.execution_id)).items.length, 2);
  assert.equal((await command('workspace', 'history', '--all', '--path', 'nested')).items.length, 2);
  const page = await command('workspace', 'history', '--all', '--limit', '1');
  assert.equal(page.items[0].revision, next.revision);
  assert.equal((await command('workspace', 'history', '--all', '--limit', '1', '--cursor', page.next_cursor)).items[0].revision, saved.revision);
  assert.equal(saved.source.execution_id, execution.execution_id);
  assert.equal(saved.source.task_id, execution.task_id);
  assert.equal(saved.content_hash, exported.content_hash);
  assert.equal((await command('workspace', 'read', 'nested/note.md', '--at', next.revision)).content, 'second');
  await assert.rejects(dispatch('status', 'save-one'), error => error.code === 'CONFLICT');
  await assert.rejects(bridge.call({ operation: 'workspace_save', payload: { files: { injected: 'bad' } } }), /cannot supply/);
  await assert.rejects(bridge.call({ operation: 'write_workspace_file', payload: { path: 'injected', content: 'bad' } }), /Legacy private/);
  assert.equal(runtime.taskService.getExecution(execution.execution_id).workspace_input.revision, '0.1');
});

test('snapshot busy errors replay identically and do not poison subsequent save or status', async t => {
  const { guest, dispatch } = await workspaceFixture(t);
  guest.before = () => { throw new SwarmEnvError(ERROR_CODES.WORKSPACE_BUSY, 'controlled writer busy'); };
  let initial;
  await assert.rejects(dispatch('save', 'busy'), error => { initial = { code: error.code, message: error.message, details: error.details }; return error.code === 'WORKSPACE_BUSY'; });
  const captures = guest.captures;
  guest.before = null;
  await assert.rejects(dispatch('save', 'busy'), error => { assert.deepEqual({ code: error.code, message: error.message, details: error.details }, initial); return true; });
  assert.equal(guest.captures, captures);
  assert.equal((await dispatch('status', 'status-after-busy')).dirty, false);
  assert.equal((await dispatch('save', 'fresh')).revision, '0.2');
});

test('snapshot finishing after E closes cannot publish a new revision', async t => {
  const { guest, service, dispatch, bot, runtime } = await workspaceFixture(t);
  guest.before = () => { service.requestBotStop(bot.bot_id, 'controlled-close', { terminalState: 'FAILED' }); };
  await assert.rejects(dispatch('save', 'close-first'), error => error.code === 'WORKSPACE_REQUEST_ABORTED');
  assert.equal((await runtime.missionWorkspace.listRevisions({ workspaceId: 'workspace-default' })).length, 1);
});

test('Git commit lost before SQL acknowledgement reconciles after E closes without recapturing', async t => {
  const { runtime, dispatch, service, bot, guest, execution } = await workspaceFixture(t);
  guest.files = { 'saved.txt': Buffer.from('persisted before close') };
  let faulted = false;
  runtime.missionWorkspace.repository.fault = point => { if (point === 'after_receipt' && !faulted) { faulted = true; throw new Error('controlled process loss after Git receipt'); } };
  await assert.rejects(dispatch('save', 'commit-first'), error => error.code === 'WORKSPACE_RESULT_UNKNOWN');
  assert.equal(service.db.prepare('SELECT phase FROM execution_workspace_requests WHERE request_id = ?').get('commit-first').phase, 'captured');
  runtime.missionWorkspace.repository.fault = null;
  guest.files = { 'different.txt': Buffer.from('must not recapture') };
  service.requestBotStop(bot.bot_id, 'controlled-close', { terminalState: 'FAILED' });
  await runtime.executionWorkspace.reconcile(execution.execution_id);
  const result = await dispatch('save', 'commit-first');
  assert.equal(result.revision, '0.2');
  assert.equal(guest.captures, 1);
  assert.equal((await runtime.missionWorkspace.read({ workspaceId: 'workspace-default', revision: result.revision, path: 'saved.txt' })).content, 'persisted before close');
  assert.equal(service.db.prepare('SELECT phase FROM execution_workspace_requests WHERE request_id = ?').get('commit-first').phase, 'done');
});

test('a captured save with a definitive Git rejection fails once without poisoning later requests', async t => {
  const { runtime, dispatch, guest, service } = await workspaceFixture(t);
  const importTree = runtime.missionWorkspace.repository.importTree.bind(runtime.missionWorkspace.repository);
  let reject = true;
  runtime.missionWorkspace.repository.importTree = async (...args) => {
    if (reject) { reject = false; throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'controlled publication rejection'); }
    return importTree(...args);
  };
  await assert.rejects(dispatch('save', 'rejected'), /controlled publication rejection/);
  assert.equal(service.db.prepare('SELECT phase FROM execution_workspace_requests WHERE request_id = ?').get('rejected').phase, 'failed');
  const captures = guest.captures;
  await assert.rejects(dispatch('save', 'rejected'), /controlled publication rejection/);
  assert.equal(guest.captures, captures);
  assert.equal((await dispatch('status', 'after-rejection')).dirty, false);
  assert.equal((await dispatch('save', 'new-request')).revision, '0.2');
});

test('unknown publication preserves captured bytes across coordinator replacement and changed guest files', async t => {
  const { runtime, dispatch, guest, service } = await workspaceFixture(t);
  const importTree = runtime.missionWorkspace.repository.importTree.bind(runtime.missionWorkspace.repository);
  let reject = true;
  runtime.missionWorkspace.repository.importTree = async (...args) => {
    if (reject) { reject = false; throw new Error('controlled transient import loss'); }
    return importTree(...args);
  };
  guest.files = { 'exact.txt': Buffer.from('captured') };
  await assert.rejects(dispatch('save', 'unknown'), /controlled transient import loss/);
  const { ExecutionWorkspace } = await import('../src/runtime/execution-workspace.js');
  runtime.executionWorkspace = new ExecutionWorkspace({ taskService: service, workspace: runtime.missionWorkspace, sandboxManager: runtime.sandboxManager, guard: runtime.executionWorkspace.guard });
  guest.files = { 'new.txt': Buffer.from('newer unsaved bytes') };
  // A different payload cannot complete the pending write as a side effect.
  await assert.rejects(dispatch('status', 'unknown'), error => error.code === 'CONFLICT');
  assert.equal((await runtime.missionWorkspace.listRevisions({ workspaceId: 'workspace-default' })).length, 1);
  const result = await dispatch('save', 'unknown');
  assert.equal(guest.captures, 1);
  assert.deepEqual(Object.keys(result.files), ['exact.txt']);
  assert.deepEqual((await dispatch('status', 'newer-status')).changed_paths, ['exact.txt', 'new.txt']);
});

test('Workspace contributions reject foreign identity, stale fence and closed Session before capture', async t => {
  const { runtime, identity, guest, service, bot, dispatch } = await workspaceFixture(t);
  const call = overrides => runtime.dispatchExecutionWorkspace('save', {}, { ...identity, requestId: 'unauthorized', ...overrides });
  await assert.rejects(call({ actorRef: 'bot:foreign' }), error => error.code === 'NOT_ALLOWED');
  await assert.rejects(call({ fencingVersion: identity.fencingVersion + 1 }), error => error.code === 'NOT_ALLOWED');
  const binding = runtime.botBindings.get(bot.bot_id);
  binding.session.closed = true;
  await assert.rejects(dispatch('save', 'closed-session'), error => error.code === 'NOT_ALLOWED');
  binding.session.closed = false;
  service.db.prepare('UPDATE bots SET hard_deadline = ? WHERE bot_id = ?').run(new Date(Date.now() - 1).toISOString(), bot.bot_id);
  await assert.rejects(dispatch('save', 'expired'), error => error.code === 'NOT_ALLOWED');
  assert.equal(guest.captures, 0);
});

test('post-Git SQLite acknowledgement failure returns unknown and replays the original save', async t => {
  const { service, dispatch, guest } = await workspaceFixture(t);
  service.db.exec("CREATE TRIGGER reject_save_ack BEFORE UPDATE ON execution_workspace_state BEGIN SELECT RAISE(ABORT, 'controlled SQL ack failure'); END;");
  await assert.rejects(dispatch('save', 'sql-ack'), error => error.code === 'WORKSPACE_RESULT_UNKNOWN' && error.retryable);
  service.db.exec('DROP TRIGGER reject_save_ack');
  guest.files = { later: Buffer.from('unsaved') };
  const result = await dispatch('save', 'sql-ack');
  assert.deepEqual(Object.keys(result.files), ['input.txt']);
  assert.equal(guest.captures, 1);
});

for (const method of ['stopExecution', 'fenceExecution']) test(`${method} retains Task ownership when pending save reconciliation fails`, async t => {
  const { service, runtime, execution, dispatch } = await workspaceFixture(t);
  await dispatch('save', 'before-stop');
  const reconcile = runtime.executionWorkspace.reconcile.bind(runtime.executionWorkspace);
  runtime.executionWorkspace.reconcile = async () => { throw new SwarmEnvError(ERROR_CODES.WORKSPACE_RECONCILIATION_REQUIRED, 'controlled unresolved receipt'); };
  await assert.rejects(runtime[method](execution.execution_id), error => error.code === 'WORKSPACE_RECONCILIATION_REQUIRED');
  assert.equal(service.getExecution(execution.execution_id).state, 'RUNNING');
  assert.equal(service.getTask(execution.task_id).state, 'RUNNING');
  runtime.executionWorkspace.reconcile = reconcile;
  await runtime[method](execution.execution_id);
  assert.notEqual(service.getExecution(execution.execution_id).state, 'RUNNING');
});

const closeFromAnotherProcess = async (root, botId) => promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
  import { TaskService } from './src/task/task-service.js';
  const service = new TaskService(process.argv[1]);
  service.requestBotStop(process.argv[2], 'external-close', { terminalState: 'FAILED' });
  service.close();
`, join(root, 'state.sqlite'), botId], { timeout: 10_000 });

test('another TaskService process closing before publication prevents the saved revision', async t => {
  const { root, bot, runtime, dispatch } = await workspaceFixture(t, { persistent: true });
  const importTree = runtime.missionWorkspace.repository.importTree.bind(runtime.missionWorkspace.repository);
  runtime.missionWorkspace.repository.importTree = async (...args) => {
    await closeFromAnotherProcess(root, bot.bot_id);
    return importTree(...args);
  };
  await assert.rejects(dispatch('save', 'external-close-first'), error => error.code === 'NOT_ALLOWED');
  assert.equal((await runtime.missionWorkspace.listRevisions({ workspaceId: 'workspace-default' })).length, 1);
});

test('SQLite publication lock excludes another process closing between final guard and Git commit', async t => {
  const { root, bot, runtime, dispatch } = await workspaceFixture(t, { persistent: true });
  let attempted = false;
  runtime.missionWorkspace.repository.fault = point => {
    if (point !== 'after_intent') return;
    attempted = true;
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      db.exec('PRAGMA busy_timeout = 40');
      try { db.exec('BEGIN IMMEDIATE'); console.log('incorrectly acquired'); db.exec('ROLLBACK'); }
      catch (error) { console.log(error.errcode === 5 ? 'blocked' : error.message); }
      db.close();
    `, join(root, 'state.sqlite')], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.trim(), 'blocked');
  };
  const result = await dispatch('save', 'publication-first');
  assert.equal(attempted, true);
  runtime.missionWorkspace.repository.fault = null;
  await closeFromAnotherProcess(root, bot.bot_id);
  assert.deepEqual(await dispatch('save', 'publication-first'), result);
});

test('lease expiry keeps its durable intent and Task owner until Workspace receipts reconcile', async t => {
  const { service, runtime, execution, bot } = await workspaceFixture(t);
  service.db.prepare('UPDATE executions SET lease_expires_at = ? WHERE execution_id = ?').run(new Date(Date.now() - 1000).toISOString(), execution.execution_id);
  const reconcile = runtime.executionWorkspace.reconcile.bind(runtime.executionWorkspace);
  runtime.executionWorkspace.reconcile = async () => { throw new SwarmEnvError(ERROR_CODES.WORKSPACE_RECONCILIATION_REQUIRED, 'controlled lease receipt failure'); };
  await assert.rejects(runtime.sweepExpired(), error => error.code === 'WORKSPACE_RECONCILIATION_REQUIRED');
  assert.equal(service.getBot(bot.bot_id).state, 'CLOSING');
  assert.equal(service.getBot(bot.bot_id).stop_terminal_state, 'EXPIRED');
  assert.equal(service.getTask(execution.task_id).state, 'RUNNING');
  assert.equal(service.listEligibleTasks().length, 0);
  runtime.executionWorkspace.reconcile = reconcile;
  await runtime.sweepExpired();
  assert.equal(service.getExecution(execution.execution_id).state, 'EXPIRED');
  assert.equal(service.getTask(execution.task_id).state, 'OPEN');
});

test('lease renewal before atomic expiry intent keeps the Bot active', async t => {
  const { service, runtime, execution, bot } = await workspaceFixture(t);
  const cutoff = new Date();
  const original = service.listActiveExecutions.bind(service);
  service.db.prepare('UPDATE executions SET lease_expires_at = ? WHERE execution_id = ?').run(new Date(cutoff.getTime() - 1000).toISOString(), execution.execution_id);
  service.listActiveExecutions = () => {
    const rows = original();
    service.db.prepare('UPDATE executions SET lease_expires_at = ? WHERE execution_id = ?').run(new Date(cutoff.getTime() + 60_000).toISOString(), execution.execution_id);
    return rows;
  };
  assert.deepEqual(await runtime.sweepExpired(cutoff), []);
  assert.equal(service.getBot(bot.bot_id).state, 'ACTIVE');
  assert.equal(service.getExecution(execution.execution_id).state, 'RUNNING');
});

test('CLI apply retains both saved parents, requires saving dirty work and preserves the take origin', async t => {
  const { runtime, command, guest, execution } = await workspaceFixture(t);
  const incoming = await runtime.missionWorkspace.save({ workspaceId: 'workspace-default', baseRevision: '0.1', files: { 'input.txt': 'public project input', incoming: 'from peer' } });
  guest.files.local = Buffer.from('local saved contribution');
  await assert.rejects(command('workspace', 'apply', '--from', incoming.revision, '--request-id', 'dirty-apply'), error => {
    const failure = JSON.parse(error.stderr);
    assert.equal(failure.details.request_id, 'dirty-apply');
    assert.equal(failure.details.cause_code, 'WORKSPACE_BUSY');
    assert.match(failure.details.notice, /未替换文件/);
    return true;
  });
  assert.equal(guest.installs, 0);
  const local = await command('workspace', 'save', '--request-id', 'before-apply');
  const applied = await command('workspace', 'apply', '--from', incoming.revision, '--request-id', 'apply-clean');
  assert.deepEqual(applied.parents, [local.revision, incoming.revision]);
  assert.equal(guest.files.local.toString(), 'local saved contribution');
  assert.equal(guest.files.incoming.toString(), 'from peer');
  const status = await command('workspace', 'status');
  assert.equal(status.initial_revision, '0.1');
  assert.equal(status.dirty, true);
  assert.equal(status.applied_revisions[0].revision, incoming.revision);
  const saved = await command('workspace', 'save', '--request-id', 'after-apply');
  assert.deepEqual(saved.parents, applied.parents);
  guest.files.later = Buffer.from('later unsaved content');
  assert.deepEqual(await command('workspace', 'apply', '--from', incoming.revision, '--request-id', 'apply-clean'), applied);
  assert.equal(guest.installs, 1);
  assert.equal(guest.files.later.toString(), 'later unsaved content');
  assert.equal(runtime.taskService.getExecution(execution.execution_id).workspace_input.revision, '0.1');
});

test('apply conflict metadata survives save and a fresh E; resolved save checks real markers and alternatives', async t => {
  const { runtime, service, command, guest, execution, startSession, manager } = await workspaceFixture(t);
  const incoming = await runtime.missionWorkspace.save({ workspaceId: 'workspace-default', baseRevision: '0.1', files: { 'input.txt': 'incoming choice\n' } });
  guest.files['input.txt'] = Buffer.from('local choice\n');
  await command('workspace', 'save', '--request-id', 'local-conflict');
  const applied = await command('workspace', 'apply', '--from', incoming.revision, '--request-id', 'conflicting-apply');
  assert.ok(applied.conflicts.length);
  assert.match(applied.notice, /冲突文件为 input\.txt.*save --resolved/);
  const unresolved = await command('workspace', 'save', '--request-id', 'unresolved');
  assert.deepEqual(unresolved.conflicts, applied.conflicts);
  await runtime.stopExecution(execution.execution_id);
  const { bot, session } = await runtime.startBot({ missionId: 'mission:bots', coreId: 'core-1', startSession });
  const task = service.createTask({ mission_id: bot.mission_id, summary: 'Resolve recorded public Workspace conflicts', expected_output: 'Resolved revision', acceptance_conditions: ['Conflicts resolved'], workspace: { workspace_id: 'workspace-default', revision: unresolved.revision } }, makeEnvelope({ actorRef: bot.bot_id })).task;
  const take = service.takeTask(task.task_id, { owner_ref: bot.bot_id, core_id: bot.core_id, take_key: 'inherit-conflicts' });
  await runtime.bindAgentExecution(take.execution.execution_id, session, { coreId: 'core-1', sendInitialPrompt: false });
  const next = service.getExecution(take.execution.execution_id);
  guest.files = Object.fromEntries(Object.entries((await runtime.missionWorkspace.exportRevision({ workspaceId: 'workspace-default', revision: unresolved.revision })).files).map(([path, bytes]) => [path, Buffer.from(bytes)]));
  const call = (operation, requestId, input = {}) => runtime.dispatchExecutionWorkspace(operation, input, { actorRef: bot.bot_id, taskId: task.task_id, executionId: next.execution_id, fencingVersion: next.fencing_version, requestId });
  assert.deepEqual((await call('status', 'inherited')).conflicts, applied.conflicts);
  await assert.rejects(call('save', 'too-early', { resolved: true }), error => error.code === 'INVALID_CONTRACT');
  for (const path of Object.keys(guest.files)) if (applied.conflicts.some(conflict => path.startsWith(conflict.artifact_root + '/'))) delete guest.files[path];
  await assert.rejects(call('save', 'markers-remain', { resolved: true }), error => error.code === 'INVALID_CONTRACT');
  guest.files['input.txt'] = Buffer.from('chosen resolution\n');
  const resolved = await call('save', 'resolved', { resolved: true });
  assert.deepEqual(resolved.conflicts, []);
  assert.deepEqual((await runtime.missionWorkspace.exportRevision({ workspaceId: 'workspace-default', revision: resolved.revision })).conflicts, []);
});

test('install intent excludes Task finish until E lineage and worker acknowledgement are durable', async t => {
  const { runtime, service, guest, dispatch, execution, identity } = await workspaceFixture(t);
  const incoming = await runtime.missionWorkspace.save({ workspaceId: 'workspace-default', baseRevision: '0.1', files: { 'input.txt': 'public project input', peer: 'note' } });
  let rejected = false;
  guest.installHook = () => {
    assert.throws(() => service.dispatch('task_finish', { outcome: 'incomplete' }, makeEnvelope({ actorRef: identity.actorRef, taskId: execution.task_id, executionId: execution.execution_id,
      specVersion: execution.spec_version, stateVersion: execution.state_version, fencingVersion: execution.fencing_version })), error => error.code === 'WORKSPACE_BUSY');
    rejected = true;
  };
  await dispatch('apply', 'mutual-exclusion', { from: incoming.revision });
  assert.equal(rejected, true);
  const current = service.getExecution(execution.execution_id);
  const finished = service.dispatch('task_finish', { outcome: 'incomplete' }, makeEnvelope({ actorRef: identity.actorRef, taskId: execution.task_id, executionId: execution.execution_id,
    specVersion: current.spec_version, stateVersion: current.state_version, fencingVersion: current.fencing_version }));
  assert.equal(finished.execution.state, 'CLOSING');
});

test('Runtime reconciles lost apply acknowledgement without waiting for the paused Bot to retry', { timeout: 8000 }, async t => {
  const { runtime, guest, service, dispatch } = await workspaceFixture(t);
  const incoming = await runtime.missionWorkspace.save({ workspaceId: 'workspace-default', baseRevision: '0.1', files: { 'input.txt': 'public project input', peer: 'note' } });
  let fail = true;
  guest.confirmHook = () => { if (fail) { fail = false; throw new SwarmEnvError(ERROR_CODES.SERVICE_TIMEOUT, 'controlled acknowledgement loss'); } };
  await assert.rejects(dispatch('apply', 'lost-ack', { from: incoming.revision }), error => error.code === 'WORKSPACE_RESULT_UNKNOWN');
  assert.equal(guest.held, true);
  const until = Date.now() + 4000;
  while (guest.held && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(guest.held, false);
  assert.equal(guest.installs, 1);
  assert.equal(service.db.prepare('SELECT phase FROM execution_workspace_requests WHERE request_id = ?').get('lost-ack').phase, 'done');
  assert.equal((await dispatch('apply', 'lost-ack', { from: incoming.revision })).source_revision, incoming.revision);
});

test('confirmed apply survives response loss followed by hard close with the same terminal receipt', async t => {
  const { runtime, guest, manager, service, dispatch, execution } = await workspaceFixture(t);
  const incoming = await runtime.missionWorkspace.save({ workspaceId: 'workspace-default', baseRevision: '0.1', files: { 'input.txt': 'public project input', peer: 'note' } });
  const confirm = manager.confirmBotProjectInstall;
  let lose = true;
  manager.confirmBotProjectInstall = async input => {
    const receipt = await confirm(input);
    if (lose) { lose = false; throw new SwarmEnvError(ERROR_CODES.SERVICE_TIMEOUT, 'controlled response lost after resume'); }
    return receipt;
  };
  await assert.rejects(dispatch('apply', 'confirmed-before-close', { from: incoming.revision }), error => error.code === 'WORKSPACE_RESULT_UNKNOWN');
  const before = JSON.parse(service.db.prepare('SELECT result_json FROM execution_workspace_requests WHERE request_id = ?').get('confirmed-before-close').result_json);
  assert.equal(guest.held, false);
  await runtime.stopExecution(execution.execution_id);
  assert.deepEqual(await dispatch('apply', 'confirmed-before-close', { from: incoming.revision }), before);
  assert.equal(service.db.prepare('SELECT phase FROM execution_workspace_requests WHERE request_id = ?').get('confirmed-before-close').phase, 'done');
  assert.equal(guest.installs, 1);
});

test('apply installation stays held through SQL failure and Runtime retries only acknowledgement', { timeout: 30000 }, async t => {
  const { runtime, guest, service, dispatch } = await workspaceFixture(t);
  const incoming = await runtime.missionWorkspace.save({ workspaceId: 'workspace-default', baseRevision: '0.1', files: { 'input.txt': 'public project input', peer: 'note' } });
  service.db.exec("CREATE TRIGGER reject_apply_ack BEFORE UPDATE ON execution_workspace_state BEGIN SELECT RAISE(ABORT, 'controlled apply SQL failure'); END;");
  await assert.rejects(dispatch('apply', 'sql-apply', { from: incoming.revision }), error => error.code === 'WORKSPACE_RESULT_UNKNOWN');
  assert.equal(guest.held, true);
  service.db.exec('DROP TRIGGER reject_apply_ack');
  let entered, release;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const heldPromise = new Promise(resolve => { release = resolve; });
  const reconcile = runtime.executionWorkspace.reconcile.bind(runtime.executionWorkspace);
  runtime.executionWorkspace.reconcile = async (...args) => {
    entered();
    await heldPromise;
    return reconcile(...args);
  };
  await enteredPromise;
  let settled = false;
  const settling = runtime.waitForSettled().then(() => { settled = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
  } finally {
    release();
    await settling;
  }
  assert.equal(guest.held, false);
  assert.equal(guest.installs, 1);
  assert.equal((await dispatch('status', 'after-sql-apply')).applied_revisions[0].revision, incoming.revision);
});

for (const width of [1, 9]) test(`resolved save rejects actual ${width}-character Git markers`, async t => {
  const { runtime, guest, dispatch } = await workspaceFixture(t);
  guest.files['.gitattributes'] = Buffer.from(`input.txt conflict-marker-size=${width}\n`);
  guest.files['input.txt'] = Buffer.from('base\n');
  const base = await dispatch('save', 'marker-base');
  const incoming = await runtime.missionWorkspace.save({ workspaceId: 'workspace-default', baseRevision: base.revision, files: { '.gitattributes': guest.files['.gitattributes'], 'input.txt': 'incoming\n' } });
  guest.files['input.txt'] = Buffer.from('current\n');
  await dispatch('save', 'marker-current');
  const applied = await dispatch('apply', 'marker-apply', { from: incoming.revision });
  assert.ok(guest.files['input.txt'].toString().startsWith('<'.repeat(width) + ' '));
  for (const path of Object.keys(guest.files)) if (applied.conflicts.some(conflict => path.startsWith(conflict.artifact_root + '/'))) delete guest.files[path];
  await assert.rejects(dispatch('save', 'false-resolution', { resolved: true }), error => error.code === 'INVALID_CONTRACT');
  guest.files['input.txt'] = Buffer.from(guest.files['input.txt'].toString().split('\n').filter(line => !/^[<>]+ /.test(line)).join('\n'));
  await assert.rejects(dispatch('save', 'separator-remains', { resolved: true }), error => error.code === 'INVALID_CONTRACT' && /markers remain/.test(error.message));
  const saved = await dispatch('save', 'honest-unresolved');
  assert.equal(saved.conflicts.length, applied.conflicts.length);
});

test('closing intent alone does not discard a pending apply receipt while physical stop is outstanding', async t => {
  const { runtime, guest, manager, service, dispatch, execution, bot } = await workspaceFixture(t);
  const incoming = await runtime.missionWorkspace.save({ workspaceId: 'workspace-default', baseRevision: '0.1', files: { 'input.txt': 'public project input', peer: 'note' } });
  const confirm = manager.confirmBotProjectInstall;
  manager.confirmBotProjectInstall = async input => { await confirm(input); throw new SwarmEnvError(ERROR_CODES.SERVICE_TIMEOUT, 'lost confirmed response'); };
  await assert.rejects(dispatch('apply', 'close-query-race', { from: incoming.revision }), error => error.code === 'WORKSPACE_RESULT_UNKNOWN');
  service.requestBotStop(bot.bot_id, 'controlled in-flight close', { terminalState: 'FAILED' });
  const query = manager.queryBotProjectInstall;
  manager.queryBotProjectInstall = async () => { throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'physical stop is still collecting receipts'); };
  await assert.rejects(runtime.executionWorkspace.reconcile(execution.execution_id), error => error.code === 'WORKSPACE_RESULT_UNKNOWN');
  assert.equal(service.db.prepare('SELECT phase FROM execution_workspace_requests WHERE request_id = ?').get('close-query-race').phase, 'installed');
  manager.queryBotProjectInstall = query;
  await runtime.stopExecution(execution.execution_id);
  assert.equal(service.db.prepare('SELECT phase FROM execution_workspace_requests WHERE request_id = ?').get('close-query-race').phase, 'done');
  assert.equal(guest.installs, 1);
});

test('Task finish accepted before apply intent prevents any guest installation', async t => {
  const { runtime, guest, service, dispatch, execution, identity } = await workspaceFixture(t);
  const incoming = await runtime.missionWorkspace.save({ workspaceId: 'workspace-default', baseRevision: '0.1', files: { 'input.txt': 'public project input', peer: 'note' } });
  guest.before = () => service.dispatch('task_finish', { outcome: 'incomplete' }, makeEnvelope({ actorRef: identity.actorRef, taskId: execution.task_id, executionId: execution.execution_id,
    specVersion: execution.spec_version, stateVersion: execution.state_version, fencingVersion: execution.fencing_version }));
  await assert.rejects(dispatch('apply', 'finish-first', { from: incoming.revision }), error => error.code === 'WORKSPACE_REQUEST_ABORTED');
  assert.equal(guest.installs, 0);
  assert.equal((await runtime.missionWorkspace.listRevisions({ workspaceId: 'workspace-default' })).length, 2);
});

test('registered Judge CLI checks only a fixed public file and scopes durable results to its Mission', async t => {
  const { JudgeService } = await import('../src/judge/judge-service.js');
  const checked = [];
  let judge;
  const createJudgeService = service => (judge = new JudgeService(service.db, { taskService: service, fixtureManifest: { fixture_id: 'public-source', putnambench_commit: 'a'.repeat(40), problem_file: 'input.txt', problem_file_hash: 'b'.repeat(64), lean_toolchain: 'leanprover/lean4:v4.33.1', mathlib_version: 'test', checker_ref: 'lean', checker_version: 'test', environment_ref: 'test' }, checker: {
    preflight: async () => ({ status: 'healthy', checker_process_status: 'completed', evidence: { input_binding_verified: true, toolchain_version_verified: true, checker_version_verified: true } }),
    check: async input => { checked.push(input); return { verdict: 'PASS', evidence: { checker_started: true, exit_code: 0, private_internal_field: 'private checker stream', diagnostic: 'verified input' } }; },
  } }));
  const { runtime, command, dispatch, guest, bridge, service, bot } = await workspaceFixture(t, { createJudgeService });
  guest.files['proof.lean'] = Buffer.from('theorem local : True := by trivial');
  const saved = await dispatch('save', 'check-source-save');
  guest.files['proof.lean'] = Buffer.from('unsaved private edit');
  runtime.readWorkspaceFile = async () => { throw new Error('legacy host read must not occur'); };
  const current = service.getExecution(bridge.executionId);
  const legacyInput = { request_key: 'legacy-source-check', source: { workspace_id: 'workspace-default', revision: saved.revision, path: 'proof.lean', content: 'theorem local : True := by trivial' } };
  const legacyEnvelope = makeEnvelope({ actorRef: 'runtime:legacy', operationId: 'legacy-source-check', taskId: bridge.taskId, executionId: bridge.executionId, specVersion: current.spec_version, stateVersion: current.state_version });
  const legacy = await judge.checkWorkspaceSource(legacyInput, legacyEnvelope);
  assert.equal((await judge.checkWorkspaceSource(legacyInput, legacyEnvelope)).check_result_id, legacy.check_result_id);
  assert.equal(checked.length, 1);
  const result = await command('judge', 'check', '--at', saved.revision, '--path', 'proof.lean', '--request-id', 'public-source-check');
  assert.equal(result.verdict, 'PASS');
  assert.equal(checked.length, 2);
  assert.equal(checked[1].workspace_source.content, 'theorem local : True := by trivial');
  assert.equal(result.workspace_input.revision, saved.revision);
  assert.equal(result.workspace_input.git_tree, saved.git_tree);
  assert.equal(result.workspace_input.content_hash, createHash('sha256').update(checked[1].workspace_source.content).digest('hex'));
  assert.equal(result.evidence, undefined);
  assert.doesNotMatch(JSON.stringify(result), /private checker stream/);
  service.db.prepare('UPDATE executions SET state_version = state_version + 1 WHERE execution_id = ?').run(bridge.executionId);
  const replay = await command('judge', 'check', '--revision', saved.revision, '--path', 'proof.lean', '--request-id', 'public-source-check');
  assert.deepEqual(replay, result);
  assert.equal(checked.length, 2);
  const read = await command('judge', 'result', '--check-result-id', result.check_result_id);
  assert.equal(read.workspace_input.revision, saved.revision);
  assert.equal(read.diagnostic_excerpt, result.diagnostic_excerpt);
  for (const payload of [{ path: 'proof.lean' }, { revision: saved.revision, path: 'proof.lean', source: { content: 'forged' } }, { revision: 'main', path: 'proof.lean' }]) {
    await assert.rejects(bridge.call({ operation: 'workspace_check', payload }), { code: 'INVALID_CONTRACT' });
  }
  await assert.rejects(bridge.call({ operation: 'workspace_check', payload: { revision: saved.revision, path: 'proof.lean', workspace_id: 'other-mission' } }), { code: 'NOT_ALLOWED' });
  await assert.rejects(bridge.call({ operation: 'workspace_check', operation_id: 'public-source-check', payload: { revision: saved.revision, path: 'input.txt' } }), { code: 'CONFLICT' });
  assert.equal(checked.length, 2);
  guest.files['proof.lean'] = Buffer.from('theorem local : True := by trivial');
  guest.files['other.txt'] = Buffer.from('a changed surrounding tree');
  const later = await dispatch('save', 'check-later-tree');
  const laterResult = await command('judge', 'check', '--revision', later.revision, '--path', 'proof.lean', '--request-id', 'later-public-check');
  assert.equal(checked.length, 3);
  assert.equal(laterResult.workspace_input.revision, later.revision);
  assert.equal(laterResult.workspace_input.git_tree, later.git_tree);
  assert.notEqual(laterResult.check_result_id, result.check_result_id);
  const alias = await command('judge', 'check', '--revision', later.revision, '--path', 'proof.lean', '--request-id', 'public-check-alias');
  assert.equal(alias.check_result_id, laterResult.check_result_id);
  assert.equal(checked.length, 3);
  const aliasQuery = await command('judge', 'result', '--request-key', 'public-check-alias');
  assert.equal(aliasQuery.check_result_id, laterResult.check_result_id);
  await assert.rejects(bridge.call({ operation: 'workspace_check', operation_id: 'public-check-alias', payload: { revision: saved.revision, path: 'proof.lean' } }), { code: 'CONFLICT' });
  assert.equal(checked.length, 3);
  const foreignMission = service.createMission({ mission_id: 'foreign-judge', goal: 'Other research' }, makeEnvelope({ actorRef: 'operator:test' })).mission;
  const foreignTask = service.createTask({ mission_id: foreignMission.mission_id, summary: 'Investigate an unrelated responsibility', expected_output: 'Other result', acceptance_conditions: ['Other evidence'] }, makeEnvelope({ actorRef: 'operator:test' })).task;
  judge.db.prepare('UPDATE check_results SET target_task_id = ? WHERE check_result_id = ?').run(foreignTask.task_id, result.check_result_id);
  await assert.rejects(bridge.call({ operation: 'get_check_result', payload: { check_result_id: result.check_result_id } }), { code: 'NOT_ALLOWED' });
  judge.db.prepare('UPDATE check_results SET target_task_id = ? WHERE check_result_id = ?').run(bridge.taskId, result.check_result_id);
  const reader = service.registerBot({ missionId: bot.mission_id, coreId: 'core-2', selectionDeadline: new Date(Date.now() + 60000).toISOString() });
  const readerBridge = new ServicesBridge({ taskService: service, contextService: {}, runtime, coreId: 'core-2',
    registry: createBuiltinServiceRegistry({ taskService: service, judgeService: judge }) });
  await readerBridge.start(); t.after(() => readerBridge.stop());
  readerBridge.startBotIdentity(reader.bot_id);
  service.recordBotSandbox(reader.bot_id, { provider: 'controlled', sandboxId: 'reader-sandbox' }); service.markBotReady(reader.bot_id);
  const publicResult = await readerBridge.call({ operation: 'get_check_result', payload: { check_result_id: result.check_result_id } });
  assert.equal(publicResult.workspace_input.revision, saved.revision);
  assert.equal(service.getBot(reader.bot_id).execution_id, null);
  assert.equal(service.getBot(bot.bot_id).state, 'ACTIVE');
});


const mergeCheckerIdentity = { checker_ref: 'controlled-tree', checker_version: '1', environment_ref: 'network-disabled-test' };

test('registered CLI distinguishes a failed merge check from a changed main', async t => {
  let beforeResult;
  const { runtime, command, dispatch, guest } = await workspaceFixture(t, {
    mergeRequiredCheck: mergeCheckerIdentity,
    runtimeOptions: { workspaceMergeChecker: { identity: mergeCheckerIdentity, timeoutMs: 5000,
      async check() { return beforeResult ? beforeResult() : { verdict: 'FAIL' }; },
    } },
  });
  guest.files['addition.txt'] = Buffer.from('saved contribution');
  const saved = await dispatch('save', 'merge-feedback-source');
  await assert.rejects(command('workspace', 'merge', '--from', saved.revision, '--request-id', 'merge-scientific-fail'), error => {
    const result = JSON.parse(error.stderr);
    assert.equal(result.details.main_revision, '0.1');
    assert.equal(result.details.source_revision, saved.revision);
    assert.match(result.details.notice, /最终合成树未通过 1：FAIL/);
    return true;
  });
  const peer = await runtime.missionWorkspace.save({ workspaceId: 'workspace-default', baseRevision: '0.1',
    files: { 'input.txt': 'public project input', 'peer.txt': 'another contribution' } });
  beforeResult = async () => {
    await runtime.missionWorkspace.merge({ workspaceId: 'workspace-default', fromRevision: peer.revision });
    return { verdict: 'PASS' };
  };
  await assert.rejects(command('workspace', 'merge', '--from', saved.revision, '--request-id', 'merge-main-moved'), error => {
    const result = JSON.parse(error.stderr);
    assert.equal(result.code, 'MAIN_MOVED');
    assert.equal(result.details.observed_revision, '0.1');
    assert.match(result.details.notice, /检查后 main 已从 0\.1 前进到 .*本请求未覆盖 main/);
    return true;
  });
});

test('registered CLI merge checks the final combined public tree and preserves the private E worktree', async t => {
  const checked = [];
  const { runtime, command, dispatch, guest, execution } = await workspaceFixture(t, { mergeRequiredCheck: mergeCheckerIdentity, runtimeOptions: { workspaceMergeChecker: {
    identity: mergeCheckerIdentity, timeoutMs: 5000,
    async check(plan) { checked.push(plan); return { verdict: 'PASS', check_result_id: 'controlled-combined-tree' }; },
  } } });
  guest.files['local.txt'] = Buffer.from('local contribution');
  const source = await dispatch('save', 'merge-source');
  const peer = await runtime.missionWorkspace.save({ workspaceId: 'workspace-default', baseRevision: '0.1', files: { 'input.txt': 'public project input', 'peer.txt': 'peer contribution' } });
  await runtime.missionWorkspace.merge({ workspaceId: 'workspace-default', fromRevision: peer.revision, expectedMainRevision: '0.1' });
  const merged = await command('workspace', 'merge', '--from', source.revision, '--request-id', 'merge-public-source');
  assert.equal(checked.length, 1);
  assert.equal(String(checked[0].files['local.txt']), 'local contribution');
  assert.equal(String(checked[0].files['peer.txt']), 'peer contribution');
  assert.equal(merged.check.checked_tree, checked[0].tree);
  assert.deepEqual(merged.check.checker, mergeCheckerIdentity);
  const publicTree = await runtime.missionWorkspace.exportRevision({ workspaceId: 'workspace-default', revision: merged.main_revision });
  assert.equal(String(publicTree.files['peer.txt']), 'peer contribution');
  assert.equal(guest.files['peer.txt'], undefined);
  assert.equal((await dispatch('status', 'after-merge')).last_saved_revision, source.revision);
  guest.files['later.txt'] = Buffer.from('later private edit');
  assert.deepEqual(await command('workspace', 'merge', '--from', source.revision, '--request-id', 'merge-public-source'), merged);
  assert.equal(checked.length, 1);
  const included = await command('workspace', 'merge', '--from', source.revision, '--request-id', 'included-source');
  assert.equal(included.already_included, true);
  assert.equal(included.main_revision, merged.main_revision);
  assert.equal(checked.length, 1);
  const history = await runtime.missionWorkspace.history({ workspaceId: 'workspace-default', all: true, sourceExecution: execution.execution_id });
  assert.ok(history.items.some(revision => revision.revision === merged.main_revision));
});


for (const boundary of ['finish', 'freeze', 'freeze-released', 'soft-closeout']) test(`registered merge cannot advance main after ${boundary} wins during checking`, async t => {
  let entered, resume;
  const checking = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { resume = resolve; });
  const { runtime, service, dispatch, guest, identity, execution } = await workspaceFixture(t, { mergeRequiredCheck: mergeCheckerIdentity, runtimeOptions: { workspaceMergeChecker: {
    identity: mergeCheckerIdentity, timeoutMs: 10000,
    async check() { entered(); await gate; return { verdict: 'PASS', check_result_id: 'late-result' }; },
  } } });
  guest.files['addition.txt'] = Buffer.from('saved contribution');
  const saved = await dispatch('save', `merge-${boundary}-source`);
  const attempt = runtime.mergeExecutionWorkspace({ from: saved.revision }, { ...identity, requestId: `merge-${boundary}` });
  const rejected = assert.rejects(attempt, error => error.code === (boundary.startsWith('freeze') ? 'MISSION_SUBMITTING' : 'NOT_ALLOWED'));
  await checking;
  try {
    if (boundary.startsWith('freeze')) {
      await runtime.missionWorkspace.freeze({ workspaceId: 'workspace-default', submissionId: 'trusted-submit', expectedMainRevision: '0.1' });
      if (boundary === 'freeze-released') await runtime.missionWorkspace.unfreeze({ workspaceId: 'workspace-default', submissionId: 'trusted-submit' });
    }
    else {
      const current = service.getExecution(execution.execution_id);
      service.dispatch(boundary === 'finish' ? 'task_finish' : 'record_handoff_reminder', boundary === 'finish' ? { outcome: 'incomplete' } : { reminded_at: new Date().toISOString() },
        makeEnvelope({ actorRef: identity.actorRef, taskId: execution.task_id, executionId: execution.execution_id, specVersion: current.spec_version, stateVersion: current.state_version, fencingVersion: current.fencing_version }));
    }
  } finally { resume(); }
  await rejected;
  assert.equal((await runtime.missionWorkspace.get({ workspaceId: 'workspace-default' })).main_revision, '0.1');
  assert.equal((await runtime.missionWorkspace.listRevisions({ workspaceId: 'workspace-default' })).length, 2);
});

test('merge publication holds the cross-process lifecycle lock through its Git commit', async t => {
  const { root, runtime, identity, dispatch, guest } = await workspaceFixture(t, { persistent: true });
  guest.files['merge.txt'] = Buffer.from('public contribution');
  const saved = await dispatch('save', 'locked-merge-source');
  let attempted = false;
  runtime.missionWorkspace.repository.fault = point => {
    if (point !== 'after_intent') return;
    attempted = true;
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      db.exec('PRAGMA busy_timeout = 40');
      try { db.exec('BEGIN IMMEDIATE'); console.log('incorrectly acquired'); db.exec('ROLLBACK'); }
      catch (error) { console.log(error.errcode === 5 ? 'blocked' : error.message); }
      db.close();
    `, join(root, 'state.sqlite')], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.trim(), 'blocked');
  };
  const result = await runtime.mergeExecutionWorkspace({ from: saved.revision }, { ...identity, requestId: 'locked-merge' });
  runtime.missionWorkspace.repository.fault = null;
  assert.equal(attempted, true);
  assert.equal((await runtime.missionWorkspace.get({ workspaceId: 'workspace-default' })).main_revision, result.main_revision);
});

test('required merge checker cannot be bypassed by missing configuration or caller fields', async t => {
  const { runtime, identity, dispatch, guest } = await workspaceFixture(t, { mergeRequiredCheck: mergeCheckerIdentity });
  guest.files['new.txt'] = Buffer.from('needs a real check');
  const saved = await dispatch('save', 'unconfigured-check-source');
  const noop = await runtime.mergeExecutionWorkspace({ from: '0.1' }, { ...identity, requestId: 'unconfigured-noop' });
  assert.equal(noop.already_included, true);
  await assert.rejects(runtime.mergeExecutionWorkspace({ from: saved.revision }, { ...identity, requestId: 'unconfigured' }), { code: 'SERVICE_NOT_READY' });
  await assert.rejects(runtime.mergeExecutionWorkspace({ from: '0.1', checker: null }, { ...identity, requestId: 'forged-policy' }), { code: 'INVALID_CONTRACT' });
  assert.equal((await runtime.missionWorkspace.get({ workspaceId: 'workspace-default' })).main_revision, '0.1');
});

test('merge timeout rejects even if its abort handler resolves a late PASS, and replays without rechecking', async t => {
  let checks = 0;
  const { runtime, identity, dispatch, guest } = await workspaceFixture(t, { mergeRequiredCheck: mergeCheckerIdentity, runtimeOptions: { workspaceMergeChecker: {
    identity: mergeCheckerIdentity, timeoutMs: 30,
    check({ signal }) { checks += 1; return new Promise(resolve => signal.addEventListener('abort', () => resolve({ verdict: 'PASS' }), { once: true })); },
  } } });
  guest.files['addition.txt'] = Buffer.from('saved contribution');
  const saved = await dispatch('save', 'merge-timeout-source');
  const merge = () => runtime.mergeExecutionWorkspace({ from: saved.revision }, { ...identity, requestId: 'merge-timeout' });
  await assert.rejects(merge(), { code: 'SERVICE_TIMEOUT' });
  await assert.rejects(merge(), { code: 'SERVICE_TIMEOUT' });
  assert.equal(checks, 1);
  assert.equal((await runtime.missionWorkspace.get({ workspaceId: 'workspace-default' })).main_revision, '0.1');
});

for (const policy of ['task-done-only', 'conflicting', 'none']) test(`merge honors ${policy} Task and Mission check requirements`, async t => {
  let checks = 0;
  const { runtime, dispatch, guest, identity } = await workspaceFixture(t, {
    mergeRequiredCheck: policy === 'conflicting' ? { ...mergeCheckerIdentity, checker_version: 'other' } : null,
    completionContract: policy === 'none' ? {} : { required_check: mergeCheckerIdentity },
    runtimeOptions: { workspaceMergeChecker: { identity: mergeCheckerIdentity, timeoutMs: 5000,
      async check() { checks += 1; return { verdict: 'PASS' }; } } },
  });
  guest.files['policy.txt'] = Buffer.from('policy-bound contribution');
  const saved = await dispatch('save', `policy-${policy}`);
  const attempt = runtime.mergeExecutionWorkspace({ from: saved.revision }, { ...identity, requestId: `policy-${policy}` });
  if (policy === 'conflicting') {
    await assert.rejects(attempt, { code: 'SERVICE_NOT_READY' });
    assert.equal((await runtime.missionWorkspace.get({ workspaceId: 'workspace-default' })).main_revision, '0.1');
  } else {
    const result = await attempt;
    assert.equal(result.check, null);
  }
  assert.equal(checks, 0);
});

test('timed-out checker retains its slot until cleanup confirmation and cannot accumulate new checks', async t => {
  let checks = 0, release;
  const { runtime, identity, dispatch, guest } = await workspaceFixture(t, {
    mergeRequiredCheck: mergeCheckerIdentity,
    runtimeOptions: { workspaceMergeChecker: { identity: mergeCheckerIdentity, timeoutMs: 30,
      check() { checks += 1; return new Promise(resolve => { release = resolve; }); } } },
  });
  guest.files['quarantine.txt'] = Buffer.from('contribution');
  const saved = await dispatch('save', 'quarantine-source');
  const merge = requestId => runtime.mergeExecutionWorkspace({ from: saved.revision }, { ...identity, requestId });
  await assert.rejects(merge('first-hung-check'), { code: 'SERVICE_TIMEOUT' });
  await assert.rejects(merge('second-check-blocked'), { code: 'WORKSPACE_BUSY' });
  assert.equal(checks, 1);
  let shutdownDone = false;
  let runtimeSettled = false;
  const shutdown = runtime.shutdown().then(() => { shutdownDone = true; });
  const settling = runtime.waitForSettled().then(() => { runtimeSettled = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(shutdownDone, false);
    assert.equal(runtimeSettled, false);
  } finally {
    release({ verdict: 'PASS' });
    await Promise.all([shutdown, settling]);
  }
  assert.equal(runtime.activeWorkspaceCheck, null);
  assert.equal((await runtime.missionWorkspace.get({ workspaceId: 'workspace-default' })).main_revision, '0.1');
});

test('merge reports failed final-tree evidence with pinned revisions and bounded diagnostics', async t => {
  const { runtime, dispatch, guest, identity } = await workspaceFixture(t, {
    mergeRequiredCheck: mergeCheckerIdentity,
    runtimeOptions: { workspaceMergeChecker: { identity: mergeCheckerIdentity, timeoutMs: 5000,
      async check() { return { verdict: 'FAIL', check_result_id: 'failed-tree', diagnostic: 'x'.repeat(4096) }; } } },
  });
  guest.files['fails.txt'] = Buffer.from('invalid contribution');
  const saved = await dispatch('save', 'failed-tree-source');
  await assert.rejects(runtime.mergeExecutionWorkspace({ from: saved.revision }, { ...identity, requestId: 'failed-tree' }), error => {
    assert.equal(error.code, 'NOT_ALLOWED');
    assert.equal(error.details.main_revision, '0.1');
    assert.equal(error.details.source_revision, saved.revision);
    assert.equal(error.details.check.check_result_id, 'failed-tree');
    assert.equal(error.details.check.diagnostic.length, 2048);
    return true;
  });
});

test('Git merge publication survives SQLite confirmation failure and replays the same result', async t => {
  const { runtime, service, identity, dispatch, guest } = await workspaceFixture(t);
  guest.files['durable.txt'] = Buffer.from('durable contribution');
  const saved = await dispatch('save', 'durable-source');
  const exec = service.db.exec.bind(service.db);
  let failCommit = false;
  runtime.missionWorkspace.repository.fault = point => { if (point === 'after_intent') failCommit = true; };
  service.db.exec = sql => {
    if (sql === 'COMMIT' && failCommit) { failCommit = false; throw new Error('controlled SQLite commit failure'); }
    return exec(sql);
  };
  const merge = () => runtime.mergeExecutionWorkspace({ from: saved.revision }, { ...identity, requestId: 'durable-merge' });
  await assert.rejects(merge(), { code: 'WORKSPACE_RESULT_UNKNOWN' });
  runtime.missionWorkspace.repository.fault = null;
  service.db.exec = exec;
  const result = await merge();
  assert.equal((await runtime.missionWorkspace.get({ workspaceId: 'workspace-default' })).main_revision, result.main_revision);
  assert.equal((await runtime.missionWorkspace.listRevisions({ workspaceId: 'workspace-default' })).length, 3);
});

test('shutdown revokes and stops an active Bot before a different Core startup returns', { timeout: 15_000 }, async t => {
  const { service, runtime, startSession } = await fixture(t, { maxWorkers: 2 });
  const active = await runtime.startBot({ missionId: 'mission:bots', coreId: 'core-1', startSession });
  const task = service.createTask({ mission_id: 'mission:bots', summary: 'A bounded active responsibility', expected_output: 'Research note', acceptance_conditions: ['Readable'] }, makeEnvelope({ actorRef: active.bot.bot_id })).task;
  const take = service.takeTask(task.task_id, { owner_ref: active.bot.bot_id, core_id: 'core-1', take_key: 'shutdown-active' });
  await runtime.bindAgentExecution(take.execution.execution_id, active.session, { coreId: 'core-1', sendInitialPrompt: false });
  let entered, release, stopped;
  const entering = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const activeStopped = new Promise(resolve => { stopped = resolve; });
  const stop = active.session.stop;
  active.session.stop = async () => { await stop(); stopped(); };
  const starting = runtime.startBot({ missionId: 'mission:bots', coreId: 'core-2', startSession: async options => { entered(); await held; return startSession(options); } });
  const rejected = assert.rejects(starting, /stopp|clos|cancel/i);
  await entering;
  const shuttingDown = runtime.shutdown();
  try {
    assert.equal(service.getBot(active.bot.bot_id).state, 'CLOSING');
    assert.equal(service.getTask(task.task_id).state, 'RUNNING');
    assert.throws(() => service.createTask({ mission_id: 'mission:bots', summary: 'Investigate another independent responsibility after shutdown', expected_output: 'Result', acceptance_conditions: ['Readable'] }, makeEnvelope({ actorRef: active.bot.bot_id })), { code: 'NOT_ALLOWED' });
    await activeStopped;
  } finally { release(); }
  await rejected;
  const result = await shuttingDown;
  assert.equal(result.active_process_count, 0);
  assert.deepEqual(result.cleanup_pending_bot_ids, []);
});

test('Runtime shutdown rejects new Bot admission before persistence or provider allocation', async t => {
  const { service, runtime, manager, startSession, calls } = await fixture(t);
  await runtime.shutdown();
  assert.throws(() => runtime.startBot({ missionId: 'mission:bots', coreId: 'core-1', startSession }), { code: 'NOT_ALLOWED' });
  assert.equal(service.db.prepare('SELECT COUNT(*) AS count FROM bots').get().count, 0);
  assert.equal(manager.snapshot().executions.length, 0);
  assert.equal(calls.length, 0);
});

test('soft closeout allows real CLI save publish finish and receipt replay but rejects new apply before capture', async t => {
  const { service, execution, dispatch, command, guest } = await workspaceFixture(t);
  const saved = await dispatch('save', 'before-soft-save');
  const applied = await dispatch('apply', 'before-soft-apply', { from: saved.revision });
  service.db.prepare('UPDATE executions SET handoff_deadline = ? WHERE execution_id = ?').run(new Date(Date.now() - 1).toISOString(), execution.execution_id);
  const captures = guest.captures;
  assert.deepEqual(await dispatch('apply', 'before-soft-apply', { from: saved.revision }), applied);
  await assert.rejects(dispatch('apply', 'new-soft-apply', { from: saved.revision }), error => error.code === 'NOT_ALLOWED' && error.details.phase === 'soft_closeout');
  assert.equal(guest.captures, captures);
  guest.files['note.txt'] = Buffer.from('Existing result saved during closeout');
  assert.ok((await command('workspace', 'save', '--request-id', 'soft-save')).revision);
  assert.ok((await command('material', 'publish', '--content', 'Existing conclusion', '--request-id', 'soft-note')).material.material_id);
  const finish = await command('task', 'finish', '--outcome', 'incomplete', '--request-id', 'soft-finish');
  assert.match(finish.notice, /结束请求 soft-finish 已持久受理.*不得再 save\/publish/);
  assert.notEqual(service.getExecution(execution.execution_id).state, 'RUNNING');
});

test('apply snapshot crossing soft closeout cannot install newly selected input', async t => {
  const { service, execution, dispatch, guest } = await workspaceFixture(t);
  guest.before = async () => { service.db.prepare('UPDATE executions SET handoff_deadline = ? WHERE execution_id = ?').run(new Date(Date.now() - 1).toISOString(), execution.execution_id); };
  await assert.rejects(dispatch('apply', 'cross-soft', { from: 'main' }), error => error.code === 'WORKSPACE_REQUEST_ABORTED' && error.details.cause_code === 'NOT_ALLOWED');
  assert.equal(guest.installs, 0);
});

test('an apply already captured before soft closeout completes its original installation once', async t => {
  const { service, execution, runtime, dispatch, guest } = await workspaceFixture(t);
  const contribution = await runtime.missionWorkspace.save({ workspaceId: 'workspace-default', baseRevision: '0.1', requestId: 'incoming-soft', files: { 'input.txt': 'public project input', 'shared.txt': 'existing contribution' } });
  guest.installHook = async () => { service.db.prepare('UPDATE executions SET handoff_deadline = ? WHERE execution_id = ?').run(new Date(Date.now() - 1).toISOString(), execution.execution_id); };
  const result = await dispatch('apply', 'accepted-before-soft', { from: contribution.revision });
  assert.equal(guest.files['shared.txt'].toString(), 'existing contribution');
  assert.deepEqual(await dispatch('apply', 'accepted-before-soft', { from: contribution.revision }), result);
  assert.equal(guest.installs, 1);
});

test('actual Material CLI records correction CAS, separate disputes and revocation history', async t => {
  const { command } = await workspaceFixture(t);
  const a = (await command('material', 'publish', '--content', 'Original complete account', '--request-id', 'cli-a')).material;
  const b = (await command('material', 'publish', '--content', 'Complete replacement with counterexample', '--request-id', 'cli-b')).material;
  const observed = await command('material', 'view', a.material_id);
  assert.equal(observed.material.relation_version, 0);
  await command('material', 'dispute', a.material_id, '--claim', 'Boundary case', '--reason', 'Counterexample in the new note', '--request-id', 'cli-dispute');
  const replacement = await command('material', 'supersede', a.material_id, '--with', b.material_id, '--expected-version', '0', '--reason', 'Complete correction', '--request-id', 'cli-supersede');
  assert.equal(replacement.material.relation_version, 1);
  await assert.rejects(command('material', 'supersede', a.material_id, '--with', b.material_id, '--expected-version', '0', '--reason', 'Stale observed state', '--request-id', 'cli-stale'), error => /STALE_VERSION/.test(error.stderr));
  const reversed = await command('material', 'unsupersede', a.material_id, '--with', b.material_id, '--expected-version', '1', '--reason', 'Recheck the replacement', '--request-id', 'cli-revoke');
  assert.equal(reversed.relation_version, 2);
  assert.deepEqual(await command('material', 'unsupersede', a.material_id, '--with', b.material_id, '--expected-version', '1', '--reason', 'Recheck the replacement', '--request-id', 'cli-revoke'), reversed);
  const view = await command('material', 'view', a.material_id);
  assert.equal(view.disputed, true);
  assert.equal(view.active_successors.length, 0);
  assert.equal(view.correction_events.filter(e => e.action === 'revoked').length, 1);
});

test('independent contributions can merge before a failing Mission submission and after it unfreezes', async t => {
  let store;
  let checkerCalls = 0;
  let nextCheck, releaseSecond;
  const secondStarted = new Promise(resolve => { nextCheck = resolve; });
  const heldSecond = new Promise(resolve => { releaseSecond = resolve; });
  t.after(() => releaseSecond({ verdict: 'FAIL' }));
  const identity = { checker_ref: 'controlled-final-tree', checker_version: '1', environment_ref: 'local-test' };
  const checker = { identity, timeoutMs: 60_000, async check() {
    checkerCalls += 1;
    if (checkerCalls === 2) { nextCheck(); return heldSecond; }
    return { verdict: 'FAIL', check_result_id: 'unsolved-final' };
  } };
  const { command, dispatch, guest, runtime, service, execution } = await workspaceFixture(t, {
    persistent: true,
    acceptanceConditions: { required_check: identity },
    runtimeOptions: { coordinationPermissions: ['mission_submit'] },
    createMissionSubmissionStore: ({ service, runtime, context }) => {
      store = createMissionCoordination({ taskService: service, contextService: context, workspace: runtime.missionWorkspace,
        workspaceId: runtime.missionWorkspaceId, missionId: 'mission:bots', checker, deadline: Date.now() + 60_000 });
      return store;
    },
  });
  guest.files['independent.txt'] = Buffer.from('Public note while the Mission is unsolved');
  const saved = await dispatch('save', 'partial-contribution');
  const merge = await command('workspace', 'merge', '--from', saved.revision, '--request-id', 'merge-partial');
  assert.equal(merge.check, null);
  assert.equal(checkerCalls, 0);
  guest.files['followup.txt'] = Buffer.from('Another useful contribution');
  const followup = await dispatch('save', 'followup-contribution');
  const submit = await command('mission', 'submit', '--materials', '[]', '--request-id', 'check-unsolved');
  assert.equal(submit.main_revision, merge.main_revision);
  await store.waitForIdle();
  assert.equal(checkerCalls, 1);
  const settled = await command('mission', 'submission', 'view', submit.submission_id);
  assert.equal(settled.result.verdict, 'FAIL');
  assert.equal(settled.freeze_release_result, 'released');
  assert.equal(settled.current.merge_allowed, true);
  assert.match(settled.notice, /未通过不能记为成功/);
  const discovery = await command('mission', 'submission', 'view');
  assert.equal(discovery.state, 'open');
  assert.equal(discovery.current.main_revision, merge.main_revision);
  assert.equal(discovery.active_submission_id, null);
  const observed = discovery.submissions.find(row => row.submission_id === submit.submission_id);
  assert.equal(observed.state, 'failed');
  assert.equal(observed.main_revision, merge.main_revision);
  assert.equal((await runtime.missionWorkspace.get({ workspaceId: 'workspace-default' })).frozen_submission_id, null);
  const next = await command('workspace', 'merge', '--from', followup.revision, '--request-id', 'merge-after-unfreeze');
  assert.notEqual(next.main_revision, merge.main_revision);
  const second = await command('mission', 'submit', '--materials', '[]', '--request-id', 'check-new-main');
  await secondStarted;
  try {
    const old = await command('mission', 'submission', 'view', submit.submission_id);
    assert.equal(old.freeze_release_result, 'released');
    assert.equal(old.current.active_submission_id, second.submission_id);
    assert.equal(old.current.main_revision, next.main_revision);
    assert.equal(old.current.merge_allowed, false);
    assert.match(old.current.observed_at, /^\d{4}-/);
  } finally {
    releaseSecond({ verdict: 'FAIL' });
    await store.waitForIdle();
  }
  assert.equal(service.getExecution(execution.execution_id).state, 'RUNNING');
});

test('actual Mission CLI fixes current main and explicit empty Material selection under trusted checker authority', async t => {
  const identity = { checker_ref: 'controlled-final-tree', checker_version: '1', environment_ref: 'local-test' };
  let resolveCheck, store;
  const checker = { identity, timeoutMs: 60_000, check: () => new Promise(resolve => { resolveCheck = resolve; }) };
  const { command, service, bot, root } = await workspaceFixture(t, {
    persistent: true,
    acceptanceConditions: { required_check: identity },
    runtimeOptions: { coordinationPermissions: ['mission_submit'], workspaceMergeChecker: checker },
    createMissionSubmissionStore: ({ service, runtime, context }) => {
      store = createMissionCoordination({ taskService: service, contextService: context, workspace: runtime.missionWorkspace,
        workspaceId: runtime.missionWorkspaceId, missionId: 'mission:bots', checker, deadline: Date.now() + 60_000 });
      service.setMissionStopReader(id => store.isAccepted(id));
      return store;
    },
  });
  await assert.rejects(command('mission', 'submit', '--request-id', 'implicit-materials'), error => /explicit/.test(error.stderr));
  const submission = await command('mission', 'submit', '--materials', '[]', '--request-id', 'accepted-cli-snapshot');
  assert.equal(submission.state, 'pending');
  assert.deepEqual(submission.materials, []);
  assert.equal(submission.actor_ref, bot.bot_id);
  assert.equal(submission.main_revision, '0.1');
  assert.deepEqual(submission.checker, identity);
  await assert.rejects(command('mission', 'submit', '--materials', '[]', '--checker', 'caller-selected', '--request-id', 'forged-checker'), error => /INVALID_CONTRACT/.test(error.stderr));
  resolveCheck({ verdict: 'PASS', check_result_id: 'trusted-check' });
  await store.waitForIdle();
  const accepted = await command('mission', 'submission', 'view', submission.submission_id);
  assert.equal(accepted.state, 'accepted');
  assert.equal(accepted.result.check_result_id, 'trusted-check');
  const current = service.getExecution(submission.execution_id);
  const second = new TaskService(join(root, 'state.sqlite'));
  try {
    for (const connection of [service, second]) {
      assert.throws(() => connection.createTask({ mission_id: 'mission:bots', summary: 'Late new research after accepted Mission', expected_output: 'Note', acceptance_conditions: ['Evidence'] },
        makeEnvelope({ actorRef: bot.bot_id, taskId: current.task_id, executionId: current.execution_id, specVersion: current.spec_version, stateVersion: current.state_version, fencingVersion: current.fencing_version })), { code: 'NOT_ALLOWED' });
    }
  } finally { second.db.close(); }
});

test('actual Task CLI can retire an unowned responsibility and repair only its cancelled dependency', async t => {
  const { command } = await workspaceFixture(t, { runtimeOptions: { coordinationPermissions: ['task_cancel', 'task_dependency_replace'] } });
  const propose = async (summary, dependencies = []) => (await command('task', 'create', '--summary', summary,
    '--expected-output', 'A reusable account of the independent claim', '--acceptance-conditions', '["State evidence and limitations"]',
    '--depends-on', JSON.stringify(dependencies))).task;
  const old = await propose('Investigate the old prerequisite responsibility');
  const replacement = await propose('Investigate the corrected prerequisite responsibility');
  const other = await propose('Investigate another unaffected prerequisite responsibility');
  const dependent = await propose('Combine results after both prerequisites complete', [old.task_id, other.task_id]);
  const cancelled = await command('task', 'cancel', old.task_id, '--expected-spec-version', String(old.spec_version), '--expected-state-version', String(old.state_version),
    '--reason', 'The corrected responsibility supersedes this unowned proposal', '--replacement', replacement.task_id, '--request-id', 'cli-cancel-old');
  assert.equal(cancelled.task.state, 'CANCELLED');
  const view = await command('task', 'view', dependent.task_id);
  const repaired = await command('task', 'dependency-replace', dependent.task_id, '--from-task-id', old.task_id, '--to-task-id', replacement.task_id,
    '--expected-spec-version', String(view.task.spec_version), '--expected-state-version', String(view.task.state_version),
    '--reason', 'The replacement supplies the required result', '--request-id', 'cli-repair-edge');
  assert.deepEqual(repaired.task.relations.depends_on.map(r => r.related_task_id).sort(), [replacement.task_id, other.task_id].sort());
  assert.equal(repaired.task.relations.dependency_replacements.length, 1);
});

test('Mission acceptance gates new work but permits actual CLI save publish finish within bounded closeout', async t => {
  const { service, runtime, command, execution } = await workspaceFixture(t);
  let stopped = 0;
  const state = { taskService: service, missionId: 'mission:bots', missionCloseoutMs: 20_000, runDeadlineAt: Date.now() + 15_000,
    identityLoops: [{ stop: () => { stopped += 1; } }], controller: { stop: async () => { stopped += 1; } }, requestIdentityWake: () => {} };
  service.setMissionStopReader(() => true);
  beginMissionCloseout(state, { submission_id: 'accepted', actor_ref: execution.owner_ref, finished_at: new Date().toISOString() });
  await Promise.all(state.backgroundStopPromises);
  assert.equal(stopped, 2);
  assert.equal(state.missionCloseoutDeadline, state.runDeadlineAt);
  assert.ok(service.getExecution(execution.execution_id).handoff_reminder_sent_at);
  await assert.rejects(command('workspace', 'apply', '--from', '0.1', '--request-id', 'new-after-acceptance'), error => /NOT_ALLOWED/.test(error.stderr));
  assert.ok((await command('workspace', 'save', '--request-id', 'closeout-save')).revision);
  assert.ok((await command('material', 'publish', '--content', 'Existing useful result saved during Mission closeout', '--request-id', 'closeout-material')).material.material_id);
  const finished = await command('task', 'finish', '--outcome', 'incomplete', '--request-id', 'closeout-finish');
  assert.ok(finished.execution);
  await runtime.waitForSettled(execution.execution_id);
  assert.equal(service.getBot(execution.owner_ref).state, 'CLOSED');
});

test('Mission PASS while project preparation is pending prevents reserved execution activation and write grant', async t => {
  const { service, runtime, startSession } = await fixture(t);
  const { bot, session } = await runtime.startBot({ missionId: 'mission:bots', coreId: 'core-1', startSession });
  const task = service.createTask({ mission_id: bot.mission_id, summary: 'Inspect a delayed project preparation', expected_output: 'An independent note', acceptance_conditions: ['State evidence'] }, makeEnvelope({ actorRef: bot.bot_id })).task;
  const { execution } = service.takeTask(task.task_id, { owner_ref: bot.bot_id, core_id: bot.core_id, take_key: 'prepare-before-pass' });
  let enter;
  let proceed;
  const preparing = new Promise(resolve => { enter = resolve; });
  const release = new Promise(resolve => { proceed = resolve; });
  const prepare = runtime.sandboxManager.prepareBotProject.bind(runtime.sandboxManager);
  runtime.sandboxManager.prepareBotProject = async input => { enter(); await release; return prepare(input); };
  runtime.sandboxManager.grantBotProject = () => assert.fail('accepted Mission granted writes to an undelivered take');
  const rejected = assert.rejects(runtime.bindAgentExecution(execution.execution_id, session, { coreId: bot.core_id, sendInitialPrompt: false }), { code: 'NOT_ALLOWED' });
  await preparing;
  assert.equal(service.getExecution(execution.execution_id).state, 'CREATED');
  service.setMissionStopReader(id => id === bot.mission_id);
  proceed();
  await rejected;
  assert.equal(service.getExecution(execution.execution_id).started_at, null);
  assert.equal(service.getExecution(execution.execution_id).state, 'FAILED');
  assert.equal(service.getBot(bot.bot_id).state, 'CLOSED');
});

test('unbound CLI compares an unmerged public revision and keeps Workspace pages fixed', async t => {
  const { service, runtime, startSession } = await fixture(t);
  const workspace = runtime.missionWorkspace;
  const workspaceId = runtime.missionWorkspaceId;
  const candidate = await workspace.save({ workspaceId, baseRevision: '0.1', files: { 'a.txt': 'match', 'b.txt': 'match' } });
  const context = new ContextService(service.db, { taskService: service });
  const bridge = new ServicesBridge({ taskService: service, contextService: context, runtime, coreId: 'core-1',
    registry: createBuiltinServiceRegistry({ taskService: service, contextService: context, missionWorkspace: workspace }) });
  await bridge.start();
  t.after(() => bridge.stop());
  let env;
  const { bot } = await runtime.startBot({ missionId: 'mission:bots', coreId: 'core-1', startSession: async input => {
    env = bridge.startBotIdentity(input.bot.bot_id);
    return startSession(input);
  } });
  const call = (...args) => promisify(execFile)(process.execPath, ['scripts/swarm.mjs', 'workspace', ...args], {
    env: { PATH: process.env.PATH, ...env }, timeout: 15_000,
  });
  const command = async (...args) => JSON.parse((await call(...args)).stdout);
  const diff = await command('diff', '--from', 'main', '--to', candidate.revision, '--limit', '1');
  assert.equal(diff.from.revision, '0.1');
  assert.equal(diff.to.reachable_from_main, false);
  assert.ok(diff.next_cursor);
  const first = await command('files', '--at', candidate.revision, '--limit', '1');
  assert.equal(first.files[0].path, 'a.txt');
  const second = await command('files', '--at', candidate.revision, '--cursor', first.next_cursor);
  assert.deepEqual(second.files.map(item => item.path), ['b.txt']);
  const exact = await command('files', 'a.txt', '--at', candidate.revision);
  assert.deepEqual(exact.files.map(item => item.path), ['a.txt']);
  const search = await command('search', 'match', '--at', candidate.revision, '--max-results', '1');
  assert.equal(search.matches[0].path, 'a.txt');
  const more = await command('search', 'match', '--cursor', search.next_cursor);
  assert.equal(more.matches[0].path, 'b.txt');
  await assert.rejects(call('diff', '--from', 'main'), /requires both --from and --to/);
  await assert.rejects(call('diff', '--from', 'main', '--to', candidate.revision, '--workspace-id', 'outside'), /configured Mission Workspace/);
  await assert.rejects(call('diff'), /not available|requires/i);
  assert.equal(service.getBot(bot.bot_id).execution_id, null);
});

test('declared Workspace delivery verifies a published revision before accepting done', async t => {
  const { guest, command, dispatch, service, execution, runtime } = await workspaceFixture(t, {
    completionContract: { workspace_delivery: { paths: ['answer.txt'], require_main: true } },
  });
  await assert.rejects(command('task', 'finish', '--outcome', 'done', '--workspace-revision', '0.1'));
  guest.files['answer.txt'] = Buffer.from('candidate answer');
  const saved = await dispatch('save', 'actual-delivery');
  await assert.rejects(command('task', 'finish', '--outcome', 'done', '--workspace-revision', saved.revision));
  assert.equal(service.getExecution(execution.execution_id).state, 'RUNNING');
  const merged = await command('workspace', 'merge', '--from', saved.revision);
  const finished = await command('task', 'finish', '--outcome', 'done', '--workspace-revision', merged.main_revision);
  assert.equal(finished.workspace_delivery.merged_to_main, true);
  assert.equal(finished.workspace_delivery.files[0].content_hash,
    createHash('sha256').update(guest.files['answer.txt']).digest('hex'));
  assert.equal(service.getExecutionFinish(execution.execution_id).payload.workspace_delivery.revision, merged.main_revision);
  assert.equal((await runtime.missionWorkspace.get({ workspaceId: saved.workspace_id })).main_revision, merged.main_revision);
});

test('Workspace provenance records explicit uses and exposes affected revisions in history', async t => {
  const { guest, command, dispatch, bridge, context } = await workspaceFixture(t);
  const materialId = 'material:workspace-use';
  await bridge.call({ operation: 'context_publish_material', operationId: 'material-for-use',
    payload: { material_id: materialId, kind: 'note', content: 'Useful proof observation' } });
  guest.files['answer.txt'] = Buffer.from('candidate answer');
  await assert.rejects(dispatch('save', 'missing-use', { material_ids: [materialId] }), /recorded use/);
  await command('material', 'consume', '--material-ids', JSON.stringify([materialId]),
    '--action', 'workspace', '--impact', 'Established the case used in answer.txt.');
  context.db.prepare('UPDATE material_consumptions SET material_version = 99 WHERE material_id = ?').run(materialId);
  await assert.rejects(dispatch('save', 'wrong-use-version', { material_ids: [materialId] }), /recorded use/);
  context.db.prepare('UPDATE material_consumptions SET material_version = 1 WHERE material_id = ?').run(materialId);
  const saved = await command('workspace', 'save', '--material-ids', materialId, '--request-id', 'with-use');
  assert.equal(saved.source.material_uses[0].material_id, materialId);
  assert.equal(saved.source.material_uses[0].impact, 'Established the case used in answer.txt.');
  const history = await command('workspace', 'history', '--all', '--material-id', materialId);
  assert.deepEqual(history.items.map(item => item.revision), [saved.revision]);
});

test('Workspace delivery rejects a source PASS from another tree of the same file', async t => {
  const { JudgeService } = await import('../src/judge/judge-service.js');
  const identity = { checker_ref: 'lean', checker_version: 'test', environment_ref: 'test' };
  const createJudgeService = service => {
    const judge = new JudgeService(service.db, { taskService: service, fixtureManifest: {
      fixture_id: 'explicit-delivery', putnambench_commit: 'a'.repeat(40), problem_file: 'input.txt',
      problem_file_hash: 'b'.repeat(64), lean_toolchain: 'leanprover/lean4:v4.33.1', mathlib_version: 'test', ...identity,
    }, checker: {
      preflight: async () => ({ status: 'healthy', checker_process_status: 'completed',
        evidence: { input_binding_verified: true, toolchain_version_verified: true, checker_version_verified: true } }),
      check: async () => ({ verdict: 'PASS', evidence: { checker_started: true } }),
    } });
    service.setCheckResultReader(id => judge.getCheckResult(id));
    return judge;
  };
  const { command, dispatch, guest } = await workspaceFixture(t, {
    createJudgeService, completionContract: { workspace_delivery: { paths: ['proof.lean'], check: identity } },
  });
  guest.files['proof.lean'] = Buffer.from('theorem local : True := by trivial');
  const before = await dispatch('save', 'delivery-before');
  const first = await command('judge', 'check', '--at', before.revision, '--path', 'proof.lean');
  guest.files.notes = Buffer.from('changed the containing tree');
  const after = await dispatch('save', 'delivery-after');
  const finish = (...args) => command('task', 'finish', '--outcome', 'done', '--workspace-revision', after.revision, ...args);
  await assert.rejects(finish('--check-result-id', first.check_result_id), /did not pass for this delivery/);
  const second = await command('judge', 'check', '--at', after.revision, '--path', 'proof.lean');
  assert.equal((await finish('--check-result-id', second.check_result_id)).workspace_delivery.check.checked_tree, after.git_tree);
});

test('Task main delivery checks the merged tree under its declared checker environment', async t => {
  const identity = mergeCheckerIdentity;
  const checked = [];
  const { command, dispatch, guest } = await workspaceFixture(t, {
    completionContract: { workspace_delivery: { paths: ['answer.txt'], require_main: true, check: identity } },
    runtimeOptions: { workspaceMergeChecker: { identity, timeoutMs: 5000,
      async check(plan) { checked.push(plan.tree); return { verdict: 'PASS', check_result_id: 'delivery-merge-check' }; },
    } },
  });
  guest.files['answer.txt'] = Buffer.from('draft answer');
  const saved = await dispatch('save', 'checked-delivery-save');
  const merged = await command('workspace', 'merge', '--from', saved.revision);
  const finished = await command('task', 'finish', '--outcome', 'done', '--workspace-revision', merged.main_revision);
  assert.deepEqual(checked, [finished.workspace_delivery.git_tree]);
  assert.equal(finished.workspace_delivery.check.check_result_id, 'delivery-merge-check');
  assert.equal(finished.workspace_delivery.check.environment_ref, identity.environment_ref);
});

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TaskService } from '../src/task/task-service.js';
import { Runtime } from '../src/runtime/runtime.js';
import { WorkspaceManager } from '../src/runtime/workspace-manager.js';
import { MissionWorkspace } from '../src/runtime/mission-workspace.js';
import { createOpenSandboxManager } from '../src/runtime/opensandbox-manager.js';
import { makeEnvelope } from '../src/protocol/envelope.js';

async function fixture(t, runtimeOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'swarm-bot-'));
  const service = new TaskService();
  service.createMission({ mission_id: 'mission:bots', goal: 'Inspect independent questions' }, makeEnvelope({ actorRef: 'operator:test' }));
  const calls = [];
  let sandboxNumber = 0;
  const manager = createOpenSandboxManager({ lifecycleBaseUrl: 'http://provider.test', image: 'test:bot', waitForExecdReady: false,
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method });
      if (options.method === 'DELETE') return new Response('{}');
      if (url.endsWith('/sandboxes')) return new Response(JSON.stringify({ id: `sandbox:${++sandboxNumber}` }), { status: 202 });
      if (url.includes('/endpoints/')) return new Response(JSON.stringify({ url: 'http://execd.test' }));
      if (url.endsWith('/command')) return new Response('event: execution_complete\ndata: {"exit_code":0}\n\n');
      return new Response('{}');
    },
  });
  const runtime = new Runtime({ taskService: service, workspaceManager: new WorkspaceManager({ rootDir: root }), sandboxManager: manager, agentAdapter: {}, ...runtimeOptions });
  t.after(async () => { await runtime.shutdown(); service.close(); await rm(root, { recursive: true, force: true }); });
  const startSession = async ({ bot, onSandboxCreated }) => {
    const sandbox = await manager.ensureExecution({ executionId: bot.resource_key, botId: bot.bot_id, onCreated: onSandboxCreated });
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
  const accepted = service.dispatch('bot_exit', { reason: 'no-work' }, makeEnvelope({ actorRef: bot.bot_id }));
  assert.equal(accepted.bot.execution_id, null);
  await runtime.releaseBot(bot.bot_id);
  assert.equal(session.closed, true);
  assert.equal(service.getBot(bot.bot_id).state, 'CLOSED');
  assert.equal(runtime.getCoreStatus('core-1').state, 'IDLE');
  assert.equal(manager.snapshot().executions.length, 0);
});

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
  const { bot, session } = await runtime.startBot({ missionId: 'mission:bots', coreId: 'core-1', maxLifetimeMs: 350, startSession });
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
  const { workspace } = await runtime.bindAgentExecution(execution.execution_id, session, { coreId: bot.core_id, sendInitialPrompt: false });
  const current = service.getExecution(execution.execution_id);
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

test('a Task cannot materialize another Mission public Workspace', async t => {
  const { root, service, runtime, startSession } = await fixture(t);
  runtime.missionWorkspace = new MissionWorkspace({ rootDir: join(root, 'public-repositories') });
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
    workspace: { workspace_id: 'workspace-selected', revision: saved.revision } }, makeEnvelope({ actorRef: bot.bot_id })).task;
  const { execution } = service.takeTask(task.task_id, { owner_ref: bot.bot_id, core_id: bot.core_id, take_key: 'selected-input' });
  const { workspace } = await runtime.bindAgentExecution(execution.execution_id, session, { coreId: bot.core_id, sendInitialPrompt: false });
  assert.equal(service.getExecution(execution.execution_id).workspace_input.revision, saved.revision);
  assert.equal(await readFile(join(workspace.workspace_ref, 'input.txt'), 'utf8'), 'selected saved revision');
});

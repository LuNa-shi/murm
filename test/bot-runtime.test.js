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

async function fixture(t, runtimeOptions = {}, { persistent = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'swarm-bot-'));
  const service = new TaskService(persistent ? join(root, 'state.sqlite') : ':memory:');
  service.createMission({ mission_id: 'mission:bots', goal: 'Inspect independent questions' }, makeEnvelope({ actorRef: 'operator:test' }));
  const calls = [];
  let sandboxNumber = 0;
  const manager = createOpenSandboxManager({ lifecycleBaseUrl: 'http://provider.test', image: 'test:bot', waitForExecdReady: false,
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method });
      if (options.method === 'DELETE') return new Response('{}');
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
  t.after(async () => { await runtime.shutdown(); service.close(); await rm(root, { recursive: true, force: true }); });
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
    workspace: { workspace_id: 'workspace-selected', revision: saved.revision } }, makeEnvelope({ actorRef: bot.bot_id })).task;
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
  const f = await fixture(t, {}, options);
  let session;
  let env;
  const context = new ContextService(f.service.db);
  const bridge = new ServicesBridge({ taskService: f.service, contextService: context, runtime: f.runtime, coreId: 'core-1',
    registry: createBuiltinServiceRegistry({ taskService: f.service, contextService: context, missionWorkspace: f.runtime.missionWorkspace }),
    onTake: result => f.runtime.bindAgentExecution(result.execution.execution_id, session, { coreId: 'core-1', sendInitialPrompt: false }) });
  await bridge.start();
  t.after(() => bridge.stop());
  const { bot } = await f.runtime.startBot({ missionId: 'mission:bots', coreId: 'core-1', startSession: async input => {
    env = bridge.startBotIdentity(input.bot.bot_id);
    session = await f.startSession(input);
    return session;
  } });
  const task = f.service.createTask({ mission_id: bot.mission_id, summary: 'Produce a reusable project artifact', expected_output: 'Public files', acceptance_conditions: ['Artifact saved'] }, makeEnvelope({ actorRef: bot.bot_id })).task;
  await bridge.call({ operation: 'task_take', payload: { task_id: task.task_id }, operationId: 'workspace-take' });
  const execution = f.service.getExecution(bridge.executionId);
  const identity = { actorRef: bot.bot_id, taskId: task.task_id, executionId: execution.execution_id, fencingVersion: execution.fencing_version };
  const guest = { files: { 'input.txt': Buffer.from('public project input') }, captures: 0, before: null };
  f.manager.snapshotBotProject = async () => {
    guest.captures += 1;
    await guest.before?.();
    const manifest = Object.fromEntries(Object.entries(guest.files).map(([path, bytes]) => [path, { bytes: bytes.length, content_hash: createHash('sha256').update(bytes).digest('hex') }]));
    return { state: 'ACTIVE', execution_id: execution.execution_id, binding_version: execution.fencing_version, manifest,
      files: Object.fromEntries(Object.entries(guest.files).map(([path, bytes]) => [path, bytes.toString('base64')])), content_hash: createHash('sha256').update(stableStringify(manifest)).digest('hex') };
  };
  const command = async (...args) => JSON.parse((await promisify(execFile)(process.execPath, ['scripts/swarm.mjs', ...args], { env: { PATH: process.env.PATH, ...env }, timeout: 15_000 })).stdout);
  const dispatch = (operation, requestId, input = {}) => f.runtime.dispatchExecutionWorkspace(operation, input, { ...identity, requestId });
  return { ...f, bot, bridge, execution, identity, guest, command, dispatch };
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

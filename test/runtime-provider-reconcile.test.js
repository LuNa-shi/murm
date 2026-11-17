import { openSandboxBotKey } from '../src/runtime/opensandbox-metadata.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskService } from '../src/task/task-service.js';
import { createOpenSandboxManager } from '../src/runtime/opensandbox-manager.js';
import { makeEnvelope } from '../src/protocol/envelope.js';
import { Runtime } from '../src/runtime/runtime.js';

test('Runtime reconciles provider sandboxes from durable active Executions', async () => {
  const calls = [];
  const events = [];
  const taskService = {
    listActiveExecutions: () => [{ execution_id: 'execution-a' }, { execution_id: 'execution-b' }],
    subscribeExecutionState: () => () => {},
    subscribeNotifications: () => () => {},
  };
  const runtime = new Runtime({
    taskService,
    workspaceManager: {},
    agentAdapter: {},
    sandboxManager: {
      reconcileExecutions: async (input) => {
        calls.push(input);
        return { provider: 'opensandbox', adopted: [{ execution_id: 'execution-a', sandbox_id: 'sandbox-a' }] };
      },
    },
    logger: { append: (event) => events.push(event) },
  });
  try {
    const result = await runtime.reconcileProviderExecutions();
    assert.deepEqual(calls, [{ executionIds: ['execution-a', 'execution-b'] }]);
    assert.deepEqual(result.adopted, [{ execution_id: 'execution-a', sandbox_id: 'sandbox-a' }]);
    assert.deepEqual(events, [{
      event: 'runtime.provider_reconciled',
      provider: 'opensandbox',
      requested_execution_count: 2,
      adopted_execution_count: 1,
    }]);
  } finally {
    await runtime.shutdown();
  }
});

test('restart persists a discovered Bot resource before delete and only frees a confirmed Core', async t => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-provider-restart-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = join(root, 'task.sqlite');
  const previous = new TaskService(database);
  for (const missionId of ['M', 'foreign']) previous.createMission({ mission_id: missionId, goal: 'Investigate' });
  const selectionDeadline = new Date(Date.now() + 60_000).toISOString();
  for (const [botId, missionId, coreId] of [['unknown', 'M', 'one'], ['taken', 'M', 'two'], ['foreign', 'foreign', 'three']]) {
    previous.registerBot({ botId, missionId, coreId, selectionDeadline });
  }
  previous.recordBotSandbox('taken', { provider: 'opensandbox', sandboxId: 'known' });
  previous.recordBotSandboxDispatch('unknown', { provider: 'opensandbox', timeoutSeconds: 60 });
  previous.markBotReady('taken');
  previous.recordBotSandbox('foreign', { provider: 'opensandbox', sandboxId: 'foreign' });
  const task = previous.createTask({ mission_id: 'M', summary: 'Check exact behavior for a boundary example', gap: 'The Mission needs an exact boundary observation', priority: 'medium', expected_output: 'A self-contained technical note', acceptance_conditions: ['Explain accompanying output'] }, makeEnvelope({ actorRef: 'taken' })).task;
  const { execution } = previous.takeTask(task.task_id, { owner_ref: 'taken', core_id: 'two', take_key: 'take' });
  previous.close();

  const service = new TaskService(database);
  let allowDelete = false;
  const deleted = new Set();
  const calls = [];
  const reply = (status, body = {}) => new Response(status === 204 ? null : JSON.stringify(body), { status });
  const sandboxManager = createOpenSandboxManager({ lifecycleBaseUrl: 'http://provider.test/v1', image: 'fixture', fetchImpl: async (url, { method }) => {
    const { pathname, searchParams } = new URL(url);
    const sandboxId = pathname.split('/').at(-1);
    if (sandboxId === 'sandboxes') {
      const page = Number(searchParams.get('page') ?? 1);
      calls.push(page);
      const items = page === 1 ? [
        { id: 'foreign', metadata: { mission_id: 'foreign', bot_id: 'foreign' } },
        { id: 'known', metadata: { mission_id: 'M', bot_id: 'taken', resource_key: 'taken' } },
      ] : [{ id: 'discovered', metadata: { mission_id: 'M', bot_id: 'unknown', resource_key: 'unknown' } }];
      return reply(200, { items: items.filter(item => !deleted.has(item.id)), pagination: { page, hasNextPage: page === 1 } });
    }
    assert.notEqual(sandboxId, 'foreign');
    const bot = service.getBot(sandboxId === 'known' ? 'taken' : 'unknown');
    assert.equal(bot.state, 'CLOSING');
    assert.equal(bot.sandbox_id, sandboxId);
    if (method === 'DELETE' && allowDelete) deleted.add(sandboxId);
    return method === 'DELETE' ? reply(allowDelete ? 204 : 502) : reply(deleted.has(sandboxId) ? 404 : 200);
  } });
  const runtime = new Runtime({ taskService: service, workspaceManager: {}, sandboxManager, coreIds: ['one', 'two', 'three'] });
  const sibling = new Runtime({ taskService: service, workspaceManager: {}, sandboxManager, coreIds: ['two'] });
  t.after(async () => { await Promise.all([runtime.shutdown(), sibling.shutdown()]); service.close(); });
  const first = await runtime.reconcileProviderExecutions({ missionId: 'M' });
  assert.deepEqual(calls, [1, 2]);
  assert.equal(first.pending.length, 2);
  assert.equal(service.getTask(task.task_id).state, 'RUNNING');
  assert.equal(runtime.getCoreStatus('one').state, 'CLOSING');
  await assert.rejects(runtime.stopExecution(execution.execution_id), { code: 'SERVICE_UNAVAILABLE' });
  allowDelete = true;
  const [second, third] = await Promise.all([
    runtime.reconcileProviderExecutions({ missionId: 'M' }),
    sibling.reconcileProviderExecutions({ missionId: 'M' }),
  ]);
  assert.deepEqual(second.closed_bot_ids, ['taken', 'unknown']);
  assert.deepEqual(third.closed_bot_ids, []);
  assert.equal(service.getBot('unknown').state, 'CLOSED');
  assert.equal(service.getBot('taken').state, 'CLOSED');
  assert.equal(service.getBot('foreign').state, 'STARTING');
  assert.equal(service.getExecution(execution.execution_id).state, 'FENCED');
  assert.equal(service.getTask(task.task_id).state, 'OPEN');
  assert.equal(runtime.getCoreStatus('one').state, 'IDLE');
});

test('sibling reconciliation leaves live in-process ownership alone and keeps an unknown Bot recoverable', async t => {
  const tasks = new TaskService(':memory:');
  tasks.createMission({ mission_id: 'M', goal: 'Investigate' });
  const sandboxManager = createOpenSandboxManager({ lifecycleBaseUrl: 'http://provider.test/v1', image: 'fixture', fetchImpl: async (url, { method }) => {
    assert.equal(method, 'GET');
    assert.equal(new URL(url).pathname, '/v1/sandboxes');
    return new Response(JSON.stringify({ items: [] }));
  } });
  const live = new Runtime({ taskService: tasks, workspaceManager: {}, sandboxManager, coreIds: ['one'] });
  const recovering = new Runtime({ taskService: tasks, workspaceManager: {}, sandboxManager, coreIds: ['two'] });
  t.after(async () => { await Promise.all([live.shutdown(), recovering.shutdown()]); tasks.close(); });
  tasks.registerBot({ botId: 'unknown', missionId: 'M', coreId: 'two', selectionDeadline: new Date(Date.now() + 60_000).toISOString() });
  tasks.recordBotSandboxDispatch('unknown', { provider: 'opensandbox', timeoutSeconds: 60 });
  const session = { closed: false, waitForReady: async () => {}, stop: async () => { session.closed = true; } };
  const { bot } = await live.startBot({ missionId: 'M', coreId: 'one', startSession: async ({ onSandboxCreated }) => {
    onSandboxCreated({ sandbox_id: 'live', provider: 'opensandbox' });
    return session;
  } });
  const result = await recovering.reconcileProviderExecutions({ missionId: 'M' });
  assert.deepEqual(result.owned_bot_ids, [bot.bot_id]);
  assert.equal(session.closed, false);
  assert.equal(tasks.getBot(bot.bot_id).state, 'UNBOUND');
  assert.deepEqual(result.pending.map(entry => entry.reason), ['creation_unconfirmed']);
  assert.equal(recovering.getCoreStatus('two').state, 'CLOSING');
  await assert.rejects(recovering.startBot({ missionId: 'M', coreId: 'two', startSession: async () => assert.fail('unconfirmed Core started a new Bot') }), { code: 'CONFLICT' });
});

test('restart frees Bots with proven absence without treating an empty list as proof of an unknown create', async t => {
  const tasks = new TaskService(':memory:');
  tasks.createMission({ mission_id: 'M', goal: 'Investigate' });
  t.after(() => tasks.close());
  for (const botId of ['never-posted', 'rejected', 'unknown']) {
    tasks.registerBot({ botId, missionId: 'M', coreId: botId, selectionDeadline: new Date(Date.now() + 60_000).toISOString() });
  }
  for (const botId of ['rejected', 'unknown']) tasks.recordBotSandboxDispatch(botId, { provider: 'opensandbox', timeoutSeconds: 75 });
  tasks.recordBotSandboxRejection('rejected');
  const manager = createOpenSandboxManager({ lifecycleBaseUrl: 'http://provider.test/v1', image: 'fixture', fetchImpl: async (url, { method }) => {
    assert.equal(method, 'GET');
    assert.equal(new URL(url).pathname, '/v1/sandboxes');
    return new Response(JSON.stringify({ items: [] }));
  } });
  const runtime = new Runtime({ taskService: tasks, workspaceManager: {}, sandboxManager: manager, coreIds: ['never-posted', 'rejected', 'unknown'] });
  const result = await runtime.reconcileProviderExecutions({ missionId: 'M' });
  assert.deepEqual(result.closed_bot_ids, ['never-posted', 'rejected']);
  assert.deepEqual(result.pending.map(row => [row.bot_id, row.reason]), [['unknown', 'creation_unconfirmed']]);
  assert.equal(tasks.getBot('unknown').sandbox_timeout_seconds, 75);
  assert.equal(tasks.getBot('unknown').state, 'CLOSING');
  await runtime.shutdown();
});

test('provider persists intent before POST, sends a finite lifetime and only records definitive rejection', async t => {
  const tasks = new TaskService(':memory:');
  tasks.createMission({ mission_id: 'M', goal: 'Investigate' });
  t.after(() => tasks.close());
  let status = 400;
  const manager = createOpenSandboxManager({ lifecycleBaseUrl: 'http://provider.test/v1', image: 'fixture', fetchImpl: async (url, request) => {
    assert.equal(request.method, 'POST');
    const body = JSON.parse(request.body);
    const bot = tasks.listRecoverableBots('M').find(candidate => openSandboxBotKey(candidate.bot_id) === body.metadata.bot_key);
    assert.equal(bot.sandbox_create_state, 'UNKNOWN');
    assert.equal(bot.sandbox_timeout_seconds, 90);
    assert.equal(body.timeout, 90);
    return new Response('{}', { status });
  } });
  for (const [botId, responseStatus, expected] of [['rejected', 400, 'REJECTED'], ['unknown', 502, 'UNKNOWN']]) {
    status = responseStatus;
    tasks.registerBot({ botId, missionId: 'M', coreId: botId, selectionDeadline: new Date(Date.now() + 60_000).toISOString() });
    await assert.rejects(manager.ensureExecution({ executionId: botId, botId, timeoutSeconds: 90,
      onCreateDispatch: resource => tasks.recordBotSandboxDispatch(botId, { provider: resource.provider, timeoutSeconds: resource.timeout_seconds }),
      onCreateRejected: () => tasks.recordBotSandboxRejection(botId),
    }));
    assert.equal(tasks.getBot(botId).sandbox_create_state, expected);
    assert.equal(manager.ownsBotResource(botId), expected === 'UNKNOWN');
  }
});

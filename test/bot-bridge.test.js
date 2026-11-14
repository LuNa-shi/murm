import assert from 'node:assert/strict';
import test from 'node:test';
import { request as httpRequest } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MissionWorkspace } from '../src/runtime/mission-workspace.js';
import { promisify } from 'node:util';
import { TaskService } from '../src/task/task-service.js';
import { ContextService } from '../src/context/context-service.js';
import { ServicesBridge } from '../src/agent/services-bridge.js';
import { createBuiltinServiceRegistry } from '../src/sdk/builtin-registry.js';
import { makeEnvelope } from '../src/protocol/envelope.js';

async function fixture(t, options = {}) {
  const service = new TaskService();
  const context = new ContextService(service.db, { taskService: service });
  service.createMission({ mission_id: 'mission:auth', goal: 'Inspect authenticated Bot lifecycle' }, makeEnvelope({ actorRef: 'operator:test' }));
  const registry = createBuiltinServiceRegistry({ taskService: service, contextService: context, missionWorkspace: options.runtime?.missionWorkspace });
  const bridge = new ServicesBridge({ taskService: service, contextService: context, runtime: {}, coreId: 'core-1', registry, ...options });
  await bridge.start();
  t.after(async () => { await bridge.stop(); service.close(); });
  const start = id => {
    service.registerBot({ botId: id, missionId: 'mission:auth', coreId: 'core-1', selectionDeadline: new Date(Date.now() + 60_000).toISOString() });
    const env = bridge.startBotIdentity(id);
    service.recordBotSandbox(id, { provider: 'controlled', sandboxId: `sandbox:${id}` });
    service.markBotReady(id);
    return env;
  };
  const close = id => { service.requestBotStop(id, 'test-cleanup'); service.finalizeBotClose(id); };
  return { service, bridge, start, close };
}

test('a request authenticated before rotation cannot execute as the successor Bot', async t => {
  const { service, bridge, start, close } = await fixture(t);
  const env = start('bot:first');
  const body = JSON.stringify({ operation: 'bot_exit', payload: { reason: 'no-work' } });
  let arrived;
  const received = new Promise(resolve => { arrived = resolve; });
  bridge.server.once('request', arrived);
  let req;
  const response = new Promise((resolve, reject) => {
    req = httpRequest(`${env.SWARMENV_BRIDGE_URL}/call`, { method: 'POST', headers: { authorization: `Bearer ${env.SWARMENV_BRIDGE_TOKEN}`, 'content-length': Buffer.byteLength(body) } }, res => {
      let result = '';
      res.on('data', chunk => { result += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(result) }));
    });
    req.on('error', reject);
    req.write(body.slice(0, 1));
  });
  await received;
  close('bot:first');
  start('bot:second');
  req.end(body.slice(1));
  const rejected = await response;
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error.code, 'NOT_ALLOWED');
  assert.equal(service.getBot('bot:second').state, 'UNBOUND');
});

test('a queued Task proposal cannot acquire a successor Bot identity', async t => {
  let entered;
  let resume;
  const queued = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { resume = resolve; });
  const { service, bridge, start, close } = await fixture(t, { taskCreateMutex: { run: async fn => { entered(); await gate; return fn(); } } });
  start('bot:first');
  const proposal = bridge.call({ operation: 'task_create', payload: { mission_id: 'mission:auth', summary: 'Inspect one independently useful question', expected_output: 'Note', acceptance_conditions: ['Reviewed'] } });
  const rejected = assert.rejects(proposal, /credentials changed/);
  await queued;
  close('bot:first');
  start('bot:second');
  resume();
  await rejected;
  assert.equal(service.listMissionTasks({ mission_id: 'mission:auth' }).length, 0);
});

test('swarm bot exit uses the provisioned Bridge identity without an actor override', async t => {
  const { service, start } = await fixture(t);
  const env = start('bot:cli');
  const { stdout } = await promisify(execFile)(process.execPath, ['scripts/swarm.mjs', 'bot', 'exit', '--reason', 'no-work', '--json'], { cwd: process.cwd(), env: { ...process.env, ...env }, timeout: 10_000 });
  const result = JSON.parse(stdout);
  assert.equal(result.bot.bot_id, 'bot:cli');
  assert.equal(service.getBot('bot:cli').state, 'CLOSING');
  assert.equal(service.getBot('bot:cli').execution_id, null);
});

test('Bridge refuses an expired Bot credential before the cleanup timer runs', async t => {
  const { service, bridge, start } = await fixture(t);
  start('bot:expired');
  service.db.prepare('UPDATE bots SET hard_deadline = ? WHERE bot_id = ?').run(new Date(Date.now() - 1).toISOString(), 'bot:expired');
  assert.equal(service.getBot('bot:expired').state, 'UNBOUND');
  await assert.rejects(bridge.call({ operation: 'task_create', payload: { summary: 'A late proposal at the real Bridge boundary', expected_output: 'Note', acceptance_conditions: ['Note'] } }), /hard deadline elapsed/);
});


test('Bridge withholds contribution binding until the activation and grant callback completes', async t => {
  let entered; let release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const { service, bridge, start } = await fixture(t, { onTake: async () => { entered(); await gate; } });
  start('bot:preparing-grant');
  const task = service.createTask({ mission_id: 'mission:auth', summary: 'Inspect the protected binding boundary', expected_output: 'Note', acceptance_conditions: ['Note'] }, makeEnvelope({ actorRef: 'bot:preparing-grant' })).task;
  const taken = service.takeTask(task.task_id, { owner_ref: 'bot:preparing-grant', core_id: 'core-1', take_key: 'bridge-grant' });
  const binding = bridge.bindTake(taken);
  await started;
  try {
    await assert.rejects(bridge.call({ operation: 'task_create', payload: { summary: 'A proposal before grant completes', expected_output: 'Note', acceptance_conditions: ['Note'] } }), /binding is still being prepared/);
  } finally { release(); }
  await binding;
  assert.equal(bridge.bindingPending, false);
});


test('real swarm CLI discovers services, reads pinned public input, proposes and takes under its Bot binding', async t => {
  const root = await mkdtemp(join(tmpdir(), 'swarm-cli-bot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = new MissionWorkspace({ rootDir: root });
  await workspace.create({ missionId: 'mission:auth', workspaceId: 'W-cli', initialFiles: { 'notes.txt': 'x=y=z' } });
  let service;
  let activations = 0;
  const fixtureResult = await fixture(t, {
    runtime: { missionWorkspace: workspace, missionWorkspaceId: 'W-cli' },
    onTake: async result => {
      activations += 1;
      const e = service.getExecution(result.execution.execution_id);
      result.execution = service.dispatch('start_execution', { core_id: 'core-1' }, makeEnvelope({
        operationId: `activate:${e.execution_id}`, actorRef: e.owner_ref, taskId: e.task_id,
        executionId: e.execution_id, specVersion: e.spec_version, stateVersion: e.state_version, fencingVersion: e.fencing_version,
      })).execution;
    },
  });
  service = fixtureResult.service;
  const env = fixtureResult.start('bot:cli-flow');
  const run = async (...args) => {
    const result = await promisify(execFile)(process.execPath, ['scripts/swarm.mjs', ...args], {
      env: { PATH: process.env.PATH, ...env }, timeout: 10_000,
    });
    return JSON.parse(result.stdout);
  };
  assert.ok((await run('service', 'list')).services.some(item => item.service_id === 'task'));
  assert.ok((await run('service', 'view', 'task')).capabilities.some(item => item.operation === 'task_create'));
  assert.equal((await run('mission', 'view')).mission_id, 'mission:auth');
  const file = await run('workspace', 'read', 'notes.txt', '--at', '0.1');
  assert.equal(file.content, 'x=y=z');
  assert.equal(file.revision, '0.1');
  const proposalPath = join(root, 'proposal.json');
  await writeFile(proposalPath, JSON.stringify({ summary: 'Check one independently useful boundary', expected_output: 'A reproducible result', acceptance_conditions: ['Result is readable'] }));
  const task = (await run('task', 'propose', '--input', proposalPath, '--request-id', 'cli-propose')).task;
  assert.equal(task.mission_id, 'mission:auth');
  assert.equal((await run('task', 'propose', '--input', proposalPath, '--request-id', 'cli-propose')).task.task_id, task.task_id);
  assert.equal((await run('task', 'view', task.task_id)).task.task_id, task.task_id);
  const taken = await run('task', 'take', task.task_id, '--request-id', 'cli-take');
  assert.equal(taken.execution.state, 'RUNNING');
  assert.deepEqual(await run('task', 'take', task.task_id, '--request-id', 'cli-take'), taken);
  assert.equal(activations, 1);
  await assert.rejects(run('task', 'take', task.task_id, '--request-id', 'different-take'), /current Execution binding/);
  await assert.rejects(run('task', 'take', task.task_id, '--request-id', 'cli-take', '--take-key', 'changed'), /another payload/);
  await assert.rejects(run('task', 'view', task.task_id, '--actor-ref', 'operator:fake'), /identity overrides/);
  await assert.rejects(run('workspace', 'read', 'notes.txt', '--workspace-id', 'W-foreign'), /configured Mission Workspace/);
  const materialPath = join(root, 'material.json');
  await writeFile(materialPath, JSON.stringify({ role: 'experience', content: 'A public research note with its assumptions' }));
  const published = await run('material', 'publish', '--input', materialPath, '--request-id', 'cli-material');
  assert.equal(published.material.producer_bot_id, 'bot:cli-flow');
  const current = service.getExecution(taken.execution.execution_id);
  service.dispatch('heartbeat', {}, makeEnvelope({ actorRef: current.owner_ref, taskId: current.task_id, executionId: current.execution_id,
    specVersion: current.spec_version, stateVersion: current.state_version, fencingVersion: current.fencing_version }));
  assert.deepEqual(await run('material', 'publish', '--input', materialPath, '--request-id', 'cli-material'), published);
  assert.equal((await run('material', 'view', published.material.material_id)).material.content, published.material.content);
  await writeFile(proposalPath, JSON.stringify({ summary: 'Inspect the replacement responsibility and its boundary', expected_output: 'A new bounded result', acceptance_conditions: ['Result is readable'] }));
  const replacement = (await run('task', 'propose', '--input', proposalPath, '--request-id', 'cli-replacement')).task;
  const finished = await run('task', 'finish', '--outcome', 'cancelled', '--reason', 'responsibility replaced', '--replacement', replacement.task_id, '--request-id', 'cli-finish');
  assert.equal(service.getExecutionFinish(taken.execution.execution_id).replacement_task_id, replacement.task_id);
  assert.equal(finished.execution.state, 'CLOSING');
  await assert.rejects(run('material', 'publish', '--input', materialPath, '--request-id', 'after-finish'));
});

test('Bot public discovery refuses foreign Mission/Task identities and does not drop equals in flags', async t => {
  const { service, bridge, start } = await fixture(t);
  const env = start('bot:scoped-read');
  service.createMission({ mission_id: 'mission:foreign', goal: 'Private foreign work' }, makeEnvelope({ actorRef: 'operator:test' }));
  const foreign = service.createTask({ mission_id: 'mission:foreign', summary: 'Inspect a distinct question in the foreign Mission', expected_output: 'Note', acceptance_conditions: ['Note'] }, makeEnvelope({ actorRef: 'operator:test' })).task;
  await assert.rejects(bridge.call({ operation: 'task_view', payload: { task_id: foreign.task_id } }), /not readable/);
  await assert.rejects(bridge.call({ operation: 'task_list', payload: { mission_id: 'mission:foreign' } }), /Bot Mission/);
  service.takeTask(foreign.task_id, { owner_ref: 'operator:foreign', core_id: 'foreign-core', take_key: 'foreign-take' });
  const status = await bridge.call({ operation: 'task_status', payload: {} });
  assert.deepEqual(status.lanes, []);
  await assert.rejects(bridge.call({ operation: 'mission_submit', payload: {} }), { code: 'SERVICE_NOT_READY' });
  const { stdout } = await promisify(execFile)(process.execPath, ['scripts/swarm.mjs', 'task', 'list', '--query=x=y=z'], { env: { PATH: process.env.PATH, ...env }, timeout: 10_000 });
  assert.equal(JSON.parse(stdout).tasks.length, 0);
});

test('real CLI follows Task pages and takes an existing low-priority responsibility beyond the first 500', { timeout: 30000 }, async t => {
  let service;
  const f = await fixture(t, { onTake: async result => {
    const e = service.getExecution(result.execution.execution_id);
    result.execution = service.dispatch('start_execution', {}, makeEnvelope({ actorRef: e.owner_ref, taskId: e.task_id, executionId: e.execution_id,
      specVersion: e.spec_version, stateVersion: e.state_version, fencingVersion: e.fencing_version })).execution;
  } });
  service = f.service;
  for (let i = 0; i < 505; i += 1) service.createTask({ mission_id: 'mission:auth', task_id: `existing:${i}`, summary: `Inspect reusable responsibility number ${i}`,
    expected_output: 'A reusable result', acceptance_conditions: ['Result is readable'], priority: i === 504 ? 0 : 10 }, makeEnvelope({ actorRef: 'operator:fixture' }));
  const env = f.start('bot:deep-lookup');
  const run = async (...args) => JSON.parse((await promisify(execFile)(process.execPath, ['scripts/swarm.mjs', ...args], {
    env: { PATH: process.env.PATH, ...env }, timeout: 10000,
  })).stdout);
  let cursor, target, pages = 0;
  do {
    const page = await run('task', 'list', '--query', 'reusable', '--limit', '100', ...(cursor ? ['--cursor', cursor] : []));
    target ??= page.tasks.find(task => task.task_id === 'existing:504');
    cursor = page.next_cursor; pages += 1;
  } while (cursor);
  assert.equal(pages, 6); assert.equal(target.task_id, 'existing:504');
  const detail = await run('task', 'view', target.task_id);
  assert.equal(detail.task.expected_output, 'A reusable result');
  const taken = await run('task', 'take', target.task_id, '--request-id', 'take-existing');
  assert.equal(taken.execution.task_id, target.task_id);
  assert.equal(taken.execution.owner_ref, 'bot:deep-lookup');
  assert.equal(service.taskStatus({ mission_id: 'mission:auth' }).counts.total, 505);
  await run('task', 'finish', '--outcome', 'incomplete', '--request-id', 'finish-existing');
});


test('same-ID take retry joins preparation while altered payload and other writes are rejected', async t => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let activations = 0;
  const { service, bridge, start } = await fixture(t, { onTake: async result => {
    entered(); await gate; activations += 1;
    const e = service.getExecution(result.execution.execution_id);
    result.execution = service.dispatch('start_execution', {}, makeEnvelope({ operationId: `activate:${e.execution_id}`, actorRef: e.owner_ref, taskId: e.task_id, executionId: e.execution_id, specVersion: e.spec_version, stateVersion: e.state_version, fencingVersion: e.fencing_version })).execution;
  } });
  start('bot:retry-preparing');
  const task = (await bridge.call({ operation: 'task_create', payload: { summary: 'Inspect a slow preparation and retry boundary', expected_output: 'A result', acceptance_conditions: ['Verified'] } })).task;
  const request = { operation: 'task_take', operation_id: 'slow-take', payload: { task_id: task.task_id } };
  const first = bridge.call(request);
  await started;
  const retry = bridge.call(structuredClone(request));
  try {
    await assert.rejects(bridge.call({ ...request, service_id: 'bogus' }), { code: 'NOT_ALLOWED' });
    await assert.rejects(bridge.call({ ...request, capability_id: 'bogus.task_take' }), { code: 'NOT_ALLOWED' });
    await assert.rejects(bridge.call({ ...request, payload: { ...request.payload, take_key: 'changed' } }), /another payload/);
    await assert.rejects(bridge.call({ operation: 'task_create', payload: {} }), /still being prepared/);
  } finally { release(); }
  assert.deepEqual(await retry, await first);
  assert.equal(activations, 1);
  assert.equal(service.listExecutions(task.task_id).length, 1);
});

test('registered Bots cannot discover foreign Tasks through retired list aliases', async t => {
  const { service, bridge, start } = await fixture(t);
  service.createMission({ mission_id: 'mission:foreign', goal: 'Private independent project' }, makeEnvelope({ actorRef: 'operator:test' }));
  service.createTask({ mission_id: 'mission:foreign', summary: 'Foreign responsibility', expected_output: 'Result', acceptance_conditions: ['Readable'] }, makeEnvelope({ actorRef: 'operator:test' }));
  start('bot:scoped-discovery');
  for (const operation of ['list_tasks', 'list_eligible_tasks', 'list_executions', 'task_discover']) {
    await assert.rejects(bridge.call({ operation, payload: {} }), { code: 'NOT_ALLOWED' });
    if (operation !== 'task_discover') assert.throws(() => service.dispatch(operation, {}, makeEnvelope({ actorRef: 'bot:scoped-discovery' })), { code: 'NOT_ALLOWED' });
  }
  assert.deepEqual((await bridge.call({ operation: 'task_list', payload: {} })).tasks, []);
});

test('Bridge stop closes an incomplete HTTP request and rejects new direct calls', async t => {
  const { bridge, start } = await fixture(t);
  const env = start('bot:stopping');
  let arrived;
  const received = new Promise(resolve => { arrived = resolve; });
  bridge.server.once('request', arrived);
  const req = httpRequest(`${env.SWARMENV_BRIDGE_URL}/call`, { method: 'POST', headers: { authorization: `Bearer ${env.SWARMENV_BRIDGE_TOKEN}`, 'content-length': '1000' } });
  const disconnected = new Promise(resolve => { req.on('error', resolve); req.on('close', resolve); });
  req.write('{');
  await received;
  await bridge.stop(); await disconnected;
  await assert.rejects(bridge.call({ operation: 'bot_exit', payload: { reason: 'no-work' } }), { code: 'NOT_ALLOWED' });
});

test('Bridge stop drains an admitted real HTTP call after its connection is gone', async t => {
  let entered, release;
  const accepted = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  let completed = false;
  const { service, bridge, start } = await fixture(t, { onWorkUnit: async ({ operation, result }) => {
    if (operation !== 'task_create') return;
    entered(); await held;
    assert.equal(service.getTask(result.task.task_id).mission_id, 'mission:auth');
    completed = true;
  } });
  const env = start('bot:admitted-stop');
  const req = httpRequest(`${env.SWARMENV_BRIDGE_URL}/call`, { method: 'POST', headers: { authorization: `Bearer ${env.SWARMENV_BRIDGE_TOKEN}` } });
  const disconnected = new Promise(resolve => { req.on('error', resolve); req.on('close', resolve); });
  req.end(JSON.stringify({ operation: 'task_create', payload: { summary: 'Inspect one independent research responsibility', expected_output: 'Readable note', acceptance_conditions: ['Answer the question'] } }));
  await accepted;
  let stopFinished = false;
  const stopping = bridge.stop().then(() => { stopFinished = true; });
  await disconnected;
  assert.equal(stopFinished, false);
  assert.equal(completed, false);
  assert.equal(bridge.pendingCalls.size, 1);
  release(); await stopping;
  assert.equal(completed, true);
  assert.equal(bridge.pendingCalls.size, 0); assert.equal(bridge.pendingHandlers.size, 0);
  await assert.rejects(bridge.start(), { code: 'NOT_ALLOWED' });
});

test('Bridge start settles when stop wins before the listening event', async t => {
  const { service, bridge } = await fixture(t);
  const pending = new ServicesBridge({ taskService: service, contextService: bridge.contextService, runtime: {} });
  const starting = pending.start();
  const rejected = assert.rejects(starting, /stopped/);
  await pending.stop(); await rejected;
  assert.equal(pending.server, null);
});

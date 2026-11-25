import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TaskService } from '../src/task/task-service.js';
import { makeEnvelope } from '../src/protocol/envelope.js';
import { createCoreModelAccess } from '../src/core/model-access.js';
import { createTaskPoolModelAccessPolicy } from '../src/harnesses/taskpool/model-access-policy.js';

async function fixture(t, { held = false } = {}) {
  const outputDir = await mkdtemp(join(tmpdir(), 'flat-model-'));
  const tasks = new TaskService();
  tasks.createMission({ mission_id: 'm', goal: 'Authorize actual flat Bot model access' }, makeEnvelope({ actorRef: 'host' }));
  const deadlineAt = Date.now() + 15_000;
  tasks.registerBot({ botId: 'b', missionId: 'm', legacySlotId: 'slot', selectionDeadline: new Date(deadlineAt - 1000).toISOString(), hardDeadline: new Date(deadlineAt).toISOString() });
  tasks.markCoreBotReady('b');
  let requests = 0, received;
  const dispatched = new Promise(resolve => { received = resolve; });
  const upstream = createServer((request, response) => {
    requests++; request.resume(); received();
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (held) response.write(': held\n\n');
    else response.end('event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n');
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const policy = createTaskPoolModelAccessPolicy({ runtimeId: 'r', taskService: tasks, missionId: 'm', deadline: () => deadlineAt });
  const access = await createCoreModelAccess({ runtimeId: 'r', outputDir, modelAccessPolicy: policy,
    getBot: id => id === 'b' ? { profile: 'readonly', model: 'default', status: 'idle' } : null,
    config: { modelGateway: { host: '127.0.0.1', advertiseHost: '127.0.0.1', requestTimeoutMs: 5000, maxOutputTokens: 32 },
      models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: `http://127.0.0.1:${upstream.address().port}/v1/responses`, headers: {} } } } } });
  const credentials = access.credentialsForBot('b', 'default');
  t.after(async () => { await access.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); tasks.close(); await rm(outputDir, { recursive: true, force: true }); });
  const call = async id => {
    const response = await fetch(`${credentials.baseUrl}/responses`, { method: 'POST', headers: {
      authorization: `Bearer ${credentials.secretEnvironment.PI_KIMI_PROXY_API_KEY}`, 'content-type': 'application/json', 'x-swarmenv-request-id': id }, body: JSON.stringify({ model: 'k3', input: 'FIXED_AUTHORITY_CHECK' }) });
    return { status: response.status, body: await response.text() };
  };
  return { outputDir, tasks, policy, access, call, dispatched, requests: () => requests };
}

test('flat selection calls Core model gateway, then domain stop denies before upstream', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('allowed')).status, 200);
  f.tasks.requestBotStop('b', 'host-stop');
  assert.equal((await f.call('denied')).status, 403);
  assert.equal(f.requests(), 1);
});

test('an actual selection HTTP stream is aborted when real TaskService authority is revoked', { timeout: 2500 }, async t => {
  const f = await fixture(t, { held: true });
  const result = f.call('held');
  await f.dispatched;
  f.tasks.requestBotStop('b', 'host-stop');
  await assert.rejects(result, /terminated|fetch failed/);
  assert.equal(f.requests(), 1);
});

test('real Execution fencing aborts its active HTTP stream and denies another model request', { timeout: 2500 }, async t => {
  const f = await fixture(t, { held: true });
  const task = f.tasks.createTask({ mission_id: 'm', gap: 'Check that model streams stop when their Execution is fenced', priority: 'medium', summary: 'Fence live model authority', expected_output: 'Verified denial', acceptance_conditions: ['Fence enforced'] }, makeEnvelope({ actorRef: 'b' })).task;
  const { execution: preparing } = f.tasks.takeTask(task.task_id, { owner_ref: 'b', core_id: 'slot', take_key: 'take' });
  const envelope = execution => makeEnvelope({ actorRef: 'b', taskId: task.task_id, executionId: execution.execution_id, specVersion: execution.spec_version, stateVersion: execution.state_version, fencingVersion: execution.fencing_version });
  const { execution } = f.tasks.dispatch('start_execution', {}, envelope(preparing));
  const result = f.call('held-execution');
  await f.dispatched;
  f.tasks.dispatch('fence_execution', { reason: 'controlled-fence' }, envelope(execution));
  await assert.rejects(result, /terminated|fetch failed/);
  assert.equal((await f.call('fenced')).status, 403);
  assert.equal(f.requests(), 1);
});

test('a Bot bound to another Bot Execution is denied before ledger reservation and upstream', async t => {
  const f = await fixture(t);
  f.tasks.registerBot({ botId: 'owner', missionId: 'm', legacySlotId: 'other-slot', selectionDeadline: new Date(Date.now() + 10_000).toISOString() });
  f.tasks.markCoreBotReady('owner');
  const task = f.tasks.createTask({ mission_id: 'm', gap: 'Verify a stale binding cannot borrow another Bot Execution', priority: 'medium', summary: 'Deny foreign Execution', expected_output: 'Denial', acceptance_conditions: ['No upstream request'] }, makeEnvelope({ actorRef: 'b' })).task;
  const { execution: preparing } = f.tasks.takeTask(task.task_id, { owner_ref: 'b', core_id: 'slot', take_key: 'foreign-take' });
  f.tasks.dispatch('start_execution', {}, makeEnvelope({ actorRef: 'b', taskId: task.task_id, executionId: preparing.execution_id, specVersion: preparing.spec_version, stateVersion: preparing.state_version, fencingVersion: preparing.fencing_version }));
  // Fault injection into real durable host state; no model payload chooses this binding.
  f.tasks.db.prepare("UPDATE executions SET owner_ref = 'owner' WHERE execution_id = ?").run(preparing.execution_id);
  assert.equal((await f.call('foreign-execution')).status, 403);
  assert.equal(f.requests(), 0);
  const [filename] = await readdir(join(f.outputDir, 'model-access'));
  const ledger = new DatabaseSync(join(f.outputDir, 'model-access', filename), { readOnly: true });
  try { assert.equal(ledger.prepare('SELECT COUNT(*) AS count FROM runtime_model_attempts').get().count, 0); } finally { ledger.close(); }
});

test('flat withCommit holds real SQLite lifecycle authority exactly through its synchronous callback', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'flat-policy-lock-'));
  const tasks = new TaskService(join(directory, 'tasks.sqlite'));
  const other = new TaskService(join(directory, 'tasks.sqlite'));
  other.db.exec('PRAGMA busy_timeout = 0');
  t.after(async () => { other.close(); tasks.close(); await rm(directory, { recursive: true, force: true }); });
  tasks.createMission({ mission_id: 'm', goal: 'Verify synchronous model admission ordering' }, makeEnvelope({ actorRef: 'host' }));
  const deadline = Date.now() + 10_000;
  tasks.registerBot({ botId: 'b', missionId: 'm', legacySlotId: 'slot', selectionDeadline: new Date(deadline).toISOString() }); tasks.markCoreBotReady('b');
  const policy = createTaskPoolModelAccessPolicy({ runtimeId: 'r', taskService: tasks, missionId: 'm', deadline: () => deadline });
  let calls = 0;
  const result = policy.withCommit(() => {
    calls++;
    assert.equal(policy.authorize({ runtimeId: 'r', botId: 'b', profile: 'readonly', model: 'default' }).phase, 'selection');
    assert.throws(() => other.requestBotStop('b', 'concurrent-stop'), /locked|busy/);
    return 'dispatched-before-stop';
  });
  assert.equal(result, 'dispatched-before-stop'); assert.equal(calls, 1);
  other.requestBotStop('b', 'after-window-stop');
  assert.equal(policy.authorize({ runtimeId: 'r', botId: 'b', profile: 'readonly', model: 'default' }), null);
});

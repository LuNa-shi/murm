import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskService } from '../src/task/task-service.js';
import { RemoteJudgeService } from '../src/sdk/remote-judge-service.js';
import { makeEnvelope } from '../src/protocol/envelope.js';
const fixtureManifest = { fixture_id: 'remote-judge', putnambench_commit: 'a'.repeat(40), problem_file: 'input.lean',
  problem_file_hash: 'b'.repeat(64), lean_toolchain: 'leanprover/lean4:v4.33.1', mathlib_version: 'fixture',
  checker_ref: 'lean', checker_version: 'fixture', environment_ref: 'fixture' };

for (const closeDuringPreflight of [false, true]) test(`independent Judge preserves lifecycle authority (close during preflight: ${closeDuringPreflight})`, { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'remote-judge-'));
  const tasks = new TaskService(join(root, 'task.sqlite'));
  const token = 'private-judge-coordinator-test-token';
  const judge = new RemoteJudgeService({ taskService: tasks, token, timeoutMs: 10000 });
  const coordinator = await judge.startCoordinator();
  const child = spawn('flock', ['--nonblock', '--no-fork', join(root, 'judge.lock'), process.execPath, 'test-support/judge-peer-fixture.mjs'], {
    env: { ...process.env, JUDGE_PEER_FIXTURE: JSON.stringify({ database: join(root, 'judge.sqlite'), token,
      coordinator: { url: coordinator.url, token }, fixtureManifest, preflightDelay: closeDuringPreflight ? 500 : 0 }) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => { await judge.close(); const done = once(child, 'exit'); child.kill(); await done; tasks.close(); await rm(root, { recursive: true, force: true }); });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const endpoint = await new Promise((resolve, reject) => {
    child.once('exit', code => reject(new Error(`Judge exited ${code}: ${errors}`)));
    child.stdout.once('data', chunk => resolve(JSON.parse(chunk.toString())));
  });
  judge.connect(endpoint.url);
  tasks.createMission({ mission_id: 'mission:one', goal: 'Investigate one question' }, makeEnvelope({ actorRef: 'operator:test' }));
  tasks.registerBot({ botId: 'bot:one', missionId: 'mission:one', coreId: 'core:one', selectionDeadline: new Date(Date.now() + 60_000).toISOString() });
  tasks.recordBotSandbox('bot:one', { provider: 'controlled', sandboxId: 'sandbox:one' });
  tasks.markBotReady('bot:one');
  const task = tasks.createTask({ mission_id: 'mission:one', summary: 'Investigate a bounded question', expected_output: 'A Material with evidence', acceptance_conditions: ['Explain the finding'] }, makeEnvelope({ actorRef: 'bot:one' })).task;
  const taken = tasks.takeTask(task.task_id, { owner_ref: 'bot:one', core_id: 'core:one', take_key: 'take:one' });
  const env = id => {
    const e = tasks.getExecution(taken.execution.execution_id);
    return makeEnvelope({ operationId: id, actorRef: 'bot:one', taskId: task.task_id, executionId: e.execution_id,
      specVersion: e.spec_version, stateVersion: e.state_version, fencingVersion: e.fencing_version });
  };
  tasks.dispatch('start_execution', {}, env('start'));
  const input = { request_key: 'check:one', source: { workspace_id: 'workspace:one', revision: '0.1', path: 'Main.lean',
    git_commit: 'c'.repeat(40), git_tree: 'd'.repeat(40), content: 'example : True := by trivial' } };
  const checking = judge.dispatch('workspace_check', input, env('check:one'));
  if (closeDuringPreflight) {
    for (let attempt = 0; judge.getMissionCheckBudget('mission:one').preflight_process_starts !== 1; attempt++) {
      assert.ok(attempt < 100); await delay(10);
    }
    tasks.dispatch('task_finish', { outcome: 'incomplete' }, env('finish'));
    const rejected = await checking;
    assert.equal(rejected.result_class, 'request_failure');
    assert.equal(judge.getMissionCheckBudget('mission:one').source_process_starts, 0);
    return;
  }
  const result = await checking;
  assert.equal(result.verdict, 'PASS');
  assert.equal(judge.getCheckResult(result.check_result_id).verdict, 'PASS');
  assert.equal(judge.getMissionCheckBudget('mission:one').source_process_starts, 1);
  tasks.dispatch('task_finish', { outcome: 'incomplete' }, env('finish'));
  const replay = await judge.dispatch('workspace_check', input, env('check:one'));
  assert.equal(replay.check_result_id, result.check_result_id);
  assert.equal(judge.getMissionCheckBudget('mission:one').source_process_starts, 1);
});

async function queuedJudge(t, { sourceDelay = 1200, missionBudget, interruptQueueAuthority = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'remote-judge-queue-'));
  const tasks = new TaskService(join(root, 'task.sqlite'));
  const token = 'private-queue-coordinator-test-token';
  const judge = new RemoteJudgeService({ taskService: tasks, token, timeoutMs: 10000 });
  const coordinator = await judge.startCoordinator();
  let interruptedQueueRefreshes = 0;
  const proxy = interruptQueueAuthority ? createServer(async (incoming, response) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    if (JSON.parse(body.toString()).input?.action === 'queue_status' && interruptedQueueRefreshes === 0) {
      interruptedQueueRefreshes++;
      incoming.socket.destroy();
      return;
    }
    const forwarded = httpRequest(new URL(incoming.url, coordinator.url), {
      method: incoming.method, headers: incoming.headers,
    }, upstream => {
      response.writeHead(upstream.statusCode, upstream.headers);
      upstream.pipe(response);
    });
    forwarded.on('error', () => response.destroy());
    forwarded.end(body);
  }) : null;
  if (proxy) { proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening'); }
  const coordinatorUrl = proxy ? `http://127.0.0.1:${proxy.address().port}` : coordinator.url;
  const child = spawn('flock', ['--nonblock', '--no-fork', join(root, 'judge.lock'), process.execPath, 'test-support/judge-peer-fixture.mjs'], {
    env: { ...process.env, JUDGE_PEER_FIXTURE: JSON.stringify({ database: join(root, 'judge.sqlite'), token,
      coordinator: { url: coordinatorUrl, token }, fixtureManifest, sourceDelay, processTimeoutMs: 5000, missionBudget }) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    await judge.close();
    if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    tasks.close();
    await rm(root, { recursive: true, force: true });
  });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const endpoint = await new Promise((resolve, reject) => {
    let output = '';
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Judge exited ${code}: ${errors}`)));
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('\n')) resolve(JSON.parse(output.split('\n')[0]));
    });
  });
  judge.connect(endpoint.url);
  tasks.createMission({ mission_id: 'mission:queue', goal: 'Investigate queued checks' }, makeEnvelope({ actorRef: 'operator:test' }));
  tasks.registerBot({ botId: 'bot:queue', missionId: 'mission:queue', coreId: 'core:queue', selectionDeadline: new Date(Date.now() + 60000).toISOString() });
  tasks.recordBotSandbox('bot:queue', { provider: 'controlled', sandboxId: 'sandbox:queue' });
  tasks.markBotReady('bot:queue');
  const task = tasks.createTask({ mission_id: 'mission:queue', summary: 'Check fixed revisions', expected_output: 'Checked source',
    acceptance_conditions: ['Record checker results'] }, makeEnvelope({ actorRef: 'bot:queue' })).task;
  const taken = tasks.takeTask(task.task_id, { owner_ref: 'bot:queue', core_id: 'core:queue', take_key: 'take:queue' });
  const envelope = operationId => {
    const e = tasks.getExecution(taken.execution.execution_id);
    return makeEnvelope({ operationId, actorRef: 'bot:queue', taskId: task.task_id, executionId: e.execution_id,
      specVersion: e.spec_version, stateVersion: e.state_version, fencingVersion: e.fencing_version });
  };
  tasks.dispatch('start_execution', {}, envelope('start:queue'));
  const submit = (revision, requestKey = `check:queue:${revision}`) => judge.dispatch('workspace_check', {
    request_key: requestKey, source: { workspace_id: 'workspace:queue', revision: `0.${revision}`, path: 'Main.lean',
      git_commit: revision.toString(16).padStart(40, '0'), git_tree: revision.toString(16).padStart(40, '1'),
      content: `example : True := by trivial\n-- revision ${revision}` },
  }, envelope(requestKey));
  const budget = () => judge.getMissionCheckBudget('mission:queue');
  const until = async predicate => {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, 'Judge did not reach the expected observable queue state');
      await delay(10);
    }
  };
  return { tasks, judge, envelope, submit, budget, until, interruptedQueueRefreshes: () => interruptedQueueRefreshes };
}

for (const finishWhileQueued of [false, true]) test(`independent Judge bounds four active checks and one queued check (finish: ${finishWhileQueued})`, { timeout: 15000 }, async t => {
  const service = await queuedJudge(t, { sourceDelay: finishWhileQueued ? 3000 : 1800, missionBudget: { maxConcurrent: 4, maxQueued: 1, queueWaitMs: 900_000 } });
  const { tasks, judge, envelope, submit, budget, until } = service;
  const running = [1, 2, 3, 4].map(revision => submit(revision));
  await until(() => budget().source_process_starts === 4);
  const queued = submit(5);
  const queuedOutcome = queued.then(result => ({ result }), error => ({ error }));
  await until(() => budget().queued_requests === 1);
  assert.equal(budget().active_requests, 4);
  assert.equal(budget().source_process_starts, 4);
  const replay = await submit(5);
  assert.equal(replay.status, 'REQUESTED');
  assert.equal(budget().admitted_requests, 5);
  await assert.rejects(submit(6), { code: 'CHECKER_BUSY', retryable: true });
  assert.equal(budget().admitted_requests, 5);
  if (finishWhileQueued) {
    assert.equal(tasks.dispatch('task_finish', { outcome: 'incomplete' }, envelope('finish:queued')).execution.state, 'CLOSING');
    assert.equal(judge.gate.pending(), null);
    const waitingAt = Date.now();
    const cancelled = await queuedOutcome;
    assert.equal(cancelled.result?.diagnostic_code, 'NOT_ALLOWED');
    assert.equal(cancelled.result?.result_class, 'request_failure');
    assert.equal(cancelled.result?.checker_process_status, 'not_started');
    assert.ok(Date.now() - waitingAt < 1500, 'Closed Execution must settle its queued request before a running checker frees a slot');
    assert.equal(budget().active_requests, 4);
    assert.equal(budget().queued_requests, 0);
    assert.equal(budget().source_process_starts, 4);
  }
  const first = await Promise.all(running);
  assert.ok(first.every(result => result.verdict === 'PASS'));
  const outcome = await queuedOutcome;
  const result = finishWhileQueued ? judge.getByRequestKey('check:queue:5') : outcome.result;
  assert.equal(result.check_result_id, replay.check_result_id);
  assert.equal(result.result_class, finishWhileQueued ? 'request_failure' : 'PASS');
  assert.equal(budget().source_process_starts, finishWhileQueued ? 4 : 5);
  assert.equal(budget().preflight_process_starts, finishWhileQueued ? 4 : 5);
  assert.equal(budget().queued_requests, 0);
  assert.equal(budget().active_requests, 0);
  assert.equal((await submit(5)).check_result_id, result.check_result_id);
  assert.equal(budget().admitted_requests, 5);
});

test('independent Judge queue timeout persists its receipt and permits a new request after capacity returns', { timeout: 15000 }, async t => {
  const { submit, budget, until, judge } = await queuedJudge(t, {
    sourceDelay: 800, missionBudget: { maxConcurrent: 1, maxQueued: 1, queueWaitMs: 150 },
  });
  const running = submit(1);
  await until(() => budget().source_process_starts === 1);
  const queued = submit(2);
  await assert.rejects(queued, { code: 'CHECKER_BUSY', retryable: true });
  const receipt = await submit(2);
  assert.equal(receipt.diagnostic_code, 'CHECKER_BUSY');
  assert.equal(receipt.checker_process_status, 'not_started');
  assert.equal(budget().source_process_starts, 1);
  assert.equal(budget().queued_requests, 0);
  assert.equal(judge.gate.pending(), null);
  await running;
  const retried = await submit(2, 'check:queue:2:retry');
  assert.equal(retried.verdict, 'PASS');
  assert.notEqual(retried.check_result_id, receipt.check_result_id);
  assert.equal(budget().source_process_starts, 2);
});

test('independent Judge refreshes queued authority after the owning Execution heartbeat renews its lease', { timeout: 15000 }, async t => {
  const { tasks, envelope, submit, budget, until } = await queuedJudge(t, {
    sourceDelay: 1500, missionBudget: { maxConcurrent: 1, maxQueued: 1, queueWaitMs: 5000 },
  });
  const running = submit(1);
  await until(() => budget().source_process_starts === 1);
  const oldDeadline = Date.now() + 800;
  tasks.dispatch('heartbeat', { lease_expires_at: new Date(oldDeadline).toISOString() }, envelope('short-lease'));
  const queued = submit(2);
  await until(() => budget().queued_requests === 1);
  tasks.dispatch('heartbeat', { lease_expires_at: new Date(Date.now() + 30000).toISOString() }, envelope('renew-lease'));
  await running;
  assert.ok(Date.now() > oldDeadline, 'The queued request must outlive its original authority lease');
  assert.equal((await queued).verdict, 'PASS');
  assert.equal(budget().source_process_starts, 2);
});


test('independent Judge permits retry after queued authority refresh transport failure', { timeout: 15000 }, async t => {
  const { submit, budget, until, judge, interruptedQueueRefreshes } = await queuedJudge(t, {
    sourceDelay: 800, interruptQueueAuthority: true,
    missionBudget: { maxConcurrent: 1, maxQueued: 1, queueWaitMs: 5000 },
  });
  const running = submit(1);
  await until(() => budget().source_process_starts === 1);
  await assert.rejects(submit(2), { code: 'SERVICE_UNAVAILABLE', retryable: true });
  assert.equal(interruptedQueueRefreshes(), 1);
  const receipt = await submit(2);
  assert.equal(receipt.diagnostic_code, 'SERVICE_UNAVAILABLE');
  assert.equal(receipt.retryable, true);
  assert.equal(receipt.checker_process_status, 'not_started');
  assert.equal(budget().source_process_starts, 1);
  assert.equal(budget().queued_requests, 0);
  assert.equal(judge.gate.pending(), null);
  await running;
  const retried = await submit(2, 'check:queue:2:after-transport-recovery');
  assert.equal(retried.verdict, 'PASS');
  assert.notEqual(retried.check_result_id, receipt.check_result_id);
  assert.equal((await submit(2)).check_result_id, receipt.check_result_id);
  assert.equal(budget().source_process_starts, 2);
});

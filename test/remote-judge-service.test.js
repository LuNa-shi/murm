import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
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

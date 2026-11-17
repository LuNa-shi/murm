import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { JudgeService } from '../src/judge/judge-service.js';
import { makeEnvelope } from '../src/protocol/envelope.js';

const fixtureManifest = { fixture_id: 'budget', putnambench_commit: 'a'.repeat(40), problem_file: 'input.lean',
  problem_file_hash: 'b'.repeat(64), lean_toolchain: 'leanprover/lean4:v4.33.1', mathlib_version: 'fixture',
  checker_ref: 'lean', checker_version: 'fixture', environment_ref: 'fixture' };

test('Mission Judge reservations span independent connections, preflight, and unresolved checker work', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'judge-mission-budget-'));
  const taskDb = new DatabaseSync(join(dir, 'task.sqlite'));
  const judgePath = join(dir, 'judge.sqlite');
  taskDb.exec('CREATE TABLE execution_gate (permitted INTEGER); INSERT INTO execution_gate VALUES (1)');
  const execution = { execution_id: 'execution:one', task_id: 'task:one', owner_ref: 'bot:one', state_version: 1, state: 'RUNNING',
    handoff_deadline: new Date(Date.now() + 60_000).toISOString(), execution_deadline: new Date(Date.now() + 120_000).toISOString() };
  const taskService = {
    db: taskDb,
    getBot: () => true,
    getExecution: () => execution,
    materialScope: () => {
      assert.equal(taskDb.prepare('SELECT permitted FROM execution_gate').get().permitted, 1);
      return { mission_id: 'mission:one' };
    },
    assertMissionResearchOpen() {},
    withServiceLifecycleWrite(perform) {
      taskDb.exec('BEGIN IMMEDIATE');
      try { return perform(); }
      finally { taskDb.exec('COMMIT'); }
    },
  };
  const inSource = Promise.withResolvers();
  const finishSource = Promise.withResolvers();
  let calls = 0;
  const checker = {
    timeoutMs: 1000,
    preflight: ({ startProcess }) => startProcess(async () => ({ status: 'healthy', checker_process_status: 'completed',
      evidence: { input_binding_verified: true, toolchain_version_verified: true, checker_version_verified: true } })),
    check: ({ startProcess }) => startProcess(() => {
      calls++;
      inSource.resolve();
      return finishSource.promise;
    }),
  };
  const options = { checker, fixtureManifest, taskService, missionBudget: { maxConcurrent: 1, maxQueued: 0 } };
  const first = new JudgeService(judgePath, options);
  const second = new JudgeService(judgePath, options);
  t.after(async () => { finishSource.resolve({ verdict: 'FAIL', evidence: { checker_started: true } }); await first.waitForIdle(); await second.waitForIdle(); first.close(); second.close(); taskDb.close(); await rm(dir, { recursive: true }); });
  const submit = (judge, request, revision) => judge.checkWorkspaceSource({ request_key: request, source: {
    workspace_id: 'workspace', revision: String(revision), path: 'result.lean', git_commit: String(revision).padStart(40, '0'),
    git_tree: String(revision).padStart(40, '0'), content: `theorem result${revision} : True := by trivial`,
  } }, makeEnvelope({ operationId: request, actorRef: 'bot:one', executionId: execution.execution_id,
    taskId: execution.task_id, stateVersion: 1, specVersion: 1, fencingVersion: 1 }));
  const running = submit(first, 'pending', 1);
  await inSource.promise;
  const receipt = await submit(second, 'pending', 1);
  assert.equal(receipt.status, 'RUNNING');
  await assert.rejects(submit(second, 'different', 2), { code: 'CHECKER_BUSY', retryable: true });
  assert.equal(second.getMissionCheckBudget('mission:one').max_requests, null);
  assert.equal(second.getMissionCheckBudget('mission:one').active_requests, 1);
  finishSource.resolve({ verdict: 'FAIL', evidence: { checker_started: true, exit_code: 1 } });
  await running;
  assert.equal((await submit(second, 'cached', 1)).check_result_id, receipt.check_result_id);
  await submit(second, 'different', 2);
  for (let revision = 3; revision <= 25; revision++) await submit(first, `request-${revision}`, revision);
  assert.equal(first.getMissionCheckBudget('mission:one').active_requests, 0);
  assert.equal(first.getMissionCheckBudget('mission:one').cached_request_aliases, 1);
  assert.equal(calls, 25);
});

test('Judge runs four checks and queues FIFO without consuming cumulative quota', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'judge-queue-'));
  const taskDb = new DatabaseSync(':memory:');
  const execution = { execution_id: 'execution:queue', task_id: 'task:queue', owner_ref: 'bot:queue', state_version: 1,
    state: 'RUNNING', handoff_deadline: new Date(Date.now() + 60_000).toISOString(), execution_deadline: new Date(Date.now() + 120_000).toISOString() };
  const taskService = { db: taskDb, getBot: () => true, getExecution: () => execution,
    materialScope: () => ({ mission_id: 'mission:queue' }), assertMissionResearchOpen() {},
    withServiceLifecycleWrite: perform => perform() };
  const releases = []; const started = [];
  const checker = { timeoutMs: 1000,
    preflight: ({ startProcess }) => startProcess(async () => ({ status: 'healthy', checker_process_status: 'completed',
      evidence: { input_binding_verified: true, toolchain_version_verified: true, checker_version_verified: true } })),
    check: ({ startProcess, workspace_source }) => startProcess(() => {
      started.push(workspace_source.content);
      const release = Promise.withResolvers(); releases.push(release);
      return release.promise;
    }) };
  const judge = new JudgeService(join(dir, 'judge.sqlite'), { checker, fixtureManifest, taskService, missionBudget: { maxQueued: 2 } });
  const pending = [];
  t.after(async () => {
    for (const release of releases) release.resolve({ verdict: 'PASS' });
    await Promise.allSettled(pending); await judge.waitForIdle(); judge.close(); taskDb.close(); await rm(dir, { recursive: true });
  });
  const submit = n => judge.checkWorkspaceSource({ request_key: `queue-${n}`, source: { content: `theorem q${n} : True := by trivial` } },
    makeEnvelope({ operationId: `queue-${n}`, actorRef: 'bot:queue', executionId: execution.execution_id, taskId: execution.task_id, specVersion: 1, stateVersion: 1 }));
  const waitUntil = async predicate => {
    for (let i = 0; i < 200 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(predicate(), 'expected queue progress');
  };
  for (let n = 0; n < 4; n++) pending.push(submit(n));
  await waitUntil(() => started.length === 4);
  pending.push(submit(4)); pending.push(submit(5));
  // Observe rejections immediately so a red test cannot leak an unhandled rejection.
  for (const work of pending) work.catch(() => {});
  await waitUntil(() => judge.getMissionCheckBudget('mission:queue').queued_requests === 2);
  assert.equal((await submit(4)).check_result_id, judge.getByRequestKey('queue-4').check_result_id);
  await assert.rejects(submit(6), { code: 'CHECKER_BUSY', retryable: true });
  assert.equal(started.length, 4);
  releases[0].resolve({ verdict: 'PASS' });
  await waitUntil(() => started.length === 5);
  assert.match(started[4], /q4/);
  releases[1].resolve({ verdict: 'PASS' });
  await waitUntil(() => started.length === 6);
  assert.match(started[5], /q5/);
  for (const release of releases) release.resolve({ verdict: 'PASS' });
  await Promise.all(pending);
  assert.equal(judge.getMissionCheckBudget('mission:queue').active_requests, 0);
  assert.equal(judge.getMissionCheckBudget('mission:queue').queued_requests, 0);
});

test('Judge preserves historical finite policy while migrating old stores', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'judge-policy-migration-'));
  const path = join(dir, 'judge.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE judge_mission_check_policies (
    mission_id TEXT PRIMARY KEY, max_requests INTEGER NOT NULL CHECK(max_requests > 0),
    max_concurrent INTEGER NOT NULL CHECK(max_concurrent > 0 AND max_concurrent <= max_requests), process_timeout_ms INTEGER);
    INSERT INTO judge_mission_check_policies VALUES ('historical', 20, 2, 120000);
    CREATE TABLE judge_mission_check_admissions (mission_id TEXT NOT NULL, check_result_id TEXT NOT NULL,
      admitted_at TEXT NOT NULL, is_retry INTEGER NOT NULL DEFAULT 0, preflight_starts INTEGER NOT NULL DEFAULT 0,
      source_starts INTEGER NOT NULL DEFAULT 0, settled_at TEXT, PRIMARY KEY(mission_id, check_result_id));
    INSERT INTO judge_mission_check_admissions (mission_id, check_result_id, admitted_at) VALUES ('historical', 'old-active', '2026-11-16T00:00:00Z');`);
  legacy.close();
  const judge = new JudgeService(path);
  t.after(async () => { judge.close(); await rm(dir, { recursive: true }); });
  const historical = judge.getMissionCheckBudget('historical');
  assert.equal(historical.max_requests, 20);
  assert.equal(historical.active_requests, 1);
  assert.equal(historical.queued_requests, 0);
  assert.equal(judge.getMissionCheckBudget('new').max_requests, null);
  assert.equal(judge.getMissionCheckBudget('new').max_concurrent, 4);
  assert.throws(() => new JudgeService(':memory:', { missionBudget: { maxRequests: 20 } }), /no longer support/);
});

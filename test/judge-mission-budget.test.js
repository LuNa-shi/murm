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
  const options = { checker, fixtureManifest, taskService, missionBudget: { maxRequests: 2, maxConcurrent: 1 } };
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
  assert.deepEqual({ ...second.getMissionCheckBudget('mission:one') }, { max_requests: 2, max_concurrent: 1,
    process_timeout_ms: 1000, upper_bound_process_ms: 4000, admitted_requests: 1, active_requests: 1, retry_requests: 0,
    preflight_process_starts: 1, source_process_starts: 1, cached_request_aliases: 0 });
  finishSource.resolve({ verdict: 'FAIL', evidence: { checker_started: true, exit_code: 1 } });
  await running;
  assert.equal((await submit(second, 'cached', 1)).check_result_id, receipt.check_result_id);
  await submit(second, 'different', 2);
  await assert.rejects(submit(first, 'over-limit', 3), { code: 'CHECKER_BUDGET_EXHAUSTED', retryable: false });
  assert.equal(first.getMissionCheckBudget('mission:one').active_requests, 0);
  assert.equal(first.getMissionCheckBudget('mission:one').cached_request_aliases, 1);
  assert.equal(calls, 2);
});

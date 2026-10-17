import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import {
  ERROR_CODES,
  JudgeService,
  LeanChecker,
  SwarmEnvError,
  makeEnvelope,
  validateFixtureManifest,
} from '../src/index.js';

const fixtureManifest = {
  fixture_id: 'putnam-1966-a1',
  putnambench_commit: 'a635813f5edf297d928f9bd5ef8324a26bdde09c',
  problem_file: 'lean4/src/putnam_1966_a1.lean',
  problem_file_hash: '4b1bd530669e71e5909398d54caddeb65eb33a708850e25ba4f1d7fc88ba0cad',
  lean_toolchain: 'leanprover/lean4:v4.33.1',
  mathlib_version: '0df444a360eaa60ab8c11dca51a86af692955474',
  checker_ref: 'lean',
  checker_version: 'mvp-1',
  environment_ref: 'putnambench-lean4@a635813f5edf297d928f9bd5ef8324a26bdde09c',
};

const targetTask = { task_id: 'task-proof', spec_version: 1, spec_hash: 'spec-hash' };
const initialContext = { input_snapshot_hash: 'input-snapshot' };

function candidate(content, materialId = 'material-1') {
  return { material_id: materialId, content };
}

test('fixture manifest locks PutnamBench commit, problem hash, Lean, Mathlib, checker, and environment', async () => {
  validateFixtureManifest(fixtureManifest);
  const source = await readFile('fixtures/putnam-1966-a1/putnam_1966_a1.lean');
  assert.equal(source.length, 539);
  assert.equal(fixtureManifest.problem_file_hash, '4b1bd530669e71e5909398d54caddeb65eb33a708850e25ba4f1d7fc88ba0cad');
  assert.equal(fixtureManifest.putnambench_commit.length, 40);
});

test('Lean checker returns PASS only for a clean zero exit and preserves failure evidence', async () => {
  const calls = [];
  const checker = new LeanChecker({
    runner: async (command, args, options) => {
      calls.push({ command, args, options });
      return calls.length === 1
        ? { exit_code: 0, signal: null, stdout: 'compiled', stderr: '' }
        : { exit_code: 1, signal: null, stdout: '', stderr: 'type mismatch' };
    },
  });
  const pass = await checker.check({ candidate: candidate('import Mathlib\ntheorem ok : True := by trivial'), targetTask, initialContext, fixtureManifest });
  assert.equal(pass.verdict, 'PASS');
  assert.match(pass.evidence.candidate_hash, /^[0-9a-f]{64}$/);
  const fail = await checker.check({ candidate: candidate('import Mathlib\ntheorem bad : True := by exact nope', 'material-2'), targetTask, initialContext, fixtureManifest });
  assert.equal(fail.verdict, 'FAIL');
  assert.match(fail.evidence.diagnostic, /type mismatch/);
  assert.equal(calls[0].args[0], 'env');
  assert.equal(calls[0].args[1], 'lean');

  const timedOut = new LeanChecker({ runner: async () => ({ exit_code: null, signal: 'SIGKILL', stdout: '', stderr: '', timed_out: true }) });
  const timeoutResult = await timedOut.check({ candidate: candidate('theorem timed : True := by trivial'), targetTask, initialContext, fixtureManifest });
  assert.equal(timeoutResult.verdict, 'ERROR');
  assert.match(timeoutResult.evidence.diagnostic, /timed out/);

  const unavailable = new LeanChecker({ runner: async () => ({ exit_code: null, signal: null, stdout: '', stderr: '', error: 'lake: command not found' }) });
  const errorResult = await unavailable.check({ candidate: candidate('theorem unavailable : True := by trivial'), targetTask, initialContext, fixtureManifest });
  assert.equal(errorResult.verdict, 'ERROR');
  assert.match(errorResult.evidence.diagnostic, /command not found/);
});

test('JudgeService stores CheckResult truth, keeps Task untouched, and deduplicates request keys', async () => {
  let checks = 0;
  const judge = new JudgeService(new DatabaseSync(':memory:'), {
    checker: { check: async () => { checks += 1; return { verdict: 'PASS', evidence: { exit_code: 0, stdout: 'ok', stderr: '', candidate_hash: 'candidate-hash', input_snapshot_hash: 'input-snapshot' } }; } },
  });
  const input = {
    request_key: 'check-request-1', candidate_material_id: 'material-1', target_task_id: targetTask.task_id, target_spec_version: 1,
    input_snapshot_hash: initialContext.input_snapshot_hash, checker_ref: fixtureManifest.checker_ref, checker_version: fixtureManifest.checker_version,
    environment_ref: fixtureManifest.environment_ref, candidate: candidate('import Mathlib\ntheorem ok : True := by trivial'), target_task: targetTask,
    initial_context: initialContext, fixture_manifest: fixtureManifest,
  };
  const first = await judge.judgeCandidate(input, { operationId: 'judge-op-1' });
  assert.equal(first.status, 'RECEIVED');
  assert.equal(first.verdict, 'PASS');
  assert.equal(checks, 1);
  const replay = await judge.judgeCandidate(input, { operationId: 'judge-op-2' });
  assert.equal(replay.check_result_id, first.check_result_id);
  assert.equal(checks, 1, 'same request_key must not run Lean twice');
  assert.equal(judge.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get(), undefined);
  await assert.rejects(
    () => judge.judgeCandidate({ ...input, candidate_material_id: 'material-2', candidate: candidate('changed', 'material-2') }, { operationId: 'judge-op-3' }),
    (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.CONFLICT,
  );
  judge.close();
});

test('concurrent checks for one request_key elect one checker invocation', async () => {
  let checks = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const judge = new JudgeService(new DatabaseSync(':memory:'), {
    checker: { check: async () => { checks += 1; await gate; return { verdict: 'PASS', evidence: { exit_code: 0 } }; } },
  });
  const input = {
    request_key: 'concurrent-check', candidate_material_id: 'material-1', target_task_id: targetTask.task_id, target_spec_version: 1,
    input_snapshot_hash: initialContext.input_snapshot_hash, checker_ref: fixtureManifest.checker_ref, checker_version: fixtureManifest.checker_version,
    environment_ref: fixtureManifest.environment_ref, candidate: candidate('theorem concurrent : True := by trivial'), target_task: targetTask,
    initial_context: initialContext, fixture_manifest: fixtureManifest,
  };
  const firstPromise = judge.judgeCandidate(input, { operationId: 'concurrent-1' });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await judge.judgeCandidate(input, { operationId: 'concurrent-2' });
  assert.equal(second.status, 'RUNNING');
  assert.equal(checks, 1);
  release();
  const first = await firstPromise;
  assert.equal(first.status, 'RECEIVED');
  assert.equal(first.check_result_id, second.check_result_id);
  judge.close();
});

test('Judge rejects results whose frozen Task or Initial Context binding has drifted', async () => {
  const judge = new JudgeService(new DatabaseSync(':memory:'), {
    checker: { check: async () => ({ verdict: 'PASS', evidence: {} }) },
  });
  const input = {
    request_key: 'binding-check', candidate_material_id: 'material-1', target_task_id: targetTask.task_id, target_spec_version: 1,
    input_snapshot_hash: initialContext.input_snapshot_hash, checker_ref: fixtureManifest.checker_ref, checker_version: fixtureManifest.checker_version,
    environment_ref: fixtureManifest.environment_ref, candidate: candidate('theorem ok : True := by trivial'), target_task: targetTask,
    initial_context: initialContext, fixture_manifest: fixtureManifest,
  };
  await assert.rejects(
    () => judge.judgeCandidate({ ...input, target_task: { ...targetTask, spec_version: 2 } }, { operationId: 'drifted-task' }),
    (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.INVALID_CONTRACT,
  );
  await assert.rejects(
    () => judge.judgeCandidate({ ...input, initial_context: { input_snapshot_hash: 'different-input' } }, { operationId: 'drifted-input' }),
    (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.INVALID_CONTRACT,
  );
  judge.close();
});

test('Judge operation replay and mismatched fixture bindings are explicit', async () => {
  const judge = new JudgeService(new DatabaseSync(':memory:'));
  const payload = {
    request_key: 'submitted-1', candidate_material_id: 'material-1', target_task_id: 'task-proof', target_spec_version: 1,
    input_snapshot_hash: 'input-snapshot', checker_ref: 'lean', checker_version: 'mvp-1', environment_ref: fixtureManifest.environment_ref,
    candidate: candidate('x'), target_task: targetTask, initial_context: initialContext, fixture_manifest: fixtureManifest,
    status: 'RECEIVED', verdict: 'FAIL', evidence: { exit_code: 1, diagnostic: 'bad proof' },
  };
  const envelope = makeEnvelope({ operationId: 'submit-1', actorRef: 'judge:lean', taskId: 'task-proof', specVersion: 1 });
  const first = judge.dispatch('submit_check_result', payload, envelope);
  const replay = judge.dispatch('submit_check_result', payload, envelope);
  assert.equal(replay.check_result_id, first.check_result_id);
  assert.equal(first.verdict, 'FAIL');
  assert.throws(
    () => judge.dispatch('submit_check_result', { ...payload, candidate_material_id: 'material-2', candidate: candidate('changed', 'material-2') }, makeEnvelope({ operationId: 'submit-2', actorRef: 'judge:lean', taskId: 'task-proof', specVersion: 1 })),
    (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.CONFLICT,
  );
  await assert.rejects(
    () => judge.judgeCandidate({ ...payload, request_key: 'bad-binding', checker_version: 'different' }),
    (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.INVALID_CONTRACT,
  );
  judge.close();
});

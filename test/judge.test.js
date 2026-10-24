import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
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
const workspace = { input_snapshot_hash: 'input-snapshot' };

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
  const pass = await checker.check({ candidate: candidate('import Mathlib\ntheorem ok : True := by trivial'), targetTask, workspace, fixtureManifest });
  assert.equal(pass.verdict, 'PASS');
  assert.match(pass.evidence.candidate_hash, /^[0-9a-f]{64}$/);
  const fail = await checker.check({ candidate: candidate('import Mathlib\ntheorem bad : True := by exact nope', 'material-2'), targetTask, workspace, fixtureManifest });
  assert.equal(fail.verdict, 'FAIL');
  assert.match(fail.evidence.diagnostic, /type mismatch/);
  assert.equal(calls[0].args[0], 'env');
  assert.equal(calls[0].args[1], 'lean');

  const timedOut = new LeanChecker({ runner: async () => ({ exit_code: null, signal: 'SIGKILL', stdout: '', stderr: '', timed_out: true }) });
  const timeoutResult = await timedOut.check({ candidate: candidate('theorem timed : True := by trivial'), targetTask, workspace, fixtureManifest });
  assert.equal(timeoutResult.verdict, 'ERROR');
  assert.match(timeoutResult.evidence.diagnostic, /timed out/);

  const unavailable = new LeanChecker({ runner: async () => ({ exit_code: null, signal: null, stdout: '', stderr: '', error: 'lake: command not found' }) });
  const errorResult = await unavailable.check({ candidate: candidate('theorem unavailable : True := by trivial'), targetTask, workspace, fixtureManifest });
  assert.equal(errorResult.verdict, 'ERROR');
  assert.match(errorResult.evidence.diagnostic, /command not found/);
});

test('Checker result contract distinguishes source failure from a checker that never started', async () => {
  const unavailable = new LeanChecker({
    runner: async () => ({ exit_code: null, signal: null, error: 'spawn lake ENOENT', error_code: 'ENOENT', checker_started: false }),
  });
  const result = await unavailable.check({ candidate: candidate('theorem unavailable : True := by trivial'), targetTask, workspace, fixtureManifest });
  assert.equal(result.verdict, 'ERROR');
  assert.equal(result.checker_process_status, 'not_started');
  assert.equal(result.result_class, 'infrastructure_failure');
  assert.equal(result.mathematical_outcome, 'unassessed');
  assert.equal(result.retryable, true);
  assert.equal(result.diagnostic_code, 'checker_unavailable');

  const sourceFailure = new LeanChecker({
    runner: async () => ({ exit_code: 1, signal: null, stdout: '', stderr: 'type mismatch', checker_started: true }),
  });
  const failed = await sourceFailure.check({ candidate: candidate('theorem bad : True := by exact nope'), targetTask, workspace, fixtureManifest });
  assert.equal(failed.verdict, 'FAIL');
  assert.equal(failed.checker_process_status, 'completed');
  assert.equal(failed.result_class, 'source_failure');
  assert.equal(failed.mathematical_outcome, 'FAIL');
  assert.equal(failed.retryable, false);

  const rejected = await new LeanChecker({ runner: async () => ({ exit_code: 0, checker_started: true }) }).check({ candidate: candidate('theorem rejected : True := by sorry'), targetTask, workspace, fixtureManifest });
  assert.equal(rejected.result_class, 'request_failure');
  assert.equal(rejected.diagnostic_code, 'checker_request_rejected');
  assert.equal(rejected.mathematical_outcome, 'unassessed');
});

test('Lean checker preflight reports an unavailable executable before proof checking', async () => {
  const root = await mkdtemp('/tmp/swarmenv-checker-missing-executable-');
  const projectRoot = join(root, 'lean4');
  const problemPath = join(projectRoot, 'src', 'putnam_1966_a1.lean');
  const source = await readFile('fixtures/putnam-1966-a1/putnam_1966_a1.lean');
  try {
    await mkdir(join(projectRoot, 'src'), { recursive: true });
    await writeFile(problemPath, source);
    const manifest = { ...fixtureManifest, project_root: projectRoot, problem_file_hash: createHash('sha256').update(source).digest('hex') };
    const checker = new LeanChecker({ command: '/definitely-missing-swarmenv-checker' });
    const result = await checker.preflight({ fixtureManifest: manifest });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.checker_process_status, 'not_started');
    assert.equal(result.diagnostic_code, 'checker_unavailable');
    assert.equal(result.evidence.exit_code, null);
    assert.equal(result.evidence.signal, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Lean checker preflight refuses an unbound fixture or an unknown toolchain version', async () => {
  const unbound = await new LeanChecker({ runner: async () => ({ exit_code: 0, checker_started: true, stdout: 'Lean (version 4.33.1)', stderr: '' }) })
    .preflight({ fixtureManifest });
  assert.equal(unbound.status, 'unavailable');
  assert.equal(unbound.checker_process_status, 'not_started');
  assert.equal(unbound.diagnostic_code, 'checker_input_binding_unverified');
  assert.equal(unbound.evidence.input_binding_verified, false);

  const root = await mkdtemp('/tmp/swarmenv-checker-unknown-version-');
  const projectRoot = join(root, 'lean4');
  const problemPath = join(projectRoot, 'src', 'input.lean');
  const source = 'import Mathlib\ntheorem input : True := by trivial\n';
  await mkdir(join(projectRoot, 'src'), { recursive: true });
  await writeFile(problemPath, source, 'utf8');
  const manifest = {
    ...fixtureManifest,
    project_root: projectRoot,
    problem_file: 'lean4/src/input.lean',
    problem_file_hash: createHash('sha256').update(source).digest('hex'),
  };
  try {
    const checker = new LeanChecker({ runner: async () => ({ exit_code: 0, signal: null, stdout: 'lake is ready', stderr: '', checker_started: true }) });
    const result = await checker.preflight({ fixtureManifest: manifest });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.checker_process_status, 'completed');
    assert.equal(result.diagnostic_code, 'checker_version_unverified');
    assert.equal(result.evidence.toolchain_version_verified, false);
    assert.equal(result.evidence.preflight_verified, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Lean checker preflight binds the locked input, project cwd, and toolchain version', async () => {
  const root = await mkdtemp('/tmp/swarmenv-checker-preflight-');
  const projectRoot = join(root, 'lean4');
  const problemPath = join(projectRoot, 'src', 'input.lean');
  const source = 'import Mathlib\ntheorem input : True := by trivial\n';
  await mkdir(join(projectRoot, 'src'), { recursive: true });
  await writeFile(problemPath, source, 'utf8');
  const manifest = {
    ...fixtureManifest,
    project_root: projectRoot,
    problem_file: 'lean4/src/input.lean',
    problem_file_hash: createHash('sha256').update(source).digest('hex'),
  };
  const calls = [];
  try {
    const checker = new LeanChecker({
      runner: async (command, args, options) => {
        calls.push({ command, args, cwd: options.cwd });
        return { exit_code: 0, signal: null, stdout: 'Lean (version 4.33.1)', stderr: '', checker_started: true };
      },
    });
    const result = await checker.preflight({ fixtureManifest: manifest });
    assert.equal(result.status, 'healthy');
    assert.equal(result.evidence.input_binding_verified, true);
    assert.equal(result.evidence.expected_input_hash, manifest.problem_file_hash);
    assert.equal(result.evidence.observed_toolchain_version, '4.33.1');
    assert.equal(result.evidence.toolchain_version_verified, true);
    assert.equal(result.evidence.preflight_verified, true);
    assert.equal(calls[0].cwd, projectRoot);
    assert.deepEqual(calls[0].args, ['env', 'lean', '--version']);

    await writeFile(problemPath, `${source}-- drift\n`, 'utf8');
    const drifted = await checker.preflight({ fixtureManifest: manifest });
    assert.equal(drifted.status, 'unavailable');
    assert.equal(drifted.diagnostic_code, 'checker_input_hash_mismatch');
    assert.equal(drifted.checker_process_status, 'not_started');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Judge persists checker preflight health and bounds identical infrastructure retries', async () => {
  let checks = 0;
  const judge = new JudgeService(new DatabaseSync(':memory:'), {
    maxInfrastructureRetries: 2,
    checker: {
      preflight: async () => ({
        status: 'unavailable',
        checker_process_status: 'not_started',
        evidence: { diagnostic: 'spawn lake ENOENT', error_code: 'ENOENT', checker_started: false },
      }),
      check: async () => { checks += 1; return { verdict: 'PASS', evidence: { exit_code: 0 } }; },
    },
  });
  const base = {
    candidate_material_id: 'infra-material-1', target_task_id: targetTask.task_id, target_spec_version: 1,
    input_snapshot_hash: workspace.input_snapshot_hash, checker_ref: fixtureManifest.checker_ref, checker_version: fixtureManifest.checker_version,
    environment_ref: fixtureManifest.environment_ref, target_task: targetTask, workspace, fixture_manifest: fixtureManifest,
  };
  const results = [];
  for (let index = 1; index <= 3; index += 1) {
    results.push(await judge.judgeCandidate({
      ...base,
      request_key: `infra-request-${index}`,
      candidate_material_id: `infra-material-${index}`,
      candidate: candidate(`theorem infra${index} : True := by trivial`, `infra-material-${index}`),
    }, { operationId: `infra-operation-${index}` }));
  }
  assert.equal(checks, 0, 'preflight failure must prevent the checker from receiving Candidates');
  assert.deepEqual(results.map((result) => result.result_class), ['infrastructure_failure', 'infrastructure_failure', 'infrastructure_failure']);
  assert.deepEqual(results.map((result) => result.checker_process_status), ['not_started', 'not_started', 'not_started']);
  assert.deepEqual(results.map((result) => result.evidence.infrastructure_attempt_count), [1, 2, 3]);
  assert.deepEqual(results.map((result) => result.retryable), [true, true, false]);
  assert.equal(results[2].evidence.retry_exhausted, true);
  assert.equal(results[0].verdict, 'ERROR');
  assert.equal(results[0].judge_operation_status, 'persisted');
  assert.equal(judge.db.prepare('SELECT COUNT(*) AS count FROM checker_preflights').get().count, 1);
  assert.equal(judge.db.prepare('SELECT attempt_count FROM checker_preflights').get().attempt_count, 3);
  judge.close();
});

test('Judge also bounds a checker launch failure discovered after a healthy preflight', async () => {
  let checks = 0;
  const judge = new JudgeService(new DatabaseSync(':memory:'), {
    maxInfrastructureRetries: 2,
    checker: {
      preflight: async () => ({ status: 'healthy', checker_process_status: 'completed', evidence: { exit_code: 0 } }),
      check: async () => {
        checks += 1;
        return { verdict: 'ERROR', evidence: { diagnostic: 'spawn lake ENOENT', error_code: 'ENOENT', checker_started: false } };
      },
    },
  });
  const base = {
    target_task_id: targetTask.task_id, target_spec_version: 1, input_snapshot_hash: workspace.input_snapshot_hash,
    checker_ref: fixtureManifest.checker_ref, checker_version: fixtureManifest.checker_version, environment_ref: fixtureManifest.environment_ref,
    target_task: targetTask, workspace, fixture_manifest: fixtureManifest,
  };
  const results = [];
  for (let index = 1; index <= 3; index += 1) {
    const materialId = `post-preflight-material-${index}`;
    results.push(await judge.judgeCandidate({
      ...base, request_key: `post-preflight-request-${index}`, candidate_material_id: materialId,
      candidate: candidate(`theorem post${index} : True := by trivial`, materialId),
    }, { operationId: `post-preflight-operation-${index}` }));
  }
  assert.equal(checks, 3);
  assert.deepEqual(results.map((result) => result.evidence.infrastructure_attempt_count), [1, 2, 3]);
  assert.deepEqual(results.map((result) => result.retryable), [true, true, false]);
  assert.ok(results.every((result) => result.checker_process_status === 'not_started'));
  judge.close();
});

test('A changed Checker health result allows a later source-level check', async () => {
  let healthy = false;
  let checks = 0;
  const judge = new JudgeService(new DatabaseSync(':memory:'), {
    maxInfrastructureRetries: 0,
    checker: {
      preflight: async () => healthy
        ? { status: 'healthy', checker_process_status: 'completed', evidence: { exit_code: 0 } }
        : { status: 'unavailable', checker_process_status: 'not_started', evidence: { diagnostic: 'spawn lake ENOENT', error_code: 'ENOENT' } },
      check: async () => { checks += 1; return { verdict: 'PASS', evidence: { exit_code: 0 } }; },
    },
  });
  const input = {
    request_key: 'health-change-1', candidate_material_id: 'health-change-material-1', target_task_id: targetTask.task_id, target_spec_version: 1,
    input_snapshot_hash: workspace.input_snapshot_hash, checker_ref: fixtureManifest.checker_ref, checker_version: fixtureManifest.checker_version,
    environment_ref: fixtureManifest.environment_ref, candidate: candidate('theorem before : True := by trivial', 'health-change-material-1'), target_task: targetTask,
    workspace, fixture_manifest: fixtureManifest,
  };
  const unavailable = await judge.judgeCandidate(input, { operationId: 'health-change-op-1' });
  assert.equal(unavailable.retryable, false);
  healthy = true;
  const available = await judge.judgeCandidate({
    ...input,
    request_key: 'health-change-2', candidate_material_id: 'health-change-material-2',
    candidate: candidate('theorem after : True := by trivial', 'health-change-material-2'),
  }, { operationId: 'health-change-op-2' });
  assert.equal(available.result_class, 'PASS');
  assert.equal(available.mathematical_outcome, 'PASS');
  assert.equal(checks, 1);
  assert.equal(judge.db.prepare('SELECT attempt_count FROM checker_preflights').get().attempt_count, 0);
  judge.close();
});

test('A changed unavailable diagnostic opens a fresh bounded retry window', async () => {
  let diagnostic = 'spawn lake ENOENT: binary-a';
  const judge = new JudgeService(new DatabaseSync(':memory:'), {
    maxInfrastructureRetries: 1,
    checker: {
      preflight: async () => ({ status: 'unavailable', checker_process_status: 'not_started', evidence: { diagnostic, error_code: 'ENOENT' } }),
      check: async () => ({ verdict: 'PASS', evidence: { exit_code: 0 } }),
    },
  });
  const input = {
    target_task_id: targetTask.task_id, target_spec_version: 1, input_snapshot_hash: workspace.input_snapshot_hash,
    checker_ref: fixtureManifest.checker_ref, checker_version: fixtureManifest.checker_version, environment_ref: fixtureManifest.environment_ref,
    target_task: targetTask, workspace, fixture_manifest: fixtureManifest,
  };
  const first = await judge.judgeCandidate({ ...input, request_key: 'changed-health-1', candidate_material_id: 'changed-health-1', candidate: candidate('theorem changed1 : True := by trivial', 'changed-health-1') }, { operationId: 'changed-health-op-1' });
  const second = await judge.judgeCandidate({ ...input, request_key: 'changed-health-2', candidate_material_id: 'changed-health-2', candidate: candidate('theorem changed2 : True := by trivial', 'changed-health-2') }, { operationId: 'changed-health-op-2' });
  diagnostic = 'spawn lake ENOENT: binary-b';
  const third = await judge.judgeCandidate({ ...input, request_key: 'changed-health-3', candidate_material_id: 'changed-health-3', candidate: candidate('theorem changed3 : True := by trivial', 'changed-health-3') }, { operationId: 'changed-health-op-3' });
  assert.deepEqual([first.evidence.infrastructure_attempt_count, second.evidence.infrastructure_attempt_count, third.evidence.infrastructure_attempt_count], [1, 2, 1]);
  assert.deepEqual([first.retryable, second.retryable, third.retryable], [true, false, true]);
  judge.close();
});

test('Judge ok persistence is separate from source-level checker success', async () => {
  const judge = new JudgeService(new DatabaseSync(':memory:'), {
    checker: {
      preflight: async () => ({ status: 'healthy', checker_process_status: 'completed', evidence: { exit_code: 0 } }),
      check: async () => ({ verdict: 'PASS', evidence: { exit_code: 0, stdout: 'compiled' } }),
    },
  });
  const result = await judge.judgeCandidate({
    request_key: 'healthy-request', candidate_material_id: 'healthy-material', target_task_id: targetTask.task_id, target_spec_version: 1,
    input_snapshot_hash: workspace.input_snapshot_hash, checker_ref: fixtureManifest.checker_ref, checker_version: fixtureManifest.checker_version,
    environment_ref: fixtureManifest.environment_ref, candidate: candidate('theorem healthy : True := by trivial', 'healthy-material'), target_task: targetTask,
    workspace, fixture_manifest: fixtureManifest,
  }, { operationId: 'healthy-operation' });
  assert.equal(result.judge_operation_status, 'persisted');
  assert.equal(result.checker_process_status, 'completed');
  assert.equal(result.result_class, 'PASS');
  assert.equal(result.verdict, 'PASS');
  assert.equal(result.retryable, false);
  judge.close();
});

test('JudgeService stores CheckResult truth, keeps Task untouched, and deduplicates request keys', async () => {
  let checks = 0;
  const judge = new JudgeService(new DatabaseSync(':memory:'), {
    checker: { check: async () => { checks += 1; return { verdict: 'PASS', evidence: { exit_code: 0, stdout: 'ok', stderr: '', candidate_hash: 'candidate-hash', input_snapshot_hash: 'input-snapshot' } }; } },
  });
  const input = {
    request_key: 'check-request-1', candidate_material_id: 'material-1', target_task_id: targetTask.task_id, target_spec_version: 1,
    input_snapshot_hash: workspace.input_snapshot_hash, checker_ref: fixtureManifest.checker_ref, checker_version: fixtureManifest.checker_version,
    environment_ref: fixtureManifest.environment_ref, candidate: candidate('import Mathlib\ntheorem ok : True := by trivial'), target_task: targetTask,
    workspace: workspace, fixture_manifest: fixtureManifest,
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
    input_snapshot_hash: workspace.input_snapshot_hash, checker_ref: fixtureManifest.checker_ref, checker_version: fixtureManifest.checker_version,
    environment_ref: fixtureManifest.environment_ref, candidate: candidate('theorem concurrent : True := by trivial'), target_task: targetTask,
    workspace: workspace, fixture_manifest: fixtureManifest,
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

test('Judge rejects results whose Task or Workspace binding has drifted', async () => {
  const judge = new JudgeService(new DatabaseSync(':memory:'), {
    checker: { check: async () => ({ verdict: 'PASS', evidence: {} }) },
  });
  const input = {
    request_key: 'binding-check', candidate_material_id: 'material-1', target_task_id: targetTask.task_id, target_spec_version: 1,
    input_snapshot_hash: workspace.input_snapshot_hash, checker_ref: fixtureManifest.checker_ref, checker_version: fixtureManifest.checker_version,
    environment_ref: fixtureManifest.environment_ref, candidate: candidate('theorem ok : True := by trivial'), target_task: targetTask,
    workspace: workspace, fixture_manifest: fixtureManifest,
  };
  await assert.rejects(
    () => judge.judgeCandidate({ ...input, target_task: { ...targetTask, spec_version: 2 } }, { operationId: 'drifted-task' }),
    (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.INVALID_CONTRACT,
  );
  await assert.rejects(
    () => judge.judgeCandidate({ ...input, workspace: { input_snapshot_hash: 'different-input' } }, { operationId: 'drifted-input' }),
    (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.INVALID_CONTRACT,
  );
  judge.close();
});

test('Judge operation replay and mismatched fixture bindings are explicit', async () => {
  const judge = new JudgeService(new DatabaseSync(':memory:'));
  const payload = {
    request_key: 'submitted-1', candidate_material_id: 'material-1', target_task_id: 'task-proof', target_spec_version: 1,
    input_snapshot_hash: 'input-snapshot', checker_ref: 'lean', checker_version: 'mvp-1', environment_ref: fixtureManifest.environment_ref,
    candidate: candidate('x'), target_task: targetTask, workspace: workspace, fixture_manifest: fixtureManifest,
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

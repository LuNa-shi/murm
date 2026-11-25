import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ERROR_CODES, MurmError } from '../src/errors.js';
import { JudgeService } from '../src/judge/judge-service.js';
import { LeanChecker } from '../src/judge/lean-adapter.js';
import { agentCheckResult } from '../src/judge/check-result.js';
import { makeEnvelope } from '../src/protocol/envelope.js';
import { validateFixtureManifest, createFixtureManifest } from '../src/judge/fixture.js';

const fixtureSource = 'theorem fixture_truth : True := by trivial\n';

const fixtureManifest = {
  fixture_id: 'synthetic-truth',
  putnambench_commit: '1111111111111111111111111111111111111111',
  problem_file: 'lean4/src/input.lean',
  problem_file_hash: '3fdfe56b91d9bf0b84a43d332dd95e372768df80f9921b8795981510e0b963a8',
  lean_toolchain: 'leanprover/lean4:v4.33.1',
  mathlib_version: '0df444a360eaa60ab8c11dca51a86af692955474',
  checker_ref: 'lean',
  checker_version: 'mvp-1',
  environment_ref: 'synthetic-lean4-fixture',
};

const targetTask = { task_id: 'task-proof', spec_version: 1, spec_hash: 'spec-hash' };
const workspace = { input_snapshot_hash: 'input-snapshot' };

function workspace_source(content, materialId = 'material-1') {
  return { material_id: materialId, content };
}

function checkerWithPreflight(checker) {
  if (typeof checker.preflight === 'function') return checker;
  return {
    ...checker,
    preflight: async ({ fixtureManifest: manifest }) => ({
      status: 'healthy',
      checker_process_status: 'completed',
      evidence: {
        preflight_supported: true,
        preflight_verified: true,
        input_binding_verified: true,
        toolchain_version_verified: true,
        checker_version_verified: true,
        expected_checker_version: manifest.checker_version,
        observed_checker_version: manifest.checker_version,
      },
    }),
  };
}

test('Agent CheckResult feedback is bounded, actionable, and excludes private evidence', () => {
  const feedback = agentCheckResult({
    check_result_id: 'agent-feedback-result',
    workspace_source_id: 'workspace_source-material',
    target_task_id: 'task-proof',
    execution_id: 'execution-proof',
    status: 'RECEIVED',
    verdict: 'FAIL',
    judge_operation_status: 'persisted',
    checker_process_status: 'completed',
    result_class: 'source_failure',
    mathematical_outcome: 'FAIL',
    retryable: false,
    diagnostic_code: 'source_failure',
    evidence: {
      diagnostic: 'WorkspaceSource.lean:12:7: error: type mismatch\n' + 'x'.repeat(5000),
      file: 'WorkspaceSource.lean',
      line: 12,
      column: 7,
      exit_code: 1,
      signal: null,
      timed_out: false,
      error_code: null,
      workspace_source_hash: 'private-workspace_source-hash',
      stdout: 'private stdout',
      stderr: 'private stderr',
    },
  });
  assert.equal(feedback.check_result_id, 'agent-feedback-result');
  assert.equal(feedback.result_class, 'source_failure');
  assert.equal(feedback.mathematical_outcome, 'FAIL');
  assert.equal(feedback.checker_process_status, 'completed');
  assert.equal(feedback.retryable, false);
  assert.equal(feedback.diagnostic_code, 'source_failure');
  assert.match(feedback.diagnostic_excerpt, /type mismatch/);
  assert.ok(feedback.diagnostic_excerpt.length <= 4_096);
  assert.deepEqual(feedback.diagnostic_location, { file: 'WorkspaceSource.lean', line: 12, column: 7 });
  assert.deepEqual(feedback.process_evidence, { exit_code: 1, signal: null, timed_out: false, error_code: null });
  assert.equal(feedback.evidence, undefined);
  assert.equal(feedback.workspace_source_hash, undefined);
  assert.equal(feedback.stdout, undefined);
  assert.equal(feedback.stderr, undefined);
  assert.doesNotMatch(JSON.stringify(feedback), /private-workspace_source-hash|private stdout|private stderr/);
});

test('Agent CheckResult feedback redacts credentials from checker diagnostics', () => {
  const feedback = agentCheckResult({
    verdict: 'ERROR',
    result_class: 'infrastructure_failure',
    checker_process_status: 'crashed',
    evidence: {
      diagnostic: 'checker failed at WorkspaceSource.lean:12:7: type mismatch',
      stderr: 'OPENAI_API_KEY=sk-test-secret-value-123456 Bearer eyJsecret-token-value https://user:password@example.test/x',
      stdout: 'token=another-secret-value',
    },
  });
  assert.match(feedback.diagnostic_excerpt, /type mismatch/);
  assert.match(feedback.diagnostic_excerpt, /\[REDACTED\]/);
  assert.doesNotMatch(feedback.diagnostic_excerpt, /sk-test-secret-value-123456|eyJsecret-token-value|another-secret-value|user:password/);
});

test('fixture manifest binds original source bytes and validates locked checker identity', async t => {
  const root = await mkdtemp(join(tmpdir(), 'swarmenv-original-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const problemFile = join(root, 'input.lean');
  await writeFile(problemFile, fixtureSource);
  const created = await createFixtureManifest({ fixtureId: fixtureManifest.fixture_id,
    fixtureCommit: fixtureManifest.putnambench_commit, problemFile,
    leanToolchain: fixtureManifest.lean_toolchain, mathlibVersion: fixtureManifest.mathlib_version,
    checkerRef: fixtureManifest.checker_ref, checkerVersion: fixtureManifest.checker_version,
    environmentRef: fixtureManifest.environment_ref });
  assert.equal(created.problem_file_hash, fixtureManifest.problem_file_hash);
  assert.equal(created.fixture_commit, fixtureManifest.putnambench_commit);
  assert.equal(created.putnambench_commit, undefined);
  const legacy = await createFixtureManifest({ fixtureId: fixtureManifest.fixture_id,
    putnambenchCommit: fixtureManifest.putnambench_commit, problemFile,
    leanToolchain: fixtureManifest.lean_toolchain, mathlibVersion: fixtureManifest.mathlib_version,
    checkerRef: fixtureManifest.checker_ref, checkerVersion: fixtureManifest.checker_version,
    environmentRef: fixtureManifest.environment_ref });
  assert.deepEqual(legacy, created);
  validateFixtureManifest(created);
  assert.throws(() => validateFixtureManifest({ ...created, problem_file_hash: 'not-sha256' }), { code: 'INVALID_CONTRACT' });
  assert.throws(() => validateFixtureManifest({ ...created, fixture_commit: 'not-a-commit' }), { code: 'INVALID_CONTRACT' });
});

test('Judge reopening reuses one fixture revision but checks a changed canonical revision', async t => {
  const root = await mkdtemp(join(tmpdir(), 'swarmenv-judge-fixture-revision-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { putnambench_commit: originalCommit, ...manifest } = fixtureManifest;
  const checker = checkerWithPreflight({
    check: async ({ fixtureManifest: boundManifest }) => ({
      verdict: (boundManifest.fixture_commit ?? boundManifest.putnambench_commit) === originalCommit ? 'PASS' : 'FAIL',
      evidence: { checker_started: true, exit_code: (boundManifest.fixture_commit ?? boundManifest.putnambench_commit) === originalCommit ? 0 : 1 },
    }),
  });
  const results = [];
  const revisions = [
    { putnambench_commit: originalCommit },
    { fixture_commit: originalCommit },
    { fixture_commit: originalCommit },
    { fixture_commit: '2'.repeat(40), putnambench_commit: originalCommit },
  ];
  for (const [index, revision] of revisions.entries()) {
    const judge = new JudgeService(join(root, 'judge.sqlite'), {
      checker, fixtureManifest: { ...manifest, ...revision },
    });
    try {
      results.push(await judge.checkWorkspaceSource({
        request_key: `fixture-revision-${index}`, source: { content: fixtureSource },
      }, makeEnvelope({ operationId: `fixture-operation-${index}`, actorRef: 'trusted:host',
        taskId: 'task-fixture', executionId: 'execution-fixture', specVersion: 1, stateVersion: 1 })));
      await judge.waitForIdle();
    } finally {
      judge.close();
    }
  }
  assert.equal(results[0].verdict, 'PASS');
  assert.equal(results[1].check_result_id, results[0].check_result_id);
  assert.equal(results[2].check_result_id, results[0].check_result_id);
  assert.equal(results[3].verdict, 'FAIL');
  assert.notEqual(results[3].check_result_id, results[0].check_result_id);
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
  const pass = await checker.check({ workspace_source: workspace_source('import Mathlib\ntheorem ok : True := by trivial'), targetTask, workspace, fixtureManifest });
  assert.equal(pass.verdict, 'PASS');
  assert.match(pass.evidence.workspace_source_hash, /^[0-9a-f]{64}$/);
  const fail = await checker.check({ workspace_source: workspace_source('import Mathlib\ntheorem bad : True := by exact nope', 'material-2'), targetTask, workspace, fixtureManifest });
  assert.equal(fail.verdict, 'FAIL');
  assert.match(fail.evidence.diagnostic, /type mismatch/);
  assert.equal(calls[0].args[0], 'env');
  assert.equal(calls[0].args[1], 'lean');

  const timedOut = new LeanChecker({ runner: async () => ({ exit_code: null, signal: 'SIGKILL', stdout: '', stderr: '', timed_out: true }) });
  const timeoutResult = await timedOut.check({ workspace_source: workspace_source('theorem timed : True := by trivial'), targetTask, workspace, fixtureManifest });
  assert.equal(timeoutResult.verdict, 'ERROR');
  assert.match(timeoutResult.evidence.diagnostic, /timed out/);

  const crashed = new LeanChecker({ runner: async () => ({ exit_code: null, signal: 'SIGSEGV', stdout: '', stderr: '', checker_started: true }) });
  const crashedResult = await crashed.check({ workspace_source: workspace_source('theorem crashed : True := by trivial'), targetTask, workspace, fixtureManifest });
  assert.equal(crashedResult.verdict, 'ERROR');
  assert.equal(crashedResult.checker_process_status, 'crashed');
  assert.equal(crashedResult.result_class, 'infrastructure_failure');
  assert.equal(crashedResult.mathematical_outcome, 'unassessed');
  assert.match(crashedResult.evidence.diagnostic, /SIGSEGV/);

  const unavailable = new LeanChecker({ runner: async () => ({ exit_code: null, signal: null, stdout: '', stderr: '', error: 'lake: command not found' }) });
  const errorResult = await unavailable.check({ workspace_source: workspace_source('theorem unavailable : True := by trivial'), targetTask, workspace, fixtureManifest });
  assert.equal(errorResult.verdict, 'ERROR');
  assert.match(errorResult.evidence.diagnostic, /command not found/);
});

test('Checker result contract distinguishes source failure from a checker that never started', async () => {
  const unavailable = new LeanChecker({
    runner: async () => ({ exit_code: null, signal: null, error: 'spawn lake ENOENT', error_code: 'ENOENT', checker_started: false }),
  });
  const result = await unavailable.check({ workspace_source: workspace_source('theorem unavailable : True := by trivial'), targetTask, workspace, fixtureManifest });
  assert.equal(result.verdict, 'ERROR');
  assert.equal(result.checker_process_status, 'not_started');
  assert.equal(result.result_class, 'infrastructure_failure');
  assert.equal(result.mathematical_outcome, 'unassessed');
  assert.equal(result.retryable, true);
  assert.equal(result.diagnostic_code, 'checker_unavailable');

  const sourceFailure = new LeanChecker({
    runner: async () => ({ exit_code: 1, signal: null, stdout: '', stderr: 'type mismatch', checker_started: true }),
  });
  const failed = await sourceFailure.check({ workspace_source: workspace_source('theorem bad : True := by exact nope'), targetTask, workspace, fixtureManifest });
  assert.equal(failed.verdict, 'FAIL');
  assert.equal(failed.checker_process_status, 'completed');
  assert.equal(failed.result_class, 'source_failure');
  assert.equal(failed.mathematical_outcome, 'FAIL');
  assert.equal(failed.retryable, false);

  const rejected = await new LeanChecker({ runner: async () => ({ exit_code: 0, checker_started: true }) }).check({ workspace_source: workspace_source('theorem rejected : True := by sorry'), targetTask, workspace, fixtureManifest });
  assert.equal(rejected.result_class, 'request_failure');
  assert.equal(rejected.diagnostic_code, 'forbidden_placeholder');
  assert.equal(rejected.mathematical_outcome, 'unassessed');
});

test('Lean checker preflight reports an unavailable executable before proof checking', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swarmenv-checker-missing-executable-'));
  const projectRoot = join(root, 'lean4');
  const problemPath = join(projectRoot, 'src', 'input.lean');
  const source = fixtureSource;
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

  const root = await mkdtemp(join(tmpdir(), 'swarmenv-checker-unknown-version-'));
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
  const root = await mkdtemp(join(tmpdir(), 'swarmenv-checker-preflight-'));
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
    assert.equal(result.evidence.observed_checker_version, manifest.checker_version);
    assert.equal(result.evidence.checker_version_verified, true);
    assert.equal(result.evidence.preflight_verified, true);
    assert.equal(calls[0].cwd, projectRoot);
    assert.deepEqual(calls[0].args, ['env', 'lean', '--version']);

    await writeFile(problemPath, `${source}-- drift\n`, 'utf8');
    const drifted = await checker.preflight({ fixtureManifest: manifest });
    assert.equal(drifted.status, 'unavailable');
    assert.equal(drifted.diagnostic_code, 'checker_input_hash_mismatch');
    assert.equal(drifted.checker_process_status, 'not_started');

    const mismatchedChecker = new LeanChecker({
      checkerVersion: 'mvp-0',
      runner: async () => ({ exit_code: 0, signal: null, stdout: 'Lean (version 4.33.1)', stderr: '', checker_started: true }),
    });
    await writeFile(problemPath, source, 'utf8');
    const versionMismatch = await mismatchedChecker.preflight({ fixtureManifest: manifest });
    assert.equal(versionMismatch.status, 'unavailable');
    assert.equal(versionMismatch.diagnostic_code, 'checker_version_mismatch');
    assert.equal(versionMismatch.evidence.checker_version_verified, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Judge refuses a checker adapter without a preflight health gate', async () => {
  let checks = 0;
  const judge = new JudgeService(new DatabaseSync(':memory:'), {
    fixtureManifest,
    checker: { check: async () => { checks += 1; return { verdict: 'PASS', evidence: { exit_code: 0 } }; } },
  });
  const result = await judge.checkWorkspaceSource({
    request_key: 'unsupported-preflight-request',
    workspace_source_id: 'unsupported-preflight-material',
    target_task_id: targetTask.task_id,
    target_spec_version: targetTask.spec_version,
    input_snapshot_hash: workspace.input_snapshot_hash,
    checker_ref: fixtureManifest.checker_ref,
    checker_version: fixtureManifest.checker_version,
    environment_ref: fixtureManifest.environment_ref,
    workspace_source: workspace_source('theorem unsupported : True := by trivial', 'unsupported-preflight-material'),
    target_task: targetTask,
    workspace,
    fixture_manifest: fixtureManifest,
  }, makeEnvelope({ operationId: 'unsupported-preflight-operation', actorRef: 'judge:test', taskId: targetTask.task_id, executionId: 'execution-proof', specVersion: 1, stateVersion: 1 }));
  assert.equal(checks, 0);
  assert.equal(result.result_class, 'infrastructure_failure');
  assert.equal(result.checker_process_status, 'not_started');
  assert.equal(result.diagnostic_code, 'checker_preflight_unsupported');
  assert.equal(result.mathematical_outcome, 'unassessed');
  assert.equal(judge.listCheckerPreflights()[0].evidence.preflight_verified, false);
  judge.close();
});

test('Judge persists checker preflight health and bounds identical infrastructure retries', async () => {
  let checks = 0;
  const judge = new JudgeService(new DatabaseSync(':memory:'), {
    fixtureManifest,
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
    workspace_source_id: 'infra-material-1', target_task_id: targetTask.task_id, target_spec_version: 1,
    input_snapshot_hash: workspace.input_snapshot_hash, checker_ref: fixtureManifest.checker_ref, checker_version: fixtureManifest.checker_version,
    environment_ref: fixtureManifest.environment_ref, target_task: targetTask, workspace, fixture_manifest: fixtureManifest,
  };
  const results = [];
  for (let index = 1; index <= 3; index += 1) {
    results.push(await judge.checkWorkspaceSource({
      ...base,
      request_key: `infra-request-${index}`,
      workspace_source_id: `infra-material-${index}`,
      workspace_source: workspace_source(`theorem infra${index} : True := by trivial`, `infra-material-${index}`),
    }, { operationId: `infra-operation-${index}` }));
  }
  assert.equal(checks, 0, 'preflight failure must prevent the checker from receiving WorkspaceSources');
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
    fixtureManifest,
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
    results.push(await judge.checkWorkspaceSource({
      ...base, request_key: `post-preflight-request-${index}`, workspace_source_id: materialId,
      workspace_source: workspace_source(`theorem post${index} : True := by trivial`, materialId),
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
    fixtureManifest,
    maxInfrastructureRetries: 0,
    checker: {
      preflight: async () => healthy
        ? { status: 'healthy', checker_process_status: 'completed', evidence: { exit_code: 0 } }
        : { status: 'unavailable', checker_process_status: 'not_started', evidence: { diagnostic: 'spawn lake ENOENT', error_code: 'ENOENT' } },
      check: async () => { checks += 1; return { verdict: 'PASS', evidence: { exit_code: 0 } }; },
    },
  });
  const input = {
    request_key: 'health-change-1', workspace_source_id: 'health-change-material-1', target_task_id: targetTask.task_id, target_spec_version: 1,
    input_snapshot_hash: workspace.input_snapshot_hash, checker_ref: fixtureManifest.checker_ref, checker_version: fixtureManifest.checker_version,
    environment_ref: fixtureManifest.environment_ref, workspace_source: workspace_source('theorem before : True := by trivial', 'health-change-material-1'), target_task: targetTask,
    workspace, fixture_manifest: fixtureManifest,
  };
  const unavailable = await judge.checkWorkspaceSource(input, makeEnvelope({ operationId: 'health-change-op-1', actorRef: 'judge:test', taskId: targetTask.task_id, executionId: 'execution-proof', specVersion: 1, stateVersion: 1 }));
  assert.equal(unavailable.retryable, false);
  healthy = true;
  const available = await judge.checkWorkspaceSource({
    ...input,
    request_key: 'health-change-2', workspace_source_id: 'health-change-material-2',
    workspace_source: workspace_source('theorem after : True := by trivial', 'health-change-material-2'),
  }, makeEnvelope({ operationId: 'health-change-op-2', actorRef: 'judge:test', taskId: targetTask.task_id, executionId: 'execution-proof', specVersion: 1, stateVersion: 1 }));
  assert.equal(available.result_class, 'PASS');
  assert.equal(available.mathematical_outcome, 'PASS');
  assert.equal(checks, 1);
  assert.equal(judge.db.prepare('SELECT attempt_count FROM checker_preflights').get().attempt_count, 0);
  judge.close();
});

test('A changed unavailable diagnostic opens a fresh bounded retry window', async () => {
  let diagnostic = 'spawn lake ENOENT: binary-a';
  const judge = new JudgeService(new DatabaseSync(':memory:'), {
    fixtureManifest,
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
  const first = await judge.checkWorkspaceSource({ ...input, request_key: 'changed-health-1', workspace_source_id: 'changed-health-1', workspace_source: workspace_source('theorem changed1 : True := by trivial', 'changed-health-1') }, makeEnvelope({ operationId: 'changed-health-op-1', actorRef: 'judge:test', taskId: targetTask.task_id, executionId: 'execution-proof', specVersion: 1, stateVersion: 1 }));
  const second = await judge.checkWorkspaceSource({ ...input, request_key: 'changed-health-2', workspace_source_id: 'changed-health-2', workspace_source: workspace_source('theorem changed2 : True := by trivial', 'changed-health-2') }, makeEnvelope({ operationId: 'changed-health-op-2', actorRef: 'judge:test', taskId: targetTask.task_id, executionId: 'execution-proof', specVersion: 1, stateVersion: 1 }));
  diagnostic = 'spawn lake ENOENT: binary-b';
  const third = await judge.checkWorkspaceSource({ ...input, request_key: 'changed-health-3', workspace_source_id: 'changed-health-3', workspace_source: workspace_source('theorem changed3 : True := by trivial', 'changed-health-3') }, makeEnvelope({ operationId: 'changed-health-op-3', actorRef: 'judge:test', taskId: targetTask.task_id, executionId: 'execution-proof', specVersion: 1, stateVersion: 1 }));
  assert.deepEqual([first.evidence.infrastructure_attempt_count, second.evidence.infrastructure_attempt_count, third.evidence.infrastructure_attempt_count], [1, 2, 1]);
  assert.deepEqual([first.retryable, second.retryable, third.retryable], [true, false, true]);
  judge.close();
});

test('Judge ok persistence is separate from source-level checker success', async () => {
  const judge = new JudgeService(new DatabaseSync(':memory:'), {
    fixtureManifest,
    checker: {
      preflight: async () => ({ status: 'healthy', checker_process_status: 'completed', evidence: { exit_code: 0 } }),
      check: async () => ({ verdict: 'PASS', evidence: { exit_code: 0, stdout: 'compiled' } }),
    },
  });
  const result = await judge.checkWorkspaceSource({
    request_key: 'healthy-request', workspace_source_id: 'healthy-material', target_task_id: targetTask.task_id, target_spec_version: 1,
    input_snapshot_hash: workspace.input_snapshot_hash, checker_ref: fixtureManifest.checker_ref, checker_version: fixtureManifest.checker_version,
    environment_ref: fixtureManifest.environment_ref, workspace_source: workspace_source('theorem healthy : True := by trivial', 'healthy-material'), target_task: targetTask,
    workspace, fixture_manifest: fixtureManifest,
  }, makeEnvelope({ operationId: 'healthy-operation', actorRef: 'judge:test', taskId: targetTask.task_id, executionId: 'execution-proof', specVersion: 1, stateVersion: 1 }));
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
    fixtureManifest,
    checker: checkerWithPreflight({ check: async () => { checks += 1; return { verdict: 'PASS', evidence: { exit_code: 0, stdout: 'ok', stderr: '', workspace_source_hash: 'workspace_source-hash', input_snapshot_hash: 'input-snapshot' } }; } }),
  });
  const input = {
    request_key: 'check-request-1', workspace_source_id: 'material-1', target_task_id: targetTask.task_id, target_spec_version: 1,
    input_snapshot_hash: workspace.input_snapshot_hash, checker_ref: fixtureManifest.checker_ref, checker_version: fixtureManifest.checker_version,
    environment_ref: fixtureManifest.environment_ref, workspace_source: workspace_source('import Mathlib\ntheorem ok : True := by trivial'), target_task: targetTask,
    workspace: workspace, fixture_manifest: fixtureManifest,
  };
  const first = await judge.checkWorkspaceSource(input, makeEnvelope({ operationId: 'judge-op-1', actorRef: 'judge:test', taskId: targetTask.task_id, executionId: 'execution-proof', specVersion: 1, stateVersion: 1 }));
  assert.equal(first.status, 'RECEIVED');
  assert.equal(first.verdict, 'PASS');
  assert.equal(checks, 1);
  const replay = await judge.checkWorkspaceSource(input, makeEnvelope({ operationId: 'judge-op-2', actorRef: 'judge:test', taskId: targetTask.task_id, executionId: 'execution-proof', specVersion: 1, stateVersion: 1 }));
  assert.equal(replay.check_result_id, first.check_result_id);
  assert.equal(checks, 1, 'same request_key must not run Lean twice');
  const queried = judge.dispatch('get_check_result', { request_key: input.request_key }, makeEnvelope({ operationId: 'judge-query-by-request', actorRef: 'test:judge-query', taskId: targetTask.task_id, executionId: 'execution-proof' }));
  assert.equal(queried.check_result_id, first.check_result_id, 'a lost submit response must be recoverable by request_key');
  assert.equal(judge.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get(), undefined);
  await assert.rejects(
    () => judge.checkWorkspaceSource({ ...input, workspace_source_id: 'material-2', workspace_source: workspace_source('changed', 'material-2') }, makeEnvelope({ operationId: 'judge-op-3', actorRef: 'judge:test', taskId: targetTask.task_id, executionId: 'execution-proof', specVersion: 1, stateVersion: 1 })),
    (error) => error instanceof MurmError && error.code === ERROR_CODES.CONFLICT,
  );
  judge.close();
});

test('JudgeService deduplicates an unchanged workspace_source across request keys', async () => {
  let checks = 0;
  const judge = new JudgeService(new DatabaseSync(':memory:'), {
    fixtureManifest,
    checker: checkerWithPreflight({ check: async () => { checks += 1; return { verdict: 'FAIL', result_class: 'source_failure', evidence: { exit_code: 1 } }; } }),
  });
  const input = {
    request_key: 'workspace_source-duplicate-1', workspace_source_id: 'same-material', target_task_id: targetTask.task_id, target_spec_version: 1,
    input_snapshot_hash: workspace.input_snapshot_hash, checker_ref: fixtureManifest.checker_ref, checker_version: fixtureManifest.checker_version,
    environment_ref: fixtureManifest.environment_ref, workspace_source: workspace_source('theorem duplicate : True := by trivial', 'same-material'), target_task: targetTask,
    workspace, fixture_manifest: fixtureManifest,
  };
  const first = await judge.checkWorkspaceSource(input, makeEnvelope({ operationId: 'workspace_source-duplicate-op-1', actorRef: 'judge:test', taskId: targetTask.task_id, executionId: 'execution-proof', specVersion: 1, stateVersion: 1 }));
  const duplicate = await judge.checkWorkspaceSource({ ...input, request_key: 'workspace_source-duplicate-2', workspace_source_id: 'different-material', workspace_source: workspace_source('theorem duplicate : True := by trivial', 'different-material') }, makeEnvelope({ operationId: 'workspace_source-duplicate-op-2', actorRef: 'judge:test', taskId: targetTask.task_id, executionId: 'execution-proof', specVersion: 1, stateVersion: 1 }));
  assert.equal(checks, 1);
  assert.equal(duplicate.check_result_id, first.check_result_id);
  assert.equal(duplicate.deduplicated, true);
  assert.equal(duplicate.duplicate_of_request_key, input.request_key);
  judge.close();
});

test('concurrent checks for one request_key elect one checker invocation', async () => {
  let checks = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const judge = new JudgeService(new DatabaseSync(':memory:'), {
    fixtureManifest,
    checker: checkerWithPreflight({ check: async () => { checks += 1; await gate; return { verdict: 'PASS', evidence: { exit_code: 0 } }; } }),
  });
  const input = {
    request_key: 'concurrent-check', workspace_source_id: 'material-1', target_task_id: targetTask.task_id, target_spec_version: 1,
    input_snapshot_hash: workspace.input_snapshot_hash, checker_ref: fixtureManifest.checker_ref, checker_version: fixtureManifest.checker_version,
    environment_ref: fixtureManifest.environment_ref, workspace_source: workspace_source('theorem concurrent : True := by trivial'), target_task: targetTask,
    workspace: workspace, fixture_manifest: fixtureManifest,
  };
  const firstPromise = judge.checkWorkspaceSource(input, makeEnvelope({ operationId: 'concurrent-1', actorRef: 'judge:test', taskId: targetTask.task_id, executionId: 'execution-proof', specVersion: 1, stateVersion: 1 }));
  await new Promise((resolve) => setImmediate(resolve));
  const second = await judge.checkWorkspaceSource(input, makeEnvelope({ operationId: 'concurrent-2', actorRef: 'judge:test', taskId: targetTask.task_id, executionId: 'execution-proof', specVersion: 1, stateVersion: 1 }));
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
    fixtureManifest,
    checker: checkerWithPreflight({ check: async () => ({ verdict: 'PASS', evidence: {} }) }),
  });
  const input = {
    request_key: 'binding-check', workspace_source_id: 'material-1', target_task_id: targetTask.task_id, target_spec_version: 1,
    input_snapshot_hash: workspace.input_snapshot_hash, checker_ref: fixtureManifest.checker_ref, checker_version: fixtureManifest.checker_version,
    environment_ref: fixtureManifest.environment_ref, workspace_source: workspace_source('theorem ok : True := by trivial'), target_task: targetTask,
    workspace: workspace, fixture_manifest: fixtureManifest,
  };
  await assert.rejects(
    () => judge.checkWorkspaceSource({ ...input, target_task: { ...targetTask, spec_version: 2 } }, makeEnvelope({ operationId: 'drifted-task', actorRef: 'judge:test', taskId: targetTask.task_id, executionId: 'execution-proof', specVersion: 1, stateVersion: 1 })),
    (error) => error instanceof MurmError && error.code === ERROR_CODES.INVALID_CONTRACT,
  );
  await assert.rejects(
    () => judge.checkWorkspaceSource({ ...input, workspace: { input_snapshot_hash: 'different-input' } }, makeEnvelope({ operationId: 'drifted-input', actorRef: 'judge:test', taskId: targetTask.task_id, executionId: 'execution-proof', specVersion: 1, stateVersion: 1 })),
    (error) => error instanceof MurmError && error.code === ERROR_CODES.INVALID_CONTRACT,
  );
  judge.close();
});

test('Judge operation replay and mismatched fixture bindings are explicit', async () => {
  const judge = new JudgeService(new DatabaseSync(':memory:'), { fixtureManifest });
  const payload = {
    request_key: 'submitted-1', workspace_source_id: 'material-1', target_task_id: 'task-proof', target_spec_version: 1,
    input_snapshot_hash: 'input-snapshot', checker_ref: 'lean', checker_version: 'mvp-1', environment_ref: fixtureManifest.environment_ref,
    workspace_source: workspace_source('x'), target_task: targetTask, workspace: workspace, fixture_manifest: fixtureManifest,
    status: 'RECEIVED', verdict: 'FAIL', evidence: { exit_code: 1, diagnostic: 'bad proof' },
  };
  const envelope = makeEnvelope({ operationId: 'submit-1', actorRef: 'judge:lean', taskId: 'task-proof', specVersion: 1 });
  const first = judge.dispatch('submit_check_result', payload, envelope);
  const replay = judge.dispatch('submit_check_result', payload, envelope);
  assert.equal(replay.check_result_id, first.check_result_id);
  assert.equal(first.verdict, 'FAIL');
  assert.throws(
    () => judge.dispatch('submit_check_result', { ...payload, workspace_source_id: 'material-2', workspace_source: workspace_source('changed', 'material-2') }, makeEnvelope({ operationId: 'submit-2', actorRef: 'judge:lean', taskId: 'task-proof', specVersion: 1 })),
    (error) => error instanceof MurmError && error.code === ERROR_CODES.CONFLICT,
  );
  await assert.rejects(
    () => judge.checkWorkspaceSource({ ...payload, request_key: 'bad-binding', checker_version: 'different' }),
    (error) => error instanceof MurmError && error.code === ERROR_CODES.INVALID_CONTRACT,
  );
  judge.close();
});

test('Agent Judge projection preserves public input and preflight feedback when applied twice', () => {
  const original = { verdict: 'ERROR', status: 'RECEIVED', retryable: true, result_class: 'infrastructure_failure', checker_process_status: 'timeout', evidence: {
    diagnostic: 'checking timed out', exit_code: null, timed_out: true, checker_started: true, preflight_key: 'preflight-test', preflight_status: 'healthy',
    preflight_verified: true, input_binding_verified: true, checker_version_verified: true, health_fingerprint: 'health-test', infrastructure_attempt_count: 2,
    workspace_input: { workspace_id: 'W1', revision: '0.2', path: 'proof.lean', git_tree: 'a'.repeat(40), private_field: 'must not escape' },
    private_field: 'must not escape',
  } };
  const projected = agentCheckResult(original);
  assert.deepEqual(agentCheckResult(projected), projected);
  assert.equal(projected.workspace_input.private_field, undefined);
  assert.equal(projected.evidence, undefined);
});

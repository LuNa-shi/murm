import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { TaskService } from '../src/task/task-service.js';
import { RemoteJudgeService } from '../src/sdk/remote-judge-service.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { JudgeService } from '../src/judge/judge-service.js';
import { LeanChecker } from '../src/judge/lean-adapter.js';
import { LeanFinalTreeVerifier } from '../src/judge/lean-final-tree-verifier.js';
import { SwarmEnvError } from '../src/errors.js';
import { makeEnvelope } from '../src/protocol/envelope.js';

const manifest = { fixture_id: 'module-admission', putnambench_commit: 'a'.repeat(40), problem_file: 'Target.lean',
  problem_file_hash: 'b'.repeat(64), lean_toolchain: 'leanprover/lean4:v4.33.1', mathlib_version: 'fixture',
  checker_ref: 'lean', checker_version: 'fixture', environment_ref: 'fixture' };
const sources = { 'Target.lean': 'import Helper\ntheorem target : True := helper\n', 'Helper.lean': 'theorem helper : True := trivial\n' };
function harness(t, { check, checker, fixtureManifest = manifest, files = sources } = {}) {
  const db = new DatabaseSync(':memory:');
  const execution = { execution_id: 'e', task_id: 't', owner_ref: 'bot', state: 'RUNNING', state_version: 1, fencing_version: 1, lease_expires_at: new Date(Date.now() + 60000).toISOString(),
    workspace_input: { workspace_id: 'w' }, handoff_deadline: new Date(Date.now() + 60000).toISOString() };
  let authorityChecks = 0;
  let lockDepth = 0;
  const taskService = { db, getBot: () => true, getTask: () => ({ task_id: 't', mission_id: 'm' }), getExecution: () => execution,
    materialScope(envelope) { authorityChecks++; if (envelope.fencing_version !== execution.fencing_version || Date.parse(execution.lease_expires_at) <= Date.now()) throw new SwarmEnvError('FENCED', 'Stale authority'); if (execution.state !== 'RUNNING') throw new SwarmEnvError('FENCED', 'Execution ended'); return { mission_id: 'm' }; },
    assertMissionResearchOpen() {}, withServiceLifecycleWrite(fn) { lockDepth++; try { return fn(); } finally { lockDepth--; } } };
  const judge = new JudgeService(':memory:', { taskService, fixtureManifest,
    checker: checker ?? { timeoutMs: 30000, projectChecker: true,
      preflight: async () => ({ status: 'healthy', checker_process_status: 'completed', evidence: { input_binding_verified: true, toolchain_version_verified: true, checker_version_verified: true } }),
      checkProject: check },
    readProjectRevision: async ({ revision }) => ({ mission_id: 'm', workspace_id: 'w', revision, git_commit: revision.padEnd(40, 'c'), git_tree: revision.padEnd(40, 'd'), content_hash: revision, files }) });
  const submit = (revision = '0.1', mode = 'lean-module') => judge.checkWorkspaceSource({ request_key: revision, source: { workspace_id: 'w', revision, path: 'Target.lean', check_mode: mode } },
    makeEnvelope({ operationId: revision, actorRef: 'bot', executionId: 'e', taskId: 't', stateVersion: 1, specVersion: 1, fencingVersion: 1 }));
  t.after(async () => { await judge.waitForIdle(); judge.close(); db.close(); });
  return { judge, submit, execution, authorityChecks: () => authorityChecks, locked: () => lockDepth === 1 };
}

test('module source launches have a snapshot bound; project source remains single-launch', async t => {
  let starts = 0;
  const h = harness(t, { check: async ({ startProcess }) => {
    // Two modules permit a finite parser/build/validation plan. An extra call
    // must be refused before its callback executes.
    for (let i = 0; i < 100; i++) await startProcess(async () => { assert.ok(h.locked()); starts++; });
  } });
  assert.equal((await h.submit()).verdict, 'ERROR');
  assert.equal(starts, Object.keys(sources).length * 2 + 1);
  assert.equal(h.judge.getMissionCheckBudget('m').source_process_starts, starts);
  const moduleStarts = starts;
  assert.equal((await h.submit('0.2', 'lean-project')).verdict, 'ERROR');
  assert.equal(starts, moduleStarts + 1);
});

test('module launch is serial through cleanup; authority is rechecked after Execution cancellation', async t => {
  const worker = Promise.withResolvers();
  let starts = 0;
  const h = harness(t, { check: async ({ startProcess }) => {
    const first = startProcess(() => { starts++; return worker.promise; });
    try {
      await assert.rejects(startProcess(() => { starts++; }), /serially/);
    } finally { worker.resolve(); await first; }
    h.execution.state = 'CANCELLED';
    await startProcess(() => { starts++; });
  } });
  const result = await h.submit();
  assert.equal(result.verdict, 'ERROR');
  assert.equal(starts, 1);
  assert.equal(h.judge.getMissionCheckBudget('m').source_process_starts, 1);
  assert.ok(h.authorityChecks() >= 2);
});

test('module launch rechecks soft closeout and the unchanged absolute source deadline', async t => {
  for (const boundary of ['soft', 'deadline', 'lease', 'fence']) await t.test(boundary, async t => {
    let starts = 0;
    const h = harness(t, { check: async ({ startProcess }) => {
      await startProcess(async () => { starts++; });
      if (boundary === 'soft') h.execution.handoff_deadline = new Date(Date.now() - 1).toISOString();
      else if (boundary === 'lease') h.execution.lease_expires_at = new Date(Date.now() - 1).toISOString();
      else if (boundary === 'fence') h.execution.fencing_version++;
      else t.mock.timers.tick(30001);
      await startProcess(() => { starts++; });
    } });
    if (boundary === 'deadline') t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const result = await h.submit();
    assert.equal(result.verdict, 'ERROR');
    assert.equal(starts, 1);
    assert.equal(h.judge.getMissionCheckBudget('m').source_process_starts, 1);
  });
});

test('real Judge and locked Lean complete cold and warm module checks under source admission', { skip: !process.env.SWARMENV_TEST_LEAN_ROOT }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'judge-module-real-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = 'theorem target : True := by sorry\n';
  await writeFile(join(directory, 'Target.lean'), fixture);
  await writeFile(join(directory, 'lean-toolchain'), 'leanprover/lean4:v4.33.1\n');
  const fixtureManifest = { ...manifest, project_root: directory, problem_file_hash: createHash('sha256').update(fixture).digest('hex') };
  const leanRoot = process.env.SWARMENV_TEST_LEAN_ROOT;
  const verifier = new LeanFinalTreeVerifier({ identity: manifest, leanRoot, libraryRoots: [], comparatorLibraryRoots: ['/unused', '/unused'],
    exporterPath: '/unused/export', targetPath: 'Target.lean', declarationName: 'target', fixtureSource: fixture,
    fixtureSha256: fixtureManifest.problem_file_hash, projectChecks: true, allowUnboundedDiagnostics: true, timeoutMs: 30000 });
  const checker = new LeanChecker({ command: join(leanRoot, 'bin/lake'), checkerVersion: 'fixture', projectChecker: input => verifier.checkProject(input), timeoutMs: 30000 });
  const files = { ...sources };
  const h = harness(t, { checker, fixtureManifest, files });
  for (const revision of ['0.1', '0.2']) {
    const result = await h.submit(revision);
    assert.equal(result.verdict, 'PASS', JSON.stringify(result.evidence));
    assert.equal(result.mathematical_outcome, 'unassessed');
    assert.equal(result.evidence.build_scope, 'module');
    assert.deepEqual(result.evidence.checked_paths, ['Helper.lean', 'Target.lean']);
  }
  files['Target.lean'] = 'import Helper\ntheorem target : False := by trivial\n';
  assert.equal((await h.submit('0.3')).verdict, 'FAIL');
  files['Target.lean'] = sources['Target.lean'];
  assert.equal((await h.submit('0.4')).verdict, 'PASS');
  assert.equal(h.judge.getMissionCheckBudget('m').active_requests, 0);
});


for (const cancelDuringParser of [false, true]) test(`independent Judge peer gates real module workers (cancel during parser: ${cancelDuringParser})`, { skip: !process.env.SWARMENV_TEST_LEAN_ROOT, timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'judge-module-peer-'));
  const tasks = new TaskService(join(root, 'task.sqlite'));
  const fixture = 'theorem target : True := by sorry\n';
  await writeFile(join(root, 'Target.lean'), fixture);
  await writeFile(join(root, 'lean-toolchain'), 'leanprover/lean4:v4.33.1\n');
  const fixtureManifest = { ...manifest, project_root: root, problem_file_hash: createHash('sha256').update(fixture).digest('hex') };
  const token = 'module-peer-private-test-token-137';
  const readProjectRevision = async ({ revision }) => ({ mission_id: 'm', workspace_id: 'w', revision,
    git_commit: revision.padEnd(40, 'c'), git_tree: revision.padEnd(40, 'd'), content_hash: revision, files: sources });
  const judge = new RemoteJudgeService({ taskService: tasks, token, readProjectRevision, timeoutMs: 25000 });
  const coordinator = await judge.startCoordinator();
  const child = spawn('flock', ['--nonblock', '--no-fork', join(root, 'judge.lock'), process.execPath, 'test-support/judge-peer-fixture.mjs'], {
    env: { ...process.env, JUDGE_PEER_FIXTURE: JSON.stringify({ database: join(root, 'judge.sqlite'), token,
      coordinator: { url: coordinator.url, token }, fixtureManifest, projectChecks: true, realLeanRoot: process.env.SWARMENV_TEST_LEAN_ROOT }) },
    stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { await judge.close(); if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill(); await done; } tasks.close(); await rm(root, { recursive: true, force: true }); });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const endpoint = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Judge exited ${code}: ${errors}`)));
    child.stdout.once('data', chunk => resolve(JSON.parse(chunk.toString())));
  });
  judge.connect(endpoint.url);
  tasks.createMission({ mission_id: 'm', goal: 'Check fixed local scope' }, makeEnvelope({ actorRef: 'operator:test' }));
  tasks.registerBot({ botId: 'bot', missionId: 'm', coreId: 'core', selectionDeadline: new Date(Date.now() + 60000).toISOString() });
  tasks.recordBotSandbox('bot', { provider: 'controlled', sandboxId: 'sandbox' });
  tasks.markBotReady('bot');
  const task = tasks.createTask({ mission_id: 'm', gap: 'Establish helper', priority: 'medium', summary: 'Check helper', expected_output: 'Evidence', acceptance_conditions: ['Checked'] }, makeEnvelope({ actorRef: 'bot' })).task;
  const taken = tasks.takeTask(task.task_id, { owner_ref: 'bot', core_id: 'core', take_key: 'take' });
  tasks.db.prepare('UPDATE executions SET workspace_input_json = ? WHERE execution_id = ?').run(JSON.stringify({ workspace_id: 'w' }), taken.execution.execution_id);
  const envelope = operationId => { const e = tasks.getExecution(taken.execution.execution_id); return makeEnvelope({ operationId,
    actorRef: 'bot', taskId: task.task_id, executionId: e.execution_id, specVersion: e.spec_version, stateVersion: e.state_version, fencingVersion: e.fencing_version }); };
  tasks.dispatch('start_execution', {}, envelope('start'));
  if (cancelDuringParser) {
    const checking = judge.dispatch('workspace_check', { request_key: '0.1', source: { workspace_id: 'w', revision: '0.1', path: 'Target.lean', check_mode: 'lean-module' } }, envelope('0.1'));
    for (let attempt = 0; judge.getMissionCheckBudget('m').source_process_starts !== 1; attempt++) {
      assert.ok(attempt < 100, 'Header parser did not start'); await delay(10);
    }
    tasks.dispatch('task_finish', { outcome: 'incomplete' }, envelope('finish'));
    const result = await checking;
    assert.equal(result.verdict, 'ERROR');
    assert.equal(result.result_class, 'request_failure');
    assert.equal(judge.getMissionCheckBudget('m').source_process_starts, 1);
    return;
  }
  for (const revision of ['0.1', '0.2']) {
    const result = await judge.dispatch('workspace_check', { request_key: revision, source: { workspace_id: 'w', revision, path: 'Target.lean', check_mode: 'lean-module' } }, envelope(revision));
    assert.equal(result.verdict, 'PASS', JSON.stringify(result.evidence));
    assert.equal(result.evidence.build_scope, 'module');
  }
  assert.ok(judge.getMissionCheckBudget('m').source_process_starts >= 4);
  tasks.dispatch('task_finish', { outcome: 'incomplete' }, envelope('finish'));
  await assert.rejects(judge.dispatch('workspace_check', { request_key: '0.3', source: { workspace_id: 'w', revision: '0.3', path: 'Target.lean', check_mode: 'lean-module' } }, envelope('0.3')));
});


test('completed module artifact rejection preserves feedback and checker health through real Judge', { skip: !process.env.SWARMENV_TEST_LEAN_ROOT }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'judge-module-rejection-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = 'theorem target : True := by sorry\n';
  await writeFile(join(directory, 'Target.lean'), fixture);
  await writeFile(join(directory, 'lean-toolchain'), 'leanprover/lean4:v4.33.1\n');
  const fixtureManifest = { ...manifest, project_root: directory, problem_file_hash: createHash('sha256').update(fixture).digest('hex') };
  const leanRoot = process.env.SWARMENV_TEST_LEAN_ROOT;
  const verifier = new LeanFinalTreeVerifier({ identity: manifest, leanRoot, libraryRoots: [], comparatorLibraryRoots: ['/unused', '/unused'],
    exporterPath: '/unused/export', targetPath: 'Target.lean', declarationName: 'target', fixtureSource: fixture,
    fixtureSha256: fixtureManifest.problem_file_hash, projectChecks: true, allowUnboundedDiagnostics: true, timeoutMs: 30000 });
  const checker = new LeanChecker({ command: join(leanRoot, 'bin/lake'), checkerVersion: 'fixture', projectChecker: input => verifier.checkProject(input), timeoutMs: 30000 });
  const files = { 'Target.lean': `import Lean
open Lean Elab Command
elab "inject_invalid_safe_theorem" : command => do
  modifyEnv fun env =>
    match env.addDeclCore 0 0 (.thmDecl {
      name := \`badFalse
      levelParams := []
      type := mkConst \`\`False
      value := mkConst \`\`True.intro
    }) none (doCheck := false) with
    | .ok env => env
    | .error _ => env
inject_invalid_safe_theorem
#check badFalse
` };
  const h = harness(t, { checker, fixtureManifest, files });
  const rejected = await h.submit('0.1');
  assert.equal(rejected.verdict, 'ERROR');
  assert.equal(rejected.mathematical_outcome, 'unassessed');
  assert.equal(rejected.checker_process_status, 'completed');
  assert.equal(rejected.diagnostic_code, 'module_verification_failed');
  assert.equal(rejected.retryable, false);
  assert.equal(rejected.evidence.build_scope, 'module');
  assert.equal(rejected.evidence.build_cache.stored_bytes, 0);
  const health = h.judge.db.prepare('SELECT status, attempt_count FROM checker_preflights').all();
  assert.equal(health.length, 1);
  assert.equal(health[0].status, 'healthy');
  assert.equal(health[0].attempt_count, 0);
  files['Target.lean'] = 'theorem target : True := by trivial\n';
  const corrected = await h.submit('0.2');
  assert.equal(corrected.verdict, 'PASS', JSON.stringify(corrected));
  assert.equal(corrected.mathematical_outcome, 'unassessed');
});

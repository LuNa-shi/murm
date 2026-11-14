import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskService } from '../src/task/task-service.js';
import { JudgeService } from '../src/judge/judge-service.js';
import { makeEnvelope } from '../src/protocol/envelope.js';

function fixture(t, { preflight = async () => {}, database = ':memory:', judgeDb = null } = {}) {
  const tasks = new TaskService(database); t.after(() => tasks.close());
  tasks.createMission({ mission_id: 'closeout', goal: 'Investigate bounded work' }, makeEnvelope({ actorRef: 'operator:test' }));
  tasks.registerBot({ botId: 'bounded', coreId: 'core-1', missionId: 'closeout', selectionDeadline: new Date(Date.now() + 60_000).toISOString() });
  tasks.recordBotSandbox('bounded', { provider: 'controlled', sandboxId: 'bounded' }); tasks.markBotReady('bounded');
  const proposal = { mission_id: 'closeout', summary: 'Inspect one independent research question', expected_output: 'Readable conclusion', acceptance_conditions: ['Evidence and limitations'] };
  const task = tasks.createTask(proposal, makeEnvelope({ actorRef: 'bounded' })).task;
  const taken = tasks.takeTask(task.task_id, { owner_ref: 'bounded', core_id: 'core-1', take_key: 'bounded-take' });
  const envelope = operationId => {
    const e = tasks.getExecution(taken.execution.execution_id);
    return makeEnvelope({ operationId, actorRef: 'bounded', taskId: task.task_id, executionId: e.execution_id,
      specVersion: e.spec_version, stateVersion: e.state_version, fencingVersion: e.fencing_version });
  };
  tasks.dispatch('start_execution', {}, envelope('start'));
  const closeout = () => tasks.db.prepare('UPDATE executions SET handoff_deadline = ?, state_version = state_version + 1 WHERE execution_id = ?').run(new Date(Date.now() - 1).toISOString(), taken.execution.execution_id);
  const counts = { preflight: 0, check: 0 };
  const judge = new JudgeService(judgeDb ?? tasks.db, { taskService: tasks, fixtureManifest: { fixture_id: 'closeout', putnambench_commit: 'a'.repeat(40), problem_file: 'input.lean', problem_file_hash: 'b'.repeat(64), lean_toolchain: 'controlled', mathlib_version: 'controlled', checker_ref: 'controlled', checker_version: '1', environment_ref: 'controlled' }, checker: {
    preflight: async () => { counts.preflight += 1; await preflight(); return { status: 'healthy', checker_process_status: 'completed', evidence: { input_binding_verified: true, toolchain_version_verified: true, checker_version_verified: true } }; },
    check: async () => { counts.check += 1; return { verdict: 'PASS', evidence: { checker_started: true, exit_code: 0 } }; },
  } });
  const input = id => ({ request_key: id, source: { workspace_id: 'public', revision: '0.2', path: 'proof.lean', git_commit: 'c'.repeat(40), git_tree: 'd'.repeat(40), tree_content_hash: 'e'.repeat(64), content: 'theorem local : True := by trivial' } });
  return { tasks, task, proposal, judge, input, envelope, closeout, counts };
}

test('soft closeout rejects new Task and Judge work while original receipts survive E version changes', async t => {
  const { tasks, proposal, judge, input, envelope, closeout, counts } = fixture(t);
  const admitted = tasks.createTask({ ...proposal, summary: 'Inspect a second independent responsibility' }, envelope('proposed-before-soft'));
  const result = await judge.checkWorkspaceSource(input('checked-before-soft'), envelope('checked-before-soft'));
  closeout();
  assert.equal(tasks.getExecution(envelope('read').execution_id).handoff_reminder_sent_at, null);
  assert.throws(() => tasks.createTask(proposal, envelope('new-proposal')), error => error.code === 'NOT_ALLOWED' && error.details.phase === 'soft_closeout');
  assert.deepEqual(tasks.createTask({ ...proposal, summary: 'Inspect a second independent responsibility' }, envelope('proposed-before-soft')), admitted);
  assert.equal((await judge.checkWorkspaceSource(input('checked-before-soft'), envelope('checked-before-soft'))).check_result_id, result.check_result_id);
  await assert.rejects(judge.checkWorkspaceSource(input('new-check'), envelope('new-check')), error => error.code === 'NOT_ALLOWED' && error.details.phase === 'soft_closeout');
  await assert.rejects(judge.checkWorkspaceSource({ ...input('checked-before-soft'), source: { ...input('checked-before-soft').source, content: 'theorem changed : True := by trivial' } }, envelope('checked-before-soft')), { code: 'CONFLICT' });
  assert.equal(counts.check, 1);
});

test('preflight crossing soft closeout records a replayable request failure without starting scientific checking', async t => {
  let entered, release;
  const entering = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const { judge, input, envelope, closeout, counts } = fixture(t, { preflight: async () => { entered(); await held; } });
  const checking = judge.checkWorkspaceSource(input('held-preflight'), envelope('held-preflight'));
  await entering; closeout(); release();
  const result = await checking;
  assert.equal(result.result_class, 'request_failure');
  assert.equal(result.diagnostic_code, 'soft_closeout');
  assert.equal((await judge.checkWorkspaceSource(input('held-preflight'), envelope('held-preflight'))).check_result_id, result.check_result_id);
  assert.deepEqual(counts, { preflight: 1, check: 0 });
});

test('public Judge admission fails closed when it cannot share Task lifecycle authority', async t => {
  const { judge, input, envelope, counts } = fixture(t);
  judge.taskService = null;
  await assert.rejects(judge.checkWorkspaceSource(input('no-authority'), envelope('no-authority')), { code: 'SERVICE_NOT_READY' });
  assert.deepEqual(counts, { preflight: 0, check: 0 });
});

for (const boundary of ['soft', 'closing']) test(`actual continuation dispatch rereads ${boundary} phase after Session readiness`, async t => {
  const { runTurn } = await import('../src/benchmark/putnam-runner.js');
  const { BOT_CONTINUATION_MESSAGE, BOT_SOFT_CLOSEOUT_MESSAGE } = await import('../src/agent/bot-contract.js');
  const { tasks, task, envelope, closeout } = fixture(t);
  let ready, release;
  const entering = new Promise(resolve => { ready = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const sent = [];
  const session = { rpcRecords: [], waitForReady: async () => { ready(); await held; }, prompt: async text => { sent.push(text); return { data: { disposition: 'handled' } }; } };
  const core = { index: 1, taskId: task.task_id, executionId: envelope('read').execution_id, session, runtime: { taskService: tasks },
    parallelism: { beginAgentTurn() {}, endAgentTurn() {}, recordTurnTime() {} }, turnStartedAt: Date.now(), turns: 0, errors: [], toolEvents: [], turnDurationsMs: [], turnIntervalMs: 0 };
  const running = runTurn(core, BOT_CONTINUATION_MESSAGE, 1000);
  await entering;
  if (boundary === 'soft') closeout();
  else { tasks.requestBotStop('bounded', 'controlled-stop', { terminalState: 'FAILED' }); assert.equal(tasks.getExecution(core.executionId).state, 'RUNNING'); }
  release(); await running;
  if (boundary === 'soft') {
    assert.equal(sent.length, 1);
    assert.ok(sent[0].startsWith(`E ${core.executionId} 接近 Execution 时间上限，收尾额度为 `));
    assert.ok(sent[0].endsWith(BOT_SOFT_CLOSEOUT_MESSAGE));
  } else assert.deepEqual(sent, []);
  assert.deepEqual(core.errors, []);
});

test('late lifecycle rejection does not accuse an unexamined source of cheating', async t => {
  let entered, release;
  const entering = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const { judge, input, envelope, closeout, counts } = fixture(t, { preflight: async () => { entered(); await held; } });
  const request = input('unexamined'); request.source.content += '\n-- sorry was a prior diagnostic';
  const checking = judge.checkWorkspaceSource(request, envelope('unexamined'));
  await entering; closeout(); release();
  const result = await checking;
  assert.equal(result.result_class, 'request_failure'); assert.equal(result.diagnostic_code, 'soft_closeout');
  assert.equal(result.evidence.forbidden_placeholder, undefined);
  assert.equal(counts.check, 0);
});

for (const phase of ['preflight', 'source-preparation']) test(`production Lean adapter cannot launch after ${phase} crosses soft closeout`, async t => {
  const { LeanChecker } = await import('../src/judge/lean-adapter.js');
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createHash } = await import('node:crypto');
  const root = await mkdtemp(join(tmpdir(), 'closeout-lean-')); t.after(() => rm(root, { recursive: true, force: true }));
  const { judge, input, envelope, closeout } = fixture(t);
  const source = 'theorem fixture : True := by trivial';
  await writeFile(join(root, 'input.lean'), source);
  judge.fixtureManifest.project_root = root;
  judge.fixtureManifest.problem_file_hash = createHash('sha256').update(source).digest('hex');
  let launches = 0;
  const lean = new LeanChecker({ workRoot: root, runner: async () => { launches += 1; return { exit_code: 0, stdout: 'Lean (version 4.33.1)', stderr: '' }; } });
  if (phase === 'preflight') judge.checker.preflight = args => { const preparing = lean.preflight(args); closeout(); return preparing; };
  else judge.checker.check = args => { const preparing = lean.check(args); closeout(); return preparing; };
  const result = await judge.checkWorkspaceSource(input(`late-${phase}`), envelope(`late-${phase}`));
  assert.equal(result.result_class, 'request_failure'); assert.equal(result.diagnostic_code, 'soft_closeout');
  assert.equal(result.evidence.forbidden_placeholder, undefined);
  assert.equal(launches, 0);
});

test('real second connection cannot accept finish during synchronous Lean spawn and can afterward', async t => {
  const { LeanChecker } = await import('../src/judge/lean-adapter.js');
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createHash } = await import('node:crypto');
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { DatabaseSync } = await import('node:sqlite');
  const root = await mkdtemp(join(tmpdir(), 'closeout-judge-writer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = join(root, 'task.sqlite');
  const { judge, input, envelope } = fixture(t, { database, judgeDb: join(root, 'judge.sqlite') });
  const rival = new TaskService(new DatabaseSync(database));
  rival.db.exec('PRAGMA busy_timeout = 0');
  t.after(() => { rival.close(); judge.db.close(); });
  const source = 'theorem fixture : True := by trivial';
  await writeFile(join(root, 'input.lean'), source);
  judge.fixtureManifest.project_root = root;
  judge.fixtureManifest.problem_file_hash = createHash('sha256').update(source).digest('hex');
  const executionEnvelope = envelope('genuine-finish');
  const rivalFinish = () => rival.dispatch('task_finish', { outcome: 'incomplete' }, executionEnvelope);
  let checkerStarted;
  let launches = 0;
  const entered = new Promise(resolve => { checkerStarted = resolve; });
  let release;
  const waitForFinish = new Promise(resolve => { release = resolve; });
  const checker = new LeanChecker({ workRoot: root, runner: (command, args) => {
    launches += 1;
    assert.throws(rivalFinish, error => error.errcode === 5);
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const closed = once(child, 'close');
    if (args.at(-1) !== '--version') checkerStarted();
    return closed.then(async ([exit_code]) => {
      if (args.at(-1) !== '--version') await waitForFinish;
      return { exit_code, stdout: 'Lean (version 4.33.1)', stderr: '' };
    });
  } });
  judge.fixtureManifest.lean_toolchain = 'leanprover/lean4:v4.33.1';
  judge.fixtureManifest.checker_ref = checker.checkerRef;
  judge.fixtureManifest.checker_version = checker.checkerVersion;
  judge.checker = checker;
  const check = judge.checkWorkspaceSource(input('spawn-writer'), envelope('spawn-writer'));
  await Promise.race([entered, check.then(result => assert.fail(JSON.stringify(result.evidence)))]);
  assert.equal(rivalFinish().execution.state, 'CLOSING');
  release();
  const result = await check;
  assert.equal(launches, 2);
  assert.equal(result.verdict, 'PASS');
});

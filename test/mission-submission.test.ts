import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { MissionSubmissionStore } from '../src/runtime/mission-submission.js';
import { MissionWorkspace } from '../src/runtime/mission-workspace.js';

const identity = { checker_ref: 'lean', checker_version: '1', environment_ref: 'locked' };
const root = { missionId: 'mission:m', workspaceId: 'workspace-m', actorRef: 'bot:first', materialIds: [] };

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'swarmenv-submit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const workspace = new MissionWorkspace({ rootDir: dir });
  await workspace.create({ missionId: root.missionId, workspaceId: root.workspaceId, initialFiles: { 'proof.lean': 'initial' } });
  const database = new DatabaseSync(join(dir, 'submission.sqlite'));
  t.after(() => database.close());
  const checkerCalls = [];
  const config = {
    database, workspace,
    authorize: () => ({ acceptance: { required_check: identity } }),
    validateCompletion: () => true,
    checker: { identity, check: input => new Promise(resolve => checkerCalls.push({ input, resolve })) },
    ...options,
  };
  return { workspace, database, checkerCalls, config, store: new MissionSubmissionStore(config) };
}

async function until(read, condition) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await read();
    if (condition(value)) return value;
    await delay(5);
  }
  assert.fail('condition did not settle');
}

test('Mission freezes a fixed tree and observed Material, replays IDs and caches scientific failures', async t => {
  const material = { material_id: 'm:1', version: 'v1', content_hash: 'a'.repeat(64), observed_state: 'current' };
  const { workspace, store, checkerCalls } = await fixture(t, { snapshotMaterials: () => [material] });
  const input = { ...root, materialIds: ['m:1'], requestId: 'check-1' };
  const submitted = await store.submit(input);
  assert.equal(submitted.state, 'pending');
  assert.equal(submitted.main_revision, '0.1');
  assert.equal(submitted.materials[0].observed_state, 'current');
  material.observed_state = 'superseded';
  assert.equal(checkerCalls[0].input.files['proof.lean'].toString(), 'initial');
  assert.equal(checkerCalls[0].input.tree, submitted.git_tree);
  assert.deepEqual(await store.submit(input), submitted);
  await assert.rejects(store.submit({ ...input, materialIds: [] }), { code: 'CONFLICT' });
  await assert.rejects(store.submit({ ...input, requestId: 'other' }), { code: 'CONFLICT' });
  await assert.rejects(workspace.merge({ workspaceId: root.workspaceId, fromRevision: '0.1' }), { code: 'MISSION_SUBMITTING' });
  await assert.rejects(store.finish({ ...root, submissionId: 'check-1', verdict: 'PASS' }), { code: 'NOT_ALLOWED' });
  material.observed_state = 'current';
  checkerCalls[0].resolve({ verdict: 'FAIL' });
  const failed = await until(() => store.get({ ...root, submissionId: 'check-1' }), row => row.state === 'failed' && !row.release_pending);
  assert.equal(failed.materials[0].observed_state, 'current');
  assert.equal((await store.submit({ ...input, requestId: 'check-repeat' })).reused_submission_id, 'check-1');
  assert.equal(checkerCalls.length, 1);
  assert.equal((await workspace.get({ workspaceId: root.workspaceId })).frozen_submission_id, null);
});

test('timeout thaws its own freeze and late PASS cannot affect another submission', async t => {
  const { workspace, store, checkerCalls, database } = await fixture(t, { timeoutMs: 500, maxInfrastructureRetries: 1, maxConcurrentFinalChecks: 2 });
  const first = await store.submit({ ...root, requestId: 'check-1' });
  await until(() => store.get({ ...root, submissionId: 'check-1' }), row => row.state === 'timed_out' && !row.release_pending);
  const second = await store.submit({ ...root, requestId: 'check-2' });
  assert.ok(second.freeze_epoch > first.freeze_epoch);
  checkerCalls[0].resolve({ verdict: 'PASS' });
  await until(() => database.prepare("SELECT count(*) AS total FROM mission_submission_audit WHERE event = 'late_accepted'").get(), row => row.total > 0);
  assert.equal(store.isAccepted(root.missionId), false);
  assert.equal((await workspace.get({ workspaceId: root.workspaceId })).frozen_submission_id, second.freeze_id);
  checkerCalls[1].resolve({ verdict: 'FAIL' });
  await until(() => store.get({ ...root, submissionId: 'check-2' }), row => row.state === 'failed' && !row.release_pending);
});

test('recovery retries accepted stop hook, preserves main freeze and does not rerun the checker', async t => {
  let stops = 0;
  const { workspace, store, checkerCalls, config } = await fixture(t, { onAccepted: async () => {
    if (++stops === 1) throw new Error('controller unavailable');
  } });
  const input = { ...root, requestId: 'check-1' };
  const submission = await store.submit(input);
  checkerCalls[0].resolve({ verdict: 'PASS', check_result_id: 'proof-check' });
  await until(() => store.get({ ...root, submissionId: 'check-1' }), row => row.state === 'accepted' && stops === 1);
  assert.equal(store.isAccepted(root.missionId), true);
  const restarted = new MissionSubmissionStore(config);
  await restarted.reconcile(root);
  const done = await restarted.submit(input);
  assert.equal(done.stop_pending, false);
  assert.equal(done.result.check_result_id, 'proof-check');
  assert.equal((await workspace.get({ workspaceId: root.workspaceId })).frozen_submission_id, submission.freeze_id);
  assert.equal(checkerCalls.length, 1);
});

test('authorization is rechecked after async snapshot reads and before checker admission', async t => {
  let eligible = true;
  const { workspace, store, checkerCalls } = await fixture(t, {
    authorize: () => eligible ? { acceptance: { required_check: identity } } : null,
    snapshotMaterials: async () => {
      eligible = false;
      return [{ material_id: 'm:1', version: '1', content_hash: 'a'.repeat(64) }];
    },
  });
  assert.equal((await store.submit({ ...root, requestId: 'check-1', materialIds: ['m:1'] })).result.code, 'NOT_ALLOWED');
  assert.equal(checkerCalls.length, 0);
  assert.equal((await workspace.get({ workspaceId: root.workspaceId })).frozen_submission_id, null);
});

test('admission crash after Workspace freeze leaves recoverable intent and never launches checker', async t => {
  const { workspace, database, store, checkerCalls, config } = await fixture(t);
  database.exec(`CREATE TRIGGER interrupt_admission BEFORE UPDATE ON mission_submissions
    WHEN NEW.state = 'pending' BEGIN SELECT RAISE(ABORT, 'interrupted'); END;`);
  const request = { ...root, requestId: 'interrupted' };
  const failed = await store.submit(request);
  assert.equal(failed.state, 'error');
  assert.equal(failed.release_pending, true);
  await store.waitForIdle();
  assert.equal((await workspace.get({ workspaceId: root.workspaceId })).frozen_submission_id, null);
  assert.equal(checkerCalls.length, 0);
  const recovery = new MissionSubmissionStore(config);
  database.exec('DROP TRIGGER interrupt_admission');
  await recovery.reconcile(root);
  const replay = await recovery.submit(request);
  assert.equal(replay.state, 'error');
  assert.equal(replay.result.code, failed.result.code);
  assert.equal(checkerCalls.length, 0);
});

test('lost unfreeze response reconciles only previous owner and records release complete', async t => {
  const { workspace, store, checkerCalls, config } = await fixture(t);
  const original = workspace.unfreeze.bind(workspace);
  let loseResponse = true;
  workspace.unfreeze = async input => {
    const result = await original(input);
    if (loseResponse) { loseResponse = false; throw new Error('response lost'); }
    return result;
  };
  await store.submit({ ...root, requestId: 'failed' });
  checkerCalls[0].resolve({ verdict: 'FAIL' });
  await until(() => store.get({ ...root, submissionId: 'failed' }), row => row.release_pending);
  await until(() => loseResponse, value => value === false);
  const recovery = new MissionSubmissionStore(config);
  await recovery.reconcile(root);
  assert.equal((await recovery.get({ ...root, submissionId: 'failed' })).release_pending, false);
  assert.equal((await workspace.get({ workspaceId: root.workspaceId })).frozen_submission_id, null);
});

test('a cancelled Mission cannot accept an outstanding PASS', async t => {
  let running = true;
  const { store, checkerCalls } = await fixture(t, { validateCompletion: () => running });
  await store.submit({ ...root, requestId: 'late' });
  running = false;
  checkerCalls[0].resolve({ verdict: 'PASS' });
  const row = await until(() => store.get({ ...root, submissionId: 'late' }), item => item.state === 'cancelled' && !item.release_pending);
  assert.equal(row.result.code, 'MISSION_NO_LONGER_ACCEPTING');
  assert.equal(store.isAccepted(root.missionId), false);
});

test('stop persists cancellation and aborts the checker before awaiting its actual settlement', async t => {
  const { store, checkerCalls, database, workspace } = await fixture(t);
  await store.submit({ ...root, requestId: 'stop-check' });
  let stopped = false;
  const stopping = store.stop(root).then(() => { stopped = true; });
  await until(() => store.get({ ...root, submissionId: 'stop-check' }), row => row.state === 'cancelled' && !row.release_pending);
  assert.equal(checkerCalls[0].input.signal.aborted, true);
  assert.equal(stopped, false);
  await assert.rejects(store.submit({ ...root, requestId: 'new-check' }), { code: 'NOT_ALLOWED' });
  assert.equal((await workspace.get(root)).frozen_submission_id, null);
  checkerCalls[0].resolve({ verdict: 'PASS' });
  await stopping;
  assert.equal(store.isAccepted(root.missionId), false);
  assert.equal(database.prepare("SELECT count(*) AS total FROM mission_submission_audit WHERE event = 'late_accepted'").get().total, 1);
  await store.shutdown();
  assert.equal(database.prepare('SELECT 1 AS open').get().open, 1);
});

test('a timed-out preparation stays tracked until every snapshot read settles', async t => {
  let releaseExport;
  const { store, workspace, checkerCalls } = await fixture(t, {
    timeoutMs: 50,
    snapshotMaterials: () => { throw new Error('snapshot failed early'); },
  });
  workspace.exportRevision = () => new Promise(resolve => { releaseExport = resolve; });
  const request = { ...root, requestId: 'slow-preparation', materialIds: ['m:1'] };
  const result = await store.submit(request);
  assert.equal(result.result.code, 'SERVICE_TIMEOUT');
  assert.deepEqual(await store.submit(request), result);
  let stopped = false;
  const stopping = store.stop(root).then(() => { stopped = true; });
  await delay(5);
  assert.equal(stopped, false);
  releaseExport({});
  await stopping;
  assert.equal((await store.get({ ...root, submissionId: 'slow-preparation' })).state, 'timed_out');
  assert.equal(checkerCalls.length, 0);
});

test('shutdown closes only a self-owned database after actual idle', async () => {
  const store = new MissionSubmissionStore();
  await store.shutdown();
  assert.throws(() => store.db.prepare('SELECT 1'), /not open/i);
});

test('concurrent same ID sees durable preparation, different IDs cannot start competing reads', async t => {
  let resume;
  let reads = 0;
  const config = {
    snapshotMaterials: () => {
      reads += 1;
      return new Promise(resolve => { resume = resolve; });
    },
  };
  const { config: storeConfig, store, checkerCalls } = await fixture(t, config);
  const other = new MissionSubmissionStore(storeConfig);
  const input = { ...root, materialIds: ['m:1'], requestId: 'first' };
  const preparing = store.submit(input);
  assert.equal((await other.submit(input)).state, 'preparing');
  await assert.rejects(other.submit({ ...input, requestId: 'competing' }), { code: 'CONFLICT' });
  await assert.rejects(other.submit({ ...input, materialIds: [] }), { code: 'CONFLICT' });
  assert.equal(reads, 1);
  resume([{ material_id: 'm:1', version: 'v1', content_hash: 'a'.repeat(64) }]);
  assert.equal((await preparing).state, 'pending');
  checkerCalls[0].resolve({ verdict: 'FAIL' });
  await store.waitForIdle();
});

test('a source read failure has a durable terminal receipt before a later retry', async t => {
  let reads = 0;
  const { store, checkerCalls } = await fixture(t, { snapshotMaterials: () => {
    reads += 1;
    throw new Error('Material read failed');
  } });
  const input = { ...root, materialIds: ['m:1'], requestId: 'unreadable' };
  const result = await store.submit(input);
  assert.equal(result.state, 'error');
  assert.deepEqual(await store.submit(input), result);
  assert.equal(reads, 1);
  assert.equal(checkerCalls.length, 0);
});

test('abort-triggered PASS cannot overtake an explicit durable cancellation', async t => {
  const { workspace, store } = await fixture(t, { checker: {
    identity,
    check: ({ signal }) => new Promise(resolve => {
      signal.addEventListener('abort', () => resolve({ verdict: 'PASS' }), { once: true });
    }),
  } });
  await store.submit({ ...root, requestId: 'cancel' });
  const cancelled = await store.cancel({ ...root, submissionId: 'cancel' });
  assert.equal(cancelled.state, 'cancelled');
  await store.waitForIdle();
  assert.equal(store.isAccepted(root.missionId), false);
  assert.equal((await workspace.get(root)).frozen_submission_id, null);
});

test('main movement during preparation records a terminal receipt without resurrecting the old main', async t => {
  const { workspace, store, checkerCalls } = await fixture(t);
  const saved = await workspace.save({ workspaceId: root.workspaceId, baseRevision: '0.1',
    files: { 'proof.lean': 'new' }, requestId: 'save-next' });
  const original = workspace.exportRevision.bind(workspace);
  let merged;
  workspace.exportRevision = async input => {
    const snapshot = await original(input);
    merged = await workspace.merge({ workspaceId: root.workspaceId, fromRevision: saved.revision, requestId: 'move-main' });
    return snapshot;
  };
  const request = { ...root, requestId: 'old-main' };
  const result = await store.submit(request);
  assert.equal(result.state, 'error');
  assert.equal(result.result.code, 'MAIN_MOVED');
  assert.deepEqual(await store.submit(request), result);
  assert.equal(checkerCalls.length, 0);
  assert.equal((await workspace.get(root)).main_revision, merged.main_revision);
});

test('cancellation on a second connection wins before the preparing intent can publish a freeze', async t => {
  const { workspace, checkerCalls, config } = await fixture(t);
  const secondDb = new DatabaseSync(config.database.location());
  t.after(() => secondDb.close());
  const peer = new MissionSubmissionStore({ ...config, database: secondDb });
  let validations = 0;
  let peerCancel;
  const store = new MissionSubmissionStore({ ...config, authorize: input => {
    // The call inside the Workspace lock follows its initial 'preparing' read
    // but precedes writing the intended freeze epoch.
    if (++validations === 3) peerCancel = peer.cancel({ ...root, submissionId: input.requestId });
    return config.authorize(input);
  } });
  const result = await store.submit({ ...root, requestId: 'cross-process-race' });
  await peerCancel;
  assert.equal(result.state, 'cancelled');
  assert.equal(checkerCalls.length, 0);
  assert.equal((await workspace.get(root)).frozen_submission_id, null);
});

test('checker PASS with an unavailable completion authority is a terminal error with bounded checker audit', async t => {
  const { store, database, checkerCalls } = await fixture(t, {
    validateCompletion: () => { throw new Error('validation unavailable'); },
  });
  await store.submit({ ...root, requestId: 'authority-error' });
  checkerCalls[0].resolve({ verdict: 'PASS', check_result_id: 'pass-proof', diagnostic: 'evidence for the late checker'.repeat(200) });
  const outcome = await until(() => store.get({ ...root, submissionId: 'authority-error' }),
    row => row.state === 'error' && !row.release_pending);
  assert.equal(outcome.result.code, 'MISSION_ACCEPTANCE_VALIDATION_ERROR');
  const audit = JSON.parse(database.prepare("SELECT details_json FROM mission_submission_audit WHERE event = 'acceptance_validation_error'").get().details_json);
  assert.equal(audit.result.check_result_id, 'pass-proof');
  assert.equal(audit.result.verdict, 'PASS');
  assert.equal(audit.result.diagnostic.length, 2048);
  assert.equal(audit.freeze_epoch, outcome.freeze_epoch);
  assert.equal(audit.git_tree, outcome.git_tree);
});

test('an unknown required checker attribute cannot silently weaken a locked Mission', async t => {
  const { store, checkerCalls } = await fixture(t, {
    authorize: () => ({ acceptance: { required_check: { ...identity, proof_policy: 'custom' } } }),
  });
  await assert.rejects(store.submit({ ...root, requestId: 'unknown-attribute' }), { code: 'SERVICE_NOT_READY' });
  assert.equal(checkerCalls.length, 0);
});

test('infrastructure retries are bounded for one fixed snapshot and retain lineage', async t => {
  const { store, checkerCalls } = await fixture(t, { maxInfrastructureRetries: 1 });
  const first = await store.submit({ ...root, requestId: 'attempt-1' });
  assert.equal(first.attempt_number, 1);
  checkerCalls[0].resolve({ verdict: 'ERROR' });
  await store.waitForIdle();
  const second = await store.submit({ ...root, requestId: 'attempt-2' });
  assert.equal(second.attempt_number, 2);
  assert.equal(second.attempt_of, first.submission_id);
  assert.equal(second.snapshot_fingerprint, first.snapshot_fingerprint);
  checkerCalls[1].resolve({ verdict: 'ERROR' });
  await store.waitForIdle();
  const third = await store.submit({ ...root, requestId: 'attempt-3' });
  assert.equal(third.result.code, 'MISSION_RETRY_EXHAUSTED');
  assert.equal(checkerCalls.length, 2);
  assert.deepEqual(await store.submit({ ...root, requestId: 'attempt-3' }), third);
});

test('final checker budget holds timed-out work until actual settlement and limits changed snapshots', async t => {
  const { workspace, store, checkerCalls, config } = await fixture(t, { timeoutMs: 500, maxInfrastructureRetries: 1, maxFinalChecks: 2 });
  await store.submit({ ...root, requestId: 'pending-first' });
  await until(() => store.get({ ...root, submissionId: 'pending-first' }), row => row.state === 'timed_out' && !row.release_pending);
  const separateStore = new MissionSubmissionStore(config);
  assert.deepEqual(separateStore.getFinalCheckBudget(root.missionId), { max_checks: 2, max_concurrent: 1, admitted_checks: 1, active_checks: 1 });
  const blocked = await separateStore.submit({ ...root, requestId: 'blocked-while-cleaning' });
  assert.deepEqual(blocked.result, { code: 'CHECKER_BUSY', retryable: true });
  assert.equal(checkerCalls.length, 1);
  checkerCalls[0].resolve({ verdict: 'PASS' });
  await until(() => store.getFinalCheckBudget(root.missionId), budget => budget.active_checks === 0);
  assert.equal(store.isAccepted(root.missionId), false);
  const retry = await store.submit({ ...root, requestId: 'successful-admission' });
  assert.equal(retry.state, 'pending');
  checkerCalls[1].resolve({ verdict: 'FAIL' });
  await until(() => store.get({ ...root, submissionId: retry.submission_id }), row => row.state === 'failed' && !row.release_pending);
  assert.equal((await store.submit({ ...root, requestId: 'cached' })).state, 'reused');
  const saved = await workspace.save({ workspaceId: root.workspaceId, baseRevision: '0.1',
    files: { 'proof.lean': 'changed' }, requestId: 'changed-proof', core: 1 });
  await workspace.merge({ workspaceId: root.workspaceId, fromRevision: saved.revision, requestId: 'changed-main' });
  assert.deepEqual((await store.submit({ ...root, requestId: 'over-limit' })).result, { code: 'CHECKER_BUDGET_EXHAUSTED', retryable: false });
  assert.equal(store.getFinalCheckBudget(root.missionId).admitted_checks, 2);
  assert.equal(checkerCalls.length, 2);
});


test('explicit unlimited final checks admit six distinct candidates across reopen with finite cleanup concurrency', async t => {
  const { workspace, store, config, checkerCalls } = await fixture(t, { maxFinalChecks: null });
  assert.deepEqual(store.getFinalCheckBudget(root.missionId), { max_checks: null, max_concurrent: 1, admitted_checks: 0, active_checks: 0 });
  let current = store;
  for (let index = 0; index < 6; index += 1) {
    const main = await workspace.get({ workspaceId: root.workspaceId });
    const saved = await workspace.save({ workspaceId: root.workspaceId, baseRevision: main.main_revision,
      files: { 'proof.lean': `candidate ${index}` }, requestId: `candidate-save-${index}`, core: 1 });
    await workspace.merge({ workspaceId: root.workspaceId, fromRevision: saved.revision, requestId: `candidate-merge-${index}` });
    const submission = await current.submit({ ...root, requestId: `candidate-check-${index}` });
    assert.equal(submission.state, 'pending');
    assert.deepEqual(current.getFinalCheckBudget(root.missionId), { max_checks: null, max_concurrent: 1, admitted_checks: index + 1, active_checks: 1 });
    checkerCalls[index].resolve({ verdict: 'FAIL' });
    await current.waitForIdle();
    current = new MissionSubmissionStore(config);
  }
  assert.equal(checkerCalls.length, 6);
  assert.deepEqual(current.getFinalCheckBudget(root.missionId), { max_checks: null, max_concurrent: 1, admitted_checks: 6, active_checks: 0 });
  const incompatible = new MissionSubmissionStore({ ...config, maxFinalChecks: 4 });
  assert.equal(incompatible.getFinalCheckBudget(root.missionId).max_checks, null);
  assert.throws(() => new MissionSubmissionStore({ ...config, maxConcurrentFinalChecks: Infinity }), /concurrent/);
});

test('legacy persisted finite policies retain their limit and usage when unlimited support is opened', async t => {
  const legacy = new DatabaseSync(':memory:');
  t.after(() => legacy.close());
  legacy.exec(`CREATE TABLE mission_final_check_policies (
    mission_id TEXT PRIMARY KEY, max_checks INTEGER NOT NULL CHECK(max_checks > 0),
    max_concurrent INTEGER NOT NULL CHECK(max_concurrent > 0 AND max_concurrent <= max_checks));
    INSERT INTO mission_final_check_policies VALUES ('mission:m', 2, 1);
    CREATE TABLE mission_final_check_admissions (mission_id TEXT NOT NULL, submission_id TEXT NOT NULL,
      admitted_at TEXT NOT NULL, settled_at TEXT, PRIMARY KEY (mission_id, submission_id));
    INSERT INTO mission_final_check_admissions VALUES ('mission:m', 'historical', '2026-01-01', '2026-01-01');`);
  const { store, config, checkerCalls, workspace } = await fixture(t, { database: legacy, maxFinalChecks: 2 });
  assert.deepEqual(store.getFinalCheckBudget(root.missionId), { max_checks: 2, max_concurrent: 1, admitted_checks: 1, active_checks: 0 });
  const unlimited = new MissionSubmissionStore({ ...config, maxFinalChecks: null });
  assert.equal((await unlimited.submit({ ...root, requestId: 'cannot-change-policy' })).result.code, 'SERVICE_NOT_READY');
  assert.equal(checkerCalls.length, 0);
  const candidate = await store.submit({ ...root, requestId: 'last-admission' });
  assert.equal(candidate.state, 'pending');
  checkerCalls[0].resolve({ verdict: 'FAIL' });
  await store.waitForIdle();
  const main = await workspace.get({ workspaceId: root.workspaceId });
  const saved = await workspace.save({ workspaceId: root.workspaceId, baseRevision: main.main_revision,
    files: { 'proof.lean': 'new candidate' }, requestId: 'over-budget-save', core: 1 });
  await workspace.merge({ workspaceId: root.workspaceId, fromRevision: saved.revision, requestId: 'over-budget-merge' });
  const reopened = new MissionSubmissionStore(config);
  assert.deepEqual((await reopened.submit({ ...root, requestId: 'over-budget' })).result, { code: 'CHECKER_BUDGET_EXHAUSTED', retryable: false });
  assert.equal(checkerCalls.length, 1);
  await workspace.create({ missionId: 'mission:unlimited', workspaceId: 'workspace-unlimited', initialFiles: { 'proof.lean': 'fresh' } });
  const fresh = await unlimited.submit({ ...root, missionId: 'mission:unlimited', workspaceId: 'workspace-unlimited', requestId: 'new-unlimited-policy' });
  assert.equal(fresh.state, 'pending');
  checkerCalls[1].resolve({ verdict: 'FAIL' });
  await unlimited.waitForIdle();
  assert.equal(unlimited.getFinalCheckBudget('mission:unlimited').max_checks, null);
  const { store: defaults } = await fixture(t);
  assert.deepEqual(defaults.getFinalCheckBudget(root.missionId), { max_checks: 4, max_concurrent: 1, admitted_checks: 0, active_checks: 0 });
});

test('unlimited final checks keep timed-out resources within the finite concurrent limit', async t => {
  const { store, config, checkerCalls } = await fixture(t, { maxFinalChecks: null, timeoutMs: 500, maxInfrastructureRetries: 1 });
  await store.submit({ ...root, requestId: 'unlimited-timeout' });
  await until(() => store.get({ ...root, submissionId: 'unlimited-timeout' }), row => row.state === 'timed_out' && !row.release_pending);
  const reopened = new MissionSubmissionStore(config);
  assert.deepEqual((await reopened.submit({ ...root, requestId: 'unlimited-busy' })).result, { code: 'CHECKER_BUSY', retryable: true });
  assert.equal(checkerCalls.length, 1);
  checkerCalls[0].resolve({ verdict: 'FAIL' });
  await store.waitForIdle();
  assert.deepEqual(reopened.getFinalCheckBudget(root.missionId), { max_checks: null, max_concurrent: 1, admitted_checks: 1, active_checks: 0 });
});

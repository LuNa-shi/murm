import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { MissionWorkspace } from '../src/runtime/mission-workspace.js';
import { MissionSubmissionStore } from '../src/runtime/mission-submission.js';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../scripts/review-mission.mjs', import.meta.url));
const identity = { checker_ref: 'manual-operator', checker_version: 'review-policy-1', environment_ref: 'owner-review' };
const input = { missionId: 'mission:first', workspaceId: 'workspace-first', actorRef: 'bot:first', materialIds: [], requestId: 'manual-1' };

async function fixture(t, timeoutMs = 5000) {
  const directory = await mkdtemp(join(tmpdir(), 'manual-mission-review-'));
  const file = join(directory, 'state.sqlite');
  const database = new DatabaseSync(file);
  await chmod(file, 0o600);
  const workspace = new MissionWorkspace({ rootDir: directory });
  await workspace.create({ missionId: input.missionId, workspaceId: input.workspaceId, initialFiles: { proof: 'fixed' } });
  const config = { database, workspace, authorize: () => ({ acceptance: { required_check: identity } }),
    validateCompletion: () => true, manualReview: { checkerVersion: identity.checker_version, environmentRef: identity.environment_ref, timeoutMs } };
  const store = new MissionSubmissionStore(config);
  t.after(async () => { await store.shutdown(); database.close(); await rm(directory, { recursive: true, force: true }); });
  const run = async (mode, ...args) => JSON.parse((await exec(process.execPath, [cli, mode, file, input.missionId, input.requestId, ...args])).stdout);
  return { config, directory, file, run, store, workspace };
}

async function completed(store, state) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const row = await store.get({ missionId: input.missionId, submissionId: input.requestId });
    if (row.state === state && !row.release_pending) return row;
    await delay(10);
  }
  assert.fail(`Mission did not reach ${state}`);
}

test('owner-local CLI reviews the fixed snapshot and records an idempotent decision for the Mission store', async t => {
  const { config, run, store, workspace } = await fixture(t);
  assert.throws(() => new MissionSubmissionStore({ ...config, checker: { identity } }), /Select either/);
  const submitted = await store.submit(input);
  const snapshot = await run('show');
  assert.equal(snapshot.snapshot_fingerprint, submitted.snapshot_fingerprint);
  assert.equal(snapshot.main_commit, submitted.main_commit);
  assert.equal(snapshot.git_tree, submitted.git_tree);
  assert.deepEqual(snapshot.checker, identity);
  assert.deepEqual(snapshot.materials, []);
  await assert.rejects(run('decide', '0'.repeat(64), 'PASS', 'review-1', 'reason'), /snapshot fingerprint is stale/);
  const args = [snapshot.snapshot_fingerprint, 'PASS', 'review-1', 'Checked the pinned input.'];
  const review = await run('decide', ...args);
  assert.equal(review.timely, true);
  assert.deepEqual(review.reviewer, { uid: userInfo().uid, username: userInfo().username });
  const result = await completed(store, 'accepted');
  assert.equal(result.result.check_result_id, review.review_id);
  assert.equal(result.result.diagnostic, null);
  assert.deepEqual(await run('decide', ...args), review);
  await assert.rejects(run('decide', snapshot.snapshot_fingerprint, 'FAIL', 'review-1', 'different'), /different decision/);
  assert.equal((await workspace.get({ workspaceId: input.workspaceId })).frozen_submission_id, submitted.freeze_id);
});

test('cancelled and expired manual decisions remain audit receipts and cannot accept the Mission', async t => {
  for (const state of ['cancelled', 'timed_out']) {
    const { run, store, workspace } = await fixture(t, state === 'timed_out' ? 500 : 5000);
    const submitted = await store.submit(input);
    if (state === 'cancelled') await store.cancel({ missionId: input.missionId, submissionId: input.requestId });
    await completed(store, state);
    const audit = await run('decide', submitted.snapshot_fingerprint, 'PASS', 'late-review', 'Finished after closeout.');
    assert.equal(audit.observed_state, state);
    assert.equal(audit.timely, false);
    assert.equal(store.isAccepted(input.missionId), false);
    assert.equal((await workspace.get({ workspaceId: input.workspaceId })).frozen_submission_id, null);
  }
});

test('operator CLI refuses shared database modes and symlink paths', async t => {
  const { directory, file, run, store } = await fixture(t);
  await store.submit(input);
  await chmod(file, 0o644);
  await assert.rejects(run('show'), /owner-private regular file/);
  await chmod(file, 0o600);
  const alias = join(directory, 'alias.sqlite');
  await symlink(file, alias);
  await assert.rejects(exec(process.execPath, [cli, 'show', alias, input.missionId, input.requestId]), /ELOOP/);
  await store.cancel({ missionId: input.missionId, submissionId: input.requestId });
});

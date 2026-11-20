import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { MissionWorkspace } from '../src/runtime/mission-workspace.js';
import { readWorkspaceHistory, WORKSPACE_HISTORY_DIR } from '../src/runtime/workspace-repository.js';
import { restoreWorkspaceAt } from '../src/replay/workspace-history.js';

const run = promisify(execFile);
const time = second => `2026-01-02T03:04:${String(second).padStart(2, '0')}.000Z`;

async function fixture(t, { fault = null } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'workspace-time-replay-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourceRoot = join(directory, 'original');
  let clock = time(0);
  const store = new MissionWorkspace({ rootDir: sourceRoot, clock: () => clock, fault });
  const workspaceId = 'workspace-history';
  await store.create({ workspaceId, missionId: 'mission-history', initialFiles: { 'keep.txt': 'original', 'remove.txt': 'old' }, metadata: { input_hash: 'fixed-input' } });
  return { directory, sourceRoot, store, workspaceId, setTime: second => { clock = time(second); } };
}

async function fingerprint(directory) {
  const values = [];
  async function visit(root, prefix = '') {
    for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) await visit(join(root, entry.name), `${relative}/`);
      else values.push([relative, createHash('sha256').update(await readFile(join(root, entry.name))).digest('hex')]);
    }
  }
  await visit(directory);
  return values;
}

test('completed Workspace can be restored at unplanned earlier times, with save distinct from main', async t => {
  const f = await fixture(t);
  f.setTime(10);
  const saved = await f.store.save({ workspaceId: f.workspaceId, requestId: 'saved-past', files: { 'keep.txt': 'proof', 'binary.bin': Buffer.from([0, 255, 128]) } });
  f.setTime(20);
  const merged = await f.store.merge({ workspaceId: f.workspaceId, fromRevision: saved.revision, requestId: 'merged-past' });
  f.setTime(30);
  const future = await f.store.save({ workspaceId: f.workspaceId, requestId: 'saved-future', files: { 'future.txt': 'must not be visible' } });
  f.setTime(40);
  await f.store.merge({ workspaceId: f.workspaceId, fromRevision: future.revision, requestId: 'merged-future' });
  const sourceBefore = await fingerprint(f.sourceRoot);

  // All time choices happen after the entire original run has finished.
  const destinationRoot = join(f.directory, 'at-save');
  const restored = await restoreWorkspaceAt({ sourceRoot: f.sourceRoot, destinationRoot, workspaceId: f.workspaceId, at: time(15) });
  assert.equal(restored.history.mode, 'recorded');
  assert.equal(restored.workspace.main_revision, '0.1');
  assert.deepEqual(restored.workspace.revisions, ['0.1', saved.revision]);
  assert.equal(restored.workspace.metadata.input_hash, 'fixed-input');
  const resumed = new MissionWorkspace({ rootDir: destinationRoot });
  assert.equal((await resumed.read({ workspaceId: f.workspaceId, path: 'keep.txt' })).content, 'original');
  assert.equal((await resumed.read({ workspaceId: f.workspaceId, revision: saved.revision, path: 'keep.txt' })).content, 'proof');
  await assert.rejects(resumed.read({ workspaceId: f.workspaceId, revision: future.revision, path: 'future.txt' }), /not published/);
  await assert.rejects(run('git', ['-C', resumed.workspacePath(f.workspaceId), 'cat-file', '-e', future.git_commit]));
  assert.equal(resumed.repository.readReceipt(resumed.workspacePath(f.workspaceId), createHash('sha256').update('saved-future').digest('hex')), null);

  const mergedRoot = join(f.directory, 'at-merge');
  const afterMerge = await restoreWorkspaceAt({ sourceRoot: f.sourceRoot, destinationRoot: mergedRoot, workspaceId: f.workspaceId, at: time(25) });
  assert.equal(afterMerge.workspace.main_revision, merged.main_revision);
  const mergedStore = new MissionWorkspace({ rootDir: mergedRoot });
  await assert.rejects(mergedStore.read({ workspaceId: f.workspaceId, path: 'remove.txt' }), /unavailable/);
  const binary = await mergedStore.read({ workspaceId: f.workspaceId, path: 'binary.bin' });
  assert.deepEqual(Buffer.from(binary.content, 'base64'), Buffer.from([0, 255, 128]));
  const continued = await mergedStore.save({ workspaceId: f.workspaceId, files: { 'continued.txt': 'new work' }, requestId: 'continued' });
  assert.equal(continued.revision, '0.4');
  const continuedMain = await mergedStore.merge({ workspaceId: f.workspaceId, fromRevision: continued.revision, requestId: 'continued-merge' });
  assert.equal(continuedMain.main_revision, '0.5');
  assert.equal((await mergedStore.read({ workspaceId: f.workspaceId, path: 'continued.txt' })).content, 'new work');
  assert.deepEqual(await fingerprint(f.sourceRoot), sourceBefore);
});

test('automatic Workspace history includes freeze and unfreeze', async t => {
  const f = await fixture(t);
  f.setTime(10);
  await f.store.freeze({ workspaceId: f.workspaceId, submissionId: 'submission-at-ten' });
  f.setTime(20);
  await f.store.unfreeze({ workspaceId: f.workspaceId, submissionId: 'submission-at-ten' });
  const frozen = await restoreWorkspaceAt({ sourceRoot: f.sourceRoot, destinationRoot: join(f.directory, 'frozen'), workspaceId: f.workspaceId, at: time(15) });
  assert.equal(frozen.workspace.frozen_submission_id, 'submission-at-ten');
  assert.equal(frozen.workspace.freeze_epoch, 1);
  const unfrozen = await restoreWorkspaceAt({ sourceRoot: f.sourceRoot, destinationRoot: join(f.directory, 'unfrozen'), workspaceId: f.workspaceId, at: time(25) });
  assert.equal(unfrozen.workspace.frozen_submission_id, null);
  assert.equal(unfrozen.workspace.freeze_epoch, 1);
});

test('old Workspace without a history journal restores from immutable revisions and main ancestry', async t => {
  const f = await fixture(t);
  f.setTime(10);
  const saved = await f.store.save({ workspaceId: f.workspaceId, baseRevision: '0.1', requestId: 'legacy-save', files: { 'keep.txt': 'first proof' } });
  f.setTime(20);
  const merged = await f.store.merge({ workspaceId: f.workspaceId, fromRevision: saved.revision, requestId: 'legacy-merge' });
  f.setTime(30);
  const unmerged = await f.store.save({ workspaceId: f.workspaceId, requestId: 'legacy-unmerged', files: { 'unmerged.txt': 'separate result' } });
  await rm(join(f.store.workspacePath(f.workspaceId), WORKSPACE_HISTORY_DIR), { recursive: true });
  const before = await fingerprint(f.sourceRoot);
  const early = await restoreWorkspaceAt({ sourceRoot: f.sourceRoot, destinationRoot: join(f.directory, 'legacy-early'), workspaceId: f.workspaceId, at: time(15) });
  assert.equal(early.history.mode, 'legacy');
  assert.equal(early.workspace.main_revision, '0.1');
  assert.deepEqual(early.workspace.revisions, ['0.1', saved.revision]);
  const lateRoot = join(f.directory, 'legacy-late');
  const late = await restoreWorkspaceAt({ sourceRoot: f.sourceRoot, destinationRoot: lateRoot, workspaceId: f.workspaceId, at: time(35) });
  assert.equal(late.workspace.main_revision, merged.main_revision);
  assert.ok(late.workspace.revisions.includes(unmerged.revision));
  assert.ok(late.history.warnings.some(value => value.includes('publication')));
  const resumed = new MissionWorkspace({ rootDir: lateRoot });
  assert.equal((await resumed.read({ workspaceId: f.workspaceId, revision: unmerged.revision, path: 'unmerged.txt' })).content, 'separate result');
  assert.deepEqual(await resumed.save({ workspaceId: f.workspaceId, baseRevision: '0.1', requestId: 'legacy-save', files: { 'keep.txt': 'first proof' } }), saved);
  const repeatedRoot = join(f.directory, 'legacy-again');
  await restoreWorkspaceAt({ sourceRoot: lateRoot, destinationRoot: repeatedRoot, workspaceId: f.workspaceId, at: time(35) });
  const repeated = new MissionWorkspace({ rootDir: repeatedRoot });
  assert.deepEqual(await repeated.save({ workspaceId: f.workspaceId, baseRevision: '0.1', requestId: 'legacy-save', files: { 'keep.txt': 'first proof' } }), saved);
  assert.deepEqual(await fingerprint(f.sourceRoot), before);
});

test('events in the same millisecond retain deterministic order and inclusive cutoff', async t => {
  const f = await fixture(t);
  await f.store.save({ workspaceId: f.workspaceId, files: { 'one.txt': 'one' } });
  await f.store.save({ workspaceId: f.workspaceId, files: { 'two.txt': 'two' } });
  const events = readWorkspaceHistory(f.store.workspacePath(f.workspaceId));
  assert.deepEqual(events.map(event => event.sequence), [1, 2, 3]);
  assert.equal(new Set(events.map(event => event.committed_at)).size, 1);
  const result = await restoreWorkspaceAt({ sourceRoot: f.sourceRoot, destinationRoot: join(f.directory, 'same-time'), workspaceId: f.workspaceId, at: time(0) });
  assert.deepEqual(result.workspace.revisions, ['0.1', '0.2', '0.3']);
  assert.equal(result.workspace.main_revision, '0.1');
  await assert.rejects(restoreWorkspaceAt({ sourceRoot: f.sourceRoot, destinationRoot: join(f.directory, 'too-early'), workspaceId: f.workspaceId, at: '2026-01-02T03:03:59.999Z' }), /precedes/);
});

test('history gaps and missing public revision metadata produce concrete failures', async t => {
  const f = await fixture(t);
  f.setTime(10);
  await f.store.save({ workspaceId: f.workspaceId, files: { 'result.txt': 'result' } });
  await rm(join(f.store.workspacePath(f.workspaceId), '.swarm-revisions', '0.2.json'));
  await assert.rejects(restoreWorkspaceAt({ sourceRoot: f.sourceRoot, destinationRoot: join(f.directory, 'missing-revision'), workspaceId: f.workspaceId, at: time(15) }), { code: 'REPLAY_HISTORY_INCOMPLETE' });
  await rm(join(f.store.workspacePath(f.workspaceId), WORKSPACE_HISTORY_DIR, '000000000001.json'));
  await assert.rejects(restoreWorkspaceAt({ sourceRoot: f.sourceRoot, destinationRoot: join(f.directory, 'missing-history'), workspaceId: f.workspaceId, at: time(0) }), /missing or invalid event/);
});

test('a crash after history publication does not duplicate or overwrite the committed event', async t => {
  let crash = false;
  const f = await fixture(t, { fault: stage => { if (crash && stage === 'after_history_event') throw new Error('simulated history-head interruption'); } });
  f.setTime(10);
  crash = true;
  const request = { workspaceId: f.workspaceId, requestId: 'history-crash', files: { 'result.txt': 'retained' } };
  await assert.rejects(f.store.save(request), { code: 'WORKSPACE_RESULT_UNKNOWN' });
  await assert.rejects(restoreWorkspaceAt({ sourceRoot: f.sourceRoot, destinationRoot: join(f.directory, 'unsettled'), workspaceId: f.workspaceId, at: time(15) }), /unsettled publication/);
  const recovered = new MissionWorkspace({ rootDir: f.sourceRoot, clock: () => time(20) });
  await recovered.get({ workspaceId: f.workspaceId });
  assert.equal((await recovered.save(request)).revision, '0.2');
  const events = readWorkspaceHistory(recovered.workspacePath(f.workspaceId));
  assert.equal(events.length, 2);
  assert.equal(events[1].committed_at, time(10));
  const restored = await restoreWorkspaceAt({ sourceRoot: f.sourceRoot, destinationRoot: join(f.directory, 'recovered'), workspaceId: f.workspaceId, at: time(15) });
  assert.deepEqual(restored.workspace.revisions, ['0.1', '0.2']);
});

test('restore never overwrites an existing destination or accepts an unzoned time', async t => {
  const f = await fixture(t);
  await assert.rejects(restoreWorkspaceAt({ sourceRoot: f.sourceRoot, destinationRoot: f.sourceRoot, workspaceId: f.workspaceId, at: time(0) }), /separate/);
  await assert.rejects(restoreWorkspaceAt({ sourceRoot: f.sourceRoot, destinationRoot: join(f.directory, 'invalid-time'), workspaceId: f.workspaceId, at: '2026-01-02T03:04:00' }), /timezone/);
  const destinationRoot = join(f.directory, 'repeat');
  await restoreWorkspaceAt({ sourceRoot: f.sourceRoot, destinationRoot, workspaceId: f.workspaceId, at: time(0) });
  const before = await fingerprint(destinationRoot);
  await assert.rejects(restoreWorkspaceAt({ sourceRoot: f.sourceRoot, destinationRoot, workspaceId: f.workspaceId, at: time(0) }), { code: 'EEXIST' });
  assert.deepEqual(await fingerprint(destinationRoot), before);
});

test('recorded creation does not fall back to an earlier revision preparation timestamp', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'workspace-created-time-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourceRoot = join(directory, 'original');
  let second = 0;
  const store = new MissionWorkspace({ rootDir: sourceRoot, clock: () => time(second++) });
  await store.create({ workspaceId: 'created-later', missionId: 'mission-created-later' });
  const events = readWorkspaceHistory(store.workspacePath('created-later'));
  assert.equal(events[0].committed_at, time(3));
  await assert.rejects(restoreWorkspaceAt({ sourceRoot, destinationRoot: join(directory, 'too-early'), workspaceId: 'created-later', at: time(2) }), /precedes the committed/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MissionWorkspace } from '../examples/taskpool/services/workspace/mission-workspace.js';
import { readWorkspaceHistory, WORKSPACE_HISTORY_DIR } from '../examples/taskpool/services/workspace/workspace-repository.js';

const time = second => `2026-01-02T03:04:${String(second).padStart(2, '0')}.000Z`;

async function fixture(t, { fault = null } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'workspace-publication-history-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourceRoot = join(directory, 'public');
  let clock = time(0);
  const store = new MissionWorkspace({ rootDir: sourceRoot, clock: () => clock, fault });
  const workspaceId = 'workspace-history';
  await store.create({ workspaceId, missionId: 'mission-history', initialFiles: { 'keep.txt': 'original' } });
  return { sourceRoot, store, workspaceId, setTime: second => { clock = time(second); } };
}

test('Workspace publication events retain immutable saved bytes separately from main', async t => {
  const f = await fixture(t);
  f.setTime(10);
  const saved = await f.store.save({ workspaceId: f.workspaceId, requestId: 'saved-result',
    files: { 'keep.txt': 'proof', 'binary.bin': Buffer.from([0, 255, 128]) } });
  assert.equal((await f.store.get({ workspaceId: f.workspaceId })).main_revision, '0.1');
  assert.equal((await f.store.read({ workspaceId: f.workspaceId, path: 'keep.txt' })).content, 'original');
  assert.equal((await f.store.read({ workspaceId: f.workspaceId, revision: saved.revision, path: 'keep.txt' })).content, 'proof');
  const binary = await f.store.read({ workspaceId: f.workspaceId, revision: saved.revision, path: 'binary.bin' });
  assert.deepEqual(Buffer.from(binary.content, 'base64'), Buffer.from([0, 255, 128]));
  f.setTime(20);
  const merged = await f.store.merge({ workspaceId: f.workspaceId, fromRevision: saved.revision, requestId: 'merged-result' });
  const events = readWorkspaceHistory(f.store.workspacePath(f.workspaceId));
  assert.equal(events[1].record.main_revision, '0.1');
  assert.equal(events.at(-1).record.main_revision, merged.main_revision);
  assert.equal((await f.store.read({ workspaceId: f.workspaceId, path: 'keep.txt' })).content, 'proof');
});

test('Workspace publication history retains freeze and unfreeze as ordered events', async t => {
  const f = await fixture(t);
  f.setTime(10);
  await f.store.freeze({ workspaceId: f.workspaceId, submissionId: 'submission-at-ten' });
  f.setTime(20);
  await f.store.unfreeze({ workspaceId: f.workspaceId, submissionId: 'submission-at-ten' });
  const events = readWorkspaceHistory(f.store.workspacePath(f.workspaceId));
  assert.equal(events[1].record.frozen_submission_id, 'submission-at-ten');
  assert.equal(events[1].record.freeze_epoch, 1);
  assert.equal(events[2].record.frozen_submission_id, null);
  assert.equal(events[2].record.freeze_epoch, 1);
  assert.deepEqual(events.map(event => event.committed_at), [time(0), time(10), time(20)]);
});

test('Workspace events in the same millisecond keep their sequence and reject a missing event', async t => {
  const f = await fixture(t);
  await f.store.save({ workspaceId: f.workspaceId, files: { 'one.txt': 'one' } });
  await f.store.save({ workspaceId: f.workspaceId, files: { 'two.txt': 'two' } });
  const root = f.store.workspacePath(f.workspaceId);
  const events = readWorkspaceHistory(root);
  assert.deepEqual(events.map(event => event.sequence), [1, 2, 3]);
  assert.equal(new Set(events.map(event => event.committed_at)).size, 1);
  await rm(join(root, WORKSPACE_HISTORY_DIR, '000000000002.json'));
  assert.throws(() => readWorkspaceHistory(root), { code: 'REPLAY_HISTORY_INCOMPLETE' });
});

test('a crash after Workspace history publication preserves its event identity and commit time on recovery', async t => {
  let crash = false;
  const f = await fixture(t, { fault: stage => {
    if (crash && stage === 'after_history_event') throw new Error('simulated history-head interruption');
  } });
  f.setTime(10);
  crash = true;
  const request = { workspaceId: f.workspaceId, requestId: 'history-crash', files: { 'result.txt': 'retained' } };
  await assert.rejects(f.store.save(request), { code: 'WORKSPACE_RESULT_UNKNOWN' });
  assert.throws(() => readWorkspaceHistory(f.store.workspacePath(f.workspaceId)), { code: 'REPLAY_HISTORY_INCOMPLETE' });
  const published = JSON.parse(await readFile(join(f.store.workspacePath(f.workspaceId), WORKSPACE_HISTORY_DIR, '000000000002.json'), 'utf8'));
  const recovered = new MissionWorkspace({ rootDir: f.sourceRoot, clock: () => time(20) });
  await recovered.get({ workspaceId: f.workspaceId });
  const first = await recovered.save(request);
  const events = readWorkspaceHistory(recovered.workspacePath(f.workspaceId));
  assert.equal(first.revision, '0.2');
  assert.equal(events.length, 2);
  assert.equal(events[1].committed_at, time(10));
  assert.equal(events[1].event_id, published.event_id);
  assert.deepEqual(await recovered.save(request), first);
  assert.deepEqual(readWorkspaceHistory(recovered.workspacePath(f.workspaceId)), events);
  assert.equal((await recovered.read({ workspaceId: f.workspaceId, revision: first.revision, path: 'result.txt' })).content, 'retained');
});

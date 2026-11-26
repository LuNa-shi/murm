import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MissionWorkspace, candidateFileRef } from '../src/runtime/mission-workspace.js';
import { dispatchMissionWorkspaceRead } from '../src/sdk/builtin-registry.js';

test('MissionWorkspace keeps public immutable revisions separate from main and merges whole trees', async () => {
  const root = await mkdtemp(join(tmpdir(), 'murm-mission-workspace-'));
  const store = new MissionWorkspace({ rootDir: root });
  const created = await store.create({ missionId: 'mission:1', workspaceId: 'workspace:1'.replace(':', '-'), initialFiles: { 'README.md': 'start\n' } });
  assert.equal(created.main_revision, '0.1');
  const saved = await store.save({ workspaceId: created.workspace_id, baseRevision: '0.1', files: { 'README.md': 'start\n', 'proof.txt': 'candidate\n' } });
  assert.equal(saved.revision, '0.2');
  assert.equal((await store.get({ workspaceId: created.workspace_id })).main_revision, '0.1');
  assert.equal((await store.read({ workspaceId: created.workspace_id, revision: '0.2', path: 'proof.txt' })).content, 'candidate\n');
  const merged = await store.merge({ workspaceId: created.workspace_id, fromRevision: '0.2', expectedMainRevision: '0.1' });
  assert.equal(merged.main_revision, '0.3');
  assert.deepEqual(merged.parents, ['0.1', '0.2']);
  assert.equal((await store.read({ workspaceId: created.workspace_id, path: 'proof.txt' })).content, 'candidate\n');
  assert.deepEqual(candidateFileRef({ workspaceId: created.workspace_id, revision: '0.2', path: 'proof.txt' }), { workspace_id: created.workspace_id, revision: '0.2', path: 'proof.txt' });
});

test('whole-revision merge removes files deleted from the source tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'murm-mission-workspace-'));
  const store = new MissionWorkspace({ rootDir: root });
  const created = await store.create({ missionId: 'mission:delete', workspaceId: 'workspace-delete', initialFiles: { 'keep.md': 'yes', 'remove.md': 'old' } });
  const saved = await store.save({ workspaceId: created.workspace_id, baseRevision: '0.1', files: { 'keep.md': 'yes' } });
  await store.merge({ workspaceId: created.workspace_id, fromRevision: saved.revision, expectedMainRevision: '0.1' });
  await assert.rejects(() => store.read({ workspaceId: created.workspace_id, path: 'remove.md' }), { code: 'INVALID_CONTRACT' });
});

test('three-way merge reports concurrent edits instead of overwriting main', async () => {
  const root = await mkdtemp(join(tmpdir(), 'murm-mission-workspace-'));
  const store = new MissionWorkspace({ rootDir: root });
  const created = await store.create({ missionId: 'mission:conflict', workspaceId: 'workspace-conflict', initialFiles: { 'notes.md': 'base' } });
  const source = await store.save({ workspaceId: created.workspace_id, baseRevision: '0.1', files: { 'notes.md': 'source' } });
  const mainCandidate = await store.save({ workspaceId: created.workspace_id, baseRevision: '0.1', files: { 'notes.md': 'main' } });
  await store.merge({ workspaceId: created.workspace_id, fromRevision: mainCandidate.revision, expectedMainRevision: '0.1' });
  await assert.rejects(() => store.merge({ workspaceId: created.workspace_id, fromRevision: source.revision, expectedMainRevision: '0.1' }), { code: 'MAIN_MOVED' });
  await assert.rejects(() => store.merge({ workspaceId: created.workspace_id, fromRevision: source.revision, expectedMainRevision: '0.4' }), (error) => error.code === 'CONFLICT' && error.details.conflicts.includes('notes.md'));
});

test('MissionWorkspace rejects stale main updates and protects metadata paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'murm-mission-workspace-'));
  const store = new MissionWorkspace({ rootDir: root });
  const created = await store.create({ missionId: 'mission:2', workspaceId: 'workspace-2' });
  await store.save({ workspaceId: created.workspace_id, baseRevision: '0.1', files: { 'notes.md': 'one' } });
  await assert.rejects(() => store.merge({ workspaceId: created.workspace_id, fromRevision: '0.2', expectedMainRevision: '9.9' }), { code: 'MAIN_MOVED' });
  await assert.rejects(() => store.save({ workspaceId: created.workspace_id, baseRevision: '0.2', files: { '.swarm-workspace.json': 'bad' } }), { code: 'NOT_ALLOWED' });
});

test('MissionWorkspace apply materializes a public revision and freezes main during submission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'murm-mission-workspace-'));
  const store = new MissionWorkspace({ rootDir: root });
  const created = await store.create({ missionId: 'mission:freeze', workspaceId: 'workspace-freeze', initialFiles: { 'notes.md': 'base' } });
  const saved = await store.save({ workspaceId: created.workspace_id, baseRevision: '0.1', files: { 'notes.md': 'candidate' } });
  const target = await mkdtemp(join(tmpdir(), 'murm-apply-'));
  const applied = await store.apply({ workspaceId: created.workspace_id, revision: saved.revision, targetDir: target });
  assert.equal(applied.revision, saved.revision);
  assert.equal((await store.read({ workspaceId: created.workspace_id, revision: saved.revision, path: 'notes.md' })).content, 'candidate');
  await store.freeze({ workspaceId: created.workspace_id, submissionId: 'sub-1', expectedMainRevision: '0.1' });
  await assert.rejects(() => store.merge({ workspaceId: created.workspace_id, fromRevision: saved.revision, expectedMainRevision: '0.1' }), { code: 'MISSION_SUBMITTING' });
  await store.unfreeze({ workspaceId: created.workspace_id, submissionId: 'sub-1' });
  await store.merge({ workspaceId: created.workspace_id, fromRevision: saved.revision, expectedMainRevision: '0.1' });
});

test('public workspace pages pin revisions and reject a cursor for a different query', async t => {
  const root = await mkdtemp(join(tmpdir(), 'murm-mission-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new MissionWorkspace({ rootDir: root });
  const workspaceId = 'W-public';
  await store.create({ missionId: 'M-public', workspaceId, initialFiles: { 'a/needle.txt': 'needle one\nneedle two', 'b.bin': Buffer.from([0, 200]), 'c.txt': 'c' } });
  const saved = await store.save({ workspaceId, baseRevision: '0.1', files: { 'a/needle.txt': 'needle revised', 'd.txt': 'needle new' }, source: { task_id: 'T', execution_id: 'E' } });
  const listing = await store.files({ workspaceId, revision: 'main', prefix: 'a', limit: 1 });
  assert.deepEqual(listing.files, [{ path: 'a', type: 'directory', bytes: null }]);
  const search = await store.search({ workspaceId, revision: 'main', query: 'needle', maxResults: 1 });
  assert.deepEqual(search.matches, [{ path: 'a/needle.txt', kind: 'path' }]);
  assert.equal(search.binary_text_skipped, 1);
  const diff = await store.diff({ workspaceId, from: 'main', to: saved.revision, limit: 1 });
  assert.equal(diff.from.revision, '0.1');
  assert.equal(diff.to.reachable_from_main, false);
  assert.equal(diff.to.source.execution_id, 'E');
  assert.equal(diff.changes[0].change, 'modified');
  await store.merge({ workspaceId, fromRevision: saved.revision });
  assert.notEqual((await store.get({ workspaceId })).main_revision, '0.1');
  const files2 = await store.files({ workspaceId, revision: '0.1', prefix: 'a', limit: 1, cursor: listing.next_cursor });
  assert.equal(files2.files[0].path, 'a/needle.txt');
  assert.equal(files2.next_cursor, null);
  const search2 = await store.search({ workspaceId, query: 'needle', maxResults: 2, cursor: search.next_cursor });
  assert.equal(search2.revision, '0.1');
  assert.deepEqual(search2.matches.map(hit => hit.text), ['needle one', 'needle two']);
  assert.equal(search2.next_cursor, null);
  const diff2 = await store.diff({ workspaceId, from: 'main', to: saved.revision, cursor: diff.next_cursor });
  assert.equal(diff2.main_revision, '0.1');
  assert.equal(diff2.to.reachable_from_main, false);
  assert.deepEqual(diff2.changes.map(change => [change.path, change.change]), [['b.bin', 'deleted'], ['c.txt', 'deleted'], ['d.txt', 'added']]);
  await assert.rejects(store.files({ workspaceId, revision: saved.revision, prefix: 'a', cursor: listing.next_cursor }), /requested revision/);
  await assert.rejects(store.files({ workspaceId: 'other', prefix: 'a', cursor: listing.next_cursor }), /does not match this query/);
  await assert.rejects(store.search({ workspaceId, query: 'other', cursor: search.next_cursor }), /does not match this query/);
  await assert.rejects(store.diff({ workspaceId, from: saved.revision, to: '0.1', cursor: diff.next_cursor }), /requested revision/);
});

test('concurrent creation across workspace stores allows one repository per Mission', async t => {
  const root = await mkdtemp(join(tmpdir(), 'murm-mission-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stores = [new MissionWorkspace({ rootDir: root }), new MissionWorkspace({ rootDir: root })];
  const results = await Promise.allSettled(stores.map((store, index) => store.create({ missionId: 'M-single', workspaceId: `W-${index}` })));
  const result = results.find(item => item.status === 'fulfilled').value;
  assert.equal(results.find(item => item.status === 'rejected').reason.code, 'CONFLICT');
  assert.deepEqual(await stores[1].create({ missionId: 'M-single', workspaceId: result.workspace_id }), result);
  assert.equal((await stores[0].create({ missionId: 'M-other', workspaceId: 'W-other' })).mission_id, 'M-other');
});

test('Workspace registry keeps public diff inside the registered Agent Mission', async t => {
  const root = await mkdtemp(join(tmpdir(), 'murm-mission-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const missionWorkspace = new MissionWorkspace({ rootDir: root });
  await missionWorkspace.create({ missionId: 'own', workspaceId: 'W-own', initialFiles: { 'local.txt': 'local' } });
  await missionWorkspace.create({ missionId: 'foreign', workspaceId: 'W-foreign', initialFiles: { 'foreign.txt': 'foreign' } });
  const taskService = { getAgent: actor => actor === 'B-own' ? { mission_id: 'own' } : null };
  const envelope = { actor_ref: 'B-own' };
  {
    const payload = { workspace_id: 'W-own', from: 'main', to: 'main' };
    assert.equal((await dispatchMissionWorkspaceRead({ taskService, missionWorkspace }, 'workspace_public_diff', payload, envelope)).from.revision, '0.1');
    await assert.rejects(dispatchMissionWorkspaceRead({ taskService, missionWorkspace }, 'workspace_public_diff', { ...payload, workspace_id: 'W-foreign' }, envelope), { code: 'NOT_ALLOWED' });
  }
});

test('live apply plans preserve both versions and explicit conflict alternatives', async t => {
  const root = await mkdtemp(join(tmpdir(), 'murm-live-apply-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new MissionWorkspace({ rootDir: root });
  const created = await store.create({ missionId: 'mission:live-apply', workspaceId: 'live-apply', initialFiles: { 'proof.lean': 'base\n' } });
  const current = await store.save({ workspaceId: created.workspace_id, baseRevision: '0.1', files: { 'proof.lean': 'current\n', 'own.lean': 'own\n' } });
  const incoming = await store.save({ workspaceId: created.workspace_id, baseRevision: '0.1', files: { 'proof.lean': 'incoming\n', 'peer.lean': 'peer\n' } });
  const plan = await store.planApply({ workspaceId: created.workspace_id, baseRevision: current.revision, fromRevision: incoming.revision, requestId: 'conflict' });
  assert.deepEqual(plan.parents, [current.revision, incoming.revision]);
  assert.equal(plan.files['own.lean'], 'own\n'); assert.equal(plan.files['peer.lean'], 'peer\n');
  assert.equal(plan.conflicts.length, 1);
  const conflict = plan.conflicts[0];
  assert.deepEqual(conflict.paths, ['proof.lean']);
  assert.equal(Buffer.from(plan.files[`${conflict.artifact_root}/base/proof.lean`]).toString(), 'base\n');
  assert.equal(Buffer.from(plan.files[`${conflict.artifact_root}/current/proof.lean`]).toString(), 'current\n');
  assert.equal(Buffer.from(plan.files[`${conflict.artifact_root}/incoming/proof.lean`]).toString(), 'incoming\n');
  assert.equal((await store.get({ workspaceId: created.workspace_id })).main_revision, '0.1');
});

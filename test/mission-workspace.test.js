import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MissionWorkspace, candidateFileRef } from '../src/runtime/mission-workspace.js';

test('MissionWorkspace keeps public immutable revisions separate from main and merges whole trees', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swarmenv-mission-workspace-'));
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
  const root = await mkdtemp(join(tmpdir(), 'swarmenv-mission-workspace-'));
  const store = new MissionWorkspace({ rootDir: root });
  const created = await store.create({ missionId: 'mission:delete', workspaceId: 'workspace-delete', initialFiles: { 'keep.md': 'yes', 'remove.md': 'old' } });
  const saved = await store.save({ workspaceId: created.workspace_id, baseRevision: '0.1', files: { 'keep.md': 'yes' } });
  await store.merge({ workspaceId: created.workspace_id, fromRevision: saved.revision, expectedMainRevision: '0.1' });
  await assert.rejects(() => store.read({ workspaceId: created.workspace_id, path: 'remove.md' }), { code: 'INVALID_CONTRACT' });
});

test('MissionWorkspace rejects stale main updates and protects metadata paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swarmenv-mission-workspace-'));
  const store = new MissionWorkspace({ rootDir: root });
  const created = await store.create({ missionId: 'mission:2', workspaceId: 'workspace-2' });
  await store.save({ workspaceId: created.workspace_id, baseRevision: '0.1', files: { 'notes.md': 'one' } });
  await assert.rejects(() => store.merge({ workspaceId: created.workspace_id, fromRevision: '0.2', expectedMainRevision: '9.9' }), { code: 'STALE_VERSION' });
  await assert.rejects(() => store.save({ workspaceId: created.workspace_id, baseRevision: '0.2', files: { '.swarm-workspace.json': 'bad' } }), { code: 'NOT_ALLOWED' });
});

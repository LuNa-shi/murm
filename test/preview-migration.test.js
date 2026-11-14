import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { promisify } from 'node:util';
import { MissionWorkspace } from '../src/runtime/mission-workspace.js';

const exec = promisify(execFile);

test('fresh migration previews without mutation and verifies an independent restoration', async t => {
  const root = await mkdtemp(join(tmpdir(), 'swarm-migration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, 'workspace');
  const workspace = new MissionWorkspace({ rootDir: workspaceRoot });
  await workspace.create({ missionId: 'old-mission', workspaceId: 'public', initialFiles: { 'Proof.lean': 'example : True := by trivial' } });
  const task = join(root, 'task.sqlite');
  const context = join(root, 'context.sqlite');
  const judge = join(root, 'judge.sqlite');
  const sources = [
    [task, "CREATE TABLE tasks (task_id, state); INSERT INTO tasks VALUES ('T', 'ARCHIVED'); CREATE TABLE executions (execution_id, state, owner_ref, workspace_ref); INSERT INTO executions VALUES ('E', 'FAILED', 'owner', '/private/ref');"],
    [context, "CREATE TABLE materials (material_id, role, content_ref, source_task, source_execution, content_json, content_hash); INSERT INTO materials VALUES ('M', 'handoff', '/private/blob', NULL, NULL, 'null', 'missing');"],
    [judge, 'CREATE TABLE check_results (check_result_id, verdict);'],
  ];
  for (const [path, sql] of sources) {
    const db = new DatabaseSync(path);
    try { db.exec(sql); } finally { db.close(); }
  }
  const runManifest = join(root, 'run.json');
  const external = join(root, 'evidence.json');
  await writeFile(runManifest, JSON.stringify({ release: 'locked' }));
  await writeFile(external, JSON.stringify({ old_writer_stop: 'evidence:a', provider_isolation: 'evidence:b', external_operations_accounted: 'evidence:c' }));
  const candidates = ['--task', task, '--context', context, '--judge', judge, '--workspace', join(workspaceRoot, 'public'), '--revision', '0.1'];
  const invoke = async (command, ...args) => JSON.parse((await exec(process.execPath, ['scripts/preview-migration.mjs', command, ...args])).stdout);
  const before = await Promise.all(sources.map(([path]) => readFile(path)));
  const preview = await invoke('preview', ...candidates);
  assert.equal(preview.blocked, false);
  assert.equal(preview.external_isolation_verified, false);
  assert.equal(preview.selected_input.revision, '0.1');
  assert.equal(preview.domains.task.sqlite_user_version, 0);
  assert.match(preview.domains.task.schema_sha256, /^[a-f0-9]{64}$/);
  assert.ok(preview.domains.task.inspected_table_columns.executions.some(column => column.name === 'owner_ref'));
  assert.ok(preview.domains.context.findings.some(row => row.reason === 'missing_or_unverifiable_content_or_attachment'));
  assert.ok(preview.domains.task.findings.some(row => row.reason === 'historical_or_unknown_task_state'));
  assert.deepEqual(await Promise.all(sources.map(([path]) => readFile(path))), before);
  const backup = join(root, 'backup');
  const restored = join(root, 'restored');
  await invoke('backup', ...candidates, '--run-manifest', runManifest, '--external-evidence', external, '--out', backup);
  assert.equal((await invoke('restore-verify', '--backup', backup, '--out', restored)).status, 'verified_rehearsal');
  assert.deepEqual(await readFile(join(backup, 'context.sqlite')), await readFile(join(restored, 'context.sqlite')));
  await writeFile(join(backup, 'workspace.json'), '{}');
  await assert.rejects(invoke('restore-verify', '--backup', backup, '--out', join(root, 'changed')), /checksum failed/);
  const db = new DatabaseSync(task);
  try { db.exec("INSERT INTO executions VALUES ('active1', 'RUNNING', 'owner', NULL), ('active2', 'CREATED', 'owner', NULL)"); } finally { db.close(); }
  await assert.rejects(invoke('preview', ...candidates), error => {
    const active = JSON.parse(error.stdout);
    assert.equal(error.code, 2);
    assert.equal(active.blocked, true);
    assert.ok(active.domains.task.findings.some(row => row.reason === 'duplicate_active_owner'));
    return true;
  });
  await assert.rejects(invoke('backup', ...candidates), /nonterminal/);
  await assert.rejects(invoke('preview', ...candidates.slice(0, -1), 'main'), /fixed public Workspace revision/);
  const malformed = new DatabaseSync(task);
  try { malformed.exec('DROP TABLE executions'); } finally { malformed.close(); }
  await assert.rejects(invoke('preview', ...candidates), error => {
    const state = JSON.parse(error.stdout);
    assert.equal(error.code, 2);
    assert.equal(state.domains.task.authority_schema_complete, false);
    assert.notEqual(state.domains.task.schema_sha256, preview.domains.task.schema_sha256);
    assert.ok(state.domains.task.findings.some(row => row.id === 'executions' && row.reason === 'missing_authority_table'));
    return true;
  });
  await assert.rejects(invoke('backup', ...candidates), /unresolved authority/);
});

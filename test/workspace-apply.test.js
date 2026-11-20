import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MissionWorkspace } from '../src/runtime/mission-workspace.js';

async function fixture(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'swarm-apply-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = new MissionWorkspace({ rootDir: root });
  await workspace.create({ missionId: 'mission:apply', workspaceId: 'W-apply', initialFiles: files });
  const save = (files, baseRevision = '0.1', extra = {}) => workspace.save({ workspaceId: 'W-apply', baseRevision, files, ...extra });
  const apply = (baseRevision, fromRevision) => workspace.planApply({ workspaceId: 'W-apply', baseRevision, fromRevision, requestId: 'apply-test' });
  return { workspace, save, apply };
}

test('apply planning merges disjoint saved trees with exact parents and no public revision', async t => {
  const { workspace, save, apply } = await fixture(t, { original: 'base' });
  const a = await save({ original: 'base', first: 'left' });
  const b = await save({ original: 'base', second: 'right' });
  const planned = await apply(a.revision, b.revision);
  assert.deepEqual({ ...planned.files }, { first: 'left', original: 'base', second: 'right' });
  assert.deepEqual(planned.parents, [a.revision, b.revision]);
  assert.deepEqual(planned.conflicts, []);
  assert.equal((await workspace.listRevisions({ workspaceId: 'W-apply' })).length, 3);
  assert.equal((await workspace.get({ workspaceId: 'W-apply' })).main_revision, '0.1');
  const saved = await save(planned.files, a.revision, { parentRevisions: planned.parents, conflicts: planned.conflicts });
  const noop = await apply(saved.revision, a.revision);
  assert.equal(noop.already_included, true);
  assert.deepEqual(noop.parents, [saved.revision]);
  assert.deepEqual(noop.changed_paths, []);
});

for (const variant of ['text', 'binary', 'delete', 'rename']) test(`apply planning preserves editable ${variant} conflicts and saved conflict inheritance`, async t => {
  const base = variant === 'binary' ? Buffer.from([0, 1, 2]) : 'line from common base\n';
  const { workspace, save, apply } = await fixture(t, { file: base });
  const left = variant === 'binary' ? Buffer.from([0, 3, 4]) : 'left decision\n';
  const right = variant === 'binary' ? Buffer.from([0, 5, 6]) : 'right decision\n';
  const a = await save(variant === 'delete' ? {} : variant === 'rename' ? { left_name: base } : { file: left });
  const b = await save(variant === 'rename' ? { right_name: base } : { file: right });
  const planned = await apply(a.revision, b.revision);
  assert.ok(planned.conflicts.length);
  const conflict = planned.conflicts[0];
  assert.ok(conflict.stages.length >= 2);
  assert.ok(Object.keys(planned.files).some(path => path.startsWith(conflict.artifact_root + '/')));
  for (const stage of conflict.stages) assert.ok(Object.hasOwn(planned.files, stage.artifact_path));
  if (variant === 'text') assert.match(String(planned.files.file), /<<<<<<<[\s\S]*left decision[\s\S]*right decision/);
  if (variant === 'binary') {
    const incoming = conflict.stages.find(stage => stage.stage === 3);
    assert.deepEqual(planned.files[incoming.artifact_path], right);
  }
  if (variant === 'rename') assert.ok(conflict.paths.includes('left_name') && conflict.paths.includes('right_name'));
  const saved = await save(planned.files, a.revision, { parentRevisions: planned.parents, conflicts: planned.conflicts });
  const exported = await workspace.exportRevision({ workspaceId: 'W-apply', revision: saved.revision });
  assert.deepEqual(exported.conflicts, planned.conflicts);
  await assert.rejects(workspace.merge({ workspaceId: 'W-apply', fromRevision: saved.revision, expectedMainRevision: '0.1' }), /unresolved Workspace conflicts/);
});

for (const width of [1, 9]) test(`apply records actual Git conflict marker lines with configured width ${width}`, async t => {
  const attrs = `file conflict-marker-size=${width}\n`;
  const { save, apply } = await fixture(t, { '.gitattributes': attrs, file: 'base\n' });
  const a = await save({ '.gitattributes': attrs, file: 'left\n' });
  const b = await save({ '.gitattributes': attrs, file: 'right\n' });
  const planned = await apply(a.revision, b.revision);
  const markers = planned.conflicts[0].marker_lines;
  assert.ok(markers.some(marker => marker.line.startsWith('<'.repeat(width) + ' ')));
  assert.ok(markers.some(marker => marker.line.startsWith('>'.repeat(width) + ' ')));
});

test('concurrent coordinators initialize Execution Workspace tables under one SQLite write lock', async t => {
  const { DatabaseSync } = await import('node:sqlite');
  const { spawn } = await import('node:child_process');
  const root = await mkdtemp(join(tmpdir(), 'swarm-apply-init-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'state.sqlite'), db = new DatabaseSync(path);
  t.after(() => db.close());
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 1000');
  db.exec('BEGIN IMMEDIATE');
  const module = new URL('../src/runtime/execution-workspace.js', import.meta.url).href;
  const children = Array.from({ length: 2 }, () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { DatabaseSync } from 'node:sqlite';
      import { ExecutionWorkspace } from ${JSON.stringify(module)};
      const db = new DatabaseSync(process.argv[1]);
      process.stdout.write('ready\\n');
      new ExecutionWorkspace({ taskService: { db } });
      if (!db.prepare('PRAGMA table_info(execution_workspace_state)').all().some(column => column.name === 'pending_apply')) process.exitCode = 1;
      db.close();
    `, path], { stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = '';
    child.stderr.on('data', data => { errors += data; });
    const ready = new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
    const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(errors))); });
    return { ready, done };
  });
  await Promise.all(children.map(child => child.ready));
  db.exec('COMMIT');
  await Promise.all(children.map(child => child.done));
  assert.equal(db.prepare('PRAGMA table_info(execution_workspace_state)').all().filter(column => column.name === 'pending_apply').length, 1);
});

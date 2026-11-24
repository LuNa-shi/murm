import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

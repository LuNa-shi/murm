import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { TaskService } from '../src/task/task-service.js';
import { ContextService } from '../src/context/context-service.js';
import { JudgeService } from '../src/judge/judge-service.js';
import { dropReplayHistory, installServiceHistory, parseReplayTime, restoreServiceDatabaseAt } from '../src/replay/service-history.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'swarm-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source.sqlite');
  const db = new DatabaseSync(source);
  db.exec(`CREATE TABLE results (id TEXT PRIMARY KEY, status TEXT NOT NULL, attachment BLOB, count INTEGER);
    CREATE TABLE links (result_id TEXT, related_id TEXT, PRIMARY KEY(result_id, related_id));`);
  installServiceHistory(db, { domain: 'task' });
  return { root, source, db };
}

test('finished data can be restored to an unselected earlier time, including overwritten rows, deletions and bytes', async t => {
  const { root, source, db } = await fixture(t);
  db.prepare('INSERT INTO results VALUES (?, ?, ?, ?)').run('lemma', 'working', Buffer.from([0, 255, 12]), 9_007_199_254_740_993n);
  db.prepare('INSERT INTO links VALUES (?, ?)').run('lemma', 'parent');
  const at = new Date().toISOString();
  await delay(5);
  db.prepare('UPDATE results SET status = ?, attachment = ? WHERE id = ?').run('proved', Buffer.from('future'), 'lemma');
  db.prepare('DELETE FROM links WHERE result_id = ?').run('lemma');
  db.prepare('INSERT INTO results VALUES (?, ?, ?, ?)').run('future', 'proved', null, 1);
  db.close();
  const original = await readFile(source);
  const destination = join(root, 'earlier.sqlite');
  const summary = await restoreServiceDatabaseAt({ sourcePath: source, destinationPath: destination, domain: 'task', at });
  assert.equal(summary.mode, 'journal');
  const restored = new DatabaseSync(destination, { readOnly: true });
  const query = restored.prepare('SELECT * FROM results'); query.setReadBigInts(true);
  assert.deepEqual(query.all().map(row => ({ ...row, attachment: Buffer.from(row.attachment) })),
    [{ id: 'lemma', status: 'working', attachment: Buffer.from([0, 255, 12]), count: 9_007_199_254_740_993n }]);
  assert.deepEqual(restored.prepare('SELECT * FROM links').all().map(row => ({ ...row })), [{ result_id: 'lemma', related_id: 'parent' }]);
  restored.close();
  assert.deepEqual(await readFile(source), original);
});

test('a cutoff during a multi-statement transaction cannot expose half of its updates', async t => {
  const { root, source, db } = await fixture(t);
  db.exec("INSERT INTO results VALUES ('a', 'old', NULL, 1); INSERT INTO results VALUES ('b', 'old', NULL, 2)");
  await delay(5);
  db.exec('BEGIN IMMEDIATE');
  db.prepare("UPDATE results SET status = 'new' WHERE id = ?").run('a');
  const during = new Date().toISOString();
  await delay(5);
  db.prepare("UPDATE results SET status = 'new' WHERE id = ?").run('b');
  db.exec('COMMIT');
  const committed = db.prepare('SELECT committed_at FROM replay_transactions ORDER BY transaction_id DESC LIMIT 1').get().committed_at;
  db.close();
  for (const [at, expected, name] of [[during, ['old', 'old'], 'before'], [committed, ['new', 'new'], 'after']]) {
    const destination = join(root, `${name}.sqlite`);
    await restoreServiceDatabaseAt({ sourcePath: source, destinationPath: destination, domain: 'task', at });
    const copy = new DatabaseSync(destination);
    assert.deepEqual(copy.prepare('SELECT status FROM results ORDER BY id').all().map(row => row.status), expected);
    copy.close();
  }
});

test('rolled back writes and savepoint rollbacks leave no committed state or replay events', async t => {
  const { root, source, db } = await fixture(t);
  db.exec("INSERT INTO results VALUES ('a', 'old', NULL, 1)");
  db.exec('BEGIN');
  db.prepare("UPDATE results SET status = 'bad' WHERE id = 'a'").run();
  db.exec('ROLLBACK');
  db.exec('SAVEPOINT outer_save');
  db.prepare("UPDATE results SET status = 'intermediate' WHERE id = 'a'").run();
  db.exec('ROLLBACK TO outer_save');
  db.prepare("UPDATE results SET status = 'good' WHERE id = 'a'").run();
  db.exec('RELEASE outer_save');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM replay_events').get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM replay_transactions WHERE committed_at IS NULL').get().n, 0);
  const at = new Date().toISOString(); db.close();
  await restoreServiceDatabaseAt({ sourcePath: source, destinationPath: join(root, 'copy.sqlite'), domain: 'task', at });
  const restored = new DatabaseSync(join(root, 'copy.sqlite'));
  assert.equal(restored.prepare('SELECT status FROM results').get().status, 'good');
  restored.close();
});

for (const [name, nestedStatements] of [
  ['releasing a shadowed savepoint', [
    'SAVEPOINT outer_save',
    "UPDATE results SET status = 'nested' WHERE id = 'a'",
    'RELEASE outer_save',
  ]],
  ['rolling back to a shadowed savepoint and releasing it', [
    'SAVEPOINT outer_save',
    'SAVEPOINT discarded',
    "UPDATE results SET status = 'discarded' WHERE id = 'a'",
    'ROLLBACK TRANSACTION TO SAVEPOINT outer_save',
    'RELEASE SAVEPOINT outer_save',
  ]],
  ['rolling back past a shadowed name before releasing the outer savepoint', [
    'SAVEPOINT middle_save',
    'SAVEPOINT outer_save',
    'SAVEPOINT discarded',
    "UPDATE results SET status = 'discarded' WHERE id = 'a'",
    'ROLLBACK TO middle_save',
    'RELEASE middle_save',
  ]],
]) {
  test(`${name} retains the outer transaction's historical boundary`, async t => {
    const { root, source, db } = await fixture(t);
    db.exec("INSERT INTO results VALUES ('a', 'old', NULL, 1)");
    db.exec('SAVEPOINT outer_save');
    db.exec("UPDATE results SET status = 'intermediate' WHERE id = 'a'");
    for (const statement of nestedStatements) db.exec(statement);
    assert.equal(db.isTransaction, true);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM replay_transactions WHERE committed_at IS NOT NULL').get().n, 0);
    const during = new Date().toISOString();
    await delay(5);
    db.exec("UPDATE results SET status = 'final' WHERE id = 'a'");
    db.exec('RELEASE outer_save');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM replay_transactions').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM replay_transactions WHERE committed_at IS NULL').get().n, 0);
    const committed = db.prepare('SELECT committed_at FROM replay_transactions').get().committed_at;
    db.close();
    for (const [at, status, file] of [[during, 'old', 'during.sqlite'], [committed, 'final', 'committed.sqlite']]) {
      const destination = join(root, file);
      await restoreServiceDatabaseAt({ sourcePath: source, destinationPath: destination, domain: 'task', at });
      const restored = new DatabaseSync(destination);
      assert.equal(restored.prepare('SELECT status FROM results').get().status, status);
      restored.close();
    }
  });
}

test('a failed commit and subsequent repair preserve one historical transaction boundary', async t => {
  const { root, source, db } = await fixture(t);
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE parents (id INTEGER PRIMARY KEY);
    CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parents(id) DEFERRABLE INITIALLY DEFERRED);`);
  installServiceHistory(db, { domain: 'task' });
  db.exec('BEGIN; INSERT INTO children VALUES (1, 1)');
  assert.throws(() => db.exec('COMMIT'), /FOREIGN KEY constraint failed/);
  assert.equal(db.isTransaction, true);
  assert.equal(db.prepare('SELECT committed_at FROM replay_transactions').get().committed_at, null);
  const during = new Date().toISOString();
  await delay(5);
  db.exec('INSERT INTO parents VALUES (1); COMMIT');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM replay_transactions').get().n, 1);
  const committed = db.prepare('SELECT committed_at FROM replay_transactions').get().committed_at;
  db.close();
  for (const [at, expectedCount, file] of [[during, 0, 'during.sqlite'], [committed, 1, 'committed.sqlite']]) {
    const destination = join(root, file);
    await restoreServiceDatabaseAt({ sourcePath: source, destinationPath: destination, domain: 'task', at });
    const restored = new DatabaseSync(destination);
    assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM children').get().n, expectedCount);
    assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM parents').get().n, expectedCount);
    assert.deepEqual(restored.prepare('PRAGMA foreign_key_check').all(), []);
    restored.close();
  }
});

test('replacement, primary-key changes and multiple changes in one timestamp restore in stable reverse order', async t => {
  const { root, source, db } = await fixture(t);
  db.exec("INSERT INTO results VALUES ('a', 'old', NULL, 1)");
  const at = new Date().toISOString(); await delay(5);
  db.exec('BEGIN IMMEDIATE');
  db.prepare("INSERT OR REPLACE INTO results VALUES ('a', 'replacement', NULL, 2)").run();
  db.prepare("UPDATE results SET id = 'renamed', status = 'last' WHERE id = 'a'").run();
  db.exec('COMMIT'); db.close();
  const destination = join(root, 'copy.sqlite');
  await restoreServiceDatabaseAt({ sourcePath: source, destinationPath: destination, domain: 'task', at });
  const restored = new DatabaseSync(destination);
  assert.deepEqual(restored.prepare('SELECT id, status, count FROM results').all().map(row => ({ ...row })), [{ id: 'a', status: 'old', count: 1 }]);
  restored.close();
});

test('recording does not turn a read-only transaction into a database write', async t => {
  const { db } = await fixture(t);
  db.exec('BEGIN');
  db.prepare('SELECT * FROM results').all();
  db.exec('COMMIT');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM replay_transactions').get().n, 0);
  db.close();
});

test('history exec preserves SQLite empty-tail handling and rejects invalid or closed input', async t => {
  const { db } = await fixture(t);
  for (const sql of ['', ' \n\t', '; ;\n', '-- comment', '/* comment */']) {
    db.exec(sql);
  }
  assert.throws(() => db.exec("'not a statement'"), { code: 'ERR_SQLITE_ERROR' });
  db.exec("INSERT INTO results VALUES ('a', 'recorded', NULL, 1); -- trailing comment");
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM replay_events').get().n, 1);
  assert.equal(db.prepare('SELECT status FROM results').get().status, 'recorded');
  db.close();
  assert.throws(() => db.exec(' -- comment'), { code: 'ERR_INVALID_STATE' });
});

test('compound exec, quoted savepoints and prepared transaction control retain committed boundaries', async t => {
  const { db } = await fixture(t);
  db.exec("INSERT INTO results VALUES ('a', 'old', NULL, 1)");
  db.exec('BEGIN');
  db.exec("SELECT 1; UPDATE results SET status = 'compound' WHERE id = 'a'; -- trailing comment");
  db.prepare('COMMIT').run();
  db.exec('SAVEPOINT "a quoted name"');
  db.prepare("UPDATE results SET status = 'quoted' WHERE id = 'a'").run();
  db.exec('RELEASE SAVEPOINT "a quoted name"');
  db.exec("BEGIN; UPDATE results SET status = 'script' WHERE id = 'a'; COMMIT;");
  db.prepare('BEGIN').run();
  db.prepare("UPDATE results SET status = 'iterator' WHERE id = 'a'").run();
  [...db.prepare('COMMIT').iterate()];
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM replay_events WHERE before_json IS NOT NULL AND transaction_id IS NULL').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM replay_transactions WHERE committed_at IS NULL').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM replay_transactions').get().n, 4);
  db.close();
});

test('persistent Task, Context and Judge stores automatically install row history', async t => {
  const root = await mkdtemp(join(tmpdir(), 'swarm-history-services-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [Service, domain] of [[TaskService, 'task'], [ContextService, 'context'], [JudgeService, 'judge']]) {
    const service = new Service(join(root, `${domain}.sqlite`));
    assert.equal(service.db.prepare('SELECT domain FROM replay_domains WHERE domain = ?').get(domain).domain, domain);
    assert.ok(service.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'replay_capture_%'").get().n > 0);
    service.close();
  }
});

test('a finished WAL source and all its sidecars remain byte-identical during restoration', async t => {
  const root = await mkdtemp(join(tmpdir(), 'swarm-history-wal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source.sqlite');
  const script = `
    import { DatabaseSync } from 'node:sqlite';
    const { installServiceHistory } = await import(process.argv[2]);
    const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA journal_mode = WAL; CREATE TABLE results (id TEXT PRIMARY KEY, value TEXT)');
    installServiceHistory(db, { domain: 'task' });
    db.exec("INSERT INTO results VALUES ('old', 'visible')");
    process.stdout.write(new Date().toISOString());
    process.exit(0);
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, source,
    new URL('../src/replay/service-history.js', import.meta.url).href], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const names = (await readdir(root)).filter(name => name.startsWith('source.sqlite')).sort();
  assert.ok(names.includes('source.sqlite-wal'));
  assert.ok(names.includes('source.sqlite-shm'));
  const before = await Promise.all(names.map(name => readFile(join(root, name))));
  const destination = join(root, 'restored.sqlite');
  await restoreServiceDatabaseAt({ sourcePath: source, destinationPath: destination, domain: 'task', at: child.stdout });
  const copy = new DatabaseSync(destination);
  assert.equal(copy.prepare('SELECT value FROM results').get().value, 'visible');
  copy.close();
  assert.deepEqual((await readdir(root)).filter(name => name.startsWith('source.sqlite')).sort(), names);
  assert.deepEqual(await Promise.all(names.map(name => readFile(join(root, name)))), before);
});

test('an uncovered public table cannot silently carry future results into a journal restore', async t => {
  const { root, source, db } = await fixture(t);
  const at = new Date().toISOString();
  db.exec("CREATE TABLE late_public_results (id TEXT, value TEXT); INSERT INTO late_public_results VALUES ('proof', 'future')");
  db.close();
  await assert.rejects(restoreServiceDatabaseAt({ sourcePath: source, destinationPath: join(root, 'copy.sqlite'), domain: 'task', at }),
    error => error.code === 'REPLAY_HISTORY_MISSING' && error.details.table === 'late_public_results');
});

test('a later runtime-only schema does not move the public history coverage boundary', async t => {
  const { root, source, db } = await fixture(t);
  db.exec("INSERT INTO results VALUES ('a', 'old', NULL, 1)");
  const at = new Date().toISOString();
  await delay(5);
  db.exec('CREATE TABLE service_commit_events (gate_id TEXT PRIMARY KEY, events_json TEXT, delivered INTEGER)');
  installServiceHistory(db, { domain: 'task' });
  db.exec("UPDATE results SET status = 'future' WHERE id = 'a'");
  db.close();
  const destination = join(root, 'restored.sqlite');
  const restored = await restoreServiceDatabaseAt({ sourcePath: source, destinationPath: destination, domain: 'task', at });
  assert.equal(restored.mode, 'journal');
  const copy = new DatabaseSync(destination);
  assert.equal(copy.prepare('SELECT status FROM results').get().status, 'old');
  copy.close();
});

test('replay rejects ambiguous timezones, missing sources and existing output without changing them', async t => {
  const { root, source, db } = await fixture(t); db.close();
  assert.throws(() => parseReplayTime('2026-11-19T12:00:00'), /timezone/);
  assert.equal(parseReplayTime('2026-11-19T12:00:00-08:00'), '2026-11-19T20:00:00.000Z');
  const destination = join(root, 'existing.sqlite'); await writeFile(destination, 'keep');
  await assert.rejects(restoreServiceDatabaseAt({ sourcePath: source, destinationPath: destination, domain: 'task', at: new Date().toISOString() }), { code: 'EEXIST' });
  assert.equal(await readFile(destination, 'utf8'), 'keep');
  await assert.rejects(restoreServiceDatabaseAt({ sourcePath: join(root, 'absent.sqlite'), destinationPath: join(root, 'absent-output.sqlite'), domain: 'task', at: new Date().toISOString() }), { code: 'ENOENT' });
});

test('a service database without automatic history cannot be reconstructed or leave output behind', async t => {
  const root = await mkdtemp(join(tmpdir(), 'swarm-unjournaled-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source.sqlite');
  const tasks = new TaskService(source);
  dropReplayHistory(tasks.db);
  tasks.createMission({ mission_id: 'mission', goal: 'An original task history boundary' });
  tasks.close();
  const original = await readFile(source);
  const at = new Date().toISOString();
  await assert.rejects(restoreServiceDatabaseAt({ sourcePath: source,
    destinationPath: join(root, 'copy.sqlite'), domain: 'task', at }),
  error => error.code === 'REPLAY_HISTORY_MISSING' && error.details.domain === 'task');
  assert.deepEqual(await readFile(source), original);
  assert.deepEqual(await readdir(root), ['source.sqlite']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { TaskService } from '../src/task/task-service.js';
import { ContextService } from '../src/context/context-service.js';
import { JudgeService } from '../src/judge/judge-service.js';
import { installServiceHistory } from '../src/replay/service-history.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'swarm-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source.sqlite');
  const db = new DatabaseSync(source);
  db.exec(`CREATE TABLE results (id TEXT PRIMARY KEY, status TEXT NOT NULL, attachment BLOB, count INTEGER);
    CREATE TABLE links (result_id TEXT, related_id TEXT, PRIMARY KEY(result_id, related_id));`);
  installServiceHistory(db, { domain: 'task' });
  return { db };
}

test('service history retains typed before and after images for overwritten rows, deletions and bytes', async t => {
  const { db } = await fixture(t);
  db.prepare('INSERT INTO results VALUES (?, ?, ?, ?)').run('lemma', 'working', Buffer.from([0, 255, 12]), 9_007_199_254_740_993n);
  db.prepare('INSERT INTO links VALUES (?, ?)').run('lemma', 'parent');
  db.prepare('UPDATE results SET status = ?, attachment = ? WHERE id = ?').run('proved', Buffer.from('future'), 'lemma');
  db.prepare('DELETE FROM links WHERE result_id = ?').run('lemma');
  const events = db.prepare('SELECT sequence, table_name, before_json, after_json FROM replay_events ORDER BY sequence').all();
  assert.deepEqual(events.map(event => event.sequence), [1, 2, 3, 4]);
  const inserted = JSON.parse(events[0].after_json);
  assert.equal(events[0].before_json, null);
  assert.deepEqual(inserted.attachment, ['blob', '00FF0C']);
  assert.deepEqual(inserted.count, ['integer', '9007199254740993']);
  assert.deepEqual(JSON.parse(events[2].before_json), inserted);
  assert.deepEqual(JSON.parse(events[2].after_json).status, ['text', 'proved']);
  assert.equal(events[3].table_name, 'links');
  assert.deepEqual(JSON.parse(events[3].before_json).related_id, ['text', 'parent']);
  assert.equal(events[3].after_json, null);
  db.close();
});

test('multi-statement writes share one transaction marker and its final committed time', async t => {
  const { db } = await fixture(t);
  db.exec("INSERT INTO results VALUES ('a', 'old', NULL, 1); INSERT INTO results VALUES ('b', 'old', NULL, 2)");
  db.exec('BEGIN IMMEDIATE');
  db.prepare("UPDATE results SET status = 'new' WHERE id = ?").run('a');
  const pending = db.prepare('SELECT transaction_id, committed_at FROM replay_transactions').get();
  assert.equal(pending.committed_at, null);
  await delay(5);
  db.prepare("UPDATE results SET status = 'new' WHERE id = ?").run('b');
  db.exec('COMMIT');
  const committed = db.prepare('SELECT transaction_id, committed_at FROM replay_transactions').get();
  assert.equal(committed.transaction_id, pending.transaction_id);
  assert.ok(Number.isFinite(Date.parse(committed.committed_at)));
  assert.deepEqual(db.prepare('SELECT transaction_id FROM replay_events WHERE before_json IS NOT NULL').all().map(row => row.transaction_id),
    [pending.transaction_id, pending.transaction_id]);
  assert.equal(db.prepare('SELECT transaction_id FROM replay_control').get().transaction_id, null);
  db.close();
});

test('rolled back writes and savepoint rollbacks leave no committed state or replay events', async t => {
  const { db } = await fixture(t);
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
  assert.equal(db.prepare('SELECT status FROM results').get().status, 'good');
  db.close();
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
    const { db } = await fixture(t);
    db.exec("INSERT INTO results VALUES ('a', 'old', NULL, 1)");
    db.exec('SAVEPOINT outer_save');
    db.exec("UPDATE results SET status = 'intermediate' WHERE id = 'a'");
    for (const statement of nestedStatements) db.exec(statement);
    assert.equal(db.isTransaction, true);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM replay_transactions WHERE committed_at IS NOT NULL').get().n, 0);
    await delay(5);
    db.exec("UPDATE results SET status = 'final' WHERE id = 'a'");
    db.exec('RELEASE outer_save');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM replay_transactions').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM replay_transactions WHERE committed_at IS NULL').get().n, 0);
    assert.equal(db.prepare('SELECT status FROM results').get().status, 'final');
    assert.equal(new Set(db.prepare('SELECT transaction_id FROM replay_events WHERE transaction_id IS NOT NULL').all().map(row => row.transaction_id)).size, 1);
    db.close();
  });
}

test('a failed commit and subsequent repair preserve one historical transaction boundary', async t => {
  const { db } = await fixture(t);
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE parents (id INTEGER PRIMARY KEY);
    CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parents(id) DEFERRABLE INITIALLY DEFERRED);`);
  installServiceHistory(db, { domain: 'task' });
  db.exec('BEGIN; INSERT INTO children VALUES (1, 1)');
  assert.throws(() => db.exec('COMMIT'), /FOREIGN KEY constraint failed/);
  assert.equal(db.isTransaction, true);
  assert.equal(db.prepare('SELECT committed_at FROM replay_transactions').get().committed_at, null);
  await delay(5);
  db.exec('INSERT INTO parents VALUES (1); COMMIT');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM replay_transactions').get().n, 1);
  assert.ok(Number.isFinite(Date.parse(db.prepare('SELECT committed_at FROM replay_transactions').get().committed_at)));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM children').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM parents').get().n, 1);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();
});

test('replacement and primary-key changes retain ordered delete, insert and update images', async t => {
  const { db } = await fixture(t);
  db.exec("INSERT INTO results VALUES ('a', 'old', NULL, 1)");
  db.exec('BEGIN IMMEDIATE');
  db.prepare("INSERT OR REPLACE INTO results VALUES ('a', 'replacement', NULL, 2)").run();
  db.prepare("UPDATE results SET id = 'renamed', status = 'last' WHERE id = 'a'").run();
  db.exec('COMMIT');
  const events = db.prepare('SELECT before_json, after_json, transaction_id FROM replay_events ORDER BY sequence').all();
  assert.equal(events.length, 4);
  assert.deepEqual(JSON.parse(events[1].before_json).status, ['text', 'old']);
  assert.equal(events[1].after_json, null);
  assert.equal(events[2].before_json, null);
  assert.deepEqual(JSON.parse(events[2].after_json).status, ['text', 'replacement']);
  assert.deepEqual(JSON.parse(events[3].before_json).id, ['text', 'a']);
  assert.deepEqual(JSON.parse(events[3].after_json).id, ['text', 'renamed']);
  assert.equal(new Set(events.slice(1).map(event => event.transaction_id)).size, 1);
  db.close();
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
  for (const sql of ['', ' \n\t', '; ;\n', '-- comment', '/* comment */', '/* unfinished comment']) {
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

test('later runtime-only tables keep the public history interval and stay outside capture', async t => {
  const { db } = await fixture(t);
  db.exec("INSERT INTO results VALUES ('a', 'old', NULL, 1)");
  const before = db.prepare("SELECT history_from FROM replay_tables WHERE table_name = 'results'").get().history_from;
  await delay(5);
  db.exec('CREATE TABLE service_commit_events (gate_id TEXT PRIMARY KEY, events_json TEXT, delivered INTEGER)');
  installServiceHistory(db, { domain: 'task' });
  assert.equal(db.prepare("SELECT history_from FROM replay_tables WHERE table_name = 'results'").get().history_from, before);
  assert.equal(db.prepare("SELECT 1 FROM replay_tables WHERE table_name = 'service_commit_events'").get(), undefined);
  const captured = db.prepare('SELECT tables_json FROM replay_domains').get().tables_json;
  assert.ok(!JSON.parse(captured).includes('service_commit_events'));
  db.exec("INSERT INTO service_commit_events VALUES ('runtime-gate', '[]', 0)");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM replay_events WHERE table_name = 'service_commit_events'").get().n, 0);
  db.close();
});

test('schema changes reset the affected journal interval without reinterpreting older row images', async t => {
  const { db } = await fixture(t);
  db.exec("INSERT INTO results VALUES ('a', 'old', NULL, 1)");
  const previous = db.prepare("SELECT history_from FROM replay_tables WHERE table_name = 'results'").get().history_from;
  await delay(5);
  db.exec('ALTER TABLE results ADD COLUMN annotation TEXT');
  installServiceHistory(db, { domain: 'task' });
  const catalog = db.prepare("SELECT history_from, columns_json FROM replay_tables WHERE table_name = 'results'").get();
  assert.ok(catalog.history_from > previous);
  assert.ok(JSON.parse(catalog.columns_json).some(column => column.name === 'annotation'));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM replay_events WHERE table_name = 'results'").get().n, 0);
  db.exec("UPDATE results SET annotation = 'new schema' WHERE id = 'a'");
  const image = JSON.parse(db.prepare("SELECT after_json FROM replay_events WHERE table_name = 'results'").get().after_json);
  assert.deepEqual(image.annotation, ['text', 'new schema']);
  db.close();
});

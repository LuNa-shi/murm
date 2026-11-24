import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, open, realpath, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';

const SQL_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const installed = new WeakMap();
const quote = value => `"${String(value).replaceAll('"', '""')}"`;
const literal = value => `'${String(value).replaceAll("'", "''")}'`;
const ROWID = '__replay_rowid__';
// Historical capture omits these live ownership and delivery tables.
// A host establishes fresh authority separately from this journal.
const RUNTIME_TABLES = new Set(['experiments', 'observation_events', 'execution_workspace_state',
  'execution_workspace_requests', 'service_commit_gate', 'service_commit_events',
  'context_peer_receipts', 'judge_peer_phases']);

export const SERVICE_HISTORY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS replay_tables (
  table_name TEXT PRIMARY KEY,
  columns_json TEXT NOT NULL,
  rowid_alias TEXT,
  history_from TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS replay_domains (
  domain TEXT PRIMARY KEY,
  format_version INTEGER NOT NULL,
  tables_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS replay_transactions (
  transaction_id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL DEFAULT (${SQL_NOW}),
  committed_at TEXT
);
CREATE TABLE IF NOT EXISTS replay_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  transaction_id INTEGER
);
INSERT OR IGNORE INTO replay_control VALUES (1, NULL);
CREATE TABLE IF NOT EXISTS replay_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  transaction_id INTEGER,
  occurred_at TEXT NOT NULL DEFAULT (${SQL_NOW}),
  before_json TEXT,
  after_json TEXT
);
CREATE INDEX IF NOT EXISTS replay_events_time ON replay_events(occurred_at, sequence);
CREATE INDEX IF NOT EXISTS replay_events_transaction ON replay_events(transaction_id, sequence);
`;

export function parseReplayTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ||
      !Number.isFinite(Date.parse(value))) {
    throw new TypeError('Replay time must be an ISO timestamp with an explicit timezone');
  }
  return new Date(value).toISOString();
}

function missing(domain, reason, details = {}) {
  const error = new Error(`Cannot reconstruct ${domain} history: ${reason}`);
  error.code = 'REPLAY_HISTORY_MISSING';
  error.details = { domain, reason, ...details };
  return error;
}

function hasTable(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function rowExpression(columns, rowidAlias, side) {
  const fields = columns.map(column => {
    const reference = `${side}.${quote(column.name)}`;
    // Preserve SQLite's types, including binary attachments and 64-bit integers.
    return `${literal(column.name)}, json_array(typeof(${reference}), CASE typeof(${reference})
      WHEN 'blob' THEN hex(${reference}) WHEN 'integer' THEN CAST(${reference} AS TEXT) ELSE ${reference} END)`;
  });
  if (rowidAlias) fields.push(`${literal(ROWID)}, json_array('integer', CAST(${side}.${quote(rowidAlias)} AS TEXT))`);
  return `json_object(${fields.join(', ')})`;
}

const SQL_QUOTES_AND_COMMENTS = /--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]/g;
function statementInfo(sql) {
  const withoutComments = String(sql).replace(SQL_QUOTES_AND_COMMENTS, part => /^(?:--|\/\*)/.test(part) ? ' ' : part)
    .trim().replace(/^(?:;\s*)+/, '').replace(/;\s*$/, '').trim();
  const bare = withoutComments.replace(SQL_QUOTES_AND_COMMENTS, ' ');
  const savepoint = withoutComments.match(/^(SAVEPOINT|RELEASE(?:\s+SAVEPOINT)?|ROLLBACK(?:\s+TRANSACTION)?\s+TO(?:\s+SAVEPOINT)?)\s+([\s\S]+)$/i);
  let name = savepoint?.[2];
  if (name && /^['"`\[]/.test(name)) {
    const delimiter = name[0]; name = name.slice(1, -1).replaceAll(delimiter + delimiter, delimiter);
  }
  return {
    savepoint: savepoint?.[1].toUpperCase() === 'SAVEPOINT' ? name.toLowerCase() : null,
    release: /^RELEASE/i.test(savepoint?.[1] ?? '') ? name.toLowerCase() : null,
    rollbackTo: /^ROLLBACK/i.test(savepoint?.[1] ?? '') ? name.toLowerCase() : null,
    commit: /^(?:COMMIT|END)(?:\s+TRANSACTION)?$/i.test(withoutComments),
    write: /^(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|REINDEX|VACUUM|ANALYZE)\b/i.test(bare) ||
      (/^WITH\b/i.test(bare) && /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(bare)),
  };
}

/** Track explicit transaction completion without turning read transactions into
 * writers. Triggers capture every row; a transaction marker is allocated only
 * immediately before its first write. Ordinary autocommit statements use
 * SQLite's statement-stable clock. No model/tool calls are replayed here. */
function instrumentTransactions(db) {
  if (installed.has(db)) return installed.get(db);
  const state = { rawExec: db.exec.bind(db), rawPrepare: db.prepare.bind(db), enabled: true,
    savepoints: [], savepointTransaction: false };
  const beginWrite = () => {
    if (!state.enabled || !db.isTransaction) return;
    const current = state.rawPrepare('SELECT transaction_id FROM replay_control WHERE singleton = 1').get();
    if (current.transaction_id !== null) return;
    const id = state.rawPrepare('INSERT INTO replay_transactions DEFAULT VALUES').run().lastInsertRowid;
    state.rawPrepare('UPDATE replay_control SET transaction_id = ? WHERE singleton = 1').run(id);
  };
  const finishWrite = () => {
    if (!state.enabled || !db.isTransaction) return;
    const current = state.rawPrepare('SELECT transaction_id FROM replay_control WHERE singleton = 1').get();
    if (current.transaction_id === null) return;
    state.rawPrepare(`UPDATE replay_transactions SET committed_at = ${SQL_NOW} WHERE transaction_id = ?`).run(current.transaction_id);
    state.rawPrepare('UPDATE replay_control SET transaction_id = NULL WHERE singleton = 1').run();
    return current.transaction_id;
  };
  const execute = (info, call) => {
    const wasTransaction = db.isTransaction;
    // SQLite resolves repeated names to the innermost matching savepoint.
    // RELEASE commits only when it removes the savepoint that began the transaction.
    const releaseIndex = info.release === null ? -1 : state.savepoints.lastIndexOf(info.release);
    const commitsTransaction = info.commit || (releaseIndex === 0 && state.savepointTransaction);
    const finishingTransactionId = commitsTransaction ? finishWrite() : undefined;
    if (!commitsTransaction && info.write) beginWrite();
    try {
      const result = call();
      if (info.savepoint !== null) {
        if (!wasTransaction) state.savepointTransaction = true;
        state.savepoints.push(info.savepoint);
      }
      if (releaseIndex >= 0) state.savepoints.splice(releaseIndex);
      if (info.rollbackTo !== null) {
        const index = state.savepoints.lastIndexOf(info.rollbackTo);
        state.savepoints.splice(index + 1);
      }
      return result;
    } catch (error) {
      // A failed COMMIT can leave the transaction open, for example when a
      // deferred foreign key is unsatisfied. Preserve its original marker
      // until a successful retry commits every surviving write together.
      if (finishingTransactionId !== undefined && db.isTransaction) {
        state.rawPrepare('UPDATE replay_transactions SET committed_at = NULL WHERE transaction_id = ?').run(finishingTransactionId);
        state.rawPrepare('UPDATE replay_control SET transaction_id = ? WHERE singleton = 1').run(finishingTransactionId);
      }
      throw error;
    } finally {
      if (!db.isTransaction) {
        state.savepoints.length = 0;
        state.savepointTransaction = false;
      }
    }
  };
  db.prepare = function(sql) {
    const statement = state.rawPrepare(sql);
    const info = statementInfo(statement.sourceSQL);
    for (const method of ['run', 'get', 'all']) {
      const call = statement[method].bind(statement);
      statement[method] = (...args) => execute(info, () => call(...args));
    }
    const iterate = statement.iterate.bind(statement);
    statement.iterate = (...args) => {
      const iterator = iterate(...args);
      return {
        next: (...values) => execute(info, () => iterator.next(...values)),
        return: (...values) => iterator.return?.(...values) ?? { done: true },
        [Symbol.iterator]() { return this; },
      };
    };
    return statement;
  };
  db.exec = function(sql) {
    if (typeof sql !== 'string') return state.rawExec(sql);
    let remaining = String(sql);
    while (remaining.length) {
      // Avoid creating empty prepared statements, whose handles are already
      // finalized on Node 22. SQLite still validates the complete tail.
      if (!remaining.replace(SQL_QUOTES_AND_COMMENTS, '').replace(/[;\s]/g, '')) return state.rawExec(remaining);
      const first = state.rawPrepare(remaining).sourceSQL;
      // Let SQLite find statement boundaries, including trigger bodies and
      // semicolons in quoted text. Every COMMIT in a compound exec is observed.
      execute(statementInfo(first), () => state.rawExec(first));
      remaining = remaining.slice(first.length);
    }
  };
  installed.set(db, state);
  return state;
}

/** Enable automatic history on a service's persistent database after schema
 * setup. In-memory fixtures can opt in explicitly. Capture is part of each
 * business SQL write, so rolled-back writes leave no history. */
export function installServiceHistory(db, { domain, includeMemory = false } = {}) {
  if (!['task', 'context', 'judge'].includes(domain)) throw new TypeError('Unknown replay service domain');
  if (!includeMemory && !db.location()) return;
  if (db.isTransaction) throw new Error('Install service history after schema setup, outside a transaction');
  const state = installed.get(db);
  const exec = state?.rawExec ?? db.exec.bind(db);
  const prepare = state?.rawPrepare ?? db.prepare.bind(db);
  exec(SERVICE_HISTORY_SCHEMA_SQL);
  // REPLACE emits a DELETE trigger only with recursive_triggers enabled.
  exec('PRAGMA recursive_triggers = ON');
  const tables = prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
    .filter(table => !table.name.startsWith('sqlite_') && !table.name.startsWith('replay_') &&
      !RUNTIME_TABLES.has(table.name));
  exec('BEGIN IMMEDIATE');
  try {
    for (const table of tables) {
      const columns = prepare(`PRAGMA table_info(${quote(table.name)})`).all();
      if (columns.some(column => column.name === ROWID)) throw new Error(`Reserved replay column in ${table.name}`);
      const rowidAlias = /\bWITHOUT\s+ROWID\b/i.test(table.sql) ? null :
        ['rowid', '_rowid_', 'oid'].find(alias => !columns.some(column => column.name.toLowerCase() === alias));
      if (!rowidAlias && !columns.some(column => column.pk)) throw new Error(`No stable row identity in ${table.name}`);
      const encodedColumns = JSON.stringify(columns);
      const previous = prepare('SELECT * FROM replay_tables WHERE table_name = ?').get(table.name);
      if (previous && (previous.columns_json !== encodedColumns || previous.rowid_alias !== rowidAlias)) {
        // A schema change starts a new exact-history interval. Old receipts can
        // still be examined by the legacy projector; never reinterpret old rows.
        prepare('DELETE FROM replay_events WHERE table_name = ?').run(table.name);
        prepare(`UPDATE replay_tables SET columns_json = ?, rowid_alias = ?, history_from = ${SQL_NOW} WHERE table_name = ?`)
          .run(encodedColumns, rowidAlias, table.name);
      } else if (!previous) {
        prepare(`INSERT INTO replay_tables VALUES (?, ?, ?, ${SQL_NOW})`).run(table.name, encodedColumns, rowidAlias);
      }
      const prefix = `replay_capture_${createHash('sha256').update(table.name).digest('hex').slice(0, 16)}`;
      for (const [suffix, event, before, after] of [
        ['insert', 'INSERT', 'NULL', rowExpression(columns, rowidAlias, 'NEW')],
        ['update', 'UPDATE', rowExpression(columns, rowidAlias, 'OLD'), rowExpression(columns, rowidAlias, 'NEW')],
        ['delete', 'DELETE', rowExpression(columns, rowidAlias, 'OLD'), 'NULL'],
      ]) {
        exec(`DROP TRIGGER IF EXISTS ${quote(`${prefix}_${suffix}`)};
          CREATE TRIGGER ${quote(`${prefix}_${suffix}`)} AFTER ${event} ON ${quote(table.name)} BEGIN
            INSERT INTO replay_events(table_name, transaction_id, before_json, after_json)
              VALUES (${literal(table.name)}, (SELECT transaction_id FROM replay_control WHERE singleton = 1), ${before}, ${after});
          END;`);
      }
    }
    prepare(`INSERT INTO replay_domains(domain, format_version, tables_json) VALUES (?, 1, ?)
      ON CONFLICT(domain) DO UPDATE SET tables_json = excluded.tables_json`).run(domain, JSON.stringify(tables.map(table => table.name)));
    exec('COMMIT');
  } catch (error) { exec('ROLLBACK'); throw error; }
  instrumentTransactions(db);
}

/** Offline import only: a restored run starts its own recording interval. */
export function dropReplayHistory(db) {
  const state = installed.get(db);
  if (state) {
    state.enabled = false;
    db.exec = state.rawExec;
    db.prepare = state.rawPrepare;
    installed.delete(db);
  }
  const objects = db.prepare("SELECT type, name FROM sqlite_master WHERE type IN ('trigger', 'table')").all();
  for (const object of objects.filter(item => item.type === 'trigger' && item.name.startsWith('replay_capture_'))) db.exec(`DROP TRIGGER ${quote(object.name)}`);
  for (const object of objects.filter(item => item.type === 'table' && item.name.startsWith('replay_'))) db.exec(`DROP TABLE ${quote(object.name)}`);
}

function decodeRow(value) {
  if (value === null) return null;
  return Object.fromEntries(Object.entries(JSON.parse(value)).map(([name, [type, contents]]) => [name,
    type === 'blob' ? Buffer.from(contents, 'hex') : type === 'integer' ? BigInt(contents) : contents]));
}

function rewindJournal(db, { domain, at }) {
  if (!hasTable(db, 'replay_domains')) return null;
  const info = db.prepare('SELECT * FROM replay_domains WHERE domain = ?').get(domain);
  if (!info || info.format_version !== 1) return null;
  const tables = db.prepare('SELECT * FROM replay_tables').all();
  const catalog = new Map(tables.map(table => [table.table_name, { ...table, columns: JSON.parse(table.columns_json) }]));
  for (const name of JSON.parse(info.tables_json)) if (!catalog.has(name)) throw missing(domain, 'history table catalog is incomplete', { table: name });
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
    if (!name.startsWith('sqlite_') && !name.startsWith('replay_') && !RUNTIME_TABLES.has(name) && !catalog.has(name)) {
      throw missing(domain, 'a public table was added without automatic change capture', { table: name });
    }
  }
  const from = tables.filter(table => !RUNTIME_TABLES.has(table.table_name)).map(table => table.history_from).sort().at(-1);
  if (at < from) return null;
  const incomplete = db.prepare(`SELECT e.transaction_id FROM replay_events e LEFT JOIN replay_transactions t USING(transaction_id)
    WHERE e.transaction_id IS NOT NULL AND t.committed_at IS NULL LIMIT 1`).get();
  if (incomplete) throw missing(domain, 'a recorded transaction lacks a committed boundary', incomplete);
  for (const table of tables) {
    if (!hasTable(db, table.table_name) || JSON.stringify(db.prepare(`PRAGMA table_info(${quote(table.table_name)})`).all()) !== table.columns_json) {
      throw missing(domain, 'recorded schema does not match the source database', { table: table.table_name });
    }
    const prefix = `replay_capture_${createHash('sha256').update(table.table_name).digest('hex').slice(0, 16)}`;
    for (const suffix of ['insert', 'update', 'delete']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(`${prefix}_${suffix}`)) {
        throw missing(domain, 'automatic change capture is incomplete', { table: table.table_name, event: suffix });
      }
    }
  }
  const rows = db.prepare(`SELECT e.*, COALESCE(t.committed_at, e.occurred_at) AS effective_at FROM replay_events e
    LEFT JOIN replay_transactions t USING(transaction_id)
    WHERE COALESCE(t.committed_at, e.occurred_at) > ? ORDER BY e.sequence DESC`).all(at);
  const through = db.prepare(`SELECT MAX(COALESCE(t.committed_at, e.occurred_at)) AS at FROM replay_events e
    LEFT JOIN replay_transactions t USING(transaction_id)`).get().at ?? from;
  // Read the history first, then remove capture before applying reverse changes.
  dropReplayHistory(db);
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const event of rows) {
      const table = catalog.get(event.table_name);
      if (!table) throw missing(domain, 'event has no recorded table schema', { table: event.table_name });
      const before = decodeRow(event.before_json), after = decodeRow(event.after_json);
      if (after) {
        const keys = table.rowid_alias ? [table.rowid_alias] : table.columns.filter(column => column.pk).sort((a, b) => a.pk - b.pk).map(column => column.name);
        db.prepare(`DELETE FROM ${quote(table.table_name)} WHERE ${keys.map(name => `${quote(name)} IS ?`).join(' AND ')}`)
          .run(...keys.map(name => after[table.rowid_alias ? ROWID : name]));
      }
      if (before) {
        const names = table.columns.map(column => column.name);
        const values = names.map(name => before[name]);
        if (table.rowid_alias) { names.push(table.rowid_alias); values.push(before[ROWID]); }
        db.prepare(`INSERT INTO ${quote(table.table_name)} (${names.map(quote).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...values);
      }
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  finally { db.exec('PRAGMA foreign_keys = ON'); }
  return { domain, at, mode: 'journal', coverage: { from, through }, events_reverted: rows.length, warnings: [] };
}

/** Reconstruct one journaled service database into a new destination.
 * The caller owns any later use; this function never touches providers. */
export async function restoreServiceDatabaseAt({ sourcePath, destinationPath, domain, at }) {
  at = parseReplayTime(at);
  if (!['task', 'context', 'judge'].includes(domain)) throw new TypeError('Unknown replay service domain');
  const source = await realpath(sourcePath);
  const destination = resolve(destinationPath);
  if (source === destination) throw new TypeError('Replay destination must differ from the source database');
  await mkdir(dirname(destination), { recursive: true });
  const reservation = await open(destination, 'wx', 0o600);
  await reservation.close();
  let sourceDb, db, stage;
  try {
    // Even SQLite's readOnly connection may change a WAL source's -shm file.
    // The source database must be quiescent: copy its stable disk files before
    // opening SQLite at all, and let recovery/checkpointing touch only this copy.
    stage = await mkdtemp(join(dirname(destination), '.replay-source-'));
    const stagedSource = join(stage, 'source.sqlite');
    const signature = async path => {
      try { const info = await stat(path, { bigint: true }); return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`; }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    };
    const suffixes = ['', '-wal', '-journal'];
    const before = await Promise.all(suffixes.map(suffix => signature(`${source}${suffix}`)));
    for (let i = 0; i < suffixes.length; i += 1) {
      if (before[i] !== null) await copyFile(`${source}${suffixes[i]}`, `${stagedSource}${suffixes[i]}`);
    }
    const after = await Promise.all(suffixes.map(suffix => signature(`${source}${suffix}`)));
    if (before.some((value, index) => value !== after[index])) {
      throw missing(domain, 'source files changed during import; use a quiescent source database');
    }
    sourceDb = new DatabaseSync(stagedSource);
    await backup(sourceDb, destination);
    sourceDb.close(); sourceDb = null;
    db = new DatabaseSync(destination);
    const result = rewindJournal(db, { domain, at });
    if (!result) throw missing(domain, 'automatic history does not cover the requested time');
    db.close(); db = null;
    return result;
  } catch (error) {
    try { db?.close(); } catch {}
    try { sourceDb?.close(); } catch {}
    for (const suffix of ['', '-wal', '-shm']) await rm(`${destination}${suffix}`, { force: true }).catch(() => {});
    throw error;
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
  }
}

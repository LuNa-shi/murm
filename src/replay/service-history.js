import { createHash } from 'node:crypto';

const SQL_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const installed = new WeakMap();
const quote = value => `"${String(value).replaceAll('"', '""')}"`;
const literal = value => `'${String(value).replaceAll("'", "''")}'`;
const ROWID = '__replay_rowid__';
// The private change journal excludes transient ownership and delivery tables.
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
const SQL_TRIVIA_PREFIX = /^(?:[;\s]|--[^\n]*(?:\n|$)|\/\*[\s\S]*?(?:\*\/|$))*/;
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
      if (SQL_TRIVIA_PREFIX.exec(remaining)[0].length === remaining.length) return state.rawExec(remaining);
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
        // A schema change starts a new exact-history interval. Retained receipts
        // keep their original payloads, while incompatible row images are cleared.
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

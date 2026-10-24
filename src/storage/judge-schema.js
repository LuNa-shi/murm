export const JUDGE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS operations (
  operation_id TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS check_results (
  check_result_id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  candidate_material_id TEXT NOT NULL,
  target_task_id TEXT NOT NULL,
  target_spec_version INTEGER NOT NULL,
  execution_id TEXT,
  input_snapshot_hash TEXT NOT NULL,
  checker_ref TEXT NOT NULL,
  checker_version TEXT NOT NULL,
  environment_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('REQUESTED', 'RUNNING', 'RECEIVED', 'APPLIED', 'IGNORED', 'SUPERSEDED')),
  verdict TEXT CHECK (verdict IS NULL OR verdict IN ('PASS', 'FAIL', 'INCONCLUSIVE', 'ERROR')),
  judge_operation_status TEXT NOT NULL DEFAULT 'persisted',
  checker_process_status TEXT NOT NULL DEFAULT 'not_started',
  result_class TEXT NOT NULL DEFAULT 'unassessed',
  retryable INTEGER NOT NULL DEFAULT 0,
  diagnostic_code TEXT,
  evidence_json TEXT NOT NULL,
  applied_task_state_version INTEGER,
  applied_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS checker_preflights (
  preflight_key TEXT PRIMARY KEY,
  fixture_id TEXT NOT NULL,
  checker_ref TEXT NOT NULL,
  checker_version TEXT NOT NULL,
  environment_ref TEXT NOT NULL,
  project_root TEXT,
  status TEXT NOT NULL CHECK (status IN ('healthy', 'unavailable')),
  checker_process_status TEXT NOT NULL,
  diagnostic_code TEXT,
  retryable INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  health_fingerprint TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
`;

export function ensureJudgeSchema(database) {
  database.exec(JUDGE_SCHEMA_SQL);
  const columns = new Set(database.prepare('PRAGMA table_info(check_results)').all().map((column) => column.name));
  for (const [name, definition] of [
    ['execution_id', 'TEXT'],
    ['applied_task_state_version', 'INTEGER'],
    ['applied_at', 'TEXT'],
    ['judge_operation_status', "TEXT NOT NULL DEFAULT 'persisted'"],
    ['checker_process_status', "TEXT NOT NULL DEFAULT 'not_started'"],
    ['result_class', "TEXT NOT NULL DEFAULT 'unassessed'"],
    ['retryable', 'INTEGER NOT NULL DEFAULT 0'],
    ['diagnostic_code', 'TEXT'],
  ]) {
    if (!columns.has(name)) database.exec(`ALTER TABLE check_results ADD COLUMN ${name} ${definition}`);
  }
}

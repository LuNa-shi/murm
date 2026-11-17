export const JUDGE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS operations (
  operation_id TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS judge_request_aliases (
  request_key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  check_result_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS judge_mission_check_policies (
  mission_id TEXT PRIMARY KEY,
  max_requests INTEGER CHECK(max_requests > 0),
  max_concurrent INTEGER NOT NULL CHECK(max_concurrent > 0),
  process_timeout_ms INTEGER,
  max_queued INTEGER NOT NULL DEFAULT 0,
  queue_wait_ms INTEGER NOT NULL DEFAULT 120000
);

CREATE TABLE IF NOT EXISTS judge_mission_check_admissions (
  mission_id TEXT NOT NULL,
  check_result_id TEXT NOT NULL,
  admitted_at TEXT NOT NULL,
  started_at TEXT,
  is_retry INTEGER NOT NULL DEFAULT 0,
  preflight_starts INTEGER NOT NULL DEFAULT 0,
  source_starts INTEGER NOT NULL DEFAULT 0,
  settled_at TEXT,
  PRIMARY KEY (mission_id, check_result_id)
);
CREATE INDEX IF NOT EXISTS judge_mission_check_active
  ON judge_mission_check_admissions(mission_id) WHERE settled_at IS NULL;

CREATE TABLE IF NOT EXISTS check_results (
  check_result_id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  workspace_source_id TEXT NOT NULL,
  workspace_content_hash TEXT,
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
  const legacy = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'judge_mission_check_policies'").get();
  if (legacy?.sql.includes('max_requests INTEGER NOT NULL')) {
    database.exec(`BEGIN IMMEDIATE;
      ALTER TABLE judge_mission_check_policies RENAME TO judge_mission_check_policies_legacy;
      CREATE TABLE judge_mission_check_policies (mission_id TEXT PRIMARY KEY,
        max_requests INTEGER CHECK(max_requests > 0), max_concurrent INTEGER NOT NULL CHECK(max_concurrent > 0),
        process_timeout_ms INTEGER);
      INSERT INTO judge_mission_check_policies SELECT mission_id, max_requests, max_concurrent, process_timeout_ms FROM judge_mission_check_policies_legacy;
      DROP TABLE judge_mission_check_policies_legacy;
      COMMIT;`);
  }
  database.exec(JUDGE_SCHEMA_SQL);
  const policyColumns = new Set(database.prepare('PRAGMA table_info(judge_mission_check_policies)').all().map(column => column.name));
  if (!policyColumns.has('max_queued')) database.exec('ALTER TABLE judge_mission_check_policies ADD COLUMN max_queued INTEGER NOT NULL DEFAULT 0');
  if (!policyColumns.has('queue_wait_ms')) database.exec('ALTER TABLE judge_mission_check_policies ADD COLUMN queue_wait_ms INTEGER NOT NULL DEFAULT 120000');
  const admissionColumns = new Set(database.prepare('PRAGMA table_info(judge_mission_check_admissions)').all().map(column => column.name));
  if (!admissionColumns.has('started_at')) {
    database.exec(`ALTER TABLE judge_mission_check_admissions ADD COLUMN started_at TEXT;
      UPDATE judge_mission_check_admissions SET started_at = admitted_at`);
  }
  const columns = new Set(database.prepare('PRAGMA table_info(check_results)').all().map((column) => column.name));
  for (const [name, definition] of [
    ['workspace_content_hash', 'TEXT'],
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

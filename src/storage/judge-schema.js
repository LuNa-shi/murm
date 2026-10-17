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
  input_snapshot_hash TEXT NOT NULL,
  checker_ref TEXT NOT NULL,
  checker_version TEXT NOT NULL,
  environment_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('REQUESTED', 'RUNNING', 'RECEIVED', 'APPLIED', 'IGNORED', 'SUPERSEDED')),
  verdict TEXT CHECK (verdict IS NULL OR verdict IN ('PASS', 'FAIL', 'INCONCLUSIVE', 'ERROR')),
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

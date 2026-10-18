export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL,
  parent_id TEXT REFERENCES tasks(task_id),
  owner_ref TEXT NOT NULL,
  task_type TEXT NOT NULL,
  task_type_version TEXT NOT NULL,
  goal TEXT NOT NULL,
  expected_output TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0 CHECK (priority >= 0),
  task_instructions TEXT NOT NULL DEFAULT '',
  workspace_json TEXT NOT NULL DEFAULT '{}',
  acceptance_conditions_json TEXT NOT NULL,
  input_material_refs_json TEXT NOT NULL,
  spec_version INTEGER NOT NULL,
  spec_hash TEXT NOT NULL,
  completion_contract_json TEXT NOT NULL,
  parallel_quota INTEGER NOT NULL DEFAULT 1 CHECK (parallel_quota >= 1),
  state_version INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('OPEN', 'BLOCKED', 'RUNNING', 'WAITING', 'SATISFIED', 'FAILED', 'CANCELLED', 'REJECTED')),
  block_reason TEXT,
  max_depth INTEGER NOT NULL,
  max_children INTEGER NOT NULL,
  max_attempts INTEGER NOT NULL,
  retry_policy_json TEXT NOT NULL,
  root_deadline TEXT,
  cancelled_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((state = 'BLOCKED' AND block_reason IS NOT NULL) OR (state <> 'BLOCKED' AND block_reason IS NULL))
);

CREATE TABLE IF NOT EXISTS executions (
  execution_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  owner_ref TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('CREATED', 'RUNNING', 'WAITING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED', 'FENCED', 'SUPERSEDED')),
  state_version INTEGER NOT NULL DEFAULT 0,
  attempt_no INTEGER NOT NULL,
  fencing_version INTEGER NOT NULL,
  runtime_generation INTEGER NOT NULL,
  lease_expires_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  launch_token TEXT NOT NULL UNIQUE,
  spec_version INTEGER NOT NULL,
  spec_hash TEXT NOT NULL,
  agent_prompt TEXT NOT NULL DEFAULT '',
  workspace_manifest_ref TEXT NOT NULL,
  input_material_refs_json TEXT NOT NULL,
  input_snapshot_hash TEXT NOT NULL,
  workspace_selection_json TEXT NOT NULL DEFAULT '{}',
  candidate_material_id TEXT,
  workspace_ref TEXT,
  workspace_revision INTEGER,
  workspace_content_hash TEXT,
  checkpoint_ref TEXT,
  checkpoint_hash TEXT,
  instruction_version INTEGER NOT NULL DEFAULT 1,
  steer_material_refs_json TEXT NOT NULL,
  wait_condition_json TEXT,
  wait_deadline TEXT,
  resume_token TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS operations (
  operation_id TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_creation_keys (
  request_key TEXT PRIMARY KEY,
  parent_task_id TEXT,
  fingerprint TEXT NOT NULL,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(task_id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS claim_keys (
  request_key TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  fingerprint TEXT NOT NULL,
  execution_id TEXT NOT NULL UNIQUE REFERENCES executions(execution_id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wait_keys (
  request_key TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(execution_id),
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wake_keys (
  request_key TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(execution_id),
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

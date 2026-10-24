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
  started_at TEXT,
  handoff_deadline TEXT,
  execution_deadline TEXT,
  handoff_reminder_sent_at TEXT,
  handoff_metadata_json TEXT,
  terminal_reason TEXT,
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

-- Task relationships are semantic records over ordinary Task IDs.  The
-- parent_id column above remains the legacy creation edge; these tables keep
-- alternative work, jointly-required work, and concrete dependencies
-- separate from creation provenance.
CREATE TABLE IF NOT EXISTS task_creation_provenance (
  task_id TEXT PRIMARY KEY REFERENCES tasks(task_id),
  creator_task_id TEXT REFERENCES tasks(task_id),
  creator_execution_id TEXT REFERENCES executions(execution_id),
  creator_actor_ref TEXT NOT NULL,
  creation_kind TEXT NOT NULL CHECK (creation_kind IN ('ROOT', 'CHILD', 'BRANCH', 'REQUIRED_SUBTASK', 'REWORK')),
  prior_task_id TEXT REFERENCES tasks(task_id),
  source_material_refs_json TEXT NOT NULL DEFAULT '[]',
  feedback_json TEXT,
  workspace_lineage_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_structure_versions (
  task_id TEXT PRIMARY KEY REFERENCES tasks(task_id),
  structural_version INTEGER NOT NULL DEFAULT 1 CHECK (structural_version >= 1),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_structure_events (
  event_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  structural_version INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  actor_ref TEXT NOT NULL,
  execution_id TEXT REFERENCES executions(execution_id),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS task_structure_events_task_version
  ON task_structure_events(task_id, structural_version, created_at);

CREATE TABLE IF NOT EXISTS task_structure_groups (
  group_id TEXT PRIMARY KEY,
  owner_task_id TEXT NOT NULL REFERENCES tasks(task_id),
  group_kind TEXT NOT NULL CHECK (group_kind IN ('BRANCH', 'REQUIRED_SUBTASK')),
  structural_version INTEGER NOT NULL,
  created_by_task_id TEXT REFERENCES tasks(task_id),
  created_by_execution_id TEXT REFERENCES executions(execution_id),
  created_by_actor_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  retired_at TEXT
);

CREATE TABLE IF NOT EXISTS task_structure_members (
  group_id TEXT NOT NULL REFERENCES task_structure_groups(group_id),
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  member_order INTEGER NOT NULL DEFAULT 0,
  added_in_version INTEGER NOT NULL,
  added_at TEXT NOT NULL,
  retired_at TEXT,
  PRIMARY KEY (group_id, task_id)
);

CREATE INDEX IF NOT EXISTS task_structure_members_task
  ON task_structure_members(task_id, retired_at);

CREATE TABLE IF NOT EXISTS task_structure_dependencies (
  dependency_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  dependency_kind TEXT NOT NULL CHECK (dependency_kind IN ('TASK', 'MATERIAL', 'CHECK_RESULT')),
  prerequisite_task_id TEXT REFERENCES tasks(task_id),
  material_id TEXT,
  check_result_id TEXT,
  requirement_json TEXT NOT NULL DEFAULT '{}',
  created_by_task_id TEXT REFERENCES tasks(task_id),
  created_by_execution_id TEXT REFERENCES executions(execution_id),
  created_by_actor_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  retired_at TEXT,
  CHECK (
    (dependency_kind = 'TASK' AND prerequisite_task_id IS NOT NULL AND material_id IS NULL AND check_result_id IS NULL) OR
    (dependency_kind = 'MATERIAL' AND prerequisite_task_id IS NULL AND material_id IS NOT NULL AND check_result_id IS NULL) OR
    (dependency_kind = 'CHECK_RESULT' AND prerequisite_task_id IS NULL AND material_id IS NULL AND check_result_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS task_structure_dependencies_active
  ON task_structure_dependencies(task_id, dependency_kind, COALESCE(prerequisite_task_id, material_id, check_result_id))
  WHERE retired_at IS NULL;

CREATE TABLE IF NOT EXISTS task_rework_links (
  prior_task_id TEXT NOT NULL REFERENCES tasks(task_id),
  rework_task_id TEXT PRIMARY KEY REFERENCES tasks(task_id),
  feedback_json TEXT NOT NULL,
  source_material_refs_json TEXT NOT NULL DEFAULT '[]',
  workspace_lineage_json TEXT,
  created_by_actor_ref TEXT NOT NULL,
  created_by_execution_id TEXT REFERENCES executions(execution_id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS claim_keys (
  request_key TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  fingerprint TEXT NOT NULL,
  execution_id TEXT NOT NULL REFERENCES executions(execution_id),
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

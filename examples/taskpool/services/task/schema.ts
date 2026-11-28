export const TASKS_TABLE_DEFINITION = `(
  task_id TEXT PRIMARY KEY,
  owner_ref TEXT NOT NULL,
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
  state_version INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('OPEN', 'BLOCKED', 'RUNNING', 'DONE', 'CANCELED')),
  block_reason TEXT,
  cancelled_at TEXT,
  eligible_at TEXT,
  responsibility_key TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((state = 'BLOCKED' AND block_reason IS NOT NULL) OR (state <> 'BLOCKED' AND block_reason IS NULL))
)`;

export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS missions (
  mission_id TEXT PRIMARY KEY,
  goal TEXT NOT NULL,
  acceptance_conditions_json TEXT NOT NULL DEFAULT '{}',
  merge_required_check_json TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_records (
  task_id TEXT PRIMARY KEY REFERENCES tasks(task_id),
  mission_id TEXT NOT NULL REFERENCES missions(mission_id),
  summary TEXT NOT NULL,
  gap TEXT NOT NULL,
  timebox_ms INTEGER NOT NULL CHECK (timebox_ms > 0),
  registration_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS task_records_mission
  ON task_records(mission_id, created_at, task_id);

-- SQLite indexes carry rowid as their tie breaker: this supports bounded
-- Mission creation-window scans without sorting every Mission record.
CREATE INDEX IF NOT EXISTS task_records_mission_scan ON task_records(mission_id);

CREATE TABLE IF NOT EXISTS task_contract_revisions (
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  spec_version INTEGER NOT NULL,
  spec_hash TEXT NOT NULL,
  actor_ref TEXT NOT NULL,
  reason TEXT NOT NULL,
  contract_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, spec_version)
);

CREATE TABLE IF NOT EXISTS task_relations (
  relation_id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(mission_id),
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  relation_kind TEXT NOT NULL CHECK (relation_kind = 'depends_on'),
  related_task_id TEXT NOT NULL REFERENCES tasks(task_id),
  created_by_task_id TEXT REFERENCES tasks(task_id),
  created_by_execution_id TEXT REFERENCES executions(execution_id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(task_id, relation_kind, related_task_id)
);

CREATE INDEX IF NOT EXISTS task_relations_task
  ON task_relations(task_id, relation_kind, created_at);

CREATE INDEX IF NOT EXISTS task_relations_related
  ON task_relations(related_task_id, relation_kind, created_at);

CREATE TABLE IF NOT EXISTS task_dependency_replacements (
  operation_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  original_relation_json TEXT NOT NULL,
  replacement_relation_id TEXT NOT NULL,
  actor_ref TEXT NOT NULL,
  execution_id TEXT REFERENCES executions(execution_id),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_cancellations (
  task_id TEXT PRIMARY KEY REFERENCES tasks(task_id),
  operation_id TEXT NOT NULL UNIQUE,
  replacement_task_id TEXT REFERENCES tasks(task_id),
  actor_ref TEXT NOT NULL,
  execution_id TEXT REFERENCES executions(execution_id),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Notifications are durable, keyed lifecycle facts rather than a general
-- Agent-to-Agent chat channel.  A delivery key makes retries idempotent while
-- the nullable execution target lets an inactive Task receive the item on its
-- next Execution.
CREATE TABLE IF NOT EXISTS task_notifications (
  notification_id TEXT PRIMARY KEY,
  delivery_key TEXT NOT NULL UNIQUE,
  mission_id TEXT NOT NULL REFERENCES missions(mission_id),
  recipient_task_id TEXT NOT NULL REFERENCES tasks(task_id),
  recipient_execution_id TEXT REFERENCES executions(execution_id),
  notification_type TEXT NOT NULL CHECK (notification_type IN ('handoff_warning', 'material_available', 'task_reopened')),
  material_id TEXT,
  source_task_id TEXT,
  source_execution_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  delivered_execution_id TEXT,
  handled_at TEXT,
  handled_execution_id TEXT,
  handling_decision TEXT,
  handling_action TEXT,
  handling_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS task_notifications_pending
  ON task_notifications(recipient_task_id, delivered_at, created_at);
CREATE INDEX IF NOT EXISTS task_notifications_execution
  ON task_notifications(recipient_execution_id, delivered_at, created_at);

-- Delivery and handling are separate facts.  A Task-level notification may
-- be delivered to more than one active Execution, and each recipient must
-- acknowledge/act on it independently before it is considered handled.
CREATE TABLE IF NOT EXISTS task_notification_receipts (
  notification_id TEXT NOT NULL REFERENCES task_notifications(notification_id),
  execution_id TEXT NOT NULL REFERENCES executions(execution_id),
  delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  delivered_at TEXT,
  handled_at TEXT,
  handling_decision TEXT,
  handling_action TEXT,
  handling_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (notification_id, execution_id)
);

CREATE INDEX IF NOT EXISTS task_notification_receipts_execution
  ON task_notification_receipts(execution_id, handled_at, delivered_at);

-- A Material link is an explicit delivery/knowledge edge.  It does not make
-- the linked Task a parent or create a scheduling dependency.  role tells
-- readers whether the edge is an input, response, handoff, or shared
-- experience; producer provenance is copied from the immutable Material so a
-- later reader can audit who produced it.
CREATE TABLE IF NOT EXISTS task_material_links (
  link_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  material_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('input', 'response', 'handoff', 'experience')),
  receiving_task_id TEXT REFERENCES tasks(task_id),
  producer_task_id TEXT,
  producer_execution_id TEXT,
  created_by_task_id TEXT REFERENCES tasks(task_id),
  created_by_execution_id TEXT REFERENCES executions(execution_id),
  accepted_at TEXT,
  accepted_by_task_id TEXT REFERENCES tasks(task_id),
  accepted_by_execution_id TEXT REFERENCES executions(execution_id),
  created_at TEXT NOT NULL,
  UNIQUE(task_id, material_id, role, receiving_task_id)
);

CREATE INDEX IF NOT EXISTS task_material_links_task
  ON task_material_links(task_id, role, created_at, link_id);

CREATE INDEX IF NOT EXISTS task_material_links_material
  ON task_material_links(material_id, role, created_at, link_id);

CREATE TABLE IF NOT EXISTS tasks ${TASKS_TABLE_DEFINITION};

CREATE TABLE IF NOT EXISTS executions (
  execution_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  owner_ref TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('CREATED', 'RUNNING', 'CLOSING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED', 'FENCED', 'HANDED_OFF')),
  state_version INTEGER NOT NULL DEFAULT 0,
  attempt_no INTEGER NOT NULL,
  -- A Core binding is immutable for the lifetime of an Execution.
  core_id TEXT,
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
  workspace_input_json TEXT,
  workspace_ref TEXT,
  workspace_revision INTEGER,
  workspace_content_hash TEXT,
  started_at TEXT,
  handoff_deadline TEXT,
  execution_deadline TEXT,
  handoff_reminder_sent_at TEXT,
  handoff_metadata_json TEXT,
  terminal_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS execution_finish_intents (
  execution_id TEXT PRIMARY KEY REFERENCES executions(execution_id),
  request_id TEXT NOT NULL UNIQUE,
  outcome TEXT NOT NULL CHECK (outcome IN ('done', 'incomplete', 'blocked', 'cancelled')),
  payload_json TEXT NOT NULL,
  terminal_state TEXT NOT NULL,
  reason TEXT,
  wait_for_task_id TEXT REFERENCES tasks(task_id),
  replacement_task_id TEXT REFERENCES tasks(task_id),
  accepted_at TEXT NOT NULL,
  closed_at TEXT
);

-- Runtime creates Agent identities before there is any Task take. The Task
-- coordinator stores them here so take and lifecycle guards share a transaction.
CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(mission_id),
  core_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('STARTING', 'UNBOUND', 'PREPARING', 'ACTIVE', 'CLOSING', 'CLOSED')),
  execution_id TEXT UNIQUE REFERENCES executions(execution_id),
  state_version INTEGER NOT NULL DEFAULT 0,
  selection_deadline TEXT NOT NULL,
  hard_deadline TEXT NOT NULL,
  coordination_permissions_json TEXT NOT NULL DEFAULT '[]',
  resource_key TEXT NOT NULL UNIQUE,
  provider TEXT,
  sandbox_id TEXT,
  sandbox_create_state TEXT NOT NULL DEFAULT 'NOT_DISPATCHED',
  sandbox_timeout_seconds INTEGER,
  sandbox_expires_at TEXT,
  exit_request_id TEXT UNIQUE,
  exit_reason TEXT,
  stop_terminal_state TEXT,
  started_at TEXT NOT NULL,
  ready_at TEXT,
  closed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS agents_occupied_core
  ON agents(mission_id, core_id) WHERE state <> 'CLOSED';

CREATE TABLE IF NOT EXISTS operations (
  operation_id TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS take_keys (
  request_key TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  fingerprint TEXT NOT NULL,
  execution_id TEXT NOT NULL REFERENCES executions(execution_id),
  created_at TEXT NOT NULL
);

`;

export const MISSION_SUBMISSION_SCHEMA_SQL = `
      CREATE TABLE IF NOT EXISTS mission_final_check_policies (
        mission_id TEXT PRIMARY KEY,
        max_checks INTEGER CHECK(max_checks IS NULL OR max_checks > 0),
        max_concurrent INTEGER NOT NULL CHECK(max_concurrent > 0 AND (max_checks IS NULL OR max_concurrent <= max_checks))
      );
      CREATE TABLE IF NOT EXISTS mission_final_check_admissions (
        mission_id TEXT NOT NULL,
        submission_id TEXT NOT NULL,
        admitted_at TEXT NOT NULL,
        settled_at TEXT,
        PRIMARY KEY (mission_id, submission_id)
      );
      CREATE INDEX IF NOT EXISTS mission_final_check_active
        ON mission_final_check_admissions(mission_id) WHERE settled_at IS NULL;
      CREATE TABLE IF NOT EXISTS mission_submissions (
        mission_id TEXT NOT NULL,
        submission_id TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        snapshot_fingerprint TEXT NOT NULL,
        state TEXT NOT NULL,
        document TEXT NOT NULL,
        PRIMARY KEY (mission_id, submission_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS mission_submission_inflight
        ON mission_submissions (mission_id) WHERE state IN ('preparing', 'pending');
      CREATE TABLE IF NOT EXISTS mission_submission_audit (
        mission_id TEXT NOT NULL, submission_id TEXT NOT NULL, event TEXT NOT NULL, observed_at TEXT NOT NULL, details_json TEXT
      );
    `;

// Kept as a reusable definition so a persistent MVP database can be rebuilt
// when the simplified Task lifecycle adds DONE/CLOSED/CANCELED to its state
// CHECK constraint. SQLite cannot alter a CHECK constraint in place.
export const TASKS_TABLE_DEFINITION = `(
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
  state TEXT NOT NULL CHECK (state IN ('OPEN', 'BLOCKED', 'RUNNING', 'DONE', 'CLOSED', 'CANCELED', 'WAITING', 'SATISFIED', 'FAILED', 'CANCELLED', 'REJECTED')),
  block_reason TEXT,
  max_depth INTEGER NOT NULL,
  max_children INTEGER NOT NULL,
  max_attempts INTEGER NOT NULL,
  retry_policy_json TEXT NOT NULL,
  root_deadline TEXT,
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

-- Mission and modern Task records are deliberately additive.  The legacy
-- Task tables remain readable while the Issue #100 public surface uses these
-- small records for a flat Mission-scoped queue.
CREATE TABLE IF NOT EXISTS missions (
  mission_id TEXT PRIMARY KEY,
  goal TEXT NOT NULL,
  acceptance_conditions_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS modern_task_records (
  task_id TEXT PRIMARY KEY REFERENCES tasks(task_id),
  mission_id TEXT NOT NULL REFERENCES missions(mission_id),
  summary TEXT NOT NULL,
  timebox_ms INTEGER NOT NULL CHECK (timebox_ms > 0),
  registration_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS modern_task_records_mission
  ON modern_task_records(mission_id, created_at, task_id);

CREATE TABLE IF NOT EXISTS task_relations (
  relation_id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(mission_id),
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  relation_kind TEXT NOT NULL CHECK (relation_kind IN ('spawned_from', 'depends_on')),
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
  state TEXT NOT NULL CHECK (state IN ('CREATED', 'RUNNING', 'WAITING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED', 'FENCED', 'HANDED_OFF', 'SUPERSEDED')),
  state_version INTEGER NOT NULL DEFAULT 0,
  attempt_no INTEGER NOT NULL,
  -- A Core binding is immutable for the lifetime of an Execution.  Legacy
  -- records may be unbound and are migrated with NULL for read compatibility.
  core_id TEXT,
  session_generation INTEGER NOT NULL DEFAULT 1,
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
  collaboration_reason_json TEXT,
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

CREATE TABLE IF NOT EXISTS take_keys (
  request_key TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  fingerprint TEXT NOT NULL,
  execution_id TEXT NOT NULL REFERENCES executions(execution_id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_admission_policies (
  root_id TEXT PRIMARY KEY REFERENCES tasks(task_id),
  max_unfinished_tasks INTEGER NOT NULL,
  max_open_tasks INTEGER NOT NULL,
  max_children_per_execution INTEGER NOT NULL,
  max_turn_mutations INTEGER NOT NULL,
  aging_threshold_ms INTEGER NOT NULL,
  require_responsibility_key INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS execution_admission_counters (
  execution_id TEXT PRIMARY KEY REFERENCES executions(execution_id),
  child_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS turn_admission_counters (
  execution_id TEXT NOT NULL REFERENCES executions(execution_id),
  turn_id TEXT NOT NULL,
  mutation_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (execution_id, turn_id)
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

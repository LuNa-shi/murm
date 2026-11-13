# 11. Durable records, process state and complete schemas

This chapter separates persisted facts from live-process state, and provides every exported SQLite schema for the implementation pinned in [Architecture INDEX](INDEX.md). A restarted process can reconstruct facts that were committed to a database; it does not automatically recreate an in-memory Pi process, bound Core, pending callback or Sandbox job.

## Ownership and persistence map

| Owner | Durable records | What remains outside the database |
|---|---|---|
| Task Service | Mission, Task contract/state, Execution/fence/lease, Task relationships, admission counters, replay keys, Material links, notification and receipt state | Runtime Core occupancy, callback subscriptions and scheduling loop |
| Context Service | Immutable Material content/provenance/hash/version and explicit consumption edges | No semantic proof of whether the Agent used or understood the text |
| Judge Service | Candidate request/checker/input binding, CheckResult and result class, checker health/preflight attempts, applied-result bookkeeping | The currently executing checker subprocess and pending asynchronous call |
| Workspace Manager | File content plus `.swarm/workspace.json`, revision/checkpoint metadata; local Git commits/refs are separate filesystem history | Live process working memory and unsaved shell edits |
| Observation Store | Experiment registry, ordered events, operator payload, redacted Agent payload and payload hash | SSE connections, event-emitter subscriptions, server caches and client projection |
| Registry/Bridge | Manifest/profile hashes can be recorded in run metadata; source/bundle files define defaults | Registered adapters, readiness cache, Bridge token, current binding, deferred lifecycle callback |
| Sandbox | Workspace files can be saved by Runtime checkpoint/progress | Container/process state, background job handles; cleanup and saving are separate steps |

The benchmark normally supplies one project SQLite connection to Task, Context and Judge. This lets the Task Service use Context publication inside its transaction. Independently hosted processes can point at the same mounted database; using separate files does not magically provide distributed transactions or replicate state. The shared `operations` table namespaces replay by `operation_id`, so callers use distinct IDs across logically different actions.

## How to interpret the tables

| Table(s) | Meaning and important fields |
|---|---|
| `missions` | Mission columns are `mission_id`, `goal`, `acceptance_conditions_json`, `created_by`, `created_at`, `updated_at`. Initial Materials/resource budgets are not Mission columns. |
| `tasks` + `modern_task_records` | Durable legacy-compatible Task row plus `modern_task_records` Mission ID, short summary, timebox and registration hash. Responsibility keys live on `tasks`; feedback lives in notifications/receipts. Modern record projection combines these facts. The earliest modern Task in a Mission is treated as the shared Mission Task; there is no explicit shared-Mission boolean. |
| `executions` | One authorization interval: Task/spec/state/fence, owner/Core, lease/deadline, Workspace/checkpoint, candidate/result references, input snapshot/Materials, and terminal reason. A Session restart can retain this Execution. |
| `task_relations` | Modern `spawned_from` provenance and `depends_on` prerequisite edges. Provenance does not imply a scheduler dependency. |
| `task_material_links` | A Material's input/response/handoff/experience role for a Task and receiving Task, separate from immutable producer provenance. |
| `task_notifications` | Durable typed feedback queue with Mission/Task/Execution targeting and fallback delivery/handling metadata. |
| `task_notification_receipts` | Per-Execution receipt: two concurrent Executions can handle the same notification independently. Delivery is not handling. |
| `materials` | Immutable content and producer IDs, role/kind/evidence state, Mission ID, content hash/ref, version, supersedes pointer and provenance. Public reads also add `producer_task_id`/`producer_execution_id` aliases. |
| `material_consumptions` | Explicit `(operation_id, material_id)` consumption with reader Task/Execution, action and optional action reference. Reading/searching alone does not create this row. |
| `check_results` | Request key/hash and candidate binding; status/verdict; separate process status/result class/retryability/diagnostic; applied Task state/version/time. A result is evidence, not universally Mission acceptance. |
| `checker_preflights` | Checker/environment/project identity, health fingerprint, repeated-failure count and evidence. |
| `operations`, `claim_keys`, `task_creation_keys`, `wait_keys`, `wake_keys` | Replay and conflict protection. Operation replay compares the full stable operation/payload/envelope fingerprint. |
| `task_creation_provenance`, `task_structure_*`, `task_rework_links` | Retained structural/legacy support: versioned alternative/required groups, explicit dependencies, audit history and rework lineage. These tables still exist at this baseline. |
| `task_admission_policies`, `execution_admission_counters`, `turn_admission_counters` | Creation/fairness limits and usage accounting; not the authoritative plan for a GitHub development Issue. |
| `experiments`, `observation_events` | Monitoring registry and ordered projections. `visibility` is a label; Agent reads use the redacted payload column rather than filtering out all private-labeled rows. |

## Transactions, migrations and recovery limits

Task and Observation schema setup enables foreign keys, a 5-second SQLite busy timeout and WAL mode. Context and Judge create their tables on the supplied connection. Task/Context dispatch mutation replay and Judge's `submit_check_result` replay use `BEGIN IMMEDIATE` transactions with rollback on failure. Judge commits its RUNNING request before awaiting the external checker; checker health and final result are later writes, so a whole compiler run is not one database transaction. A readonly query is not thereby a distributed snapshot across independently hosted providers.

Constructors inspect existing columns and apply compatibility migrations. Context adds missing `role` (default `experience`) and `mission_id`. Judge adds candidate-content binding, Execution/applied-result metadata and explicit checker outcome fields. Task Service contains further migrations for Task/Execution fields, constraints and notification receipts; the source inventory links that constructor. The SQL below is the complete create-schema definition, not a promise that every historical database already has identical rows or a lossless automatic migration for every possible old schema.

Durable state can outlive a Session, but runtime recovery still has to validate the current fence, reconstruct/restore a Workspace, reacquire a Core and start a Session. Observation events do not authorize that recovery. See [02 Execution](02-execution.md) and [05 Workspace](05-workspace-continuity.md).

## Updating and checking

`node scripts/generate-architecture-api.mjs` refreshes the schema text from the executable exports. `--check` verifies it without writes. A newly added table, column, constraint or index therefore creates a reviewable documentation difference. Runtime state-machine and migration changes also require updates to this narrative and the relevant lifecycle chapter.

<!-- BEGIN GENERATED REFERENCE -->

## Generated SQL schema reference

The SQL below is the complete exported create-schema text, including checks, keys and indexes. It is schema text, not an export of a user database. The `tasks` interpolation is expanded. Constructors also migrate older databases as described above. Shared `operations` declarations intentionally appear in several owners because the services can share a SQLite connection.

### Task and Execution database

Source: [src/storage/schema.js](../../src/storage/schema.js); source SHA-256: `f8e94182caab54779d0f67b6cacf4bb524949f605d104dee6bde00bbe5750e7a`.

```sql
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
  state TEXT NOT NULL CHECK (state IN ('OPEN', 'BLOCKED', 'RUNNING', 'DONE', 'CLOSED', 'CANCELED', 'WAITING', 'SATISFIED', 'FAILED', 'CANCELLED', 'REJECTED')),
  block_reason TEXT,
  max_depth INTEGER NOT NULL,
  max_children INTEGER NOT NULL,
  max_attempts INTEGER NOT NULL,
  retry_policy_json TEXT NOT NULL,
  root_deadline TEXT,
  cancelled_at TEXT,
  claimable_at TEXT,
  responsibility_key TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((state = 'BLOCKED' AND block_reason IS NOT NULL) OR (state <> 'BLOCKED' AND block_reason IS NULL))
);

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

CREATE TABLE IF NOT EXISTS claim_keys (
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
```

### Context database

Source: [src/storage/context-schema.js](../../src/storage/context-schema.js); source SHA-256: `a44a47931acc2c9f0ec2973a92cb56413d50821c683a916143b5e10832add7e4`.

```sql
CREATE TABLE IF NOT EXISTS operations (
  operation_id TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS materials (
  material_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('assumption', 'fact', 'conjecture', 'experience', 'failure', 'artifact', 'steer', 'check_result')),
  -- Collaboration role is orthogonal to the evidence kind.  Older rows are
  -- migrated to experience, which is the least prescriptive role.
  role TEXT NOT NULL DEFAULT 'experience' CHECK (role IN ('input', 'response', 'handoff', 'experience')),
  mission_id TEXT,
  scope TEXT NOT NULL,
  evidence_state TEXT NOT NULL CHECK (evidence_state IN ('proposed', 'observed', 'checked', 'accepted', 'rejected', 'stale')),
  content_ref TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content_json TEXT NOT NULL,
  version INTEGER NOT NULL,
  source_task TEXT,
  source_execution TEXT,
  provenance_json TEXT NOT NULL,
  supersedes TEXT REFERENCES materials(material_id),
  evidence_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS materials_kind_scope ON materials(kind, scope);
CREATE INDEX IF NOT EXISTS materials_source ON materials(source_task, source_execution);

CREATE TABLE IF NOT EXISTS material_relations (
  relation_id TEXT PRIMARY KEY,
  material_id TEXT NOT NULL REFERENCES materials(material_id),
  replacement_material_id TEXT REFERENCES materials(material_id),
  relation_kind TEXT NOT NULL CHECK (relation_kind IN ('dispute', 'supersede')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  reason TEXT,
  actor_ref TEXT NOT NULL,
  source_task TEXT,
  source_execution TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE(material_id, replacement_material_id, relation_kind, version)
);

CREATE INDEX IF NOT EXISTS material_relations_active
  ON material_relations(material_id, relation_kind, active, created_at);

CREATE TABLE IF NOT EXISTS material_consumptions (
  operation_id TEXT NOT NULL,
  material_id TEXT NOT NULL REFERENCES materials(material_id),
  reader_task TEXT NOT NULL,
  reader_execution TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('route', 'task', 'candidate', 'integration')),
  action_ref TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (operation_id, material_id)
);

CREATE INDEX IF NOT EXISTS material_consumptions_reader
  ON material_consumptions(reader_task, reader_execution, action);
CREATE INDEX IF NOT EXISTS material_consumptions_material
  ON material_consumptions(material_id, action);
```

### Judge database

Source: [src/storage/judge-schema.js](../../src/storage/judge-schema.js); source SHA-256: `32d4c2c1e0a646de4eea5b46cfe1ae78d9714d0ccc19556c35a375429686f44d`.

```sql
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
  candidate_content_hash TEXT,
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
```

### Observation database

Source: [src/observability/observation-store.js](../../src/observability/observation-store.js); source SHA-256: `f5074b99ddcad62fb1a4adb2936c2a74a55fef0d01b337592533937d2ff05fa5`.

```sql
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS experiments (
  experiment_id TEXT PRIMARY KEY,
  root_task_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('CREATED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'FINISHED')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS observation_events (
  event_id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiments(experiment_id),
  sequence INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  core_id TEXT,
  session_id TEXT,
  task_id TEXT,
  execution_id TEXT,
  correlation_id TEXT,
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'operator', 'agent')),
  payload_json TEXT NOT NULL,
  agent_payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (experiment_id, sequence)
);

CREATE INDEX IF NOT EXISTS observation_events_experiment_sequence
  ON observation_events(experiment_id, sequence);
CREATE INDEX IF NOT EXISTS observation_events_execution_sequence
  ON observation_events(execution_id, sequence);
CREATE INDEX IF NOT EXISTS observation_events_kind_sequence
  ON observation_events(kind, sequence);
CREATE INDEX IF NOT EXISTS observation_events_experiment_kind_sequence
  ON observation_events(experiment_id, kind, sequence);
CREATE INDEX IF NOT EXISTS observation_events_experiment_task_sequence
  ON observation_events(experiment_id, task_id, sequence);
CREATE INDEX IF NOT EXISTS observation_events_experiment_execution_sequence
  ON observation_events(experiment_id, execution_id, sequence);
CREATE INDEX IF NOT EXISTS observation_events_experiment_core_sequence
  ON observation_events(experiment_id, core_id, sequence);
```

### Constructor-added schema objects

Fresh Task Service initialization adds the following objects beyond the exported create-schema strings. Source: [src/task/task-service.js](../../src/task/task-service.js); SHA-256: `cf991713b3f508bc3a070c809ad9c63b55ca1477699e68b2ac5af4302f4d91f8`.

#### executions_active_core

```sql
CREATE INDEX executions_active_core ON executions(core_id, state) WHERE core_id IS NOT NULL AND state IN ('CREATED', 'RUNNING');
```

#### tasks_active_responsibility

```sql
CREATE UNIQUE INDEX tasks_active_responsibility
      ON tasks(root_id, responsibility_key)
      WHERE responsibility_key IS NOT NULL AND state NOT IN ('CANCELLED', 'CANCELED', 'REJECTED', 'CLOSED', 'DONE');
```

<!-- END GENERATED REFERENCE -->

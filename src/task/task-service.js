import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ERROR_CODES, SwarmEnvError } from '../errors.js';
import { storedCheckerProcessStatus, storedResultClass } from '../judge/check-result.js';
import { makeEnvelope, operationPayload, stableStringify, validateEnvelope } from '../protocol/envelope.js';
import { SCHEMA_SQL, TASKS_TABLE_DEFINITION } from '../storage/schema.js';
import { ensureJudgeSchema } from '../storage/judge-schema.js';
import {
  TERMINAL_EXECUTION_STATES,
  TERMINAL_TASK_STATES,
  validateTaskProposal,
} from './task-types.js';

const EXECUTION_WRITE_OPERATIONS = new Set(['execution_progress', 'expire_execution', 'fence_execution', 'finish_task', 'heartbeat', 'link_material', 'record_handoff_reminder', 'recover_execution', 'save_checkpoint', 'save_workspace_revision', 'task_feedback']);
const MODERN_OPERATION_ALIASES = Object.freeze({
  'mission.create': 'create_mission',
  'mission.get': 'get_mission',
  'task.create': 'create_task',
  'task.list': 'list_task',
  'task.view': 'view_task',
  mission_create: 'create_mission',
  mission_get: 'get_mission',
  task_create: 'create_task',
  task_list: 'list_task',
  task_view: 'view_task',
  'task.link_material': 'link_material',
  task_link_material: 'link_material',
  'task.materials': 'list_task_materials',
  task_materials: 'list_task_materials',
  'task.finish': 'finish_task',
  task_finish: 'finish_task',
  'task.status': 'task_status',
  task_status: 'task_status',
  'task.take': 'task_take',
  task_take: 'task_take',
  'task.feedback': 'task_feedback',
  task_feedback: 'task_feedback',
  'execution.progress': 'execution_progress',
});
const MODERN_MUTATING_OPERATIONS = new Set(['create_mission', 'create_task', 'link_material', 'finish_task', 'task_feedback']);
const MODERN_READ_OPERATIONS = new Set(['get_mission', 'list_task', 'view_task', 'list_task_materials']);
const TASK_MUTATING_OPERATIONS = new Set([
  'reconcile_task', 'reopen_task',
  'link_material', 'finish_task',
  ...MODERN_MUTATING_OPERATIONS,
  'task_take',
  'execution_progress',
]);
const TASK_EVENT_OPERATIONS = new Set([
  'reconcile_task', 'recover_execution', 'reopen_task',
  'create_task', 'expire_execution',
  'link_material', 'finish_task',
  'task_feedback',
  'execution_progress',
]);
const TASK_READ_OPERATIONS = new Set([
  'get_task', 'get_execution', 'list_tasks', 'list_eligible_tasks', 'list_executions',
  ...MODERN_READ_OPERATIONS,
  'task_status',
]);

const TASK_TABLE_COLUMNS = Object.freeze([
  'task_id', 'root_id', 'parent_id', 'owner_ref', 'task_type', 'task_type_version', 'goal', 'expected_output',
  'priority', 'task_instructions', 'workspace_json', 'acceptance_conditions_json', 'input_material_refs_json',
  'spec_version', 'spec_hash', 'completion_contract_json', 'parallel_quota', 'state_version', 'state', 'block_reason',
  'max_depth', 'max_children', 'max_attempts', 'retry_policy_json', 'root_deadline', 'cancelled_at', 'eligible_at',
  'responsibility_key', 'created_by', 'created_at', 'updated_at',
]);

function json(value) {
  return JSON.stringify(value ?? null);
}

function parse(value) {
  return value === null || value === undefined ? null : JSON.parse(value);
}

function now() {
  return new Date().toISOString();
}

function isCompletedTaskState(state) {
  return state === 'DONE' || state === 'SATISFIED';
}

function taskCompletionState(task) {
  return task?.completion_contract?.normal_flow === true ? 'DONE' : 'SATISFIED';
}

function taskCancellationState(task) {
  return task?.completion_contract?.normal_flow === true ? 'CANCELED' : 'CANCELLED';
}

function hash(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function rowToTask(row) {
  if (!row) return null;
  return {
    ...row,
    acceptance_conditions: parse(row.acceptance_conditions_json),
    input_material_refs: parse(row.input_material_refs_json),
    completion_contract: parse(row.completion_contract_json),
    workspace: parse(row.workspace_json),
    retry_policy: parse(row.retry_policy_json),
    task_instructions: row.task_instructions ?? '',
    eligible_at: row.eligible_at ?? row.created_at ?? null,
  };
}

function rowToExecution(row) {
  if (!row) return null;
  return {
    ...row,
    input_material_refs: parse(row.input_material_refs_json),
    agent_prompt: row.agent_prompt ?? '',
    workspace_manifest_ref: row.workspace_manifest_ref,
    workspace_snapshot_hash: row.input_snapshot_hash,
    workspace_selection: parse(row.workspace_selection_json) ?? {},
    steer_material_refs: parse(row.steer_material_refs_json),
    wait_condition: parse(row.wait_condition_json),
    handoff_metadata: parse(row.handoff_metadata_json),
    terminal_reason: row.terminal_reason ?? null,
    core_id: row.core_id ?? null,
    session_generation: row.session_generation ?? 1,
  };
}

function rowToCheckResult(row) {
  if (!row) return null;
  const resultClass = storedResultClass({ verdict: row.verdict, resultClass: row.result_class, checkerProcessStatus: row.checker_process_status });
  const checkerProcessStatus = storedCheckerProcessStatus({ verdict: row.verdict, resultClass: row.result_class, checkerProcessStatus: row.checker_process_status });
  return {
    ...row,
    result_class: resultClass,
    checker_process_status: checkerProcessStatus,
    process_status: checkerProcessStatus,
    mathematical_outcome: resultClass === 'PASS' ? 'PASS' : resultClass === 'source_failure' ? 'FAIL' : 'unassessed',
    retryable: Boolean(row.retryable),
    evidence: parse(row.evidence_json),
  };
}

function rowToMaterialLink(row, material = null) {
  if (!row) return null;
  return {
    ...row,
    receiving_task_id: row.receiving_task_id || null,
    material,
  };
}

function rowToNotification(row) {
  if (!row) return null;
  return {
    ...row,
    payload: parse(row.payload_json) ?? {},
    delivered: row.delivered_at !== null && row.delivered_at !== undefined,
    handled: row.handled_at !== null && row.handled_at !== undefined,
    handling: parse(row.handling_json) ?? {},
  };
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `${field} is required`);
  }
  return value;
}

function positiveLimit(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'admission limits must be positive integers');
  return value;
}

export class TaskService {
  constructor(database = ':memory:', { contextService = null, checkerHealthReader = null, logger = null, admission = {} } = {}) {
    this.db = database instanceof DatabaseSync ? database : new DatabaseSync(database);
    this.db.exec(SCHEMA_SQL);
    // Notifications gained per-recipient handling state after the initial
    // lifecycle schema.  Keep old persistent stores readable while allowing
    // a shared Mission notification to be delivered and handled independently
    // by each active Execution.
    const notificationColumns = new Set(this.db.prepare('PRAGMA table_info(task_notifications)').all().map((column) => column.name));
    if (!notificationColumns.has('handled_at')) this.db.exec('ALTER TABLE task_notifications ADD COLUMN handled_at TEXT');
    if (!notificationColumns.has('handled_execution_id')) this.db.exec('ALTER TABLE task_notifications ADD COLUMN handled_execution_id TEXT');
    if (!notificationColumns.has('handling_decision')) this.db.exec('ALTER TABLE task_notifications ADD COLUMN handling_decision TEXT');
    if (!notificationColumns.has('handling_action')) this.db.exec('ALTER TABLE task_notifications ADD COLUMN handling_action TEXT');
    if (!notificationColumns.has('handling_json')) this.db.exec("ALTER TABLE task_notifications ADD COLUMN handling_json TEXT NOT NULL DEFAULT '{}'");
    this.db.exec(`CREATE TABLE IF NOT EXISTS task_notification_receipts (
      notification_id TEXT NOT NULL REFERENCES task_notifications(notification_id),
      execution_id TEXT NOT NULL REFERENCES executions(execution_id),
      delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
      delivered_at TEXT,
      handled_at TEXT,
      handling_decision TEXT,
      handling_action TEXT,
      handling_json TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (notification_id, execution_id)
    )`);
    this.db.exec('CREATE INDEX IF NOT EXISTS task_notification_receipts_execution ON task_notification_receipts(execution_id, handled_at, delivered_at)');
    const provenanceColumns = new Set(this.db.prepare('PRAGMA table_info(task_creation_provenance)').all().map((column) => column.name));
    if (!provenanceColumns.has('collaboration_reason_json')) this.db.exec('ALTER TABLE task_creation_provenance ADD COLUMN collaboration_reason_json TEXT');
    const modernTaskColumns = new Set(this.db.prepare('PRAGMA table_info(modern_task_records)').all().map((column) => column.name));
    if (!modernTaskColumns.has('registration_hash')) this.db.exec('ALTER TABLE modern_task_records ADD COLUMN registration_hash TEXT');
    const taskTableSql = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get()?.sql ?? '';
    const needsTaskStateMigration = !taskTableSql.includes("'DONE'") || !taskTableSql.includes("'CLOSED'") || !taskTableSql.includes("'CANCELED'");
    // Older MVP databases made execution_id unique in take_keys. A waiting
    // Execution can now be taken again by a later Agent, so idempotency is
    // keyed by take request rather than by the reusable Execution identity.
    const takeIndexes = this.db.prepare("PRAGMA index_list('take_keys')").all();
    const hasExecutionUnique = takeIndexes.some((index) => {
      if (index.unique !== 1) return false;
      const safeName = String(index.name).replaceAll('"', '""');
      return this.db.prepare(`PRAGMA index_info("${safeName}")`).all().some((column) => column.name === 'execution_id');
    });
    if (hasExecutionUnique) {
      this.db.exec(`
        CREATE TABLE take_keys_migrated (
          request_key TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(task_id),
          fingerprint TEXT NOT NULL,
          execution_id TEXT NOT NULL REFERENCES executions(execution_id),
          created_at TEXT NOT NULL
        );
        INSERT INTO take_keys_migrated SELECT request_key, task_id, fingerprint, execution_id, created_at FROM take_keys;
        DROP TABLE take_keys;
        ALTER TABLE take_keys_migrated RENAME TO take_keys;
      `);
    }
    const taskColumns = new Set(this.db.prepare('PRAGMA table_info(tasks)').all().map((column) => column.name));
    if (!taskColumns.has('priority')) this.db.exec("ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0 CHECK (priority >= 0)");
    if (!taskColumns.has('task_instructions')) {
      if (taskColumns.has('initial_prompt')) this.db.exec('ALTER TABLE tasks RENAME COLUMN initial_prompt TO task_instructions');
      else this.db.exec("ALTER TABLE tasks ADD COLUMN task_instructions TEXT NOT NULL DEFAULT ''");
    }
    if (!taskColumns.has('workspace_json')) this.db.exec("ALTER TABLE tasks ADD COLUMN workspace_json TEXT NOT NULL DEFAULT '{}'");
    if (!taskColumns.has('eligible_at')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN eligible_at TEXT');
      this.db.exec('UPDATE tasks SET eligible_at = created_at WHERE eligible_at IS NULL AND state = \'OPEN\'');
    }
    if (!taskColumns.has('responsibility_key')) this.db.exec('ALTER TABLE tasks ADD COLUMN responsibility_key TEXT');
    if (needsTaskStateMigration) this.#migrateTaskStateConstraint();
    // Create this partial index only after migrations have added the column;
    // older databases must be able to run SCHEMA_SQL before the new field
    // exists.
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS tasks_active_responsibility
      ON tasks(root_id, responsibility_key)
      WHERE responsibility_key IS NOT NULL AND state NOT IN ('CANCELLED', 'CANCELED', 'REJECTED', 'CLOSED', 'DONE')`);
    const executionColumns = new Set(this.db.prepare('PRAGMA table_info(executions)').all().map((column) => column.name));
    if (!executionColumns.has('core_id')) this.db.exec('ALTER TABLE executions ADD COLUMN core_id TEXT');
    if (!executionColumns.has('session_generation')) this.db.exec('ALTER TABLE executions ADD COLUMN session_generation INTEGER NOT NULL DEFAULT 1');
    if (!executionColumns.has('agent_prompt')) {
      if (executionColumns.has('initial_prompt')) this.db.exec('ALTER TABLE executions RENAME COLUMN initial_prompt TO agent_prompt');
      else this.db.exec("ALTER TABLE executions ADD COLUMN agent_prompt TEXT NOT NULL DEFAULT ''");
    }
    if (!executionColumns.has('workspace_manifest_ref')) {
      if (executionColumns.has('initial_context_ref')) this.db.exec('ALTER TABLE executions RENAME COLUMN initial_context_ref TO workspace_manifest_ref');
      else this.db.exec("ALTER TABLE executions ADD COLUMN workspace_manifest_ref TEXT NOT NULL DEFAULT ''");
    }
    if (!executionColumns.has('workspace_selection_json')) this.db.exec("ALTER TABLE executions ADD COLUMN workspace_selection_json TEXT NOT NULL DEFAULT '{}'");
    if (!executionColumns.has('candidate_material_id')) this.db.exec('ALTER TABLE executions ADD COLUMN candidate_material_id TEXT');
    if (!executionColumns.has('started_at')) this.db.exec('ALTER TABLE executions ADD COLUMN started_at TEXT');
    if (!executionColumns.has('handoff_deadline')) this.db.exec('ALTER TABLE executions ADD COLUMN handoff_deadline TEXT');
    if (!executionColumns.has('execution_deadline')) this.db.exec('ALTER TABLE executions ADD COLUMN execution_deadline TEXT');
    if (!executionColumns.has('handoff_reminder_sent_at')) this.db.exec('ALTER TABLE executions ADD COLUMN handoff_reminder_sent_at TEXT');
    if (!executionColumns.has('handoff_metadata_json')) this.db.exec("ALTER TABLE executions ADD COLUMN handoff_metadata_json TEXT");
    if (!executionColumns.has('terminal_reason')) this.db.exec('ALTER TABLE executions ADD COLUMN terminal_reason TEXT');
    // Older persistent MVP stores have a CHECK constraint that predates the
    // semantic HANDED_OFF terminal state.  Rebuild only that table after the
    // additive column migrations; SQLite cannot alter a CHECK constraint in
    // place.  The operation is equivalent to the existing Task state
    // migration and preserves every durable Execution column.
    const executionTableSql = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'executions'").get()?.sql ?? '';
    if (executionTableSql && !executionTableSql.includes("'HANDED_OFF'")) {
      const executionColumnsForMigration = this.db.prepare('PRAGMA table_info(executions)').all().map((column) => column.name);
      const columnList = executionColumnsForMigration.map((column) => `"${column.replaceAll('"', '""')}"`).join(', ');
      const migratedSql = executionTableSql.replace(/^CREATE TABLE executions\b/i, 'CREATE TABLE executions_migrated');
      this.db.exec(`
        PRAGMA foreign_keys = OFF;
        ${migratedSql.replace(/state TEXT NOT NULL CHECK \(state IN \([^)]*\)\)/, "state TEXT NOT NULL CHECK (state IN ('CREATED', 'RUNNING', 'WAITING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED', 'FENCED', 'HANDED_OFF', 'SUPERSEDED'))")};
        INSERT INTO executions_migrated (${columnList}) SELECT ${columnList} FROM executions;
        DROP TABLE executions;
        ALTER TABLE executions_migrated RENAME TO executions;
        PRAGMA foreign_keys = ON;
      `);
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS executions_active_core ON executions(core_id, state) WHERE core_id IS NOT NULL AND state IN ('CREATED', 'RUNNING')");
    const admissionPolicyColumns = new Set(this.db.prepare('PRAGMA table_info(task_admission_policies)').all().map((column) => column.name));
    if (!admissionPolicyColumns.has('require_responsibility_key')) {
      this.db.exec('ALTER TABLE task_admission_policies ADD COLUMN require_responsibility_key INTEGER NOT NULL DEFAULT 0');
    }
    this.db.exec('DROP INDEX IF EXISTS executions_one_active_per_task');
    ensureJudgeSchema(this.db);
    this.#backfillStructureRecords();
    this.contextService = contextService;
    this.checkerHealthReader = null;
    this.setCheckerHealthReader(checkerHealthReader);
    this.logger = logger;
    this.executionStateListeners = new Set();
    this.taskEventListeners = new Set();
    this.notificationListeners = new Set();
    this.admission = this.#normalizeAdmissionPolicy(admission);
  }

  close() {
    this.db.close();
  }

  #migrateTaskStateConstraint() {
    const columns = TASK_TABLE_COLUMNS.join(', ');
    this.db.exec('PRAGMA foreign_keys = OFF');
    try {
      this.db.exec(`
        DROP TABLE IF EXISTS tasks_migrated;
        CREATE TABLE tasks_migrated ${TASKS_TABLE_DEFINITION};
        INSERT INTO tasks_migrated (${columns}) SELECT ${columns} FROM tasks;
        DROP TABLE tasks;
        ALTER TABLE tasks_migrated RENAME TO tasks;
      `);
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON');
    }
  }

  /** Subscribe Runtime instances to durable fencing/release facts. */
  subscribeExecutionState(listener) {
    if (typeof listener !== 'function') throw new TypeError('execution state listener must be a function');
    this.executionStateListeners.add(listener);
    return () => this.executionStateListeners.delete(listener);
  }

  /** Subscribe orchestration loops to committed Task/dependency changes. */
  subscribeTaskEvents(listener) {
    if (typeof listener !== 'function') throw new TypeError('task event listener must be a function');
    this.taskEventListeners.add(listener);
    return () => this.taskEventListeners.delete(listener);
  }

  /** Subscribe Runtime instances to committed lifecycle notifications. */
  subscribeNotifications(listener) {
    if (typeof listener !== 'function') throw new TypeError('notification listener must be a function');
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  #emitNotification(event) {
    for (const listener of this.notificationListeners) {
      try { listener(event); } catch { /* delivery remains durable */ }
    }
  }

  /**
   * Insert a bounded lifecycle notification.  This is intentionally an
   * internal service seam; Agents receive the resulting fact in their prompt
   * or follow-up rather than calling a general send-message operation.
   */
  enqueueNotification({
    deliveryKey,
    missionId,
    recipientTaskId,
    recipientExecutionId = null,
    type,
    materialId = null,
    sourceTaskId = null,
    sourceExecutionId = null,
    payload = {},
  } = {}) {
    requireString(deliveryKey, 'delivery_key');
    requireString(missionId, 'mission_id');
    requireString(recipientTaskId, 'recipient_task_id');
    if (!['handoff_warning', 'material_available', 'task_reopened'].includes(type)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'notification type is unsupported');
    }
    if (recipientExecutionId !== null) requireString(recipientExecutionId, 'recipient_execution_id');
    if (materialId !== null) requireString(materialId, 'material_id');
    if (sourceTaskId !== null) requireString(sourceTaskId, 'source_task_id');
    if (sourceExecutionId !== null) requireString(sourceExecutionId, 'source_execution_id');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'notification payload must be an object');
    }
    if (!this.#getMission(missionId)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown mission: ${missionId}`);
    if (!this.getTask(recipientTaskId)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown recipient Task: ${recipientTaskId}`);
    const createdAt = now();
    const notificationId = randomUUID();
    this.db.prepare(`INSERT OR IGNORE INTO task_notifications
      (notification_id, delivery_key, mission_id, recipient_task_id, recipient_execution_id,
       notification_type, material_id, source_task_id, source_execution_id, payload_json,
       delivery_attempts, created_at, delivered_at, delivered_execution_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL)`).run(
      notificationId, deliveryKey, missionId, recipientTaskId, recipientExecutionId,
      type, materialId, sourceTaskId, sourceExecutionId, json(payload), createdAt,
    );
    const row = this.db.prepare('SELECT * FROM task_notifications WHERE delivery_key = ?').get(deliveryKey);
    const notification = rowToNotification(row);
    // The queue row is inserted inside the caller's mutation transaction in
    // several paths. Defer the active-session signal until the current stack
    // unwinds, after the outer transaction has committed, so a follow-up
    // cannot race a Material/link read against an uncommitted SQLite write.
    if (row?.notification_id === notificationId) queueMicrotask(() => this.#emitNotification(notification));
    return notification;
  }

  listPendingNotifications(taskId, executionId = null) {
    requireString(taskId, 'task_id');
    if (executionId !== null) requireString(executionId, 'execution_id');
    return this.db.prepare(`SELECT * FROM task_notifications
      WHERE recipient_task_id = ? AND delivered_at IS NULL AND handled_at IS NULL
        AND (recipient_execution_id IS NULL OR recipient_execution_id = ?
          OR NOT EXISTS (
            SELECT 1 FROM executions addressed
            WHERE addressed.execution_id = task_notifications.recipient_execution_id
              AND addressed.state IN ('CREATED', 'RUNNING', 'WAITING')
          ))
        AND (notification_type != 'handoff_warning'
          OR recipient_execution_id IS NULL
          OR recipient_execution_id = ?)
      ORDER BY created_at, notification_id`).all(taskId, executionId, executionId).map(rowToNotification);
  }

  /**
   * Return feedback that this particular Execution has not handled yet.
   *
   * `listPendingNotifications` intentionally preserves the old undelivered
   * queue projection.  This per-Execution view is the continuation boundary:
   * a notification may already have been delivered to a fenced predecessor,
   * yet remains available to the successor until that successor records a
   * decision and action.
   */
  listUnprocessedNotifications(taskId, executionId = null) {
    requireString(taskId, 'task_id');
    if (executionId !== null) requireString(executionId, 'execution_id');
    const rows = this.db.prepare(`SELECT n.* FROM task_notifications n
      WHERE n.recipient_task_id = ? AND n.handled_at IS NULL
        AND (n.recipient_execution_id IS NULL OR n.recipient_execution_id = ?
          OR NOT EXISTS (
            SELECT 1 FROM executions addressed
            WHERE addressed.execution_id = n.recipient_execution_id
              AND addressed.state IN ('CREATED', 'RUNNING', 'WAITING')
          ))
        AND (? IS NULL OR NOT EXISTS (
          SELECT 1 FROM task_notification_receipts r
          WHERE r.notification_id = n.notification_id
            AND r.execution_id = ? AND r.handled_at IS NOT NULL
        ))
        AND (n.notification_type != 'handoff_warning'
          OR n.recipient_execution_id IS NULL
          OR n.recipient_execution_id = ?)
      ORDER BY n.created_at, n.notification_id`).all(taskId, executionId, executionId, executionId, executionId);
    return rows.map((row) => {
      const notification = rowToNotification(row);
      if (executionId === null) return notification;
      const receipt = this.db.prepare(`SELECT * FROM task_notification_receipts
        WHERE notification_id = ? AND execution_id = ?`).get(row.notification_id, executionId);
      return {
        ...notification,
        recipient_delivery: receipt ? {
          delivered_at: receipt.delivered_at ?? null,
          delivery_attempts: receipt.delivery_attempts ?? 0,
          handled_at: receipt.handled_at ?? null,
          handling_decision: receipt.handling_decision ?? null,
          handling_action: receipt.handling_action ?? null,
          handling: parse(receipt.handling_json) ?? {},
        } : null,
      };
    });
  }

  /** Return the durable notification projection used by sanitized reports. */
  listNotifications({ missionId = null, recipientTaskId = null } = {}) {
    return this.db.prepare(`SELECT * FROM task_notifications
      WHERE (? IS NULL OR mission_id = ?)
        AND (? IS NULL OR recipient_task_id = ?)
      ORDER BY created_at, notification_id`).all(
      missionId, missionId, recipientTaskId, recipientTaskId,
    ).map(rowToNotification);
  }

  markNotificationDelivered(notificationId, executionId) {
    requireString(notificationId, 'notification_id');
    requireString(executionId, 'execution_id');
    const existing = this.db.prepare('SELECT * FROM task_notifications WHERE notification_id = ?').get(notificationId);
    if (!existing) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown notification: ${notificationId}`);
    if (existing.recipient_execution_id && existing.recipient_execution_id !== executionId) {
      const addressed = this.getExecution(existing.recipient_execution_id);
      if (addressed && ['CREATED', 'RUNNING', 'WAITING'].includes(addressed.state)) {
        throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `notification is addressed to another active Execution: ${existing.recipient_execution_id}`);
      }
    }
    const updatedAt = now();
    this.db.prepare(`INSERT INTO task_notification_receipts
      (notification_id, execution_id, delivery_attempts, delivered_at, handled_at,
       handling_decision, handling_action, handling_json)
      VALUES (?, ?, 1, ?, NULL, NULL, NULL, '{}')
      ON CONFLICT(notification_id, execution_id) DO UPDATE SET
        delivery_attempts = task_notification_receipts.delivery_attempts + 1,
        delivered_at = COALESCE(task_notification_receipts.delivered_at, excluded.delivered_at)`).run(
      notificationId, executionId, updatedAt,
    );
    this.db.prepare(`UPDATE task_notifications
      SET delivered_at = ?, delivered_execution_id = ?, delivery_attempts = delivery_attempts + 1
      WHERE notification_id = ? AND delivered_at IS NULL`).run(updatedAt, executionId, notificationId);
    const row = this.db.prepare('SELECT * FROM task_notifications WHERE notification_id = ?').get(notificationId);
    return rowToNotification(row);
  }

  recordNotificationAttempt(notificationId) {
    requireString(notificationId, 'notification_id');
    this.db.prepare('UPDATE task_notifications SET delivery_attempts = delivery_attempts + 1 WHERE notification_id = ? AND delivered_at IS NULL').run(notificationId);
    return rowToNotification(this.db.prepare('SELECT * FROM task_notifications WHERE notification_id = ?').get(notificationId));
  }

  /** Record the recipient Execution's durable decision and resulting action. */
  markNotificationHandled(notificationId, executionId, { decision, action, details = {} } = {}) {
    requireString(notificationId, 'notification_id');
    requireString(executionId, 'execution_id');
    requireString(decision, 'handling_decision');
    requireString(action, 'handling_action');
    if (!details || typeof details !== 'object' || Array.isArray(details)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'handling details must be an object');
    }
    const existing = this.db.prepare('SELECT * FROM task_notifications WHERE notification_id = ?').get(notificationId);
    if (!existing) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown notification: ${notificationId}`);
    if (existing.recipient_execution_id && existing.recipient_execution_id !== executionId) {
      const addressed = this.getExecution(existing.recipient_execution_id);
      if (addressed && ['CREATED', 'RUNNING', 'WAITING'].includes(addressed.state)) {
        throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `notification is addressed to another active Execution: ${existing.recipient_execution_id}`);
      }
    }
    const handledAt = now();
    this.db.prepare(`INSERT INTO task_notification_receipts
      (notification_id, execution_id, delivery_attempts, delivered_at, handled_at,
       handling_decision, handling_action, handling_json)
      VALUES (?, ?, 1, ?, ?, ?, ?, ?)
      ON CONFLICT(notification_id, execution_id) DO UPDATE SET
        delivered_at = COALESCE(task_notification_receipts.delivered_at, excluded.delivered_at),
        handled_at = excluded.handled_at,
        handling_decision = excluded.handling_decision,
        handling_action = excluded.handling_action,
        handling_json = excluded.handling_json`).run(
      notificationId, executionId, handledAt, handledAt, decision, action, json(details),
    );
    // Specific Execution notifications have one authoritative recipient and
    // retain the legacy row-level projection. Task-level notifications stay
    // open at the row level until each recipient's receipt is handled.
    if (existing.recipient_execution_id === executionId) {
      this.db.prepare(`UPDATE task_notifications SET
        delivered_at = COALESCE(delivered_at, ?), delivered_execution_id = COALESCE(delivered_execution_id, ?),
        handled_at = ?, handled_execution_id = ?, handling_decision = ?, handling_action = ?, handling_json = ?
        WHERE notification_id = ?`).run(
        handledAt, executionId, handledAt, executionId, decision, action, json(details), notificationId,
      );
    }
    const row = this.db.prepare('SELECT * FROM task_notifications WHERE notification_id = ?').get(notificationId);
    return {
      notification: rowToNotification(row),
      receipt: this.db.prepare(`SELECT * FROM task_notification_receipts
        WHERE notification_id = ? AND execution_id = ?`).get(notificationId, executionId),
    };
  }

  /** Wake reconciliation when a dependency-owned service commits a fact. */
  notifyDependencyEvent(event = {}) {
    this.#emitTaskEvent({
      kind: event.kind ?? 'dependency_changed',
      operation: event.operation ?? 'dependency_event',
      task_id: event.task_id ?? null,
      execution_id: event.execution_id ?? null,
      state: event.state ?? null,
      changed: true,
      timestamp: now(),
    });
  }

  #emitTaskEvent(event) {
    for (const listener of this.taskEventListeners) {
      try { listener(event); } catch { /* reconciliation remains authoritative */ }
    }
  }

  #emitExecutionState(event) {
    for (const listener of this.executionStateListeners) {
      try { listener(event); } catch { /* Runtime cleanup must not break the durable transition. */ }
    }
  }

  setCheckerHealthReader(reader) {
    if (reader !== null && typeof reader !== 'function') throw new TypeError('checkerHealthReader must be a function or null');
    this.checkerHealthReader = reader;
    return this;
  }

  #normalizeAdmissionPolicy(policy = {}) {
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'admission policy must be an object');
    }
    const agingThresholdMs = policy.aging_threshold_ms ?? policy.agingThresholdMs ?? 5 * 60 * 1000;
    if (!Number.isFinite(agingThresholdMs) || agingThresholdMs < 0) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'aging_threshold_ms must be a non-negative finite number');
    }
    return {
      max_unfinished_tasks: positiveLimit(policy.max_unfinished_tasks ?? policy.maxUnfinishedTasks, Number.MAX_SAFE_INTEGER),
      max_open_tasks: positiveLimit(policy.max_open_tasks ?? policy.maxOpenTasks, Number.MAX_SAFE_INTEGER),
      max_children_per_execution: positiveLimit(policy.max_children_per_execution ?? policy.maxChildrenPerExecution, Number.MAX_SAFE_INTEGER),
      max_turn_mutations: positiveLimit(policy.max_turn_mutations ?? policy.maxTurnMutations, Number.MAX_SAFE_INTEGER),
      aging_threshold_ms: agingThresholdMs,
      require_responsibility_key: Boolean(policy.require_responsibility_key ?? policy.requireResponsibilityKey ?? false),
    };
  }

  dispatch(operation, payload = {}, envelope) {
    const normalizedOperation = MODERN_OPERATION_ALIASES[operation] ?? operation;
    this.logger?.append({ event: 'dispatch.start', service: 'task', operation: normalizedOperation, requested_operation: operation, envelope });
    try {
      validateEnvelope(envelope, { executionWrite: EXECUTION_WRITE_OPERATIONS.has(normalizedOperation) });
      let result;
      let replayed = false;
      if (TASK_READ_OPERATIONS.has(normalizedOperation)) {
        result = this.#read(normalizedOperation, payload, envelope);
      } else {
        if (!TASK_MUTATING_OPERATIONS.has(normalizedOperation) && !EXECUTION_WRITE_OPERATIONS.has(normalizedOperation)) {
          throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unsupported Task Service operation: ${operation}`);
        }
        result = this.#transaction(() => {
          const fingerprint = operationPayload(normalizedOperation, payload, envelope);
          const replay = this.#replay(envelope.operation_id, fingerprint);
          if (replay) {
            replayed = true;
            return replay;
          }
          const value = this.#mutate(normalizedOperation, payload, envelope);
          this.#saveOperation(envelope.operation_id, normalizedOperation, fingerprint, value);
          return value;
        });
      }
      if (TASK_EVENT_OPERATIONS.has(normalizedOperation) && !replayed && (normalizedOperation !== 'reconcile_task' || result?.changed === true)) {
        this.#emitTaskEvent({
          kind: `task_${normalizedOperation}`,
          operation: normalizedOperation,
          task_id: result?.task?.task_id ?? result?.execution?.task_id ?? payload?.task_id ?? envelope?.task_id ?? null,
          execution_id: result?.execution?.execution_id ?? envelope?.execution_id ?? null,
          state: result?.task?.state ?? result?.execution?.state ?? null,
          changed: result?.changed ?? null,
          timestamp: now(),
        });
      }
      this.logger?.append({ event: 'dispatch.complete', service: 'task', operation: normalizedOperation, ok: true, result });
      return result;
    } catch (error) {
      this.logger?.append({ event: 'dispatch.complete', service: 'task', operation: normalizedOperation, ok: false, error: { name: error.name, code: error.code, message: error.message } });
      throw error;
    }
  }

  getTask(taskId) {
    return this.#decorateModernTask(rowToTask(this.db.prepare(`SELECT t.* FROM tasks t
      JOIN modern_task_records m ON m.task_id = t.task_id WHERE t.task_id = ?`).get(taskId)));
  }

  /** Public Mission lookup for the Issue #100 flat Task surface. */
  getMission(missionId) {
    return this.#getMission(requireString(missionId, 'mission_id'));
  }

  createMission(input, envelope = makeEnvelope({ actorRef: input?.created_by ?? 'unknown' })) {
    return this.dispatch('create_mission', input, envelope);
  }

  createTask(input, envelope = makeEnvelope({ actorRef: input?.created_by ?? 'unknown' })) {
    return this.dispatch('create_task', input, envelope);
  }

  listMissionTasks(filters = {}, envelope = makeEnvelope({ actorRef: 'unknown' })) {
    return this.dispatch('list_task', filters, envelope);
  }

  taskStatus(filters = {}, envelope = makeEnvelope({ actorRef: 'unknown' })) {
    return this.dispatch('task_status', filters, envelope);
  }

  viewModernTask(taskId, envelope = makeEnvelope({ actorRef: 'unknown', taskId })) {
    return this.dispatch('view_task', { task_id: taskId }, envelope);
  }

  linkMaterial(payload, envelope) {
    return this.dispatch('link_material', payload, envelope);
  }

  listTaskMaterials(taskId, envelope = makeEnvelope({ actorRef: 'unknown', taskId })) {
    return this.dispatch('list_task_materials', { task_id: taskId }, envelope);
  }

  /** Take one eligible Task through the canonical Agent seam. */
  takeTask(taskId, payload = {}, envelope = null) {
    const id = requireString(taskId, 'task_id');
    const task = this.getTask(id);
    if (!task) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown task: ${id}`);
    const takeEnvelope = envelope ?? makeEnvelope({
      actorRef: payload.owner_ref ?? 'daemon',
      taskId: id,
      specVersion: task.spec_version,
      stateVersion: task.state_version,
    });
    return this.dispatch('task_take', payload, { ...takeEnvelope, task_id: id,
      execution_id: null,
      spec_version: takeEnvelope.spec_version ?? task.spec_version,
      state_version: takeEnvelope.state_version ?? task.state_version });
  }

  getExecution(executionId) {
    return rowToExecution(this.db.prepare('SELECT * FROM executions WHERE execution_id = ?').get(executionId));
  }

  recordHandoffReminder(payload, envelope) {
    return this.dispatch('record_handoff_reminder', payload, envelope);
  }

  handoffExecution(payload, envelope) {
    return this.dispatch('handoff_execution', payload, envelope);
  }

  getCheckResult(checkResultId) {
    return rowToCheckResult(this.db.prepare('SELECT * FROM check_results WHERE check_result_id = ?').get(checkResultId));
  }

  listTasks({ rootId = null, states = ['OPEN', 'RUNNING', 'WAITING'], taskType = null, limit = 10, availableOnly = true, scanAll = false } = {}) {
    if (rootId !== null && (typeof rootId !== 'string' || rootId.length === 0)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'root_id must be a non-empty string or null');
    }
    if (!Array.isArray(states) || states.length === 0 || states.some((state) => typeof state !== 'string' || state.length === 0)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'states must contain at least one task state');
    }
    if (taskType !== null && (typeof taskType !== 'string' || taskType.length === 0)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'task_type must be a non-empty string or null');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'limit must be an integer between 1 and 100');
    }
    const statePlaceholders = states.map(() => '?').join(', ');
    const conditions = [`t.state IN (${statePlaceholders})`];
    const params = [...states];
    if (rootId !== null) {
      conditions.push('t.root_id = ?');
      params.push(rootId);
    }
    if (taskType !== null) {
      conditions.push('t.task_type = ?');
      params.push(taskType);
    }
    // Claimability needs to inspect the complete OPEN set before applying the
    // fairness floor.  The public list remains bounded; scanAll is an
    // internal read used only by listEligibleTasks.
    params.push(scanAll ? -1 : (availableOnly ? 100 : limit));
    const tasks = this.db.prepare(`SELECT t.* FROM tasks t WHERE ${conditions.join(' AND ')}
      ORDER BY t.priority DESC, t.created_at ASC, t.task_id ASC LIMIT ?`).all(...params).map((row) => ({
      ...this.#decorateModernTask(rowToTask(row)),
      // A fenced or superseded recovery attempt must not hide a still-active
      // resumable Execution from an Agent browsing the queue. The response is
      // the Agent's handoff boundary, so prefer the latest active Execution;
      // fall back to the terminal history only when no active owner remains.
      latest_execution: this.#latestExecution(row.task_id, true) ?? this.#latestExecution(row.task_id),
    }));
    if (!availableOnly) return tasks;
    const nowMs = Date.now();
    return tasks.filter((task) => {
      if (this.#gatingDependencyBlockers(task).length > 0) return false;
      const executions = this.listExecutions(task.task_id, { includeTerminal: false });
      const active = executions.filter((execution) => ['CREATED', 'RUNNING'].includes(execution.state));
      // The shared Mission entry is a collaboration surface: a RUNNING
      // Execution does not make it disappear from the eligible view.  Every
      // independent Task still honours its explicit single-owner quota.
      const sharedMission = this.#isSharedMissionTask(task);
      if (!sharedMission && active.length >= task.parallel_quota && !this.#expiredReworkCanBeClaimed(task, active, nowMs)) return false;
      const waiting = executions.filter((execution) => execution.state === 'WAITING');
      if (sharedMission) return task.state === 'OPEN' || task.state === 'RUNNING';
      if (waiting.length === 0) return true;
      const resumableWaiting = waiting.some((execution) => this.#isWaitingResumable(execution, nowMs));
      return resumableWaiting || active.length + waiting.length < task.parallel_quota;
    }).slice(0, limit);
  }

  /**
   * Return the bounded value-selection view used by a Core Daemon.  This is a
   * read-only projection: it never ranks with an LLM and never takes a Task.
   * Protected older work is placed ahead of younger work once it crosses the
   * configured aging threshold, while priority remains the tie-breaker inside
   * each fairness band.
   */
  listEligibleTasks({ rootId = null, missionId = null, limit = 10, agingThresholdMs = null, nowMs = Date.now() } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'limit must be an integer between 1 and 100');
    }
    if (agingThresholdMs !== null && (!Number.isFinite(agingThresholdMs) || agingThresholdMs < 0)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'aging_threshold_ms must be non-negative');
    }
    if (!Number.isFinite(nowMs)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'now_ms must be finite');
    // A resumable WAITING execution is eligible again once its typed
    // dependency is satisfied. A parent review also turns the existing
    // Execution back into CREATED; that rework responsibility is represented
    // by a RUNNING Task, so admission must include that one bounded case.
    // Unresolved waits and ordinary active executions remain filtered here.
    const tasks = this.listTasks({ rootId: missionId === null ? rootId : null, states: ['OPEN', 'RUNNING', 'WAITING'], limit: 100, availableOnly: false, scanAll: true })
      .filter((task) => missionId === null || task.mission_id === missionId || (task.mission_id === undefined && task.root_id === missionId))
      .filter((task) => {
        if (this.#gatingDependencyBlockers(task).length > 0) return false;
        const executions = this.listExecutions(task.task_id, { includeTerminal: false });
        const active = executions.filter((execution) => ['CREATED', 'RUNNING'].includes(execution.state));
        const waiting = executions.filter((execution) => execution.state === 'WAITING');
        const sharedMission = this.#isSharedMissionTask(task);
        if (sharedMission) return task.state === 'OPEN' || task.state === 'RUNNING';
        const rework = active.length === 1 && active[0].state === 'CREATED' && active[0].instruction_version > 1 && task.parallel_quota === 1;
        if (rework) return true;
        if (active.length >= task.parallel_quota && !this.#expiredReworkCanBeClaimed(task, active, nowMs)) return false;
        if (waiting.length === 0) return active.length < task.parallel_quota;
        return waiting.some((execution) => this.#isWaitingResumable(execution, nowMs)) || active.length + waiting.length < task.parallel_quota;
      });
    return tasks
      .map((task) => {
        const configuredThreshold = agingThresholdMs ?? this.#admissionPolicy(task.root_id).aging_threshold_ms;
        if (!Number.isFinite(configuredThreshold) || configuredThreshold < 0) {
          throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'aging_threshold_ms must be non-negative');
        }
        const eligibleSince = task.eligible_at ?? task.created_at;
        const eligibleMs = Date.parse(eligibleSince ?? '');
        const ageMs = Number.isNaN(eligibleMs) ? 0 : Math.max(0, nowMs - eligibleMs);
        return {
          ...task,
          eligible_since: eligibleSince,
          age_ms: ageMs,
          fairness_protected: ageMs >= configuredThreshold,
        };
      })
      .sort((left, right) => {
        if (left.fairness_protected !== right.fairness_protected) return left.fairness_protected ? -1 : 1;
        const leftSince = Date.parse(left.eligible_since ?? '') || Number.MAX_SAFE_INTEGER;
        const rightSince = Date.parse(right.eligible_since ?? '') || Number.MAX_SAFE_INTEGER;
        // Once the fairness floor is active, age is the protected ordering;
        // priority may decide only among equally old eligible work.
        if (left.fairness_protected && right.fairness_protected && leftSince !== rightSince) return leftSince - rightSince;
        if (left.priority !== right.priority) return right.priority - left.priority;
        if (leftSince !== rightSince) return leftSince - rightSince;
        return left.task_id.localeCompare(right.task_id);
      })
      .slice(0, limit)
      .map((task, index) => ({ ...task, selection_rank: index + 1 }));
  }

  /** Return blocked Tasks for Controller repair sweeps without exposing SQL. */
  listBlockedTasks({ rootId = null, limit = 100, includeOpen = false } = {}) {
    return this.listTasks({ rootId, states: includeOpen ? ['OPEN', 'BLOCKED'] : ['BLOCKED'], limit, availableOnly: false });
  }

  getActiveExecutionForCore(coreId) {
    requireString(coreId, 'core_id');
    return rowToExecution(this.db.prepare("SELECT * FROM executions WHERE core_id = ? AND state IN ('CREATED', 'RUNNING') ORDER BY created_at, execution_id LIMIT 1").get(coreId));
  }

  reconcileTask(taskId, envelope = makeEnvelope({ actorRef: 'controller', taskId })) {
    return this.dispatch('reconcile_task', { task_id: requireString(taskId, 'task_id') }, envelope);
  }

  reopenTask(taskId, envelope = makeEnvelope({ actorRef: 'controller', taskId })) {
    return this.dispatch('reopen_task', { task_id: requireString(taskId, 'task_id') }, envelope);
  }

  /** Canonical Agent-facing Task take. */
  taskTake(taskId, payload = {}, envelope = null) {
    const id = requireString(taskId, 'task_id');
    const task = this.getTask(id);
    if (!task) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown task: ${id}`);
    const takeEnvelope = envelope ?? makeEnvelope({
      actorRef: payload.owner_ref ?? 'agent',
      taskId: id,
      specVersion: task.spec_version,
      stateVersion: task.state_version,
    });
    return this.dispatch('task_take', { ...payload, task_id: id }, {
      ...takeEnvelope,
      task_id: id,
      execution_id: null,
      spec_version: takeEnvelope.spec_version ?? task.spec_version,
      state_version: takeEnvelope.state_version ?? task.state_version,
    });
  }

  listExecutions(taskId, { includeTerminal = true } = {}) {
    requireString(taskId, 'task_id');
    const stateClause = includeTerminal ? '' : "AND state IN ('CREATED', 'RUNNING', 'WAITING')";
    return this.db.prepare(`SELECT * FROM executions WHERE task_id = ? ${stateClause} ORDER BY attempt_no DESC, created_at DESC`)
      .all(taskId).map(rowToExecution);
  }

  listActiveExecutions() {
    return this.db.prepare("SELECT * FROM executions WHERE state IN ('CREATED', 'RUNNING', 'WAITING') ORDER BY created_at, execution_id").all().map(rowToExecution);
  }

  listResumableExecutions({ rootId = null } = {}) {
    const executions = this.db.prepare("SELECT * FROM executions WHERE state = 'WAITING' ORDER BY updated_at, execution_id").all().map(rowToExecution);
    const nowMs = Date.now();
    return executions.filter((execution) => {
      if (rootId !== null && this.getTask(execution.task_id)?.root_id !== rootId) return false;
      return this.#isWaitingResumable(execution, nowMs);
    });
  }

  validateWaitCondition(executionId, { waitCondition, waitDeadline = null } = {}) {
    const execution = this.getExecution(requireString(executionId, 'execution_id'));
    if (!execution) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown execution: ${executionId}`);
    const task = this.getTask(execution.task_id);
    const normalized = this.#validateWaitCondition(execution, task, waitCondition, waitDeadline);
    return { execution, task, wait_condition: normalized.waitCondition, wait_deadline: normalized.waitDeadline };
  }

  isWaitConditionSatisfied(executionId, waitCondition = undefined) {
    const execution = this.getExecution(requireString(executionId, 'execution_id'));
    if (!execution) return false;
    const candidate = waitCondition === undefined ? execution : {
      ...execution,
      wait_condition: waitCondition,
      wait_deadline: waitCondition?.deadline ?? execution.wait_deadline,
    };
    return this.#isWaitingResumable(candidate);
  }

  #getMission(missionId) {
    const row = this.db.prepare('SELECT * FROM missions WHERE mission_id = ?').get(missionId);
    if (!row) return null;
    return {
      mission_id: row.mission_id,
      goal: row.goal,
      acceptance_conditions: parse(row.acceptance_conditions_json) ?? {},
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  #modernRelations(taskId) {
    const rows = this.db.prepare(`SELECT relation_id, mission_id, task_id, relation_kind,
      related_task_id, created_by_task_id, created_by_execution_id, created_by, created_at
      FROM task_relations WHERE task_id = ? ORDER BY created_at, relation_id`).all(taskId);
    return {
      spawned_from: rows.filter((row) => row.relation_kind === 'spawned_from'),
      depends_on: rows.filter((row) => row.relation_kind === 'depends_on'),
    };
  }

  #modernTaskRecord(taskId) {
    return this.db.prepare('SELECT * FROM modern_task_records WHERE task_id = ?').get(taskId);
  }

  isModernTask(taskId) {
    requireString(taskId, 'task_id');
    return Boolean(this.#modernTaskRecord(taskId));
  }

  #taskMaterialLinks(taskId, { role = null, materialId = null } = {}) {
    const rows = this.db.prepare(`SELECT * FROM task_material_links
      WHERE task_id = ?
        AND (? IS NULL OR role = ?)
        AND (? IS NULL OR material_id = ?)
      ORDER BY created_at, link_id`).all(taskId, role, role, materialId, materialId);
    return rows.map((row) => rowToMaterialLink(row, this.contextService?.getMaterial(row.material_id) ?? null));
  }

  /** Context Service asks Task Service for link IDs without reading its table. */
  listTaskMaterialIds(taskId) {
    requireString(taskId, 'task_id');
    return this.db.prepare('SELECT material_id FROM task_material_links WHERE task_id = ? ORDER BY created_at, link_id')
      .all(taskId).map((row) => row.material_id);
  }

  #taskMissionId(taskId) {
    const modern = this.#modernTaskRecord(taskId);
    if (modern) return modern.mission_id;
    const task = rowToTask(this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId));
    return task?.root_id ?? null;
  }

  /**
   * The first flat Task registered for a Mission is its shared Mission
   * responsibility.  Later Tasks are independent responsibilities even when
   * the caller does not provide a spawned_from relation.  Keeping this
   * distinction in the Service makes the admission rule authoritative for
   * every adapter (legacy take, canonical task_take, and Runtime recovery).
   */
  #isSharedMissionTask(taskOrId) {
    // Mission is a shared objective, never a eligible responsibility. Every
    // Task is independently owned and uses the ordinary exclusive Execution
    // contract. The previous first-Task special case allowed multiple
    // concurrent Executions and made an empty Task list impossible to model.
    return false;
  }

  #decorateModernTask(task) {
    if (!task) return null;
    const modern = this.#modernTaskRecord(task.task_id);
    if (!modern) return task;
    return {
      ...task,
      mission_id: modern.mission_id,
      summary: modern.summary,
      timebox_ms: modern.timebox_ms,
      relations: this.#modernRelations(task.task_id),
      materials: this.#taskMaterialLinks(task.task_id),
      blockers: this.#dependencyBlockers(task.task_id),
    };
  }

  #createMission(payload, envelope) {
    if (envelope.task_id !== null || envelope.execution_id !== null) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Mission creation cannot target a Task or Execution');
    }
    const missionId = payload.mission_id ?? randomUUID();
    requireString(missionId, 'mission_id');
    requireString(payload.goal, 'goal');
    if (payload.acceptance_conditions !== undefined && (typeof payload.acceptance_conditions !== 'object' || payload.acceptance_conditions === null)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'acceptance_conditions must be an object or array');
    }
    const createdAt = now();
    const existing = this.#getMission(missionId);
    if (existing) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'mission_id already exists', { mission_id: missionId });
    this.db.prepare(`INSERT INTO missions
      (mission_id, goal, acceptance_conditions_json, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      missionId,
      payload.goal,
      json(payload.acceptance_conditions ?? {}),
      envelope.actor_ref,
      createdAt,
      createdAt,
    );
    return { mission: this.#getMission(missionId) };
  }

  #assertModernTaskInput(payload) {
    requireString(payload.mission_id, 'mission_id');
    requireString(payload.summary, 'summary');
    requireString(payload.expected_output, 'expected_output');
    if (payload.acceptance_conditions === undefined || payload.acceptance_conditions === null ||
      (typeof payload.acceptance_conditions !== 'object' && !Array.isArray(payload.acceptance_conditions))) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'acceptance_conditions must be an object or array');
    }
    if (payload.summary.trim().length < 20) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'summary must describe a substantial question and boundary');
    }
    if ((Array.isArray(payload.acceptance_conditions) && payload.acceptance_conditions.length === 0) ||
      (!Array.isArray(payload.acceptance_conditions) && Object.keys(payload.acceptance_conditions).length === 0)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'acceptance_conditions must contain at least one condition');
    }
    if (payload.summary.length > 4_000) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'summary must be at most 4000 characters');
    const timebox = payload.timebox_ms ?? payload.timeboxMs ?? 60 * 60 * 1000;
    if (!Number.isInteger(timebox) || timebox <= 0) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'timebox_ms must be a positive integer');
    const responsibilityKey = payload.responsibility_key ?? payload.responsibilityKey ?? null;
    if (responsibilityKey !== null && (typeof responsibilityKey !== 'string' || responsibilityKey.length === 0 || responsibilityKey.length > 256)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_TASK_CONTRACT, 'responsibility_key must be a non-empty string of at most 256 characters');
    }
    return { timebox_ms: timebox };
  }

  #assertModernDependencyCycle(taskId, prerequisiteTaskId) {
    if (taskId === prerequisiteTaskId) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'depends_on cannot point to the same Task');
    const seen = new Set();
    const visit = (candidate) => {
      if (candidate === taskId) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'depends_on would create a cycle');
      if (seen.has(candidate)) return;
      seen.add(candidate);
      const rows = this.db.prepare(`SELECT related_task_id FROM task_relations
        WHERE task_id = ? AND relation_kind = 'depends_on'`).all(candidate);
      for (const row of rows) visit(row.related_task_id);
    };
    visit(prerequisiteTaskId);
  }

  #modernDependencySatisfied(row) {
    const task = this.getTask(row.related_task_id);
    return task?.state === 'DONE' || task?.state === 'CLOSED';
  }

  #modernDependencyBlockers(taskId) {
    return this.db.prepare(`SELECT relation_id, mission_id, task_id, relation_kind,
      related_task_id, created_by_task_id, created_by_execution_id, created_by, created_at
      FROM task_relations WHERE task_id = ? AND relation_kind = 'depends_on'
      ORDER BY created_at, relation_id`).all(taskId)
      .filter((row) => !this.#modernDependencySatisfied(row))
      .map((row) => ({
        dependency_id: row.relation_id,
        dependency_kind: 'TASK',
        prerequisite_task_id: row.related_task_id,
        relation_id: row.relation_id,
      }));
  }

  #createModernTask(payload, envelope) {
    const { timebox_ms: timeboxMs } = this.#assertModernTaskInput(payload);
    const missionId = payload.mission_id;
    const mission = this.#getMission(missionId);
    if (!mission) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown mission: ${missionId}`);
    let currentExecution = null;
    if (envelope.execution_id !== null && envelope.execution_id !== undefined) {
      currentExecution = this.#executionForWrite(envelope);
      if (currentExecution.task_id !== envelope.task_id) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'bound Task creation must use the current Task Execution');
      if (!['CREATED', 'RUNNING'].includes(currentExecution.state)) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'only an active Execution may create a Task');
      if (this.#taskMissionId(envelope.task_id) !== missionId) {
        throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'a bound Agent may create Tasks only in its current Mission', {
          current_mission_id: this.#taskMissionId(envelope.task_id),
          requested_mission_id: missionId,
        });
      }
    }
    const taskId = payload.task_id ?? randomUUID();
    requireString(taskId, 'task_id');
    if (this.getTask(taskId)) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'task_id already exists', { task_id: taskId });
    const responsibilityKey = payload.responsibility_key ?? payload.responsibilityKey ?? null;
    const spawnedFrom = payload.spawned_from ?? payload.spawnedFrom ?? null;
    if (spawnedFrom !== null) {
      requireString(spawnedFrom, 'spawned_from');
      if (!this.getTask(spawnedFrom) || this.#taskMissionId(spawnedFrom) !== missionId) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'spawned_from must identify a Task in the same Mission');
      }
    }
    const dependsOn = payload.depends_on ?? payload.dependsOn ?? [];
    if (!Array.isArray(dependsOn) || dependsOn.some((id) => typeof id !== 'string' || id.length === 0)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'depends_on must contain Task IDs');
    }
    const uniqueDependsOn = [...new Set(dependsOn)];
    for (const prerequisiteId of uniqueDependsOn) {
      if (!this.getTask(prerequisiteId) || this.#taskMissionId(prerequisiteId) !== missionId) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'depends_on must identify Tasks in the same Mission');
      }
      this.#assertModernDependencyCycle(taskId, prerequisiteId);
    }
    const createdAt = now();
    const taskType = payload.task_type ?? payload.taskType ?? 'task';
    const taskTypeVersion = payload.task_type_version ?? '1.0';
    const ownerRef = payload.owner_ref ?? envelope.actor_ref;
    requireString(ownerRef, 'owner_ref');
    const priority = payload.priority ?? 0;
    if (!Number.isInteger(priority) || priority < 0) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'priority must be a non-negative integer');
    const completionContract = { ...(payload.completion_contract ?? {}) };
    if (!completionContract || typeof completionContract !== 'object' || Array.isArray(completionContract)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'completion_contract must be an object');
    }
    const requiredCapabilities = payload.required_capabilities ?? payload.requiredCapabilities ??
      payload.capability_requirements ?? payload.capabilityRequirements;
    if (requiredCapabilities !== undefined) {
      if (!Array.isArray(requiredCapabilities) || requiredCapabilities.some((value) => typeof value !== 'string' || value.length === 0)) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_TASK_CONTRACT, 'required_capabilities must contain non-empty capability IDs');
      }
      completionContract.required_capabilities = [...new Set(requiredCapabilities)];
    }
    const retiredContractFields = ['required_children', 'required_branch_groups', 'required_subtask_groups', 'parent_review', 'required_artifact'];
    const retiredContractField = retiredContractFields.find((field) => Object.hasOwn(completionContract, field));
    if (retiredContractField) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `${retiredContractField} is retired from the Mission Task contract`);
    }
    const spec = {
      task_id: taskId, mission_id: missionId, summary: payload.summary, task_type: taskType,
      task_type_version: taskTypeVersion, goal: payload.goal ?? payload.summary, expected_output: payload.expected_output,
      acceptance_conditions: payload.acceptance_conditions, completion_contract: completionContract,
      timebox_ms: timeboxMs, owner_ref: ownerRef, priority, responsibility_key: responsibilityKey,
      collaboration_reason: payload.collaboration_reason ?? payload.collaborationReason ?? null,
    };
    if (responsibilityKey !== null) {
      const existing = this.db.prepare(`SELECT t.task_id, t.spec_hash, m.registration_hash FROM tasks t
        JOIN modern_task_records m ON m.task_id = t.task_id
        WHERE m.mission_id = ? AND t.responsibility_key = ?
        ORDER BY t.created_at, t.task_id LIMIT 1`).get(missionId, responsibilityKey);
      if (existing) {
        const requestedHash = hash({ ...spec, task_id: null });
        if (existing.registration_hash && existing.registration_hash !== requestedHash) {
          throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'responsibility_key already identifies different Task content', {
            mission_id: missionId,
            responsibility_key: responsibilityKey,
            existing_task_id: existing.task_id,
          });
        }
        return {
          task: this.getTask(existing.task_id),
          created: false,
          deduplicated: true,
          responsibility_key: responsibilityKey,
          created_from_execution_id: currentExecution?.execution_id ?? null,
        };
      }
    }
    this.db.prepare(`INSERT INTO tasks (
      task_id, root_id, parent_id, owner_ref, task_type, task_type_version, goal, expected_output,
      priority, task_instructions, workspace_json, acceptance_conditions_json, input_material_refs_json,
      spec_version, spec_hash, completion_contract_json, parallel_quota, state_version, state,
      block_reason, max_depth, max_children, max_attempts, retry_policy_json, root_deadline,
      cancelled_at, eligible_at, created_by, created_at, updated_at
    ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 'OPEN', NULL, 0, 0, 1, '{}', NULL, NULL, ?, ?, ?, ?)`)
      .run(taskId, taskId, ownerRef, taskType, taskTypeVersion, payload.goal ?? payload.summary, payload.expected_output,
      priority, payload.task_instructions ?? '', json(payload.workspace ?? {}), json(payload.acceptance_conditions),
        json(payload.input_material_refs ?? []), 1, hash(spec), json(completionContract), createdAt, envelope.actor_ref, createdAt, createdAt);
    this.db.prepare(`INSERT INTO modern_task_records
      (task_id, mission_id, summary, timebox_ms, registration_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(taskId, missionId, payload.summary, timeboxMs, hash({ ...spec, task_id: null }), createdAt, createdAt);
    this.db.prepare('UPDATE tasks SET responsibility_key = ? WHERE task_id = ?').run(responsibilityKey, taskId);
    const relationStatement = this.db.prepare(`INSERT INTO task_relations
      (relation_id, mission_id, task_id, relation_kind, related_task_id,
       created_by_task_id, created_by_execution_id, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    if (spawnedFrom !== null) relationStatement.run(randomUUID(), missionId, taskId, 'spawned_from', spawnedFrom, envelope.task_id ?? null, envelope.execution_id ?? null, envelope.actor_ref, createdAt);
    for (const prerequisiteId of uniqueDependsOn) relationStatement.run(randomUUID(), missionId, taskId, 'depends_on', prerequisiteId, envelope.task_id ?? null, envelope.execution_id ?? null, envelope.actor_ref, createdAt);
    this.#recordCreationProvenance({
      taskId,
      creatorTaskId: envelope.task_id ?? null,
      creatorExecutionId: envelope.execution_id ?? null,
      creatorActorRef: envelope.actor_ref,
      creationKind: spawnedFrom === null ? 'ROOT' : 'CHILD',
      collaborationReason: payload.collaboration_reason ?? payload.collaborationReason ?? null,
      createdAt,
    });
    return {
      task: this.#decorateModernTask(rowToTask(this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId))),
      created_from_execution_id: currentExecution?.execution_id ?? null,
    };
  }

  #listModernTasks(payload = {}) {
    const missionId = payload.mission_id ?? payload.missionId ?? null;
    if (missionId !== null) requireString(missionId, 'mission_id');
    const states = payload.states ?? (payload.state ? [payload.state] : ['OPEN', 'BLOCKED', 'RUNNING', 'DONE', 'CLOSED', 'CANCELED']);
    if (!Array.isArray(states) || states.length === 0 || states.some((state) => typeof state !== 'string' || state.length === 0)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'states must contain at least one Task state');
    }
    const limit = payload.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'limit must be between 1 and 500');
    const search = payload.search ?? payload.query ?? null;
    if (search !== null && (typeof search !== 'string' || search.length === 0)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'search must be a non-empty string or null');
    const placeholders = states.map(() => '?').join(', ');
    const where = [`t.state IN (${placeholders})`];
    const params = [...states];
    if (missionId !== null) { where.push('m.mission_id = ?'); params.push(missionId); }
    if (search !== null) { where.push('(m.summary LIKE ? OR t.goal LIKE ? OR t.expected_output LIKE ?)'); params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
    // Apply the page after availability filtering. Limiting the SQL rows
    // first can hide later eligible Tasks behind blocked or occupied rows and
    // make a bounded page look like an empty/complete queue.
    const availableOnly = payload.available_only ?? payload.availableOnly ?? false;
    const queryLimit = availableOnly ? -1 : limit;
    const rows = this.db.prepare(`SELECT t.* FROM tasks t JOIN modern_task_records m ON m.task_id = t.task_id
      WHERE ${where.join(' AND ')} ORDER BY t.priority DESC, t.created_at, t.task_id LIMIT ?`).all(...params, queryLimit);
    const filtered = rows.map((row) => this.#decorateModernTask(rowToTask(row))).filter((task) => {
      if (!availableOnly) return true;
      const sharedMission = this.#isSharedMissionTask(task);
      if (task.state !== 'OPEN' && !(task.state === 'RUNNING' && sharedMission)) return false;
      return sharedMission || this.#modernDependencyBlockers(task.task_id).length === 0;
    });
    return filtered.slice(0, limit);
  }

  #viewModernTask(taskId) {
    const task = this.#decorateModernTask(rowToTask(this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId)));
    if (!task?.mission_id) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown modern Task: ${taskId}`);
    return { task, mission: this.#getMission(task.mission_id), relations: task.relations, blockers: task.blockers, materials: task.materials };
  }

  #linkMaterial(payload, envelope) {
    const materialId = requireString(payload.material_id ?? payload.materialId, 'material_id');
    if (!this.contextService) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Context Service is required for Task Material links');
    const material = this.contextService.getMaterial(materialId);
    if (!material) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown Material: ${materialId}`);
    const role = payload.role ?? material.role ?? 'experience';
    if (!['input', 'response', 'handoff', 'experience'].includes(role)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'role must be input, response, handoff, or experience');
    }
    // Material.role describes the producer's declared publication context.
    // A receiving Task's link role describes how that immutable Material is
    // used here; reuse and correction must not rewrite or be blocked by the
    // producer-wide label.
    const producerTaskId = requireString(material.source_task, 'material source_task');
    const producerExecutionId = requireString(material.source_execution, 'material source_execution');
    const currentTaskId = envelope.task_id;
    const producerIsCurrent = currentTaskId === producerTaskId;
    const producerExecution = producerIsCurrent ? this.#executionForWrite(envelope) : null;
    if (producerExecution && (producerExecution.task_id !== producerTaskId || producerExecution.execution_id !== producerExecutionId)) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Material provenance does not match the current Execution');
    }
    // A producer creates directed Response/Handoff links. Any bound Task may
    // attach already-published Experience or input Material to its own local
    // Materials area; the immutable producer provenance remains unchanged.
    if (!producerIsCurrent && !['input', 'experience'].includes(role)) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'only the producing Task Execution may create a Response or Handoff link');
    }
    const targetTaskId = payload.task_id ?? payload.receiving_task_id ??
      (role === 'handoff' ? producerTaskId : ['input', 'experience'].includes(role) ? currentTaskId : null);
    const targetTask = this.getTask(requireString(targetTaskId, 'task_id'));
    if (!targetTask) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown receiving Task: ${targetTaskId}`);
    if (this.#taskMissionId(targetTaskId) !== this.#taskMissionId(producerTaskId)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'linked Tasks must belong to the same Mission');
    }
    const receivingTaskId = role === 'response'
      ? requireString(payload.receiving_task_id ?? payload.task_id, 'receiving_task_id')
      : role === 'experience' && payload.receiving_task_id
        ? requireString(payload.receiving_task_id, 'receiving_task_id')
        : null;
    if (role === 'response' && receivingTaskId === producerTaskId) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Response Material must target a receiving Task');
    }
    if (role === 'input' && targetTaskId !== currentTaskId) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'input Material links must target the current Task');
    }
    if (role === 'experience' && targetTaskId !== currentTaskId && !payload.receiving_task_id) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'cross-Task Experience links require receiving_task_id');
    }
    if (receivingTaskId && receivingTaskId !== targetTaskId) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'receiving_task_id must match task_id');
    }
    const existing = this.db.prepare(`SELECT * FROM task_material_links
      WHERE task_id = ? AND material_id = ? AND role = ?
        AND ((? IS NULL AND receiving_task_id IS NULL) OR receiving_task_id = ?)`).get(
      targetTaskId, materialId, role, receivingTaskId, receivingTaskId,
    );
    if (existing) return { link: rowToMaterialLink(existing, material) };
    const linkId = payload.link_id ?? randomUUID();
    requireString(linkId, 'link_id');
    const createdAt = now();
    this.db.prepare(`INSERT INTO task_material_links
      (link_id, task_id, material_id, role, receiving_task_id, producer_task_id,
       producer_execution_id, created_by_task_id, created_by_execution_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      linkId, targetTaskId, materialId, role, receivingTaskId, producerTaskId,
      producerExecutionId, envelope.task_id, envelope.execution_id, createdAt,
    );
    const link = rowToMaterialLink(this.db.prepare('SELECT * FROM task_material_links WHERE link_id = ?').get(linkId), material);
    if (['response', 'experience'].includes(role) && receivingTaskId) {
      const recipientExecution = this.db.prepare(`SELECT execution_id FROM executions
        WHERE task_id = ? AND state IN ('CREATED', 'RUNNING')
        ORDER BY attempt_no DESC, created_at DESC LIMIT 1`).get(targetTaskId);
      const missionId = this.#taskMissionId(targetTaskId);
      // Legacy Tasks use root_id as their scope but do not have a Mission
      // record. Notifications are a Mission-scoped Issue #100 capability;
      // keep the legacy material-link path usable without inventing a
      // notification addressed to a non-existent Mission.
      if (missionId && this.#getMission(missionId)) {
        this.enqueueNotification({
          deliveryKey: `material_available:${linkId}`,
          missionId,
          recipientTaskId: targetTaskId,
          recipientExecutionId: recipientExecution?.execution_id ?? null,
          type: 'material_available',
          materialId,
          sourceTaskId: producerTaskId,
          sourceExecutionId: producerExecutionId,
          payload: {
            material_id: materialId,
            producer_task_id: producerTaskId,
            producer_execution_id: producerExecutionId,
            receiving_task_id: targetTaskId,
            action: 'inspect_material_and_record_task_feedback',
          },
        });
      }
    }
    return { link };
  }

  #completeTask(payload, envelope) {
    const execution = this.#executionForWrite(envelope);
    if (execution.owner_ref !== envelope.actor_ref) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'only the current Task Execution owner may complete the Task');
    }
    if (!['CREATED', 'RUNNING'].includes(execution.state)) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `cannot complete Execution in ${execution.state}`);
    }
    const task = this.getTask(execution.task_id);
    const requestedMaterialIds = payload.material_ids ?? payload.materialIds ?? [];
    if (!Array.isArray(requestedMaterialIds) || requestedMaterialIds.some((id) => typeof id !== 'string' || id.length === 0)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'material_ids must be an array of Material IDs');
    }
    const linked = this.#taskMaterialLinks(task.task_id);
    const producedResponseLinks = this.db.prepare(`SELECT * FROM task_material_links
      WHERE producer_task_id = ? AND role = 'response'
      ORDER BY created_at, link_id`).all(task.task_id)
      .map((row) => rowToMaterialLink(row, this.contextService?.getMaterial(row.material_id) ?? null));
    const completionLinks = [...linked, ...producedResponseLinks].filter((link, index, links) =>
      links.findIndex((candidate) => candidate.link_id === link.link_id) === index);
    const linkedIds = new Set(completionLinks.map((link) => link.material_id));
    const unlinked = [...new Set(requestedMaterialIds)].filter((id) => !linkedIds.has(id));
    if (unlinked.length > 0) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'task.complete can reference only linked Materials', { unlinked_material_ids: unlinked });
    }
    const requestedCheckResultId = payload.check_result_id ?? null;
    if (requestedCheckResultId) {
      const requestedCheck = this.getCheckResult(requestedCheckResultId);
      if (!requestedCheck) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown CheckResult: ${requestedCheckResultId}`);
      if (requestedCheck.execution_id !== execution.execution_id || requestedCheck.target_task_id !== task.task_id) {
        throw new SwarmEnvError(ERROR_CODES.FENCED, 'CheckResult does not belong to the current Task Execution');
      }
      if (requestedCheck.status === 'RECEIVED') {
        this.db.prepare("UPDATE check_results SET status = 'APPLIED', applied_task_state_version = ?, applied_at = ?, updated_at = ? WHERE check_result_id = ?")
          .run(task.state_version + 1, now(), now(), requestedCheckResultId);
      }
    }
    const completion = this.#completion(task, execution, requestedCheckResultId);
    if (!completion.satisfied) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'completion_contract is not satisfied', { missing: completion.missing });
    }
    // The shared Mission entry is a collaboration surface, not an ordinary
    // subtask.  A local material/check must never let a research branch close
    // the Mission unless it explicitly carries the complete-candidate
    // contract and satisfies the Mission's own acceptance conditions.
    if (this.#isSharedMissionTask(task)) {
      const mission = this.#getMission(task.mission_id);
      const missionCompletion = this.#missionCompletion(mission, task, execution, payload.check_result_id ?? null);
      if (!missionCompletion.satisfied) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Mission acceptance conditions are not satisfied', { missing: missionCompletion.missing });
      }
    }
    const updatedAt = now();
    this.db.prepare(`UPDATE executions
      SET state = 'SUCCEEDED', wait_condition_json = NULL, wait_deadline = NULL,
          resume_token = NULL, state_version = state_version + 1, updated_at = ?
      WHERE execution_id = ?`).run(updatedAt, execution.execution_id);
    this.db.prepare(`UPDATE tasks
      SET state = 'DONE', state_version = state_version + 1, block_reason = NULL,
          eligible_at = NULL, updated_at = ? WHERE task_id = ?`).run(updatedAt, task.task_id);
    return { task: this.getTask(task.task_id), execution: this.getExecution(execution.execution_id), materials: completionLinks };
  }

  #closeTask(payload, envelope) {
    const receivingTaskId = envelope.task_id;
    const producerTaskId = requireString(payload.producer_task_id ?? payload.producerTaskId, 'producer_task_id');
    const materialId = requireString(payload.material_id ?? payload.materialId, 'material_id');
    if (producerTaskId === receivingTaskId) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'a producer Task cannot close itself');
    }
    const acceptingExecution = this.#executionForWrite(envelope);
    if (acceptingExecution.owner_ref !== envelope.actor_ref) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'only the receiving Task Execution owner may close a producer Task');
    }
    const producer = this.getTask(producerTaskId);
    if (!producer) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown producer Task: ${producerTaskId}`);
    const link = this.db.prepare(`SELECT * FROM task_material_links
      WHERE task_id = ? AND material_id = ? AND role = 'response' AND receiving_task_id = ?`).get(receivingTaskId, materialId, receivingTaskId);
    if (!link || link.producer_task_id !== producerTaskId) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'producer Task must have a linked Response Material for this receiving Task');
    }
    if (producer.state === 'CLOSED') {
      return { task: producer, producer_task_id: producerTaskId, material_id: materialId, accepting_task_id: receivingTaskId, link: rowToMaterialLink(link, this.contextService?.getMaterial(materialId) ?? null) };
    }
    if (producer.state !== 'DONE') {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'only a DONE producer Task can be closed by a receiving Task');
    }
    const acceptedAt = now();
    this.db.prepare(`UPDATE task_material_links
      SET accepted_at = ?, accepted_by_task_id = ?, accepted_by_execution_id = ?
      WHERE link_id = ?`).run(acceptedAt, receivingTaskId, acceptingExecution.execution_id, link.link_id);
    this.db.prepare(`UPDATE tasks
      SET state = 'CLOSED', state_version = state_version + 1, block_reason = NULL,
          eligible_at = NULL, updated_at = ? WHERE task_id = ?`).run(acceptedAt, producerTaskId);
    const acceptedLink = this.db.prepare('SELECT * FROM task_material_links WHERE link_id = ?').get(link.link_id);
    return {
      task: this.getTask(producerTaskId),
      producer_task_id: producerTaskId,
      material_id: materialId,
      accepting_task_id: receivingTaskId,
      accepting_execution_id: acceptingExecution.execution_id,
      link: rowToMaterialLink(acceptedLink, this.contextService?.getMaterial(materialId) ?? null),
    };
  }

  #assertHandoffMaterial(execution, payload) {
    const materialId = requireString(payload.handoff_material_id ?? payload.handoffMaterialId, 'handoff_material_id');
    if (!this.contextService) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Context Service is required for Task handoff');
    const material = this.contextService.getMaterial(materialId);
    if (!material) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown Handoff Material: ${materialId}`);
    if (material.role !== 'handoff') throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'handoff_material_id must reference Handoff Material');
    if (material.source_task !== execution.task_id || material.source_execution !== execution.execution_id) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Handoff Material provenance does not match the current Execution');
    }
    let link = this.db.prepare(`SELECT * FROM task_material_links
      WHERE task_id = ? AND material_id = ? AND role = 'handoff'
        AND producer_task_id = ? AND producer_execution_id = ?`).get(
      execution.task_id, materialId, execution.task_id, execution.execution_id,
    );
    // Context publication and the semantic terminal transition are separate
    // service calls.  Make the second call self-contained: if the Agent did
    // not issue an explicit task.link_material first, validate provenance and
    // create the Task link in this transaction before recording the handoff.
    if (!link) {
      const linked = this.#linkMaterial({
        task_id: execution.task_id,
        material_id: materialId,
        role: 'handoff',
      }, {
        ...makeEnvelope({
          operationId: `handoff-link:${execution.execution_id}:${materialId}`,
          actorRef: execution.owner_ref,
          taskId: execution.task_id,
          executionId: execution.execution_id,
          specVersion: execution.spec_version,
          stateVersion: execution.state_version,
          fencingVersion: execution.fencing_version,
        }),
      });
      link = linked.link;
    } else {
      link = rowToMaterialLink(link, material);
    }
    return { material, link };
  }

  #handoffTask(payload, envelope) {
    const execution = this.#executionForWrite(envelope);
    if (execution.owner_ref !== envelope.actor_ref) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'only the current Task Execution owner may hand off the Task');
    }
    if (!['CREATED', 'RUNNING'].includes(execution.state)) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `cannot hand off Execution from ${execution.state}`);
    }
    const { material, link } = this.#assertHandoffMaterial(execution, payload);
    const updatedAt = now();
    const metadata = {
      ...(payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata) ? payload.metadata : {}),
      handoff_material_id: material.material_id,
      kind: 'voluntary_handoff',
    };
    this.db.prepare(`UPDATE executions SET state = 'HANDED_OFF', fencing_version = fencing_version + 1,
      terminal_reason = ?, handoff_metadata_json = ?, wait_condition_json = NULL,
      wait_deadline = NULL, resume_token = NULL, state_version = state_version + 1,
      updated_at = ? WHERE execution_id = ?`).run(
      payload.reason ?? 'voluntary_handoff', json(metadata), updatedAt, execution.execution_id,
    );
    const task = this.getTask(execution.task_id);
    if (this.#isSharedMissionTask(task)) {
      // A shared Mission has one logical Task and many independent
      // Executions.  Releasing one branch must not make siblings stale or
      // hide their active work; refreshTaskState derives RUNNING/OPEN from
      // the remaining durable Executions.
      this.#refreshTaskState(execution.task_id, { updatedAt });
    } else {
      this.db.prepare(`UPDATE tasks SET state = 'OPEN', block_reason = NULL,
        eligible_at = ?, state_version = state_version + 1, updated_at = ?
        WHERE task_id = ? AND state NOT IN ('DONE', 'CLOSED', 'CANCELED')`).run(updatedAt, updatedAt, execution.task_id);
    }
    return {
      task: this.getTask(execution.task_id),
      execution: this.getExecution(execution.execution_id),
      handoff: { material, link },
      disposition: 'handed_off',
    };
  }

  #blockTaskSemantic(payload, envelope) {
    const execution = this.#executionForWrite(envelope);
    if (execution.owner_ref !== envelope.actor_ref) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'only the current Task Execution owner may block the Task');
    }
    if (!['CREATED', 'RUNNING'].includes(execution.state)) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `cannot block Execution from ${execution.state}`);
    }
    const { material, link } = this.#assertHandoffMaterial(execution, payload);
    const blocker = payload.blocker ?? payload.reason;
    if (!blocker || (typeof blocker !== 'object' && typeof blocker !== 'string')) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'blocker is required');
    }
    const dependency = payload.dependency;
    if (!dependency || typeof dependency !== 'object' || Array.isArray(dependency)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'task.block requires a typed Task dependency');
    }
    const dependencyKind = String(dependency.dependency_kind ?? dependency.dependencyKind ?? dependency.kind ?? 'TASK').toUpperCase();
    if (['CAPABILITY', 'EXTERNAL_CAPABILITY', 'EXTERNAL'].includes(dependencyKind)) {
      const capabilityId = dependency.capability_id ?? dependency.capabilityId ?? dependency.required_capability ?? null;
      if (typeof capabilityId !== 'string' || capabilityId.length === 0) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'capability blockers require dependency.capability_id');
      }
      const normalizedDependency = {
        dependency_kind: 'CAPABILITY',
        capability_id: capabilityId,
        scope: dependency.scope ?? null,
        retryable: dependency.retryable !== false,
        recovery_condition: dependency.recovery_condition ?? dependency.recoveryCondition ?? dependency.resolution ?? 'explicit_reopen',
      };
      const blocked = this.#blockTask({
        block_reason: typeof blocker === 'string' ? blocker : (blocker.reason ?? blocker.kind ?? `capability:${capabilityId}`),
        external_dependency: normalizedDependency,
        terminal_state: 'HANDED_OFF',
        terminal_reason: typeof blocker === 'string' ? blocker : (blocker.reason ?? 'capability_blocked'),
        handoff_metadata: { handoff_material_id: material.material_id, blocker, dependency: normalizedDependency },
      }, envelope);
      return { ...blocked, dependency: normalizedDependency, handoff: { material, link }, disposition: 'blocked' };
    }
    if (dependencyKind !== 'TASK') {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT,
        'task.block requires a TASK dependency or a capability dependency with capability_id', {
          dependency_kind: dependencyKind,
          action: 'use_dependency_kind_TASK_or_CAPABILITY',
          retryable: false,
        });
    }
    const prerequisiteTaskId = dependency.prerequisite_task_id ?? dependency.prerequisiteTaskId ?? dependency.task_id ?? dependency.taskId;
    if (typeof prerequisiteTaskId !== 'string' || prerequisiteTaskId.length === 0) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Task block requires a prerequisite Task ID');
    }
    const prerequisite = this.getTask(prerequisiteTaskId);
    if (!prerequisite || this.#taskMissionId(prerequisiteTaskId) !== this.#taskMissionId(execution.task_id)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'block dependency must identify a Task in the same Mission');
    }
    this.#assertModernDependencyCycle(execution.task_id, prerequisiteTaskId);
    const normalizedDependency = { dependency_kind: 'TASK', prerequisite_task_id: prerequisiteTaskId };
    const blocked = this.#blockTask({
      block_reason: typeof blocker === 'string' ? blocker : (blocker.reason ?? blocker.kind ?? 'typed_dependency'),
      dependency: normalizedDependency,
      terminal_state: 'HANDED_OFF',
      terminal_reason: typeof blocker === 'string' ? blocker : (blocker.reason ?? 'typed_dependency'),
      handoff_metadata: { handoff_material_id: material.material_id, blocker, dependency: normalizedDependency },
    }, envelope);
    const missionId = this.#taskMissionId(execution.task_id);
    const relationId = this.db.prepare(`SELECT relation_id FROM task_relations
        WHERE task_id = ? AND relation_kind = 'depends_on' AND related_task_id = ?`).get(execution.task_id, prerequisiteTaskId)?.relation_id ?? randomUUID();
    this.db.prepare(`INSERT OR IGNORE INTO task_relations
        (relation_id, mission_id, task_id, relation_kind, related_task_id,
         created_by_task_id, created_by_execution_id, created_by, created_at)
        VALUES (?, ?, ?, 'depends_on', ?, ?, ?, ?, ?)`).run(
        relationId, missionId, execution.task_id, prerequisiteTaskId,
        envelope.task_id, envelope.execution_id, envelope.actor_ref, now(),
      );
    return { ...blocked, dependency: normalizedDependency, handoff: { material, link }, disposition: 'blocked' };
  }

  #taskStatus(payload = {}) {
    const missionId = requireString(payload.mission_id ?? payload.missionId, 'mission_id');
    const mission = this.#getMission(missionId);
    if (!mission) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown mission: ${missionId}`);
    const states = payload.states ?? ['OPEN', 'BLOCKED', 'RUNNING', 'WAITING', 'DONE', 'CLOSED', 'CANCELED'];
    const limit = payload.limit ?? 100;
    const tasks = this.#listModernTasks({ mission_id: missionId, states, limit, available_only: false });
    const eligible = this.#listModernTasks({
      mission_id: missionId,
      states: ['OPEN', 'RUNNING'],
      limit,
      available_only: true,
    });
    const statePlaceholders = states.map(() => '?').join(', ');
    const pageTotal = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM tasks t
      JOIN modern_task_records m ON m.task_id = t.task_id
      WHERE m.mission_id = ? AND t.state IN (${statePlaceholders})`).get(missionId, ...states).count ?? 0);
    const counts = this.db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN t.state = 'OPEN' THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN t.state = 'RUNNING' THEN 1 ELSE 0 END) AS running,
      SUM(CASE WHEN t.state = 'WAITING' THEN 1 ELSE 0 END) AS waiting,
      SUM(CASE WHEN t.state IN ('DONE', 'CLOSED', 'CANCELED', 'SATISFIED') THEN 1 ELSE 0 END) AS terminal,
      0 AS eligible
      FROM tasks t JOIN modern_task_records m ON m.task_id = t.task_id WHERE m.mission_id = ?`).get(missionId);
    const lanes = this.db.prepare(`SELECT core_id, task_id, execution_id, state, owner_ref, updated_at
      FROM executions WHERE core_id IS NOT NULL AND state IN ('CREATED', 'RUNNING', 'WAITING')
      ORDER BY core_id, updated_at, execution_id`).all().reduce((byCore, row) => {
      const lane = byCore.get(row.core_id) ?? { core_id: row.core_id, state: 'IDLE', task_id: null, execution_id: null, owner_ref: null, updated_at: null };
      if (lane.state === 'IDLE' || row.state === 'RUNNING' || (row.state === 'CREATED' && lane.state !== 'RUNNING')) {
        lane.state = row.state;
        lane.task_id = row.task_id;
        lane.execution_id = row.execution_id;
        lane.owner_ref = row.owner_ref;
        lane.updated_at = row.updated_at;
      }
      byCore.set(row.core_id, lane);
      return byCore;
    }, new Map());
    return {
      mission,
      tasks,
      eligible_tasks: eligible,
      lanes: [...lanes.values()],
      counts: {
        total: Number(counts.total ?? 0),
        open: Number(counts.open ?? 0),
        running: Number(counts.running ?? 0),
        waiting: Number(counts.waiting ?? 0),
        terminal: Number(counts.terminal ?? 0),
        eligible: eligible.length,
      },
      page: { limit, returned: tasks.length, total: pageTotal, complete: tasks.length >= pageTotal },
      observed_at: now(),
    };
  }

  #taskTake(payload, envelope) {
    const taskId = requireString(payload.task_id ?? envelope.task_id, 'task_id');
    const task = this.getTask(taskId);
    if (!task) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown task: ${taskId}`);
    const takeEnvelope = {
      ...envelope,
      task_id: taskId,
      execution_id: null,
      spec_version: envelope.spec_version ?? task.spec_version,
      state_version: envelope.state_version ?? task.state_version,
    };
    // Fairness bypass is reserved for the internal register-and-switch take.
    const { skip_fairness: _skipFairness, ...takePayload } = payload;
    return this.#takeTask(task, {
      ...takePayload,
      take_key: payload.take_key ?? payload.request_key ?? envelope.operation_id,
      owner_ref: envelope.actor_ref,
    }, takeEnvelope);
  }

  #taskFeedback(payload, envelope) {
    const execution = this.#executionForWrite(envelope);
    const notificationId = requireString(payload.notification_id ?? payload.notificationId, 'notification_id');
    const handled = this.markNotificationHandled(notificationId, execution.execution_id, {
      decision: payload.decision,
      action: payload.action,
      details: payload.details ?? payload.basis ?? {},
    });
    return {
      ...handled,
      task: this.getTask(execution.task_id),
      execution: this.getExecution(execution.execution_id),
    };
  }

  #executionProgress(payload, envelope) {
    const execution = this.#executionForWrite(envelope);
    const kind = payload.kind ?? 'checkpoint';
    if (!['checkpoint', 'handoff'].includes(kind)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'execution_progress kind must be checkpoint or handoff');
    }
    const progress = payload.progress;
    if (!progress || typeof progress !== 'object' || Array.isArray(progress)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'execution_progress progress must be an object');
    }
    for (const field of ['completed_work', 'findings', 'open_questions', 'next_step']) {
      if (!Object.hasOwn(progress, field)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `progress.${field} is required`);
    }
    let progressMaterial = null;
    let link = null;
    if (this.contextService?.publishMaterialForTask) {
      progressMaterial = this.contextService.publishMaterialForTask({
        kind: 'experience',
        role: 'experience',
        scope: 'execution_progress',
        evidence_state: 'observed',
        content: progress,
        provenance: {
          actor_ref: envelope.actor_ref,
          source_execution: execution.execution_id,
          progress_kind: kind,
        },
      }, envelope).material;
      link = this.#linkMaterial({
        task_id: execution.task_id,
        material_id: progressMaterial.material_id,
        role: 'experience',
      }, envelope).link;
    }
    let current = execution;
    if (payload.checkpoint_ref || payload.checkpoint_hash) {
      if (!payload.checkpoint_ref || !payload.checkpoint_hash) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'checkpoint_ref and checkpoint_hash must be provided together');
      }
      current = this.#saveCheckpoint({
        checkpoint_ref: payload.checkpoint_ref,
        checkpoint_hash: payload.checkpoint_hash,
        workspace_revision: payload.workspace_revision ?? null,
      }, envelope).execution;
    }
    if (kind === 'handoff') {
      const handoffEnvelope = {
        ...envelope,
        state_version: current.state_version,
        fencing_version: current.fencing_version,
      };
      const handed = this.#handoffExecution({
        terminal_state: 'FENCED',
        terminal_reason: payload.reason ?? 'progress_handoff',
        checkpoint_ref: current.checkpoint_ref,
        checkpoint_hash: current.checkpoint_hash,
        workspace_ref: payload.workspace_ref ?? current.workspace_ref,
        workspace_revision: payload.workspace_revision ?? current.workspace_revision,
        workspace_content_hash: payload.workspace_content_hash ?? current.workspace_content_hash,
        handoff_metadata: {
          summary: payload.summary ?? null,
          progress_material_id: progressMaterial?.material_id ?? null,
          save_status: payload.save_status ?? 'not_applicable',
        },
      }, handoffEnvelope);
      return { ...handed, kind, progress_material: progressMaterial, progress_link: link, save_status: payload.save_status ?? 'not_applicable' };
    }
    return {
      execution: current,
      task: this.getTask(execution.task_id),
      kind,
      progress_material: progressMaterial,
      progress_link: link,
      save_status: payload.save_status ?? (current.checkpoint_ref ? 'saved' : 'not_applicable'),
    };
  }

  #read(operation, payload, envelope) {
    if (operation === 'get_mission') return this.#getMission(requireString(payload.mission_id, 'mission_id'));
    if (operation === 'task_status') return this.#taskStatus(payload);
    if (operation === 'list_task') return this.#listModernTasks(payload);
    if (operation === 'view_task') return this.#viewModernTask(requireString(payload.task_id ?? envelope.task_id, 'task_id'));
    if (operation === 'list_task_materials') {
      const taskId = requireString(payload.task_id ?? envelope.task_id, 'task_id');
      if (!this.getTask(taskId)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown Task: ${taskId}`);
      return { links: this.#taskMaterialLinks(taskId, { role: payload.role ?? null, materialId: payload.material_id ?? payload.materialId ?? null }) };
    }
    if (operation === 'get_task') {
      const taskId = payload.task_id ?? envelope.task_id;
      return this.getTask(requireString(taskId, 'task_id'));
    }
    if (operation === 'get_execution') {
      const executionId = payload.execution_id ?? envelope.execution_id;
      return this.getExecution(requireString(executionId, 'execution_id'));
    }
    if (operation === 'list_tasks') {
      return this.listTasks({
        rootId: payload.root_id ?? null,
        states: payload.states ?? ['OPEN', 'RUNNING', 'WAITING'],
        taskType: payload.task_type ?? null,
        limit: payload.limit ?? 10,
        availableOnly: payload.available_only ?? true,
      });
    }
    if (operation === 'list_eligible_tasks') {
      return this.listEligibleTasks({
        rootId: payload.root_id ?? null,
        missionId: payload.mission_id ?? payload.missionId ?? null,
        limit: payload.limit ?? 10,
        agingThresholdMs: payload.aging_threshold_ms ?? null,
        nowMs: payload.now_ms ?? Date.now(),
      });
    }
    if (operation === 'list_executions') {
      return this.listExecutions(payload.task_id ?? envelope.task_id, { includeTerminal: payload.include_terminal ?? true });
    }
    throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unsupported Task Service read operation: ${operation}`);
  }

  #mutate(operation, payload, envelope) {
    switch (operation) {
      case 'create_mission': return this.#createMission(payload, envelope);
      case 'create_task': return this.#createModernTask(payload, envelope);
      case 'link_material': return this.#linkMaterial(payload, envelope);
      case 'finish_task': return this.#finishTask(payload, envelope);
      case 'task_take': return this.#taskTake(payload, envelope);
      case 'task_feedback': return this.#taskFeedback(payload, envelope);
      case 'execution_progress': return this.#executionProgress(payload, envelope);
      case 'reconcile_task': return this.#reconcileTask(payload, envelope);
      case 'reopen_task': return this.#reopenTask(payload, envelope);
      case 'heartbeat': return this.#heartbeat(payload, envelope);
      case 'record_handoff_reminder': return this.#recordHandoffReminder(payload, envelope);
      case 'handoff_execution': return this.#handoffExecution(payload, envelope);
      case 'start_execution': return this.#startExecution(payload, envelope);
      case 'resume_execution': return this.#resumeExecution(payload, envelope);
      case 'request_wait': return this.#requestWait(payload, envelope);
      case 'save_workspace_revision': return this.#saveWorkspaceRevision(payload, envelope);
      case 'save_checkpoint': return this.#saveCheckpoint(payload, envelope);
      case 'expire_execution': return this.#expireExecution(payload, envelope);
      case 'fence_execution': return this.#fenceExecution(payload, envelope);
      case 'recover_execution': return this.#recoverExecution(payload, envelope);
      case 'wake_execution': return this.#wakeExecution(payload, envelope);
      default: throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unsupported Task Service operation: ${operation}`);
    }
  }

  #finishTask(payload, envelope) {
    const outcome = String(payload.outcome ?? '').toLowerCase();
    if (!['done', 'incomplete', 'blocked', 'cancelled'].includes(outcome)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'task.finish outcome must be done, incomplete, blocked, or cancelled');
    }
    if (outcome === 'done') return this.#completeTask(payload, envelope);
    if (outcome === 'incomplete') {
      // An incomplete result is a valid boundary even when no durable handoff
      // Material exists yet. Preserve the Task as reopenable work and let a
      // later fresh Bot inspect the public state.
      if (!payload.handoff_material_id) {
        return this.#stopExecution({ ...payload, terminal_state: 'HANDED_OFF', terminal_reason: payload.reason ?? 'incomplete' }, envelope);
      }
      return this.#handoffTask(payload, envelope);
    }
    if (outcome === 'blocked') {
      const execution = this.#executionForWrite(envelope);
      const blocker = payload.blocker ?? payload.reason;
      const dependency = payload.wait_for ?? payload.waitFor ?? payload.dependency;
      if (!blocker || (typeof blocker !== 'object' && typeof blocker !== 'string')) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'task.finish blocked requires blocker');
      }
      if (!dependency || typeof dependency !== 'object' || Array.isArray(dependency)) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'task.finish blocked requires wait_for dependency');
      }
      const dependencyKind = String(dependency.dependency_kind ?? dependency.dependencyKind ?? dependency.kind ?? 'TASK').toUpperCase();
      if (dependencyKind !== 'TASK') {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'task.finish blocked requires a TASK wait_for dependency');
      }
      const prerequisiteTaskId = dependency.prerequisite_task_id ?? dependency.prerequisiteTaskId ?? dependency.task_id ?? dependency.taskId;
      if (typeof prerequisiteTaskId !== 'string' || prerequisiteTaskId.length === 0 || prerequisiteTaskId === execution.task_id) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'task.finish blocked requires a distinct prerequisite Task ID');
      }
      const prerequisite = this.getTask(prerequisiteTaskId);
      if (!prerequisite || this.#taskMissionId(prerequisiteTaskId) !== this.#taskMissionId(execution.task_id)) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'wait_for must identify a Task in the same Mission');
      }
      this.#assertModernDependencyCycle(execution.task_id, prerequisiteTaskId);
      const normalizedDependency = { dependency_kind: 'TASK', prerequisite_task_id: prerequisiteTaskId };
      const blocked = this.#blockTask({
        block_reason: typeof blocker === 'string' ? blocker : (blocker.reason ?? blocker.kind ?? 'typed_dependency'),
        dependency: normalizedDependency,
        terminal_state: 'HANDED_OFF',
        terminal_reason: typeof blocker === 'string' ? blocker : (blocker.reason ?? 'typed_dependency'),
      }, envelope);
      return { ...blocked, dependency: normalizedDependency, disposition: 'blocked' };
    }
    if (outcome === 'cancelled') {
      const execution = this.#executionForWrite(envelope);
      const replacementTaskId = payload.replacement_task_id ?? payload.replacementTaskId ?? null;
      if (replacementTaskId !== null) {
        if (typeof replacementTaskId !== 'string' || replacementTaskId.length === 0 || replacementTaskId === execution.task_id) {
          throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'replacement_task_id must identify another Task');
        }
        const replacement = this.getTask(replacementTaskId);
        if (!replacement || this.#taskMissionId(replacementTaskId) !== this.#taskMissionId(execution.task_id) || ['CANCELED', 'DONE', 'CLOSED'].includes(replacement.state)) {
          throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'replacement_task_id must identify a live Task in the same Mission');
        }
      }
      return this.#stopExecution({
        ...payload,
        terminal_state: 'CANCELLED',
        terminal_reason: payload.reason ?? 'cancelled',
        handoff_metadata: replacementTaskId ? { replacement_task_id: replacementTaskId } : null,
      }, envelope);
    }
    return this.#stopExecution({ ...payload, terminal_state: 'CANCELLED', terminal_reason: payload.reason ?? 'cancelled' }, envelope);
  }

  #backfillStructureRecords() {
    const createdAt = now();
    const tasks = this.db.prepare('SELECT task_id, parent_id, created_by, created_at FROM tasks').all();
    for (const task of tasks) {
      this.#ensureStructureVersion(task.task_id, task.created_at ?? createdAt);
      this.#recordCreationProvenance({
        taskId: task.task_id,
        creatorTaskId: task.parent_id,
        creatorExecutionId: null,
        creatorActorRef: task.created_by ?? 'system:backfill',
        creationKind: task.parent_id ? 'CHILD' : 'ROOT',
        createdAt: task.created_at ?? createdAt,
      });
    }
  }

  #ensureStructureVersion(taskId, updatedAt = now()) {
    this.db.prepare(`INSERT INTO task_structure_versions (task_id, structural_version, updated_at)
      VALUES (?, 1, ?) ON CONFLICT(task_id) DO NOTHING`).run(taskId, updatedAt);
  }

  #recordCreationProvenance({ taskId, creatorTaskId = null, creatorExecutionId = null, creatorActorRef, creationKind, priorTaskId = null, sourceMaterialRefs = [], feedback = null, workspaceLineage = null, collaborationReason = null, createdAt = now() }) {
    this.db.prepare(`INSERT INTO task_creation_provenance
      (task_id, creator_task_id, creator_execution_id, creator_actor_ref, creation_kind, prior_task_id, source_material_refs_json, feedback_json, workspace_lineage_json, collaboration_reason_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(task_id) DO NOTHING`)
      .run(taskId, creatorTaskId, creatorExecutionId, requireString(creatorActorRef, 'creator_actor_ref'), creationKind,
        priorTaskId, json(sourceMaterialRefs), feedback === null ? null : json(feedback), workspaceLineage === null ? null : json(workspaceLineage), collaborationReason === null ? null : json(collaborationReason), createdAt);
  }

  #structureVersion(taskId) {
    return this.db.prepare('SELECT structural_version FROM task_structure_versions WHERE task_id = ?').get(taskId)?.structural_version ?? 1;
  }

  #bumpStructure(taskId, { eventType, payload, envelope, version = null, sourceMaterialRefs = [] } = {}) {
    const current = this.#structureVersion(taskId);
    const next = version ?? current + 1;
    if (next !== current + 1) throw new SwarmEnvError(ERROR_CODES.STALE_VERSION, 'structural version is stale', { expected_structural_version: current });
    const createdAt = now();
    this.db.prepare('UPDATE task_structure_versions SET structural_version = ?, updated_at = ? WHERE task_id = ?').run(next, createdAt, taskId);
    const eventPayload = sourceMaterialRefs.length > 0
      ? { ...(payload ?? {}), source_material_refs: sourceMaterialRefs }
      : payload;
    this.db.prepare(`INSERT INTO task_structure_events
      (event_id, task_id, structural_version, event_type, actor_ref, execution_id, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), taskId, next, eventType, envelope?.actor_ref ?? 'system', envelope?.execution_id ?? null, json(eventPayload), createdAt);
    return next;
  }

  #assertStructureAuthority(ownerTaskId, envelope) {
    requireString(ownerTaskId, 'task_id');
    if (envelope.task_id !== ownerTaskId) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'structure mutation must target the owner Task');
    if (!envelope.execution_id) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'structure mutation requires a bound Task Execution');
    }
    const owner = this.getTask(ownerTaskId);
    if (!owner) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown Task: ${ownerTaskId}`);
    const execution = this.getExecution(envelope.execution_id);
    if (!execution || execution.task_id !== ownerTaskId || !['CREATED', 'RUNNING', 'WAITING'].includes(execution.state) || execution.owner_ref !== envelope.actor_ref) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'only the current Task Execution owner may change Task structure');
    }
    try {
      this.#executionForWrite(envelope);
    } catch (error) {
      if (error.code !== ERROR_CODES.STALE_VERSION || envelope.state_version !== owner.state_version) throw error;
      this.#executionForWrite({ ...envelope, state_version: execution.state_version });
    }
    return { task: owner, execution };
  }

  #isBranchTask(taskId) {
    return Boolean(this.db.prepare(`SELECT 1 FROM task_structure_members m
      JOIN task_structure_groups g ON g.group_id = m.group_id
      WHERE m.task_id = ? AND g.group_kind = 'BRANCH' AND m.retired_at IS NULL AND g.retired_at IS NULL LIMIT 1`).get(taskId));
  }

  #assertCanCreateBranch(ownerTaskId) {
    if (this.#isBranchTask(ownerTaskId)) {
      throw new SwarmEnvError(ERROR_CODES.BRANCH_TASK_CANNOT_CREATE_BRANCH, 'a Branch Task may create required subtasks but cannot create another Branch group', { task_id: ownerTaskId });
    }
  }

  #assertExpectedStructureVersion(taskId, expected) {
    const current = this.#structureVersion(taskId);
    if (expected !== undefined && expected !== null && expected !== current) {
      throw new SwarmEnvError(ERROR_CODES.STALE_VERSION, 'Task structural version is stale', { expected_structural_version: current, received_structural_version: expected });
    }
    return current;
  }

  #admissionPolicy(rootId) {
    const row = this.db.prepare('SELECT * FROM task_admission_policies WHERE root_id = ?').get(rootId);
    if (row) return { ...row, require_responsibility_key: Boolean(row.require_responsibility_key) };
    const policy = this.admission;
    const createdAt = now();
    this.db.prepare(`INSERT OR IGNORE INTO task_admission_policies
      (root_id, max_unfinished_tasks, max_open_tasks, max_children_per_execution, max_turn_mutations, aging_threshold_ms, require_responsibility_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      rootId, policy.max_unfinished_tasks, policy.max_open_tasks, policy.max_children_per_execution,
      policy.max_turn_mutations, policy.aging_threshold_ms, policy.require_responsibility_key ? 1 : 0, createdAt, createdAt,
    );
    const stored = this.db.prepare('SELECT * FROM task_admission_policies WHERE root_id = ?').get(rootId);
    return { ...stored, require_responsibility_key: Boolean(stored.require_responsibility_key) };
  }

  #storeAdmissionPolicy(rootId, override = {}) {
    const policy = this.#normalizeAdmissionPolicy({ ...this.admission, ...(override ?? {}) });
    const createdAt = now();
    this.db.prepare(`INSERT OR REPLACE INTO task_admission_policies
      (root_id, max_unfinished_tasks, max_open_tasks, max_children_per_execution, max_turn_mutations, aging_threshold_ms, require_responsibility_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM task_admission_policies WHERE root_id = ?), ?), ?)`).run(
      rootId, policy.max_unfinished_tasks, policy.max_open_tasks, policy.max_children_per_execution,
      policy.max_turn_mutations, policy.aging_threshold_ms, policy.require_responsibility_key ? 1 : 0, rootId, createdAt, createdAt,
    );
    return { ...policy, require_responsibility_key: Boolean(policy.require_responsibility_key) };
  }

  #enforceFairness(task) {
    const policy = this.#admissionPolicy(task.root_id);
    const protectedTasks = this.listEligibleTasks({
      rootId: task.root_id,
      limit: 100,
      agingThresholdMs: policy.aging_threshold_ms,
      nowMs: Date.now(),
    }).filter((candidate) => candidate.fairness_protected);
    if (protectedTasks.length === 0) return;
    const oldest = protectedTasks[0];
    if (oldest.task_id !== task.task_id) {
      throw new SwarmEnvError(ERROR_CODES.FAIRNESS_REQUIRED, 'an older eligible Task must receive a take opportunity first', {
        protected_task_id: oldest.task_id,
        selected_task_id: task.task_id,
        root_task_id: task.root_id,
      }, { retryable: true });
    }
  }

  #taskRow(taskId) {
    const row = this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
    if (!row) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown Task: ${taskId}`);
    return rowToTask(row);
  }

  #taskDependencyRows(taskId) {
    return this.db.prepare(`SELECT * FROM task_structure_dependencies
      WHERE task_id = ? AND retired_at IS NULL ORDER BY created_at, dependency_id`).all(taskId);
  }

  #dependencySatisfied(dependency) {
    if (dependency.dependency_kind === 'TASK') return isCompletedTaskState(this.getTask(dependency.prerequisite_task_id)?.state);
    const requirement = dependency.requirement ?? parse(dependency.requirement_json) ?? {};
    if (dependency.dependency_kind === 'MATERIAL') {
      const material = this.contextService?.getMaterial(dependency.material_id);
      if (!material) return false;
      for (const field of ['kind', 'scope', 'evidence_state', 'content_hash', 'source_task', 'source_execution']) {
        if (requirement[field] !== undefined && material[field] !== requirement[field]) return false;
      }
      return true;
    }
    if (dependency.dependency_kind === 'CHECK_RESULT') {
      const result = this.getCheckResult(dependency.check_result_id);
      const checkerHealth = requirement.checker_health;
      if (checkerHealth && typeof checkerHealth === 'object') {
        const health = this.checkerHealthReader?.(checkerHealth.preflight_key) ?? null;
        return Boolean(health?.status === 'healthy' || (health?.health_fingerprint && health.health_fingerprint !== checkerHealth.health_fingerprint));
      }
      if (!result || result.status !== 'APPLIED' || result.verdict !== 'PASS') return false;
      for (const field of ['status', 'verdict', 'target_task_id', 'candidate_material_id']) {
        if (requirement[field] !== undefined && result[field] !== requirement[field]) return false;
      }
      return true;
    }
    return false;
  }

  /**
   * Dependencies that gate take/readiness. A shared Mission Task records a
   * branch's prerequisites as observable structure, but per the runtime
   * contract (§1, §3) it remains OPEN and eligible whenever it has no
   * executor until the Mission itself ends; one branch's prerequisite never
   * removes the shared responsibility from the other identities.
   */
  #gatingDependencyBlockers(taskOrId) {
    const taskId = typeof taskOrId === 'string' ? taskOrId : taskOrId?.task_id;
    if (this.#isSharedMissionTask(taskOrId)) return [];
    return this.#dependencyBlockers(taskId);
  }

  #dependencyBlockers(taskId) {
    const legacy = this.#taskDependencyRows(taskId).filter((dependency) => !this.#dependencySatisfied(dependency)).map((dependency) => ({
      dependency_id: dependency.dependency_id,
      dependency_kind: dependency.dependency_kind,
      prerequisite_task_id: dependency.prerequisite_task_id,
      material_id: dependency.material_id,
      check_result_id: dependency.check_result_id,
      requirement: parse(dependency.requirement_json) ?? {},
    }));
    return [...legacy, ...this.#modernDependencyBlockers(taskId)];
  }

  #assertDependencyCycle(taskId, prerequisiteTaskId) {
    if (taskId === prerequisiteTaskId) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'execution dependency cannot point to the same Task');
    const seen = new Set();
    const visit = (candidate) => {
      if (candidate === taskId) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'execution dependency would create a cycle');
      if (seen.has(candidate)) return;
      seen.add(candidate);
      for (const row of this.#taskDependencyRows(candidate)) {
        if (row.dependency_kind === 'TASK') visit(row.prerequisite_task_id);
      }
    };
    visit(prerequisiteTaskId);
  }

  #insertDependency(taskId, dependency, envelope) {
    if (!dependency || typeof dependency !== 'object' || Array.isArray(dependency)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'dependency must be an object');
    const dependencyKind = dependency.dependency_kind ?? dependency.kind ?? (dependency.prerequisite_task_id ? 'TASK' : dependency.material_id ? 'MATERIAL' : dependency.check_result_id ? 'CHECK_RESULT' : null);
    if (!['TASK', 'MATERIAL', 'CHECK_RESULT'].includes(dependencyKind)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'dependency_kind must be TASK, MATERIAL, or CHECK_RESULT');
    const prerequisiteTaskId = dependency.prerequisite_task_id ?? dependency.task_id ?? null;
    const materialId = dependency.material_id ?? null;
    const checkResultId = dependency.check_result_id ?? null;
    if (dependencyKind === 'TASK') {
      const prerequisite = this.#taskRow(requireString(prerequisiteTaskId, 'dependency.prerequisite_task_id'));
      this.#assertDependencyCycle(taskId, prerequisite.task_id);
    }
    if (dependencyKind === 'MATERIAL') {
      requireString(materialId, 'dependency.material_id');
    }
    if (dependencyKind === 'CHECK_RESULT') {
      requireString(checkResultId, 'dependency.check_result_id');
    }
    const dependencyId = dependency.dependency_id ?? randomUUID();
    const duplicate = this.db.prepare(`SELECT dependency_id FROM task_structure_dependencies
      WHERE task_id = ? AND dependency_kind = ?
        AND COALESCE(prerequisite_task_id, material_id, check_result_id) = ? AND retired_at IS NULL`).get(
      taskId, dependencyKind, dependencyKind === 'TASK' ? prerequisiteTaskId : dependencyKind === 'MATERIAL' ? materialId : checkResultId);
    if (duplicate) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'active execution dependency already exists', { dependency_id: duplicate.dependency_id });
    if (this.db.prepare('SELECT 1 FROM task_structure_dependencies WHERE dependency_id = ?').get(dependencyId)) {
      throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'dependency_id already exists', { dependency_id: dependencyId });
    }
    this.db.prepare(`INSERT INTO task_structure_dependencies
      (dependency_id, task_id, dependency_kind, prerequisite_task_id, material_id, check_result_id, requirement_json,
       created_by_task_id, created_by_execution_id, created_by_actor_ref, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(dependencyId, taskId, dependencyKind, dependencyKind === 'TASK' ? prerequisiteTaskId : null,
      dependencyKind === 'MATERIAL' ? materialId : null, dependencyKind === 'CHECK_RESULT' ? checkResultId : null,
      json(dependency.requirement ?? {}), envelope.task_id, envelope.execution_id, envelope.actor_ref, now());
    return this.db.prepare('SELECT * FROM task_structure_dependencies WHERE dependency_id = ?').get(dependencyId);
  }

  #sourceMaterialRefs(value, field = 'source_material_refs') {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.some((ref) => typeof ref !== 'string' || !ref)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `${field} must contain Material IDs`);
    }
    if (this.contextService) {
      for (const materialId of value) {
        if (!this.contextService.getMaterial(materialId)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown structural-change Material: ${materialId}`);
      }
    }
    return [...new Set(value)];
  }

  #take(payload, envelope) {
    requireString(envelope.task_id, 'task_id');
    if (envelope.execution_id !== null) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'take cannot target an execution');
    const task = this.getTask(envelope.task_id);
    if (!task) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown task: ${envelope.task_id}`);
    return this.#takeTask(task, payload, envelope);
  }

  #reconcileTask(payload, envelope) {
    const taskId = requireString(payload.task_id ?? envelope.task_id, 'task_id');
    if (envelope.execution_id !== null) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Controller reconciliation cannot target an Execution');
    const task = this.getTask(taskId);
    if (!task) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown task: ${taskId}`);
    const blockers = this.#gatingDependencyBlockers(task);
    const active = this.db.prepare("SELECT COUNT(*) AS count FROM executions WHERE task_id = ? AND state IN ('CREATED', 'RUNNING')").get(taskId).count;
    const updatedAt = now();
    if (TERMINAL_TASK_STATES.includes(task.state) || active > 0) {
      return { task: this.getTask(taskId), changed: false, blockers };
    }
    if (task.state === 'BLOCKED' && this.#isSharedMissionTask(task)) {
      // Repair durable state written before the shared-Mission block fix: a
      // shared Mission is never aggregate-BLOCKED while the Mission is live.
      const reopened = this.#refreshTaskState(taskId, { updatedAt });
      return { task: reopened, changed: reopened.state !== task.state, blockers: [] };
    }
    if (blockers.length > 0 && task.state !== 'BLOCKED') {
      const reason = blockers.map((blocker) => `dependency:${blocker.dependency_id ?? 'unknown'}`).join(',');
      this.db.prepare("UPDATE tasks SET state = 'BLOCKED', block_reason = ?, eligible_at = NULL, state_version = state_version + 1, updated_at = ? WHERE task_id = ?")
        .run(reason, updatedAt, taskId);
      return { task: this.getTask(taskId), changed: true, blockers };
    }
    // Controller reconciliation may reopen a dependency block after the
    // prerequisite becomes satisfied.  Other block reasons (checker health,
    // admission, or an operator decision) require an explicit reopen so a
    // periodic sweep cannot silently erase that decision.
    if (blockers.length === 0 && task.state === 'BLOCKED' && String(task.block_reason ?? '').startsWith('dependency:')) {
      this.db.prepare("UPDATE tasks SET state = 'OPEN', block_reason = NULL, eligible_at = ?, state_version = state_version + 1, updated_at = ? WHERE task_id = ?")
        .run(updatedAt, updatedAt, taskId);
      const reopened = this.getTask(taskId);
      const missionId = this.#taskMissionId(taskId);
      if (missionId && this.#getMission(missionId)) {
        this.enqueueNotification({
          deliveryKey: `task_reopened:${taskId}:${reopened.state_version}`,
          missionId,
          recipientTaskId: taskId,
          type: 'task_reopened',
          payload: { task_id: taskId, state_version: reopened.state_version, reason: 'dependency_satisfied' },
        });
      }
      return { task: reopened, changed: true, blockers: [] };
    }
    return { task: this.getTask(taskId), changed: false, blockers };
  }

  #reopenTask(payload, envelope) {
    const taskId = requireString(payload.task_id ?? envelope.task_id, 'task_id');
    if (envelope.execution_id !== null) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'reopen_task cannot target an Execution');
    const task = this.getTask(taskId);
    if (!task) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown task: ${taskId}`);
    if (TERMINAL_TASK_STATES.includes(task.state)) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'terminal Task cannot be reopened');
    const blockers = this.#gatingDependencyBlockers(task);
    if (blockers.length > 0) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Task dependencies are not satisfied', { blockers });
    }
    const active = this.db.prepare("SELECT COUNT(*) AS count FROM executions WHERE task_id = ? AND state IN ('CREATED', 'RUNNING')").get(taskId).count;
    if (active > 0) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Task already has an active Execution');
    if (task.state === 'OPEN') return { task, changed: false, blockers: [] };
    const updatedAt = now();
    this.db.prepare("UPDATE tasks SET state = 'OPEN', block_reason = NULL, eligible_at = ?, state_version = state_version + 1, updated_at = ? WHERE task_id = ?")
      .run(updatedAt, updatedAt, taskId);
    const reopened = this.getTask(taskId);
    const missionId = this.#taskMissionId(taskId);
    if (missionId && this.#getMission(missionId)) {
      this.enqueueNotification({
        deliveryKey: `task_reopened:${taskId}:${reopened.state_version}`,
        missionId,
        recipientTaskId: taskId,
        type: 'task_reopened',
        payload: { task_id: taskId, state_version: reopened.state_version, reason: 'explicit_reopen' },
      });
    }
    return { task: reopened, changed: true, blockers: [] };
  }

  #blockTask(payload, envelope) {
    const execution = this.#executionForWrite(envelope);
    if (!['CREATED', 'RUNNING'].includes(execution.state)) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `only an active Execution can block a Task, got ${execution.state}`);
    }
    const reason = requireString(payload.block_reason ?? payload.reason, 'block_reason');
    let dependency = null;
    let externalDependency = null;
    if (payload.dependency !== undefined) {
      dependency = this.#insertDependency(execution.task_id, payload.dependency, envelope);
      this.#bumpStructure(execution.task_id, {
        eventType: 'dependency_added',
        payload: { dependency_id: dependency.dependency_id, dependency },
        envelope,
      });
    }
    if (payload.external_dependency !== undefined) {
      const candidate = payload.external_dependency;
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'external_dependency must be an object');
      }
      const capabilityId = candidate.capability_id ?? candidate.capabilityId ?? candidate.required_capability ?? null;
      if (typeof capabilityId !== 'string' || capabilityId.length === 0) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'external_dependency.capability_id is required');
      }
      if (dependency) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'a block may have either a Task dependency or an external dependency, not both');
      }
      externalDependency = {
        dependency_kind: 'CAPABILITY',
        capability_id: capabilityId,
        scope: candidate.scope ?? null,
        retryable: candidate.retryable !== false,
        recovery_condition: candidate.recovery_condition ?? candidate.recoveryCondition ?? candidate.resolution ?? 'explicit_reopen',
      };
    }
    const task = this.getTask(execution.task_id);
    if (task?.completion_contract?.normal_flow === true && !dependency && !externalDependency) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'normal_flow Tasks require execution_block with a typed dependency');
    }
    const blockReason = dependency?.dependency_id
      ? `dependency:${dependency.dependency_id}`
      : externalDependency
        ? `external:${externalDependency.capability_id}`
        : reason;
    const terminalState = payload.terminal_state ?? 'FENCED';
    if (!TERMINAL_EXECUTION_STATES.includes(terminalState)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'terminal_state must be an Execution terminal state');
    }
    const updatedAt = now();
    const handoffMetadata = payload.handoff_metadata && typeof payload.handoff_metadata === 'object' && !Array.isArray(payload.handoff_metadata)
      ? json(payload.handoff_metadata)
      : null;
    this.db.prepare(`UPDATE executions SET state = ?, fencing_version = fencing_version + 1,
      terminal_reason = ?, checkpoint_ref = COALESCE(?, checkpoint_ref), checkpoint_hash = COALESCE(?, checkpoint_hash),
      workspace_ref = COALESCE(?, workspace_ref), workspace_revision = COALESCE(?, workspace_revision),
      workspace_content_hash = COALESCE(?, workspace_content_hash), handoff_metadata_json = COALESCE(?, handoff_metadata_json),
      state_version = state_version + 1, updated_at = ?
      WHERE execution_id = ?`).run(
      terminalState,
      reason,
      payload.checkpoint_ref ?? null,
      payload.checkpoint_hash ?? null,
      payload.workspace_ref ?? null,
      payload.workspace_revision ?? null,
      payload.workspace_content_hash ?? null,
      handoffMetadata,
      updatedAt,
      execution.execution_id,
    );
    const sharedMission = this.#isSharedMissionTask(task);
    // A dependency block on an ordinary Task releases its whole responsibility.
    // A shared Mission is different: one branch may be blocked while sibling
    // Executions continue to own the shared problem, so only the current
    // Execution is fenced and aggregate state is refreshed from the survivors.
    const otherExecutionIds = sharedMission ? [] : this.db.prepare("SELECT execution_id FROM executions WHERE task_id = ? AND execution_id <> ? AND state IN ('CREATED', 'RUNNING', 'WAITING')")
      .all(execution.task_id, execution.execution_id).map((row) => row.execution_id);
    const fencedOthers = sharedMission ? 0 : this.db.prepare(`UPDATE executions SET state = 'FENCED', fencing_version = fencing_version + 1,
      terminal_reason = ?, state_version = state_version + 1, updated_at = ?
      WHERE task_id = ? AND execution_id <> ? AND state IN ('CREATED', 'RUNNING', 'WAITING')`)
      .run(`dependency_blocked:${blockReason}`, updatedAt, execution.task_id, execution.execution_id).changes;
    if (sharedMission) {
      // The block ends only this branch. Per the runtime contract (§1, §3)
      // the shared Mission Task is RUNNING while others execute and OPEN with
      // no executor, and stays eligible until the Mission ends. The typed
      // prerequisite remains recorded on the Execution handoff metadata and
      // as Task structure; it does not become an aggregate BLOCKED state
      // (r12: that state idled every Core for the remaining 84 minutes).
      this.#refreshTaskState(execution.task_id, { updatedAt });
    } else {
      this.db.prepare("UPDATE tasks SET state = 'BLOCKED', block_reason = ?, eligible_at = NULL, state_version = state_version + 1, updated_at = ? WHERE task_id = ?")
        .run(blockReason, updatedAt, execution.task_id);
    }
    this.#emitExecutionState({
      kind: 'executions_fenced',
      task_id: execution.task_id,
      execution_ids: otherExecutionIds,
      excluded_execution_id: execution.execution_id,
      reason,
    });
    return {
      execution: this.getExecution(execution.execution_id),
      task: this.getTask(execution.task_id),
      blocked: true,
      dependency: dependency ?? externalDependency,
      external_dependency: externalDependency,
      fenced_execution_count: fencedOthers,
    };
  }

  #takeTask(task, payload, envelope) {
    if (TERMINAL_TASK_STATES.includes(task.state)) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'terminal Task cannot be taken');
    const sharedMission = this.#isSharedMissionTask(task);
    const dependencyBlockers = this.#gatingDependencyBlockers(task);
    if (dependencyBlockers.length > 0) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Task is blocked by an explicit execution dependency', { blockers: dependencyBlockers });
    }
    const takeKey = requireString(payload.take_key ?? payload.request_key, 'take_key');
    const keyFingerprint = operationPayload('take', payload, envelope);
    const existingKey = this.db.prepare('SELECT * FROM take_keys WHERE request_key = ?').get(takeKey);
    if (existingKey) {
      if (existingKey.task_id !== task.task_id || existingKey.fingerprint !== keyFingerprint) {
        throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'take_key was reused with another payload');
      }
      return { task: this.getTask(task.task_id), execution: this.getExecution(existingKey.execution_id) };
    }
    if (envelope.spec_version !== task.spec_version || envelope.state_version !== task.state_version) {
      throw new SwarmEnvError(ERROR_CODES.STALE_VERSION, 'Task take version is stale', { expected_state_version: task.state_version, expected_spec_version: task.spec_version });
    }
    if (payload.skip_fairness !== true) this.#enforceFairness(task);
    const ownerRef = payload.owner_ref ?? envelope.actor_ref;
    const coreId = payload.core_id ?? payload.coreId ?? null;
    if (coreId !== null) requireString(coreId, 'core_id');
    // A Bot is represented by its authenticated owner reference for the
    // coordination boundary. It may have zero or one active Execution. A
    // successor Bot receives a fresh owner reference after the previous
    // Execution is terminal and fenced.
    const ownerExecution = this.db.prepare("SELECT execution_id, task_id FROM executions WHERE owner_ref = ? AND state IN ('CREATED', 'RUNNING', 'WAITING') LIMIT 1").get(ownerRef);
    if (ownerExecution) {
      throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Bot already owns an active Execution', {
        owner_ref: ownerRef,
        execution_id: ownerExecution.execution_id,
        task_id: ownerExecution.task_id,
      });
    }
    if (coreId !== null) {
      const occupied = this.getActiveExecutionForCore(coreId);
      if (occupied) {
        throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Core already owns an active Execution', {
          core_id: coreId,
          execution_id: occupied.execution_id,
          task_id: occupied.task_id,
        });
      }
    }
    const agentPrompt = payload.agent_prompt ?? payload.initial_prompt ?? task.task_instructions ?? '';
    if (typeof agentPrompt !== 'string') throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'agent_prompt must be a string');
    const inputMaterialRefs = payload.input_material_refs ?? task.input_material_refs;
    if (!Array.isArray(inputMaterialRefs)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'input_material_refs must be an array');
    const modernTask = Boolean(this.#modernTaskRecord(task.task_id));
    // New Mission Tasks start from the public Workspace revision resolved at
    // take time. Legacy executions retain their explicit resume compatibility
    // path until their data is migrated.
    const workspaceMode = payload.workspace_mode ?? (modernTask ? 'clean' : 'resume');
    if (!['resume', 'clean'].includes(workspaceMode)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'workspace_mode must be resume or clean');
    }
    if (modernTask && workspaceMode === 'resume') {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'private Workspace resume is retired for Mission Tasks; select a public revision or clean Workspace');
    }
    if (payload.workspace_revision !== undefined && (!Number.isInteger(payload.workspace_revision) || payload.workspace_revision < 1)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'workspace_revision must be a positive integer');
    }
    let sourceExecutionId = payload.workspace_source_execution_id ?? null;
    let sourceWorkspaceRef = payload.workspace_source_ref ?? null;
    if (sourceExecutionId) {
      const source = this.getExecution(sourceExecutionId);
      if (!source || source.task_id !== task.task_id || !source.workspace_ref) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'workspace_source_execution_id must identify an Execution of this Task with a Workspace');
      }
      sourceWorkspaceRef = source.workspace_ref;
    }
    if (workspaceMode === 'resume' && sourceWorkspaceRef !== null && typeof sourceWorkspaceRef !== 'string') {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'workspace_source_ref must be a string');
    }
    if (workspaceMode === 'clean' && (sourceExecutionId || sourceWorkspaceRef || payload.workspace_revision !== undefined)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'clean Workspace selection cannot include a source or revision');
    }
    let waitingExecution = this.db.prepare("SELECT * FROM executions WHERE task_id = ? AND state = 'WAITING' ORDER BY updated_at DESC, execution_id DESC LIMIT 1").get(task.task_id);
    const queuedRework = this.db.prepare("SELECT 1 FROM executions WHERE task_id = ? AND state = 'CREATED' LIMIT 1").get(task.task_id);
    if (workspaceMode === 'resume' && !sourceExecutionId && sourceWorkspaceRef === null && !waitingExecution && !queuedRework) {
      // A successor take after a fenced/handed-off Execution should carry
      // explicit Workspace lineage even when the Agent only asks for the
      // default resume mode. This makes the source Execution/revision
      // auditable and prevents a successor from silently starting from an
      // ambiguous task-level snapshot.
      const previous = this.db.prepare(`SELECT execution_id, workspace_ref, workspace_revision
        FROM executions WHERE task_id = ? AND state IN ('HANDED_OFF', 'FENCED', 'EXPIRED', 'FAILED')
          AND workspace_ref IS NOT NULL ORDER BY updated_at DESC, execution_id DESC LIMIT 1`).get(task.task_id);
      if (previous) {
        sourceExecutionId = previous.execution_id;
        sourceWorkspaceRef = previous.workspace_ref;
        if (payload.workspace_revision === undefined && Number.isInteger(previous.workspace_revision)) {
          payload = { ...payload, workspace_revision: previous.workspace_revision };
        }
      }
    }
    const inputSnapshotHash = payload.input_snapshot_hash ?? hash({
      task_id: task.task_id,
      spec_hash: task.spec_hash,
      workspace: task.workspace,
      input_material_refs: inputMaterialRefs,
    });
    const activeCount = this.db.prepare("SELECT COUNT(*) AS count FROM executions WHERE task_id = ? AND state IN ('CREATED', 'RUNNING')").get(task.task_id).count;
    // A released Execution may remain CREATED so a later Worker can resume its
    // Workspace. Its incremented instruction version marks it as queueable;
    // an ordinary take-created Execution remains protected by the active
    // quota until Runtime binds it.
    const createdRow = this.db.prepare("SELECT * FROM executions WHERE task_id = ? AND state = 'CREATED' ORDER BY updated_at DESC, execution_id DESC LIMIT 1").get(task.task_id);
    const reworkExecution = createdRow ? rowToExecution(createdRow) : null;
    const reworkLeaseExpired = reworkExecution && (!reworkExecution.lease_expires_at || Date.parse(reworkExecution.lease_expires_at) <= Date.now());
    const sameReworkWorkspace = reworkExecution && sourceExecutionId === reworkExecution.execution_id &&
      (payload.workspace_revision === undefined || payload.workspace_revision === reworkExecution.workspace_revision);
    if (!sharedMission && reworkExecution && reworkExecution.instruction_version > 1 && reworkLeaseExpired && !waitingExecution && activeCount === 1 && task.parallel_quota === 1 &&
      workspaceMode === 'resume' && ((!sourceExecutionId && !sourceWorkspaceRef) || sameReworkWorkspace) &&
      (payload.workspace_revision === undefined || payload.workspace_revision === reworkExecution.workspace_revision)) {
      const updatedAt = now();
      const nextLease = payload.lease_expires_at ?? new Date(Date.now() + 30_000).toISOString();
      if (coreId !== null && reworkExecution.core_id !== null && reworkExecution.core_id !== coreId) {
        throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Execution is permanently bound to another Core', { core_id: reworkExecution.core_id });
      }
      this.db.prepare(`UPDATE executions SET owner_ref = ?, core_id = COALESCE(?, core_id), lease_expires_at = ?, heartbeat_at = ?, agent_prompt = ?, state_version = state_version + 1, updated_at = ?
        WHERE execution_id = ?`).run(ownerRef, coreId, nextLease, updatedAt, agentPrompt, updatedAt, reworkExecution.execution_id);
      this.db.prepare('UPDATE tasks SET state = ?, state_version = state_version + 1, block_reason = NULL, updated_at = ? WHERE task_id = ?')
        .run('RUNNING', updatedAt, task.task_id);
      this.db.prepare('INSERT INTO take_keys (request_key, task_id, fingerprint, execution_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(takeKey, task.task_id, keyFingerprint, reworkExecution.execution_id, updatedAt);
      return { task: this.getTask(task.task_id), execution: this.getExecution(reworkExecution.execution_id) };
    }
    const resumableWaiting = waitingExecution && this.#isWaitingResumable(rowToExecution(waitingExecution));
    const canContinueCurrentWaiting = Boolean(!sharedMission && waitingExecution && activeCount === 0 && task.parallel_quota === 1 && resumableWaiting &&
      (payload.workspace_revision === undefined || payload.workspace_revision === waitingExecution.workspace_revision) &&
      !(coreId !== null && waitingExecution.core_id !== null && waitingExecution.core_id !== coreId));
    if (workspaceMode === 'resume' && payload.workspace_revision !== undefined && !sourceWorkspaceRef && !canContinueCurrentWaiting) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'resume Workspace selection with a revision requires a source Workspace or the current waiting Workspace revision');
    }
    if (!sharedMission && waitingExecution && activeCount === 0 && task.parallel_quota === 1 && resumableWaiting) {
      const continueExisting = workspaceMode === 'resume' && !sourceExecutionId && !sourceWorkspaceRef && canContinueCurrentWaiting;
      if (!continueExisting) {
        // A worker may explicitly choose a clean start or a Workspace fork.
        // Retire the released responsibility first, then create the selected
        // new Execution below without violating the single active quota.
        const supersededAt = now();
        this.db.prepare("UPDATE executions SET state = 'SUPERSEDED', fencing_version = fencing_version + 1, state_version = state_version + 1, updated_at = ? WHERE execution_id = ?")
          .run(supersededAt, waitingExecution.execution_id);
        waitingExecution = null;
      } else {
      const updatedAt = now();
      const nextLease = payload.lease_expires_at ?? new Date(Date.now() + 30_000).toISOString();
      this.db.prepare(`UPDATE executions SET owner_ref = ?, core_id = COALESCE(?, core_id), state = 'CREATED', attempt_no = attempt_no + 1,
        lease_expires_at = ?, heartbeat_at = ?, agent_prompt = ?, wait_condition_json = NULL,
        wait_deadline = NULL, resume_token = NULL, state_version = state_version + 1, updated_at = ?
        WHERE execution_id = ?`).run(ownerRef, coreId, nextLease, updatedAt, agentPrompt, updatedAt, waitingExecution.execution_id);
      this.db.prepare('UPDATE tasks SET state = ?, state_version = state_version + 1, block_reason = NULL, updated_at = ? WHERE task_id = ?')
        .run('RUNNING', updatedAt, task.task_id);
      this.db.prepare('INSERT INTO take_keys (request_key, task_id, fingerprint, execution_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(takeKey, task.task_id, keyFingerprint, waitingExecution.execution_id, updatedAt);
      return { task: this.getTask(task.task_id), execution: this.getExecution(waitingExecution.execution_id) };
      }
    }
    if (!sharedMission && activeCount + (waitingExecution ? 1 : 0) >= task.parallel_quota) {
      throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Task has reached its active Execution quota', { parallel_quota: task.parallel_quota });
    }
    if (task.state === 'BLOCKED') {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `Task is blocked: ${task.block_reason ?? 'unknown'}`);
    }
    const executionId = payload.execution_id ?? randomUUID();
    const createdAt = now();
    const leaseExpiresAt = payload.lease_expires_at ?? new Date(Date.now() + 30_000).toISOString();
    const execution = {
      execution_id: executionId,
      task_id: task.task_id,
      owner_ref: ownerRef,
      state: 'CREATED',
      state_version: 0,
      attempt_no: payload.attempt_no ?? 1,
      fencing_version: 1,
      runtime_generation: payload.runtime_generation ?? 1,
      lease_expires_at: leaseExpiresAt,
      heartbeat_at: createdAt,
      launch_token: payload.launch_token ?? randomUUID(),
      spec_version: task.spec_version,
      spec_hash: task.spec_hash,
      agent_prompt: agentPrompt,
      workspace_manifest_ref: payload.workspace_manifest_ref ?? `workspace://task/${task.task_id}`,
      input_material_refs: inputMaterialRefs,
      input_snapshot_hash: inputSnapshotHash,
      workspace_selection: {
        mode: workspaceMode,
        revision: payload.workspace_revision ?? null,
        source_execution_id: sourceExecutionId,
        source_workspace_ref: sourceWorkspaceRef,
      },
      candidate_material_id: null,
      workspace_ref: null,
      workspace_revision: null,
      workspace_content_hash: null,
      checkpoint_ref: null,
      checkpoint_hash: null,
      started_at: null,
      handoff_deadline: null,
      execution_deadline: null,
      handoff_reminder_sent_at: null,
      handoff_metadata: null,
      terminal_reason: null,
      instruction_version: 1,
      steer_material_refs: [],
      wait_condition: null,
      wait_deadline: null,
      resume_token: null,
      created_at: createdAt,
      updated_at: createdAt,
    };
    this.db.prepare(`INSERT INTO executions (
      execution_id, task_id, owner_ref, state, state_version, attempt_no, fencing_version, runtime_generation,
      lease_expires_at, heartbeat_at, launch_token, spec_version, spec_hash, agent_prompt, workspace_manifest_ref,
      input_material_refs_json, input_snapshot_hash, workspace_selection_json, candidate_material_id, workspace_ref, workspace_revision, workspace_content_hash, checkpoint_ref, checkpoint_hash,
      started_at, handoff_deadline, execution_deadline, handoff_reminder_sent_at, handoff_metadata_json, terminal_reason,
      instruction_version, steer_material_refs_json, wait_condition_json, wait_deadline, resume_token, created_at, updated_at
    ) VALUES (${Array.from({ length: 37 }, () => '?').join(', ')})`)
      .run(execution.execution_id, execution.task_id, execution.owner_ref, execution.state, execution.state_version,
        execution.attempt_no, execution.fencing_version, execution.runtime_generation, execution.lease_expires_at,
        execution.heartbeat_at, execution.launch_token, execution.spec_version, execution.spec_hash, execution.agent_prompt,
        execution.workspace_manifest_ref, json(execution.input_material_refs), execution.input_snapshot_hash, json(execution.workspace_selection), execution.candidate_material_id, execution.workspace_ref,
        execution.workspace_revision, execution.workspace_content_hash, execution.checkpoint_ref, execution.checkpoint_hash,
        execution.started_at, execution.handoff_deadline, execution.execution_deadline, execution.handoff_reminder_sent_at, json(execution.handoff_metadata), execution.terminal_reason,
        execution.instruction_version, json(execution.steer_material_refs), json(execution.wait_condition), execution.wait_deadline, execution.resume_token,
        execution.created_at, execution.updated_at);
    if (coreId !== null) {
      this.db.prepare('UPDATE executions SET core_id = ? WHERE execution_id = ?').run(coreId, executionId);
    }
    this.db.prepare('UPDATE tasks SET state = ?, state_version = state_version + 1, block_reason = NULL, eligible_at = CASE WHEN ? = \'OPEN\' THEN eligible_at ELSE NULL END, updated_at = ? WHERE task_id = ?')
      .run('RUNNING', 'RUNNING', createdAt, task.task_id);
    this.db.prepare('INSERT INTO take_keys (request_key, task_id, fingerprint, execution_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(takeKey, task.task_id, keyFingerprint, executionId, createdAt);
    return { task: this.getTask(task.task_id), execution: this.getExecution(executionId) };
  }

  #executionForWrite(envelope) {
    const executionId = requireString(envelope.execution_id, 'execution_id');
    const execution = this.getExecution(executionId);
    if (!execution) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown execution: ${executionId}`);
    if (envelope.task_id !== execution.task_id) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'task_id does not match execution');
    if (envelope.spec_version !== execution.spec_version) throw new SwarmEnvError(ERROR_CODES.STALE_VERSION, 'execution spec_version is stale');
    if (envelope.fencing_version !== execution.fencing_version) throw new SwarmEnvError(ERROR_CODES.FENCED, 'execution fencing_version is stale', { expected: execution.fencing_version });
    if (envelope.state_version !== execution.state_version) throw new SwarmEnvError(ERROR_CODES.STALE_VERSION, 'execution state_version is stale', { expected: execution.state_version });
    if (TERMINAL_EXECUTION_STATES.includes(execution.state)) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'terminal Execution cannot be modified');
    return execution;
  }

  #heartbeat(payload, envelope) {
    const execution = this.#executionForWrite(envelope);
    const updatedAt = now();
    const leaseExpiresAt = payload.lease_expires_at ?? new Date(Date.now() + 30_000).toISOString();
    this.db.prepare('UPDATE executions SET heartbeat_at = ?, lease_expires_at = ?, state_version = state_version + 1, updated_at = ? WHERE execution_id = ?')
      .run(updatedAt, leaseExpiresAt, updatedAt, execution.execution_id);
    return { execution: this.getExecution(execution.execution_id) };
  }

  #recordHandoffReminder(payload, envelope) {
    const execution = this.#executionForWrite(envelope);
    if (!['CREATED', 'RUNNING'].includes(execution.state)) return { execution };
    if (execution.handoff_reminder_sent_at) return { execution };
    const remindedAt = payload.reminded_at ?? now();
    if (typeof remindedAt !== 'string' || Number.isNaN(Date.parse(remindedAt))) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'reminded_at must be an ISO timestamp');
    }
    this.db.prepare(`UPDATE executions SET handoff_reminder_sent_at = ?, state_version = state_version + 1, updated_at = ? WHERE execution_id = ?`)
      .run(remindedAt, now(), execution.execution_id);
    return { execution: this.getExecution(execution.execution_id), reminded: true };
  }

  #handoffExecution(payload, envelope) {
    const execution = this.#executionForWrite(envelope);
    if (!['CREATED', 'RUNNING'].includes(execution.state)) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `cannot handoff Execution from ${execution.state}`);
    }
    const terminalState = payload.terminal_state ?? 'FENCED';
    if (!['EXPIRED', 'FENCED'].includes(terminalState)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'handoff terminal_state must be EXPIRED or FENCED');
    }
    const terminalReason = requireString(payload.terminal_reason ?? payload.reason, 'terminal_reason');
    const handoffMetadata = payload.handoff_metadata ?? payload.handoff ?? {};
    if (!handoffMetadata || typeof handoffMetadata !== 'object' || Array.isArray(handoffMetadata)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'handoff_metadata must be an object');
    }
    const checkpointRef = payload.checkpoint_ref ?? execution.checkpoint_ref;
    const checkpointHash = payload.checkpoint_hash ?? execution.checkpoint_hash;
    if (checkpointRef !== null && checkpointRef !== undefined) requireString(checkpointRef, 'checkpoint_ref');
    if (checkpointHash !== null && checkpointHash !== undefined) requireString(checkpointHash, 'checkpoint_hash');
    if ((checkpointRef && !checkpointHash) || (!checkpointRef && checkpointHash)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'checkpoint_ref and checkpoint_hash must be provided together');
    }
    const updatedAt = now();
    this.db.prepare(`UPDATE executions SET state = ?, fencing_version = ?, checkpoint_ref = COALESCE(?, checkpoint_ref), checkpoint_hash = COALESCE(?, checkpoint_hash), workspace_ref = COALESCE(?, workspace_ref), workspace_revision = COALESCE(?, workspace_revision), workspace_content_hash = COALESCE(?, workspace_content_hash), handoff_metadata_json = ?, terminal_reason = ?, wait_condition_json = NULL, wait_deadline = NULL, resume_token = NULL, state_version = state_version + 1, updated_at = ? WHERE execution_id = ?`)
      .run(terminalState, execution.fencing_version + 1, checkpointRef ?? null, checkpointHash ?? null,
        payload.workspace_ref ?? null, payload.workspace_revision ?? null, payload.workspace_content_hash ?? null,
        json(handoffMetadata), terminalReason, updatedAt, execution.execution_id);
    const task = this.getTask(execution.task_id);
    if (!TERMINAL_TASK_STATES.includes(task.state)) this.#refreshTaskState(execution.task_id, { updatedAt });
    return { execution: this.getExecution(execution.execution_id), task: this.getTask(execution.task_id), handoff: handoffMetadata };
  }

  #startExecution(payload, envelope) {
    const execution = this.#executionForWrite(envelope);
    if (execution.state !== 'CREATED') throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `cannot start Execution from ${execution.state}`);
    const coreId = payload.core_id ?? payload.coreId ?? null;
    if (coreId !== null) {
      requireString(coreId, 'core_id');
      if (execution.core_id !== null && execution.core_id !== coreId) {
        throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Execution is permanently bound to another Core', {
          execution_id: execution.execution_id,
          expected_core_id: execution.core_id,
          received_core_id: coreId,
        });
      }
      const occupied = this.getActiveExecutionForCore(coreId);
      if (occupied && occupied.execution_id !== execution.execution_id) {
        throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Core already owns an active Execution', {
          core_id: coreId,
          execution_id: occupied.execution_id,
        });
      }
    }
    const updatedAt = now();
    const startedAt = payload.started_at ?? updatedAt;
    if (typeof startedAt !== 'string' || Number.isNaN(Date.parse(startedAt))) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'started_at must be an ISO timestamp');
    const handoffDeadline = payload.handoff_deadline ?? null;
    const executionDeadline = payload.execution_deadline ?? null;
    for (const [name, value] of [['handoff_deadline', handoffDeadline], ['execution_deadline', executionDeadline]]) {
      if (value !== null && (typeof value !== 'string' || Number.isNaN(Date.parse(value)))) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `${name} must be an ISO timestamp`);
    }
    this.db.prepare('UPDATE executions SET state = ?, core_id = COALESCE(?, core_id), started_at = ?, handoff_deadline = ?, execution_deadline = ?, handoff_reminder_sent_at = NULL, terminal_reason = NULL, state_version = state_version + 1, updated_at = ? WHERE execution_id = ?')
      .run('RUNNING', coreId, startedAt, handoffDeadline, executionDeadline, updatedAt, execution.execution_id);
    return { execution: this.getExecution(execution.execution_id) };
  }

  #resumeExecution(payload, envelope) {
    const execution = this.#executionForWrite(envelope);
    if (execution.state !== 'WAITING' && execution.state !== 'CREATED') throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `cannot resume Execution from ${execution.state}`);
    const coreId = payload.core_id ?? payload.coreId ?? null;
    if (coreId !== null) {
      requireString(coreId, 'core_id');
      if (execution.core_id !== null && execution.core_id !== coreId) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Execution is permanently bound to another Core');
      const occupied = this.getActiveExecutionForCore(coreId);
      if (occupied && occupied.execution_id !== execution.execution_id) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Core already owns an active Execution', { core_id: coreId, execution_id: occupied.execution_id });
    }
    const updatedAt = now();
    this.db.prepare('UPDATE executions SET state = ?, core_id = COALESCE(?, core_id), wait_condition_json = NULL, wait_deadline = NULL, resume_token = NULL, state_version = state_version + 1, updated_at = ? WHERE execution_id = ?')
      .run('RUNNING', coreId, updatedAt, execution.execution_id);
    this.db.prepare('UPDATE tasks SET state = ?, state_version = state_version + 1, block_reason = NULL, updated_at = ? WHERE task_id = ?')
      .run('RUNNING', updatedAt, execution.task_id);
    return { execution: this.getExecution(execution.execution_id), task: this.getTask(execution.task_id) };
  }

  #validateWaitCondition(execution, task, rawCondition, rawDeadline = null) {
    if (!rawCondition || typeof rawCondition !== 'object' || Array.isArray(rawCondition)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'wait_condition is required');
    if (task?.completion_contract?.normal_flow === true) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'normal_flow Tasks use execution_block with a typed dependency instead of request_wait');
    }
    const waitCondition = { ...rawCondition };
    if (waitCondition.type === 'check_result_arrived' && waitCondition.candidate_material_id !== undefined) {
      requireString(waitCondition.candidate_material_id, 'wait_condition.candidate_material_id');
      if (waitCondition.candidate_material_id !== execution.candidate_material_id) throw new SwarmEnvError(ERROR_CODES.FENCED, 'wait_condition candidate does not match the current Execution candidate');
      if (!waitCondition.check_request_key && !waitCondition.request_key) waitCondition.check_request_key = waitCondition.candidate_material_id;
    }
    const allowed = new Set(['child_task_terminal', 'children_all_terminal', 'parent_review', 'check_result_arrived', 'checker_health', 'timer']);
    if (!allowed.has(waitCondition.type)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'unsupported wait_condition type');
    if (waitCondition.type === 'parent_review' && !task.parent_id) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'parent_review requires a child Task');
    if (waitCondition.type === 'parent_review' && task.completion_contract?.normal_flow === true) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'normal_flow Tasks do not enter parent_review');
    }
    if (waitCondition.type === 'child_task_terminal') {
      const childTaskId = requireString(waitCondition.child_task_id ?? waitCondition.task_id, 'wait_condition.child_task_id');
      const child = this.getTask(childTaskId);
      if (!child || child.parent_id !== task.task_id) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'child_task_terminal must reference a direct child Task');
      if (TERMINAL_TASK_STATES.includes(child.state)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'child_task_terminal condition is already satisfied');
    }
    if (waitCondition.type === 'children_all_terminal') {
      if (!Array.isArray(waitCondition.child_task_ids) || waitCondition.child_task_ids.length === 0) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'children_all_terminal requires at least one child_task_id');
      const childIds = [...new Set(waitCondition.child_task_ids.map((id) => requireString(id, 'wait_condition.child_task_ids')))];
      const children = childIds.map((id) => this.getTask(id));
      if (children.some((child) => !child || child.parent_id !== task.task_id)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'children_all_terminal must reference direct child Tasks');
      if (children.every((child) => TERMINAL_TASK_STATES.includes(child.state))) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'children_all_terminal condition is already satisfied');
      waitCondition.child_task_ids = childIds;
    }
    if (waitCondition.type === 'check_result_arrived') requireString(waitCondition.check_request_key ?? waitCondition.request_key, 'wait_condition.check_request_key');
    if (waitCondition.type === 'checker_health') {
      requireString(waitCondition.preflight_key, 'wait_condition.preflight_key');
      requireString(waitCondition.health_fingerprint, 'wait_condition.health_fingerprint');
      if (waitCondition.retry_after !== undefined) requireString(waitCondition.retry_after, 'wait_condition.retry_after');
    }
    const waitDeadline = rawDeadline ?? waitCondition.deadline ?? null;
    if (waitCondition.type === 'timer' && !waitDeadline) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'timer wait requires a deadline');
    if (waitDeadline !== null && (typeof waitDeadline !== 'string' || Number.isNaN(Date.parse(waitDeadline)))) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'wait_deadline must be an ISO timestamp');
    return { waitCondition, waitDeadline };
  }

  #requestWait(payload, envelope) {
    const executionId = requireString(envelope.execution_id, 'execution_id');
    const waitKey = requireString(payload.wait_key ?? payload.request_key ?? payload.checkpoint_ref, 'wait_key');
    const waitFingerprint = stableStringify({ operation: 'request_wait', payload: { ...payload, wait_key: waitKey }, execution_id: executionId });
    const existingKey = this.db.prepare('SELECT * FROM wait_keys WHERE request_key = ?').get(waitKey);
    if (existingKey) {
      if (existingKey.execution_id !== executionId || existingKey.fingerprint !== waitFingerprint) {
        throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'wait_key was reused with another payload');
      }
      const current = this.getExecution(executionId);
      return { execution: current, task: this.getTask(current.task_id) };
    }
    const execution = this.#executionForWrite(envelope);
    requireString(payload.checkpoint_ref, 'checkpoint_ref');
    requireString(payload.checkpoint_hash, 'checkpoint_hash');
    if (execution.checkpoint_ref !== payload.checkpoint_ref || execution.checkpoint_hash !== payload.checkpoint_hash) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'request_wait requires a checkpoint already saved for this Execution');
    }
    const task = this.getTask(execution.task_id);
    const { waitCondition, waitDeadline } = this.#validateWaitCondition(
      execution,
      task,
      payload.wait_condition,
      payload.wait_deadline ?? payload.wait_condition?.deadline ?? null,
    );
    const updatedAt = now();
    this.db.prepare(`UPDATE executions SET state = 'WAITING', checkpoint_ref = ?, checkpoint_hash = ?, workspace_ref = COALESCE(?, workspace_ref), workspace_revision = COALESCE(?, workspace_revision), workspace_content_hash = COALESCE(?, workspace_content_hash), wait_condition_json = ?, wait_deadline = ?, resume_token = ?, state_version = state_version + 1, updated_at = ? WHERE execution_id = ?`)
      .run(payload.checkpoint_ref, payload.checkpoint_hash, payload.workspace_ref ?? null, payload.workspace_revision ?? null, payload.workspace_content_hash ?? null,
      json(waitCondition), waitDeadline, payload.resume_token ?? randomUUID(), updatedAt, execution.execution_id);
    this.#refreshTaskState(execution.task_id, { updatedAt });
    this.db.prepare('INSERT INTO wait_keys (request_key, execution_id, fingerprint, created_at) VALUES (?, ?, ?, ?)')
      .run(waitKey, execution.execution_id, waitFingerprint, updatedAt);
    return { execution: this.getExecution(execution.execution_id), task: this.getTask(execution.task_id) };
  }

  #saveWorkspaceRevision(payload, envelope) {
    const execution = this.#executionForWrite(envelope);
    requireString(payload.workspace_ref, 'workspace_ref');
    requireString(payload.workspace_content_hash, 'workspace_content_hash');
    if (!Number.isInteger(payload.workspace_revision) || payload.workspace_revision < 1) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'workspace_revision must be a positive integer');
    }
    if (execution.workspace_ref && execution.workspace_ref !== payload.workspace_ref) {
      throw new SwarmEnvError(ERROR_CODES.FENCED, 'workspace_ref does not match the Execution workspace');
    }
    const expectedRevision = execution.workspace_revision === null ? payload.workspace_revision : execution.workspace_revision + 1;
    if (payload.workspace_revision !== expectedRevision) {
      throw new SwarmEnvError(ERROR_CODES.STALE_VERSION, 'workspace_revision is not the next revision', { expected: expectedRevision });
    }
    const updatedAt = now();
    this.db.prepare('UPDATE executions SET workspace_ref = ?, workspace_revision = ?, workspace_content_hash = ?, state_version = state_version + 1, updated_at = ? WHERE execution_id = ?')
      .run(payload.workspace_ref, payload.workspace_revision, payload.workspace_content_hash, updatedAt, execution.execution_id);
    return { execution: this.getExecution(execution.execution_id) };
  }

  #saveCheckpoint(payload, envelope) {
    const execution = this.#executionForWrite(envelope);
    requireString(payload.checkpoint_ref, 'checkpoint_ref');
    requireString(payload.checkpoint_hash, 'checkpoint_hash');
    if (payload.workspace_ref && execution.workspace_ref && payload.workspace_ref !== execution.workspace_ref) {
      throw new SwarmEnvError(ERROR_CODES.FENCED, 'workspace_ref does not match the Execution workspace');
    }
    if (payload.workspace_revision !== undefined && payload.workspace_revision !== execution.workspace_revision) {
      throw new SwarmEnvError(ERROR_CODES.STALE_VERSION, 'checkpoint workspace_revision is stale', { expected: execution.workspace_revision });
    }
    const updatedAt = now();
    this.db.prepare('UPDATE executions SET checkpoint_ref = ?, checkpoint_hash = ?, state_version = state_version + 1, updated_at = ? WHERE execution_id = ?')
      .run(payload.checkpoint_ref, payload.checkpoint_hash, updatedAt, execution.execution_id);
    return { execution: this.getExecution(execution.execution_id) };
  }

  #stopExecution(payload, envelope) {
    const execution = this.#executionForWrite(envelope);
    const terminalState = payload.terminal_state ?? 'FAILED';
    if (!TERMINAL_EXECUTION_STATES.includes(terminalState)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'terminal_state must be an Execution terminal state');
    const terminalReason = payload.terminal_reason ?? payload.reason ?? terminalState.toLowerCase();
    if (typeof terminalReason !== 'string' || terminalReason.length === 0) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'terminal_reason must be a non-empty string');
    }
    const updatedAt = now();
    const handoffMetadata = payload.handoff_metadata && typeof payload.handoff_metadata === 'object' && !Array.isArray(payload.handoff_metadata)
      ? json(payload.handoff_metadata)
      : null;
    this.db.prepare('UPDATE executions SET state = ?, terminal_reason = ?, handoff_metadata_json = COALESCE(?, handoff_metadata_json), state_version = state_version + 1, updated_at = ? WHERE execution_id = ?')
      .run(terminalState, terminalReason, handoffMetadata, updatedAt, execution.execution_id);
    const task = this.getTask(execution.task_id);
    if (!TERMINAL_TASK_STATES.includes(task.state)) this.#refreshTaskState(execution.task_id, { updatedAt, cancelIfIdle: terminalState === 'CANCELLED' });
    return { execution: this.getExecution(execution.execution_id), task: this.getTask(execution.task_id) };
  }

  #expireExecution(payload, envelope) {
    const execution = this.#executionForWrite(envelope);
    const updatedAt = now();
    const terminalReason = payload.terminal_reason ?? payload.reason ?? 'lease_expired';
    if (typeof terminalReason !== 'string' || terminalReason.length === 0) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'terminal_reason must be a non-empty string');
    }
    this.db.prepare('UPDATE executions SET state = ?, fencing_version = fencing_version + 1, runtime_generation = COALESCE(?, runtime_generation), terminal_reason = ?, state_version = state_version + 1, updated_at = ? WHERE execution_id = ?')
      .run('EXPIRED', payload.runtime_generation ?? null, terminalReason, updatedAt, execution.execution_id);
    const task = this.getTask(execution.task_id);
    if (!TERMINAL_TASK_STATES.includes(task.state)) this.#refreshTaskState(execution.task_id, { updatedAt });
    return { execution: this.getExecution(execution.execution_id), task: this.getTask(execution.task_id) };
  }

  #fenceExecution(payload, envelope) {
    const execution = this.#executionForWrite(envelope);
    const updatedAt = now();
    const terminalReason = payload.terminal_reason ?? payload.reason ?? 'fenced';
    if (typeof terminalReason !== 'string' || terminalReason.length === 0) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'terminal_reason must be a non-empty string');
    }
    this.db.prepare('UPDATE executions SET state = ?, fencing_version = fencing_version + 1, runtime_generation = COALESCE(?, runtime_generation), terminal_reason = ?, state_version = state_version + 1, updated_at = ? WHERE execution_id = ?')
      .run('FENCED', payload.runtime_generation ?? null, terminalReason, updatedAt, execution.execution_id);
    const task = this.getTask(execution.task_id);
    if (!TERMINAL_TASK_STATES.includes(task.state)) this.#refreshTaskState(execution.task_id, { updatedAt });
    return { execution: this.getExecution(execution.execution_id), task: this.getTask(execution.task_id) };
  }

  #recoverExecution(payload, envelope) {
    const execution = this.#executionForWrite(envelope);
    if (execution.state !== 'RUNNING') throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `cannot recover Execution in ${execution.state}`);
    const updatedAt = now();
    const nextLease = payload.lease_expires_at ?? new Date(Date.now() + 30_000).toISOString();
    this.db.prepare(`UPDATE executions SET state = 'CREATED', fencing_version = fencing_version + 1,
      runtime_generation = COALESCE(?, runtime_generation), session_generation = session_generation + 1, attempt_no = attempt_no + 1,
      lease_expires_at = ?, heartbeat_at = ?, agent_prompt = ?, state_version = state_version + 1, updated_at = ?
      WHERE execution_id = ?`)
      .run(payload.runtime_generation ?? null, nextLease, updatedAt, payload.agent_prompt ?? execution.agent_prompt, updatedAt, execution.execution_id);
    this.db.prepare("UPDATE tasks SET state = 'RUNNING', block_reason = NULL, state_version = state_version + 1, updated_at = ? WHERE task_id = ?")
      .run(updatedAt, execution.task_id);
    return { execution: this.getExecution(execution.execution_id), task: this.getTask(execution.task_id) };
  }

  #checkWorkspace(payload, envelope) {
    const execution = this.#executionForWrite(envelope);
    const candidateMaterialId = requireString(payload.candidate_material_id, 'candidate_material_id');
    if (this.contextService) {
      const material = this.contextService.getMaterial(candidateMaterialId);
      if (!material) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown candidate Material: ${candidateMaterialId}`);
      if (material.source_task !== execution.task_id || material.source_execution !== execution.execution_id) {
        throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'candidate Material must come from the current Execution');
      }
      const requiredCandidate = this.getTask(execution.task_id).completion_contract.required_candidate;
      if (requiredCandidate?.kind && material.kind !== requiredCandidate.kind) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'candidate Material kind does not satisfy required_candidate');
      }
      if (requiredCandidate?.scope && material.scope !== requiredCandidate.scope) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'candidate Material scope does not satisfy required_candidate');
      }
    }
    const updatedAt = now();
    this.db.prepare('UPDATE executions SET candidate_material_id = ?, state_version = state_version + 1, updated_at = ? WHERE execution_id = ?')
      .run(candidateMaterialId, updatedAt, execution.execution_id);
    return { execution: this.getExecution(execution.execution_id), task: this.getTask(execution.task_id) };
  }

  #applyCheckResult(payload, envelope) {
    const checkResultId = requireString(payload.check_result_id, 'check_result_id');
    const result = this.getCheckResult(checkResultId);
    if (!result) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown CheckResult: ${checkResultId}`);
    const task = this.getTask(result.target_task_id);
    if (!task) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown target Task: ${result.target_task_id}`);
    if (envelope.task_id !== null && envelope.task_id !== task.task_id) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'CheckResult target does not match the operation envelope');
    }
    if (result.status === 'APPLIED' || result.status === 'IGNORED') return { task, check_result: result, execution: this.#latestExecution(task.task_id) };
    if (result.status !== 'RECEIVED') throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `CheckResult is not ready: ${result.status}`);
    if (TERMINAL_TASK_STATES.includes(task.state)) {
      const updatedAt = now();
      this.db.prepare("UPDATE check_results SET status = 'IGNORED', updated_at = ? WHERE check_result_id = ?").run(updatedAt, checkResultId);
      return { task, check_result: this.getCheckResult(checkResultId), execution: this.#latestExecution(task.task_id) };
    }
    // A CheckResult is also a synchronous diagnostic for Tasks whose own
    // completion contract is material- or coordination-based.  Keep the
    // contract requirement for automatic completion below, but do not turn it
    // into a capability gate: authorized Executions may ask Judge to inspect
    // an intermediate candidate and continue iterating in place.
    const requiredCheck = task.completion_contract.required_check ?? null;
    let execution;
    if (envelope.execution_id !== null) {
      execution = this.#executionForWrite(envelope);
      if (execution.task_id !== task.task_id) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Execution does not belong to CheckResult target Task');
    } else {
      execution = this.#latestExecution(task.task_id, true);
      if (!execution) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'CheckResult application needs an active Execution');
    }
    if (result.execution_id && result.execution_id !== execution.execution_id) {
      throw new SwarmEnvError(ERROR_CODES.FENCED, 'CheckResult belongs to another Execution');
    }
    const inputMetadata = task.workspace?.input_metadata ?? {};
    const expectedCheckerRef = requiredCheck?.checker_ref ?? inputMetadata.checker_ref ?? null;
    const expectedCheckerVersion = requiredCheck?.checker_version ?? inputMetadata.checker_version ?? null;
    const expectedEnvironmentRef = requiredCheck?.environment_ref ?? inputMetadata.environment_ref ?? null;
    const expectedInputSnapshotHash = requiredCheck?.input_snapshot_hash ?? inputMetadata.input_snapshot_hash ?? null;
    if (result.target_spec_version !== task.spec_version || result.input_snapshot_hash !== execution.input_snapshot_hash ||
      (expectedCheckerRef && result.checker_ref !== expectedCheckerRef) ||
      (expectedCheckerVersion && result.checker_version !== expectedCheckerVersion) ||
      (expectedEnvironmentRef && result.environment_ref !== expectedEnvironmentRef) ||
      (expectedInputSnapshotHash && result.input_snapshot_hash !== expectedInputSnapshotHash)) {
      throw new SwarmEnvError(ERROR_CODES.STALE_VERSION, 'CheckResult binding does not match the current Task contract or Execution input');
    }
    if (execution.candidate_material_id !== result.candidate_material_id) {
      throw new SwarmEnvError(ERROR_CODES.STALE_VERSION, 'CheckResult candidate does not match the current Execution candidate');
    }
    const updatedAt = now();
    this.db.prepare("UPDATE check_results SET status = 'APPLIED', applied_task_state_version = ?, applied_at = ?, updated_at = ? WHERE check_result_id = ?")
      .run(task.state_version + 1, updatedAt, updatedAt, checkResultId);
    if (result.result_class === 'infrastructure_failure' && !requiredCheck) {
      // Diagnostic checker/service failures are data for a research or
      // coordination Task.  They must not manufacture a dependency block or
      // a repair Task when the Task did not ask Judge to establish completion.
    } else if (result.result_class === 'infrastructure_failure') {
      const deferInfrastructureBlock = payload.defer_execution_block === true;
      if (task.completion_contract?.normal_flow === true && !deferInfrastructureBlock) {
        const blockReason = `checker_unavailable:${result.diagnostic_code ?? 'unknown'}`;
        const dependency = {
          dependency_kind: 'CHECK_RESULT',
          check_result_id: checkResultId,
          requirement: result.evidence?.preflight_key && result.evidence?.health_fingerprint
            ? { checker_health: { preflight_key: result.evidence.preflight_key, health_fingerprint: result.evidence.health_fingerprint } }
            : {},
        };
        const blocked = this.#blockTask({ block_reason: blockReason, dependency, terminal_state: 'FAILED' }, envelope);
        return { task: blocked.task, execution: blocked.execution, check_result: this.getCheckResult(checkResultId), dependency: blocked.dependency };
      }
      if (!result.retryable || result.evidence?.retry_exhausted) {
        if (deferInfrastructureBlock) {
          return { task: this.getTask(task.task_id), execution: this.getExecution(execution.execution_id), check_result: this.getCheckResult(checkResultId) };
        }
        const blockReason = `checker_unavailable:${result.diagnostic_code ?? 'unknown'}`;
        const blocked = this.#blockTask({ block_reason: blockReason, terminal_state: 'FAILED' }, envelope);
        return { task: blocked.task, execution: blocked.execution, check_result: this.getCheckResult(checkResultId) };
      } else if (execution.state === 'WAITING') {
        // A retryable infrastructure result is not mathematical feedback. Keep
        // the checkpointed responsibility resumable while allowing the next
        // Agent/Core to try again after the health gate changes.
        const preflightKey = result.evidence?.preflight_key;
        const healthFingerprint = result.evidence?.health_fingerprint;
        const waitCondition = preflightKey && healthFingerprint
          ? {
            type: 'checker_health',
            preflight_key: preflightKey,
            health_fingerprint: healthFingerprint,
            diagnostic_code: result.diagnostic_code ?? null,
            candidate_material_id: result.candidate_material_id,
          }
          : execution.wait_condition;
        this.db.prepare("UPDATE executions SET state = 'WAITING', wait_condition_json = ?, wait_deadline = NULL, resume_token = ?, state_version = state_version + 1, updated_at = ? WHERE execution_id = ?")
          .run(waitCondition ? json(waitCondition) : null, randomUUID(), updatedAt, execution.execution_id);
        this.#refreshTaskState(task.task_id, { updatedAt });
      }
    } else if (result.verdict === 'PASS' && requiredCheck) {
      const completion = this.#completion(task, execution, checkResultId);
      if (completion.satisfied) {
        this.db.prepare("UPDATE executions SET state = 'SUCCEEDED', wait_condition_json = NULL, wait_deadline = NULL, resume_token = NULL, state_version = state_version + 1, updated_at = ? WHERE execution_id = ?")
          .run(updatedAt, execution.execution_id);
        this.db.prepare('UPDATE tasks SET state = ?, state_version = state_version + 1, block_reason = NULL, updated_at = ? WHERE task_id = ?')
          .run(taskCompletionState(task), updatedAt, task.task_id);
      }
    } else if (execution.state === 'WAITING') {
      // A failed check wakes the responsibility for another Agent. Keep the
      // durable Workspace and wait lineage visible as a resumable WAITING
      // Execution; the next explicit take will hand it over and bind it.
      this.db.prepare("UPDATE executions SET state = 'WAITING', wait_deadline = NULL, resume_token = NULL, state_version = state_version + 1, updated_at = ? WHERE execution_id = ?")
        .run(updatedAt, execution.execution_id);
      this.#refreshTaskState(task.task_id, { updatedAt });
    }
    return { task: this.getTask(task.task_id), execution: this.getExecution(execution.execution_id), check_result: this.getCheckResult(checkResultId) };
  }

  #wakeExecution(payload, envelope) {
    const executionId = requireString(envelope.execution_id, 'execution_id');
    const current = this.getExecution(executionId);
    if (!current) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown execution: ${executionId}`);
    const wakeKey = requireString(payload.wake_key ?? payload.request_key ?? current.resume_token, 'wake_key');
    const fingerprint = stableStringify({ operation: 'wake_execution', payload: { ...payload, wake_key: wakeKey }, execution_id: executionId });
    const existing = this.db.prepare('SELECT * FROM wake_keys WHERE request_key = ?').get(wakeKey);
    if (existing) {
      if (existing.execution_id !== executionId || existing.fingerprint !== fingerprint) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'wake_key was reused with another payload');
      return { execution: current, task: this.getTask(current.task_id) };
    }
    const execution = this.#executionForWrite(envelope);
    if (execution.state !== 'WAITING') throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `cannot wake Execution from ${execution.state}`);
    const coreId = payload.core_id ?? payload.coreId ?? null;
    if (coreId !== null) {
      requireString(coreId, 'core_id');
      if (execution.core_id !== null && execution.core_id !== coreId) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Execution is permanently bound to another Core');
      const occupied = this.getActiveExecutionForCore(coreId);
      if (occupied && occupied.execution_id !== execution.execution_id) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Core already owns an active Execution', { core_id: coreId, execution_id: occupied.execution_id });
    }
    const updatedAt = now();
    this.db.prepare("UPDATE executions SET state = 'RUNNING', core_id = COALESCE(?, core_id), wait_condition_json = NULL, wait_deadline = NULL, resume_token = NULL, state_version = state_version + 1, updated_at = ? WHERE execution_id = ?")
      .run(coreId, updatedAt, execution.execution_id);
    this.#refreshTaskState(execution.task_id, { updatedAt });
    this.db.prepare('INSERT INTO wake_keys (request_key, execution_id, fingerprint, created_at) VALUES (?, ?, ?, ?)')
      .run(wakeKey, execution.execution_id, fingerprint, updatedAt);
    return { execution: this.getExecution(execution.execution_id), task: this.getTask(execution.task_id) };
  }

  #assertAcceptanceAuthority(target, envelope) {
    const requiresParentReview = target.parent_id && target.completion_contract.parent_review === true;
    const authorityTaskId = requiresParentReview ? target.parent_id : target.task_id;
    if (envelope.task_id !== authorityTaskId) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'operation envelope is not the acceptance authority');
    if (requiresParentReview) {
      const parentExecution = this.#executionForWrite(envelope);
      if (parentExecution.owner_ref !== envelope.actor_ref) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'only the Parent Task current owner may review a child');
      return parentExecution;
    }
    if (envelope.execution_id === null) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Task owner acceptance requires the current Execution');
    const execution = this.#executionForWrite(envelope);
    if (execution.owner_ref !== envelope.actor_ref) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'only the current Task owner may accept the Task');
    return execution;
  }

  #refreshTaskState(taskId, { updatedAt = now(), cancelIfIdle = false } = {}) {
    const task = this.getTask(taskId);
    if (!task || TERMINAL_TASK_STATES.includes(task.state)) return task;
    const active = this.db.prepare("SELECT state FROM executions WHERE task_id = ? AND state IN ('CREATED', 'RUNNING', 'WAITING')").all(taskId);
    const nextState = active.length === 0
      ? (cancelIfIdle ? taskCancellationState(task) : 'OPEN')
      : (active.some((execution) => execution.state === 'RUNNING')
        ? 'RUNNING'
        : (active.some((execution) => execution.state === 'WAITING') ? 'WAITING' : 'OPEN'));
    if (task.state === nextState) return task;
    this.db.prepare('UPDATE tasks SET state = ?, state_version = state_version + 1, block_reason = NULL, eligible_at = CASE WHEN ? = \'OPEN\' THEN COALESCE(eligible_at, ?) ELSE NULL END, cancelled_at = CASE WHEN ? IN (\'CANCELLED\', \'CANCELED\') THEN ? ELSE cancelled_at END, updated_at = ? WHERE task_id = ?')
      .run(nextState, nextState, updatedAt, nextState, ['CANCELLED', 'CANCELED'].includes(nextState) ? updatedAt : null, updatedAt, taskId);
    return this.getTask(taskId);
  }

  #latestExecution(taskId, activeOnly = false) {
    const activeClause = activeOnly ? "AND state IN ('CREATED', 'RUNNING', 'WAITING')" : '';
    return rowToExecution(this.db.prepare(`SELECT * FROM executions WHERE task_id = ? ${activeClause} ORDER BY attempt_no DESC, created_at DESC LIMIT 1`).get(taskId));
  }

  #expiredReworkCanBeClaimed(task, executions, nowMs = Date.now()) {
    const active = executions.filter((execution) => ['CREATED', 'RUNNING'].includes(execution.state));
    if (active.length !== 1 || task.parallel_quota !== 1) return false;
    const execution = active[0];
    if (execution.state !== 'CREATED' || execution.instruction_version <= 1) return false;
    const latest = this.#latestExecution(task.task_id, true);
    return latest?.execution_id === execution.execution_id &&
      (!execution.lease_expires_at || Date.parse(execution.lease_expires_at) <= nowMs);
  }

  #isWaitingResumable(execution, nowMs = Date.now()) {
    const condition = execution.wait_condition;
    if (!condition || condition.type === 'parent_review') return false;
    if (condition.type === 'timer') return !execution.wait_deadline || Date.parse(execution.wait_deadline) <= nowMs;
    if (condition.type === 'child_task_terminal') {
      const childTaskId = condition.child_task_id ?? condition.task_id;
      const child = childTaskId ? this.getTask(childTaskId) : null;
      if (!child) return false;
      if (TERMINAL_TASK_STATES.includes(child.state)) return true;
      // A child delivers a parent-review event by entering parent_review.
      // The parent must wake for both successful and failed child results:
      // it may accept a satisfied contract or request focused rework. Waiting
      // for a terminal child alone would deadlock the parent on a failed
      // candidate that still requires review.
      if (child.state !== 'WAITING' || !child.parent_id) return false;
      const childExecution = this.#latestExecution(child.task_id, true);
      return Boolean(childExecution?.wait_condition?.type === 'parent_review');
    }
    if (condition.type === 'children_all_terminal') {
      const childIds = Array.isArray(condition.child_task_ids) ? condition.child_task_ids : [];
      return childIds.length > 0 && childIds.every((childTaskId) => {
        const child = this.getTask(childTaskId);
        if (!child) return false;
        if (TERMINAL_TASK_STATES.includes(child.state)) return true;
        if (child.state !== 'WAITING' || !child.parent_id) return false;
        const childExecution = this.#latestExecution(child.task_id, true);
        return Boolean(childExecution?.wait_condition?.type === 'parent_review');
      });
    }
    if (condition.type === 'check_result_arrived') {
      const requestKey = condition.check_request_key ?? condition.request_key;
      if (!requestKey) return false;
      // Agent-facing candidate submission does not know the runner's internal
      // Judge request key. In that path the agent uses its candidate Material
      // ID as the wait key, while the Judge stores the generated request key
      // and the same candidate ID separately. Bind the fallback to this
      // Execution so an unrelated CheckResult cannot wake the Task.
      const candidateMaterialId = condition.candidate_material_id ??
        (requestKey === execution.candidate_material_id ? requestKey : null);
      const result = this.db.prepare(`SELECT status FROM check_results
        WHERE execution_id = ? AND target_task_id = ?
          AND (request_key = ? OR (? IS NOT NULL AND candidate_material_id = ?))
        ORDER BY created_at DESC LIMIT 1`).get(
        execution.execution_id,
        execution.task_id,
        requestKey,
        candidateMaterialId,
        candidateMaterialId,
      );
      return Boolean(result && ['RECEIVED', 'APPLIED', 'IGNORED'].includes(result.status));
    }
    if (condition.type === 'checker_health') {
      // Judge owns checker health persistence. Task Service receives a small
      // read seam from the composition root instead of reaching into the
      // Judge schema directly.
      const health = this.checkerHealthReader?.(condition.preflight_key) ?? null;
      if (!health) return false;
      // A checker-health wait is a health gate, not a timer.  The same
      // unavailable fingerprint must not wake the Execution and submit the
      // same candidate again.  Only a newly observed health fingerprint may
      // make this responsibility eligible again.
      return health.health_fingerprint !== condition.health_fingerprint;
    }
    return false;
  }

  #createRecoveryExecution(task, previous, steerRefs, createdAt) {
    const executionId = randomUUID();
    const execution = {
      execution_id: executionId,
      task_id: task.task_id,
      owner_ref: previous.owner_ref,
      state: 'CREATED',
      state_version: 0,
      attempt_no: previous.attempt_no + 1,
      fencing_version: 1,
      runtime_generation: previous.runtime_generation,
      lease_expires_at: new Date(Date.now() + 30_000).toISOString(),
      heartbeat_at: createdAt,
      launch_token: randomUUID(),
      spec_version: previous.spec_version,
      spec_hash: previous.spec_hash,
      agent_prompt: previous.agent_prompt,
      workspace_manifest_ref: previous.workspace_manifest_ref,
      input_material_refs: previous.input_material_refs,
      input_snapshot_hash: previous.input_snapshot_hash,
      workspace_selection: previous.workspace_selection,
      candidate_material_id: null,
      workspace_ref: previous.workspace_ref,
      workspace_revision: previous.workspace_revision,
      workspace_content_hash: previous.workspace_content_hash,
      checkpoint_ref: previous.checkpoint_ref,
      checkpoint_hash: previous.checkpoint_hash,
      instruction_version: previous.instruction_version + 1,
      steer_material_refs: steerRefs,
      wait_condition: null,
      wait_deadline: null,
      resume_token: null,
      created_at: createdAt,
      updated_at: createdAt,
    };
    this.db.prepare(`INSERT INTO executions (
      execution_id, task_id, owner_ref, state, state_version, attempt_no, fencing_version, runtime_generation,
      lease_expires_at, heartbeat_at, launch_token, spec_version, spec_hash, agent_prompt, workspace_manifest_ref,
      input_material_refs_json, input_snapshot_hash, workspace_selection_json, candidate_material_id, workspace_ref, workspace_revision, workspace_content_hash,
      checkpoint_ref, checkpoint_hash, instruction_version, steer_material_refs_json, wait_condition_json, wait_deadline, resume_token, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(execution.execution_id, execution.task_id, execution.owner_ref, execution.state, execution.state_version,
        execution.attempt_no, execution.fencing_version, execution.runtime_generation, execution.lease_expires_at,
        execution.heartbeat_at, execution.launch_token, execution.spec_version, execution.spec_hash, execution.agent_prompt,
        execution.workspace_manifest_ref, json(execution.input_material_refs), execution.input_snapshot_hash, json(execution.workspace_selection), execution.candidate_material_id,
        execution.workspace_ref, execution.workspace_revision, execution.workspace_content_hash, execution.checkpoint_ref, execution.checkpoint_hash,
        execution.instruction_version, json(execution.steer_material_refs), json(execution.wait_condition), execution.wait_deadline,
        execution.resume_token, execution.created_at, execution.updated_at);
    return this.getExecution(executionId);
  }

  #completion(task, execution, appliedCheckResultId = null) {
    const contract = task.completion_contract;
    const missing = [];
    // A Mission Task with no specialized checker contract still has to leave
    // an auditable result.  This default keeps research/coordination work
    // material-driven without inventing an artifact or Judge requirement.
    if (this.#modernTaskRecord(task.task_id) && Object.keys(contract ?? {}).length === 0) {
      const produced = this.contextService?.readMaterials?.({ source_task: task.task_id }) ?? [];
      const linkedMaterialIds = new Set(this.db.prepare('SELECT DISTINCT material_id FROM task_material_links').all().map((row) => row.material_id));
      if (!produced.some((material) => linkedMaterialIds.has(material.material_id))) missing.push('linked_material');
    }
    if (contract.required_materials) {
      if (!this.contextService) missing.push('required_materials');
      else for (const requirement of contract.required_materials) {
        const normalizedRequirement = typeof requirement === 'string' ? { kind: requirement, min_count: 1 } : (requirement ?? {});
        const kinds = normalizedRequirement.kinds ?? (normalizedRequirement.kind ? [normalizedRequirement.kind] : []);
        if (!Array.isArray(kinds) || kinds.length === 0) {
          missing.push('materials:invalid_requirement');
          continue;
        }
        const consumptionAction = normalizedRequirement.action ?? normalizedRequirement.consumption_action;
        const linkedMaterials = this.#taskMaterialLinks(task.task_id).map((link) => link.material).filter(Boolean);
        const materials = (linkedMaterials.length > 0 ? linkedMaterials : this.contextService.readMaterials({ source_task: task.task_id })).filter((material) =>
          kinds.includes(material.kind) && (!normalizedRequirement.scope || normalizedRequirement.scope === material.scope) &&
          (!normalizedRequirement.role || normalizedRequirement.role === material.role) &&
          // A cross-task integration requirement cannot be satisfied by a
          // scratchpad Material produced by the receiving Task itself (or a
          // later Execution of that same Task). Self-consumption remains
          // valid evidence for ordinary local work, but it is not proof that
          // a collaborator's result changed the completion state.
          (!normalizedRequirement.cross_task || (material.source_task ?? material.producer_task_id) !== task.task_id));
        let count = materials.length;
        if (normalizedRequirement.requires_consumption) {
          const consumptionRows = typeof this.contextService.listMaterialConsumptions === 'function'
            ? this.contextService.listMaterialConsumptions({ reader_task: task.task_id, action: consumptionAction })
            : [];
          const consumedIds = new Set(consumptionRows.map((row) => row.material_id));
          count = materials.filter((material) => {
            const consumedMaterialIds = material.provenance?.consumed_material_ids;
            if (Array.isArray(consumedMaterialIds) && consumedMaterialIds.length > 0) {
              return consumedMaterialIds.every((materialId) => consumedIds.has(materialId));
            }
            return consumedIds.has(material.material_id);
          }).length;
        }
        if (count < (normalizedRequirement.min_count ?? 1)) {
          const suffix = normalizedRequirement.requires_consumption ? `:${consumptionAction}` : '';
          missing.push(`materials${suffix}:${kinds.join('|')}`);
        }
      }
    }
    if (contract.required_response) {
      const requirements = Array.isArray(contract.required_response) ? contract.required_response : [contract.required_response];
      // A required response is a delivery obligation of the current
      // producer Task. Response links are stored on the receiving Task, so
      // query by producer_task_id rather than treating the producer as the
      // receiver. This keeps completion aligned with the directed Material
      // link semantics used by Mission Tasks.
      const responseLinks = this.db.prepare(`SELECT * FROM task_material_links
        WHERE producer_task_id = ? AND role = 'response'
        ORDER BY created_at, link_id`).all(task.task_id)
        .map((row) => rowToMaterialLink(row, this.contextService?.getMaterial(row.material_id) ?? null));
      for (const requirement of requirements) {
        const targetTaskId = typeof requirement === 'string' ? requirement : requirement?.receiving_task_id ?? requirement?.task_id ?? null;
        const matches = responseLinks.filter((link) => !targetTaskId || link.receiving_task_id === targetTaskId);
        if (matches.length < (typeof requirement === 'object' ? requirement.min_count ?? 1 : 1)) {
          missing.push(`response${targetTaskId ? `:${targetTaskId}` : ''}`);
        }
      }
    }
    if (contract.required_candidate) {
      const candidate = execution?.candidate_material_id && this.contextService?.getMaterial(execution.candidate_material_id);
      const appliedCheck = appliedCheckResultId ? this.getCheckResult(appliedCheckResultId) : null;
      const workspaceCandidate = appliedCheck?.status === 'APPLIED' && appliedCheck.verdict === 'PASS' &&
        appliedCheck.execution_id === execution?.execution_id && typeof appliedCheck.candidate_material_id === 'string' &&
        appliedCheck.candidate_material_id.startsWith('workspace:');
      if ((!candidate && !workspaceCandidate) || (candidate && (candidate.kind !== contract.required_candidate.kind ||
        (contract.required_candidate.scope && candidate.scope !== contract.required_candidate.scope)))) {
        missing.push('required_candidate');
      }
    }
    if (contract.required_check) {
      const check = appliedCheckResultId ? this.getCheckResult(appliedCheckResultId) : this.db.prepare(`SELECT * FROM check_results
        WHERE target_task_id = ? AND target_spec_version = ? AND input_snapshot_hash = ? AND checker_ref = ? AND checker_version = ?
          AND status = 'APPLIED' AND verdict = 'PASS' ORDER BY applied_at DESC LIMIT 1`)
        .get(task.task_id, task.spec_version, execution?.input_snapshot_hash ?? '', contract.required_check.checker_ref, contract.required_check.checker_version);
      if (!check || check.status !== 'APPLIED' || check.verdict !== 'PASS') missing.push('required_check');
    }
    return { satisfied: missing.length === 0, missing };
  }

  #missionCompletion(mission, task, execution, appliedCheckResultId = null) {
    const acceptance = mission?.acceptance_conditions && typeof mission.acceptance_conditions === 'object'
      ? mission.acceptance_conditions
      : {};
    const missing = [];
    // Missions that declare final-candidate acceptance opt into the stronger
    // project-level gate.  Older coordination Missions intentionally keep
    // their own material contracts and remain compatible when no such
    // project-level condition was declared.
    const requiresFinalCandidate = acceptance.final_candidate === true ||
      Boolean(acceptance.required_candidate || acceptance.required_check || acceptance.required_task_id);
    if (requiresFinalCandidate && task?.completion_contract?.final_candidate !== true) missing.push('mission:final_candidate');
    if (acceptance.required_task_id && acceptance.required_task_id !== task.task_id) {
      missing.push(`mission:task:${acceptance.required_task_id}`);
    }
    if (acceptance.required_candidate) {
      const candidate = execution?.candidate_material_id && this.contextService?.getMaterial(execution.candidate_material_id);
      const requirement = acceptance.required_candidate;
      if (!candidate || (requirement.kind && candidate.kind !== requirement.kind) || (requirement.scope && candidate.scope !== requirement.scope)) {
        missing.push('mission:required_candidate');
      }
    }
    if (acceptance.required_check) {
      const requirement = acceptance.required_check;
      const check = appliedCheckResultId ? this.getCheckResult(appliedCheckResultId) : this.db.prepare(`SELECT * FROM check_results
        WHERE target_task_id = ? AND target_spec_version = ? AND input_snapshot_hash = ? AND checker_ref = ? AND checker_version = ?
          AND status = 'APPLIED' AND verdict = 'PASS' ORDER BY applied_at DESC LIMIT 1`)
        .get(task.task_id, task.spec_version, execution?.input_snapshot_hash ?? '', requirement.checker_ref, requirement.checker_version);
      if (!check || check.status !== 'APPLIED' || check.verdict !== 'PASS') missing.push('mission:required_check');
    }
    return { satisfied: missing.length === 0, missing };
  }

  #replay(operationId, fingerprint) {
    const row = this.db.prepare('SELECT fingerprint, result_json FROM operations WHERE operation_id = ?').get(operationId);
    if (!row) return null;
    if (row.fingerprint !== fingerprint) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'operation_id was reused with another payload');
    return parse(row.result_json);
  }

  #saveOperation(operationId, operation, fingerprint, result) {
    this.db.prepare('INSERT INTO operations (operation_id, operation, fingerprint, result_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(operationId, operation, fingerprint, json(result), now());
  }

  #transaction(callback) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

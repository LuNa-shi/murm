import { assertServiceCommitSettled } from '../sdk/service-commit-gate.js';
import { MANUAL_MISSION_REVIEW_SCHEMA_SQL } from '../runtime/manual-mission-review.js';
import { installServiceHistory } from '../replay/service-history.js';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ERROR_CODES, SwarmEnvError } from '../errors.js';
import { storedCheckerProcessStatus, storedResultClass } from '../judge/check-result.js';
import { makeEnvelope, operationPayload, stableStringify, validateEnvelope } from '../protocol/envelope.js';
import { MISSION_SUBMISSION_SCHEMA_SQL, SCHEMA_SQL } from '../storage/schema.js';
import { assertNewExecutionWork } from './execution-budget.js';
import { ensureJudgeSchema } from '../storage/judge-schema.js';
import {
  TERMINAL_EXECUTION_STATES,
  TERMINAL_TASK_STATES,
} from './task-types.js';

const EXECUTION_WRITE_OPERATIONS = new Set(['fence_execution', 'task_finish', 'task_link_material', 'heartbeat', 'record_handoff_reminder', 'save_workspace_revision', 'start_execution', 'stop_execution', 'task_feedback']);
const COORDINATION_PERMISSIONS = new Set(['unsupersede', 'task_cancel', 'task_dependency_replace', 'mission_submit']);
const TASK_PUBLIC_MUTATING_OPERATIONS = new Set(['mission_create', 'task_create', 'task_link_material', 'task_finish', 'task_feedback', 'task_revise', 'task_cancel', 'task_dependency_replace']);
const TASK_PUBLIC_READ_OPERATIONS = new Set(['mission_get', 'task_list', 'task_view', 'task_materials']);
const TASK_MUTATING_OPERATIONS = new Set([
  'bot_exit',
  'reconcile_task', 'start_execution', 'stop_execution', 'fence_execution', 'save_workspace_revision',
  'task_link_material', 'task_finish',
  ...TASK_PUBLIC_MUTATING_OPERATIONS,
  'task_take',
]);
const TASK_EVENT_OPERATIONS = new Set([
  'mission_create', 'task_create', 'task_revise',
  'reconcile_task', 'start_execution', 'stop_execution', 'fence_execution', 'save_workspace_revision',
  'task_create', 'task_cancel', 'task_dependency_replace',
  'task_link_material', 'task_finish',
  'task_feedback',
]);
const TASK_READ_OPERATIONS = new Set([
  ...TASK_PUBLIC_READ_OPERATIONS,
  'task_status',
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
  return state === 'DONE';
}

function taskCompletionState() {
  return 'DONE';
}

function taskCancellationState() {
  return 'CANCELED';
}

function hash(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function contractPriority(value) {
  const encoded = typeof value === 'string' ? { low: 0, medium: 1, high: 2 }[value] : value;
  if (!Number.isInteger(encoded) || encoded < 0 || encoded > 2) {
    throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'priority must explicitly select low, medium, or high (0, 1, or 2)');
  }
  return encoded;
}

function rowToTask(row) {
  if (!row) return null;
  return {
    ...row,
    acceptance_conditions: parse(row.acceptance_conditions_json),
    input_material_refs: parse(row.input_material_refs_json),
    completion_contract: parse(row.completion_contract_json),
    workspace: parse(row.workspace_json),
    task_instructions: row.task_instructions ?? '',
    eligible_at: row.eligible_at ?? row.created_at ?? null,
  };
}

export function fixedExecutionInputHash(task, input) {
  return hash({
    task_id: task.task_id, spec_hash: task.spec_hash,
    workspace: { workspace_id: input.workspace_id, revision: input.revision, git_commit: input.git_commit,
      git_tree: input.git_tree, content_hash: input.content_hash },
    materials: input.material_inputs,
  });
}

function rowToExecution(row) {
  if (!row) return null;
  return {
    ...row,
    input_material_refs: parse(row.input_material_refs_json),
    agent_prompt: row.agent_prompt ?? '',
    workspace_manifest_ref: row.workspace_manifest_ref,
    workspace_snapshot_hash: row.input_snapshot_hash,
    workspace_input: parse(row.workspace_input_json),
    handoff_metadata: parse(row.handoff_metadata_json),
    terminal_reason: row.terminal_reason ?? null,
    core_id: row.core_id ?? null,
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

function normalizeTaskContractText(payload) {
  const normalized = { ...payload };
  for (const field of ['summary', 'gap', 'expected_output']) {
    if (typeof normalized[field] === 'string') normalized[field] = normalized[field].trim();
  }
  return normalized;
}

export class TaskService {
  constructor(database = ':memory:', { contextService = null, logger = null } = {}) {
    this.db = database instanceof DatabaseSync ? database : new DatabaseSync(database);
    this.db.exec(SCHEMA_SQL);
    this.db.exec(MISSION_SUBMISSION_SCHEMA_SQL);
    this.db.exec(MANUAL_MISSION_REVIEW_SCHEMA_SQL);
    ensureJudgeSchema(this.db);
    this.contextService = contextService;
    if (contextService?.db === this.db && !contextService.taskService) contextService.taskService = this;
    this.logger = logger;
    this.executionStateListeners = new Set();
    this.taskEventListeners = new Set();
    this.notificationListeners = new Set();
    installServiceHistory(this.db, { domain: 'task' });
  }

  close() {
    this.db.close();
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
              AND addressed.state IN ('CREATED', 'RUNNING', 'CLOSING')
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
              AND addressed.state IN ('CREATED', 'RUNNING', 'CLOSING')
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
      if (addressed && ['CREATED', 'RUNNING'].includes(addressed.state)) {
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
      if (addressed && ['CREATED', 'RUNNING'].includes(addressed.state)) {
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
    // retain the row-level projection. Task-level notifications stay
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

  dispatch(operation, payload = {}, envelope) {
    const normalizedOperation = operation;
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
          // A finish receipt outlives the Execution versions that it closes.
          // Keep its identity and input stable when an SDK refreshes versions
          // after a lost response; a new request still checks current fences.
          const fingerprintEnvelope = normalizedOperation === 'task_finish'
            ? { ...envelope, state_version: null, fencing_version: null }
            : (normalizedOperation === 'task_create' || ['task_revise', 'task_cancel', 'task_dependency_replace'].includes(normalizedOperation)) && this.getBot(envelope.actor_ref)
              ? { ...envelope, state_version: null } : envelope;
          const fingerprint = operationPayload(normalizedOperation, payload, fingerprintEnvelope);
          const replay = this.#replay(envelope.operation_id, fingerprint);
          if (replay) {
            replayed = true;
            return replay;
          }
          if (normalizedOperation !== 'bot_exit') this.assertBotDeadline(envelope.actor_ref);
          const value = this.#mutate(normalizedOperation, payload, envelope);
          this.#saveOperation(envelope.operation_id, normalizedOperation, fingerprint, value);
          return value;
        });
      }
      if (normalizedOperation === 'task_finish' && !replayed) {
        this.#emitExecutionState({ kind: 'execution_finish_accepted', execution_id: result.execution.execution_id });
      }
      if (normalizedOperation === 'bot_exit' && !replayed) {
        this.#emitExecutionState({ kind: 'bot_exit_accepted', bot_id: result.bot.bot_id });
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
      if (this.getBot(envelope.actor_ref)) {
        if (result?.task?.mission_id) {
          result = {
            ...result,
            task: this.#publicTask(result.task, {
              execution_id: result.created_from_execution_id ?? null,
              task_id: result.created_from_execution_id ? envelope.task_id ?? null : null,
            }),
          };
        }
      }
      this.logger?.append({ event: 'dispatch.complete', service: 'task', operation: normalizedOperation, ok: true, result });
      return result;
    } catch (error) {
      this.logger?.append({ event: 'dispatch.complete', service: 'task', operation: normalizedOperation, ok: false, error: { name: error.name, code: error.code, message: error.message } });
      throw error;
    }
  }

  getTask(taskId) {
    return this.#decorateTaskRecord(rowToTask(this.db.prepare(`SELECT t.* FROM tasks t
      JOIN task_records m ON m.task_id = t.task_id WHERE t.task_id = ?`).get(taskId)));
  }

  /** Public Mission lookup for the current Task surface. */
  getMission(missionId) {
    return this.#getMission(requireString(missionId, 'mission_id'));
  }

  getBot(botId) {
    const row = this.db.prepare('SELECT * FROM bots WHERE bot_id = ?').get(requireString(botId, 'bot_id'));
    if (!row) return null;
    const { coordination_permissions_json: permissions, ...binding } = row;
    return { ...binding, coordination_permissions: parse(permissions) ?? [] };
  }

  listRecoverableBots(missionId = null) {
    if (missionId !== null) requireString(missionId, 'mission_id');
    const rows = missionId === null
      ? this.db.prepare("SELECT bot_id FROM bots WHERE state <> 'CLOSED' ORDER BY mission_id, bot_id").all()
      : this.db.prepare("SELECT bot_id FROM bots WHERE mission_id = ? AND state <> 'CLOSED' ORDER BY bot_id").all(missionId);
    return rows.map(row => this.getBot(row.bot_id));
  }

  /** Install a trusted synchronous gate at the Mission lifecycle boundary. */
  setMissionStopReader(reader) {
    if (typeof reader !== 'function') throw new TypeError('Mission stop reader must be a function');
    this.missionStopReader = reader;
  }

  assertMissionResearchOpen(missionId) {
    this.#assertMissionOpen(missionId);
  }

  /** Local domain call. Hold the lifecycle writer while a synchronous service
   * admits and commits its own write. This transaction writes no Task rows. */
  withServiceLifecycleWrite(commit) {
    if (typeof commit !== 'function') throw new TypeError('Service lifecycle write requires a synchronous commit');
    return this.#transaction(commit);
  }

  isMissionStopped(missionId) {
    return Boolean(this.db.prepare("SELECT 1 FROM mission_submissions WHERE mission_id = ? AND state = 'accepted' LIMIT 1").get(missionId)
      || this.missionStopReader?.(missionId));
  }

  #assertMissionOpen(missionId) {
    if (this.isMissionStopped(missionId)) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Mission no longer admits new work');
    }
  }

  /** Task-owned authorization for a registered Bot with an explicit narrow grant. */
  assertMissionCoordination(envelope, operation) {
    validateEnvelope(envelope);
    const bot = this.getBot(envelope.actor_ref);
    if (!COORDINATION_PERMISSIONS.has(operation) || !bot?.coordination_permissions.includes(operation)) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bot lacks the required Mission coordination grant');
    }
    this.#assertMissionOpen(bot.mission_id);
    return this.materialScope(envelope, { write: bot.state === 'ACTIVE' });
  }

  /** Synchronous Context authority seam; reads only Task-owned rows. */
  materialScope(envelope, { write = false } = {}) {
    validateEnvelope(envelope);
    const bot = this.getBot(envelope.actor_ref);
    this.assertBotDeadline(envelope.actor_ref);
    if (bot) {
      if (!['UNBOUND', 'ACTIVE'].includes(bot.state)) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bot cannot access Materials in its current state');
      if (bot.state === 'UNBOUND') {
        if (write || envelope.execution_id || envelope.task_id || bot.execution_id) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Material contributions require a bound active Bot');
        if (Date.parse(bot.selection_deadline) <= Date.now()) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bot discovery deadline elapsed');
        return { mission_id: bot.mission_id, bot_id: bot.bot_id, task_id: null, execution_id: null };
      }
      if (!envelope.execution_id || bot.execution_id !== envelope.execution_id) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Material request does not match the Bot binding');
    }
    if (write) validateEnvelope(envelope, { executionWrite: true });
    const execution = write ? this.#executionForWrite(envelope) : this.getExecution(envelope.execution_id);
    if (!execution || execution.owner_ref !== envelope.actor_ref || execution.task_id !== envelope.task_id) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Material request requires its actual Execution owner');
    if (write && !['CREATED', 'RUNNING'].includes(execution.state)) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Material contributions require an active Execution');
    if (bot && execution.state !== 'RUNNING') throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Material contributions require a running Execution');
    if (bot && execution.lease_expires_at && Date.parse(execution.lease_expires_at) <= Date.now()) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Material Execution lease has expired');
    if (bot) {
      const task = this.db.prepare('SELECT state, spec_version FROM tasks WHERE task_id = ?').get(execution.task_id);
      if (!task || task.state !== 'RUNNING' || task.spec_version !== execution.spec_version) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Material Execution no longer matches its current Task');
    }
    const missionId = this.#taskMissionId(execution.task_id);
    if (!missionId || (bot && bot.mission_id !== missionId)) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Material binding has no matching Mission');
    return { mission_id: missionId, bot_id: bot?.bot_id ?? null, task_id: execution.task_id, execution_id: execution.execution_id };
  }

  /** Historical provenance lookup; terminal E records remain readable. */
  materialOriginMission(taskId, executionId, actorRef = null) {
    const execution = this.getExecution(executionId);
    return execution?.task_id === taskId && (!actorRef || execution.owner_ref === actorRef) ? this.#taskMissionId(taskId) : null;
  }

  // Read the durable clock boundary on the synchronous write path. A delayed
  // timer still owns cleanup, but cannot extend authorization for new work.
  assertBotDeadline(actorRef) {
    const bot = this.getBot(actorRef);
    if (!bot) return;
    const hard = Date.parse(bot.hard_deadline);
    const execution = bot.execution_id ? this.getExecution(bot.execution_id) : null;
    const executionDeadline = execution?.execution_deadline ? Date.parse(execution.execution_deadline) : Infinity;
    if (!Number.isFinite(hard) || hard <= Date.now() || executionDeadline <= Date.now()) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bot or Execution hard deadline elapsed');
    }
  }

  /** Runtime-only registration; no model capability may invent a Bot identity. */
  registerBot({ botId = `bot:${randomUUID()}`, missionId, coreId, legacySlotId = coreId, selectionDeadline, hardDeadline = selectionDeadline, coordinationPermissions = [] }) {
    requireString(botId, 'bot_id');
    requireString(missionId, 'mission_id');
    requireString(legacySlotId, 'legacySlotId');
    if (coreId !== undefined && coreId !== legacySlotId) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Conflicting legacy capacity identities');
    coreId = legacySlotId;
    if (!Array.isArray(coordinationPermissions) || [...coordinationPermissions].some(permission => !COORDINATION_PERMISSIONS.has(permission))) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Unknown Mission coordination grant');
    }
    if (typeof selectionDeadline !== 'string' || !Number.isFinite(Date.parse(selectionDeadline)) || Date.parse(selectionDeadline) <= Date.now()) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'selection_deadline must be a finite future timestamp');
    }
    if (typeof hardDeadline !== 'string' || !Number.isFinite(Date.parse(hardDeadline)) || Date.parse(hardDeadline) <= Date.now() || Date.parse(selectionDeadline) > Date.parse(hardDeadline)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Bot hard deadline must be finite and no earlier than its selection deadline');
    }
    return this.#transaction(() => {
      if (!this.getMission(missionId)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'unknown Mission');
      this.#assertMissionOpen(missionId);
      if (this.getBot(botId)) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Bot identity already exists');
      const occupant = this.db.prepare("SELECT bot_id FROM bots WHERE mission_id = ? AND core_id = ? AND state <> 'CLOSED'").get(missionId, coreId);
      if (occupant) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Core still owns a Bot', { bot_id: occupant.bot_id });
      const startedAt = now();
      this.db.prepare(`INSERT INTO bots (bot_id, mission_id, core_id, state, selection_deadline, hard_deadline, resource_key, started_at, updated_at, coordination_permissions_json, sandbox_create_state)
        VALUES (?, ?, ?, 'STARTING', ?, ?, ?, ?, ?, ?, 'NOT_DISPATCHED')`).run(botId, missionId, coreId, selectionDeadline, hardDeadline, botId, startedAt, startedAt,
          json([...new Set(coordinationPermissions)]));
      return this.getBot(botId);
    });
  }

  /** Runtime-only admission at the asynchronous provider startup boundaries. */
  assertBotStartupAllowed(botId) {
    const bot = this.getBot(botId);
    const nowMs = Date.now();
    if (!bot || bot.state !== 'STARTING' ||
        Date.parse(bot.selection_deadline) <= nowMs || Date.parse(bot.hard_deadline) <= nowMs) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bot startup is not eligible to proceed');
    }
    this.#assertMissionOpen(bot.mission_id);
    return bot;
  }

  recordBotSandboxDispatch(botId, { provider, timeoutSeconds }) {
    requireString(provider, 'provider');
    if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Sandbox create requires a finite lifetime');
    return this.#transaction(() => {
      this.assertBotStartupAllowed(botId);
      const result = this.db.prepare(`UPDATE bots SET provider = ?, sandbox_create_state = 'UNKNOWN',
        sandbox_timeout_seconds = ?, updated_at = ? WHERE bot_id = ? AND state = 'STARTING' AND sandbox_create_state = 'NOT_DISPATCHED'`)
        .run(provider, timeoutSeconds, now(), botId);
      if (!result.changes) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bot cannot dispatch sandbox creation');
    });
  }

  recordBotSandboxRejection(botId) {
    return this.#transaction(() => {
      const result = this.db.prepare(`UPDATE bots SET sandbox_create_state = 'REJECTED', updated_at = ?
        WHERE bot_id = ? AND state <> 'CLOSED' AND sandbox_create_state = 'UNKNOWN' AND sandbox_id IS NULL`).run(now(), botId);
      if (!result.changes) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Bot sandbox creation has no pending rejection');
    });
  }

  recordBotSandbox(botId, { provider, sandboxId, expiresAt = null }) {
    requireString(provider, 'provider');
    requireString(sandboxId, 'sandbox_id');
    return this.#transaction(() => {
      const bot = this.getBot(botId);
      if (!bot || bot.state === 'CLOSED') throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bot is not awaiting a resource');
      if (bot.sandbox_id && (bot.sandbox_id !== sandboxId || bot.provider !== provider)) {
        throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Bot already owns another sandbox');
      }
      const expiry = typeof expiresAt === 'string' && Number.isFinite(Date.parse(expiresAt)) ? new Date(expiresAt).toISOString() : null;
      this.db.prepare(`UPDATE bots SET provider = ?, sandbox_id = ?, sandbox_create_state = 'CREATED',
        sandbox_expires_at = COALESCE(?, sandbox_expires_at), updated_at = ? WHERE bot_id = ?`).run(provider, sandboxId, expiry, now(), botId);
      return this.getBot(botId);
    });
  }

  markBotReady(botId) {
    return this.#transaction(() => {
      const current = this.getBot(botId);
      if (current?.state === 'UNBOUND') return current;
      const bot = this.assertBotStartupAllowed(botId);
      if (!bot.sandbox_id) {
        throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bot startup is not eligible to become ready');
      }
      const readyAt = now();
      this.db.prepare("UPDATE bots SET state = 'UNBOUND', ready_at = ?, state_version = state_version + 1, updated_at = ? WHERE bot_id = ?")
        .run(readyAt, readyAt, botId);
      return this.getBot(botId);
    });
  }

  /** Trusted flat host confirms Core spawn readiness. Provider resources remain Core-owned. */
  markCoreBotReady(botId) {
    return this.#transaction(() => {
      const current = this.getBot(botId);
      if (current?.state === 'UNBOUND' && !current.sandbox_id) return current;
      const bot = this.assertBotStartupAllowed(botId);
      if (bot.sandbox_id || bot.sandbox_create_state !== 'NOT_DISPATCHED') {
        throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Core readiness cannot adopt legacy sandbox resources');
      }
      const readyAt = now();
      this.db.prepare("UPDATE bots SET state = 'UNBOUND', ready_at = ?, state_version = state_version + 1, updated_at = ? WHERE bot_id = ?")
        .run(readyAt, readyAt, botId);
      return this.getBot(botId);
    });
  }

  /** Runtime-only stop; a taken Task must already have reached a terminal state. */
  requestBotStop(botId, reason, { terminalState = null, leaseExpiredAt = null } = {}) {
    requireString(reason, 'reason');
    if (terminalState !== null && !TERMINAL_EXECUTION_STATES.includes(terminalState)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Bot stop requires a terminal Execution state');
    if (leaseExpiredAt !== null && (terminalState !== 'EXPIRED' || !Number.isFinite(Date.parse(leaseExpiredAt)))) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Lease expiry requires an EXPIRED stop and a valid cutoff');
    return this.#transaction(() => {
      const bot = this.getBot(botId);
      if (!bot || (bot.execution_id && !terminalState && !TERMINAL_EXECUTION_STATES.includes(this.getExecution(bot.execution_id)?.state))) {
        throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'bound Bot must close through its Execution');
      }
      if (['CLOSING', 'CLOSED'].includes(bot.state)) return bot;
      if (leaseExpiredAt !== null) {
        const execution = this.getExecution(bot.execution_id);
        if (!execution || !['CREATED', 'RUNNING'].includes(execution.state) || Date.parse(execution.lease_expires_at) > Date.parse(leaseExpiredAt)) return null;
      }
      this.db.prepare("UPDATE bots SET state = 'CLOSING', exit_request_id = ?, exit_reason = ?, stop_terminal_state = ?, state_version = state_version + 1, updated_at = ? WHERE bot_id = ?")
        .run(`runtime:${randomUUID()}`, reason, terminalState, now(), botId);
      return this.getBot(botId);
    });
  }

  /** Trusted Runtime confirms all resources have stopped before freeing a Bot/Core. */
  finalizeBotClose(botId) {
    return this.#transaction(() => {
      const bot = this.getBot(botId);
      if (bot?.state === 'CLOSED') return bot;
      if (!bot || bot.state !== 'CLOSING') throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bot has no accepted close');
      if (bot.execution_id && !TERMINAL_EXECUTION_STATES.includes(this.getExecution(bot.execution_id)?.state)) {
        throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bot Execution has not safely closed');
      }
      const closedAt = now();
      this.db.prepare("UPDATE bots SET state = 'CLOSED', closed_at = ?, state_version = state_version + 1, updated_at = ? WHERE bot_id = ?")
        .run(closedAt, closedAt, botId);
      return this.getBot(botId);
    });
  }

  #exitBot(payload, envelope) {
    if (envelope.execution_id || envelope.task_id) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'bound Bot must finish its Task');
    const bot = this.getBot(envelope.actor_ref);
    if (!bot || bot.state !== 'UNBOUND' || bot.execution_id) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'bot exit requires an unbound Bot with no pending take');
    if (!['no-work', 'selection-budget'].includes(payload.reason)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'bot exit reason must be no-work or selection-budget');
    const at = Date.now();
    if (!this.isMissionStopped(bot.mission_id) && at < Date.parse(bot.selection_deadline) && at < Date.parse(bot.hard_deadline)) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Mission is still open and the Bot has selection time remaining', { phase: 'discovery_required' });
    }
    this.db.prepare("UPDATE bots SET state = 'CLOSING', exit_request_id = ?, exit_reason = ?, state_version = state_version + 1, updated_at = ? WHERE bot_id = ?")
      .run(envelope.operation_id, payload.reason, now(), bot.bot_id);
    return { bot: this.getBot(bot.bot_id), disposition: 'closing' };
  }

  createMission(input, envelope = makeEnvelope({ actorRef: input?.created_by ?? 'unknown' })) {
    return this.dispatch('mission_create', input, envelope);
  }

  createTask(input, envelope = makeEnvelope({ actorRef: input?.created_by ?? 'unknown' })) {
    return this.dispatch('task_create', input, envelope);
  }

  listMissionTasks(filters = {}, envelope = makeEnvelope({ actorRef: 'unknown' })) {
    // Controller/report helper retains full records. Bots use paged dispatch.
    validateEnvelope(envelope);
    return this.#listTaskRecords(filters);
  }

  publicChangeToken(missionId) {
    requireString(missionId, 'mission_id');
    return this.db.prepare(`SELECT
      (SELECT COUNT(*) FROM task_records WHERE mission_id = ?) AS tasks,
      (SELECT COALESCE(SUM(t.state_version + t.spec_version), 0) FROM tasks t JOIN task_records m ON m.task_id = t.task_id WHERE m.mission_id = ?) AS versions,
      (SELECT COUNT(*) FROM task_material_links link JOIN task_records m ON m.task_id = link.task_id WHERE m.mission_id = ?) AS links,
      (SELECT COUNT(*) FROM task_relations WHERE mission_id = ?) AS relations`).get(missionId, missionId, missionId, missionId);
  }

  taskStatus(filters = {}, envelope = makeEnvelope({ actorRef: 'unknown' })) {
    return this.dispatch('task_status', filters, envelope);
  }

  viewTaskRecord(taskId, envelope = makeEnvelope({ actorRef: 'unknown', taskId })) {
    return this.dispatch('task_view', { task_id: taskId }, envelope);
  }

  linkMaterial(payload, envelope) {
    return this.dispatch('task_link_material', payload, envelope);
  }

  listTaskMaterials(taskId, envelope = makeEnvelope({ actorRef: 'unknown', taskId })) {
    return this.dispatch('task_materials', { task_id: taskId }, envelope);
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
    const execution = rowToExecution(this.db.prepare('SELECT * FROM executions WHERE execution_id = ?').get(executionId));
    const finish = this.getExecutionFinish(executionId);
    return execution && finish ? { ...execution, finish } : execution;
  }

  getExecutionFinish(executionId) {
    const row = this.db.prepare('SELECT * FROM execution_finish_intents WHERE execution_id = ?').get(executionId);
    if (!row) return null;
    const { payload_json, ...finish } = row;
    return { ...finish, payload: parse(payload_json) };
  }

  /** Trusted Runtime seam, called only after the owning Bot and sandbox have stopped. */
  finalizeExecutionFinish(executionId, { fencingVersion }) {
    const result = this.#transaction(() => {
      const execution = this.getExecution(executionId);
      const finish = execution?.finish;
      if (!finish) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Execution has no accepted finish');
      if (finish.closed_at) return { execution, task: this.getTask(execution.task_id), changed: false };
      const otherOwner = this.db.prepare(`SELECT execution_id FROM executions WHERE task_id = ? AND execution_id <> ?
        AND state IN ('CREATED', 'RUNNING', 'CLOSING') LIMIT 1`).get(execution.task_id, executionId);
      const task = this.getTask(execution.task_id);
      if (execution.state !== 'CLOSING' || execution.fencing_version !== fencingVersion || task.state !== 'RUNNING' || otherOwner) {
        throw new SwarmEnvError(ERROR_CODES.FENCED, 'finish no longer owns the Task');
      }
      const closedAt = now();
      this.db.prepare(`UPDATE executions SET state = ?, terminal_reason = ?, fencing_version = fencing_version + 1,
        state_version = state_version + 1, updated_at = ? WHERE execution_id = ?`)
        .run(finish.terminal_state, finish.reason, closedAt, executionId);
      this.db.prepare('UPDATE execution_finish_intents SET closed_at = ? WHERE execution_id = ?').run(closedAt, executionId);
      if (finish.outcome === 'done') {
        this.db.prepare("UPDATE tasks SET state = 'DONE', block_reason = NULL, eligible_at = NULL, state_version = state_version + 1, updated_at = ? WHERE task_id = ?")
          .run(closedAt, execution.task_id);
      } else if (finish.outcome === 'cancelled') {
        this.db.prepare("UPDATE tasks SET state = 'CANCELED', cancelled_at = ?, block_reason = NULL, eligible_at = NULL, state_version = state_version + 1, updated_at = ? WHERE task_id = ?")
          .run(closedAt, closedAt, execution.task_id);
      } else {
        this.#refreshTaskState(execution.task_id, { updatedAt: closedAt });
      }
      this.#reconcileTask({ task_id: execution.task_id }, makeEnvelope({ actorRef: 'runtime:finish' }));
      this.#reconcileDependents(execution.task_id);
      return { execution: this.getExecution(executionId), task: this.getTask(execution.task_id), changed: true };
    });
    if (result.changed) this.#emitTaskEvent({ kind: 'task_finish_closed', operation: 'finish_closed',
      task_id: result.task.task_id, execution_id: executionId, state: result.task.state, changed: true, timestamp: now() });
    return result;
  }

  recordHandoffReminder(payload, envelope) {
    return this.dispatch('record_handoff_reminder', payload, envelope);
  }

  getCheckResult(checkResultId) {
    if (this.checkResultReader) return this.checkResultReader(checkResultId);
    return rowToCheckResult(this.db.prepare('SELECT * FROM check_results WHERE check_result_id = ?').get(checkResultId));
  }

  setWorkspaceDeliveryReader(reader) {
    if (typeof reader !== 'function') throw new TypeError('Workspace delivery reader requires a function');
    this.workspaceDeliveryReader = reader;
  }

  setCheckResultReader(reader) {
    if (typeof reader !== 'function') throw new TypeError('Check result reader requires a function');
    this.checkResultReader = reader;
  }

  listTasks({ missionId = null, states = ['OPEN', 'RUNNING'], limit = 10, availableOnly = true, scanAll = false } = {}) {
    if (missionId !== null && (typeof missionId !== 'string' || missionId.length === 0)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'mission_id must be a non-empty string or null');
    }
    if (!Array.isArray(states) || states.length === 0 || states.some((state) => typeof state !== 'string' || state.length === 0)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'states must contain at least one task state');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'limit must be an integer between 1 and 100');
    }
    const statePlaceholders = states.map(() => '?').join(', ');
    const conditions = [`t.state IN (${statePlaceholders})`];
    const params = [...states];
    if (missionId !== null) {
      conditions.push('m.mission_id = ?');
      params.push(missionId);
    }
    // Claimability needs to inspect the complete OPEN set before applying the
    // fairness floor.  The public list remains bounded; scanAll is an
    // internal read used only by listEligibleTasks.
    params.push(scanAll ? -1 : (availableOnly ? 100 : limit));
    const tasks = this.db.prepare(`SELECT t.* FROM tasks t JOIN task_records m ON m.task_id = t.task_id WHERE ${conditions.join(' AND ')}
      ORDER BY t.priority DESC, t.created_at ASC, t.task_id ASC LIMIT ?`).all(...params).map((row) => ({
      ...this.#decorateTaskRecord(rowToTask(row)),
      // Prefer the active owner, then show the last terminal attempt.
      latest_execution: this.#latestExecution(row.task_id, true) ?? this.#latestExecution(row.task_id),
    }));
    if (!availableOnly) return tasks;
    return tasks.filter((task) => {
      if (this.#gatingDependencyBlockers(task).length > 0) return false;
      const executions = this.listExecutions(task.task_id, { includeTerminal: false });
      const active = executions.filter((execution) => ['CREATED', 'RUNNING', 'CLOSING'].includes(execution.state));
      return active.length === 0;
    }).slice(0, limit);
  }

  /**
   * Return the bounded value-selection view used by a Core Daemon.  This is a
   * read-only projection: it never ranks with an LLM and never takes a Task.
   * Protected older work is placed ahead of younger work once it crosses the
   * configured aging threshold, while priority remains the tie-breaker inside
   * each fairness band.
   */
  listEligibleTasks({ missionId = null, limit = 10, nowMs = Date.now() } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'limit must be an integer between 1 and 100');
    }
    if (!Number.isFinite(nowMs)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'now_ms must be finite');
    const tasks = this.listTasks({ missionId, states: ['OPEN', 'RUNNING'], limit: 100, availableOnly: false, scanAll: true })
      .filter((task) => {
        if (this.#gatingDependencyBlockers(task).length > 0) return false;
        const executions = this.listExecutions(task.task_id, { includeTerminal: false });
        const active = executions.filter((execution) => ['CREATED', 'RUNNING', 'CLOSING'].includes(execution.state));
        return active.length === 0;
      });
    return tasks
      .map((task) => {
        const eligibleSince = task.eligible_at ?? task.created_at;
        const eligibleMs = Date.parse(eligibleSince ?? '');
        const ageMs = Number.isNaN(eligibleMs) ? 0 : Math.max(0, nowMs - eligibleMs);
        return {
          ...task,
          eligible_since: eligibleSince,
          age_ms: ageMs,
          fairness_protected: false,
        };
      })
      .sort((left, right) => {
        const leftSince = Date.parse(left.eligible_since ?? '') || Number.MAX_SAFE_INTEGER;
        const rightSince = Date.parse(right.eligible_since ?? '') || Number.MAX_SAFE_INTEGER;
        if (left.priority !== right.priority) return right.priority - left.priority;
        if (leftSince !== rightSince) return leftSince - rightSince;
        return left.task_id.localeCompare(right.task_id);
      })
      .slice(0, limit)
      .map((task, index) => ({ ...task, selection_rank: index + 1 }));
  }

  /** Return blocked Tasks for Controller repair sweeps without exposing SQL. */
  listBlockedTasks({ missionId = null, limit = 100, includeOpen = false } = {}) {
    return this.listTasks({ missionId, states: includeOpen ? ['OPEN', 'BLOCKED'] : ['BLOCKED'], limit, availableOnly: false });
  }

  getActiveExecutionForCore(coreId) {
    requireString(coreId, 'core_id');
    return rowToExecution(this.db.prepare("SELECT * FROM executions WHERE core_id = ? AND state IN ('CREATED', 'RUNNING', 'CLOSING') ORDER BY created_at, execution_id LIMIT 1").get(coreId));
  }

  reconcileTask(taskId, envelope = makeEnvelope({ actorRef: 'controller', taskId })) {
    return this.dispatch('reconcile_task', { task_id: requireString(taskId, 'task_id') }, envelope);
  }


  listExecutions(taskId, { includeTerminal = true } = {}) {
    requireString(taskId, 'task_id');
    const stateClause = includeTerminal ? '' : "AND state IN ('CREATED', 'RUNNING', 'CLOSING')";
    return this.db.prepare(`SELECT * FROM executions WHERE task_id = ? ${stateClause} ORDER BY attempt_no DESC, created_at DESC`)
      .all(taskId).map(rowToExecution);
  }

  listActiveExecutions() {
    return this.db.prepare("SELECT * FROM executions WHERE state IN ('CREATED', 'RUNNING', 'CLOSING') ORDER BY created_at, execution_id").all().map(rowToExecution);
  }

  #getMission(missionId) {
    const row = this.db.prepare('SELECT * FROM missions WHERE mission_id = ?').get(missionId);
    if (!row) return null;
    return {
      mission_id: row.mission_id,
      goal: row.goal,
      acceptance_conditions: parse(row.acceptance_conditions_json) ?? {},
      merge_required_check: parse(row.merge_required_check_json),
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  #taskRelations(taskId) {
    const rows = this.db.prepare(`SELECT relation_id, mission_id, task_id, relation_kind,
      related_task_id, created_by_task_id, created_by_execution_id, created_by, created_at
      FROM task_relations WHERE task_id = ? ORDER BY created_at, relation_id`).all(taskId);
    return {
      depends_on: rows.filter((row) => row.relation_kind === 'depends_on').map(row => ({ ...row })),
      dependency_replacements: this.db.prepare(`SELECT * FROM task_dependency_replacements
        WHERE task_id = ? ORDER BY created_at, operation_id`).all(taskId).map(row => {
        const { original_relation_json: original, ...record } = row;
        return { ...record, original_relation: parse(original) };
      }),
    };
  }

  #taskRecord(taskId) {
    return this.db.prepare('SELECT * FROM task_records WHERE task_id = ?').get(taskId);
  }


  #taskMaterialLinks(taskId, { role = null, materialId = null } = {}) {
    const rows = this.db.prepare(`SELECT * FROM task_material_links
      WHERE task_id = ?
        AND (? IS NULL OR role = ?)
        AND (? IS NULL OR material_id = ?)
      ORDER BY created_at, link_id`).all(taskId, role, role, materialId, materialId);
    return rows.map(row => this.#scopedMaterialLink(row, this.#taskMissionId(taskId))).filter(Boolean);
  }

  #scopedMaterialLink(row, missionId) {
    const material = this.contextService?.getMaterial(row.material_id);
    if (!material || material.mission_id !== missionId || this.#taskMissionId(row.task_id) !== missionId ||
        this.#taskMissionId(row.producer_task_id) !== missionId ||
        this.materialOriginMission(row.producer_task_id, row.producer_execution_id, material.producer_bot_id) !== missionId ||
        this.materialOriginMission(row.created_by_task_id, row.created_by_execution_id) !== missionId ||
        material.producer_task_id !== row.producer_task_id || material.producer_execution_id !== row.producer_execution_id) return null;
    return rowToMaterialLink(row, material);
  }

  /** Context Service asks Task Service for link IDs without reading its table. */
  listTaskMaterialIds(taskId) {
    requireString(taskId, 'task_id');
    return this.db.prepare('SELECT material_id FROM task_material_links WHERE task_id = ? ORDER BY created_at, link_id')
      .all(taskId).map((row) => row.material_id);
  }

  hasTaskMaterial(taskId, materialId) {
    return Boolean(this.db.prepare('SELECT 1 FROM task_material_links WHERE task_id = ? AND material_id = ? LIMIT 1').get(taskId, materialId));
  }

  #taskMissionId(taskId) {
    return this.#taskRecord(taskId)?.mission_id ?? null;
  }

  #decorateTaskRecord(task) {
    if (!task) return null;
    const record = this.#taskRecord(task.task_id);
    if (!record) return null;
    return {
      ...task,
      mission_id: record.mission_id,
      summary: record.summary,
      gap: record.gap,
      contract_format: 'mission-gap-v1',
      priority_level: ['low', 'medium', 'high'][task.priority] ?? null,
      timebox_ms: record.timebox_ms,
      relations: this.#taskRelations(task.task_id),
      materials: this.#taskMaterialLinks(task.task_id),
      blockers: this.#taskDependencyBlockers(task.task_id),
    };
  }

  #publicTaskRelations(relations) {
    return relations;
  }

  #publicTask(task, creation = {}) {
    const { task_id, mission_id, summary, gap, contract_format, priority_level, goal, expected_output, acceptance_conditions, task_instructions,
      completion_contract, input_material_refs, workspace, timebox_ms, priority, state, block_reason,
      spec_version, spec_hash, state_version, eligible_at, created_at, updated_at, relations, materials, blockers } = task;
    const creationRecord = { actor_ref: task.created_by, task_id: creation.task_id ?? null, execution_id: creation.execution_id ?? null,
      reason: creation.reason ?? null, created_at: task.created_at };
    return { task_id, mission_id, summary, gap, contract_format, priority_level, goal, expected_output, acceptance_conditions, task_instructions,
      completion_contract, input_material_refs, workspace, base_revision: workspace?.revision ?? null, timebox_ms, priority, state, block_reason,
      spec_version, spec_hash, state_version, eligible_at, created_at, updated_at, creation: creationRecord,
      relations: this.#publicTaskRelations(relations), materials, blockers };
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
    const mergeCheck = payload.merge_required_check ?? null;
    if (mergeCheck !== null && (typeof mergeCheck !== 'object' || Array.isArray(mergeCheck) ||
        !['checker_ref', 'checker_version', 'environment_ref'].every(field => typeof mergeCheck[field] === 'string' && mergeCheck[field]))) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'merge_required_check must identify the checker, version and environment');
    }
    const createdAt = now();
    const existing = this.#getMission(missionId);
    if (existing) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'mission_id already exists', { mission_id: missionId });
    this.db.prepare(`INSERT INTO missions
      (mission_id, goal, acceptance_conditions_json, merge_required_check_json, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      missionId,
      payload.goal,
      json(payload.acceptance_conditions ?? {}),
      mergeCheck === null ? null : json(mergeCheck),
      envelope.actor_ref,
      createdAt,
      createdAt,
    );
    return { mission: this.#getMission(missionId) };
  }

  #assertTaskRecordInput(payload) {
    requireString(payload.mission_id, 'mission_id');
    requireString(payload.summary, 'summary');
    requireString(payload.expected_output, 'expected_output');
    if (!payload.summary.trim() || payload.summary.length > 240) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'summary must be a nonblank short title of at most 240 characters');
    if (!payload.expected_output.trim() || payload.expected_output.length > 4000) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'expected_output must be nonblank and at most 4000 characters');
    if (payload.acceptance_conditions === undefined || payload.acceptance_conditions === null ||
      (typeof payload.acceptance_conditions !== 'object' && !Array.isArray(payload.acceptance_conditions))) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'acceptance_conditions must be an object or array');
    }
    if ((Array.isArray(payload.acceptance_conditions) && payload.acceptance_conditions.length === 0) ||
      (!Array.isArray(payload.acceptance_conditions) && Object.keys(payload.acceptance_conditions).length === 0)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'acceptance_conditions must contain at least one condition');
    }
    const timebox = payload.timebox_ms ?? 60 * 60 * 1000;
    if (!Number.isInteger(timebox) || timebox <= 0) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'timebox_ms must be a positive integer');
    const responsibilityKey = payload.responsibility_key ?? null;
    if (responsibilityKey !== null && (typeof responsibilityKey !== 'string' || responsibilityKey.length === 0 || responsibilityKey.length > 256)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_TASK_CONTRACT, 'responsibility_key must be a non-empty string of at most 256 characters');
    }
    return { timebox_ms: timebox };
  }

  #assertDependencyCycle(taskId, prerequisiteTaskId) {
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

  #taskDependencyBlockers(taskId) {
    return this.db.prepare(`SELECT r.relation_id, r.related_task_id, prerequisite.state AS prerequisite_state,
      COALESCE((SELECT c.replacement_task_id FROM task_cancellations c WHERE c.task_id = r.related_task_id),
      (SELECT f.replacement_task_id FROM execution_finish_intents f
       JOIN executions e ON e.execution_id = f.execution_id
       WHERE e.task_id = r.related_task_id AND f.outcome = 'cancelled' AND f.closed_at IS NOT NULL
       ORDER BY f.closed_at DESC, f.execution_id DESC LIMIT 1)) AS replacement_task_id
      FROM task_relations r LEFT JOIN tasks prerequisite ON prerequisite.task_id = r.related_task_id
      WHERE r.task_id = ? AND r.relation_kind = 'depends_on' AND prerequisite.state IS NOT 'DONE'
      ORDER BY r.created_at, r.relation_id`).all(taskId)
      .map((row) => ({
        prerequisite_task_id: row.related_task_id,
        relation_id: row.relation_id,
        prerequisite_state: row.prerequisite_state,
        ...(['CANCELED'].includes(row.prerequisite_state) ? { invalid_prerequisite: true, replacement_task_id: row.replacement_task_id } : {}),
      }));
  }

  #createTaskRecord(payload, envelope) {
    payload = normalizeTaskContractText(payload);
    const removedFields = ['task_type', 'task_type_version', 'parallel_quota', 'max_attempts', 'retry_policy', 'capability_requirements', 'capabilityRequirements'];
    const unsupported = removedFields.filter(field => Object.hasOwn(payload, field));
    if (unsupported.length) throw new SwarmEnvError(ERROR_CODES.INVALID_TASK_CONTRACT, 'Task proposal contains unsupported fields', { unsupported_fields: unsupported });
    const callerBot = this.getBot(envelope.actor_ref);
    if (payload.mission_id === undefined && callerBot) payload = { ...payload, mission_id: callerBot.mission_id };
    const { timebox_ms: timeboxMs } = this.#assertTaskRecordInput(payload);
    const missionId = payload.mission_id;
    const mission = this.#getMission(missionId);
    if (!mission) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown mission: ${missionId}`);
    this.#assertMissionOpen(missionId);
    const bot = this.getBot(envelope.actor_ref);
    const gap = payload.gap ?? (bot ? null : payload.summary);
    if (bot && payload.gap === undefined) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'gap is required');
    requireString(gap, 'gap');
    if (!gap.trim() || gap.length > 4000) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'gap must describe a concrete Mission contribution in at most 4000 characters');
    if (bot && payload.priority === undefined) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'priority is required');
    const validatedPriority = contractPriority(payload.priority ?? 'medium');
    if (bot) {
      if (!['UNBOUND', 'ACTIVE'].includes(bot.state) || bot.mission_id !== missionId) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Task proposal requires a live Bot in its own Mission');
      if (bot.state === 'ACTIVE' && (!envelope.execution_id || bot.execution_id !== envelope.execution_id)) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bound Task proposal must include the current Bot Execution');
      if (bot.state === 'UNBOUND' && (envelope.execution_id || envelope.task_id || bot.execution_id || Date.parse(bot.selection_deadline) <= Date.now())) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Unbound Task proposal requires valid selection authority');
    }
    let currentExecution = null;
    if (envelope.execution_id !== null && envelope.execution_id !== undefined) {
      currentExecution = this.#executionForWrite(envelope);
      if (bot && (currentExecution.state !== 'RUNNING' || currentExecution.owner_ref !== bot.bot_id || Date.parse(currentExecution.lease_expires_at) <= Date.now())) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Task proposal requires the current active Execution');
      assertNewExecutionWork(currentExecution);
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
    if (payload.workspace != null && (typeof payload.workspace !== 'object' || Array.isArray(payload.workspace))) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'workspace must be an object');
    }
    const workspace = { ...payload.workspace };
    if (payload.base_revision !== undefined) {
      if (typeof payload.base_revision !== 'string' || !/^\d+\.\d+$/.test(payload.base_revision)) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'base_revision must name a fixed public Workspace revision in major.minor form');
      }
      if (workspace.revision !== undefined && workspace.revision !== payload.base_revision) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'base_revision conflicts with workspace.revision');
      }
      workspace.revision = payload.base_revision;
    }
    const inputMaterialRefs = payload.input_material_refs ?? [];
    if (!Array.isArray(inputMaterialRefs) || inputMaterialRefs.length > 100 ||
        inputMaterialRefs.some(id => typeof id !== 'string' || !id)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Task input Materials must contain at most 100 IDs');
    }
    const taskInstructions = payload.task_instructions ?? '';
    const responsibilityKey = payload.responsibility_key ?? null;
    const dependsOn = payload.depends_on ?? [];
    if (!Array.isArray(dependsOn) || dependsOn.some((id) => typeof id !== 'string' || id.length === 0)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'depends_on must contain Task IDs');
    }
    const uniqueDependsOn = [...new Set(dependsOn)];
    for (const prerequisiteId of uniqueDependsOn) {
      const prerequisite = this.getTask(prerequisiteId);
      if (!prerequisite || this.#taskMissionId(prerequisiteId) !== missionId) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'depends_on must identify Tasks in the same Mission');
      }
      if (['CANCELED'].includes(prerequisite.state)) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'depends_on cannot identify a cancelled Task', { prerequisite_task_id: prerequisiteId });
      }
      this.#assertDependencyCycle(taskId, prerequisiteId);
    }
    const createdAt = now();
    const ownerRef = payload.owner_ref ?? envelope.actor_ref;
    requireString(ownerRef, 'owner_ref');
    const priority = validatedPriority;
    if (!Number.isInteger(priority) || priority < 0) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'priority must be a non-negative integer');
    const completionContract = { ...(payload.completion_contract ?? {}) };
    if (!completionContract || typeof completionContract !== 'object' || Array.isArray(completionContract)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'completion_contract must be an object');
    }
    if (completionContract.workspace_delivery !== undefined) this.#assertWorkspaceDelivery(completionContract.workspace_delivery);
    if (completionContract.required_materials !== undefined && (!Array.isArray(completionContract.required_materials) ||
        completionContract.required_materials.some(requirement => !requirement || typeof requirement !== 'object' || Array.isArray(requirement) ||
          Object.keys(requirement).some(field => !['role', 'min_count', 'requires_consumption', 'action', 'cross_task'].includes(field)) ||
          (requirement.role !== undefined && !['input', 'response', 'handoff', 'experience'].includes(requirement.role)) ||
          (requirement.min_count !== undefined && (!Number.isInteger(requirement.min_count) || requirement.min_count < 1))))) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_TASK_CONTRACT, 'required_materials accepts Task link role, min_count, requires_consumption, action and cross_task');
    }

    const requiredCapabilities = payload.required_capabilities;
    if (requiredCapabilities !== undefined) {
      if (!Array.isArray(requiredCapabilities) || requiredCapabilities.some((value) => typeof value !== 'string' || value.length === 0)) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_TASK_CONTRACT, 'required_capabilities must contain non-empty capability IDs');
      }
      completionContract.required_capabilities = [...new Set(requiredCapabilities)];
    }
    const spec = {
      task_id: taskId, mission_id: missionId, summary: payload.summary, gap,
      goal: payload.goal ?? payload.summary, expected_output: payload.expected_output,
      acceptance_conditions: payload.acceptance_conditions, completion_contract: completionContract,
      timebox_ms: timeboxMs, owner_ref: ownerRef, priority, responsibility_key: responsibilityKey,
      collaboration_reason: payload.collaboration_reason ?? null,
    };
    const fixedInputs = { workspace, input_material_refs: [...new Set(inputMaterialRefs)].sort(), task_instructions: taskInstructions };
    const fixedSpec = { ...spec, ...fixedInputs, depends_on: [...uniqueDependsOn].sort() };
    const registrationHash = hash({ summary: payload.summary, gap, expected_output: payload.expected_output,
      acceptance_conditions: payload.acceptance_conditions, priority, workspace,
      input_material_refs: fixedInputs.input_material_refs, task_instructions: taskInstructions,
      depends_on: fixedSpec.depends_on, timebox_ms: timeboxMs });
    if (responsibilityKey !== null) {
      const existing = this.db.prepare(`SELECT t.task_id, m.registration_hash FROM tasks t
        JOIN task_records m ON m.task_id = t.task_id
        WHERE m.mission_id = ? AND t.responsibility_key = ?
        ORDER BY t.created_at, t.task_id LIMIT 1`).get(missionId, responsibilityKey);
      if (existing) {
        if (existing.registration_hash !== registrationHash) {
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
      task_id, owner_ref, goal, expected_output,
      priority, task_instructions, workspace_json, acceptance_conditions_json, input_material_refs_json,
      spec_version, spec_hash, completion_contract_json, state_version, state,
      block_reason,
      cancelled_at, eligible_at, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) `)
      .run(taskId, ownerRef, payload.goal ?? payload.summary, payload.expected_output,
        priority, taskInstructions, json(workspace), json(payload.acceptance_conditions),
        json(inputMaterialRefs), 1, hash(fixedSpec), json(completionContract), 0, 'OPEN', null,
        null, createdAt, envelope.actor_ref, createdAt, createdAt);
    this.db.prepare(`INSERT INTO task_records
      (task_id, mission_id, summary, gap, timebox_ms, registration_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(taskId, missionId, payload.summary, gap, timeboxMs, registrationHash, createdAt, createdAt);
    this.db.prepare('UPDATE tasks SET responsibility_key = ? WHERE task_id = ?').run(responsibilityKey, taskId);
    const relationStatement = this.db.prepare(`INSERT INTO task_relations
      (relation_id, mission_id, task_id, relation_kind, related_task_id,
       created_by_task_id, created_by_execution_id, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const prerequisiteId of uniqueDependsOn) relationStatement.run(randomUUID(), missionId, taskId, 'depends_on', prerequisiteId, envelope.task_id ?? null, envelope.execution_id ?? null, envelope.actor_ref, createdAt);
    this.#recordContractRevision(this.getTask(taskId), envelope.actor_ref, 'Initial Task proposal');
    return {
      task: this.#decorateTaskRecord(rowToTask(this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId))),
      created_from_execution_id: currentExecution?.execution_id ?? null,
    };
  }

  #listTaskRecords(payload = {}) {
    const missionId = payload.mission_id ?? null;
    if (missionId !== null) requireString(missionId, 'mission_id');
    const states = payload.states ?? (payload.state ? [payload.state] : ['OPEN', 'BLOCKED', 'RUNNING', 'DONE', 'CANCELED']);
    if (!Array.isArray(states) || states.length === 0 || states.some((state) => typeof state !== 'string' || state.length === 0)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'states must contain at least one Task state');
    }
    const limit = payload.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'limit must be between 1 and 500');
    const search = payload.search ?? null;
    if (search !== null && (typeof search !== 'string' || search.length === 0)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'search must be a non-empty string or null');
    const placeholders = states.map(() => '?').join(', ');
    const where = [`t.state IN (${placeholders})`];
    const params = [...states];
    if (missionId !== null) { where.push('m.mission_id = ?'); params.push(missionId); }
    if (search !== null) { where.push('(m.summary LIKE ? OR t.goal LIKE ? OR t.expected_output LIKE ?)'); params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
    // Apply the page after availability filtering. Limiting the SQL rows
    // first can hide later eligible Tasks behind blocked or occupied rows and
    // make a bounded page look like an empty/complete queue.
    const availableOnly = payload.available_only ?? false;
    const queryLimit = availableOnly ? -1 : limit;
    const rows = this.db.prepare(`SELECT t.* FROM tasks t JOIN task_records m ON m.task_id = t.task_id
      WHERE ${where.join(' AND ')} ORDER BY t.priority DESC, t.created_at, t.task_id LIMIT ?`).all(...params, queryLimit);
    const filtered = rows.map((row) => this.#decorateTaskRecord(rowToTask(row))).filter((task) => {
      if (!availableOnly) return true;
      if (task.state !== 'OPEN') return false;
      return this.#gatingDependencyBlockers(task).length === 0;
    });
    return filtered.slice(0, limit);
  }

  #listTaskPage(payload, envelope) {
    const bot = this.getBot(envelope.actor_ref);
    if (bot) {
      this.assertBotDeadline(bot.bot_id);
      if (!['UNBOUND', 'ACTIVE'].includes(bot.state) || (bot.state === 'UNBOUND' && Date.parse(bot.selection_deadline) <= Date.now())) {
        throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bot is not available for Task discovery');
      }
      if (payload.mission_id && payload.mission_id !== bot.mission_id) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Task discovery must stay within the Bot Mission');
    }
    const missionId = bot?.mission_id ?? payload.mission_id ?? null;
    if (missionId !== null) requireString(missionId, 'mission_id');
    const aliases = { ready: 'OPEN', running: 'RUNNING', blocked: 'BLOCKED', done: 'DONE', canceled: 'CANCELED' };
    const requestedStates = payload.states ?? (payload.state ? [payload.state] : ['OPEN', 'RUNNING', 'BLOCKED', 'DONE', 'CANCELED']);
    if (!Array.isArray(requestedStates) || !requestedStates.length || requestedStates.length > 16 || requestedStates.some(value => typeof value !== 'string' || !value)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Task states must be a bounded nonempty list');
    const states = [...new Set(requestedStates.map(value => aliases[value.toLowerCase()] ?? value.toUpperCase()))].sort();
    const query = payload.query ?? null;
    if (query !== null && (typeof query !== 'string' || !query || query.length > 4000)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Task query must contain 1 to 4000 characters');
    const limit = payload.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Task page limit must be between 1 and 100');
    const availableOnly = payload.available_only ?? false;
    if (typeof availableOnly !== 'boolean') throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'available_only must be boolean');
    const scope = { mission_id: missionId, states, query, available_only: availableOnly };
    const fingerprint = hash(scope);
    let continuation = null;
    if (payload.cursor !== undefined && payload.cursor !== null) {
      try {
        if (typeof payload.cursor !== 'string' || !payload.cursor || payload.cursor.length > 4096) throw new Error('invalid cursor');
        continuation = JSON.parse(Buffer.from(payload.cursor, 'base64url').toString('utf8'));
        if (continuation.version !== 1 || continuation.query_hash !== fingerprint ||
            !Number.isSafeInteger(continuation.ceiling) || !Number.isSafeInteger(continuation.after) ||
            continuation.after < 0 || continuation.after > continuation.ceiling || !Number.isFinite(Date.parse(continuation.started_at))) throw new Error('cursor mismatch');
      } catch { throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Task cursor is invalid or belongs to another query scope'); }
    }
    const ceiling = continuation?.ceiling ?? Number((missionId === null
      ? this.db.prepare('SELECT COALESCE(MAX(rowid), 0) AS ceiling FROM task_records').get()
      : this.db.prepare('SELECT COALESCE(MAX(rowid), 0) AS ceiling FROM task_records WHERE mission_id = ?').get(missionId)).ceiling);
    const startedAt = continuation?.started_at ?? now();
    const after = continuation?.after ?? 0;
    const scopeSql = missionId === null ? '' : 'AND mission_id = ?';
    // Bound the raw Mission window before applying any content/state filter.
    // The Mission-only index includes rowid implicitly, so sparse matches do
    // not force sorting or scanning the rest of the Mission on every page.
    const rows = this.db.prepare(`WITH page AS MATERIALIZED (
      SELECT task_id, mission_id, summary, gap, timebox_ms, rowid AS creation_sequence
      FROM task_records WHERE rowid > ? AND rowid <= ? ${scopeSql} ORDER BY rowid LIMIT 501
    ) SELECT t.task_id, t.state, t.spec_version, t.state_version, t.priority, t.created_at, t.updated_at,
      substr(t.block_reason, 1, 1000) AS block_reason, length(t.block_reason) AS block_reason_length,
      substr(t.expected_output, 1, 1000) AS expected_output, length(t.expected_output) AS expected_output_length,
      page.mission_id, page.timebox_ms, page.creation_sequence,
      substr(page.summary, 1, 1000) AS summary, length(page.summary) AS summary_length,
      substr(page.gap, 1, 1000) AS gap, length(page.gap) AS gap_length,
      (? IS NULL OR page.summary LIKE ? OR t.goal LIKE ? OR t.expected_output LIKE ? OR page.gap LIKE ?) AS query_matches
      FROM page JOIN tasks t ON t.task_id = page.task_id ORDER BY page.creation_sequence`).all(
      after, ceiling, ...(missionId === null ? [] : [missionId]), query, ...Array(4).fill(query === null ? null : `%${query}%`));
    const dependencySummary = this.db.prepare(`SELECT
      EXISTS(SELECT 1 FROM task_relations WHERE task_id = ? AND relation_kind = 'depends_on') AS present`);
    const tasks = [];
    let scanned = 0, last = after;
    for (const row of rows.slice(0, 500)) {
      last = row.creation_sequence; scanned += 1;
      if (!states.includes(row.state) || !row.query_matches) continue;
      const dependency = dependencySummary.get(row.task_id);
      const unsatisfied = dependency.present && this.#gatingDependencyBlockers(row.task_id).length > 0;
      const ready = row.state === 'OPEN' && !unsatisfied;
      if (availableOnly && !ready) continue;
      const cancelled = row.state === 'CANCELED'
        ? this.db.prepare('SELECT substr(reason, 1, 1000) AS reason, length(reason) AS reason_length FROM task_cancellations WHERE task_id = ?').get(row.task_id) ??
          this.db.prepare(`SELECT substr(f.reason, 1, 1000) AS reason, length(f.reason) AS reason_length
            FROM executions e JOIN execution_finish_intents f ON f.execution_id = e.execution_id
            WHERE e.task_id = ? AND f.outcome = 'cancelled' AND f.closed_at IS NOT NULL
            ORDER BY f.closed_at DESC, e.execution_id DESC LIMIT 1`).get(row.task_id) : null;
      const truncated = ['summary', 'gap', 'expected_output', 'block_reason'].filter(field => row[`${field}_length`] > 1000);
      if (cancelled?.reason_length > 1000) truncated.push('cancellation_reason');
      const owner = this.db.prepare(`SELECT execution_id, owner_ref, state FROM executions WHERE task_id = ? AND state IN ('CREATED', 'RUNNING', 'CLOSING') ORDER BY created_at DESC LIMIT 1`).get(row.task_id) ?? null;
      tasks.push({ task_id: row.task_id, mission_id: row.mission_id, summary: row.summary,
        gap: row.gap, contract_format: 'mission-gap-v1',
        priority_level: ['low', 'medium', 'high'][row.priority] ?? null,
        expected_output: row.expected_output, truncated_fields: truncated, state: row.state,
        spec_version: row.spec_version, state_version: row.state_version, priority: row.priority, timebox_ms: row.timebox_ms,
        created_at: row.created_at, updated_at: row.updated_at, available: ready, current_execution: owner,
        dependencies: { present: Boolean(dependency.present), satisfied: !unsatisfied },
        block_reason: row.block_reason, cancellation_reason: cancelled?.reason ?? null });
      if (tasks.length === limit) break;
    }
    const more = rows.some(row => row.creation_sequence > last);
    const cursor = more ? Buffer.from(JSON.stringify({ version: 1, query_hash: fingerprint, ceiling, after: last, started_at: startedAt })).toString('base64url') : null;
    return { tasks, scope, limit, returned: tasks.length, scanned, next_cursor: cursor, truncated: more,
      started_at: startedAt, read_at: now(), membership: 'state-and-availability-at-page-read', order: 'creation',
      guidance: 'Read relevant continuation pages and Task detail before taking. New Tasks after this scan began require a fresh query.' };
  }

  #viewTaskRecord(taskId, envelope, payload = {}) {
    const task = this.#decorateTaskRecord(rowToTask(this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId)));
    if (!task?.mission_id) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown Task: ${taskId}`);
    const bot = this.getBot(envelope.actor_ref);
    if (bot && bot.mission_id !== task.mission_id) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Task detail is limited to the Bot Mission');
    const history = this.listExecutions(taskId).map(execution => {
      const { execution_id, owner_ref, core_id, attempt_no, state, terminal_reason, workspace_input,
        created_at, updated_at, spec_version, spec_hash } = execution;
      return { execution_id, owner_ref, core_id, attempt_no, state, terminal_reason, workspace_input,
        created_at, updated_at, spec_version, spec_hash, finish: this.getExecutionFinish(execution_id) };
    });
    const finishes = history.map(execution => execution.finish).filter(Boolean);
    const cancellation = this.db.prepare('SELECT * FROM task_cancellations WHERE task_id = ?').get(taskId) ?? null;
    const relations = this.getBot(envelope.actor_ref) ? this.#publicTaskRelations(task.relations) : task.relations;
    const after = payload.contract_history_after_version ?? 0;
    const limit = payload.contract_history_limit ?? 50;
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Contract history requires a nonnegative after version and limit 1..100');
    const versions = this.db.prepare('SELECT * FROM task_contract_revisions WHERE task_id = ? AND spec_version > ? ORDER BY spec_version LIMIT ?').all(taskId, after, limit + 1);
    const historyPage = versions.slice(0, limit).map(({ contract_json, ...row }) => ({ ...row, contract: parse(contract_json) }));
    return { task, mission: this.#getMission(task.mission_id), relations, blockers: task.blockers,
      contract_history: historyPage, contract_history_page: { complete: versions.length <= limit,
        next_after_version: versions.length > limit ? historyPage.at(-1).spec_version : null },
      materials: task.materials, executions: history, finishes, cancellation };
  }

  #linkMaterial(payload, envelope) {
    const caller = this.materialScope(envelope, { write: true });
    const materialId = requireString(payload.material_id, 'material_id');
    if (!this.contextService) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Context Service is required for Task Material links');
    const material = this.contextService.getMaterial(materialId);
    if (!material) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown Material: ${materialId}`);
    if (material.mission_id !== caller.mission_id) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Material belongs to another Mission');
    const role = payload.role ?? 'experience';
    if (!['input', 'response', 'handoff', 'experience'].includes(role)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'role must be input, response, handoff, or experience');
    }
    // Purpose belongs to this Task link, not to the immutable Material.
    const producerTaskId = requireString(material.producer_task_id, 'material producer_task_id');
    const producerExecutionId = requireString(material.producer_execution_id, 'material producer_execution_id');
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
    if (caller.mission_id !== this.#taskMissionId(targetTaskId) || caller.mission_id !== this.#taskMissionId(producerTaskId)) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Material links must stay within the caller Mission');
    }
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
        WHERE task_id = ? AND state IN ('CREATED', 'RUNNING', 'CLOSING')
        ORDER BY attempt_no DESC, created_at DESC LIMIT 1`).get(targetTaskId);
      const missionId = this.#taskMissionId(targetTaskId);
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

  #validateTaskCompletion(payload, envelope) {
    const execution = this.#executionForWrite(envelope);
    if (execution.owner_ref !== envelope.actor_ref) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'only the current Task Execution owner may complete the Task');
    }
    if (!['CREATED', 'RUNNING'].includes(execution.state)) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `cannot complete Execution in ${execution.state}`);
    }
    const task = this.getTask(execution.task_id);
    const requestedMaterialIds = payload.material_ids ?? [];
    if (!Array.isArray(requestedMaterialIds) || requestedMaterialIds.some((id) => typeof id !== 'string' || id.length === 0)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'material_ids must be an array of Material IDs');
    }
    const linked = this.#taskMaterialLinks(task.task_id);
    const producedResponseLinks = this.db.prepare(`SELECT * FROM task_material_links
      WHERE producer_task_id = ? AND role = 'response'
      ORDER BY created_at, link_id`).all(task.task_id)
      .map(row => this.#scopedMaterialLink(row, task.mission_id)).filter(Boolean);
    const completionLinks = [...linked, ...producedResponseLinks].filter((link, index, links) =>
      links.findIndex((candidate) => candidate.link_id === link.link_id) === index);
    const linkedIds = new Set(completionLinks.map((link) => link.material_id));
    const unlinked = [...new Set(requestedMaterialIds)].filter((id) => !linkedIds.has(id));
    if (unlinked.length > 0) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'task finish can reference only linked Materials. Use swarm task link before citing them.', { unlinked_material_ids: unlinked });
    }
    const requestedCheckResultId = payload.check_result_id ?? null;
    if (requestedCheckResultId) {
      const requestedCheck = this.getCheckResult(requestedCheckResultId);
      if (!requestedCheck) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown CheckResult: ${requestedCheckResultId}`);
      if (requestedCheck.execution_id !== execution.execution_id || requestedCheck.target_task_id !== task.task_id) {
        throw new SwarmEnvError(ERROR_CODES.FENCED, 'CheckResult does not belong to the current Task Execution');
      }
      if (requestedCheck.status === 'RECEIVED' && (!task.completion_contract.workspace_delivery?.check || task.completion_contract.required_check)) {
        this.db.prepare("UPDATE check_results SET status = 'APPLIED', applied_task_state_version = ?, applied_at = ?, updated_at = ? WHERE check_result_id = ?")
          .run(task.state_version + 1, now(), now(), requestedCheckResultId);
      }
    }
    const delivery = this.#validateWorkspaceDelivery(task, execution, payload, requestedCheckResultId);
    const completion = this.#completion(task, execution, requestedCheckResultId);
    if (!completion.satisfied) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'completion_contract is not satisfied', { missing: completion.missing });
    }
    return { materials: completionLinks, delivery };
  }

  #assertHandoffMaterial(execution, payload) {
    const materialId = requireString(payload.handoff_material_id, 'handoff_material_id');
    if (!this.contextService) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Context Service is required for Task handoff');
    const material = this.contextService.getMaterial(materialId);
    if (!material) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown Handoff Material: ${materialId}`);
    if (material.producer_task_id !== execution.task_id || material.producer_execution_id !== execution.execution_id) {
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

  #taskStatus(payload, envelope) {
    const missionId = requireString(payload.mission_id, 'mission_id');
    const mission = this.#getMission(missionId);
    if (!mission) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown mission: ${missionId}`);
    const states = payload.states ?? ['OPEN', 'BLOCKED', 'RUNNING', 'DONE', 'CANCELED'];
    const limit = payload.limit ?? 100;
    const isBot = Boolean(this.getBot(envelope.actor_ref));
    const taskPage = isBot ? this.#listTaskPage({ mission_id: missionId, states, limit }, envelope) : null;
    const eligiblePage = isBot ? this.#listTaskPage({ mission_id: missionId, states: ['OPEN'], limit, available_only: true }, envelope) : null;
    const tasks = taskPage?.tasks ?? this.#listTaskRecords({ mission_id: missionId, states, limit, available_only: false });
    const eligible = eligiblePage?.tasks ?? this.#listTaskRecords({
      mission_id: missionId,
      states: ['OPEN', 'RUNNING'],
      limit,
      available_only: true,
    });
    const statePlaceholders = states.map(() => '?').join(', ');
    const pageTotal = isBot ? null : Number(this.db.prepare(`SELECT COUNT(*) AS count FROM tasks t
      JOIN task_records m ON m.task_id = t.task_id
      WHERE m.mission_id = ? AND t.state IN (${statePlaceholders})`).get(missionId, ...states).count ?? 0);
    const counts = this.db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN t.state = 'OPEN' THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN t.state = 'RUNNING' THEN 1 ELSE 0 END) AS running,
      SUM(CASE WHEN t.state IN ('DONE', 'CANCELED') THEN 1 ELSE 0 END) AS terminal,
      0 AS eligible
      FROM tasks t JOIN task_records m ON m.task_id = t.task_id WHERE m.mission_id = ?`).get(missionId);
    const lanes = this.db.prepare(`SELECT e.core_id, e.task_id, e.execution_id, e.state, e.owner_ref, e.updated_at
      FROM executions e JOIN task_records m ON m.task_id = e.task_id
      WHERE m.mission_id = ? AND e.core_id IS NOT NULL AND e.state IN ('CREATED', 'RUNNING', 'CLOSING')
      ORDER BY e.core_id, e.updated_at, e.execution_id`).all(missionId).reduce((byCore, row) => {
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
        terminal: Number(counts.terminal ?? 0),
        eligible: eligiblePage?.truncated ? null : eligible.length,
      },
      page: { limit, returned: tasks.length, total: pageTotal,
        complete: taskPage ? !taskPage.truncated : tasks.length >= pageTotal },
      ...(isBot ? { eligible_page: { limit, returned: eligible.length, complete: !eligiblePage.truncated },
        guidance: 'Use task list for continued discovery. Status summarizes the first bounded window.' } : {}),
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
    return this.#takeTask(task, {
      ...payload,
      take_key: payload.take_key ?? envelope.operation_id,
      owner_ref: envelope.actor_ref,
    }, takeEnvelope);
  }

  #taskFeedback(payload, envelope) {
    const execution = this.#executionForWrite(envelope);
    const notificationId = requireString(payload.notification_id, 'notification_id');
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

  #read(operation, payload, envelope) {
    if (operation === 'mission_get') return this.#getMission(requireString(payload.mission_id, 'mission_id'));
    if (operation === 'task_status') return this.#taskStatus(payload, envelope);
    if (operation === 'task_list') return this.#listTaskPage(payload, envelope);
    if (operation === 'task_view') return this.#viewTaskRecord(requireString(payload.task_id ?? envelope.task_id, 'task_id'), envelope, payload);
    if (operation === 'task_materials') {
      const taskId = requireString(payload.task_id ?? envelope.task_id, 'task_id');
      if (!this.getTask(taskId)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown Task: ${taskId}`);
      return { links: this.#taskMaterialLinks(taskId, { role: payload.role ?? null, materialId: payload.material_id ?? null }) };
    }
    throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unsupported Task Service read operation: ${operation}`);
  }

  #mutate(operation, payload, envelope) {
    switch (operation) {
      case 'bot_exit': return this.#exitBot(payload, envelope);
      case 'mission_create': return this.#createMission(payload, envelope);
      case 'task_create': return this.#createTaskRecord(payload, envelope);
      case 'task_revise': return this.#reviseTask(payload, envelope);
      case 'task_cancel': return this.#cancelUnownedTask(payload, envelope);
      case 'task_dependency_replace': return this.#replaceInvalidTaskDependency(payload, envelope);
      case 'task_link_material': return this.#linkMaterial(payload, envelope);
      case 'task_finish': return this.#finishTask(payload, envelope);
      case 'task_take': return this.#taskTake(payload, envelope);
      case 'task_feedback': return this.#taskFeedback(payload, envelope);
      case 'reconcile_task': return this.#reconcileTask(payload, envelope);
      case 'heartbeat': return this.#heartbeat(payload, envelope);
      case 'stop_execution': return this.#stopExecution(payload, envelope);
      case 'record_handoff_reminder': return this.#recordHandoffReminder(payload, envelope);
      case 'start_execution': return this.#startExecution(payload, envelope);
      case 'save_workspace_revision': return this.#saveWorkspaceRevision(payload, envelope);
      case 'fence_execution': return this.#fenceExecution(payload, envelope);
      default: throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unsupported Task Service operation: ${operation}`);
    }
  }

  #acceptTaskFinish(payload, envelope, { outcome, terminalState, waitForTaskId = null, replacementTaskId = null }) {
    const bot = this.getBot(envelope.actor_ref);
    if (bot && (bot.state !== 'ACTIVE' || bot.execution_id !== envelope.execution_id)) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Only an active Bot may request a new Task finish');
    }
    const execution = this.#executionForWrite(envelope);
    if (execution.owner_ref !== envelope.actor_ref || !['CREATED', 'RUNNING'].includes(execution.state)) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'only the current active owner may finish');
    }
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'execution_workspace_requests'").get() &&
        this.db.prepare("SELECT 1 FROM execution_workspace_requests WHERE execution_id = ? AND phase IN ('installing', 'installed') LIMIT 1").get(execution.execution_id)) {
      throw new SwarmEnvError(ERROR_CODES.WORKSPACE_BUSY, 'Workspace apply must settle before Task finish can be accepted', undefined, { retryable: true });
    }
    const acceptedAt = now();
    this.db.prepare(`INSERT INTO execution_finish_intents
      (execution_id, request_id, outcome, payload_json, terminal_state, reason, wait_for_task_id, replacement_task_id, accepted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(execution.execution_id, envelope.operation_id, outcome, json(payload),
        terminalState, payload.reason ?? outcome, waitForTaskId, replacementTaskId, acceptedAt);
    this.db.prepare("UPDATE executions SET state = 'CLOSING', state_version = state_version + 1, updated_at = ? WHERE execution_id = ?")
      .run(acceptedAt, execution.execution_id);
    this.db.prepare("UPDATE bots SET state = 'CLOSING', state_version = state_version + 1, updated_at = ? WHERE execution_id = ? AND state <> 'CLOSED'")
      .run(acceptedAt, execution.execution_id);
    return { task: this.getTask(execution.task_id), execution: this.getExecution(execution.execution_id), disposition: 'closing' };
  }

  #finishTask(payload, envelope) {
    const outcome = String(payload.outcome ?? '').toLowerCase();
    if (!['done', 'incomplete', 'blocked', 'cancelled'].includes(outcome)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'task.finish outcome must be done, incomplete, blocked, or cancelled');
    }
    if (outcome === 'done') {
      const { materials, delivery } = this.#validateTaskCompletion(payload, envelope);
      const intent = { ...payload };
      delete intent.workspace_delivery;
      if (delivery) intent.workspace_delivery = delivery;
      return { ...this.#acceptTaskFinish(intent, envelope, { outcome, terminalState: 'SUCCEEDED' }),
        materials, ...(delivery ? { workspace_delivery: delivery } : {}) };
    }
    if (outcome === 'incomplete') {
      const execution = this.#executionForWrite(envelope);
      if (execution.owner_ref !== envelope.actor_ref) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'only the current owner may finish');
      if (payload.handoff_material_id) this.#assertHandoffMaterial(execution, payload);
      return this.#acceptTaskFinish(payload, envelope, { outcome, terminalState: 'HANDED_OFF' });
    }
    if (outcome === 'blocked') {
      const execution = this.#executionForWrite(envelope);
      const blocker = payload.blocker ?? payload.reason;
      const prerequisiteTaskId = payload.wait_for;
      if (!blocker || (typeof blocker !== 'object' && typeof blocker !== 'string')) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'task.finish blocked requires blocker');
      }
      if (typeof prerequisiteTaskId !== 'string' || prerequisiteTaskId.length === 0 || prerequisiteTaskId === execution.task_id) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'task.finish blocked requires a distinct prerequisite Task ID');
      }
      const prerequisite = this.getTask(prerequisiteTaskId);
      if (!prerequisite || this.#taskMissionId(prerequisiteTaskId) !== this.#taskMissionId(execution.task_id)) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'wait_for must identify a Task in the same Mission');
      }
      this.#assertDependencyCycle(execution.task_id, prerequisiteTaskId);
      if (['CANCELED'].includes(prerequisite.state)) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'wait_for cannot identify a cancelled Task');
      }
      const existing = this.db.prepare("SELECT relation_id FROM task_relations WHERE task_id = ? AND relation_kind = 'depends_on' AND related_task_id = ?")
        .get(execution.task_id, prerequisiteTaskId);
      if (!existing) this.db.prepare(`INSERT INTO task_relations
        (relation_id, mission_id, task_id, relation_kind, related_task_id, created_by_task_id, created_by_execution_id, created_by, created_at)
        VALUES (?, ?, ?, 'depends_on', ?, ?, ?, ?, ?)`).run(randomUUID(), this.#taskMissionId(execution.task_id), execution.task_id,
          prerequisiteTaskId, execution.task_id, execution.execution_id, envelope.actor_ref, now());
      return this.#acceptTaskFinish(payload, envelope, { outcome, terminalState: 'HANDED_OFF', waitForTaskId: prerequisiteTaskId });
    }
    const execution = this.#executionForWrite(envelope);
    requireString(payload.reason, 'reason');
    const replacementTaskId = payload.replacement_task_id ?? null;
    this.#assertTaskReplacement(execution.task_id, replacementTaskId);
    return this.#acceptTaskFinish(payload, envelope, { outcome, terminalState: 'CANCELLED', replacementTaskId });
  }

  #assertTaskReplacement(taskId, replacementTaskId) {
    if (replacementTaskId !== null) {
      if (typeof replacementTaskId !== 'string' || replacementTaskId.length === 0 || replacementTaskId === taskId) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'replacement_task_id must identify another Task');
      }
      const replacement = this.getTask(replacementTaskId);
      if (!replacement || this.#taskMissionId(replacementTaskId) !== this.#taskMissionId(taskId) || ['CANCELED'].includes(replacement.state)) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'replacement_task_id must identify a non-cancelled Task in the same Mission');
      }
      const seen = new Set([taskId]);
      let candidate = replacementTaskId;
      while (candidate) {
        if (seen.has(candidate)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'replacement would create a cycle');
        seen.add(candidate);
        const cancelled = this.db.prepare('SELECT replacement_task_id FROM task_cancellations WHERE task_id = ?').get(candidate);
        candidate = cancelled ? cancelled.replacement_task_id : this.db.prepare(`SELECT f.replacement_task_id FROM execution_finish_intents f
          JOIN executions e ON e.execution_id = f.execution_id
          WHERE e.task_id = ? AND f.outcome = 'cancelled' ORDER BY f.accepted_at DESC LIMIT 1`).get(candidate)?.replacement_task_id;
      }
    }
  }

  #coordinationTarget(payload, envelope, operation, allowedStates) {
    let scope;
    if (operation === 'task_revise' || operation === 'task_cancel') {
      const bot = this.getBot(envelope.actor_ref);
      if (bot?.state !== 'UNBOUND') throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Task revision and cancellation require an UNBOUND Bot');
      this.#assertMissionOpen(bot.mission_id);
      scope = this.materialScope(envelope);
    } else scope = this.assertMissionCoordination(envelope, operation);
    const taskId = requireString(payload.task_id, 'task_id');
    const task = this.getTask(taskId);
    if (!task || task.mission_id !== scope.mission_id) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Task coordination requires a target in the Bot Mission');
    }
    if (!Number.isSafeInteger(payload.expected_spec_version) || !Number.isSafeInteger(payload.expected_state_version)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Expected Task spec and state versions are required');
    }
    if (task.spec_version !== payload.expected_spec_version || task.state_version !== payload.expected_state_version) {
      throw new SwarmEnvError(ERROR_CODES.STALE_VERSION, 'Task changed; reread before coordination', {
        expected_spec_version: task.spec_version, expected_state_version: task.state_version,
      });
    }
    const owned = this.db.prepare("SELECT 1 FROM executions WHERE task_id = ? AND state IN ('CREATED', 'RUNNING', 'CLOSING') LIMIT 1").get(taskId);
    const cleaning = this.db.prepare(`SELECT 1 FROM executions e LEFT JOIN bots b ON b.execution_id = e.execution_id
      LEFT JOIN execution_finish_intents f ON f.execution_id = e.execution_id
      WHERE e.task_id = ? AND (b.state IN ('ACTIVE', 'CLOSING') OR (f.execution_id IS NOT NULL AND f.closed_at IS NULL)) LIMIT 1`).get(taskId);
    if (owned || cleaning || !allowedStates.includes(task.state)) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Task coordination requires an unowned Task in an eligible state');
    }
    return { task, scope };
  }

  #recordContractRevision(task, actorRef, reason) {
    const fields = ['task_id', 'mission_id', 'summary', 'gap', 'contract_format', 'goal', 'expected_output',
      'acceptance_conditions', 'completion_contract', 'priority', 'priority_level', 'timebox_ms', 'task_instructions',
      'workspace', 'input_material_refs', 'spec_version', 'spec_hash', 'owner_ref', 'responsibility_key'];
    const contract = Object.fromEntries(fields.map(field => [field, task[field]]));
    contract.depends_on = task.relations.depends_on.map(row => row.related_task_id).sort();
    this.db.prepare(`INSERT OR IGNORE INTO task_contract_revisions
      (task_id, spec_version, spec_hash, actor_ref, reason, contract_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(task.task_id, task.spec_version, task.spec_hash, actorRef, reason, json(contract), now());
    return { ...this.db.prepare('SELECT * FROM task_contract_revisions WHERE task_id = ? AND spec_version = ?').get(task.task_id, task.spec_version), contract };
  }

  #reviseTask(payload, envelope) {
    const { task } = this.#coordinationTarget(payload, envelope, 'task_revise', ['OPEN', 'BLOCKED']);
    const reason = requireString(payload.reason, 'reason');
    if (!reason.trim() || reason.length > 4000) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Revision reason must be nonblank and at most 4000 characters');
    const changes = payload.changes;
    const allowed = new Set(['summary', 'gap', 'expected_output', 'acceptance_conditions', 'priority', 'depends_on',
      'input_material_refs', 'workspace', 'base_revision', 'task_instructions']);
    if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length || Object.keys(changes).some(key => !allowed.has(key))) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Task changes must contain supported contract fields');
    }
    const next = normalizeTaskContractText({ ...task, ...changes });
    this.#assertTaskRecordInput(next);
    requireString(next.gap, 'gap');
    if (!next.gap.trim() || next.gap.length > 4000) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'gap must describe a concrete Mission contribution in at most 4000 characters');
    const priority = contractPriority(next.priority);
    if (!Array.isArray(next.input_material_refs) || next.input_material_refs.length > 100 || next.input_material_refs.some(id => typeof id !== 'string' || !id)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Task input Materials must contain at most 100 IDs');
    if (typeof next.task_instructions !== 'string' || !next.workspace || typeof next.workspace !== 'object' || Array.isArray(next.workspace)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Task instructions and Workspace inputs have invalid types');
    const workspace = { ...next.workspace };
    if (Object.hasOwn(changes, 'base_revision')) {
      if (typeof changes.base_revision !== 'string' || !/^\d+\.\d+$/.test(changes.base_revision)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'base_revision must name a fixed public revision');
      if (changes.workspace?.revision !== undefined && changes.workspace.revision !== changes.base_revision) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'base_revision conflicts with workspace.revision');
      workspace.revision = changes.base_revision;
    }
    const dependsOn = Object.hasOwn(changes, 'depends_on') ? changes.depends_on : task.relations.depends_on.map(row => row.related_task_id);
    const existingPrerequisites = new Set(task.relations.depends_on.map(row => row.related_task_id));
    if (!Array.isArray(dependsOn) || dependsOn.length > 100 || dependsOn.some(id => typeof id !== 'string' || !id)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'depends_on must contain at most 100 Task IDs');
    for (const id of new Set(dependsOn)) {
      const prerequisite = this.getTask(id);
      if (!prerequisite || prerequisite.mission_id !== task.mission_id ||
          (['CANCELED'].includes(prerequisite.state) && !existingPrerequisites.has(id))) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'New prerequisites require non-cancelled Tasks in the same Mission');
      }
      this.#assertDependencyCycle(task.task_id, id);
    }
    this.#recordContractRevision(task, task.created_by, 'Contract preserved before first revision');
    const at = now();
    if (Object.hasOwn(changes, 'depends_on')) {
      this.db.prepare("DELETE FROM task_relations WHERE task_id = ? AND relation_kind = 'depends_on'").run(task.task_id);
      const insert = this.db.prepare(`INSERT INTO task_relations (relation_id, mission_id, task_id, relation_kind, related_task_id, created_by, created_at)
        VALUES (?, ?, ?, 'depends_on', ?, ?, ?)`);
      for (const id of new Set(dependsOn)) insert.run(randomUUID(), task.mission_id, task.task_id, id, envelope.actor_ref, at);
    }
    const spec = { summary: next.summary, gap: next.gap, expected_output: next.expected_output,
      goal: Object.hasOwn(changes, 'summary') ? next.summary : next.goal, owner_ref: task.owner_ref,
      responsibility_key: task.responsibility_key,
      acceptance_conditions: next.acceptance_conditions, completion_contract: next.completion_contract,
      priority, workspace, depends_on: [...new Set(dependsOn)].sort(), input_material_refs: [...new Set(next.input_material_refs)].sort(),
      task_instructions: next.task_instructions, timebox_ms: next.timebox_ms, task_id: task.task_id, mission_id: task.mission_id };
    this.db.prepare(`UPDATE tasks SET goal = ?, expected_output = ?, acceptance_conditions_json = ?, priority = ?,
      workspace_json = ?, input_material_refs_json = ?, task_instructions = ?, spec_version = spec_version + 1,
      spec_hash = ?, state_version = state_version + 1, updated_at = ? WHERE task_id = ?`)
      .run(Object.hasOwn(changes, 'summary') ? next.summary : next.goal, next.expected_output, json(next.acceptance_conditions), priority,
        json(workspace), json(next.input_material_refs), next.task_instructions, hash(spec), at, task.task_id);
    const registrationHash = hash({ summary: next.summary, gap: next.gap, expected_output: next.expected_output,
      acceptance_conditions: next.acceptance_conditions, priority, workspace,
      input_material_refs: [...new Set(next.input_material_refs)].sort(), task_instructions: next.task_instructions,
      depends_on: [...new Set(dependsOn)].sort(), timebox_ms: next.timebox_ms });
    this.db.prepare('UPDATE task_records SET summary = ?, gap = ?, registration_hash = ?, updated_at = ? WHERE task_id = ?')
      .run(next.summary, next.gap, registrationHash, at, task.task_id);
    this.#reconcileTask({ task_id: task.task_id }, makeEnvelope({ actorRef: 'runtime:contract-reconciliation' }));
    const revised = this.getTask(task.task_id);
    const { contract_json: _stored, ...revision } = this.#recordContractRevision(revised, envelope.actor_ref, reason);
    return { task: revised, revision };
  }

  #cancelUnownedTask(payload, envelope) {
    const { task } = this.#coordinationTarget(payload, envelope, 'task_cancel', ['OPEN', 'BLOCKED']);
    const reason = requireString(payload.reason, 'reason');
    if (!reason.trim() || reason.length > 4000) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Cancellation reason must be nonblank and at most 4000 characters');
    const replacementTaskId = payload.replacement_task_id ?? null;
    this.#assertTaskReplacement(task.task_id, replacementTaskId);
    const at = now();
    this.db.prepare(`INSERT INTO task_cancellations (task_id, operation_id, replacement_task_id, actor_ref, execution_id, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(task.task_id, envelope.operation_id, replacementTaskId, envelope.actor_ref, envelope.execution_id, reason, at);
    this.db.prepare("UPDATE tasks SET state = 'CANCELED', cancelled_at = ?, block_reason = NULL, eligible_at = NULL, state_version = state_version + 1, updated_at = ? WHERE task_id = ?")
      .run(at, at, task.task_id);
    this.#reconcileDependents(task.task_id);
    return { task: this.getTask(task.task_id), cancellation: { ...this.db.prepare('SELECT * FROM task_cancellations WHERE task_id = ?').get(task.task_id) } };
  }

  #reconcileDependents(taskId) {
    const dependents = this.db.prepare(`SELECT task_id FROM task_relations WHERE relation_kind = 'depends_on' AND related_task_id = ?`).all(taskId);
    for (const dependent of dependents) this.#reconcileTask({ task_id: dependent.task_id }, makeEnvelope({ actorRef: 'runtime:dependency-reconciliation' }));
  }

  #replaceInvalidTaskDependency(payload, envelope) {
    const { task, scope } = this.#coordinationTarget(payload, envelope, 'task_dependency_replace', ['BLOCKED']);
    const from = requireString(payload.from_task_id, 'from_task_id');
    const to = requireString(payload.to_task_id, 'to_task_id');
    const reason = requireString(payload.reason, 'reason');
    const previous = this.db.prepare("SELECT * FROM task_relations WHERE task_id = ? AND relation_kind = 'depends_on' AND related_task_id = ?").get(task.task_id, from);
    const prerequisite = this.getTask(from);
    if (!previous || prerequisite?.mission_id !== scope.mission_id || prerequisite.state !== 'CANCELED') {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Replacement requires an existing cancelled prerequisite');
    }
    const successor = this.getTask(to);
    if (!successor || successor.mission_id !== scope.mission_id || successor.state === 'CANCELED') {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'New prerequisite must be a non-cancelled Task in the same Mission');
    }
    this.#assertDependencyCycle(task.task_id, to);
    const at = now();
    let replacement = this.db.prepare("SELECT relation_id FROM task_relations WHERE task_id = ? AND relation_kind = 'depends_on' AND related_task_id = ?").get(task.task_id, to)?.relation_id;
    if (!replacement) {
      replacement = randomUUID();
      this.db.prepare(`INSERT INTO task_relations (relation_id, mission_id, task_id, relation_kind, related_task_id,
        created_by_task_id, created_by_execution_id, created_by, created_at) VALUES (?, ?, ?, 'depends_on', ?, ?, ?, ?, ?)`)
        .run(replacement, scope.mission_id, task.task_id, to, scope.task_id, scope.execution_id, scope.bot_id, at);
    }
    const original = previous;
    this.db.prepare(`INSERT INTO task_dependency_replacements (operation_id, task_id, original_relation_json, replacement_relation_id, actor_ref, execution_id, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(envelope.operation_id, task.task_id, json(original), replacement, scope.bot_id, scope.execution_id, reason, at);
    if (previous) this.db.prepare('DELETE FROM task_relations WHERE relation_id = ?').run(previous.relation_id);
        const reconciled = this.#reconcileTask({ task_id: task.task_id }, makeEnvelope({ actorRef: 'runtime:dependency-replacement' }));
    if (!reconciled.changed) {
      this.db.prepare('UPDATE tasks SET state_version = state_version + 1, updated_at = ? WHERE task_id = ?').run(at, task.task_id);
    }
    return { task: this.getTask(task.task_id), replaced_relation_id: original.relation_id, replacement_relation_id: replacement };
  }

  #taskRow(taskId) {
    const row = this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
    if (!row) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown Task: ${taskId}`);
    return rowToTask(row);
  }

  #gatingDependencyBlockers(taskOrId) {
    const taskId = typeof taskOrId === 'string' ? taskOrId : taskOrId?.task_id;
    return this.#taskDependencyBlockers(taskId);
  }

  #reconcileTask(payload, envelope) {
    const taskId = requireString(payload.task_id ?? envelope.task_id, 'task_id');
    if (envelope.execution_id !== null) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Controller reconciliation cannot target an Execution');
    const task = this.getTask(taskId);
    if (!task) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown task: ${taskId}`);
    const blockers = this.#gatingDependencyBlockers(task);
    const active = this.db.prepare("SELECT COUNT(*) AS count FROM executions WHERE task_id = ? AND state IN ('CREATED', 'RUNNING', 'CLOSING')").get(taskId).count;
    const updatedAt = now();
    if (TERMINAL_TASK_STATES.includes(task.state) || active > 0) {
      return { task: this.getTask(taskId), changed: false, blockers };
    }
    if (blockers.length > 0 && task.state !== 'BLOCKED') {
      const reason = blockers.map((blocker) => `dependency:${blocker.relation_id ?? 'unknown'}`).join(',');
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

  #takeTask(task, payload, envelope) {
    if (TERMINAL_TASK_STATES.includes(task.state)) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'terminal Task cannot be taken');
    const dependencyBlockers = this.#gatingDependencyBlockers(task);
    if (dependencyBlockers.length > 0) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Task is blocked by an explicit execution dependency', { blockers: dependencyBlockers });
    }
    const takeKey = requireString(payload.take_key, 'take_key');
    const keyFingerprint = operationPayload('take', payload, envelope);
    const existingKey = this.db.prepare('SELECT * FROM take_keys WHERE request_key = ?').get(takeKey);
    if (existingKey) {
      if (existingKey.task_id !== task.task_id || existingKey.fingerprint !== keyFingerprint) {
        throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'take_key was reused with another payload');
      }
      return { task: this.getTask(task.task_id), execution: this.getExecution(existingKey.execution_id) };
    }
    this.#assertMissionOpen(this.#taskMissionId(task.task_id));
    if (envelope.spec_version !== task.spec_version || envelope.state_version !== task.state_version) {
      throw new SwarmEnvError(ERROR_CODES.STALE_VERSION, 'Task take version is stale', { expected_state_version: task.state_version, expected_spec_version: task.spec_version });
    }
    const ownerRef = payload.owner_ref ?? envelope.actor_ref;
    const coreId = payload.core_id ?? null;
    if (coreId !== null) requireString(coreId, 'core_id');
    const bot = this.getBot(ownerRef);
    const occupiedBot = coreId === null ? null : this.db.prepare("SELECT bot_id FROM bots WHERE mission_id = ? AND core_id = ? AND state <> 'CLOSED'").get(this.#taskMissionId(task.task_id), coreId);
    if (occupiedBot && occupiedBot.bot_id !== ownerRef) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Core already owns another Bot');
    if (bot && (envelope.actor_ref !== ownerRef || bot.state !== 'UNBOUND' || bot.execution_id || bot.mission_id !== this.#taskMissionId(task.task_id) || bot.core_id !== coreId || (Date.parse(bot.selection_deadline) <= Date.now() || Date.parse(bot.hard_deadline) <= Date.now()))) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bot cannot reserve another Execution or leave its Mission/Core');
    }

    // A Bot is represented by its authenticated owner reference for the
    // coordination boundary. It may have zero or one active Execution. A
    // successor Bot receives a fresh owner reference after the previous
    // Execution is terminal and fenced.
    const ownerExecution = this.db.prepare("SELECT execution_id, task_id FROM executions WHERE owner_ref = ? AND state IN ('CREATED', 'RUNNING', 'CLOSING') LIMIT 1").get(ownerRef);
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
    const agentPrompt = payload.agent_prompt ?? task.task_instructions ?? '';
    if (typeof agentPrompt !== 'string') throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'agent_prompt must be a string');
    let inputMaterialRefs = payload.input_material_refs ?? task.input_material_refs;
    if (!Array.isArray(inputMaterialRefs)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'input_material_refs must be an array');
    if (bot) {
      inputMaterialRefs = [...new Set([...(task.input_material_refs ?? []), ...inputMaterialRefs])];
      if (inputMaterialRefs.length > 100 || inputMaterialRefs.some(id => typeof id !== 'string' || !id)) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Task input Materials must contain at most 100 distinct IDs');
      }
    }
    const active = this.db.prepare("SELECT execution_id, state FROM executions WHERE task_id = ? AND state IN ('CREATED', 'RUNNING', 'CLOSING') LIMIT 1").get(task.task_id);
    if (active) {
      throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Task already has an active Execution; choose another responsibility or wait for cleanup', { execution_id: active.execution_id, execution_state: active.state, condition: 'task_occupied' });
    }
    if (task.state === 'BLOCKED') {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `Task is blocked: ${task.block_reason ?? 'unknown'}`);
    }
    const inputSnapshotHash = payload.input_snapshot_hash ?? hash({
      task_id: task.task_id,
      spec_hash: task.spec_hash,
      workspace: task.workspace,
      input_material_refs: inputMaterialRefs,
    });
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
      workspace_ref: null,
      workspace_revision: null,
      workspace_content_hash: null,
      started_at: null,
      handoff_deadline: null,
      execution_deadline: null,
      handoff_reminder_sent_at: null,
      handoff_metadata: null,
      terminal_reason: null,
      created_at: createdAt,
      updated_at: createdAt,
    };
    this.db.prepare(`INSERT INTO executions (
      execution_id, task_id, owner_ref, state, state_version, attempt_no, fencing_version, runtime_generation,
      lease_expires_at, heartbeat_at, launch_token, spec_version, spec_hash, agent_prompt, workspace_manifest_ref,
      input_material_refs_json, input_snapshot_hash, workspace_ref, workspace_revision, workspace_content_hash,
      started_at, handoff_deadline, execution_deadline, handoff_reminder_sent_at, handoff_metadata_json, terminal_reason,
      created_at, updated_at
    ) VALUES (${Array.from({ length: 28 }, () => '?').join(', ')})`)
      .run(execution.execution_id, execution.task_id, execution.owner_ref, execution.state, execution.state_version,
        execution.attempt_no, execution.fencing_version, execution.runtime_generation, execution.lease_expires_at,
        execution.heartbeat_at, execution.launch_token, execution.spec_version, execution.spec_hash, execution.agent_prompt,
        execution.workspace_manifest_ref, json(execution.input_material_refs), execution.input_snapshot_hash, execution.workspace_ref,
        execution.workspace_revision, execution.workspace_content_hash,
        execution.started_at, execution.handoff_deadline, execution.execution_deadline, execution.handoff_reminder_sent_at, json(execution.handoff_metadata), execution.terminal_reason,
        execution.created_at, execution.updated_at);
    if (coreId !== null) {
      this.db.prepare('UPDATE executions SET core_id = ? WHERE execution_id = ?').run(coreId, executionId);
    }
    if (bot) this.db.prepare("UPDATE bots SET execution_id = ?, state = 'PREPARING', state_version = state_version + 1, updated_at = ? WHERE bot_id = ?")
      .run(executionId, createdAt, bot.bot_id);
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
    if (execution.state === 'CLOSING') throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'closing Execution cannot accept new contributions');
    if (TERMINAL_EXECUTION_STATES.includes(execution.state)) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'terminal Execution cannot be modified');
    return execution;
  }

  #heartbeat(payload, envelope) {
    const execution = this.#executionForWrite(envelope);
    const at = Date.now();
    if (this.getBot(execution.owner_ref) && !(at < Date.parse(execution.lease_expires_at))) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Execution lease has expired');
    }
    const updatedAt = new Date(at).toISOString();
    const leaseExpiresAt = payload.lease_expires_at ?? new Date(at + 30_000).toISOString();
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

  #startExecution(payload, envelope) {
    const execution = this.#executionForWrite(envelope);
    if (execution.state !== 'CREATED') throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `cannot start Execution from ${execution.state}`);
    const bot = this.getBot(execution.owner_ref);
    if (bot) {
      this.#assertMissionOpen(bot.mission_id);
      this.assertBotDeadline(bot.bot_id);
      if (bot.state !== 'PREPARING' || bot.execution_id !== execution.execution_id || bot.core_id !== execution.core_id) {
        throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Activation requires the preparing Bot and its reserved Execution');
      }
    }
    const coreId = payload.core_id ?? null;
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
    const executionDeadline = payload.execution_deadline ?? bot?.hard_deadline ?? null;
    for (const [name, value] of [['handoff_deadline', handoffDeadline], ['execution_deadline', executionDeadline]]) {
      if (value !== null && (typeof value !== 'string' || Number.isNaN(Date.parse(value)))) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `${name} must be an ISO timestamp`);
    }
    if (bot && (Date.parse(executionDeadline) <= Date.now() || Date.parse(executionDeadline) > Date.parse(bot.hard_deadline))) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Execution activation deadline exceeds the remaining Bot budget');
    }
    this.db.prepare('UPDATE executions SET state = ?, core_id = COALESCE(?, core_id), started_at = ?, handoff_deadline = ?, execution_deadline = ?, handoff_reminder_sent_at = NULL, terminal_reason = NULL, state_version = state_version + 1, updated_at = ? WHERE execution_id = ?')
      .run('RUNNING', coreId, startedAt, handoffDeadline, executionDeadline, updatedAt, execution.execution_id);
    this.db.prepare("UPDATE bots SET state = 'ACTIVE', state_version = state_version + 1, updated_at = ? WHERE execution_id = ? AND state = 'PREPARING'")
      .run(updatedAt, execution.execution_id);
    return { execution: this.getExecution(execution.execution_id) };
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
    const input = payload.workspace_input ?? execution.workspace_input;
    if (payload.workspace_input) {
      if (execution.workspace_input && stableStringify(execution.workspace_input) !== stableStringify(input)) {
        throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Initial public Workspace input is immutable');
      }
      if (!execution.workspace_input && execution.state !== 'CREATED') throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Initial Workspace input must be recorded before activation');
      for (const field of ['workspace_id', 'mission_id', 'revision', 'git_commit', 'content_hash']) requireString(input[field], `workspace_input.${field}`);
      if (input.mission_id !== this.#taskMissionId(execution.task_id)) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Workspace input belongs to another Mission');
    }
    const fixedHash = !execution.workspace_input && Array.isArray(input?.material_inputs)
      ? fixedExecutionInputHash(this.getTask(execution.task_id), input) : execution.input_snapshot_hash;
    const updatedAt = now();
    this.db.prepare('UPDATE executions SET workspace_ref = ?, workspace_revision = ?, workspace_content_hash = ?, workspace_input_json = ?, input_snapshot_hash = ?, state_version = state_version + 1, updated_at = ? WHERE execution_id = ?')
      .run(payload.workspace_ref, payload.workspace_revision, payload.workspace_content_hash, json(input), fixedHash, updatedAt, execution.execution_id);
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

  #refreshTaskState(taskId, { updatedAt = now(), cancelIfIdle = false } = {}) {
    const task = this.getTask(taskId);
    if (!task || TERMINAL_TASK_STATES.includes(task.state)) return task;
    const active = this.db.prepare("SELECT state FROM executions WHERE task_id = ? AND state IN ('CREATED', 'RUNNING', 'CLOSING')").all(taskId);
    const nextState = active.length === 0 ? (cancelIfIdle ? taskCancellationState(task) : 'OPEN') :
      (active.some((execution) => ['RUNNING', 'CLOSING'].includes(execution.state)) ? 'RUNNING' : 'OPEN');
    if (task.state === nextState) return task;
    this.db.prepare('UPDATE tasks SET state = ?, state_version = state_version + 1, block_reason = NULL, eligible_at = CASE WHEN ? = \'OPEN\' THEN COALESCE(eligible_at, ?) ELSE NULL END, cancelled_at = CASE WHEN ? = \'CANCELED\' THEN ? ELSE cancelled_at END, updated_at = ? WHERE task_id = ?')
      .run(nextState, nextState, updatedAt, nextState, nextState === 'CANCELED' ? updatedAt : null, updatedAt, taskId);
    return this.getTask(taskId);
  }

  #latestExecution(taskId, activeOnly = false) {
    const activeClause = activeOnly ? "AND state IN ('CREATED', 'RUNNING', 'CLOSING')" : '';
    return rowToExecution(this.db.prepare(`SELECT * FROM executions WHERE task_id = ? ${activeClause} ORDER BY attempt_no DESC, created_at DESC LIMIT 1`).get(taskId));
  }

  #assertWorkspaceDelivery(contract) {
    const check = contract?.check;
    const identityFields = ['checker_ref', 'checker_version', 'environment_ref'];
    if (!contract || typeof contract !== 'object' || Array.isArray(contract) ||
        Object.keys(contract).some(key => !['paths', 'require_main', 'check'].includes(key)) ||
        !Array.isArray(contract.paths) || contract.paths.length < 1 || contract.paths.length > 20 ||
        new Set(contract.paths).size !== contract.paths.length ||
        contract.paths.some(path => typeof path !== 'string' || path.length > 1024 ||
          path.includes('\\') || path.includes('\0') || path.split('/').some(part => ['', '.', '..'].includes(part))) ||
        (contract.require_main !== undefined && typeof contract.require_main !== 'boolean') ||
        (check !== undefined && (!check || typeof check !== 'object' || Array.isArray(check) ||
          Object.keys(check).length !== identityFields.length ||
          identityFields.some(field => typeof check[field] !== 'string' || !check[field] || check[field].length > 256))) ||
        (check && !contract.require_main && contract.paths.length !== 1)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_TASK_CONTRACT, 'Invalid explicit Workspace delivery contract');
    }
  }

  #validateWorkspaceDelivery(task, execution, payload, checkResultId) {
    const delivery = task.completion_contract.workspace_delivery;
    if (!delivery) return null;
    this.#assertWorkspaceDelivery(delivery);
    const revision = payload.workspace_revision;
    if (typeof revision !== 'string' || !/^\d+\.\d+$/.test(revision)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Task done requires a fixed Workspace revision');
    }
    const workspaceId = execution.workspace_input?.workspace_id;
    if (!workspaceId || !this.workspaceDeliveryReader) {
      throw new SwarmEnvError(ERROR_CODES.SERVICE_NOT_READY, 'Trusted Workspace delivery evidence is unavailable');
    }
    const metadata = this.workspaceDeliveryReader({ missionId: task.mission_id, workspaceId, revision });
    const source = metadata?.source;
    if (!source || source.mission_id !== task.mission_id || source.task_id !== task.task_id ||
        source.execution_id !== execution.execution_id || source.bot_id !== execution.owner_ref ||
        source.fencing_version !== execution.fencing_version || metadata.conflicts?.length ||
        (delivery.require_main === true && source.operation !== 'merge') ||
        delivery.paths.some(path => !Object.hasOwn(metadata.files, path))) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Workspace revision does not satisfy the declared delivery');
    }
    const files = delivery.paths.map(path => ({ path, ...metadata.files[path] }));
    let check = null;
    const matches = identity => Object.entries(delivery.check).every(([key, value]) => identity?.[key] === value);
    if (delivery.check && delivery.require_main) {
      const proof = metadata.check;
      if (proof?.check_mode === 'lean-module' || proof?.scope === 'module' || proof?.verdict !== 'PASS' || proof.checked_tree !== metadata.git_tree || !matches(proof.checker) ||
          proof.policy?.task?.spec_version !== task.spec_version) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Declared final-tree delivery check did not pass');
      }
      if (proof.check_mode === 'lean-project') {
        const checkedPaths = new Set(Array.isArray(proof.checked_paths) ? proof.checked_paths : []);
        if (delivery.paths.some(path => !checkedPaths.has(path))) {
          throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Final-tree project check did not cover all declared Workspace delivery files');
        }
      }
      check = { ...delivery.check, check_result_id: proof.check_result_id, checked_tree: proof.checked_tree };
    } else if (delivery.check) {
      const result = checkResultId ? this.getCheckResult(checkResultId) : null;
      const input = result?.evidence?.workspace_input;
      const file = files[0];
      if (input?.check_mode === 'lean-module' || result?.evidence?.build_scope === 'module' ||
          result?.verdict !== 'PASS' || !['RECEIVED', 'APPLIED'].includes(result.status) || result.execution_id !== execution.execution_id ||
          result.target_task_id !== task.task_id || result.target_spec_version !== task.spec_version ||
          !matches(result) || input?.workspace_id !== workspaceId || input.revision !== revision ||
          input.path !== file.path || input.content_hash !== file.content_hash ||
          input.git_commit !== metadata.git_commit || input.git_tree !== metadata.git_tree) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Declared Workspace file check did not pass for this delivery');
      }
      check = { ...delivery.check, check_result_id: checkResultId, checked_tree: input.git_tree };
    }
    return { workspace_id: workspaceId, revision, git_commit: metadata.git_commit, git_tree: metadata.git_tree,
      files, merged_to_main: source.operation === 'merge', check };
  }

  #completion(task, execution, appliedCheckResultId = null) {
    const contract = task.completion_contract;
    const missing = [];
    if (contract.required_materials) {
      if (!this.contextService) missing.push('required_materials');
      else for (const requirement of contract.required_materials) {
        const normalizedRequirement = requirement ?? {};
        const consumptionAction = normalizedRequirement.action;
        const links = this.#taskMaterialLinks(task.task_id);
        const candidates = normalizedRequirement.role
          ? links.filter(link => link.role === normalizedRequirement.role).map(link => link.material).filter(Boolean)
          : [...links.map(link => link.material).filter(Boolean), ...this.contextService.readMaterials({ producer_task_id: task.task_id })];
        const materials = [...new Map(candidates.map(material => [material.material_id, material])).values()]
          .filter(material => !normalizedRequirement.cross_task || material.producer_task_id !== task.task_id);
        let count = materials.length;
        if (normalizedRequirement.requires_consumption) {
          const consumptionRows = typeof this.contextService.listMaterialConsumptions === 'function'
            ? this.contextService.listMaterialConsumptions({ reader_task: task.task_id, action: consumptionAction })
            : [];
          const consumedIds = new Set(consumptionRows.map((row) => row.material_id));
          count = materials.filter((material) => {
            const consumedMaterialIds = material.provenance?.used_materials?.map(item => item.material_id);
            if (Array.isArray(consumedMaterialIds) && consumedMaterialIds.length > 0) {
              return consumedMaterialIds.every((materialId) => consumedIds.has(materialId));
            }
            return consumedIds.has(material.material_id);
          }).length;
        }
        if (count < (normalizedRequirement.min_count ?? 1)) {
          const suffix = normalizedRequirement.requires_consumption ? `:${consumptionAction}` : '';
          missing.push(`materials${suffix}${normalizedRequirement.role ? `:${normalizedRequirement.role}` : ''}`);
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
        .map(row => this.#scopedMaterialLink(row, task.mission_id)).filter(Boolean);
      for (const requirement of requirements) {
        const targetTaskId = typeof requirement === 'string' ? requirement : requirement?.receiving_task_id ?? requirement?.task_id ?? null;
        const matches = responseLinks.filter((link) => !targetTaskId || link.receiving_task_id === targetTaskId);
        if (matches.length < (typeof requirement === 'object' ? requirement.min_count ?? 1 : 1)) {
          missing.push(`response${targetTaskId ? `:${targetTaskId}` : ''}`);
        }
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
      assertServiceCommitSettled(this.db);
      const result = callback();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ERROR_CODES, SwarmEnvError } from '../errors.js';
import { storedCheckerProcessStatus, storedResultClass } from '../judge/check-result.js';
import { makeEnvelope, operationPayload, stableStringify, validateEnvelope } from '../protocol/envelope.js';
import { SCHEMA_SQL } from '../storage/schema.js';
import { ensureJudgeSchema } from '../storage/judge-schema.js';
import {
  TERMINAL_EXECUTION_STATES,
  TERMINAL_TASK_STATES,
  validateTaskProposal,
} from './task-types.js';

const EXECUTION_WRITE_OPERATIONS = new Set(['abort', 'expire_execution', 'fence_execution', 'heartbeat', 'recover_execution', 'request_rework', 'request_wait', 'resume_execution', 'save_checkpoint', 'save_workspace_revision', 'start_execution', 'stop_execution', 'submit_candidate', 'wake_execution']);
const CLAIM_OPERATION = 'claim';
const TASK_MUTATING_OPERATIONS = new Set([
  'accept_task', 'apply_check_result', 'create_branch_group', 'create_child_task',
  'add_required_subtask', 'propose_structure_change', 'create_rework_task',
  'propose_task', 'request_rework', 'submit_candidate',
]);
const TASK_READ_OPERATIONS = new Set([
  'get_task', 'get_execution', 'get_task_structure', 'explain_task_readiness',
  'list_children', 'list_tasks', 'list_executions',
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

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `${field} is required`);
  }
  return value;
}

export class TaskService {
  constructor(database = ':memory:', { contextService = null, checkerHealthReader = null, logger = null } = {}) {
    this.db = database instanceof DatabaseSync ? database : new DatabaseSync(database);
    this.db.exec(SCHEMA_SQL);
    // Older MVP databases made execution_id unique in claim_keys. A waiting
    // Execution can now be claimed again by a later Agent, so idempotency is
    // keyed by claim request rather than by the reusable Execution identity.
    const claimIndexes = this.db.prepare("PRAGMA index_list('claim_keys')").all();
    const hasExecutionUnique = claimIndexes.some((index) => {
      if (index.unique !== 1) return false;
      const safeName = String(index.name).replaceAll('"', '""');
      return this.db.prepare(`PRAGMA index_info("${safeName}")`).all().some((column) => column.name === 'execution_id');
    });
    if (hasExecutionUnique) {
      this.db.exec(`
        CREATE TABLE claim_keys_migrated (
          request_key TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(task_id),
          fingerprint TEXT NOT NULL,
          execution_id TEXT NOT NULL REFERENCES executions(execution_id),
          created_at TEXT NOT NULL
        );
        INSERT INTO claim_keys_migrated SELECT request_key, task_id, fingerprint, execution_id, created_at FROM claim_keys;
        DROP TABLE claim_keys;
        ALTER TABLE claim_keys_migrated RENAME TO claim_keys;
      `);
    }
    const taskColumns = new Set(this.db.prepare('PRAGMA table_info(tasks)').all().map((column) => column.name));
    if (!taskColumns.has('priority')) this.db.exec("ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0 CHECK (priority >= 0)");
    if (!taskColumns.has('task_instructions')) {
      if (taskColumns.has('initial_prompt')) this.db.exec('ALTER TABLE tasks RENAME COLUMN initial_prompt TO task_instructions');
      else this.db.exec("ALTER TABLE tasks ADD COLUMN task_instructions TEXT NOT NULL DEFAULT ''");
    }
    if (!taskColumns.has('workspace_json')) this.db.exec("ALTER TABLE tasks ADD COLUMN workspace_json TEXT NOT NULL DEFAULT '{}'");
    const executionColumns = new Set(this.db.prepare('PRAGMA table_info(executions)').all().map((column) => column.name));
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
    this.db.exec('DROP INDEX IF EXISTS executions_one_active_per_task');
    ensureJudgeSchema(this.db);
    this.#backfillStructureRecords();
    this.contextService = contextService;
    this.checkerHealthReader = null;
    this.setCheckerHealthReader(checkerHealthReader);
    this.logger = logger;
  }

  close() {
    this.db.close();
  }

  setCheckerHealthReader(reader) {
    if (reader !== null && typeof reader !== 'function') throw new TypeError('checkerHealthReader must be a function or null');
    this.checkerHealthReader = reader;
    return this;
  }

  dispatch(operation, payload = {}, envelope) {
    this.logger?.append({ event: 'dispatch.start', service: 'task', operation, envelope });
    try {
      validateEnvelope(envelope, { executionWrite: EXECUTION_WRITE_OPERATIONS.has(operation) });
      let result;
      if (TASK_READ_OPERATIONS.has(operation)) {
        result = this.#read(operation, payload, envelope);
      } else {
        if (!TASK_MUTATING_OPERATIONS.has(operation) && !EXECUTION_WRITE_OPERATIONS.has(operation) && operation !== CLAIM_OPERATION) {
          throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unsupported Task Service operation: ${operation}`);
        }
        result = this.#transaction(() => {
          const fingerprint = operationPayload(operation, payload, envelope);
          const replay = this.#replay(envelope.operation_id, fingerprint);
          if (replay) return replay;
          const value = this.#mutate(operation, payload, envelope);
          this.#saveOperation(envelope.operation_id, operation, fingerprint, value);
          return value;
        });
      }
      this.logger?.append({ event: 'dispatch.complete', service: 'task', operation, ok: true, result });
      return result;
    } catch (error) {
      this.logger?.append({ event: 'dispatch.complete', service: 'task', operation, ok: false, error: { name: error.name, code: error.code, message: error.message } });
      throw error;
    }
  }

  proposeTask(input, envelope = makeEnvelope({ actorRef: input?.owner_ref ?? 'unknown' })) {
    return this.dispatch('propose_task', input, envelope);
  }

  createChildTask(input, envelope) {
    return this.dispatch('create_child_task', input, envelope);
  }

  createBranchGroup(input, envelope) {
    return this.dispatch('create_branch_group', input, envelope);
  }

  addRequiredSubtask(input, envelope) {
    return this.dispatch('add_required_subtask', input, envelope);
  }

  getTaskStructure(taskId, envelope = makeEnvelope({ actorRef: 'unknown', taskId })) {
    return this.dispatch('get_task_structure', { task_id: taskId }, envelope);
  }

  explainTaskReadiness(taskId, envelope = makeEnvelope({ actorRef: 'unknown', taskId })) {
    return this.dispatch('explain_task_readiness', { task_id: taskId }, envelope);
  }

  proposeStructureChange(input, envelope) {
    return this.dispatch('propose_structure_change', input, envelope);
  }

  createReworkTask(input, envelope) {
    return this.dispatch('create_rework_task', input, envelope);
  }

  getTask(taskId) {
    return rowToTask(this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId));
  }

  getExecution(executionId) {
    return rowToExecution(this.db.prepare('SELECT * FROM executions WHERE execution_id = ?').get(executionId));
  }

  getCheckResult(checkResultId) {
    return rowToCheckResult(this.db.prepare('SELECT * FROM check_results WHERE check_result_id = ?').get(checkResultId));
  }

  listChildren(parentTaskId) {
    return this.db.prepare('SELECT * FROM tasks WHERE parent_id = ? ORDER BY created_at, task_id').all(parentTaskId).map(rowToTask);
  }

  listTasks({ rootId = null, states = ['OPEN', 'RUNNING', 'WAITING'], taskType = null, limit = 10, availableOnly = true } = {}) {
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
    params.push(availableOnly ? 100 : limit);
    const tasks = this.db.prepare(`SELECT t.* FROM tasks t WHERE ${conditions.join(' AND ')}
      ORDER BY t.priority DESC, t.created_at ASC, t.task_id ASC LIMIT ?`).all(...params).map((row) => ({
      ...rowToTask(row),
      latest_execution: this.#latestExecution(row.task_id),
    }));
    if (!availableOnly) return tasks;
    const nowMs = Date.now();
    return tasks.filter((task) => {
      if (this.#dependencyBlockers(task.task_id).length > 0) return false;
      const executions = this.listExecutions(task.task_id, { includeTerminal: false });
      const active = executions.filter((execution) => ['CREATED', 'RUNNING'].includes(execution.state));
      if (active.length >= task.parallel_quota && !this.#expiredReworkCanBeClaimed(task, active, nowMs)) return false;
      const waiting = executions.filter((execution) => execution.state === 'WAITING');
      if (waiting.length === 0) return true;
      const resumableWaiting = waiting.some((execution) => this.#isWaitingResumable(execution, nowMs));
      return resumableWaiting || active.length + waiting.length < task.parallel_quota;
    }).slice(0, limit);
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

  #read(operation, payload, envelope) {
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
    if (operation === 'list_executions') {
      return this.listExecutions(payload.task_id ?? envelope.task_id, { includeTerminal: payload.include_terminal ?? true });
    }
    if (operation === 'get_task_structure') return this.#taskStructure(requireString(payload.task_id ?? envelope.task_id, 'task_id'));
    if (operation === 'explain_task_readiness') return this.#readinessExplanation(requireString(payload.task_id ?? envelope.task_id, 'task_id'));
    const parentTaskId = payload.parent_task_id ?? envelope.task_id;
    return this.listChildren(requireString(parentTaskId, 'parent_task_id'));
  }

  #mutate(operation, payload, envelope) {
    switch (operation) {
      case 'propose_task': return this.#proposeTask(payload, envelope);
      case 'create_child_task': return this.#createChildTask(payload, envelope);
      case 'create_branch_group': return this.#createBranchGroup(payload, envelope);
      case 'add_required_subtask': return this.#addRequiredSubtask(payload, envelope);
      case 'propose_structure_change': return this.#proposeStructureChange(payload, envelope);
      case 'create_rework_task': return this.#createReworkTask(payload, envelope);
      case 'claim': return this.#claim(payload, envelope);
      case 'heartbeat': return this.#heartbeat(payload, envelope);
      case 'start_execution': return this.#startExecution(payload, envelope);
      case 'resume_execution': return this.#resumeExecution(payload, envelope);
      case 'request_wait': return this.#requestWait(payload, envelope);
      case 'save_workspace_revision': return this.#saveWorkspaceRevision(payload, envelope);
      case 'save_checkpoint': return this.#saveCheckpoint(payload, envelope);
      case 'stop_execution': return this.#stopExecution(payload, envelope);
      case 'expire_execution': return this.#expireExecution(payload, envelope);
      case 'fence_execution': return this.#fenceExecution(payload, envelope);
      case 'recover_execution': return this.#recoverExecution(payload, envelope);
      case 'abort': return this.#stopExecution({ ...payload, terminal_state: 'CANCELLED' }, envelope);
      case 'accept_task': return this.#acceptTask(payload, envelope);
      case 'apply_check_result': return this.#applyCheckResult(payload, envelope);
      case 'request_rework': return this.#requestRework(payload, envelope);
      case 'submit_candidate': return this.#submitCandidate(payload, envelope);
      case 'wake_execution': return this.#wakeExecution(payload, envelope);
      default: throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unsupported Task Service operation: ${operation}`);
    }
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

  #recordCreationProvenance({ taskId, creatorTaskId = null, creatorExecutionId = null, creatorActorRef, creationKind, priorTaskId = null, sourceMaterialRefs = [], feedback = null, workspaceLineage = null, createdAt = now() }) {
    this.db.prepare(`INSERT INTO task_creation_provenance
      (task_id, creator_task_id, creator_execution_id, creator_actor_ref, creation_kind, prior_task_id, source_material_refs_json, feedback_json, workspace_lineage_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(task_id) DO NOTHING`)
      .run(taskId, creatorTaskId, creatorExecutionId, requireString(creatorActorRef, 'creator_actor_ref'), creationKind,
        priorTaskId, json(sourceMaterialRefs), feedback === null ? null : json(feedback), workspaceLineage === null ? null : json(workspaceLineage), createdAt);
  }

  #structureVersion(taskId) {
    this.#ensureStructureVersion(taskId);
    return this.db.prepare('SELECT structural_version FROM task_structure_versions WHERE task_id = ?').get(taskId).structural_version;
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
    if (envelope.execution_id) this.#executionForWrite(envelope);
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

  #assertChildLimits(parentTaskId, additionalChildren = 1) {
    const parent = this.#taskRow(parentTaskId);
    const childCount = this.db.prepare('SELECT COUNT(*) AS count FROM tasks WHERE parent_id = ?').get(parentTaskId).count;
    if (childCount + additionalChildren > parent.max_children) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'parent max_children exceeded');
    }
    const depth = this.db.prepare(`SELECT COUNT(*) AS count FROM tasks WHERE task_id = ? OR task_id IN (
      WITH RECURSIVE ancestors(task_id, parent_id) AS (
        SELECT task_id, parent_id FROM tasks WHERE task_id = ?
        UNION ALL SELECT t.task_id, t.parent_id FROM tasks t JOIN ancestors a ON t.task_id = a.parent_id
      ) SELECT task_id FROM ancestors
    )`).get(parentTaskId, parentTaskId).count - 1;
    if (depth + 1 > parent.max_depth) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'maximum task depth exceeded');
    }
    return parent;
  }

  #taskRow(taskId) {
    const row = this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
    if (!row) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown Task: ${taskId}`);
    return rowToTask(row);
  }

  #taskReadiness(taskId) {
    const task = this.#taskRow(taskId);
    if (TERMINAL_TASK_STATES.includes(task.state)) return { status: task.state, blockers: [] };
    const blockers = this.#dependencyBlockers(taskId);
    if (blockers.length > 0 || task.state === 'BLOCKED') {
      return { status: 'BLOCKED', blockers: blockers.length > 0 ? blockers : [{ reason: task.block_reason ?? 'task_blocked' }] };
    }
    const executions = this.listExecutions(taskId, { includeTerminal: false });
    if (executions.some((execution) => execution.state === 'RUNNING')) return { status: 'RUNNING', blockers: [] };
    const waiting = executions.filter((execution) => execution.state === 'WAITING');
    if (waiting.length > 0 && !waiting.some((execution) => this.#isWaitingResumable(execution))) return { status: 'WAITING', blockers: [] };
    return { status: 'READY', blockers: [] };
  }

  #insertRelatedTask({ input, taskId = randomUUID(), rootId, parentId = null, envelope, creationKind, priorTaskId = null, sourceMaterialRefs = [], feedback = null, workspaceLineage = null, createdAt = now() }) {
    const normalized = validateTaskProposal(input, { parentId });
    const spec = {
      task_id: taskId, root_id: rootId, parent_id: parentId, task_type: normalized.task_type,
      task_type_version: normalized.task_type_version, goal: normalized.goal, expected_output: normalized.expected_output,
      priority: normalized.priority, task_instructions: normalized.task_instructions, workspace: normalized.workspace,
      acceptance_conditions: normalized.acceptance_conditions, input_material_refs: normalized.input_material_refs,
      completion_contract: normalized.completion_contract, owner_ref: normalized.owner_ref, parallel_quota: normalized.parallel_quota,
      max_depth: normalized.max_depth, max_children: normalized.max_children, max_attempts: normalized.max_attempts,
      retry_policy: normalized.retry_policy, root_deadline: normalized.root_deadline,
    };
    this.db.prepare(`INSERT INTO tasks (
      task_id, root_id, parent_id, owner_ref, task_type, task_type_version, goal, expected_output, priority, task_instructions, workspace_json,
      acceptance_conditions_json, input_material_refs_json, spec_version, spec_hash, completion_contract_json, parallel_quota,
      state_version, state, block_reason, max_depth, max_children, max_attempts, retry_policy_json, root_deadline, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(taskId, rootId, parentId, normalized.owner_ref, normalized.task_type, normalized.task_type_version, normalized.goal,
        normalized.expected_output, normalized.priority, normalized.task_instructions, json(normalized.workspace), json(normalized.acceptance_conditions),
        json(normalized.input_material_refs), 1, hash(spec), json(normalized.completion_contract), normalized.parallel_quota, 0, 'OPEN', null,
        normalized.max_depth, normalized.max_children, normalized.max_attempts, json(normalized.retry_policy), normalized.root_deadline,
        envelope.actor_ref, createdAt, createdAt);
    this.#ensureStructureVersion(taskId, createdAt);
    this.#recordCreationProvenance({ taskId, creatorTaskId: envelope.task_id ?? null, creatorExecutionId: envelope.execution_id ?? null,
      creatorActorRef: envelope.actor_ref, creationKind, priorTaskId, sourceMaterialRefs, feedback, workspaceLineage, createdAt });
    return this.getTask(taskId);
  }

  #proposeTask(payload, envelope) {
    if (envelope.task_id !== null || envelope.execution_id !== null) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'root proposal cannot target an existing task or execution');
    }
    const ownerRef = payload.owner_ref ?? envelope.actor_ref;
    const input = validateTaskProposal({ ...payload, owner_ref: ownerRef }, { parentId: null });
    const taskId = payload.task_id ?? randomUUID();
    const createdAt = now();
    const spec = {
      task_id: taskId,
      root_id: taskId,
      parent_id: null,
      task_type: input.task_type,
      task_type_version: input.task_type_version,
      goal: input.goal,
      expected_output: input.expected_output,
      priority: input.priority,
      task_instructions: input.task_instructions,
      workspace: input.workspace,
      acceptance_conditions: input.acceptance_conditions,
      input_material_refs: input.input_material_refs,
      completion_contract: input.completion_contract,
      owner_ref: input.owner_ref,
      parallel_quota: input.parallel_quota,
      max_depth: input.max_depth,
      max_children: input.max_children,
      max_attempts: input.max_attempts,
      retry_policy: input.retry_policy,
      root_deadline: input.root_deadline,
    };
    this.db.prepare(`INSERT INTO tasks (
      task_id, root_id, parent_id, owner_ref, task_type, task_type_version, goal, expected_output, priority, task_instructions, workspace_json,
      acceptance_conditions_json, input_material_refs_json, spec_version, spec_hash,
      completion_contract_json, parallel_quota, state_version, state, block_reason,
      max_depth, max_children, max_attempts, retry_policy_json, root_deadline, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(taskId, taskId, null, input.owner_ref, input.task_type, input.task_type_version, input.goal, input.expected_output, input.priority,
        input.task_instructions, json(input.workspace), json(input.acceptance_conditions), json(input.input_material_refs), 1, hash(spec),
        json(input.completion_contract), input.parallel_quota, 0, 'OPEN', null, input.max_depth, input.max_children, input.max_attempts,
        json(input.retry_policy), input.root_deadline, envelope.actor_ref, createdAt, createdAt);
    this.#ensureStructureVersion(taskId, createdAt);
    this.#recordCreationProvenance({ taskId, creatorActorRef: envelope.actor_ref, creationKind: 'ROOT', createdAt });
    return { task: this.getTask(taskId) };
  }

  #createChildTask(payload, envelope) {
    const parentId = payload.parent_task_id ?? envelope.task_id;
    requireString(parentId, 'parent_task_id');
    if (envelope.task_id !== parentId) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'parent_task_id must match envelope task_id');
    const parent = this.getTask(parentId);
    if (!parent) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown parent task: ${parentId}`);
    const parentExecution = envelope.execution_id
      ? this.getExecution(envelope.execution_id)
      : this.db.prepare(`SELECT * FROM executions WHERE task_id = ? AND state IN ('CREATED', 'RUNNING', 'WAITING')`).get(parentId);
    if (!parentExecution || parentExecution.task_id !== parentId || !['CREATED', 'RUNNING', 'WAITING'].includes(parentExecution.state) || parentExecution.owner_ref !== envelope.actor_ref) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'only the parent task current execution owner may create a child');
    }
    const key = requireString(payload.child_creation_key ?? payload.request_key, 'child_creation_key');
    const fingerprint = operationPayload('create_child_task', payload, envelope);
    const existing = this.db.prepare('SELECT * FROM task_creation_keys WHERE request_key = ?').get(key);
    if (existing) {
      if (existing.parent_task_id !== parentId || existing.fingerprint !== fingerprint) {
        throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'child_creation_key was reused with another payload');
      }
      return { task: this.getTask(existing.task_id) };
    }
    if (envelope.spec_version !== parent.spec_version || envelope.state_version !== parent.state_version) {
      throw new SwarmEnvError(ERROR_CODES.STALE_VERSION, 'parent task version is stale', { expected_state_version: parent.state_version, expected_spec_version: parent.spec_version });
    }
    const childInput = validateTaskProposal({
      ...payload,
      owner_ref: payload.owner_ref ?? envelope.actor_ref,
      workspace: payload.workspace ?? parent.workspace,
    }, { parentId });
    const childCount = this.db.prepare('SELECT COUNT(*) AS count FROM tasks WHERE parent_id = ?').get(parentId).count;
    if (childCount >= parent.max_children) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'parent max_children exceeded');
    const depth = this.db.prepare(`SELECT COUNT(*) AS count FROM tasks WHERE task_id = ? OR task_id IN (
      WITH RECURSIVE ancestors(task_id, parent_id) AS (
        SELECT task_id, parent_id FROM tasks WHERE task_id = ?
        UNION ALL SELECT t.task_id, t.parent_id FROM tasks t JOIN ancestors a ON t.task_id = a.parent_id
      ) SELECT task_id FROM ancestors
    )`).get(parentId, parentId).count - 1;
    if (depth + 1 > parent.max_depth) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'maximum task depth exceeded');
    const taskId = payload.task_id ?? randomUUID();
    const createdAt = now();
    const spec = {
      task_id: taskId,
      root_id: parent.root_id,
      parent_id: parentId,
      task_type: childInput.task_type,
      task_type_version: childInput.task_type_version,
      goal: childInput.goal,
      expected_output: childInput.expected_output,
      priority: childInput.priority,
      task_instructions: childInput.task_instructions,
      workspace: childInput.workspace,
      acceptance_conditions: childInput.acceptance_conditions,
      input_material_refs: childInput.input_material_refs,
      completion_contract: childInput.completion_contract,
      owner_ref: childInput.owner_ref,
      parallel_quota: childInput.parallel_quota,
      max_depth: childInput.max_depth,
      max_children: childInput.max_children,
      max_attempts: childInput.max_attempts,
      retry_policy: childInput.retry_policy,
      root_deadline: childInput.root_deadline,
    };
    this.db.prepare(`INSERT INTO tasks (
      task_id, root_id, parent_id, owner_ref, task_type, task_type_version, goal, expected_output, priority, task_instructions, workspace_json,
      acceptance_conditions_json, input_material_refs_json, spec_version, spec_hash,
      completion_contract_json, parallel_quota, state_version, state, block_reason,
      max_depth, max_children, max_attempts, retry_policy_json, root_deadline, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(taskId, parent.root_id, parentId, childInput.owner_ref, childInput.task_type, childInput.task_type_version,
        childInput.goal, childInput.expected_output, childInput.priority, childInput.task_instructions, json(childInput.workspace), json(childInput.acceptance_conditions), json(childInput.input_material_refs),
        1, hash(spec), json(childInput.completion_contract), childInput.parallel_quota, 0, 'OPEN', null, childInput.max_depth, childInput.max_children,
        childInput.max_attempts, json(childInput.retry_policy), childInput.root_deadline, envelope.actor_ref, createdAt, createdAt);
    this.db.prepare('INSERT INTO task_creation_keys (request_key, parent_task_id, fingerprint, task_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(key, parentId, fingerprint, taskId, createdAt);
    this.#ensureStructureVersion(taskId, createdAt);
    this.#recordCreationProvenance({ taskId, creatorTaskId: parentId, creatorExecutionId: parentExecution.execution_id,
      creatorActorRef: envelope.actor_ref, creationKind: 'CHILD', createdAt });
    this.#bumpStructure(parentId, {
      eventType: 'child_task_created',
      payload: { child_task_id: taskId, relationship: 'PARENT' },
      envelope,
    });
    this.db.prepare('UPDATE tasks SET state_version = state_version + 1, updated_at = ? WHERE task_id = ?')
      .run(createdAt, parentId);
    return { task: this.getTask(taskId) };
  }

  #groupView(group) {
    const members = this.db.prepare(`SELECT m.*, t.root_id, t.parent_id, t.goal, t.state, t.state_version, t.spec_version,
      t.completion_contract_json, t.task_type, t.expected_output
      FROM task_structure_members m JOIN tasks t ON t.task_id = m.task_id
      WHERE m.group_id = ? AND m.retired_at IS NULL ORDER BY m.member_order, m.added_at, m.task_id`).all(group.group_id).map((row) => ({
      task_id: row.task_id,
      root_id: row.root_id,
      parent_id: row.parent_id,
      task_type: row.task_type,
      goal: row.goal,
      expected_output: row.expected_output,
      state: row.state,
      state_version: row.state_version,
      spec_version: row.spec_version,
      membership: { added_in_version: row.added_in_version, added_at: row.added_at },
      satisfied: row.state === 'SATISFIED',
      readiness: this.#taskReadiness(row.task_id),
    }));
    const satisfied = group.group_kind === 'BRANCH'
      ? members.some((member) => member.satisfied)
      : members.length > 0 && members.every((member) => member.satisfied);
    return { ...group, members, satisfaction: group.group_kind === 'BRANCH' ? 'ANY' : 'ALL', satisfied };
  }

  #taskDependencyRows(taskId) {
    return this.db.prepare(`SELECT * FROM task_structure_dependencies
      WHERE task_id = ? AND retired_at IS NULL ORDER BY created_at, dependency_id`).all(taskId);
  }

  #dependencySatisfied(dependency) {
    if (dependency.dependency_kind === 'TASK') return this.getTask(dependency.prerequisite_task_id)?.state === 'SATISFIED';
    if (dependency.dependency_kind === 'MATERIAL') return Boolean(this.contextService?.getMaterial(dependency.material_id));
    if (dependency.dependency_kind === 'CHECK_RESULT') {
      const result = this.getCheckResult(dependency.check_result_id);
      return Boolean(result && result.status === 'APPLIED' && result.verdict === 'PASS');
    }
    return false;
  }

  #dependencyBlockers(taskId) {
    return this.#taskDependencyRows(taskId).filter((dependency) => !this.#dependencySatisfied(dependency)).map((dependency) => ({
      dependency_id: dependency.dependency_id,
      dependency_kind: dependency.dependency_kind,
      prerequisite_task_id: dependency.prerequisite_task_id,
      material_id: dependency.material_id,
      check_result_id: dependency.check_result_id,
      requirement: parse(dependency.requirement_json) ?? {},
    }));
  }

  #taskStructure(taskId) {
    const task = this.#taskRow(taskId);
    const groups = this.db.prepare(`SELECT * FROM task_structure_groups
      WHERE owner_task_id = ? AND retired_at IS NULL ORDER BY created_at, group_id`).all(taskId).map((group) => this.#groupView(group));
    const memberOf = this.db.prepare(`SELECT g.* FROM task_structure_members m JOIN task_structure_groups g ON g.group_id = m.group_id
      WHERE m.task_id = ? AND m.retired_at IS NULL AND g.retired_at IS NULL ORDER BY g.created_at, g.group_id`).all(taskId).map((group) => this.#groupView(group));
    const provenanceRow = this.db.prepare('SELECT * FROM task_creation_provenance WHERE task_id = ?').get(taskId);
    const provenance = provenanceRow ? {
      task_id: provenanceRow.task_id,
      creator_task_id: provenanceRow.creator_task_id,
      creator_execution_id: provenanceRow.creator_execution_id,
      creator_actor_ref: provenanceRow.creator_actor_ref,
      creation_kind: provenanceRow.creation_kind,
      prior_task_id: provenanceRow.prior_task_id,
      source_material_refs: parse(provenanceRow.source_material_refs_json) ?? [],
      feedback: parse(provenanceRow.feedback_json),
      workspace_lineage: parse(provenanceRow.workspace_lineage_json),
      created_at: provenanceRow.created_at,
    } : null;
    const dependencies = this.#taskDependencyRows(taskId).map((dependency) => ({
      ...dependency,
      requirement: parse(dependency.requirement_json) ?? {},
      satisfied: this.#dependencySatisfied(dependency),
    }));
    const reworkLinks = this.db.prepare(`SELECT prior_task_id, rework_task_id, source_material_refs_json,
      workspace_lineage_json, created_by_actor_ref, created_by_execution_id, created_at
      FROM task_rework_links WHERE prior_task_id = ? OR rework_task_id = ? ORDER BY created_at, rework_task_id`).all(taskId, taskId).map((link) => ({
      ...link,
      source_material_refs: parse(link.source_material_refs_json) ?? [],
      workspace_lineage: parse(link.workspace_lineage_json),
    }));
    const events = this.db.prepare('SELECT * FROM task_structure_events WHERE task_id = ? ORDER BY structural_version, created_at, event_id').all(taskId).map((event) => ({
      ...event,
      payload: parse(event.payload_json),
    }));
    const status = this.#structureSatisfaction(taskId);
    const branchGroups = groups.filter((group) => group.group_kind === 'BRANCH');
    const requiredSubtaskGroups = groups.filter((group) => group.group_kind === 'REQUIRED_SUBTASK');
    return {
      task,
      structural_version: this.#structureVersion(taskId),
      provenance,
      branch_groups: branchGroups,
      alternatives: branchGroups,
      required_subtask_groups: requiredSubtaskGroups,
      required_subtasks: requiredSubtaskGroups.flatMap((group) => group.members),
      member_of: memberOf,
      dependencies,
      explicit_dependencies: dependencies,
      rework_links: reworkLinks,
      events,
      satisfaction: status,
    };
  }

  #structureSatisfaction(taskId) {
    const task = this.#taskRow(taskId);
    const groups = this.db.prepare("SELECT * FROM task_structure_groups WHERE owner_task_id = ? AND retired_at IS NULL").all(taskId).map((group) => this.#groupView(group));
    const byId = new Map(groups.map((group) => [group.group_id, group]));
    const contract = task.completion_contract ?? {};
    const branchGroupIds = Array.isArray(contract.required_branch_groups) ? contract.required_branch_groups : [];
    const requiredGroupIds = Array.isArray(contract.required_subtask_groups) ? contract.required_subtask_groups : [];
    const branchGroups = branchGroupIds.map((groupId) => ({
      group_id: groupId,
      satisfied: byId.get(groupId)?.group_kind === 'BRANCH' ? byId.get(groupId).satisfied : false,
      present: byId.get(groupId)?.group_kind === 'BRANCH',
    }));
    const requiredSubtaskGroups = requiredGroupIds.map((groupId) => ({
      group_id: groupId,
      satisfied: byId.get(groupId)?.group_kind === 'REQUIRED_SUBTASK' ? byId.get(groupId).satisfied : false,
      present: byId.get(groupId)?.group_kind === 'REQUIRED_SUBTASK',
    }));
    const dependencies = this.#taskDependencyRows(taskId).map((dependency) => ({
      dependency_id: dependency.dependency_id,
      dependency_kind: dependency.dependency_kind,
      prerequisite_task_id: dependency.prerequisite_task_id,
      material_id: dependency.material_id,
      check_result_id: dependency.check_result_id,
      satisfied: this.#dependencySatisfied(dependency),
    }));
    return {
      branch_groups: branchGroups,
      required_subtask_groups: requiredSubtaskGroups,
      dependencies,
      satisfied: [...branchGroups, ...requiredSubtaskGroups, ...dependencies].every((entry) => entry.satisfied),
    };
  }

  #readinessExplanation(taskId) {
    const task = this.#taskRow(taskId);
    const structure = this.#taskStructure(taskId);
    const missing = [];
    const blockers = structure.satisfaction.dependencies.filter((dependency) => !dependency.satisfied);
    const active = this.listExecutions(taskId, { includeTerminal: false });
    const activeCount = active.filter((execution) => ['CREATED', 'RUNNING'].includes(execution.state)).length;
    if (task.state === 'SATISFIED') return { task_id: taskId, readiness: 'SATISFIED', reasons: ['task_contract_satisfied'], missing: [], structure };
    if (task.state === 'BLOCKED') missing.push(task.block_reason ?? 'task_blocked');
    if (blockers.length > 0) missing.push(...blockers.map((dependency) => `dependency:${dependency.dependency_id}`));
    const executionQuotaBlocked = activeCount >= task.parallel_quota && !this.#expiredReworkCanBeClaimed(task, active, Date.now());
    if (executionQuotaBlocked) missing.push('execution_quota');
    const waiting = active.filter((execution) => execution.state === 'WAITING');
    if (task.state === 'WAITING' && waiting.length > 0 && !waiting.some((execution) => this.#isWaitingResumable(execution))) {
      return { task_id: taskId, readiness: 'WAITING', reasons: ['execution_waiting'], missing: [...new Set(missing)], structure };
    }
    const latest = this.#latestExecution(taskId, true);
    const completion = this.#completion(task, latest);
    if (completion.missing.length > 0) missing.push(...completion.missing);
    const blocked = task.state === 'BLOCKED' || blockers.length > 0 || (executionQuotaBlocked && active.every((execution) => execution.state !== 'WAITING'));
    return {
      task_id: taskId,
      readiness: blocked ? 'BLOCKED' : 'READY',
      reasons: blocked ? missing : ['no_explicit_dependency_blocker'],
      missing: [...new Set(missing)],
      structure,
    };
  }

  #createGroup({ ownerTaskId, groupKind, envelope, groupId = randomUUID(), structuralVersion }) {
    if (this.db.prepare('SELECT 1 FROM task_structure_groups WHERE group_id = ?').get(groupId)) {
      throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'structure group already exists', { group_id: groupId });
    }
    this.db.prepare(`INSERT INTO task_structure_groups
      (group_id, owner_task_id, group_kind, structural_version, created_by_task_id, created_by_execution_id, created_by_actor_ref, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(groupId, ownerTaskId, groupKind, structuralVersion, envelope.task_id, envelope.execution_id, envelope.actor_ref, now());
    return this.db.prepare('SELECT * FROM task_structure_groups WHERE group_id = ?').get(groupId);
  }

  #addGroupMember(groupId, taskId, structuralVersion, memberOrder = 0) {
    const existing = this.db.prepare('SELECT * FROM task_structure_members WHERE group_id = ? AND task_id = ?').get(groupId, taskId);
    if (existing?.retired_at === null) return;
    this.db.prepare(`INSERT INTO task_structure_members (group_id, task_id, member_order, added_in_version, added_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(group_id, task_id) DO UPDATE SET retired_at = NULL, added_in_version = excluded.added_in_version, added_at = excluded.added_at`)
      .run(groupId, taskId, memberOrder, structuralVersion, now());
  }

  #createBranchGroup(payload, envelope, { authority = null, currentVersion = null, sourceMaterialRefs = [] } = {}) {
    const ownerTaskId = payload.parent_task_id ?? envelope.task_id;
    if (envelope.task_id !== ownerTaskId) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'parent_task_id must match envelope task_id');
    this.#assertCanCreateBranch(ownerTaskId);
    const { task: owner, execution } = authority ?? this.#assertStructureAuthority(ownerTaskId, envelope);
    if (!Array.isArray(payload.branch_tasks) || payload.branch_tasks.length === 0) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'branch_tasks must contain at least one Task proposal');
    this.#assertChildLimits(ownerTaskId, payload.branch_tasks.length);
    const current = currentVersion ?? this.#assertExpectedStructureVersion(ownerTaskId, payload.expected_structural_version);
    const next = current + 1;
    const groupId = payload.group_id ?? payload.group_key ?? randomUUID();
    const group = this.#createGroup({ ownerTaskId, groupKind: 'BRANCH', envelope, groupId, structuralVersion: next });
    const tasks = [];
    try {
      for (const [index, proposal] of payload.branch_tasks.entries()) {
        if (!proposal || typeof proposal !== 'object') throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `branch_tasks[${index}] must be an object`);
        const task = this.#insertRelatedTask({
          input: { ...proposal, owner_ref: proposal.owner_ref ?? envelope.actor_ref, workspace: proposal.workspace ?? owner.workspace },
          taskId: proposal.task_id ?? randomUUID(), rootId: owner.root_id, parentId: ownerTaskId, envelope,
          creationKind: 'BRANCH', createdAt: now(),
        });
        this.#addGroupMember(groupId, task.task_id, next, index);
        tasks.push(task);
      }
    } catch (error) {
      this.db.prepare('DELETE FROM task_structure_members WHERE group_id = ?').run(groupId);
      this.db.prepare('DELETE FROM task_structure_groups WHERE group_id = ?').run(groupId);
      throw error;
    }
    this.#bumpStructure(ownerTaskId, { eventType: 'branch_group_created', payload: { group_id: groupId, task_ids: tasks.map((task) => task.task_id) }, envelope, version: next, sourceMaterialRefs });
    return { group: this.#groupView(this.db.prepare('SELECT * FROM task_structure_groups WHERE group_id = ?').get(groupId)), tasks, parent: this.getTask(ownerTaskId), execution };
  }

  #addRequiredSubtask(payload, envelope, { authority = null, currentVersion = null, sourceMaterialRefs = [] } = {}) {
    const ownerTaskId = payload.owner_task_id ?? payload.task_id ?? envelope.task_id;
    const { task: owner, execution } = authority ?? this.#assertStructureAuthority(ownerTaskId, envelope);
    const current = currentVersion ?? this.#assertExpectedStructureVersion(ownerTaskId, payload.expected_structural_version);
    const next = current + 1;
    let group = null;
    if (payload.group_id) {
      group = this.db.prepare('SELECT * FROM task_structure_groups WHERE group_id = ?').get(payload.group_id);
      if (group && (group.owner_task_id !== ownerTaskId || group.group_kind !== 'REQUIRED_SUBTASK' || group.retired_at !== null)) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'group_id must identify an active REQUIRED_SUBTASK group owned by the Task');
      }
      if (!group) group = this.#createGroup({ ownerTaskId, groupKind: 'REQUIRED_SUBTASK', envelope, groupId: payload.group_id, structuralVersion: next });
    } else {
      group = this.db.prepare("SELECT * FROM task_structure_groups WHERE owner_task_id = ? AND group_kind = 'REQUIRED_SUBTASK' AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1").get(ownerTaskId);
      if (!group) group = this.#createGroup({ ownerTaskId, groupKind: 'REQUIRED_SUBTASK', envelope, structuralVersion: next });
    }
    let task;
    if (payload.subtask_task_id) {
      task = this.#taskRow(payload.subtask_task_id);
      if (task.root_id !== owner.root_id || task.task_id === ownerTaskId) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'subtask must belong to the same root and differ from its owner');
    } else {
      if (!payload.subtask || typeof payload.subtask !== 'object') throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'subtask_task_id or subtask proposal is required');
      this.#assertChildLimits(ownerTaskId);
      task = this.#insertRelatedTask({ input: { ...payload.subtask, owner_ref: payload.subtask.owner_ref ?? envelope.actor_ref, workspace: payload.subtask.workspace ?? owner.workspace }, rootId: owner.root_id, parentId: ownerTaskId, envelope, creationKind: 'REQUIRED_SUBTASK', createdAt: now() });
    }
    this.#addGroupMember(group.group_id, task.task_id, next, payload.member_order ?? 0);
    this.db.prepare('UPDATE task_structure_groups SET structural_version = ? WHERE group_id = ?').run(next, group.group_id);
    this.#bumpStructure(ownerTaskId, { eventType: 'required_subtask_added', payload: { group_id: group.group_id, task_id: task.task_id }, envelope, version: next, sourceMaterialRefs });
    return { group: this.#groupView(this.db.prepare('SELECT * FROM task_structure_groups WHERE group_id = ?').get(group.group_id)), task, owner: this.getTask(ownerTaskId), execution };
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
      if (!this.contextService) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Context Service is required to validate a Material dependency');
      if (!this.contextService.getMaterial(materialId)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown dependency Material: ${materialId}`);
    }
    if (dependencyKind === 'CHECK_RESULT') {
      requireString(checkResultId, 'dependency.check_result_id');
      if (!this.getCheckResult(checkResultId)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown dependency CheckResult: ${checkResultId}`);
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

  #proposeStructureChange(payload, envelope) {
    const taskId = requireString(payload.task_id ?? envelope.task_id, 'task_id');
    const { task, execution } = this.#assertStructureAuthority(taskId, envelope);
    const current = this.#assertExpectedStructureVersion(taskId, payload.expected_structural_version);
    const change = payload.change;
    if (!change || typeof change !== 'object' || Array.isArray(change)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'change is required');
    const kind = change.kind ?? change.change_kind;
    const sourceMaterialRefs = this.#sourceMaterialRefs(change.source_material_refs ?? payload.source_material_refs);
    if (['create_branch_group', 'add_branch_group', 'branch_group'].includes(kind)) {
      const result = this.#createBranchGroup({
        ...change,
        parent_task_id: taskId,
        expected_structural_version: current,
      }, envelope, { authority: { task, execution }, currentVersion: current, sourceMaterialRefs });
      return { ...result, structure: this.#taskStructure(taskId), change: { kind: 'create_branch_group', group_id: result.group.group_id, task_ids: result.tasks.map((candidate) => candidate.task_id), structural_version: current + 1, source_material_refs: sourceMaterialRefs } };
    }
    if (['add_required_subtask', 'required_subtask'].includes(kind)) {
      const result = this.#addRequiredSubtask({
        ...change,
        owner_task_id: taskId,
        expected_structural_version: current,
      }, envelope, { authority: { task, execution }, currentVersion: current, sourceMaterialRefs });
      return { ...result, structure: this.#taskStructure(taskId), change: { kind: 'add_required_subtask', group_id: result.group.group_id, task_id: result.task.task_id, structural_version: current + 1, source_material_refs: sourceMaterialRefs } };
    }
    if (['add_dependency', 'dependency', 'add_execution_dependency'].includes(kind)) {
      const dependency = this.#insertDependency(taskId, change.dependency ?? change, envelope);
      const version = this.#bumpStructure(taskId, { eventType: 'dependency_added', payload: { dependency_id: dependency.dependency_id, dependency }, envelope, version: current + 1, sourceMaterialRefs });
      return { structure: this.#taskStructure(taskId), change: { kind: 'add_dependency', dependency_id: dependency.dependency_id, structural_version: version, source_material_refs: sourceMaterialRefs }, task, execution };
    }
    if (['retire_dependency', 'remove_dependency'].includes(kind)) {
      const dependencyId = requireString(change.dependency_id, 'change.dependency_id');
      const dependency = this.db.prepare('SELECT * FROM task_structure_dependencies WHERE dependency_id = ? AND task_id = ? AND retired_at IS NULL').get(dependencyId, taskId);
      if (!dependency) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'active dependency was not found');
      const retiredAt = now();
      this.db.prepare('UPDATE task_structure_dependencies SET retired_at = ? WHERE dependency_id = ?').run(retiredAt, dependencyId);
      const version = this.#bumpStructure(taskId, { eventType: 'dependency_retired', payload: { dependency_id: dependencyId }, envelope, version: current + 1, sourceMaterialRefs });
      return { structure: this.#taskStructure(taskId), change: { kind: 'retire_dependency', dependency_id: dependencyId, structural_version: version, source_material_refs: sourceMaterialRefs }, task, execution };
    }
    throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unsupported structure change: ${kind ?? '<missing>'}`);
  }

  #assertReworkAuthority(prior, envelope, payload = {}) {
    if (!envelope.execution_id) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'rework operation requires a bound Task Execution');
    const execution = this.getExecution(envelope.execution_id);
    const consumer = this.getTask(envelope.task_id);
    if (!execution || !consumer || execution.task_id !== consumer.task_id || execution.owner_ref !== envelope.actor_ref) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'rework operation requires the current consumer Task owner');
    }
    if (consumer.root_id !== prior.root_id) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'rework consumer must belong to the prior Task root');
    }
    const sourceExecutionId = payload.workspace_source_execution_id ?? payload.workspace_lineage?.source_execution_id;
    if (sourceExecutionId) {
      const sourceExecution = this.getExecution(sourceExecutionId);
      if (!sourceExecution || sourceExecution.task_id !== prior.task_id) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'workspace lineage must reference an Execution of the prior Task');
      }
    }
    return this.#executionForWrite(envelope);
  }

  #createReworkTask(payload, envelope) {
    const priorTaskId = requireString(payload.prior_task_id ?? payload.target_task_id, 'prior_task_id');
    const prior = this.#taskRow(priorTaskId);
    const authorityExecution = this.#assertReworkAuthority(prior, envelope, payload);
    const currentStructureVersion = this.#assertExpectedStructureVersion(priorTaskId, payload.expected_structural_version);
    const priorExecution = this.#latestExecution(priorTaskId);
    const instruction = payload.instruction ?? payload.feedback;
    if (instruction === undefined || instruction === null || instruction === '') throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'instruction or feedback is required');
    const sourceMaterialRefs = payload.input_material_refs ?? prior.input_material_refs ?? [];
    if (!Array.isArray(sourceMaterialRefs) || sourceMaterialRefs.some((ref) => typeof ref !== 'string' || !ref)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'input_material_refs must contain Material IDs');
    if (this.contextService) {
      for (const materialId of sourceMaterialRefs) {
        if (!this.contextService.getMaterial(materialId)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown rework Material: ${materialId}`);
      }
    }
    const workspaceLineage = payload.workspace_lineage ?? {
      source_execution_id: payload.workspace_source_execution_id ?? priorExecution?.execution_id ?? authorityExecution.execution_id,
      workspace_revision: payload.workspace_revision ?? priorExecution?.workspace_revision ?? null,
      workspace_ref: priorExecution?.workspace_ref ?? authorityExecution.workspace_ref ?? null,
    };
    const parentId = payload.parent_task_id ?? (prior.parent_id ?? prior.task_id);
    const parent = this.#taskRow(parentId);
    this.#assertChildLimits(parentId);
    const proposal = {
      ...prior,
      ...(payload.task ?? {}),
      task_type: payload.task?.task_type ?? prior.task_type,
      task_type_version: payload.task?.task_type_version ?? prior.task_type_version,
      goal: payload.task?.goal ?? `${prior.goal} (rework)`,
      expected_output: payload.task?.expected_output ?? prior.expected_output,
      acceptance_conditions: payload.task?.acceptance_conditions ?? prior.acceptance_conditions,
      completion_contract: payload.task?.completion_contract ?? prior.completion_contract,
      owner_ref: payload.owner_ref ?? envelope.actor_ref,
      workspace: payload.task?.workspace ?? prior.workspace,
      input_material_refs: sourceMaterialRefs,
    };
    delete proposal.task_id;
    delete proposal.root_id;
    delete proposal.parent_id;
    delete proposal.state;
    delete proposal.state_version;
    delete proposal.spec_version;
    delete proposal.spec_hash;
    delete proposal.created_by;
    delete proposal.created_at;
    delete proposal.updated_at;
    const task = this.#insertRelatedTask({ input: proposal, rootId: prior.root_id, parentId, envelope, creationKind: 'REWORK', priorTaskId, sourceMaterialRefs, feedback: instruction, workspaceLineage, createdAt: now() });
    const createdAt = now();
    this.db.prepare(`INSERT INTO task_rework_links
      (prior_task_id, rework_task_id, feedback_json, source_material_refs_json, workspace_lineage_json, created_by_actor_ref, created_by_execution_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(priorTaskId, task.task_id, json(instruction), json(sourceMaterialRefs), json(workspaceLineage), envelope.actor_ref, authorityExecution.execution_id, createdAt);
    this.#bumpStructure(priorTaskId, {
      eventType: 'rework_task_created',
      payload: { rework_task_id: task.task_id, source_material_count: sourceMaterialRefs.length },
      envelope,
      version: currentStructureVersion + 1,
    });
    if (parentId !== priorTaskId) {
      this.#bumpStructure(parentId, {
        eventType: 'rework_task_created',
        payload: { rework_task_id: task.task_id, prior_task_id: priorTaskId, relationship: 'PARENT' },
        envelope,
      });
    }
    return { task, prior_task: prior, provenance: this.#taskStructure(task.task_id).provenance, rework_link: { prior_task_id: priorTaskId, rework_task_id: task.task_id, feedback: instruction, source_material_refs: sourceMaterialRefs, workspace_lineage: workspaceLineage }, authority_execution: authorityExecution };
  }

  #claim(payload, envelope) {
    requireString(envelope.task_id, 'task_id');
    if (envelope.execution_id !== null) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'claim cannot target an execution');
    const task = this.getTask(envelope.task_id);
    if (!task) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown task: ${envelope.task_id}`);
    return this.#claimTask(task, payload, envelope);
  }

  #claimTask(task, payload, envelope) {
    if (TERMINAL_TASK_STATES.includes(task.state)) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'terminal Task cannot be claimed');
    const dependencyBlockers = this.#dependencyBlockers(task.task_id);
    if (dependencyBlockers.length > 0) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Task is blocked by an explicit execution dependency', { blockers: dependencyBlockers });
    }
    const claimKey = requireString(payload.claim_key ?? payload.request_key, 'claim_key');
    const keyFingerprint = operationPayload('claim', payload, envelope);
    const existingKey = this.db.prepare('SELECT * FROM claim_keys WHERE request_key = ?').get(claimKey);
    if (existingKey) {
      if (existingKey.task_id !== task.task_id || existingKey.fingerprint !== keyFingerprint) {
        throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'claim_key was reused with another payload');
      }
      return { task: this.getTask(task.task_id), execution: this.getExecution(existingKey.execution_id) };
    }
    if (envelope.spec_version !== task.spec_version || envelope.state_version !== task.state_version) {
      throw new SwarmEnvError(ERROR_CODES.STALE_VERSION, 'Task claim version is stale', { expected_state_version: task.state_version, expected_spec_version: task.spec_version });
    }
    const ownerRef = payload.owner_ref ?? envelope.actor_ref;
    const agentPrompt = payload.agent_prompt ?? payload.initial_prompt ?? task.task_instructions ?? '';
    if (typeof agentPrompt !== 'string') throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'agent_prompt must be a string');
    const inputMaterialRefs = payload.input_material_refs ?? task.input_material_refs;
    if (!Array.isArray(inputMaterialRefs)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'input_material_refs must be an array');
    const workspaceMode = payload.workspace_mode ?? 'resume';
    if (!['resume', 'clean'].includes(workspaceMode)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'workspace_mode must be resume or clean');
    }
    if (payload.workspace_revision !== undefined && (!Number.isInteger(payload.workspace_revision) || payload.workspace_revision < 1)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'workspace_revision must be a positive integer');
    }
    const sourceExecutionId = payload.workspace_source_execution_id ?? null;
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
    const inputSnapshotHash = payload.input_snapshot_hash ?? hash({
      task_id: task.task_id,
      spec_hash: task.spec_hash,
      workspace: task.workspace,
      input_material_refs: inputMaterialRefs,
    });
    const activeCount = this.db.prepare("SELECT COUNT(*) AS count FROM executions WHERE task_id = ? AND state IN ('CREATED', 'RUNNING')").get(task.task_id).count;
    // request_rework leaves the same Execution in CREATED so a later Worker
    // can resume its Workspace. Its incremented instruction version marks it
    // as queueable; an ordinary claim-created Execution remains protected by
    // the active quota until Runtime binds it.
    const createdRow = this.db.prepare("SELECT * FROM executions WHERE task_id = ? AND state = 'CREATED' ORDER BY updated_at DESC, execution_id DESC LIMIT 1").get(task.task_id);
    const reworkExecution = createdRow ? rowToExecution(createdRow) : null;
    const reworkLeaseExpired = reworkExecution && (!reworkExecution.lease_expires_at || Date.parse(reworkExecution.lease_expires_at) <= Date.now());
    const sameReworkWorkspace = reworkExecution && sourceExecutionId === reworkExecution.execution_id &&
      (payload.workspace_revision === undefined || payload.workspace_revision === reworkExecution.workspace_revision);
    if (reworkExecution && reworkExecution.instruction_version > 1 && reworkLeaseExpired && !waitingExecution && activeCount === 1 && task.parallel_quota === 1 &&
      workspaceMode === 'resume' && ((!sourceExecutionId && !sourceWorkspaceRef) || sameReworkWorkspace) &&
      (payload.workspace_revision === undefined || payload.workspace_revision === reworkExecution.workspace_revision)) {
      const updatedAt = now();
      const nextLease = payload.lease_expires_at ?? new Date(Date.now() + 30_000).toISOString();
      this.db.prepare(`UPDATE executions SET owner_ref = ?, lease_expires_at = ?, heartbeat_at = ?, agent_prompt = ?, state_version = state_version + 1, updated_at = ?
        WHERE execution_id = ?`).run(ownerRef, nextLease, updatedAt, agentPrompt, updatedAt, reworkExecution.execution_id);
      this.db.prepare('UPDATE tasks SET state = ?, state_version = state_version + 1, block_reason = NULL, updated_at = ? WHERE task_id = ?')
        .run('RUNNING', updatedAt, task.task_id);
      this.db.prepare('INSERT INTO claim_keys (request_key, task_id, fingerprint, execution_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(claimKey, task.task_id, keyFingerprint, reworkExecution.execution_id, updatedAt);
      return { task: this.getTask(task.task_id), execution: this.getExecution(reworkExecution.execution_id) };
    }
    const resumableWaiting = waitingExecution && this.#isWaitingResumable(rowToExecution(waitingExecution));
    const canContinueCurrentWaiting = Boolean(waitingExecution && activeCount === 0 && task.parallel_quota === 1 && resumableWaiting &&
      (payload.workspace_revision === undefined || payload.workspace_revision === waitingExecution.workspace_revision));
    if (workspaceMode === 'resume' && payload.workspace_revision !== undefined && !sourceWorkspaceRef && !canContinueCurrentWaiting) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'resume Workspace selection with a revision requires a source Workspace or the current waiting Workspace revision');
    }
    if (waitingExecution && activeCount === 0 && task.parallel_quota === 1 && resumableWaiting) {
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
      this.db.prepare(`UPDATE executions SET owner_ref = ?, state = 'CREATED', attempt_no = attempt_no + 1,
        lease_expires_at = ?, heartbeat_at = ?, agent_prompt = ?, wait_condition_json = NULL,
        wait_deadline = NULL, resume_token = NULL, state_version = state_version + 1, updated_at = ?
        WHERE execution_id = ?`).run(ownerRef, nextLease, updatedAt, agentPrompt, updatedAt, waitingExecution.execution_id);
      this.db.prepare('UPDATE tasks SET state = ?, state_version = state_version + 1, block_reason = NULL, updated_at = ? WHERE task_id = ?')
        .run('RUNNING', updatedAt, task.task_id);
      this.db.prepare('INSERT INTO claim_keys (request_key, task_id, fingerprint, execution_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(claimKey, task.task_id, keyFingerprint, waitingExecution.execution_id, updatedAt);
      return { task: this.getTask(task.task_id), execution: this.getExecution(waitingExecution.execution_id) };
      }
    }
    if (activeCount + (waitingExecution ? 1 : 0) >= task.parallel_quota) {
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
      instruction_version, steer_material_refs_json, wait_condition_json, wait_deadline, resume_token, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(execution.execution_id, execution.task_id, execution.owner_ref, execution.state, execution.state_version,
        execution.attempt_no, execution.fencing_version, execution.runtime_generation, execution.lease_expires_at,
        execution.heartbeat_at, execution.launch_token, execution.spec_version, execution.spec_hash, execution.agent_prompt,
        execution.workspace_manifest_ref, json(execution.input_material_refs), execution.input_snapshot_hash, json(execution.workspace_selection), execution.candidate_material_id, execution.workspace_ref,
        execution.workspace_revision, execution.workspace_content_hash, execution.checkpoint_ref, execution.checkpoint_hash, execution.instruction_version,
        json(execution.steer_material_refs), json(execution.wait_condition), execution.wait_deadline, execution.resume_token,
        execution.created_at, execution.updated_at);
    this.db.prepare('UPDATE tasks SET state = ?, state_version = state_version + 1, block_reason = NULL, updated_at = ? WHERE task_id = ?')
      .run('RUNNING', createdAt, task.task_id);
    this.db.prepare('INSERT INTO claim_keys (request_key, task_id, fingerprint, execution_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(claimKey, task.task_id, keyFingerprint, executionId, createdAt);
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

  #startExecution(payload, envelope) {
    const execution = this.#executionForWrite(envelope);
    if (execution.state !== 'CREATED') throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `cannot start Execution from ${execution.state}`);
    const updatedAt = now();
    this.db.prepare('UPDATE executions SET state = ?, state_version = state_version + 1, updated_at = ? WHERE execution_id = ?')
      .run('RUNNING', updatedAt, execution.execution_id);
    return { execution: this.getExecution(execution.execution_id) };
  }

  #resumeExecution(payload, envelope) {
    const execution = this.#executionForWrite(envelope);
    if (execution.state !== 'WAITING' && execution.state !== 'CREATED') throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `cannot resume Execution from ${execution.state}`);
    const updatedAt = now();
    this.db.prepare('UPDATE executions SET state = ?, wait_condition_json = NULL, wait_deadline = NULL, resume_token = NULL, state_version = state_version + 1, updated_at = ? WHERE execution_id = ?')
      .run('RUNNING', updatedAt, execution.execution_id);
    this.db.prepare('UPDATE tasks SET state = ?, state_version = state_version + 1, block_reason = NULL, updated_at = ? WHERE task_id = ?')
      .run('RUNNING', updatedAt, execution.task_id);
    return { execution: this.getExecution(execution.execution_id), task: this.getTask(execution.task_id) };
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
    if (!payload.wait_condition || typeof payload.wait_condition !== 'object') throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'wait_condition is required');
    const waitCondition = { ...payload.wait_condition };
    if (waitCondition.type === 'check_result_arrived' && waitCondition.candidate_material_id !== undefined) {
      requireString(waitCondition.candidate_material_id, 'wait_condition.candidate_material_id');
      if (waitCondition.candidate_material_id !== execution.candidate_material_id) {
        throw new SwarmEnvError(ERROR_CODES.FENCED, 'wait_condition candidate does not match the current Execution candidate');
      }
      if (!waitCondition.check_request_key && !waitCondition.request_key) {
        waitCondition.check_request_key = waitCondition.candidate_material_id;
      }
    }
    const allowed = new Set(['child_task_terminal', 'children_all_terminal', 'parent_review', 'check_result_arrived', 'checker_health', 'timer']);
    if (!allowed.has(waitCondition.type)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'unsupported wait_condition type');
    const task = this.getTask(execution.task_id);
    if (waitCondition.type === 'parent_review' && !task.parent_id) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'parent_review requires a child Task');
    }
    if (waitCondition.type === 'child_task_terminal') {
      const childTaskId = requireString(waitCondition.child_task_id ?? waitCondition.task_id, 'wait_condition.child_task_id');
      const child = this.getTask(childTaskId);
      if (!child || child.parent_id !== task.task_id) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'child_task_terminal must reference a direct child Task');
      if (TERMINAL_TASK_STATES.includes(child.state)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'child_task_terminal condition is already satisfied');
    }
    if (waitCondition.type === 'children_all_terminal') {
      if (!Array.isArray(waitCondition.child_task_ids) || waitCondition.child_task_ids.length === 0) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'children_all_terminal requires at least one child_task_id');
      }
      const childIds = [...new Set(waitCondition.child_task_ids.map((childTaskId) => requireString(childTaskId, 'wait_condition.child_task_ids')))];
      const children = childIds.map((childTaskId) => this.getTask(childTaskId));
      if (children.some((child) => !child || child.parent_id !== task.task_id)) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'children_all_terminal must reference direct child Tasks');
      }
      if (children.every((child) => TERMINAL_TASK_STATES.includes(child.state))) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'children_all_terminal condition is already satisfied');
      }
      waitCondition.child_task_ids = childIds;
    }
    if (waitCondition.type === 'check_result_arrived') {
      requireString(waitCondition.check_request_key ?? waitCondition.request_key, 'wait_condition.check_request_key');
    }
    if (waitCondition.type === 'checker_health') {
      requireString(waitCondition.preflight_key, 'wait_condition.preflight_key');
      requireString(waitCondition.health_fingerprint, 'wait_condition.health_fingerprint');
      if (waitCondition.retry_after !== undefined) requireString(waitCondition.retry_after, 'wait_condition.retry_after');
    }
    const waitDeadline = payload.wait_deadline ?? waitCondition.deadline ?? null;
    if (waitCondition.type === 'timer' && !waitDeadline) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'timer wait requires a deadline');
    }
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
    const updatedAt = now();
    this.db.prepare('UPDATE executions SET state = ?, state_version = state_version + 1, updated_at = ? WHERE execution_id = ?')
      .run(terminalState, updatedAt, execution.execution_id);
    const task = this.getTask(execution.task_id);
    if (!TERMINAL_TASK_STATES.includes(task.state)) this.#refreshTaskState(execution.task_id, { updatedAt, cancelIfIdle: terminalState === 'CANCELLED' });
    return { execution: this.getExecution(execution.execution_id), task: this.getTask(execution.task_id) };
  }

  #expireExecution(payload, envelope) {
    const execution = this.#executionForWrite(envelope);
    const updatedAt = now();
    this.db.prepare('UPDATE executions SET state = ?, fencing_version = fencing_version + 1, runtime_generation = COALESCE(?, runtime_generation), state_version = state_version + 1, updated_at = ? WHERE execution_id = ?')
      .run('EXPIRED', payload.runtime_generation ?? null, updatedAt, execution.execution_id);
    const task = this.getTask(execution.task_id);
    if (!TERMINAL_TASK_STATES.includes(task.state)) this.#refreshTaskState(execution.task_id, { updatedAt });
    return { execution: this.getExecution(execution.execution_id), task: this.getTask(execution.task_id) };
  }

  #fenceExecution(payload, envelope) {
    const execution = this.#executionForWrite(envelope);
    const updatedAt = now();
    this.db.prepare('UPDATE executions SET state = ?, fencing_version = fencing_version + 1, runtime_generation = COALESCE(?, runtime_generation), state_version = state_version + 1, updated_at = ? WHERE execution_id = ?')
      .run('FENCED', payload.runtime_generation ?? null, updatedAt, execution.execution_id);
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
      runtime_generation = COALESCE(?, runtime_generation), attempt_no = attempt_no + 1,
      lease_expires_at = ?, heartbeat_at = ?, agent_prompt = ?, state_version = state_version + 1, updated_at = ?
      WHERE execution_id = ?`)
      .run(payload.runtime_generation ?? null, nextLease, updatedAt, payload.agent_prompt ?? execution.agent_prompt, updatedAt, execution.execution_id);
    this.db.prepare("UPDATE tasks SET state = 'RUNNING', block_reason = NULL, state_version = state_version + 1, updated_at = ? WHERE task_id = ?")
      .run(updatedAt, execution.task_id);
    return { execution: this.getExecution(execution.execution_id), task: this.getTask(execution.task_id) };
  }

  #submitCandidate(payload, envelope) {
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

  #acceptTask(payload, envelope) {
    const targetTaskId = payload.target_task_id ?? payload.child_task_id ?? envelope.task_id;
    const target = this.getTask(requireString(targetTaskId, 'target_task_id'));
    if (!target) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown target Task: ${targetTaskId}`);
    const authorityExecution = this.#assertAcceptanceAuthority(target, envelope);
    const expectedStateVersion = payload.target_state_version ?? payload.task_state_version;
    if (expectedStateVersion !== undefined && expectedStateVersion !== target.state_version) {
      throw new SwarmEnvError(ERROR_CODES.STALE_VERSION, 'target Task state_version is stale', { expected_state_version: target.state_version });
    }
    if (TERMINAL_TASK_STATES.includes(target.state)) {
      if (target.state === 'SATISFIED') return { task: target, execution: this.#latestExecution(target.task_id), authority_execution: authorityExecution };
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'terminal Task cannot be accepted');
    }
    const execution = this.#latestExecution(target.task_id, true);
    if (!execution) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'accepted Task needs an active Execution');
    if (target.parent_id && target.completion_contract.parent_review === true && (execution.state !== 'WAITING' || execution.wait_condition?.type !== 'parent_review')) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'child Task is not waiting for parent review');
    }
    const completion = this.#completion(target, execution);
    if (!completion.satisfied) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'completion_contract is not satisfied', { missing: completion.missing });
    const updatedAt = now();
    this.db.prepare("UPDATE executions SET state = 'SUCCEEDED', wait_condition_json = NULL, wait_deadline = NULL, resume_token = NULL, state_version = state_version + 1, updated_at = ? WHERE execution_id = ?")
      .run(updatedAt, execution.execution_id);
    this.db.prepare("UPDATE tasks SET state = 'SATISFIED', state_version = state_version + 1, block_reason = NULL, updated_at = ? WHERE task_id = ?")
      .run(updatedAt, target.task_id);
    return { task: this.getTask(target.task_id), execution: this.getExecution(execution.execution_id), authority_execution: authorityExecution };
  }

  #requestRework(payload, envelope) {
    const targetTaskId = requireString(payload.target_task_id ?? payload.child_task_id, 'target_task_id');
    const target = this.getTask(targetTaskId);
    if (!target) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown target Task: ${targetTaskId}`);
    if (!target.parent_id) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'request_rework requires a child Task');
    const parentExecution = this.#assertAcceptanceAuthority(target, envelope);
    const instruction = requireString(payload.instruction ?? payload.feedback, 'instruction');
    if (!this.contextService) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Context Service is required for request_rework');
    const current = this.#latestExecution(target.task_id);
    if (!current) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'rework target has no Execution');
    if (TERMINAL_TASK_STATES.includes(target.state) && target.state !== 'OPEN') {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'terminal Task cannot be sent for rework');
    }
    if (['CREATED', 'RUNNING', 'WAITING'].includes(current.state) &&
      (current.state !== 'WAITING' || current.wait_condition?.type !== 'parent_review')) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'rework target is not waiting for parent review');
    }
    const steer = this.contextService.publishMaterialForTask({
      kind: 'steer',
      scope: payload.scope ?? 'strategy',
      evidence_state: 'observed',
      content: { instruction },
      provenance: { actor_ref: envelope.actor_ref, parent_task_id: target.parent_id, target_task_id: target.task_id },
    }, envelope).material;
    const steerRefs = [...(current.steer_material_refs ?? []), steer.material_id];
    const updatedAt = now();
    let execution;
    if (['CREATED', 'RUNNING', 'WAITING'].includes(current.state)) {
      this.db.prepare(`UPDATE executions SET state = 'CREATED', candidate_material_id = NULL, instruction_version = instruction_version + 1,
        steer_material_refs_json = ?, wait_condition_json = NULL, wait_deadline = NULL, resume_token = NULL,
        lease_expires_at = ?, state_version = state_version + 1, updated_at = ? WHERE execution_id = ?`)
        .run(json(steerRefs), updatedAt, updatedAt, current.execution_id);
      execution = this.getExecution(current.execution_id);
    } else if (['EXPIRED', 'FENCED'].includes(current.state)) {
      execution = this.#createRecoveryExecution(target, current, steerRefs, updatedAt);
    } else {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `cannot rework Execution in ${current.state}`);
    }
    this.db.prepare("UPDATE tasks SET state = 'RUNNING', block_reason = NULL, state_version = state_version + 1, updated_at = ? WHERE task_id = ?")
      .run(updatedAt, target.task_id);
    return { task: this.getTask(target.task_id), execution, steer_material: steer, parent_execution: parentExecution };
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
    const requiredCheck = task.completion_contract.required_check;
    if (!requiredCheck) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Task completion_contract does not require a CheckResult');
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
    if (result.target_spec_version !== task.spec_version || result.input_snapshot_hash !== execution.input_snapshot_hash ||
      result.checker_ref !== requiredCheck.checker_ref || result.checker_version !== requiredCheck.checker_version ||
      (requiredCheck.environment_ref && result.environment_ref !== requiredCheck.environment_ref) ||
      (requiredCheck.input_snapshot_hash && result.input_snapshot_hash !== requiredCheck.input_snapshot_hash)) {
      throw new SwarmEnvError(ERROR_CODES.STALE_VERSION, 'CheckResult binding does not match the current Task contract or Execution input');
    }
    if (execution.candidate_material_id !== result.candidate_material_id) {
      throw new SwarmEnvError(ERROR_CODES.STALE_VERSION, 'CheckResult candidate does not match the current Execution candidate');
    }
    const updatedAt = now();
    this.db.prepare("UPDATE check_results SET status = 'APPLIED', applied_task_state_version = ?, applied_at = ?, updated_at = ? WHERE check_result_id = ?")
      .run(task.state_version + 1, updatedAt, updatedAt, checkResultId);
    if (result.result_class === 'infrastructure_failure') {
      if (!result.retryable || result.evidence?.retry_exhausted) {
        const blockReason = `checker_unavailable:${result.diagnostic_code ?? 'unknown'}`;
        this.db.prepare("UPDATE executions SET state = 'FAILED', wait_condition_json = NULL, wait_deadline = NULL, resume_token = NULL, state_version = state_version + 1, updated_at = ? WHERE execution_id = ?")
          .run(updatedAt, execution.execution_id);
        this.db.prepare("UPDATE tasks SET state = 'BLOCKED', state_version = state_version + 1, block_reason = ?, updated_at = ? WHERE task_id = ?")
          .run(blockReason, updatedAt, task.task_id);
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
    } else if (result.verdict === 'PASS') {
      const completion = this.#completion(task, execution, checkResultId);
      if (completion.satisfied) {
        this.db.prepare("UPDATE executions SET state = 'SUCCEEDED', wait_condition_json = NULL, wait_deadline = NULL, resume_token = NULL, state_version = state_version + 1, updated_at = ? WHERE execution_id = ?")
          .run(updatedAt, execution.execution_id);
        this.db.prepare("UPDATE tasks SET state = 'SATISFIED', state_version = state_version + 1, block_reason = NULL, updated_at = ? WHERE task_id = ?")
          .run(updatedAt, task.task_id);
      }
    } else if (execution.state === 'WAITING') {
      // A failed check wakes the responsibility for another Agent. Keep the
      // durable Workspace and wait lineage visible as a resumable WAITING
      // Execution; the next explicit claim will hand it over and bind it.
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
    const updatedAt = now();
    this.db.prepare("UPDATE executions SET state = 'RUNNING', wait_condition_json = NULL, wait_deadline = NULL, resume_token = NULL, state_version = state_version + 1, updated_at = ? WHERE execution_id = ?")
      .run(updatedAt, execution.execution_id);
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
      ? (cancelIfIdle ? 'CANCELLED' : 'OPEN')
      : (active.some((execution) => execution.state === 'RUNNING')
        ? 'RUNNING'
        : (active.some((execution) => execution.state === 'WAITING') ? 'WAITING' : 'OPEN'));
    if (task.state === nextState) return task;
    this.db.prepare('UPDATE tasks SET state = ?, state_version = state_version + 1, block_reason = NULL, cancelled_at = CASE WHEN ? = \'CANCELLED\' THEN ? ELSE cancelled_at END, updated_at = ? WHERE task_id = ?')
      .run(nextState, nextState, nextState === 'CANCELLED' ? updatedAt : null, updatedAt, taskId);
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
      // make this responsibility claimable again.
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
    if (contract.required_children) {
      for (const childId of contract.required_children) {
        if (this.getTask(childId)?.state !== 'SATISFIED') missing.push(`child:${childId}`);
      }
    }
    if (contract.required_branch_groups) {
      for (const groupId of contract.required_branch_groups) {
        const group = this.db.prepare("SELECT * FROM task_structure_groups WHERE group_id = ? AND group_kind = 'BRANCH' AND retired_at IS NULL").get(groupId);
        if (!group || group.owner_task_id !== task.task_id || !this.#groupView(group).satisfied) missing.push(`branch_group:${groupId}`);
      }
    }
    if (contract.required_subtask_groups) {
      for (const groupId of contract.required_subtask_groups) {
        const group = this.db.prepare("SELECT * FROM task_structure_groups WHERE group_id = ? AND group_kind = 'REQUIRED_SUBTASK' AND retired_at IS NULL").get(groupId);
        if (!group || group.owner_task_id !== task.task_id || !this.#groupView(group).satisfied) missing.push(`subtask_group:${groupId}`);
      }
    }
    if (contract.required_materials) {
      if (!this.contextService) missing.push('required_materials');
      else for (const requirement of contract.required_materials) {
        const count = this.contextService.readMaterials({ source_task: task.task_id }).filter((material) =>
          requirement.kinds.includes(material.kind) && (!requirement.scope || requirement.scope === material.scope)).length;
        if (count < requirement.min_count) missing.push(`materials:${requirement.kinds.join('|')}`);
      }
    }
    if (contract.required_candidate) {
      const candidate = execution?.candidate_material_id && this.contextService?.getMaterial(execution.candidate_material_id);
      if (!candidate || candidate.kind !== contract.required_candidate.kind || (contract.required_candidate.scope && candidate.scope !== contract.required_candidate.scope)) {
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

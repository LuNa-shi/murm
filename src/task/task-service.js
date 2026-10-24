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

const EXECUTION_WRITE_OPERATIONS = new Set(['abort', 'expire_execution', 'fence_execution', 'handoff_execution', 'heartbeat', 'record_handoff_reminder', 'recover_execution', 'request_rework', 'request_wait', 'resume_execution', 'save_checkpoint', 'save_workspace_revision', 'start_execution', 'stop_execution', 'submit_candidate', 'wake_execution']);
const CLAIM_OPERATION = 'claim';
const STRUCTURE_MUTATING_OPERATIONS = new Set(['create_branch_group', 'add_required_subtask', 'propose_structure_change', 'create_rework_task']);
const TASK_MUTATING_OPERATIONS = new Set(['accept_task', 'apply_check_result', 'create_child_task', 'propose_task', 'request_rework', 'submit_candidate', ...STRUCTURE_MUTATING_OPERATIONS]);
const STRUCTURE_READ_OPERATIONS = new Set(['get_task_structure', 'explain_task_readiness']);

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
    handoff_metadata: parse(row.handoff_metadata_json),
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
    if (!executionColumns.has('started_at')) this.db.exec('ALTER TABLE executions ADD COLUMN started_at TEXT');
    if (!executionColumns.has('handoff_deadline')) this.db.exec('ALTER TABLE executions ADD COLUMN handoff_deadline TEXT');
    if (!executionColumns.has('execution_deadline')) this.db.exec('ALTER TABLE executions ADD COLUMN execution_deadline TEXT');
    if (!executionColumns.has('handoff_reminder_sent_at')) this.db.exec('ALTER TABLE executions ADD COLUMN handoff_reminder_sent_at TEXT');
    if (!executionColumns.has('handoff_metadata_json')) this.db.exec("ALTER TABLE executions ADD COLUMN handoff_metadata_json TEXT");
    if (!executionColumns.has('terminal_reason')) this.db.exec('ALTER TABLE executions ADD COLUMN terminal_reason TEXT');
    this.db.exec('DROP INDEX IF EXISTS executions_one_active_per_task');
    ensureJudgeSchema(this.db);
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
      if (['get_task', 'get_execution', 'list_children', 'list_tasks', 'list_executions', ...STRUCTURE_READ_OPERATIONS].includes(operation)) {
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

  recordHandoffReminder(payload, envelope) {
    return this.dispatch('record_handoff_reminder', payload, envelope);
  }

  handoffExecution(payload, envelope) {
    return this.dispatch('handoff_execution', payload, envelope);
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
      const executions = this.listExecutions(task.task_id, { includeTerminal: false });
      const active = executions.filter((execution) => ['CREATED', 'RUNNING'].includes(execution.state));
      if (active.length >= task.parallel_quota) {
        const reworkExecution = active.length === 1 && task.parallel_quota === 1 && active[0].state === 'CREATED'
          ? this.#latestExecution(task.task_id, true)
          : null;
        const reworkLeaseExpired = reworkExecution && (!reworkExecution.lease_expires_at || Date.parse(reworkExecution.lease_expires_at) <= nowMs);
        if (!reworkExecution || reworkExecution.state !== 'CREATED' || reworkExecution.instruction_version <= 1 || !reworkLeaseExpired) return false;
      }
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

  getTaskStructure(taskId) {
    return this.#getTaskStructure(requireString(taskId, 'task_id'));
  }

  explainTaskReadiness(taskId) {
    return this.#explainTaskReadiness(requireString(taskId, 'task_id'));
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

  /**
   * Validate a wait request without writing a checkpoint, changing ownership,
   * or changing the Task projection. Runtime uses this read seam before it
   * materializes a checkpoint so malformed waits are non-mutating.
   */
  validateWaitCondition(executionId, { waitCondition, waitDeadline = null } = {}) {
    const execution = this.getExecution(requireString(executionId, 'execution_id'));
    if (!execution) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown execution: ${executionId}`);
    const task = this.getTask(execution.task_id);
    const normalized = this.#validateWaitCondition(execution, task, waitCondition, waitDeadline);
    return { execution, task, wait_condition: normalized.waitCondition, wait_deadline: normalized.waitDeadline };
  }

  /** Return whether the persisted condition is already satisfied. */
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
    if (operation === 'get_task_structure') {
      const taskId = payload.task_id ?? envelope.task_id;
      return this.#getTaskStructure(requireString(taskId, 'task_id'));
    }
    if (operation === 'explain_task_readiness') {
      const taskId = payload.task_id ?? envelope.task_id;
      return this.#explainTaskReadiness(requireString(taskId, 'task_id'));
    }
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
      case 'record_handoff_reminder': return this.#recordHandoffReminder(payload, envelope);
      case 'handoff_execution': return this.#handoffExecution(payload, envelope);
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
    this.#recordTaskCreation({
      taskId,
      creatorTaskId: null,
      creatorExecutionId: null,
      actorRef: envelope.actor_ref,
      creationKind: 'ROOT',
      createdAt,
    });
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
    this.#recordTaskCreation({
      taskId,
      creatorTaskId: parentId,
      creatorExecutionId: parentExecution.execution_id,
      actorRef: envelope.actor_ref,
      creationKind: 'CHILD',
      createdAt,
    });
    this.db.prepare('UPDATE tasks SET state_version = state_version + 1, updated_at = ? WHERE task_id = ?')
      .run(createdAt, parentId);
    return { task: this.getTask(taskId) };
  }

  #recordTaskCreation({ taskId, creatorTaskId = null, creatorExecutionId = null, actorRef, creationKind, priorTaskId = null, sourceMaterialRefs = [], feedback = null, workspaceLineage = null, createdAt = now() }) {
    this.db.prepare(`INSERT OR IGNORE INTO task_structure_versions (task_id, structural_version, updated_at)
      VALUES (?, 1, ?)`)
      .run(taskId, createdAt);
    this.db.prepare(`INSERT OR IGNORE INTO task_creation_provenance (
      task_id, creator_task_id, creator_execution_id, creator_actor_ref, creation_kind, prior_task_id,
      source_material_refs_json, feedback_json, workspace_lineage_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(taskId, creatorTaskId, creatorExecutionId, requireString(actorRef, 'creator_actor_ref'), creationKind, priorTaskId,
        json(sourceMaterialRefs), feedback === null ? null : json(feedback), workspaceLineage === null ? null : json(workspaceLineage), createdAt);
  }

  #ensureTaskStructure(taskId) {
    const task = this.getTask(taskId);
    if (!task) return null;
    const createdAt = task.created_at ?? now();
    this.#recordTaskCreation({
      taskId,
      creatorTaskId: task.parent_id,
      creatorExecutionId: null,
      actorRef: task.created_by ?? task.owner_ref,
      creationKind: task.parent_id ? 'CHILD' : 'ROOT',
      createdAt,
    });
    return task;
  }

  #structureVersion(taskId) {
    this.#ensureTaskStructure(taskId);
    return this.db.prepare('SELECT * FROM task_structure_versions WHERE task_id = ?').get(taskId);
  }

  #assertStructureAuthority(taskId, envelope) {
    requireString(taskId, 'task_id');
    if (envelope.task_id !== taskId) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'structure operation task_id must match the bound Task');
    }
    if (typeof envelope.execution_id !== 'string' || envelope.execution_id.length === 0) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'structure mutation requires a bound Execution');
    }
    const execution = this.getExecution(envelope.execution_id);
    if (!execution || execution.task_id !== taskId) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'structure mutation Execution does not own the Task');
    }
    if (!['CREATED', 'RUNNING', 'WAITING'].includes(execution.state)) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'structure mutation requires an active Execution');
    }
    if (execution.owner_ref !== envelope.actor_ref) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'only the current Task Execution owner may change its structure');
    }
    if (envelope.spec_version === null || envelope.spec_version === undefined || envelope.spec_version !== execution.spec_version) {
      throw new SwarmEnvError(ERROR_CODES.STALE_VERSION, 'structure mutation spec_version is stale', { expected_spec_version: execution.spec_version });
    }
    if (!Number.isInteger(envelope.fencing_version) || envelope.fencing_version !== execution.fencing_version) {
      throw new SwarmEnvError(ERROR_CODES.FENCED, 'structure mutation fencing_version is stale', { expected: execution.fencing_version });
    }
    const task = this.getTask(taskId);
    if (!task) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown Task: ${taskId}`);
    if (envelope.state_version !== null && envelope.state_version !== undefined &&
      envelope.state_version !== task.state_version && envelope.state_version !== execution.state_version) {
      throw new SwarmEnvError(ERROR_CODES.STALE_VERSION, 'structure mutation state_version is stale', {
        expected_task_state_version: task.state_version,
        expected_execution_state_version: execution.state_version,
      });
    }
    this.#ensureTaskStructure(taskId);
    return { task, execution };
  }

  #assertStructureVersion(taskId, expectedVersion) {
    const current = this.#structureVersion(taskId)?.structural_version ?? 1;
    if (expectedVersion !== undefined && expectedVersion !== null) {
      if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'expected_structural_version must be a positive integer');
      }
      if (expectedVersion !== current) {
        throw new SwarmEnvError(ERROR_CODES.STALE_VERSION, 'Task structure version is stale', { expected_structural_version: current });
      }
    }
    return current;
  }

  #normalizeRelatedProposal(input, ownerTask, envelope, { prior = null } = {}) {
    const source = input?.task && typeof input.task === 'object' ? { ...input.task, ...input } : { ...(input ?? {}) };
    delete source.task;
    const goal = source.goal ?? source.instruction ?? prior?.goal;
    if (typeof goal !== 'string' || goal.length === 0) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'related Task goal is required');
    }
    return validateTaskProposal({
      ...source,
      task_type: source.task_type ?? prior?.task_type ?? 'default',
      expected_output: source.expected_output ?? prior?.expected_output ?? goal,
      acceptance_conditions: source.acceptance_conditions ?? prior?.acceptance_conditions ?? {},
      owner_ref: source.owner_ref ?? envelope.actor_ref,
      workspace: source.workspace ?? ownerTask.workspace,
      input_material_refs: source.input_material_refs ?? prior?.input_material_refs ?? [],
      completion_contract: source.completion_contract ?? prior?.completion_contract,
    }, { parentId: null });
  }

  #relatedTaskDepth(parentId) {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM tasks WHERE task_id = ? OR task_id IN (
      WITH RECURSIVE ancestors(task_id, parent_id) AS (
        SELECT task_id, parent_id FROM tasks WHERE task_id = ?
        UNION ALL SELECT t.task_id, t.parent_id FROM tasks t JOIN ancestors a ON t.task_id = a.parent_id
      ) SELECT task_id FROM ancestors
    )`).get(parentId, parentId);
    return row.count - 1;
  }

  #insertRelatedTask({ ownerTask, input, envelope, creationKind, parentId = ownerTask.task_id, priorTaskId = null, sourceMaterialRefs = [], feedback = null, workspaceLineage = null }) {
    if (parentId !== null) {
      const childCount = this.db.prepare('SELECT COUNT(*) AS count FROM tasks WHERE parent_id = ?').get(parentId).count;
      if (childCount >= ownerTask.max_children) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'parent max_children exceeded');
      if (this.#relatedTaskDepth(parentId) + 1 > ownerTask.max_depth) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'maximum task depth exceeded');
    }
    const taskId = input.task_id ?? randomUUID();
    if (this.getTask(taskId)) throw new SwarmEnvError(ERROR_CODES.CONFLICT, `Task already exists: ${taskId}`);
    const createdAt = now();
    const spec = {
      task_id: taskId,
      root_id: ownerTask.root_id,
      parent_id: parentId,
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
      .run(taskId, ownerTask.root_id, parentId, input.owner_ref, input.task_type, input.task_type_version,
        input.goal, input.expected_output, input.priority, input.task_instructions, json(input.workspace), json(input.acceptance_conditions), json(input.input_material_refs),
        1, hash(spec), json(input.completion_contract), input.parallel_quota, 0, 'OPEN', null, input.max_depth, input.max_children,
        input.max_attempts, json(input.retry_policy), input.root_deadline, envelope.actor_ref, createdAt, createdAt);
    this.#recordTaskCreation({ taskId, creatorTaskId: ownerTask.task_id, creatorExecutionId: envelope.execution_id, actorRef: envelope.actor_ref, creationKind, priorTaskId, sourceMaterialRefs, feedback, workspaceLineage, createdAt });
    return this.getTask(taskId);
  }

  #assertNoBranchCreation(taskId) {
    const row = this.db.prepare(`SELECT g.group_id FROM task_structure_groups g
      JOIN task_structure_members m ON m.group_id = g.group_id
      WHERE m.task_id = ? AND g.group_kind = 'BRANCH' AND m.retired_at IS NULL AND g.retired_at IS NULL LIMIT 1`).get(taskId);
    if (row) {
      throw new SwarmEnvError(ERROR_CODES.BRANCH_TASK_CANNOT_CREATE_BRANCH, 'a Branch Task cannot directly create another Branch group', { task_id: taskId, branch_group_id: row.group_id });
    }
  }

  #createBranchGroup(payload, envelope) {
    const ownerTaskId = payload.parent_task_id ?? payload.owner_task_id ?? envelope.task_id;
    requireString(ownerTaskId, 'parent_task_id');
    const authority = this.#assertStructureAuthority(ownerTaskId, envelope);
    this.#assertNoBranchCreation(ownerTaskId);
    return this.#createBranchGroupInternal(payload, envelope, authority);
  }

  #createBranchGroupInternal(payload, envelope, authority) {
    const ownerTask = authority.task;
    const expectedVersion = payload.expected_structural_version;
    const currentVersion = this.#assertStructureVersion(ownerTask.task_id, expectedVersion);
    const branchInputs = payload.branch_tasks ?? payload.branches ?? payload.tasks;
    if (!Array.isArray(branchInputs) || branchInputs.length === 0) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'branch_tasks must contain at least one Task proposal');
    }
    const groupId = payload.group_id ?? payload.branch_group_id ?? randomUUID();
    const existing = this.db.prepare('SELECT * FROM task_structure_groups WHERE group_id = ?').get(groupId);
    if (existing) {
      if (existing.owner_task_id !== ownerTask.task_id || existing.group_kind !== 'BRANCH') throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'group_id is already used by another structure group');
      return { group: this.#structureGroup(groupId), task: this.getTask(ownerTask.task_id), structural_version: this.#structureVersion(ownerTask.task_id).structural_version };
    }
    const createdAt = now();
    const nextVersion = currentVersion + 1;
    this.db.prepare(`INSERT INTO task_structure_groups (
      group_id, owner_task_id, group_kind, structural_version, created_by_task_id, created_by_execution_id, created_by_actor_ref, created_at
    ) VALUES (?, ?, 'BRANCH', ?, ?, ?, ?, ?)`)
      .run(groupId, ownerTask.task_id, nextVersion, ownerTask.task_id, authority.execution.execution_id, envelope.actor_ref, createdAt);
    const members = [];
    for (const [index, rawProposal] of branchInputs.entries()) {
      const proposal = typeof rawProposal === 'string' ? { task_id: rawProposal } : rawProposal;
      if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `branch_tasks[${index}] must be an object or Task ID`);
      const existingTaskId = proposal.task_id;
      const existingTask = existingTaskId ? this.getTask(existingTaskId) : null;
      const relatedInput = existingTask ? null : this.#normalizeRelatedProposal(proposal, ownerTask, envelope);
      if (existingTaskId && relatedInput) relatedInput.task_id = existingTaskId;
      const task = existingTask ?? this.#insertRelatedTask({ ownerTask, input: relatedInput, envelope, creationKind: 'BRANCH' });
      if (!task) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown branch Task: ${existingTaskId}`);
      if (task.task_id === ownerTask.task_id) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'a Task cannot be a member of its own Branch group');
      const activeMembership = this.db.prepare(`SELECT 1 FROM task_structure_members m JOIN task_structure_groups g ON g.group_id = m.group_id
        WHERE m.task_id = ? AND m.retired_at IS NULL AND g.retired_at IS NULL AND g.group_kind = 'BRANCH'`).get(task.task_id);
      if (activeMembership) throw new SwarmEnvError(ERROR_CODES.CONFLICT, `Task is already a member of an active Branch group: ${task.task_id}`);
      this.db.prepare(`INSERT INTO task_structure_members (group_id, task_id, member_order, added_in_version, added_at)
        VALUES (?, ?, ?, ?, ?)`).run(groupId, task.task_id, index, nextVersion, createdAt);
      members.push(task);
    }
    const structuralVersion = this.#finishStructureMutation(ownerTask.task_id, nextVersion, 'branch_group_created', {
      group_id: groupId,
      group_kind: 'BRANCH',
      member_task_ids: members.map((task) => task.task_id),
      group_key: payload.group_key ?? null,
    }, envelope, createdAt);
    return { group: this.#structureGroup(groupId), tasks: members, task: this.getTask(ownerTask.task_id), structural_version: structuralVersion };
  }

  #addRequiredSubtask(payload, envelope) {
    const ownerTaskId = payload.owner_task_id ?? payload.parent_task_id ?? envelope.task_id;
    requireString(ownerTaskId, 'owner_task_id');
    const authority = this.#assertStructureAuthority(ownerTaskId, envelope);
    return this.#addRequiredSubtaskInternal(payload, envelope, authority);
  }

  #addRequiredSubtaskInternal(payload, envelope, authority) {
    const ownerTask = authority.task;
    const currentVersion = this.#assertStructureVersion(ownerTask.task_id, payload.expected_structural_version);
    const groupId = payload.group_id ?? payload.required_subtask_group_id ?? null;
    let group = groupId ? this.db.prepare('SELECT * FROM task_structure_groups WHERE group_id = ?').get(groupId) : null;
    if (group && (group.owner_task_id !== ownerTask.task_id || group.group_kind !== 'REQUIRED_SUBTASK' || group.retired_at)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'group_id must identify an active required-subtask group owned by the Task');
    }
    const nextVersion = currentVersion + 1;
    const createdAt = now();
    if (!group) {
      group = { group_id: groupId ?? randomUUID(), owner_task_id: ownerTask.task_id, group_kind: 'REQUIRED_SUBTASK' };
      this.db.prepare(`INSERT INTO task_structure_groups (
        group_id, owner_task_id, group_kind, structural_version, created_by_task_id, created_by_execution_id, created_by_actor_ref, created_at
      ) VALUES (?, ?, 'REQUIRED_SUBTASK', ?, ?, ?, ?, ?)`)
        .run(group.group_id, ownerTask.task_id, nextVersion, ownerTask.task_id, authority.execution.execution_id, envelope.actor_ref, createdAt);
    }
    const proposal = payload.subtask ?? payload.task ?? null;
    const subtaskId = payload.subtask_task_id ?? payload.subtask_id ?? proposal?.task_id;
    const existingSubtask = subtaskId ? this.getTask(subtaskId) : null;
    const relatedInput = this.#normalizeRelatedProposal(proposal ?? payload, ownerTask, envelope);
    if (subtaskId) relatedInput.task_id = subtaskId;
    const task = existingSubtask ?? this.#insertRelatedTask({
      ownerTask,
      input: relatedInput,
      envelope,
      creationKind: 'REQUIRED_SUBTASK',
    });
    if (!task) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown subtask Task: ${subtaskId}`);
    if (task.task_id === ownerTask.task_id) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'a Task cannot be its own required subtask');
    const member = this.db.prepare('SELECT * FROM task_structure_members WHERE group_id = ? AND task_id = ?').get(group.group_id, task.task_id);
    if (member && !member.retired_at) {
      return { group: this.#structureGroup(group.group_id), task: this.getTask(ownerTask.task_id), subtask: task, structural_version: this.#structureVersion(ownerTask.task_id).structural_version };
    }
    this.db.prepare(`INSERT INTO task_structure_members (group_id, task_id, member_order, added_in_version, added_at)
      VALUES (?, ?, COALESCE((SELECT MAX(member_order) + 1 FROM task_structure_members WHERE group_id = ?), 0), ?, ?)`)
      .run(group.group_id, task.task_id, group.group_id, nextVersion, createdAt);
    const structuralVersion = this.#finishStructureMutation(ownerTask.task_id, nextVersion, 'required_subtask_added', {
      group_id: group.group_id,
      group_kind: 'REQUIRED_SUBTASK',
      member_task_id: task.task_id,
    }, envelope, createdAt);
    return { group: this.#structureGroup(group.group_id), task: this.getTask(ownerTask.task_id), subtask: task, structural_version: structuralVersion };
  }

  #finishStructureMutation(taskId, expectedNextVersion, eventType, payload, envelope, updatedAt = now()) {
    const current = this.#structureVersion(taskId)?.structural_version ?? 1;
    if (current + 1 !== expectedNextVersion) {
      throw new SwarmEnvError(ERROR_CODES.STALE_VERSION, 'Task structure changed during mutation', { expected_structural_version: current });
    }
    this.db.prepare('UPDATE task_structure_versions SET structural_version = ?, updated_at = ? WHERE task_id = ?')
      .run(expectedNextVersion, updatedAt, taskId);
    this.db.prepare(`INSERT INTO task_structure_events (
      event_id, task_id, structural_version, event_type, actor_ref, execution_id, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), taskId, expectedNextVersion, eventType, envelope.actor_ref, envelope.execution_id ?? null, json(payload), updatedAt);
    this.db.prepare('UPDATE tasks SET state_version = state_version + 1, updated_at = ? WHERE task_id = ?')
      .run(updatedAt, taskId);
    return expectedNextVersion;
  }

  #proposeStructureChange(payload, envelope) {
    const taskId = payload.task_id ?? envelope.task_id;
    requireString(taskId, 'task_id');
    const authority = this.#assertStructureAuthority(taskId, envelope);
    const change = payload.change;
    if (!change || typeof change !== 'object' || Array.isArray(change)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'change must be an object');
    }
    const currentVersion = this.#assertStructureVersion(taskId, payload.expected_structural_version);
    const kind = change.kind ?? change.operation;
    let result;
    if (['add_branch', 'create_branch_group', 'branch_group'].includes(kind)) {
      this.#assertNoBranchCreation(taskId);
      result = this.#createBranchGroupInternal({
        ...change,
        parent_task_id: taskId,
        expected_structural_version: currentVersion,
      }, envelope, authority);
    } else if (['add_required_subtask', 'required_subtask', 'add_subtask'].includes(kind)) {
      result = this.#addRequiredSubtaskInternal({
        ...change,
        owner_task_id: taskId,
        expected_structural_version: currentVersion,
      }, envelope, authority);
    } else if (['add_dependency', 'dependency', 'add_execution_dependency'].includes(kind)) {
      const dependencyTargetId = change.task_id ?? taskId;
      const dependencyTarget = this.getTask(dependencyTargetId);
      if (!dependencyTarget) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown dependency target Task: ${dependencyTargetId}`);
      const targetIsOwned = dependencyTarget.task_id === taskId || dependencyTarget.parent_id === taskId || dependencyTarget.root_id === authority.task.root_id;
      if (!targetIsOwned) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'dependency target is outside the bound Task structure');
      result = this.#addDependencyInternal({ ...change, task_id: dependencyTargetId }, envelope, authority,
        dependencyTargetId === taskId ? currentVersion : undefined);
    } else {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unsupported structure change kind: ${kind}`);
    }
    return { ...result, change: { ...change, kind }, proposed_by: envelope.actor_ref };
  }

  #addDependencyInternal(payload, envelope, authority, expectedVersion = undefined) {
    const taskId = payload.task_id ?? authority.task.task_id;
    const targetTask = this.getTask(taskId);
    if (!targetTask || (taskId !== authority.task.task_id && targetTask.root_id !== authority.task.root_id)) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'dependency target is outside the bound Task structure');
    }
    const currentVersion = this.#assertStructureVersion(taskId, expectedVersion);
    const dependencyKind = String(payload.dependency_kind ?? (payload.kind === 'task' ? 'TASK' : (payload.kind ?? ''))).toUpperCase();
    const prerequisiteTaskId = payload.prerequisite_task_id ?? payload.depends_on_task_id ?? payload.dependency_task_id ?? payload.prerequisite?.task_id ?? null;
    const materialId = payload.material_id ?? payload.prerequisite_material_id ?? payload.prerequisite?.material_id ?? null;
    const checkResultId = payload.check_result_id ?? payload.prerequisite_check_result_id ?? payload.prerequisite?.check_result_id ?? null;
    const selected = [prerequisiteTaskId, materialId, checkResultId].filter((value) => value !== null && value !== undefined);
    if (!['TASK', 'MATERIAL', 'CHECK_RESULT'].includes(dependencyKind) || selected.length !== 1) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'dependency requires exactly one TASK, MATERIAL, or CHECK_RESULT prerequisite');
    }
    if (dependencyKind === 'TASK') {
      const prerequisite = this.getTask(prerequisiteTaskId);
      if (!prerequisite) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown prerequisite Task: ${prerequisiteTaskId}`);
      if (prerequisiteTaskId === taskId || this.#dependencyReaches(prerequisiteTaskId, taskId)) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Task dependency would create a cycle');
      }
    }
    const existing = this.db.prepare(`SELECT * FROM task_structure_dependencies WHERE task_id = ? AND dependency_kind = ?
      AND COALESCE(prerequisite_task_id, material_id, check_result_id) = ? AND retired_at IS NULL`).get(taskId, dependencyKind, selected[0]);
    if (existing) {
      return { dependency: this.#dependencyRecord(existing), task: this.getTask(taskId), structural_version: currentVersion };
    }
    const createdAt = now();
    const dependencyId = payload.dependency_id ?? randomUUID();
    this.db.prepare(`INSERT INTO task_structure_dependencies (
      dependency_id, task_id, dependency_kind, prerequisite_task_id, material_id, check_result_id, requirement_json,
      created_by_task_id, created_by_execution_id, created_by_actor_ref, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(dependencyId, taskId, dependencyKind, dependencyKind === 'TASK' ? prerequisiteTaskId : null,
        dependencyKind === 'MATERIAL' ? materialId : null, dependencyKind === 'CHECK_RESULT' ? checkResultId : null,
        json(payload.requirement ?? payload.requirement_json ?? {}), authority.task.task_id, envelope.execution_id, envelope.actor_ref, createdAt);
    const structuralVersion = this.#finishStructureMutation(taskId, currentVersion + 1, 'dependency_added', {
      dependency_id: dependencyId,
      dependency_kind: dependencyKind,
      prerequisite_task_id: prerequisiteTaskId,
      material_id: materialId,
      check_result_id: checkResultId,
    }, envelope, createdAt);
    this.#refreshTaskDependencyState(taskId, { updatedAt: createdAt });
    return { dependency: this.#dependencyRecord(this.db.prepare('SELECT * FROM task_structure_dependencies WHERE dependency_id = ?').get(dependencyId)), task: this.getTask(taskId), structural_version: structuralVersion };
  }

  #dependencyReaches(startTaskId, targetTaskId, seen = new Set()) {
    if (startTaskId === targetTaskId) return true;
    if (seen.has(startTaskId)) return false;
    seen.add(startTaskId);
    const prerequisites = this.db.prepare("SELECT prerequisite_task_id FROM task_structure_dependencies WHERE task_id = ? AND dependency_kind = 'TASK' AND retired_at IS NULL").all(startTaskId);
    return prerequisites.some(({ prerequisite_task_id: prerequisite }) => this.#dependencyReaches(prerequisite, targetTaskId, seen));
  }

  #createReworkTask(payload, envelope) {
    const priorTaskId = requireString(payload.prior_task_id ?? payload.task_id, 'prior_task_id');
    const priorTask = this.getTask(priorTaskId);
    if (!priorTask) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown prior Task: ${priorTaskId}`);
    const authorityTaskId = envelope.task_id === priorTaskId ? priorTaskId : (priorTask.parent_id === envelope.task_id ? envelope.task_id : null);
    if (!authorityTaskId) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'rework creator must own the prior Task or its parent Task');
    const authority = this.#assertStructureAuthority(authorityTaskId, envelope);
    const sourceMaterialRefs = payload.input_material_refs ?? payload.source_material_refs ?? [];
    if (!Array.isArray(sourceMaterialRefs) || sourceMaterialRefs.some((ref) => typeof ref !== 'string' || ref.length === 0)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'input_material_refs must be an array of Material IDs');
    }
    const instruction = payload.instruction ?? payload.feedback ?? payload.goal;
    requireString(instruction, 'instruction');
    const workspaceSourceExecutionId = payload.workspace_source_execution_id ?? null;
    let workspaceLineage = payload.workspace_lineage ?? null;
    if (workspaceSourceExecutionId) {
      const sourceExecution = this.getExecution(workspaceSourceExecutionId);
      if (!sourceExecution || sourceExecution.task_id !== priorTaskId) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'workspace_source_execution_id must belong to the prior Task');
      workspaceLineage = { source_execution_id: workspaceSourceExecutionId, workspace_ref: sourceExecution.workspace_ref, workspace_revision: payload.workspace_revision ?? sourceExecution.workspace_revision };
    }
    const input = this.#normalizeRelatedProposal({
      ...payload,
      ...(payload.task && typeof payload.task === 'object' ? payload.task : {}),
      goal: payload.goal ?? instruction,
      expected_output: payload.expected_output ?? priorTask.expected_output,
      acceptance_conditions: payload.acceptance_conditions ?? priorTask.acceptance_conditions,
      completion_contract: payload.completion_contract ?? priorTask.completion_contract,
      workspace: payload.workspace ?? priorTask.workspace,
      input_material_refs: sourceMaterialRefs.length > 0 ? sourceMaterialRefs : priorTask.input_material_refs,
      task_type: payload.task_type ?? priorTask.task_type,
    }, authority.task, envelope, { prior: priorTask });
    if (payload.rework_task_id ?? payload.new_task_id ?? payload.task?.task_id) {
      input.task_id = payload.rework_task_id ?? payload.new_task_id ?? payload.task.task_id;
    }
    const reworkTask = this.#insertRelatedTask({
      ownerTask: authority.task,
      input,
      envelope,
      creationKind: 'REWORK',
      parentId: priorTask.parent_id ?? null,
      priorTaskId,
      sourceMaterialRefs,
      feedback: { instruction, ...(payload.feedback && typeof payload.feedback === 'object' ? payload.feedback : {}) },
      workspaceLineage,
    });
    const createdAt = now();
    this.db.prepare(`INSERT INTO task_rework_links (
      prior_task_id, rework_task_id, feedback_json, source_material_refs_json, workspace_lineage_json,
      created_by_actor_ref, created_by_execution_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(priorTaskId, reworkTask.task_id, json({ instruction, feedback: payload.feedback ?? null }), json(sourceMaterialRefs), workspaceLineage === null ? null : json(workspaceLineage), envelope.actor_ref, envelope.execution_id, createdAt);
    const structuralVersion = this.#finishStructureMutation(authorityTaskId, this.#structureVersion(authorityTaskId).structural_version + 1, 'rework_task_created', {
      prior_task_id: priorTaskId,
      rework_task_id: reworkTask.task_id,
      source_material_refs: sourceMaterialRefs,
    }, envelope, createdAt);
    return { task: this.getTask(authorityTaskId), rework_task: this.getTask(reworkTask.task_id), prior_task: priorTask, structural_version: structuralVersion };
  }

  #structureGroup(groupId) {
    const group = this.db.prepare('SELECT * FROM task_structure_groups WHERE group_id = ?').get(groupId);
    if (!group) return null;
    const members = this.db.prepare(`SELECT m.*, t.* FROM task_structure_members m
      JOIN tasks t ON t.task_id = m.task_id
      WHERE m.group_id = ? AND m.retired_at IS NULL ORDER BY m.member_order, m.added_at, m.task_id`).all(groupId)
      .map((row) => {
        const task = rowToTask(row);
        return {
          task,
          task_id: task.task_id,
          member_order: row.member_order,
          added_in_version: row.added_in_version,
          readiness: this.#taskReadiness(task),
        };
      });
    const satisfied = group.group_kind === 'BRANCH'
      ? members.some((member) => member.task.state === 'SATISFIED')
      : members.length > 0 && members.every((member) => member.task.state === 'SATISFIED');
    return {
      ...group,
      members,
      member_task_ids: members.map((member) => member.task_id),
      satisfied,
      unresolved_task_ids: members.filter((member) => member.task.state !== 'SATISFIED').map((member) => member.task_id),
      ready_task_ids: members.filter((member) => member.readiness.ready).map((member) => member.task_id),
    };
  }

  #dependencyRecord(row) {
    if (!row) return null;
    const record = {
      ...row,
      requirement: parse(row.requirement_json) ?? {},
    };
    const status = this.#dependencyStatus(record);
    return { ...record, ...status };
  }

  #dependencyStatus(dependency) {
    if (dependency.dependency_kind === 'TASK') {
      const prerequisite = this.getTask(dependency.prerequisite_task_id);
      if (!prerequisite) return { status: 'MISSING', satisfied: false, prerequisite: null };
      if (prerequisite.state === 'SATISFIED') return { status: 'SATISFIED', satisfied: true, prerequisite };
      if (TERMINAL_TASK_STATES.includes(prerequisite.state)) return { status: 'FAILED', satisfied: false, prerequisite };
      return { status: 'PENDING', satisfied: false, prerequisite };
    }
    if (dependency.dependency_kind === 'MATERIAL') {
      const material = this.contextService?.getMaterial?.(dependency.material_id) ?? null;
      if (!material) return { status: 'PENDING', satisfied: false, material: null };
      return { status: ['rejected', 'stale'].includes(material.evidence_state) ? 'FAILED' : 'SATISFIED', satisfied: !['rejected', 'stale'].includes(material.evidence_state), material };
    }
    const check = this.getCheckResult(dependency.check_result_id);
    if (!check) return { status: 'PENDING', satisfied: false, check_result: null };
    if (check.status === 'APPLIED' && check.verdict === 'PASS') return { status: 'SATISFIED', satisfied: true, check_result: check };
    if (['IGNORED', 'SUPERSEDED'].includes(check.status) || ['FAIL', 'ERROR'].includes(check.verdict)) return { status: 'FAILED', satisfied: false, check_result: check };
    return { status: 'PENDING', satisfied: false, check_result: check };
  }

  #taskDependencies(taskId) {
    return this.db.prepare('SELECT * FROM task_structure_dependencies WHERE task_id = ? AND retired_at IS NULL ORDER BY created_at, dependency_id')
      .all(taskId).map((row) => this.#dependencyRecord(row));
  }

  #taskReadiness(task = null) {
    if (!task) return { status: 'MISSING', ready: false, blocked: true, reasons: ['unknown_task'], missing: ['task'] };
    const dependencies = this.#taskDependencies(task.task_id);
    const unresolvedDependencies = dependencies.filter((dependency) => !dependency.satisfied);
    const activeExecutions = this.db.prepare("SELECT state FROM executions WHERE task_id = ? AND state IN ('CREATED', 'RUNNING', 'WAITING')").all(task.task_id);
    let status;
    if (task.state === 'SATISFIED') status = 'SATISFIED';
    else if (TERMINAL_TASK_STATES.includes(task.state)) status = task.state;
    else if (activeExecutions.some(({ state }) => state === 'RUNNING')) status = 'RUNNING';
    else if (activeExecutions.some(({ state }) => state === 'WAITING')) status = 'WAITING';
    else if (unresolvedDependencies.length > 0 || (task.state === 'BLOCKED' &&
      (!String(task.block_reason ?? '').startsWith('dependency:') || unresolvedDependencies.length > 0))) status = 'BLOCKED';
    else status = 'READY';
    const missing = unresolvedDependencies.map((dependency) => `${dependency.dependency_kind.toLowerCase()}:${dependency.prerequisite_task_id ?? dependency.material_id ?? dependency.check_result_id}`);
    if (task.block_reason && !missing.includes(`block:${task.block_reason}`)) missing.push(`block:${task.block_reason}`);
    return {
      status,
      state: task.state,
      ready: status === 'READY',
      blocked: status === 'BLOCKED',
      reasons: unresolvedDependencies.map((dependency) => ({ type: 'dependency', dependency_id: dependency.dependency_id, status: dependency.status })),
      missing,
      dependencies,
    };
  }

  #explainTaskReadiness(taskId) {
    const task = this.#ensureTaskStructure(taskId);
    if (!task) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown Task: ${taskId}`);
    const readiness = this.#taskReadiness(task);
    const latestExecution = this.#latestExecution(taskId);
    const completion = this.#completion(task, latestExecution);
    const groupRows = this.db.prepare(`SELECT group_id FROM task_structure_groups WHERE owner_task_id = ? AND retired_at IS NULL ORDER BY created_at, group_id`).all(taskId);
    const groups = groupRows.map(({ group_id: groupId }) => this.#structureGroup(groupId));
    const unresolvedGroups = groups.filter((group) => !group.satisfied);
    return {
      task,
      status: readiness.status,
      state: readiness.state,
      ready: readiness.ready,
      blocked: readiness.blocked,
      dependencies: readiness.dependencies,
      reasons: readiness.reasons,
      missing: readiness.missing,
      missing_requirements: [...completion.missing, ...unresolvedGroups.map((group) => `${group.group_kind.toLowerCase()}:${group.group_id}`)],
      completion,
      latest_execution: latestExecution,
    };
  }

  #getTaskStructure(taskId) {
    const task = this.#ensureTaskStructure(taskId);
    if (!task) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown Task: ${taskId}`);
    const groupRows = this.db.prepare(`SELECT group_id FROM task_structure_groups WHERE owner_task_id = ? AND retired_at IS NULL ORDER BY created_at, group_id`).all(taskId);
    const groups = groupRows.map(({ group_id: groupId }) => this.#structureGroup(groupId));
    const branchGroups = groups.filter((group) => group.group_kind === 'BRANCH');
    const requiredSubtaskGroups = groups.filter((group) => group.group_kind === 'REQUIRED_SUBTASK');
    const dependencies = this.#taskDependencies(taskId);
    const provenanceRow = this.db.prepare('SELECT * FROM task_creation_provenance WHERE task_id = ?').get(taskId);
    const provenance = provenanceRow ? {
      ...provenanceRow,
      source_material_refs: parse(provenanceRow.source_material_refs_json) ?? [],
      feedback: parse(provenanceRow.feedback_json),
      workspace_lineage: parse(provenanceRow.workspace_lineage_json),
    } : null;
    const events = this.db.prepare('SELECT * FROM task_structure_events WHERE task_id = ? ORDER BY structural_version, created_at, event_id').all(taskId)
      .map((event) => ({ ...event, payload: parse(event.payload_json) ?? {} }));
    const readiness = this.#explainTaskReadiness(taskId);
    return {
      task,
      structural_version: this.#structureVersion(taskId).structural_version,
      branches: branchGroups,
      branch_groups: branchGroups,
      required_subtasks: requiredSubtaskGroups,
      required_subtask_groups: requiredSubtaskGroups,
      dependencies,
      explicit_dependencies: dependencies,
      provenance,
      creation_provenance: provenance,
      events,
      readiness,
      completion: readiness.completion,
      unresolved_work: {
        branch_groups: branchGroups.filter((group) => !group.satisfied).map((group) => group.group_id),
        required_subtask_groups: requiredSubtaskGroups.filter((group) => !group.satisfied).map((group) => group.group_id),
        dependencies: dependencies.filter((dependency) => !dependency.satisfied).map((dependency) => dependency.dependency_id),
      },
    };
  }

  #refreshTaskDependencyState(taskId, { updatedAt = now() } = {}) {
    const task = this.getTask(taskId);
    if (!task || TERMINAL_TASK_STATES.includes(task.state)) return task;
    const active = this.db.prepare("SELECT COUNT(*) AS count FROM executions WHERE task_id = ? AND state IN ('CREATED', 'RUNNING', 'WAITING')").get(taskId).count;
    const unresolved = this.#taskDependencies(taskId).filter((dependency) => !dependency.satisfied);
    if (active > 0) return task;
    const nextState = unresolved.length > 0 ? 'BLOCKED' : 'OPEN';
    const blockReason = unresolved.length > 0 ? `dependency:${unresolved[0].dependency_id}` : null;
    if (task.state === nextState && task.block_reason === blockReason) return task;
    this.db.prepare('UPDATE tasks SET state = ?, block_reason = ?, state_version = state_version + 1, updated_at = ? WHERE task_id = ?')
      .run(nextState, blockReason, updatedAt, taskId);
    return this.getTask(taskId);
  }

  #refreshDependents(prerequisiteTaskId, { updatedAt = now() } = {}) {
    const dependents = this.db.prepare("SELECT DISTINCT task_id FROM task_structure_dependencies WHERE prerequisite_task_id = ? AND dependency_kind = 'TASK' AND retired_at IS NULL").all(prerequisiteTaskId);
    for (const { task_id: taskId } of dependents) this.#refreshTaskDependencyState(taskId, { updatedAt });
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
        execution.instruction_version,
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

  #recordHandoffReminder(payload, envelope) {
    const execution = this.#executionForWrite(envelope);
    if (!['CREATED', 'RUNNING'].includes(execution.state)) {
      return { execution };
    }
    if (execution.handoff_reminder_sent_at) return { execution };
    const remindedAt = payload.reminded_at ?? now();
    if (typeof remindedAt !== 'string' || Number.isNaN(Date.parse(remindedAt))) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'reminded_at must be an ISO timestamp');
    }
    this.db.prepare(`UPDATE executions SET handoff_reminder_sent_at = ?, state_version = state_version + 1, updated_at = ?
      WHERE execution_id = ?`).run(remindedAt, now(), execution.execution_id);
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
    const nextFence = execution.fencing_version + 1;
    this.db.prepare(`UPDATE executions SET state = ?, fencing_version = ?, checkpoint_ref = COALESCE(?, checkpoint_ref),
      checkpoint_hash = COALESCE(?, checkpoint_hash), workspace_ref = COALESCE(?, workspace_ref),
      workspace_revision = COALESCE(?, workspace_revision), workspace_content_hash = COALESCE(?, workspace_content_hash),
      handoff_metadata_json = ?, terminal_reason = ?, wait_condition_json = NULL, wait_deadline = NULL, resume_token = NULL,
      state_version = state_version + 1, updated_at = ? WHERE execution_id = ?`)
      .run(terminalState, nextFence, checkpointRef ?? null, checkpointHash ?? null,
        payload.workspace_ref ?? null, payload.workspace_revision ?? null, payload.workspace_content_hash ?? null,
        json(handoffMetadata), terminalReason, updatedAt, execution.execution_id);
    const task = this.getTask(execution.task_id);
    if (!TERMINAL_TASK_STATES.includes(task.state)) this.#refreshTaskState(execution.task_id, { updatedAt });
    return { execution: this.getExecution(execution.execution_id), task: this.getTask(execution.task_id), handoff: handoffMetadata };
  }

  #startExecution(payload, envelope) {
    const execution = this.#executionForWrite(envelope);
    if (execution.state !== 'CREATED') throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `cannot start Execution from ${execution.state}`);
    const updatedAt = now();
    const startedAt = payload.started_at ?? updatedAt;
    if (typeof startedAt !== 'string' || Number.isNaN(Date.parse(startedAt))) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'started_at must be an ISO timestamp');
    }
    const handoffDeadline = payload.handoff_deadline ?? null;
    const executionDeadline = payload.execution_deadline ?? null;
    for (const [name, value] of [['handoff_deadline', handoffDeadline], ['execution_deadline', executionDeadline]]) {
      if (value !== null && (typeof value !== 'string' || Number.isNaN(Date.parse(value)))) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `${name} must be an ISO timestamp`);
      }
    }
    this.db.prepare(`UPDATE executions SET state = ?, started_at = ?, handoff_deadline = ?, execution_deadline = ?,
      handoff_reminder_sent_at = NULL, terminal_reason = NULL, state_version = state_version + 1, updated_at = ? WHERE execution_id = ?`)
      .run('RUNNING', startedAt, handoffDeadline, executionDeadline, updatedAt, execution.execution_id);
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

  #validateWaitCondition(execution, task, rawCondition, rawDeadline = null) {
    if (!rawCondition || typeof rawCondition !== 'object' || Array.isArray(rawCondition)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'wait_condition is required');
    }
    const waitCondition = { ...rawCondition };
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
    const waitDeadline = rawDeadline ?? waitCondition.deadline ?? null;
    if (waitCondition.type === 'timer' && !waitDeadline) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'timer wait requires a deadline');
    }
    if (waitDeadline !== null && (typeof waitDeadline !== 'string' || Number.isNaN(Date.parse(waitDeadline)))) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'wait_deadline must be an ISO timestamp');
    }
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
    const updatedAt = now();
    this.db.prepare('UPDATE executions SET state = ?, terminal_reason = ?, state_version = state_version + 1, updated_at = ? WHERE execution_id = ?')
      .run(terminalState, payload.terminal_reason ?? null, updatedAt, execution.execution_id);
    const task = this.getTask(execution.task_id);
    if (!TERMINAL_TASK_STATES.includes(task.state)) this.#refreshTaskState(execution.task_id, { updatedAt, cancelIfIdle: terminalState === 'CANCELLED' });
    return { execution: this.getExecution(execution.execution_id), task: this.getTask(execution.task_id) };
  }

  #expireExecution(payload, envelope) {
    const execution = this.#executionForWrite(envelope);
    const updatedAt = now();
    this.db.prepare('UPDATE executions SET state = ?, terminal_reason = ?, fencing_version = fencing_version + 1, runtime_generation = COALESCE(?, runtime_generation), state_version = state_version + 1, updated_at = ? WHERE execution_id = ?')
      .run('EXPIRED', payload.terminal_reason ?? 'lease_expired', payload.runtime_generation ?? null, updatedAt, execution.execution_id);
    const task = this.getTask(execution.task_id);
    if (!TERMINAL_TASK_STATES.includes(task.state)) this.#refreshTaskState(execution.task_id, { updatedAt });
    return { execution: this.getExecution(execution.execution_id), task: this.getTask(execution.task_id) };
  }

  #fenceExecution(payload, envelope) {
    const execution = this.#executionForWrite(envelope);
    const updatedAt = now();
    this.db.prepare('UPDATE executions SET state = ?, terminal_reason = ?, fencing_version = fencing_version + 1, runtime_generation = COALESCE(?, runtime_generation), state_version = state_version + 1, updated_at = ? WHERE execution_id = ?')
      .run('FENCED', payload.terminal_reason ?? 'fenced', payload.runtime_generation ?? null, updatedAt, execution.execution_id);
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
      lease_expires_at = ?, heartbeat_at = ?, agent_prompt = ?, started_at = NULL, handoff_deadline = NULL,
      execution_deadline = NULL, handoff_reminder_sent_at = NULL, terminal_reason = NULL,
      state_version = state_version + 1, updated_at = ?
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
    if (target.parent_id && (execution.state !== 'WAITING' || execution.wait_condition?.type !== 'parent_review')) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'child Task is not waiting for parent review');
    }
    const completion = this.#completion(target, execution);
    if (!completion.satisfied) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'completion_contract is not satisfied', { missing: completion.missing });
    const updatedAt = now();
    this.db.prepare("UPDATE executions SET state = 'SUCCEEDED', wait_condition_json = NULL, wait_deadline = NULL, resume_token = NULL, state_version = state_version + 1, updated_at = ? WHERE execution_id = ?")
      .run(updatedAt, execution.execution_id);
    this.db.prepare("UPDATE tasks SET state = 'SATISFIED', state_version = state_version + 1, block_reason = NULL, updated_at = ? WHERE task_id = ?")
      .run(updatedAt, target.task_id);
    this.#refreshDependents(target.task_id, { updatedAt });
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
        started_at = NULL, handoff_deadline = NULL, execution_deadline = NULL, handoff_reminder_sent_at = NULL,
        terminal_reason = NULL, handoff_metadata_json = NULL, lease_expires_at = ?, state_version = state_version + 1, updated_at = ? WHERE execution_id = ?`)
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
        this.#refreshDependents(task.task_id, { updatedAt });
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
    const authorityTaskId = target.parent_id ?? target.task_id;
    if (envelope.task_id !== authorityTaskId) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'operation envelope is not the acceptance authority');
    if (target.parent_id) {
      const parentExecution = this.#executionForWrite(envelope);
      if (parentExecution.owner_ref !== envelope.actor_ref) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'only the Parent Task current owner may review a child');
      return parentExecution;
    }
    if (envelope.actor_ref !== target.owner_ref) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'only the root Task owner may accept the Task');
    if (envelope.execution_id !== null) return this.#executionForWrite(envelope);
    return null;
  }

  #refreshTaskState(taskId, { updatedAt = now(), cancelIfIdle = false } = {}) {
    const task = this.getTask(taskId);
    if (!task || TERMINAL_TASK_STATES.includes(task.state)) return task;
    const active = this.db.prepare("SELECT state FROM executions WHERE task_id = ? AND state IN ('CREATED', 'RUNNING', 'WAITING')").all(taskId);
    const unresolved = this.#taskDependencies(taskId).filter((dependency) => !dependency.satisfied);
    const nextState = active.length === 0
      ? (cancelIfIdle ? 'CANCELLED' : unresolved.length > 0 ? 'BLOCKED' : 'OPEN')
      : (active.some((execution) => execution.state === 'RUNNING')
        ? 'RUNNING'
        : (active.some((execution) => execution.state === 'WAITING') ? 'WAITING' : 'OPEN'));
    const blockReason = nextState === 'BLOCKED' ? `dependency:${unresolved[0].dependency_id}` : null;
    if (task.state === nextState && task.block_reason === blockReason) return task;
    this.db.prepare('UPDATE tasks SET state = ?, state_version = state_version + 1, block_reason = ?, cancelled_at = CASE WHEN ? = \'CANCELLED\' THEN ? ELSE cancelled_at END, updated_at = ? WHERE task_id = ?')
      .run(nextState, blockReason, nextState, nextState === 'CANCELLED' ? updatedAt : null, updatedAt, taskId);
    return this.getTask(taskId);
  }

  #latestExecution(taskId, activeOnly = false) {
    const activeClause = activeOnly ? "AND state IN ('CREATED', 'RUNNING', 'WAITING')" : '';
    return rowToExecution(this.db.prepare(`SELECT * FROM executions WHERE task_id = ? ${activeClause} ORDER BY attempt_no DESC, created_at DESC LIMIT 1`).get(taskId));
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
    const structuralGroups = this.db.prepare(`SELECT group_id, group_kind FROM task_structure_groups
      WHERE owner_task_id = ? AND retired_at IS NULL ORDER BY created_at, group_id`).all(task.task_id);
    for (const group of structuralGroups) {
      const structure = this.#structureGroup(group.group_id);
      if (!structure?.satisfied) missing.push(`${group.group_kind === 'BRANCH' ? 'branch_group' : 'required_subtask_group'}:${group.group_id}`);
    }
    if (contract.required_children) {
      for (const childId of contract.required_children) {
        if (this.getTask(childId)?.state !== 'SATISFIED') missing.push(`child:${childId}`);
      }
    }
    for (const [key, expectedKind] of [['required_branch_groups', 'BRANCH'], ['required_subtask_groups', 'REQUIRED_SUBTASK']]) {
      if (!contract[key]) continue;
      for (const groupId of contract[key]) {
        const group = this.db.prepare('SELECT * FROM task_structure_groups WHERE group_id = ? AND owner_task_id = ? AND group_kind = ? AND retired_at IS NULL').get(groupId, task.task_id, expectedKind);
        if (!group) {
          missing.push(`${key}:${groupId}`);
          continue;
        }
        const structure = this.#structureGroup(groupId);
        if (!structure?.satisfied) missing.push(`${key}:${groupId}`);
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

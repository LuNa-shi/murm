import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ERROR_CODES, SwarmEnvError } from '../errors.js';
import { makeEnvelope, operationPayload, stableStringify, validateEnvelope } from '../protocol/envelope.js';
import { SCHEMA_SQL } from '../storage/schema.js';
import {
  TERMINAL_EXECUTION_STATES,
  TERMINAL_TASK_STATES,
  validateTaskProposal,
} from './task-types.js';

const EXECUTION_WRITE_OPERATIONS = new Set(['abort', 'fence_execution', 'heartbeat', 'request_wait', 'resume_execution', 'start_execution', 'stop_execution']);
const CLAIM_OPERATION = 'claim';
const TASK_MUTATING_OPERATIONS = new Set(['accept_task', 'create_child_task', 'propose_task']);

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
    retry_policy: parse(row.retry_policy_json),
  };
}

function rowToExecution(row) {
  if (!row) return null;
  return {
    ...row,
    input_material_refs: parse(row.input_material_refs_json),
    steer_material_refs: parse(row.steer_material_refs_json),
    wait_condition: parse(row.wait_condition_json),
  };
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `${field} is required`);
  }
  return value;
}

function requireVersion(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `${field} must be a non-negative integer`);
  }
}

export class TaskService {
  constructor(database = ':memory:') {
    this.db = database instanceof DatabaseSync ? database : new DatabaseSync(database);
    this.db.exec(SCHEMA_SQL);
  }

  close() {
    this.db.close();
  }

  dispatch(operation, payload = {}, envelope) {
    validateEnvelope(envelope, { executionWrite: EXECUTION_WRITE_OPERATIONS.has(operation) });
    if (['get_task', 'get_execution', 'list_children'].includes(operation)) {
      return this.#read(operation, payload, envelope);
    }
    if (!TASK_MUTATING_OPERATIONS.has(operation) && !EXECUTION_WRITE_OPERATIONS.has(operation) && operation !== CLAIM_OPERATION) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unsupported Task Service operation: ${operation}`);
    }
    return this.#transaction(() => {
      const fingerprint = operationPayload(operation, payload, envelope);
      const replay = this.#replay(envelope.operation_id, fingerprint);
      if (replay) return replay;
      const result = this.#mutate(operation, payload, envelope);
      this.#saveOperation(envelope.operation_id, operation, fingerprint, result);
      return result;
    });
  }

  proposeTask(input, envelope = makeEnvelope({ actorRef: input?.owner_ref ?? 'unknown' })) {
    return this.dispatch('propose_task', input, envelope);
  }

  createChildTask(input, envelope) {
    return this.dispatch('create_child_task', input, envelope);
  }

  getTask(taskId) {
    return rowToTask(this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId));
  }

  getExecution(executionId) {
    return rowToExecution(this.db.prepare('SELECT * FROM executions WHERE execution_id = ?').get(executionId));
  }

  listChildren(parentTaskId) {
    return this.db.prepare('SELECT * FROM tasks WHERE parent_id = ? ORDER BY created_at, task_id').all(parentTaskId).map(rowToTask);
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
    const parentTaskId = payload.parent_task_id ?? envelope.task_id;
    return this.listChildren(requireString(parentTaskId, 'parent_task_id'));
  }

  #mutate(operation, payload, envelope) {
    switch (operation) {
      case 'propose_task': return this.#proposeTask(payload, envelope);
      case 'create_child_task': return this.#createChildTask(payload, envelope);
      case 'claim': return this.#claim(payload, envelope);
      case 'heartbeat': return this.#heartbeat(payload, envelope);
      case 'start_execution': return this.#startExecution(payload, envelope);
      case 'resume_execution': return this.#resumeExecution(payload, envelope);
      case 'request_wait': return this.#requestWait(payload, envelope);
      case 'stop_execution': return this.#stopExecution(payload, envelope);
      case 'fence_execution': return this.#fenceExecution(payload, envelope);
      case 'abort': return this.#stopExecution({ ...payload, terminal_state: 'CANCELLED' }, envelope);
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
      task_id, root_id, parent_id, owner_ref, task_type, task_type_version, goal, expected_output,
      acceptance_conditions_json, input_material_refs_json, spec_version, spec_hash,
      completion_contract_json, parallel_quota, state_version, state, block_reason,
      max_depth, max_children, max_attempts, retry_policy_json, root_deadline, created_by, created_at, updated_at
    ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 1, 0, 'OPEN', NULL, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(taskId, taskId, input.owner_ref, input.task_type, input.task_type_version, input.goal, input.expected_output,
        json(input.acceptance_conditions), json(input.input_material_refs), hash(spec), json(input.completion_contract),
        input.max_depth, input.max_children, input.max_attempts, json(input.retry_policy), input.root_deadline,
        envelope.actor_ref, createdAt, createdAt);
    return { task: this.getTask(taskId) };
  }

  #createChildTask(payload, envelope) {
    const parentId = payload.parent_task_id ?? envelope.task_id;
    requireString(parentId, 'parent_task_id');
    if (envelope.task_id !== parentId) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'parent_task_id must match envelope task_id');
    const parent = this.getTask(parentId);
    if (!parent) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown parent task: ${parentId}`);
    const parentExecution = this.db.prepare(`SELECT * FROM executions WHERE task_id = ? AND state IN ('CREATED', 'RUNNING', 'WAITING')`).get(parentId);
    if (!parentExecution || parentExecution.owner_ref !== envelope.actor_ref) {
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
    const childInput = validateTaskProposal({ ...payload, owner_ref: payload.owner_ref ?? envelope.actor_ref }, { parentId });
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
      task_id, root_id, parent_id, owner_ref, task_type, task_type_version, goal, expected_output,
      acceptance_conditions_json, input_material_refs_json, spec_version, spec_hash,
      completion_contract_json, parallel_quota, state_version, state, block_reason,
      max_depth, max_children, max_attempts, retry_policy_json, root_deadline, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 1, 0, 'OPEN', NULL, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(taskId, parent.root_id, parentId, childInput.owner_ref, childInput.task_type, childInput.task_type_version,
        childInput.goal, childInput.expected_output, json(childInput.acceptance_conditions), json(childInput.input_material_refs),
        hash(spec), json(childInput.completion_contract), childInput.max_depth, childInput.max_children, childInput.max_attempts,
        json(childInput.retry_policy), childInput.root_deadline, envelope.actor_ref, createdAt, createdAt);
    this.db.prepare('INSERT INTO task_creation_keys (request_key, parent_task_id, fingerprint, task_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(key, parentId, fingerprint, taskId, createdAt);
    this.db.prepare('UPDATE tasks SET state_version = state_version + 1, updated_at = ? WHERE task_id = ?')
      .run(createdAt, parentId);
    return { task: this.getTask(taskId) };
  }

  #claim(payload, envelope) {
    requireString(envelope.task_id, 'task_id');
    if (envelope.execution_id !== null) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'claim cannot target an execution');
    const task = this.getTask(envelope.task_id);
    if (!task) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown task: ${envelope.task_id}`);
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
    const initialPrompt = requireString(payload.initial_prompt, 'initial_prompt');
    const initialContextRef = requireString(payload.initial_context_ref, 'initial_context_ref');
    const inputSnapshotHash = requireString(payload.input_snapshot_hash, 'input_snapshot_hash');
    if (!Array.isArray(payload.input_material_refs)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'input_material_refs must be an array');
    const active = this.db.prepare(`SELECT * FROM executions WHERE task_id = ? AND state IN ('CREATED', 'RUNNING', 'WAITING')`).get(task.task_id);
    if (active) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Task already has an active Execution', { execution_id: active.execution_id });
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
      initial_prompt: initialPrompt,
      initial_context_ref: initialContextRef,
      input_material_refs: payload.input_material_refs,
      input_snapshot_hash: inputSnapshotHash,
      workspace_ref: null,
      workspace_revision: null,
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
      lease_expires_at, heartbeat_at, launch_token, spec_version, spec_hash, initial_prompt, initial_context_ref,
      input_material_refs_json, input_snapshot_hash, workspace_ref, workspace_revision, checkpoint_ref, checkpoint_hash,
      instruction_version, steer_material_refs_json, wait_condition_json, wait_deadline, resume_token, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(execution.execution_id, execution.task_id, execution.owner_ref, execution.state, execution.state_version,
        execution.attempt_no, execution.fencing_version, execution.runtime_generation, execution.lease_expires_at,
        execution.heartbeat_at, execution.launch_token, execution.spec_version, execution.spec_hash, execution.initial_prompt,
        execution.initial_context_ref, json(execution.input_material_refs), execution.input_snapshot_hash, execution.workspace_ref,
        execution.workspace_revision, execution.checkpoint_ref, execution.checkpoint_hash, execution.instruction_version,
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
    const execution = this.#executionForWrite(envelope);
    requireString(payload.checkpoint_ref, 'checkpoint_ref');
    requireString(payload.checkpoint_hash, 'checkpoint_hash');
    if (!payload.wait_condition || typeof payload.wait_condition !== 'object') throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'wait_condition is required');
    const allowed = new Set(['child_task_terminal', 'parent_review', 'check_result_arrived', 'timer']);
    if (!allowed.has(payload.wait_condition.type)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'unsupported wait_condition type');
    const updatedAt = now();
    this.db.prepare(`UPDATE executions SET state = 'WAITING', checkpoint_ref = ?, checkpoint_hash = ?, workspace_ref = COALESCE(?, workspace_ref), workspace_revision = COALESCE(?, workspace_revision), wait_condition_json = ?, wait_deadline = ?, resume_token = ?, state_version = state_version + 1, updated_at = ? WHERE execution_id = ?`)
      .run(payload.checkpoint_ref, payload.checkpoint_hash, payload.workspace_ref ?? null, payload.workspace_revision ?? null,
        json(payload.wait_condition), payload.wait_deadline ?? null, payload.resume_token ?? randomUUID(), updatedAt, execution.execution_id);
    this.db.prepare('UPDATE tasks SET state = ?, state_version = state_version + 1, block_reason = NULL, updated_at = ? WHERE task_id = ?')
      .run('WAITING', updatedAt, execution.task_id);
    return { execution: this.getExecution(execution.execution_id), task: this.getTask(execution.task_id) };
  }

  #stopExecution(payload, envelope) {
    const execution = this.#executionForWrite(envelope);
    const terminalState = payload.terminal_state ?? 'FAILED';
    if (!TERMINAL_EXECUTION_STATES.includes(terminalState)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'terminal_state must be an Execution terminal state');
    const updatedAt = now();
    this.db.prepare('UPDATE executions SET state = ?, state_version = state_version + 1, updated_at = ? WHERE execution_id = ?')
      .run(terminalState, updatedAt, execution.execution_id);
    const task = this.getTask(execution.task_id);
    if (!TERMINAL_TASK_STATES.includes(task.state)) {
      this.db.prepare('UPDATE tasks SET state = ?, state_version = state_version + 1, updated_at = ? WHERE task_id = ?')
        .run(terminalState === 'CANCELLED' ? 'CANCELLED' : 'OPEN', updatedAt, execution.task_id);
    }
    return { execution: this.getExecution(execution.execution_id), task: this.getTask(execution.task_id) };
  }

  #fenceExecution(payload, envelope) {
    const execution = this.#executionForWrite(envelope);
    const updatedAt = now();
    this.db.prepare('UPDATE executions SET state = ?, fencing_version = fencing_version + 1, state_version = state_version + 1, updated_at = ? WHERE execution_id = ?')
      .run('FENCED', updatedAt, execution.execution_id);
    const task = this.getTask(execution.task_id);
    if (!TERMINAL_TASK_STATES.includes(task.state)) {
      this.db.prepare('UPDATE tasks SET state = ?, state_version = state_version + 1, block_reason = NULL, updated_at = ? WHERE task_id = ?')
        .run('OPEN', updatedAt, execution.task_id);
    }
    return { execution: this.getExecution(execution.execution_id), task: this.getTask(execution.task_id) };
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

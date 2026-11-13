import { createHash, randomUUID } from 'node:crypto';
import { ERROR_CODES, SwarmEnvError } from '../errors.js';
import { operationPayload, validateEnvelope } from '../protocol/envelope.js';

const MUTATING_OPERATIONS = new Set([
  'heartbeat',
  'consume_materials',
  'publish_material',
  'request_wait',
  'workspace_check',
]);

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

/**
 * A deterministic, in-process service boundary used before the SQLite services
 * exist. It intentionally exposes public operations only; private workspace
 * management belongs to Runtime and is absent from this interface.
 */
export class LocalServiceDouble {
  constructor({ tasks = [], executions = [], trustedActorPrefixes = ['judge:'] } = {}) {
    this.tasks = new Map(tasks.map((task) => [task.task_id, clone(task)]));
    this.executions = new Map(executions.map((execution) => [execution.execution_id, clone(execution)]));
    this.materials = new Map();
    this.consumptions = [];
    this.operations = new Map();
    this.calls = [];
    this.trustedActorPrefixes = trustedActorPrefixes;
  }

  seedTask(task) {
    this.tasks.set(task.task_id, clone(task));
  }

  seedExecution(execution) {
    this.executions.set(execution.execution_id, clone(execution));
  }

  dispatch(operation, payload = {}, envelope) {
    validateEnvelope(envelope, { executionWrite: MUTATING_OPERATIONS.has(operation) && operation !== 'publish_material' });
    const call = { operation, payload: clone(payload), envelope: clone(envelope) };
    this.calls.push(call);

    const key = envelope.operation_id;
    const fingerprint = operationPayload(operation, payload, envelope);
    const prior = this.operations.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new SwarmEnvError(ERROR_CODES.CONFLICT, `operation_id ${key} was already used with another payload`);
      }
      return clone(prior.result);
    }

    this.#checkVersions(envelope, operation);
    let result;
    switch (operation) {
      case 'get_task':
        result = this.#getTask(payload.task_id ?? envelope.task_id);
        break;
      case 'get_execution':
        result = this.#getExecution(payload.execution_id ?? envelope.execution_id);
        break;
      case 'list_tasks':
        result = [...this.tasks.values()]
          .filter((task) => (payload.root_id ? task.root_id === payload.root_id : true))
          .filter((task) => (payload.task_type ? task.task_type === payload.task_type : true))
          .filter((task) => (payload.states ?? ['OPEN']).includes(task.state))
          .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0) || String(left.task_id).localeCompare(String(right.task_id)))
          .slice(0, payload.limit ?? 10)
          .map(clone);
        break;
      case 'list_executions':
        result = [...this.executions.values()]
          .filter((execution) => execution.task_id === (payload.task_id ?? envelope.task_id))
          .filter((execution) => payload.include_terminal !== false || ['CREATED', 'RUNNING', 'WAITING'].includes(execution.state))
          .map(clone);
        break;
      case 'read_materials':
        result = this.#readMaterials(payload);
        break;
      case 'list_material_consumptions':
        result = this.#listMaterialConsumptions(payload);
        break;
      case 'consume_materials':
        result = this.#consumeMaterials(payload, envelope);
        break;
      case 'publish_material':
        result = this.#publishMaterial(payload, envelope);
        break;
      case 'heartbeat':
      case 'workspace_check':
        result = { accepted: true, operation, operation_id: key };
        break;
      default:
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unsupported service operation: ${operation}`);
    }

    if (MUTATING_OPERATIONS.has(operation)) {
      this.operations.set(key, { fingerprint, result: clone(result) });
    }
    return clone(result);
  }

  #getTask(taskId) {
    if (!taskId || !this.tasks.has(taskId)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown task: ${taskId ?? '<missing>'}`);
    }
    return clone(this.tasks.get(taskId));
  }

  #getExecution(executionId) {
    if (!executionId || !this.executions.has(executionId)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown execution: ${executionId ?? '<missing>'}`);
    }
    return clone(this.executions.get(executionId));
  }

  #checkVersions(envelope, operation) {
    const task = envelope.task_id ? this.tasks.get(envelope.task_id) : undefined;
    if (task && envelope.spec_version !== null && envelope.spec_version !== task.spec_version) {
      throw new SwarmEnvError(ERROR_CODES.STALE_VERSION, 'task spec_version is stale', {
        expected: task.spec_version,
        received: envelope.spec_version,
      });
    }
    const execution = envelope.execution_id ? this.executions.get(envelope.execution_id) : undefined;
    if (!execution) return;
    if (envelope.fencing_version !== null && envelope.fencing_version !== undefined &&
      envelope.fencing_version !== execution.fencing_version) {
      throw new SwarmEnvError(ERROR_CODES.FENCED, 'execution fencing_version is stale', {
        expected: execution.fencing_version,
        received: envelope.fencing_version,
      });
    }
    if (envelope.state_version !== null && envelope.state_version !== undefined &&
      envelope.state_version !== execution.state_version &&
      ['heartbeat', 'request_wait', 'workspace_check', 'abort'].includes(operation)) {
      throw new SwarmEnvError(ERROR_CODES.STALE_VERSION, 'execution state_version is stale', {
        expected: execution.state_version,
        received: envelope.state_version,
      });
    }
  }

  #readMaterials({ materialId, kind, scope, sourceTask, sourceExecution } = {}) {
    return [...this.materials.values()]
      .filter((material) => !materialId || material.material_id === materialId)
      .filter((material) => !kind || material.kind === kind)
      .filter((material) => !scope || material.scope === scope)
      .filter((material) => !sourceTask || material.source_task === sourceTask)
      .filter((material) => !sourceExecution || material.source_execution === sourceExecution)
      .map(clone);
  }

  #listMaterialConsumptions({ materialId, material_id: materialIdSnake, readerTask, reader_task: readerTaskSnake, readerExecution, reader_execution: readerExecutionSnake, action } = {}) {
    const selectedMaterialId = materialId ?? materialIdSnake;
    const selectedReaderTask = readerTask ?? readerTaskSnake;
    const selectedReaderExecution = readerExecution ?? readerExecutionSnake;
    return [...(this.consumptions ?? [])]
      .filter((row) => !selectedMaterialId || row.material_id === selectedMaterialId)
      .filter((row) => !selectedReaderTask || row.reader_task === selectedReaderTask)
      .filter((row) => !selectedReaderExecution || row.reader_execution === selectedReaderExecution)
      .filter((row) => !action || row.action === action)
      .map(clone);
  }

  #consumeMaterials(payload, envelope) {
    const materialIds = payload.material_ids ?? payload.materialIds;
    if (!envelope.task_id || !envelope.execution_id) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'consume_materials requires a bound Task and Execution');
    }
    if (!Array.isArray(materialIds) || materialIds.length < 1 || materialIds.length > 100 || materialIds.some((id) => typeof id !== 'string' || id.length === 0)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'material_ids must contain between 1 and 100 Material IDs');
    }
    const uniqueMaterialIds = [...new Set(materialIds)];
    if (uniqueMaterialIds.length !== materialIds.length) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'material_ids must not contain duplicates');
    }
    if (!['route', 'task', 'candidate', 'integration'].includes(payload.action)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'action must be route, task, candidate, or integration');
    }
    if (payload.action_ref !== undefined && payload.action_ref !== null && (typeof payload.action_ref !== 'string' || payload.action_ref.length === 0)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'action_ref must be a non-empty string or null');
    }
    const missing = uniqueMaterialIds.filter((materialId) => !this.materials.has(materialId));
    if (missing.length > 0) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown Material IDs: ${missing.join(',')}`);
    this.consumptions ??= [];
    const createdAt = new Date().toISOString();
    for (const materialId of uniqueMaterialIds) {
      if (!this.consumptions.some((row) => row.operation_id === envelope.operation_id && row.material_id === materialId)) {
        this.consumptions.push({
          operation_id: envelope.operation_id,
          material_id: materialId,
          reader_task: envelope.task_id,
          reader_execution: envelope.execution_id,
          action: payload.action,
          action_ref: payload.action_ref ?? null,
          created_at: createdAt,
        });
      }
    }
    return {
      consumptions: this.#listMaterialConsumptions({ reader_execution: envelope.execution_id, action: payload.action })
        .filter((row) => row.operation_id === envelope.operation_id && uniqueMaterialIds.includes(row.material_id)),
      material_ids: uniqueMaterialIds,
      action: payload.action,
      action_ref: payload.action_ref ?? null,
    };
  }

  #publishMaterial(payload, envelope) {
    if (!payload.kind || !payload.scope || payload.content === undefined) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'material kind, scope, and content are required');
    }
    const contentHash = sha256(payload.content);
    if (payload.content_hash && payload.content_hash !== contentHash) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'content_hash does not match content');
    }
    const provenance = clone(payload.provenance ?? { actor_ref: envelope.actor_ref });
    if (payload.scope === 'root_integration') {
      const consumedIds = provenance?.consumed_material_ids;
      if (!Array.isArray(consumedIds) || consumedIds.length < 1 || consumedIds.length > 100 || consumedIds.some((id) => typeof id !== 'string' || id.length === 0)) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'root_integration provenance must include 1 to 100 consumed_material_ids');
      }
      if (new Set(consumedIds).size !== consumedIds.length) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'root_integration consumed_material_ids must not contain duplicates');
      }
      const consumed = new Set(this.#listMaterialConsumptions({ reader_task: envelope.task_id, reader_execution: envelope.execution_id, action: 'integration' }).map((row) => row.material_id));
      const missingConsumed = consumedIds.filter((materialId) => !consumed.has(materialId));
      if (missingConsumed.length > 0) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `root_integration Material IDs were not durably consumed: ${missingConsumed.join(',')}`);
      }
    }
    const trusted = this.trustedActorPrefixes.some((prefix) => envelope.actor_ref.startsWith(prefix));
    const requestedEvidence = payload.evidence_state ?? 'proposed';
    const evidenceState = trusted ? requestedEvidence : ['checked', 'accepted'].includes(requestedEvidence) ? 'proposed' : requestedEvidence;
    const material = {
      material_id: payload.material_id ?? randomUUID(),
      kind: payload.kind,
      scope: payload.scope,
      evidence_state: evidenceState,
      content_ref: `memory://${contentHash}`,
      content_hash: contentHash,
      content: clone(payload.content),
      source_task: envelope.task_id,
      source_execution: envelope.execution_id,
      provenance,
      supersedes: payload.supersedes ?? null,
      created_at: new Date().toISOString(),
    };
    const existing = this.materials.get(material.material_id);
    if (existing && existing.content_hash !== material.content_hash) {
      throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'material_id already contains different content');
    }
    this.materials.set(material.material_id, material);
    return clone(material);
  }
}

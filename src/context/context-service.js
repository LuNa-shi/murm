import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ERROR_CODES, SwarmEnvError } from '../errors.js';
import { operationPayload, stableStringify, validateEnvelope } from '../protocol/envelope.js';
import { CONTEXT_SCHEMA_SQL } from '../storage/context-schema.js';

const EVIDENCE_STATES = new Set(['proposed', 'observed', 'checked', 'accepted', 'rejected', 'stale']);
const TRUSTED_ACTOR_PREFIXES = ['judge:', 'system:'];
const SECRET_KEY = /(secret|password|token|api[_-]?key|credential|private[_-]?key)/i;

function now() {
  return new Date().toISOString();
}

function json(value) {
  return JSON.stringify(value ?? null);
}

function parse(value) {
  return value === null || value === undefined ? null : JSON.parse(value);
}

function sha256(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `${field} is required`);
  }
  return value;
}

function cloneMaterial(row) {
  if (!row) return null;
  return { ...row, content: parse(row.content_json), provenance: parse(row.provenance_json) };
}

function rejectSecrets(value, path = 'payload') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSecrets(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `secret-bearing field ${path}.${key} cannot enter Context Service`);
    }
    rejectSecrets(child, `${path}.${key}`);
  }
}

export class ContextService {
  constructor(database = ':memory:', { trustedActorPrefixes = TRUSTED_ACTOR_PREFIXES, taskService = null } = {}) {
    this.db = database instanceof DatabaseSync ? database : new DatabaseSync(database);
    this.db.exec(CONTEXT_SCHEMA_SQL);
    this.trustedActorPrefixes = trustedActorPrefixes;
    this.taskService = taskService;
  }

  close() {
    this.db.close();
  }

  dispatch(operation, payload = {}, envelope) {
    const executionWrite = operation === 'publish_material' && envelope?.execution_id !== null;
    validateEnvelope(envelope, { executionWrite });
    if (operation === 'read_materials') return this.#readMaterials(payload);
    return this.#transaction(() => {
      const fingerprint = operationPayload(operation, payload, envelope);
      const replay = this.#replay(envelope.operation_id, fingerprint);
      if (replay) return replay;
      let result;
      if (operation === 'publish_material') result = this.#publishMaterial(payload, envelope);
      else if (operation === 'freeze_initial_context') result = this.#freezeInitialContext(payload, envelope, fingerprint);
      else throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unsupported Context Service operation: ${operation}`);
      this.#saveOperation(envelope.operation_id, operation, fingerprint, result);
      return result;
    });
  }

  getMaterial(materialId) {
    return cloneMaterial(this.db.prepare('SELECT * FROM materials WHERE material_id = ?').get(materialId));
  }

  getInitialContext(executionId) {
    const row = this.db.prepare('SELECT * FROM initial_contexts WHERE execution_id = ?').get(executionId);
    if (!row) return null;
    return {
      execution_id: row.execution_id,
      task_id: row.task_id,
      spec_version: row.spec_version,
      spec_hash: row.spec_hash,
      input_snapshot_hash: row.input_snapshot_hash,
      manifest_hash: row.manifest_hash,
      freeze_key: row.freeze_key,
      manifest: parse(row.manifest_json),
      created_at: row.created_at,
    };
  }

  #readMaterials(filters = {}) {
    const materialId = filters.material_id ?? filters.materialId;
    const kind = filters.kind;
    const scope = filters.scope;
    const sourceTask = filters.source_task ?? filters.sourceTask;
    const sourceExecution = filters.source_execution ?? filters.sourceExecution;
    return this.db.prepare(`SELECT * FROM materials
      WHERE (? IS NULL OR material_id = ?)
        AND (? IS NULL OR kind = ?)
        AND (? IS NULL OR scope = ?)
        AND (? IS NULL OR source_task = ?)
        AND (? IS NULL OR source_execution = ?)
      ORDER BY created_at, material_id`)
      .all(materialId, materialId, kind ?? null, kind ?? null, scope ?? null, scope ?? null,
        sourceTask ?? null, sourceTask ?? null, sourceExecution ?? null, sourceExecution ?? null)
      .map(cloneMaterial);
  }

  #publishMaterial(payload, envelope) {
    this.#assertExecutionFence(envelope);
    rejectSecrets(payload);
    for (const field of ['kind', 'scope']) requireString(payload[field], field);
    if (!EVIDENCE_STATES.has(payload.evidence_state ?? 'proposed')) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'unsupported evidence_state');
    }
    if (payload.content === undefined) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'material content is required');
    if (payload.source_task !== undefined && payload.source_task !== envelope.task_id) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'source_task must match the operation envelope');
    }
    if (payload.source_execution !== undefined && payload.source_execution !== envelope.execution_id) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'source_execution must match the operation envelope');
    }
    const contentHash = sha256(payload.content);
    if (payload.content_hash && payload.content_hash !== contentHash) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'content_hash does not match content');
    }
    const materialId = payload.material_id ?? randomUUID();
    const supersedes = payload.supersedes ?? null;
    let version = 1;
    if (supersedes) {
      const previous = this.getMaterial(supersedes);
      if (!previous) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `superseded material does not exist: ${supersedes}`);
      version = previous.version + 1;
    }
    const trusted = this.trustedActorPrefixes.some((prefix) => envelope.actor_ref.startsWith(prefix));
    const requestedEvidence = payload.evidence_state ?? 'proposed';
    const evidenceState = trusted ? requestedEvidence : ['checked', 'accepted'].includes(requestedEvidence) ? 'proposed' : requestedEvidence;
    const material = {
      material_id: materialId,
      kind: payload.kind,
      scope: payload.scope,
      evidence_state: evidenceState,
      content_ref: payload.content_ref ?? `sqlite://material/${materialId}`,
      content_hash: contentHash,
      content: payload.content,
      version,
      source_task: envelope.task_id,
      source_execution: envelope.execution_id,
      provenance: payload.provenance ?? { actor_ref: envelope.actor_ref },
      supersedes,
      created_at: now(),
    };
    const existing = this.getMaterial(materialId);
    if (existing) {
      if (existing.content_hash !== contentHash || existing.kind !== material.kind || existing.scope !== material.scope || existing.supersedes !== material.supersedes) {
        throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'material_id already contains a different immutable record');
      }
      return { material: existing };
    }
    this.db.prepare(`INSERT INTO materials (
      material_id, kind, scope, evidence_state, content_ref, content_hash, content_json, version,
      source_task, source_execution, provenance_json, supersedes, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(material.material_id, material.kind, material.scope, material.evidence_state, material.content_ref, material.content_hash,
        json(material.content), material.version, material.source_task, material.source_execution, json(material.provenance), material.supersedes, material.created_at);
    return { material: cloneMaterial(this.db.prepare('SELECT * FROM materials WHERE material_id = ?').get(materialId)) };
  }

  #assertExecutionFence(envelope) {
    if (!this.taskService || envelope.execution_id === null) return;
    const execution = this.taskService.getExecution(envelope.execution_id);
    if (!execution) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'material source execution does not exist');
    if (execution.task_id !== envelope.task_id) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'material source task does not match execution');
    if (execution.spec_version !== envelope.spec_version) throw new SwarmEnvError(ERROR_CODES.STALE_VERSION, 'material source spec_version is stale');
    if (execution.fencing_version !== envelope.fencing_version) throw new SwarmEnvError(ERROR_CODES.FENCED, 'material source fencing_version is stale', { expected: execution.fencing_version });
    if (execution.state_version !== envelope.state_version) throw new SwarmEnvError(ERROR_CODES.STALE_VERSION, 'material source state_version is stale', { expected: execution.state_version });
  }

  #freezeInitialContext(payload, envelope, fingerprint) {
    rejectSecrets(payload);
    const executionId = requireString(payload.execution_id ?? envelope.execution_id, 'execution_id');
    const taskId = requireString(payload.task_id ?? envelope.task_id, 'task_id');
    if (envelope.execution_id !== null && envelope.execution_id !== executionId) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'execution_id must match the operation envelope');
    if (envelope.task_id !== null && envelope.task_id !== taskId) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'task_id must match the operation envelope');
    if (!Number.isInteger(payload.spec_version) || payload.spec_version < 0) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'spec_version is required');
    requireString(payload.spec_hash, 'spec_hash');
    requireString(payload.initial_prompt, 'initial_prompt');
    if (!payload.task_spec || typeof payload.task_spec !== 'object' || Array.isArray(payload.task_spec)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'task_spec is required');
    }
    if (!Array.isArray(payload.material_refs)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'material_refs must be an array');
    if (!payload.service_environment || typeof payload.service_environment !== 'object' || Array.isArray(payload.service_environment)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'service_environment is required');
    }
    const freezeKey = requireString(payload.freeze_key ?? payload.request_key, 'freeze_key');
    const existingKey = this.db.prepare('SELECT * FROM initial_context_keys WHERE request_key = ?').get(freezeKey);
    if (existingKey) {
      if (existingKey.fingerprint !== fingerprint) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'freeze_key was reused with another payload');
      return { initial_context: this.getInitialContext(existingKey.execution_id), initial_context_ref: `sqlite://initial-context/${existingKey.execution_id}` };
    }
    const materials = payload.material_refs.map((reference, index) => {
      const materialId = typeof reference === 'string' ? reference : reference?.material_id;
      requireString(materialId, `material_refs[${index}].material_id`);
      const material = this.getMaterial(materialId);
      if (!material) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown material: ${materialId}`);
      if (reference?.content_hash && reference.content_hash !== material.content_hash) {
        throw new SwarmEnvError(ERROR_CODES.STALE_VERSION, `material hash is stale: ${materialId}`);
      }
      return { material_id: material.material_id, version: material.version, kind: material.kind, scope: material.scope, content_hash: material.content_hash };
    });
    const baseManifest = {
      execution_id: executionId,
      task_id: taskId,
      spec_version: payload.spec_version,
      spec_hash: payload.spec_hash,
      task_spec: payload.task_spec,
      initial_prompt: payload.initial_prompt,
      material_refs: materials,
      service_environment: payload.service_environment,
      instruction_version: payload.instruction_version ?? 1,
    };
    const inputSnapshotHash = sha256(baseManifest);
    const manifest = { ...baseManifest, input_snapshot_hash: inputSnapshotHash, frozen_at: now() };
    const manifestHash = sha256(baseManifest);
    const existingContext = this.getInitialContext(executionId);
    if (existingContext) {
      if (existingContext.manifest_hash !== manifestHash) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Initial Context is already frozen with different input');
      return { initial_context: existingContext, initial_context_ref: `sqlite://initial-context/${executionId}` };
    }
    const createdAt = now();
    this.db.prepare(`INSERT INTO initial_contexts (
      execution_id, task_id, spec_version, spec_hash, input_snapshot_hash, manifest_hash, manifest_json, freeze_key, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(executionId, taskId, payload.spec_version, payload.spec_hash, inputSnapshotHash, manifestHash, json(manifest), freezeKey, createdAt);
    this.db.prepare('INSERT INTO initial_context_keys (request_key, fingerprint, execution_id, created_at) VALUES (?, ?, ?, ?)')
      .run(freezeKey, fingerprint, executionId, createdAt);
    return { initial_context: this.getInitialContext(executionId), initial_context_ref: `sqlite://initial-context/${executionId}`, input_snapshot_hash: inputSnapshotHash };
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

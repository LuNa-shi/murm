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
  constructor(database = ':memory:', { trustedActorPrefixes = TRUSTED_ACTOR_PREFIXES, taskService = null, logger = null } = {}) {
    this.db = database instanceof DatabaseSync ? database : new DatabaseSync(database);
    this.db.exec(CONTEXT_SCHEMA_SQL);
    this.trustedActorPrefixes = trustedActorPrefixes;
    this.taskService = taskService;
    this.logger = logger;
  }

  close() {
    this.db.close();
  }

  dispatch(operation, payload = {}, envelope) {
    this.logger?.append({ event: 'dispatch.start', service: 'context', operation, envelope });
    try {
      const executionWrite = operation === 'publish_material' && envelope?.execution_id !== null;
      validateEnvelope(envelope, { executionWrite });
      const result = operation === 'read_materials' ? this.#readMaterials(payload) : this.#transaction(() => {
        const fingerprint = operationPayload(operation, payload, envelope);
        const replay = this.#replay(envelope.operation_id, fingerprint);
        if (replay) return replay;
        let value;
        if (operation === 'publish_material') value = this.#publishMaterial(payload, envelope);
        else throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unsupported Context Service operation: ${operation}`);
        this.#saveOperation(envelope.operation_id, operation, fingerprint, value);
        return value;
      });
      this.logger?.append({ event: 'dispatch.complete', service: 'context', operation, ok: true, result });
      return result;
    } catch (error) {
      this.logger?.append({ event: 'dispatch.complete', service: 'context', operation, ok: false, error: { name: error.name, code: error.code, message: error.message } });
      throw error;
    }
  }

  getMaterial(materialId) {
    return cloneMaterial(this.db.prepare('SELECT * FROM materials WHERE material_id = ?').get(materialId));
  }

  readMaterials(filters = {}) {
    return this.#readMaterials(filters);
  }

  // Task Flow uses this while its SQLite transaction is open so a steer
  // Material and the corresponding Execution update commit together.
  publishMaterialForTask(payload, envelope) {
    validateEnvelope(envelope, { executionWrite: true });
    return this.#publishMaterial(payload, envelope);
  }

  #readMaterials(filters = {}) {
    const materialId = filters.material_id ?? filters.materialId ?? null;
    const kind = filters.kind ?? null;
    const scope = filters.scope ?? null;
    const sourceTask = filters.source_task ?? filters.sourceTask ?? null;
    const sourceExecution = filters.source_execution ?? filters.sourceExecution ?? null;
    return this.db.prepare(`SELECT * FROM materials
      WHERE (? IS NULL OR material_id = ?)
        AND (? IS NULL OR kind = ?)
        AND (? IS NULL OR scope = ?)
        AND (? IS NULL OR source_task = ?)
        AND (? IS NULL OR source_execution = ?)
      ORDER BY created_at, material_id`)
      .all(materialId, materialId, kind, kind, scope, scope, sourceTask, sourceTask, sourceExecution, sourceExecution)
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

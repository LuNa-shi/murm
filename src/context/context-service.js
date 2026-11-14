import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ERROR_CODES, SwarmEnvError } from '../errors.js';
import { operationPayload, stableStringify, validateEnvelope } from '../protocol/envelope.js';
import { CONTEXT_SCHEMA_SQL } from '../storage/context-schema.js';

const EVIDENCE_STATES = new Set(['proposed', 'observed', 'checked', 'accepted', 'rejected', 'stale']);
const CONSUMPTION_ACTIONS = new Set(['route', 'task', 'workspace', 'integration']);
const MATERIAL_ROLES = new Set(['input', 'response', 'handoff', 'experience']);
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
  return {
    ...row,
    // `role` was added after the first Context schema.  Keep reads from old
    // databases deterministic while the constructor migration catches up.
    role: row.role ?? 'experience',
    // Stable semantic aliases.  The SQLite schema retains the historical
    // source_* column names, while the public Material contract names the
    // immutable producer identity explicitly.
    producer_task_id: row.source_task ?? null,
    producer_execution_id: row.source_execution ?? null,
    content: parse(row.content_json),
    provenance: parse(row.provenance_json),
    evidence: parse(row.evidence_json) ?? [],
  };
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
    const materialColumns = new Set(this.db.prepare('PRAGMA table_info(materials)').all().map((column) => column.name));
    if (!materialColumns.has('role')) {
      this.db.exec("ALTER TABLE materials ADD COLUMN role TEXT NOT NULL DEFAULT 'experience'");
    }
    if (!materialColumns.has('mission_id')) {
      this.db.exec('ALTER TABLE materials ADD COLUMN mission_id TEXT');
    }
    if (!materialColumns.has('evidence_json')) {
      this.db.exec("ALTER TABLE materials ADD COLUMN evidence_json TEXT NOT NULL DEFAULT '[]'");
    }
    this.trustedActorPrefixes = trustedActorPrefixes;
    this.taskService = taskService;
    this.logger = logger;
  }

  close() {
    this.db.close();
  }

  dispatch(operation, payload = {}, envelope) {
    const normalizedOperation = {
      'context.publish_material': 'publish_material',
      context_publish_material: 'publish_material',
      'context.search_materials': 'search_materials',
      context_search_materials: 'search_materials',
      'context.get_material': 'get_material',
      context_get_material: 'get_material',
      'context.read_materials': 'read_materials',
      context_read_materials: 'read_materials',
      'material.publish': 'publish_material',
      material_publish: 'publish_material',
      'material.read': 'read_materials',
      material_read: 'read_materials',
      'material.search': 'search_materials',
      material_search: 'search_materials',
      'material.get': 'get_material',
      material_get: 'get_material',
      material_dispute: 'dispute_material',
      'material.dispute': 'dispute_material',
      material_supersede: 'supersede_material',
      'material.supersede': 'supersede_material',
      material_unsupersede: 'unsupersede_material',
      'material.unsupersede': 'unsupersede_material',
      material_relations: 'list_material_relations',
      'material.relations': 'list_material_relations',
    }[operation] ?? operation;
    const normalizedPayload = normalizedOperation === 'publish_material' &&
      (operation === 'context.publish_material' || operation === 'context_publish_material')
      ? {
        ...payload,
        kind: payload.kind ?? (payload.role === 'experience' ? 'experience' : payload.role === 'handoff' ? 'failure' : 'fact'),
        scope: payload.scope ?? 'mission',
        evidence_state: payload.evidence_state ?? 'proposed',
      }
      : payload;
    this.logger?.append({ event: 'dispatch.start', service: 'context', operation: normalizedOperation, requested_operation: operation, envelope });
    try {
      const executionWrite = ['publish_material', 'consume_materials', 'dispute_material', 'supersede_material', 'unsupersede_material'].includes(normalizedOperation) && envelope?.execution_id !== null;
      validateEnvelope(envelope, { executionWrite });
      let replayed = false;
      const result = normalizedOperation === 'read_materials' || normalizedOperation === 'search_materials'
        ? this.#readMaterials(payload)
        : normalizedOperation === 'list_material_relations'
          ? this.listMaterialRelations(payload)
        : normalizedOperation === 'get_material'
          ? { material: this.getMaterial(requireString(payload.material_id ?? payload.materialId, 'material_id')) }
        : normalizedOperation === 'list_material_consumptions'
          ? this.listMaterialConsumptions(payload)
        : this.#transaction(() => {
        const fingerprint = operationPayload(normalizedOperation, normalizedPayload, envelope);
        const replay = this.#replay(envelope.operation_id, fingerprint);
        if (replay) {
          replayed = true;
          return replay;
        }
        let value;
        if (normalizedOperation === 'publish_material') value = this.#publishMaterial(normalizedPayload, envelope);
        else if (normalizedOperation === 'consume_materials') value = this.#consumeMaterials(normalizedPayload, envelope);
        else if (normalizedOperation === 'dispute_material') value = this.#disputeMaterial(normalizedPayload, envelope);
        else if (normalizedOperation === 'supersede_material') value = this.#supersedeMaterial(normalizedPayload, envelope);
        else if (normalizedOperation === 'unsupersede_material') value = this.#unsupersedeMaterial(normalizedPayload, envelope);
        else throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unsupported Context Service operation: ${operation}`);
        this.#saveOperation(envelope.operation_id, normalizedOperation, fingerprint, value);
        return value;
      });
      if (normalizedOperation === 'publish_material' && !replayed) {
        this.taskService?.notifyDependencyEvent?.({
          kind: 'material_published',
          operation: normalizedOperation,
          task_id: result?.material?.source_task ?? null,
          execution_id: result?.material?.source_execution ?? null,
        });
      }
      this.logger?.append({ event: 'dispatch.complete', service: 'context', operation: normalizedOperation, requested_operation: operation, ok: true, result });
      return result;
    } catch (error) {
      this.logger?.append({ event: 'dispatch.complete', service: 'context', operation: normalizedOperation, requested_operation: operation, ok: false, error: { name: error.name, code: error.code, message: error.message } });
      throw error;
    }
  }

  getMaterial(materialId) {
    return cloneMaterial(this.db.prepare('SELECT * FROM materials WHERE material_id = ?').get(materialId));
  }

  readMaterials(filters = {}) {
    return this.#readMaterials(filters);
  }

  /** Return durable Material consumption edges for Task completion and reports. */
  listMaterialConsumptions(filters = {}) {
    const materialId = filters.material_id ?? filters.materialId ?? null;
    const readerTask = filters.reader_task ?? filters.readerTask ?? null;
    const readerExecution = filters.reader_execution ?? filters.readerExecution ?? null;
    const action = filters.action ?? null;
    return this.db.prepare(`SELECT operation_id, material_id, reader_task, reader_execution, action, action_ref, created_at
      FROM material_consumptions
      WHERE (? IS NULL OR material_id = ?)
        AND (? IS NULL OR reader_task = ?)
        AND (? IS NULL OR reader_execution = ?)
        AND (? IS NULL OR action = ?)
      ORDER BY created_at, operation_id, material_id`)
      .all(materialId, materialId, readerTask, readerTask, readerExecution, readerExecution, action, action)
      .map((row) => ({
        operation_id: row.operation_id,
        material_id: row.material_id,
        reader_task: row.reader_task,
        reader_execution: row.reader_execution,
        action: row.action,
        action_ref: row.action_ref,
        created_at: row.created_at,
      }));
  }

  listMaterialRelations(filters = {}) {
    const materialId = filters.material_id ?? filters.materialId ?? null;
    const includeInactive = filters.include_inactive === true || filters.includeInactive === true;
    return this.db.prepare(`SELECT * FROM material_relations
      WHERE (? IS NULL OR material_id = ? OR replacement_material_id = ?)
        AND (? = 1 OR active = 1)
      ORDER BY created_at, relation_id`)
      .all(materialId, materialId, materialId, includeInactive ? 1 : 0)
      .map((row) => this.#relationView(row));
  }

  // Task Flow uses this while its SQLite transaction is open so a steer
  // Material and the corresponding Execution update commit together.
  publishMaterialForTask(payload, envelope) {
    validateEnvelope(envelope, { executionWrite: true });
    return this.#publishMaterial(payload, envelope);
  }

  consumeMaterialsForTask(payload, envelope) {
    validateEnvelope(envelope, { executionWrite: true });
    return this.#consumeMaterials(payload, envelope);
  }

  #readMaterials(filters = {}) {
    const materialId = filters.material_id ?? filters.materialId ?? null;
    const kind = filters.kind ?? null;
    const scope = filters.scope ?? null;
    const explicitSourceTask = filters.source_task ?? filters.sourceTask ?? null;
    const taskId = filters.task_id ?? filters.taskId ?? null;
    // A standalone Context Service has no Task-link table, so task_id keeps
    // its useful producer lookup there. Once Task Service is attached,
    // task_id also includes Materials linked to that Task as input, response,
    // handoff, or experience while source_task remains producer-only.
    const sourceTask = explicitSourceTask ?? (this.taskService ? null : taskId);
    const sourceExecution = filters.source_execution ?? filters.sourceExecution ?? null;
    const role = filters.role ?? null;
    const query = filters.query ?? filters.search ?? null;
    if (role !== null && !MATERIAL_ROLES.has(role)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'role must be input, response, handoff, or experience');
    }
    if (query !== null && (typeof query !== 'string' || query.length === 0)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'query must be a non-empty string or null');
    }
    const missionId = filters.mission_id ?? filters.missionId ?? null;
    const includeHistory = filters.include_history === true || filters.includeHistory === true;
    let rows = this.db.prepare(`SELECT * FROM materials
      WHERE (? IS NULL OR material_id = ?)
        AND (? IS NULL OR kind = ?)
        AND (? IS NULL OR scope = ?)
        AND (? IS NULL OR source_task = ?)
        AND (? IS NULL OR source_execution = ?)
        AND (? IS NULL OR role = ?)
        AND (? IS NULL OR mission_id = ?)
        AND (? IS NULL OR content_json LIKE '%' || ? || '%' OR provenance_json LIKE '%' || ? || '%')
      ORDER BY created_at, material_id`)
      .all(materialId, materialId, kind, kind, scope, scope, sourceTask, sourceTask, sourceExecution, sourceExecution,
        role, role, missionId, missionId, query, query, query);
    if (!includeHistory) {
      const hidden = new Set(this.db.prepare(`SELECT material_id FROM material_relations
        WHERE relation_kind = 'supersede' AND active = 1`).all().map((row) => row.material_id));
      rows = rows.filter((row) => !hidden.has(row.material_id));
    }
    if (taskId !== null && this.taskService && explicitSourceTask === null) {
      const linkedMaterialIds = new Set(this.taskService.listTaskMaterialIds?.(taskId) ?? []);
      rows = rows.filter((row) => row.source_task === taskId || linkedMaterialIds.has(row.material_id));
    }
    // Mission is represented by Task Service rather than duplicated into
    // Context rows.  The optional Task filter above joins producer and
    // consumer links without giving Context Service Task authority.
    return rows.map(cloneMaterial);
  }

  #consumeMaterials(payload, envelope) {
    this.#assertExecutionFence(envelope);
    if (!envelope.task_id || !envelope.execution_id) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'consume_materials requires a bound Task and Execution');
    }
    const materialIds = payload.material_ids ?? payload.materialIds;
    if (!Array.isArray(materialIds) || materialIds.length === 0 || materialIds.length > 100 || materialIds.some((id) => typeof id !== 'string' || id.length === 0)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'material_ids must contain between 1 and 100 Material IDs');
    }
    const uniqueMaterialIds = [...new Set(materialIds)];
    if (uniqueMaterialIds.length !== materialIds.length) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'material_ids must not contain duplicates');
    }
    const action = payload.action;
    if (!CONSUMPTION_ACTIONS.has(action)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'action must be route, task, workspace, or integration');
    }
    if (payload.action_ref !== undefined && payload.action_ref !== null && (typeof payload.action_ref !== 'string' || payload.action_ref.length === 0)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'action_ref must be a non-empty string or null');
    }
    const missing = uniqueMaterialIds.filter((materialId) => !this.getMaterial(materialId));
    if (missing.length > 0) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown Material IDs: ${missing.join(',')}`);
    }
    const createdAt = now();
    const statement = this.db.prepare(`INSERT OR IGNORE INTO material_consumptions
      (operation_id, material_id, reader_task, reader_execution, action, action_ref, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const materialId of uniqueMaterialIds) {
      statement.run(envelope.operation_id, materialId, envelope.task_id, envelope.execution_id, action, payload.action_ref ?? null, createdAt);
    }
    return {
      consumptions: this.listMaterialConsumptions({ reader_execution: envelope.execution_id, action })
        .filter((row) => row.operation_id === envelope.operation_id && uniqueMaterialIds.includes(row.material_id)),
      material_ids: uniqueMaterialIds,
      action,
      action_ref: payload.action_ref ?? null,
    };
  }

  #publishMaterial(payload, envelope) {
    this.#assertExecutionFence(envelope);
    rejectSecrets(payload);
    for (const field of ['kind', 'scope']) requireString(payload[field], field);
    const role = payload.role ?? 'experience';
    if (!MATERIAL_ROLES.has(role)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'role must be input, response, handoff, or experience');
    }
    if (!EVIDENCE_STATES.has(payload.evidence_state ?? 'proposed')) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'unsupported evidence_state');
    }
    if (payload.content === undefined) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'material content is required');
    const evidence = payload.evidence ?? [];
    if (!Array.isArray(evidence) || evidence.some((claim) => !claim || typeof claim !== 'object' || Array.isArray(claim) || typeof claim.claim !== 'string' || claim.claim.length === 0 || (claim.explanation !== undefined && typeof claim.explanation !== 'string'))) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'evidence must contain claim-scoped {claim, explanation} records');
    }
    const provenance = payload.provenance ? { ...payload.provenance } : { actor_ref: envelope.actor_ref };
    provenance.role ??= role;
    const boundMissionId = envelope.task_id && typeof this.taskService?.getTask === 'function'
      ? this.taskService.getTask(envelope.task_id)?.mission_id ?? null
      : null;
    const requestedMissionId = payload.mission_id ?? payload.missionId ?? null;
    if (boundMissionId && requestedMissionId && requestedMissionId !== boundMissionId) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Material mission_id must match the current Task Mission', {
        current_mission_id: boundMissionId,
        requested_mission_id: requestedMissionId,
      });
    }
    const missionId = requestedMissionId ?? boundMissionId;
    if (missionId !== null) {
      requireString(missionId, 'mission_id');
      provenance.mission_id ??= missionId;
    }
    if (payload.scope === 'root_integration') {
      const consumedIds = provenance?.consumed_material_ids;
      if (!Array.isArray(consumedIds) || consumedIds.length === 0 || consumedIds.length > 100 || consumedIds.some((id) => typeof id !== 'string' || id.length === 0)) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'root_integration provenance must include 1 to 100 consumed_material_ids');
      }
      const uniqueConsumedIds = [...new Set(consumedIds)];
      if (uniqueConsumedIds.length !== consumedIds.length) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'root_integration consumed_material_ids must not contain duplicates');
      }
      const consumed = new Set(this.listMaterialConsumptions({ reader_task: envelope.task_id, reader_execution: envelope.execution_id, action: 'integration' }).map((row) => row.material_id));
      const missingConsumed = uniqueConsumedIds.filter((materialId) => !consumed.has(materialId));
      if (missingConsumed.length > 0) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `root_integration Material IDs were not durably consumed: ${missingConsumed.join(',')}`);
      }
      provenance.consumed_material_ids = uniqueConsumedIds;
    }
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
      role,
      mission_id: missionId,
      content_ref: payload.content_ref ?? `sqlite://material/${materialId}`,
      content_hash: contentHash,
      content: payload.content,
      version,
      source_task: envelope.task_id,
      source_execution: envelope.execution_id,
      provenance,
      evidence,
      supersedes,
      created_at: now(),
    };
    const existing = this.getMaterial(materialId);
    if (existing) {
      if (existing.content_hash !== contentHash || existing.kind !== material.kind || existing.role !== material.role || existing.mission_id !== material.mission_id || existing.scope !== material.scope || existing.supersedes !== material.supersedes) {
        throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'material_id already contains a different immutable record');
      }
      return { material: existing };
    }
    this.db.prepare(`INSERT INTO materials (
      material_id, kind, role, mission_id, scope, evidence_state, content_ref, content_hash, content_json, version,
      source_task, source_execution, provenance_json, supersedes, evidence_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(material.material_id, material.kind, material.role, material.mission_id, material.scope, material.evidence_state, material.content_ref, material.content_hash,
        json(material.content), material.version, material.source_task, material.source_execution, json(material.provenance), material.supersedes, json(material.evidence), material.created_at);
    if (supersedes) {
      this.#insertRelation({ materialId: supersedes, replacementMaterialId: materialId, relationKind: 'supersede', envelope, reason: payload.supersede_reason ?? null });
    }
    return { material: cloneMaterial(this.db.prepare('SELECT * FROM materials WHERE material_id = ?').get(materialId)) };
  }

  #insertRelation({ materialId, replacementMaterialId = null, relationKind, envelope, reason = null }) {
    const existing = this.db.prepare(`SELECT * FROM material_relations
      WHERE material_id = ? AND replacement_material_id IS ? AND relation_kind = ? AND active = 1
      ORDER BY version DESC LIMIT 1`).get(materialId, replacementMaterialId, relationKind);
    if (existing) return existing;
    const previous = this.db.prepare(`SELECT COALESCE(MAX(version), 0) AS version FROM material_relations
      WHERE material_id = ? AND relation_kind = ?`).get(materialId, relationKind);
    const relation = {
      relation_id: randomUUID(), material_id: materialId, replacement_material_id: replacementMaterialId,
      relation_kind: relationKind, active: 1, reason, actor_ref: envelope.actor_ref,
      source_task: envelope.task_id ?? null, source_execution: envelope.execution_id ?? null,
      version: Number(previous?.version ?? 0) + 1, created_at: now(),
    };
    this.db.prepare(`INSERT INTO material_relations
      (relation_id, material_id, replacement_material_id, relation_kind, active, reason,
       actor_ref, source_task, source_execution, version, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      relation.relation_id, relation.material_id, relation.replacement_material_id,
      relation.relation_kind, relation.active, relation.reason, relation.actor_ref,
      relation.source_task, relation.source_execution, relation.version, relation.created_at,
    );
    return relation;
  }

  #relationView(row) {
    return row ? {
      relation_id: row.relation_id,
      material_id: row.material_id,
      replacement_material_id: row.replacement_material_id,
      relation_kind: row.relation_kind,
      active: Boolean(row.active),
      reason: row.reason,
      actor_ref: row.actor_ref,
      source_task: row.source_task,
      source_execution: row.source_execution,
      version: row.version,
      created_at: row.created_at,
    } : null;
  }

  #disputeMaterial(payload, envelope) {
    this.#assertExecutionFence(envelope);
    const materialId = requireString(payload.material_id ?? payload.materialId, 'material_id');
    const material = this.getMaterial(materialId);
    if (!material) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown Material: ${materialId}`);
    const relation = this.#insertRelation({
      materialId,
      relationKind: 'dispute',
      envelope,
      reason: requireString(payload.reason, 'reason'),
    });
    return { material, relation: this.#relationView(relation) };
  }

  #supersedeMaterial(payload, envelope) {
    this.#assertExecutionFence(envelope);
    const materialId = requireString(payload.material_id ?? payload.materialId, 'material_id');
    const replacementMaterialId = requireString(payload.replacement_material_id ?? payload.replacementMaterialId, 'replacement_material_id');
    if (materialId === replacementMaterialId) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'a Material cannot supersede itself');
    if (!this.getMaterial(materialId) || !this.getMaterial(replacementMaterialId)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'supersede relation requires both Materials');
    const relation = this.#insertRelation({ materialId, replacementMaterialId, relationKind: 'supersede', envelope, reason: payload.reason ?? null });
    return { material: this.getMaterial(materialId), replacement: this.getMaterial(replacementMaterialId), relation: this.#relationView(relation) };
  }

  #unsupersedeMaterial(payload, envelope) {
    this.#assertExecutionFence(envelope);
    const materialId = requireString(payload.material_id ?? payload.materialId, 'material_id');
    const replacementMaterialId = requireString(payload.replacement_material_id ?? payload.replacementMaterialId, 'replacement_material_id');
    const current = this.db.prepare(`SELECT * FROM material_relations
      WHERE material_id = ? AND replacement_material_id = ? AND relation_kind = 'supersede' AND active = 1
      ORDER BY version DESC LIMIT 1`).get(materialId, replacementMaterialId);
    if (!current) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'matching active supersede relation was not found');
    const trusted = this.trustedActorPrefixes.some((prefix) => envelope.actor_ref.startsWith(prefix));
    const sourceOwned = current.source_execution && current.source_execution === envelope.execution_id;
    if (!trusted && !sourceOwned) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'unsupersede requires the relation owner or a trusted actor');
    const expectedVersion = payload.expected_version ?? payload.expectedVersion ?? current.version;
    if (Number(expectedVersion) !== current.version) throw new SwarmEnvError(ERROR_CODES.STALE_VERSION, 'supersede relation version is stale', { expected: current.version, received: expectedVersion });
    const result = this.db.prepare(`UPDATE material_relations SET active = 0
      WHERE relation_id = ? AND active = 1 AND version = ?`).run(current.relation_id, current.version);
    if (result.changes !== 1) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'supersede relation changed concurrently');
    return { material: this.getMaterial(materialId), replacement: this.getMaterial(replacementMaterialId), relation: this.#relationView({ ...current, active: 0 }) };
  }

  #assertExecutionFence(envelope) {
    this.taskService?.assertBotDeadline?.(envelope.actor_ref);
    if (!this.taskService || envelope.execution_id === null) return;
    const execution = this.taskService.getExecution(envelope.execution_id);
    if (!execution) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'material source execution does not exist');
    if (execution.task_id !== envelope.task_id) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'material source task does not match execution');
    if (execution.spec_version !== envelope.spec_version) throw new SwarmEnvError(ERROR_CODES.STALE_VERSION, 'material source spec_version is stale');
    if (execution.fencing_version !== envelope.fencing_version) throw new SwarmEnvError(ERROR_CODES.FENCED, 'material source fencing_version is stale', { expected: execution.fencing_version });
    if (execution.state_version !== envelope.state_version) throw new SwarmEnvError(ERROR_CODES.STALE_VERSION, 'material source state_version is stale', { expected: execution.state_version });
    if (!['CREATED', 'RUNNING'].includes(execution.state)) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Material contributions require an active Execution');
    if (execution.owner_ref !== envelope.actor_ref) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Material contributions require the Execution owner');
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

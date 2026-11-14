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

function normalizeAttachments(input = [], readExisting) {
  if (!Array.isArray(input) || input.length > 16) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'attachments must contain at most 16 entries');
  let total = 0;
  const names = new Set();
  return input.map(item => {
    const { name, content_base64: encoded, content_hash: expected, media_type: suppliedType, source } = item ?? {};
    if (typeof name !== 'string' || !name.trim() || name.length > 128 || /[\/\\\x00-\x1f]/.test(name) || ['.', '..'].includes(name) || names.has(name)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'attachments require distinct names without path components');
    }
    names.add(name);
    if (source !== undefined && (encoded !== undefined || !readExisting || typeof source?.material_id !== 'string' ||
        typeof source?.attachment_name !== 'string' || typeof expected !== 'string')) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Reference attachments require a source Material ID, attachment name and content_hash');
    }
    const prior = source === undefined ? null : readExisting(source);
    const mediaType = suppliedType ?? prior?.media_type ?? 'application/octet-stream';
    if ((!prior && (typeof encoded !== 'string' || encoded.length > 350_000)) || typeof mediaType !== 'string' ||
        !/^[\w.+-]+\/[\w.+-]+$/.test(mediaType) || mediaType.length > 100) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'attachment must include bounded base64 bytes and a valid media_type');
    }
    const bytes = prior ? Buffer.from(prior.bytes) : Buffer.from(encoded, 'base64');
    total += bytes.length;
    if ((!prior && bytes.toString('base64') !== encoded) || total > 256 * 1024) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'attachments must use canonical base64 totaling at most 256 KiB');
    }
    const contentHash = createHash('sha256').update(bytes).digest('hex');
    if ((expected !== undefined && expected !== contentHash) || (prior && prior.content_hash !== contentHash)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'attachment content_hash does not match bytes');
    }
    return { name, media_type: mediaType, content_hash: contentHash, bytes };
  }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

function boundedText(value, fallback, max, field) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `${field} must be a non-empty string of at most ${max} characters`);
  }
  return value.trim();
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
    const busyTimeout = this.db.prepare('PRAGMA busy_timeout').get().timeout;
    this.db.exec(`PRAGMA busy_timeout = ${Math.max(busyTimeout, 1000)}`);
    try {
      this.db.exec('BEGIN IMMEDIATE');
      try {
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
        if (!materialColumns.has('producer_bot_id')) this.db.exec('ALTER TABLE materials ADD COLUMN producer_bot_id TEXT');
        for (const column of ['title', 'summary', 'media_type']) {
          if (!materialColumns.has(column)) this.db.exec(`ALTER TABLE materials ADD COLUMN ${column} TEXT`);
        }
        const consumptionColumns = new Set(this.db.prepare('PRAGMA table_info(material_consumptions)').all().map(column => column.name));
        for (const [column, type] of [['material_version', 'INTEGER'], ['content_hash', 'TEXT'], ['impact', 'TEXT']]) {
          if (!consumptionColumns.has(column)) this.db.exec(`ALTER TABLE material_consumptions ADD COLUMN ${column} ${type}`);
        }
        const relationColumns = new Set(this.db.prepare('PRAGMA table_info(material_relations)').all().map(column => column.name));
        if (!relationColumns.has('claim')) this.db.exec('ALTER TABLE material_relations ADD COLUMN claim TEXT');
        // Preserve ambiguous historical forks. Never select a winner or erase a
        // relation during migration; exact reads expose all successors.
        this.db.exec(`INSERT OR IGNORE INTO material_relation_heads (material_id, version)
          SELECT material_id, MAX(version) + SUM(CASE WHEN active = 0 THEN 1 ELSE 0 END)
          FROM material_relations WHERE relation_kind = 'supersede' GROUP BY material_id`);
        this.db.exec('COMMIT');
      } catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw error; }
    } finally { this.db.exec(`PRAGMA busy_timeout = ${busyTimeout}`); }
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
      if (typeof this.taskService?.materialScope !== 'function') throw new SwarmEnvError(ERROR_CODES.SERVICE_NOT_READY, 'Material requests require Task-owned Mission authority');
      const executionWrite = ['publish_material', 'consume_materials', 'dispute_material', 'supersede_material', 'unsupersede_material'].includes(normalizedOperation) && envelope?.execution_id !== null;
      validateEnvelope(envelope, { executionWrite });
      const modern = Boolean(this.taskService.getBot?.(envelope.actor_ref));
      const read = ['read_materials', 'search_materials', 'list_material_relations', 'get_material', 'list_material_consumptions'].includes(normalizedOperation);
      let replayed = false;
      const result = read ? this.#readSnapshot(() => {
        const scopedPayload = this.#scopeRead(payload, envelope);
        if (normalizedOperation === 'read_materials' || normalizedOperation === 'search_materials') {
          return modern ? this.#readMaterialPage(scopedPayload) : this.#readMaterials(scopedPayload);
        }
        if (normalizedOperation === 'list_material_relations') return this.listMaterialRelations(scopedPayload);
        if (normalizedOperation === 'get_material') {
          const view = this.#materialView(scopedPayload);
          return modern && view.material ? { ...view, material: this.#publicMaterial(view.material),
            usage: this.#materialUsagePage(view.material, scopedPayload) } : view;
        }
        return this.listMaterialConsumptions(scopedPayload);
      }) : this.#lifecycleTransaction(() => {
        const originalFingerprint = operationPayload(normalizedOperation, normalizedPayload, envelope);
        const fingerprint = operationPayload(normalizedOperation, normalizedPayload,
          this.taskService?.getBot?.(envelope.actor_ref) ? { ...envelope, state_version: null } : envelope);
        const replay = this.#replay(envelope.operation_id, fingerprint, originalFingerprint);
        if (replay) {
          replayed = true;
          return replay;
        }
        let value;
        if (normalizedOperation === 'publish_material') value = this.#publishMaterial(normalizedPayload, envelope, { modern });
        else if (normalizedOperation === 'consume_materials') value = this.#consumeMaterials(normalizedPayload, envelope);
        else if (normalizedOperation === 'dispute_material') value = this.#disputeMaterial(normalizedPayload, envelope);
        else if (normalizedOperation === 'supersede_material') value = this.#supersedeMaterial(normalizedPayload, envelope);
        else if (normalizedOperation === 'unsupersede_material') value = this.#unsupersedeMaterial(normalizedPayload, envelope);
        else throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unsupported Context Service operation: ${operation}`);
        if (modern && value.relation) {
          value = { ...value, material: this.#publicMaterial(value.material),
            ...(value.replacement ? { replacement: this.#publicMaterial(value.replacement) } : {}) };
        }
        if (modern) {
          if (normalizedOperation === 'unsupersede_material' && !envelope.execution_id) this.#assertCorrectionCoordinator(envelope);
          else this.#assertExecutionFence(envelope);
        }
        this.#saveOperation(envelope.operation_id, normalizedOperation, fingerprint, value);
        return value;
      });
      if (['publish_material', 'dispute_material', 'supersede_material', 'unsupersede_material'].includes(normalizedOperation) && !replayed) {
        this.taskService?.notifyDependencyEvent?.({
          kind: normalizedOperation === 'publish_material' ? 'material_published' : 'material_corrected',
          operation: normalizedOperation,
          task_id: result?.material?.producer_task_id ?? result?.material?.source_task ?? null,
          execution_id: result?.material?.producer_execution_id ?? result?.material?.source_execution ?? null,
        });
      }
      this.logger?.append({ event: 'dispatch.complete', service: 'context', operation: normalizedOperation, requested_operation: operation, ok: true, result });
      return result;
    } catch (error) {
      this.logger?.append({ event: 'dispatch.complete', service: 'context', operation: normalizedOperation, requested_operation: operation, ok: false, error: { name: error.name, code: error.code, message: error.message } });
      throw error;
    }
  }

  getMaterial(materialId, { verifyIntegrity = false } = {}) {
    const material = cloneMaterial(this.db.prepare(`SELECT material.*, COALESCE(head.version, 0) AS relation_version
      FROM materials material LEFT JOIN material_relation_heads head USING (material_id) WHERE material.material_id = ?`).get(materialId));
    if (material && verifyIntegrity) this.#assertReadableContent(material);
    return material;
  }

  readMaterials(filters = {}) {
    return this.#readSnapshot(() => this.#readMaterials(filters));
  }

  /** Durable public-state observation for discovery; no heartbeat/read counts. */
  publicChangeToken(missionId) {
    requireString(missionId, 'mission_id');
    return this.db.prepare(`SELECT
      (SELECT COUNT(*) FROM materials WHERE mission_id = ?) AS materials,
      (SELECT COUNT(*) FROM material_relations relation JOIN materials m ON m.material_id = relation.material_id WHERE m.mission_id = ?) AS relations,
      (SELECT COALESCE(SUM(relation.active), 0) FROM material_relations relation JOIN materials m ON m.material_id = relation.material_id WHERE m.mission_id = ?) AS active_relations`).get(missionId, missionId, missionId);
  }

  /** Return durable Material consumption edges for Task completion and reports. */
  listMaterialConsumptions(filters = {}) {
    const materialId = filters.material_id ?? filters.materialId ?? null;
    const readerTask = filters.reader_task ?? filters.readerTask ?? null;
    const readerExecution = filters.reader_execution ?? filters.readerExecution ?? null;
    const action = filters.action ?? null;
    return this.db.prepare(`SELECT operation_id, material_id, reader_task, reader_execution, action, action_ref, material_version, content_hash, impact, created_at
      FROM material_consumptions
      WHERE (? IS NULL OR material_id = ?)
        AND (? IS NULL OR material_id IN (SELECT material_id FROM materials WHERE mission_id = ?))
        AND (? IS NULL OR reader_task = ?)
        AND (? IS NULL OR reader_execution = ?)
        AND (? IS NULL OR action = ?)
      ORDER BY created_at, operation_id, material_id`)
      .all(materialId, materialId, filters.mission_id ?? null, filters.mission_id ?? null, readerTask, readerTask, readerExecution, readerExecution, action, action)
      .filter(row => !filters.mission_id || this.taskService?.materialOriginMission?.(row.reader_task, row.reader_execution) === filters.mission_id)
      .filter(row => !filters.mission_id || this.#materialInScope(this.getMaterial(row.material_id), filters))
      .map((row) => ({
        operation_id: row.operation_id,
        material_id: row.material_id,
        reader_task: row.reader_task,
        reader_execution: row.reader_execution,
        action: row.action,
        action_ref: row.action_ref,
        ...(row.material_version !== null ? { material_version: row.material_version, content_hash: row.content_hash, impact: row.impact } : {}),
        created_at: row.created_at,
      }));
  }

  readTakeMaterialInputs({ missionId, materialIds }) {
    if (!Array.isArray(materialIds) || materialIds.length > 100 ||
        new Set(materialIds).size !== materialIds.length || materialIds.some(id => typeof id !== 'string' || !id)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Task input Materials must contain at most 100 distinct IDs');
    }
    return this.#readSnapshot(() => materialIds.map(materialId => {
      const material = this.getMaterial(materialId);
      if (!this.#materialInScope(material, { mission_id: missionId })) {
        throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Task input Material is not readable in this Mission');
      }
      this.#assertReadableContent(material);
      return { material_id: materialId, version: material.version, content_hash: material.content_hash };
    }));
  }

  readWorkspaceMaterialUses({ missionId, taskId, executionId, materialIds }) {
    const find = this.db.prepare(`SELECT operation_id, material_id, material_version, content_hash, impact
      FROM material_consumptions WHERE reader_task = ? AND reader_execution = ?
        AND material_id = ? AND action = 'workspace' AND material_version IS NOT NULL
        AND content_hash IS NOT NULL AND impact IS NOT NULL AND length(trim(impact)) > 0
      ORDER BY created_at DESC, operation_id DESC LIMIT 1`);
    return materialIds.map(materialId => {
      const material = this.getMaterial(materialId);
      const use = this.#materialInScope(material, { mission_id: missionId }) && find.get(taskId, executionId, materialId);
      if (!use || use.material_version !== material.version || use.content_hash !== material.content_hash) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Workspace Material must have a recorded use in this Execution');
      }
      return { material_id: use.material_id, version: use.material_version, content_hash: use.content_hash,
        operation_id: use.operation_id, impact: use.impact };
    });
  }

  listMaterialRelations(filters = {}) {
    const materialId = filters.material_id ?? filters.materialId ?? null;
    const includeInactive = filters.include_inactive === true || filters.includeInactive === true;
    return this.db.prepare(`SELECT * FROM material_relations
      WHERE (? IS NULL OR material_id = ? OR replacement_material_id = ?)
        AND (? IS NULL OR material_id IN (SELECT material_id FROM materials WHERE mission_id = ?))
        AND (? IS NULL OR replacement_material_id IS NULL OR replacement_material_id IN (SELECT material_id FROM materials WHERE mission_id = ?))
        AND (? = 1 OR active = 1)
      ORDER BY created_at, relation_id`)
      .all(materialId, materialId, materialId, filters.mission_id ?? null, filters.mission_id ?? null, filters.mission_id ?? null, filters.mission_id ?? null, includeInactive ? 1 : 0)
      .filter(row => !filters.mission_id || this.#relationInScope(row, filters))
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

  #publicMaterial(material, { summaryOnly = false } = {}) {
    const { material_id, mission_id, source_task, source_execution, producer_bot_id, content_hash,
      version, relation_version, created_at } = material;
    const preview = typeof material.content === 'string' ? material.content : stableStringify(material.content);
    const selected = {
      material_id, mission_id, producer_task_id: source_task, producer_execution_id: source_execution, producer_bot_id,
      content_hash, version, relation_version, created_at, title: material.title ?? preview?.trim().slice(0, 120) ?? material_id,
      summary: material.summary ?? preview?.trim().slice(0, 500) ?? '',
      media_type: material.media_type ?? (typeof material.content === 'string' ? 'text/markdown' : 'application/json'),
      attachments: this.db.prepare('SELECT name, media_type, content_hash, length(bytes) AS size_bytes FROM material_attachments WHERE material_id = ? ORDER BY name').all(material_id).map(row => ({ ...row })),
    };
    return summaryOnly ? selected : { ...selected, content: material.content, provenance: {
      mission_id, task_id: source_task, execution_id: source_execution, bot_id: producer_bot_id,
      actor_ref: material.provenance?.actor_ref ?? null, used_materials: material.provenance?.used_materials ?? [],
    } };
  }

  #readMaterialPage(filters) {
    const missionId = filters.mission_id;
    const materialId = filters.material_id ?? filters.materialId ?? null;
    const taskId = filters.task_id ?? filters.taskId ?? null;
    const sourceTask = filters.source_task ?? filters.sourceTask ?? null;
    const sourceExecution = filters.source_execution ?? filters.sourceExecution ?? null;
    const relationKind = filters.relation_kind ?? null;
    const relatedId = filters.related_material_id ?? null;
    const query = filters.query ?? filters.search ?? null;
    const history = filters.include_history === true || filters.includeHistory === true;
    const limit = filters.limit ?? 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 ||
        (relationKind !== null && !['supersede', 'dispute'].includes(relationKind)) ||
        [materialId, taskId, sourceTask, sourceExecution, query, relatedId].some(value => value !== null && (typeof value !== 'string' || !value || value.length > 1000))) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Invalid Material page filters');
    }
    const scope = { mission_id: missionId, material_id: materialId, task_id: taskId,
      source_task: sourceTask, source_execution: sourceExecution, query, include_history: history,
      relation_kind: relationKind, related_material_id: relatedId };
    const fingerprint = sha256(scope);
    let after = 0;
    let offset = 0;
    let ceiling = this.db.prepare('SELECT COALESCE(MAX(rowid), 0) AS ceiling FROM materials WHERE mission_id = ?').get(missionId).ceiling;
    if (filters.cursor !== undefined) {
      try {
        if (typeof filters.cursor !== 'string' || filters.cursor.length > 2048) throw new Error();
        const cursor = JSON.parse(Buffer.from(filters.cursor, 'base64url').toString());
        if (cursor.fingerprint !== fingerprint || !Number.isSafeInteger(cursor.after) || !Number.isSafeInteger(cursor.ceiling) ||
            !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > 499 ||
            cursor.after < 0 || cursor.ceiling < cursor.after || cursor.ceiling > ceiling) throw new Error();
        ({ after, ceiling, offset } = cursor);
      } catch { throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Material cursor does not match this query'); }
    }
    const rows = this.db.prepare(`WITH window AS MATERIALIZED (
      SELECT rowid AS sequence, material_id, mission_id, source_task, source_execution, producer_bot_id,
        title, summary, media_type, content_hash, version, created_at, content_json
      FROM materials WHERE mission_id = ? AND rowid > ? AND rowid <= ? ORDER BY rowid LIMIT 501
    ) SELECT sequence, material_id, mission_id, source_task, source_execution, producer_bot_id, title, summary,
      media_type, content_hash, version, created_at, substr(content_json, 1, 502) AS preview,
      CASE WHEN ? IS NULL THEN 1 WHEN instr(lower(title), lower(?)) > 0 THEN 3 WHEN instr(lower(summary), lower(?)) > 0 THEN 2
        WHEN instr(lower(content_json), lower(?)) > 0 THEN 1 ELSE 0 END AS relevance
      FROM window ORDER BY sequence`).all(missionId, after, ceiling, query, query, query, query);
    const materials = [];
    const window = rows.slice(0, 500).sort((a, b) => b.relevance - a.relevance || a.sequence - b.sequence);
    let scanned = offset;
    for (const row of window.slice(offset)) {
      scanned++;
      if ((materialId && row.material_id !== materialId) || (sourceTask && row.source_task !== sourceTask) ||
          (sourceExecution && row.source_execution !== sourceExecution) || !this.#materialInScope(row, { mission_id: missionId })) continue;
      if (taskId && row.source_task !== taskId && !this.taskService.hasTaskMaterial(taskId, row.material_id)) continue;
      if (!row.relevance) continue;
      const successors = this.#summaryRelations(row.material_id, missionId, 'supersede');
      if (!history && !materialId && successors.length) continue;
      const supersedes = this.#summaryRelations(row.material_id, missionId, 'supersede', { incoming: true });
      const disputes = this.#summaryRelations(row.material_id, missionId, 'dispute');
      if (relationKind === 'dispute' && (relatedId || !disputes.length)) continue;
      if (relationKind === 'supersede' || relatedId) {
        const matched = relatedId
          ? this.#summaryRelations(row.material_id, missionId, 'supersede', { otherId: relatedId }).length ||
            this.#summaryRelations(row.material_id, missionId, 'supersede', { otherId: relatedId, incoming: true }).length
          : successors.length || supersedes.length;
        if (!matched) continue;
      }
      const preview = row.preview?.startsWith('"') ? row.preview.slice(1).replace(/"$/, '') : row.preview;
      materials.push({ ...this.#publicMaterial({ ...row, content: preview, relation_version: this.#relationVersion(row.material_id) }, { summaryOnly: true }),
        disputed: disputes.length > 0, disputes: disputes.slice(0, 10), disputes_truncated: disputes.length > 10,
        active_successors: successors.slice(0, 10), supersedes: supersedes.slice(0, 10),
        supersedes_truncated: supersedes.length > 10 });
      if (materials.length === limit) break;
    }
    const more = scanned < window.length || rows.length > window.length;
    const next = scanned < window.length ? { after, offset: scanned } : { after: rows[window.length - 1]?.sequence ?? after, offset: 0 };
    return { materials, scope, limit, scanned: scanned - offset, returned: materials.length, truncated: more,
      order: query ? 'bounded-window-title-summary-content' : 'creation',
      next_cursor: more ? Buffer.from(JSON.stringify({ fingerprint, ceiling, ...next })).toString('base64url') : null };
  }

  #summaryRelations(materialId, missionId, kind, { incoming = false, otherId = null } = {}) {
    const [endpoint, other] = incoming ? ['replacement_material_id', 'material_id'] : ['material_id', 'replacement_material_id'];
    const page = this.db.prepare(`SELECT rowid AS sequence, * FROM material_relations WHERE ${endpoint} = ? AND relation_kind = ?
      AND active = 1 ${otherId === null ? '' : `AND ${other} = ?`} AND rowid > ? ORDER BY rowid LIMIT 101`);
    const args = [materialId, kind, ...(otherId === null ? [] : [otherId])];
    const scope = { mission_id: missionId };
    const matches = [];
    let after = 0;
    while (matches.length < 11) {
      const rows = page.all(...args, after);
      for (const row of rows) {
        if (!this.#relationInScope(row, scope)) continue;
        matches.push(this.#relationView(row));
        if (matches.length === 11) break;
      }
      if (rows.length < 101) break;
      after = rows.at(-1).sequence;
    }
    return matches;
  }

  #materialUsagePage(material, filters) {
    const limit = filters.usage_limit ?? 20;
    const scope = { material_id: material.material_id, mission_id: filters.mission_id };
    const fingerprint = sha256(scope);
    let after = 0;
    let ceiling = this.db.prepare('SELECT COALESCE(MAX(rowid), 0) AS ceiling FROM material_consumptions WHERE material_id = ?').get(material.material_id).ceiling;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Invalid Material usage limit');
    if (filters.usage_cursor !== undefined) {
      try {
        if (typeof filters.usage_cursor !== 'string' || filters.usage_cursor.length > 2048) throw new Error();
        const cursor = JSON.parse(Buffer.from(filters.usage_cursor, 'base64url').toString());
        if (cursor.fingerprint !== fingerprint || !Number.isSafeInteger(cursor.after) || !Number.isSafeInteger(cursor.ceiling) ||
            cursor.after < 0 || cursor.ceiling > ceiling || cursor.after > cursor.ceiling) throw new Error();
        ({ after, ceiling } = cursor);
      } catch { throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Material usage cursor does not match this query'); }
    }
    const rows = this.db.prepare(`SELECT rowid AS sequence, operation_id, material_id, reader_task, reader_execution,
      action, substr(action_ref, 1, 2000) AS action_ref, material_version, content_hash, substr(impact, 1, 2000) AS impact, created_at
      FROM material_consumptions WHERE material_id = ? AND rowid > ? AND rowid <= ? ORDER BY rowid LIMIT 501`)
      .all(material.material_id, after, ceiling);
    let last = after;
    let scanned = 0;
    const consumptions = [];
    for (const { sequence, ...row } of rows.slice(0, 500)) {
      last = sequence;
      scanned++;
      if (this.taskService.materialOriginMission(row.reader_task, row.reader_execution) !== scope.mission_id) continue;
      consumptions.push(row);
      if (consumptions.length === limit) break;
    }
    const more = rows.some(row => row.sequence > last);
    return { consumptions, scope, limit, scanned, returned: consumptions.length, truncated: more,
      next_cursor: more ? Buffer.from(JSON.stringify({ fingerprint, ceiling, after: last })).toString('base64url') : null };
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
    if (!includeHistory && !materialId) {
      const hidden = new Set(this.db.prepare(`SELECT relation.* FROM material_relations relation
        JOIN materials origin ON origin.material_id = relation.material_id
        JOIN materials replacement ON replacement.material_id = relation.replacement_material_id
        WHERE relation.relation_kind = 'supersede' AND relation.active = 1 AND replacement.mission_id IS origin.mission_id`).all()
        .filter(row => !missionId || this.taskService?.materialOriginMission?.(row.source_task, row.source_execution, row.actor_ref) === missionId)
        .filter(row => !missionId || this.#materialInScope(this.getMaterial(row.replacement_material_id), { mission_id: missionId }))
        .map(row => row.material_id));
      rows = rows.filter((row) => !hidden.has(row.material_id));
    }
    if (taskId !== null && this.taskService && explicitSourceTask === null) {
      const linkedMaterialIds = new Set(this.taskService.listTaskMaterialIds?.(taskId) ?? []);
      rows = rows.filter((row) => row.source_task === taskId || linkedMaterialIds.has(row.material_id));
    }
    // Mission is represented by Task Service rather than duplicated into
    // Context rows.  The optional Task filter above joins producer and
    // consumer links without giving Context Service Task authority.
    return rows.filter(row => !missionId || this.#materialInScope(row, { mission_id: missionId })).map(row => {
      const relations = this.listMaterialRelations({ material_id: row.material_id, mission_id: missionId });
      const disputes = relations.filter(relation => relation.material_id === row.material_id && relation.relation_kind === 'dispute');
      return { ...cloneMaterial(row), relation_version: this.#relationVersion(row.material_id), disputed: disputes.length > 0,
        disputes, active_successors: relations.filter(relation => relation.material_id === row.material_id && relation.relation_kind === 'supersede') };
    });
  }

  #consumeMaterials(payload, envelope) {
    const scope = this.#assertExecutionFence(envelope);
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
    const impact = payload.impact ?? (scope.bot_id ? null : payload.action_ref ?? null);
    if ((scope.bot_id || impact !== null) && (typeof impact !== 'string' || !impact.trim() || impact.length > 2_000)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Material consumption requires a concrete impact of at most 2000 characters');
    }
    const materials = uniqueMaterialIds.map(id => this.getMaterial(id));
    const missing = uniqueMaterialIds.filter((id, index) => !materials[index]);
    if (missing.length > 0) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown Material IDs: ${missing.join(',')}`);
    }
    for (const material of materials) this.#assertMaterialScope(material, scope);
    const createdAt = now();
    const statement = this.db.prepare(`INSERT OR IGNORE INTO material_consumptions
      (operation_id, material_id, reader_task, reader_execution, action, action_ref, material_version, content_hash, impact, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const material of materials) {
      statement.run(envelope.operation_id, material.material_id, envelope.task_id, envelope.execution_id, action, payload.action_ref ?? null,
        material.version, material.content_hash, impact, createdAt);
    }
    return {
      consumptions: this.listMaterialConsumptions({ reader_execution: envelope.execution_id, action })
        .filter((row) => row.operation_id === envelope.operation_id && uniqueMaterialIds.includes(row.material_id)),
      material_ids: uniqueMaterialIds,
      action,
      action_ref: payload.action_ref ?? null,
    };
  }

  #publishMaterial(payload, envelope, { modern = false } = {}) {
    const caller = this.#assertExecutionFence(envelope);
    rejectSecrets(payload);
    if (modern) payload = { ...payload, kind: 'fact', scope: 'mission', role: 'experience', evidence_state: 'proposed', evidence: [] };
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
    provenance.actor_ref = envelope.actor_ref;
    if (caller) Object.assign(provenance, { mission_id: caller.mission_id, task_id: caller.task_id, execution_id: caller.execution_id, bot_id: caller.bot_id });
    if (modern) {
      const used = payload.used_material_ids ?? [];
      if (!Array.isArray(used) || used.length > 100 || new Set(used).size !== used.length || used.some(id => typeof id !== 'string' || !id)) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'used_material_ids must contain at most 100 distinct Material IDs');
      }
      const exactUse = this.db.prepare(`SELECT material_id, material_version, content_hash FROM material_consumptions
        WHERE reader_execution = ? AND material_id = ? AND material_version IS NOT NULL AND impact IS NOT NULL
        ORDER BY rowid DESC LIMIT 1`);
      provenance.used_materials = used.map(id => {
        const use = exactUse.get(envelope.execution_id, id);
        const material = this.getMaterial(id);
        this.#assertMaterialScope(material, caller);
        if (!use || !material || use.material_version !== material.version || use.content_hash !== material.content_hash) {
          throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Used Material requires an exact consumption record from this Execution');
        }
        return { ...use };
      });
    }
    provenance.role ??= role;
    const boundMissionId = caller?.mission_id ?? (envelope.task_id && typeof this.taskService?.getTask === 'function'
      ? this.taskService.getTask(envelope.task_id)?.mission_id ?? null
      : null);
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
    const attachments = normalizeAttachments(payload.attachments, modern ? source => {
      const material = this.getMaterial(source.material_id);
      this.#assertMaterialScope(material, caller);
      const attachment = material && this.db.prepare('SELECT * FROM material_attachments WHERE material_id = ? AND name = ?')
        .get(source.material_id, source.attachment_name);
      if (!attachment) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Referenced Material attachment is unavailable');
      return attachment;
    } : null);
    const contentText = typeof payload.content === 'string' ? payload.content : stableStringify(payload.content);
    if (typeof contentText !== 'string') throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Material content must be JSON data or text');
    const title = boundedText(payload.title, contentText.trim().split('\n')[0].trim().slice(0, 120) || 'Material', 120, 'title');
    const summary = boundedText(payload.summary, contentText.trim().slice(0, 500) || title, 500, 'summary');
    const mediaType = payload.media_type ?? (typeof payload.content === 'string' ? 'text/markdown' : 'application/json');
    if (typeof mediaType !== 'string' || mediaType.length > 100 || !/^[\w.+-]+\/[\w.+-]+$/.test(mediaType)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Invalid Material media_type');
    }
    if (modern && (Buffer.byteLength(contentText) > 256 * 1024 || (!contentText.trim() && !attachments.length))) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Material requires bounded content or an attachment');
    }
    const manifest = attachments.map(({ bytes, ...attachment }) => ({ ...attachment, size_bytes: bytes.length }));
    const contentHash = attachments.length ? sha256({ content: payload.content, attachments: manifest }) : sha256(payload.content);
    if (payload.content_hash && payload.content_hash !== contentHash) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'content_hash does not match content');
    }
    const materialId = payload.material_id ?? randomUUID();
    const supersedes = payload.supersedes ?? null;
    let version = 1;
    if (supersedes) {
      const previous = this.getMaterial(supersedes);
      if (!previous) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `superseded material does not exist: ${supersedes}`);
      this.#assertMaterialScope(previous, caller);
      version = previous.version + 1;
    }
    const trusted = !caller?.bot_id && this.trustedActorPrefixes.some((prefix) => envelope.actor_ref.startsWith(prefix));
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
      producer_bot_id: caller?.bot_id ?? null,
      provenance,
      evidence,
      supersedes,
      created_at: now(),
    };
    const existing = this.getMaterial(materialId);
    if (existing) {
      if (supersedes) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'A new combined publish/supersede request requires a new Material ID; replay the original request ID instead');
      if (existing.content_hash !== contentHash || existing.kind !== material.kind || existing.role !== material.role || existing.mission_id !== material.mission_id || existing.scope !== material.scope || existing.supersedes !== material.supersedes ||
          existing.source_task !== material.source_task || existing.source_execution !== material.source_execution || (existing.producer_bot_id ?? null) !== material.producer_bot_id) {
        throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'material_id already contains a different immutable record');
      }
      if (modern && (existing.title !== title || existing.summary !== summary || existing.media_type !== mediaType ||
          stableStringify(existing.provenance?.used_materials ?? []) !== stableStringify(provenance.used_materials))) {
        throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'material_id already contains different immutable metadata');
      }
      return { material: modern ? this.#publicMaterial(existing) : existing };
    }
    this.db.prepare(`INSERT INTO materials (
      material_id, kind, role, mission_id, scope, evidence_state, content_ref, content_hash, content_json, version,
      source_task, source_execution, producer_bot_id, provenance_json, supersedes, evidence_json, created_at, title, summary, media_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(material.material_id, material.kind, material.role, material.mission_id, material.scope, material.evidence_state, material.content_ref, material.content_hash,
        json(material.content), material.version, material.source_task, material.source_execution, material.producer_bot_id, json(material.provenance), material.supersedes, json(material.evidence), material.created_at, title, summary, mediaType);
    const insertAttachment = this.db.prepare('INSERT INTO material_attachments (material_id, name, media_type, content_hash, bytes) VALUES (?, ?, ?, ?, ?)');
    for (const attachment of attachments) insertAttachment.run(materialId, attachment.name, attachment.media_type, attachment.content_hash, attachment.bytes);
    if (supersedes) {
      this.#supersedeMaterial({ material_id: supersedes, replacement_material_id: materialId,
        expected_version: payload.expected_version, reason: payload.supersede_reason }, envelope);
    }
    const stored = this.getMaterial(materialId);
    return { material: modern ? this.#publicMaterial(stored) : stored };
  }

  #relationVersion(materialId) {
    return this.db.prepare('SELECT version FROM material_relation_heads WHERE material_id = ?').get(materialId)?.version ?? 0;
  }

  #advanceRelation(materialId, expectedVersion) {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'expected_version must be the observed non-negative relation_version');
    }
    this.db.prepare('INSERT OR IGNORE INTO material_relation_heads (material_id, version) VALUES (?, 0)').run(materialId);
    const result = this.db.prepare('UPDATE material_relation_heads SET version = version + 1 WHERE material_id = ? AND version = ?').run(materialId, expectedVersion);
    if (result.changes !== 1) throw new SwarmEnvError(ERROR_CODES.STALE_VERSION, 'Material correction relation changed; reread the Material', {
      received: expectedVersion, current: this.#relationVersion(materialId),
    });
    return expectedVersion + 1;
  }

  #recordRelationEvent(relation, action, envelope, reason, version) {
    this.db.prepare(`INSERT INTO material_relation_events
      (event_id, relation_id, material_id, action, operation_id, actor_ref, source_task, source_execution, reason, relation_version, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), relation.relation_id, relation.material_id, action,
      envelope.operation_id, envelope.actor_ref, envelope.task_id ?? null, envelope.execution_id ?? null, reason, version, now());
  }

  #materialView(filters) {
    const material = this.getMaterial(requireString(filters.material_id ?? filters.materialId, 'material_id'), { verifyIntegrity: true });
    if (!material) return { material: null };
    if (filters.attachment_name !== undefined) {
      const name = requireString(filters.attachment_name, 'attachment_name');
      const attachment = this.db.prepare('SELECT * FROM material_attachments WHERE material_id = ? AND name = ?').get(material.material_id, name);
      if (!attachment) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Material attachment was not found');
      const bytes = Buffer.from(attachment.bytes);
      if (createHash('sha256').update(bytes).digest('hex') !== attachment.content_hash) {
        throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Stored Material attachment integrity check failed');
      }
      return { attachment: { name, media_type: attachment.media_type, content_hash: attachment.content_hash,
        size_bytes: bytes.length, content_base64: bytes.toString('base64') }, material_id: material.material_id };
    }
    const relations = this.listMaterialRelations({ ...filters, include_inactive: true });
    const readableIds = new Set(relations.map(row => row.relation_id));
    const events = this.db.prepare('SELECT * FROM material_relation_events WHERE material_id = ? ORDER BY relation_version, created_at, event_id')
      .all(material.material_id).filter(event => readableIds.has(event.relation_id));
    return { material, relations, correction_events: events,
      active_successors: relations.filter(row => row.material_id === material.material_id && row.relation_kind === 'supersede' && row.active),
      disputed: relations.some(row => row.material_id === material.material_id && row.relation_kind === 'dispute' && row.active),
      observed_at: now() };
  }

  #assertReadableContent(material) {
    const rows = this.db.prepare('SELECT name, media_type, content_hash, bytes FROM material_attachments WHERE material_id = ? ORDER BY name')
      .all(material.material_id);
    const attachments = rows.map(({ bytes, ...item }) => {
      if (createHash('sha256').update(bytes).digest('hex') !== item.content_hash) {
        throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Stored Material attachment integrity check failed');
      }
      return { ...item, size_bytes: bytes.length };
    });
    const actual = attachments.length ? sha256({ content: material.content, attachments }) : sha256(material.content);
    if (actual !== material.content_hash) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Stored Material content or attachment manifest is incomplete');
  }

  #insertRelation({ materialId, replacementMaterialId = null, relationKind, envelope, reason, claim = null, version = null }) {
    // Each distinct request records its actual claim, reason and author. Only
    // the durable operation receipt coalesces retries, not the target IDs.
    const previous = this.db.prepare(`SELECT COALESCE(MAX(version), 0) AS version FROM material_relations
      WHERE material_id = ? AND relation_kind = ?`).get(materialId, relationKind);
    const relation = {
      relation_id: randomUUID(), material_id: materialId, replacement_material_id: replacementMaterialId,
      relation_kind: relationKind, active: 1, reason, claim, actor_ref: envelope.actor_ref,
      source_task: envelope.task_id ?? null, source_execution: envelope.execution_id ?? null,
      version: version ?? Number(previous?.version ?? 0) + 1, created_at: now(),
    };
    this.db.prepare(`INSERT INTO material_relations
      (relation_id, material_id, replacement_material_id, relation_kind, active, reason, claim,
       actor_ref, source_task, source_execution, version, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      relation.relation_id, relation.material_id, relation.replacement_material_id,
      relation.relation_kind, relation.active, relation.reason, relation.claim, relation.actor_ref,
      relation.source_task, relation.source_execution, relation.version, relation.created_at,
    );
    this.#recordRelationEvent(relation, 'created', envelope, reason, relation.version);
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
      claim: row.claim ?? null,
      actor_ref: row.actor_ref,
      source_task: row.source_task,
      source_execution: row.source_execution,
      version: row.version,
      created_at: row.created_at,
    } : null;
  }

  #disputeMaterial(payload, envelope) {
    const scope = this.#assertExecutionFence(envelope);
    const materialId = requireString(payload.material_id ?? payload.materialId, 'material_id');
    const material = this.getMaterial(materialId);
    if (!material) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown Material: ${materialId}`);
    this.#assertMaterialScope(material, scope);
    const relation = this.#insertRelation({
      materialId,
      relationKind: 'dispute',
      envelope,
      reason: requireString(payload.reason, 'reason'),
      claim: requireString(payload.claim, 'claim'),
    });
    return { material, relation: this.#relationView(relation) };
  }

  #supersedeMaterial(payload, envelope) {
    const scope = this.#assertExecutionFence(envelope);
    const materialId = requireString(payload.material_id ?? payload.materialId, 'material_id');
    const replacementMaterialId = requireString(payload.replacement_material_id ?? payload.replacementMaterialId, 'replacement_material_id');
    if (materialId === replacementMaterialId) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'a Material cannot supersede itself');
    const origin = this.getMaterial(materialId);
    const replacement = this.getMaterial(replacementMaterialId);
    if (!origin || !replacement) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'supersede relation requires both Materials');
    this.#assertMaterialScope(origin, scope);
    this.#assertMaterialScope(replacement, scope);
    this.#assertReadableContent(origin);
    this.#assertReadableContent(replacement);
    const reason = requireString(payload.reason, 'reason');
    const version = this.#advanceRelation(materialId, payload.expected_version ?? payload.expectedVersion);
    const edges = this.db.prepare(`SELECT relation.* FROM material_relations relation
      JOIN materials origin ON origin.material_id = relation.material_id
      WHERE origin.mission_id = ? AND relation.relation_kind = 'supersede' AND relation.active = 1`).all(scope.mission_id)
      .filter(row => this.#relationInScope(row, scope));
    if (edges.some(row => row.material_id === materialId)) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Material already has an active successor; explicitly revoke the matching relation first');
    const successors = new Map();
    for (const edge of edges) successors.set(edge.material_id, [...(successors.get(edge.material_id) ?? []), edge.replacement_material_id]);
    const pending = [replacementMaterialId];
    const visited = new Set();
    while (pending.length) {
      const id = pending.pop();
      if (id === materialId) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Material supersession would create a directed cycle');
      if (visited.has(id)) continue;
      visited.add(id); pending.push(...(successors.get(id) ?? []));
    }
    const relation = this.#insertRelation({ materialId, replacementMaterialId, relationKind: 'supersede', envelope, reason, version });
    return { material: this.getMaterial(materialId), replacement: this.getMaterial(replacementMaterialId), relation: this.#relationView(relation) };
  }

  #unsupersedeMaterial(payload, envelope) {
    const scope = envelope.execution_id ? this.#assertExecutionFence(envelope) : this.#assertCorrectionCoordinator(envelope);
    const materialId = requireString(payload.material_id ?? payload.materialId, 'material_id');
    const replacementMaterialId = requireString(payload.replacement_material_id ?? payload.replacementMaterialId, 'replacement_material_id');
    this.#assertMaterialScope(this.getMaterial(materialId), scope);
    this.#assertMaterialScope(this.getMaterial(replacementMaterialId), scope);
    const current = this.db.prepare(`SELECT * FROM material_relations
      WHERE material_id = ? AND replacement_material_id = ? AND relation_kind = 'supersede' AND active = 1
      ORDER BY version DESC`).all(materialId, replacementMaterialId).find(row => this.#relationInScope(row, scope));
    if (!current) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'matching active supersede relation was not found');
    const reason = requireString(payload.reason, 'reason');
    // Any currently authorized Execution in this Mission may correct an old
    // relation. Actor-name prefixes and relation ownership confer no privilege.
    const version = this.#advanceRelation(materialId, payload.expected_version ?? payload.expectedVersion);
    const result = this.db.prepare(`UPDATE material_relations SET active = 0
      WHERE relation_id = ? AND active = 1`).run(current.relation_id);
    if (result.changes !== 1) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'supersede relation changed concurrently');
    this.#recordRelationEvent(current, 'revoked', envelope, reason, version);
    return { material: this.getMaterial(materialId), replacement: this.getMaterial(replacementMaterialId), relation: this.#relationView({ ...current, active: 0 }), relation_version: version };
  }

  #assertCorrectionCoordinator(envelope) {
    if (typeof this.taskService?.assertMissionCoordination !== 'function') {
      throw new SwarmEnvError(ERROR_CODES.SERVICE_NOT_READY, 'Material correction requires trusted Task-owned coordination authority at the commit boundary');
    }
    return this.taskService.assertMissionCoordination(envelope, 'unsupersede');
  }

  #assertExecutionFence(envelope) {
    if (typeof this.taskService?.materialScope !== 'function') throw new SwarmEnvError(ERROR_CODES.SERVICE_NOT_READY, 'Material writes require Task-owned Mission authority');
    return this.taskService.materialScope(envelope, { write: true });
  }

  #relationInScope(row, scope) {
    return this.taskService?.materialOriginMission?.(row.source_task, row.source_execution, row.actor_ref) === scope.mission_id &&
      this.#materialInScope(this.getMaterial(row.material_id), scope) &&
      (!row.replacement_material_id || this.#materialInScope(this.getMaterial(row.replacement_material_id), scope));
  }

  #assertMaterialScope(material, scope) {
    if (material && scope && !this.#materialInScope(material, scope)) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Material or its recorded producer belongs to another Mission');
  }

  #materialInScope(material, scope) {
    if (!material || material.mission_id !== scope.mission_id) return false;
    if (!material.source_task && !material.source_execution) return true;
    return this.taskService?.materialOriginMission?.(material.source_task, material.source_execution, material.producer_bot_id) === scope.mission_id;
  }

  #scopeRead(payload, envelope) {
    const scope = this.taskService.materialScope(envelope);
    const requested = payload.mission_id ?? payload.missionId;
    if (requested && requested !== scope.mission_id) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Material query belongs to another Mission');
    const materialId = payload.material_id ?? payload.materialId;
    if (materialId) this.#assertMaterialScope(this.getMaterial(materialId), scope);
    return { ...payload, mission_id: scope.mission_id };
  }

  #replay(operationId, fingerprint, originalFingerprint = null) {
    const row = this.db.prepare('SELECT fingerprint, result_json FROM operations WHERE operation_id = ?').get(operationId);
    if (!row) return null;
    if (row.fingerprint !== fingerprint && row.fingerprint !== originalFingerprint) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'operation_id was reused with another payload');
    return parse(row.result_json);
  }

  #saveOperation(operationId, operation, fingerprint, result) {
    this.db.prepare('INSERT INTO operations (operation_id, operation, fingerprint, result_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(operationId, operation, fingerprint, json(result), now());
  }

  #readSnapshot(callback) {
    if (this.db.isTransaction) return callback();
    this.db.exec('BEGIN');
    try {
      const result = callback();
      this.db.exec('COMMIT');
      return result;
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw error; }
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

  #lifecycleTransaction(callback) {
    if (this.taskService.db === this.db) return this.#transaction(callback);
    if (typeof this.taskService.withServiceLifecycleWrite !== 'function') {
      throw new SwarmEnvError(ERROR_CODES.SERVICE_NOT_READY, 'Material writes require the local Task lifecycle commit boundary');
    }
    return this.taskService.withServiceLifecycleWrite(() => this.#transaction(callback));
  }
}

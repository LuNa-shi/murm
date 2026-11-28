import { createHash, randomUUID } from 'node:crypto';
import { installServiceHistory } from '../../persistence/service-history.js';
import { DatabaseSync } from 'node:sqlite';
import { ERROR_CODES, MurmError } from '../../errors.js';
import { operationPayload, stableStringify, validateEnvelope } from '../../persistence/envelope.js';
import { CONTEXT_SCHEMA_SQL } from './context-schema.js';

const CONSUMPTION_ACTIONS = new Set(['route', 'task', 'workspace', 'integration']);
const SECRET_KEY = /(secret|password|token|api[_-]?key|credential|private[_-]?key)/i;

function now() {
  return new Date().toISOString();
}

function json(value: any) {
  return JSON.stringify(value ?? null);
}

function parse(value: any) {
  return value === null || value === undefined ? null : JSON.parse(value);
}

function sha256(value: any) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function normalizeAttachments(input: any = [], readExisting: any) {
  if (!Array.isArray(input) || input.length > 16) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'attachments must contain at most 16 entries');
  let total = 0;
  const names = new Set();
  return input.map((item: any) => {
    const { name, content_base64: encoded, content_hash: expected, media_type: suppliedType, source } = item ?? {};
    if (typeof name !== 'string' || !name.trim() || name.length > 128 || /[\/\\\x00-\x1f]/.test(name) || ['.', '..'].includes(name) || names.has(name)) {
      throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'attachments require distinct names without path components');
    }
    names.add(name);
    if (source !== undefined && (encoded !== undefined || !readExisting || typeof source?.material_id !== 'string' ||
        typeof source?.attachment_name !== 'string' || typeof expected !== 'string')) {
      throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Reference attachments require a source Material ID, attachment name and content_hash');
    }
    const prior = source === undefined ? null : readExisting(source);
    const mediaType = suppliedType ?? prior?.media_type ?? 'application/octet-stream';
    if ((!prior && (typeof encoded !== 'string' || encoded.length > 350_000)) || typeof mediaType !== 'string' ||
        !/^[\w.+-]+\/[\w.+-]+$/.test(mediaType) || mediaType.length > 100) {
      throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'attachment must include bounded base64 bytes and a valid media_type');
    }
    const bytes = prior ? Buffer.from(prior.bytes) : Buffer.from(encoded, 'base64');
    total += bytes.length;
    if ((!prior && bytes.toString('base64') !== encoded) || total > 256 * 1024) {
      throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'attachments must use canonical base64 totaling at most 256 KiB');
    }
    const contentHash = createHash('sha256').update(bytes).digest('hex');
    if ((expected !== undefined && expected !== contentHash) || (prior && prior.content_hash !== contentHash)) {
      throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'attachment content_hash does not match bytes');
    }
    return { name, media_type: mediaType, content_hash: contentHash, bytes };
  }).sort((a: any, b: any) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

function boundedText(value: any, fallback: any, max: any, field: any) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new MurmError(ERROR_CODES.INVALID_CONTRACT, `${field} must be a non-empty string of at most ${max} characters`);
  }
  return value.trim();
}

function requireString(value: any, field: any) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new MurmError(ERROR_CODES.INVALID_CONTRACT, `${field} is required`);
  }
  return value;
}

function cloneMaterial(row: any) {
  if (!row) return null;
  return {
    ...row,
    content: parse(row.content_json),
    provenance: parse(row.provenance_json),
  };
}

function rejectSecrets(value: any, path: any = 'payload') {
  if (Array.isArray(value)) {
    value.forEach((item: any, index: any) => rejectSecrets(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) {
      throw new MurmError(ERROR_CODES.INVALID_CONTRACT, `secret-bearing field ${path}.${key} cannot enter Context Service`);
    }
    rejectSecrets(child, `${path}.${key}`);
  }
}

export class ContextService {
  declare db: any;
  declare taskService: any;
  declare logger: any;

  constructor(database: any = ':memory:', { taskService = null, logger = null }: any = {}) {
    this.db = database instanceof DatabaseSync ? database : new DatabaseSync(database);
    const busyTimeout = this.db.prepare('PRAGMA busy_timeout').get().timeout;
    this.db.exec(`PRAGMA busy_timeout = ${Math.max(busyTimeout, 1000)}`);
    this.db.exec(CONTEXT_SCHEMA_SQL);
    this.db.exec(`PRAGMA busy_timeout = ${busyTimeout}`);
    this.taskService = taskService;
    this.logger = logger;
    installServiceHistory(this.db, { domain: 'context' });
  }

  close() {
    this.db.close();
  }

  dispatch(operation: any, payload: any = {}, envelope: any) {
    this.logger?.append({ event: 'dispatch.start', service: 'context', operation, envelope });
    try {
      if (typeof this.taskService?.materialScope !== 'function') throw new MurmError(ERROR_CODES.SERVICE_NOT_READY, 'Material requests require Task-owned Mission authority');
      const executionWrite = ['context_publish_material', 'consume_materials', 'material_dispute', 'material_supersede', 'material_unsupersede'].includes(operation) && envelope?.execution_id !== null;
      validateEnvelope(envelope, { executionWrite });
      const registeredAgent = Boolean(this.taskService.getAgent?.(envelope.actor_ref));
      const read = ['read_materials', 'context_search_materials', 'list_material_relations', 'context_get_material', 'list_material_consumptions'].includes(operation);
      if (['read_materials', 'context_search_materials'].includes(operation) && ['kind', 'scope', 'role', 'evidence_state'].some((field: any) => Object.hasOwn(payload, field))) {
        throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Material queries use content, producer and correction filters');
      }
      let replayed = false;
      const result = read ? this.#readSnapshot(() => {
        const scopedPayload = this.#scopeRead(payload, envelope);
        if (operation === 'read_materials' || operation === 'context_search_materials') {
          return registeredAgent ? this.#readMaterialPage(scopedPayload) : this.#readMaterials(scopedPayload);
        }
        if (operation === 'list_material_relations') return this.listMaterialRelations(scopedPayload);
        if (operation === 'context_get_material') {
          const view = this.#materialView(scopedPayload);
          return registeredAgent && view.material ? { ...view, material: this.#publicMaterial(view.material),
            usage: this.#materialUsagePage(view.material, scopedPayload) } : view;
        }
        return this.listMaterialConsumptions(scopedPayload);
      }) : this.#lifecycleTransaction(() => {
        const originalFingerprint = operationPayload(operation, payload, envelope);
        const fingerprint = operationPayload(operation, payload,
          this.taskService?.getAgent?.(envelope.actor_ref) ? { ...envelope, state_version: null } : envelope);
        const replay = this.#replay(envelope.operation_id, fingerprint, originalFingerprint);
        if (replay) {
          replayed = true;
          return replay;
        }
        let value: any;
        if (operation === 'context_publish_material') value = this.#publishMaterial(payload, envelope);
        else if (operation === 'consume_materials') value = this.#consumeMaterials(payload, envelope);
        else if (operation === 'material_dispute') value = this.#disputeMaterial(payload, envelope);
        else if (operation === 'material_supersede') value = this.#supersedeMaterial(payload, envelope);
        else if (operation === 'material_unsupersede') value = this.#unsupersedeMaterial(payload, envelope);
        else throw new MurmError(ERROR_CODES.INVALID_CONTRACT, `unsupported Context Service operation: ${operation}`);
        if (registeredAgent && value.relation) {
          value = { ...value, material: this.#publicMaterial(value.material),
            ...(value.replacement ? { replacement: this.#publicMaterial(value.replacement) } : {}) };
        }
        if (registeredAgent) {
          if (operation === 'material_unsupersede' && !envelope.execution_id) this.#assertCorrectionCoordinator(envelope);
          else this.#assertExecutionFence(envelope);
        }
        this.#saveOperation(envelope.operation_id, operation, fingerprint, value);
        return value;
      });
      if (['context_publish_material', 'material_dispute', 'material_supersede', 'material_unsupersede'].includes(operation) && !replayed) {
        this.taskService?.notifyDependencyEvent?.({
          kind: operation === 'context_publish_material' ? 'material_published' : 'material_corrected',
          operation,
          task_id: result?.material?.producer_task_id ?? null,
          execution_id: result?.material?.producer_execution_id ?? null,
        });
      }
      this.logger?.append({ event: 'dispatch.complete', service: 'context', operation, ok: true, result });
      return result;
    } catch (error: any) {
      this.logger?.append({ event: 'dispatch.complete', service: 'context', operation, ok: false, error: { name: error.name, code: error.code, message: error.message } });
      throw error;
    }
  }

  getMaterial(materialId: any, { verifyIntegrity = false }: any = {}) {
    const material = cloneMaterial(this.db.prepare(`SELECT material.*, COALESCE(head.version, 0) AS relation_version
      FROM materials material LEFT JOIN material_relation_heads head USING (material_id) WHERE material.material_id = ?`).get(materialId));
    if (material && verifyIntegrity) this.#assertReadableContent(material);
    return material;
  }

  readMaterials(filters: any = {}) {
    return this.#readSnapshot(() => this.#readMaterials(filters));
  }

  /** Durable public-state observation for discovery; no heartbeat/read counts. */
  publicChangeToken(missionId: any) {
    requireString(missionId, 'mission_id');
    return this.db.prepare(`SELECT
      (SELECT COUNT(*) FROM materials WHERE mission_id = ?) AS materials,
      (SELECT COUNT(*) FROM material_relations relation JOIN materials m ON m.material_id = relation.material_id WHERE m.mission_id = ?) AS relations,
      (SELECT COALESCE(SUM(relation.active), 0) FROM material_relations relation JOIN materials m ON m.material_id = relation.material_id WHERE m.mission_id = ?) AS active_relations`).get(missionId, missionId, missionId);
  }

  /** Return durable Material consumption edges for Task completion and reports. */
  listMaterialConsumptions(filters: any = {}) {
    const materialId = filters.material_id ?? null;
    const readerTask = filters.reader_task ?? null;
    const readerExecution = filters.reader_execution ?? null;
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
      .filter((row: any) => !filters.mission_id || this.taskService?.materialOriginMission?.(row.reader_task, row.reader_execution) === filters.mission_id)
      .filter((row: any) => !filters.mission_id || this.#materialInScope(this.getMaterial(row.material_id), filters))
      .map((row: any) => ({
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

  readTakeMaterialInputs({ missionId, materialIds }: any) {
    if (!Array.isArray(materialIds) || materialIds.length > 100 ||
        new Set(materialIds).size !== materialIds.length || materialIds.some((id: any) => typeof id !== 'string' || !id)) {
      throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Task input Materials must contain at most 100 distinct IDs');
    }
    return this.#readSnapshot(() => materialIds.map((materialId: any) => {
      const material = this.getMaterial(materialId);
      if (!this.#materialInScope(material, { mission_id: missionId })) {
        throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Task input Material is not readable in this Mission');
      }
      this.#assertReadableContent(material);
      return { material_id: materialId, version: material.version, content_hash: material.content_hash };
    }));
  }

  readWorkspaceMaterialUses({ missionId, taskId, executionId, materialIds }: any) {
    const find = this.db.prepare(`SELECT operation_id, material_id, material_version, content_hash, impact
      FROM material_consumptions WHERE reader_task = ? AND reader_execution = ?
        AND material_id = ? AND action = 'workspace' AND material_version IS NOT NULL
        AND content_hash IS NOT NULL AND impact IS NOT NULL AND length(trim(impact)) > 0
      ORDER BY created_at DESC, operation_id DESC LIMIT 1`);
    return materialIds.map((materialId: any) => {
      const material = this.getMaterial(materialId);
      const use = this.#materialInScope(material, { mission_id: missionId }) && find.get(taskId, executionId, materialId);
      if (!use || use.material_version !== material.version || use.content_hash !== material.content_hash) {
        throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Workspace Material must have a recorded use in this Execution');
      }
      return { material_id: use.material_id, version: use.material_version, content_hash: use.content_hash,
        operation_id: use.operation_id, impact: use.impact };
    });
  }

  listMaterialRelations(filters: any = {}) {
    const materialId = filters.material_id ?? null;
    const includeInactive = filters.include_inactive === true;
    return this.db.prepare(`SELECT * FROM material_relations
      WHERE (? IS NULL OR material_id = ? OR replacement_material_id = ?)
        AND (? IS NULL OR material_id IN (SELECT material_id FROM materials WHERE mission_id = ?))
        AND (? IS NULL OR replacement_material_id IS NULL OR replacement_material_id IN (SELECT material_id FROM materials WHERE mission_id = ?))
        AND (? = 1 OR active = 1)
      ORDER BY created_at, relation_id`)
      .all(materialId, materialId, materialId, filters.mission_id ?? null, filters.mission_id ?? null, filters.mission_id ?? null, filters.mission_id ?? null, includeInactive ? 1 : 0)
      .filter((row: any) => !filters.mission_id || this.#relationInScope(row, filters))
      .map((row: any) => this.#relationView(row));
  }

  #publicMaterial(material: any, { summaryOnly = false }: any = {}) {
    const { material_id, mission_id, producer_task_id, producer_execution_id, producer_agent_id, content_hash,
      version, relation_version, created_at } = material;
    const preview = typeof material.content === 'string' ? material.content : stableStringify(material.content);
    const selected = {
      material_id, mission_id, producer_task_id, producer_execution_id, producer_agent_id,
      content_hash, version, relation_version, created_at, title: material.title ?? preview?.trim().slice(0, 120) ?? material_id,
      summary: material.summary ?? preview?.trim().slice(0, 500) ?? '',
      media_type: material.media_type ?? (typeof material.content === 'string' ? 'text/markdown' : 'application/json'),
      attachments: this.db.prepare('SELECT name, media_type, content_hash, length(bytes) AS size_bytes FROM material_attachments WHERE material_id = ? ORDER BY name').all(material_id).map((row: any) => ({ ...row })),
    };
    return summaryOnly ? selected : { ...selected, content: material.content, provenance: {
      mission_id, task_id: producer_task_id, execution_id: producer_execution_id, agent_id: producer_agent_id,
      actor_ref: material.provenance?.actor_ref ?? null, used_materials: material.provenance?.used_materials ?? [],
    } };
  }

  #readMaterialPage(filters: any) {
    const missionId = filters.mission_id;
    const materialId = filters.material_id ?? null;
    const taskId = filters.task_id ?? null;
    const sourceTask = filters.producer_task_id ?? null;
    const sourceExecution = filters.producer_execution_id ?? null;
    const relationKind = filters.relation_kind ?? null;
    const relatedId = filters.related_material_id ?? null;
    const query = filters.query ?? null;
    const history = filters.include_history === true;
    const limit = filters.limit ?? 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 ||
        (relationKind !== null && !['supersede', 'dispute'].includes(relationKind)) ||
        [materialId, taskId, sourceTask, sourceExecution, query, relatedId].some((value: any) => value !== null && (typeof value !== 'string' || !value || value.length > 1000))) {
      throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Invalid Material page filters');
    }
    const scope = { mission_id: missionId, material_id: materialId, task_id: taskId,
      producer_task_id: sourceTask, producer_execution_id: sourceExecution, query, include_history: history,
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
      } catch { throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Material cursor does not match this query'); }
    }
    const rows = this.db.prepare(`WITH window AS MATERIALIZED (
      SELECT rowid AS sequence, material_id, mission_id, producer_task_id, producer_execution_id, producer_agent_id,
        title, summary, media_type, content_hash, version, created_at, content_json
      FROM materials WHERE mission_id = ? AND rowid > ? AND rowid <= ? ORDER BY rowid LIMIT 501
    ) SELECT sequence, material_id, mission_id, producer_task_id, producer_execution_id, producer_agent_id, title, summary,
      media_type, content_hash, version, created_at, substr(content_json, 1, 502) AS preview,
      CASE WHEN ? IS NULL THEN 1 WHEN instr(lower(title), lower(?)) > 0 THEN 3 WHEN instr(lower(summary), lower(?)) > 0 THEN 2
        WHEN instr(lower(content_json), lower(?)) > 0 THEN 1 ELSE 0 END AS relevance
      FROM window ORDER BY sequence`).all(missionId, after, ceiling, query, query, query, query);
    const materials: any[] = [];
    const window = rows.slice(0, 500).sort((a: any, b: any) => b.relevance - a.relevance || a.sequence - b.sequence);
    let scanned = offset;
    for (const row of window.slice(offset)) {
      scanned++;
      if ((materialId && row.material_id !== materialId) || (sourceTask && row.producer_task_id !== sourceTask) ||
          (sourceExecution && row.producer_execution_id !== sourceExecution) || !this.#materialInScope(row, { mission_id: missionId })) continue;
      if (taskId && row.producer_task_id !== taskId && !this.taskService.hasTaskMaterial(taskId, row.material_id)) continue;
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

  #summaryRelations(materialId: any, missionId: any, kind: any, { incoming = false, otherId = null }: any = {}) {
    const [endpoint, other] = incoming ? ['replacement_material_id', 'material_id'] : ['material_id', 'replacement_material_id'];
    const page = this.db.prepare(`SELECT rowid AS sequence, * FROM material_relations WHERE ${endpoint} = ? AND relation_kind = ?
      AND active = 1 ${otherId === null ? '' : `AND ${other} = ?`} AND rowid > ? ORDER BY rowid LIMIT 101`);
    const args = [materialId, kind, ...(otherId === null ? [] : [otherId])];
    const scope = { mission_id: missionId };
    const matches: any[] = [];
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

  #materialUsagePage(material: any, filters: any) {
    const limit = filters.usage_limit ?? 20;
    const scope = { material_id: material.material_id, mission_id: filters.mission_id };
    const fingerprint = sha256(scope);
    let after = 0;
    let ceiling = this.db.prepare('SELECT COALESCE(MAX(rowid), 0) AS ceiling FROM material_consumptions WHERE material_id = ?').get(material.material_id).ceiling;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Invalid Material usage limit');
    if (filters.usage_cursor !== undefined) {
      try {
        if (typeof filters.usage_cursor !== 'string' || filters.usage_cursor.length > 2048) throw new Error();
        const cursor = JSON.parse(Buffer.from(filters.usage_cursor, 'base64url').toString());
        if (cursor.fingerprint !== fingerprint || !Number.isSafeInteger(cursor.after) || !Number.isSafeInteger(cursor.ceiling) ||
            cursor.after < 0 || cursor.ceiling > ceiling || cursor.after > cursor.ceiling) throw new Error();
        ({ after, ceiling } = cursor);
      } catch { throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Material usage cursor does not match this query'); }
    }
    const rows = this.db.prepare(`SELECT rowid AS sequence, operation_id, material_id, reader_task, reader_execution,
      action, substr(action_ref, 1, 2000) AS action_ref, material_version, content_hash, substr(impact, 1, 2000) AS impact, created_at
      FROM material_consumptions WHERE material_id = ? AND rowid > ? AND rowid <= ? ORDER BY rowid LIMIT 501`)
      .all(material.material_id, after, ceiling);
    let last = after;
    let scanned = 0;
    const consumptions: any[] = [];
    for (const { sequence, ...row } of rows.slice(0, 500)) {
      last = sequence;
      scanned++;
      if (this.taskService.materialOriginMission(row.reader_task, row.reader_execution) !== scope.mission_id) continue;
      consumptions.push(row);
      if (consumptions.length === limit) break;
    }
    const more = rows.some((row: any) => row.sequence > last);
    return { consumptions, scope, limit, scanned, returned: consumptions.length, truncated: more,
      next_cursor: more ? Buffer.from(JSON.stringify({ fingerprint, ceiling, after: last })).toString('base64url') : null };
  }

  #readMaterials(filters: any = {}) {
    const materialId = filters.material_id ?? null;
    const explicitSourceTask = filters.producer_task_id ?? null;
    const taskId = filters.task_id ?? null;
    // A standalone Context Service has no Task-link table, so task_id keeps
    // its useful producer lookup there. Once Task Service is attached,
    // task_id also includes Materials linked to that Task as input, response,
    // handoff, or experience while producer_task_id remains producer-only.
    const sourceTask = explicitSourceTask ?? (this.taskService ? null : taskId);
    const sourceExecution = filters.producer_execution_id ?? null;
    const query = filters.query ?? null;
    if (query !== null && (typeof query !== 'string' || query.length === 0)) {
      throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'query must be a non-empty string or null');
    }
    const missionId = filters.mission_id ?? null;
    const includeHistory = filters.include_history === true;
    let rows = this.db.prepare(`SELECT * FROM materials
      WHERE (? IS NULL OR material_id = ?)
        AND (? IS NULL OR producer_task_id = ?)
        AND (? IS NULL OR producer_execution_id = ?)
        AND (? IS NULL OR mission_id = ?)
        AND (? IS NULL OR content_json LIKE '%' || ? || '%' OR provenance_json LIKE '%' || ? || '%')
      ORDER BY created_at, material_id`)
      .all(materialId, materialId, sourceTask, sourceTask, sourceExecution, sourceExecution,
        missionId, missionId, query, query, query);
    if (!includeHistory && !materialId) {
      const hidden = new Set(this.db.prepare(`SELECT relation.* FROM material_relations relation
        JOIN materials origin ON origin.material_id = relation.material_id
        JOIN materials replacement ON replacement.material_id = relation.replacement_material_id
        WHERE relation.relation_kind = 'supersede' AND relation.active = 1 AND replacement.mission_id IS origin.mission_id`).all()
        .filter((row: any) => !missionId || this.taskService?.materialOriginMission?.(row.producer_task_id, row.producer_execution_id, row.actor_ref) === missionId)
        .filter((row: any) => !missionId || this.#materialInScope(this.getMaterial(row.replacement_material_id), { mission_id: missionId }))
        .map((row: any) => row.material_id));
      rows = rows.filter((row: any) => !hidden.has(row.material_id));
    }
    if (taskId !== null && this.taskService && explicitSourceTask === null) {
      const linkedMaterialIds = new Set(this.taskService.listTaskMaterialIds?.(taskId) ?? []);
      rows = rows.filter((row: any) => row.producer_task_id === taskId || linkedMaterialIds.has(row.material_id));
    }
    // Mission is represented by Task Service rather than duplicated into
    // Context rows.  The optional Task filter above joins producer and
    // consumer links without giving Context Service Task authority.
    return rows.filter((row: any) => !missionId || this.#materialInScope(row, { mission_id: missionId })).map((row: any) => {
      const relations = this.listMaterialRelations({ material_id: row.material_id, mission_id: missionId });
      const disputes = relations.filter((relation: any) => relation.material_id === row.material_id && relation.relation_kind === 'dispute');
      return { ...cloneMaterial(row), relation_version: this.#relationVersion(row.material_id), disputed: disputes.length > 0,
        disputes, active_successors: relations.filter((relation: any) => relation.material_id === row.material_id && relation.relation_kind === 'supersede') };
    });
  }

  #consumeMaterials(payload: any, envelope: any) {
    const scope = this.#assertExecutionFence(envelope);
    if (!envelope.task_id || !envelope.execution_id) {
      throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'consume_materials requires a bound Task and Execution');
    }
    const materialIds = payload.material_ids;
    if (!Array.isArray(materialIds) || materialIds.length === 0 || materialIds.length > 100 || materialIds.some((id: any) => typeof id !== 'string' || id.length === 0)) {
      throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'material_ids must contain between 1 and 100 Material IDs');
    }
    const uniqueMaterialIds = [...new Set(materialIds)];
    if (uniqueMaterialIds.length !== materialIds.length) {
      throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'material_ids must not contain duplicates');
    }
    const action = payload.action;
    if (!CONSUMPTION_ACTIONS.has(action)) {
      throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'action must be route, task, workspace, or integration');
    }
    if (payload.action_ref !== undefined && payload.action_ref !== null && (typeof payload.action_ref !== 'string' || payload.action_ref.length === 0)) {
      throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'action_ref must be a non-empty string or null');
    }
    const impact = payload.impact ?? (scope.agent_id ? null : payload.action_ref ?? null);
    if ((scope.agent_id || impact !== null) && (typeof impact !== 'string' || !impact.trim() || impact.length > 2_000)) {
      throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Material consumption requires a concrete impact of at most 2000 characters');
    }
    const materials = uniqueMaterialIds.map((id: any) => this.getMaterial(id));
    const missing = uniqueMaterialIds.filter((id: any, index: any) => !materials[index]);
    if (missing.length > 0) {
      throw new MurmError(ERROR_CODES.INVALID_CONTRACT, `unknown Material IDs: ${missing.join(',')}`);
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
        .filter((row: any) => row.operation_id === envelope.operation_id && uniqueMaterialIds.includes(row.material_id)),
      material_ids: uniqueMaterialIds,
      action,
      action_ref: payload.action_ref ?? null,
    };
  }

  #publishMaterial(payload: any, envelope: any) {
    const caller = this.#assertExecutionFence(envelope);
    rejectSecrets(payload);
    for (const field of ['kind', 'scope', 'role', 'evidence_state', 'evidence', 'content_ref']) {
      if (Object.hasOwn(payload, field)) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, `Unsupported Material publication field: ${field}`);
    }
    if (payload.content === undefined) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'material content is required');
    const provenance: any = { actor_ref: envelope.actor_ref, mission_id: caller.mission_id, task_id: caller.task_id,
      execution_id: caller.execution_id, agent_id: caller.agent_id };
    {
      const used = payload.used_material_ids ?? [];
      if (!Array.isArray(used) || used.length > 100 || new Set(used).size !== used.length || used.some((id: any) => typeof id !== 'string' || !id)) {
        throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'used_material_ids must contain at most 100 distinct Material IDs');
      }
      const exactUse = this.db.prepare(`SELECT material_id, material_version, content_hash FROM material_consumptions
        WHERE reader_execution = ? AND material_id = ? AND material_version IS NOT NULL AND impact IS NOT NULL
        ORDER BY rowid DESC LIMIT 1`);
      provenance.used_materials = used.map((id: any) => {
        const use = exactUse.get(envelope.execution_id, id);
        const material = this.getMaterial(id);
        this.#assertMaterialScope(material, caller);
        if (!use || !material || use.material_version !== material.version || use.content_hash !== material.content_hash) {
          throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Used Material requires an exact consumption record from this Execution');
        }
        return { ...use };
      });
    }
    const boundMissionId = caller?.mission_id ?? (envelope.task_id && typeof this.taskService?.getTask === 'function'
      ? this.taskService.getTask(envelope.task_id)?.mission_id ?? null
      : null);
    const requestedMissionId = payload.mission_id ?? null;
    if (boundMissionId && requestedMissionId && requestedMissionId !== boundMissionId) {
      throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Material mission_id must match the current Task Mission', {
        current_mission_id: boundMissionId,
        requested_mission_id: requestedMissionId,
      });
    }
    const missionId = requestedMissionId ?? boundMissionId;
    if (missionId !== null) {
      requireString(missionId, 'mission_id');
      provenance.mission_id ??= missionId;
    }
    if (payload.producer_task_id !== undefined && payload.producer_task_id !== envelope.task_id) {
      throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'producer_task_id must match the operation envelope');
    }
    if (payload.producer_execution_id !== undefined && payload.producer_execution_id !== envelope.execution_id) {
      throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'producer_execution_id must match the operation envelope');
    }
    const attachments = normalizeAttachments(payload.attachments, (source: any) => {
      const material = this.getMaterial(source.material_id);
      this.#assertMaterialScope(material, caller);
      const attachment = material && this.db.prepare('SELECT * FROM material_attachments WHERE material_id = ? AND name = ?')
        .get(source.material_id, source.attachment_name);
      if (!attachment) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Referenced Material attachment is unavailable');
      return attachment;
    });
    const contentText = typeof payload.content === 'string' ? payload.content : stableStringify(payload.content);
    if (typeof contentText !== 'string') throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Material content must be JSON data or text');
    const title = boundedText(payload.title, contentText.trim().split('\n')[0].trim().slice(0, 120) || 'Material', 120, 'title');
    const summary = boundedText(payload.summary, contentText.trim().slice(0, 500) || title, 500, 'summary');
    const mediaType = payload.media_type ?? (typeof payload.content === 'string' ? 'text/markdown' : 'application/json');
    if (typeof mediaType !== 'string' || mediaType.length > 100 || !/^[\w.+-]+\/[\w.+-]+$/.test(mediaType)) {
      throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Invalid Material media_type');
    }
    if ((Buffer.byteLength(contentText) > 256 * 1024 || (!contentText.trim() && !attachments.length))) {
      throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Material requires bounded content or an attachment');
    }
    const manifest = attachments.map(({ bytes, ...attachment }: any) => ({ ...attachment, size_bytes: bytes.length }));
    const contentHash = attachments.length ? sha256({ content: payload.content, attachments: manifest }) : sha256(payload.content);
    if (payload.content_hash && payload.content_hash !== contentHash) {
      throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'content_hash does not match content');
    }
    const materialId = payload.material_id ?? randomUUID();
    const supersedes = payload.supersedes ?? null;
    let version = 1;
    if (supersedes) {
      const previous = this.getMaterial(supersedes);
      if (!previous) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, `superseded material does not exist: ${supersedes}`);
      this.#assertMaterialScope(previous, caller);
      version = previous.version + 1;
    }
    const material = {
      material_id: materialId,
      mission_id: missionId,
      content_hash: contentHash,
      content: payload.content,
      version,
      producer_task_id: envelope.task_id,
      producer_execution_id: envelope.execution_id,
      producer_agent_id: caller?.agent_id ?? null,
      provenance,
      supersedes,
      created_at: now(),
    };
    const existing = this.getMaterial(materialId);
    if (existing) {
      if (supersedes) throw new MurmError(ERROR_CODES.CONFLICT, 'A new combined publish/supersede request requires a new Material ID; replay the original request ID instead');
      if (existing.content_hash !== contentHash || existing.mission_id !== material.mission_id || existing.supersedes !== material.supersedes ||
          existing.producer_task_id !== material.producer_task_id || existing.producer_execution_id !== material.producer_execution_id || (existing.producer_agent_id ?? null) !== material.producer_agent_id) {
        throw new MurmError(ERROR_CODES.CONFLICT, 'material_id already contains a different immutable record');
      }
      if ((existing.title !== title || existing.summary !== summary || existing.media_type !== mediaType ||
          stableStringify(existing.provenance?.used_materials ?? []) !== stableStringify(provenance.used_materials))) {
        throw new MurmError(ERROR_CODES.CONFLICT, 'material_id already contains different immutable metadata');
      }
      return { material: this.#publicMaterial(existing) };
    }
    this.db.prepare(`INSERT INTO materials (
      material_id, mission_id, content_hash, content_json, version,
      producer_task_id, producer_execution_id, producer_agent_id, provenance_json, supersedes, created_at, title, summary, media_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(material.material_id, material.mission_id, material.content_hash, json(material.content), material.version,
        material.producer_task_id, material.producer_execution_id, material.producer_agent_id, json(material.provenance), material.supersedes,
        material.created_at, title, summary, mediaType);
    const insertAttachment = this.db.prepare('INSERT INTO material_attachments (material_id, name, media_type, content_hash, bytes) VALUES (?, ?, ?, ?, ?)');
    for (const attachment of attachments) insertAttachment.run(materialId, attachment.name, attachment.media_type, attachment.content_hash, attachment.bytes);
    if (supersedes) {
      this.#supersedeMaterial({ material_id: supersedes, replacement_material_id: materialId,
        expected_version: payload.expected_version, reason: payload.supersede_reason }, envelope);
    }
    const stored = this.getMaterial(materialId);
    return { material: this.#publicMaterial(stored) };
  }

  #relationVersion(materialId: any) {
    return this.db.prepare('SELECT version FROM material_relation_heads WHERE material_id = ?').get(materialId)?.version ?? 0;
  }

  #advanceRelation(materialId: any, expectedVersion: any) {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'expected_version must be the observed non-negative relation_version');
    }
    this.db.prepare('INSERT OR IGNORE INTO material_relation_heads (material_id, version) VALUES (?, 0)').run(materialId);
    const result = this.db.prepare('UPDATE material_relation_heads SET version = version + 1 WHERE material_id = ? AND version = ?').run(materialId, expectedVersion);
    if (result.changes !== 1) throw new MurmError(ERROR_CODES.STALE_VERSION, 'Material correction relation changed; reread the Material', {
      received: expectedVersion, current: this.#relationVersion(materialId),
    });
    return expectedVersion + 1;
  }

  #recordRelationEvent(relation: any, action: any, envelope: any, reason: any, version: any) {
    this.db.prepare(`INSERT INTO material_relation_events
      (event_id, relation_id, material_id, action, operation_id, actor_ref, producer_task_id, producer_execution_id, reason, relation_version, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), relation.relation_id, relation.material_id, action,
      envelope.operation_id, envelope.actor_ref, envelope.task_id ?? null, envelope.execution_id ?? null, reason, version, now());
  }

  #materialView(filters: any) {
    const material = this.getMaterial(requireString(filters.material_id, 'material_id'), { verifyIntegrity: true });
    if (!material) return { material: null };
    if (filters.attachment_name !== undefined) {
      const name = requireString(filters.attachment_name, 'attachment_name');
      const attachment = this.db.prepare('SELECT * FROM material_attachments WHERE material_id = ? AND name = ?').get(material.material_id, name);
      if (!attachment) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Material attachment was not found');
      const bytes = Buffer.from(attachment.bytes);
      if (createHash('sha256').update(bytes).digest('hex') !== attachment.content_hash) {
        throw new MurmError(ERROR_CODES.CONFLICT, 'Stored Material attachment integrity check failed');
      }
      return { attachment: { name, media_type: attachment.media_type, content_hash: attachment.content_hash,
        size_bytes: bytes.length, content_base64: bytes.toString('base64') }, material_id: material.material_id };
    }
    const relations = this.listMaterialRelations({ ...filters, include_inactive: true });
    const readableIds = new Set(relations.map((row: any) => row.relation_id));
    const events = this.db.prepare('SELECT * FROM material_relation_events WHERE material_id = ? ORDER BY relation_version, created_at, event_id')
      .all(material.material_id).filter((event: any) => readableIds.has(event.relation_id));
    return { material, relations, correction_events: events,
      active_successors: relations.filter((row: any) => row.material_id === material.material_id && row.relation_kind === 'supersede' && row.active),
      disputed: relations.some((row: any) => row.material_id === material.material_id && row.relation_kind === 'dispute' && row.active),
      observed_at: now() };
  }

  #assertReadableContent(material: any) {
    const rows = this.db.prepare('SELECT name, media_type, content_hash, bytes FROM material_attachments WHERE material_id = ? ORDER BY name')
      .all(material.material_id);
    const attachments = rows.map(({ bytes, ...item }: any) => {
      if (createHash('sha256').update(bytes).digest('hex') !== item.content_hash) {
        throw new MurmError(ERROR_CODES.CONFLICT, 'Stored Material attachment integrity check failed');
      }
      return { ...item, size_bytes: bytes.length };
    });
    const actual = attachments.length ? sha256({ content: material.content, attachments }) : sha256(material.content);
    if (actual !== material.content_hash) throw new MurmError(ERROR_CODES.CONFLICT, 'Stored Material content or attachment manifest is incomplete');
  }

  #insertRelation({ materialId, replacementMaterialId = null, relationKind, envelope, reason, claim = null, version = null }: any) {
    // Each distinct request records its actual claim, reason and author. Only
    // the durable operation receipt coalesces retries, not the target IDs.
    const previous = this.db.prepare(`SELECT COALESCE(MAX(version), 0) AS version FROM material_relations
      WHERE material_id = ? AND relation_kind = ?`).get(materialId, relationKind);
    const relation = {
      relation_id: randomUUID(), material_id: materialId, replacement_material_id: replacementMaterialId,
      relation_kind: relationKind, active: 1, reason, claim, actor_ref: envelope.actor_ref,
      producer_task_id: envelope.task_id ?? null, producer_execution_id: envelope.execution_id ?? null,
      version: version ?? Number(previous?.version ?? 0) + 1, created_at: now(),
    };
    this.db.prepare(`INSERT INTO material_relations
      (relation_id, material_id, replacement_material_id, relation_kind, active, reason, claim,
       actor_ref, producer_task_id, producer_execution_id, version, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      relation.relation_id, relation.material_id, relation.replacement_material_id,
      relation.relation_kind, relation.active, relation.reason, relation.claim, relation.actor_ref,
      relation.producer_task_id, relation.producer_execution_id, relation.version, relation.created_at,
    );
    this.#recordRelationEvent(relation, 'created', envelope, reason, relation.version);
    return relation;
  }

  #relationView(row: any) {
    return row ? {
      relation_id: row.relation_id,
      material_id: row.material_id,
      replacement_material_id: row.replacement_material_id,
      relation_kind: row.relation_kind,
      active: Boolean(row.active),
      reason: row.reason,
      claim: row.claim ?? null,
      actor_ref: row.actor_ref,
      producer_task_id: row.producer_task_id,
      producer_execution_id: row.producer_execution_id,
      version: row.version,
      created_at: row.created_at,
    } : null;
  }

  #disputeMaterial(payload: any, envelope: any) {
    const scope = this.#assertExecutionFence(envelope);
    const materialId = requireString(payload.material_id, 'material_id');
    const material = this.getMaterial(materialId);
    if (!material) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, `unknown Material: ${materialId}`);
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

  #supersedeMaterial(payload: any, envelope: any) {
    const scope = this.#assertExecutionFence(envelope);
    const materialId = requireString(payload.material_id, 'material_id');
    const replacementMaterialId = requireString(payload.replacement_material_id, 'replacement_material_id');
    if (materialId === replacementMaterialId) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'a Material cannot supersede itself');
    const origin = this.getMaterial(materialId);
    const replacement = this.getMaterial(replacementMaterialId);
    if (!origin || !replacement) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'supersede relation requires both Materials');
    this.#assertMaterialScope(origin, scope);
    this.#assertMaterialScope(replacement, scope);
    this.#assertReadableContent(origin);
    this.#assertReadableContent(replacement);
    const reason = requireString(payload.reason, 'reason');
    const version = this.#advanceRelation(materialId, payload.expected_version);
    const edges = this.db.prepare(`SELECT relation.* FROM material_relations relation
      JOIN materials origin ON origin.material_id = relation.material_id
      WHERE origin.mission_id = ? AND relation.relation_kind = 'supersede' AND relation.active = 1`).all(scope.mission_id)
      .filter((row: any) => this.#relationInScope(row, scope));
    if (edges.some((row: any) => row.material_id === materialId)) throw new MurmError(ERROR_CODES.CONFLICT, 'Material already has an active successor; explicitly revoke the matching relation first');
    const successors = new Map<any, any>();
    for (const edge of edges) successors.set(edge.material_id, [...(successors.get(edge.material_id) ?? []), edge.replacement_material_id]);
    const pending = [replacementMaterialId];
    const visited = new Set();
    while (pending.length) {
      const id = pending.pop();
      if (id === materialId) throw new MurmError(ERROR_CODES.CONFLICT, 'Material supersession would create a directed cycle');
      if (visited.has(id)) continue;
      visited.add(id); pending.push(...(successors.get(id) ?? []));
    }
    const relation = this.#insertRelation({ materialId, replacementMaterialId, relationKind: 'supersede', envelope, reason, version });
    return { material: this.getMaterial(materialId), replacement: this.getMaterial(replacementMaterialId), relation: this.#relationView(relation) };
  }

  #unsupersedeMaterial(payload: any, envelope: any) {
    const scope = envelope.execution_id ? this.#assertExecutionFence(envelope) : this.#assertCorrectionCoordinator(envelope);
    const materialId = requireString(payload.material_id, 'material_id');
    const replacementMaterialId = requireString(payload.replacement_material_id, 'replacement_material_id');
    this.#assertMaterialScope(this.getMaterial(materialId), scope);
    this.#assertMaterialScope(this.getMaterial(replacementMaterialId), scope);
    const current = this.db.prepare(`SELECT * FROM material_relations
      WHERE material_id = ? AND replacement_material_id = ? AND relation_kind = 'supersede' AND active = 1
      ORDER BY version DESC`).all(materialId, replacementMaterialId).find((row: any) => this.#relationInScope(row, scope));
    if (!current) throw new MurmError(ERROR_CODES.CONFLICT, 'matching active supersede relation was not found');
    const reason = requireString(payload.reason, 'reason');
    // Any currently authorized Execution in this Mission may correct an old
    // relation. Actor-name prefixes and relation ownership confer no privilege.
    const version = this.#advanceRelation(materialId, payload.expected_version);
    const result = this.db.prepare(`UPDATE material_relations SET active = 0
      WHERE relation_id = ? AND active = 1`).run(current.relation_id);
    if (result.changes !== 1) throw new MurmError(ERROR_CODES.CONFLICT, 'supersede relation changed concurrently');
    this.#recordRelationEvent(current, 'revoked', envelope, reason, version);
    return { material: this.getMaterial(materialId), replacement: this.getMaterial(replacementMaterialId), relation: this.#relationView({ ...current, active: 0 }), relation_version: version };
  }

  #assertCorrectionCoordinator(envelope: any) {
    if (typeof this.taskService?.assertMissionCoordination !== 'function') {
      throw new MurmError(ERROR_CODES.SERVICE_NOT_READY, 'Material correction requires trusted Task-owned coordination authority at the commit boundary');
    }
    return this.taskService.assertMissionCoordination(envelope, 'unsupersede');
  }

  #assertExecutionFence(envelope: any) {
    if (typeof this.taskService?.materialScope !== 'function') throw new MurmError(ERROR_CODES.SERVICE_NOT_READY, 'Material writes require Task-owned Mission authority');
    return this.taskService.materialScope(envelope, { write: true });
  }

  #relationInScope(row: any, scope: any) {
    return this.taskService?.materialOriginMission?.(row.producer_task_id, row.producer_execution_id, row.actor_ref) === scope.mission_id &&
      this.#materialInScope(this.getMaterial(row.material_id), scope) &&
      (!row.replacement_material_id || this.#materialInScope(this.getMaterial(row.replacement_material_id), scope));
  }

  #assertMaterialScope(material: any, scope: any) {
    if (material && scope && !this.#materialInScope(material, scope)) throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Material or its recorded producer belongs to another Mission');
  }

  #materialInScope(material: any, scope: any) {
    if (!material || material.mission_id !== scope.mission_id) return false;
    if (!material.producer_task_id && !material.producer_execution_id) return true;
    return this.taskService?.materialOriginMission?.(material.producer_task_id, material.producer_execution_id, material.producer_agent_id) === scope.mission_id;
  }

  #scopeRead(payload: any, envelope: any) {
    const scope = this.taskService.materialScope(envelope);
    const requested = payload.mission_id;
    if (requested && requested !== scope.mission_id) throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Material query belongs to another Mission');
    const materialId = payload.material_id;
    if (materialId) this.#assertMaterialScope(this.getMaterial(materialId), scope);
    return { ...payload, mission_id: scope.mission_id };
  }

  #replay(operationId: any, fingerprint: any, originalFingerprint: any = null) {
    const row = this.db.prepare('SELECT fingerprint, result_json FROM operations WHERE operation_id = ?').get(operationId);
    if (!row) return null;
    if (row.fingerprint !== fingerprint && row.fingerprint !== originalFingerprint) throw new MurmError(ERROR_CODES.CONFLICT, 'operation_id was reused with another payload');
    return parse(row.result_json);
  }

  #saveOperation(operationId: any, operation: any, fingerprint: any, result: any) {
    this.db.prepare('INSERT INTO operations (operation_id, operation, fingerprint, result_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(operationId, operation, fingerprint, json(result), now());
  }

  #readSnapshot(callback: any) {
    if (this.db.isTransaction) return callback();
    this.db.exec('BEGIN');
    try {
      const result = callback();
      this.db.exec('COMMIT');
      return result;
    } catch (error: any) { try { this.db.exec('ROLLBACK'); } catch {} throw error; }
  }

  #transaction(callback: any) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.db.exec('COMMIT');
      return result;
    } catch (error: any) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  #lifecycleTransaction(callback: any) {
    if (this.taskService.db === this.db) return this.#transaction(callback);
    if (typeof this.taskService.withServiceLifecycleWrite !== 'function') {
      throw new MurmError(ERROR_CODES.SERVICE_NOT_READY, 'Material writes require the local Task lifecycle commit boundary');
    }
    return this.taskService.withServiceLifecycleWrite(() => this.#transaction(callback));
  }
}

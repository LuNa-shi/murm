import { createHash } from 'node:crypto';
import { stableStringify } from '../protocol/envelope.js';

const CONTEXT_OPERATIONS = new Set(['publish_material', 'consume_materials', 'dispute_material', 'supersede_material', 'unsupersede_material']);
const TERMINAL_TASKS = new Set(['DONE', 'CLOSED', 'CANCELED', 'SATISFIED', 'FAILED', 'CANCELLED', 'REJECTED']);
const COMPLETED_TASKS = new Set(['DONE', 'SATISFIED']);
const quote = value => `"${value.replaceAll('"', '""')}"`;
const time = value => value == null ? NaN : Date.parse(value);
const digest = value => createHash('sha256').update(stableStringify(value)).digest('hex');

function missing(domain, table, entityId, reason) {
  const error = new Error(`Cannot reconstruct ${domain} history for ${table}:${entityId ?? '*'}: ${reason}`);
  error.code = 'REPLAY_HISTORY_MISSING';
  error.details = { domain, table, entity_id: entityId ?? null, reason };
  return error;
}

function has(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function rows(db, table) {
  return has(db, table) ? db.prepare(`SELECT rowid AS __replay_rowid, * FROM ${quote(table)} ORDER BY rowid`).all() : [];
}

function columns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${quote(table)})`).all().map(column => column.name));
}

function belongs(operation, domain) {
  const actual = CONTEXT_OPERATIONS.has(operation) ? 'context' : operation === 'submit_check_result' ? 'judge' : 'task';
  return actual === domain;
}

function receipts(db, domain, cutoff) {
  return rows(db, 'operations').filter(row => belongs(row.operation, domain)).map(row => {
    let result = null, command = null;
    try { result = JSON.parse(row.result_json); } catch {
      if (time(row.created_at) <= cutoff) throw missing(domain, 'operations', row.operation_id, 'malformed result_json');
    }
    // A legacy fingerprint is a serialized command, not a hash. Some internal
    // historical callers serialized undefined; never evaluate that text as JS.
    try { command = JSON.parse(row.fingerprint); } catch { /* Only operations that need missing inputs fail below. */ }
    return { ...row, result, command, at: time(row.created_at) };
  }).sort((a, b) => a.at - b.at || a.__replay_rowid - b.__replay_rowid);
}

function prune(db, table, keep) {
  const statement = has(db, table) ? db.prepare(`DELETE FROM ${quote(table)} WHERE rowid = ?`) : null;
  for (const row of rows(db, table)) if (!keep(row)) statement.run(row.__replay_rowid);
}

function upsert(db, table, value) {
  const names = columns(db, table);
  const entries = Object.entries(value).filter(([key, item]) => names.has(key) && item !== undefined);
  const namesSql = entries.map(([key]) => quote(key)).join(', ');
  const primary = db.prepare(`PRAGMA table_info(${quote(table)})`).all().filter(column => column.pk).map(column => column.name);
  const update = entries.filter(([key]) => !primary.includes(key)).map(([key]) => `${quote(key)} = excluded.${quote(key)}`).join(', ');
  db.prepare(`INSERT INTO ${quote(table)} (${namesSql}) VALUES (${entries.map(() => '?').join(', ')})
    ON CONFLICT (${primary.map(quote).join(', ')}) DO ${update ? `UPDATE SET ${update}` : 'NOTHING'}`)
    .run(...entries.map(([, item]) => typeof item === 'boolean' ? Number(item) : item));
}

function encoded(value, fields) {
  const result = { ...value };
  for (const field of fields) if (Object.hasOwn(value, field)) result[`${field}_json`] = JSON.stringify(value[field]);
  return result;
}

function latestEntities(history, field, idField, cutoff) {
  const result = new Map();
  for (const receipt of history) {
    const value = receipt.result?.[field];
    if (receipt.at <= cutoff && value?.[idField]) result.set(value[idField], { value, at: receipt.at, sequence: receipt.__replay_rowid });
  }
  return result;
}

function trimTimestamp(db, table, cutoff, field = 'created_at') {
  prune(db, table, row => time(row[field]) <= cutoff);
}

function clearFuture(db, table, timeField, fields, cutoff) {
  if (!has(db, table)) return;
  const available = columns(db, table);
  const entries = Object.entries(fields).filter(([key]) => available.has(key));
  if (!available.has(timeField) || !entries.length) return;
  const update = db.prepare(`UPDATE ${quote(table)} SET ${entries.map(([key]) => `${quote(key)} = ?`).join(', ')} WHERE rowid = ?`);
  for (const row of rows(db, table)) if (time(row[timeField]) > cutoff) update.run(...entries.map(([, value]) => value), row.__replay_rowid);
}

function restoreMissionSubmissions(db, cutoff, warnings) {
  const retained = new Set();
  const identity = row => JSON.stringify([row.mission_id, row.submission_id]);
  const documents = new Map();
  for (const row of rows(db, 'mission_submissions')) {
    let document;
    try { document = JSON.parse(row.document); } catch {
      throw missing('task', 'mission_submissions', row.submission_id, 'malformed submission document');
    }
    if (!Number.isFinite(time(document.created_at))) {
      throw missing('task', 'mission_submissions', row.submission_id, 'submission creation time is absent');
    }
    documents.set(identity(row), document);
  }
  // A later live request occupies the one-inflight-per-Mission unique index.
  // Remove it before changing an earlier final request back to preparing.
  prune(db, 'mission_submissions', row => time(documents.get(identity(row)).created_at) <= cutoff);
  for (const row of rows(db, 'mission_submissions')) {
    let document = documents.get(identity(row));
    const active = ['preparing', 'pending'].includes(document.state);
    if (!active && !Number.isFinite(time(document.finished_at))) {
      throw missing('task', 'mission_submissions', row.submission_id, 'terminal submission has no finished_at');
    }
    retained.add(identity(row));
    if (active || time(document.finished_at) > cutoff) {
      // Old documents have no preparation timestamp. Their final main/material
      // snapshot may have been collected after T. Preserve the initial request
      // only; the fresh-run importer interrupts it instead of reviving a checker.
      const initialFields = ['mission_id', 'submission_id', 'workspace_id', 'actor_ref', 'task_id', 'execution_id',
        'fencing_version', 'material_ids', 'request_fingerprint', 'freeze_id', 'created_at', 'deadline', 'acceptance', 'checker'];
      document = { ...Object.fromEntries(initialFields.filter(field => Object.hasOwn(document, field)).map(field => [field, document[field]])),
        snapshot_fingerprint: '', state: 'preparing', result: null, freeze_epoch: null, release_pending: false, stop_pending: false };
      warnings.push({ table: 'mission_submissions', entity_id: row.submission_id,
        reason: 'Only the initial request is reconstructable before completion; its undated snapshot was excluded and fresh-run startup must interrupt the old request' });
    }
    upsert(db, 'mission_submissions', { ...row, state: document.state,
      snapshot_fingerprint: document.snapshot_fingerprint, document: JSON.stringify(document) });
  }
  prune(db, 'mission_submissions', row => retained.has(identity(row)));
  prune(db, 'mission_submission_audit', row => retained.has(identity(row)) && time(row.observed_at) <= cutoff);
  prune(db, 'mission_final_check_admissions', row => retained.has(identity(row)) && time(row.admitted_at) <= cutoff);
  clearFuture(db, 'mission_final_check_admissions', 'settled_at', { settled_at: null }, cutoff);
  prune(db, 'mission_manual_reviews', row => {
    if (!retained.has(identity(row))) return false;
    let document;
    try { document = JSON.parse(row.document); } catch {
      throw missing('task', 'mission_manual_reviews', row.request_id, 'malformed manual review document');
    }
    if (!Number.isFinite(time(document.observed_at))) {
      throw missing('task', 'mission_manual_reviews', row.request_id, 'manual review observation time is absent');
    }
    return time(document.observed_at) <= cutoff;
  });
  return retained.size;
}

function restoreNotifications(db, cutoff, warnings) {
  trimTimestamp(db, 'task_notifications', cutoff);
  for (const row of rows(db, 'task_notifications')) {
    if (time(row.delivered_at) <= cutoff) continue;
    // Attempts have no individual timestamps in old databases. Once first
    // delivery is after T, even an earlier failed attempt count is unknowable.
    // Start the fresh runtime's undelivered queue at zero, with an explicit
    // warning when that differs from a provable zero-at-T count.
    if (row.delivery_attempts > (row.delivered_at ? 1 : 0)) warnings.push({
      table: 'task_notifications', entity_id: row.notification_id,
      reason: 'Delivery attempts have no per-attempt history; the undelivered queue counter was reset to zero for fresh-run handoff',
    });
    upsert(db, 'task_notifications', { ...row, delivered_at: null, delivered_execution_id: null, delivery_attempts: 0 });
  }
  prune(db, 'task_notification_receipts', row => {
    if (!Number.isFinite(time(row.delivered_at))) warnings.push({
      table: 'task_notification_receipts', entity_id: `${row.notification_id}/${row.execution_id}`,
      reason: 'Undated delivery receipt was excluded from fresh-run handoff',
    });
    return time(row.delivered_at) <= cutoff;
  });
  for (const row of rows(db, 'task_notification_receipts')) if (row.delivery_attempts > 1) {
    upsert(db, 'task_notification_receipts', { ...row, delivery_attempts: 1 });
    warnings.push({ table: 'task_notification_receipts', entity_id: `${row.notification_id}/${row.execution_id}`,
      reason: 'Delivery retries have no per-attempt history; the counter was reset to the one known first delivery for fresh-run handoff' });
  }
  clearFuture(db, 'task_notifications', 'handled_at', { handled_at: null, handled_execution_id: null,
    handling_decision: null, handling_action: null, handling_json: '{}' }, cutoff);
  clearFuture(db, 'task_notification_receipts', 'handled_at', { handled_at: null,
    handling_decision: null, handling_action: null, handling_json: '{}' }, cutoff);
}

function restoreTasks(db, cutoff, history, warnings) {
  if (!has(db, 'tasks') || !has(db, 'modern_task_records')) throw missing('task', 'tasks', null, 'unsupported Task schema');
  const snapshots = latestEntities(history, 'task', 'task_id', cutoff);
  const executionSnapshots = latestEntities(history, 'execution', 'execution_id', cutoff);
  const modern = new Map(rows(db, 'modern_task_records').map(row => [row.task_id, row]));
  const originalTasks = rows(db, 'tasks');
  const originalExecutions = rows(db, 'executions');
  const retainedTasks = new Map();
  const existingRelations = rows(db, 'task_relations');
  const futureCreatedTasks = new Set(history.filter(row => row.at > cutoff && row.operation === 'create_task')
    .map(row => row.result?.task?.task_id).filter(Boolean));

  for (const row of originalTasks) {
    if (time(row.created_at) > cutoff) continue;
    const record = modern.get(row.task_id);
    if (!record) throw missing('task', 'modern_task_records', row.task_id, 'Mission binding is absent');
    let snapshot = snapshots.get(row.task_id);
    if (!snapshot && futureCreatedTasks.has(row.task_id)) continue;
    if (!snapshot && (time(row.updated_at) > cutoff || time(record.updated_at) > cutoff)) {
      throw missing('task', 'tasks', row.task_id, 'Task was changed after the requested time and no earlier operation result survives');
    }
    const canUseFinalRow = time(row.updated_at) <= cutoff && time(record.updated_at) <= cutoff;
    const historical = canUseFinalRow
      ? { ...(snapshot?.value ?? {}), ...row, mission_id: record.mission_id, summary: record.summary, gap: record.gap, timebox_ms: record.timebox_ms }
      : snapshot.value;
    for (const field of ['task_id', 'goal', 'expected_output', 'spec_version', 'spec_hash', 'state', 'state_version', 'summary', 'mission_id']) {
      if (!Object.hasOwn(historical, field)) throw missing('task', 'tasks', row.task_id, `historical result does not contain ${field}`);
    }
    const historicalRow = encoded(historical, ['acceptance_conditions', 'input_material_refs', 'completion_contract', 'workspace', 'retry_policy']);
    if (!canUseFinalRow) for (const field of columns(db, 'tasks')) {
      if (!Object.hasOwn(historicalRow, field) && row[field] !== null) {
        throw missing('task', 'tasks', row.task_id, `historical result does not contain stored field ${field}`);
      }
    }
    const task = { ...row, ...historicalRow };
    const relations = snapshot?.value.relations;
    if (!relations && !canUseFinalRow) throw missing('task', 'task_relations', row.task_id, 'historical Task relations are absent');
    const edges = relations
      ? [...(relations.spawned_from ?? []), ...(relations.depends_on ?? [])]
      : existingRelations.filter(edge => edge.task_id === row.task_id && time(edge.created_at) <= cutoff);
    retainedTasks.set(row.task_id, { task, edges, snapshotAt: canUseFinalRow ? time(row.updated_at) : snapshot.at });
    upsert(db, 'tasks', task);
    upsert(db, 'modern_task_records', { ...record, summary: historical.summary, gap: historical.gap ?? null,
      timebox_ms: historical.timebox_ms ?? record.timebox_ms,
      // This is a derived duplicate-admission key, not research content. NULL
      // selects the service's existing content-comparison compatibility path.
      registration_hash: time(record.updated_at) <= cutoff ? record.registration_hash : null,
      updated_at: historical.updated_at });
  }

  for (const table of ['task_relations']) if (has(db, table)) db.exec(`DELETE FROM ${quote(table)}`);
  for (const { task, edges } of retainedTasks.values()) for (const edge of edges) {
    if (!retainedTasks.has(edge.related_task_id)) throw missing('task', 'task_relations', edge.relation_id,
      `prerequisite ${edge.related_task_id} has no historical Task at the requested time`);
    if (time(edge.created_at) <= cutoff) upsert(db, 'task_relations', { ...edge, task_id: task.task_id });
  }

  const keepExecutions = new Set();
  for (const row of originalExecutions) {
    if (!retainedTasks.has(row.task_id) || time(row.created_at) > cutoff) continue;
    const prior = executionSnapshots.get(row.execution_id);
    const futureTake = history.some(receipt => receipt.at > cutoff && receipt.operation === 'task_take' && receipt.result?.execution?.execution_id === row.execution_id);
    if (!prior && futureTake) continue;
    keepExecutions.add(row.execution_id);
    if (prior) upsert(db, 'executions', { ...row,
      // These public fields must never fall through to the final row if an old
      // receipt predates their introduction. Unknown old runtime is discarded.
      terminal_reason: null, workspace_input_json: null, workspace_ref: null,
      workspace_revision: null, workspace_content_hash: null, checkpoint_ref: null,
      checkpoint_hash: null, handoff_metadata_json: null,
      ...encoded(prior.value, ['input_material_refs', 'workspace_input', 'workspace_selection',
        'handoff_metadata', 'steer_material_refs', 'wait_condition']),
    });
    else if (time(row.updated_at) > cutoff) {
      // Identity/provenance survives; unfinished old compute is not resumed.
      // Do not expose its later result through task.view's Execution history.
      upsert(db, 'executions', { ...row, state: 'CREATED', terminal_reason: null, workspace_input_json: null,
        workspace_ref: null, workspace_revision: null, workspace_content_hash: null,
        handoff_metadata_json: null, checkpoint_ref: null, checkpoint_hash: null, updated_at: row.created_at });
      warnings.push({ table: 'executions', entity_id: row.execution_id, reason: 'Only immutable provenance survives; later execution details were excluded' });
    }
  }
  prune(db, 'executions', row => keepExecutions.has(row.execution_id));
  prune(db, 'execution_finish_intents', row => keepExecutions.has(row.execution_id) && time(row.accepted_at) <= cutoff);
  clearFuture(db, 'execution_finish_intents', 'closed_at', { closed_at: null }, cutoff);
  const finishes = rows(db, 'execution_finish_intents').filter(row => row.closed_at && time(row.closed_at) <= cutoff)
    .sort((a, b) => time(a.closed_at) - time(b.closed_at) || a.__replay_rowid - b.__replay_rowid);
  for (const finish of finishes) {
    const execution = db.prepare('SELECT * FROM executions WHERE execution_id = ?').get(finish.execution_id);
    const prior = executionSnapshots.get(finish.execution_id);
    if (!prior || prior.at <= time(finish.closed_at)) upsert(db, 'executions', { ...execution,
      state: finish.terminal_state, terminal_reason: finish.reason, updated_at: finish.closed_at });
    const target = retainedTasks.get(execution.task_id);
    const requested = history.find(receipt => receipt.operation_id === finish.request_id)?.result?.task;
    const closedVersion = (requested?.state_version ?? target.task.state_version) + 1;
    if (target.snapshotAt > time(finish.closed_at) ||
        (target.snapshotAt === time(finish.closed_at) && target.task.state_version >= closedVersion)) continue;
    const state = finish.outcome === 'done' ? 'DONE' : finish.outcome === 'cancelled' ? 'CANCELLED' : 'OPEN';
    Object.assign(target.task, { state, block_reason: null, state_version: closedVersion, updated_at: finish.closed_at,
      cancelled_at: state === 'CANCELLED' ? finish.closed_at : null, eligible_at: state === 'OPEN' ? finish.closed_at : null });
    target.snapshotAt = time(finish.closed_at);
    upsert(db, 'tasks', target.task);
  }

  const keepTask = row => retainedTasks.has(row.task_id);
  for (const table of ['task_contract_revisions', 'task_creation_provenance', 'task_dependency_replacements', 'task_cancellations',
    'task_material_links', 'task_structure_events', 'task_structure_dependencies', 'task_structure_groups', 'task_creation_keys']) {
    prune(db, table, row => time(row.created_at) <= cutoff && (row.task_id === undefined || keepTask(row)));
  }
  clearFuture(db, 'task_material_links', 'accepted_at', { accepted_at: null, accepted_by_task_id: null, accepted_by_execution_id: null }, cutoff);
  for (const table of ['task_structure_dependencies', 'task_structure_groups', 'task_structure_members']) clearFuture(db, table, 'retired_at', { retired_at: null }, cutoff);
  prune(db, 'task_structure_members', row => time(row.added_at) <= cutoff && keepTask(row));
  prune(db, 'task_structure_groups', row => retainedTasks.has(row.owner_task_id));
  for (const row of rows(db, 'task_structure_versions')) {
    if (!keepTask(row)) continue;
    const events = rows(db, 'task_structure_events').filter(event => event.task_id === row.task_id);
    const latest = events.sort((a, b) => b.structural_version - a.structural_version)[0];
    if (time(row.updated_at) > cutoff) upsert(db, 'task_structure_versions', { ...row,
      structural_version: latest?.structural_version ?? 1, updated_at: latest?.created_at ?? retainedTasks.get(row.task_id).task.created_at });
  }

  // Reconcile derived Task dependency states after restoring all primary facts.
  // Active old owners are retired by the fresh-run importer, not here.
  const dependencyRows = rows(db, 'task_relations').filter(row => row.relation_kind === 'depends_on');
  for (const { task } of retainedTasks.values()) {
    if (TERMINAL_TASKS.has(task.state) || task.state === 'RUNNING') continue;
    const blockers = dependencyRows.filter(edge => edge.task_id === task.task_id && !COMPLETED_TASKS.has(retainedTasks.get(edge.related_task_id)?.task.state));
    if (blockers.length && task.state !== 'BLOCKED') {
      Object.assign(task, { state: 'BLOCKED', block_reason: blockers.map(edge => `dependency:${edge.relation_id}`).join(','), eligible_at: null });
    } else if (!blockers.length && task.state === 'BLOCKED' && String(task.block_reason).startsWith('dependency:') &&
        !rows(db, 'task_structure_dependencies').some(row => row.task_id === task.task_id && row.retired_at == null)) {
      Object.assign(task, { state: 'OPEN', block_reason: null, eligible_at: new Date(cutoff).toISOString() });
    }
    upsert(db, 'tasks', task);
  }

  prune(db, 'modern_task_records', keepTask);
  prune(db, 'tasks', keepTask);
  trimTimestamp(db, 'missions', cutoff);
  prune(db, 'bots', row => time(row.started_at) <= cutoff && Boolean(db.prepare('SELECT 1 FROM missions WHERE mission_id = ?').get(row.mission_id)));
  for (const bot of rows(db, 'bots')) if (bot.execution_id && !keepExecutions.has(bot.execution_id)) {
    db.prepare('UPDATE bots SET execution_id = NULL WHERE bot_id = ?').run(bot.bot_id);
  }
  // These rows are delivery/ownership state, not the public research record.
  // Drop future identities and events so a new core cannot read future details.
  for (const table of ['take_keys', 'wait_keys', 'wake_keys', 'task_rework_links']) trimTimestamp(db, table, cutoff);
  restoreNotifications(db, cutoff, warnings);
  const submissions = restoreMissionSubmissions(db, cutoff, warnings);
  pruneOrphanReferences(db);
  return { tasks: retainedTasks.size, executions: keepExecutions.size, relations: rows(db, 'task_relations').length, submissions };
}

function pruneOrphanReferences(db) {
  const operational = ['task_creation_keys', 'task_structure_versions', 'task_admission_policies', 'task_structure_members',
    'task_notification_receipts', 'task_notifications', 'take_keys', 'wait_keys', 'wake_keys', 'execution_admission_counters',
    'turn_admission_counters', 'task_rework_links'];
  for (let pass = 0; pass < 2; pass++) for (const table of operational) {
    if (!has(db, table)) continue;
    for (const reference of db.prepare(`PRAGMA foreign_key_list(${quote(table)})`).all()) {
      db.exec(`DELETE FROM ${quote(table)} WHERE ${quote(reference.from)} IS NOT NULL AND NOT EXISTS
        (SELECT 1 FROM ${quote(reference.table)} parent WHERE parent.${quote(reference.to)} = ${quote(table)}.${quote(reference.from)})`);
    }
  }
}

function restoreContext(db, cutoff, history) {
  if (!has(db, 'materials')) throw missing('context', 'materials', null, 'Material table is absent');
  const materials = rows(db, 'materials').filter(row => time(row.created_at) <= cutoff);
  const materialIds = new Set(materials.map(row => row.material_id));
  const allEvents = rows(db, 'material_relation_events');
  const relations = rows(db, 'material_relations');
  const events = new Map(allEvents.map(row => [`${row.operation_id}:${row.relation_id}:${row.action}`, row]));
  for (const receipt of history) {
    const relation = receipt.result?.relation;
    if (!relation?.relation_id) continue;
    const action = receipt.operation === 'unsupersede_material' ? 'revoked' : 'created';
    const key = `${receipt.operation_id}:${relation.relation_id}:${action}`;
    if (!events.has(key)) {
      const envelope = receipt.command?.envelope;
      if (!envelope || !Number.isFinite(receipt.at)) throw missing('context', 'material_relation_events', relation.relation_id,
        'correction event is absent and its operation command cannot reconstruct the actor and time');
      events.set(key, { event_id: `replay:${receipt.operation_id}:${action}`, relation_id: relation.relation_id,
        material_id: relation.material_id, action, operation_id: receipt.operation_id, actor_ref: envelope.actor_ref,
        source_task: envelope.task_id, source_execution: envelope.execution_id,
        reason: receipt.command.payload?.reason ?? relation.reason ?? 'Recovered from operation receipt',
        relation_version: action === 'revoked' ? receipt.result.relation_version ?? receipt.result.material?.relation_version : relation.version,
        created_at: receipt.created_at });
    }
  }
  const corrections = [...events.values()];
  const retainedRelations = relations.filter(row => time(row.created_at) <= cutoff && materialIds.has(row.material_id) &&
    (!row.replacement_material_id || materialIds.has(row.replacement_material_id)));
  for (const relation of retainedRelations) {
    const revocations = corrections.filter(event => event.relation_id === relation.relation_id && event.action === 'revoked');
    if (!relation.active && !revocations.length) throw missing('context', 'material_relations', relation.relation_id,
      'inactive relation has no revocation event or operation receipt identifying when it was revoked');
    const active = !revocations.some(event => time(event.created_at) <= cutoff);
    db.prepare('UPDATE material_relations SET active = ? WHERE relation_id = ?').run(Number(active), relation.relation_id);
  }
  const retainedRelationIds = new Set(retainedRelations.map(row => row.relation_id));
  prune(db, 'material_relation_events', row => retainedRelationIds.has(row.relation_id) && time(row.created_at) <= cutoff);
  for (const event of corrections) if (has(db, 'material_relation_events') && retainedRelationIds.has(event.relation_id) && time(event.created_at) <= cutoff) {
    upsert(db, 'material_relation_events', event);
  }
  prune(db, 'material_relations', row => retainedRelationIds.has(row.relation_id));
  prune(db, 'material_attachments', row => materialIds.has(row.material_id));
  prune(db, 'material_consumptions', row => materialIds.has(row.material_id) && time(row.created_at) <= cutoff);
  prune(db, 'materials', row => materialIds.has(row.material_id));
  if (has(db, 'material_relation_heads')) {
    db.exec('DELETE FROM material_relation_heads');
    const supersedes = new Set(retainedRelations.filter(row => row.relation_kind === 'supersede').map(row => row.relation_id));
    for (const material of materials) {
      const versions = corrections.filter(event => event.material_id === material.material_id && supersedes.has(event.relation_id) && time(event.created_at) <= cutoff)
        .map(event => event.relation_version);
      versions.push(...retainedRelations.filter(row => row.material_id === material.material_id && row.relation_kind === 'supersede').map(row => row.version));
      upsert(db, 'material_relation_heads', { material_id: material.material_id, version: Math.max(0, ...versions) });
    }
  }
  for (const material of materials) {
    let content;
    try { content = JSON.parse(material.content_json); } catch { throw missing('context', 'materials', material.material_id, 'malformed immutable content_json'); }
    const attachments = rows(db, 'material_attachments').filter(row => row.material_id === material.material_id).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const attachment of attachments) if (createHash('sha256').update(attachment.bytes).digest('hex') !== attachment.content_hash) {
      throw missing('context', 'material_attachments', `${material.material_id}/${attachment.name}`, 'attachment bytes do not match the stored hash');
    }
    const manifest = attachments.map(({ name, media_type, content_hash, bytes }) => ({ name, media_type, content_hash, size_bytes: bytes.length }));
    if (digest(manifest.length ? { content, attachments: manifest } : content) !== material.content_hash) {
      throw missing('context', 'materials', material.material_id, 'immutable content or attachment set is missing or corrupt');
    }
  }
  return { materials: materials.length, relations: retainedRelations.length, consumptions: rows(db, 'material_consumptions').length };
}

function restoreJudge(db, cutoff, history, warnings) {
  if (!has(db, 'check_results')) throw missing('judge', 'check_results', null, 'Judge result table is absent');
  const byCheck = new Map();
  for (const receipt of history) if (receipt.at <= cutoff && receipt.result?.check_result_id) byCheck.set(receipt.result.check_result_id, receipt);
  const keep = new Set();
  const admissions = new Map(rows(db, 'judge_mission_check_admissions').map(row => [row.check_result_id, row]));
  for (const row of rows(db, 'check_results')) {
    if (time(row.created_at) > cutoff) continue;
    const receipt = byCheck.get(row.check_result_id);
    const futureOnlyReceipt = history.some(event => event.at > cutoff && event.result?.check_result_id === row.check_result_id);
    // Direct submit has no earlier request row; its receipt is its existence
    // boundary, even when row.created_at was assigned just before the commit.
    if (!receipt && futureOnlyReceipt && !admissions.has(row.check_result_id)) continue;
    keep.add(row.check_result_id);
    if (receipt) {
      const restored = encoded({ ...row, ...receipt.result }, ['evidence']);
      if (row.applied_at && time(row.applied_at) <= cutoff) Object.assign(restored, {
        status: 'APPLIED', applied_at: row.applied_at, applied_task_state_version: row.applied_task_state_version,
      });
      else Object.assign(restored, { applied_at: null, applied_task_state_version: null });
      upsert(db, 'check_results', restored);
    } else if (time(row.updated_at) > cutoff || futureOnlyReceipt) {
      const evidence = JSON.parse(row.evidence_json);
      const admission = admissions.get(row.check_result_id);
      const started = admission?.started_at && time(admission.started_at) <= cutoff;
      upsert(db, 'check_results', { ...row, status: started ? 'RUNNING' : 'REQUESTED', verdict: null,
        judge_operation_status: 'accepted', checker_process_status: 'not_started', result_class: 'unassessed',
        retryable: 0, diagnostic_code: null, evidence_json: JSON.stringify(evidence?.workspace_input ? { workspace_input: evidence.workspace_input } : {}),
        applied_at: null, applied_task_state_version: null, updated_at: started ? admission.started_at : row.created_at });
    }
  }
  prune(db, 'check_results', row => keep.has(row.check_result_id));
  prune(db, 'judge_request_aliases', row => keep.has(row.check_result_id) && time(row.created_at) <= cutoff);
  prune(db, 'judge_mission_check_admissions', row => keep.has(row.check_result_id) && time(row.admitted_at) <= cutoff);
  clearFuture(db, 'judge_mission_check_admissions', 'settled_at', { settled_at: null }, cutoff);
  clearFuture(db, 'judge_mission_check_admissions', 'started_at', { started_at: null }, cutoff);
  const removedHealth = rows(db, 'checker_preflights').filter(row => time(row.last_seen_at) > cutoff).length;
  prune(db, 'checker_preflights', row => time(row.last_seen_at) <= cutoff);
  if (removedHealth) warnings.push({ table: 'checker_preflights', reason: 'Later environment health observations were excluded; a fresh run must preflight its own checker' });
  return { checks: keep.size, completed_checks: rows(db, 'check_results').filter(row => row.verdict !== null).length };
}

/** Reconstruct an already-copied legacy service DB from durable historical
 * facts. This never invokes a live service, model, checker, or old execution.
 * The caller disables automatic history capture on the destination beforehand
 * and retires old runtime ownership after all service domains are restored. */
export function projectLegacyServiceState(db, { domain, at } = {}) {
  if (!['task', 'context', 'judge'].includes(domain)) throw new TypeError('domain must be task, context, or judge');
  const cutoff = at instanceof Date || typeof at === 'number' ? Number(new Date(at)) : time(at);
  if (!Number.isFinite(cutoff)) throw new TypeError('at must identify a valid time');
  if (db.isTransaction) throw new TypeError('Legacy reconstruction requires its own transaction on a destination copy');
  const history = receipts(db, domain, cutoff);
  const warnings = [];
  const foreignKeys = db.prepare('PRAGMA foreign_keys').get().foreign_keys;
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN IMMEDIATE');
  try {
    const counts = domain === 'task' ? restoreTasks(db, cutoff, history, warnings)
      : domain === 'context' ? restoreContext(db, cutoff, history)
        : restoreJudge(db, cutoff, history, warnings);
    prune(db, 'operations', row => !belongs(row.operation, domain) || time(row.created_at) <= cutoff);
    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length) throw missing(domain, violations[0].table, violations[0].rowid, `missing referenced row in ${violations[0].parent}`);
    db.exec('COMMIT');
    return { domain, at: new Date(cutoff).toISOString(), mode: 'legacy', counts, warnings };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.exec(`PRAGMA foreign_keys = ${Number(foreignKeys)}`);
  }
}

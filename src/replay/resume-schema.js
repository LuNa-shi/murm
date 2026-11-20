import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { stableStringify } from '../protocol/envelope.js';
import { SCHEMA_SQL } from '../storage/schema.js';
import { CONTEXT_SCHEMA_SQL } from '../storage/context-schema.js';
import { JUDGE_SCHEMA_SQL } from '../storage/judge-schema.js';

const quote = value => `"${value.replaceAll('"', '""')}"`;
const has = (db, table) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));

function incompatible(domain, table, entity, reason) {
  const error = new Error(`Cannot import historical ${domain} table ${table}: ${reason}`);
  error.code = 'REPLAY_SCHEMA_INCOMPATIBLE';
  error.details = { domain, table, entity_id: entity, reason };
  return error;
}

/** Admission keys follow the current public Task contract while stored spec
 * hashes remain bound to their historical executions and checks. */
export function resumedTaskRegistrationHash(task, record, relations) {
  const content = { summary: record.summary, gap: record.gap, expected_output: task.expected_output,
    acceptance_conditions: JSON.parse(task.acceptance_conditions_json), priority: task.priority,
    workspace: JSON.parse(task.workspace_json), input_material_refs: [...new Set(JSON.parse(task.input_material_refs_json))].sort(),
    task_instructions: task.task_instructions, depends_on: [...new Set(relations)].sort(), timebox_ms: record.timebox_ms };
  return createHash('sha256').update(stableStringify(content)).digest('hex');
}

function rebuild(db, catalog, source, target, transform) {
  const temporary = `${target}_resume_import`;
  const definition = catalog.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(target).sql;
  db.exec(definition.replace(/^CREATE TABLE\s+\S+/i, `CREATE TABLE ${quote(temporary)}`));
  const names = new Set(catalog.prepare(`PRAGMA table_info(${quote(target)})`).all().map(column => column.name));
  for (const original of db.prepare(`SELECT * FROM ${quote(source)} ORDER BY rowid`).all()) {
    const value = transform(original);
    if (!value) continue;
    const entries = Object.entries(value).filter(([name, item]) => names.has(name) && item !== undefined);
    db.prepare(`INSERT INTO ${quote(temporary)} (${entries.map(([name]) => quote(name)).join(', ')})
      VALUES (${entries.map(() => '?').join(', ')})`).run(...entries.map(([, item]) => item));
  }
  db.exec(`DROP TABLE ${quote(source)}; ALTER TABLE ${quote(temporary)} RENAME TO ${quote(target)}`);
  for (const index of catalog.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL").all(target)) {
    db.exec(index.sql);
  }
}

/** Convert only a reconstructed destination, after history rewind and before
 * opening current services. Public content and historical IDs stay intact. */
export function upgradeResumedServiceDatabase(db, { domain }) {
  if (!['task', 'context', 'judge'].includes(domain)) throw new TypeError('Unknown replay service domain');
  if (db.isTransaction) throw new TypeError('Historical schema conversion requires its own transaction');
  const legacyTask = domain === 'task' && has(db, 'modern_task_records');
  const legacyContext = domain === 'context' && db.prepare('PRAGMA table_info(materials)').all().some(column => column.name === 'source_task');
  if (!legacyTask && !legacyContext) return { domain, converted: false, warnings: [] };
  const warnings = [];
  const catalog = new DatabaseSync(':memory:');
  catalog.exec(domain === 'task' ? SCHEMA_SQL : CONTEXT_SCHEMA_SQL);
  const foreignKeys = db.prepare('PRAGMA foreign_keys').get().foreign_keys;
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN IMMEDIATE');
  try {
    if (legacyTask) {
      if (has(db, 'task_records')) throw incompatible(domain, 'task_records', null, 'both old and current Task record tables are present');
      if (has(db, 'task_structure_dependencies')) {
        const unsupported = db.prepare("SELECT * FROM task_structure_dependencies WHERE retired_at IS NULL AND dependency_kind <> 'TASK' LIMIT 1").get();
        if (unsupported) throw incompatible(domain, 'task_structure_dependencies', unsupported.dependency_id,
          `active ${unsupported.dependency_kind} dependency cannot be represented by the current Task contract`);
        for (const dependency of db.prepare("SELECT * FROM task_structure_dependencies WHERE retired_at IS NULL AND dependency_kind = 'TASK'").all()) {
          db.prepare(`INSERT OR IGNORE INTO task_relations
            (relation_id, mission_id, task_id, relation_kind, related_task_id, created_by_task_id, created_by_execution_id, created_by, created_at)
            VALUES (?, (SELECT mission_id FROM modern_task_records WHERE task_id = ?), ?, 'depends_on', ?, ?, ?, ?, ?)`)
            .run(dependency.dependency_id, dependency.task_id, dependency.task_id, dependency.prerequisite_task_id,
              dependency.created_by_task_id, dependency.created_by_execution_id, dependency.created_by_actor_ref, dependency.created_at);
        }
      }
      rebuild(db, catalog, 'tasks', 'tasks', row => {
        const contract = JSON.parse(row.completion_contract_json);
        if (contract.required_materials?.some(requirement => typeof requirement !== 'object' || !requirement ||
            Object.keys(requirement).some(field => !['role', 'min_count', 'requires_consumption', 'action', 'cross_task'].includes(field)))) {
          throw incompatible(domain, 'tasks', row.task_id, 'required_materials contains archived conditions the current service cannot enforce');
        }
        const retired = ['required_children', 'required_branch_groups', 'required_subtask_groups', 'parent_review', 'required_artifact']
          .find(field => Object.hasOwn(contract, field));
        if (retired) throw incompatible(domain, 'tasks', row.task_id, `${retired} has no current completion semantics`);
        const state = { CANCELLED: 'CANCELED', SATISFIED: 'DONE', WAITING: 'RUNNING' }[row.state] ?? row.state;
        if (!['OPEN', 'BLOCKED', 'RUNNING', 'DONE', 'CANCELED'].includes(state)) {
          throw incompatible(domain, 'tasks', row.task_id, `Task state ${row.state} has no current equivalent`);
        }
        if (state !== row.state) warnings.push({ table: 'tasks', entity_id: row.task_id,
          reason: `Archived state ${row.state} is represented as ${state} before fresh-run handoff` });
        return { ...row, state };
      });
      rebuild(db, catalog, 'executions', 'executions', row => {
        const state = row.state === 'WAITING' ? 'CREATED' : row.state === 'SUPERSEDED' ? 'HANDED_OFF' : row.state;
        if (state !== row.state) warnings.push({ table: 'executions', entity_id: row.execution_id,
          reason: `Archived state ${row.state} is represented as ${state} before fresh-run handoff` });
        return { ...row, state };
      });
      rebuild(db, catalog, 'task_relations', 'task_relations', row => {
        if (row.relation_kind === 'depends_on') return row;
        warnings.push({ table: 'task_relations', entity_id: row.relation_id,
          reason: 'Archived proposal-origin relation has no current scheduling semantics; its historical operation receipts remain available' });
        return null;
      });
      rebuild(db, catalog, 'modern_task_records', 'task_records', row => {
        const record = { ...row, gap: row.gap ?? row.summary };
        if (row.gap == null) warnings.push({ table: 'task_records', entity_id: row.task_id,
          reason: 'The archived Task has no gap field; its preserved summary supplies the current trusted-owner default' });
        const task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(row.task_id);
        const dependencies = db.prepare('SELECT related_task_id FROM task_relations WHERE task_id = ?').all(row.task_id).map(edge => edge.related_task_id);
        return { ...record, registration_hash: resumedTaskRegistrationHash(task, record, dependencies) };
      });
      // Task stores also contain the Judge compatibility tables used by local
      // service calls. Their schema is unchanged at the supported archive base.
      db.exec(JUDGE_SCHEMA_SQL);
    } else {
      for (const table of ['materials', 'material_relations', 'material_relation_events']) {
        rebuild(db, catalog, table, table, row => ({ ...row,
          producer_task_id: row.source_task ?? null, producer_execution_id: row.source_execution ?? null,
          ...(table === 'materials' ? { provenance_json: JSON.stringify({ ...JSON.parse(row.provenance_json),
            historical_metadata: Object.fromEntries(['kind', 'role', 'scope', 'evidence_state', 'content_ref', 'evidence_json']
              .filter(field => Object.hasOwn(row, field)).map(field => [field, row[field]])),
          }) } : {}),
        }));
      }
      warnings.push({ table: 'materials', reason: 'Archived Material classification and evidence metadata are retained in stored provenance.historical_metadata; current public views expose content, producer, attachment and correction fields' });
    }
    const violation = db.prepare('PRAGMA foreign_key_check').get();
    if (violation) throw incompatible(domain, violation.table, violation.rowid, `missing reference in ${violation.parent}`);
    db.exec('COMMIT');
    return { domain, converted: true, warnings };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    catalog.close();
    db.exec(`PRAGMA foreign_keys = ${Number(foreignKeys)}`);
  }
}

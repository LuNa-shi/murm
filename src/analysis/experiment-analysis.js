import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { storedCheckerProcessStatus, storedResultClass } from '../judge/check-result.js';

// Reports are written for human review. Five-minute windows keep the narrative
// bounded while still allowing an objective change, Judge result, handoff, or
// wait to split a window earlier.
const DEFAULT_MAX_WINDOW_MS = 5 * 60 * 1000;
const SILENT_GAP_MS = 5 * 60 * 1000;
const MAX_SOURCE_ERRORS = 20;

const EVIDENCE_CLASSES = [
  'metadata', 'agent', 'bridge', 'runtime', 'service', 'judge', 'sqlite',
  'observation', 'workspace', 'summary',
];

const SENSITIVE_KEYS = /(?:^|_)(?:authorization|content|credential|formal_source|password|private_key|proof|raw_transcript|secret|stderr|stdout|task_instructions|token|api_key|agent_prompt|candidate_source)(?:$|_)/i;
const SAFE_RESULT_KEYS = new Set([
  'task_id', 'root_id', 'parent_id', 'execution_id', 'owner_ref', 'task_type',
  'state', 'task_state', 'execution_state', 'state_version', 'attempt_no',
  'fencing_version', 'runtime_generation', 'workspace_ref', 'workspace_revision',
  'workspace_content_hash', 'artifact_material_id', 'material_id', 'kind',
  'scope', 'evidence_state', 'source_task', 'source_execution', 'check_result_id',
  'request_key', 'target_task_id', 'target_spec_version', 'status', 'verdict',
  'checker_ref', 'checker_version', 'environment_ref', 'operation_id',
  'wait_condition', 'wait_condition_type', 'deadline', 'terminal_state',
  'task_count', 'material_count', 'services', 'tools', 'changed_files',
  'workspace_revision_start', 'workspace_revision_end', 'progress_kind',
  'tool', 'operation', 'outcome', 'phase', 'service', 'error', 'stream', 'type',
  'event', 'decision', 'diagnostic', 'session_transport_id', 'file_count',
  'content_hash', 'assignment_basis', 'target_task_id', 'target_execution_id', 'authority_execution_id', 'parent_execution_id', 'parent_task_id', 'result', 'task', 'execution', 'material', 'check_result',
  'material_ids', 'count', 'artifact_material_id', 'diagnostic_class', 'judge_operation_status',
  'checker_process_status', 'process_status', 'result_class', 'mathematical_outcome', 'retryable', 'checker_started',
  'checker_ref', 'checker_version', 'environment_ref', 'checker_result_available',
  'diagnostic_code', 'preflight_key', 'preflight_status', 'retry_exhausted', 'infrastructure_attempt_count',
  'health_fingerprint', 'preflight_supported', 'preflight_verified', 'input_binding_verified', 'toolchain_version_verified',
  'checker_ref_verified', 'checker_version_verified', 'checker_identity_verified', 'expected_checker_ref', 'observed_checker_ref',
  'expected_checker_version', 'observed_checker_version',
]);

const INTENT_BY_OPERATION = new Map([
  ['list_services', 'discover services'],
  ['list_tools', 'discover tools'],
  ['list_tasks', 'discover available work'],
  ['list_executions', 'inspect execution history'],
  ['get_task', 'inspect task contract'],
  ['get_execution', 'inspect execution state'],
  ['get_workspace', 'inspect Workspace'],
  ['list_workspace_revisions', 'inspect Workspace lineage'],
  ['list_workspace_files', 'inspect Workspace files'],
  ['read_workspace_file', 'inspect a Workspace file'],
  ['workspace_diff', 'inspect Workspace changes'],
  ['task_take', 'take a Task'],
  ['create_child_task', 'decompose the Task'],
  ['save_workspace_revision', 'save a Workspace revision'],
  ['write_workspace_file', 'edit the Workspace'],
  ['publish_material', 'publish a Material'],
  ['read_materials', 'read Materials'],
  ['consume_materials', 'record Material use'],
  ['workspace_check', 'submit a Candidate'],
  ['get_check_result', 'inspect Judge feedback'],
  ['apply_check_result', 'process Judge feedback'],
  ['wait_for', 'wait for a concrete condition'],
  ['wake_execution', 'wake an Execution'],
  ['resume_execution', 'resume an Execution'],
  ['accept_task', 'review and accept a Task'],
  ['request_rework', 'review and request rework'],
  ['heartbeat', 'maintain the Execution lease'],
  ['scheduler_status', 'inspect scheduler status'],
]);

const BOUNDARY_KINDS = new Set([
  'task_created', 'task_taken', 'task_state_changed', 'execution_assigned',
  'execution_state_changed', 'workspace_revision', 'material_published',
  'material_read', 'material_consumed', 'workspace_checked', 'judge_result', 'judge_check',
  'wait_for_requested', 'wake', 'resume', 'review', 'rework', 'execution_terminal',
]);

function hash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function jsonParse(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

const BOUNDED_OPERATOR_ID_KEYS = ['material_ids', 'source_task_ids'];

function boundedOperatorIds(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'string').slice(0, 100)
    : null;
}

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}

function text(value, max = 180) {
  if (value === null || value === undefined) return null;
  const result = String(value).replace(/\s+/g, ' ').trim();
  if (!result) return null;
  return result.length <= max ? result : `${result.slice(0, max - 1)}…`;
}

function parseTime(value) {
  if (value === null || value === undefined || value === '') return null;
  const milliseconds = typeof value === 'number' ? value : Date.parse(String(value));
  if (!Number.isFinite(milliseconds)) return null;
  return new Date(milliseconds).toISOString();
}

function timeMs(value) {
  if (!value) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function pathInside(root, candidate) {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  const rel = relative(rootPath, candidatePath);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith('..\\') && !rel.startsWith('/'));
}

function sourcePath(root, candidate) {
  const candidatePath = resolve(candidate);
  if (pathInside(root, candidatePath)) { const rel = relative(root, candidatePath).split(sep).join('/'); return rel || '.'; }
  return `<external>/${basename(candidatePath)}`;
}

function sourceRef(root, candidate, suffix = '') {
  const base = sourcePath(root, candidate);
  return suffix ? `${base}${suffix}` : base;
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

async function isDirectory(path) {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

async function isRegularFile(path) {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

async function listFiles(path, suffix = null) {
  if (!(await isDirectory(path))) return [];
  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(child, suffix));
    else if (!suffix || entry.name.endsWith(suffix)) files.push(child);
  }
  return files;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function safeResult(value, depth = 0) {
  if (depth > 3 || value === null || value === undefined) return value ?? null;
  if (typeof value !== 'object') {
    if (typeof value === 'string') return text(value, 180);
    return value;
  }
  if (Array.isArray(value)) {
    const safe = value.slice(0, 20).map((item) => safeResult(item, depth + 1));
    if (value.length > 20) safe.push(`[${value.length - 20} items omitted]`);
    return safe;
  }
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEYS.test(key)) continue;
    if (SAFE_RESULT_KEYS.has(key) || depth > 0) {
      if (key === 'services' || key === 'tools') {
        result[key] = array(child).slice(0, 20).map((item) => safeResult(item, depth + 1));
      } else if (key === 'changed_files') {
        result[key] = array(child).map((item) => text(item, 120)).filter(Boolean).slice(0, 20);
      } else {
        result[key] = safeResult(child, depth + 1);
      }
    }
  }
  return result;
}

function safeEntity(value, type) {
  if (!isObject(value)) return null;
  const result = {};
  const keys = type === 'task'
    ? ['task_id', 'root_id', 'parent_id', 'owner_ref', 'task_type', 'state', 'state_version', 'goal', 'created_at', 'updated_at', 'block_reason']
    : type === 'execution'
      ? ['execution_id', 'task_id', 'owner_ref', 'state', 'state_version', 'attempt_no', 'fencing_version', 'runtime_generation', 'workspace_ref', 'workspace_revision', 'artifact_material_id', 'wait_condition', 'wait_deadline', 'created_at', 'updated_at']
      : type === 'material'
        ? ['material_id', 'kind', 'scope', 'evidence_state', 'source_task', 'source_execution', 'version', 'created_at']
        : type === 'check_result'
          ? ['check_result_id', 'request_key', 'artifact_material_id', 'target_task_id', 'execution_id', 'status', 'verdict', 'judge_operation_status', 'checker_process_status', 'result_class', 'retryable', 'diagnostic_code', 'checker_ref', 'checker_version', 'environment_ref', 'diagnostic_class', 'created_at', 'updated_at']
          : [...SAFE_RESULT_KEYS];
  for (const key of keys) {
    if (!(key in value) || SENSITIVE_KEYS.test(key)) continue;
    if (key === 'goal') result[key] = text(value[key], 180);
    else if (key === 'wait_condition') {
      const condition = value[key];
      result[key] = isObject(condition) ? {
        type: text(condition.type, 80),
        check_request_key: text(condition.check_request_key ?? condition.request_key, 120),
        child_task_id: text(condition.child_task_id, 120),
        preflight_key: text(condition.preflight_key, 120),
        health_fingerprint: text(condition.health_fingerprint, 120),
        diagnostic_code: text(condition.diagnostic_code, 120),
      } : null;
    } else result[key] = safeResult(value[key]);
  }
  return result;
}

function diagnosticClass(value) {
  const message = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!message) return 'unknown';
  if (/unsolved goals|failed to prove the goal/i.test(message)) return 'unsolved_goals';
  if (/(?:aesop|simp).*no progress|made no progress/i.test(message)) return 'tactic_no_progress';
  if (/rcases failed|not an inductive datatype/i.test(message)) return 'tactic_shape_error';
  if (/type mismatch|unknown identifier|application type mismatch/i.test(message)) return 'lean_type_error';
  if (/sorry|admit|axiom/i.test(message)) return 'forbidden_placeholder';
  if (/timed out|timeout/i.test(message)) return 'checker_timeout';
  return 'lean_checker_error';
}

function errorInfo(fact) {
  const error = fact.summary?.error;
  if (isObject(error)) return { code: text(error.code, 80) ?? 'UNKNOWN', message: text(error.message, 180) ?? '' };
  if (error) return { code: 'TOOL_ERROR', message: text(error, 180) ?? '' };
  return null;
}

function errorCategory(info, fact) {
  const message = info?.message ?? '';
  if (info?.code === 'CONFLICT' && /active Execution quota/i.test(message)) return 'take_active_execution_quota';
  if (info?.code === 'NOT_ALLOWED' && /does not require a CheckResult/i.test(message)) return 'check_result_contract_mismatch';
  if (fact.kind === 'tool_call' && info?.code === 'TOOL_ERROR') return 'agent_tool_error';
  return `${String(info?.code ?? 'UNKNOWN').toLowerCase()}_${fact.operation ?? fact.kind}`;
}

function entityFromResult(result, key) {
  if (!isObject(result)) return null;
  if (isObject(result[key])) return result[key];
  if (key === 'check_result' && isObject(result.checkResult)) return result.checkResult;
  return null;
}

function idsFromEntity(entity) {
  if (!isObject(entity)) return {};
  return {
    taskId: entity.task_id ?? entity.target_task_id ?? null,
    executionId: entity.execution_id ?? null,
    materialId: entity.material_id ?? entity.artifact_material_id ?? null,
    checkResultId: entity.check_result_id ?? null,
  };
}

function envelopeIds(envelope) {
  if (!isObject(envelope)) return {};
  return {
    taskId: envelope.task_id ?? null,
    executionId: envelope.execution_id ?? null,
    correlationId: envelope.operation_id ?? null,
  };
}

function coreFromScope(scope) {
  const match = String(scope ?? '').match(/(?:agent|bridge|runtime):((?:core|worker)[^:]+|core-\d+)/i);
  return match?.[1]?.startsWith('core-') ? match[1] : null;
}

function operationFromTool(toolName) {
  const operation = text(String(toolName ?? '').replace(/^swarmenv_(?:task|execution|workspace|context|judge|catalog)_/, ''), 100);
  return operation === 'take' ? 'task_take' : operation;
}

function intentFor(operation, kind = null) {
  if (operation && INTENT_BY_OPERATION.has(operation)) return INTENT_BY_OPERATION.get(operation);
  if (kind === 'judge_result' || kind === 'judge_check') return 'process Judge feedback';
  if (kind === 'workspace_revision') return 'edit the Workspace';
  if (kind === 'material_published') return 'publish a Material';
  if (kind === 'material_read') return 'read Materials';
  if (kind === 'material_consumed') return 'record Material use';
  if (kind === 'execution_assigned') return 'take or resume a Task';
  if (kind === 'wait_for_requested') return 'wait for a concrete condition';
  if (kind === 'review' || kind === 'rework') return 'review a child result';
  return 'unknown';
}

function factIdentity(kind, source, discriminator = '') {
  return `F-${hash(`${kind}|${source}|${discriminator}`).slice(0, 12)}`;
}

function makeFact(root, {
  kind, at = null, source, taskId = null, executionId = null, sessionId = null,
  coreId = null, correlationId = null, operation = null, summary = {}, priority = 4,
  preserveBoundedOperatorIds = false,
}) {
  const sourceValue = source.ref ?? source.path ?? String(source);
  const discriminator = [taskId, executionId, sessionId, coreId, correlationId, operation, JSON.stringify(summary)].join('|');
  const safeSummary = safeResult(summary) ?? {};
  if (preserveBoundedOperatorIds && isObject(summary) && isObject(safeSummary)) {
    for (const key of BOUNDED_OPERATOR_ID_KEYS) {
      const ids = boundedOperatorIds(summary[key]);
      if (!ids) continue;
      safeSummary[key] = ids;
      if (summary[key].length > ids.length) safeSummary[`${key}_truncated`] = true;
    }
  }
  return {
    id: factIdentity(kind, sourceValue, discriminator),
    kind,
    at: parseTime(at),
    taskId: taskId ?? null,
    executionId: executionId ?? null,
    sessionId: sessionId ?? null,
    coreId: coreId ?? null,
    correlationId: correlationId ?? null,
    operation: operation ?? null,
    summary: safeSummary,
    sources: [sourceValue],
    priority,
  };
}

function addSource(fact, source) {
  const ref = source.ref ?? source.path ?? String(source);
  if (!fact.sources.includes(ref)) fact.sources.push(ref);
  return fact;
}

function sourceForLine(root, path, line) {
  return { path: sourcePath(root, path), ref: sourceRef(root, path, `:${line}`) };
}

function sourceForDb(root, path, table, key) {
  return { path: sourcePath(root, path), ref: sourceRef(root, path, `#${table}.${key}`) };
}

function sourceForObservation(root, path, sequence) {
  return { path: sourcePath(root, path), ref: sourceRef(root, path, `#observation_events.sequence=${sequence}`) };
}

function serviceFact(root, row, source, payload, result = null) {
  const event = row.kind ?? payload?.event ?? row.event;
  const operation = row.operation ?? payload?.operation ?? null;
  const envelope = row.envelope ?? payload?.envelope ?? {};
  const owner = envelopeIds(envelope);
  const targetTask = idsFromEntity(result?.task);
  const targetExecution = idsFromEntity(result?.execution);
  const authority = idsFromEntity(result?.authority_execution ?? result?.parent_execution);
  const ids = {
    taskId: owner.taskId ?? targetTask.taskId ?? null,
    executionId: owner.executionId ?? targetExecution.executionId ?? null,
    correlationId: owner.correlationId ?? null,
  };
  const entity = result?.task ? safeEntity(result.task, 'task') : result?.execution ? safeEntity(result.execution, 'execution') : safeResult(result);
  const summary = {
    service: row.service ?? payload?.service ?? null,
    operation,
    phase: event?.endsWith('.start') ? 'started' : 'finished',
    ok: row.ok ?? payload?.ok ?? null,
    ...ids,
    target_task_id: targetTask.taskId ?? null,
    target_execution_id: targetExecution.executionId ?? null,
    authority_execution_id: authority.executionId ?? null,
    result: entity,
    error: row.error ? { code: text(row.error.code ?? row.error.name, 80), message: text(row.error.message, 180) } : null,
  };
  return makeFact(root, {
    kind: event?.endsWith('.start') ? 'service_call_started' : 'service_call_finished',
    at: row.occurredAt ?? row.timestamp,
    source,
    taskId: ids.taskId,
    executionId: ids.executionId,
    correlationId: ids.correlationId,
    operation,
    summary,
    priority: 3,
  });
}

function domainFactsForService(root, row, source, payload, result = null) {
  const operation = row.operation ?? payload?.operation ?? null;
  const event = row.kind ?? payload?.event ?? row.event;
  if (!event?.endsWith('.complete') && !event?.endsWith('.finished')) return [];
  const envelope = row.envelope ?? payload?.envelope ?? {};
  const owner = envelopeIds(envelope);
  const execution = entityFromResult(result, 'execution');
  const task = entityFromResult(result, 'task');
  const material = entityFromResult(result, 'material');
  const check = entityFromResult(result, 'check_result');
  const authority = result?.authority_execution ?? result?.parent_execution ?? null;
  const targetIds = { ...idsFromEntity(task), ...idsFromEntity(execution) };
  const authorityIds = idsFromEntity(authority);
  const ids = {
    taskId: owner.taskId ?? targetIds.taskId ?? null,
    executionId: owner.executionId ?? targetIds.executionId ?? null,
    correlationId: owner.correlationId ?? null,
  };
  const at = row.occurredAt ?? row.timestamp;
  const facts = [];
  const base = (kind, summary, extra = {}) => makeFact(root, {
    kind, at, source,
    taskId: extra.taskId ?? ids.taskId,
    executionId: extra.executionId ?? ids.executionId,
    correlationId: ids.correlationId,
    operation,
    summary,
    priority: 2,
  });
  if (['propose_task', 'create_child_task'].includes(operation) && task) {
    facts.push(base('task_created', { task: safeEntity(task, 'task'), parent_task_id: owner.taskId, parent_execution_id: owner.executionId }, { taskId: owner.taskId, executionId: owner.executionId }));
  }
  if (operation === 'task_take' && execution) {
    facts.push(base('task_taken', { task_id: task?.task_id ?? execution.task_id, execution_id: execution.execution_id, owner_ref: execution.owner_ref, state: execution.state }, { taskId: task?.task_id ?? execution.task_id, executionId: execution.execution_id }));
  }
  if (operation === 'save_workspace_revision') {
    facts.push(base('workspace_revision', {
      execution_id: execution?.execution_id ?? ids.executionId,
      workspace_revision: execution?.workspace_revision ?? result?.workspace_revision ?? null,
      workspace_content_hash: execution?.workspace_content_hash ?? null,
    }));
  }
  if (operation === 'publish_material' && material) {
    facts.push(base('material_published', { material: safeEntity(material, 'material') }, { taskId: material.source_task ?? ids.taskId, executionId: material.source_execution ?? ids.executionId }));
  }
  if (operation === 'read_materials') {
    const materials = array(result).map((item) => safeEntity(item, 'material') ?? { material_id: item?.material_id ?? item }).filter((item) => item.material_id);
    facts.push(base('material_read', { material_ids: materials.map((item) => item.material_id), count: materials.length }, {}));
  }
  if (operation === 'consume_materials') {
    const materialIds = array(result?.material_ids ?? result?.consumptions?.map((row) => row.material_id))
      .filter((id) => typeof id === 'string').slice(0, 100);
    facts.push(base('material_consumed', {
      material_ids: materialIds,
      action: typeof result?.action === 'string' ? result.action : null,
      action_ref: typeof result?.action_ref === 'string' ? result.action_ref : null,
      count: materialIds.length,
    }, {}));
  }
  if (operation === 'workspace_check') {
    const candidateId = execution?.artifact_material_id ?? result?.artifact_material_id ?? null;
    facts.push(base('workspace_checked', {
      artifact_material_id: candidateId,
      workspace_revision: execution?.workspace_revision ?? null,
      execution_id: execution?.execution_id ?? ids.executionId,
    }, { executionId: execution?.execution_id ?? ids.executionId }));
  }
  if (operation === 'apply_check_result' && check) {
    facts.push(base('judge_result', { check_result: safeEntity(check, 'check_result') }, { executionId: check.execution_id ?? ids.executionId }));
  }
  if (operation === 'wait_for') {
    const condition = execution?.wait_condition ?? result?.wait_condition ?? null;
    facts.push(base('wait_for_requested', {
      execution_id: execution?.execution_id ?? ids.executionId,
      wait_condition: safeEntity({ wait_condition: condition }, 'execution')?.wait_condition ?? null,
      deadline: execution?.wait_deadline ?? null,
    }, { executionId: execution?.execution_id ?? ids.executionId }));
  }
  if (operation === 'wake_execution') facts.push(base('wake', { execution_id: ids.executionId }, {}));
  if (operation === 'resume_execution') facts.push(base('resume', { execution_id: ids.executionId }, {}));
  if (operation === 'accept_task') facts.push(base('review', { decision: 'accept', target_task_id: task?.task_id ?? owner.taskId, authority_execution_id: authorityIds.executionId ?? owner.executionId }, { taskId: owner.taskId ?? authorityIds.taskId, executionId: authorityIds.executionId ?? owner.executionId }));
  if (operation === 'request_rework') facts.push(base('rework', { decision: 'request_rework', target_task_id: task?.task_id ?? owner.taskId, parent_execution_id: authorityIds.executionId ?? owner.executionId }, { taskId: owner.taskId ?? authorityIds.taskId, executionId: authorityIds.executionId ?? owner.executionId }));
  if (operation === 'stop_execution') {
    facts.push(base('execution_terminal', { execution: safeEntity(execution, 'execution'), terminal_state: execution?.state ?? result?.terminal_state ?? null }, { executionId: execution?.execution_id ?? ids.executionId }));
  }
  if (task?.state) facts.push(base('task_state_changed', { task_id: task.task_id, state: task.state, state_version: task.state_version }, { taskId: task.task_id, executionId: execution?.execution_id ?? ids.executionId }));
  if (execution?.state) facts.push(base('execution_state_changed', { execution_id: execution.execution_id, state: execution.state, state_version: execution.state_version, wait_condition: safeEntity(execution, 'execution')?.wait_condition ?? null }, { taskId: execution.task_id ?? ids.taskId, executionId: execution.execution_id }));
  return facts;
}

function factsForObservationRow(root, observationPath, row, payload, mode) {
  const source = sourceForObservation(root, observationPath, row.sequence);
  const envelope = payload?.envelope ?? {};
  const rowIds = { taskId: row.task_id, executionId: row.execution_id, sessionId: row.session_id, coreId: row.core_id, correlationId: row.correlation_id };
  const ids = {
    taskId: row.task_id ?? envelope.task_id ?? null,
    executionId: row.execution_id ?? envelope.execution_id ?? null,
    sessionId: row.session_id ?? null,
    coreId: row.core_id ?? null,
    correlationId: row.correlation_id ?? envelope.operation_id ?? null,
  };
  const event = payload?.event ?? row.kind;
  const operation = payload?.operation ?? null;
  const facts = [];
  const base = (kind, summary = {}, extra = {}) => makeFact(root, {
    kind, at: row.occurred_at, source,
    taskId: extra.taskId ?? ids.taskId, executionId: extra.executionId ?? ids.executionId,
    sessionId: ids.sessionId, coreId: ids.coreId, correlationId: ids.correlationId,
    operation: extra.operation ?? operation, summary, priority: 1,
    preserveBoundedOperatorIds: true,
  });
  // These operator events are emitted by the benchmark runner with only
  // stable IDs and bounded classifications.  Keep them usable in sanitized
  // mode so a Material handoff can be joined to its reader and later action
  // without opening raw Agent or Context payloads.
  if (row.kind === 'material_read') {
    facts.push(base('material_read', {
      material_ids: array(payload?.material_ids).filter((id) => typeof id === 'string').slice(0, 100),
      source_task_ids: array(payload?.source_task_ids).filter((id) => typeof id === 'string').slice(0, 100),
      count: Number.isInteger(payload?.count) ? payload.count : array(payload?.material_ids).length,
    }, { operation: 'read_materials' }));
    return facts;
  }
  if (row.kind === 'material_consumed') {
    // Older runner versions used this event name for a read-only query. Keep
    // those historical observations read-only unless the bounded payload
    // explicitly marks a durable consume action.
    if (payload?.durable !== true && typeof payload?.action !== 'string') {
      facts.push(base('material_read', {
        material_ids: array(payload?.material_ids).filter((id) => typeof id === 'string').slice(0, 100),
        source_task_ids: array(payload?.source_task_ids).filter((id) => typeof id === 'string').slice(0, 100),
        count: Number.isInteger(payload?.count) ? payload.count : array(payload?.material_ids).length,
      }, { operation: 'read_materials' }));
      return facts;
    }
    facts.push(base('material_consumed', {
      material_ids: array(payload?.material_ids).filter((id) => typeof id === 'string').slice(0, 100),
      action: typeof payload?.action === 'string' ? payload.action : null,
      action_ref: typeof payload?.action_ref === 'string' ? payload.action_ref : null,
      count: Number.isInteger(payload?.count) ? payload.count : array(payload?.material_ids).length,
    }, { operation: 'consume_materials' }));
    return facts;
  }
  if (row.kind === 'material_published') {
    facts.push(base('material_published', {
      material: {
        material_id: typeof payload?.material_id === 'string' ? payload.material_id : null,
        kind: typeof payload?.kind === 'string' ? payload.kind : null,
        scope: typeof payload?.scope === 'string' ? payload.scope : null,
        source_task: typeof payload?.source_task === 'string' ? payload.source_task : ids.taskId,
        source_execution: typeof payload?.source_execution === 'string' ? payload.source_execution : ids.executionId,
      },
    }, { operation: 'publish_material' }));
    return facts;
  }
  if (row.kind === 'task_review') {
    const decision = payload?.decision === 'request_rework' ? 'request_rework' : payload?.decision === 'accept' ? 'accept' : null;
    facts.push(base(decision === 'request_rework' ? 'rework' : 'review', {
      decision,
      target_task_id: typeof payload?.target_task_id === 'string' ? payload.target_task_id : null,
    }, { operation: decision === 'request_rework' ? 'request_rework' : 'accept_task' }));
    return facts;
  }
  if (row.kind === 'workspace_revision_saved') {
    facts.push(base('workspace_revision', {
      workspace_revision: Number.isInteger(payload?.workspace_revision) ? payload.workspace_revision : null,
    }, { operation: 'save_workspace_revision' }));
    return facts;
  }
  if (row.kind === 'workspace_checked') {
    facts.push(base('workspace_checked', {
      artifact_material_id: typeof payload?.artifact_material_id === 'string' ? payload.artifact_material_id : null,
      check_result_id: typeof payload?.check_result_id === 'string' ? payload.check_result_id : null,
      verdict: typeof payload?.verdict === 'string' ? payload.verdict : null,
    }, { operation: 'workspace_check' }));
    return facts;
  }
  if (row.source === 'agent') {
    const record = payload?.record ?? payload;
    const recordType = record?.type;
    if (['tool_execution_start', 'tool_call'].includes(recordType)) {
      const tool = record.toolName ?? record.tool_name ?? record.name;
      facts.push(base('tool_call', { tool: text(tool, 120), operation: operationFromTool(tool), outcome: 'started' }, { operation: operationFromTool(tool) }));
    } else if (['tool_execution_end', 'tool_result'].includes(recordType)) {
      const tool = record.toolName ?? record.tool_name ?? record.name;
      const failed = Boolean(record.isError || record.error);
      facts.push(base('tool_call', { tool: text(tool, 120), operation: operationFromTool(tool), outcome: failed ? 'error' : 'finished', error: failed ? 'tool error' : null }, { operation: operationFromTool(tool) }));
    } else if (recordType === 'turn_start' || recordType === 'turn_end') {
      facts.push(base('agent_turn', { phase: recordType === 'turn_start' ? 'started' : 'finished' }));
    } else if (recordType === 'agent_settled') {
      facts.push(base('agent_settled', {}));
    } else if (row.kind === 'session_started') {
      facts.push(base('session_started', { session_id: row.session_id }));
    } else if (row.kind === 'session_closed') {
      facts.push(base('session_closed', { session_id: row.session_id, code: payload?.code ?? null, signal: payload?.signal ?? null }));
    } else if (row.kind === 'rpc_request') {
      facts.push(base('agent_rpc_request', { command: text(payload?.message?.type, 80) }));
    } else if (row.kind === 'process_stderr' || row.kind === 'process_stdout') {
      facts.push(base('process_event', { stream: row.kind === 'process_stderr' ? 'stderr' : 'stdout' }));
    } else {
      facts.push(base('agent_event', { type: text(recordType ?? row.kind, 100) }));
    }
    return facts;
  }
  if (row.source === 'runtime') {
    const runtimeEvent = payload?.event ?? row.kind;
    const runtimeSummary = safeResult({
      event: runtimeEvent,
      state: payload?.state,
      reason: payload?.reason,
      wait_condition: payload?.wait_condition,
      deadline: payload?.deadline,
      terminal_state: payload?.terminal_state,
    });
    let kind = 'runtime_event';
    if (runtimeEvent === 'execution_assigned') kind = 'execution_assigned';
    else if (runtimeEvent === 'core_state_changed') kind = 'execution_state_changed';
    else if (runtimeEvent === 'execution_released') kind = 'execution_released';
    else if (runtimeEvent === 'experiment_finished') kind = 'experiment_finished';
    if (runtimeEvent === 'runtime.wait_for' || runtimeEvent === 'wait_for') kind = 'wait_for_requested';
    if (runtimeEvent === 'runtime.stop_execution' || runtimeEvent === 'stop_execution') kind = 'execution_terminal';
    facts.push(base(kind, runtimeSummary));
    return facts;
  }
  if (row.source === 'judge-service') {
    const summary = safeResult({
      operation_id: payload?.operation_id,
      target_task_id: payload?.target_task_id,
      artifact_material_id: payload?.artifact_material_id,
      verdict: payload?.verdict,
      check_result_id: payload?.check_result_id,
      ok: payload?.ok,
      judge_operation_status: payload?.operation_status ?? payload?.judge_operation_status,
      checker_process_status: payload?.checker_process_status,
      result_class: payload?.result_class,
      mathematical_outcome: payload?.mathematical_outcome,
      checker_result_available: payload?.checker_result_available,
      retryable: payload?.retryable,
      diagnostic_code: payload?.diagnostic_code,
    });
    facts.push(base(payload?.event === 'judge.complete' ? 'judge_result' : 'judge_request', summary, { operation: 'judge' }));
    return facts;
  }
  if (row.source === 'judge') {
    const summary = safeResult({
      event: payload?.event,
      target_task_id: payload?.target_task_id ?? payload?.evidence?.target_task_id,
      artifact_material_id: payload?.candidate_hash ? null : payload?.artifact_material_id,
      verdict: payload?.verdict,
      checker_process_status: payload?.checker_process_status ?? payload?.evidence?.checker_process_status,
      result_class: payload?.result_class ?? payload?.evidence?.result_class,
      retryable: payload?.retryable ?? payload?.evidence?.retryable,
      diagnostic_code: payload?.diagnostic_code ?? payload?.evidence?.diagnostic_code,
      diagnostic: payload?.evidence?.diagnostic ? 'diagnostic present' : null,
    });
    facts.push(base(payload?.event === 'checker.complete' ? 'judge_check' : 'judge_request', summary, { operation: 'checker' }));
    return facts;
  }
  if (row.source.endsWith('service') || row.source === 'service-router') {
    const result = mode === 'full' ? payload?.result : null;
    const serviceRow = {
      kind: row.kind,
      operation,
      service: payload?.service ?? row.source,
      envelope,
      ok: payload?.ok,
      error: payload?.error,
      occurredAt: row.occurred_at,
      timestamp: row.occurred_at,
    };
    facts.push(serviceFact(root, serviceRow, source, payload, result));
    if (mode === 'full') facts.push(...domainFactsForService(root, serviceRow, source, payload, result));
    return facts;
  }
  facts.push(base('observation_event', { source: row.source, kind: row.kind }));
  return facts;
}

function normaliseRawRecord(root, path, line, record, context, mode) {
  const sourceClass = context.sourceClass;
  const source = sourceForLine(root, path, line);
  const at = record.timestamp ?? record.occurred_at ?? null;
  const coreId = record.core_id ?? coreFromScope(record.scope) ?? context.coreId ?? null;
  const facts = [];
  if (sourceClass === 'agent') {
    const nested = record.type === 'rpc_record' ? record.record : record;
    const type = nested?.type ?? record.type;
    const active = context.findExecution(coreId, timeMs(parseTime(at)));
    const ids = { taskId: active?.taskId ?? null, executionId: active?.executionId ?? null };
    if (['tool_execution_start', 'tool_execution_end', 'tool_call', 'tool_result'].includes(type)) {
      const tool = nested.toolName ?? nested.tool_name ?? nested.name;
      const operation = operationFromTool(tool);
      const finished = ['tool_execution_end', 'tool_result'].includes(type);
      const failed = Boolean(nested.isError || nested.error);
      facts.push(makeFact(root, {
        kind: 'tool_call', at, source, coreId, taskId: ids.taskId, executionId: ids.executionId,
        correlationId: nested.id ?? nested.toolCallId ?? record.correlation_id ?? null,
        operation, summary: { tool: text(tool, 120), operation, outcome: finished ? (failed ? 'error' : 'finished') : 'started', error: failed ? 'tool error' : null, ...(active ? { assignment_basis: 'timestamp_core_interval' } : {}) }, priority: 2,
      }));
    } else if (['turn_start', 'turn_end', 'agent_settled', 'session_started', 'session_closed'].includes(type) || ['stdout', 'stderr', 'rpc_request'].includes(record.type)) {
      facts.push(makeFact(root, {
        kind: type === 'session_started' ? 'session_started' : type === 'session_closed' ? 'session_closed' : type === 'agent_settled' ? 'agent_settled' : type === 'rpc_request' ? 'agent_rpc_request' : 'agent_turn',
        at, source, coreId, taskId: ids.taskId, executionId: ids.executionId,
        summary: { type, stream: record.type === 'stdout' ? 'stdout' : record.type === 'stderr' ? 'stderr' : null }, priority: 2,
      }));
    }
    return facts;
  }
  if (sourceClass === 'runtime') {
    const event = record.event ?? record.type;
    const kind = event === 'runtime.bind_execution' ? 'execution_assigned'
      : event === 'runtime.wait_for' ? 'wait_for_requested'
        : event === 'runtime.stop_execution' ? 'execution_terminal'
          : event === 'runtime.heartbeat' ? 'heartbeat' : 'runtime_event';
    facts.push(makeFact(root, {
      kind, at, source, coreId, executionId: record.execution_id ?? null,
      summary: safeResult({ event, state: record.state, reason: record.reason, wait_condition: record.wait_condition, deadline: record.deadline, terminal_state: record.terminal_state }),
      priority: kind === 'heartbeat' ? 5 : 2,
    }));
    return facts;
  }
  if (sourceClass === 'bridge') {
    const event = record.event ?? record.type;
    const operation = record.operation ?? null;
    const pending = event === 'bridge.complete' ? context.takePending('bridge', operation) : null;
    const effective = pending?.record ?? record;
    const ids = { taskId: effective.task_id ?? record.task_id ?? null, executionId: effective.execution_id ?? record.execution_id ?? null, correlationId: effective.operation_id ?? record.operation_id ?? null };
    const result = record.result;
    facts.push(makeFact(root, {
      kind: event === 'bridge.start' ? 'service_call_started' : 'service_call_finished', at, source, ...ids, coreId, operation,
      summary: { service: 'bridge', operation, phase: event === 'bridge.start' ? 'started' : 'finished', ok: record.ok ?? null, result: mode === 'full' ? safeResult(result) : null }, priority: 2,
    }));
    if (event === 'bridge.start') context.addPending('bridge', operation, record);
    return facts;
  }
  if (sourceClass === 'service') {
    const event = record.event ?? record.type;
    const operation = record.operation ?? null;
    const pending = event === 'dispatch.complete' ? context.takePending('service', operation) : null;
    const start = pending?.record ?? {};
    const envelope = start.envelope ?? record.envelope ?? {};
    const serviceRow = { ...record, kind: event, operation, envelope, timestamp: at, occurredAt: at };
    const result = mode === 'full' ? record.result : null;
    facts.push(serviceFact(root, serviceRow, source, record, result));
    if (mode === 'full') facts.push(...domainFactsForService(root, serviceRow, source, record, result));
    if (event === 'dispatch.start') context.addPending('service', operation, record);
    return facts;
  }
  if (sourceClass === 'judge-service') {
    const event = record.event ?? record.type;
    facts.push(makeFact(root, {
      kind: event === 'judge.complete' ? 'judge_result' : 'judge_request', at, source,
      taskId: record.target_task_id ?? null, correlationId: record.operation_id ?? null,
      operation: 'judge', summary: safeResult({ event, target_task_id: record.target_task_id, artifact_material_id: record.artifact_material_id, verdict: record.verdict, check_result_id: record.check_result_id, ok: record.ok, judge_operation_status: record.operation_status ?? record.judge_operation_status, checker_process_status: record.checker_process_status, result_class: record.result_class, mathematical_outcome: record.mathematical_outcome, checker_result_available: record.checker_result_available, retryable: record.retryable, diagnostic_code: record.diagnostic_code }), priority: 2,
    }));
    return facts;
  }
  if (sourceClass === 'judge') {
    const event = record.event ?? record.type;
    facts.push(makeFact(root, {
      kind: event === 'judge.complete' ? 'judge_result' : 'judge_request', at, source,
      taskId: record.target_task_id ?? null, correlationId: record.operation_id ?? null,
      operation: 'judge', summary: safeResult({ event, target_task_id: record.target_task_id, artifact_material_id: record.artifact_material_id, verdict: record.verdict, check_result_id: record.check_result_id, ok: record.ok, judge_operation_status: record.operation_status ?? record.judge_operation_status, checker_process_status: record.checker_process_status, result_class: record.result_class, mathematical_outcome: record.mathematical_outcome, checker_result_available: record.checker_result_available, retryable: record.retryable, diagnostic_code: record.diagnostic_code }), priority: 2,
    }));
    return facts;
  }
  if (sourceClass === 'checker') {
    const event = record.event ?? record.type;
    facts.push(makeFact(root, {
      kind: event === 'checker.complete' ? 'judge_check' : 'judge_request', at, source,
      taskId: record.target_task_id ?? record.evidence?.target_task_id ?? null,
      operation: 'checker', summary: safeResult({ event, target_task_id: record.target_task_id ?? record.evidence?.target_task_id, verdict: record.verdict, checker_process_status: record.checker_process_status ?? record.process_status ?? record.evidence?.checker_process_status, result_class: record.result_class ?? record.evidence?.result_class, retryable: record.retryable ?? record.evidence?.retryable, diagnostic_code: record.diagnostic_code ?? record.evidence?.diagnostic_code, diagnostic: record.evidence?.diagnostic ? 'diagnostic present' : null }), priority: 2,
    }));
    return facts;
  }
  return facts;
}

function buildExecutionIntervals(runtimeRecords) {
  const byCore = new Map();
  for (const record of runtimeRecords) {
    const coreId = record.coreId ?? coreFromScope(record.scope);
    const at = timeMs(parseTime(record.timestamp));
    if (!coreId || at === null) continue;
    if (!byCore.has(coreId)) byCore.set(coreId, []);
    byCore.get(coreId).push({ ...record, coreId, at });
  }
  const intervals = new Map();
  for (const [coreId, records] of byCore) {
    records.sort((a, b) => a.at - b.at);
    let active = null;
    const entries = [];
    for (const record of records) {
      if (record.event === 'runtime.bind_execution' && record.execution_id) {
        if (active) entries.push({ ...active, end: record.at });
        active = { coreId, executionId: record.execution_id, taskId: null, start: record.at, end: null };
      } else if (active && record.execution_id === active.executionId && ['runtime.wait_for', 'runtime.stop_execution'].includes(record.event)) {
        entries.push({ ...active, end: record.at });
        active = null;
      }
    }
    if (active) entries.push(active);
    intervals.set(coreId, entries);
  }
  return intervals;
}

function findExecution(intervals, coreId, at) {
  if (!coreId || at === null || !intervals.has(coreId)) return null;
  return intervals.get(coreId).find((entry) => at >= entry.start && (entry.end === null || at < entry.end)) ?? null;
}

function dedupeFacts(facts) {
  const map = new Map();
  const semantic = (fact) => [
    fact.kind, fact.at, fact.taskId, fact.executionId, fact.coreId, fact.operation,
    fact.summary?.material_id, fact.summary?.artifact_material_id, fact.summary?.check_result_id,
    fact.correlationId, fact.summary?.tool, fact.summary?.phase, fact.summary?.outcome, fact.summary?.event,
    fact.summary?.check_result?.check_result_id, fact.summary?.artifact_material_id,
  ].map((value) => value ?? '').join('|');
  for (const fact of facts) {
    const key = semantic(fact);
    const existing = map.get(key);
    if (!existing) { map.set(key, fact); continue; }
    if (fact.priority < existing.priority) {
      fact.sources = [...new Set([...fact.sources, ...existing.sources])].sort();
      map.set(key, fact);
    } else {
      existing.sources = [...new Set([...existing.sources, ...fact.sources])].sort();
    }
  }
  return [...map.values()].sort((a, b) => (timeMs(a.at) ?? Number.MAX_SAFE_INTEGER) - (timeMs(b.at) ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id));
}

function parseLineRecords(root, path, sourceClass, context, mode, errors) {
  return readFile(path, 'utf8').then((contents) => {
    const facts = [];
    const lines = contents.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!line.trim()) return;
      let record;
      try { record = JSON.parse(line); }
      catch (error) {
        errors.push({ path: sourcePath(root, path), line: index + 1, error: text(error.message, 160) });
        return;
      }
      facts.push(...normaliseRawRecord(root, path, index + 1, record, { ...context, sourceClass }, mode));
    });
    return facts;
  });
}

function databaseTableNames(db) {
  return db.prepare("select name from sqlite_master where type='table'").all().map((row) => row.name);
}

function columnNames(db, table) {
  return db.prepare(`pragma table_info("${table.replaceAll('"', '""')}")`).all().map((row) => row.name);
}

function selectRows(db, table, columns) {
  const available = new Set(columnNames(db, table));
  const selected = columns.filter((column) => available.has(column));
  if (!selected.length) return [];
  return db.prepare(`select ${selected.map((column) => `"${column}"`).join(', ')} from "${table.replaceAll('"', '""')}"`).all();
}

function closeDb(db) {
  try { db.close(); } catch { /* already closed */ }
}

async function readDomainDatabases(root, dbPaths, errors, mode = 'full') {
  const model = { tasks: [], executions: [], materials: [], checks: [], preflights: [], operations: [] };
  for (const dbPath of dbPaths) {
    let db;
    try { db = new DatabaseSync(dbPath); }
    catch (error) { errors.push({ path: sourcePath(root, dbPath), error: text(error.message, 180) }); continue; }
    try {
      const tables = new Set(databaseTableNames(db));
      if (tables.has('tasks')) {
        for (const row of selectRows(db, 'tasks', ['task_id', 'root_id', 'parent_id', 'owner_ref', 'task_type', 'state', 'state_version', 'goal', 'block_reason', 'created_at', 'updated_at'])) {
          model.tasks.push({ ...row, project: basename(dirname(dbPath)), source: sourceForDb(root, dbPath, 'tasks', `task_id=${row.task_id}`) });
        }
      }
      if (tables.has('executions')) {
        for (const row of selectRows(db, 'executions', ['execution_id', 'task_id', 'owner_ref', 'state', 'state_version', 'attempt_no', 'fencing_version', 'runtime_generation', 'workspace_ref', 'workspace_revision', 'artifact_material_id', 'wait_condition_json', 'wait_deadline', 'created_at', 'updated_at'])) {
          model.executions.push({ ...row, wait_condition: jsonParse(row.wait_condition_json), project: basename(dirname(dbPath)), source: sourceForDb(root, dbPath, 'executions', `execution_id=${row.execution_id}`) });
        }
      }
      if (tables.has('materials')) {
        for (const row of selectRows(db, 'materials', ['material_id', 'kind', 'scope', 'evidence_state', 'source_task', 'source_execution', 'version', 'created_at'])) {
          model.materials.push({ ...row, project: basename(dirname(dbPath)), source: sourceForDb(root, dbPath, 'materials', `material_id=${row.material_id}`) });
        }
      }
      if (tables.has('check_results')) {
        const checkColumns = ['check_result_id', 'request_key', 'artifact_material_id', 'target_task_id', 'target_spec_version', 'execution_id', 'status', 'verdict', 'judge_operation_status', 'checker_process_status', 'result_class', 'retryable', 'diagnostic_code', 'checker_ref', 'checker_version', 'environment_ref', ...(mode === 'full' ? ['evidence_json'] : []), 'created_at', 'updated_at'];
        for (const row of selectRows(db, 'check_results', checkColumns)) {
          const evidence = mode === 'full' ? jsonParse(row.evidence_json) : null;
          const diagnostic = isObject(evidence) ? (evidence.diagnostic ?? evidence.stderr ?? evidence.stdout) : null;
          const { evidence_json: _evidenceJson, ...safeRow } = row;
          const resultClass = storedResultClass({ verdict: row.verdict, resultClass: row.result_class, checkerProcessStatus: row.checker_process_status });
          const checkerProcessStatus = storedCheckerProcessStatus({ verdict: row.verdict, resultClass: row.result_class, checkerProcessStatus: row.checker_process_status });
          const diagnosticClassValue = row.diagnostic_code ?? (resultClass === 'infrastructure_failure' ? 'checker_unavailable' : diagnosticClass(diagnostic));
          model.checks.push({
            ...safeRow,
            result_class: resultClass,
            checker_process_status: checkerProcessStatus,
            mathematical_outcome: evidence?.mathematical_outcome ?? (resultClass === 'PASS' ? 'PASS' : resultClass === 'source_failure' ? 'FAIL' : 'unassessed'),
            infrastructure_attempt_count: evidence?.infrastructure_attempt_count ?? null,
            retry_exhausted: Boolean(evidence?.retry_exhausted),
            preflight_key: evidence?.preflight_key ?? null,
            diagnostic_class: diagnosticClassValue,
            project: basename(dirname(dbPath)),
            source: sourceForDb(root, dbPath, 'check_results', `check_result_id=${row.check_result_id}`),
          });
        }
      }
      if (tables.has('checker_preflights')) {
        const preflightColumns = ['preflight_key', 'fixture_id', 'checker_ref', 'checker_version', 'environment_ref', 'status', 'checker_process_status', 'diagnostic_code', 'retryable', 'attempt_count', ...(mode === 'full' ? ['evidence_json'] : []), 'first_seen_at', 'last_seen_at'];
        for (const row of selectRows(db, 'checker_preflights', preflightColumns)) {
          const evidence = mode === 'full' ? jsonParse(row.evidence_json) : null;
          const { evidence_json: _evidenceJson, ...safeRow } = row;
          model.preflights.push({
            ...safeRow,
            retryable: Boolean(row.retryable),
            preflight_verified: evidence?.preflight_verified ?? null,
            preflight_supported: evidence?.preflight_supported ?? null,
            input_binding_verified: evidence?.input_binding_verified ?? null,
            toolchain_version_verified: evidence?.toolchain_version_verified ?? null,
            project: basename(dirname(dbPath)),
            source: sourceForDb(root, dbPath, 'checker_preflights', `preflight_key=${row.preflight_key}`),
          });
        }
      }
      if (tables.has('operations')) {
        for (const row of selectRows(db, 'operations', ['operation_id', 'operation', 'result_json', 'created_at'])) {
          model.operations.push({ ...row, result: jsonParse(row.result_json), project: basename(dirname(dbPath)), source: sourceForDb(root, dbPath, 'operations', `operation_id=${row.operation_id}`) });
        }
      }
    } catch (error) {
      errors.push({ path: sourcePath(root, dbPath), error: text(error.message, 180) });
    } finally { closeDb(db); }
  }
  return model;
}

function factsFromDomainModel(root, model) {
  const facts = [];
  for (const task of model.tasks) {
    facts.push(makeFact(root, { kind: 'task_snapshot', at: task.updated_at ?? task.created_at, source: task.source,
      taskId: task.task_id, summary: safeEntity(task, 'task'), priority: 3 }));
  }
  for (const execution of model.executions) {
    facts.push(makeFact(root, { kind: 'execution_snapshot', at: execution.updated_at ?? execution.created_at, source: execution.source,
      taskId: execution.task_id, executionId: execution.execution_id,
      coreId: String(execution.owner_ref ?? '').match(/core-\d+/)?.[0] ?? null,
      summary: safeEntity(execution, 'execution'), priority: 3 }));
  }
  for (const material of model.materials) {
    facts.push(makeFact(root, { kind: 'material_record', at: material.created_at, source: material.source,
      taskId: material.source_task, executionId: material.source_execution, summary: safeEntity(material, 'material'), priority: 3 }));
  }
  for (const check of model.checks) {
    facts.push(makeFact(root, { kind: 'judge_check_record', at: check.updated_at ?? check.created_at, source: check.source,
      taskId: check.target_task_id, executionId: check.execution_id, summary: safeEntity(check, 'check_result'), priority: 3 }));
  }
  for (const preflight of model.preflights ?? []) {
    facts.push(makeFact(root, { kind: 'checker_preflight', at: preflight.last_seen_at ?? preflight.first_seen_at, source: preflight.source,
      summary: safeResult(preflight), priority: 3 }));
  }
  for (const operation of model.operations) {
    const result = operation.result;
    const task = entityFromResult(result, 'task');
    const execution = entityFromResult(result, 'execution');
    const check = entityFromResult(result, 'check_result');
    const ids = { ...idsFromEntity(task), ...idsFromEntity(execution) };
    facts.push(makeFact(root, { kind: 'database_operation', at: operation.created_at, source: operation.source,
      taskId: ids.taskId, executionId: ids.executionId, correlationId: operation.operation_id, operation: operation.operation,
      summary: { operation: operation.operation, task: safeEntity(task, 'task'), execution: safeEntity(execution, 'execution'), check_result: safeEntity(check, 'check_result') }, priority: 4 }));
  }
  return facts;
}

async function readWorkspaceFacts(root, projectIds, model, errors) {
  const facts = [];
  const workspaceRoot = join(root, 'workspaces', 'projects');
  for (const projectId of projectIds) {
    const projectRoot = join(workspaceRoot, projectId);
    if (!(await isDirectory(projectRoot))) continue;
    const executionDirs = await readdir(projectRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of executionDirs.filter((candidate) => candidate.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const executionId = entry.name;
      const executionRoot = join(projectRoot, executionId);
      for (const filename of ['workspace-manifest.json', 'runtime-manifest.json', '.swarm/workspace.json']) {
        const path = join(executionRoot, filename);
        if (!(await isRegularFile(path))) continue;
        try {
          const manifest = await readJson(path);
          const revision = manifest.workspace_revision ?? manifest.revision ?? null;
          facts.push(makeFact(root, { kind: 'workspace_manifest', at: manifest.updated_at ?? manifest.created_at ?? null,
            source: { ref: sourceRef(root, path) }, executionId: manifest.execution_id ?? executionId,
            taskId: manifest.task_id ?? null, summary: { workspace_revision: revision, content_hash: manifest.content_hash ?? null, file_count: isObject(manifest.files) ? Object.keys(manifest.files).length : null }, priority: 1 }));
        } catch (error) { errors.push({ path: sourcePath(root, path), error: text(error.message, 180) }); }
      }
      const revisionRoot = join(executionRoot, '.swarm', 'revisions');
      const revisionFiles = await listFiles(revisionRoot, '.json');
      for (const path of revisionFiles) {
        try {
          const revision = await readJson(path);
          const revisionNumber = revision.workspace_revision ?? (Number.parseInt(basename(path, extname(path)), 10) || null);
          facts.push(makeFact(root, { kind: 'workspace_revision', at: revision.created_at ?? revision.updated_at ?? null,
            source: { ref: sourceRef(root, path) }, executionId,
            summary: { workspace_revision: revisionNumber, content_hash: revision.content_hash ?? null, changed_files: array(revision.changed_files).map((item) => text(item, 120)).filter(Boolean) }, priority: 1 }));
        } catch (error) { errors.push({ path: sourcePath(root, path), error: text(error.message, 180) }); }
      }
    }
  }
  return facts;
}

async function readObservationFacts(root, observationPath, experimentIds, mode, errors) {
  let db;
  try { db = new DatabaseSync(observationPath); }
  catch (error) { errors.push({ path: sourcePath(root, observationPath), error: text(error.message, 180) }); return []; }
  try {
    const tables = new Set(databaseTableNames(db));
    if (!tables.has('observation_events')) {
      errors.push({ path: sourcePath(root, observationPath), kind: 'malformed', error: 'observation_events table is missing' });
      return [];
    }
    const ids = [...new Set((Array.isArray(experimentIds) ? experimentIds : [experimentIds]).filter(Boolean))];
    if (!ids.length) return [];
    const columns = ['event_id', 'experiment_id', 'sequence', 'occurred_at', 'source', 'kind', 'core_id', 'session_id', 'task_id', 'execution_id', 'correlation_id'];
    if (mode === 'full') columns.push('payload_json');
    const placeholders = ids.map(() => '?').join(', ');
    const rows = db.prepare(`select ${columns.join(', ')} from observation_events where experiment_id in (${placeholders}) order by experiment_id, sequence`).all(...ids);
    const facts = [];
    for (const row of rows) {
      let payload = {};
      if (mode === 'full') {
        try { payload = JSON.parse(row.payload_json ?? '{}'); }
        catch (error) { errors.push({ path: sourcePath(root, observationPath), sequence: row.sequence, error: text(error.message, 180) }); continue; }
      } else if (['material_read', 'material_consumed', 'material_published', 'task_review', 'workspace_revision_saved', 'workspace_checked'].includes(row.kind)) {
        // Read only the runner's bounded operator events in sanitized mode.
        // Other observation payloads may contain Agent or checker material and
        // remain intentionally opaque.
        try {
          const raw = db.prepare('SELECT payload_json FROM observation_events WHERE event_id = ?').get(row.event_id)?.payload_json;
          const decoded = JSON.parse(raw ?? '{}');
          if (row.kind === 'material_read') {
            payload = {
              material_ids: array(decoded.material_ids).filter((id) => typeof id === 'string').slice(0, 100),
              source_task_ids: array(decoded.source_task_ids).filter((id) => typeof id === 'string').slice(0, 100),
              count: Number.isInteger(decoded.count) ? decoded.count : null,
            };
          } else if (row.kind === 'material_consumed') {
            payload = {
              material_ids: array(decoded.material_ids).filter((id) => typeof id === 'string').slice(0, 100),
              action: typeof decoded.action === 'string' ? decoded.action : null,
              action_ref: typeof decoded.action_ref === 'string' ? decoded.action_ref : null,
              durable: decoded.durable === true,
              count: Number.isInteger(decoded.count) ? decoded.count : null,
            };
          } else if (row.kind === 'material_published') {
            payload = {
              material_id: typeof decoded.material_id === 'string' ? decoded.material_id : null,
              kind: typeof decoded.kind === 'string' ? decoded.kind : null,
              scope: typeof decoded.scope === 'string' ? decoded.scope : null,
              source_task: typeof decoded.source_task === 'string' ? decoded.source_task : null,
              source_execution: typeof decoded.source_execution === 'string' ? decoded.source_execution : null,
            };
          } else if (row.kind === 'task_review') {
            payload = {
              decision: decoded.decision === 'accept' || decoded.decision === 'request_rework' ? decoded.decision : null,
              target_task_id: typeof decoded.target_task_id === 'string' ? decoded.target_task_id : null,
            };
          } else if (row.kind === 'workspace_revision_saved') {
            payload = { workspace_revision: Number.isInteger(decoded.workspace_revision) ? decoded.workspace_revision : null };
          } else {
            payload = {
              artifact_material_id: typeof decoded.artifact_material_id === 'string' ? decoded.artifact_material_id : null,
              check_result_id: typeof decoded.check_result_id === 'string' ? decoded.check_result_id : null,
              verdict: typeof decoded.verdict === 'string' ? decoded.verdict : null,
            };
          }
        } catch (error) {
          errors.push({ path: sourcePath(root, observationPath), sequence: row.sequence, error: 'bounded operator observation payload is malformed' });
          continue;
        }
      }
      facts.push(...factsForObservationRow(root, observationPath, row, payload, mode));
    }
    return facts;
  } catch (error) {
    errors.push({ path: sourcePath(root, observationPath), error: text(error.message, 180) }); return [];
  } finally { closeDb(db); }
}

async function readMetadata(root, errors) {
  const result = {};
  for (const filename of ['metadata/experiment.json', 'metadata/observability.json']) {
    const path = join(root, filename);
    if (!(await isRegularFile(path))) continue;
    try { result[basename(path, '.json')] = await readJson(path); }
    catch (error) { errors.push({ path: sourcePath(root, path), error: text(error.message, 180) }); }
  }
  return result;
}

function summaryPaths(root, metadata) {
  const candidates = [];
  const configured = metadata.experiment?.report_path ?? metadata.experiment?.result?.report_path ?? metadata.observability?.report_path;
  if (configured) candidates.push(resolve(configured));
  const reportLayout = metadata.experiment?.protocol?.report_layout;
  if (reportLayout) candidates.push(resolve(reportLayout));
  candidates.push(join(root, 'reports'));
  return [...new Set(candidates)];
}

async function findSummaryFiles(root, metadata) {
  const files = [];
  for (const candidate of summaryPaths(root, metadata)) {
    if (await isRegularFile(candidate) && basename(candidate) === 'report.json') files.push(candidate);
    else if (await isDirectory(candidate)) files.push(...await listFiles(candidate, '.json').then((items) => items.filter((path) => basename(path) === 'report.json' || basename(path) === 'aggregate-report.json')));
  }
  return [...new Set(files)];
}

function summaryProjection(report) {
  if (!isObject(report)) return {};
  const run = report.run ?? {};
  const project = report.project ?? {};
  const parallelism = report.parallelism ?? {};
  return {
    run: {
      solved: run.solved ?? null,
      protocol_valid: run.protocol_valid ?? null,
      made_progress: run.made_progress ?? null,
      elapsed_ms: run.elapsed_ms ?? null,
      started_at: parseTime(run.started_at),
      ended_at: parseTime(run.ended_at),
    },
    project: {
      problem_id: project.problem_id ?? null,
      run_id: project.run_id ?? null,
      task_count: array(project.task_tree).length || null,
      execution_count: array(project.execution_history).length || null,
    },
    parallelism: {
      core_count: parallelism.core_count ?? null,
      agent_time_ms: parallelism.agent_time_ms ?? null,
      turn_occupancy_ms: parallelism.turn_occupancy_ms ?? null,
      waiting_ms: parallelism.waiting_ms ?? null,
      idle_ms: parallelism.idle_ms ?? null,
    },
  };
}

async function readSummaries(root, metadata, errors) {
  const summaries = [];
  for (const path of await findSummaryFiles(root, metadata)) {
    try {
      summaries.push({ path: sourcePath(root, path), data: summaryProjection(await readJson(path)) });
    } catch (error) { errors.push({ path: sourcePath(root, path), error: text(error.message, 180) }); }
  }
  return summaries;
}

async function projectIdsFor(root, metadata) {
  const ids = new Set();
  for (const base of ['logs/projects', 'state/projects', 'workspaces/projects']) {
    const path = join(root, base);
    for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) if (entry.isDirectory()) ids.add(entry.name);
  }
  const experiment = metadata.experiment ?? {};
  for (const id of array(experiment.problem_ids)) ids.add(id);
  if (experiment.problem_id) ids.add(experiment.problem_id);
  return [...ids].sort();
}

async function inventoryLogs(root, projectIds, className, errors, { validate = true } = {}) {
  const files = [];
  const directories = [];
  const base = join(root, 'logs', 'projects');
  for (const projectId of projectIds) {
    const directoryName = { agent: 'agents', bridge: 'bridge', runtime: 'runtime', service: 'services', judge: 'judge' }[className] ?? className;
    const directory = join(base, projectId, directoryName);
    if (await isDirectory(directory)) directories.push(directory);
    files.push(...await listFiles(directory, '.ndjson'));
    if (className === 'judge') files.push(join(base, projectId, 'services', 'judge-service.ndjson'));
  }
  const uniqueFiles = [];
  for (const path of [...new Set(files)].filter((candidate) => candidate.endsWith('.ndjson'))) {
    if (await isRegularFile(path)) uniqueFiles.push(path);
  }
  let malformed = 0;
  if (!validate) return { files: uniqueFiles, malformed, directories };
  for (const path of uniqueFiles) {
    const lines = (await readFile(path, 'utf8').catch(() => '')).split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!line.trim()) return;
      try { JSON.parse(line); } catch (error) {
        malformed += 1;
        if (errors.length < MAX_SOURCE_ERRORS) errors.push({ path: sourcePath(root, path), line: index + 1, error: text(error.message, 160) });
      }
    });
  }
  return { files: uniqueFiles, malformed, directories };
}

async function inventoryExperiment(root, { mode = 'full', metadata = null, projectIds = null } = {}) {
  const errors = [];
  const actualMetadata = metadata ?? await readMetadata(root, errors);
  const ids = projectIds ?? await projectIdsFor(root, actualMetadata);
  const evidence = [];
  const add = (name, status, paths, detail = null) => evidence.push({ class: name, status, paths: paths.map((path) => sourcePath(root, path)), detail });
  const metadataPaths = ['metadata/experiment.json', 'metadata/observability.json'].map((path) => join(root, path));
  const existingMetadata = [];
  for (const path of metadataPaths) if (await exists(path)) existingMetadata.push(path);
  add('metadata', errors.some((item) => item.path?.startsWith('metadata/')) ? 'malformed' : existingMetadata.length ? 'present' : 'missing', existingMetadata, errors.filter((item) => item.path?.startsWith('metadata/')));
  for (const className of ['agent', 'bridge', 'runtime', 'service', 'judge']) {
    const result = await inventoryLogs(root, ids, className, errors, { validate: mode === 'full' });
    const status = result.malformed ? 'malformed' : result.files.length ? 'present' : result.directories.length ? 'empty' : 'missing';
    add(className, status, result.files, result.malformed ? `${result.malformed} malformed NDJSON record(s)` : null);
  }
  const dbPaths = [];
  for (const projectId of ids) {
    const path = join(root, 'state', 'projects', projectId, 'project.sqlite');
    if (await isRegularFile(path)) dbPaths.push(path);
  }
  add('sqlite', dbPaths.length ? 'present' : 'missing', dbPaths, null);
  const localObservation = join(root, 'observability.sqlite');
  const configuredObservation = actualMetadata.observability?.database_path ? resolve(actualMetadata.observability.database_path) : null;
  const observationPaths = [];
  for (const path of [...new Set([localObservation, configuredObservation].filter(Boolean))]) if (await isRegularFile(path)) observationPaths.push(path);
  add('observation', observationPaths.length ? 'present' : 'missing', observationPaths, null);
  const workspaceRoot = join(root, 'workspaces', 'projects');
  const workspaceFiles = await listFiles(workspaceRoot);
  const workspaceEvidenceFiles = workspaceFiles.filter((path) => ['workspace-manifest.json', 'runtime-manifest.json', 'workspace.json'].includes(basename(path)) || (path.includes('/.swarm/revisions/') && path.endsWith('.json')) || (path.includes('/.swarm/checkpoints/') && path.endsWith('.json')));
  const workspaceErrorsBefore = errors.length;
  const workspaceDetail = workspaceFiles.length > workspaceEvidenceFiles.length ? `${workspaceFiles.length} files found; raw Workspace contents are not listed` : null;
  add('workspace', workspaceFiles.length ? 'present' : (await isDirectory(workspaceRoot) ? 'empty' : 'missing'), workspaceEvidenceFiles.slice(0, 40), workspaceDetail);
  if (errors.length > workspaceErrorsBefore) evidence.at(-1).status = 'malformed';
  const summaries = await findSummaryFiles(root, actualMetadata);
  add('summary', summaries.length ? 'present' : 'missing', summaries, 'Numerical summary only; not the semantic source of truth');
  const malformed = errors.filter((item) => item.error || item.line || item.sequence);
  const presentRaw = ['metadata', 'agent', 'bridge', 'runtime', 'service', 'judge', 'sqlite', 'observation', 'workspace'].every((name) => evidence.find((item) => item.class === name)?.status === 'present');
  const evidenceMode = mode === 'sanitized' ? 'sanitized export mode' : presentRaw ? 'full local evidence' : 'incomplete local evidence';
  return {
    experimentId: actualMetadata.experiment?.experiment_id ?? basename(root),
    root: resolve(root),
    projectIds: ids,
    evidenceMode,
    evidence,
    errors: malformed.slice(0, MAX_SOURCE_ERRORS),
    metadata: actualMetadata,
    summaryPaths: summaries.map((path) => sourcePath(root, path)),
  };
}

function resolveConfiguredObservation(root, metadata) {
  const paths = [join(root, 'observability.sqlite')];
  if (metadata.observability?.database_path) paths.push(resolve(metadata.observability.database_path));
  return paths;
}

async function readRawFacts(root, projectIds, mode, intervals, errors) {
  if (mode === 'sanitized') return [];
  const facts = [];
  for (const className of ['agent', 'bridge', 'runtime', 'service', 'judge']) {
    const result = await inventoryLogs(root, projectIds, className, []);
    const pending = new Map();
    const context = {
      coreId: null,
      findExecution: (coreId, at) => findExecution(intervals, coreId, at),
      addPending: (type, operation, record) => {
        const key = `${type}:${operation ?? '<none>'}`;
        if (!pending.has(key)) pending.set(key, []);
        pending.get(key).push({ record });
      },
      takePending: (type, operation) => {
        const key = `${type}:${operation ?? '<none>'}`;
        const queue = pending.get(key) ?? [];
        const value = queue.shift() ?? null;
        if (!queue.length) pending.delete(key);
        return value;
      },
    };
    for (const path of result.files) {
      const coreId = basename(path, '.ndjson');
      const effectiveClass = path.endsWith('/judge-service.ndjson') ? 'judge-service' : className === 'judge' ? 'checker' : className;
      facts.push(...await parseLineRecords(root, path, effectiveClass, { ...context, coreId }, mode, errors));
    }
  }
  return facts;
}

function attachFactReferences(facts, model, intervals) {
  const executionIds = new Set(model.executions.map((row) => row.execution_id));
  const taskIds = new Set(model.tasks.map((row) => row.task_id));
  const materialById = new Map(model.materials.map((row) => [row.material_id, row]));
  const candidateToExecution = new Map(model.checks.map((row) => [row.artifact_material_id, row.execution_id]).filter(([, value]) => value));
  const taskExecutions = new Map();
  for (const execution of model.executions) {
    if (!taskExecutions.has(execution.task_id)) taskExecutions.set(execution.task_id, []);
    taskExecutions.get(execution.task_id).push(execution);
  }
  const warningMap = new Map();
  const addWarning = (warning) => {
    const key = `${warning.type}|${warning.execution_id ?? warning.task_id}`;
    const existing = warningMap.get(key);
    if (!existing) {
      warningMap.set(key, { ...warning, count: 1 });
      return;
    }
    existing.count += 1;
    existing.sources = [...new Set([...existing.sources, ...(warning.sources ?? [])])].slice(0, 12);
  };
  for (const fact of facts) {
    const summary = fact.summary ?? {};
    const candidateId = summary.artifact_material_id ?? summary.material_id ?? summary.material?.material_id ?? null;
    if (!fact.executionId && candidateId && candidateToExecution.has(candidateId)) fact.executionId = candidateToExecution.get(candidateId);
    if (!fact.executionId && summary.material_id && materialById.has(summary.material_id)) fact.executionId = materialById.get(summary.material_id).source_execution ?? null;
    if (!fact.executionId && fact.taskId && taskExecutions.has(fact.taskId)) {
      const at = timeMs(fact.at);
      const candidates = taskExecutions.get(fact.taskId).filter((execution) => {
        const start = timeMs(parseTime(execution.created_at));
        const end = timeMs(parseTime(execution.updated_at));
        return at === null || start === null || (at >= start && (end === null || at <= end));
      });
      if (candidates.length === 1) fact.executionId = candidates[0].execution_id;
    }
    if (!fact.taskId && fact.executionId) fact.taskId = model.executions.find((row) => row.execution_id === fact.executionId)?.task_id ?? null;
    // The adapter uses a worker-session identifier in the observation envelope
    // before a real Task is claimed. It is a session transport ID, not a
    // domain Execution reference, so keep it as bounded metadata instead of
    // manufacturing an Execution section or integrity warning.
    if (fact.executionId && !executionIds.has(fact.executionId) && !fact.taskId && /^worker-/.test(fact.executionId) && ['agent_rpc_request', 'agent_turn', 'agent_event', 'agent_settled', 'session_started', 'session_closed', 'process_event', 'tool_call'].includes(fact.kind)) {
      fact.summary = { ...fact.summary, session_transport_id: fact.executionId };
      fact.executionId = null;
    }
    if (fact.executionId && !executionIds.has(fact.executionId)) addWarning({ type: 'unknown_execution', execution_id: fact.executionId, fact_id: fact.id, sources: fact.sources });
    if (fact.taskId && !taskIds.has(fact.taskId)) addWarning({ type: 'unknown_task', task_id: fact.taskId, fact_id: fact.id, sources: fact.sources });
  }
  return [...warningMap.values()].sort((a, b) => `${a.type}|${a.execution_id ?? a.task_id}`.localeCompare(`${b.type}|${b.execution_id ?? b.task_id}`));
}

function factOperation(fact) {
  return fact.operation ?? fact.summary?.operation ?? fact.summary?.event ?? fact.kind;
}

function isBoundary(fact) {
  if (BOUNDARY_KINDS.has(fact.kind)) return true;
  const operation = factOperation(fact);
  return ['task_take', 'create_child_task', 'save_workspace_revision', 'publish_material', 'read_materials', 'consume_materials', 'workspace_check', 'apply_check_result', 'wait_for', 'wake_execution', 'resume_execution', 'accept_task', 'request_rework', 'stop_execution'].includes(operation);
}

function isSemanticBoundary(fact) {
  return new Set([
    'task_created', 'task_taken',
    'workspace_checked', 'judge_result', 'judge_check', 'judge_check_record',
    'wait_for_requested', 'wake', 'resume', 'review', 'rework', 'execution_terminal',
  ]).has(fact.kind) || (!['service_call_started', 'service_call_finished', 'database_operation', 'tool_call'].includes(fact.kind) && ['create_child_task', 'workspace_check', 'wait_for', 'wake_execution', 'resume_execution', 'accept_task', 'request_rework', 'stop_execution'].includes(factOperation(fact)));
}

function sourceLabels(facts) {
  return [...new Set(facts.flatMap((fact) => fact.sources))].sort();
}

function compactFact(fact) {
  const summary = fact.summary ?? {};
  const operation = factOperation(fact);
  if (fact.kind === 'tool_call') return `${operation ?? 'tool'} (${summary.outcome ?? 'observed'}) [${fact.id}]`;
  if (fact.kind === 'service_call_started' || fact.kind === 'service_call_finished') return `${summary.service ?? 'service'}:${operation ?? 'call'} ${summary.phase ?? ''}${summary.ok === false ? ' error' : ''} [${fact.id}]`.trim();
  if (fact.kind === 'material_published') return `publish Material ${summary.material?.material_id ?? summary.material_id ?? 'unknown'} [${fact.id}]`;
  if (fact.kind === 'material_read') return `read ${array(summary.material_ids).length} Material(s) [${fact.id}]`;
  if (fact.kind === 'material_consumed') return `consume ${array(summary.material_ids).length} Material(s)${summary.action ? ` for ${summary.action}` : ''} [${fact.id}]`;
  if (fact.kind === 'workspace_checked') return `workspace check ${summary.artifact_material_id ?? 'unknown'} [${fact.id}]`;
  if (fact.kind === 'checker_preflight') return `Checker preflight ${summary.status ?? 'unknown'}${summary.diagnostic_code ? `/${summary.diagnostic_code}` : ''} [${fact.id}]`;
  if (fact.kind === 'judge_result' || fact.kind === 'judge_check' || fact.kind === 'judge_check_record') return `Judge ${summary.verdict ?? summary.check_result?.verdict ?? 'result'}${summary.result_class ? `/${summary.result_class}` : ''}${summary.checker_process_status ? ` (${summary.checker_process_status})` : ''} [${fact.id}]`;
  if (fact.kind === 'workspace_revision' || fact.kind === 'workspace_manifest') return `Workspace revision ${summary.workspace_revision ?? 'unknown'} [${fact.id}]`;
  if (fact.kind === 'wait_for_requested') return `wait (${summary.wait_condition?.type ?? 'condition unknown'}) [${fact.id}]`;
  if (fact.kind === 'execution_assigned') return `Execution assigned [${fact.id}]`;
  if (fact.kind === 'execution_terminal') return `Execution terminal: ${summary.terminal_state ?? summary.execution?.state ?? 'unknown'} [${fact.id}]`;
  if (fact.kind === 'review' || fact.kind === 'rework') return `${summary.decision ?? fact.kind} [${fact.id}]`;
  if (fact.kind === 'heartbeat') return `heartbeat [${fact.id}]`;
  return `${operation ?? fact.kind} [${fact.id}]`;
}

function latestState(facts, execution) {
  for (const fact of [...facts].reverse()) {
    const state = fact.summary?.state ?? fact.summary?.task_state ?? fact.summary?.execution_state ?? fact.summary?.execution?.state ?? fact.summary?.task?.state;
    if (state) return state;
  }
  return execution?.state ?? 'unknown';
}

function resultForWindow(facts) {
  const meaningful = [...facts].reverse().find((fact) => ['judge_result', 'judge_check', 'judge_check_record', 'workspace_checked', 'wait_for_requested', 'review', 'rework', 'material_read', 'material_consumed', 'material_published', 'workspace_revision', 'execution_terminal', 'task_state_changed', 'execution_state_changed'].includes(fact.kind));
  const impactful = meaningful ?? [...facts].reverse().find((fact) => {
    const durableOperations = ['task_take', 'create_child_task', 'save_workspace_revision', 'publish_material', 'read_materials', 'consume_materials', 'workspace_check', 'apply_check_result', 'wait_for', 'wake_execution', 'resume_execution', 'accept_task', 'request_rework', 'stop_execution'];
    if (['heartbeat', 'agent_turn', 'agent_settled', 'process_event', 'agent_event', 'agent_rpc_request'].includes(fact.kind)) return false;
    if (durableOperations.includes(fact.operation)) return true;
    if (fact.kind === 'service_call_started' || fact.kind === 'service_call_finished') return Boolean(fact.summary?.ok === false || fact.summary?.error);
    return BOUNDARY_KINDS.has(fact.kind) || ['task_snapshot', 'execution_snapshot', 'material_record', 'judge_check_record'].includes(fact.kind);
  });
  if (!impactful) return 'No state-changing operation observed in this window.';
  const summary = impactful.summary ?? {};
  if (impactful.kind === 'judge_result' || impactful.kind === 'judge_check' || impactful.kind === 'judge_check_record') return `Judge returned ${summary.verdict ?? summary.check_result?.verdict ?? 'an observed result'}.`;
  if (impactful.kind === 'wait_for_requested') return `A concrete wait condition was recorded: ${summary.wait_condition?.type ?? 'condition not visible'}.`;
  if (impactful.kind === 'material_published') return `Material publication was recorded; semantic usefulness is not inferred.`;
  if (impactful.kind === 'material_read') return `Material read was recorded; durable consumption is checked separately.`;
  if (impactful.kind === 'material_consumed') return `Durable Material consumption was recorded for ${summary.action ?? 'an action'}; downstream effect is checked separately.`;
  if (impactful.kind === 'workspace_checked') return 'Workspace check was recorded.';
  if (impactful.kind === 'workspace_revision' || impactful.kind === 'workspace_manifest') return `Workspace revision ${summary.workspace_revision ?? 'unknown'} was recorded.`;
  if (summary.ok === false || summary.error) return `An error was returned by ${summary.service ?? 'a service'}; later activity is checked separately.`;
  return `Observed ${factOperation(impactful) ?? impactful.kind}.`;
}

function handoffForWindow(facts) {
  const material = facts.find((fact) => fact.kind === 'material_published');
  if (material) return `Material published; consumer/effect must be established by later records (${material.id}).`;
  const wait = facts.find((fact) => fact.kind === 'wait_for_requested');
  if (wait) return `Execution responsibility persisted with wait condition ${wait.summary?.wait_condition?.type ?? 'unknown'} (${wait.id}).`;
  const candidate = facts.find((fact) => fact.kind === 'workspace_checked');
  if (candidate) return `Candidate handed to Judge path (${candidate.id}).`;
  const review = facts.find((fact) => fact.kind === 'review' || fact.kind === 'rework');
  if (review) return `Parent review decision recorded (${review.id}).`;
  return 'none recorded';
}

function windowIntent(facts) {
  const explicit = facts.find((fact) => fact.operation || ['material_published', 'material_read', 'material_consumed', 'workspace_checked', 'judge_result', 'wait_for_requested', 'review', 'rework', 'workspace_revision'].includes(fact.kind));
  if (!explicit) return { label: 'unknown', confidence: 'unknown', basis: [] };
  return { label: intentFor(factOperation(explicit), explicit.kind), confidence: explicit.operation ? 'high' : 'medium', basis: [explicit.id] };
}

function semanticPhase(facts) {
  const kinds = new Set(facts.map((fact) => fact.kind));
  const operations = new Set(facts.map(factOperation));
  if (kinds.has('judge_result') || kinds.has('judge_check') || kinds.has('judge_check_record')) return 'candidate checking and feedback';
  if (kinds.has('workspace_checked') || operations.has('workspace_check')) return 'Workspace editing and checking';
  if (kinds.has('review') || kinds.has('rework')) return 'parent review and rework';
  if (kinds.has('wait_for_requested')) return 'coordination and waiting';
  if (kinds.has('material_published') || kinds.has('material_read') || kinds.has('material_consumed') || operations.has('create_child_task')) return 'research and collaboration handoff';
  if (kinds.has('workspace_revision') || operations.has('write_workspace_file') || operations.has('save_workspace_revision')) return 'Workspace editing';
  if (operations.has('task_take') || kinds.has('execution_assigned')) return 'Task discovery and take';
  if (facts.some((fact) => ['agent_turn', 'agent_event', 'agent_rpc_request'].includes(fact.kind))) return 'Agent reasoning activity';
  return 'runtime or lifecycle activity';
}

function semanticSummary(facts, previousWindow = null) {
  if (!facts.length) return {
    phase: 'no observed event',
    summary: 'No observable record was available in this interval; the gap does not prove that no work occurred.',
    route_change: 'unknown',
    durable_changes: [],
    event_counts: {},
    confidence: 'unknown',
  };
  const counts = {};
  for (const fact of facts) counts[fact.kind] = (counts[fact.kind] ?? 0) + 1;
  const phase = semanticPhase(facts);
  const durable = [...new Set(facts.filter((fact) => ['task_created', 'task_taken', 'task_state_changed', 'execution_assigned', 'workspace_revision', 'material_published', 'material_read', 'material_consumed', 'workspace_checked', 'judge_result', 'judge_check', 'judge_check_record', 'review', 'rework', 'wait_for_requested', 'wake', 'resume', 'execution_terminal'].includes(fact.kind)).map((fact) => compactFact(fact).replace(/ \[F-[A-Za-z0-9_-]+\]$/, '')))].slice(0, 8);
  const candidate = facts.find((fact) => fact.kind === 'workspace_checked');
  const judge = facts.find((fact) => ['judge_result', 'judge_check', 'judge_check_record'].includes(fact.kind));
  const material = facts.find((fact) => ['material_published', 'material_read', 'material_consumed'].includes(fact.kind));
  let summary = `The Agent was primarily engaged in ${phase.toLowerCase()}.`;
  if (candidate) summary += ' A candidate was handed to the Judge path.';
  if (judge) summary += ` Judge feedback was recorded (${judge.summary?.verdict ?? judge.summary?.check_result?.verdict ?? 'result unavailable'}).`;
  if (material && phase === 'research and collaboration handoff') summary += ' The observable handoff involved shared Material or a child Task.';
  if (previousWindow?.semantic_phase && previousWindow.semantic_phase !== phase) return {
    phase, summary: `The activity changed from ${previousWindow.semantic_phase} to ${phase}. ${summary}`,
    route_change: 'objective or lifecycle phase changed', durable_changes: durable, event_counts: counts, confidence: durable.length ? 'high' : 'medium',
  };
  return { phase, summary, route_change: 'no explicit route change observed', durable_changes: durable, event_counts: counts, confidence: durable.length ? 'medium' : 'low' };
}

function makeWindow(facts, startMs, endMs, { gap = false, previousWindow = null } = {}) {
  const sorted = [...facts].sort((a, b) => (timeMs(a.at) ?? startMs) - (timeMs(b.at) ?? startMs) || a.id.localeCompare(b.id));
  const intent = gap ? { label: 'unknown', confidence: 'unknown', basis: [] } : windowIntent(sorted);
  const semantic = semanticSummary(sorted, previousWindow);
  const operations = gap ? ['no observed event'] : [semantic.phase];
  return {
    time: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), duration_ms: Math.max(0, endMs - startMs), evidence_gap: gap },
    operations,
    semantic_phase: semantic.phase,
    semantic_summary: semantic.summary,
    route_change: semantic.route_change,
    durable_changes: semantic.durable_changes,
    event_counts: semantic.event_counts,
    semantic_confidence: semantic.confidence,
    observed_intent: intent.label,
    intent_basis: intent.basis,
    intent_confidence: intent.confidence,
    result: gap ? 'No observed event in this interval; absence is not evidence that no work occurred.' : resultForWindow(sorted),
    next_state: gap ? 'unknown' : latestState(sorted, null),
    handoff_or_blocker: gap ? 'evidence gap' : handoffForWindow(sorted),
    evidence: sourceLabels(sorted),
  };
}

function buildWindows(execution, facts, experimentEnd, maxWindowMs = DEFAULT_MAX_WINDOW_MS) {
  const timed = facts.filter((fact) => fact.at && timeMs(fact.at) !== null).sort((a, b) => timeMs(a.at) - timeMs(b.at) || a.id.localeCompare(b.id));
  if (!timed.length) {
    const start = timeMs(parseTime(execution.created_at)) ?? timeMs(parseTime(execution.updated_at)) ?? timeMs(parseTime(experimentEnd)) ?? Date.now();
    return [makeWindow([], start, start)];
  }
  const windows = [];
  let current = [timed[0]];
  let currentStart = timeMs(timed[0].at);
  for (let index = 1; index < timed.length; index += 1) {
    const fact = timed[index];
    const at = timeMs(fact.at);
    const previousAt = timeMs(timed[index - 1].at);
    const gap = at - previousAt;
    const phaseChanged = semanticPhase(current) !== semanticPhase([...current, fact]);
    const boundary = isSemanticBoundary(fact) && phaseChanged && at - currentStart > 1000;
    if (gap >= SILENT_GAP_MS) {
      windows.push(makeWindow(current, currentStart, previousAt, { previousWindow: windows.at(-1) ?? null }));
      windows.push(makeWindow([], previousAt, at, { gap: true }));
      current = [fact]; currentStart = at; continue;
    }
    if (boundary && at > currentStart) {
      windows.push(makeWindow(current, currentStart, at, { previousWindow: windows.at(-1) ?? null }));
      current = [fact]; currentStart = at; continue;
    }
    if (at - currentStart >= maxWindowMs) {
      windows.push(makeWindow(current, currentStart, previousAt, { previousWindow: windows.at(-1) ?? null }));
      const splitAt = previousAt;
      if (at > splitAt) windows.push(makeWindow([], splitAt, at, { gap: true }));
      current = [fact]; currentStart = at; continue;
    }
    current.push(fact);
  }
  const finalAt = timeMs(timed.at(-1).at);
  windows.push(makeWindow(current, currentStart, finalAt, { previousWindow: windows.at(-1) ?? null }));
  return windows.filter((window) => window.time.duration_ms > 0 || window.operations.length > 0);
}

function materialCollaboration(model, facts) {
  const published = facts.filter((fact) => fact.kind === 'material_published');
  const consumed = facts.filter((fact) => fact.kind === 'material_consumed');
  const downstreamKinds = new Set(['workspace_revision', 'workspace_checked', 'judge_result', 'judge_check', 'review', 'rework']);
  const rows = [];
  for (const material of model.materials) {
    const materialId = material.material_id;
    const pub = published.find((fact) => fact.summary?.material?.material_id === materialId || fact.summary?.material_id === materialId);
    const readsForMaterial = consumed.filter((fact) => array(fact.summary?.material_ids).includes(materialId));
    const knownReadKeys = new Set(readsForMaterial.filter((read) => read.executionId).map((read) => `${read.at}|${array(read.summary?.material_ids).join(',')}`));
    const reads = readsForMaterial.filter((read) => read.executionId || !knownReadKeys.has(`${read.at}|${array(read.summary?.material_ids).join(',')}`));
    const linkedReads = reads.filter((read) => read.executionId && read.at);
    const effects = facts.filter((fact) => downstreamKinds.has(fact.kind) && fact.at && linkedReads.some((read) => read.executionId === fact.executionId && timeMs(fact.at) >= timeMs(read.at)));
    let assessment = 'no recorded consumer';
    if (material.evidence_state === 'accepted' && reads.length === 0) assessment = 'accepted-but-unused';
    else if (reads.length && !effects.length) assessment = 'consumed-without-recorded-downstream-effect';
    else if (reads.length && effects.length) assessment = 'explicit downstream operation recorded; semantic usefulness not inferred';
    rows.push({
      material_id: materialId, kind: material.kind, evidence_state: material.evidence_state,
      publisher: { task_id: material.source_task, execution_id: material.source_execution },
      published_evidence: pub?.id ?? evidenceRef(material.source),
      consumers: reads.map((fact) => ({ execution_id: fact.executionId, task_id: fact.taskId, evidence: fact.id })),
      downstream_effects: effects.slice(0, 8).map((fact) => ({ kind: fact.kind, execution_id: fact.executionId, evidence: fact.id })),
      assessment,
    });
  }
  return rows;
}

function executionInventory(model, facts, experimentEnd, maxWindowMs = DEFAULT_MAX_WINDOW_MS) {
  const ids = new Set([
    ...model.executions.map((row) => row.execution_id),
    ...facts.map((fact) => fact.executionId).filter(Boolean),
  ]);
  const byTask = new Map();
  for (const row of model.executions) {
    const group = byTask.get(row.task_id) ?? [];
    group.push(row);
    byTask.set(row.task_id, group);
  }
  for (const group of byTask.values()) group.sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
  return [...ids].sort().map((executionId) => {
    const execution = model.executions.find((row) => row.execution_id === executionId) ?? { execution_id: executionId, task_id: null, state: 'unknown', created_at: null, updated_at: null };
    const executionFacts = facts.filter((fact) => fact.executionId === executionId);
    const coreIds = [...new Set([String(execution.owner_ref ?? '').match(/core-\d+/)?.[0], ...executionFacts.map((fact) => fact.coreId)].filter(Boolean))].sort();
    const sessionIds = [...new Set(executionFacts.map((fact) => fact.sessionId).filter(Boolean))].sort();
    const workspaceRefs = [...new Set([execution.workspace_ref, ...executionFacts.map((fact) => fact.summary?.workspace_ref).filter(Boolean)].filter(Boolean))].sort();
    const siblings = byTask.get(execution.task_id) ?? [];
    const position = siblings.findIndex((row) => row.execution_id === executionId);
    const predecessor = null;
    const successor = null;
    return {
      execution,
      facts: executionFacts,
      windows: buildWindows(execution, executionFacts, experimentEnd, maxWindowMs),
      lifecycle_role: predecessor || successor ? 'later Execution for the same Task (rework relation unconfirmed)' : 'initial or only Execution',
      predecessor_execution_id: predecessor?.execution_id ?? null,
      successor_execution_id: successor?.execution_id ?? null,
      counts: Object.fromEntries([...new Set(executionFacts.map((fact) => fact.kind))].sort().map((kind) => [kind, executionFacts.filter((fact) => fact.kind === kind).length])),
      sources: sourceLabels(executionFacts),
      coreIds,
      sessionIds,
      workspaceRefs,
      waitCondition: execution.wait_condition ?? executionFacts.findLast((fact) => fact.kind === 'wait_for_requested')?.summary?.wait_condition ?? null,
    };
  });
}

function markEvidenceStatuses(evidence, errors) {
  const hasError = (entryName, error, entry) => {
    const path = String(error.path ?? '');
    if (entry.paths.some((candidate) => candidate === path)) return true;
    if (entryName === 'metadata') return path.startsWith('metadata/');
    if (entryName === 'agent') return path.includes('/agents/') || path.includes('agents/');
    if (entryName === 'bridge') return path.includes('/bridge/') || path.includes('bridge/');
    if (entryName === 'runtime') return path.includes('/runtime/') || path.includes('runtime/');
    if (entryName === 'service') return path.includes('/services/') || path.includes('services/');
    if (entryName === 'judge') return path.includes('/judge/') || path.includes('judge/') || path.includes('judge-service.ndjson');
    if (entryName === 'sqlite') return path.includes('/state/') || path.includes('state/');
    if (entryName === 'observation') return path.includes('observability.sqlite');
    if (entryName === 'workspace') return path.includes('/workspaces/') || path.includes('workspaces/');
    if (entryName === 'summary') return path.includes('report.json') || path.includes('aggregate-report.json');
    return false;
  };
  return evidence.map((entry) => ({
    ...entry,
    status: errors.some((error) => error.kind !== 'correlation' && hasError(entry.class, error, entry)) ? 'malformed' : entry.status,
  }));
}

function aggregateSummary(summaries, model, facts, inventory) {
  const run = (summaries.find((summary) => summary.data?.run?.protocol_valid !== null || summary.data?.run?.solved !== null) ?? summaries[0])?.data?.run ?? {};
  const candidates = model.checks.length ? model.checks : facts.filter((fact) => fact.kind === 'workspace_checked');
  const judges = model.checks.length ? model.checks : facts.filter((fact) => ['judge_result', 'judge_check', 'judge_check_record'].includes(fact.kind));
  const waits = model.operations.filter((operation) => operation.operation === 'wait_for');
  const heartbeats = facts.filter((fact) => fact.kind === 'heartbeat');
  return {
    experiment_id: inventory.experimentId,
    problem_ids: inventory.projectIds,
    status: inventory.metadata.experiment?.status ?? null,
    started_at: inventory.metadata.experiment?.started_at ?? run.started_at ?? null,
    ended_at: inventory.metadata.experiment?.ended_at ?? run.ended_at ?? null,
    solved: run.solved ?? (inventory.metadata.experiment?.result && inventory.metadata.experiment.result.project_count !== undefined
      ? inventory.metadata.experiment.result.solved_count === inventory.metadata.experiment.result.project_count
      : null),
    protocol_valid: run.protocol_valid ?? inventory.metadata.experiment?.valid_for_analysis ?? null,
    made_progress_summary: run.made_progress ?? null,
    task_count: model.tasks.length,
    execution_count: inventory.executions_count ?? model.executions.length,
    material_count: model.materials.length,
    candidate_count: candidates.length || model.checks.length,
    judge_event_count: judges.length || model.checks.length,
    wait_count: waits.length,
    heartbeat_count: heartbeats.length,
  };
}

function buildErrorAnalysis(facts) {
  const groups = new Map();
  const baseKeyFor = (fact) => `${fact.operation ?? fact.kind}|${fact.at ? fact.at.slice(0, 19) : 'untimed'}`;
  for (const fact of facts) {
    const info = errorInfo(fact);
    if (!info) continue;
    const category = errorCategory(info, fact);
    const baseKey = baseKeyFor(fact);
    let key = `${category}|${baseKey}`;
    // Agent-visible "tool error" records are the transport echo of the
    // Service failure at the same operation/time. Count them as evidence for
    // the same occurrence instead of inflating the failure total.
    if (category === 'agent_tool_error') {
      const related = [...groups.values()].find((group) => group.base_key === baseKey && group.category !== 'agent_tool_error');
      if (related) key = related.key;
    }
    let group = groups.get(key);
    if (!group) {
      group = { key, base_key: baseKey, category, code: info.code, operation: fact.operation ?? fact.kind, occurrences: new Set(), supporting_records: 0, tasks: new Set(), executions: new Set(), sources: new Set(), first_at: fact.at, last_at: fact.at };
      groups.set(key, group);
    }
    group.occurrences.add(fact.at ? fact.at.slice(0, 19) : 'untimed');
    group.supporting_records += Math.max(1, fact.sources.length);
    if (fact.taskId) group.tasks.add(fact.taskId);
    if (fact.executionId) group.executions.add(fact.executionId);
    for (const source of fact.sources) if (group.sources.size < 16) group.sources.add(source);
    if (fact.at && (!group.first_at || fact.at < group.first_at)) group.first_at = fact.at;
    if (fact.at && (!group.last_at || fact.at > group.last_at)) group.last_at = fact.at;
  }
  return [...groups.values()].map((group) => {
    const common = {
      category: group.category,
      code: group.code,
      operation: group.operation,
      occurrence_count: group.occurrences.size,
      supporting_record_count: group.supporting_records,
      affected_tasks: [...group.tasks].sort(),
      affected_executions: [...group.executions].sort(),
      first_at: group.first_at,
      last_at: group.last_at,
      evidence: [...group.sources],
      confidence: 'high',
    };
    if (group.category === 'take_active_execution_quota') return {
      ...common,
      severity: 'medium',
      interpretation: 'Several Agents attempted to take a Task while its active Execution quota was full. This is contention and retry waste, not evidence of state corruption by itself.',
      next_optimization: 'Make claimability quota-aware before dispatch, and add bounded per-Core backoff after this conflict.',
    };
    if (group.category === 'check_result_contract_mismatch') return {
      ...common,
      severity: 'medium',
      interpretation: 'An Agent applied Judge feedback to a Task whose completion contract did not require a CheckResult. The Service correctly rejected the operation, but the turn was spent on an invalid route.',
      next_optimization: 'Expose completion-contract capabilities in the task prompt/tool boundary and gate apply_check_result to proof Tasks that require checks.',
    };
    if (group.category === 'agent_tool_error') return {
      ...common,
      severity: 'low',
      interpretation: 'The Agent received a tool error without a matched structured Service error in the available evidence.',
      next_optimization: 'Preserve the operation/correlation ID through the Agent tool result so the next analysis can classify the underlying Service cause.',
    };
    return {
      ...common,
      severity: 'medium',
      interpretation: 'A structured Service or checker error was recorded. The available evidence does not justify a stronger causal claim.',
      next_optimization: 'Inspect the cited operation and add a targeted recovery or contract test before changing Runtime behavior.',
    };
  }).sort((a, b) => b.occurrence_count - a.occurrence_count || a.category.localeCompare(b.category));
}

function buildSystemFindings(analysis) {
  const findings = [];
  const scopeForExecutions = (executionIds) => {
    const rows = analysis.executions.filter((item) => executionIds.includes(item.execution.execution_id));
    return {
      affected_tasks: [...new Set(rows.map((item) => item.execution.task_id).filter(Boolean))],
      affected_executions: [...new Set(executionIds)],
      affected_cores: [...new Set(rows.flatMap((item) => item.coreIds))],
    };
  };
  const configuredCores = Number(analysis.inventory.metadata?.experiment?.protocol?.core_count ?? 0);
  const start = timeMs(analysis.aggregate.started_at);
  const end = timeMs(analysis.aggregate.ended_at);
  const elapsed = start !== null && end !== null ? Math.max(0, end - start) : null;
  const executionIntervals = analysis.model.executions.map((execution) => ({
    execution,
    start: timeMs(parseTime(execution.created_at)),
    end: timeMs(parseTime(execution.updated_at)),
  })).filter((item) => item.start !== null && item.end !== null);
  let maxOverlap = 0;
  for (const point of [...new Set(executionIntervals.flatMap((item) => [item.start, item.end]))]) {
    const overlap = executionIntervals.filter((item) => item.start <= point && item.end >= point).length;
    maxOverlap = Math.max(maxOverlap, overlap);
  }
  if (configuredCores > 1 && executionIntervals.length && maxOverlap <= 1) findings.push({
    severity: 'medium', category: 'serial-or-supply-limited', title: 'Configured Core capacity was not reflected in overlapping Executions',
    interpretation: `The authoritative Execution intervals overlap at most ${maxOverlap} at a time while ${configuredCores} Cores were configured. This is a system-level serialization signal; the trace does not by itself identify whether the cause was insufficient ready work, take policy, or Agent behavior.`,
    validation: 'Run with the same workload and record ready-work, take, and Core assignment intervals; require at least two independent Tasks to overlap before labeling scheduling defective.',
    ...scopeForExecutions(executionIntervals.map((item) => item.execution.execution_id)),
    evidence: executionIntervals.map((item) => evidenceRef(item.execution.source)).filter(Boolean), confidence: 'medium',
  });
  if (configuredCores > 1 && elapsed !== null && executionIntervals.length) {
    const coreMs = executionIntervals.reduce((sum, item) => sum + Math.max(0, item.end - item.start) * Math.max(1, analysis.executions.find((row) => row.execution.execution_id === item.execution.execution_id)?.coreIds.length ?? 1), 0);
    const proxy = coreMs / (configuredCores * elapsed);
    if (proxy < 0.5) findings.push({
      severity: 'medium', category: 'low_core_occupancy', title: 'Core occupancy proxy stayed below half of configured capacity',
      interpretation: `The derived Execution-duration proxy is ${(proxy * 100).toFixed(1)}% of configured Core capacity. This is a supply/dispatch diagnostic, not proof of wasted Agent time because IDLE, WAITING, Judge, and ready-work intervals are not all represented by Execution duration.`,
      validation: 'Compare Runtime RUNNING intervals, ready-unassigned time, and Task supply before changing scheduler policy.',
      ...scopeForExecutions(analysis.executions.map((row) => row.execution.execution_id)),
      evidence: analysis.executions.flatMap((row) => row.sources).slice(0, 8), confidence: 'low',
    });
  }
  const noConsumer = analysis.collaboration.filter((row) => row.assessment === 'no recorded consumer');
  if (noConsumer.length) {
    const executionIds = noConsumer.map((row) => row.publisher.execution_id).filter(Boolean);
    findings.push({
    severity: 'medium', category: 'delivery_without_consumption', title: 'Child or Material delivery has no recorded consumer',
    interpretation: `${noConsumer.length} Material(s) have no recorded consumer. This is a collaboration-loop failure or an evidence gap; it is not a judgment that the content was mathematically useless.`,
    validation: 'Require an explicit parent read and review/rework decision for each child delivery, then compare root progress after the read.',
    ...scopeForExecutions(executionIds),
    evidence: noConsumer.map((row) => evidenceRef(row.published_evidence)).slice(0, 12), confidence: 'medium',
    });
  }
  const infrastructureRows = analysis.candidates.rows.filter((row) => row.result_class === 'infrastructure_failure');
  if (infrastructureRows.length) {
    const diagnosticGroups = new Map();
    for (const row of infrastructureRows) {
      const key = `${row.diagnostic_class ?? 'checker_unavailable'}|${row.checker_process_status ?? 'unknown'}`;
      const group = diagnosticGroups.get(key) ?? { count: 0, rows: [] };
      group.count += 1;
      group.rows.push(row);
      diagnosticGroups.set(key, group);
    }
    for (const [key, group] of diagnosticGroups) {
      const [diagnostic, processStatus] = key.split('|');
      const executionIds = group.rows.map((row) => row.execution_id).filter(Boolean);
      findings.push({
        severity: 'critical', category: 'checker_unavailable', title: 'Checker infrastructure failed before a mathematical result was produced',
        interpretation: `${group.count} Candidate check(s) reached the Judge but the Checker process status was ${processStatus}; the recorded diagnostic was ${diagnostic}. These Candidates are mathematically unassessed. The causal risk is that Agent retries consume the timebox as if this were proof feedback.`,
        validation: 'Run the same locked fixture with Checker preflight and require a source-level PASS/FAIL when the process starts; when preflight fails, require bounded retry followed by BLOCKED(checker_unavailable) and Core release.',
        ...scopeForExecutions(executionIds),
        evidence: group.rows.flatMap((row) => row.evidence).slice(0, 12), confidence: 'high',
      });
    }
  }
  if (analysis.candidates.repeated_diagnostics.length) findings.push({
    severity: 'high', category: 'feedback_loop_no_route_change', title: 'Repeated Judge diagnostics did not produce a recorded route change',
    interpretation: `The same diagnostic class repeats for ${analysis.candidates.repeated_diagnostics.map((row) => `${row.task_id} (${row.count})`).join(', ')}. Candidate checking continued, but the available metadata does not show a meaningful strategy change.`,
    validation: 'Require each repeated diagnostic to be followed by a changed Workspace route, parent review, or bounded research Task before another submission.',
    ...scopeForExecutions(analysis.candidates.rows.filter((row) => analysis.candidates.repeated_diagnostics.some((diagnostic) => diagnostic.task_id === row.task_id)).map((row) => row.execution_id).filter(Boolean)),
    evidence: analysis.candidates.repeated_diagnostics.flatMap((row) => row.evidence).slice(0, 12), confidence: 'medium',
  });
  return findings;
}

function buildServiceAnalysis(facts) {
  const rows = new Map();
  for (const fact of facts.filter((item) => ['service_call_started', 'service_call_finished'].includes(item.kind))) {
    const service = fact.summary?.service ?? 'unknown service';
    const row = rows.get(service) ?? { service, started: 0, finished: 0, failed: 0, operations: new Set(), evidence: new Set() };
    if (fact.kind === 'service_call_started') row.started += 1;
    else {
      row.finished += 1;
      if (fact.summary?.ok === false || fact.summary?.error || errorInfo(fact)) row.failed += 1;
    }
    if (fact.operation) row.operations.add(fact.operation);
    for (const source of fact.sources) row.evidence.add(source);
    rows.set(service, row);
  }
  return [...rows.values()].sort((a, b) => a.service.localeCompare(b.service)).map((row) => ({
    ...row,
    operations: [...row.operations].sort(),
    evidence: [...row.evidence].slice(0, 8),
    observed_failure_rate: row.finished ? row.failed / row.finished : null,
  }));
}

function buildToolAnalysis(analysis) {
  const toolFacts = analysis.facts.filter((fact) => fact.kind === 'tool_call');
  const toolErrors = toolFacts.filter((fact) => fact.summary?.outcome === 'error' || errorInfo(fact));
  const checks = analysis.model.checks.length ? analysis.model.checks : analysis.facts.filter((fact) => ['judge_result', 'judge_check', 'judge_check_record'].includes(fact.kind));
  const preflights = analysis.model.preflights ?? [];
  const infrastructureFailures = checks.filter((check) => check.result_class === 'infrastructure_failure');
  const sourceFailures = checks.filter((check) => check.result_class === 'source_failure' || (check.result_class === undefined && check.verdict === 'FAIL'));
  const unassessed = checks.filter((check) => check.result_class === 'infrastructure_failure' || check.result_class === 'unassessed' || check.mathematical_outcome === 'unassessed');
  const diagnostics = checks.filter((check) => (check.diagnostic_class ?? check.evidence?.diagnostic ?? check.verdict) && check.verdict !== 'PASS');
  const providerErrors = analysis.errors.filter((error) => /provider|transport|timeout|rate|upstream/i.test(`${error.category} ${error.code ?? ''} ${error.operation}`));
  return {
    tool_calls: toolFacts.length,
    tool_errors: toolErrors.length,
    provider_error_occurrences: providerErrors.reduce((sum, error) => sum + error.occurrence_count, 0),
    judge_checks: checks.length,
    judge_non_pass: diagnostics.length,
    judge_infrastructure_failures: infrastructureFailures.length,
    judge_source_failures: sourceFailures.length,
    judge_unassessed: unassessed.length,
    checker_preflight_count: preflights.length,
    checker_preflight_unavailable: preflights.filter((preflight) => preflight.status === 'unavailable').length,
    checker_preflight_healthy: preflights.filter((preflight) => preflight.status === 'healthy').length,
    judge_diagnostic_classes: [...new Set(diagnostics.map((check) => check.diagnostic_class ?? 'unknown'))].sort(),
    evidence: [...new Set([...toolFacts, ...checks, ...preflights].flatMap((fact) => fact.sources ?? []))].slice(0, 12),
  };
}

function buildCandidateAnalysis(model, facts) {
  const submissions = new Map();
  for (const fact of facts.filter((candidate) => candidate.kind === 'workspace_checked')) {
    const candidateId = fact.summary?.artifact_material_id;
    if (!candidateId || !fact.executionId) continue;
    const existing = submissions.get(candidateId);
    if (!existing || (fact.at && (!existing.at || fact.at < existing.at))) submissions.set(candidateId, fact);
  }
  const orderedChecks = [...model.checks].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const rows = orderedChecks.map((check, index) => {
    const resultClass = check.result_class ?? (check.verdict === 'PASS' ? 'PASS' : check.verdict === 'FAIL' ? 'source_failure' : 'unassessed');
    const checkerProcessStatus = check.checker_process_status ?? (resultClass === 'source_failure' || resultClass === 'PASS' ? 'completed' : 'unknown');
    const mathematicalOutcome = resultClass === 'PASS' ? 'PASS' : resultClass === 'source_failure' ? 'FAIL' : 'unassessed';
    const submission = submissions.get(check.artifact_material_id);
    const start = timeMs(parseTime(check.created_at));
    const end = timeMs(parseTime(check.updated_at));
    const feedbackReads = facts.filter((fact) => fact.executionId === check.execution_id && ['get_check_result', 'apply_check_result'].includes(fact.operation) && timeMs(fact.at) !== null && end !== null && timeMs(fact.at) >= end).length;
    const laterActions = facts.filter((fact) => fact.executionId === check.execution_id && ['workspace_revision', 'workspace_checked', 'material_published', 'material_consumed', 'review', 'rework'].includes(fact.kind) && timeMs(fact.at) !== null && end !== null && timeMs(fact.at) >= end).map((fact) => fact.kind);
    const visibleRevisions = facts.filter((fact) => fact.executionId === check.execution_id && fact.kind === 'workspace_revision' && timeMs(fact.at) !== null && start !== null && timeMs(fact.at) <= start).slice(-3);
    const changedFiles = [...new Set(visibleRevisions.flatMap((fact) => array(fact.summary?.changed_files)))].slice(0, 8);
    const strategySummary = changedFiles.length
      ? `The visible Workspace revision reports ${changedFiles.length} changed file(s); file names and proof contents are omitted from the shareable report.`
      : 'No bounded strategy metadata was recorded; a semantic reviewer must inspect the cited Agent objective and Workspace revision references.';
    const previousCheck = index > 0 ? orderedChecks[index - 1] : null;
    const previous = previousCheck ? {
      diagnostic_class: previousCheck.diagnostic_class ?? 'unknown',
      strategy_fingerprint: [...new Set(facts.filter((fact) => fact.executionId === previousCheck.execution_id && fact.kind === 'workspace_revision').flatMap((fact) => array(fact.summary?.changed_files)))].join('|'),
    } : null;
    const changeFromPrevious = !previous
      ? 'initial Candidate; no previous route to compare'
      : previous.diagnostic_class === (check.diagnostic_class ?? 'unknown') && previous.strategy_fingerprint === changedFiles.join('|')
        ? 'same diagnostic class and same visible Workspace change pattern'
        : 'visible diagnostic or Workspace change pattern differs from the previous Candidate';
    return {
      artifact_material_id: check.artifact_material_id,
      check_result_id: check.check_result_id,
      task_id: check.target_task_id,
      execution_id: check.execution_id,
      verdict: check.verdict ?? 'unknown',
      status: check.status,
      diagnostic_class: check.diagnostic_code ?? check.diagnostic_class ?? 'unknown',
      result_class: resultClass,
      checker_process_status: checkerProcessStatus,
      mathematical_outcome: mathematicalOutcome,
      retryable: check.retryable === undefined ? null : Boolean(check.retryable),
      preflight_verified: check.evidence?.preflight_verified ?? null,
      infrastructure_attempt_count: check.evidence?.infrastructure_attempt_count ?? null,
      submitted_at: submission?.at ?? check.created_at,
      checked_at: check.updated_at,
      check_elapsed_ms: start !== null && end !== null ? Math.max(0, end - start) : null,
      workspace_revision: submission?.summary?.workspace_revision ?? null,
      feedback_reads: feedbackReads,
      later_actions: [...new Set(laterActions)],
      strategy_summary: strategySummary,
      strategy_fingerprint: changedFiles.join('|'),
      change_from_previous: changeFromPrevious,
      feedback_response: resultClass === 'infrastructure_failure'
        ? (check.retryable === false ? 'Checker health failure reached the retry bound; no mathematical route conclusion is valid.' : 'Checker health failure was exposed as infrastructure feedback; mathematical progress is unassessed.')
        : feedbackReads ? 'Judge feedback was explicitly read; whether the mathematical route improved remains an interpretation.' : 'No explicit Judge feedback read was recorded before later activity.',
      evidence: [...new Set([check.source.ref, ...(submission?.sources ?? [])])],
    };
  });
  const checkedIds = new Set(rows.map((row) => row.artifact_material_id));
  for (const submission of submissions.values()) {
    const candidateId = submission.summary?.artifact_material_id;
    if (candidateId && !checkedIds.has(candidateId)) rows.push({
      artifact_material_id: candidateId,
      check_result_id: null,
      task_id: submission.taskId,
      execution_id: submission.executionId,
      verdict: 'no recorded CheckResult',
      status: 'unknown',
      diagnostic_class: 'unknown',
      result_class: 'unassessed',
      checker_process_status: 'unknown',
      mathematical_outcome: 'unassessed',
      retryable: null,
      infrastructure_attempt_count: null,
      submitted_at: submission.at,
      checked_at: null,
      check_elapsed_ms: null,
      workspace_revision: submission.summary?.workspace_revision ?? null,
      feedback_reads: 0,
      later_actions: [],
      evidence: submission.sources,
    });
  }
  rows.sort((a, b) => String(a.submitted_at ?? '').localeCompare(String(b.submitted_at ?? '')));
  const diagnosticCounts = {};
  for (const row of rows) {
    if (row.result_class !== 'source_failure') continue;
    const key = `${row.task_id}|${row.diagnostic_class}`;
    diagnosticCounts[key] = (diagnosticCounts[key] ?? 0) + 1;
  }
  const repeated = Object.entries(diagnosticCounts).filter(([key, count]) => !key.endsWith('|unknown') && count >= 2).map(([key, count]) => {
    const [task_id, diagnostic_class] = key.split('|');
    return { task_id, diagnostic_class, count, evidence: rows.filter((row) => row.task_id === task_id && row.diagnostic_class === diagnostic_class).flatMap((row) => row.evidence).slice(0, 12) };
  });
  return {
    rows,
    pass_count: rows.filter((row) => row.mathematical_outcome === 'PASS').length,
    fail_count: rows.filter((row) => row.result_class === 'source_failure').length,
    infrastructure_failure_count: rows.filter((row) => row.result_class === 'infrastructure_failure').length,
    unassessed_count: rows.filter((row) => row.mathematical_outcome === 'unassessed').length,
    repeated_diagnostics: repeated,
    all_failed: rows.length > 0 && rows.every((row) => row.result_class === 'source_failure'),
  };
}

function buildTerminalAnalysis(analysis) {
  const end = timeMs(analysis.aggregate.ended_at);
  const finalFailed = analysis.model.executions.filter((execution) => execution.state === 'FAILED' && end !== null && timeMs(parseTime(execution.updated_at)) !== null && end - timeMs(parseTime(execution.updated_at)) <= 5_000);
  const unfinishedTasks = analysis.model.tasks.filter((task) => ['OPEN', 'RUNNING', 'WAITING', 'BLOCKED'].includes(task.state));
  if (!analysis.aggregate.solved && finalFailed.length && unfinishedTasks.length) {
    return {
      category: 'timebox_or_incomplete_cleanup',
      confidence: 'medium',
      interpretation: 'The experiment ended with a recently failed Execution while Tasks remained OPEN or WAITING. The trace supports timebox/cleanup truncation as a likely explanation; it does not prove a scheduler failure.',
      affected_executions: finalFailed.map((execution) => execution.execution_id),
      unfinished_tasks: unfinishedTasks.map((task) => ({ task_id: task.task_id, state: task.state })),
      evidence: [...finalFailed.map((execution) => execution.source.ref), ...unfinishedTasks.map((task) => task.source.ref), 'metadata/experiment.json'],
      next_optimization: 'Persist an explicit experiment-timebox terminal reason, wake/cancel dependent waits during cleanup, and report unfinished Task contracts separately from Agent/Service errors.',
    };
  }
  return null;
}

function buildOptimizationRecommendations(analysis) {
  const recommendations = [];
  const add = (priority, category, action, rationale, validation, evidence) => recommendations.push({ priority, category, action, rationale, validation, evidence: [...new Set(evidence)].slice(0, 12) });
  const categories = new Set(analysis.errors.map((error) => error.category));
  if (categories.has('take_active_execution_quota')) {
    const count = analysis.errors.filter((error) => error.category === 'take_active_execution_quota').reduce((total, error) => total + error.occurrence_count, 0);
    add('P1', 'take contention', 'Make the eligible queue quota-aware; after a conflict, back off and refresh the queue.', `This run produced ${count} unique quota conflict occurrence(s) while active Executions already owned the work.`, 'Count unique quota conflicts per run and require the next retry to occur only after claimability changes.', analysis.errors.filter((error) => error.category === 'take_active_execution_quota').flatMap((error) => error.evidence));
  }
  if (categories.has('check_result_contract_mismatch')) {
    const count = analysis.errors.filter((error) => error.category === 'check_result_contract_mismatch').reduce((total, error) => total + error.occurrence_count, 0);
    add('P1', 'task-contract/tool mismatch', 'Expose completion-contract capabilities to the Agent and prevent apply_check_result on research Tasks that do not require a CheckResult.', `This run recorded ${count} unique invalid operation occurrence(s) with the same NOT_ALLOWED contract error.`, 'Run a research Task fixture and assert zero apply_check_result calls, while proof Tasks still apply matching results.', analysis.errors.filter((error) => error.category === 'check_result_contract_mismatch').flatMap((error) => error.evidence));
  }
  if (analysis.candidates.all_failed || analysis.candidates.repeated_diagnostics.length) {
    add('P1', 'candidate route control', 'After two consecutive FAILs in the same diagnostic class, require a documented route change, parent review, or a bounded research Task before another submission.', `${analysis.candidates.fail_count} of ${analysis.candidates.rows.length} recorded checks failed; repeated diagnostic classes did not produce a PASS.`, 'Report diagnostic-class transitions and compare the next Candidate against the previous feedback before allowing another attempt.', analysis.candidates.repeated_diagnostics.flatMap((row) => row.evidence));
  }
  if (analysis.terminal) {
    add('P1', 'timebox cleanup', analysis.terminal.next_optimization, analysis.terminal.interpretation, 'Run a short timebox fixture with a waiting Root and open Child; assert explicit terminal reason and no orphaned wait.', analysis.terminal.evidence);
  }
  const unconsumed = analysis.collaboration.filter((row) => row.assessment === 'no recorded consumer');
  if (unconsumed.length) {
    add('P2', 'handoff visibility', 'Make parent review/Material consumption explicit before treating a child result as delivered.', `${unconsumed.length} Material(s) had no recorded consumer in this run; this is an evidence result, not a claim that they were useless.`, 'Add a report assertion for each published Material: consumer, downstream operation, or explicit no-consumer state.', unconsumed.map((row) => row.published_evidence));
  }
  if (analysis.errors.length) add('P0', 'analysis quality', 'Keep the cross-source operation-chain deduplication and add regression fixtures for Service/Observation/Agent echoes.', 'The same failure appears in multiple layers; the report must preserve supporting evidence without counting it as independent failures.', 'A fixture should produce one unique occurrence with multiple supporting source references.', analysis.errors.flatMap((error) => error.evidence));
  return recommendations;
}

function deriveConclusions(analysis) {
  const conclusions = [];
  const statuses = Object.fromEntries(analysis.inventory.evidence.map((entry) => [entry.class, entry.status]));
  const missing = EVIDENCE_CLASSES.filter((name) => name !== 'summary' && ['missing', 'empty', 'malformed'].includes(statuses[name]));
  conclusions.push({ type: 'Fact', text: `The analyzer found ${analysis.executions.length} Execution(s), ${analysis.model.tasks.length} Task(s), ${analysis.model.materials.length} Material(s), and ${analysis.model.checks.length} Judge check record(s).`, evidence: analysis.executions.flatMap((item) => item.sources).slice(0, 8) });
  if (missing.length) conclusions.push({ type: 'Unknown', text: `The evidence boundary is incomplete or malformed for: ${missing.join(', ')}. The report is diagnostic-only for conclusions that depend on those sources.`, evidence: missing.map((name) => `missing evidence class: ${name}`) });
  else conclusions.push({ type: 'Fact', text: 'The expected local evidence classes were found; source-level gaps and integrity warnings are still reported below.', evidence: analysis.inventory.evidence.flatMap((entry) => entry.paths).slice(0, 12) });
  if (analysis.collaboration.some((row) => row.assessment === 'accepted-but-unused')) conclusions.push({ type: 'Interpretation', text: 'At least one Material is marked accepted but has no recorded consumer. This is an evidence-backed handoff result, not a claim that the Material was mathematically useless.', evidence: analysis.collaboration.filter((row) => row.assessment === 'accepted-but-unused').map((row) => row.published_evidence) });
  if (analysis.warnings.length) conclusions.push({ type: 'Unknown', text: `${analysis.warnings.length} event reference(s) point to an unknown Task or Execution in the authoritative model. Those events are retained as unmatched facts.`, evidence: analysis.warnings.slice(0, 8).flatMap((warning) => warning.sources ?? []) });
  for (const error of analysis.errors.slice(0, 8)) conclusions.push({ type: 'Interpretation', text: `${error.occurrence_count} unique ${error.category} occurrence(s) were found for ${error.operation}: ${error.interpretation}`, evidence: error.evidence.slice(0, 8) });
  if (analysis.candidates.infrastructure_failure_count) conclusions.push({ type: 'Interpretation', text: `${analysis.candidates.infrastructure_failure_count} Candidate check(s) were infrastructure failures and produced no mathematical verdict. They are reported as unassessed rather than as proof failures.`, evidence: analysis.candidates.rows.filter((row) => row.result_class === 'infrastructure_failure').flatMap((row) => row.evidence).slice(0, 12) });
  if (analysis.candidates.all_failed) conclusions.push({ type: 'Interpretation', text: `None of the ${analysis.candidates.rows.length} recorded Candidate check(s) returned PASS. Repeated diagnostic classes are reported as route non-convergence, not as proof of a mathematical impossibility.`, evidence: analysis.candidates.rows.flatMap((row) => row.evidence).slice(0, 12) });
  if (analysis.terminal) conclusions.push({ type: 'Interpretation', text: analysis.terminal.interpretation, evidence: analysis.terminal.evidence.slice(0, 8) });
  conclusions.push({ type: 'Derived metric', text: 'The report treats heartbeat, turn count, Material count, Task acceptance, and report.json made_progress as activity or supporting metrics. None is labeled productive Goal progress by itself.', evidence: ['docs/workflows/experiment.md'] });
  return conclusions;
}

export async function resolveExperiment(input, { experimentsRoot = null } = {}) {
  if (typeof input !== 'string' || !input.trim()) throw new TypeError('experiment directory or ID is required');
  const value = input.trim();
  const root = resolve(experimentsRoot ?? join(process.cwd(), 'experiments'));
  const isId = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
  if (isId) {
    const byId = resolve(root, value);
    if (!pathInside(root, byId)) throw new Error(`experiment ID escapes experiments root: ${value}`);
    if (await isDirectory(byId)) return byId;
    throw new Error(`experiment not found: ${value}`);
  }
  const candidate = resolve(value);
  if (!isAbsolute(value) && !pathInside(process.cwd(), candidate)) throw new Error(`experiment directory escapes current working root: ${input}`);
  if (await isDirectory(candidate)) return candidate;
  throw new Error(`experiment directory not found: ${input}`);
}

export async function analyseExperiment(input, { mode = 'full', experimentsRoot = null, outputPath = null, maxWindowMs = DEFAULT_MAX_WINDOW_MS } = {}) {
  if (!['full', 'sanitized'].includes(mode)) throw new TypeError('mode must be full or sanitized');
  const root = await resolveExperiment(input, { experimentsRoot });
  const metadataErrors = [];
  const metadata = await readMetadata(root, metadataErrors);
  const inventory = await inventoryExperiment(root, { mode, metadata });
  inventory.errors = [...metadataErrors, ...inventory.errors].slice(0, MAX_SOURCE_ERRORS);
  const projectIds = inventory.projectIds;
  const dbPaths = [];
  for (const projectId of projectIds) {
    const path = join(root, 'state', 'projects', projectId, 'project.sqlite');
    if (await isRegularFile(path)) dbPaths.push(path);
  }
  const modelErrors = [];
  const model = await readDomainDatabases(root, dbPaths, modelErrors, mode);
  const summaries = await readSummaries(root, metadata, modelErrors);
  const observationIds = [inventory.experimentId, ...summaries.map((summary) => summary.data?.project?.run_id).filter(Boolean)];
  const workspaceErrors = [];
  const workspaceFacts = mode === 'full' ? await readWorkspaceFacts(root, projectIds, model, workspaceErrors) : [];
  const runtimePaths = inventory.evidence.find((entry) => entry.class === 'runtime')?.paths ?? [];
  const rawRuntimeRecords = [];
  if (mode === 'full') {
    for (const pathRef of runtimePaths) {
      const path = resolve(root, pathRef);
      for (const line of (await readFile(path, 'utf8').catch(() => '')).split(/\r?\n/)) {
        if (!line.trim()) continue;
        try { rawRuntimeRecords.push(JSON.parse(line)); } catch { /* inventory has the error */ }
      }
    }
  }
  const intervals = buildExecutionIntervals(rawRuntimeRecords);
  const observationCandidates = [];
  for (const path of resolveConfiguredObservation(root, metadata)) if (await isRegularFile(path)) observationCandidates.push(path);
  const observationFacts = [];
  const observationErrors = [];
  let observationMatched = false;
  if (observationCandidates.length) {
    for (const path of observationCandidates) {
      const facts = await readObservationFacts(root, path, observationIds, mode, observationErrors);
      // Observation stores can contain hundreds of thousands of bounded
      // heartbeat/tool rows. Avoid spreading the whole array into push(),
      // which overflows the JavaScript argument stack on a long run.
      if (facts.length) {
        for (const fact of facts) observationFacts.push(fact);
        observationMatched = true;
        break;
      }
    }
    if (!observationMatched) observationErrors.push({ path: sourcePath(root, observationCandidates[0]), kind: 'correlation', error: 'no observation events matched the resolved experiment/project run IDs' });
  }
  const rawErrors = [];
  const rawFacts = await readRawFacts(root, projectIds, mode, intervals, rawErrors);
  const domainFacts = factsFromDomainModel(root, model);
  const allFacts = dedupeFacts([...observationFacts, ...rawFacts, ...domainFacts, ...workspaceFacts]);
  const warnings = attachFactReferences(allFacts, model, intervals);
  const projectSummary = summaries.find((summary) => summary.data?.run?.protocol_valid !== null || summary.data?.run?.solved !== null) ?? summaries[0];
  const experimentEnd = inventory.metadata.experiment?.ended_at ?? projectSummary?.data?.run?.ended_at ?? new Date().toISOString();
  const executions = executionInventory(model, allFacts, experimentEnd, maxWindowMs);
  for (const execution of executions) execution.windows = execution.windows.map((window) => ({ ...window }));
  const collaboration = materialCollaboration(model, allFacts);
  const allErrors = [...inventory.errors, ...modelErrors, ...workspaceErrors, ...observationErrors, ...rawErrors].slice(0, MAX_SOURCE_ERRORS);
  const analysis = {
    root,
    mode,
    inventory: { ...inventory, evidence: markEvidenceStatuses(inventory.evidence, allErrors), errors: allErrors },
    model,
    summaries,
    facts: allFacts,
    executions,
    collaboration,
    warnings,
    aggregate: null,
    errors: [],
    candidates: null,
    terminal: null,
    optimizations: [],
    systemFindings: [],
    windowSizeMinutes: maxWindowMs / 60000,
  };
  analysis.aggregate = aggregateSummary(summaries, model, allFacts, { ...inventory, executions_count: executions.length });
  analysis.errors = buildErrorAnalysis(allFacts);
  analysis.candidates = buildCandidateAnalysis(model, allFacts);
  analysis.terminal = buildTerminalAnalysis(analysis);
  analysis.optimizations = buildOptimizationRecommendations(analysis);
  analysis.systemFindings = buildSystemFindings(analysis);
  analysis.serviceAnalysis = buildServiceAnalysis(allFacts);
  analysis.toolAnalysis = buildToolAnalysis(analysis);
  analysis.conclusions = deriveConclusions(analysis);
  const report = renderMarkdown(analysis);
  const reportPath = resolve(outputPath ?? join(root, 'analysis', 'experiment-analysis.md'));
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, report, 'utf8');
  return { ...analysis, reportPath, report };
}

function md(value) {
  return String(value ?? 'unknown').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function evidenceRef(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return value.ref ?? value.path ?? 'unknown evidence';
  return 'unknown evidence';
}

function safeWorkspaceRef(value) {
  const raw = String(value ?? '');
  if (!raw) return 'unknown';
  if (isAbsolute(raw)) return `workspace:${basename(raw)}`;
  return raw.replaceAll(/(?:^|\/)home\/[^/]+\//g, 'workspace:/');
}

function refs(ids, factMap) {
  return array(ids).map((id) => {
    const fact = factMap.get(id);
    return fact ? `${id} (${fact.sources.join(', ')})` : id;
  }).join('; ') || 'none recorded';
}

function evidenceTable(inventory) {
  const rows = inventory.evidence.map((entry) => `| ${entry.class} | ${entry.status} | ${entry.paths.length ? entry.paths.join('<br>') : 'none'} | ${md(entry.detail ?? '')} |`);
  return ['| Evidence class | Status | Paths | Limitation/notes |', '|---|---|---|---|', ...rows].join('\n');
}

function taskTable(model) {
  const rows = model.tasks.map((task) => `| ${md(task.task_id)} | ${md(task.parent_id ?? 'root')} | ${md(task.task_type)} | ${md(task.state)} | ${md(task.owner_ref)} | ${md(task.goal)} | ${task.source.ref} |`);
  return rows.length ? ['| Task | Parent | Type | State | Owner | Goal | Evidence |', '|---|---|---|---|---|---|---|', ...rows].join('\n') : '_No Task rows were available from the authoritative database._';
}

function executionTable(executions) {
  const rows = executions.map(({ execution: item, counts, sources, coreIds, sessionIds, workspaceRefs, lifecycle_role, predecessor_execution_id, successor_execution_id }) => `| ${md(item.execution_id)} | ${md(item.task_id)} | ${md(lifecycle_role)} | ${md(predecessor_execution_id ?? 'none')} | ${md(successor_execution_id ?? 'none')} | ${md(item.owner_ref)} | ${md(coreIds.join(', ') || 'unknown')} | ${md(sessionIds.join(', ') || 'unknown')} | ${md(item.state)} | ${md(item.attempt_no ?? 'unknown')} | ${md(workspaceRefs.map(safeWorkspaceRef).join(', ') || 'unknown')} | ${sources.slice(0, 2).join('<br>') || 'none'} |`);
  return rows.length ? ['| Execution attempt | Task | Lifecycle role | Predecessor | Successor | Owner | Core | Session | State | Attempt | Workspace lineage | Evidence |', '|---|---|---|---|---|---|---|---|---|---:|---|---|', ...rows].join('\n') : '_No Execution was discoverable._';
}

function windowTable(item) {
  const rows = item.windows.map((window, index) => {
    const counts = Object.entries(window.event_counts ?? {}).filter(([kind]) => !['heartbeat', 'agent_turn', 'agent_event', 'process_event'].includes(kind)).map(([kind, count]) => `${kind}=${count}`).join(', ') || 'no durable event count';
    return `| ${index + 1} | ${window.time.start}<br>${window.time.end} | ${Math.round(window.time.duration_ms / 1000)} s${window.time.evidence_gap ? ' (evidence gap)' : ''} | ${md(window.semantic_phase)} | ${md(window.semantic_summary)} | ${md(window.route_change)} | ${md(window.durable_changes.join('; ') || 'none recorded')}<br><small>${md(counts)}</small> | ${md(window.result)} | ${md(window.next_state)} | ${md(window.handoff_or_blocker)} | ${md(window.semantic_confidence)} | ${window.evidence.slice(0, 4).join('<br>') || 'none'} |`;
  });
  return ['| # | Time | Duration | Phase | Semantic summary | Route change | Durable changes / supporting counts | Result | Next state | Handoff/blocker | Confidence | Evidence |', '|---:|---|---:|---|---|---|---|---|---|---|---|---|', ...rows].join('\n');
}

function renderMarkdown(analysis) {
  const factMap = new Map(analysis.facts.map((fact) => [fact.id, fact]));
  const aggregate = analysis.aggregate;
  const conclusionLines = analysis.conclusions.map((item) => `- **${item.type}:** ${item.text} _(evidence: ${item.evidence.join(', ') || 'none recorded'})_`).join('\n');
  const executionSections = analysis.executions.map((item) => {
    const counts = Object.entries(item.counts).map(([key, value]) => `${key}=${value}`).join(', ') || 'no normalized facts';
    const artifacts = item.facts.filter((fact) => ['material_published', 'material_read', 'material_consumed', 'workspace_checked', 'workspace_revision', 'judge_result', 'judge_check'].includes(fact.kind)).slice(0, 40).map((fact) => `- ${compactFact(fact)} — ${fact.sources.join(', ')}`).join('\n') || '- No artifact/check fact was observed for this Execution.';
    return `### Execution \`${md(item.execution.execution_id)}\` — ${md(item.lifecycle_role)}\n\n- Task: \`${md(item.execution.task_id)}\`\n- Lifecycle role: **${md(item.lifecycle_role)}**\n- Predecessor/rework source: ${md(item.predecessor_execution_id ?? 'none recorded')}\n- Successor/rework target: ${md(item.successor_execution_id ?? 'none recorded')}\n- Owner: ${md(item.execution.owner_ref)}\n- Core(s): ${md(item.coreIds.join(', ') || 'unknown')}\n- Session(s): ${md(item.sessionIds.join(', ') || 'unknown')}\n- Current/terminal state: **${md(item.execution.state)}**\n- Attempt: ${md(item.execution.attempt_no ?? 'unknown')}\n- Workspace lineage: ${md(item.workspaceRefs.map(safeWorkspaceRef).join(', ') || 'unknown')}\n- Wait condition: ${md(item.waitCondition?.type ?? 'none recorded')}\n- Normalized evidence counts: ${counts}\n- Evidence mode: ${analysis.inventory.evidenceMode}\n\n#### ${analysis.windowSizeMinutes}-minute semantic work windows\n\nThe table summarizes observable Agent objectives, Workspace/Material/Judge changes, and lifecycle state. Supporting event counts are included for audit; low-level calls are not the narrative.\n\n${windowTable(item)}\n\n#### Artifacts, Service effects, and errors\n\n${artifacts}\n`;
  }).join('\n');
  const collaborationRows = analysis.collaboration.map((row) => {
    const consumerText = row.consumers.map((consumer) => `${consumer.execution_id ?? 'unknown'} (${consumer.evidence})`).join('<br>') || 'none recorded';
    const effectText = row.downstream_effects.map((effect) => `${effect.kind} (${effect.evidence})`).join('<br>') || 'none recorded';
    const meaning = row.downstream_effects.length ? 'Delivery reached a recorded downstream operation; semantic usefulness still requires review.' : row.consumers.length ? 'Consumer read was recorded without a linked downstream state change.' : 'No recorded consumer; delivery loop is incomplete in the available evidence.';
    return `| ${md(row.material_id)} | ${md(row.kind)} / ${md(row.evidence_state)} | ${md(row.publisher.execution_id ?? 'unknown')} | ${consumerText} | ${effectText} | ${md(meaning)} | ${md(row.assessment)} |`;
  }).join('\n');
  const errorRows = analysis.errors.map((error) => `| ${md(error.severity)} | ${md(error.category)} | ${error.occurrence_count} | ${error.supporting_record_count} | ${md(error.operation)} | ${md(error.interpretation)} | ${error.evidence.slice(0, 6).join('<br>')} |`).join('\n');
  const systemFindingRows = analysis.systemFindings.map((finding) => `| ${md(finding.severity)} | ${md(finding.category)} | ${finding.title ? `**${md(finding.title)}** ` : ''}${md(finding.interpretation)} | ${md(finding.confidence)} | ${md(finding.validation)} | ${finding.evidence.slice(0, 6).join('<br>')} |`).join('\n');
  const serviceRows = analysis.serviceAnalysis.map((row) => `| ${md(row.service)} | ${row.started} | ${row.finished} | ${row.failed} | ${row.observed_failure_rate === null ? 'unknown' : `${(row.observed_failure_rate * 100).toFixed(1)}%`} | ${md(row.operations.join(', ') || 'unknown')} | ${row.evidence.slice(0, 4).join('<br>')} |`).join('\n');
  const tool = analysis.toolAnalysis;
  const optimizationRows = analysis.optimizations.map((item) => `| ${md(item.priority)} | ${md(item.category)} | ${md(item.action)} | ${md(item.rationale)} | ${md(item.validation)} | ${item.evidence.slice(0, 6).join('<br>')} |`).join('\n');
  const candidateRows = analysis.candidates.rows.map((row) => `| ${md(row.artifact_material_id)} | ${md(row.task_id)} | ${md(row.execution_id)} | ${md(row.strategy_summary)} | ${md(row.change_from_previous)} | ${md(row.feedback_response)} | ${md(row.check_result_id ?? 'none')} | ${md(row.verdict)} / ${md(row.mathematical_outcome)} / ${md(row.status)} | ${md(row.result_class)} | ${md(row.checker_process_status)} | ${md(row.diagnostic_class)} | ${md(row.submitted_at)} | ${row.feedback_reads} | ${row.later_actions.join(', ') || 'none recorded'} | ${row.evidence.slice(0, 4).join('<br>')} |`).join('\n');
  const repeatedDiagnosticRows = analysis.candidates.repeated_diagnostics.map((row) => `| ${md(row.task_id)} | ${md(row.diagnostic_class)} | ${row.count} | ${row.evidence.slice(0, 6).join('<br>')} |`).join('\n');
  const healthByCore = {};
  for (const fact of analysis.facts.filter((candidate) => ['heartbeat', 'execution_assigned', 'wait_for_requested', 'execution_terminal', 'session_started', 'session_closed'].includes(candidate.kind))) {
    const key = fact.coreId ?? 'unknown';
    if (!healthByCore[key]) healthByCore[key] = {};
    healthByCore[key][fact.kind] = (healthByCore[key][fact.kind] ?? 0) + 1;
  }
  const healthRows = Object.entries(healthByCore).map(([core, counts]) => `| ${core} | ${Object.entries(counts).map(([key, value]) => `${key}=${value}`).join('<br>')} |`).join('\n');
  const projectRows = analysis.summaries.filter((summary) => summary.data?.project?.problem_id).map((summary) => `| ${md(summary.data.project.problem_id)} | ${md(summary.data?.run?.solved)} | ${md(summary.data?.run?.protocol_valid)} | ${md(summary.data?.run?.made_progress)} | ${summary.path} |`).join('\n');
  return `# Experiment analysis

> Generated by the local evidence-first analyzer. This report is a semantic projection of local evidence; it does not treat \`report.json\` as authoritative.

## Executive conclusion

- Experiment: \`${md(aggregate.experiment_id)}\`
- Evidence boundary: **${md(analysis.inventory.evidenceMode)}**
- Solved/protocol flags: solved=${md(aggregate.solved)}, protocol_valid=${md(aggregate.protocol_valid)}, report_made_progress=${md(aggregate.made_progress_summary)}
- The report records observable operations and explicit effects. It does not decide whether a mathematical idea or Material was useful merely because it was published, accepted, read, or counted.

${conclusionLines}

## Evidence boundary

- Resolved experiment directory: \`${md(sourcePath(analysis.root, analysis.root))}\`
- Experiment ID: \`${md(analysis.inventory.experimentId)}\`
- Problem IDs: ${analysis.inventory.projectIds.map((id) => `\`${md(id)}\``).join(', ') || 'unknown'}
- Analysis mode: **${md(analysis.mode)}**
- Raw transcript, proof/candidate source, credentials, stdout, stderr, and unrestricted payloads are not copied into this report.

${evidenceTable(analysis.inventory)}

${analysis.inventory.errors.length ? `### Source/integrity warnings\n\n${analysis.inventory.errors.map((item) => `- ${md(item.path ?? 'unknown source')}${item.line ? `:${item.line}` : ''}${item.sequence ? `#sequence=${item.sequence}` : ''}: ${md(item.error ?? 'malformed or incomplete')}`).join('\n')}` : 'No source parse errors were recorded by the inventory.'}

${analysis.warnings.length ? `### Unmatched domain references\n\n${analysis.warnings.map((warning) => `- ${warning.type}: ${warning.execution_id ?? warning.task_id} in ${warning.fact_id}; evidence: ${warning.sources.join(', ')}`).join('\n')}` : 'No unknown Task/Execution references were found against the available authoritative database rows.'}

## Run overview

| Field | Value |
|---|---|
| Started | ${md(aggregate.started_at)} |
| Ended | ${md(aggregate.ended_at)} |
| Tasks | ${aggregate.task_count} |
| Executions | ${aggregate.execution_count} |
| Materials | ${aggregate.material_count} |
| Candidates | ${aggregate.candidate_count} |
| Judge events/checks | ${aggregate.judge_event_count} |
| Wait requests | ${aggregate.wait_count} |
| Heartbeats (lease activity only) | ${aggregate.heartbeat_count} |

### Summary artifacts

${analysis.summaries.length ? analysis.summaries.map((summary) => `- ${summary.path}: supporting numerical projection only`).join('\n') : '- No report.json or aggregate report was found.'}

### Project outcomes

| Project | Solved | Protocol valid | Summary made_progress | Supporting source |
|---|---|---|---|---|
${projectRows || '| _none_ | unknown | unknown | unknown | — |'}

## Coordination layer

This layer evaluates public-service availability, contract use, task supply, handoffs, and whether collaboration loops close. Counts are observed evidence; an absent call is unknown when the corresponding source is missing.

### Public-service health

| Service | Calls started | Calls finished | Failed finishes | Observed failure rate | Operations | Evidence |
|---|---:|---:|---:|---:|---|---|
${serviceRows || '| _none_ | 0 | 0 | 0 | unknown | — | — |'}

### Task/Execution inventory

### Tasks

${taskTable(analysis.model)}

### Executions

${executionTable(analysis.executions)}

## Execution layer

The authoritative domain model keeps a durable Execution distinct from an Agent Session. This report presents each Execution attempt and its Session/Core segments; a successor Execution is shown only when the durable model records a new ID. A wait/resume, Core handoff, or in-place parent rework remains the same Execution.

## Per-Execution analysis

${executionSections || '_No Execution section can be rendered from the available evidence._'}

### Collaboration review

This section follows the collaboration loop: decompose → take → independent work → deliver → consumer reads → review/rework → resume. A Material is treated as a delivery artifact; it is not treated as useful merely because it exists.

| Material | Kind/state | Producer | Explicit consumers | Recorded downstream effects | Semantic handoff reading | Assessment |
|---|---|---|---|---|---|---|
${collaborationRows || '| _none_ | — | — | — | — | No Material rows available |'}

The assessment labels are deliberately narrow: 'accepted-but-unused' means the authoritative Material state says accepted and no explicit read was found; 'consumed-without-recorded-downstream-effect' means a read was recorded but no later Workspace/Candidate/Judge/review operation was linked. Neither label is a semantic judgment of mathematical value.

## System efficiency and health

| Core/session lane | Recorded lifecycle facts |
|---|---|
${healthRows || '| unknown | No Core/session facts available |'}

Heartbeats are lease activity only. Agent turns, process health, Judge time, IDLE, WAITING, scheduler polling, and effective Agent work are not collapsed into one metric. An unexplained interval is reported as an evidence gap, not a scheduler defect.

The efficiency view must distinguish configured capacity from effective work: Core occupancy, concurrency, ready-but-unassigned work, take contention, capacity release on WAITING, wake/resume, Judge time, scheduler polling, and cleanup are separate measures. When the trace lacks Runtime RUNNING or ready-queue intervals, occupancy is a proxy and the report says so.

## Tool layer

This layer evaluates provider/transport failures, tool contract use, response schemas, and error fidelity. Judge/checker results are reviewed for diagnostic quality and whether the Agent could act on the feedback.

| Metric | Observed value | Interpretation | Evidence |
|---|---:|---|---|
| Agent/tool calls | ${tool.tool_calls} | Low-level call volume is supporting evidence, not productive work. | ${tool.evidence.slice(0, 4).join('<br>') || 'none'} |
| Agent/tool errors | ${tool.tool_errors} | Check whether failures contain an actionable code, message, and correlation ID. | ${tool.evidence.slice(0, 4).join('<br>') || 'none'} |
| Provider/transport error occurrences | ${tool.provider_error_occurrences} | Unknown means the source did not classify provider errors separately. | ${tool.evidence.slice(0, 4).join('<br>') || 'none'} |
| Judge checks | ${tool.judge_checks} | Checker coverage is distinct from mathematical success. | ${tool.evidence.slice(0, 4).join('<br>') || 'none'} |
| Checker preflight records | ${tool.checker_preflight_count} | Persisted against checker/environment identity; an unavailable preflight gates proof checking. | ${tool.evidence.slice(0, 4).join('<br>') || 'none'} |
| Unavailable checker preflights | ${tool.checker_preflight_unavailable} | A health failure is infrastructure evidence and cannot be read as a mathematical verdict. | ${tool.evidence.slice(0, 4).join('<br>') || 'none'} |
| Judge non-PASS checks | ${tool.judge_non_pass} | Diagnostic classes and feedback response require semantic review. | ${tool.judge_diagnostic_classes.join(', ') || 'none recorded'} |
| Judge infrastructure failures | ${tool.judge_infrastructure_failures} | Checker health failures are not mathematical proof failures. | ${tool.evidence.slice(0, 4).join('<br>') || 'none'} |
| Judge source-level failures | ${tool.judge_source_failures} | Only these checks support a mathematical FAIL conclusion. | ${tool.evidence.slice(0, 4).join('<br>') || 'none'} |
| Mathematical outcomes unassessed | ${tool.judge_unassessed} | No source-level verdict was produced for these checks. | ${tool.evidence.slice(0, 4).join('<br>') || 'none'} |

## Error analysis

Error Analysis prioritizes failures in the Swarm collaboration loop. Low-level Agent, Bridge, and Service errors are supporting evidence; they are not the main conclusion unless they block take, handoff, feedback, recovery, or cleanup. 'occurrence_count' is the estimated number of independent failures; source references show supporting records and are not additional failures.

### System-level findings

| Severity | Category | Affected Tasks | Affected Executions | Affected Cores | Evidence-backed interpretation / impact | Confidence | Validation condition | Evidence |
|---|---|---|---|---|---|---|---|---|
${analysis.systemFindings.map((finding) => `| ${md(finding.severity)} | ${md(finding.category)} | ${md(finding.affected_tasks?.join(', ') || 'unknown')} | ${md(finding.affected_executions?.join(', ') || 'unknown')} | ${md(finding.affected_cores?.join(', ') || 'unknown')} | ${finding.title ? `**${md(finding.title)}** ` : ''}${md(finding.interpretation)} | ${md(finding.confidence)} | ${md(finding.validation)} | ${finding.evidence.slice(0, 6).join('<br>')} |`).join('\n') || '| — | none recorded | unknown | unknown | unknown | No system-level collaboration finding was derived from the available evidence. | — | — | — |'}

### Supporting operation errors

| Severity | Category | Unique occurrences | Supporting records | Operation | Evidence-backed interpretation | Evidence |
|---|---|---:|---:|---|---|---|
${errorRows || '| — | none recorded | 0 | 0 | — | No structured error was normalized. | — |'}

${analysis.terminal ? `### Terminal/timebox finding

- **${md(analysis.terminal.category)} (${md(analysis.terminal.confidence)} confidence):** ${md(analysis.terminal.interpretation)}
- Affected Executions: ${analysis.terminal.affected_executions.map(md).join(', ') || 'none'}
- Unfinished Tasks: ${analysis.terminal.unfinished_tasks.map((task) => `${md(task.task_id)}=${md(task.state)}`).join(', ') || 'none'}
- Evidence: ${analysis.terminal.evidence.join(', ')}` : 'No separate terminal/timebox finding was derived.'}

## Optimization recommendations

These are proposed next actions, not claims that the current trace proves a code defect. Each recommendation includes a validation condition.

| Priority | Category | Proposed optimization | Why this run supports it | How to validate | Evidence |
|---|---|---|---|---|---|
${optimizationRows || '| — | none | No additional optimization was derived | — | — | — |'}

## Candidate/Judge review

Candidate strategy summaries are bounded by visible Agent objectives, Workspace revision metadata, Material links, and Judge diagnostics. They summarize route changes without copying proof or candidate source. A semantic reviewer should inspect the cited local records when the strategy metadata is sparse.

| Candidate/material | Task | Execution | Visible strategy summary | Change from previous | Feedback response | CheckResult | Verdict / mathematical outcome / status | Result class | Checker process | Diagnostic code | Submitted | Feedback reads | Later observable action | Evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---:|---|---|
${candidateRows || '| _none_ | — | — | — | — | — | — | — | — | — | — | — |'}

${repeatedDiagnosticRows ? `### Repeated diagnostic classes

| Task | Diagnostic class | Count | Evidence |
|---|---|---:|---|
${repeatedDiagnosticRows}` : 'No diagnostic class repeated at least twice.'}

## Conclusions and follow-up

${conclusionLines}

Recommended operator follow-up:

1. Open the listed source references for each high-impact conclusion.
2. If an evidence class is missing or malformed, repair collection before interpreting the corresponding absence.
3. Compare candidate diagnostics and subsequent Workspace/Material operations; a FAIL is feedback, not proof that the Agent used it.
4. Treat this report as diagnostic-only whenever the completeness matrix says so. Re-run the analyzer after evidence repair; fact IDs and source references should remain stable for unchanged inputs.
`;
}

export { DEFAULT_MAX_WINDOW_MS, EVIDENCE_CLASSES, inventoryExperiment, renderMarkdown };
export const analyzeExperiment = analyseExperiment;

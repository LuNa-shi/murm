import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';

const DEFAULT_MAX_WINDOW_MS = 15 * 60 * 1000;
const SILENT_GAP_MS = 60 * 1000;
const MAX_SOURCE_ERRORS = 20;
const MAX_OPERATIONS_PER_WINDOW = 14;

const EVIDENCE_CLASSES = [
  'metadata', 'agent', 'bridge', 'runtime', 'service', 'judge', 'sqlite',
  'observation', 'workspace', 'summary',
];

const SENSITIVE_KEYS = /(?:^|_)(?:authorization|content|credential|formal_source|password|private_key|proof|raw_transcript|secret|stderr|stdout|task_instructions|token|api_key|agent_prompt|candidate_source)(?:$|_)/i;
const SAFE_RESULT_KEYS = new Set([
  'task_id', 'root_id', 'parent_id', 'execution_id', 'owner_ref', 'task_type',
  'state', 'task_state', 'execution_state', 'state_version', 'attempt_no',
  'fencing_version', 'runtime_generation', 'workspace_ref', 'workspace_revision',
  'workspace_content_hash', 'candidate_material_id', 'material_id', 'kind',
  'scope', 'evidence_state', 'source_task', 'source_execution', 'check_result_id',
  'request_key', 'target_task_id', 'target_spec_version', 'status', 'verdict',
  'checker_ref', 'checker_version', 'environment_ref', 'operation_id',
  'wait_condition', 'wait_condition_type', 'deadline', 'terminal_state',
  'task_count', 'material_count', 'services', 'tools', 'changed_files',
  'workspace_revision_start', 'workspace_revision_end', 'progress_kind',
  'tool', 'operation', 'outcome', 'phase', 'service', 'error', 'stream', 'type',
  'event', 'decision', 'diagnostic', 'session_transport_id', 'file_count',
  'content_hash', 'result', 'task', 'execution', 'material', 'check_result',
  'material_ids', 'count', 'candidate_material_id', 'diagnostic_class',
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
  ['claim', 'claim a Task'],
  ['create_child_task', 'decompose the Task'],
  ['save_workspace_revision', 'save a Workspace revision'],
  ['write_workspace_file', 'edit the Workspace'],
  ['publish_material', 'publish a Material'],
  ['read_materials', 'read Materials'],
  ['submit_candidate', 'submit a Candidate'],
  ['get_check_result', 'inspect Judge feedback'],
  ['apply_check_result', 'process Judge feedback'],
  ['request_wait', 'wait for a concrete condition'],
  ['wake_execution', 'wake an Execution'],
  ['resume_execution', 'resume an Execution'],
  ['accept_task', 'review and accept a Task'],
  ['request_rework', 'review and request rework'],
  ['heartbeat', 'maintain the Execution lease'],
  ['scheduler_status', 'inspect scheduler status'],
]);

const BOUNDARY_KINDS = new Set([
  'task_created', 'task_claimed', 'task_state_changed', 'execution_assigned',
  'execution_state_changed', 'workspace_revision', 'material_published',
  'material_consumed', 'candidate_submitted', 'judge_result', 'judge_check',
  'wait_requested', 'wake', 'resume', 'review', 'rework', 'execution_terminal',
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
      ? ['execution_id', 'task_id', 'owner_ref', 'state', 'state_version', 'attempt_no', 'fencing_version', 'runtime_generation', 'workspace_ref', 'workspace_revision', 'candidate_material_id', 'wait_condition', 'wait_deadline', 'created_at', 'updated_at']
      : type === 'material'
        ? ['material_id', 'kind', 'scope', 'evidence_state', 'source_task', 'source_execution', 'version', 'created_at']
        : type === 'check_result'
          ? ['check_result_id', 'request_key', 'candidate_material_id', 'target_task_id', 'execution_id', 'status', 'verdict', 'checker_ref', 'checker_version', 'diagnostic_class', 'created_at', 'updated_at']
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
  if (info?.code === 'CONFLICT' && /active Execution quota/i.test(message)) return 'claim_active_execution_quota';
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
    materialId: entity.material_id ?? entity.candidate_material_id ?? null,
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
  return text(String(toolName ?? '').replace(/^swarmenv_(?:task|execution|workspace|context|judge|catalog)_/, ''), 100);
}

function intentFor(operation, kind = null) {
  if (operation && INTENT_BY_OPERATION.has(operation)) return INTENT_BY_OPERATION.get(operation);
  if (kind === 'judge_result' || kind === 'judge_check') return 'process Judge feedback';
  if (kind === 'workspace_revision') return 'edit the Workspace';
  if (kind === 'material_published') return 'publish a Material';
  if (kind === 'material_consumed') return 'read Materials';
  if (kind === 'execution_assigned') return 'claim or resume a Task';
  if (kind === 'wait_requested') return 'wait for a concrete condition';
  if (kind === 'review' || kind === 'rework') return 'review a child result';
  return 'unknown';
}

function factIdentity(kind, source, discriminator = '') {
  return `F-${hash(`${kind}|${source}|${discriminator}`).slice(0, 12)}`;
}

function makeFact(root, {
  kind, at = null, source, taskId = null, executionId = null, sessionId = null,
  coreId = null, correlationId = null, operation = null, summary = {}, priority = 4,
}) {
  const sourceValue = source.ref ?? source.path ?? String(source);
  const discriminator = [taskId, executionId, sessionId, coreId, correlationId, operation, JSON.stringify(summary)].join('|');
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
    summary: safeResult(summary) ?? {},
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
  const ids = { ...envelopeIds(envelope), ...idsFromEntity(result?.task), ...idsFromEntity(result?.execution) };
  const entity = result?.task ? safeEntity(result.task, 'task') : result?.execution ? safeEntity(result.execution, 'execution') : safeResult(result);
  const summary = {
    service: row.service ?? payload?.service ?? null,
    operation,
    phase: event?.endsWith('.start') ? 'started' : 'finished',
    ok: row.ok ?? payload?.ok ?? null,
    ...ids,
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
  const envelopeValues = envelopeIds(envelope);
  const execution = entityFromResult(result, 'execution');
  const task = entityFromResult(result, 'task');
  const material = entityFromResult(result, 'material');
  const check = entityFromResult(result, 'check_result');
  const ids = { ...envelopeValues, ...idsFromEntity(task), ...idsFromEntity(execution) };
  const at = row.occurredAt ?? row.timestamp;
  const facts = [];
  const base = (kind, summary, extra = {}) => makeFact(root, {
    kind, at, source, taskId: extra.taskId ?? ids.taskId, executionId: extra.executionId ?? ids.executionId,
    correlationId: ids.correlationId, operation, summary, priority: 2,
  });
  if (['propose_task', 'create_child_task'].includes(operation) && task) {
    facts.push(base('task_created', { task: safeEntity(task, 'task') }, { taskId: task.task_id }));
  }
  if (operation === 'claim' && execution) {
    facts.push(base('task_claimed', { task_id: task?.task_id ?? execution.task_id, execution_id: execution.execution_id, owner_ref: execution.owner_ref, state: execution.state }, { taskId: task?.task_id, executionId: execution.execution_id }));
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
    facts.push(base('material_consumed', { material_ids: materials.map((item) => item.material_id), count: materials.length }, {}));
  }
  if (operation === 'submit_candidate') {
    const candidateId = execution?.candidate_material_id ?? result?.candidate_material_id ?? null;
    facts.push(base('candidate_submitted', {
      candidate_material_id: candidateId,
      workspace_revision: execution?.workspace_revision ?? null,
      execution_id: execution?.execution_id ?? ids.executionId,
    }, { executionId: execution?.execution_id ?? ids.executionId }));
  }
  if (operation === 'apply_check_result' && check) {
    facts.push(base('judge_result', { check_result: safeEntity(check, 'check_result') }, { executionId: check.execution_id ?? ids.executionId }));
  }
  if (operation === 'request_wait') {
    const condition = execution?.wait_condition ?? result?.wait_condition ?? null;
    facts.push(base('wait_requested', {
      execution_id: execution?.execution_id ?? ids.executionId,
      wait_condition: safeEntity({ wait_condition: condition }, 'execution')?.wait_condition ?? null,
      deadline: execution?.wait_deadline ?? null,
    }, { executionId: execution?.execution_id ?? ids.executionId }));
  }
  if (operation === 'wake_execution') facts.push(base('wake', { execution_id: ids.executionId }, {}));
  if (operation === 'resume_execution') facts.push(base('resume', { execution_id: ids.executionId }, {}));
  if (operation === 'accept_task') facts.push(base('review', { decision: 'accept', task_id: ids.taskId }, {}));
  if (operation === 'request_rework') facts.push(base('rework', { decision: 'request_rework', task_id: ids.taskId }, {}));
  if (operation === 'stop_execution') {
    facts.push(base('execution_terminal', { execution: safeEntity(execution, 'execution'), terminal_state: execution?.state ?? result?.terminal_state ?? null }, { executionId: execution?.execution_id ?? ids.executionId }));
  }
  if (task?.state) facts.push(base('task_state_changed', { task_id: task.task_id, state: task.state, state_version: task.state_version }, { taskId: task.task_id }));
  if (execution?.state) facts.push(base('execution_state_changed', { execution_id: execution.execution_id, state: execution.state, state_version: execution.state_version, wait_condition: safeEntity(execution, 'execution')?.wait_condition ?? null }, { executionId: execution.execution_id }));
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
  });
  if (row.source === 'agent') {
    const record = row.kind === 'rpc_record' ? payload?.record : payload;
    const recordType = record?.type;
    if (recordType === 'tool_execution_start') {
      const tool = record.toolName ?? record.tool_name;
      facts.push(base('tool_call', { tool: text(tool, 120), operation: operationFromTool(tool), outcome: 'started' }, { operation: operationFromTool(tool) }));
    } else if (recordType === 'tool_execution_end') {
      const tool = record.toolName ?? record.tool_name;
      facts.push(base('tool_call', { tool: text(tool, 120), operation: operationFromTool(tool), outcome: record.isError ? 'error' : 'finished', error: record.isError ? 'tool error' : null }, { operation: operationFromTool(tool) }));
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
    if (runtimeEvent === 'runtime.request_wait' || runtimeEvent === 'request_wait') kind = 'wait_requested';
    if (runtimeEvent === 'runtime.stop_execution' || runtimeEvent === 'stop_execution') kind = 'execution_terminal';
    facts.push(base(kind, runtimeSummary));
    return facts;
  }
  if (row.source === 'judge-service') {
    const summary = safeResult({
      operation_id: payload?.operation_id,
      target_task_id: payload?.target_task_id,
      candidate_material_id: payload?.candidate_material_id,
      verdict: payload?.verdict,
      check_result_id: payload?.check_result_id,
      ok: payload?.ok,
    });
    facts.push(base(payload?.event === 'judge.complete' ? 'judge_result' : 'judge_request', summary, { operation: 'judge' }));
    return facts;
  }
  if (row.source === 'judge') {
    const summary = safeResult({
      event: payload?.event,
      target_task_id: payload?.target_task_id ?? payload?.evidence?.target_task_id,
      candidate_material_id: payload?.candidate_hash ? null : payload?.candidate_material_id,
      verdict: payload?.verdict,
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
    if (type === 'tool_execution_start' || type === 'tool_execution_end') {
      const tool = nested.toolName ?? nested.tool_name;
      const operation = operationFromTool(tool);
      facts.push(makeFact(root, {
        kind: 'tool_call', at, source, coreId, taskId: ids.taskId, executionId: ids.executionId,
        operation, summary: { tool: text(tool, 120), operation, outcome: type === 'tool_execution_end' ? (nested.isError ? 'error' : 'finished') : 'started', error: nested.isError ? 'tool error' : null }, priority: 2,
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
      : event === 'runtime.request_wait' ? 'wait_requested'
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
      operation: 'judge', summary: safeResult({ event, target_task_id: record.target_task_id, candidate_material_id: record.candidate_material_id, verdict: record.verdict, check_result_id: record.check_result_id, ok: record.ok }), priority: 2,
    }));
    return facts;
  }
  if (sourceClass === 'judge') {
    const event = record.event ?? record.type;
    facts.push(makeFact(root, {
      kind: event === 'judge.complete' ? 'judge_result' : 'judge_request', at, source,
      taskId: record.target_task_id ?? null, correlationId: record.operation_id ?? null,
      operation: 'judge', summary: safeResult({ event, target_task_id: record.target_task_id, candidate_material_id: record.candidate_material_id, verdict: record.verdict, check_result_id: record.check_result_id, ok: record.ok }), priority: 2,
    }));
    return facts;
  }
  if (sourceClass === 'checker') {
    const event = record.event ?? record.type;
    facts.push(makeFact(root, {
      kind: event === 'checker.complete' ? 'judge_check' : 'judge_request', at, source,
      taskId: record.target_task_id ?? record.evidence?.target_task_id ?? null,
      operation: 'checker', summary: safeResult({ event, target_task_id: record.target_task_id ?? record.evidence?.target_task_id, verdict: record.verdict, diagnostic: record.evidence?.diagnostic ? 'diagnostic present' : null }), priority: 2,
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
      } else if (active && record.execution_id === active.executionId && ['runtime.request_wait', 'runtime.stop_execution'].includes(record.event)) {
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
  return intervals.get(coreId).find((entry) => at >= entry.start && (entry.end === null || at <= entry.end)) ?? null;
}

function dedupeFacts(facts) {
  const map = new Map();
  const semantic = (fact) => [
    fact.kind, fact.at, fact.taskId, fact.executionId, fact.coreId, fact.operation,
    fact.summary?.material_id, fact.summary?.candidate_material_id, fact.summary?.check_result_id,
    fact.summary?.phase, fact.summary?.outcome, fact.summary?.event,
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

async function readDomainDatabases(root, dbPaths, errors) {
  const model = { tasks: [], executions: [], materials: [], checks: [], operations: [] };
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
        for (const row of selectRows(db, 'executions', ['execution_id', 'task_id', 'owner_ref', 'state', 'state_version', 'attempt_no', 'fencing_version', 'runtime_generation', 'workspace_ref', 'workspace_revision', 'candidate_material_id', 'wait_condition_json', 'wait_deadline', 'created_at', 'updated_at'])) {
          model.executions.push({ ...row, wait_condition: jsonParse(row.wait_condition_json), project: basename(dirname(dbPath)), source: sourceForDb(root, dbPath, 'executions', `execution_id=${row.execution_id}`) });
        }
      }
      if (tables.has('materials')) {
        for (const row of selectRows(db, 'materials', ['material_id', 'kind', 'scope', 'evidence_state', 'source_task', 'source_execution', 'version', 'created_at'])) {
          model.materials.push({ ...row, project: basename(dirname(dbPath)), source: sourceForDb(root, dbPath, 'materials', `material_id=${row.material_id}`) });
        }
      }
      if (tables.has('check_results')) {
        for (const row of selectRows(db, 'check_results', ['check_result_id', 'request_key', 'candidate_material_id', 'target_task_id', 'target_spec_version', 'execution_id', 'status', 'verdict', 'checker_ref', 'checker_version', 'environment_ref', 'evidence_json', 'created_at', 'updated_at'])) {
          const evidence = jsonParse(row.evidence_json);
          const diagnostic = isObject(evidence) ? (evidence.diagnostic ?? evidence.stderr ?? evidence.stdout) : null;
          const { evidence_json: _evidenceJson, ...safeRow } = row;
          model.checks.push({ ...safeRow, diagnostic_class: diagnosticClass(diagnostic), project: basename(dirname(dbPath)), source: sourceForDb(root, dbPath, 'check_results', `check_result_id=${row.check_result_id}`) });
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

async function readObservationFacts(root, observationPath, experimentId, mode, errors) {
  let db;
  try { db = new DatabaseSync(observationPath); }
  catch (error) { errors.push({ path: sourcePath(root, observationPath), error: text(error.message, 180) }); return []; }
  try {
    const tables = new Set(databaseTableNames(db));
    if (!tables.has('observation_events')) return [];
    let rows = db.prepare('select event_id, experiment_id, sequence, occurred_at, source, kind, core_id, session_id, task_id, execution_id, correlation_id, payload_json from observation_events where experiment_id = ? order by sequence').all(experimentId);
    if (!rows.length) {
      const identities = db.prepare('select distinct experiment_id from observation_events order by experiment_id').all().map((row) => row.experiment_id).filter(Boolean);
      if (identities.length === 1) rows = db.prepare('select event_id, experiment_id, sequence, occurred_at, source, kind, core_id, session_id, task_id, execution_id, correlation_id, payload_json from observation_events where experiment_id = ? order by sequence').all(identities[0]);
    }
    const facts = [];
    for (const row of rows) {
      let payload = {};
      if (mode === 'full') {
        try { payload = JSON.parse(row.payload_json ?? '{}'); }
        catch (error) { errors.push({ path: sourcePath(root, observationPath), sequence: row.sequence, error: text(error.message, 180) }); continue; }
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

async function inventoryLogs(root, projectIds, className, errors) {
  const files = [];
  const base = join(root, 'logs', 'projects');
  for (const projectId of projectIds) {
    const directoryName = { agent: 'agents', bridge: 'bridge', runtime: 'runtime', service: 'services', judge: 'judge' }[className] ?? className;
    const directory = join(base, projectId, directoryName);
    files.push(...await listFiles(directory, '.ndjson'));
    if (className === 'judge') files.push(join(base, projectId, 'services', 'judge-service.ndjson'));
  }
  const uniqueFiles = [];
  for (const path of [...new Set(files)].filter((candidate) => candidate.endsWith('.ndjson'))) {
    if (await isRegularFile(path)) uniqueFiles.push(path);
  }
  let malformed = 0;
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
  return { files: uniqueFiles, malformed };
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
    const result = await inventoryLogs(root, ids, className, errors);
    const status = result.malformed ? 'malformed' : result.files.length ? (mode === 'full' ? 'present' : 'present') : 'missing';
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
  const observationPaths = [...new Set([localObservation, configuredObservation].filter(Boolean))].filter((path) => exists(path));
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
  const presentRaw = ['agent', 'bridge', 'runtime', 'service', 'judge', 'sqlite', 'workspace'].every((name) => ['present', 'empty'].includes(evidence.find((item) => item.class === name)?.status));
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
  const candidateToExecution = new Map(model.checks.map((row) => [row.candidate_material_id, row.execution_id]).filter(([, value]) => value));
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
    const candidateId = summary.candidate_material_id ?? summary.material_id ?? summary.material?.material_id ?? null;
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
  return ['claim', 'create_child_task', 'save_workspace_revision', 'publish_material', 'read_materials', 'submit_candidate', 'apply_check_result', 'request_wait', 'wake_execution', 'resume_execution', 'accept_task', 'request_rework', 'stop_execution'].includes(operation);
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
  if (fact.kind === 'material_consumed') return `read ${array(summary.material_ids).length} Material(s) [${fact.id}]`;
  if (fact.kind === 'candidate_submitted') return `submit Candidate ${summary.candidate_material_id ?? 'unknown'} [${fact.id}]`;
  if (fact.kind === 'judge_result' || fact.kind === 'judge_check' || fact.kind === 'judge_check_record') return `Judge ${summary.verdict ?? summary.check_result?.verdict ?? 'result'} [${fact.id}]`;
  if (fact.kind === 'workspace_revision' || fact.kind === 'workspace_manifest') return `Workspace revision ${summary.workspace_revision ?? 'unknown'} [${fact.id}]`;
  if (fact.kind === 'wait_requested') return `wait (${summary.wait_condition?.type ?? 'condition unknown'}) [${fact.id}]`;
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
  const impactful = [...facts].reverse().find((fact) => {
    const durableOperations = ['claim', 'create_child_task', 'save_workspace_revision', 'publish_material', 'read_materials', 'submit_candidate', 'apply_check_result', 'request_wait', 'wake_execution', 'resume_execution', 'accept_task', 'request_rework', 'stop_execution'];
    if (['heartbeat', 'agent_turn', 'agent_settled', 'process_event', 'agent_event', 'agent_rpc_request'].includes(fact.kind)) return false;
    if (durableOperations.includes(fact.operation)) return true;
    if (fact.kind === 'service_call_started' || fact.kind === 'service_call_finished') return Boolean(fact.summary?.ok === false || fact.summary?.error);
    return BOUNDARY_KINDS.has(fact.kind) || ['task_snapshot', 'execution_snapshot', 'material_record', 'judge_check_record'].includes(fact.kind);
  });
  if (!impactful) return 'No state-changing operation observed in this window.';
  const summary = impactful.summary ?? {};
  if (impactful.kind === 'judge_result' || impactful.kind === 'judge_check' || impactful.kind === 'judge_check_record') return `Judge returned ${summary.verdict ?? summary.check_result?.verdict ?? 'an observed result'}.`;
  if (impactful.kind === 'wait_requested') return `A concrete wait condition was recorded: ${summary.wait_condition?.type ?? 'condition not visible'}.`;
  if (impactful.kind === 'material_published') return `Material publication was recorded; semantic usefulness is not inferred.`;
  if (impactful.kind === 'material_consumed') return `Explicit Material read was recorded; downstream effect is checked separately.`;
  if (impactful.kind === 'candidate_submitted') return 'Candidate submission was recorded.';
  if (impactful.kind === 'workspace_revision' || impactful.kind === 'workspace_manifest') return `Workspace revision ${summary.workspace_revision ?? 'unknown'} was recorded.`;
  if (summary.ok === false || summary.error) return `An error was returned by ${summary.service ?? 'a service'}; later activity is checked separately.`;
  return `Observed ${factOperation(impactful) ?? impactful.kind}.`;
}

function handoffForWindow(facts) {
  const material = facts.find((fact) => fact.kind === 'material_published');
  if (material) return `Material published; consumer/effect must be established by later records (${material.id}).`;
  const wait = facts.find((fact) => fact.kind === 'wait_requested');
  if (wait) return `Execution responsibility persisted with wait condition ${wait.summary?.wait_condition?.type ?? 'unknown'} (${wait.id}).`;
  const candidate = facts.find((fact) => fact.kind === 'candidate_submitted');
  if (candidate) return `Candidate handed to Judge path (${candidate.id}).`;
  const review = facts.find((fact) => fact.kind === 'review' || fact.kind === 'rework');
  if (review) return `Parent review decision recorded (${review.id}).`;
  return 'none recorded';
}

function windowIntent(facts) {
  const explicit = facts.find((fact) => fact.operation || ['material_published', 'material_consumed', 'candidate_submitted', 'judge_result', 'wait_requested', 'review', 'rework', 'workspace_revision'].includes(fact.kind));
  if (!explicit) return { label: 'unknown', confidence: 'unknown', basis: [] };
  return { label: intentFor(factOperation(explicit), explicit.kind), confidence: explicit.operation ? 'high' : 'medium', basis: [explicit.id] };
}

function makeWindow(facts, startMs, endMs, { gap = false } = {}) {
  const sorted = [...facts].sort((a, b) => (timeMs(a.at) ?? startMs) - (timeMs(b.at) ?? startMs) || a.id.localeCompare(b.id));
  const intent = gap ? { label: 'unknown', confidence: 'unknown', basis: [] } : windowIntent(sorted);
  const operations = gap ? ['no observed event'] : [...new Set(sorted.map(compactFact))].slice(0, MAX_OPERATIONS_PER_WINDOW);
  const overflow = gap ? 0 : Math.max(0, new Set(sorted.map(compactFact)).size - operations.length);
  if (overflow) operations.push(`… ${overflow} additional operation(s) summarized`);
  return {
    time: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), duration_ms: Math.max(0, endMs - startMs), evidence_gap: gap },
    operations,
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
    const boundary = isBoundary(fact);
    if (gap >= SILENT_GAP_MS) {
      windows.push(makeWindow(current, currentStart, previousAt));
      windows.push(makeWindow([], previousAt, at, { gap: true }));
      current = [fact]; currentStart = at; continue;
    }
    if (boundary && at > currentStart) {
      windows.push(makeWindow(current, currentStart, at));
      current = [fact]; currentStart = at; continue;
    }
    if (at - currentStart >= maxWindowMs) {
      windows.push(makeWindow(current, currentStart, previousAt));
      const splitAt = previousAt;
      if (at > splitAt) windows.push(makeWindow([], splitAt, at, { gap: true }));
      current = [fact]; currentStart = at; continue;
    }
    current.push(fact);
  }
  const finalAt = timeMs(timed.at(-1).at);
  windows.push(makeWindow(current, currentStart, finalAt));
  return windows.filter((window) => window.time.duration_ms > 0 || window.operations.length > 0);
}

function materialCollaboration(model, facts) {
  const published = facts.filter((fact) => fact.kind === 'material_published');
  const consumed = facts.filter((fact) => fact.kind === 'material_consumed');
  const downstreamKinds = new Set(['workspace_revision', 'candidate_submitted', 'judge_result', 'judge_check', 'review', 'rework']);
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
      published_evidence: pub?.id ?? material.source,
      consumers: reads.map((fact) => ({ execution_id: fact.executionId, task_id: fact.taskId, evidence: fact.id })),
      downstream_effects: effects.slice(0, 8).map((fact) => ({ kind: fact.kind, execution_id: fact.executionId, evidence: fact.id })),
      assessment,
    });
  }
  return rows;
}

function executionInventory(model, facts, experimentEnd) {
  const ids = new Set(model.executions.length
    ? model.executions.map((row) => row.execution_id)
    : facts.map((fact) => fact.executionId).filter(Boolean));
  return [...ids].sort().map((executionId) => {
    const execution = model.executions.find((row) => row.execution_id === executionId) ?? { execution_id: executionId, task_id: null, state: 'unknown', created_at: null, updated_at: null };
    const executionFacts = facts.filter((fact) => fact.executionId === executionId);
    return {
      execution,
      facts: executionFacts,
      windows: buildWindows(execution, executionFacts, experimentEnd),
      counts: Object.fromEntries([...new Set(executionFacts.map((fact) => fact.kind))].sort().map((kind) => [kind, executionFacts.filter((fact) => fact.kind === kind).length])),
      sources: sourceLabels(executionFacts),
    };
  });
}

function markEvidenceStatuses(evidence, errors) {
  const hasError = (entry, error) => {
    const path = String(error.path ?? '');
    if (entry === 'metadata') return path.startsWith('metadata/');
    if (entry === 'agent') return path.includes('/agents/') || path.includes('agents/');
    if (entry === 'bridge') return path.includes('/bridge/') || path.includes('bridge/');
    if (entry === 'runtime') return path.includes('/runtime/') || path.includes('runtime/');
    if (entry === 'service') return path.includes('/services/') || path.includes('services/');
    if (entry === 'judge') return path.includes('/judge/') || path.includes('judge/') || path.includes('judge-service.ndjson');
    if (entry === 'sqlite') return path.includes('/state/') || path.includes('state/');
    if (entry === 'observation') return path.includes('observability.sqlite');
    if (entry === 'workspace') return path.includes('/workspaces/') || path.includes('workspaces/');
    if (entry === 'summary') return path.includes('report.json') || path.includes('aggregate-report.json');
    return false;
  };
  return evidence.map((entry) => ({
    ...entry,
    status: errors.some((error) => hasError(entry.class, error)) ? 'malformed' : entry.status,
  }));
}

function aggregateSummary(summaries, model, facts, inventory) {
  const run = (summaries.find((summary) => summary.data?.run?.protocol_valid !== null || summary.data?.run?.solved !== null) ?? summaries[0])?.data?.run ?? {};
  const candidates = model.checks.length ? model.checks : facts.filter((fact) => fact.kind === 'candidate_submitted');
  const judges = model.checks.length ? model.checks : facts.filter((fact) => ['judge_result', 'judge_check', 'judge_check_record'].includes(fact.kind));
  const waits = model.operations.filter((operation) => operation.operation === 'request_wait');
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
    if (group.category === 'claim_active_execution_quota') return {
      ...common,
      severity: 'medium',
      interpretation: 'Several Agents attempted to claim a Task while its active Execution quota was full. This is contention and retry waste, not evidence of state corruption by itself.',
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

function buildCandidateAnalysis(model, facts) {
  const submissions = new Map();
  for (const fact of facts.filter((candidate) => candidate.kind === 'candidate_submitted')) {
    const candidateId = fact.summary?.candidate_material_id;
    if (!candidateId || !fact.executionId) continue;
    const existing = submissions.get(candidateId);
    if (!existing || (fact.at && (!existing.at || fact.at < existing.at))) submissions.set(candidateId, fact);
  }
  const rows = [...model.checks].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).map((check) => {
    const submission = submissions.get(check.candidate_material_id);
    const start = timeMs(parseTime(check.created_at));
    const end = timeMs(parseTime(check.updated_at));
    return {
      candidate_material_id: check.candidate_material_id,
      check_result_id: check.check_result_id,
      task_id: check.target_task_id,
      execution_id: check.execution_id,
      verdict: check.verdict ?? 'unknown',
      status: check.status,
      diagnostic_class: check.diagnostic_class ?? 'unknown',
      submitted_at: submission?.at ?? check.created_at,
      checked_at: check.updated_at,
      check_elapsed_ms: start !== null && end !== null ? Math.max(0, end - start) : null,
      workspace_revision: submission?.summary?.workspace_revision ?? null,
      evidence: [...new Set([check.source.ref, ...(submission?.sources ?? [])])],
    };
  });
  const diagnosticCounts = {};
  for (const row of rows) {
    const key = `${row.task_id}|${row.diagnostic_class}`;
    diagnosticCounts[key] = (diagnosticCounts[key] ?? 0) + 1;
  }
  const repeated = Object.entries(diagnosticCounts).filter(([, count]) => count >= 2).map(([key, count]) => {
    const [task_id, diagnostic_class] = key.split('|');
    return { task_id, diagnostic_class, count, evidence: rows.filter((row) => row.task_id === task_id && row.diagnostic_class === diagnostic_class).flatMap((row) => row.evidence).slice(0, 12) };
  });
  return {
    rows,
    pass_count: rows.filter((row) => row.verdict === 'PASS').length,
    fail_count: rows.filter((row) => row.verdict === 'FAIL').length,
    repeated_diagnostics: repeated,
    all_failed: rows.length > 0 && rows.every((row) => row.verdict === 'FAIL'),
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
  if (categories.has('claim_active_execution_quota')) {
    add('P1', 'claim contention', 'Do not dispatch a Task to a Core when its active Execution quota is full; after a conflict, back off and refresh the queue.', 'This run produced repeated quota conflicts while active Executions already owned the work.', 'Count unique quota conflicts per run and require the next retry to occur only after claimability changes.', analysis.errors.filter((error) => error.category === 'claim_active_execution_quota').flatMap((error) => error.evidence));
  }
  if (categories.has('check_result_contract_mismatch')) {
    add('P1', 'task-contract/tool mismatch', 'Expose completion-contract capabilities to the Agent and prevent apply_check_result on research Tasks that do not require a CheckResult.', 'Five unique invalid operations consumed turns and returned the same NOT_ALLOWED contract error.', 'Run a research Task fixture and assert zero apply_check_result calls, while proof Tasks still apply matching results.', analysis.errors.filter((error) => error.category === 'check_result_contract_mismatch').flatMap((error) => error.evidence));
  }
  if (analysis.candidates.all_failed || analysis.candidates.repeated_diagnostics.length) {
    add('P1', 'candidate route control', 'After two consecutive FAILs in the same diagnostic class, require a documented route change, parent review, or a bounded research Task before another submission.', 'Nine checks all failed and repeated no-progress/tactic diagnostics did not produce a PASS.', 'Report diagnostic-class transitions and compare the next Candidate against the previous feedback before allowing another attempt.', analysis.candidates.repeated_diagnostics.flatMap((row) => row.evidence));
  }
  if (analysis.terminal) {
    add('P1', 'timebox cleanup', analysis.terminal.next_optimization, analysis.terminal.interpretation, 'Run a short timebox fixture with a waiting Root and open Child; assert explicit terminal reason and no orphaned wait.', analysis.terminal.evidence);
  }
  const unconsumed = analysis.collaboration.filter((row) => row.assessment === 'no recorded consumer');
  if (unconsumed.length) {
    add('P2', 'handoff visibility', 'Make parent review/Material consumption explicit before treating a child result as delivered.', `${unconsumed.length} Material(s) had no recorded consumer in this run; this is an evidence result, not a claim that they were useless.`, 'Add a report assertion for each published Material: consumer, downstream operation, or explicit no-consumer state.', unconsumed.map((row) => row.published_evidence));
  }
  add('P0', 'analysis quality', 'Keep the cross-source operation-chain deduplication and add regression fixtures for Service/Observation/Agent echoes.', 'The same failure appears in multiple layers; the report must preserve supporting evidence without counting it as independent failures.', 'A fixture should produce one unique occurrence with multiple supporting source references.', analysis.errors.flatMap((error) => error.evidence));
  return recommendations;
}

function deriveConclusions(analysis) {
  const conclusions = [];
  const statuses = Object.fromEntries(analysis.inventory.evidence.map((entry) => [entry.class, entry.status]));
  const missing = EVIDENCE_CLASSES.filter((name) => ['missing', 'empty', 'malformed'].includes(statuses[name]));
  conclusions.push({ type: 'fact', text: `The analyzer found ${analysis.executions.length} Execution(s), ${analysis.model.tasks.length} Task(s), ${analysis.model.materials.length} Material(s), and ${analysis.model.checks.length} Judge check record(s).`, evidence: analysis.executions.flatMap((item) => item.sources).slice(0, 8) });
  if (missing.length) conclusions.push({ type: 'limitation', text: `The evidence boundary is incomplete or malformed for: ${missing.join(', ')}. The report is diagnostic-only for conclusions that depend on those sources.`, evidence: missing.map((name) => `evidence:${name}`) });
  else conclusions.push({ type: 'fact', text: 'The expected local evidence classes were found; source-level gaps and integrity warnings are still reported below.', evidence: analysis.inventory.evidence.map((entry) => `evidence:${entry.class}`) });
  if (analysis.collaboration.some((row) => row.assessment === 'accepted-but-unused')) conclusions.push({ type: 'interpretation', text: 'At least one Material is marked accepted but has no recorded consumer. This is an evidence-backed handoff result, not a claim that the Material was mathematically useless.', evidence: analysis.collaboration.filter((row) => row.assessment === 'accepted-but-unused').map((row) => row.published_evidence) });
  if (analysis.warnings.length) conclusions.push({ type: 'limitation', text: `${analysis.warnings.length} event reference(s) point to an unknown Task or Execution in the authoritative model. Those events are retained as unmatched facts.`, evidence: analysis.warnings.slice(0, 8).flatMap((warning) => warning.sources ?? []) });
  for (const error of analysis.errors.slice(0, 8)) conclusions.push({ type: 'error-analysis', text: `${error.occurrence_count} unique ${error.category} occurrence(s) were found for ${error.operation}: ${error.interpretation}`, evidence: error.evidence.slice(0, 8) });
  if (analysis.candidates.all_failed) conclusions.push({ type: 'error-analysis', text: `All ${analysis.candidates.rows.length} recorded Candidate check(s) returned FAIL. Repeated diagnostic classes are reported as route non-convergence, not as proof of a mathematical impossibility.`, evidence: analysis.candidates.rows.flatMap((row) => row.evidence).slice(0, 12) });
  if (analysis.terminal) conclusions.push({ type: 'interpretation', text: analysis.terminal.interpretation, evidence: analysis.terminal.evidence.slice(0, 8) });
  conclusions.push({ type: 'policy', text: 'The report treats heartbeat, turn count, Material count, Task acceptance, and report.json made_progress as activity or supporting metrics. None is labeled productive Goal progress by itself.', evidence: ['docs/benchmark-analysis-sop.md'] });
  return conclusions;
}

export async function resolveExperiment(input, { experimentsRoot = null } = {}) {
  if (typeof input !== 'string' || !input.trim()) throw new TypeError('experiment directory or ID is required');
  const candidate = resolve(input);
  if (await isDirectory(candidate)) return candidate;
  const root = resolve(experimentsRoot ?? join(process.cwd(), 'experiments'));
  const byId = join(root, input);
  if (await isDirectory(byId)) return byId;
  throw new Error(`experiment not found: ${input}`);
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
  const model = await readDomainDatabases(root, dbPaths, modelErrors);
  const workspaceErrors = [];
  const workspaceFacts = mode === 'full' ? await readWorkspaceFacts(root, projectIds, model, workspaceErrors) : [];
  const runtimePaths = inventory.evidence.find((entry) => entry.class === 'runtime')?.paths ?? [];
  const rawRuntimeRecords = [];
  for (const pathRef of runtimePaths) {
    const path = resolve(root, pathRef);
    for (const line of (await readFile(path, 'utf8').catch(() => '')).split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { rawRuntimeRecords.push(JSON.parse(line)); } catch { /* inventory has the error */ }
    }
  }
  const intervals = buildExecutionIntervals(rawRuntimeRecords);
  const observationCandidates = [];
  for (const path of resolveConfiguredObservation(root, metadata)) if (await isRegularFile(path)) observationCandidates.push(path);
  const observationFacts = [];
  const observationErrors = [];
  if (observationCandidates.length) {
    for (const path of observationCandidates) {
      const facts = await readObservationFacts(root, path, inventory.experimentId, mode, observationErrors);
      if (facts.length) { observationFacts.push(...facts); break; }
    }
  }
  const rawErrors = [];
  const rawFacts = await readRawFacts(root, projectIds, mode, intervals, rawErrors);
  const domainFacts = factsFromDomainModel(root, model);
  const allFacts = dedupeFacts([...observationFacts, ...rawFacts, ...domainFacts, ...workspaceFacts]);
  const warnings = attachFactReferences(allFacts, model, intervals);
  const summaries = await readSummaries(root, metadata, modelErrors);
  const projectSummary = summaries.find((summary) => summary.data?.run?.protocol_valid !== null || summary.data?.run?.solved !== null) ?? summaries[0];
  const experimentEnd = inventory.metadata.experiment?.ended_at ?? projectSummary?.data?.run?.ended_at ?? new Date().toISOString();
  const executions = executionInventory(model, allFacts, experimentEnd);
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
  };
  analysis.aggregate = aggregateSummary(summaries, model, allFacts, { ...inventory, executions_count: executions.length });
  analysis.errors = buildErrorAnalysis(allFacts);
  analysis.candidates = buildCandidateAnalysis(model, allFacts);
  analysis.terminal = buildTerminalAnalysis(analysis);
  analysis.optimizations = buildOptimizationRecommendations(analysis);
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
  const rows = executions.map(({ execution: item, counts, sources }) => `| ${md(item.execution_id)} | ${md(item.task_id)} | ${md(item.owner_ref)} | ${md(item.state)} | ${md(item.attempt_no ?? 'unknown')} | ${Object.values(counts).reduce((a, b) => a + b, 0)} | ${sources.slice(0, 3).join('<br>') || 'none'} |`);
  return rows.length ? ['| Execution | Task | Owner | Terminal/current state | Attempt | Facts | Evidence |', '|---|---|---|---|---:|---:|---|', ...rows].join('\n') : '_No Execution was discoverable._';
}

function windowTable(item) {
  const rows = item.windows.map((window, index) => `| ${index + 1} | ${window.time.start}<br>${window.time.end} | ${window.time.duration_ms} ms${window.time.evidence_gap ? ' (evidence gap)' : ''} | ${window.operations.map(md).join('<br>')} | ${md(window.observed_intent)} | ${md(window.intent_confidence)}<br>${md(window.intent_basis.join(', '))} | ${md(window.result)} | ${md(window.next_state)} | ${md(window.handoff_or_blocker)} |`);
  return ['| # | Time | Duration | Operations | Observed intent | Basis/confidence | Result | Next state | Handoff/blocker |', '|---:|---|---:|---|---|---|---|---|---|', ...rows].join('\n');
}

function renderMarkdown(analysis) {
  const factMap = new Map(analysis.facts.map((fact) => [fact.id, fact]));
  const aggregate = analysis.aggregate;
  const conclusionLines = analysis.conclusions.map((item) => `- **${item.type}:** ${item.text} _(evidence: ${item.evidence.join(', ') || 'none recorded'})_`).join('\n');
  const executionSections = analysis.executions.map((item) => {
    const counts = Object.entries(item.counts).map(([key, value]) => `${key}=${value}`).join(', ') || 'no normalized facts';
    const artifacts = item.facts.filter((fact) => ['material_published', 'material_consumed', 'candidate_submitted', 'workspace_revision', 'judge_result', 'judge_check'].includes(fact.kind)).slice(0, 40).map((fact) => `- ${compactFact(fact)} — ${fact.sources.join(', ')}`).join('\n') || '- No artifact/check fact was observed for this Execution.';
    return `### Execution \`${md(item.execution.execution_id)}\`\n\n- Task: \`${md(item.execution.task_id)}\`\n- Owner: ${md(item.execution.owner_ref)}\n- Current/terminal state: **${md(item.execution.state)}**\n- Attempt: ${md(item.execution.attempt_no ?? 'unknown')}\n- Normalized fact counts: ${counts}\n- Evidence mode: ${analysis.inventory.evidenceMode}\n\n#### Time-window summaries\n\n${windowTable(item)}\n\n#### Artifacts, Service effects, and errors\n\n${artifacts}\n`;
  }).join('\n');
  const collaborationRows = analysis.collaboration.map((row) => `| ${md(row.material_id)} | ${md(row.kind)} / ${md(row.evidence_state)} | ${md(row.publisher.execution_id ?? 'unknown')} | ${row.consumers.map((consumer) => `${consumer.execution_id ?? 'unknown'} (${consumer.evidence})`).join('<br>') || 'none recorded'} | ${row.downstream_effects.map((effect) => `${effect.kind} (${effect.evidence})`).join('<br>') || 'none recorded'} | ${md(row.assessment)} |`).join('\n');
  const errorRows = analysis.errors.map((error) => `| ${md(error.severity)} | ${md(error.category)} | ${error.occurrence_count} | ${error.supporting_record_count} | ${md(error.operation)} | ${md(error.interpretation)} | ${error.evidence.slice(0, 6).join('<br>')} |`).join('\n');
  const optimizationRows = analysis.optimizations.map((item) => `| ${md(item.priority)} | ${md(item.category)} | ${md(item.action)} | ${md(item.rationale)} | ${md(item.validation)} | ${item.evidence.slice(0, 6).join('<br>')} |`).join('\n');
  const candidateRows = analysis.candidates.rows.map((row) => `| ${md(row.candidate_material_id)} | ${md(row.task_id)} | ${md(row.execution_id)} | ${md(row.verdict)} | ${md(row.diagnostic_class)} | ${md(row.check_elapsed_ms)} | ${row.evidence.slice(0, 4).join('<br>')} |`).join('\n');
  const repeatedDiagnosticRows = analysis.candidates.repeated_diagnostics.map((row) => `| ${md(row.task_id)} | ${md(row.diagnostic_class)} | ${row.count} | ${row.evidence.slice(0, 6).join('<br>')} |`).join('\n');
  const healthByCore = {};
  for (const fact of analysis.facts.filter((candidate) => ['heartbeat', 'execution_assigned', 'wait_requested', 'execution_terminal', 'session_started', 'session_closed'].includes(candidate.kind))) {
    const key = fact.coreId ?? 'unknown';
    if (!healthByCore[key]) healthByCore[key] = {};
    healthByCore[key][fact.kind] = (healthByCore[key][fact.kind] ?? 0) + 1;
  }
  const healthRows = Object.entries(healthByCore).map(([core, counts]) => `| ${core} | ${Object.entries(counts).map(([key, value]) => `${key}=${value}`).join('<br>')} |`).join('\n');
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

## Task/Execution inventory

### Tasks

${taskTable(analysis.model)}

### Executions

${executionTable(analysis.executions)}

## Per-Execution analysis

${executionSections || '_No Execution section can be rendered from the available evidence._'}

## Collaboration review

| Material | Kind/state | Publisher | Explicit consumers | Recorded downstream effects | Assessment |
|---|---|---|---|---|---|
${collaborationRows || '| _none_ | — | — | — | — | No Material rows available |'}

The assessment labels are deliberately narrow: 'accepted-but-unused' means the authoritative Material state says accepted and no explicit read was found; 'consumed-without-recorded-downstream-effect' means a read was recorded but no later Workspace/Candidate/Judge/review operation was linked. Neither label is a semantic judgment of mathematical value.

## Scheduling and health review

| Core/session lane | Recorded lifecycle facts |
|---|---|
${healthRows || '| unknown | No Core/session facts available |'}

Heartbeats are lease activity only. Agent turns, process health, Judge time, IDLE, WAITING, scheduler polling, and effective Agent work are not collapsed into one metric. An unexplained interval is reported as an evidence gap, not a scheduler defect.

## Error analysis

The analyzer groups raw Agent, Bridge, Service, and Observation echoes into unique operation-time occurrences. 'occurrence_count' is the estimated number of independent failures; source references show supporting records and are not additional failures.

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

| Candidate/material | Task | Execution | Verdict | Diagnostic class | Check elapsed (ms) | Evidence |
|---|---|---|---|---|---:|---|
${candidateRows || '| _none_ | — | — | — | — | — | — |'}

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

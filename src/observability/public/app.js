const state = {
  experiment: null,
  experiments: [],
  events: [],
  timeline: null,
  toolCounts: {},
  model: null,
  source: null,
  registrySource: null,
  registryRevision: null,
  registryLongPoll: false,
  lastUpdated: null,
  refreshInFlight: false,
  timelineTimer: null,
  timelineRequest: 0,
  detailCache: new Map(),
  taskDetailCache: new Map(),
  executionInsightCache: new Map(),
  materialDetailCache: new Map(),
  reportCache: new Map(),
  range: 'all',
  selectedExecution: null,
};

const $ = (selector, root) => (root || document).querySelector(selector);
const $$ = (selector, root) => [...(root || document).querySelectorAll(selector)];
const H = (...parts) => parts.join('');

const ICONS = {
  home: '<svg viewBox="0 0 24 24"><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z"/><path d="M9 21v-7h6v7"/></svg>',
  activity: '<svg viewBox="0 0 24 24"><path d="M3 12h4l2.2-7 4.1 14 2.4-7H21"/></svg>',
  tasks: '<svg viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/></svg>',
  layers: '<svg viewBox="0 0 24 24"><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/></svg>',
  pulse: '<svg viewBox="0 0 24 24"><path d="M3 12h4l2-7 4 14 2-7h6"/></svg>',
  server: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="6" rx="1"/><rect x="3" y="14" width="18" height="6" rx="1"/><path d="M7 7h.01M7 17h.01"/></svg>',
  refresh: '<svg viewBox="0 0 24 24"><path d="M20 11a8.1 8.1 0 0 0-14.8-3L3 11"/><path d="M3 5v6h6M4 13a8.1 8.1 0 0 0 14.8 3L21 13"/><path d="M21 19v-6h-6"/></svg>',
  menu: '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16"/></svg>',
  arrow: '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></svg>',
  alert: '<svg viewBox="0 0 24 24"><path d="M10.3 4.2 2.7 17a2 2 0 0 0 1.7 3h15.2a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
};

function installIcons() {
  $$('[data-icon]').forEach((node) => { node.innerHTML = ICONS[node.dataset.icon] || ''; });
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character]));
}

function shortId(value, length) {
  const text = String(value || '');
  const size = length || 12;
  return text.length > size ? text.slice(0, size) + '…' : text || '—';
}

function formatTime(value, withDate) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString([], withDate
    ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }
    : { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '0s';
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return seconds + 's';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + 'm ' + (seconds % 60) + 's';
  return Math.floor(minutes / 60) + 'h ' + Math.floor((seconds % 3600) / 60) + 'm';
}

function formatNumber(value) { return Number(value || 0).toLocaleString(); }
function normalizeState(value) { return String(value || 'UNKNOWN').toLowerCase().replace(/[^a-z0-9]+/g, '-'); }
function eventLabel(event) { return String(event && event.kind || 'observation').replaceAll('_', ' ').replaceAll('.', ' · '); }
function conditionLabel(value) { return typeof value === 'string' ? value : value && typeof value === 'object' ? value.type || value.reason || value.code || 'condition' : null; }
function statusPill(status) { return '<span class="status-pill ' + escapeHtml(normalizeState(status)) + '">' + escapeHtml(status || 'UNKNOWN') + '</span>'; }
function emptyState(title, description) { return '<div class="empty"><strong>' + escapeHtml(title) + '</strong><p>' + escapeHtml(description) + '</p></div>'; }
function relationLink(type, id, label) { return '<button class="relation-link" data-route="' + escapeHtml(type) + '/' + escapeHtml(id) + '">' + escapeHtml(label || shortId(id)) + '</button>'; }

function displayValue(value) {
  if (value && typeof value === 'object' && value.redacted) return 'redacted · ' + shortId(value.sha256, 12);
  if (value == null || value === '') return '—';
  return String(value);
}

function jsonValue(value, maxLength) {
  const limit = maxLength || 16_000;
  if (value === undefined) return '—';
  let text;
  try { text = JSON.stringify(value, null, 2); } catch { text = String(value); }
  return text.length > limit ? text.slice(0, limit) + '\n… [display truncated]' : text;
}

function redactSecrets(value, key, depth) {
  const level = depth || 0;
  if (/(authorization|api[_-]?key|access[_-]?token|password|private[_-]?key|secret|proof|formal[_-]?source|raw[_-]?transcript|task[_-]?instructions|credential|bearer|cookie|(?:^|[_-])token(?:$|[_-]))/i.test(String(key || ''))) return '[redacted]';
  if (typeof value === 'string') return value.length <= 4_000 ? value : value.slice(0, 4_000) + '\n[display truncated]';
  if (level > 6) return '[nested value truncated]';
  if (Array.isArray(value)) {
    const items = value.slice(0, 100).map((item) => redactSecrets(item, '', level + 1));
    if (value.length > 100) items.push('[array items truncated]');
    return items;
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactSecrets(child, childKey, level + 1)]));
}

function safeJson(value, maxLength) { return jsonValue(redactSecrets(value), maxLength); }

function compactText(value, maxLength = 240) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > maxLength ? text.slice(0, maxLength - 1) + '…' : text;
}

function detailValue(value, keys) {
  if (!value || typeof value !== 'object') return null;
  for (const key of keys) if (value[key] !== undefined && value[key] !== null && value[key] !== '') return value[key];
  return null;
}

function resultDetails(value) {
  if (!value || typeof value !== 'object') return value;
  return value.details && typeof value.details === 'object' ? value.details : value.result && typeof value.result === 'object' ? value.result : value;
}

function toolSummary(call) {
  if (!call.end) return 'Waiting for the tool to return';
  const result = resultDetails(call.result);
  if (call.isError || result && result.ok === false || result && result.error) {
    return 'Error · ' + compactText(detailValue(result && result.error, ['message', 'code']) || result && result.message || 'tool returned an error');
  }
  const task = result && (result.task || result.task_id && (result.goal || result.task_type) && result);
  if (task) return compactText((task.task_type || 'Task') + ' · ' + (task.goal || task.task_id || '') + (task.state ? ' · ' + task.state : ''));
  const execution = result && (result.execution || result.execution_id && (result.owner_ref || result.attempt_no || result.workspace_ref) && result);
  if (execution) return compactText('Execution ' + shortId(execution.execution_id, 12) + (execution.state ? ' · ' + execution.state : '') + (execution.workspace_revision ? ' · revision ' + execution.workspace_revision : ''));
  const material = result && (result.material || result.material_id && (result.kind || result.evidence_state) && result);
  if (material) return compactText((material.kind || 'Material') + ' · ' + (material.description || material.material_id || material.evidence_state || 'published'));
  if (Array.isArray(result && result.tools)) return result.tools.length + ' tools in the visible catalog';
  if (Array.isArray(result && result.tasks)) return result.tasks.length + ' Tasks returned';
  if (Array.isArray(result && result.files)) return result.files.length + ' Workspace files returned';
  const message = detailValue(result, ['message', 'description', 'reason', 'operation', 'path', 'workspace_ref', 'state', 'status']);
  if (message !== null) return compactText(typeof message === 'object' ? safeJson(message, 240) : message);
  if (typeof result === 'string') return compactText(result);
  return compactText(safeJson(result, 260));
}

function toolArgumentSummary(call) {
  const args = call.args;
  if (!args || typeof args !== 'object' || !Object.keys(args).length) return 'No arguments';
  const command = detailValue(args, ['command', 'cmd', 'script']);
  if (command) return compactText(String(command), 300);
  const keys = ['task_id', 'execution_id', 'root_id', 'service', 'path', 'operation', 'kind', 'scope', 'workspace_mode', 'wait_condition'];
  const parts = keys.flatMap((key) => args[key] === undefined ? [] : [key + '=' + compactText(typeof args[key] === 'object' ? safeJson(args[key], 120) : args[key], 120)]);
  return parts.length ? parts.slice(0, 3).join(' · ') : compactText(safeJson(args, 220));
}

function toolKind(name) {
  if (/bash|shell|exec_command|terminal/i.test(String(name || ''))) return 'shell';
  if (/workspace|file/i.test(String(name || ''))) return 'workspace';
  if (/task|execution/i.test(String(name || ''))) return 'runtime';
  if (/context|material/i.test(String(name || ''))) return 'context';
  if (/judge|check/i.test(String(name || ''))) return 'judge';
  return 'service';
}

async function get(path) {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(response.status + ' ' + response.statusText);
  return response.json();
}

async function getAllPages(path) {
  const events = [];
  let cursor = 0;
  for (let pageNumber = 0; pageNumber < 200; pageNumber += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const page = await get(path + separator + 'after_sequence=' + cursor);
    events.push(...(page.events || []));
    if (!page.has_more || page.next_cursor == null) return { events, truncated: false };
    if (page.next_cursor <= cursor) throw new Error('event cursor did not advance');
    cursor = page.next_cursor;
  }
  return { events, truncated: true };
}

function readNested(value, keys, depth) {
  const level = depth || 0;
  if (!value || typeof value !== 'object' || level > 5) return null;
  for (const key of keys) if (value[key] !== undefined && value[key] !== null) return value[key];
  for (const child of Object.values(value)) {
    const found = readNested(child, keys, level + 1);
    if (found !== null) return found;
  }
  return null;
}

function materialCandidates(value, depth) {
  const level = depth || 0;
  if (!value || typeof value !== 'object' || level > 5) return [];
  const result = [];
  if (typeof value.material_id === 'string') result.push(value);
  if (Array.isArray(value)) value.forEach((child) => result.push(...materialCandidates(child, level + 1)));
  else Object.values(value).forEach((child) => result.push(...materialCandidates(child, level + 1)));
  return result;
}

function mergeDefined(target, source) {
  if (!source || typeof source !== 'object') return target;
  Object.entries(source).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') target[key] = value;
  });
  return target;
}

function timelineSegments() {
  return (state.timeline && state.timeline.lanes || []).flatMap((lane) => (lane.states || lane.segments || []).map((segment) => ({ ...segment, core_id: lane.core_id })));
}

function eventToolRecord(event) {
  if (event.kind === 'rpc_record' && event.payload && event.payload.record) return event.payload.record;
  return null;
}

function extractToolCalls(events) {
  const calls = new Map();
  (events || []).forEach((event) => {
    const record = eventToolRecord(event);
    if (!record) return;
    const isStart = record.type === 'tool_execution_start' || record.type === 'tool_call';
    const isEnd = record.type === 'tool_execution_end' || record.type === 'tool_result';
    if (!isStart && !isEnd) return;
    const id = record.toolCallId || record.tool_call_id || record.id || event.sequence;
    if (isStart) {
      calls.set(id, {
        id,
        toolName: record.toolName || 'unknown tool',
        args: record.args,
        start: event,
        end: null,
        result: null,
        isError: false,
      });
    } else if (isEnd) {
      const call = calls.get(id) || {
        id,
        toolName: record.toolName || 'unknown tool',
        args: null,
        start: event,
        end: null,
        result: null,
        isError: false,
      };
      call.toolName = record.toolName || call.toolName;
      call.result = record.result;
      call.isError = Boolean(record.isError);
      call.end = event;
      calls.set(id, call);
    }
  });
  return [...calls.values()].sort((a, b) => (a.start.sequence || 0) - (b.start.sequence || 0));
}

function toolCountForExecution(events, executionId) {
  return extractToolCalls((events || []).filter((event) => event.execution_id === executionId)).length;
}

function buildModel() {
  const tasks = new Map();
  const executions = new Map();
  const materials = new Map();
  const taskLinks = new Map();

  function ensureTask(id, patch) {
    if (!id) return null;
    const task = tasks.get(id) || { task_id: id, state: 'UNKNOWN', children: new Set(), executions: new Set(), material_ids: new Set(), event_count: 0, running_ms: 0, errors: 0, fields: {} };
    mergeDefined(task, patch || {});
    if (patch) mergeDefined(task.fields, patch);
    tasks.set(id, task);
    return task;
  }

  function ensureExecution(id, patch) {
    if (!id) return null;
    const execution = executions.get(id) || { execution_id: id, state: 'UNKNOWN', task_id: null, material_ids: [], event_count: 0, running_ms: 0, errors: 0, tool_calls: 0, fields: {} };
    mergeDefined(execution, patch || {});
    if (patch) mergeDefined(execution.fields, patch);
    executions.set(id, execution);
    return execution;
  }

  function ensureMaterial(material) {
    if (!material || !material.material_id) return null;
    const existing = materials.get(material.material_id) || { material_id: material.material_id, links: new Set(), consumers: new Set(), event_count: 0, fields: {} };
    mergeDefined(existing, material);
    mergeDefined(existing.fields, material);
    materials.set(material.material_id, existing);
    return existing;
  }

  function linkMaterial(id, event) {
    if (!id) return;
    const material = ensureMaterial({ material_id: id });
    material.event_count += 1;
    if (event.execution_id) {
      material.links.add(event.execution_id);
      const execution = ensureExecution(event.execution_id);
      if (!execution.material_ids.includes(id)) execution.material_ids.push(id);
      const operation = event.payload && event.payload.operation || '';
      if (/read|consume|use|action/i.test(event.kind + ' ' + operation)) material.consumers.add(event.execution_id);
    }
    if (event.task_id) {
      material.links.add(event.task_id);
      ensureTask(event.task_id).material_ids.add(id);
    }
  }

  state.events.forEach((event) => {
    const payload = event.payload || {};
    const taskPayload = readNested(payload, ['task']);
    const executionPayload = readNested(payload, ['execution']);
    const taskId = event.task_id || taskPayload && taskPayload.task_id || executionPayload && executionPayload.task_id || readNested(payload, ['target_task_id', 'parent_task_id']);
    const executionId = event.execution_id || executionPayload && executionPayload.execution_id;
    const waitCondition = payload.wait_condition || payload.wait_reason || taskPayload && taskPayload.wait_condition || executionPayload && executionPayload.wait_condition || payload.result && payload.result.wait_condition;
    // Keep the event envelope as the identity source. A recursive payload
    // lookup can find an unrelated `execution` object inside a tool result;
    // allowing that field to overwrite the map key creates duplicate rows for
    // one Runtime Execution (for example, a Pi session id and the durable id).
    const taskPatch = taskPayload && typeof taskPayload === 'object' ? { ...taskPayload } : {};
    if (taskId && taskPatch.task_id && taskPatch.task_id !== taskId) delete taskPatch.task_id;
    const executionPatch = executionPayload && typeof executionPayload === 'object' ? { ...executionPayload } : {};
    if (executionId && executionPatch.execution_id && executionPatch.execution_id !== executionId) delete executionPatch.execution_id;
    const task = ensureTask(taskId, taskPatch);
    const execution = ensureExecution(executionId, executionPatch);

    if (task) {
      task.event_count += 1;
      task.updated_at = event.occurred_at;
      if (executionId) task.executions.add(executionId);
      const nestedTaskState = taskPayload && typeof taskPayload === 'object' ? taskPayload.state : null;
      if (nestedTaskState || event.kind === 'task_state_changed' || payload.task_state || ['OPEN', 'RUNNING', 'WAITING', 'SUCCEEDED', 'SATISFIED', 'FAILED'].includes(payload.state)) task.state = nestedTaskState || payload.task_state || payload.state || task.state;
      if (payload.block_reason || waitCondition) task.block_reason = conditionLabel(payload.block_reason || waitCondition);
      if (taskPayload && taskPayload.parent_id) { task.parent_id = taskPayload.parent_id; ensureTask(task.parent_id).children.add(task.task_id); }
      if (taskPayload && taskPayload.goal) task.goal = taskPayload.goal;
      if (/error|failed|timeout/i.test(event.kind)) task.errors += 1;
    }

    if (execution) {
      execution.event_count += 1;
      execution.updated_at = event.occurred_at;
      execution.task_id = execution.task_id || taskId;
      execution.core_id = execution.core_id || event.core_id;
      execution.session_id = execution.session_id || event.session_id;
      const nestedExecutionState = executionPayload && typeof executionPayload === 'object' ? executionPayload.state : null;
      if (nestedExecutionState || event.kind === 'execution_released' || event.kind === 'core_state_changed' || payload.state) execution.state = nestedExecutionState || payload.state || execution.state;
      if (waitCondition) execution.wait_condition = waitCondition;
      if (/error|failed|timeout/i.test(event.kind)) execution.errors += 1;
      if (task) task.executions.add(execution.execution_id);
    }

    materialCandidates(payload).forEach((material) => {
      const saved = ensureMaterial(material);
      if (saved.source_task) ensureTask(saved.source_task).material_ids.add(saved.material_id);
      if (saved.source_execution) {
        const sourceExecution = ensureExecution(saved.source_execution);
        if (!sourceExecution.material_ids.includes(saved.material_id)) sourceExecution.material_ids.push(saved.material_id);
      }
      linkMaterial(saved.material_id, event);
    });

    const ids = new Set();
    function collectIds(value, depth) {
      const level = depth || 0;
      if (!value || typeof value !== 'object' || level > 5) return;
      Object.entries(value).forEach(([key, child]) => {
        if (/material_id$/i.test(key) && typeof child === 'string') ids.add(child);
        if (/material_ids|input_material_refs|steer_material_refs/i.test(key) && Array.isArray(child)) child.filter((item) => typeof item === 'string').forEach((item) => ids.add(item));
        collectIds(child, level + 1);
      });
    }
    collectIds(payload);
    ids.forEach((id) => linkMaterial(id, event));
    if (taskId && executionId) taskLinks.set(taskId + ':' + executionId, { task_id: taskId, execution_id: executionId });
  });

  tasks.forEach((task) => { if (task.parent_id) ensureTask(task.parent_id).children.add(task.task_id); });
  timelineSegments().forEach((segment) => {
    const execution = ensureExecution(segment.execution_id, { task_id: segment.task_id, core_id: segment.core_id, state: segment.state });
    const duration = segment.ended_at ? new Date(segment.ended_at).getTime() - new Date(segment.started_at).getTime() : 0;
    if (String(segment.state || '').toUpperCase() !== 'RUNNING') return;
    if (execution) execution.running_ms += Math.max(0, duration);
    if (segment.task_id) ensureTask(segment.task_id).running_ms += Math.max(0, duration);
  });

  executions.forEach((execution) => { if (execution.task_id) ensureTask(execution.task_id).executions.add(execution.execution_id); });
  // The list count must match the operator stream opened by the Execution
  // inspector. Session-scoped Pi records can sit beside Runtime records in
  // the Agent view; attributing those records by Core time double-counts a
  // durable Execution and makes the list disagree with its detail page.
  executions.forEach((execution) => {
    const serverCount = state.toolCounts && state.toolCounts[execution.execution_id];
    execution.tool_calls = Number.isFinite(serverCount) ? serverCount : toolCountForExecution(state.events, execution.execution_id);
  });

  // A Pi session can be restarted several times during one durable Execution.
  // Session IDs still appear in the raw event stream, but the dashboard's
  // Execution list should be about Runtime-owned attempts. Keep IDs that are
  // anchored by a Core interval or an explicit Execution projection.
  const durableExecutionIds = new Set(timelineSegments().map((segment) => segment.execution_id).filter(Boolean));
  state.events.forEach((event) => {
    if (event.execution_id && ['execution_assigned', 'execution_released', 'core_state_changed', 'execution_started', 'execution_waiting', 'execution_wait', 'execution_observed', 'execution_execution'].includes(event.kind)) durableExecutionIds.add(event.execution_id);
    const nestedExecution = readNested(event.payload || {}, ['execution']);
    if (nestedExecution && nestedExecution.execution_id && event.kind === 'dispatch.complete') durableExecutionIds.add(nestedExecution.execution_id);
  });
  tasks.forEach((task) => { task.executions = new Set([...task.executions].filter((executionId) => durableExecutionIds.has(executionId))); });

  const errors = state.events.filter((event) => {
    const payload = event.payload || {};
    return /error|failed|timeout|stale|fenced/i.test(event.kind || '') || payload.ok === false || Boolean(payload.error || payload.result && payload.result.error) || event.kind === 'process_stderr';
  });
  const waits = state.events.filter((event) => {
    const payload = event.payload || {};
    const executionPayload = readNested(payload, ['execution']);
    const taskPayload = readNested(payload, ['task']);
    const stateValue = payload.state || executionPayload && executionPayload.state || taskPayload && taskPayload.state;
    return /wait/i.test(event.kind || '') || stateValue === 'WAITING' || Boolean(payload.wait_condition || payload.wait_reason || executionPayload && executionPayload.wait_condition || taskPayload && taskPayload.wait_condition);
  });
  const services = new Map();
  state.events.forEach((event) => {
    const service = event.payload && event.payload.service || (event.source === 'service' ? 'service' : null);
    if (!service && !/dispatch|service|judge|route/i.test(event.kind || '')) return;
    const name = service || (event.source === 'judge' ? 'judge' : event.source || 'runtime');
    const item = services.get(name) || { name, calls: 0, errors: 0 };
    item.calls += 1; item.last_at = event.occurred_at;
    if (/error|failed/i.test(event.kind || '') || event.payload && event.payload.ok === false) item.errors += 1;
    services.set(name, item);
  });

  return {
    tasks: [...tasks.values()].map((item) => ({ ...item, children: [...item.children], executions: [...item.executions], material_ids: [...item.material_ids] })),
    executions: [...executions.values()].filter((item) => durableExecutionIds.has(item.execution_id)).map((item) => ({ ...item, material_ids: [...new Set(item.material_ids)] })),
    materials: [...materials.values()].map((item) => ({ ...item, links: [...item.links], consumers: [...item.consumers] })),
    taskLinks: [...taskLinks.values()], services: [...services.values()], errors, waits,
  };
}

function timelineBounds() {
  const dates = state.events.map((event) => new Date(event.occurred_at).getTime()).filter(Number.isFinite);
  timelineSegments().forEach((segment) => {
    dates.push(new Date(segment.started_at).getTime());
    if (segment.ended_at) dates.push(new Date(segment.ended_at).getTime());
  });
  let min = Math.min(...dates); let max = Math.max(...dates);
  if (!Number.isFinite(min)) return { min: Date.now() - 3_600_000, max: Date.now() };
  max = Math.max(max, min + 60_000);
  if (state.range !== 'all') {
    const range = state.range === '15m' ? 900_000 : state.range === '1h' ? 3_600_000 : 14_400_000;
    min = Math.max(min, max - range);
  }
  return { min, max };
}

function positionOf(start, end, bounds) {
  const span = Math.max(1, bounds.max - bounds.min);
  const startAt = typeof start === 'number' ? start : new Date(start).getTime();
  const endAt = typeof end === 'number' ? end : end ? new Date(end).getTime() : null;
  if (!Number.isFinite(startAt)) return { left: 0, width: .7 };
  const left = Math.max(0, Math.min(100, (startAt - bounds.min) / span * 100));
  const right = endAt ? Math.max(left + .7, Math.min(100, (endAt - bounds.min) / span * 100)) : 100;
  return { left, width: Math.max(.7, right - left) };
}

function traceCoreIds() {
  const ids = new Set((state.timeline && state.timeline.lanes || []).map((lane) => lane.core_id).filter(Boolean));
  state.events.forEach((event) => { if (event.core_id) ids.add(event.core_id); });
  return [...ids].sort((left, right) => String(left).localeCompare(String(right), undefined, { numeric: true }));
}

function makeTraceSpan(kind, event, patch) {
  return {
    kind,
    id: event && (event.event_id || event.sequence) || kind,
    start: event && event.occurred_at,
    end: event && event.occurred_at,
    execution_id: event && event.execution_id || null,
    task_id: event && event.task_id || null,
    session_id: event && event.session_id || null,
    core_id: event && event.core_id || null,
    label: eventLabel(event),
    state: null,
    ...patch,
  };
}

function coreTraceData() {
  const laneByCore = new Map((state.timeline && state.timeline.lanes || []).map((lane) => [lane.core_id, lane]));
  const traces = new Map(traceCoreIds().map((coreId) => [coreId, {
    core_id: coreId,
    states: [],
    executions: [],
    turns: [],
    session_turns: [],
    tools: [],
    checks: [],
    markers: [],
    last_state: 'IDLE',
    active_execution: null,
  }]));
  const ensureTrace = (coreId) => {
    if (!coreId) return null;
    if (!traces.has(coreId)) traces.set(coreId, { core_id: coreId, states: [], executions: [], turns: [], session_turns: [], tools: [], checks: [], markers: [], last_state: 'IDLE', active_execution: null });
    return traces.get(coreId);
  };
  const executionSegments = new Map();
  const laneFor = (coreId) => ensureTrace(coreId);
  for (const [coreId, lane] of laneByCore) {
    const trace = laneFor(coreId);
    const states = lane.states && lane.states.length ? lane.states : [];
    trace.states = states.map((segment) => ({
      ...segment,
      kind: 'state',
      start: segment.started_at,
      end: segment.ended_at,
      core_id: coreId,
    }));
    trace.executions = (lane.segments || []).map((segment) => ({
      ...segment,
      kind: 'execution',
      start: segment.started_at,
      end: segment.ended_at,
      core_id: coreId,
    }));
    trace.executions.forEach((segment) => {
      if (!segment.execution_id) return;
      const segments = executionSegments.get(segment.execution_id) || [];
      segments.push(segment);
      executionSegments.set(segment.execution_id, segments);
    });
    trace.last_state = trace.states.at(-1)?.state || trace.executions.at(-1)?.state || 'IDLE';
    trace.active_execution = trace.executions.find((segment) => !segment.end)?.execution_id || null;
  }
  for (const segments of executionSegments.values()) segments.sort((left, right) => new Date(left.start) - new Date(right.start));

  const coreForExecution = (executionId, occurredAt) => {
    if (!executionId) return null;
    const segments = executionSegments.get(executionId) || [];
    const at = new Date(occurredAt).getTime();
    const matching = segments.find((segment) => {
      const start = new Date(segment.start).getTime();
      const end = segment.end ? new Date(segment.end).getTime() : Infinity;
      return Number.isFinite(at) && Number.isFinite(start) && at >= start && at < end;
    });
    return matching?.core_id || null;
  };

  const openTurns = new Map();
  const openSessions = new Map();
  const openTools = new Map();
  for (const event of state.events) {
    const coreId = event.core_id || coreForExecution(event.execution_id, event.occurred_at);
    const trace = laneFor(coreId);
    if (!trace) continue;
    if (event.kind === 'session_started') {
      const key = event.session_id || event.execution_id || `${coreId}:session`;
      const span = makeTraceSpan('session', event, { label: 'Agent session', state: 'RUNNING', end: null, execution_id: null });
      openSessions.set(key, span);
      trace.session_turns.push(span);
    } else if (event.kind === 'session_closed') {
      const key = event.session_id || event.execution_id || `${coreId}:session`;
      const span = openSessions.get(key);
      if (span) span.end = event.occurred_at;
    } else if (event.kind === 'agent_turn_started') {
      const key = event.execution_id || `${coreId}:turn`;
      const span = makeTraceSpan('turn', event, { label: 'Agent turn', state: 'RUNNING', end: null });
      openTurns.set(key, span);
      trace.turns.push(span);
    } else if (event.kind === 'agent_turn_finished') {
      const key = event.execution_id || `${coreId}:turn`;
      const span = openTurns.get(key) || trace.turns.at(-1);
      if (span && !span.end) span.end = event.occurred_at;
      if (span) span.state = event.payload && event.payload.state || 'settled';
    }
    const record = eventToolRecord(event);
    if (record && (record.type === 'tool_execution_start' || record.type === 'tool_call' || record.type === 'tool_execution_end' || record.type === 'tool_result')) {
      const id = record.toolCallId || record.tool_call_id || record.id || event.sequence;
      if (record.type === 'tool_execution_start' || record.type === 'tool_call') {
        const span = makeTraceSpan('tool', event, { label: record.toolName || 'Tool call', tool_name: record.toolName || 'Tool call', state: 'RUNNING', end: null, tool_call_id: id });
        openTools.set(`${coreId}:${id}`, span);
        trace.tools.push(span);
      } else {
        const span = openTools.get(`${coreId}:${id}`) || trace.tools.at(-1);
        if (span && !span.end) span.end = event.occurred_at;
        if (span) { span.state = record.isError ? 'failed' : 'returned'; span.is_error = Boolean(record.isError); }
      }
    }
    if (/^(judge|checker)\.|^judge_check_finished$/.test(event.kind || '')) {
      const label = event.kind === 'judge_check_finished' ? 'Judge check' : event.kind.startsWith('checker') ? 'Checker' : 'Judge';
      const span = makeTraceSpan('check', event, { label, state: /complete|finished/.test(event.kind) ? 'returned' : 'running', end: /complete|finished/.test(event.kind) ? event.occurred_at : null });
      trace.checks.push(span);
    }
    if (event.kind === 'workspace_revision_saved' || event.kind === 'execution_wait' || event.kind === 'execution_execution') {
      trace.markers.push(makeTraceSpan(event.kind === 'workspace_revision_saved' ? 'workspace' : 'lifecycle', event, {
        label: event.kind === 'workspace_revision_saved' ? 'Workspace saved' : event.kind === 'execution_wait' ? 'Waiting' : 'Woken',
        state: event.kind === 'execution_wait' ? 'waiting' : 'saved',
      }));
    }
    if (/error|failed|timeout|failure|stderr/i.test(event.kind || '') || event.payload && event.payload.ok === false) {
      trace.markers.push(makeTraceSpan('error', event, { label: 'Error signal', state: 'error' }));
    }
  }
  const durableExecutionIds = new Set((state.model && state.model.executions || []).map((execution) => execution.execution_id));
  for (const trace of traces.values()) {
    [...trace.turns, ...trace.tools, ...trace.checks, ...trace.markers].forEach((span) => {
      if (span.execution_id && !durableExecutionIds.has(span.execution_id)) span.execution_id = null;
    });
    trace.turns = trace.turns.filter((span) => span.start).sort((left, right) => new Date(left.start) - new Date(right.start));
    trace.tools = trace.tools.filter((span) => span.start).sort((left, right) => new Date(left.start) - new Date(right.start));
    trace.checks = trace.checks.filter((span) => span.start).sort((left, right) => new Date(left.start) - new Date(right.start));
    trace.markers = trace.markers.filter((span) => span.start).sort((left, right) => new Date(left.start) - new Date(right.start));
    trace.executions.forEach((execution) => {
      const executionStart = new Date(execution.start).getTime();
      const executionEnd = execution.end ? new Date(execution.end).getTime() : Infinity;
      const inExecution = (span) => {
        const at = new Date(span.start).getTime();
        return Number.isFinite(at) && at >= executionStart && at <= executionEnd;
      };
      execution.agent_turn_count = trace.turns.filter((span) => span.execution_id === execution.execution_id && inExecution(span)).length;
      execution.agent_session_count = trace.session_turns.filter((span) => inExecution(span)).length;
    });
    trace.agent_turn_count = trace.turns.length;
    trace.agent_session_count = trace.session_turns.length;
  }
  return [...traces.values()].sort((left, right) => String(left.core_id).localeCompare(String(right.core_id), undefined, { numeric: true }));
}

function traceSpanMarkup(span, bounds, className, label) {
  const position = positionOf(span.start, span.end, bounds);
  const executionId = span.execution_id || '';
  const selected = executionId && executionId === state.selectedExecution ? ' selected' : '';
  const details = [
    executionId ? 'Execution ' + executionId : 'Core event',
    span.task_id ? 'Task ' + shortId(span.task_id, 14) : null,
    span.session_id ? 'Session ' + shortId(span.session_id, 14) : null,
    span.agent_session_count ? span.agent_session_count + ' Agent session' + (span.agent_session_count === 1 ? '' : 's') : null,
    span.agent_turn_count ? span.agent_turn_count + ' Agent turn' + (span.agent_turn_count === 1 ? '' : 's') : null,
    span.state ? String(span.state).replaceAll('_', ' ') : null,
  ].filter(Boolean).join(' · ');
  const title = `${span.label || label || span.kind} · ${details} · ${formatTime(span.start, true)} → ${formatTime(span.end, true)}`;
  const tag = executionId ? 'button' : 'span';
  const close = executionId ? 'button' : 'span';
  const attributes = executionId ? ' data-execution-id="' + escapeHtml(executionId) + '" type="button"' : '';
  return '<' + tag + ' class="waterfall-span ' + className + selected + '" style="left:' + position.left + '%;width:' + position.width + '%" title="' + escapeHtml(title) + '" data-tooltip="' + escapeHtml(title) + '" aria-label="' + escapeHtml(title) + '"' + attributes + '>' + (executionId ? '<strong>' + escapeHtml(label || span.label || span.kind) + '</strong>' : '<i aria-hidden="true"></i>') + '</' + close + '>';
}

function renderTimeline() {
  const host = $('#timeline');
  if (!host) return;
  const traces = coreTraceData();
  if (!traces.length) { host.innerHTML = emptyState('No Core activity yet', 'Start an Experiment to see reusable Core lanes here.'); return; }
  const bounds = timelineBounds();
  const ticks = [0, 20, 40, 60, 80, 100].map((percentage) => {
    const value = bounds.min + (bounds.max - bounds.min) * percentage / 100;
    return '<span style="left:' + percentage + '%">' + escapeHtml(formatTime(value)) + '</span>';
  }).join('');
  const laneHtml = traces.map((trace) => {
    const stateSegments = trace.states.length ? trace.states.map((span) => '<span class="waterfall-state state-' + escapeHtml(normalizeState(span.state)) + '" style="left:' + positionOf(span.start, span.end, bounds).left + '%;width:' + positionOf(span.start, span.end, bounds).width + '%" title="' + escapeHtml((span.state || 'unknown') + ' · ' + (span.reason || '')) + '"></span>').join('') : '<span class="lane-event">No recorded interval</span>';
    const executionSpans = trace.executions.length ? trace.executions.map((span) => traceSpanMarkup(span, bounds, 'timeline-segment execution-span state-' + escapeHtml(normalizeState(span.state)), shortId(span.execution_id, 9))).join('') : '';
    const activitySpans = [...trace.session_turns, ...trace.turns].sort((left, right) => new Date(left.start) - new Date(right.start));
    const agentOverlaySpans = activitySpans.map((span) => traceSpanMarkup(span, bounds, span.kind === 'session' ? 'session-span agent-overlay-span state-running' : 'turn-span agent-overlay-span state-running', span.kind === 'session' ? 'Agent session' : 'Agent turn')).join('');
    const toolSpans = trace.tools.map((span) => traceSpanMarkup(span, bounds, 'tool-span state-tool', span.tool_name || 'Tool')).join('');
    const checkSpans = trace.checks.map((span) => traceSpanMarkup(span, bounds, 'check-span state-check', span.label || 'Judge')).join('');
    const markerSpans = trace.markers.map((span) => traceSpanMarkup(span, bounds, 'marker-span ' + (span.state === 'waiting' ? 'marker-waiting' : span.state === 'error' ? 'marker-error' : 'marker-workspace'), span.label)).join('');
    const activeLabel = trace.active_execution ? 'Execution ' + shortId(trace.active_execution, 11) : 'capacity available';
    const stateLabel = String(trace.last_state || 'IDLE').replaceAll('_', ' ');
    const agentSummary = trace.agent_session_count || trace.agent_turn_count ? trace.agent_session_count + ' session' + (trace.agent_session_count === 1 ? '' : 's') + ' · ' + trace.agent_turn_count + ' turn' + (trace.agent_turn_count === 1 ? '' : 's') : 'No session / turn intervals';
    return '<section class="core-trace" data-core-id="' + escapeHtml(trace.core_id) + '"><div class="core-trace-header"><div class="core-identity"><span class="core-glyph">' + escapeHtml(String(trace.core_id).replace(/^core-?/i, '')) + '</span><div><strong>' + escapeHtml(trace.core_id) + '</strong><span>' + escapeHtml(activeLabel) + '</span><small class="core-agent-summary" title="Agent session and turn intervals are shown as a fine line inside the Execution row">' + escapeHtml(agentSummary) + '</small></div></div>' + statusPill(stateLabel) + '</div><div class="core-trace-body"><div class="core-track-labels"><span>STATE</span><span>EXECUTION</span><span>TOOLS / CHECKS</span></div><div class="core-track"><div class="waterfall-row state-row">' + stateSegments + '</div><div class="waterfall-row execution-row">' + executionSpans + agentOverlaySpans + '</div><div class="waterfall-row tool-row">' + toolSpans + checkSpans + markerSpans + '</div></div></div></section>';
  }).join('');
  const activeCount = traces.filter((trace) => /running|assigned/i.test(trace.last_state)).length;
  const executionCount = traces.reduce((total, trace) => total + trace.executions.length, 0);
  const toolCount = traces.reduce((total, trace) => total + trace.tools.length, 0);
  const checkCount = traces.reduce((total, trace) => total + trace.checks.length, 0);
  const errorCount = traces.reduce((total, trace) => total + trace.markers.filter((span) => span.state === 'error').length, 0);
  host.innerHTML = '<div class="waterfall-summary"><div class="waterfall-summary-copy"><span class="eyebrow">LIVE TRACE</span><strong>' + escapeHtml(activeCount + ' of ' + traces.length + ' Cores active') + '</strong><span>Read each lane top to bottom: state, Execution, then observed tools and checks. Agent session / turn intervals are folded into the Execution row.</span></div><div class="waterfall-summary-stats"><span><strong>' + formatNumber(executionCount) + '</strong><small>executions</small></span><span><strong>' + formatNumber(toolCount) + '</strong><small>tools</small></span><span><strong>' + formatNumber(checkCount) + '</strong><small>checks</small></span><span><strong>' + formatNumber(errorCount) + '</strong><small>errors</small></span></div><div class="waterfall-summary-hint"><span class="live-pulse"></span><span>Streaming updates</span></div></div><div class="timeline-axis waterfall-axis">' + ticks + '</div><div class="core-traces">' + laneHtml + '</div><div class="timeline-legend"><span class="legend-item"><i class="legend-dot running"></i>Running</span><span class="legend-item"><i class="legend-dot waiting"></i>Waiting</span><span class="legend-item"><i class="legend-dot idle"></i>Idle</span><span class="legend-item"><i class="legend-dot tool"></i>Tool / check</span><span class="legend-item"><i class="legend-agent-line"></i>Agent session / turn</span><span class="legend-item selected-execution-note">Select a bar to open its Execution trace · hover a bar for the full name</span></div>';
  $$('.timeline-segment', host).forEach((node) => node.addEventListener('click', () => { if (node.dataset.executionId) { state.selectedExecution = node.dataset.executionId; navigate('execution/' + node.dataset.executionId); } }));
}

function signalMarkup(model) {
  const signals = [];
  if (model.errors.length) signals.push({ tone: 'danger', icon: 'alert', title: model.errors.length + ' error signals', body: 'Process, tool, timeout, or failed-state observations need attention.' });
  if (model.waits.length) signals.push({ tone: 'warning', icon: 'clock', title: model.waits.length + ' wait boundaries', body: 'Inspect wait conditions and wake-up ownership in the Execution view.' });
  const idle = (state.timeline && state.timeline.lanes || []).filter((lane) => (lane.states || []).at(-1) && lane.states.at(-1).state === 'IDLE').length;
  if (idle) signals.push({ tone: 'warning', icon: 'pulse', title: idle + ' Core lane' + (idle === 1 ? '' : 's') + ' idle', body: 'Idle capacity is visible separately from semantic WAITING.' });
  if (!signals.length) signals.push({ tone: 'good', icon: 'check', title: 'No active health signals', body: 'The current event stream has no derived errors or pending waits.' });
  return signals.slice(0, 5).map((signal) => '<div class="signal-row"><span class="signal-icon ' + (signal.tone === 'good' ? '' : signal.tone) + '">' + ICONS[signal.icon] + '</span><span class="signal-copy"><strong>' + escapeHtml(signal.title) + '</strong><span>' + escapeHtml(signal.body) + '</span></span></div>').join('');
}

function renderMetrics(model) {
  const running = model.executions.filter((item) => ['RUNNING', 'ASSIGNED'].includes(String(item.state).toUpperCase())).length;
  const waiting = model.executions.filter((item) => String(item.state).toUpperCase() === 'WAITING').length;
  const activeCores = new Set(model.executions.filter((item) => item.core_id && ['RUNNING', 'ASSIGNED'].includes(String(item.state).toUpperCase())).map((item) => item.core_id)).size;
  const runningMs = model.tasks.reduce((total, item) => total + (item.running_ms || 0), 0);
  const cards = [
    ['STATUS', state.experiment && state.experiment.status || '—', formatDate(state.experiment && state.experiment.started_at), state.experiment && state.experiment.status === 'RUNNING' ? 'accent' : ''],
    ['ACTIVE CORES', activeCores || state.experiment && state.experiment.core_ids && state.experiment.core_ids.length || 0, running + ' running Executions', 'accent'],
    ['TASKS', model.tasks.length, model.tasks.filter((item) => /running|open/i.test(item.state)).length + ' active or open', ''],
    ['EXECUTIONS', model.executions.length, waiting + ' waiting', ''],
    ['MATERIALS', model.materials.length, model.materials.filter((item) => /accepted|checked/i.test(item.evidence_state || '')).length + ' checked / accepted', ''],
    ['RUNNING TIME', formatDuration(runningMs), formatNumber(state.events.length) + ' observed events', ''],
  ];
  return cards.map((card) => '<div class="metric metric-' + card[3] + '"><span class="metric-label">' + escapeHtml(card[0]) + '</span><strong class="metric-value">' + escapeHtml(card[1]) + '</strong><span class="metric-meta">' + escapeHtml(card[2]) + '</span></div>').join('');
}

function renderTopLists(model) {
  const tasks = [...model.tasks].sort((a, b) => (b.running_ms || 0) - (a.running_ms || 0) || b.event_count - a.event_count).slice(0, 5);
  const materials = [...model.materials].sort((a, b) => (b.consumers.length - a.consumers.length) || b.event_count - a.event_count).slice(0, 5);
  const taskMax = Math.max(1, ...tasks.map((item) => item.running_ms || item.event_count || 0));
  const materialMax = Math.max(1, ...materials.map((item) => item.consumers.length || item.event_count || 0));
  const taskHost = $('#top-tasks'); const materialHost = $('#top-materials');
  if (taskHost) taskHost.innerHTML = tasks.length ? tasks.map((task, index) => '<button class="rank-row" data-route="task/' + escapeHtml(task.task_id) + '"><span class="rank-number">' + (index + 1) + '</span><span class="row-copy"><strong>' + escapeHtml(task.goal || shortId(task.task_id)) + '</strong><span>' + escapeHtml(task.task_type || 'Task') + ' · ' + escapeHtml(task.state) + '</span></span><span class="rank-bar"><span style="width:' + Math.max(6, (task.running_ms || task.event_count || 0) / taskMax * 100) + '%"></span></span><span class="rank-value">' + escapeHtml(formatDuration(task.running_ms || 0)) + '</span></button>').join('') : emptyState('No Tasks observed', 'The Task Service has not emitted a Task event for this Experiment.');
  if (materialHost) materialHost.innerHTML = materials.length ? materials.map((material, index) => '<button class="rank-row" data-route="material/' + escapeHtml(material.material_id) + '"><span class="rank-number">' + (index + 1) + '</span><span class="row-copy"><strong>' + escapeHtml(material.kind || 'Material') + '</strong><span>' + escapeHtml(shortId(material.material_id)) + ' · ' + escapeHtml(material.evidence_state || 'proposed') + '</span></span><span class="rank-bar"><span style="width:' + Math.max(6, ((material.consumers.length || material.event_count || 0) + 1) / (materialMax + 1) * 100) + '%"></span></span><span class="rank-value">' + formatNumber(material.consumers.length) + ' uses</span></button>').join('') : emptyState('No Materials observed', 'Published Materials will appear here with their provenance and consumers.');
}

function renderRecentEvents() {
  const host = $('#recent-events'); if (!host) return;
  const events = [...state.events].reverse().slice(0, 8);
  host.innerHTML = events.length ? events.map((event) => '<button class="event-row" data-route="' + (event.execution_id ? 'execution/' + escapeHtml(event.execution_id) : 'diagnostics') + '"><span class="event-source">' + escapeHtml(event.source) + '</span><span class="row-copy"><strong class="event-kind">' + escapeHtml(eventLabel(event)) + '</strong><span>' + escapeHtml(shortId(event.execution_id || event.task_id || event.core_id || 'observation')) + ' · #' + event.sequence + '</span></span><span class="event-time">' + escapeHtml(formatTime(event.occurred_at)) + '</span></button>').join('') : emptyState('No events yet', 'New Runtime and Service observations will appear here.');
}

function reportMetric(label, value, tone) {
  return '<div class="report-metric ' + (tone || '') + '"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(value == null ? '—' : String(value)) + '</strong></div>';
}

function renderReportPanel(report) {
  if (!report) return '<div class="report-loading"><span class="spinner"></span><span>Loading the benchmark report…</span></div>';
  if (!report.available) return emptyState('No analysis report attached', report.reason || 'This Experiment was recorded from live observations without a report file.');
  const summary = report.summary || {};
  const analysis = report.analysis || [];
  const status = summary.solved ? 'solved' : summary.protocol_valid === false ? 'invalid protocol' : 'observed run';
  const metricHtml = [
    reportMetric('Run', status, summary.solved ? 'good' : 'neutral'),
    reportMetric('Tasks', summary.task_count),
    reportMetric('Claims', summary.claim_count),
    reportMetric('Waits', summary.wait_count),
    reportMetric('Agent time', formatDuration(summary.agent_time_ms || 0)),
    reportMetric('Active cores', summary.max_active_core_count),
  ].join('');
  const analysisHtml = analysis.length ? analysis.map((item, index) => '<details class="report-analysis" ' + (index === 0 ? 'open' : '') + '><summary>' + escapeHtml(item.name) + '</summary><pre>' + escapeHtml(item.content) + '</pre></details>').join('') : '<p class="report-empty">The attached report has benchmark metrics but no adjacent Markdown analysis file.</p>';
  return '<div class="report-overview"><div><span class="report-source">' + escapeHtml(report.source || 'report.json') + '</span><p>' + escapeHtml(summary.problem_id || 'Benchmark report') + ' · ' + escapeHtml(summary.started_at ? formatDate(summary.started_at) : 'undated') + '</p></div><div class="report-metrics">' + metricHtml + '</div></div><div class="report-analysis-list"><div class="report-section-label">ANALYSIS REPORT</div>' + analysisHtml + '</div><details class="advanced-details report-raw"><summary>Raw report metrics</summary><pre class="payload-preview">' + escapeHtml(safeJson(report.raw || summary, 30_000)) + '</pre></details>';
}

async function loadReport() {
  if (!state.experiment || !state.experiment.metadata || !state.experiment.metadata.report_path) return;
  const experimentId = state.experiment.experiment_id;
  if (state.reportCache.has(experimentId)) return;
  try {
    const report = await get('/api/experiments/' + encodeURIComponent(experimentId) + '/report');
    state.reportCache.set(experimentId, report);
    if (location.hash === '#home') route();
  } catch (error) {
    state.reportCache.set(experimentId, { available: false, reason: error.message });
    if (location.hash === '#home') route();
  }
}

function renderHome() {
  if (!state.model) return renderNoExperiment();
  const title = state.experiment && state.experiment.metadata && state.experiment.metadata.problem_id || state.experiment && state.experiment.experiment_id || 'Experiment monitor';
  const recordedEvents = state.experiment && state.experiment.event_count || state.events.length;
  const observationLabel = recordedEvents > state.events.length
    ? formatNumber(recordedEvents) + ' recorded events · ' + formatNumber(state.events.length) + ' dashboard facts'
    : formatNumber(state.events.length) + ' ordered observations';
  $('#breadcrumbs').innerHTML = '<span class="crumb-muted">Workspace</span><span class="crumb-separator">/</span><strong>Home</strong>';
  $('#main-view').innerHTML = H(
    '<div class="page-heading"><div><span class="eyebrow">EXPERIMENT MONITOR</span><h1>', escapeHtml(title), '</h1><p>Real observation data across the selected run. The Core trace is the primary surface; each Execution bar opens its detailed trace.</p></div><div class="heading-actions">', statusPill(state.experiment && state.experiment.status), '</div></div>',
    '<section class="card timeline-card"><div class="card-header"><div><span class="eyebrow">RUNTIME TOPOLOGY</span><h2>Core activity · trace waterfall</h2><p>', escapeHtml((state.experiment && state.experiment.core_ids || []).length + ' reusable Core lanes · ' + observationLabel), '</p></div><div class="timeline-tools"><button class="range-button ' + (state.range === 'all' ? 'active' : '') + '" data-range="all">Fit run</button><button class="range-button ' + (state.range === '15m' ? 'active' : '') + '" data-range="15m">15 min</button><button class="range-button ' + (state.range === '1h' ? 'active' : '') + '" data-range="1h">1 hour</button></div></div><div class="timeline-note">Read each Core from top to bottom: state, Execution, then observed tools and checks. Click a bar to open the full Execution trace; hover a bar for its complete name and timing.</div><div class="timeline-wrap" id="timeline"></div></section>',
    '<div class="summary-strip" id="metrics"></div>',
    state.experiment && state.experiment.metadata && state.experiment.metadata.report_path ? '<section class="card report-card dashboard-lower"><div class="card-header"><div><span class="eyebrow">RUN REPORT</span><h2>Experiment analysis</h2><p>Attached benchmark metrics and any local analysis report for this run.</p></div></div><div class="card-body" id="experiment-report">' + renderReportPanel(state.reportCache.get(state.experiment.experiment_id) || null) + '</div></section>' : '',
    '<div class="content-grid three dashboard-lower"><section class="card"><div class="card-header"><div><span class="eyebrow">HEALTH</span><h2>Signals</h2><p>Derived from append-only observations.</p></div><a class="card-link" href="#diagnostics">Open diagnostics</a></div><div class="card-body"><div class="signal-list" id="signals"></div></div></section>',
    '<section class="card"><div class="card-header"><div><span class="eyebrow">TASK ACTIVITY</span><h2>Top Tasks</h2><p>Click through to the complete Task fields.</p></div><a class="card-link" href="#tasks">All tasks</a></div><div class="card-body"><div class="rank-list" id="top-tasks"></div></div></section>',
    '<section class="card"><div class="card-header"><div><span class="eyebrow">CONTEXT FLOW</span><h2>Top Materials</h2><p>Provenance and downstream consumers.</p></div><a class="card-link" href="#materials">All materials</a></div><div class="card-body"><div class="rank-list" id="top-materials"></div></div></section></div>',
    '<section class="card dashboard-lower"><div class="card-header"><div><span class="eyebrow">EVENT STREAM</span><h2>Recent activity</h2><p>Latest Runtime, Agent, Service, and Judge facts.</p></div><a class="card-link" href="#executions">Browse executions</a></div><div class="card-body"><div class="event-list" id="recent-events"></div></div></section>'
  );
  installIcons();
  $('#metrics').innerHTML = renderMetrics(state.model);
  renderTimeline();
  $('#signals').innerHTML = signalMarkup(state.model);
  $('#nav-alert').classList.toggle('alert', state.model.errors.length > 0);
  renderTopLists(state.model);
  renderRecentEvents();
  void loadReport();
  $$('.range-button').forEach((button) => button.addEventListener('click', () => { state.range = button.dataset.range; renderHome(); }));
}

function renderNoExperiment() {
  $('#breadcrumbs').innerHTML = '<span class="crumb-muted">Workspace</span><span class="crumb-separator">/</span><strong>Home</strong>';
  $('#main-view').innerHTML = '<div class="page-heading"><div><span class="eyebrow">EXPERIMENT MONITOR</span><h1>Waiting for an Experiment</h1><p>The observation daemon is online. Start a benchmark or import a report under the configured experiment root and it will appear here automatically.</p></div><div class="heading-actions"><span class="status-pill idle">NO DATA</span></div></div><section class="card"><div class="card-body">' + emptyState('No Experiments registered', 'The dashboard will automatically discover later RUNNING Experiments without a manual page refresh.') + '</div></section>';
}

function renderDetailEvents(events) {
  const filtered = (events || []).filter((event) => event.kind !== 'rpc_record' && event.kind !== 'process_stdout' && event.kind !== 'process_stderr');
  if (!filtered.length) return emptyState('No lifecycle events', 'The selected Execution has no non-tool lifecycle observations.');
  return filtered.map((event) => '<details class="raw-event"><summary><strong>' + escapeHtml(eventLabel(event)) + '</strong><span class="event-source">#' + event.sequence + '</span><span class="event-time">' + escapeHtml(formatTime(event.occurred_at)) + '</span></summary><pre>' + escapeHtml(safeJson(event.payload, 20_000)) + '</pre></details>').join('');
}

function renderToolCalls(calls) {
  if (!calls.length) return emptyState('No recorded tool calls', 'This Execution contains lifecycle observations but no Pi tool_execution records.');
  return calls.map((call, index) => {
    const started = call.start && call.start.occurred_at;
    const ended = call.end && call.end.occurred_at;
    const elapsed = started && ended ? formatDuration(new Date(ended).getTime() - new Date(started).getTime()) : 'in progress';
    const status = call.isError ? '<span class="status-pill failed">error</span>' : call.end ? '<span class="status-pill succeeded">returned</span>' : '<span class="status-pill running">running</span>';
    const kind = toolKind(call.toolName);
    const toolName = String(call.toolName || 'unknown tool');
    const argumentSummary = toolArgumentSummary(call);
    const resultSummary = toolSummary(call);
    const summaryLabel = toolName + ' · ' + argumentSummary + ' · ' + resultSummary;
    return '<details class="tool-card tool-' + kind + '"><summary class="tool-card-summary" aria-label="' + escapeHtml(summaryLabel) + '"><span class="tool-index">' + (index + 1) + '</span><span class="tool-title" title="' + escapeHtml(toolName) + '"><strong>' + escapeHtml(toolName) + '</strong><span title="' + escapeHtml(argumentSummary) + '">' + escapeHtml(argumentSummary) + '</span></span><span class="tool-summary-result" title="' + escapeHtml(resultSummary) + '">' + escapeHtml(resultSummary) + '</span><span class="tool-time">' + escapeHtml(formatTime(started, true)) + ' · ' + escapeHtml(elapsed) + '</span><span class="tool-result-status">' + status + '</span></summary><div class="tool-card-expanded"><div class="tool-result-preview"><label>Key result</label><p>' + escapeHtml(resultSummary) + '</p></div><div class="tool-card-body"><details class="tool-json-details"><summary>Full arguments</summary><pre>' + escapeHtml(safeJson(call.args)) + '</pre></details><details class="tool-json-details"><summary>Full return result</summary><pre>' + escapeHtml(safeJson(call.result)) + '</pre></details></div><details class="tool-json-details raw-tool-details"><summary>Raw tool record</summary><pre>' + escapeHtml(safeJson({ start: call.start && call.start.payload, end: call.end && call.end.payload }, 30_000)) + '</pre></details></div></details>';
  }).join('');
}

function renderExecutionInsight(insight) {
  if (!insight) return emptyState('Loading starting context…', 'Reading the recorded prompt, workspace selection, and visible tool surface.');
  const task = insight.task || {};
  const workspace = insight.workspace || {};
  const tools = insight.tool_surface || [];
  const observed = insight.observed_tools || [];
  const prompt = insight.initial_prompt || 'No initial Agent prompt was captured for this Execution.';
  const instructions = insight.task_instructions || task.task_instructions || 'No Task-specific instructions were captured.';
  const workspaceItems = [
    ['project', task.workspace && task.workspace.project],
    ['problem file', task.workspace && task.workspace.problem_file],
    ['workspace mode', workspace.workspace_selection && workspace.workspace_selection.mode],
    ['workspace revision', workspace.workspace_revision],
    ['workspace ref', workspace.workspace_ref || workspace.workspace_manifest_ref],
    ['input materials', Array.isArray(workspace.input_material_refs) ? workspace.input_material_refs.length : null],
  ].filter(([, value]) => value !== undefined && value !== null && value !== '');
  const observedNames = [...new Set(observed.map((name) => String(name || '').trim()).filter(Boolean))];
  const observedMarkup = observedNames.map((name) => '<span class="tool-chip observed-tool" title="' + escapeHtml(name) + '" aria-label="Observed tool ' + escapeHtml(name) + '">' + escapeHtml(name) + '</span>').join('');
  const catalogMarkup = tools.length
    ? '<details class="tool-catalog"><summary><span>Available catalog</span><strong>' + formatNumber(tools.length) + '</strong><span>registered names · not necessarily called</span></summary><div class="tool-chips catalog-tools">' + tools.map((tool) => { const entry = typeof tool === 'string' ? { name: tool } : tool || {}; const name = entry.name || entry.tool || 'unnamed tool'; return '<span class="tool-chip catalog-tool" title="' + escapeHtml(entry.description || name) + '" aria-label="Catalog tool ' + escapeHtml(name) + '">' + escapeHtml(name) + '</span>'; }).join('') + '</div></details>'
    : '<p class="context-empty">No catalog response was captured for this Execution.</p>';
  const bashNotice = insight.bash_observed ? '<span class="context-note good">bash/shell observed</span>' : '<span class="context-note">bash/shell not observed in this Execution</span>';
  return '<div class="execution-context-grid"><section class="context-block context-prompt"><div class="context-block-heading"><span class="eyebrow">INITIAL PROMPT</span><span class="context-note">bounded projection</span></div><p class="context-copy">' + escapeHtml(compactText(prompt, 900)) + '</p><details class="context-details"><summary>Show full prompt</summary><pre>' + escapeHtml(prompt) + '</pre></details></section><section class="context-block"><div class="context-block-heading"><span class="eyebrow">TASK INSTRUCTIONS</span></div><p class="context-copy">' + escapeHtml(compactText(instructions, 700)) + '</p><details class="context-details"><summary>Show full instructions</summary><pre>' + escapeHtml(instructions) + '</pre></details></section><section class="context-block"><div class="context-block-heading"><span class="eyebrow">INITIAL WORKSPACE</span></div><div class="context-facts">' + (workspaceItems.length ? workspaceItems.map(([key, value]) => '<div class="context-fact"><span>' + escapeHtml(key) + '</span><strong title="' + escapeHtml(typeof value === 'object' ? safeJson(value, 600) : value) + '">' + escapeHtml(typeof value === 'object' ? safeJson(value, 600) : value) + '</strong></div>').join('') : emptyState('No workspace facts', 'No workspace projection was captured for this Execution.')) + '</div><details class="context-details"><summary>Show workspace selection</summary><pre>' + escapeHtml(safeJson(workspace, 12_000)) + '</pre></details></section><section class="context-block tool-surface-block"><div class="context-block-heading"><span class="eyebrow">OBSERVED TOOL USE</span>' + bashNotice + '</div><p class="context-help">Names emitted by this Execution. Hover a chip for the complete name.</p><div class="tool-chips observed-tools">' + (observedMarkup || '<span class="context-empty">No tool names were observed.</span>') + '</div>' + catalogMarkup + '<p class="context-caption">' + observedNames.length + ' observed names · ' + tools.length + ' catalog names available</p></section></div>';
}

async function loadWorkspace(executionId) {
  const host = $('#execution-workspace'); if (!host || !state.experiment) return;
  try {
    const result = await get('/api/executions/' + encodeURIComponent(executionId) + '/workspace?experiment_id=' + encodeURIComponent(state.experiment.experiment_id));
    const workspace = result.workspace || {};
    host.innerHTML = '<div class="workspace-summary"><div class="workspace-stat"><strong>' + escapeHtml(workspace.workspace_revision || '—') + '</strong><span>revision</span></div><div class="workspace-stat"><strong>' + escapeHtml(result.files && result.files.length || 0) + '</strong><span>files</span></div><div class="workspace-stat"><strong>' + escapeHtml(shortId(workspace.content_hash, 9)) + '</strong><span>content hash</span></div></div><div class="workspace-meta" style="margin-top:12px"><span>' + escapeHtml(workspace.workspace_ref || result.execution && result.execution.workspace_ref || 'workspace reference unavailable') + '</span></div>';
  } catch (error) {
    host.innerHTML = emptyState('Workspace projection unavailable', error.message.includes('404') ? 'The standalone observer does not have a live Workspace Manager for this historical Execution.' : error.message);
  }
}

async function loadExecutionInsight(executionId) {
  if (!state.experiment || state.executionInsightCache.has(executionId)) return;
  try {
    const path = '/api/experiments/' + encodeURIComponent(state.experiment.experiment_id) + '/execution-insight?execution_id=' + encodeURIComponent(executionId);
    const insight = await get(path);
    state.executionInsightCache.set(executionId, insight);
    if (location.hash === '#execution/' + executionId) route();
  } catch (error) {
    state.executionInsightCache.set(executionId, { error: error.message, tool_surface: [], observed_tools: [] });
    if (location.hash === '#execution/' + executionId) route();
  }
}

function executionDetail(id) { return state.detailCache.get(id) || null; }

function renderExecutionPage(id) {
  const model = state.model;
  const execution = model && (model.executions.find((item) => item.execution_id === id) || model.executions[0]);
  if (!execution) return renderEmptyPage('Executions', 'No Execution facts have been observed for this Experiment yet.');
  state.selectedExecution = execution.execution_id;
  const detail = executionDetail(execution.execution_id);
  const insight = state.executionInsightCache.get(execution.execution_id) || null;
  const events = detail ? detail.events : state.events.filter((event) => event.execution_id === execution.execution_id);
  const calls = extractToolCalls(events);
  const task = model.tasks.find((item) => item.task_id === execution.task_id);
  const materials = model.materials.filter((item) => execution.material_ids.includes(item.material_id) || item.source_execution === execution.execution_id);
  $('#breadcrumbs').innerHTML = '<span class="crumb-muted">Workspace</span><span class="crumb-separator">/</span><a href="#executions">Executions</a><span class="crumb-separator">/</span><strong>' + escapeHtml(shortId(execution.execution_id)) + '</strong>';
  $('#main-view').innerHTML = H(
    '<div class="page-heading"><div><span class="eyebrow">EXECUTION INSPECTOR</span><h1>', escapeHtml(shortId(execution.execution_id, 18)), '</h1><p>Complete observed activity for one durable attempt. Tool arguments and returned results are shown below from the bounded redacted Agent projection.</p></div><div class="heading-actions"><button class="button" data-route="executions">All executions</button>', statusPill(execution.state), '</div></div>',
    '<div class="detail-grid"><div class="detail-stack"><section class="detail-hero"><div><span class="eyebrow">CURRENT STATE</span><h2>', escapeHtml(execution.state || 'UNKNOWN'), '</h2><p>', escapeHtml(task && task.goal || 'Task ' + shortId(execution.task_id)), '</p></div><div class="detail-meta"><div class="meta-item"><span>Execution</span><strong>', escapeHtml(execution.execution_id), '</strong></div><div class="meta-item"><span>Task</span><strong>', escapeHtml(shortId(execution.task_id)), '</strong></div><div class="meta-item"><span>Core / Session</span><strong>', escapeHtml(execution.core_id || '—'), ' / ', escapeHtml(shortId(execution.session_id)), '</strong></div><div class="meta-item"><span>Running time</span><strong>', escapeHtml(formatDuration(execution.running_ms)), '</strong></div></div></section>',
    '<section class="detail-metrics"><div class="detail-metric"><strong>', formatNumber(calls.length), '</strong><span>tool calls</span></div><div class="detail-metric"><strong>', formatNumber(calls.filter((call) => call.end).length), '</strong><span>returned</span></div><div class="detail-metric"><strong>', formatNumber((events || []).length), '</strong><span>observations</span></div><div class="detail-metric"><strong>', formatNumber(execution.errors || 0), '</strong><span>error signals</span></div></section>',
    '<section class="card execution-context-card"><div class="card-header"><div><span class="eyebrow">STARTING CONTEXT</span><h2>What this Agent could see</h2><p>The initial prompt, Task instructions, Workspace selection, and visible tool surface are separated from the event transcript.</p></div></div><div class="card-body">', renderExecutionInsight(insight), '</div></section>',
    '<section class="card"><div class="card-header"><div><span class="eyebrow">AGENT ACTIVITY</span><h2>Tool calls and returns</h2><p>', detail ? 'Click a row to expand full arguments, key return output, and the bounded raw record.' : 'Loading the selected Execution’s bounded event stream…', '</p>', detail && detail.truncated ? '<span class="context-note warning">History is capped at the server projection limit; returned events are complete up to the cap.</span>' : '', '</div></div><div class="card-body"><div class="tool-list" id="execution-tools">', detail ? renderToolCalls(calls) : emptyState('Loading tool activity…', 'Reading the historical event stream for this Execution.'), '</div></div></section>',
    '<section class="card"><div class="card-header"><div><span class="eyebrow">LIFECYCLE</span><h2>Other observed events</h2><p>State, Runtime, Service, Workspace, and Judge boundaries.</p></div></div><div class="card-body">', renderDetailEvents(events), '</div></section></div>',
    '<div class="detail-stack"><section class="card"><div class="card-header"><div><span class="eyebrow">WORKSPACE</span><h2>Working surface</h2></div></div><div class="card-body" id="execution-workspace">', emptyState('Loading Workspace…', 'Reading the selected Execution Workspace projection.'), '</div></section>',
    '<section class="card"><div class="card-header"><div><span class="eyebrow">CONTEXT</span><h2>Linked Materials</h2></div></div><div class="card-body">', materials.length ? '<div class="relation-list">' + materials.map((material) => relationLink('material', material.material_id, (material.kind || 'material') + ' · ' + shortId(material.material_id, 9))).join('') + '</div>' : emptyState('No linked Materials', 'This Execution has not exposed a Material reference in the current observation stream.'), '</div></section>',
    '<section class="card"><div class="card-header"><div><span class="eyebrow">TASK</span><h2>Owning responsibility</h2></div></div><div class="card-body">', task ? '<button class="rank-row" data-route="task/' + escapeHtml(task.task_id) + '"><span class="signal-icon">' + ICONS.tasks + '</span><span class="row-copy"><strong>' + escapeHtml(task.goal || shortId(task.task_id)) + '</strong><span>' + escapeHtml(task.state) + ' · ' + escapeHtml(shortId(task.task_id)) + '</span></span><span class="card-link">Open</span></button>' : emptyState('Task unavailable', 'The Task projection is not attached to this observation stream.'), '</div></section></div></div>'
  );
  installIcons();
  void loadWorkspace(execution.execution_id);
  void loadExecutionInsight(execution.execution_id);
  if (!detail) void loadExecutionDetail(execution.execution_id);
}

async function loadExecutionDetail(id) {
  if (!state.experiment || state.detailCache.has(id)) return;
  try {
    const result = await get('/api/experiments/' + encodeURIComponent(state.experiment.experiment_id) + '/execution-detail?execution_id=' + encodeURIComponent(id));
    state.detailCache.set(id, { events: result.events || [], observedEvents: result.observed_events, truncated: Boolean(result.truncated) });
    if (location.hash === '#execution/' + id) route();
  } catch (error) {
    state.detailCache.set(id, { events: [], error: error.message });
    if (location.hash === '#execution/' + id) route();
  }
}

async function loadTaskDetail(id) {
  if (!state.experiment || state.taskDetailCache.has(id)) return;
  try {
    const result = await get('/api/experiments/' + encodeURIComponent(state.experiment.experiment_id) + '/tasks/' + encodeURIComponent(id));
    const task = state.model && state.model.tasks.find((item) => item.task_id === id);
    state.taskDetailCache.set(id, { task: { ...(task || {}), ...(result.task || {}) }, events: result.events || [], observedEvents: result.observed_events });
    if (location.hash === '#task/' + id) route();
  } catch (error) {
    state.taskDetailCache.set(id, { error: error.message });
    if (location.hash === '#task/' + id) route();
  }
}

function renderExecutionList() {
  const model = state.model;
  if (!model || !model.executions.length) return renderEmptyPage('Executions', 'No Execution facts have been observed for this Experiment yet.');
  $('#breadcrumbs').innerHTML = '<span class="crumb-muted">Workspace</span><span class="crumb-separator">/</span><strong>Executions</strong>';
  const rows = model.executions.slice().sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || ''))).map((execution) => '<tr data-route="execution/' + escapeHtml(execution.execution_id) + '"><td><span class="id-cell">' + escapeHtml(shortId(execution.execution_id, 18)) + '</span><span class="table-sub">' + escapeHtml(execution.core_id || 'unassigned') + ' · ' + escapeHtml(shortId(execution.session_id)) + '</span></td><td>' + statusPill(execution.state) + '</td><td>' + escapeHtml(shortId(execution.task_id)) + '</td><td>' + formatNumber(execution.tool_calls || 0) + '</td><td>' + escapeHtml(formatDuration(execution.running_ms)) + '</td><td>' + escapeHtml(formatTime(execution.updated_at, true)) + '</td></tr>').join('');
  $('#main-view').innerHTML = '<div class="page-heading"><div><span class="eyebrow">WORKSPACE / EXECUTIONS</span><h1>Execution activity</h1><p>Every leased attempt across reusable Core lanes. Open an attempt to see every tool call, argument, return result, and lifecycle boundary.</p></div><div class="heading-actions"><span class="status-pill">' + model.executions.length + ' total</span></div></div><section class="card table-card"><div class="filter-bar"><input class="search" id="execution-filter" placeholder="Filter by Execution, Task, or Core" aria-label="Filter executions" /></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Execution</th><th>State</th><th>Task</th><th>Tools</th><th>Running time</th><th>Updated</th></tr></thead><tbody id="execution-table">' + rows + '</tbody></table></div></section>';
  $('#execution-filter') && $('#execution-filter').addEventListener('input', (event) => filterTable(event.target.value, '#execution-table'));
}

function filterTable(value, selector) {
  const query = String(value || '').toLowerCase();
  $$(selector + ' tr').forEach((row) => { row.hidden = !row.textContent.toLowerCase().includes(query); });
}

function fieldTable(fields, title) {
  const entries = Object.entries(fields || {}).filter(([key]) => !['children', 'executions', 'material_ids', 'links', 'consumers', 'fields'].includes(key));
  if (!entries.length) return emptyState('No structured fields observed', 'The event stream contains an identity but no complete entity payload.');
  return '<table class="field-table"><caption>' + escapeHtml(title || 'Observed fields') + '</caption><tbody>' + entries.map(([key, value]) => '<tr><th>' + escapeHtml(key) + '</th><td><pre class="field-value">' + escapeHtml(value && typeof value === 'object' ? safeJson(value, 18_000) : displayValue(value)) + '</pre></td></tr>').join('') + '</tbody></table>';
}

function materialContentText(detail, selected) {
  if (detail && detail.content_summary) return String(detail.content_summary);
  const content = detail && detail.content_preview || selected && (selected.content || selected.content_json);
  if (!content) return 'The Material record has no readable content summary.';
  if (typeof content === 'string') return compactText(content, 2_400);
  const primary = detailValue(content, ['summary', 'description', 'title', 'text', 'claim', 'path']);
  if (primary) return compactText(primary, 2_400);
  const readable = Object.fromEntries(Object.entries(content).filter(([key]) => !/(^|_)(?:hash|ref|id|version|timestamp|created_at|updated_at)(?:$|_)/i.test(key)));
  return safeJson(readable, 2_400);
}

function materialVisibleFields(selected, detail) {
  const fields = { ...(selected && selected.fields || {}), ...(detail && detail.fields || {}) };
  return Object.fromEntries(Object.entries(fields).filter(([key]) => !['content', 'content_json', 'content_hash', 'provenance_json', 'provenance', 'content_ref'].includes(key)));
}

function materialAdvancedFields(selected, detail) {
  return {
    ...(detail && detail.advanced || {}),
    ...(selected && selected.fields || {}),
  };
}

function renderTaskPage(id) {
  const model = state.model;
  if (!model || !model.tasks.length) return renderEmptyPage('Tasks', 'No Task facts have been observed for this Experiment yet.');
  const selected = model.tasks.find((item) => item.task_id === id) || model.tasks[0];
  const detail = state.taskDetailCache.get(selected.task_id);
  const task = detail && detail.task ? detail.task : selected;
  const executions = model.executions.filter((execution) => task.executions.includes(execution.execution_id) || execution.task_id === task.task_id);
  const materials = model.materials.filter((material) => task.material_ids.includes(material.material_id) || material.source_task === task.task_id);
  $('#breadcrumbs').innerHTML = '<span class="crumb-muted">Workspace</span><span class="crumb-separator">/</span><a href="#tasks">Tasks</a><span class="crumb-separator">/</span><strong>' + escapeHtml(shortId(task.task_id)) + '</strong>';
  $('#main-view').innerHTML = '<div class="page-heading"><div><span class="eyebrow">TASK FLOW</span><h1>' + escapeHtml(task.goal || shortId(task.task_id, 18)) + '</h1><p>Complete observed Task specification, state, child relationships, Execution history, and shared Materials.</p></div><div class="heading-actions">' + statusPill(task.state) + '<button class="button" data-route="tasks">All tasks</button></div></div><div class="detail-grid"><div class="detail-stack"><section class="card"><div class="card-header"><div><span class="eyebrow">TASK SPECIFICATION</span><h2>Every observed field</h2><p>' + (detail ? 'Values are taken from the complete Task projection.' : 'Loading the complete Task projection…') + '</p></div></div><div class="card-body">' + fieldTable(task.fields, 'Task fields') + '</div></section><section class="card"><div class="card-header"><div><span class="eyebrow">TASK TREE</span><h2>Children and parent</h2></div></div><div class="card-body"><div class="relation-list">' + (task.parent_id ? relationLink('task', task.parent_id, 'Parent · ' + shortId(task.parent_id, 10)) : '<span class="tag">Root Task</span>') + task.children.map((child) => relationLink('task', child, 'Child · ' + shortId(child, 10))).join('') + '</div></div></section></div><div class="detail-stack"><section class="card"><div class="card-header"><div><span class="eyebrow">STATE</span><h2>Scheduling facts</h2></div></div><div class="card-body"><div class="meta-item"><span>Task ID</span><strong>' + escapeHtml(task.task_id) + '</strong></div><div class="meta-item" style="margin-top:10px"><span>Running time</span><strong>' + escapeHtml(formatDuration(task.running_ms)) + '</strong></div><div class="meta-item" style="margin-top:10px"><span>Observed events</span><strong>' + escapeHtml(formatNumber(task.event_count)) + '</strong></div><div class="meta-item" style="margin-top:10px"><span>Wait / block reason</span><strong>' + escapeHtml(task.block_reason || '—') + '</strong></div></div></section><section class="card"><div class="card-header"><div><span class="eyebrow">EXECUTIONS</span><h2>Attempts</h2></div></div><div class="card-body">' + (executions.length ? '<div class="relation-list">' + executions.map((execution) => relationLink('execution', execution.execution_id, execution.state + ' · ' + shortId(execution.execution_id, 9))).join('') + '</div>' : emptyState('No attempts', 'This Task has not been claimed in the observed run.')) + '</div></section><section class="card"><div class="card-header"><div><span class="eyebrow">CONTEXT</span><h2>Materials</h2></div></div><div class="card-body">' + (materials.length ? '<div class="relation-list">' + materials.map((material) => relationLink('material', material.material_id, (material.kind || 'material') + ' · ' + shortId(material.material_id, 9))).join('') + '</div>' : emptyState('No Materials linked', 'Material provenance has not been observed for this Task.')) + '</div></section></div></div>';
  if (!detail) void loadTaskDetail(task.task_id);
}

function renderTaskList() {
  if (!state.model || !state.model.tasks.length) return renderEmptyPage('Tasks', 'No Task facts have been observed for this Experiment yet.');
  $('#breadcrumbs').innerHTML = '<span class="crumb-muted">Workspace</span><span class="crumb-separator">/</span><strong>Tasks</strong>';
  const rows = state.model.tasks.slice().sort((a, b) => (b.running_ms || 0) - (a.running_ms || 0)).map((task) => '<tr data-route="task/' + escapeHtml(task.task_id) + '"><td><span class="id-cell">' + escapeHtml(shortId(task.task_id, 18)) + '</span><span class="table-sub">' + escapeHtml(task.goal || 'No goal recorded') + '</span></td><td><span class="tag">' + escapeHtml(task.task_type || 'unknown') + '</span></td><td>' + statusPill(task.state) + '</td><td>' + task.children.length + '</td><td>' + task.executions.length + '</td><td>' + escapeHtml(formatDuration(task.running_ms)) + '</td></tr>').join('');
  $('#main-view').innerHTML = '<div class="page-heading"><div><span class="eyebrow">WORKSPACE / TASKS</span><h1>Task flow</h1><p>Browse every responsibility and open a Task to inspect its complete recorded field set.</p></div></div><section class="card table-card"><div class="filter-bar"><input class="search" id="task-filter" placeholder="Filter Task ID, type, or goal" aria-label="Filter tasks" /></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Task</th><th>Type</th><th>State</th><th>Children</th><th>Executions</th><th>Running time</th></tr></thead><tbody id="task-table">' + rows + '</tbody></table></div></section>';
  $('#task-filter') && $('#task-filter').addEventListener('input', (event) => filterTable(event.target.value, '#task-table'));
}

function renderMaterialPage(id) {
  const model = state.model;
  if (!model || !model.materials.length) return renderEmptyPage('Materials', 'No Material facts have been observed for this Experiment yet.');
  const selected = model.materials.find((item) => item.material_id === id) || model.materials[0];
  const detail = state.materialDetailCache.get(selected.material_id) || null;
  const task = model.tasks.find((item) => item.task_id === selected.source_task);
  const execution = model.executions.find((item) => item.execution_id === selected.source_execution);
  const provenance = [
    task ? relationLink('task', task.task_id, 'Task · ' + shortId(task.task_id, 9)) : '',
    execution ? relationLink('execution', execution.execution_id, 'Execution · ' + shortId(execution.execution_id, 9)) : '',
    selected.supersedes ? relationLink('material', selected.supersedes, 'Supersedes · ' + shortId(selected.supersedes, 9)) : '',
  ].join('');
  const missingProvenance = [
    selected.source_task && !task ? 'Source Task ' + shortId(selected.source_task, 10) + ' was recorded but is not in this Experiment projection.' : '',
    selected.source_execution && !execution ? 'Source Execution ' + shortId(selected.source_execution, 10) + ' was recorded but is not in this Experiment projection.' : '',
  ].filter(Boolean);
  const provenanceBody = provenance || missingProvenance.length
    ? '<div class="relation-list">' + provenance + missingProvenance.map((message) => '<span class="tag relation-missing">' + escapeHtml(message) + '</span>').join('') + '</div>'
    : emptyState('No provenance observed', 'The current Experiment contains no source Task, source Execution, or supersession link for this Material.');
  $('#breadcrumbs').innerHTML = '<span class="crumb-muted">Workspace</span><span class="crumb-separator">/</span><a href="#materials">Materials</a><span class="crumb-separator">/</span><strong>' + escapeHtml(shortId(selected.material_id)) + '</strong>';
  const content = detail ? '<div class="material-content-summary"><strong>' + escapeHtml(materialContentText(detail, selected)) + '</strong><span>' + escapeHtml(detail.available ? 'Readable content projection loaded from the local Material record.' : 'Only the bounded event projection is available.') + '</span></div><details class="advanced-details"><summary>Raw Material payload, hashes, and provenance</summary><div class="advanced-details-body">' + fieldTable(materialAdvancedFields(selected, detail), 'Advanced Material fields') + '<pre class="payload-preview">' + escapeHtml(safeJson(detail.content_preview || selected.content || selected.content_json || { material_id: selected.material_id }, 20_000)) + '</pre></div></details>' : '<div class="material-content-summary loading"><span class="spinner"></span><span>Loading the readable Material content…</span></div>';
  $('#main-view').innerHTML = '<div class="page-heading"><div><span class="eyebrow">CONTEXT / MATERIAL</span><h1>' + escapeHtml(selected.kind || 'Material') + ' <span class="muted">' + escapeHtml(shortId(selected.material_id, 16)) + '</span></h1><p>Read the useful Material content first; hashes, provenance JSON, and the raw payload stay behind an explicit disclosure.</p></div><div class="heading-actions">' + statusPill(selected.evidence_state) + '<button class="button" data-route="materials">All materials</button></div></div><div class="detail-grid"><div class="detail-stack"><section class="card material-content-card"><div class="card-header"><div><span class="eyebrow">MATERIAL CONTENT</span><h2>What was published</h2><p>Redacted browser projection with a readable content summary.</p></div></div><div class="card-body">' + content + '</div></section><section class="card"><div class="card-header"><div><span class="eyebrow">MATERIAL FIELDS</span><h2>Identity and semantics</h2><p>Stable fields remain visible; technical payload fields are folded below.</p></div></div><div class="card-body">' + fieldTable(materialVisibleFields(selected, detail), 'Material fields') + '</div></section><section class="card"><div class="card-header"><div><span class="eyebrow">PROVENANCE</span><h2>Source and lineage</h2></div></div><div class="card-body">' + provenanceBody + '</div></section><section class="card"><div class="card-header"><div><span class="eyebrow">DOWNSTREAM USE</span><h2>Observed consumers</h2><p>Read and action links captured in the event stream.</p></div></div><div class="card-body">' + (selected.consumers.length ? '<div class="relation-list">' + selected.consumers.map((consumer) => relationLink('execution', consumer, 'Execution · ' + shortId(consumer, 10))).join('') + '</div>' : emptyState('No explicit consumers', 'This Material has provenance, but no downstream read or action has been observed yet.')) + '</div></section></div><section class="card"><div class="card-header"><div><span class="eyebrow">TECHNICAL PREVIEW</span><h2>Payload inspection</h2><p>Raw Material content is available behind the disclosure above when the local record contains it.</p></div></div><div class="card-body"><details class="advanced-details"><summary>Open technical payload</summary><pre class="payload-preview">' + escapeHtml(safeJson(materialAdvancedFields(selected, detail), 20_000)) + '</pre></details></div></section></div>';
  if (!detail) void loadMaterialDetail(selected.material_id);
}

async function loadMaterialDetail(materialId) {
  if (!state.experiment || state.materialDetailCache.has(materialId)) return;
  try {
    const detail = await get('/api/experiments/' + encodeURIComponent(state.experiment.experiment_id) + '/materials/' + encodeURIComponent(materialId));
    state.materialDetailCache.set(materialId, detail);
    if (location.hash === '#material/' + materialId) route();
  } catch (error) {
    state.materialDetailCache.set(materialId, { available: false, error: error.message });
    if (location.hash === '#material/' + materialId) route();
  }
}

function renderMaterialList() {
  if (!state.model || !state.model.materials.length) return renderEmptyPage('Materials', 'No Material facts have been observed for this Experiment yet.');
  $('#breadcrumbs').innerHTML = '<span class="crumb-muted">Workspace</span><span class="crumb-separator">/</span><strong>Materials</strong>';
  const rows = state.model.materials.slice().sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))).map((material) => '<tr data-route="material/' + escapeHtml(material.material_id) + '"><td><span class="id-cell">' + escapeHtml(shortId(material.material_id, 18)) + '</span><span class="table-sub">' + escapeHtml(material.scope || 'unscoped') + '</span></td><td><span class="tag">' + escapeHtml(material.kind || 'unknown') + '</span></td><td>' + statusPill(material.evidence_state) + '</td><td>' + escapeHtml(shortId(material.source_task)) + '</td><td>' + material.consumers.length + '</td><td>' + escapeHtml(formatTime(material.created_at, true)) + '</td></tr>').join('');
  $('#main-view').innerHTML = '<div class="page-heading"><div><span class="eyebrow">WORKSPACE / MATERIALS</span><h1>Context flow</h1><p>Trace shared work from producer to downstream consumer, then open a Material to inspect every recorded field.</p></div></div><section class="card table-card"><div class="filter-bar"><input class="search" id="material-filter" placeholder="Filter material, kind, or source" aria-label="Filter materials" /></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Material</th><th>Kind</th><th>Evidence</th><th>Source Task</th><th>Consumers</th><th>Created</th></tr></thead><tbody id="material-table">' + rows + '</tbody></table></div></section>';
  $('#material-filter') && $('#material-filter').addEventListener('input', (event) => filterTable(event.target.value, '#material-table'));
}

function renderDiagnostics() {
  if (!state.model) return renderEmptyPage('Diagnostics', 'Select an Experiment to inspect health.');
  const model = state.model;
  const errorRows = model.errors.slice(-30).reverse();
  $('#breadcrumbs').innerHTML = '<span class="crumb-muted">Operations</span><span class="crumb-separator">/</span><strong>Diagnostics</strong>';
  const rows = errorRows.length ? errorRows.map((event) => '<button class="event-row" data-route="' + (event.execution_id ? 'execution/' + escapeHtml(event.execution_id) : 'diagnostics') + '"><span class="signal-icon danger">' + ICONS.alert + '</span><span class="row-copy"><strong>' + escapeHtml(eventLabel(event)) + '</strong><span>' + escapeHtml(shortId(event.execution_id || event.task_id || event.core_id)) + ' · #' + event.sequence + '</span></span><span class="event-time">' + escapeHtml(formatTime(event.occurred_at)) + '</span></button>').join('') : emptyState('No error evidence', 'No process, tool, timeout, or failed-state events are present.');
  const waits = model.waits.slice(-30).reverse().map((event) => '<button class="event-row" data-route="' + (event.execution_id ? 'execution/' + escapeHtml(event.execution_id) : 'diagnostics') + '"><span class="signal-icon warning">' + ICONS.clock + '</span><span class="row-copy"><strong>' + escapeHtml(conditionLabel(event.payload && (event.payload.wait_condition || event.payload.wait_reason)) || eventLabel(event)) + '</strong><span>' + escapeHtml(shortId(event.execution_id || event.task_id || event.core_id)) + ' · #' + event.sequence + '</span></span><span class="event-time">' + escapeHtml(formatTime(event.occurred_at)) + '</span></button>');
  $('#main-view').innerHTML = '<div class="page-heading"><div><span class="eyebrow">OPERATIONS / DIAGNOSTICS</span><h1>System health</h1><p>Evidence-linked signals for scheduling, Services, and context delivery. Open an event to jump into its owning Execution.</p></div><div class="heading-actions"><span class="status-pill ' + (model.errors.length ? 'failed' : 'succeeded') + '">' + (model.errors.length ? model.errors.length + ' signals' : 'healthy') + '</span></div></div><section class="diagnostics-surface"><header class="diagnostics-header"><div><span class="eyebrow">SIGNAL BOARD</span><h2>What needs attention</h2></div><span class="diagnostics-header-note">ordered observations · latest first</span></header><div class="diagnostics-grid"><section class="diagnostics-pane diagnostics-signals"><div class="diagnostics-pane-heading"><span class="eyebrow">HEALTH SIGNALS</span><strong>Current projection</strong></div><div class="signal-list">' + signalMarkup(model) + '</div></section><section class="diagnostics-pane"><div class="diagnostics-pane-heading"><span class="eyebrow">ERROR EVIDENCE</span><strong>Recent error events</strong></div><div class="event-list">' + rows + '</div></section><section class="diagnostics-pane"><div class="diagnostics-pane-heading"><span class="eyebrow">WAIT EVIDENCE</span><strong>Observed wait boundaries</strong></div><div class="event-list">' + (waits.length ? waits.join('') : emptyState('No wait boundaries', 'No semantic WAITING condition was observed.')) + '</div></section><section class="diagnostics-pane diagnostics-integrity"><div class="diagnostics-pane-heading"><span class="eyebrow">OBSERVATION INTEGRITY</span><strong>Data plane facts</strong></div><div class="diagnostic-facts"><span><strong>' + formatNumber(state.events.length) + '</strong><small>events</small></span><span><strong>' + formatNumber(model.waits.length) + '</strong><small>wait boundaries</small></span><span><strong>' + formatNumber(model.taskLinks.length) + '</strong><small>Task links</small></span></div></section></div></section>';
}

async function renderServices() {
  $('#breadcrumbs').innerHTML = '<span class="crumb-muted">Operations</span><span class="crumb-separator">/</span><strong>Services</strong>';
  let catalog = [];
  try { catalog = (await get('/api/services')).services || []; } catch { /* imported reports may not expose the catalog */ }
  const observed = new Map((state.model && state.model.services || []).map((service) => [service.name, service]));
  const rows = catalog.map((service) => {
    const activity = observed.get(service.name) || { calls: 0, errors: 0 };
    return '<div class="service-row"><span class="signal-icon">' + ICONS.server + '</span><span class="row-copy"><strong>' + escapeHtml(service.name || service.service || 'Service') + '</strong><span>' + escapeHtml(service.description || 'Registered SwarmEnv capability group') + '</span></span><span class="rank-value">' + activity.calls + ' events · ' + activity.errors + ' errors</span></div>';
  }).join('');
  $('#main-view').innerHTML = '<div class="page-heading"><div><span class="eyebrow">OPERATIONS / SERVICES</span><h1>Service activity</h1><p>Capability groups behind Task, Execution, Context, Workspace, Judge, and observation flows.</p></div></div><section class="card"><div class="card-header"><div><span class="eyebrow">SERVICE CATALOG</span><h2>Registered capabilities</h2></div></div><div class="card-body"><div class="service-list">' + (rows || emptyState('Catalog unavailable', 'The current observation server did not expose a Service Catalog.')) + '</div></div></section>';
}

function renderEmptyPage(title, description) {
  $('#breadcrumbs').innerHTML = '<span class="crumb-muted">Workspace</span><span class="crumb-separator">/</span><strong>' + escapeHtml(title) + '</strong>';
  $('#main-view').innerHTML = '<div class="page-heading"><div><span class="eyebrow">SWARMENV OBSERVABILITY</span><h1>' + escapeHtml(title) + '</h1><p>' + escapeHtml(description) + '</p></div></div><section class="card"><div class="card-body">' + emptyState(title === 'Executions' ? 'No Executions yet' : 'No ' + title + ' data', description) + '</div></section>';
}

function route() {
  const parts = location.hash.replace(/^#/, '').split('/').filter(Boolean);
  const view = parts[0] || 'home';
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.route === view || view === 'execution' && item.dataset.route === 'executions' || view === 'task' && item.dataset.route === 'tasks' || view === 'material' && item.dataset.route === 'materials'));
  if (!state.experiment && view !== 'home') return renderNoExperiment();
  if (view === 'home') renderHome();
  else if (view === 'executions') renderExecutionList();
  else if (view === 'execution') renderExecutionPage(parts[1]);
  else if (view === 'tasks') renderTaskList();
  else if (view === 'task') renderTaskPage(parts[1]);
  else if (view === 'materials') renderMaterialList();
  else if (view === 'material') renderMaterialPage(parts[1]);
  else if (view === 'diagnostics') renderDiagnostics();
  else if (view === 'services') void renderServices();
  else renderHome();
}

function navigate(path) { if (location.hash === '#' + path) route(); else location.hash = path; }
function setConnection(label, tone) { $('#connection').textContent = label; $('#connection-dot').className = 'connection-dot ' + (tone || ''); }

function applyTheme(theme, persist) {
  const nextTheme = theme === 'black' ? 'black' : 'light';
  if (document.documentElement) document.documentElement.dataset.theme = nextTheme;
  const selector = $('#theme-select');
  if (selector) selector.value = nextTheme;
  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.content = nextTheme === 'black' ? '#111113' : '#f7f7f8';
  if (persist && typeof localStorage !== 'undefined') {
    try { localStorage.setItem('swarmenv-theme', nextTheme); } catch { /* private browsing can disable storage */ }
  }
}

function connectStream(id) {
  if (state.source) state.source.close();
  state.source = new EventSource('/api/experiments/' + encodeURIComponent(id) + '/stream?after_sequence=' + (state.events.at(-1) && state.events.at(-1).sequence || 0) + '&view=agent&overview=1');
  state.source.onopen = () => setConnection('Live', 'live');
  state.source.onerror = () => setConnection('Reconnecting…', 'error');
  state.source.addEventListener('observation', (message) => {
    const event = JSON.parse(message.data);
    if (!state.events.some((candidate) => candidate.event_id === event.event_id)) state.events.push(event);
    state.experiment.event_count = Math.max(state.experiment.event_count || 0, event.sequence || 0);
    state.model = buildModel();
    state.lastUpdated = new Date();
    updateNav();
    renderCurrent();
    if (['core_state_changed', 'execution_assigned', 'execution_released'].includes(event.kind)) scheduleTimelineRefresh(id);
  });
}

function applyExperimentRegistry(experiments, revision) {
  if (revision) state.registryRevision = revision;
  state.experiments = Array.isArray(experiments) ? experiments : [];
  updateExperimentOptions(state.experiments);
  const current = state.experiments.find((experiment) => state.experiment && experiment.experiment_id === state.experiment.experiment_id);
  const running = state.experiments.find((experiment) => experiment.status === 'RUNNING');
  if (!state.experiment) {
    const target = running?.experiment_id || state.experiments[0]?.experiment_id;
    if (target) void selectExperiment(target);
    else { setConnection('Waiting for data'); updateExperimentMeta(); renderNoExperiment(); }
    return;
  }
  if (!current) {
    const target = running?.experiment_id || state.experiments[0]?.experiment_id;
    if (target) void selectExperiment(target);
    else { state.experiment = null; updateExperimentMeta(); renderNoExperiment(); }
    return;
  }
  state.experiment = Object.assign({}, state.experiment, current);
  updateExperimentMeta();
  renderCurrent();
}

function connectExperimentRegistry() {
  if (state.registrySource) state.registrySource.close();
  const source = new EventSource('/api/experiments/stream');
  state.registrySource = source;
  let received = false;
  const fallbackTimer = setTimeout(() => {
    if (!received && state.registrySource === source) {
      source.close();
      state.registrySource = null;
      startRegistryLongPoll();
    }
  }, 8_000);
  source.addEventListener('experiments', (message) => {
    received = true;
    clearTimeout(fallbackTimer);
    try {
      const payload = JSON.parse(message.data);
      applyExperimentRegistry(payload.experiments, payload.revision);
    } catch { /* A malformed registry event is ignored until the next update. */ }
  });
  source.onerror = () => {
    if (!received && state.registrySource === source) {
      clearTimeout(fallbackTimer);
      source.close();
      state.registrySource = null;
      startRegistryLongPoll();
    } else if (!state.experiment) setConnection('Reconnecting…', 'error');
  };
}

function startRegistryLongPoll() {
  if (state.registryLongPoll) return;
  state.registryLongPoll = true;
  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const loop = async () => {
    while (state.registryLongPoll) {
      try {
        const response = await get('/api/experiments/changes?since=' + encodeURIComponent(state.registryRevision || ''));
        applyExperimentRegistry(response.experiments, response.revision);
      } catch {
        if (!state.experiment) setConnection('Reconnecting…', 'error');
        await wait(2_000);
      }
    }
  };
  void loop();
}

function scheduleTimelineRefresh(id) {
  if (state.timelineTimer) clearTimeout(state.timelineTimer);
  state.timelineTimer = setTimeout(() => { void refreshTimeline(id); }, 80);
}

async function refreshTimeline(id) {
  const request = ++state.timelineRequest;
  try {
    const timeline = await get('/api/experiments/' + encodeURIComponent(id) + '/timeline?limit=1000&view=agent');
    if (request !== state.timelineRequest || state.experiment && state.experiment.experiment_id !== id) return;
    state.timeline = timeline;
    state.model = buildModel();
    renderCurrent();
  } catch { /* A later event or manual refresh retries the timeline query. */ }
}

function renderCurrent(force) {
  const view = location.hash.replace(/^#/, '') || 'home';
  if (force) route();
  else if (view === 'home') {
    if (!updateHomeProjection()) route();
  }
  $('#last-refresh').textContent = state.lastUpdated ? 'updated ' + formatTime(state.lastUpdated) : '—';
}

function updateNav() {
  const model = state.model || { tasks: [], executions: [], materials: [] };
  $('#nav-tasks').textContent = model.tasks.length;
  $('#nav-executions').textContent = model.executions.length;
  $('#nav-materials').textContent = model.materials.length;
}

function updateExperimentMeta() {
  const host = $('#experiment-meta');
  if (!host) return;
  const experiment = state.experiment;
  if (!experiment) { host.textContent = state.experiments.length + ' experiments registered'; return; }
  const problem = experiment.metadata && experiment.metadata.problem_id;
  host.textContent = (problem ? problem + ' · ' : '') + formatDate(experiment.started_at) + ' · ' + formatNumber(experiment.event_count || 0) + ' events';
}

function updateHomeProjection() {
  const mainView = $('#main-view');
  if (!state.model || !mainView || !mainView.innerHTML.includes('id="timeline"') || (location.hash.replace(/^#/, '') || 'home') !== 'home') return false;
  const metrics = $('#metrics');
  if (metrics) metrics.innerHTML = renderMetrics(state.model);
  renderTimeline();
  const signals = $('#signals');
  if (signals) signals.innerHTML = signalMarkup(state.model);
  const alert = $('#nav-alert');
  if (alert) alert.classList.toggle('alert', state.model.errors.length > 0);
  renderTopLists(state.model);
  renderRecentEvents();
  return true;
}

async function selectExperiment(id) {
  if (!id) return;
  setConnection('Loading…');
  try {
    const [experiment, overview] = await Promise.all([
      get('/api/experiments/' + encodeURIComponent(id)),
      get('/api/experiments/' + encodeURIComponent(id) + '/overview?view=agent'),
    ]);
    state.experiment = experiment;
    state.events = overview.events || [];
    state.timeline = overview.timeline || { lanes: [] };
    state.toolCounts = overview.tool_counts || {};
    state.model = buildModel();
    state.detailCache = new Map();
    state.taskDetailCache = new Map();
    state.executionInsightCache = new Map();
    state.materialDetailCache = new Map();
    state.reportCache = new Map();
    state.selectedExecution = null;
    state.lastUpdated = new Date();
    updateNav();
    updateExperimentMeta();
    connectStream(id);
    setConnection('Live', 'live');
    renderCurrent(true);
  } catch (error) {
    setConnection('Unavailable', 'error');
    $('#main-view').innerHTML = '<section class="card"><div class="card-body">' + emptyState('Observation server unavailable', error.message) + '</div></section>';
  }
}

function updateExperimentOptions(experiments) {
  const select = $('#experiments');
  const current = state.experiment && state.experiment.experiment_id || select.value;
  select.innerHTML = experiments.length ? experiments.map((experiment) => {
    const problem = experiment.metadata && experiment.metadata.problem_id || shortId(experiment.experiment_id, 12);
    const label = problem + ' · ' + formatDate(experiment.started_at) + ' · ' + experiment.status + ' · ' + formatNumber(experiment.event_count || 0) + ' events';
    return '<option value="' + escapeHtml(experiment.experiment_id) + '">' + escapeHtml(label) + '</option>';
  }).join('') : '<option value="">No experiments</option>';
  if (current && experiments.some((experiment) => experiment.experiment_id === current)) select.value = current;
}

async function refreshExperiments(initial) {
  if (state.refreshInFlight) return;
  state.refreshInFlight = true;
  try {
    const response = await get('/api/experiments?limit=100');
    if (initial) {
      state.experiment = null;
      applyExperimentRegistry(response.experiments || [], response.revision);
    } else {
      applyExperimentRegistry(response.experiments || [], response.revision);
    }
  } catch (error) {
    setConnection('Unavailable', 'error');
    if (!state.experiment) $('#main-view').innerHTML = '<section class="card"><div class="card-body">' + emptyState('Cannot reach observer', error.message) + '</div></section>';
  } finally { state.refreshInFlight = false; }
}

function bindInteractions() {
  applyTheme(document.documentElement && document.documentElement.dataset.theme, false);
  $('#experiments').addEventListener('change', (event) => { void selectExperiment(event.target.value); });
  $('#theme-select').addEventListener('change', (event) => applyTheme(event.target.value, true));
  $('#refresh').addEventListener('click', () => { void refreshExperiments(!state.experiment); if (state.experiment) void selectExperiment(state.experiment.experiment_id); });
  $('#mobile-menu').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-route]');
    if (target && target.tagName !== 'A') { event.preventDefault(); navigate(target.dataset.route); $('#sidebar').classList.remove('open'); }
    if (target && target.tagName === 'A') $('#sidebar').classList.remove('open');
  });
  window.addEventListener('hashchange', () => route());
}

async function main() {
  installIcons();
  bindInteractions();
  await refreshExperiments(true);
  connectExperimentRegistry();
}

main().catch((error) => { setConnection('Error', 'error'); $('#main-view').innerHTML = '<section class="card"><div class="card-body">' + emptyState('Dashboard failed to load', error.message) + '</div></section>'; });

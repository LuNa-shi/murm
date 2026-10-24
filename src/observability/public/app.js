
const state = {
  experiment: null, experiments: [], events: [], timeline: null, model: null,
  source: null, selectedExecution: null, selectedTask: null, selectedMaterial: null,
  refreshInFlight: false, lastUpdated: null,
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

function installIcons() { $$('[data-icon]').forEach((node) => { node.innerHTML = ICONS[node.dataset.icon] || ''; }); }
function escapeHtml(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character])); }
function shortId(value, length) { const text = String(value || ''); const size = length || 12; return text.length > size ? text.slice(0, size) + '…' : text || '—'; }
function formatTime(value, withDate) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString([], withDate ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit', second: '2-digit' });
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
function statusPill(status) { return '<span class="status-pill ' + escapeHtml(normalizeState(status)) + '">' + escapeHtml(status || 'UNKNOWN') + '</span>'; }
function emptyState(title, description) { return '<div class="empty"><strong>' + escapeHtml(title) + '</strong><p>' + escapeHtml(description) + '</p></div>'; }
function relationLink(type, id, label) { return '<button class="relation-link" data-route="' + escapeHtml(type) + '/' + escapeHtml(id) + '">' + escapeHtml(label || shortId(id)) + '</button>'; }

async function get(path) {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(response.status + ' ' + response.statusText);
  return response.json();
}

async function getAllPages(path) {
  const events = [];
  let cursor = 0;
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const page = await get(path + separator + 'after_sequence=' + cursor);
    events.push(...(page.events || []));
    if (!page.has_more || page.next_cursor == null) return { events: events, truncated: false };
    if (page.next_cursor <= cursor) throw new Error('event cursor did not advance');
    cursor = page.next_cursor;
  }
  return { events: events, truncated: true };
}

function readNested(value, keys, depth) {
  const level = depth || 0;
  if (!value || typeof value !== 'object' || level > 4) return null;
  for (const key of keys) if (value[key] !== undefined && value[key] !== null) return value[key];
  for (const child of Object.values(value)) {
    const found = readNested(child, keys, level + 1);
    if (found !== null) return found;
  }
  return null;
}

function materialCandidates(value, depth) {
  const level = depth || 0;
  if (!value || typeof value !== 'object' || level > 4) return [];
  const result = [];
  if (typeof value.material_id === 'string') result.push(value);
  if (Array.isArray(value)) value.forEach((child) => result.push(...materialCandidates(child, level + 1)));
  else Object.values(value).forEach((child) => result.push(...materialCandidates(child, level + 1)));
  return result;
}

function mergeDefined(target, source) {
  if (!source || typeof source !== 'object') return target;
  Object.entries(source).forEach(([key, value]) => { if (value !== undefined && value !== null && value !== '') target[key] = value; });
  return target;
}

function buildModel() {
  const tasks = new Map();
  const executions = new Map();
  const materials = new Map();
  const taskLinks = new Map();
  function ensureTask(id, patch) {
    if (!id) return null;
    const task = tasks.get(id) || { task_id: id, state: 'UNKNOWN', children: new Set(), executions: new Set(), material_ids: new Set(), event_count: 0, running_ms: 0, errors: 0 };
    mergeDefined(task, patch || {});
    tasks.set(id, task);
    return task;
  }
  function ensureExecution(id, patch) {
    if (!id) return null;
    const execution = executions.get(id) || { execution_id: id, state: 'UNKNOWN', task_id: null, material_ids: [], event_count: 0, running_ms: 0 };
    mergeDefined(execution, patch || {});
    executions.set(id, execution);
    return execution;
  }
  function ensureMaterial(material) {
    if (!material || !material.material_id) return null;
    const existing = materials.get(material.material_id) || { material_id: material.material_id, links: new Set(), consumers: new Set(), event_count: 0 };
    mergeDefined(existing, material);
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
      if (event.kind.includes('read') || event.kind.includes('consume') || event.kind.includes('dispatch')) material.consumers.add(event.execution_id);
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
    const task = ensureTask(taskId, taskPayload || {});
    const execution = ensureExecution(executionId, executionPayload || {});
    if (task) {
      task.event_count += 1;
      task.updated_at = event.occurred_at;
      if (executionId) task.executions.add(executionId);
      if (event.kind === 'task_state_changed' || payload.task_state || ['OPEN', 'RUNNING', 'WAITING', 'SUCCEEDED', 'FAILED'].includes(payload.state)) task.state = payload.task_state || payload.state || task.state;
      if (payload.block_reason || payload.wait_condition || payload.wait_reason) task.block_reason = payload.block_reason || payload.wait_reason || payload.wait_condition.type;
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
      if (event.kind === 'execution_released' || event.kind === 'core_state_changed' || payload.state) execution.state = payload.state || execution.state;
      if (/error|failed|timeout/i.test(event.kind)) execution.errors = (execution.errors || 0) + 1;
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
      if (!value || typeof value !== 'object' || level > 4) return;
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
  (state.timeline && state.timeline.lanes || []).forEach((lane) => (lane.states || []).forEach((segment) => {
    const execution = ensureExecution(segment.execution_id, { task_id: segment.task_id, core_id: lane.core_id, state: segment.state });
    const duration = segment.ended_at ? new Date(segment.ended_at).getTime() - new Date(segment.started_at).getTime() : 0;
    if (execution) execution.running_ms += Math.max(0, duration);
    if (segment.task_id) ensureTask(segment.task_id).running_ms += Math.max(0, duration);
  }));
  executions.forEach((execution) => { if (execution.task_id) ensureTask(execution.task_id).executions.add(execution.execution_id); });
  const errors = state.events.filter((event) => /error|failed|timeout|stale|fenced/i.test((event.kind || '') + ' ' + (event.payload && event.payload.state || '')));
  const waits = state.events.filter((event) => /wait/i.test(event.kind || '') || event.payload && event.payload.state === 'WAITING');
  const services = new Map();
  state.events.forEach((event) => {
    const service = event.payload && event.payload.service || (event.source === 'service' ? 'service' : null);
    if (!service && !/dispatch|service|judge|route/i.test(event.kind || '')) return;
    const name = service || (event.source === 'judge' ? 'judge' : event.source || 'runtime');
    const item = services.get(name) || { name: name, calls: 0, errors: 0 };
    item.calls += 1; item.last_at = event.occurred_at;
    if (/error|failed/i.test(event.kind || '')) item.errors += 1;
    services.set(name, item);
  });
  return {
    tasks: [...tasks.values()].map((item) => ({ ...item, children: [...item.children], executions: [...item.executions], material_ids: [...item.material_ids] })),
    executions: [...executions.values()].map((item) => ({ ...item, material_ids: [...new Set(item.material_ids)] })),
    materials: [...materials.values()].map((item) => ({ ...item, links: [...item.links], consumers: [...item.consumers] })),
    taskLinks: [...taskLinks.values()], services: [...services.values()], errors: errors, waits: waits,
  };
}

function timelineBounds() {
  const dates = state.events.map((event) => new Date(event.occurred_at).getTime()).filter(Number.isFinite);
  (state.timeline && state.timeline.lanes || []).forEach((lane) => (lane.states || []).forEach((segment) => {
    dates.push(new Date(segment.started_at).getTime());
    if (segment.ended_at) dates.push(new Date(segment.ended_at).getTime());
  }));
  const min = Math.min(...dates); const max = Math.max(...dates);
  return Number.isFinite(min) ? { min: min, max: Math.max(max, min + 60000) } : { min: Date.now() - 3600000, max: Date.now() };
}

function positionOf(start, end, bounds) {
  const span = Math.max(1, bounds.max - bounds.min);
  const left = Math.max(0, Math.min(100, (new Date(start).getTime() - bounds.min) / span * 100));
  const right = end ? Math.max(left + .7, Math.min(100, (new Date(end).getTime() - bounds.min) / span * 100)) : 100;
  return { left: left, width: Math.max(.7, right - left) };
}

function renderTimeline() {
  const host = $('#timeline');
  if (!host) return;
  const lanes = state.timeline && state.timeline.lanes || [];
  if (!lanes.length) { host.innerHTML = emptyState('No Core activity yet', 'Start an Experiment to see reusable Core lanes here.'); return; }
  const bounds = timelineBounds();
  const ticks = [0, 25, 50, 75, 100].map((percentage) => {
    const value = bounds.min + (bounds.max - bounds.min) * percentage / 100;
    return '<span style="left:' + percentage + '%">' + escapeHtml(formatTime(value)) + '</span>';
  }).join('');
  const laneHtml = lanes.map((lane) => {
    const segments = lane.states && lane.states.length ? lane.states : lane.segments || [];
    const content = segments.length ? segments.map((segment) => {
      const position = positionOf(segment.started_at, segment.ended_at, bounds);
      const stateName = normalizeState(segment.state);
      const executionId = segment.execution_id || '';
      return '<button class="timeline-segment state-' + escapeHtml(stateName) + '" style="left:' + position.left + '%;width:' + position.width + '%" data-execution-id="' + escapeHtml(executionId) + '" title="' + escapeHtml((segment.state || 'unknown') + ' · ' + (executionId || 'idle')) + '"><strong>' + escapeHtml(executionId ? shortId(executionId, 9) : stateName) + '</strong><small>' + escapeHtml(segment.state || '') + '</small></button>';
    }).join('') : '<span class="lane-event">No recorded interval</span>';
    return '<div class="lane"><div class="lane-label">' + escapeHtml(lane.core_id) + '</div><div class="lane-track">' + content + '</div></div>';
  }).join('');
  host.innerHTML = '<div class="timeline-axis">' + ticks + '</div><div class="lanes">' + laneHtml + '</div><div class="timeline-legend"><span class="legend-item"><i class="legend-dot running"></i>Running</span><span class="legend-item"><i class="legend-dot waiting"></i>Waiting</span><span class="legend-item"><i class="legend-dot idle"></i>Idle</span><span class="legend-item"><i class="legend-dot error"></i>Error</span><span class="legend-item muted">Click any interval to inspect the Execution</span></div>';
  $$('.timeline-segment', host).forEach((node) => node.addEventListener('click', () => { if (node.dataset.executionId) navigate('execution/' + node.dataset.executionId); }));
}

function signalMarkup(model) {
  const signals = [];
  if (model.errors.length) signals.push({ tone: 'danger', icon: 'alert', title: model.errors.length + ' error signals', body: 'Process, tool, timeout, or failed-state observations need attention.' });
  if (model.waits.length) signals.push({ tone: 'warning', icon: 'clock', title: model.waits.length + ' wait boundaries', body: 'Inspect wait conditions and wake-up ownership in the Execution view.' });
  const idle = (state.timeline && state.timeline.lanes || []).filter((lane) => (lane.states || []).at(-1) && lane.states.at(-1).state === 'IDLE').length;
  if (idle) signals.push({ tone: 'warning', icon: 'pulse', title: idle + ' Core lane' + (idle === 1 ? '' : 's') + ' idle', body: 'Idle capacity is visible separately from semantic WAITING.' });
  if (!signals.length) signals.push({ tone: 'good', icon: 'check', title: 'No active health signals', body: 'The current event stream has no derived errors or pending waits.' });
  return signals.slice(0, 4).map((signal) => '<div class="signal-row"><span class="signal-icon ' + (signal.tone === 'good' ? '' : signal.tone) + '">' + ICONS[signal.icon] + '</span><span class="signal-copy"><strong>' + escapeHtml(signal.title) + '</strong><span>' + escapeHtml(signal.body) + '</span></span></div>').join('');
}

function renderMetrics(model) {
  const running = model.executions.filter((item) => ['RUNNING', 'ASSIGNED'].includes(String(item.state).toUpperCase())).length;
  const waiting = model.executions.filter((item) => String(item.state).toUpperCase() === 'WAITING').length;
  const activeCores = new Set(model.executions.filter((item) => running > 0 && item.core_id && ['RUNNING', 'ASSIGNED'].includes(String(item.state).toUpperCase())).map((item) => item.core_id)).size;
  const runningMs = model.tasks.reduce((total, item) => total + (item.running_ms || 0), 0);
  const cards = [
    ['RUN STATUS', state.experiment && state.experiment.status || '—', 'started ' + formatTime(state.experiment && state.experiment.started_at, true), state.experiment && state.experiment.status === 'RUNNING' ? 'accent' : ''],
    ['ACTIVE CORES', activeCores || state.experiment && state.experiment.core_ids && state.experiment.core_ids.length || 0, running + ' running Executions', 'accent'],
    ['TASKS', model.tasks.length, model.tasks.filter((item) => /running|open/i.test(item.state)).length + ' active or open', ''],
    ['EXECUTIONS', model.executions.length, waiting + ' waiting', ''],
    ['MATERIALS', model.materials.length, model.materials.filter((item) => item.evidence_state === 'accepted' || item.evidence_state === 'checked').length + ' checked / accepted', ''],
    ['RUNNING TIME', formatDuration(runningMs), state.events.length + ' observed events', ''],
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

function renderHome() {
  if (!state.model) return renderNoExperiment();
  $('#breadcrumbs').innerHTML = '<span class="crumb-muted">Workspace</span><span class="crumb-separator">/</span><strong>Home</strong>';
  $('#main-view').innerHTML = H(
    '<div class="page-heading"><div><span class="eyebrow">EXPERIMENT MONITOR</span><h1>', escapeHtml(state.experiment && state.experiment.metadata && state.experiment.metadata.problem_id || state.experiment && state.experiment.experiment_id || 'Experiment monitor'), '</h1><p>Live operations view of Core capacity, Execution flow, Task progress, and shared Material context.</p></div><div class="heading-actions">',
    statusPill(state.experiment && state.experiment.status), '<button class="button" data-route="executions"><span data-icon="activity"></span>Inspect activity</button></div></div>',
    '<div class="metric-grid" id="metrics"></div><div class="dashboard-grid"><section class="card timeline-card"><div class="card-header"><div><span class="eyebrow">RUNTIME TOPOLOGY</span><h2>Core activity</h2><p>Reusable Core lanes across the selected Experiment window.</p></div><a class="card-link" href="#executions">View executions <span data-icon="arrow"></span></a></div><div class="timeline-wrap" id="timeline"></div></section>',
    '<section class="card"><div class="card-header"><div><span class="eyebrow">HEALTH</span><h2>Signals</h2><p>Derived from append-only observations.</p></div><a class="card-link" href="#diagnostics">Open diagnostics</a></div><div class="card-body"><div class="signal-list" id="signals"></div></div></section></div>',
    '<div class="content-grid three"><section class="card"><div class="card-header"><div><span class="eyebrow">IMPACT</span><h2>Top Tasks</h2><p>Activity and downstream progress.</p></div><a class="card-link" href="#tasks">All tasks</a></div><div class="card-body"><div class="rank-list" id="top-tasks"></div></div></section>',
    '<section class="card"><div class="card-header"><div><span class="eyebrow">CONTEXT FLOW</span><h2>Top Materials</h2><p>Shared work with the widest observed use.</p></div><a class="card-link" href="#materials">All materials</a></div><div class="card-body"><div class="rank-list" id="top-materials"></div></div></section>',
    '<section class="card"><div class="card-header"><div><span class="eyebrow">EVENT STREAM</span><h2>Recent activity</h2><p>Latest Runtime and Service facts.</p></div></div><div class="card-body"><div class="event-list" id="recent-events"></div></div></section></div>'
  );
  installIcons();
  $('#metrics').innerHTML = renderMetrics(state.model);
  renderTimeline();
  $('#signals').innerHTML = signalMarkup(state.model);
  $('#nav-alert').classList.toggle('alert', state.model.errors.length > 0);
  renderTopLists(state.model);
  renderRecentEvents();
}

function renderNoExperiment() {
  $('#breadcrumbs').innerHTML = '<span class="crumb-muted">Workspace</span><span class="crumb-separator">/</span><strong>Home</strong>';
  $('#main-view').innerHTML = '<div class="page-heading"><div><span class="eyebrow">EXPERIMENT MONITOR</span><h1>Waiting for an Experiment</h1><p>The observation daemon is online. Start a benchmark or import a report under the configured experiment root and it will appear here automatically.</p></div><div class="heading-actions"><span class="status-pill idle">NO DATA</span></div></div><section class="card"><div class="card-body">' + emptyState('No Experiments registered', 'The dashboard will automatically discover later RUNNING Experiments without a manual page refresh.') + '</div></section>';
}

function renderDetailEvents(events) {
  if (!events.length) return emptyState('No Execution events', 'The observation stream has not recorded activity for this Execution.');
  return events.map((event) => '<article class="detail-event"><span class="event-time">' + escapeHtml(formatTime(event.occurred_at)) + '</span><strong>' + escapeHtml(eventLabel(event)) + '</strong><span class="event-source">#' + event.sequence + '</span>' + (event.payload && Object.keys(event.payload).length ? '<pre>' + escapeHtml(JSON.stringify(event.payload, null, 2).slice(0, 5000)) + '</pre>' : '') + '</article>').join('');
}

async function loadWorkspace(executionId) {
  const host = $('#execution-workspace'); if (!host || !state.experiment) return;
  try {
    const result = await get('/api/executions/' + encodeURIComponent(executionId) + '/workspace?experiment_id=' + encodeURIComponent(state.experiment.experiment_id));
    const workspace = result.workspace || {};
    host.innerHTML = '<div class="workspace-summary"><div class="workspace-stat"><strong>' + escapeHtml(workspace.workspace_revision || '—') + '</strong><span>revision</span></div><div class="workspace-stat"><strong>' + escapeHtml(result.files && result.files.length || 0) + '</strong><span>files</span></div><div class="workspace-stat"><strong>' + escapeHtml(shortId(workspace.content_hash, 9)) + '</strong><span>content hash</span></div></div><div class="workspace-meta" style="margin-top:12px"><span>' + escapeHtml(workspace.workspace_ref || result.execution && result.execution.workspace_ref || 'workspace reference unavailable') + '</span></div>';
  } catch (error) {
    host.innerHTML = emptyState('Workspace projection unavailable', error.message.includes('404') ? 'The standalone observer does not have a live Workspace Manager for this Execution.' : error.message);
  }
}

function renderExecutionPage(id) {
  const model = state.model;
  const execution = model && (model.executions.find((item) => item.execution_id === id) || model.executions[0]);
  if (!execution) return renderEmptyPage('Executions', 'No Execution facts have been observed for this Experiment yet.');
  const events = state.events.filter((event) => event.execution_id === execution.execution_id).reverse();
  const task = model.tasks.find((item) => item.task_id === execution.task_id);
  const materials = model.materials.filter((item) => execution.material_ids.includes(item.material_id) || item.source_execution === execution.execution_id);
  $('#breadcrumbs').innerHTML = '<span class="crumb-muted">Workspace</span><span class="crumb-separator">/</span><a href="#executions">Executions</a><span class="crumb-separator">/</span><strong>' + escapeHtml(shortId(execution.execution_id)) + '</strong>';
  $('#main-view').innerHTML = H(
    '<div class="page-heading"><div><span class="eyebrow">EXECUTION INSPECTOR</span><h1>', escapeHtml(shortId(execution.execution_id, 16)), '</h1><p>One durable attempt, all observed sessions, state transitions, and shared context.</p></div><div class="heading-actions"><button class="button" data-route="executions"><span data-icon="arrow"></span>All executions</button>', statusPill(execution.state), '</div></div>',
    '<div class="detail-grid"><div class="detail-stack"><section class="detail-hero"><div><span class="eyebrow">CURRENT STATE</span><h2>', escapeHtml(execution.state || 'UNKNOWN'), '</h2><p>', escapeHtml(task && task.goal || 'Task ' + shortId(execution.task_id)), '</p></div><div class="detail-meta">',
    '<div class="meta-item"><span>Execution</span><strong>', escapeHtml(execution.execution_id), '</strong></div><div class="meta-item"><span>Task</span><strong>', escapeHtml(shortId(execution.task_id)), '</strong></div><div class="meta-item"><span>Core / Session</span><strong>', escapeHtml(execution.core_id || '—'), ' / ', escapeHtml(shortId(execution.session_id)), '</strong></div><div class="meta-item"><span>Observed</span><strong>', escapeHtml(formatDuration(execution.running_ms)), '</strong></div></div></section>',
    '<section class="card"><div class="card-header"><div><span class="eyebrow">ORDERED RECORD</span><h2>Execution events</h2><p>', events.length, ' observations linked to this Execution.</p></div></div><div class="card-body">', renderDetailEvents(events), '</div></section></div>',
    '<div class="detail-stack"><section class="card"><div class="card-header"><div><span class="eyebrow">WORKSPACE</span><h2>Working surface</h2></div></div><div class="card-body" id="execution-workspace">', emptyState('Loading Workspace…', 'Reading the selected Execution Workspace projection.'), '</div></section>',
    '<section class="card"><div class="card-header"><div><span class="eyebrow">CONTEXT</span><h2>Linked Materials</h2></div></div><div class="card-body">', materials.length ? '<div class="relation-list">' + materials.map((material) => relationLink('material', material.material_id, (material.kind || 'material') + ' · ' + shortId(material.material_id, 9))).join('') + '</div>' : emptyState('No linked Materials', 'This Execution has not exposed a Material reference in the current observation stream.'), '</div></section>',
    '<section class="card"><div class="card-header"><div><span class="eyebrow">TASK</span><h2>Owning responsibility</h2></div></div><div class="card-body">', task ? '<button class="rank-row" data-route="task/' + escapeHtml(task.task_id) + '"><span class="signal-icon">' + ICONS.tasks + '</span><span class="row-copy"><strong>' + escapeHtml(task.goal || shortId(task.task_id)) + '</strong><span>' + escapeHtml(task.state) + ' · ' + escapeHtml(shortId(task.task_id)) + '</span></span><span class="card-link">Open</span></button>' : emptyState('Task unavailable', 'The Task Service projection is not attached to this observation server.'), '</div></section></div></div>'
  );
  installIcons();
  void loadWorkspace(execution.execution_id);
}

function renderExecutionList() {
  const model = state.model;
  if (!model || !model.executions.length) return renderEmptyPage('Executions', 'No Execution facts have been observed for this Experiment yet.');
  $('#breadcrumbs').innerHTML = '<span class="crumb-muted">Workspace</span><span class="crumb-separator">/</span><strong>Executions</strong>';
  const rows = model.executions.slice().sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || ''))).map((execution) => '<tr data-route="execution/' + escapeHtml(execution.execution_id) + '"><td><span class="id-cell">' + escapeHtml(shortId(execution.execution_id, 18)) + '</span><span class="table-sub">' + escapeHtml(execution.core_id || 'unassigned') + ' · ' + escapeHtml(shortId(execution.session_id)) + '</span></td><td>' + statusPill(execution.state) + '</td><td>' + escapeHtml(shortId(execution.task_id)) + '</td><td>' + escapeHtml(formatDuration(execution.running_ms)) + '</td><td>' + escapeHtml(formatTime(execution.updated_at, true)) + '</td></tr>').join('');
  $('#main-view').innerHTML = '<div class="page-heading"><div><span class="eyebrow">WORKSPACE / EXECUTIONS</span><h1>Execution activity</h1><p>Every leased attempt across reusable Core lanes.</p></div><div class="heading-actions"><span class="status-pill">' + model.executions.length + ' total</span></div></div><section class="card table-card"><div class="filter-bar" style="padding:18px 20px 4px"><input class="search" id="execution-filter" placeholder="Filter by Execution, Task, or Core" aria-label="Filter executions" /><span class="muted">' + escapeHtml(state.experiment.experiment_id) + '</span></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Execution</th><th>State</th><th>Task</th><th>Running time</th><th>Last observed</th></tr></thead><tbody id="execution-table">' + rows + '</tbody></table></div></section>';
  $('#execution-filter') && $('#execution-filter').addEventListener('input', (event) => filterTable(event.target.value, '#execution-table'));
}

function filterTable(value, selector) {
  const query = String(value || '').toLowerCase();
  $$(selector + ' tr').forEach((row) => { row.hidden = Boolean(query && !row.textContent.toLowerCase().includes(query)); });
}

function renderTaskPage(id) {
  const model = state.model;
  if (!model || !model.tasks.length) return renderEmptyPage('Tasks', 'No Task facts have been observed for this Experiment yet.');
  const selected = model.tasks.find((item) => item.task_id === id) || model.tasks[0];
  const roots = model.tasks.filter((task) => !task.parent_id);
  function renderTree(task, depth) {
    const children = task.children.map((childId) => model.tasks.find((candidate) => candidate.task_id === childId)).filter(Boolean);
    return '<button class="rank-row" style="margin-left:' + Math.min(depth || 0, 5) * 18 + 'px" data-route="task/' + escapeHtml(task.task_id) + '"><span class="rank-number">' + (depth ? '↳' : 'R') + '</span><span class="row-copy"><strong>' + escapeHtml(task.goal || shortId(task.task_id)) + '</strong><span>' + escapeHtml(task.task_type || 'Task') + ' · ' + escapeHtml(shortId(task.task_id)) + '</span></span>' + statusPill(task.state) + '</button>' + children.map((child) => renderTree(child, (depth || 0) + 1)).join('');
  }
  const executions = model.executions.filter((execution) => selected.executions.includes(execution.execution_id));
  const materials = model.materials.filter((material) => selected.material_ids.includes(material.material_id) || material.source_task === selected.task_id);
  $('#breadcrumbs').innerHTML = '<span class="crumb-muted">Workspace</span><span class="crumb-separator">/</span><a href="#tasks">Tasks</a><span class="crumb-separator">/</span><strong>' + escapeHtml(shortId(selected.task_id)) + '</strong>';
  $('#main-view').innerHTML = '<div class="page-heading"><div><span class="eyebrow">TASK FLOW</span><h1>' + escapeHtml(selected.goal || shortId(selected.task_id, 16)) + '</h1><p>Durable responsibility, child work, Execution attempts, and context delivery.</p></div><div class="heading-actions">' + statusPill(selected.state) + '<button class="button" data-route="tasks">All tasks</button></div></div><div class="content-grid"><section class="card"><div class="card-header"><div><span class="eyebrow">RELATIONSHIP MAP</span><h2>Task tree</h2><p>Parent and direct child ownership.</p></div></div><div class="card-body"><div class="rank-list">' + roots.map((root) => renderTree(root, 0)).join('') + '</div></div></section><div class="stack"><section class="card"><div class="card-header"><div><span class="eyebrow">SELECTED TASK</span><h2>Responsibility details</h2></div></div><div class="card-body"><div class="meta-item"><span>Task ID</span><strong>' + escapeHtml(selected.task_id) + '</strong></div><div class="meta-item" style="margin-top:10px"><span>State</span><strong>' + escapeHtml(selected.state) + '</strong></div><div class="meta-item" style="margin-top:10px"><span>Running time</span><strong>' + escapeHtml(formatDuration(selected.running_ms)) + '</strong></div><p class="muted" style="margin:15px 0 0;font-size:12px">' + escapeHtml(selected.block_reason ? 'Waiting / blocked: ' + selected.block_reason : 'No blocking reason observed.') + '</p></div></section><section class="card"><div class="card-header"><div><span class="eyebrow">EXECUTIONS</span><h2>Attempts</h2></div></div><div class="card-body">' + (executions.length ? '<div class="relation-list">' + executions.map((execution) => relationLink('execution', execution.execution_id, execution.state + ' · ' + shortId(execution.execution_id, 9))).join('') + '</div>' : emptyState('No attempts', 'This Task has not been claimed in the observed run.')) + '</div></section><section class="card"><div class="card-header"><div><span class="eyebrow">CONTEXT</span><h2>Materials</h2></div></div><div class="card-body">' + (materials.length ? '<div class="relation-list">' + materials.map((material) => relationLink('material', material.material_id, (material.kind || 'material') + ' · ' + shortId(material.material_id, 9))).join('') + '</div>' : emptyState('No Materials linked', 'Material provenance has not been observed for this Task.')) + '</div></section></div></div>';
}

function renderTaskList() {
  if (!state.model || !state.model.tasks.length) return renderEmptyPage('Tasks', 'No Task facts have been observed for this Experiment yet.');
  $('#breadcrumbs').innerHTML = '<span class="crumb-muted">Workspace</span><span class="crumb-separator">/</span><strong>Tasks</strong>';
  const rows = state.model.tasks.slice().sort((a, b) => (b.running_ms || 0) - (a.running_ms || 0)).map((task) => '<tr data-route="task/' + escapeHtml(task.task_id) + '"><td><span class="id-cell">' + escapeHtml(shortId(task.task_id, 18)) + '</span><span class="table-sub">' + escapeHtml(task.goal || 'No goal recorded') + '</span></td><td>' + statusPill(task.state) + '</td><td>' + task.children.length + '</td><td>' + task.executions.length + '</td><td>' + escapeHtml(formatDuration(task.running_ms)) + '</td></tr>').join('');
  $('#main-view').innerHTML = '<div class="page-heading"><div><span class="eyebrow">WORKSPACE / TASKS</span><h1>Task flow</h1><p>Browse every responsibility and its relationship to Executions and shared context.</p></div></div><section class="card table-card"><div class="filter-bar" style="padding:18px 20px 4px"><input class="search" id="task-filter" placeholder="Filter Task ID or goal" aria-label="Filter tasks" /></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Task</th><th>State</th><th>Children</th><th>Executions</th><th>Running time</th></tr></thead><tbody id="task-table">' + rows + '</tbody></table></div></section>';
  $('#task-filter') && $('#task-filter').addEventListener('input', (event) => filterTable(event.target.value, '#task-table'));
}

function renderMaterialPage(id) {
  const model = state.model;
  if (!model || !model.materials.length) return renderEmptyPage('Materials', 'No Material facts have been observed for this Experiment yet.');
  const selected = model.materials.find((item) => item.material_id === id) || model.materials[0];
  const task = model.tasks.find((item) => item.task_id === selected.source_task);
  const execution = model.executions.find((item) => item.execution_id === selected.source_execution);
  $('#breadcrumbs').innerHTML = '<span class="crumb-muted">Workspace</span><span class="crumb-separator">/</span><a href="#materials">Materials</a><span class="crumb-separator">/</span><strong>' + escapeHtml(shortId(selected.material_id)) + '</strong>';
  $('#main-view').innerHTML = '<div class="page-heading"><div><span class="eyebrow">CONTEXT / MATERIAL</span><h1>' + escapeHtml(selected.kind || 'Material') + ' <span class="muted">' + escapeHtml(shortId(selected.material_id, 16)) + '</span></h1><p>Immutable shared work, provenance, evidence state, and observed downstream use.</p></div><div class="heading-actions">' + statusPill(selected.evidence_state) + '<button class="button" data-route="materials">All materials</button></div></div><div class="detail-grid"><div class="detail-stack"><section class="card"><div class="card-header"><div><span class="eyebrow">PROVENANCE</span><h2>Source and lineage</h2></div></div><div class="card-body"><div class="meta-item"><span>Material ID</span><strong>' + escapeHtml(selected.material_id) + '</strong></div><div class="meta-item" style="margin-top:10px"><span>Content hash</span><strong>' + escapeHtml(selected.content_hash || '—') + '</strong></div><div class="meta-item" style="margin-top:10px"><span>Version</span><strong>' + escapeHtml(selected.version || '—') + '</strong></div><div class="meta-item" style="margin-top:10px"><span>Created</span><strong>' + escapeHtml(formatTime(selected.created_at, true)) + '</strong></div><div class="relation-list" style="margin-top:18px">' + (task ? relationLink('task', task.task_id, 'Task · ' + shortId(task.task_id, 9)) : '') + (execution ? relationLink('execution', execution.execution_id, 'Execution · ' + shortId(execution.execution_id, 9)) : '') + (selected.supersedes ? relationLink('material', selected.supersedes, 'Supersedes · ' + shortId(selected.supersedes, 9)) : '') + '</div></div></section><section class="card"><div class="card-header"><div><span class="eyebrow">DOWNSTREAM USE</span><h2>Observed consumers</h2><p>Read and action links captured in the current event stream.</p></div></div><div class="card-body">' + (selected.consumers.length ? '<div class="relation-list">' + selected.consumers.map((consumer) => relationLink('execution', consumer, 'Execution · ' + shortId(consumer, 10))).join('') + '</div>' : emptyState('No explicit consumers', 'This Material has provenance, but no downstream read or action has been observed yet.')) + '</div></section></div><section class="card"><div class="card-header"><div><span class="eyebrow">CONTENT PREVIEW</span><h2>Payload</h2><p>Local operator view; public projections should remain redacted.</p></div></div><div class="card-body"><pre class="payload-preview">' + escapeHtml(JSON.stringify(selected.content || selected.content_json || { material_id: selected.material_id }, null, 2).slice(0, 12000)) + '</pre></div></section></div>';
}

function renderMaterialList() {
  if (!state.model || !state.model.materials.length) return renderEmptyPage('Materials', 'No Material facts have been observed for this Experiment yet.');
  $('#breadcrumbs').innerHTML = '<span class="crumb-muted">Workspace</span><span class="crumb-separator">/</span><strong>Materials</strong>';
  const rows = state.model.materials.slice().sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))).map((material) => '<tr data-route="material/' + escapeHtml(material.material_id) + '"><td><span class="id-cell">' + escapeHtml(shortId(material.material_id, 18)) + '</span><span class="table-sub">' + escapeHtml(material.scope || 'unscoped') + '</span></td><td><span class="tag">' + escapeHtml(material.kind || 'unknown') + '</span></td><td>' + statusPill(material.evidence_state) + '</td><td>' + escapeHtml(shortId(material.source_task)) + '</td><td>' + material.consumers.length + '</td><td>' + escapeHtml(formatTime(material.created_at, true)) + '</td></tr>').join('');
  $('#main-view').innerHTML = '<div class="page-heading"><div><span class="eyebrow">WORKSPACE / MATERIALS</span><h1>Context flow</h1><p>Trace shared work from producer to downstream consumer.</p></div></div><section class="card table-card"><div class="filter-bar" style="padding:18px 20px 4px"><input class="search" id="material-filter" placeholder="Filter material, kind, or source" aria-label="Filter materials" /></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Material</th><th>Kind</th><th>Evidence</th><th>Source Task</th><th>Consumers</th><th>Created</th></tr></thead><tbody id="material-table">' + rows + '</tbody></table></div></section>';
  $('#material-filter') && $('#material-filter').addEventListener('input', (event) => filterTable(event.target.value, '#material-table'));
}

function renderDiagnostics() {
  if (!state.model) return renderEmptyPage('Diagnostics', 'Select an Experiment to inspect health.');
  const model = state.model;
  const errorRows = model.errors.slice(-30).reverse();
  $('#breadcrumbs').innerHTML = '<span class="crumb-muted">Operations</span><span class="crumb-separator">/</span><strong>Diagnostics</strong>';
  const rows = errorRows.length ? errorRows.map((event) => '<button class="event-row" data-route="' + (event.execution_id ? 'execution/' + escapeHtml(event.execution_id) : 'diagnostics') + '"><span class="signal-icon danger">' + ICONS.alert + '</span><span class="row-copy"><strong>' + escapeHtml(eventLabel(event)) + '</strong><span>' + escapeHtml(shortId(event.execution_id || event.task_id || event.core_id)) + ' · #' + event.sequence + '</span></span><span class="event-time">' + escapeHtml(formatTime(event.occurred_at)) + '</span></button>').join('') : emptyState('No error evidence', 'No process, tool, timeout, or failed-state events are present.');
  $('#main-view').innerHTML = '<div class="page-heading"><div><span class="eyebrow">OPERATIONS / DIAGNOSTICS</span><h1>System health</h1><p>Evidence-linked signals for scheduling, Session lifecycle, Services, and context delivery.</p></div><div class="heading-actions"><span class="status-pill ' + (model.errors.length ? 'failed' : 'succeeded') + '">' + (model.errors.length ? model.errors.length + ' signals' : 'healthy') + '</span></div></div><div class="content-grid"><section class="card"><div class="card-header"><div><span class="eyebrow">HEALTH SIGNALS</span><h2>Current projection</h2></div></div><div class="card-body"><div class="signal-list">' + signalMarkup(model) + '</div></div></section><section class="card"><div class="card-header"><div><span class="eyebrow">ERROR EVIDENCE</span><h2>Recent error events</h2></div></div><div class="card-body"><div class="event-list">' + rows + '</div></div></section></div><section class="card" style="margin-top:16px"><div class="card-header"><div><span class="eyebrow">OBSERVATION INTEGRITY</span><h2>Data plane facts</h2></div></div><div class="card-body"><div class="metric-grid" style="margin-bottom:0"><div class="metric"><span class="metric-label">Events</span><strong class="metric-value">' + formatNumber(state.events.length) + '</strong><span class="metric-meta">ordered by sequence</span></div><div class="metric"><span class="metric-label">Wait boundaries</span><strong class="metric-value">' + formatNumber(model.waits.length) + '</strong><span class="metric-meta">typed lifecycle observations</span></div><div class="metric"><span class="metric-label">Task links</span><strong class="metric-value">' + formatNumber(model.taskLinks.length) + '</strong><span class="metric-meta">Task / Execution pairs</span></div></div></div></section>';
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

function connectStream(id) {
  if (state.source) state.source.close();
  state.source = new EventSource('/api/experiments/' + encodeURIComponent(id) + '/stream?after_sequence=' + (state.events.at(-1) && state.events.at(-1).sequence || 0));
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
  });
}

function renderCurrent() {
  route();
  $('#last-refresh').textContent = state.lastUpdated ? 'updated ' + formatTime(state.lastUpdated) : '—';
}

function updateNav() {
  const model = state.model || { tasks: [], executions: [], materials: [] };
  $('#nav-tasks').textContent = model.tasks.length;
  $('#nav-executions').textContent = model.executions.length;
  $('#nav-materials').textContent = model.materials.length;
}

async function selectExperiment(id) {
  if (!id) return;
  setConnection('Loading…');
  try {
    const experiment = await get('/api/experiments/' + encodeURIComponent(id));
    const results = await Promise.all([
      getAllPages('/api/experiments/' + encodeURIComponent(id) + '/events?limit=1000'),
      get('/api/experiments/' + encodeURIComponent(id) + '/timeline?limit=1000'),
    ]);
    state.experiment = experiment;
    state.events = results[0].events;
    state.timeline = results[1];
    state.model = buildModel();
    state.lastUpdated = new Date();
    updateNav();
    connectStream(id);
    setConnection('Live', 'live');
    renderCurrent();
  } catch (error) {
    setConnection('Unavailable', 'error');
    $('#main-view').innerHTML = '<section class="card"><div class="card-body">' + emptyState('Observation server unavailable', error.message) + '</div></section>';
  }
}

function updateExperimentOptions(experiments) {
  const select = $('#experiments');
  const current = state.experiment && state.experiment.experiment_id || select.value;
  select.innerHTML = experiments.length ? experiments.map((experiment) => '<option value="' + escapeHtml(experiment.experiment_id) + '">' + escapeHtml(shortId(experiment.experiment_id, 22)) + ' · ' + escapeHtml(experiment.status) + '</option>').join('') : '<option value="">No experiments</option>';
  if (current && experiments.some((experiment) => experiment.experiment_id === current)) select.value = current;
}

async function refreshExperiments(initial) {
  if (state.refreshInFlight) return;
  state.refreshInFlight = true;
  try {
    const response = await get('/api/experiments?limit=100');
    state.experiments = response.experiments || [];
    updateExperimentOptions(state.experiments);
    const current = state.experiments.find((experiment) => state.experiment && experiment.experiment_id === state.experiment.experiment_id);
    const running = state.experiments.find((experiment) => experiment.status === 'RUNNING');
    const target = initial || !state.experiment ? running && running.experiment_id || state.experiments[0] && state.experiments[0].experiment_id : !current && state.experiments[0] && state.experiments[0].experiment_id;
    if (target && target !== (state.experiment && state.experiment.experiment_id)) await selectExperiment(target);
    else if (current && state.experiment) { state.experiment = Object.assign({}, state.experiment, current); renderCurrent(); }
    else if (!state.experiment) { setConnection('Waiting for data'); renderNoExperiment(); }
  } catch (error) {
    setConnection('Unavailable', 'error');
    if (!state.experiment) $('#main-view').innerHTML = '<section class="card"><div class="card-body">' + emptyState('Cannot reach observer', error.message) + '</div></section>';
  } finally { state.refreshInFlight = false; }
}

function bindInteractions() {
  $('#experiments').addEventListener('change', (event) => { void selectExperiment(event.target.value); });
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
  setInterval(() => { void refreshExperiments(false); }, 4000);
}

main().catch((error) => { setConnection('Error', 'error'); $('#main-view').innerHTML = '<section class="card"><div class="card-body">' + emptyState('Dashboard failed to load', error.message) + '</div></section>'; });

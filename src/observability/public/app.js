const state = { experiment: null, events: [], timeline: null, source: null, refreshInFlight: false, timelineInFlight: false };
const $ = (selector) => document.querySelector(selector);

function formatTime(value) {
  return value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character]));
}

async function get(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

function renderSummary(experiment) {
  $('#summary').innerHTML = `<span class="pill ${experiment.status.toLowerCase()}">${escapeHtml(experiment.status)}</span><span>${escapeHtml(experiment.experiment_id)}</span><span>started ${formatTime(experiment.started_at)}</span><span>${experiment.event_count ?? 0} events</span>`;
  $('#event-count').textContent = `${experiment.event_count ?? 0} observed events`;
}

function durationWeight(start, end) {
  const milliseconds = end ? Math.max(1, new Date(end).getTime() - new Date(start).getTime()) : 1;
  return Math.max(1, Math.round(milliseconds / 1000));
}

function stateSegments(events) {
  const segments = [];
  for (const event of events) {
    if (event.kind !== 'core_state_changed') continue;
    const previous = [...segments].reverse().find((candidate) => candidate.ended_at === null);
    if (previous) previous.ended_at = event.occurred_at;
    segments.push({
      event,
      state: event.payload?.state ?? 'UNKNOWN',
      started_at: event.occurred_at,
      ended_at: Number.isFinite(event.payload?.ended_at_ms) ? new Date(event.payload.ended_at_ms).toISOString() : null,
    });
  }
  return segments;
}

function renderLanes() {
  if (state.timeline) {
    const lanes = state.timeline.lanes ?? [];
    if (!lanes.length) {
      $('#lanes').innerHTML = '<div class="empty">No Core events yet.</div>';
      return;
    }
    $('#lanes').innerHTML = lanes.map((lane) => {
      const stateContent = (lane.states ?? []).map((segment) => `<button class="segment state-${escapeHtml(segment.state.toLowerCase())}" style="flex-grow: ${durationWeight(segment.started_at, segment.ended_at)}" data-execution-id="${escapeHtml(segment.execution_id ?? '')}" title="${escapeHtml(segment.reason ?? segment.state)}"><strong>${escapeHtml(segment.state)}</strong><small>${escapeHtml(segment.execution_id?.slice(0, 12) ?? 'idle')} · ${formatTime(segment.started_at)} → ${formatTime(segment.ended_at)}</small></button>`).join('');
      const segmentContent = (lane.segments ?? []).map((segment) => `<button class="segment state-running" style="flex-grow: ${durationWeight(segment.started_at, segment.ended_at)}" data-execution-id="${escapeHtml(segment.execution_id ?? '')}" title="${escapeHtml(segment.execution_id ?? '')}"><strong>${escapeHtml(segment.execution_id?.slice(0, 12) ?? 'execution')}</strong><small>${formatTime(segment.started_at)} → ${formatTime(segment.ended_at)}</small></button>`).join('');
      return `<div class="lane"><div class="lane-label">${escapeHtml(lane.core_id)}</div><div class="track">${stateContent || segmentContent || '<span class="lane-event">observing</span>'}</div></div>`;
    }).join('');
    document.querySelectorAll('.segment').forEach((segment) => segment.addEventListener('click', () => selectExecution(segment.dataset.executionId)));
    return;
  }
  const lanes = new Map();
  for (const event of state.events) {
    if (!event.core_id) continue;
    if (!lanes.has(event.core_id)) lanes.set(event.core_id, []);
    lanes.get(event.core_id).push(event);
  }
  if (!lanes.size) {
    $('#lanes').innerHTML = '<div class="empty">No Core events yet.</div>';
    return;
  }
  $('#lanes').innerHTML = [...lanes.entries()].map(([core, events]) => {
    const segments = [];
    let current = null;
    for (const event of events) {
      if (event.kind === 'execution_assigned') current = { event, end: null };
      if (event.kind === 'execution_released' && current?.event.execution_id === event.execution_id) { current.end = event; segments.push(current); current = null; }
    }
    if (current) segments.push(current);
    const states = stateSegments(events);
    const content = states.length
      ? states.map(({ event, state, started_at, ended_at }) => `<button class="segment state-${escapeHtml(state.toLowerCase())}" style="flex-grow: ${durationWeight(started_at, ended_at)}" data-execution-id="${escapeHtml(event.execution_id ?? '')}" title="${escapeHtml(event.payload?.reason ?? state)}"><strong>${escapeHtml(state)}</strong><small>${escapeHtml(event.execution_id?.slice(0, 12) ?? 'idle')} · ${formatTime(started_at)} → ${formatTime(ended_at)}</small></button>`).join('')
      : segments.length
        ? segments.map(({ event, end }) => `<button class="segment state-running" style="flex-grow: ${durationWeight(event.occurred_at, end?.occurred_at)}" data-execution-id="${escapeHtml(event.execution_id)}" title="${escapeHtml(event.execution_id)}"><strong>${escapeHtml(event.execution_id?.slice(0, 12))}</strong><small>${formatTime(event.occurred_at)} → ${formatTime(end?.occurred_at)}</small></button>`).join('')
      : '<span class="lane-event">observing</span>';
    return `<div class="lane"><div class="lane-label">${escapeHtml(core)}</div><div class="track">${content}</div></div>`;
  }).join('');
  document.querySelectorAll('.segment').forEach((segment) => segment.addEventListener('click', () => selectExecution(segment.dataset.executionId)));
}

function renderEvents() {
  const events = [...state.events].reverse().slice(0, 40);
  $('#events').innerHTML = events.length ? events.map((event) => `<article class="event"><div class="event-meta"><span class="source">${escapeHtml(event.source)}</span><span>${formatTime(event.occurred_at)}</span><span>#${event.sequence}</span></div><strong>${escapeHtml(event.kind)}</strong><div class="event-ids">${escapeHtml(event.execution_id ?? event.task_id ?? event.core_id ?? '')}</div></article>`).join('') : '<div class="empty">No interactions yet.</div>';
}

function renderSignals() {
  const errors = state.events.filter((event) => /error|failed|timeout/i.test(event.kind));
  const waits = state.events.filter((event) => /wait/i.test(event.kind));
  $('#signals').innerHTML = `<div class="signal ${errors.length ? 'warning' : 'good'}"><strong>${errors.length ? `${errors.length} error signals` : 'No error signals'}</strong><span>derived from observed events</span></div><div class="signal"><strong>${waits.length} wait events</strong><span>inspect Execution activity for dependencies</span></div>`;
}

function renderDomainState() {
  const tasks = new Set(state.events.map((event) => event.task_id).filter(Boolean));
  const executions = new Set(state.events.map((event) => event.execution_id).filter(Boolean));
  const materialEvents = state.events.filter((event) => /material|context/i.test(event.kind));
  const serviceEvents = state.events.filter((event) => /service|dispatch|judge/i.test(`${event.source} ${event.kind}`));
  $('#domain-state').innerHTML = `<div class="domain-stat"><strong>${tasks.size}</strong><span>Tasks observed</span></div><div class="domain-stat"><strong>${executions.size}</strong><span>Executions observed</span></div><div class="domain-stat"><strong>${materialEvents.length}</strong><span>Context and Material events</span></div><div class="domain-stat"><strong>${serviceEvents.length}</strong><span>Service and Judge events</span></div>`;
}

function renderExecutionEvents(executionId, events) {
  $('#execution-events-title').textContent = `Execution ${executionId.slice(0, 12)} · ${events.length} events`;
  $('#execution-events').innerHTML = events.length ? events.map((event) => `<article class="event"><div class="event-meta"><span class="source">${escapeHtml(event.source)}</span><span>${formatTime(event.occurred_at)}</span><span>#${event.sequence}</span></div><strong>${escapeHtml(event.kind)}</strong><div class="event-ids">${escapeHtml(event.session_id ?? event.task_id ?? '')}</div><pre>${escapeHtml(JSON.stringify(event.payload ?? {}, null, 2).slice(0, 6000))}</pre></article>`).join('') : '<div class="empty">No events for this Execution yet.</div>';
}

function render() {
  if (!state.experiment) return;
  renderSummary(state.experiment);
  renderLanes();
  renderEvents();
  renderSignals();
  renderDomainState();
}

async function selectExecution(executionId) {
  if (!executionId || !state.experiment) return;
  $('#workspace-title').textContent = `Execution ${executionId.slice(0, 12)}`;
  $('#workspace-state').textContent = 'Loading…';
  try {
    const [result, activity] = await Promise.all([
      get(`/api/executions/${encodeURIComponent(executionId)}/workspace?experiment_id=${encodeURIComponent(state.experiment.experiment_id)}`),
      getAllPages(`/api/executions/${encodeURIComponent(executionId)}/events?experiment_id=${encodeURIComponent(state.experiment.experiment_id)}&limit=1000`),
    ]);
    $('#workspace-state').textContent = `${result.execution?.state ?? 'UNKNOWN'} · revision ${result.workspace?.workspace_revision ?? '—'}`;
    $('#workspace').innerHTML = `<div class="workspace-meta"><span>ref ${escapeHtml(result.workspace?.workspace_ref ?? result.execution?.workspace_ref ?? '')}</span><span>content ${escapeHtml(result.workspace?.content_hash ?? '—')}</span><span>${result.files.length} files</span></div><div class="file-list">${result.files.map((file) => `<div class="file"><span>${escapeHtml(file.path)}</span><span>${file.bytes} bytes · ${escapeHtml(file.content_hash.slice(0, 12))}</span></div>`).join('')}</div><div class="revision-list"><strong>Revisions</strong>${result.revisions.map((revision) => `<span>r${revision.workspace_revision} · ${escapeHtml(revision.content_hash.slice(0, 12))} · ${revision.changed_files.length} changed</span>`).join('')}</div>`;
    renderExecutionEvents(executionId, activity.events);
  } catch (error) {
    $('#workspace-state').textContent = 'Unavailable';
    $('#workspace').innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
    $('#execution-events-title').textContent = `Execution ${executionId.slice(0, 12)}`;
    $('#execution-events').innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

function connectStream(id) {
  state.source?.close();
  state.source = new EventSource(`/api/experiments/${encodeURIComponent(id)}/stream?after_sequence=${state.events.at(-1)?.sequence ?? 0}`);
  state.source.onopen = () => { $('#connection').textContent = 'Live'; $('#connection').className = 'status live'; };
  state.source.onerror = () => { $('#connection').textContent = 'Reconnecting…'; $('#connection').className = 'status warning'; };
  state.source.addEventListener('observation', (message) => {
    const event = JSON.parse(message.data);
    if (!state.events.some((candidate) => candidate.event_id === event.event_id)) state.events.push(event);
    state.experiment.event_count = Math.max(state.experiment.event_count ?? 0, event.sequence ?? 0);
    if (['core_state_changed', 'execution_assigned', 'execution_released'].includes(event.kind)) void refreshTimeline(id);
    render();
  });
}

async function getAllPages(path) {
  const events = [];
  let cursor = 0;
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const page = await get(`${path}${separator}after_sequence=${cursor}`);
    events.push(...(page.events ?? []));
    if (!page.has_more || page.next_cursor === null || page.next_cursor === undefined) return { ...page, events };
    if (page.next_cursor <= cursor) throw new Error('event cursor did not advance');
    cursor = page.next_cursor;
  }
  throw new Error('event history exceeds the UI paging bound');
}

async function refreshTimeline(id) {
  if (state.timelineInFlight || state.experiment?.experiment_id !== id) return;
  state.timelineInFlight = true;
  try {
    const timeline = await get(`/api/experiments/${encodeURIComponent(id)}/timeline?limit=1000`);
    if (state.experiment?.experiment_id === id) {
      state.timeline = timeline;
      render();
    }
  } finally {
    state.timelineInFlight = false;
  }
}

async function selectExperiment(id) {
  if (!id) return;
  const experiment = await get(`/api/experiments/${encodeURIComponent(id)}`);
  const afterSequence = Math.max(0, (experiment.event_count ?? 0) - 1000);
  const [page, timeline] = await Promise.all([
    get(`/api/experiments/${encodeURIComponent(id)}/events?after_sequence=${afterSequence}&limit=1000`),
    get(`/api/experiments/${encodeURIComponent(id)}/timeline?limit=1000`),
  ]);
  state.experiment = experiment;
  state.events = page.events;
  state.timeline = timeline;
  render();
  connectStream(id);
}

function updateExperimentOptions(experiments) {
  const select = $('#experiments');
  const currentId = state.experiment?.experiment_id ?? select.value;
  select.innerHTML = experiments.map((experiment) => `<option value="${escapeHtml(experiment.experiment_id)}">${escapeHtml(experiment.experiment_id)} · ${escapeHtml(experiment.status)}</option>`).join('');
  if (currentId && experiments.some((experiment) => experiment.experiment_id === currentId)) select.value = currentId;
}

async function refreshExperiments({ initial = false } = {}) {
  if (state.refreshInFlight) return;
  state.refreshInFlight = true;
  try {
    const response = await get('/api/experiments?limit=100');
    updateExperimentOptions(response.experiments);
    const current = response.experiments.find((experiment) => experiment.experiment_id === state.experiment?.experiment_id);
    const running = response.experiments.find((experiment) => experiment.status === 'RUNNING');
    const target = initial || !state.experiment
      ? (running?.experiment_id ?? response.experiments[0]?.experiment_id)
      : (running && running.experiment_id !== current?.experiment_id
        ? running.experiment_id
        : (!current ? response.experiments[0]?.experiment_id : null));
    if (target && target !== state.experiment?.experiment_id) {
      await selectExperiment(target);
    } else if (current && state.experiment) {
      state.experiment = { ...state.experiment, ...current };
      render();
    } else if (!state.experiment) {
      $('#connection').textContent = 'No experiments';
      $('#connection').className = 'status warning';
    }
  } finally {
    state.refreshInFlight = false;
  }
}

async function main() {
  const select = $('#experiments');
  select.addEventListener('change', () => selectExperiment(select.value));
  await refreshExperiments({ initial: true });
  // A browser tab opened before a benchmark starts discovers the new RUNNING
  // Experiment without a manual refresh.
  setInterval(() => { void refreshExperiments(); }, 3_000);
}

main().catch((error) => { $('#connection').textContent = error.message; $('#connection').className = 'status warning'; });

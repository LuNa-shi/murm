import { conditionLabel, eventLabel, readNested, shortId } from './format.js';

export const TERMINAL_TASK_STATES = new Set(['SUCCEEDED', 'SATISFIED', 'DONE', 'COMPLETED', 'FAILED', 'CANCELLED', 'FENCED', 'EXPIRED', 'REJECTED']);
export const ACTIVE_EXECUTION_STATES = new Set(['RUNNING', 'ASSIGNED', 'CREATED']);

export function eventToolRecord(event: any) {
  return event?.kind === 'rpc_record' && event.payload?.record ? event.payload.record : null;
}

export function extractToolCalls(events: any = []) {
  const calls = new Map<any, any>();
  for (const event of events) {
    const record = eventToolRecord(event);
    if (!record) continue;
    const start = record.type === 'tool_execution_start' || record.type === 'tool_call';
    const end = record.type === 'tool_execution_end' || record.type === 'tool_result';
    if (!start && !end) continue;
    const id = record.toolCallId || record.tool_call_id || record.id || event.sequence;
    if (start) calls.set(id, {
      id,
      toolName: record.toolName || record.tool_name || 'unknown tool',
      args: record.args || record.arguments || record.input,
      start: event,
      end: null,
      result: null,
      isError: false,
    });
    if (end) {
      const call = calls.get(id) || { id, toolName: record.toolName || 'unknown tool', args: null, start: event, end: null, result: null, isError: false };
      call.end = event;
      call.result = record.result;
      call.isError = Boolean(record.isError);
      calls.set(id, call);
    }
  }
  return [...calls.values()].sort((left: any, right: any) => (left.start?.sequence || 0) - (right.start?.sequence || 0));
}

function materialCandidates(value: any, depth: any = 0) {
  if (!value || typeof value !== 'object' || depth > 5) return [];
  const result: any[] = [];
  if (typeof value.material_id === 'string') result.push(value);
  if (Array.isArray(value)) value.forEach((child: any) => result.push(...materialCandidates(child, depth + 1)));
  else Object.values(value).forEach((child: any) => result.push(...materialCandidates(child, depth + 1)));
  return result;
}

function mergeDefined(target: any, source: any) {
  if (!source || typeof source !== 'object') return target;
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value !== null && value !== '') target[key] = value;
  }
  return target;
}

function eventIdentity(event: any) {
  const payload = event.payload || {};
  const taskPayload = readNested(payload, ['task']);
  const executionPayload = readNested(payload, ['execution']);
  const taskId = event.task_id || taskPayload?.task_id || executionPayload?.task_id || readNested(payload, ['target_task_id']);
  const executionId = event.execution_id || executionPayload?.execution_id;
  return { taskPayload, executionPayload, taskId, executionId };
}

export function buildModel(events: any = [], timeline: any = { lanes: [] }, toolCounts: any = {}) {
  const tasks = new Map<any, any>();
  const executions = new Map<any, any>();
  const materials = new Map<any, any>();
  const taskLinks = new Map<any, any>();

  const ensureTask = (id: any, patch: any = {}) => {
    if (!id) return null;
    const task = tasks.get(id) || { task_id: id, state: 'UNKNOWN', executions: new Set(), material_ids: new Set(), event_count: 0, running_ms: 0, errors: 0, fields: {} };
    mergeDefined(task, patch);
    mergeDefined(task.fields, patch);
    tasks.set(id, task);
    return task;
  };
  const ensureExecution = (id: any, patch: any = {}) => {
    if (!id) return null;
    const execution = executions.get(id) || { execution_id: id, state: 'UNKNOWN', task_id: null, material_ids: [], event_count: 0, running_ms: 0, errors: 0, tool_calls: 0, fields: {} };
    mergeDefined(execution, patch);
    mergeDefined(execution.fields, patch);
    executions.set(id, execution);
    return execution;
  };
  const ensureMaterial = (material: any) => {
    if (!material?.material_id) return null;
    const current = materials.get(material.material_id) || { material_id: material.material_id, links: new Set(), consumers: new Set(), event_count: 0, fields: {} };
    mergeDefined(current, material);
    mergeDefined(current.fields, material);
    materials.set(material.material_id, current);
    return current;
  };
  const linkMaterial = (id: any, event: any) => {
    if (!id) return;
    const material = ensureMaterial({ material_id: id });
    material.event_count += 1;
    if (event.execution_id) {
      material.links.add(event.execution_id);
      ensureExecution(event.execution_id);
      if (/read|consume|use|action/i.test(`${event.kind} ${event.payload?.operation || ''}`)) material.consumers.add(event.execution_id);
    }
    if (event.task_id) {
      material.links.add(event.task_id);
      ensureTask(event.task_id).material_ids.add(id);
    }
  };

  for (const event of events) {
    const { taskPayload, executionPayload, taskId, executionId } = eventIdentity(event);
    const payload = event.payload || {};
    const waitCondition = payload.wait_condition || payload.wait_reason || taskPayload?.wait_condition || executionPayload?.wait_condition || payload.result?.wait_condition;
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
      const nextState = taskPayload?.state || payload.task_state || (['OPEN', 'READY', 'RUNNING', 'WAITING', 'SUCCEEDED', 'SATISFIED', 'FAILED'].includes(payload.state) ? payload.state : null);
      if (nextState) task.state = nextState;
      if (waitCondition || payload.block_reason) task.block_reason = conditionLabel(payload.block_reason || waitCondition);
      if (taskPayload?.goal) task.goal = taskPayload.goal;
      if (/error|failed|timeout/i.test(event.kind || '')) task.errors += 1;
    }
    if (execution) {
      execution.event_count += 1;
      execution.updated_at = event.occurred_at;
      execution.task_id = execution.task_id || taskId;
      execution.core_id = execution.core_id || event.core_id;
      execution.session_id = execution.session_id || event.session_id;
      const nextState = executionPayload?.state || (event.kind === 'execution_released' || event.kind === 'core_state_changed' ? payload.state : null) || payload.state;
      if (nextState) execution.state = nextState;
      if (waitCondition) execution.wait_condition = waitCondition;
      if (/error|failed|timeout/i.test(event.kind || '')) execution.errors += 1;
    }
    for (const material of materialCandidates(payload)) {
      const saved = ensureMaterial(material);
      if (saved.producer_task_id) ensureTask(saved.producer_task_id).material_ids.add(saved.material_id);
      if (saved.producer_execution_id) {
        const sourceExecution = ensureExecution(saved.producer_execution_id);
        if (!sourceExecution.material_ids.includes(saved.material_id)) sourceExecution.material_ids.push(saved.material_id);
      }
      linkMaterial(saved.material_id, event);
    }
    const ids = new Set();
    const collectIds = (value: any, depth: any = 0) => {
      if (!value || typeof value !== 'object' || depth > 5) return;
      for (const [key, child] of Object.entries(value)) {
        if (/material_id$/i.test(key) && typeof child === 'string') ids.add(child);
        if (/material_ids|input_material_refs|steer_material_refs/i.test(key) && Array.isArray(child)) child.filter((item: any) => typeof item === 'string').forEach((item: any) => ids.add(item));
        collectIds(child, depth + 1);
      }
    };
    collectIds(payload);
    ids.forEach((id: any) => linkMaterial(id, event));
    if (taskId && executionId) taskLinks.set(`${taskId}:${executionId}`, { task_id: taskId, execution_id: executionId });
  }

  for (const segment of timelineSegments(timeline)) {
    const execution = ensureExecution(segment.execution_id, { task_id: segment.task_id, core_id: segment.core_id, state: segment.state });
    const duration = segment.ended_at ? new Date(segment.ended_at).getTime() - new Date(segment.started_at).getTime() : 0;
    if (String(segment.state || '').toUpperCase() === 'RUNNING') {
      if (execution) execution.running_ms += Math.max(0, duration);
      if (segment.task_id) ensureTask(segment.task_id).running_ms += Math.max(0, duration);
    }
  }
  for (const execution of executions.values()) {
    if (execution.task_id) ensureTask(execution.task_id).executions.add(execution.execution_id);
    execution.tool_calls = Number.isFinite(toolCounts[execution.execution_id]) ? toolCounts[execution.execution_id] : extractToolCalls(events.filter((event: any) => event.execution_id === execution.execution_id)).length;
  }
  const durableIds = new Set(timelineSegments(timeline).map((segment: any) => segment.execution_id).filter(Boolean));
  const durableKinds = new Set(['execution_assigned', 'execution_released', 'core_state_changed', 'execution_started', 'execution_waiting', 'execution_wait', 'execution_observed', 'execution_execution']);
  for (const event of events) {
    if (event.execution_id && durableKinds.has(event.kind)) durableIds.add(event.execution_id);
    const nestedExecution = readNested(event.payload || {}, ['execution']);
    if (nestedExecution?.execution_id && event.kind === 'dispatch.complete') durableIds.add(nestedExecution.execution_id);
  }
  for (const task of tasks.values()) task.executions = new Set([...task.executions].filter((id: any) => durableIds.has(id)));
  const errors = events.filter((event: any) => /error|failed|timeout|stale|fenced/i.test(event.kind || '') || event.payload?.ok === false || event.payload?.error || event.payload?.result?.error || event.kind === 'process_stderr');
  const waits = events.filter((event: any) => /wait/i.test(event.kind || '') || event.payload?.state === 'WAITING' || readNested(event.payload || {}, ['execution'])?.state === 'WAITING' || event.payload?.wait_condition);
  const services = new Map<any, any>();
  for (const event of events) {
    const service = event.payload?.service || (event.source === 'service' ? 'service' : null);
    if (!service && !/dispatch|service|judge|route/i.test(event.kind || '')) continue;
    const name = service || (event.source === 'judge' ? 'judge' : event.source || 'runtime');
    const item = services.get(name) || { name, calls: 0, errors: 0, last_at: null };
    item.calls += 1;
    item.last_at = event.occurred_at;
    if (/error|failed/i.test(event.kind || '') || event.payload?.ok === false) item.errors += 1;
    services.set(name, item);
  }
  return {
    tasks: [...tasks.values()].map((task: any) => ({ ...task, executions: [...task.executions], material_ids: [...task.material_ids] })),
    executions: [...executions.values()].filter((execution: any) => durableIds.has(execution.execution_id)).map((execution: any) => ({ ...execution, material_ids: [...new Set(execution.material_ids)] })),
    materials: [...materials.values()].map((material: any) => ({ ...material, links: [...material.links], consumers: [...material.consumers] })),
    taskLinks: [...taskLinks.values()],
    services: [...services.values()],
    errors,
    waits,
  };
}

export function timelineSegments(timeline: any = { lanes: [] }) {
  return (timeline.lanes || []).flatMap((lane: any) => (lane.segments || []).map((segment: any) => ({ ...segment, core_id: lane.core_id })));
}

function traceSpan(kind: any, event: any, patch: any = {}) {
  return {
    kind,
    id: event?.event_id || event?.sequence || kind,
    start: event?.occurred_at,
    end: event?.occurred_at,
    execution_id: event?.execution_id || null,
    task_id: event?.task_id || null,
    session_id: event?.session_id || null,
    label: eventLabel(event),
    state: null,
    ...patch,
  };
}

export function coreTraceData(events: any = [], timeline: any = { lanes: [] }, model: any = { executions: [] }) {
  const traces = new Map<any, any>((timeline.lanes || []).map((lane: any) => [lane.core_id, {
    core_id: lane.core_id,
    states: (lane.states || []).map((state: any) => ({ ...state, start: state.started_at, end: state.ended_at, kind: 'state' })),
    executions: (lane.segments || []).map((segment: any) => ({ ...segment, start: segment.started_at, end: segment.ended_at, kind: 'execution' })),
    session_turns: [], turns: [], tools: [], checks: [], markers: [],
  }]));
  const executionSegments = new Map<any, any>();
  const ensureTrace = (coreId: any) => {
    if (!coreId) return null;
    if (!traces.has(coreId)) traces.set(coreId, { core_id: coreId, states: [], executions: [], session_turns: [], turns: [], tools: [], checks: [], markers: [] });
    return traces.get(coreId);
  };
  for (const trace of traces.values()) for (const segment of trace.executions) {
    const list = executionSegments.get(segment.execution_id) || [];
    list.push({ ...segment, core_id: trace.core_id });
    executionSegments.set(segment.execution_id, list);
  }
  const coreForExecution = (executionId: any, atValue: any) => {
    const at = new Date(atValue).getTime();
    return (executionSegments.get(executionId) || []).find((segment: any) => {
      const start = new Date(segment.start).getTime();
      const end = segment.end ? new Date(segment.end).getTime() : Infinity;
      return Number.isFinite(at) && at >= start && at <= end;
    })?.core_id || null;
  };
  const openSessions = new Map<any, any>();
  const openTurns = new Map<any, any>();
  const openTools = new Map<any, any>();
  for (const event of events) {
    const trace = ensureTrace(event.core_id || coreForExecution(event.execution_id, event.occurred_at));
    if (!trace) continue;
    if (event.kind === 'session_started') {
      const span = traceSpan('session', event, { label: 'Agent session', end: null, state: 'RUNNING', execution_id: null });
      openSessions.set(event.session_id || event.execution_id || trace.core_id, span);
      trace.session_turns.push(span);
    } else if (event.kind === 'session_closed') {
      const span = openSessions.get(event.session_id || event.execution_id || trace.core_id);
      if (span) span.end = event.occurred_at;
    } else if (event.kind === 'agent_turn_started') {
      const span = traceSpan('turn', event, { label: 'Agent turn', end: null, state: 'RUNNING' });
      openTurns.set(event.execution_id || trace.core_id, span);
      trace.turns.push(span);
    } else if (event.kind === 'agent_turn_finished') {
      const span = openTurns.get(event.execution_id || trace.core_id) || trace.turns.at(-1);
      if (span && !span.end) span.end = event.occurred_at;
      if (span) span.state = event.payload?.state || 'settled';
    }
    const record = eventToolRecord(event);
    if (record && ['tool_execution_start', 'tool_call', 'tool_execution_end', 'tool_result'].includes(record.type)) {
      const id = record.toolCallId || record.tool_call_id || record.id || event.sequence;
      if (record.type === 'tool_execution_start' || record.type === 'tool_call') {
        const span = traceSpan('tool', event, { label: record.toolName || 'Tool call', tool_name: record.toolName || 'Tool call', state: 'RUNNING', end: null, tool_call_id: id });
        openTools.set(`${trace.core_id}:${id}`, span);
        trace.tools.push(span);
      } else {
        const span = openTools.get(`${trace.core_id}:${id}`) || trace.tools.at(-1);
        if (span && !span.end) span.end = event.occurred_at;
        if (span) { span.state = record.isError ? 'failed' : 'returned'; span.is_error = Boolean(record.isError); }
      }
    }
    if (/^(judge|checker)\.|^judge_check_finished$/.test(event.kind || '')) trace.checks.push(traceSpan('check', event, { label: event.kind === 'judge_check_finished' ? 'Judge check' : event.kind.startsWith('checker') ? 'Checker' : 'Judge', state: /complete|finished/.test(event.kind) ? 'returned' : 'running', end: /complete|finished/.test(event.kind) ? event.occurred_at : null }));
    if (event.kind === 'workspace_revision_saved' || event.kind === 'execution_wait' || event.kind === 'execution_execution') trace.markers.push(traceSpan(event.kind === 'workspace_revision_saved' ? 'workspace' : 'lifecycle', event, { label: event.kind === 'workspace_revision_saved' ? 'Workspace saved' : event.kind === 'execution_wait' ? 'Waiting' : 'Woken', state: event.kind === 'execution_wait' ? 'waiting' : 'saved' }));
    if (/error|failed|timeout|failure|stderr/i.test(event.kind || '') || event.payload?.ok === false) trace.markers.push(traceSpan('error', event, { label: 'Error signal', state: 'error' }));
  }
  const durableIds = new Set(model.executions.map((execution: any) => execution.execution_id));
  for (const trace of traces.values()) {
    const spans = [...trace.turns, ...trace.tools, ...trace.checks, ...trace.markers];
    for (const span of spans) if (span.execution_id && !durableIds.has(span.execution_id)) span.execution_id = null;
    for (const key of ['turns', 'tools', 'checks', 'markers']) trace[key] = trace[key].filter((span: any) => span.start).sort((left: any, right: any) => (new Date(left.start) as any) - (new Date(right.start) as any));
    trace.last_state = trace.states.at(-1)?.state || trace.executions.at(-1)?.state || 'IDLE';
    trace.active_execution = trace.executions.find((segment: any) => !segment.end)?.execution_id || null;
    trace.agent_turn_count = trace.turns.length;
    trace.agent_session_count = trace.session_turns.length;
  }
  return [...traces.values()].sort((left: any, right: any) => String(left.core_id).localeCompare(String(right.core_id), undefined, { numeric: true }));
}

export function isTerminal(value: any) {
  return TERMINAL_TASK_STATES.has(String(value || '').toUpperCase());
}

export function queueTasks(model: any) {
  const active = new Set(model.executions.filter((execution: any) => ACTIVE_EXECUTION_STATES.has(String(execution.state || '').toUpperCase())).map((execution: any) => execution.execution_id));
  return model.tasks.filter((task: any) => !isTerminal(task.state) && !task.executions.some((id: any) => active.has(id))).sort((left: any, right: any) => {
    const rank = (task: any) => /BLOCKED|WAITING/i.test(task.state) ? 0 : /READY|OPEN|CREATED/i.test(task.state) ? 1 : 2;
    return rank(left) - rank(right) || String(right.updated_at || '').localeCompare(String(left.updated_at || ''));
  });
}

export function workerRows(experiment: any, timeline: any, model: any, events: any) {
  const ids = new Set([...(experiment?.core_ids || []), ...(timeline.lanes || []).map((lane: any) => lane.core_id), ...model.executions.map((execution: any) => execution.core_id)].filter(Boolean));
  return [...ids].sort((left: any, right: any) => String(left).localeCompare(String(right), undefined, { numeric: true })).map((coreId: any) => {
    const lane = timeline.lanes?.find((candidate: any) => candidate.core_id === coreId) || { segments: [], states: [] };
    const activeSegment = [...lane.segments].reverse().find((segment: any) => !segment.ended_at) || null;
    const lastSegment = activeSegment || lane.segments.at(-1) || null;
    const execution = activeSegment && model.executions.find((candidate: any) => candidate.execution_id === activeSegment.execution_id);
    const task = execution && model.tasks.find((candidate: any) => candidate.task_id === execution.task_id) || activeSegment && model.tasks.find((candidate: any) => candidate.task_id === activeSegment.task_id);
    const state = String(execution?.state || lane.states.at(-1)?.state || lastSegment?.state || 'IDLE').toUpperCase();
    const agentEvent = [...events].reverse().find((event: any) => event.core_id === coreId && (event.payload?.model || event.payload?.provider || event.payload?.agent));
    const agent = agentEvent?.payload?.model || agentEvent?.payload?.agent || agentEvent?.payload?.provider || `Core ${String(coreId).replace(/^core[-_]?/i, '')}`;
    return { core_id: coreId, agent, state: /WAITING|BLOCKED/.test(state) ? 'WAITING' : activeSegment ? 'RUNNING' : state === 'UNKNOWN' ? 'IDLE' : state, active: Boolean(activeSegment), execution_id: activeSegment?.execution_id || null, execution, task, progress: activeSegment ? 68 : 0 };
  });
}

export function queueDepthSeries(events: any, model: any) {
  const states = new Map<any, any>();
  const samples: any[] = [];
  for (const event of [...events].sort((left: any, right: any) => (new Date(left.occurred_at) as any) - (new Date(right.occurred_at) as any))) {
    const { taskId, taskPayload, executionPayload } = eventIdentity(event);
    const nextState = taskPayload?.state || executionPayload?.state || event.payload?.task_state || event.payload?.state;
    if (taskId && nextState) states.set(taskId, String(nextState).toUpperCase());
    if (taskId && event.kind === 'execution_assigned') states.set(taskId, 'RUNNING');
    const depth = [...states.values()].filter((value: any) => !isTerminal(value) && !/RUNNING|ASSIGNED|RELEASED|FENCED|EXPIRED/.test(value)).length;
    if (event.occurred_at) samples.push({ at: event.occurred_at, depth });
  }
  const current = queueTasks(model).length;
  if (!samples.length) return [{ at: new Date(Date.now() - 60_000).toISOString(), depth: current }, { at: new Date().toISOString(), depth: current }];
  if (samples.at(-1).depth !== current) samples.push({ at: new Date().toISOString(), depth: current });
  return samples.slice(-32);
}

export function modelTaskLabel(task: any) {
  return task?.goal || task?.title || task?.description || shortId(task?.task_id, 18) || 'Untitled Task';
}

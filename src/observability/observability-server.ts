import { watch } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, dirname, join } from 'node:path';
import { once } from 'node:events';
import { listServices, listTools } from '../sdk/service-catalog.js';

export const OBSERVABILITY_AUTH_VERSION = 1;

function isLoopbackAddress(address: any) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export function observabilityAccessMode({ host, operatorPassword = null }: any) {
  if (operatorPassword !== null && (typeof operatorPassword !== 'string' || !operatorPassword.trim())) {
    throw new TypeError('Observer operator password must be nonempty');
  }
  if (operatorPassword !== null) return 'operator-basic';
  if (host === 'localhost' || isLoopbackAddress(host)) return 'local-operator';
  throw new TypeError('Non-loopback Observer requires explicit operator authentication');
}

function httpHost(host: any) {
  return host.includes(':') ? `[${host}]` : host;
}

function json(value: any) {
  return JSON.stringify(value ?? null);
}

function send(response: any, status: any, body: any) {
  const content = json(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(content),
  });
  response.end(content);
}

function errorBody(error: any) {
  return { code: error?.code ?? 'OBSERVABILITY_ERROR', message: error?.message ?? String(error) };
}

function parseLimit(value: any, fallback: any = 100) {
  if (value === null || value === undefined || value === '') return fallback;
  const limit = Number(value);
  if (!Number.isInteger(limit)) throw new TypeError('limit must be an integer');
  return limit;
}

function parseCursor(value: any, fallback: any = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const cursor = Number(value);
  if (!Number.isInteger(cursor) || cursor < 0) throw new TypeError('after_sequence must be a non-negative integer');
  return cursor;
}

function parseKinds(value: any) {
  if (!value) return null;
  return value.split(',').map((kind: any) => kind.trim()).filter(Boolean);
}

const DASHBOARD_SECRET_KEY = /(?:authorization|api[_-]?key|access[_-]?token|password|private[_-]?key|credential|bearer|cookie|secret|proof|formal[_-]?source|raw[_-]?transcript|task[_-]?instructions|(?:^|[_-])token(?:$|[_-]))/i;
const DASHBOARD_MAX_STRING = 8_000;
const DASHBOARD_MAX_ARRAY = 100;
const OVERVIEW_EVENT_KINDS = [
  'dispatch.complete',
  'execution_assigned',
  'execution_started',
  'execution_waiting',
  'execution_wait',
  'execution_observed',
  'execution_execution',
  'execution_released',
  'core_capacity_released',
  'core_state_changed',
  'session_started',
  'session_closed',
  'agent_turn_started',
  'agent_turn_finished',
  'agent_settled',
  'workspace_revision_saved',
  'task_state_changed',
  'task_child_created',
  'judge.start',
  'judge.complete',
  'judge_check_finished',
  'checker.start',
  'checker.complete',
  'checker.preflight.start',
  'checker.preflight.complete',
  'runtime.session_failure',
  'runtime.recovery_exhausted',
  'session_failure',
  'recovery_exhausted',
  'process_stderr',
  'stderr',
  'experiment_started',
  'experiment_finished',
];
const OVERVIEW_RPC_RECORD_TYPES = new Set(['tool_execution_start', 'tool_execution_end', 'tool_call', 'tool_result']);
const OVERVIEW_TOOL_NAMES = new Set([
  'swarmenv_task_list',
  'swarmenv_task_take',
  'swarmenv_context_publish',
  'swarmenv_context_read',
  'swarmenv_context_consume',
  'swarmenv_judge_workspace_check',
  'swarmenv_judge_get_check_result',
]);
const EXECUTION_DETAIL_LIFECYCLE_KINDS = new Set([
  'session_started',
  'session_closed',
  'execution_assigned',
  'execution_started',
  'execution_waiting',
  'execution_wait',
  'execution_observed',
  'execution_execution',
  'execution_released',
  'core_state_changed',
  'agent_settled',
  'agent_turn_started',
  'agent_turn_finished',
  'workspace_revision_saved',
  'judge_check_finished',
  'dispatch.start',
  'dispatch.complete',
  'route.start',
  'route.complete',
  'judge.start',
  'judge.complete',
  'checker.start',
  'checker.complete',
  'checker.preflight.start',
  'checker.preflight.complete',
  'runtime.session_failure',
  'runtime.recovery_exhausted',
  'session_failure',
  'recovery_exhausted',
]);
const DETAIL_MAX_EVENTS = 10_000;
const DETAIL_MAX_BYTES = 4_000_000;
const OVERVIEW_MAX_EVENTS = 50_000;
const OVERVIEW_MAX_BYTES = 4_000_000;
// The overview is a live operational view. Keep the initial projection close
// to the active window instead of replaying an entire historical run into the
// server and client. Detail endpoints remain available for historical reads.
const OVERVIEW_RECENT_EVENTS = 2_000;
const TIMELINE_RECENT_EVENTS = 1_000;
const OVERVIEW_ENTITY_SEEDS = 750;

function parseJson(value: any) {
  if (typeof value !== 'string' || value.length === 0) return value;
  try { return JSON.parse(value); } catch { return value; }
}

function rawToolName(record: any) {
  return record?.toolName ?? record?.tool_name ?? record?.name ?? null;
}

function toolArguments(record: any) {
  return record?.args ?? record?.arguments ?? record?.params ?? record?.input ?? undefined;
}

function dashboardToolName(record: any) {
  return rawToolName(record);
}

function isToolRecord(record: any, type: any) {
  return Boolean(record) && (record.type === type);
}

function isToolStart(record: any) {
  return isToolRecord(record, 'tool_execution_start') || isToolRecord(record, 'tool_call');
}

function isToolEnd(record: any) {
  return isToolRecord(record, 'tool_execution_end') || isToolRecord(record, 'tool_result');
}

function toolCallId(record: any, fallback: any = null) {
  return record?.toolCallId ?? record?.tool_call_id ?? record?.id ?? fallback;
}

function compactToolRecord(record: any) {
  if (!record || typeof record !== 'object') return null;
  const compact = {
    type: record.type,
    toolCallId: toolCallId(record),
    toolName: dashboardToolName(record),
    args: isToolStart(record) ? toolArguments(record) : undefined,
    result: isToolEnd(record) ? compactOverviewToolResult(record.result) : undefined,
    isError: record.isError,
  };
  return dashboardValue(compact);
}

function dashboardValue(value: any, key: any = '', depth: any = 0): any {
  if (DASHBOARD_SECRET_KEY.test(String(key))) return '[redacted]';
  if (typeof value === 'string') return value.length <= DASHBOARD_MAX_STRING ? value : `${value.slice(0, DASHBOARD_MAX_STRING)}\n… [display truncated]`;
  if (depth > 7) return '[nested value truncated]';
  if (Array.isArray(value)) {
    const items: any = value.slice(0, DASHBOARD_MAX_ARRAY).map((item: any) => dashboardValue(item, '', depth + 1));
    if (value.length > DASHBOARD_MAX_ARRAY) items.push(`[${value.length - DASHBOARD_MAX_ARRAY} array items truncated]`);
    return items;
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([childKey, child]: any) => [childKey, dashboardValue(child, childKey, depth + 1)]));
}

function nestedValue(value: any, keys: any, depth: any = 0): any {
  if (!value || typeof value !== 'object' || depth > 6) return null;
  for (const key of keys) if (value[key] !== undefined && value[key] !== null) return value[key];
  for (const child of Object.values(value)) {
    const found: any = nestedValue(child, keys, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function materialFromPayload(value: any, materialId: any, depth: any = 0): any {
  if (typeof value === 'string') {
    const parsed = parseJson(value);
    return parsed === value ? null : materialFromPayload(parsed, materialId, depth + 1);
  }
  if (!value || typeof value !== 'object' || depth > 7) return null;
  if (value.material_id === materialId) return value;
  if (Array.isArray(value)) {
    for (const child of value) {
      const found: any = materialFromPayload(child, materialId, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const child of Object.values(value)) {
    const found: any = materialFromPayload(child, materialId, depth + 1);
    if (found) return found;
  }
  return null;
}

function toolDetails(record: any) {
  return record?.result?.details ?? record?.result?.result ?? record?.result ?? null;
}

function compactTask(value: any) {
  if (!value || typeof value !== 'object') return value;
  return dashboardValue({
    task_id: value.task_id,
    owner_ref: value.owner_ref,
    goal: value.goal,
    priority: value.priority,
    state: value.state,
    wait_condition: value.wait_condition,
    block_reason: value.block_reason,
    material_ids: value.material_ids,
  });
}

function compactExecution(value: any) {
  if (!value || typeof value !== 'object') return value;
  return dashboardValue({
    execution_id: value.execution_id,
    task_id: value.task_id,
    state: value.state,
    owner_ref: value.owner_ref,
    attempt_no: value.attempt_no,
    core_id: value.core_id,
    session_id: value.session_id,
    wait_condition: value.wait_condition,
    artifact_material_id: value.artifact_material_id,
    material_ids: value.material_ids,
  });
}

function overviewText(value: any) {
  if (typeof value !== 'string') return dashboardValue(value);
  return value.length <= 1_200 ? value : `${value.slice(0, 1_200)}\n… [display truncated]`;
}

function compactMaterial(value: any) {
  if (!value || typeof value !== 'object') return value;
  return dashboardValue({
    material_id: value.material_id,
    media_type: value.media_type,
    version: value.version,
    producer_task_id: value.producer_task_id,
    producer_execution_id: value.producer_execution_id,
    supersedes: value.supersedes,
    summary: overviewText(value.summary),
    description: overviewText(value.description),
    title: overviewText(value.title),
    text: overviewText(value.text),
    path: value.path,
  });
}

function compactOverviewResult(value: any) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.slice(0, DASHBOARD_MAX_ARRAY).map((item: any) => {
      if (!item || typeof item !== 'object') return dashboardValue(item);
      if (item.task_id) return compactTask(item);
      if (item.execution_id) return compactExecution(item);
      if (item.material_id) return compactMaterial(item);
      return dashboardValue(item);
    });
  }
  const result: Record<string, any> = {};
  for (const key of ['state', 'status', 'operation', 'wait_condition', 'block_reason', 'artifact_material_id']) {
    if (value[key] !== undefined && value[key] !== null) result[key] = dashboardValue(value[key], key);
  }
  if (value.task) result.task = compactTask(value.task);
  if (value.execution) result.execution = compactExecution(value.execution);
  if (value.material) result.material = compactMaterial(value.material);
  if (!value.task && value.task_id) result.task = compactTask(value);
  if (!value.execution && value.execution_id) result.execution = compactExecution(value);
  if (!value.material && value.material_id) result.material = compactMaterial(value);
  if (Array.isArray(value.tasks)) result.tasks = value.tasks.slice(0, 100).map(compactTask);
  if (Array.isArray(value.executions)) result.executions = value.executions.slice(0, 100).map(compactExecution);
  if (Array.isArray(value.materials)) result.materials = value.materials.slice(0, 100).map(compactMaterial);
  if (value.error) result.error = dashboardValue(value.error, 'error');
  return result;
}

function compactOverviewToolResult(value: any) {
  if (!value || typeof value !== 'object') return dashboardValue(value);
  const result = compactOverviewResult(value);
  const details = value.details ?? value.result;
  if (details !== undefined) result.details = compactOverviewResult(details);
  if (Array.isArray(value.content)) {
    result.content = value.content.slice(0, 8).map((item: any) => dashboardValue({
      type: item?.type,
      text: overviewText(item?.text),
    }));
  }
  return result;
}

function compactOverviewRecord(record: any) {
  if (!record || typeof record !== 'object' || !OVERVIEW_RPC_RECORD_TYPES.has(record.type)) return null;
  return compactToolRecord(record);
}

function compactOverviewEvent(event: any) {
  const payload = event.payload ?? {};
  const record = compactOverviewRecord(payload.record);
  return {
    event_id: event.event_id,
    experiment_id: event.experiment_id,
    sequence: event.sequence,
    occurred_at: event.occurred_at,
    source: event.source,
    kind: event.kind,
    core_id: event.core_id,
    session_id: event.session_id,
    task_id: event.task_id,
    execution_id: event.execution_id,
    correlation_id: event.correlation_id,
    visibility: event.visibility,
    payload: {
      event: payload.event,
      service: payload.service,
      operation: payload.operation,
      ok: payload.ok,
      state: payload.state,
      task_state: payload.task_state,
      wait_condition: dashboardValue(payload.wait_condition, 'wait_condition'),
      wait_reason: dashboardValue(payload.wait_reason, 'wait_reason'),
      block_reason: dashboardValue(payload.block_reason, 'block_reason'),
      error: dashboardValue(payload.error, 'error'),
      result: compactOverviewResult(payload.result),
      record,
    },
  };
}

function compactOverviewEvents(events: any) {
  const snapshots = new Map<any, any>();
  return events.map((event: any) => {
    const compact = compactOverviewEvent(event);
    const result = compact.payload?.result;
    if (!result || typeof result !== 'object') return compact;
    for (const [kind, id] of [['task', result.task?.task_id], ['execution', result.execution?.execution_id], ['material', result.material?.material_id]]) {
      if (!id || !result[kind]) continue;
      const key = `${kind}:${id}`;
      const snapshot = JSON.stringify(result[kind]);
      if (snapshots.get(key) === snapshot) delete result[kind];
      else snapshots.set(key, snapshot);
    }
    if (!Object.keys(result).length) delete compact.payload.result;
    return compact;
  });
}

function boundOverviewEvents(events: any) {
  const bounded: any[] = [];
  let bytes = 0;
  for (const event of events) {
    const size = Buffer.byteLength(JSON.stringify(event));
    if (bounded.length >= OVERVIEW_MAX_EVENTS || bytes + size > OVERVIEW_MAX_BYTES) {
      return { events: bounded, bytes, truncated: true };
    }
    bounded.push(event);
    bytes += size;
  }
  return { events: bounded, bytes, truncated: false };
}

function reportSummary(report: any) {
  if (!report || typeof report !== 'object') return null;
  const project = report.project ?? {};
  const run = report.run ?? {};
  const parallelism = report.parallelism ?? {};
  return {
    schema_version: report.schema_version ?? null,
    problem_id: project.problem_id ?? null,
    run_id: project.run_id ?? null,
    tags: project.tags ?? [],
    repository_commit: report.protocol?.repository_commit ?? null,
    started_at: run.started_at ?? null,
    ended_at: run.ended_at ?? null,
    elapsed_ms: run.elapsed_ms ?? null,
    solved: run.solved ?? null,
    protocol_valid: run.protocol_valid ?? null,
    made_progress: run.made_progress ?? null,
    task_count: project.task_count ?? project.task_tree?.length ?? null,
    material_count: run.material_count ?? null,
    candidate_count: run.candidate_count ?? null,
    tool_error_count: run.tool_error_count ?? null,
    take_count: run.take_count ?? null,
    wait_count: run.wait_count ?? null,
    wake_count: run.wake_count ?? null,
    accept_count: run.accept_count ?? null,
    rework_count: run.rework_count ?? null,
    resume_count: run.resume_count ?? null,
    core_count: parallelism.core_count ?? report.protocol?.core_count ?? null,
    agent_time_ms: parallelism.agent_time_ms ?? null,
    mean_active_core_count: parallelism.mean_active_core_count ?? null,
    max_active_core_count: parallelism.max_active_core_count ?? null,
    state_time_ms: parallelism.state_time_ms ?? null,
    task_tree: (project.task_tree ?? []).map((task: any) => ({
      task_id: task.task_id,
      goal: task.goal ?? null,
      state: task.state ?? task.task_state ?? null,
    })),
    cores: (report.cores ?? []).map((core: any) => ({
      core: core.core,
      task_id: core.task_id ?? null,
      execution_id: core.execution_id ?? null,
      task_state: core.task_state ?? null,
      execution_state: core.execution_state ?? null,
      tool_events: core.tool_events ?? [],
      tool_errors: core.tool_errors ?? [],
      workspace_writes: core.workspace_writes?.length ?? 0,
      checks: (core.checks ?? []).map((check: any) => ({
        verdict: check.verdict ?? check.status ?? null,
        checker_ref: check.checker_ref ?? null,
        error_class: check.error_class ?? null,
      })),
    })),
  };
}

/**
 * Small local operator server for the Observation Store. It deliberately
 * keeps the HTTP surface read-only; Task and Context mutations stay behind
 * their existing Service boundaries.
 */
export class ObservabilityServer {
  declare observationStore: any;
  declare taskService: any;
  declare contextService: any;
  declare workspaceManager: any;
  declare workspaceProvider: any;
  declare experimentRoot: any;
  declare host: any;
  declare advertiseHost: any;
  declare accessMode: any;
  declare operatorHash: any;
  declare server: any;
  declare addressValue: any;
  declare streamResponses: any;
  declare registryResponses: any;
  declare registryWaiters: any;
  declare registryWatchers: any;
  declare registryWatcherPaths: any;
  declare registryRefreshTimer: any;
  declare registryRescanTimer: any;
  declare registrySnapshotKey: any;

  constructor({ observationStore, taskService = null, contextService = null, workspaceManager = null, workspaceProvider = null, experimentRoot = null, host = '127.0.0.1', advertiseHost = null, operatorPassword = null }: any = {}) {
    if (!observationStore) throw new TypeError('ObservabilityServer requires observationStore');
    this.observationStore = observationStore;
    this.taskService = taskService;
    this.contextService = contextService;
    this.workspaceManager = workspaceManager;
    this.workspaceProvider = workspaceProvider;
    this.experimentRoot = experimentRoot;
    this.host = host;
    this.advertiseHost = advertiseHost;
    this.accessMode = observabilityAccessMode({ host, operatorPassword });
    this.operatorHash = operatorPassword === null ? null :
      createHash('sha256').update(`operator:${operatorPassword}`).digest();
    this.server = null;
    this.addressValue = null;
    this.streamResponses = new Set();
    this.registryResponses = new Set();
    this.registryWaiters = new Set();
    this.registryWatchers = [];
    this.registryWatcherPaths = new Set();
    this.registryRefreshTimer = null;
    this.registryRescanTimer = null;
    this.registrySnapshotKey = null;
  }

  async start({ port = 0 }: any = {}) {
    if (this.server) return this.address();
    this.server = createServer((request: any, response: any) => {
      void this.#handle(request, response);
    });
    this.server.listen(port, this.host);
    await once(this.server, 'listening');
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('observability server did not receive an address');
    this.addressValue = address;
    this.#startRegistryWatchers();
    return this.address();
  }

  address() {
    if (!this.addressValue) throw new Error('ObservabilityServer has not been started');
    const publicHost = this.advertiseHost ?? this.host;
    return {
      host: this.host,
      advertise_host: this.advertiseHost,
      port: this.addressValue.port,
      url: `http://${httpHost(publicHost)}:${this.addressValue.port}`,
      access_mode: this.accessMode,
    };
  }

  async stop() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.addressValue = null;
    if (this.registryRefreshTimer) clearTimeout(this.registryRefreshTimer);
    this.registryRefreshTimer = null;
    if (this.registryRescanTimer) clearInterval(this.registryRescanTimer);
    this.registryRescanTimer = null;
    for (const watcher of this.registryWatchers) watcher.close();
    this.registryWatchers = [];
    this.registryWatcherPaths.clear();
    for (const response of this.streamResponses) response.destroy();
    this.streamResponses.clear();
    this.registryResponses.clear();
    for (const resolveWaiter of this.registryWaiters) resolveWaiter(null);
    this.registryWaiters.clear();
    server.close();
    await once(server, 'close').catch(() => undefined);
  }

  #isOperator(request: any) {
    if (request.headers['sec-fetch-site'] === 'cross-site') return false;
    if (this.operatorHash) {
      const value = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(request.headers.authorization ?? '')?.[1];
      if (!value) return false;
      const digest = createHash('sha256').update(Buffer.from(value, 'base64')).digest();
      return timingSafeEqual(digest, this.operatorHash);
    }
    if (!isLoopbackAddress(request.socket.remoteAddress)) return false;
    // Protect loopback-only browser sessions from virtual-host/DNS rebinding
    // and accidental forwarding by a reverse proxy.
    const host = request.headers.host?.toLowerCase();
    const port = this.addressValue.port;
    return ['127.0.0.1', 'localhost', '[::1]'].some((name: any) => host === `${name}:${port}`) &&
      !request.headers.forwarded && !request.headers['x-forwarded-for'] && !request.headers['x-forwarded-host'];
  }

  async #handle(request: any, response: any) {
    try {
      const url = new URL(request.url ?? '/', `http://${httpHost(this.host)}`);
      if (request.method === 'GET' && url.pathname === '/health') {
        send(response, 200, { ok: true, service: 'swarmenv-observability',
          auth_version: OBSERVABILITY_AUTH_VERSION, access_mode: this.accessMode });
        return;
      }
      if (!this.#isOperator(request)) {
        if (this.operatorHash) response.setHeader('www-authenticate', 'Basic realm="murm Operator", charset="UTF-8"');
        send(response, this.operatorHash ? 401 : 403, { ok: false, error: { code: 'OPERATOR_REQUIRED', message: 'Observer operator access is required' } });
        return;
      }
      if (request.method !== 'GET') {
        send(response, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'observability API is read-only' } });
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        await this.#api(url, response);
        return;
      }
      send(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'unknown observability route' } });
    } catch (error: any) {
      if (!response.headersSent) send(response, 400, { ok: false, error: errorBody(error) });
      else response.end();
    }
  }

  async #api(url: any, response: any) {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[1] === 'experiments' && parts[2] === 'stream' && parts.length === 3) {
      this.#registryStream(response);
      return;
    }
    if (parts[1] === 'experiments' && parts[2] === 'changes' && parts.length === 3) {
      await this.#registryChanges(url, response);
      return;
    }
    if (parts[1] === 'experiments' && parts.length === 2) {
      send(response, 200, this.#registryPayload(parseLimit(url.searchParams.get('limit'))));
      return;
    }
    if (parts[1] === 'experiments' && parts.length >= 3) {
      const experimentId = decodeURIComponent(parts[2]);
      const experiment = this.observationStore.getExperiment(experimentId);
      if (!experiment) {
        send(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: `unknown experiment: ${experimentId}` } });
        return;
      }
      if (parts[3] === 'events') {
        send(response, 200, this.#eventsQuery(experimentId, url));
        return;
      }
      if (parts[3] === 'tasks' && parts.length >= 5) {
        const taskId = decodeURIComponent(parts[4]);
        send(response, 200, await this.#taskDetail(experimentId, taskId));
        return;
      }
      if (parts[3] === 'execution-detail') {
        const executionId = url.searchParams.get('execution_id');
        if (!executionId) throw new TypeError('execution_id is required for execution detail queries');
        send(response, 200, await this.#executionDetail(experimentId, executionId));
        return;
      }
      if (parts[3] === 'overview') {
        send(response, 200, await this.#overview(experimentId, url));
        return;
      }
      if (parts[3] === 'stream') {
        this.#stream(experimentId, response, url);
        return;
      }
      if (parts[3] === 'timeline') {
        send(response, 200, this.#timeline(experimentId, url));
        return;
      }
      if (parts[3] === 'execution-insight') {
        const executionId = url.searchParams.get('execution_id');
        if (!executionId) throw new TypeError('execution_id is required for execution insight queries');
        send(response, 200, await this.#executionInsight(experimentId, executionId));
        return;
      }
      if (parts[3] === 'materials' && parts.length >= 5) {
        const materialId = decodeURIComponent(parts[4]);
        send(response, 200, await this.#materialDetail(experimentId, materialId));
        return;
      }
      if (parts[3] === 'report') {
        send(response, 200, await this.#report(experiment));
        return;
      }
      send(response, 200, this.#summary(experiment));
      return;
    }
    if (parts[1] === 'executions' && parts.length >= 3) {
      const executionId = decodeURIComponent(parts[2]);
      const experimentId = url.searchParams.get('experiment_id');
      if (!experimentId) throw new TypeError('experiment_id is required for execution queries');
      const execution = this.taskService?.getExecution(executionId) ?? this.#executionFromEvents(experimentId, executionId);
      if (parts[3] === 'workspace') {
        if (!execution && !this.workspaceProvider && !this.workspaceManager) {
          send(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: `workspace is unavailable for execution: ${executionId}` } });
          return;
        }
        const projection = this.workspaceManager
          ? execution ? await this.#workspaceFromManager(execution) : null
          : await this.workspaceProvider.get({ experimentId, executionId, execution: execution ?? { execution_id: executionId } });
        if (!projection) {
          send(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: `workspace is unavailable for execution: ${executionId}` } });
          return;
        }
        send(response, 200, { execution, ...projection });
        return;
      }
      const events = this.observationStore.listEvents({
        ...this.#eventFilters(url), experimentId, executionId,
      });
      send(response, 200, { execution, ...events });
      return;
    }
    if (parts[1] === 'tasks' && parts.length >= 3 && this.taskService) {
      const taskId = decodeURIComponent(parts[2]);
      const task = this.taskService.getTask(taskId);
      if (!task) {
        send(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: `unknown task: ${taskId}` } });
        return;
      }
      send(response, 200, { task, executions: this.taskService.listExecutions(taskId) });
      return;
    }
    if (parts[1] === 'tasks' && parts.length >= 3) {
      const taskId = decodeURIComponent(parts[2]);
      const experimentId = url.searchParams.get('experiment_id');
      if (!experimentId) throw new TypeError('experiment_id is required for task queries');
      const events = this.observationStore.listEvents({ experimentId, taskId, limit: parseLimit(url.searchParams.get('limit'), 500) }).events;
      if (events.length === 0) {
        send(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: `unknown task: ${taskId}` } });
        return;
      }
      const executions = [...new Set(events.map((event: any) => event.execution_id).filter(Boolean))].map((executionId: any) => this.#executionFromEvents(experimentId, executionId));
      send(response, 200, { task: { task_id: taskId, state: this.#latestTaskState(events) }, executions, events });
      return;
    }
    if (parts[1] === 'context' && parts[2] === 'materials' && this.contextService) {
      send(response, 200, { materials: this.contextService.readMaterials(Object.fromEntries(url.searchParams.entries())) });
      return;
    }
    if (parts[1] === 'context' && parts[2] === 'materials') {
      const experimentId = url.searchParams.get('experiment_id');
      if (!experimentId) throw new TypeError('experiment_id is required for context material queries');
      const events = this.observationStore.listEvents({ experimentId, source: 'context-service', kinds: ['dispatch.complete'], limit: 1_000 }).events;
      const materials = events.flatMap((event: any) => {
        const material = event.payload?.result?.material ?? event.payload?.material ?? null;
        return material?.material_id ? [{ ...material, observed_at: event.occurred_at, source_event_id: event.event_id }] : [];
      }).filter((material: any, index: any, all: any) => all.findIndex((candidate: any) => candidate.material_id === material.material_id) === index);
      send(response, 200, { materials });
      return;
    }
    if (parts[1] === 'services') {
      send(response, 200, { services: listServices() });
      return;
    }
    send(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'unknown observability API route' } });
  }

  #eventFilters(url: any) {
    return {
      afterSequence: parseCursor(url.searchParams.get('after_sequence'), 0),
      coreId: url.searchParams.get('core_id') ?? null,
      sessionId: url.searchParams.get('session_id') ?? null,
      taskId: url.searchParams.get('task_id') ?? null,
      kinds: parseKinds(url.searchParams.get('kinds')),
      source: url.searchParams.get('source') ?? null,
      // The HTTP observer is also served through a public hostname. Keep the
      // generic event surface on the bounded Agent projection even when a
      // caller omits `view` (or tries to request the operator stream).
      view: 'agent',
      limit: parseLimit(url.searchParams.get('limit')),
    };
  }

  #eventsQuery(experimentId: any, url: any) {
    return this.observationStore.listEvents({ ...this.#eventFilters(url), experimentId, executionId: url.searchParams.get('execution_id') ?? null });
  }

  async #allEvents(options: any, maxPages: any = 20) {
    return (await this.#allEventsWithMeta(options, maxPages)).events;
  }

  async #allEventsWithMeta(options: any, maxPages: any = 20, maxEvents: any = Number.MAX_SAFE_INTEGER) {
    const events: any[] = [];
    let afterSequence = 0;
    let truncated = false;
    for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
      const page = this.observationStore.listEvents({ ...options, afterSequence, limit: 1_000 });
      const remaining = Math.max(0, maxEvents - events.length);
      events.push(...page.events.slice(0, remaining));
      if (page.events.length > remaining) {
        truncated = true;
        break;
      }
      if (!page.has_more || page.next_cursor === null) break;
      if (page.next_cursor <= afterSequence) break;
      afterSequence = page.next_cursor;
      if (events.length >= maxEvents) {
        truncated = true;
        break;
      }
      if (pageNumber === maxPages - 1) truncated = true;
    }
    return { events, truncated };
  }

  async #overview(experimentId: any, url: any) {
    const [events, entitySeeds, toolProjection] = await Promise.all([
      this.#recentEvents({
        experimentId,
        kinds: OVERVIEW_EVENT_KINDS,
        view: 'agent',
      }, OVERVIEW_RECENT_EVENTS),
      Promise.resolve(this.observationStore.listLatestEntityEvents({
        experimentId,
        kinds: OVERVIEW_EVENT_KINDS,
        view: 'agent',
        limit: OVERVIEW_ENTITY_SEEDS,
      }).events),
      this.#toolProjection(experimentId),
    ]);
    const overviewEvents = [...new Map<any, any>([...entitySeeds, ...events, ...toolProjection.events].map((event: any) => [event.event_id, event])).values()]
      .sort((left: any, right: any) => left.sequence - right.sequence);
    const bounded = boundOverviewEvents(compactOverviewEvents(overviewEvents));
    const latestSequence = this.observationStore.latestSequence(experimentId);
    return {
      experiment_id: experimentId,
      events: bounded.events,
      overview_bytes: bounded.bytes,
      overview_truncated: bounded.truncated,
      overview_history_truncated: latestSequence > OVERVIEW_RECENT_EVENTS,
      overview_start_sequence: overviewEvents.at(0)?.sequence ?? latestSequence,
      overview_end_sequence: latestSequence,
      overview_entity_seed_count: entitySeeds.length,
      timeline: this.#timeline(experimentId, url),
      tool_counts: toolProjection.counts,
      tool_counts_windowed: toolProjection.windowed,
    };
  }

  async #toolProjection(experimentId: any) {
    const events = await this.#recentEvents({ experimentId, kinds: ['rpc_record'], view: 'agent' }, OVERVIEW_RECENT_EVENTS);
    const calls = new Map<any, any>();
    const overviewEvents: any[] = [];
    for (const event of events) {
      const record = event.payload?.record;
      const toolName = dashboardToolName(record);
      if (!event.execution_id || !record || !OVERVIEW_RPC_RECORD_TYPES.has(record.type)) continue;
      const key = `${event.execution_id}:${toolCallId(record, event.sequence)}`;
      calls.set(key, event.execution_id);
      if (OVERVIEW_TOOL_NAMES.has(toolName) || OVERVIEW_TOOL_NAMES.has(rawToolName(record))) overviewEvents.push(event);
    }
    const counts: Record<string, any> = {};
    for (const executionId of calls.values()) counts[executionId] = (counts[executionId] ?? 0) + 1;
    return { counts, events: overviewEvents, windowed: this.observationStore.latestSequence(experimentId) > OVERVIEW_RECENT_EVENTS };
  }

  #recentEvents(options: any, limit: any = OVERVIEW_RECENT_EVENTS) {
    return this.observationStore.listRecentEvents({ ...options, limit }).events;
  }

  async #executionInsight(experimentId: any, executionId: any) {
    const events = await this.#allEvents({ experimentId, executionId, view: 'agent' });
    const insight: any = {
      execution_id: executionId,
      initial_prompt: null,
      task_instructions: null,
      task: null,
      workspace: null,
      tool_surface: [],
      observed_tools: [],
      bash_observed: false,
      source_events: events.length,
    };
    const tools = new Map<any, any>();
    const addCatalogTools = (details: any) => {
      const catalogTools = details?.tools ?? details;
      if (!Array.isArray(catalogTools)) return;
      catalogTools.forEach((tool: any) => {
        if (!tool?.name) return;
        insight.tool_surface.push(dashboardValue({
          name: tool.name,
          service: tool.service,
          operation: tool.operation,
          description: tool.description,
          scope: tool.scope,
          side_effect: tool.side_effect,
        }));
      });
    };
    for (const event of events) {
      const record = event.kind === 'rpc_record' ? event.payload?.record : null;
      const toolName = dashboardToolName(record);
      if (!toolName) continue;
      if (isToolStart(record) || isToolEnd(record)) {
        tools.set(toolName, true);
      }
      if (!isToolEnd(record)) continue;
      const details = toolDetails(record);
      if (!details || typeof details !== 'object') continue;
      if (toolName === 'swarmenv_task_view') {
        const task = details.task ?? details;
        if (task && typeof task === 'object') {
          insight.task = dashboardValue({
            task_id: task.task_id,
            owner_ref: task.owner_ref,
            goal: task.goal,
            expected_output: task.expected_output,
            priority: task.priority,
            task_instructions: task.task_instructions,
            workspace: task.workspace,
            acceptance_conditions: task.acceptance_conditions,
            input_material_refs: task.input_material_refs,
            state: task.state,
          });
          insight.task_instructions = dashboardValue(task.task_instructions ?? task.initial_prompt ?? null, 'task_instructions');
        }
      } else if (toolName === 'swarmenv_catalog_list_tools') {
        addCatalogTools(details);
      }
    }
    if (!insight.tool_surface.length) {
      const catalogEvents = await this.#allEvents({ experimentId, kinds: ['rpc_record'], view: 'agent' }, 2);
      for (const event of catalogEvents) {
        const record = event.payload?.record;
        if (isToolEnd(record) && dashboardToolName(record) === 'swarmenv_catalog_list_tools') addCatalogTools(toolDetails(record));
      }
    }
    insight.observed_tools = [...tools.keys()].sort();
    insight.bash_observed = insight.observed_tools.some((name: any) => /bash|shell|exec_command|terminal/i.test(name));
    const uniqueTools = new Map<any, any>(insight.tool_surface.map((tool: any) => [tool.name, tool]));
    insight.tool_surface = [...uniqueTools.values()].sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)));
    return insight;
  }

  async #executionDetail(experimentId: any, executionId: any) {
    const observed = await this.#allEventsWithMeta({ experimentId, executionId, view: 'agent' }, 200, DETAIL_MAX_EVENTS);
    const selected = observed.events.filter((event: any) => {
      if (event.kind === 'rpc_record') {
        return OVERVIEW_RPC_RECORD_TYPES.has(event.payload?.record?.type);
      }
      return EXECUTION_DETAIL_LIFECYCLE_KINDS.has(event.kind);
    });
    let bytes = 0;
    const events: any[] = [];
    let truncated = observed.truncated;
    for (const event of selected) {
      const payload = event.payload ?? {};
      const compact = {
        ...event,
        payload: payload.record ? { ...dashboardValue(payload), record: compactToolRecord(payload.record) } : dashboardValue(payload),
      };
      const size = Buffer.byteLength(JSON.stringify(compact));
      if (events.length >= DETAIL_MAX_EVENTS || bytes + size > DETAIL_MAX_BYTES) {
        truncated = true;
        break;
      }
      events.push(compact);
      bytes += size;
    }
    return {
      experiment_id: experimentId,
      execution_id: executionId,
      events,
      observed_events: observed.events.length,
      returned_events: events.length,
      truncated,
    };
  }

  async #taskDetail(experimentId: any, taskId: any) {
    const observed = await this.#allEventsWithMeta({ experimentId, taskId, view: 'agent' }, 200, DETAIL_MAX_EVENTS);
    const events = observed.events;
    if (!events.length) throw new Error(`unknown task: ${taskId}`);
    const fields: Record<string, any> = {};
    for (const event of events) {
      const payload = event.payload ?? {};
      const record = payload.record;
      const candidates = [payload.task, payload.result?.task];
      if (isToolEnd(record) && dashboardToolName(record) === 'swarmenv_task_view') {
        const result = record.result ?? {};
        const details = result.details ?? result.result ?? result;
        candidates.unshift(details?.task ?? details);
      }
      for (const candidate of candidates) {
        if (!candidate || typeof candidate !== 'object') continue;
        if (candidate.task_id && candidate.task_id !== taskId) continue;
        for (const [key, value] of Object.entries(candidate)) {
          if (value !== undefined) fields[key] = value;
        }
      }
    }
    fields.task_id ??= taskId;
    const safeFields = dashboardValue(fields);
    const executionIds = [...new Set(events.map((event: any) => event.execution_id).filter(Boolean))];
    return {
      task: { ...safeFields, fields: safeFields },
      executions: executionIds.map((executionId: any) => this.#executionFromEvents(experimentId, executionId)),
      observed_events: events.length,
      truncated: observed.truncated,
    };
  }

  async #materialDetail(experimentId: any, materialId: any) {
    const [contextEvents, agentProjection] = await Promise.all([
      this.#allEvents({
        experimentId,
        source: 'context-service',
        kinds: ['dispatch.complete'],
        view: 'operator',
      }, 20),
      // Imported experiments may not have Context Service envelopes. Their
      // durable Material records are still present inside bounded historical
      // context_publish tool results.
      this.#allEventsWithMeta({ experimentId, kinds: ['rpc_record'], view: 'operator' }, 100, 50_000),
    ]);
    const events = [...contextEvents, ...agentProjection.events].sort((left: any, right: any) => left.sequence - right.sequence);
    let material: any = null;
    let observedAt: any = null;
    let sourceEventId: any = null;
    for (const event of events) {
      const candidate = materialFromPayload(event.payload, materialId);
      if (candidate) {
        material = candidate;
        observedAt = event.occurred_at;
        sourceEventId = event.event_id;
      }
    }
    if (!material) return { material_id: materialId, available: false, fields: {}, content_summary: null, content_preview: null, raw: null };
    const parsedContent = parseJson(material.content_json ?? material.content);
    const content = parsedContent && typeof parsedContent === 'object' ? parsedContent : { value: parsedContent };
    const contentSummary = material.summary ?? material.description ?? content.summary ?? content.description ?? content.title ?? content.text ?? content.path ?? null;
    const fields = {
      material_id: material.material_id,
      title: material.title,
      media_type: material.media_type,
      version: material.version,
      producer_task_id: material.producer_task_id,
      producer_execution_id: material.producer_execution_id,
      supersedes: material.supersedes,
      created_at: material.created_at,
    };
    const advanced = {
      content_hash: material.content_hash,
      provenance_json: material.provenance_json,
      provenance: material.provenance,
      source_event_id: sourceEventId,
      observed_at: observedAt,
    };
    return {
      available: true,
      material_id: materialId,
      fields: dashboardValue(fields),
      content_summary: typeof contentSummary === 'string' ? dashboardValue(contentSummary, 'summary') : null,
      content_preview: dashboardValue(content, 'material_content'),
      advanced: dashboardValue(advanced),
    };
  }

  async #report(experiment: any) {
    const metadata = experiment.metadata ?? {};
    const reportPath = metadata.report_path;
    if (!reportPath) return { available: false, reason: 'No report_path was recorded for this Experiment.' };
    let report;
    try {
      report = JSON.parse(await readFile(reportPath, 'utf8'));
    } catch (error: any) {
      return { available: false, reason: `Report unavailable: ${error.message}`, source: basename(reportPath) };
    }
    const analysisCandidates = [
      join(dirname(reportPath), 'analysis'),
      join(dirname(dirname(reportPath)), 'analysis'),
      metadata.experiment_root ? join(metadata.experiment_root, 'analysis') : null,
    ].filter(Boolean);
    const analysis: any[] = [];
    for (const directory of analysisCandidates) {
      let entries;
      try { entries = await (await import('node:fs/promises')).readdir(directory!, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries.filter((candidate: any) => candidate.isFile() && /\.(md|txt)$/i.test(candidate.name))) {
        if (analysis.some((item: any) => item.name === entry.name)) continue;
        try {
          const content = await readFile(join(directory!, entry.name), 'utf8');
          analysis.push({ name: entry.name, content: content.length <= 80_000 ? content : `${content.slice(0, 80_000)}\n… [report truncated]` });
        } catch { /* report files can disappear while a run is being archived */ }
      }
    }
    return {
      available: true,
      source: basename(reportPath),
      summary: reportSummary(report),
      analysis,
      raw: dashboardValue({ protocol: report.protocol, run: report.run, parallelism: report.parallelism, audit: report.audit }),
    };
  }

  async #workspaceFromManager(execution: any) {
    const workspaceRef = execution.workspace_ref ?? this.workspaceManager.workspacePath(execution.execution_id);
    const workspace = await this.workspaceManager.restoreWorkspace({ workspaceRef, executionId: execution.execution_id });
    const [files, revisions] = await Promise.all([
      this.workspaceManager.listFiles({ workspaceRef, executionId: execution.execution_id }),
      this.workspaceManager.listRevisions({ workspaceRef, executionId: execution.execution_id }),
    ]);
    return { workspace, files: files.files, revisions };
  }

  #summary(experiment: any) {
    const metadata = experiment.metadata ?? {};
    return {
      ...experiment,
      metadata: {
        problem_id: metadata.problem_id ?? null,
        report_path: metadata.report_path ? basename(metadata.report_path) : null,
        repository_commit: metadata.repository_commit ?? null,
        core_count: metadata.core_count ?? null,
        elapsed_ms: metadata.elapsed_ms ?? null,
        solved: metadata.solved ?? null,
        protocol_valid: metadata.protocol_valid ?? null,
        made_progress: metadata.made_progress ?? null,
      },
      event_count: this.observationStore.countEvents(experiment.experiment_id),
      core_ids: this.observationStore.listCoreIds(experiment.experiment_id),
      latest_sequence: this.observationStore.latestSequence(experiment.experiment_id),
    };
  }

  #registryPayload(limit: any = 100) {
    this.observationStore.refresh?.();
    this.#startRegistryWatchers();
    const experiments = this.observationStore.listExperiments({ limit }).map((experiment: any) => this.#summary(experiment));
    return {
      revision: createHash('sha256').update(JSON.stringify(experiments)).digest('hex'),
      experiments,
    };
  }

  #emitRegistryPayload(payload: any) {
    const message = `event: experiments\ndata: ${json(payload)}\n\n`;
    for (const response of this.registryResponses) {
      if (response.destroyed || response.writableEnded) {
        this.registryResponses.delete(response);
        this.streamResponses.delete(response);
        continue;
      }
      try {
        response.write(message);
      } catch {
        response.destroy();
        this.registryResponses.delete(response);
        this.streamResponses.delete(response);
      }
    }
    const waiters = [...this.registryWaiters];
    this.registryWaiters.clear();
    for (const resolveWaiter of waiters) resolveWaiter(true);
  }

  #refreshRegistry() {
    if (this.registryResponses.size === 0 && this.registryWaiters.size === 0) return;
    try {
      const payload = this.#registryPayload();
      const key = payload.revision;
      if (key === this.registrySnapshotKey) return;
      this.registrySnapshotKey = key;
      this.#emitRegistryPayload(payload);
    } catch {
      // A short SQLite lock is normal while a benchmark writer commits. The
      // next filesystem notification will retry the snapshot.
    }
  }

  #scheduleRegistryRefresh() {
    if (this.registryRefreshTimer || (this.registryResponses.size === 0 && this.registryWaiters.size === 0)) return;
    this.registryRefreshTimer = setTimeout(() => {
      this.registryRefreshTimer = null;
      this.#refreshRegistry();
    }, 50);
    this.registryRefreshTimer.unref?.();
  }

  #startRegistryWatchers() {
    const paths = new Set(this.observationStore.watchPaths?.() ?? []);
    if (this.experimentRoot) {
      paths.add(this.experimentRoot);
      paths.add(join(this.experimentRoot, '.observability'));
    }
    if (this.observationStore.databasePath) paths.add(dirname(this.observationStore.databasePath));
    for (const path of paths) {
      if (!path || this.registryWatcherPaths.has(path)) continue;
      try {
        const watcher = watch(path as string, { persistent: false, recursive: true }, () => this.#scheduleRegistryRefresh());
        this.registryWatchers.push(watcher);
        this.registryWatcherPaths.add(path);
      } catch {
        try {
          const watcher = watch(path as string, { persistent: false }, () => this.#scheduleRegistryRefresh());
          this.registryWatchers.push(watcher);
          this.registryWatcherPaths.add(path);
        } catch {
          // The dashboard can still serve existing data when a root is removed
          // during experiment cleanup; a later server restart reattaches it.
        }
      }
    }
  }

  #registryStream(response: any) {
    this.streamResponses.add(response);
    this.registryResponses.add(response);
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    response.flushHeaders?.();
    response.write(': connected\n\n');
    try {
      const payload = this.#registryPayload();
      this.registrySnapshotKey = payload.revision;
      this.#emitRegistryPayload(payload);
    } catch {
      response.write('event: error\ndata: {"message":"registry temporarily unavailable"}\n\n');
    }
    const heartbeat = setInterval(() => response.write(': keep-alive\n\n'), 15_000);
    this.#ensureRegistryRescan();
    response.on('close', () => {
      clearInterval(heartbeat);
      this.registryResponses.delete(response);
      this.streamResponses.delete(response);
      this.#maybeStopRegistryRescan();
    });
  }

  #ensureRegistryRescan() {
    if (this.registryRescanTimer) return;
    this.registryRescanTimer = setInterval(() => this.#refreshRegistry(), 2_000);
    this.registryRescanTimer.unref?.();
  }

  #maybeStopRegistryRescan() {
    if (this.registryResponses.size !== 0 || this.registryWaiters.size !== 0 || !this.registryRescanTimer) return;
    clearInterval(this.registryRescanTimer);
    this.registryRescanTimer = null;
  }

  async #registryChanges(url: any, response: any) {
    const since = url.searchParams.get('since') ?? '';
    let payload = this.#registryPayload();
    if (!since || since !== payload.revision) {
      send(response, 200, { changed: true, ...payload });
      return;
    }
    this.#ensureRegistryRescan();
    const changed = await new Promise<any>((resolvePromise: any) => {
      let settled = false;
      const finish = (value: any) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.registryWaiters.delete(finish);
        this.#maybeStopRegistryRescan();
        resolvePromise(value);
      };
      const timer = setTimeout(() => finish(false), 25_000);
      this.registryWaiters.add(finish);
      response.on('close', () => finish(null));
    });
    if (changed === null || response.destroyed || response.writableEnded) return;
    payload = this.#registryPayload();
    send(response, 200, { changed: payload.revision !== since, ...payload });
    this.#maybeStopRegistryRescan();
  }

  #executionFromEvents(experimentId: any, executionId: any) {
    if (!experimentId) return null;
    const events = this.observationStore.listEvents({ experimentId, executionId, limit: 1_000 }).events;
    if (events.length === 0) return null;
    const latest = [...events].reverse();
    const stateEvent = latest.find((event: any) => event.kind === 'execution_released' || event.kind === 'core_state_changed' || event.payload?.state);
    const workspaceEvent = latest.find((event: any) => event.payload?.workspace_ref);
    return {
      execution_id: executionId,
      task_id: latest.find((event: any) => event.task_id)?.task_id ?? null,
      state: stateEvent?.payload?.state ?? 'UNKNOWN',
      session_id: latest.find((event: any) => event.session_id)?.session_id ?? null,
      workspace_ref: workspaceEvent?.payload?.workspace_ref ?? null,
      workspace_revision: workspaceEvent?.payload?.workspace_revision ?? null,
      workspace_content_hash: workspaceEvent?.payload?.workspace_content_hash ?? null,
      updated_at: latest[0].occurred_at,
    };
  }

  #latestTaskState(events: any) {
    const candidate = [...events].reverse().find((event: any) => event.payload?.result?.task?.state || event.payload?.task?.state || event.payload?.state);
    return candidate?.payload?.result?.task?.state ?? candidate?.payload?.task?.state ?? candidate?.payload?.state ?? 'UNKNOWN';
  }

  #latestTaskField(events: any, field: any) {
    const candidate = [...events].reverse().find((event: any) => event.payload?.result?.task?.[field] || event.payload?.task?.[field]);
    return candidate?.payload?.result?.task?.[field] ?? candidate?.payload?.task?.[field] ?? null;
  }

  #timeline(experimentId: any, url: any) {
    const filters = this.#eventFilters(url);
    const recentEvents = this.observationStore.listRecentEvents({
      experimentId,
      ...filters,
      kinds: ['core_state_changed', 'execution_assigned', 'execution_released'],
      limit: TIMELINE_RECENT_EVENTS,
    }).events;
    // A long-running Execution may have been assigned before the recent
    // window while still owning a Core. Seed that assignment and each Core's
    // latest state so the waterfall keeps showing active lanes without
    // replaying the full lifecycle history.
    const activeSeeds = this.observationStore.listActiveTimelineEvents({
      experimentId,
      view: 'agent',
      limit: TIMELINE_RECENT_EVENTS,
    }).events.filter((event: any) => event.sequence > filters.afterSequence);
    const events = [...new Map<any, any>([...activeSeeds, ...recentEvents].map((event: any) => [event.event_id, event])).values()]
      .filter((event: any) => !filters.coreId || event.core_id === filters.coreId)
      .filter((event: any) => !filters.sessionId || event.session_id === filters.sessionId)
      .filter((event: any) => !filters.taskId || event.task_id === filters.taskId)
      .filter((event: any) => !filters.source || event.source === filters.source)
      .sort((left: any, right: any) => left.sequence - right.sequence);
    const lanes = new Map<any, any>();
    for (const event of events) {
      if (!event.core_id) continue;
      if (!lanes.has(event.core_id)) lanes.set(event.core_id, { core_id: event.core_id, events: [], segments: [], states: [] });
      const lane = lanes.get(event.core_id);
      if (event.sequence > filters.afterSequence) lane.events.push(event);
      if (event.kind === 'core_state_changed') {
        const previous = [...lane.states].reverse().find((candidate: any) => candidate.ended_at === null);
        if (previous) previous.ended_at = event.occurred_at;
        const endedAt = Number.isFinite(event.payload?.ended_at_ms)
          ? new Date(event.payload.ended_at_ms).toISOString()
          : null;
        lane.states.push({
          state: event.payload?.state ?? 'UNKNOWN',
          reason: event.payload?.reason ?? null,
          task_id: event.task_id,
          execution_id: event.execution_id,
          started_at: event.occurred_at,
          ended_at: endedAt,
        });
      } else if (event.kind === 'execution_assigned') {
        lane.segments.push({
          execution_id: event.execution_id,
          task_id: event.task_id,
          session_id: event.session_id,
          started_at: event.occurred_at,
          ended_at: null,
          state: 'RUNNING',
        });
      } else if (event.kind === 'execution_released') {
        const segment = [...lane.segments].reverse().find((candidate: any) => candidate.execution_id === event.execution_id && candidate.ended_at === null);
        if (segment) {
          segment.ended_at = event.occurred_at;
          segment.state = event.payload?.state ?? 'RELEASED';
        }
      }
    }
    return { experiment_id: experimentId, lanes: [...lanes.values()] };
  }

  #stream(experimentId: any, response: any, url: any) {
    this.streamResponses.add(response);
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    response.flushHeaders?.();
    response.write(': connected\n\n');
    let cursor = parseCursor(url.searchParams.get('after_sequence'), 0);
    const view = 'agent';
    const overview = url.searchParams.get('overview') === '1';
    const kinds = overview ? OVERVIEW_EVENT_KINDS : null;
    const emit = (event: any) => {
      response.write(`event: observation\ndata: ${json(overview ? compactOverviewEvent(event) : event)}\n\n`);
      cursor = Math.max(cursor, event.sequence);
    };
    for (const event of this.observationStore.listEvents({ experimentId, afterSequence: cursor, view, kinds, limit: 1_000 }).events) emit(event);
    // The writer is usually a different process from this long-lived server.
    // Polling the WAL-backed store keeps SSE useful across process boundaries;
    // the in-process EventEmitter alone would miss those events.
    const poll = setInterval(() => {
      try {
        for (const event of this.observationStore.listEvents({ experimentId, afterSequence: cursor, view, kinds, limit: 1_000 }).events) emit(event);
      } catch {
        // A reconnect will retry the cursor if the backing store is briefly busy.
      }
    }, 250);
    const heartbeat = setInterval(() => response.write(': keep-alive\n\n'), 15_000);
    response.on('close', () => {
      clearInterval(poll);
      clearInterval(heartbeat);
      this.streamResponses.delete(response);
    });
  }
}

export function createObservabilityServer(options: any) {
  return new ObservabilityServer(options);
}

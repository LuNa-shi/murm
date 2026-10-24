import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { listServices } from '../sdk/service-catalog.js';

const PUBLIC_ROOT = fileURLToPath(new URL('./public/', import.meta.url));

function json(value) {
  return JSON.stringify(value ?? null);
}

function send(response, status, body) {
  const content = json(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(content),
  });
  response.end(content);
}

function errorBody(error) {
  return { code: error?.code ?? 'OBSERVABILITY_ERROR', message: error?.message ?? String(error) };
}

function parseLimit(value, fallback = 100) {
  if (value === null || value === undefined || value === '') return fallback;
  const limit = Number(value);
  if (!Number.isInteger(limit)) throw new TypeError('limit must be an integer');
  return limit;
}

function parseCursor(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const cursor = Number(value);
  if (!Number.isInteger(cursor) || cursor < 0) throw new TypeError('after_sequence must be a non-negative integer');
  return cursor;
}

function parseKinds(value) {
  if (!value) return null;
  return value.split(',').map((kind) => kind.trim()).filter(Boolean);
}

function contentType(path) {
  const extension = path === '/' ? '.html' : extname(path);
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
  }[extension] ?? 'application/octet-stream';
}

async function readStatic(path) {
  const safePath = path === '/' ? 'index.html' : path.slice(1);
  if (!safePath || safePath.includes('..') || safePath.includes('\\')) return null;
  try {
    return await readFile(join(PUBLIC_ROOT, safePath));
  } catch {
    return null;
  }
}

/**
 * Small local operator server for the Observation Store. It deliberately
 * keeps the HTTP surface read-only; Task and Context mutations stay behind
 * their existing Service boundaries.
 */
export class ObservabilityServer {
  constructor({ observationStore, taskService = null, contextService = null, workspaceManager = null, workspaceProvider = null, host = '127.0.0.1', advertiseHost = null } = {}) {
    if (!observationStore) throw new TypeError('ObservabilityServer requires observationStore');
    this.observationStore = observationStore;
    this.taskService = taskService;
    this.contextService = contextService;
    this.workspaceManager = workspaceManager;
    this.workspaceProvider = workspaceProvider;
    this.host = host;
    this.advertiseHost = advertiseHost;
    this.server = null;
    this.addressValue = null;
    this.streamResponses = new Set();
  }

  async start({ port = 0 } = {}) {
    if (this.server) return this.address();
    this.server = createServer((request, response) => {
      void this.#handle(request, response);
    });
    this.server.listen(port, this.host);
    await once(this.server, 'listening');
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('observability server did not receive an address');
    this.addressValue = address;
    return this.address();
  }

  address() {
    if (!this.addressValue) throw new Error('ObservabilityServer has not been started');
    const publicHost = this.advertiseHost ?? this.host;
    return {
      host: this.host,
      advertise_host: this.advertiseHost,
      port: this.addressValue.port,
      url: `http://${publicHost}:${this.addressValue.port}`,
    };
  }

  async stop() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.addressValue = null;
    for (const response of this.streamResponses) response.destroy();
    this.streamResponses.clear();
    server.close();
    await once(server, 'close').catch(() => undefined);
  }

  async #handle(request, response) {
    try {
      const url = new URL(request.url ?? '/', `http://${this.host}`);
      if (request.method === 'GET' && url.pathname === '/health') {
        send(response, 200, { ok: true, service: 'swarmenv-observability' });
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
      const content = await readStatic(url.pathname);
      if (!content) {
        send(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'unknown observability route' } });
        return;
      }
      response.writeHead(200, { 'content-type': contentType(url.pathname), 'cache-control': 'no-store' });
      response.end(content);
    } catch (error) {
      if (!response.headersSent) send(response, 400, { ok: false, error: errorBody(error) });
      else response.end();
    }
  }

  async #api(url, response) {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[1] === 'experiments' && parts.length === 2) {
      const experiments = this.observationStore.listExperiments({ limit: parseLimit(url.searchParams.get('limit')) });
      send(response, 200, { experiments: experiments.map((experiment) => this.#summary(experiment)) });
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
      if (parts[3] === 'stream') {
        this.#stream(experimentId, response, url);
        return;
      }
      if (parts[3] === 'timeline') {
        send(response, 200, this.#timeline(experimentId, url));
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
      send(response, 200, { task, children: this.taskService.listChildren(taskId), executions: this.taskService.listExecutions(taskId) });
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
      const executions = [...new Set(events.map((event) => event.execution_id).filter(Boolean))].map((executionId) => this.#executionFromEvents(experimentId, executionId));
      send(response, 200, { task: { task_id: taskId, state: this.#latestTaskState(events), task_type: this.#latestTaskField(events, 'task_type') }, children: [], executions, events });
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
      const materials = events.flatMap((event) => {
        const material = event.payload?.result?.material ?? event.payload?.material ?? null;
        return material?.material_id ? [{ ...material, observed_at: event.occurred_at, source_event_id: event.event_id }] : [];
      }).filter((material, index, all) => all.findIndex((candidate) => candidate.material_id === material.material_id) === index);
      send(response, 200, { materials });
      return;
    }
    if (parts[1] === 'services') {
      send(response, 200, { services: listServices() });
      return;
    }
    send(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'unknown observability API route' } });
  }

  #eventFilters(url) {
    return {
      afterSequence: parseCursor(url.searchParams.get('after_sequence'), 0),
      coreId: url.searchParams.get('core_id') ?? null,
      sessionId: url.searchParams.get('session_id') ?? null,
      taskId: url.searchParams.get('task_id') ?? null,
      kinds: parseKinds(url.searchParams.get('kinds')),
      source: url.searchParams.get('source') ?? null,
      view: url.searchParams.get('view') === 'agent' ? 'agent' : 'operator',
      limit: parseLimit(url.searchParams.get('limit')),
    };
  }

  #eventsQuery(experimentId, url) {
    return this.observationStore.listEvents({ ...this.#eventFilters(url), experimentId, executionId: url.searchParams.get('execution_id') ?? null });
  }

  async #workspaceFromManager(execution) {
    const workspaceRef = execution.workspace_ref ?? this.workspaceManager.workspacePath(execution.execution_id);
    const workspace = await this.workspaceManager.restoreWorkspace({ workspaceRef, executionId: execution.execution_id });
    const [files, revisions] = await Promise.all([
      this.workspaceManager.listFiles({ workspaceRef, executionId: execution.execution_id }),
      this.workspaceManager.listRevisions({ workspaceRef, executionId: execution.execution_id }),
    ]);
    return { workspace, files: files.files, revisions };
  }

  #summary(experiment) {
    return {
      ...experiment,
      event_count: this.observationStore.countEvents(experiment.experiment_id),
      core_ids: this.observationStore.listEvents({ experimentId: experiment.experiment_id, limit: 1_000 }).events
        .map((event) => event.core_id).filter(Boolean).filter((id, index, ids) => ids.indexOf(id) === index),
    };
  }

  #executionFromEvents(experimentId, executionId) {
    if (!experimentId) return null;
    const events = this.observationStore.listEvents({ experimentId, executionId, limit: 1_000 }).events;
    if (events.length === 0) return null;
    const latest = [...events].reverse();
    const stateEvent = latest.find((event) => event.kind === 'execution_released' || event.kind === 'core_state_changed' || event.payload?.state);
    const workspaceEvent = latest.find((event) => event.payload?.workspace_ref);
    return {
      execution_id: executionId,
      task_id: latest.find((event) => event.task_id)?.task_id ?? null,
      state: stateEvent?.payload?.state ?? 'UNKNOWN',
      session_id: latest.find((event) => event.session_id)?.session_id ?? null,
      workspace_ref: workspaceEvent?.payload?.workspace_ref ?? null,
      workspace_revision: workspaceEvent?.payload?.workspace_revision ?? null,
      workspace_content_hash: workspaceEvent?.payload?.workspace_content_hash ?? null,
      updated_at: latest[0].occurred_at,
    };
  }

  #latestTaskState(events) {
    const candidate = [...events].reverse().find((event) => event.payload?.result?.task?.state || event.payload?.task?.state || event.payload?.state);
    return candidate?.payload?.result?.task?.state ?? candidate?.payload?.task?.state ?? candidate?.payload?.state ?? 'UNKNOWN';
  }

  #latestTaskField(events, field) {
    const candidate = [...events].reverse().find((event) => event.payload?.result?.task?.[field] || event.payload?.task?.[field]);
    return candidate?.payload?.result?.task?.[field] ?? candidate?.payload?.task?.[field] ?? null;
  }

  #timeline(experimentId, url) {
    const filters = this.#eventFilters(url);
    const events = this.observationStore.listEvents({
      experimentId,
      ...filters,
      kinds: ['core_state_changed', 'execution_assigned', 'execution_released'],
      limit: 1_000,
    }).events;
    const lanes = new Map();
    for (const event of events) {
      if (!event.core_id) continue;
      if (!lanes.has(event.core_id)) lanes.set(event.core_id, { core_id: event.core_id, events: [], segments: [], states: [] });
      const lane = lanes.get(event.core_id);
      lane.events.push(event);
      if (event.kind === 'core_state_changed') {
        const previous = [...lane.states].reverse().find((candidate) => candidate.ended_at === null);
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
        const segment = [...lane.segments].reverse().find((candidate) => candidate.execution_id === event.execution_id && candidate.ended_at === null);
        if (segment) {
          segment.ended_at = event.occurred_at;
          segment.state = event.payload?.state ?? 'RELEASED';
        }
      }
    }
    return { experiment_id: experimentId, lanes: [...lanes.values()] };
  }

  #stream(experimentId, response, url) {
    this.streamResponses.add(response);
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    response.flushHeaders?.();
    response.write(': connected\n\n');
    let cursor = parseCursor(url.searchParams.get('after_sequence'), 0);
    const view = url.searchParams.get('view') === 'agent' ? 'agent' : 'operator';
    const emit = (event) => {
      response.write(`event: observation\ndata: ${json(event)}\n\n`);
      cursor = Math.max(cursor, event.sequence);
    };
    for (const event of this.observationStore.listEvents({ experimentId, afterSequence: cursor, view, limit: 1_000 }).events) emit(event);
    // The writer is usually a different process from this long-lived server.
    // Polling the WAL-backed store keeps SSE useful across process boundaries;
    // the in-process EventEmitter alone would miss those events.
    const poll = setInterval(() => {
      try {
        for (const event of this.observationStore.listEvents({ experimentId, afterSequence: cursor, view, limit: 1_000 }).events) emit(event);
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

export function createObservabilityServer(options) {
  return new ObservabilityServer(options);
}

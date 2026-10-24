import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, dirname, extname, join } from 'node:path';
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

const DASHBOARD_SECRET_KEY = /(?:authorization|api[_-]?key|access[_-]?token|password|private[_-]?key|credential|bearer|cookie|secret|(?:^|[_-])token(?:$|[_-]))/i;
const DASHBOARD_MAX_STRING = 8_000;
const DASHBOARD_MAX_ARRAY = 100;

function parseJson(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  try { return JSON.parse(value); } catch { return value; }
}

function dashboardValue(value, key = '', depth = 0) {
  if (DASHBOARD_SECRET_KEY.test(String(key))) return '[redacted]';
  if (typeof value === 'string') return value.length <= DASHBOARD_MAX_STRING ? value : `${value.slice(0, DASHBOARD_MAX_STRING)}\n… [display truncated]`;
  if (depth > 7) return '[nested value truncated]';
  if (Array.isArray(value)) {
    const items = value.slice(0, DASHBOARD_MAX_ARRAY).map((item) => dashboardValue(item, '', depth + 1));
    if (value.length > DASHBOARD_MAX_ARRAY) items.push(`[${value.length - DASHBOARD_MAX_ARRAY} array items truncated]`);
    return items;
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, dashboardValue(child, childKey, depth + 1)]));
}

function nestedValue(value, keys, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 6) return null;
  for (const key of keys) if (value[key] !== undefined && value[key] !== null) return value[key];
  for (const child of Object.values(value)) {
    const found = nestedValue(child, keys, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function materialFromPayload(value, materialId, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 7) return null;
  if (value.material_id === materialId) return value;
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = materialFromPayload(child, materialId, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const child of Object.values(value)) {
    const found = materialFromPayload(child, materialId, depth + 1);
    if (found) return found;
  }
  return null;
}

function toolDetails(record) {
  return record?.result?.details ?? record?.result?.result ?? record?.result ?? null;
}

function reportSummary(report) {
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
    claim_count: run.claim_count ?? null,
    child_claim_count: run.child_claim_count ?? null,
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
    task_tree: (project.task_tree ?? []).map((task) => ({
      task_id: task.task_id,
      parent_id: task.parent_id ?? null,
      task_type: task.task_type ?? null,
      goal: task.goal ?? null,
      state: task.state ?? task.task_state ?? null,
    })),
    cores: (report.cores ?? []).map((core) => ({
      core: core.core,
      task_id: core.task_id ?? null,
      execution_id: core.execution_id ?? null,
      task_state: core.task_state ?? null,
      execution_state: core.execution_state ?? null,
      tool_events: core.tool_events ?? [],
      tool_errors: core.tool_errors ?? [],
      workspace_writes: core.workspace_writes?.length ?? 0,
      checks: (core.checks ?? []).map((check) => ({
        verdict: check.verdict ?? check.status ?? null,
        checker_ref: check.checker_ref ?? null,
        error_class: check.error_class ?? null,
      })),
    })),
  };
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

  async #allEvents(options, maxPages = 20) {
    const events = [];
    let afterSequence = 0;
    for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
      const page = this.observationStore.listEvents({ ...options, afterSequence, limit: 1_000 });
      events.push(...page.events);
      if (!page.has_more || page.next_cursor === null) break;
      if (page.next_cursor <= afterSequence) break;
      afterSequence = page.next_cursor;
    }
    return events;
  }

  async #executionInsight(experimentId, executionId) {
    const events = await this.#allEvents({ experimentId, executionId, view: 'operator' });
    const insight = {
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
    const tools = new Map();
    const addCatalogTools = (details) => {
      const catalogTools = details?.tools ?? details;
      if (!Array.isArray(catalogTools)) return;
      catalogTools.forEach((tool) => {
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
      if (!record?.toolName) continue;
      if (record.type === 'tool_execution_start' || record.type === 'tool_execution_end') {
        tools.set(record.toolName, true);
      }
      if (record.type !== 'tool_execution_end') continue;
      const details = toolDetails(record);
      if (!details || typeof details !== 'object') continue;
      if (record.toolName === 'swarmenv_task_get') {
        const task = details.task ?? details;
        if (task && typeof task === 'object') {
          insight.task = dashboardValue({
            task_id: task.task_id,
            root_id: task.root_id,
            parent_id: task.parent_id,
            owner_ref: task.owner_ref,
            task_type: task.task_type,
            task_type_version: task.task_type_version,
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
      } else if (record.toolName === 'swarmenv_execution_get') {
        const execution = details.execution ?? details;
        if (execution && typeof execution === 'object') {
          insight.initial_prompt = dashboardValue(execution.agent_prompt ?? execution.initial_prompt ?? null, 'agent_prompt');
          insight.workspace = dashboardValue({
            workspace_manifest_ref: execution.workspace_manifest_ref,
            workspace_ref: execution.workspace_ref,
            workspace_revision: execution.workspace_revision,
            workspace_content_hash: execution.workspace_content_hash,
            input_snapshot_hash: execution.input_snapshot_hash,
            input_material_refs: execution.input_material_refs,
            workspace_selection: execution.workspace_selection,
            checkpoint_ref: execution.checkpoint_ref,
            parent_workspace_ref: execution.workspace_selection?.source_workspace_ref,
          });
        }
      } else if (record.toolName === 'swarmenv_catalog_list_tools') {
        addCatalogTools(details);
      }
    }
    if (!insight.tool_surface.length) {
      const catalogEvents = await this.#allEvents({ experimentId, kinds: ['rpc_record'], view: 'operator' }, 2);
      for (const event of catalogEvents) {
        const record = event.payload?.record;
        if (record?.type === 'tool_execution_end' && record.toolName === 'swarmenv_catalog_list_tools') addCatalogTools(toolDetails(record));
      }
    }
    insight.observed_tools = [...tools.keys()].sort();
    insight.bash_observed = insight.observed_tools.some((name) => /bash|shell|exec_command|terminal/i.test(name));
    const uniqueTools = new Map(insight.tool_surface.map((tool) => [tool.name, tool]));
    insight.tool_surface = [...uniqueTools.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return insight;
  }

  async #materialDetail(experimentId, materialId) {
    const events = await this.#allEvents({
      experimentId,
      source: 'context-service',
      kinds: ['dispatch.complete'],
      view: 'operator',
    });
    let material = null;
    let observedAt = null;
    let sourceEventId = null;
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
      kind: material.kind,
      scope: material.scope,
      evidence_state: material.evidence_state,
      version: material.version,
      source_task: material.source_task,
      source_execution: material.source_execution,
      supersedes: material.supersedes,
      created_at: material.created_at,
      content_ref: material.content_ref,
    };
    const advanced = {
      content_hash: material.content_hash,
      provenance_json: material.provenance_json,
      provenance: material.provenance,
      content_ref: material.content_ref,
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

  async #report(experiment) {
    const metadata = experiment.metadata ?? {};
    const reportPath = metadata.report_path;
    if (!reportPath) return { available: false, reason: 'No report_path was recorded for this Experiment.' };
    let report;
    try {
      report = JSON.parse(await readFile(reportPath, 'utf8'));
    } catch (error) {
      return { available: false, reason: `Report unavailable: ${error.message}`, source: basename(reportPath) };
    }
    const analysisCandidates = [
      join(dirname(reportPath), 'analysis'),
      join(dirname(dirname(reportPath)), 'analysis'),
      metadata.experiment_root ? join(metadata.experiment_root, 'analysis') : null,
    ].filter(Boolean);
    const analysis = [];
    for (const directory of analysisCandidates) {
      let entries;
      try { entries = await (await import('node:fs/promises')).readdir(directory, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries.filter((candidate) => candidate.isFile() && /\.(md|txt)$/i.test(candidate.name))) {
        if (analysis.some((item) => item.name === entry.name)) continue;
        try {
          const content = await readFile(join(directory, entry.name), 'utf8');
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

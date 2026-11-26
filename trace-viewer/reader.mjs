import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { constants } from 'node:fs';
import { open, realpath, lstat, readdir } from 'node:fs/promises';
import { resolve, relative, join, basename, isAbsolute, sep } from 'node:path';

const version = 1;
const maxLineBytes = 8 * 1024 * 1024;
const maxBodyBytes = 1024 * 1024;
const missing = error => error.code === 'ENOENT' || error.code === 'ENOTDIR';
const identity = record => record.agentId ?? record.botId ?? record.caller?.agentId ?? record.caller?.botId;
const recordId = source => Buffer.from(`${source.path}\0${source.offset}`).toString('base64url');
const inside = (root, path) => path === root || path.startsWith(root + sep);

function failure(message, status = 400) {
  return Object.assign(new Error(message), { status, statusCode: status });
}

/** Reads only files under a configured root, including after an open races with a rename. */
async function safeOpen(root, name) {
  if (typeof name !== 'string' || name.includes('\0') || isAbsolute(name)) throw failure('Expected a relative Run path');
  const target = resolve(root, name);
  if (!inside(root, target)) throw failure('Path escapes the Run directory', 403);
  let current = root;
  for (const part of relative(root, target).split(sep).filter(Boolean)) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw failure('Symbolic links are outside the read boundary', 403);
  }
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const openedPath = await realpath(`/proc/self/fd/${handle.fd}`);
    if (!inside(root, openedPath)) throw failure('Opened file escapes the Run directory', 403);
    const stat = await handle.stat();
    if (!stat.isFile()) throw failure('Expected a regular file');
    if (stat.nlink > 1) throw failure('Hard links are outside the read boundary', 403);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readBytes(root, path, offset = 0, length = maxBodyBytes) {
  const handle = await safeOpen(root, path);
  try {
    const total = (await handle.stat()).size;
    const buffer = Buffer.alloc(Math.max(0, Math.min(length, total - offset)));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    return { text: buffer.subarray(0, bytesRead).toString('utf8'), total, bytesRead };
  } finally { await handle.close(); }
}

async function readJSON(root, path) {
  try {
    const data = await readBytes(root, path, 0, maxLineBytes);
    if (data.total > maxLineBytes) throw failure('Metadata exceeds the 8 MiB read limit');
    return JSON.parse(data.text);
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

function encodeCursor(positions) {
  return deflateRawSync(Buffer.from(JSON.stringify({ v: version, positions }))).toString('base64url');
}

function decodeCursor(value) {
  if (!value) return {};
  if (typeof value !== 'string' || value.length > 2 * 1024 * 1024) throw failure('Invalid cursor');
  try {
    const cursor = JSON.parse(inflateRawSync(Buffer.from(value, 'base64url'), { maxOutputLength: 2 * 1024 * 1024 }).toString());
    if (cursor.v !== version || !cursor.positions || Array.isArray(cursor.positions)) throw Error();
    for (const [path, offset] of Object.entries(cursor.positions)) {
      if (typeof path !== 'string' || !Number.isSafeInteger(offset) || offset < 0) throw Error();
    }
    return cursor.positions;
  } catch { throw failure('Invalid cursor'); }
}

/** A rebuildable metadata index. Bodies remain in the source Run and load on demand. */
class RunIndex {
  constructor(path, id) {
    this.path = path;
    this.id = id;
    this.sources = new Map();
    this.byId = new Map();
    this.agents = new Map();
    this.gaps = [];
    this.gapKeys = new Set();
    this.spans = [];
    this.relations = [];
    this.serviceStarts = new Map();
    this.nativeStarts = new Map();
    this.files = new Map();
    this.modelDirectories = new Map();
    this.total = 0;
    this.hasNative = false;
    this.bytesRead = 0;
    this.updateQueue = Promise.resolve();
  }

  gap(kind, message, extra = {}) {
    const key = JSON.stringify([kind, message, extra]);
    if (!this.gapKeys.has(key)) {
      this.gapKeys.add(key);
      this.gaps.push({ kind, message, ...extra });
    }
  }

  agent(id) {
    if (!id) return undefined;
    if (!this.agents.has(id)) this.agents.set(id, { id, label: id, execution: 'unknown', cleanup: 'unknown', inputs: 'unknown' });
    return this.agents.get(id);
  }

  add(record, source, overrides = {}) {
    const agentId = overrides.agentId ?? identity(record);
    const eventType = record.eventType ?? record.event?.type;
    const kind = overrides.kind ?? (record.type === 'native' ? (eventType?.startsWith('tool_') ? 'tool' : 'execution') : record.type ?? 'service');
    const time = record.workerAt ?? record.at ?? record.startedAt ?? record.timestamp;
    const sessionTools = overrides.kind === 'session' && (record.message?.role === 'toolResult' ||
      Array.isArray(record.message?.content) && record.message.content.some(item => item?.type === 'toolCall'));
    const event = { id: recordId(source), agentId, kind, type: record.type ?? kind, time,
      label: record.operation ?? eventType ?? (overrides.kind === 'session' && record.message?.role ? `Session ${record.message.role}` : record.type ?? kind),
      status: record.state ?? record.phase ?? record.event?.type ?? 'recorded', source,
      requestId: record.requestId, inputId: record.inputId, operationId: record.operationId ?? record.operation_id,
      ...overrides };
    if (sessionTools) {
      event.kind = 'tool';
      event.label = record.message.toolName ?? (Array.isArray(record.message.content) ? record.message.content.filter(item => item?.type === 'toolCall').map(item => item.name).join(', ') : 'Tool result');
      event.status = record.message.role === 'toolResult' ? (record.message.isError ? 'failed' : 'returned') : 'recorded-call';
    }
    this.byId.set(event.id, event);
    this.sources.get(source.path).events.push(event);
    this.total++;
    if (event.time && (!this.startedAt || event.time < this.startedAt)) this.startedAt = event.time;
    if (event.time && (!this.endedAt || event.time > this.endedAt)) this.endedAt = event.time;
    const agent = this.agent(agentId);
    if (record.type === 'spawn' && agent) {
      if (record.profile) agent.profile = record.profile;
      if (record.parentId) agent.parentId = record.parentId;
      if (record.state === 'ready') agent.ready = true;
    }
    if (record.type === 'input' && agent) agent.inputs = record.state;
    if (record.type === 'stop' && agent && record.receipt) {
      agent.execution = record.receipt.execution ?? 'unknown';
      agent.cleanup = record.receipt.cleanup ?? 'unknown';
    }
    if (record.type === 'native') {
      this.hasNative = true;
      this.native(record, event);
    }
    if (record.type === 'trace-gap') this.gap('trace-gap', 'Worker native event sequence has a gap', { evidenceId: event.id });
    if (source.path === 'service-calls.jsonl') this.service(record, event);
    return event;
  }

  native(record, event) {
    const type = record.eventType;
    const agent = this.agent(event.agentId);
    const key = type?.startsWith('tool_') ? `${event.agentId}:tool:${record.event?.toolCallId}` : `${event.agentId}:execution`;
    if (type === 'agent_start' || type === 'tool_execution_start') {
      this.nativeStarts.set(key, event);
      if (type === 'agent_start') agent.execution = 'running';
    }
    if (type === 'agent_settled' || type === 'tool_execution_end') {
      const start = this.nativeStarts.get(key);
      if (start) {
        this.spans.push({ id: start.id, agentId: event.agentId, kind: event.kind,
          label: record.event?.toolName ?? event.label, startedAt: start.time, endedAt: event.time,
          status: record.event?.isError ? 'failed' : 'settled', evidenceIds: [start.id, event.id] });
        this.nativeStarts.delete(key);
      } else this.gap('missing-boundary', 'Execution or tool end has no recorded start', { evidenceId: event.id });
      if (type === 'agent_settled') agent.execution = 'settled';
    }
  }

  service(record, event) {
    const key = JSON.stringify([event.agentId, record.service, record.operation, event.operationId, record.attemptId]);
    if (record.phase === 'started') this.serviceStarts.set(key, { event, input: record.input });
    if (record.phase !== 'settled') return;
    const start = this.serviceStarts.get(key);
    if (start) {
      this.spans.push({ id: start.event.id, agentId: event.agentId, kind: 'service', label: `${record.service}.${record.operation}`,
        startedAt: record.startedAt, endedAt: record.endedAt, status: record.error ? 'failed' : 'settled', evidenceIds: [start.event.id, event.id] });
      this.serviceStarts.delete(key);
    }
    const input = start?.input ?? record.input;
    const output = record.output;
    if (record.operation === 'spawn_agent' && (output?.agentId || output?.botId)) {
      const child = this.agent(output.agentId ?? output.botId);
      child.parentId = event.agentId;
      child.label = output.task_name ?? child.label;
      this.relations.push({ id: event.id, kind: 'spawn', fromAgentId: event.agentId, toAgentId: child.id,
        time: record.endedAt, evidenceIds: [start?.event.id, event.id].filter(Boolean), inputId: output.inputId });
    }
    if (['send_message', 'followup_task'].includes(record.operation) && input?.target && !record.error) {
      this.relations.push({ id: event.id, kind: 'message', fromAgentId: event.agentId, target: input.target,
        time: record.endedAt, evidenceIds: [start?.event.id, event.id].filter(Boolean), messageId: output?.messageId });
    }
  }

  async jsonl(path, kind, agentId) {
    let handle;
    try { handle = await safeOpen(this.path, path); }
    catch (error) { if (missing(error)) return; throw error; }
    try {
      const stat = await handle.stat();
      let source = this.sources.get(path);
      if (!source) {
        source = { path, position: 0, line: 0, events: [], inode: stat.ino, lastSeq: 0 };
        this.sources.set(path, source);
      }
      if (source.position > stat.size || source.inode !== stat.ino) {
        this.gap('source-replaced', 'A source file was truncated or replaced. Reopen the Viewer to rebuild its index', { path });
        return;
      }
      let position = source.position;
      let pending = Buffer.alloc(0);
      while (position < stat.size) {
        const bytes = Buffer.alloc(Math.min(65536, stat.size - position));
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, position);
        if (!bytesRead) break;
        this.bytesRead += bytesRead;
        position += bytesRead;
        pending = Buffer.concat([pending, bytes.subarray(0, bytesRead)]);
        let newline;
        while ((newline = pending.indexOf(10)) !== -1) {
          const length = newline + 1;
          const offset = source.position;
          source.position += length;
          source.line++;
          const line = pending.subarray(0, newline).toString('utf8');
          pending = pending.subarray(length);
          if (!line.trim()) continue;
          try {
            const record = JSON.parse(line);
            if (Number.isInteger(record.seq)) {
              if (record.seq !== source.lastSeq + 1) this.gap('sequence-gap', 'Source record sequence has a gap', { path, expected: source.lastSeq + 1, observed: record.seq });
              source.lastSeq = record.seq;
            }
            this.add(record, { path, offset, length, line: source.line }, { ...(kind ? {kind} : {}), ...(agentId ? {agentId} : {}) });
          } catch (error) {
            this.gap('invalid-record', 'A complete JSONL record could not be decoded', { path, line: source.line });
          }
        }
        if (pending.length > maxLineBytes) {
          this.gap('record-limit', 'A JSONL record exceeds the 8 MiB read limit', { path, offset: source.position });
          break;
        }
      }
    } finally { await handle.close(); }
  }

  async models() {
    let entries;
    try { entries = await readdir(join(this.path, 'model-trace'), { withFileTypes: true }); }
    catch (error) { if (missing(error)) return; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const name = `model-trace/${entry.name}/request.json`;
      let model = this.modelDirectories.get(entry.name);
      if (!model) {
        let data;
        try { data = await readBytes(this.path, name, 0, 65536); }
        catch (error) { if (missing(error)) continue; throw error; }
        // Core v1 writes identity and timestamp before the potentially large request body.
        const header = data.text.split('"before":')[0];
        const field = key => { try { return JSON.parse(new RegExp(`"${key}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`).exec(header)?.[1] ?? 'null'); } catch { return undefined; } };
        const agentId = field('agentId') ?? field('botId');
        const record = { type: 'model', agentId, requestId: field('requestId') ?? entry.name, startedAt: field('startedAt') };
        const source = { path: name, offset: 0, length: data.total };
        this.sources.set(name, { path: name, position: data.total, events: [] });
        const event = this.add(record, source, { kind: 'model', label: 'Model request', status: 'running', startedAt: record.startedAt });
        model = { event, directory: entry.name };
        this.modelDirectories.set(entry.name, model);
        this.files.set(name, { path: name, kind: 'model', agentId, bytes: data.total });
        for (const companion of ['response.txt', 'result.json']) {
          const path = `model-trace/${entry.name}/${companion}`;
          this.files.set(path, { path, kind: 'model', agentId });
        }
      }
      if (!model.finished) {
        let result;
        try { result = await readJSON(this.path, `model-trace/${entry.name}/result.json`); }
        catch (error) { if (error instanceof SyntaxError) continue; throw error; }
        if (result) {
          model.finished = true;
          model.event.endedAt = result.endedAt;
          model.event.status = result.state ?? result.terminalStatus ?? 'unknown';
          const resultPath = `model-trace/${entry.name}/result.json`;
          const size = (await readBytes(this.path, resultPath, 0, 1)).total;
          this.sources.set(resultPath, { path: resultPath, position: size, events: [] });
          this.add({ ...result, type: 'model', agentId: model.event.agentId, requestId: model.event.requestId, at: result.endedAt },
            { path: resultPath, offset: 0, length: size }, { kind: 'model', label: 'Model result', status: model.event.status });
          this.spans.push({ id: model.event.id, agentId: model.event.agentId, kind: 'model', label: 'Model request',
            startedAt: model.event.startedAt, endedAt: result.endedAt, status: model.event.status, evidenceIds: [model.event.id] });
        }
      }
    }
  }

  update() {
    this.updateQueue = this.updateQueue.catch(() => {}).then(() => this.refresh());
    return this.updateQueue;
  }

  async refresh() {
    const report = await readJSON(this.path, 'runtime.json');
    if (!report) throw failure('Run runtime.json is missing', 404);
    this.report = report;
    const schema = report.config?.schemaVersion ?? report.schemaVersion ?? 1;
    if (schema !== 1) this.gap('unsupported-version', `Runtime record schema ${schema} has no decoder`);
    for (const saved of report.agents ?? report.bots ?? []) {
      const agent = this.agent(saved.agentId ?? saved.botId ?? saved.id);
      if (agent) Object.assign(agent, { execution: saved.execution ?? agent.execution, cleanup: saved.cleanup ?? agent.cleanup });
    }
    await this.jsonl('evidence.jsonl');
    await this.jsonl('service-calls.jsonl', 'service');
    await this.models();
    const harnessReport = await readJSON(this.path, 'harness-report.json');
    const environmentReport = await readJSON(this.path, 'environment-report.json');
    this.harness = harnessReport ?? environmentReport;
    if (harnessReport) this.files.set('harness-report.json', { path: 'harness-report.json', kind: 'report' });
    if (environmentReport) this.files.set('environment-report.json', { path: 'environment-report.json', kind: 'report' });
    for (const member of this.harness?.collaboration?.members ?? []) {
      const agent = this.agent(member.agentId ?? member.botId);
      if (agent) agent.label = member.path ?? agent.label;
    }
    for (const relation of this.relations) {
      if (relation.target) relation.toAgentId = [...this.agents.values()].find(agent => agent.label === relation.target || agent.id === relation.target)?.id;
    }
    for (const agent of this.agents.values()) {
      for (const kind of ['session', 'artifacts']) {
        const manifestPath = `${agent.id}/${kind}/manifest.json`;
        const manifest = await readJSON(this.path, manifestPath);
        if (!manifest) continue;
        this.files.set(manifestPath, { path: manifestPath, kind: kind === 'session' ? 'session' : 'artifact', agentId: agent.id });
        for (const file of manifest.files ?? []) {
          const path = `${agent.id}/${kind}/files/${file.path}`;
          this.files.set(path, { path, kind: kind === 'session' ? 'session' : 'artifact', agentId: agent.id, bytes: file.bytes, sha256: file.sha256 });
          if (kind === 'session' && path.endsWith('.jsonl')) await this.jsonl(path, 'session', agent.id);
        }
      }
    }
    for (const saved of report.agents ?? report.bots ?? []) {
      const agent = this.agent(saved.agentId ?? saved.botId ?? saved.id);
      if (agent && saved.execution === 'stopped') agent.execution = saved.execution;
    }
    this.files.set('runtime.json', { path: 'runtime.json', kind: 'report' });
  }

  positions() { return Object.fromEntries([...this.sources].map(([path, source]) => [path, source.position])); }

  summary() {
    const report = this.report;
    const gaps = [...this.gaps];
    if (!this.hasNative) gaps.push({ kind: 'missing-boundary', message: 'Native execution boundaries unavailable in this record version' });
    if (report.evidence?.lost) gaps.push({ kind: 'trace-gap', message: `${report.evidence.lost} lifecycle records were lost` });
    if (report.modelTrace?.lost) gaps.push({ kind: 'trace-gap', message: `${report.modelTrace.lost} model records were lost` });
    if (report.evidence?.pending) gaps.push({ kind: 'pending', message: `${report.evidence.pending} lifecycle records await persistence` });
    return { id: this.id, runtimeId: report.runtimeId, label: report.name ?? report.runtimeId ?? this.id,
      status: report.status ?? 'unknown', startedAt: this.startedAt, endedAt: report.status === 'closed' ? this.endedAt : undefined,
      agents: [...this.agents.values()], relations: this.relations, gaps, files: [...this.files.values()],
      spansTruncated: this.spans.length > 1000,
      spans: [...this.spans.slice(-1000), ...[...this.nativeStarts.values()].map(event => ({ id: event.id, agentId: event.agentId,
        kind: event.kind, label: event.label, startedAt: event.time, status: 'open', evidenceIds: [event.id] }))],
      outcome: this.harness ? { status: this.harness.businessFailure ? 'failed' : this.harness.result !== undefined ? 'recorded' : 'unknown',
        businessFailure: this.harness.businessFailure ? String(this.harness.businessFailure.message ?? this.harness.businessFailure).slice(0, 1000) : null,
        report: this.files.has('harness-report.json') ? 'harness-report.json' : 'environment-report.json' } : { status: 'unknown' },
      cleanup: report.cleanup ?? 'unknown', cursor: encodeCursor(this.positions()), total: this.total,
      format: { readerVersion: version, schemaVersion: report.config?.schemaVersion ?? report.schemaVersion ?? 1,
        vocabulary: report.bots ? 'bot-v1' : 'agent-v1', coreVersion: report.config?.coreVersion },
      index: { bytesRead: this.bytesRead, sourceCount: this.sources.size } };
  }
}

export async function createTraceReader({ root }) {
  const rootPath = await realpath(root);
  const runs = new Map();
  const indexes = new Map();
  async function discover() {
    const found = new Map();
    async function visit(path, depth) {
      if (depth > 5 || found.size >= 10000) return;
      let entries;
      try { entries = await readdir(path, { withFileTypes: true }); }
      catch (error) { if (missing(error)) return; throw error; }
      if (entries.some(entry => entry.name === 'runtime.json' && entry.isFile())) {
        found.set(relative(rootPath, path).split(sep).join('/') || basename(rootPath), path);
        return;
      }
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && !['node_modules', 'model-trace', 'session', 'artifacts'].includes(entry.name)) await visit(join(path, entry.name), depth + 1);
      }
    }
    await visit(rootPath, 0);
    runs.clear();
    for (const [id, path] of found) runs.set(id, path);
  }
  await discover();
  async function index(id) {
    if (!runs.has(id)) await discover();
    const path = runs.get(id);
    if (!path) throw failure('Run was not found under the configured root', 404);
    if (!indexes.has(id)) indexes.set(id, new RunIndex(path, id));
    const current = indexes.get(id);
    await current.update();
    return current;
  }
  return {
    async listRuns() {
      await discover();
      const result = [];
      for (const [id, path] of runs) {
        try {
          const report = await readJSON(path, 'runtime.json');
          if (report) result.push({ id, runtimeId: report.runtimeId, label: report.name ?? report.runtimeId ?? id,
            status: report.status ?? 'unknown', cleanup: report.cleanup ?? 'unknown', agentCount: (report.agents ?? report.bots ?? []).length });
        } catch (error) { result.push({ id, status: 'unreadable', error: error.message }); }
      }
      return result;
    },
    async summary(id) { return (await index(id)).summary(); },
    async events(id, { cursor, limit = 1000, agentId, type } = {}) {
      const current = await index(id);
      if (cursor === 'latest') return { events: [], cursor: encodeCursor(current.positions()), hasMore: false, total: current.total };
      const positions = decodeCursor(cursor);
      const cap = Math.max(1, Math.min(1000, Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 1000));
      const candidates = [];
      for (const [path, source] of current.sources) {
        const offset = positions[path] ?? 0;
        if (offset > source.position) throw failure('Cursor is ahead of its source. Rebuild from the beginning', 409);
        let low = 0;
        let high = source.events.length;
        while (low < high) {
          const mid = (low + high) >>> 1;
          if (source.events[mid].source.offset < offset) low = mid + 1;
          else high = mid;
        }
        candidates.push({ source, position: low });
      }
      const events = [];
      let hasMore = false;
      for (const candidate of candidates) {
        for (; candidate.position < candidate.source.events.length; candidate.position++) {
          const event = candidate.source.events[candidate.position];
          if (events.length === cap) { hasMore = true; break; }
          positions[event.source.path] = event.source.offset + event.source.length;
          if ((!agentId || event.agentId === agentId) && (!type || event.kind === type || event.type === type)) events.push(event);
        }
        if (hasMore) break;
        positions[candidate.source.path] = candidate.source.position;
      }
      return { events, cursor: encodeCursor(positions), hasMore, total: current.total };
    },
    async detail(id, eventId) {
      const current = await index(id);
      const event = current.byId.get(eventId);
      if (!event) throw failure('Record was not found', 404);
      const data = await readBytes(current.path, event.source.path, event.source.offset, Math.min(event.source.length, maxBodyBytes));
      let record;
      try { record = JSON.parse(data.text); } catch { record = data.text; }
      const files = [];
      const contextMatches = [];
      const relation = current.relations.find(item => item.id === eventId);
      if (relation?.messageId && relation.toAgentId) {
        for (const model of current.modelDirectories.values()) {
          if (model.event.agentId !== relation.toAgentId) continue;
          const request = await readJSON(current.path, model.event.source.path);
          const actualInput = request?.after?.input;
          const matchingInputs = Array.isArray(actualInput) ? actualInput.filter(item =>
            (item.role === 'user' || item.type === 'function_call_output') && JSON.stringify(item).includes(relation.messageId)) : [];
          if (matchingInputs.length) {
            contextMatches.push({ recordId: model.event.id, requestId: model.event.requestId, agentId: model.event.agentId,
              startedAt: model.event.startedAt, messageId: relation.messageId, source: model.event.source });
            files.push({ path: model.event.source.path, kind: 'model', agentId: model.event.agentId, label: 'Actual request containing delivered message ID' });
          }
        }
      }
      if (event.kind === 'model') {
        const directory = event.source.path.slice(0, event.source.path.lastIndexOf('/') + 1);
        for (const name of ['request.json', 'result.json', 'response.txt']) files.push({ path: directory + name, kind: 'model', agentId: event.agentId });
      }
      contextMatches.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
      return { event, record, files, contextMatches, truncated: event.source.length > maxBodyBytes };
    },
    async file(id, path, { offset = 0, limit = maxBodyBytes } = {}) {
      const current = await index(id);
      offset = Number(offset);
      limit = Math.min(maxBodyBytes, Number(limit));
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) throw failure('Invalid file range');
      if (typeof path !== 'string' || isAbsolute(path) || !inside(current.path, resolve(current.path, path))) throw failure('Path escapes the Run directory', 403);
      if (!current.files.has(path) && !current.sources.has(path)) {
        // Validate links before the allowlist to give a precise boundary failure.
        try { const handle = await safeOpen(current.path, path); await handle.close(); }
        catch (error) { if (!missing(error)) throw error; }
        throw failure('File is outside recorded evidence', 403);
      }
      const data = await readBytes(current.path, path, offset, limit);
      return { path, text: data.text, offset, nextOffset: offset + data.bytesRead, total: data.total, truncated: offset + data.bytesRead < data.total };
    },
  };
}

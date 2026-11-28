import type { ModelCapabilities, ModelStreamTerminal, ModelTransport } from './model-transport.js';
import { chatCompletionsTransport } from './chat-completions-transport.js';
import { fields, integer, localSchemaReferences, object, optionalText } from './model-request-validation.js';
import type { createModelTrace } from './model-trace.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const CORE_MODEL_SCHEMA_SQL = `
      CREATE TABLE IF NOT EXISTS runtime_model_policies (
        runtime_id TEXT PRIMARY KEY, policy_digest TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_model_attempts (
        runtime_id TEXT NOT NULL, agent_id TEXT NOT NULL, request_id TEXT NOT NULL,
        phase TEXT NOT NULL, fingerprint TEXT NOT NULL, input_tokens INTEGER,
        output_tokens INTEGER, cost INTEGER CHECK(cost IS NULL), settled INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL, reason TEXT, receipt BLOB,
        started_at_ms INTEGER NOT NULL, deadline_ms INTEGER NOT NULL, upstream_request_id TEXT,
        upstream_status INTEGER, upstream_content_type_valid INTEGER, upstream_body_present INTEGER,
        upstream_rejection_kind TEXT, upstream_retry_after_seconds INTEGER,
        PRIMARY KEY (runtime_id, agent_id, request_id)
      );
    `;

const maximumBodyBytes = 8 * 1024 * 1024;
const maximumEventBytes = 8 * 1024 * 1024;
const maximumReceiptBytes = 1024 * 1024;
const terminalStatuses = new Map<any, any>([
  ['response.completed', 'completed'],
  ['response.incomplete', 'incomplete'],
  ['response.failed', 'failed'],
]);
const requestFields = [
  'model', 'input', 'instructions', 'tools', 'tool_choice', 'reasoning', 'include',
  'stream', 'store', 'max_output_tokens', 'temperature', 'top_p',
  'prompt_cache_key', 'prompt_cache_retention', 'parallel_tool_calls',
];

function textPart(part: any) {
  return fields(part, ['type', 'text', 'annotations']) &&
    ['input_text', 'output_text'].includes(part.type) && typeof part.text === 'string' &&
    (part.annotations === undefined || (Array.isArray(part.annotations) && part.annotations.length === 0));
}

function validItem(item: any) {
  if (!object(item)) return false;
  if (!item.type || item.type === 'message') {
    return fields(item, ['type', 'id', 'role', 'content', 'phase', 'status']) &&
      ['user', 'assistant', 'system', 'developer'].includes(item.role) &&
      (typeof item.content === 'string' || (Array.isArray(item.content) && item.content.every(textPart))) &&
      optionalText(item.id) && optionalText(item.phase) && optionalText(item.status);
  }
  if (item.type === 'function_call') {
    return fields(item, ['type', 'id', 'call_id', 'name', 'arguments', 'status']) &&
      [item.call_id, item.name, item.arguments].every((value: any) => typeof value === 'string') &&
      optionalText(item.id) && optionalText(item.status);
  }
  if (item.type === 'function_call_output') {
    return fields(item, ['type', 'id', 'call_id', 'output', 'status']) &&
      typeof item.call_id === 'string' && typeof item.output === 'string' &&
      optionalText(item.id) && optionalText(item.status);
  }
  return item.type === 'reasoning' &&
    fields(item, ['type', 'id', 'summary', 'encrypted_content', 'content', 'status']) &&
    optionalText(item.id) && optionalText(item.status) &&
    (item.encrypted_content === null || optionalText(item.encrypted_content)) &&
    (item.content === undefined || (Array.isArray(item.content) && item.content.length === 0)) &&
    Array.isArray(item.summary) && item.summary.every((part: any) =>
      fields(part, ['type', 'text']) && part.type === 'summary_text' && typeof part.text === 'string');
}

function validTool(tool: any) {
  return fields(tool, ['type', 'name', 'description', 'parameters', 'strict']) &&
    tool.type === 'function' && typeof tool.name === 'string' && optionalText(tool.description) &&
    (tool.parameters === undefined || tool.parameters === null ||
      (object(tool.parameters) && localSchemaReferences(tool.parameters))) &&
    (tool.strict === undefined || tool.strict === null || typeof tool.strict === 'boolean');
}

const codexMetadataFields = ['thread_id', 'root_turn_id', 'turn_id', 'session_id',
  'x-codex-window-id', 'x-codex-installation-id', 'x-codex-turn-metadata'];
const codexRequestFields = [...requestFields, 'client_metadata'];

function validPayload(body: any, model: any, executor: 'pi' | 'codex') {
  if (!fields(body, executor === 'codex' ? codexRequestFields : requestFields) || (body.model !== undefined && body.model !== model) ||
      (body.stream !== undefined && body.stream !== true) ||
      (body.store !== undefined && body.store !== false) || !optionalText(body.instructions)) return false;
  if (body.client_metadata !== undefined &&
      (!fields(body.client_metadata, codexMetadataFields) ||
        !Object.values(body.client_metadata).every(value => typeof value === 'string' && Buffer.byteLength(value) <= 16_384))) return false;
  if (typeof body.input !== 'string' && !(Array.isArray(body.input) && body.input.every(validItem))) return false;
  if (body.tools !== undefined && !(Array.isArray(body.tools) && body.tools.every(validTool))) return false;
  if (body.tool_choice !== undefined && !['auto', 'none', 'required'].includes(body.tool_choice) &&
      !(fields(body.tool_choice, ['type', 'name']) && body.tool_choice.type === 'function' &&
        typeof body.tool_choice.name === 'string')) return false;
  if (body.include !== undefined && !(Array.isArray(body.include) && body.include.length === 1 &&
      body.include[0] === 'reasoning.encrypted_content')) return false;
  if (body.reasoning !== undefined &&
      !(fields(body.reasoning, ['effort', 'summary']) && optionalText(body.reasoning.effort) &&
        optionalText(body.reasoning.summary))) return false;
  return (body.max_output_tokens === undefined || integer(body.max_output_tokens, 16)) &&
    (body.parallel_tool_calls === undefined || typeof body.parallel_tool_calls === 'boolean') &&
    (body.temperature === undefined || typeof body.temperature === 'number') &&
    (body.top_p === undefined || typeof body.top_p === 'number') &&
    optionalText(body.prompt_cache_key) &&
    (body.prompt_cache_retention === undefined || body.prompt_cache_retention === 'in_memory');
}

function canonicalPayload(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalPayload);
  if (!object(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key: any) => [key, canonicalPayload(value[key])]));
}

export function resolveModelTransport(protocol: unknown): ModelTransport | undefined {
  if (protocol === undefined || protocol === 'responses') return undefined;
  if (protocol === 'chat-completions') return chatCompletionsTransport;
  const transport = protocol as ModelTransport;
  if (!transport || typeof transport !== 'object' || !/^[a-zA-Z0-9_.-]{1,64}$/.test(transport.id ?? '') ||
      ['responses', 'chat-completions'].includes(transport.id) || !/^[a-zA-Z0-9_.+-]{1,64}$/.test(transport.version ?? '') ||
      !/^\/v1(?:\/[a-zA-Z0-9_-]+)+$/.test(transport.path ?? '') ||
      typeof transport.validateUpstream !== 'function' || typeof transport.prepareRequest !== 'function' ||
      typeof transport.stream !== 'function') throw new TypeError('Invalid model transport');
  return Object.freeze({ id: transport.id, version: transport.version, path: transport.path,
    clientProtocol: transport.clientProtocol, validateUpstream: transport.validateUpstream.bind(transport),
    prepareRequest: transport.prepareRequest.bind(transport), stream: transport.stream.bind(transport) });
}

export function assertModelEndpoint(value: string, transport?: ModelTransport) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      !(transport ? transport.validateUpstream(url) === true : url.pathname.endsWith('/v1/responses'))) {
    throw new TypeError(`A fixed HTTP(S) endpoint for ${transport?.id ?? '/v1/responses'} is required`);
  }
  return url;
}

function upstreamPolicy(upstream: any, transport: ModelTransport | undefined) {
  if (typeof upstream?.model !== 'string' || !upstream.model) throw new TypeError('A fixed Responses model is required');
  const url = assertModelEndpoint(upstream.url, transport);
  const policy = { model: upstream.model, url: url.href, serviceTier: upstream.serviceTier ?? null };
  if (policy.serviceTier !== null && (typeof policy.serviceTier !== 'string' || !policy.serviceTier)) {
    throw new TypeError('A fixed service tier must be a nonempty string');
  }
  return policy;
}

export const defaultTimedResponsesLimits = Object.freeze({ maxOutputTokens: 32_768, requestTimeoutMs: 120_000 });

function timedPolicy(upstream: any, { maxOutputTokens = defaultTimedResponsesLimits.maxOutputTokens,
  requestTimeoutMs = defaultTimedResponsesLimits.requestTimeoutMs, maxRequests }: any, transport: ModelTransport | undefined, capabilities?: ModelCapabilities) {
  if ((maxOutputTokens !== null && !integer(maxOutputTokens, 16)) || !integer(requestTimeoutMs, 1) || requestTimeoutMs > 2_147_483_647) {
    throw new TypeError('Timed Responses gateway requires a finite request timeout and a valid output-token policy');
  }
  if (maxRequests !== undefined && !integer(maxRequests, 1)) throw new TypeError('A configured model request cap must be a positive safe integer');
  const limit = capabilities?.maxOutputTokens;
  const effectiveLimit = limit === undefined ? maxOutputTokens : Math.min(maxOutputTokens ?? limit, limit);
  return { ...upstreamPolicy(upstream, transport), mode: 'time_bounded', maxOutputTokens: effectiveLimit, requestTimeoutMs, maxRequests };
}

function responsesStream(model: string) {
  return {
    accept(data: string): ModelStreamTerminal | undefined {
      let event;
      try { event = JSON.parse(data); } catch { return; }
      const status = terminalStatuses.get(event?.type);
      if (!status || event.response?.status !== status || event.response?.model !== model) return;
      const usage = event.response?.usage;
      if (integer(usage?.input_tokens) && integer(usage?.output_tokens)) {
        return { status, usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } };
      }
    },
  };
}

function terminalMeter(parser: ReturnType<ModelTransport['stream']>, strict: boolean,
  onTerminal: (terminal: ModelStreamTerminal) => void) {
  let buffer = '';
  let ended = false;
  let overflow = false;
  const decoder = new TextDecoder();
  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        if (!overflow && (!ended || strict)) {
          buffer += decoder.decode(chunk, { stream: true });
          let match;
          while ((match = /\r?\n\r?\n/.exec(buffer))) {
            const frame = buffer.slice(0, match.index);
            buffer = buffer.slice(match.index + match[0].length);
            if (Buffer.byteLength(frame) > maximumEventBytes) { overflow = true; break; }
            const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
              .map(line => line.slice(5).replace(/^ /, '')).join('\n');
            if (!data) continue;
            if (ended) throw new Error('Model stream has data after its terminal frame');
            const terminal = parser.accept(data);
            if (terminal) {
              const { status, usage } = terminal;
              if (!['completed', 'incomplete', 'failed'].includes(status) ||
                  (usage && (!integer(usage.inputTokens) || !integer(usage.outputTokens)))) {
                throw new Error('Invalid model terminal receipt');
              }
              onTerminal(terminal);
              ended = true;
              if (!strict) break;
            }
          }
          overflow ||= Buffer.byteLength(buffer) > maximumEventBytes;
          if (overflow && strict) throw new Error('Model stream frame exceeds its byte limit');
          if (overflow || ended && !strict) buffer = '';
        }
        callback(null, chunk);
      } catch (error) {
        callback(error as Error);
      }
    },
    flush(callback) {
      if (strict && !ended) callback(new Error('Model stream ended without a valid terminal frame'));
      else if (strict && (buffer + decoder.decode()).trim()) callback(new Error('Model stream has a truncated trailing frame'));
      else callback();
    },
  });
}

function reject(response: any, status: any, code: any) {
  if (response.destroyed || response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: { code, message: code, type: 'responses_gateway_error' } }));
}

class GatewayError extends Error {
  declare status: any;

  constructor(status: any, code: any) {
    super(code);
    this.status = status;
  }
}

export class ResponsesBudgetGateway {
  declare db: any;
  declare validateAgent: any;
  declare fetch: any;
  declare policy: any;
  declare headers: any;
  declare pin: any;
  declare transformPayload: (input: any) => any;
  declare beginTrace: ReturnType<typeof createModelTrace>['begin'] | undefined;

  #tokens: any = new Map<any, any>();
  #server: any;
  #closing: any = false;
  #working: any = new Set();
  #controllers: any = new Map<any, any>();
  #stopPromise: any;
  #executor: 'pi' | 'codex';
  #transport: ModelTransport | undefined;
  #capabilities: ModelCapabilities | undefined;
  constructor({ db, upstream, timeBounds, executor = 'pi', transport, capabilities, validateAgent, fetchImpl = globalThis.fetch, transformPayload = (payload: unknown) => payload, beginTrace }: any = {}) {
    if (!db?.prepare || typeof validateAgent !== 'function' || typeof fetchImpl !== 'function') {
      throw new TypeError('Database, synchronous Agent authority, and fetch are required');
    }
    if (!object(timeBounds)) throw new TypeError('Runtime Responses access requires time bounds');
    if (upstream?.contract !== undefined) throw new TypeError('Runtime Responses access does not accept an upstream contract');
    if (typeof executor !== 'string' || !executor) throw new TypeError('Executor identity is required for model access');
    this.#executor = executor === 'codex' ? 'codex' : 'pi';
    this.#transport = transport;
    this.#capabilities = capabilities;
    this.db = db;
    this.validateAgent = validateAgent;
    this.fetch = fetchImpl;
    this.transformPayload = transformPayload;
    this.beginTrace = beginTrace;
    this.policy = Object.freeze(timedPolicy(upstream, timeBounds, transport, capabilities));
    this.headers = new Headers(upstream.headers);
    this.headers.set('accept', 'text/event-stream');
    this.headers.set('content-type', 'application/json');
    for (const name of ['host', 'content-length', 'connection', 'transfer-encoding']) this.headers.delete(name);
    // Use the existing Runtime policy encoding for ledgers opened with the same settings.
    this.pin = createHash('sha256').update(JSON.stringify([this.policy, executor === 'pi' ? null : executor, ...(transport ? [transport.id, transport.version] : []), ...(capabilities ? [capabilities] : [])])).digest('hex');
    db.exec(CORE_MODEL_SCHEMA_SQL);
  }

  async start({ host = '127.0.0.1', port = 0 }: any = {}) {
    if (this.#closing || this.#server) throw new Error('Responses gateway cannot start again');
    this.#server = createServer(this.handleRequest);
    this.#server.requestTimeout = this.policy.requestTimeoutMs;
    this.#server.headersTimeout = Math.min(10_000, this.policy.requestTimeoutMs);
    const server = this.#server;
    await new Promise<any>((resolve: any, rejectStart: any) => {
      const done = (error?: any) => {
        server.off('listening', listening);
        server.off('close', closed);
        server.off('error', failed);
        if (error) rejectStart(error);
        else resolve();
      };
      const listening = () => done();
      const closed = () => done(new Error('Responses gateway stopped during startup'));
      const failed = (error: any) => done(error);
      server.once('listening', listening);
      server.once('close', closed);
      server.once('error', failed);
      try { server.listen({ host, port }); } catch (error: any) { done(error); }
    });
    const address = server.address();
    if (this.#closing || !address) throw new Error('Responses gateway stopped during startup');
    const hostname = host.includes(':') ? `[${host}]` : host;
    return { port: address.port, baseUrl: `http://${hostname}:${address.port}/v1` };
  }

  handleRequest = (request: IncomingMessage, response: ServerResponse) => {
    const work = Promise.resolve().then(() => this.#handle(request, response)).catch((error: unknown) => {
      reject(response, error instanceof GatewayError ? error.status : 502,
        error instanceof GatewayError ? error.message : 'upstream_unavailable');
    });
    this.#working.add(work);
    void work.then(() => this.#working.delete(work), () => this.#working.delete(work));
  };

  issueToken({ runtimeId, agentId }: any = {}) {
    if (this.#closing || typeof runtimeId !== 'string' || !runtimeId || typeof agentId !== 'string' || !agentId) {
      throw new Error('A live gateway and a trusted Runtime/Agent binding are required');
    }
    const token = randomBytes(32).toString('base64url');
    this.#tokens.set(token, { runtimeId, agentId });
    return token;
  }

  revokeToken(token: any) {
    const revoked = this.#tokens.delete(token);
    for (const [controller, activeToken] of this.#controllers) {
      if (activeToken === token) controller.abort();
    }
    return revoked;
  }

  observedUsage(runtimeId: any) {
    return this.db.prepare(`SELECT COUNT(*) AS requests, COUNT(input_tokens) AS requests_with_usage,
      COUNT(*) FILTER (WHERE state = 'unknown') AS unknown_requests,
      COUNT(*) FILTER (WHERE state = 'pending') AS pending_requests,
      SUM(input_tokens) AS observed_input_tokens, SUM(output_tokens) AS observed_output_tokens
      FROM runtime_model_attempts WHERE runtime_id = ?`).get(runtimeId);
  }

  stop() {
    if (this.#stopPromise) return this.#stopPromise;
    this.#closing = true;
    this.#tokens.clear();
    for (const controller of this.#controllers.keys()) controller.abort();
    const closed = this.#server
      ? new Promise<any>((resolve: any, rejectClose: any) => this.#server.close((error: any) => {
        if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') rejectClose(error);
        else resolve();
      })) : Promise.resolve();
    this.#server?.closeAllConnections();
    this.#stopPromise = closed.then(() => Promise.allSettled([...this.#working])).then(() => undefined)
      .catch((error: any) => { this.#stopPromise = undefined; throw error; });
    return this.#stopPromise;
  }

  #admit(token: any, requestId: any, fingerprint: any) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const binding = !this.#closing && this.#tokens.get(token);
      if (!binding) throw new GatewayError(401, 'invalid_agent_credential');
      const { runtimeId, agentId } = binding;
      let authority;
      try { authority = this.validateAgent(binding); }
      catch { throw new GatewayError(403, 'agent_not_admitted'); }
      if (!authority) throw new GatewayError(403, 'agent_not_admitted');
      const authorityDeadline = authority?.deadline ?? Date.now() + this.policy.requestTimeoutMs;
      if (!Number.isFinite(authorityDeadline) || authorityDeadline <= Date.now()) throw new GatewayError(403, 'agent_deadline_elapsed');
      this.db.prepare('INSERT OR IGNORE INTO runtime_model_policies VALUES (?, ?)').run(runtimeId, this.pin);
      if (this.db.prepare('SELECT policy_digest FROM runtime_model_policies WHERE runtime_id = ?')
        .get(runtimeId).policy_digest !== this.pin) throw new GatewayError(409, 'budget_policy_changed');
      const prior = this.db.prepare(`SELECT fingerprint, state, receipt, deadline_ms FROM runtime_model_attempts
        WHERE runtime_id = ? AND agent_id = ? AND request_id = ?`).get(runtimeId, agentId, requestId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new GatewayError(409, 'request_payload_conflict');
        if (!prior.receipt) {
          const state = prior.state === 'pending' && Date.now() >= prior.deadline_ms ? 'unknown' : prior.state;
          throw new GatewayError(409, `request_${state}`);
        }
        this.db.exec('COMMIT');
        return { ...binding, receipt: prior.receipt };
      }
      if (this.policy.maxRequests !== undefined && this.db.prepare('SELECT COUNT(*) AS attempts FROM runtime_model_attempts WHERE runtime_id = ?')
        .get(runtimeId).attempts >= this.policy.maxRequests) throw new GatewayError(429, 'runtime_request_limit');
      const startedAt = Date.now();
      const deadline = Math.min(authorityDeadline, startedAt + this.policy.requestTimeoutMs);
      this.db.prepare(`INSERT INTO runtime_model_attempts
        (runtime_id, agent_id, request_id, phase, fingerprint, state, started_at_ms, deadline_ms)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`)
        .run(runtimeId, agentId, requestId, 'runtime', fingerprint, startedAt, deadline);
      this.db.exec('COMMIT');
      return { ...binding, deadline };
    } catch (error: any) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  #prepareResponses(body: any) {
    if (this.#executor === 'codex' && Array.isArray(body?.input)) {
      // Codex serializes omitted reasoning content as null when replaying a provider summary.
      body = { ...body, input: body.input.map((item: any) => {
        if (item?.type !== 'reasoning' || item.content !== null) return item;
        const { content: _content, ...summary } = item;
        return summary;
      }) };
    }
    if (!validPayload(body, this.policy.model, this.#executor)) return null;
    if (this.#capabilities?.tools === false && (body.tools?.length || body.parallel_tool_calls !== undefined ||
        (body.tool_choice !== undefined && body.tool_choice !== 'none') ||
        (Array.isArray(body.input) && body.input.some((item: any) => ['function_call', 'function_call_output'].includes(item.type))))) return null;
    if (this.#capabilities?.reasoning === false && (body.reasoning !== undefined || body.include !== undefined ||
        (Array.isArray(body.input) && body.input.some((item: any) => item.type === 'reasoning')))) return null;
    const maxOutputTokens = this.policy.maxOutputTokens === null ? body.max_output_tokens
      : Math.min(body.max_output_tokens ?? this.policy.maxOutputTokens, this.policy.maxOutputTokens);
    // Codex diagnostics describe the guest. Keep them in private pre-forward
    // Trace and in the original fingerprint, never in the upstream request.
    const { client_metadata: _metadata, ...providerBody } = body;
    return this.transformPayload({
      ...providerBody, model: this.policy.model, stream: true, store: false,
      ...(maxOutputTokens === undefined ? {} : { max_output_tokens: maxOutputTokens }),
      ...(this.policy.serviceTier === null ? {} : { service_tier: this.policy.serviceTier }),
    });
  }

  async #handle(request: any, response: any) {
    if (request.method !== 'POST' || request.url !== (this.#transport?.path ?? '/v1/responses')) {
      throw new GatewayError(404, 'route_not_found');
    }
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '')?.[1];
    if (!this.#tokens.has(token)) throw new GatewayError(401, 'invalid_agent_credential');
    if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) {
      throw new GatewayError(415, 'json_required');
    }
    const stableId = request.headers['x-murm-request-id'];
    const requestId = stableId ?? randomUUID();
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(requestId)) throw new GatewayError(400, 'invalid_request_id');
    const chunks: any[] = [];
    let length = 0;
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      length += chunk.length;
      if (length > maximumBodyBytes) {
        response.setHeader('connection', 'close');
        throw new GatewayError(413, 'request_too_large');
      }
      chunks.push(chunk);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new GatewayError(400, 'invalid_json'); }
    if (response.destroyed || request.aborted) return;
    const fingerprint = createHash('sha256').update(JSON.stringify(canonicalPayload(body))).digest('hex');
    const normalizedPayload = this.#transport ? this.#transport.prepareRequest(structuredClone(body), {
      model: this.policy.model, maxOutputTokens: this.policy.maxOutputTokens, capabilities: this.#capabilities,
    }) : this.#prepareResponses(body);
    if (!object(normalizedPayload)) {
      throw new GatewayError(400, this.#transport ? 'unsupported_model_request' : 'unsupported_responses_request');
    }
    let runtimeId: any, agentId: any, receipt: any, cancelWatch: any, upstreamWork: any;
    let trace: ReturnType<ReturnType<typeof createModelTrace>['begin']> | undefined;
    let upstreamStatus: number | undefined, terminalStatus: string | undefined;
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    let failure: { name: string; code?: string; message: string } | undefined;
    const controller = new AbortController();
    const disconnect = () => controller.abort();
    let streamConfirmed = false;
    let reason: string | null = 'transport_interrupted';
    let receiptBytes = 0;
    const receiptChunks: any[] = [];
    try {
      const admission = this.#admit(token, requestId, fingerprint);
      ({ runtimeId, agentId, receipt } = admission);
      if (receipt) {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        response.end(receipt);
        return;
      }
      const payload = normalizedPayload;
      this.#controllers.set(controller, token);
      const deadlineTimer = setTimeout(() => controller.abort(), Math.max(0, admission.deadline - Date.now()));
      cancelWatch = () => clearTimeout(deadlineTimer);
      response.once('close', disconnect);
      trace = this.beginTrace?.({ runtimeId, agentId, requestId, startedAt: new Date().toISOString(),
        before: body, after: payload });
      upstreamWork = this.fetch(this.policy.url, {
        method: 'POST', headers: this.headers, redirect: 'error', signal: controller.signal,
        body: JSON.stringify(payload),
      });
      const upstream: Response = await upstreamWork;
      upstreamStatus = upstream.status;
      const upstreamId = upstream.headers.get('x-request-id');
      if (upstreamId && /^[A-Za-z0-9_.:-]{1,256}$/.test(upstreamId)) {
        this.db.prepare(`UPDATE runtime_model_attempts SET upstream_request_id = ?
          WHERE runtime_id = ? AND agent_id = ? AND request_id = ?`).run(upstreamId, runtimeId, agentId, requestId);
      }
      const contentTypeValid = /^text\/event-stream(?:;|$)/i.test(upstream.headers.get('content-type') ?? '');
      const rejectionKind = !upstream.ok ? 'non_2xx' : !upstream.body ? 'missing_body'
        : !contentTypeValid ? 'invalid_content_type' : null;
      const retryAfter = upstream.headers.get('retry-after') ?? '';
      // Only bounded delta-seconds are retained; dates and arbitrary header text are discarded.
      const retryAfterSeconds = /^\d{1,5}$/.test(retryAfter) && Number(retryAfter) <= 86400 ? Number(retryAfter) : null;
      this.db.prepare(`UPDATE runtime_model_attempts SET upstream_status = ?, upstream_content_type_valid = ?,
        upstream_body_present = ?, upstream_rejection_kind = ?, upstream_retry_after_seconds = ?
        WHERE runtime_id = ? AND agent_id = ? AND request_id = ?`)
        .run(upstream.status, Number(contentTypeValid), Number(Boolean(upstream.body)), rejectionKind,
          retryAfterSeconds, runtimeId, agentId, requestId);
      if (rejectionKind) {
        reason = 'upstream_http_error';
        if (trace && upstream.body) {
          for await (const bytes of upstream.body) await trace.write(bytes);
        } else await upstream.body?.cancel();
        throw new GatewayError(upstream.status === 429 ? 429 : 502, 'upstream_rejected');
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      const parser = this.#transport ? this.#transport.stream(this.policy.model) : responsesStream(this.policy.model);
      const meter = terminalMeter(parser, Boolean(this.#transport), terminal => {
        terminalStatus = terminal.status;
        usage = terminal.usage;
      });
      const capture = new Transform({
        transform(chunk: any, encoding: any, callback: any) {
          receiptBytes += chunk.length;
          if (stableId && receiptBytes <= maximumReceiptBytes) receiptChunks.push(chunk);
          else receiptChunks.length = 0;
          if (trace) trace.write(chunk).then(() => callback(null, chunk), callback);
          else callback(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream<Uint8Array>), capture, meter, response, { signal: controller.signal });
      streamConfirmed = terminalStatus !== undefined;
      reason = streamConfirmed
        ? (stableId && !receiptChunks.length ? 'receipt_too_large' : usage ? null : 'usage_unavailable')
        : 'no_trusted_terminal_usage';
      if (streamConfirmed) {
        this.db.prepare(`UPDATE runtime_model_attempts SET state = 'completed', reason = ?, receipt = ?,
          input_tokens = ?, output_tokens = ?, settled = 1
          WHERE runtime_id = ? AND agent_id = ? AND request_id = ?`)
          .run(reason, receiptChunks.length ? Buffer.concat(receiptChunks) : null,
            usage?.inputTokens ?? null, usage?.outputTokens ?? null, runtimeId, agentId, requestId);
      }
    } catch (error: any) {
      failure = { name: error.name, code: error.code, message: error.message };
      throw error;
    } finally {
      cancelWatch?.();
      controller.abort();
      response.removeListener('close', disconnect);
      this.#controllers.delete(controller);
      if (upstreamWork) {
        const started = await Promise.resolve(upstreamWork).catch(() => undefined);
        if (started?.body && !started.bodyUsed) await started.body.cancel().catch(() => undefined);
      }
      if (runtimeId && !receipt) this.db.prepare(`UPDATE runtime_model_attempts SET state = ?, reason = ?
        WHERE runtime_id = ? AND agent_id = ? AND request_id = ? AND state = 'pending'`)
        .run(streamConfirmed ? 'completed' : 'unknown', reason, runtimeId, agentId, requestId);
      await (trace as ReturnType<ReturnType<typeof createModelTrace>['begin']> | undefined)?.finish({ endedAt: new Date().toISOString(), upstreamStatus, usage: streamConfirmed ? usage : undefined, reason, terminalStatus: streamConfirmed ? terminalStatus : undefined,
        state: failure || terminalStatus === 'failed' ? 'failed' : terminalStatus ?? 'unknown', error: failure });
    }
  }
}

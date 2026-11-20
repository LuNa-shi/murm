import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const RESPONSES_BUDGET_SCHEMA_SQL = `
      CREATE TABLE IF NOT EXISTS responses_budget_policies (
        mission_id TEXT PRIMARY KEY, policy_digest TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS responses_budget_attempts (
        mission_id TEXT NOT NULL, bot_id TEXT NOT NULL, request_id TEXT NOT NULL,
        phase TEXT NOT NULL, fingerprint TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
        cost INTEGER NOT NULL, settled INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL, reason TEXT, receipt BLOB,
        started_at_ms INTEGER NOT NULL, deadline_ms INTEGER NOT NULL, upstream_request_id TEXT,
        upstream_status INTEGER, upstream_content_type_valid INTEGER, upstream_body_present INTEGER,
        upstream_rejection_kind TEXT, upstream_retry_after_seconds INTEGER,
        PRIMARY KEY (mission_id, bot_id, request_id)
      );
      CREATE TABLE IF NOT EXISTS responses_timed_attempts (
        mission_id TEXT NOT NULL, bot_id TEXT NOT NULL, request_id TEXT NOT NULL,
        phase TEXT NOT NULL, fingerprint TEXT NOT NULL, input_tokens INTEGER,
        output_tokens INTEGER, cost INTEGER CHECK(cost IS NULL), settled INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL, reason TEXT, receipt BLOB,
        started_at_ms INTEGER NOT NULL, deadline_ms INTEGER NOT NULL, upstream_request_id TEXT,
        upstream_status INTEGER, upstream_content_type_valid INTEGER, upstream_body_present INTEGER,
        upstream_rejection_kind TEXT, upstream_retry_after_seconds INTEGER,
        PRIMARY KEY (mission_id, bot_id, request_id)
      );
      CREATE INDEX IF NOT EXISTS responses_budget_scope
        ON responses_budget_attempts (mission_id, bot_id, phase);
    `;

const metrics = ['requests', 'inputTokens', 'outputTokens', 'cost'];
const phases = ['selection', 'work', 'closeout'];
const maximumBodyBytes = 8 * 1024 * 1024;
const maximumEventBytes = 8 * 1024 * 1024;
const executionAuthorityCheckMs = 1000;
const maximumReceiptBytes = 1024 * 1024;
const terminalStatuses = new Map([
  ['response.completed', 'completed'],
  ['response.incomplete', 'incomplete'],
  ['response.failed', 'failed'],
]);
const requestFields = [
  'model', 'input', 'instructions', 'tools', 'tool_choice', 'reasoning', 'include',
  'stream', 'store', 'max_output_tokens', 'temperature', 'top_p',
  'prompt_cache_key', 'prompt_cache_retention', 'parallel_tool_calls',
];

function integer(value, min = 0) {
  return Number.isSafeInteger(value) && value >= min;
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fields(value, allowed) {
  return object(value) && Object.keys(value).every(key => allowed.includes(key));
}

function optionalText(value) {
  return value === undefined || typeof value === 'string';
}

function textPart(part) {
  return fields(part, ['type', 'text', 'annotations']) &&
    ['input_text', 'output_text'].includes(part.type) && typeof part.text === 'string' &&
    (part.annotations === undefined || (Array.isArray(part.annotations) && part.annotations.length === 0));
}

function validItem(item) {
  if (!object(item)) return false;
  if (!item.type || item.type === 'message') {
    return fields(item, ['type', 'id', 'role', 'content', 'phase', 'status']) &&
      ['user', 'assistant', 'system', 'developer'].includes(item.role) &&
      (typeof item.content === 'string' || (Array.isArray(item.content) && item.content.every(textPart))) &&
      optionalText(item.id) && optionalText(item.phase) && optionalText(item.status);
  }
  if (item.type === 'function_call') {
    return fields(item, ['type', 'id', 'call_id', 'name', 'arguments', 'status']) &&
      [item.call_id, item.name, item.arguments].every(value => typeof value === 'string') &&
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
    Array.isArray(item.summary) && item.summary.every(part =>
      fields(part, ['type', 'text']) && part.type === 'summary_text' && typeof part.text === 'string');
}

function localSchemaReferences(schema) {
  const pending = [schema];
  while (pending.length) {
    const node = pending.pop();
    if (Array.isArray(node)) {
      for (const child of node) pending.push(child);
    } else if (object(node)) {
      for (const [key, value] of Object.entries(node)) {
        if (['$ref', '$dynamicRef', '$recursiveRef'].includes(key) &&
            (typeof value !== 'string' || !value.startsWith('#'))) return false;
        pending.push(value);
      }
    }
  }
  return true;
}

function validTool(tool) {
  return fields(tool, ['type', 'name', 'description', 'parameters', 'strict']) &&
    tool.type === 'function' && typeof tool.name === 'string' && optionalText(tool.description) &&
    (tool.parameters === undefined || tool.parameters === null ||
      (object(tool.parameters) && localSchemaReferences(tool.parameters))) &&
    (tool.strict === undefined || tool.strict === null || typeof tool.strict === 'boolean');
}

function validPayload(body, model) {
  if (!fields(body, requestFields) || (body.model !== undefined && body.model !== model) ||
      (body.stream !== undefined && body.stream !== true) ||
      (body.store !== undefined && body.store !== false) || !optionalText(body.instructions)) return false;
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

function canonicalPayload(value) {
  if (Array.isArray(value)) return value.map(canonicalPayload);
  if (!object(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalPayload(value[key])]));
}

function upstreamPolicy(upstream) {
  if (typeof upstream?.model !== 'string' || !upstream.model) throw new TypeError('A fixed Responses model is required');
  const url = new URL(upstream.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || url.pathname !== '/v1/responses') {
    throw new TypeError('A fixed HTTP(S) /v1/responses endpoint is required');
  }
  const policy = { model: upstream.model, url: url.href, serviceTier: upstream.serviceTier ?? null };
  if (policy.serviceTier !== null && (typeof policy.serviceTier !== 'string' || !policy.serviceTier)) {
    throw new TypeError('A fixed service tier must be a nonempty string');
  }
  return policy;
}

function timedPolicy(upstream, { maxOutputTokens = 32_768, requestTimeoutMs = 120_000 } = {}) {
  if (!integer(maxOutputTokens, 16) || !integer(requestTimeoutMs, 1) || requestTimeoutMs > 2_147_483_647) {
    throw new TypeError('Timed Responses gateway requires a finite request timeout and output-token cap');
  }
  return { ...upstreamPolicy(upstream), mode: 'time_bounded', maxOutputTokens, requestTimeoutMs };
}

function contractFor(upstream) {
  const contract = upstream?.contract;
  if (!object(contract) || typeof contract.costUnit !== 'string' || !contract.costUnit ||
      typeof contract.boundEvidence !== 'string' || !contract.boundEvidence.trim() ||
      !integer(contract.maxInputTokens, 1) || !integer(contract.maxOutputTokens, 16) ||
      !integer(contract.maxFanout, 1) || !integer(contract.inputCostPerToken) ||
      !integer(contract.outputCostPerToken) || !integer(contract.fixedAttemptCost) ||
      !integer(contract.requestTimeoutMs, 1) || contract.requestTimeoutMs > 2_147_483_647) {
    throw new TypeError('A complete trusted Responses upstream budget contract is required');
  }
  const policy = {
    ...upstreamPolicy(upstream),
    costUnit: contract.costUnit, boundEvidence: contract.boundEvidence,
    maxInputTokens: contract.maxInputTokens,
    maxOutputTokens: contract.maxOutputTokens,
    maxFanout: contract.maxFanout,
    inputCostPerToken: contract.inputCostPerToken,
    outputCostPerToken: contract.outputCostPerToken,
    fixedAttemptCost: contract.fixedAttemptCost,
    requestTimeoutMs: contract.requestTimeoutMs,
  };
  if (!Object.values(reserve(policy, policy.maxOutputTokens)).every(value => integer(value))) {
    throw new TypeError('Responses upstream budget exceeds safe integer range');
  }
  return policy;
}

// Rates are undiscounted upper bounds, in integer host-configured units. The
// provider contract bounds all attempts attributable to one upstream HTTP POST.
function reserve(policy, maxOutputTokens) {
  const inputTokens = policy.maxInputTokens * policy.maxFanout;
  const outputTokens = maxOutputTokens * policy.maxFanout;
  const cost = inputTokens * policy.inputCostPerToken + outputTokens * policy.outputCostPerToken +
    policy.fixedAttemptCost * policy.maxFanout;
  return { requests: 1, inputTokens, outputTokens, cost };
}

function terminalMeter(policy, budget, maxOutputTokens, onUsage) {
  let buffer = '';
  let overflow = false;
  const decoder = new TextDecoder();
  return new Transform({
    transform(chunk, encoding, callback) {
      if (!overflow) {
        buffer += decoder.decode(chunk, { stream: true });
        let match;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          if (Buffer.byteLength(frame) > maximumEventBytes) { overflow = true; break; }
          const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).replace(/^ /, '')).join('\n');
          let event;
          try { event = JSON.parse(data); } catch { continue; }
          const status = terminalStatuses.get(event?.type);
          if (!status || event.response?.status !== status) continue;
          const usage = event.response?.usage;
          if (event.response?.model !== policy.model ||
              !integer(usage?.input_tokens) || (budget && usage.input_tokens > policy.maxInputTokens) ||
              !integer(usage?.output_tokens) || (budget && usage.output_tokens > maxOutputTokens)) continue;
          let accounting = { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, cost: null };
          if (budget) {
            // Keep all other possible upstream attempts reserved.
            const inputTokens = budget.inputTokens - policy.maxInputTokens + usage.input_tokens;
            const outputTokens = budget.outputTokens - maxOutputTokens + usage.output_tokens;
            accounting = { inputTokens, outputTokens, cost: inputTokens * policy.inputCostPerToken +
              outputTokens * policy.outputCostPerToken + policy.fixedAttemptCost * policy.maxFanout };
          }
          try { onUsage(accounting); } catch (error) { callback(error); return; }
          overflow = true;
          break;
        }
        if (overflow || Buffer.byteLength(buffer) > maximumEventBytes) {
          overflow = true;
          buffer = '';
        }
      }
      callback(null, chunk);
    },
  });
}

function reject(response, status, code) {
  if (response.destroyed || response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: { code, message: code, type: 'responses_gateway_error' } }));
}

class GatewayError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
  }
}

export class ResponsesBudgetGateway {
  #tokens = new Map();
  #server;
  #closing = false;
  #working = new Set();
  #controllers = new Map();
  #stopPromise;
  #attempts;

  constructor({ db, upstream, limits, timeBounds, validateBot, withLifecycleWrite = commit => commit(), fetchImpl = globalThis.fetch } = {}) {
    if (!db?.prepare || typeof validateBot !== 'function' || typeof fetchImpl !== 'function') {
      throw new TypeError('Database, synchronous Bot authority, and fetch are required');
    }
    this.db = db;
    if (typeof withLifecycleWrite !== 'function') throw new TypeError('Lifecycle write boundary must be synchronous');
    this.validateBot = validateBot;
    this.withLifecycleWrite = withLifecycleWrite;
    this.fetch = fetchImpl;
    const timed = timeBounds !== undefined;
    if (timed && (upstream?.contract !== undefined || limits !== undefined)) {
      throw new TypeError('Timed and financial Responses policies are mutually exclusive');
    }
    this.policy = Object.freeze(timed ? timedPolicy(upstream, timeBounds) : contractFor(upstream));
    this.#attempts = timed ? 'responses_timed_attempts' : 'responses_budget_attempts';
    this.headers = new Headers(upstream.headers);
    this.headers.set('accept', 'text/event-stream');
    this.headers.set('content-type', 'application/json');
    for (const name of ['host', 'content-length', 'connection', 'transfer-encoding']) this.headers.delete(name);
    this.limits = timed ? null : Object.freeze(Object.fromEntries(['mission', 'bot', 'selection', 'closeout'].map(scope => {
      const limit = Object.fromEntries(metrics.map(metric => [metric, limits?.[scope]?.[metric]]));
      if (!Object.values(limit).every(value => integer(value))) {
        throw new TypeError(`Explicit finite Responses limits are required for ${scope}`);
      }
      return [scope, Object.freeze(limit)];
    })));
    if (this.limits && metrics.some(metric => this.limits.closeout[metric] > this.limits.mission[metric])) {
      throw new TypeError('Responses closeout reserve exceeds the Mission limit');
    }
    this.pin = createHash('sha256').update(JSON.stringify([this.policy, this.limits])).digest('hex');
    db.exec(RESPONSES_BUDGET_SCHEMA_SQL);
  }

  async start({ host = '127.0.0.1', port = 0 } = {}) {
    if (this.#closing || this.#server) throw new Error('Responses gateway cannot start again');
    this.#server = createServer((request, response) => {
      const work = Promise.resolve().then(() => this.#handle(request, response)).catch(error => {
        reject(response, error instanceof GatewayError ? error.status : 502,
          error instanceof GatewayError ? error.message : 'upstream_unavailable');
      });
      this.#working.add(work);
      work.then(() => this.#working.delete(work), () => this.#working.delete(work));
    });
    this.#server.requestTimeout = this.policy.requestTimeoutMs;
    this.#server.headersTimeout = Math.min(10_000, this.policy.requestTimeoutMs);
    const server = this.#server;
    await new Promise((resolve, rejectStart) => {
      const done = (error) => {
        server.off('listening', listening);
        server.off('close', closed);
        server.off('error', failed);
        if (error) rejectStart(error);
        else resolve();
      };
      const listening = () => done();
      const closed = () => done(new Error('Responses gateway stopped during startup'));
      const failed = error => done(error);
      server.once('listening', listening);
      server.once('close', closed);
      server.once('error', failed);
      try { server.listen({ host, port }); } catch (error) { done(error); }
    });
    const address = server.address();
    if (this.#closing || !address) throw new Error('Responses gateway stopped during startup');
    const hostname = host.includes(':') ? `[${host}]` : host;
    return { port: address.port, baseUrl: `http://${hostname}:${address.port}/v1` };
  }

  issueToken({ missionId, botId }) {
    if (this.#closing || typeof missionId !== 'string' || !missionId || typeof botId !== 'string' || !botId) {
      throw new Error('A live gateway and a trusted Mission/Bot binding are required');
    }
    const token = randomBytes(32).toString('base64url');
    this.#tokens.set(token, { missionId, botId });
    return token;
  }

  revokeToken(token) {
    const revoked = this.#tokens.delete(token);
    for (const [controller, activeToken] of this.#controllers) {
      if (activeToken === token) controller.abort();
    }
    return revoked;
  }

  observedUsage(missionId) {
    return this.db.prepare(`SELECT COUNT(*) AS requests, COUNT(input_tokens) AS requests_with_usage,
      COUNT(*) FILTER (WHERE state = 'unknown') AS unknown_requests,
      COUNT(*) FILTER (WHERE state = 'pending') AS pending_requests,
      SUM(input_tokens) AS observed_input_tokens, SUM(output_tokens) AS observed_output_tokens
      FROM responses_timed_attempts WHERE mission_id = ?`).get(missionId);
  }

  totals({ missionId, botId = null, phase = null }) {
    return this.db.prepare(`
      SELECT COUNT(*) AS requests, COALESCE(SUM(input_tokens), 0) AS inputTokens,
        COALESCE(SUM(output_tokens), 0) AS outputTokens, COALESCE(SUM(cost), 0) AS cost
      FROM responses_budget_attempts WHERE mission_id = ?
        AND (? IS NULL OR bot_id = ?) AND (? IS NULL OR phase = ?)
    `).get(missionId, botId, botId, phase, phase);
  }

  stop() {
    if (this.#stopPromise) return this.#stopPromise;
    this.#closing = true;
    this.#tokens.clear();
    for (const controller of this.#controllers.keys()) controller.abort();
    const closed = this.#server
      ? new Promise((resolve, rejectClose) => this.#server.close(error => {
        if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') rejectClose(error);
        else resolve();
      })) : Promise.resolve();
    this.#server?.closeAllConnections();
    this.#stopPromise = closed.then(() => Promise.allSettled([...this.#working])).then(() => undefined);
    return this.#stopPromise;
  }

  #admit(token, requestId, fingerprint, budget) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const binding = !this.#closing && this.#tokens.get(token);
      if (!binding) throw new GatewayError(401, 'invalid_bot_credential');
      const { missionId, botId } = binding;
      let authority;
      try { authority = this.validateBot({ missionId, botId }); }
      catch { throw new GatewayError(403, 'bot_not_admitted'); }
      const phase = authority?.phase;
      const authorityDeadline = authority?.deadline ?? Date.now() + this.policy.requestTimeoutMs;
      if (!Number.isFinite(authorityDeadline) || authorityDeadline <= Date.now()) throw new GatewayError(403, 'bot_deadline_elapsed');
      if (!phases.includes(phase)) throw new GatewayError(403, 'bot_not_admitted');
      this.db.prepare('INSERT OR IGNORE INTO responses_budget_policies VALUES (?, ?)').run(missionId, this.pin);
      if (this.db.prepare('SELECT policy_digest FROM responses_budget_policies WHERE mission_id = ?')
        .get(missionId).policy_digest !== this.pin) throw new GatewayError(409, 'budget_policy_changed');
      const prior = this.db.prepare(`SELECT fingerprint, state, receipt, deadline_ms FROM ${this.#attempts}
        WHERE mission_id = ? AND bot_id = ? AND request_id = ?`).get(missionId, botId, requestId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new GatewayError(409, 'request_payload_conflict');
        if (!prior.receipt) {
          const state = prior.state === 'pending' && Date.now() >= prior.deadline_ms ? 'unknown' : prior.state;
          throw new GatewayError(409, `request_${state}`);
        }
        this.db.exec('COMMIT');
        return { ...binding, receipt: prior.receipt };
      }
      if (budget) this.#assertBudget(missionId, botId, phase, budget);
      const startedAt = Date.now();
      const deadline = Math.min(authorityDeadline, startedAt + this.policy.requestTimeoutMs);
      this.db.prepare(`INSERT INTO ${this.#attempts}
        (mission_id, bot_id, request_id, phase, fingerprint, input_tokens, output_tokens, cost, state, started_at_ms, deadline_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
        .run(missionId, botId, requestId, phase, fingerprint, budget?.inputTokens ?? null, budget?.outputTokens ?? null, budget?.cost ?? null,
          startedAt, deadline);
      this.db.exec('COMMIT');
      return { ...binding, deadline, authority };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  #watchAuthority({ token, missionId, botId, deadline, authority, controller }) {
    let hardDeadline = deadline;
    let timer;
    const arm = current => {
      const nextCheck = authority.executionId
        ? Math.min(hardDeadline, current.leaseDeadline, Date.now() + executionAuthorityCheckMs)
        : hardDeadline;
      timer = setTimeout(check, Math.max(0, nextCheck - Date.now()));
    };
    const check = () => {
      if (controller.signal.aborted) return;
      try {
        if (Date.now() < hardDeadline && this.#tokens.has(token) && authority.executionId) {
          const current = this.validateBot({ missionId, botId });
          const at = Date.now();
          if (current?.executionId === authority.executionId && current.fencingVersion === authority.fencingVersion &&
              at < current.leaseDeadline && at < current.deadline) {
            hardDeadline = Math.min(hardDeadline, current.deadline);
            if (at < hardDeadline) {
              arm(current);
              return;
            }
          }
        }
      } catch {
        // Unavailable Task authority cannot keep an admitted request alive.
      }
      controller.abort();
    };
    arm(authority);
    return () => clearTimeout(timer);
  }

  #assertBudget(missionId, botId, phase, budget) {
    const applicable = [
      [this.limits.mission, this.totals({ missionId })],
      [this.limits.bot, this.totals({ missionId, botId })],
    ];
    if (phase !== 'closeout') {
      const missionWork = Object.fromEntries(metrics.map(metric =>
        [metric, this.limits.mission[metric] - this.limits.closeout[metric]]));
      const total = this.totals({ missionId });
      const closeout = this.totals({ missionId, phase: 'closeout' });
      const work = Object.fromEntries(metrics.map(metric => [metric, total[metric] - closeout[metric]]));
      applicable.push([missionWork, work]);
    }
    if (phase === 'selection') applicable.push([this.limits.selection, this.totals({ missionId, botId, phase })]);
    if (phase === 'closeout') applicable.push([this.limits.closeout, this.totals({ missionId, phase })]);
    if (applicable.some(([limit, totals]) => metrics.some(metric => budget[metric] > limit[metric] - totals[metric]))) {
      throw new GatewayError(429, 'responses_budget_exhausted');
    }
  }

  async #handle(request, response) {
    if (request.method !== 'POST' || request.url !== '/v1/responses') {
      throw new GatewayError(404, 'route_not_found');
    }
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '')?.[1];
    if (!this.#tokens.has(token)) throw new GatewayError(401, 'invalid_bot_credential');
    if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) {
      throw new GatewayError(415, 'json_required');
    }
    const stableId = request.headers['x-swarmenv-request-id'];
    const requestId = stableId ?? randomUUID();
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(requestId)) throw new GatewayError(400, 'invalid_request_id');
    const chunks = [];
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
    if (!validPayload(body, this.policy.model)) throw new GatewayError(400, 'unsupported_responses_request');
    if (response.destroyed || request.aborted) return;
    const maxOutputTokens = Math.min(body.max_output_tokens ?? this.policy.maxOutputTokens, this.policy.maxOutputTokens);
    const budget = this.limits ? reserve(this.policy, maxOutputTokens) : null;
    const payload = {
      ...body, model: this.policy.model, stream: true, store: false, max_output_tokens: maxOutputTokens,
      ...(this.policy.serviceTier === null ? {} : { service_tier: this.policy.serviceTier }),
    };
    const fingerprint = createHash('sha256').update(JSON.stringify(canonicalPayload(body))).digest('hex');
    let missionId, botId, receipt, cancelWatch, upstreamWork;
    const controller = new AbortController();
    const disconnect = () => controller.abort();
    let usageRecorded = false;
    let reason = 'transport_interrupted';
    let receiptBytes = 0;
    const receiptChunks = [];
    try {
      // Admission, its durable budget reservation and synchronous upstream
      // dispatch share the Task lifecycle writer window. Settlement never
      // holds that lock while waiting on external IO.
      this.withLifecycleWrite(() => {
        const admission = this.#admit(token, requestId, fingerprint, budget);
        ({ missionId, botId, receipt } = admission);
        if (receipt) return;
        this.#controllers.set(controller, token);
        cancelWatch = this.#watchAuthority({ ...admission, token, controller });
        response.once('close', disconnect);
        upstreamWork = this.fetch(this.policy.url, {
          method: 'POST', headers: this.headers, redirect: 'error', signal: controller.signal,
          body: JSON.stringify(payload),
        });
        // A lifecycle COMMIT failure must still observe this started request.
        Promise.resolve(upstreamWork).catch(() => {});
      });
      if (receipt) {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        response.end(receipt);
        return;
      }
      const upstream = await upstreamWork;
      const upstreamId = upstream.headers.get('x-request-id');
      if (upstreamId && /^[A-Za-z0-9_.:-]{1,256}$/.test(upstreamId)) {
        this.db.prepare(`UPDATE ${this.#attempts} SET upstream_request_id = ?
          WHERE mission_id = ? AND bot_id = ? AND request_id = ?`).run(upstreamId, missionId, botId, requestId);
      }
      const contentTypeValid = /^text\/event-stream(?:;|$)/i.test(upstream.headers.get('content-type') ?? '');
      const rejectionKind = !upstream.ok ? 'non_2xx' : !upstream.body ? 'missing_body'
        : !contentTypeValid ? 'invalid_content_type' : null;
      const retryAfter = upstream.headers.get('retry-after') ?? '';
      // Only bounded delta-seconds are retained; dates and arbitrary header text are discarded.
      const retryAfterSeconds = /^\d{1,5}$/.test(retryAfter) && Number(retryAfter) <= 86400 ? Number(retryAfter) : null;
      this.db.prepare(`UPDATE ${this.#attempts} SET upstream_status = ?, upstream_content_type_valid = ?,
        upstream_body_present = ?, upstream_rejection_kind = ?, upstream_retry_after_seconds = ?
        WHERE mission_id = ? AND bot_id = ? AND request_id = ?`)
        .run(upstream.status, Number(contentTypeValid), Number(Boolean(upstream.body)), rejectionKind,
          retryAfterSeconds, missionId, botId, requestId);
      if (rejectionKind) {
        reason = 'upstream_http_error';
        await upstream.body?.cancel();
        throw new GatewayError(upstream.status === 429 ? 429 : 502, 'upstream_rejected');
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      const meter = terminalMeter(this.policy, budget, maxOutputTokens, usage => {
        this.db.prepare(`UPDATE ${this.#attempts} SET input_tokens = ?, output_tokens = ?, cost = ?, settled = 1
          WHERE mission_id = ? AND bot_id = ? AND request_id = ? AND settled = 0`)
          .run(usage.inputTokens, usage.outputTokens, usage.cost, missionId, botId, requestId);
        usageRecorded = true;
      });
      const capture = new Transform({
        transform(chunk, encoding, callback) {
          receiptBytes += chunk.length;
          if (stableId && receiptBytes <= maximumReceiptBytes) receiptChunks.push(chunk);
          else receiptChunks.length = 0;
          callback(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(upstream.body), meter, capture, response, { signal: controller.signal });
      reason = usageRecorded ? (stableId ? 'receipt_too_large' : null) : 'no_trusted_terminal_usage';
      if (usageRecorded && receiptChunks.length) {
        this.db.prepare(`UPDATE ${this.#attempts} SET state = 'completed', receipt = ?
          WHERE mission_id = ? AND bot_id = ? AND request_id = ?`)
          .run(Buffer.concat(receiptChunks), missionId, botId, requestId);
      }
    } finally {
      cancelWatch?.();
      controller.abort();
      response.removeListener('close', disconnect);
      this.#controllers.delete(controller);
      if (upstreamWork) {
        const started = await Promise.resolve(upstreamWork).catch(() => undefined);
        if (started?.body && !started.bodyUsed) await started.body.cancel().catch(() => undefined);
      }
      if (missionId && !receipt) this.db.prepare(`UPDATE ${this.#attempts} SET state = ?, reason = ?
        WHERE mission_id = ? AND bot_id = ? AND request_id = ? AND state = 'pending'`)
        .run(usageRecorded ? 'completed' : 'unknown', reason, missionId, botId, requestId);
    }
  }
}

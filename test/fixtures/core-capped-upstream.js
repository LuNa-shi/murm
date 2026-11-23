import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { once } from 'node:events';

function json(response, status, code) {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: { code, message: code } }));
}

// Never persist provider messages or arbitrary error strings: finite labels only.
function rejectionClassification(bytes) {
  let error;
  try { error = JSON.parse(bytes.toString('utf8')).error; } catch { /* fixed fallback */ }
  const allowed = {
    code: ['unsupported_parameter', 'unknown_parameter', 'invalid_parameter', 'invalid_value', 'unsupported_value', 'invalid_request_error', 'model_not_found', 'context_length_exceeded', 'insufficient_quota'],
    type: ['invalid_request_error', 'authentication_error', 'permission_error', 'rate_limit_error', 'server_error'],
    param: ['tools', 'tool_choice', 'max_output_tokens', 'max_completion_tokens', 'model', 'input', 'stream', 'store', 'temperature', 'top_p'],
  };
  const result = Object.fromEntries(Object.entries(allowed).map(([key, values]) => [key, values.includes(error?.[key]) ? error[key] : 'other']));
  // Classify recognized protocol fields and failure language; never retain matches.
  const patterns = {
    reasoning_content: /\breasoning_content\b/i, reasoning: /\breasoning\b/i,
    call_id: /\bcall_id\b/i, function_call_output: /\bfunction_call_output\b/i,
    function_call: /\bfunction_call\b/i, content: /\bcontent\b/i,
    missing: /\b(?:missing|required)\b/i, unsupported: /\b(?:unsupported|not supported)\b/i,
    empty: /\b(?:empty|non-empty)\b/i, unmatched: /\b(?:unmatched|not found|matching)\b/i,
  };
  const detail = [error?.param, error?.message].filter(value => typeof value === 'string').join(' ');
  const hints = Object.entries(patterns).filter(([, pattern]) => pattern.test(detail)).map(([label]) => label);
  return { ...result, ...(hints.length ? { hints } : {}) };
}

export async function createCappedUpstream({ upstreamUrl, upstreamHeaders = {}, deadlineAt,
  maxRequests = 8, maxOutputTokens = 4096, filename, marker, disableTools = false, failFast = false, onFailure = () => {},
  maxConcurrent = maxRequests, maxAggregateOutputTokens = maxRequests * maxOutputTokens, maxInputBytes = 2 * 1024 ** 2, maxAggregateInputBytes = maxRequests * maxInputBytes }) {
  let target;
  try { target = new URL(upstreamUrl); } catch { throw new Error('LIVE_UPSTREAM_CONFIGURATION_INVALID'); }
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.hash ||
      !Number.isFinite(deadlineAt) || deadlineAt <= Date.now() || deadlineAt > Date.now() + 180_000 ||
      !Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 20 ||
      !Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 4096 ||
      !Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > maxRequests ||
      !Number.isInteger(maxAggregateOutputTokens) || maxAggregateOutputTokens < 1 || maxAggregateOutputTokens > maxRequests * maxOutputTokens ||
      !Number.isInteger(maxInputBytes) || maxInputBytes < 1 || maxInputBytes > 2 * 1024 ** 2 ||
      !Number.isInteger(maxAggregateInputBytes) || maxAggregateInputBytes < 1 || maxAggregateInputBytes > maxRequests * maxInputBytes ||
      !upstreamHeaders || typeof upstreamHeaders !== 'object' || Array.isArray(upstreamHeaders) ||
      typeof failFast !== 'boolean' || typeof onFailure !== 'function' || typeof disableTools !== 'boolean' || typeof filename !== 'string' || !filename || typeof marker !== 'string' || !marker) {
    throw new Error('LIVE_UPSTREAM_CONFIGURATION_INVALID');
  }
  const headers = { ...upstreamHeaders };
  const records = [];
  const active = new Set();
  const tools = new Map();
  let forwarded = 0, reservedOutputTokens = 0, peakConcurrent = 0, reservedInputBytes = 0, rejectedArrivals = 0;
  function rejectAdmission(...args) { rejectedArrivals++; json(...args); }
  let arrivals = 0;
  let closing = false;
  let deadlineReached = false;
  let bashReturned = false;
  let readVerified = false;
  let closePromise, failure;

  function observeEvent(value, record) {
    const items = value.type === 'response.output_item.done' ? [value.item] : value.response?.output ?? [];
    for (const item of items) {
      if (item?.type !== 'function_call' || typeof item.call_id !== 'string') continue;
      let args;
      try { args = JSON.parse(item.arguments); } catch { continue; }
      if (item.name === 'bash' && typeof args.command === 'string' && args.command.includes(filename) && args.command.includes(marker)) {
        tools.set(item.call_id, 'bash');
      }
      if (item.name === 'read' && typeof args.path === 'string' && (args.path === filename || args.path.endsWith(`/${filename}`))) {
        tools.set(item.call_id, 'read');
      }
    }
    if (['response.completed', 'response.failed', 'response.incomplete'].includes(value.type)) {
      record.terminal = value.type;
      if (typeof value.response?.id === 'string') record.responseId = value.response.id.slice(0, 256);
      const usage = value.response?.usage;
      if (Number.isSafeInteger(usage?.input_tokens) && Number.isSafeInteger(usage?.output_tokens) && usage.input_tokens >= 0 && usage.output_tokens >= 0) {
        record.usage = { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
      }
    }
  }

  function observeToolResults(input) {
    for (const item of input) {
      if (item?.type !== 'function_call_output') continue;
      if (tools.get(item.call_id) === 'bash') bashReturned = true;
      if (tools.get(item.call_id) === 'read' && typeof item.output === 'string' && item.output === `${marker}\n`) readVerified = true;
    }
  }

  const server = createServer(async (request, response) => {
    arrivals++;
    if (failure) { rejectAdmission(response, 400, 'LIVE_RUN_FAILED'); return; }
    if (closing || Date.now() >= deadlineAt) { rejectAdmission(response, 429, 'LIVE_WORK_DEADLINE'); return; }
    if (request.method !== 'POST' || request.url !== '/v1/responses') { rejectAdmission(response, 404, 'LIVE_ROUTE_REJECTED'); return; }
    let body;
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > maxInputBytes) throw new Error('size');
        chunks.push(chunk);
      }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (body.model !== 'k3' || !Array.isArray(body.input) ||
          (body.max_output_tokens !== undefined && (!Number.isInteger(body.max_output_tokens) || body.max_output_tokens < 1))) {
        throw new Error('shape');
      }
    } catch { rejectAdmission(response, 400, 'LIVE_REQUEST_REJECTED'); return; }
    if (closing || Date.now() >= deadlineAt) { rejectAdmission(response, 429, 'LIVE_WORK_DEADLINE'); return; }
    if (failure) { rejectAdmission(response, 400, 'LIVE_RUN_FAILED'); return; }
    if (forwarded >= maxRequests) { rejectAdmission(response, 429, 'LIVE_REQUEST_CAP'); return; }
    if (active.size >= maxConcurrent) { rejectAdmission(response, 429, 'LIVE_CONCURRENCY_CAP'); return; }
    observeToolResults(body.input);
    body.max_output_tokens = Math.min(body.max_output_tokens ?? maxOutputTokens, maxOutputTokens);
    if (reservedOutputTokens + body.max_output_tokens > maxAggregateOutputTokens) { rejectAdmission(response, 429, 'LIVE_OUTPUT_BUDGET'); return; }
    if (disableTools) { delete body.tools; delete body.tool_choice; }
    const data = Buffer.from(JSON.stringify(body));
    if (data.length > maxInputBytes || reservedInputBytes + data.length > maxAggregateInputBytes) { rejectAdmission(response, 429, 'LIVE_INPUT_BUDGET'); return; }
    reservedInputBytes += data.length;
    const number = ++forwarded; reservedOutputTokens += body.max_output_tokens;
    const record = { number, inputBytes: data.length, status: 'dispatched', maxOutputTokens: body.max_output_tokens, ...(disableTools ? { toolsDisabled: true, toolsMode: 'omitted' } : {}) };
    records.push(record);
    const outgoingHeaders = { ...headers, 'content-type': 'application/json', accept: 'text/event-stream', 'content-length': data.length };
    for (const name of ['x-swarmenv-request-id', 'x-request-id', 'idempotency-key']) {
      if (typeof request.headers[name] === 'string') outgoingHeaders[name] = request.headers[name];
    }
    let upstream;
    try {
      upstream = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, { method: 'POST', headers: outgoingHeaders }, incoming => {
        record.status = 'responding';
        record.statusCode = incoming.statusCode;
        if ((incoming.statusCode ?? 502) >= 400) {
          const chunks = [];
          let bytes = 0;
          incoming.on('data', chunk => {
            bytes += chunk.length;
            if (bytes <= 64 * 1024) chunks.push(chunk);
          });
          incoming.on('end', () => {
            record.status = 'rejected';
            record.rejection = rejectionClassification(bytes <= 64 * 1024 ? Buffer.concat(chunks) : Buffer.alloc(0));
            active.delete(upstream);
            if (failFast && !failure) {
              failure = { code: 'LIVE_PROVIDER_REJECTED', number, statusCode: incoming.statusCode ?? 502, rejection: record.rejection };
              // Fence synchronously before callback cancellation can race another admission.
              active.forEach(request => request.destroy());
              try { onFailure(structuredClone(failure)); } catch { /* The fence remains authoritative. */ }
            }
            json(response, incoming.statusCode ?? 502, 'LIVE_PROVIDER_REJECTED');
          });
          incoming.on('error', () => { record.status = failure ? 'failure_aborted' : 'stream_failed'; active.delete(upstream); json(response, 502, 'LIVE_UPSTREAM_FAILED'); });
          return;
        }
        response.writeHead(incoming.statusCode ?? 502, incoming.headers);
        let pending = '';
        incoming.on('data', chunk => {
          response.write(chunk);
          pending += chunk.toString('utf8');
          if (pending.length > 2 * 1024 * 1024) { pending = ''; record.observation = 'event_limit'; return; }
          const messages = pending.split(/\r?\n\r?\n/);
          pending = messages.pop();
          for (const message of messages) {
            const eventData = message.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (!eventData || eventData === '[DONE]') continue;
            try { observeEvent(JSON.parse(eventData), record); } catch { record.observation = 'unparsed_event'; }
          }
        });
        incoming.on('end', () => { record.status = 'complete'; active.delete(upstream); response.end(); });
        incoming.on('error', () => { record.status = failure ? 'failure_aborted' : 'stream_failed'; active.delete(upstream); response.destroy(); });
      });
      active.add(upstream); peakConcurrent = Math.max(peakConcurrent, active.size);
      upstream.on('error', () => {
        record.status = failure ? 'failure_aborted' : deadlineReached ? 'deadline_aborted' : 'transport_failed';
        active.delete(upstream);
        if (response.headersSent) response.destroy(); else json(response, 502, 'LIVE_UPSTREAM_FAILED');
      });
      response.on('close', () => { if (!response.writableEnded) upstream.destroy(); });
      upstream.end(data);
    } catch {
      record.status = 'dispatch_failed';
      json(response, 502, 'LIVE_UPSTREAM_FAILED');
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.timeout = Math.max(1, deadlineAt - Date.now());
  const deadline = setTimeout(() => {
    deadlineReached = true;
    active.forEach(request => request.destroy());
  }, Math.max(1, deadlineAt - Date.now()));
  server.listen(0, '127.0.0.1');
  try { await once(server, 'listening'); } catch { clearTimeout(deadline); throw new Error('LIVE_PROXY_START_FAILED'); }
  return {
    url: `http://127.0.0.1:${server.address().port}/v1/responses`,
    receipt() { return structuredClone({ arrivals, forwarded, maxRequests, maxOutputTokens, maxConcurrent, peakConcurrent, maxAggregateOutputTokens, reservedOutputTokens, maxInputBytes, maxAggregateInputBytes, reservedInputBytes, rejectedArrivals, deadlineReached, bashReturned, readVerified, ...(failure ? { failure } : {}), requests: records }); },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      clearTimeout(deadline);
      active.forEach(request => request.destroy());
      closePromise = new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      return closePromise;
    },
  };
}

import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { once } from 'node:events';

function json(response, status, code) {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: { code, message: code } }));
}

export async function createCappedUpstream({ upstreamUrl, upstreamHeaders = {}, deadlineAt,
  maxRequests = 8, maxOutputTokens = 4096, filename, marker, disableTools = false }) {
  let target;
  try { target = new URL(upstreamUrl); } catch { throw new Error('LIVE_UPSTREAM_CONFIGURATION_INVALID'); }
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.hash ||
      !Number.isFinite(deadlineAt) || deadlineAt <= Date.now() || deadlineAt > Date.now() + 120_000 ||
      !Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 8 ||
      !Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 4096 ||
      !upstreamHeaders || typeof upstreamHeaders !== 'object' || Array.isArray(upstreamHeaders) ||
      typeof disableTools !== 'boolean' || typeof filename !== 'string' || !filename || typeof marker !== 'string' || !marker) {
    throw new Error('LIVE_UPSTREAM_CONFIGURATION_INVALID');
  }
  const headers = { ...upstreamHeaders };
  const records = [];
  const active = new Set();
  const tools = new Map();
  let forwarded = 0;
  let closing = false;
  let deadlineReached = false;
  let bashReturned = false;
  let readVerified = false;
  let closePromise;

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
      if (Number.isSafeInteger(usage?.input_tokens) && Number.isSafeInteger(usage?.output_tokens)) {
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
    if (closing || Date.now() >= deadlineAt) { json(response, 429, 'LIVE_WORK_DEADLINE'); return; }
    if (request.method !== 'POST' || request.url !== '/v1/responses') { json(response, 404, 'LIVE_ROUTE_REJECTED'); return; }
    let body;
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) throw new Error('size');
        chunks.push(chunk);
      }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (body.model !== 'k3' || !Array.isArray(body.input) ||
          (body.max_output_tokens !== undefined && (!Number.isInteger(body.max_output_tokens) || body.max_output_tokens < 1))) {
        throw new Error('shape');
      }
    } catch { json(response, 400, 'LIVE_REQUEST_REJECTED'); return; }
    if (closing || Date.now() >= deadlineAt) { json(response, 429, 'LIVE_WORK_DEADLINE'); return; }
    if (forwarded >= maxRequests) { json(response, 429, 'LIVE_REQUEST_CAP'); return; }
    observeToolResults(body.input);
    body.max_output_tokens = Math.min(body.max_output_tokens ?? maxOutputTokens, maxOutputTokens);
    if (disableTools) body.tool_choice = 'none';
    const data = Buffer.from(JSON.stringify(body));
    const number = ++forwarded;
    const record = { number, status: 'dispatched', maxOutputTokens: body.max_output_tokens, ...(disableTools ? { toolsDisabled: true } : {}) };
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
        incoming.on('error', () => { record.status = 'stream_failed'; active.delete(upstream); response.destroy(); });
      });
      active.add(upstream);
      upstream.on('error', () => {
        record.status = deadlineReached ? 'deadline_aborted' : 'transport_failed';
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
    receipt() { return structuredClone({ forwarded, maxRequests, maxOutputTokens, deadlineReached, bashReturned, readVerified, requests: records }); },
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

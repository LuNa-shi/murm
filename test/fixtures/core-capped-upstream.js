import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { once } from 'node:events';

const terminalStatuses = new Map([
  ['response.completed', 'completed'],
  ['response.failed', 'failed'],
  ['response.incomplete', 'incomplete'],
]);

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

// Fixed structural projection only; no caller-controlled keys or values survive.
function requestGeometry(input) {
  const itemCounts = { message: 0, reasoning: 0, function_call: 0, function_call_output: 0, custom_tool_call: 0, custom_tool_call_output: 0, other: 0 };
  let emptyAssistantText = 0, reasoningSummaryPresent = 0, reasoningEncryptedContentPresent = 0;
  const calls = [], outputs = [], itemTypes = [];
  let emptyAssistantMessages = 0;
  for (const item of input) {
    const type = item?.type ?? (['system', 'developer', 'user', 'assistant'].includes(item?.role) ? 'message' : 'other');
    const safeType = typeof type === 'string' && Object.hasOwn(itemCounts, type) ? type : 'other';
    itemCounts[safeType]++;
    if (itemTypes.length < 128) itemTypes.push(safeType);
    if (item?.role === 'assistant' && (item.content === '' || (Array.isArray(item.content) && item.content.every(block => ['output_text', 'text'].includes(block?.type) && block.text === '')))) emptyAssistantMessages++;
    if (item?.role === 'assistant' && Array.isArray(item.content)) {
      emptyAssistantText += item.content.filter(block => ['output_text', 'text'].includes(block?.type) && block.text === '').length;
    }
    if (type === 'reasoning') {
      reasoningSummaryPresent += Number(Object.hasOwn(item, 'summary'));
      reasoningEncryptedContentPresent += Number(Object.hasOwn(item, 'encrypted_content'));
    }
    if (type === 'function_call') calls.push(item.call_id);
    if (type === 'function_call_output') outputs.push(item.call_id);
  }
  const remaining = new Map();
  for (const id of calls) if (typeof id === 'string' && id) remaining.set(id, (remaining.get(id) ?? 0) + 1);
  let matchedPairs = 0;
  for (const id of outputs) if (typeof id === 'string' && id && remaining.get(id) > 0) { matchedPairs++; remaining.set(id, remaining.get(id) - 1); }
  return { itemTypes, itemTypesTruncated: input.length > itemTypes.length, functionCalls: calls.length, functionCallOutputs: outputs.length,
    callIdsMatched: matchedPairs === calls.length && matchedPairs === outputs.length, reasoningItems: itemCounts.reasoning,
    emptyAssistantMessages, emptyAssistantText, reasoningSummaryPresent, reasoningEncryptedContentPresent };
}

function requestOptions(body) {
  const effort = body.reasoning?.effort, summary = body.reasoning?.summary;
  return {
    reasoningEffort: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort) ? effort : null,
    reasoningSummary: ['auto', 'concise', 'detailed'].includes(summary) ? summary : null,
    includeReasoningEncryptedContent: Array.isArray(body.include) ? body.include.includes('reasoning.encrypted_content') : null,
  };
}

function terminalGeometry(response, model) {
  const geometry = {
    status: ['completed', 'incomplete', 'failed'].includes(response?.status) ? response.status : 'other',
    modelMatches: response?.model === model,
  };
  if (Number.isSafeInteger(response?.max_output_tokens) && response.max_output_tokens >= 0) {
    geometry.maxOutputTokens = response.max_output_tokens;
  }
  const reasoningTokens = response?.usage?.output_tokens_details?.reasoning_tokens;
  if (Number.isSafeInteger(reasoningTokens) && reasoningTokens >= 0) geometry.reasoningTokens = reasoningTokens;
  if (Array.isArray(response?.output)) {
    const outputItems = { reasoning: 0, message: 0, function_call: 0, other: 0 };
    for (const item of response.output.slice(0, 128)) {
      const type = item?.type;
      const kind = typeof type === 'string' && Object.hasOwn(outputItems, type) ? type : 'other';
      outputItems[kind]++;
    }
    geometry.outputItems = outputItems;
    geometry.outputItemsTruncated = response.output.length > 128;
  }
  return geometry;
}

export async function createCappedUpstream(options) {
  const { upstreamUrl, upstreamHeaders = {}, deadlineAt,
  maxRequests = 8, maxOutputTokens = 4096, generationOutputTokens = maxOutputTokens, filename, marker, disableTools = false, failFast = false, onFailure = () => {}, recordGeometry = false,
  maxConcurrent = maxRequests, maxAggregateOutputTokens = maxRequests * maxOutputTokens, maxInputBytes = 2 * 1024 ** 2, maxAggregateInputBytes = maxRequests * maxInputBytes, profile = 'short', phases, ...extra } = options;
  const createdAt = Date.now();
  let phaseLimits, ownerDeadlineAt = deadlineAt;
  const endurance = profile === 'endurance';
  if (endurance) {
    const bounds = { setupMs: [1, 600_000], workMs: [3_600_000, 3_900_000], cleanupMs: [1, 600_000], recoveryMs: [0, 300_000], marginMs: [1, 120_000] };
    const explicit = ['maxRequests', 'maxConcurrent', 'generationOutputTokens', 'maxOutputTokens', 'maxAggregateOutputTokens', 'maxInputBytes', 'maxAggregateInputBytes', 'deadlineAt', 'failFast'];
    if (Object.keys(extra).length || !explicit.every(key => Object.hasOwn(options, key) && options[key] !== undefined) || !failFast ||
        !phases || typeof phases !== 'object' || Array.isArray(phases) || Object.keys(phases).length !== Object.keys(bounds).length ||
        !Object.entries(bounds).every(([key, [low, high]]) => Object.hasOwn(phases, key) && Number.isSafeInteger(phases[key]) && phases[key] >= low && phases[key] <= high) ||
        maxRequests > 256 || maxConcurrent > 4 || maxOutputTokens > 1024 || generationOutputTokens > 768 || generationOutputTokens >= maxOutputTokens ||
        maxAggregateOutputTokens > 196_608 || maxAggregateInputBytes > 32 * 1024 ** 2 ||
        deadlineAt < createdAt + phases.workMs || deadlineAt > createdAt + phases.setupMs + phases.workMs) {
      throw new Error('LIVE_UPSTREAM_CONFIGURATION_INVALID');
    }
    phaseLimits = Object.freeze({ ...phases });
    ownerDeadlineAt = deadlineAt + phaseLimits.cleanupMs + phaseLimits.recoveryMs + phaseLimits.marginMs;
  } else if (profile !== 'short' || phases !== undefined) throw new Error('LIVE_UPSTREAM_CONFIGURATION_INVALID');

  let target;
  try { target = new URL(upstreamUrl); } catch { throw new Error('LIVE_UPSTREAM_CONFIGURATION_INVALID'); }
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.hash ||
      !Number.isFinite(deadlineAt) || deadlineAt <= Date.now() || (!endurance && deadlineAt > createdAt + 180_000) ||
      !Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > (endurance ? 256 : 20) ||
      !Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 4096 ||
      !Number.isInteger(generationOutputTokens) || generationOutputTokens < 1 || generationOutputTokens > maxOutputTokens ||
      (generationOutputTokens !== maxOutputTokens && !failFast) ||
      !Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > maxRequests ||
      !Number.isInteger(maxAggregateOutputTokens) || maxAggregateOutputTokens < 1 || maxAggregateOutputTokens > maxRequests * maxOutputTokens ||
      !Number.isInteger(maxInputBytes) || maxInputBytes < 1 || maxInputBytes > 2 * 1024 ** 2 ||
      !Number.isInteger(maxAggregateInputBytes) || maxAggregateInputBytes < 1 || maxAggregateInputBytes > maxRequests * maxInputBytes ||
      !upstreamHeaders || typeof upstreamHeaders !== 'object' || Array.isArray(upstreamHeaders) ||
      typeof recordGeometry !== 'boolean' || typeof failFast !== 'boolean' || typeof onFailure !== 'function' || typeof disableTools !== 'boolean' || typeof filename !== 'string' || !filename || typeof marker !== 'string' || !marker) {
    throw new Error('LIVE_UPSTREAM_CONFIGURATION_INVALID');
  }
  const frozenPolicy = Object.freeze({ maxRequests, maxConcurrent, generationOutputTokens, maxOutputTokens,
    maxAggregateOutputTokens, maxInputBytes, maxAggregateInputBytes, ...(phaseLimits ? { phases: phaseLimits } : {}) });
  const headers = { ...upstreamHeaders };
  const records = [];
  const transportStarted = performance.now();
  let transportOrder = 0;
  // One observation per finite kind: bounded metadata, never raw errors/body.
  // These are host observations, not proof of an upstream failure's root cause.
  function transport(record, kind, terminates = false) {
    const log = record.transport ??= { events: [] };
    if (log.events.some(event => event.kind === kind)) return;
    const event = { kind, order: ++transportOrder, elapsedMs: performance.now() - transportStarted };
    log.events.push(event);
    if (terminates && !log.firstTermination) log.firstTermination = event;
  }
  const active = new Set();
  const requestRecords = new WeakMap();
  const terminalObservations = new WeakMap();
  const rejectionReads = new Set();
  const tools = new Map();
  let settledOutputTokens = 0, outstandingOutputTokens = 0;
  let forwarded = 0, reservedOutputTokens = 0, peakConcurrent = 0, reservedInputBytes = 0, rejectedArrivals = 0;
  function rejectAdmission(...args) { rejectedArrivals++; json(...args); }
  let arrivals = 0;
  let closing = false, listenerClosed = false;
  let deadlineReached = false;
  let bashReturned = false;
  let readVerified = false;
  let closePromise, failure;

  function failRun(reason, terminationKind) {
    if (!failFast || failure) return;
    failure = reason;
    active.forEach(request => {
      transport(requestRecords.get(request), terminationKind, true);
      request.destroy();
    });
    try { onFailure(structuredClone(failure)); } catch { /* The fence remains authoritative. */ }
  }

  function fenceUnmeteredTransport(record) {
    if (!failFast || failure || closing || deadlineReached || (record.terminal && record.usage)) return;
    failRun({ code: 'LIVE_UNMETERED_TRANSPORT_LOSS', number: record.number }, 'unmetered_transport_abort');
  }

  function observeEvent(value, record, model) {
    const terminalStatus = terminalStatuses.get(value.type);
    if (terminalStatus) {
      const usage = value.response?.usage;
      const validUsage = Number.isSafeInteger(usage?.input_tokens) && Number.isSafeInteger(usage?.output_tokens) && usage.input_tokens >= 0 && usage.output_tokens >= 0;
      const validEnvelope = value.response?.model === model && value.response?.status === terminalStatus;
      const outputExceeded = failFast && Number.isSafeInteger(usage?.output_tokens) && usage.output_tokens > record.maxOutputTokens;
      if (failFast) {
        const observation = { terminal: value.type, responseId: value.response?.id, validEnvelope,
          inputTokens: usage?.input_tokens, outputTokens: usage?.output_tokens };
        const previous = terminalObservations.get(record);
        if (previous) {
          if (Object.keys(observation).some(key => observation[key] !== previous[key])) {
            record.terminalConflict = { terminal: value.type, responseIdentityMatches: observation.responseId === previous.responseId,
              ...(validUsage ? { usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } } : {}) };
            transport(record, 'terminal_conflict', true);
            failRun({ code: 'LIVE_TERMINAL_CONFLICT', number: record.number }, 'terminal_conflict_abort');
            return true;
          }
          return;
        }
        terminalObservations.set(record, observation);
      }
      transport(record, 'terminal');
      record.terminal = value.type;
      if (typeof value.response?.id === 'string') record.responseId = value.response.id.slice(0, 256);
      if (validUsage && (!failFast || validEnvelope || outputExceeded)) {
        record.usage = { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
      }
      if (validUsage) record.requestTargetOverrun = usage.output_tokens > record.generationOutputTokens;
      if (failFast && validUsage && validEnvelope && !outputExceeded) {
        // The terminal replay/conflict guard above admits this settlement once.
        outstandingOutputTokens -= record.maxOutputTokens;
        settledOutputTokens += usage.output_tokens;
      }
      if (recordGeometry) record.terminalGeometry = terminalGeometry(value.response, model);
      if (outputExceeded) {
        transport(record, 'output_limit_exceeded', true);
        failRun({ code: 'LIVE_OUTPUT_LIMIT_EXCEEDED', number: record.number,
          maxOutputTokens: record.maxOutputTokens, outputTokens: usage.output_tokens }, 'output_limit_abort');
        return true;
      }
      if (failFast && !validUsage) {
        transport(record, 'terminal_usage_invalid', true);
        failRun({ code: 'LIVE_TERMINAL_USAGE_INVALID', number: record.number }, 'terminal_usage_abort');
        return true;
      }
      if (failFast && !validEnvelope) {
        transport(record, 'terminal_envelope_invalid', true);
        failRun({ code: 'LIVE_TERMINAL_ENVELOPE_INVALID', number: record.number }, 'terminal_envelope_abort');
        return true;
      }
    }
    // Account for terminal usage before inspecting optional tool observations.
    const items = value.type === 'response.output_item.done' ? [value.item] : value.response?.output;
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (item?.type !== 'function_call' || typeof item.call_id !== 'string') continue;
      let args;
      try { args = JSON.parse(item.arguments); } catch { continue; }
      if (item.name === 'bash' && typeof args?.command === 'string' && args.command.includes(filename) && args.command.includes(marker)) {
        tools.set(item.call_id, 'bash');
      }
      if (item.name === 'read' && typeof args?.path === 'string' && (args.path === filename || args.path.endsWith(`/${filename}`))) {
        tools.set(item.call_id, 'read');
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
    if (closing || deadlineReached || Date.now() >= deadlineAt) { rejectAdmission(response, 429, 'LIVE_WORK_DEADLINE'); return; }
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
    if (closing || deadlineReached || Date.now() >= deadlineAt) { rejectAdmission(response, 429, 'LIVE_WORK_DEADLINE'); return; }
    if (failure) { rejectAdmission(response, 400, 'LIVE_RUN_FAILED'); return; }
    if (forwarded >= maxRequests) { rejectAdmission(response, 429, 'LIVE_REQUEST_CAP'); return; }
    if (active.size >= maxConcurrent) { rejectAdmission(response, 429, 'LIVE_CONCURRENCY_CAP'); return; }
    observeToolResults(body.input);
    body.max_output_tokens = Math.min(body.max_output_tokens ?? generationOutputTokens, generationOutputTokens);
    // A separated target is guidance only. Reserve the full host allowance
    // before dispatch and release its difference only on first trusted usage.
    const hardOutputTokens = generationOutputTokens === maxOutputTokens ? body.max_output_tokens : maxOutputTokens;
    const committedOutputTokens = failFast && generationOutputTokens < maxOutputTokens ? settledOutputTokens + outstandingOutputTokens : reservedOutputTokens;
    if (committedOutputTokens + hardOutputTokens > maxAggregateOutputTokens) { rejectAdmission(response, 429, 'LIVE_OUTPUT_BUDGET'); return; }
    if (disableTools) { delete body.tools; delete body.tool_choice; }
    const data = Buffer.from(JSON.stringify(body));
    if (data.length > maxInputBytes || reservedInputBytes + data.length > maxAggregateInputBytes) { rejectAdmission(response, 429, 'LIVE_INPUT_BUDGET'); return; }
    reservedInputBytes += data.length;
    const number = ++forwarded; reservedOutputTokens += hardOutputTokens; outstandingOutputTokens += hardOutputTokens;
    const record = { ...(recordGeometry ? { geometry: requestGeometry(body.input), requestOptions: requestOptions(body) } : {}), number, inputBytes: data.length, status: 'dispatched', maxOutputTokens: hardOutputTokens, generationOutputTokens: body.max_output_tokens, ...(disableTools ? { toolsDisabled: true, toolsMode: 'omitted' } : {}) };
    records.push(record);
    const outgoingHeaders = { ...headers, 'content-type': 'application/json', accept: 'text/event-stream', 'content-length': data.length };
    for (const name of ['x-swarmenv-request-id', 'x-request-id', 'idempotency-key']) {
      if (typeof request.headers[name] === 'string') outgoingHeaders[name] = request.headers[name];
    }
    let upstream, parsingRejection = false;
    try {
      upstream = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, { method: 'POST', headers: outgoingHeaders }, incoming => {
        transport(record, 'headers');
        record.status = 'responding';
        record.statusCode = incoming.statusCode;
        const statusCode = incoming.statusCode ?? 502;
        if (statusCode >= 400 || (failFast && (statusCode < 200 || statusCode >= 300))) {
          transport(record, 'provider_rejection', true);
          const chunks = [];
          let bytes = 0, finished = false, timer;
          parsingRejection = true;
          record.status = 'rejected';
          record.rejection = rejectionClassification(Buffer.alloc(0));
          if (failFast) active.delete(upstream);
          let resolveRead;
          const read = new Promise(resolve => { resolveRead = resolve; });
          rejectionReads.add(read);
          const finish = state => {
            if (finished) return;
            finished = true; clearTimeout(timer); parsingRejection = false; active.delete(upstream);
            record.rejectionRead = state;
            record.rejection = rejectionClassification(state === 'complete' ? Buffer.concat(chunks) : Buffer.alloc(0));
            if (failure?.number === number) failure.rejection = record.rejection;
            rejectionReads.delete(read); resolveRead();
            json(response, statusCode, 'LIVE_PROVIDER_REJECTED');
            if (state !== 'complete') incoming.destroy();
          };
          incoming.on('data', chunk => {
            if (finished) return;
            bytes += chunk.length;
            if (bytes > 64 * 1024) { finish('oversized'); return; }
            chunks.push(chunk);
          });
          incoming.on('end', () => { transport(record, 'upstream_end', true); finish('complete'); });
          incoming.on('error', () => { transport(record, 'upstream_error', true); finish('failed'); });
          // Only the hosted fail-fast path changes the legacy error-body wait.
          if (failFast) timer = setTimeout(() => finish('timeout'), 250);
          // Headers are enough to fence; body parsing is separately bounded.
          failRun({ code: 'LIVE_PROVIDER_REJECTED', number, statusCode, rejection: record.rejection }, 'peer_rejection_abort');
          return;
        }
        response.writeHead(incoming.statusCode ?? 502, incoming.headers);
        let pending = '';
        incoming.on('data', chunk => {
          if (failFast && failure) return;
          if (!failFast) response.write(chunk);
          pending += chunk.toString('utf8');
          if (pending.length > 2 * 1024 * 1024) {
            pending = ''; record.observation = 'event_limit';
            if (failFast) response.write(chunk);
            return;
          }
          const messages = pending.split(/\r?\n\r?\n/);
          pending = messages.pop();
          for (const message of messages) {
            const eventData = message.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (!eventData || eventData === '[DONE]') continue;
            try { if (observeEvent(JSON.parse(eventData), record, body.model)) return; } catch { record.observation = 'unparsed_event'; }
          }
          if (failFast) response.write(chunk);
        });
        incoming.on('end', () => {
          transport(record, 'upstream_end', true); record.status = 'complete'; active.delete(upstream);
          if (failFast && !failure && !closing && !deadlineReached && !record.terminal) {
            failRun({ code: 'LIVE_TERMINAL_MISSING', number: record.number }, 'terminal_missing_abort');
          }
          response.end();
        });
        incoming.on('error', () => {
          transport(record, 'upstream_error', true);
          record.status = failure ? 'failure_aborted' : 'stream_failed'; active.delete(upstream);
          fenceUnmeteredTransport(record);
          response.destroy();
        });
      });
      requestRecords.set(upstream, record);
      active.add(upstream); peakConcurrent = Math.max(peakConcurrent, active.size);
      upstream.on('error', () => {
        transport(record, 'request_error', true);
        if (record.status === 'rejected') return;
        record.status = failure ? 'failure_aborted' : deadlineReached ? 'deadline_aborted' : 'transport_failed';
        active.delete(upstream);
        fenceUnmeteredTransport(record);
        if (response.headersSent) response.destroy(); else json(response, 502, 'LIVE_UPSTREAM_FAILED');
      });
      response.on('close', () => {
        if (!response.writableEnded && !(failFast && parsingRejection)) {
          transport(record, 'client_close', true);
          fenceUnmeteredTransport(record);
          upstream.destroy();
        }
      });
      upstream.end(data);
    } catch {
      transport(record, 'dispatch_error', true);
      record.status = 'dispatch_failed';
      fenceUnmeteredTransport(record);
      json(response, 502, 'LIVE_UPSTREAM_FAILED');
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.timeout = Math.max(1, deadlineAt - Date.now());
  const deadline = setTimeout(() => {
    deadlineReached = true;
    active.forEach(request => { transport(requestRecords.get(request), 'work_expiry', true); request.destroy(); });
  }, Math.max(1, deadlineAt - Date.now()));
  let ownerTimer;
  function closeOwner() {
    if (closePromise) return closePromise;
    closing = true;
    clearTimeout(deadline);
    clearTimeout(ownerTimer);
    // Record intent before destroy(): the later stream error can be caused by
    // this close. Preserve an earlier independently observed termination.
    records.forEach(record => transport(record, 'proxy_close', true));
    active.forEach(request => request.destroy());
    closePromise = (async () => {
      // Preserve the first finite classification even if work cancellation closes the client.
      if (failFast) await Promise.all([...rejectionReads]);
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      listenerClosed = true;
    })();
    return closePromise;
  }
  server.listen(0, '127.0.0.1');
  try { await once(server, 'listening'); } catch { clearTimeout(deadline); throw new Error('LIVE_PROXY_START_FAILED'); }
  if (endurance) ownerTimer = setTimeout(() => { void closeOwner(); }, Math.max(1, ownerDeadlineAt - Date.now()));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1/responses`,
    receipt() { return structuredClone({ profile, model: 'k3', createdAt, deadlineAt, ownerDeadlineAt, frozenPolicy, activeRequests: active.size, admissionClosed: closing, closed: listenerClosed, arrivals, forwarded, maxRequests, maxOutputTokens, generationOutputTokens, observedOutputTokens: records.reduce((total, row) => total + (row.usage?.outputTokens ?? 0), 0), settledOutputTokens, outstandingOutputTokens, committedOutputTokens: settledOutputTokens + outstandingOutputTokens, maxConcurrent, peakConcurrent, maxAggregateOutputTokens, reservedOutputTokens, maxInputBytes, maxAggregateInputBytes, reservedInputBytes, rejectedArrivals, deadlineReached, bashReturned, readVerified, ...(failure ? { failure } : {}), requests: records }); },
    close: closeOwner,
  };
}

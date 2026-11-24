import { createServer, request as httpRequest, validateHeaderName, validateHeaderValue } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { once } from 'node:events';
import { Transform } from 'node:stream';

const terminalStatuses = new Map([['response.completed', 'completed'], ['response.incomplete', 'incomplete'], ['response.failed', 'failed']]);
const count = value => Number.isSafeInteger(value) && value >= 0;
const fail = code => Object.assign(new Error(code), { code });
const sum = (total, value) => total !== null && Number.isSafeInteger(total + value) ? total + value : null;

/** Private host transport owner. Bounds metadata storage, never model work.
 * It preserves request/response bytes and accounts only observed terminal usage. */
export async function createTimedUpstreamMeter({ upstreamUrl, upstreamHeaders = {}, model = 'k3', deadlineAt, onDeadline = () => {}, onFailure = () => {} }) {
  let target;
  try { target = new URL(upstreamUrl); } catch { throw fail('TIMED_UPSTREAM_CONFIGURATION_INVALID'); }
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.hash ||
      !Number.isFinite(deadlineAt) || deadlineAt <= Date.now() || !upstreamHeaders || typeof upstreamHeaders !== 'object' || Array.isArray(upstreamHeaders) ||
      typeof model !== 'string' || !/^[A-Za-z0-9._/-]{1,128}$/.test(model) ||
      typeof onDeadline !== 'function' || typeof onFailure !== 'function') throw fail('TIMED_UPSTREAM_CONFIGURATION_INVALID');
  const headers = Object.freeze({ ...upstreamHeaders });
  try { for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== 'string') throw fail('TIMED_UPSTREAM_CONFIGURATION_INVALID');
    validateHeaderName(name); validateHeaderValue(name, value);
  } } catch { throw fail('TIMED_UPSTREAM_CONFIGURATION_INVALID'); }
  const deadline = performance.now() + deadlineAt - Date.now();
  const records = [], pending = new Set();
  let forwarded = 0, inputBytes = 0, actualInputTokens = 0, actualOutputTokens = 0, unknownRequests = 0, conflicts = 0;
  let stopping = false, closed = false, deadlineReached = false, closeWork, timer;
  const notify = (callback, value) => { try { callback(value); } catch { /* Observers cannot own transport teardown. */ } };
  const receipt = () => structuredClone({ profile: 'time_only', model, deadlineAt, deadlineReached, forwarded, active: pending.size,
    inputBytes, actualInputTokens, actualOutputTokens, unknownRequests, conflicts, closed,
    recordsTruncated: forwarded > records.length, requests: records });
  function finish(record, code) {
    if (record.finished) return;
    record.finished = true;
    if (!record.usage || record.conflict || record.observationIncomplete) { unknownRequests++; record.status = record.conflict ? 'conflict' : 'unknown';
      record.code = code ?? 'TERMINAL_USAGE_UNKNOWN'; notify(onFailure, { code: record.code, number: record.number }); }
    else record.status = 'complete';
  }
  function meter(record) {
    let buffer = '', overflow = false;
    const decoder = new TextDecoder();
    return new Transform({ transform(chunk, _encoding, callback) {
      if (!overflow) {
        buffer += decoder.decode(chunk, { stream: true });
        let match;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
          if (Buffer.byteLength(frame) > 1024 ** 2) { overflow = true; break; }
          const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
          let event; try { event = JSON.parse(data); } catch { continue; }
          const status = terminalStatuses.get(event?.type), usage = event.response?.usage;
          if (!status || event.response?.status !== status || event.response?.model !== model || !count(usage?.input_tokens) || !count(usage?.output_tokens)) continue;
          const observation = { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
          if (!record.usage) {
            record.usage = observation; record.terminal = status;
            actualInputTokens = sum(actualInputTokens, observation.inputTokens); actualOutputTokens = sum(actualOutputTokens, observation.outputTokens);
            const reasoningTokens = usage.output_tokens_details?.reasoning_tokens;
            if (count(reasoningTokens)) record.reasoningTokens = reasoningTokens;
          } else if (record.usage.inputTokens !== observation.inputTokens || record.usage.outputTokens !== observation.outputTokens || record.terminal !== status) {
            if (!record.conflict) conflicts++; record.conflict = true;
          }
        }
        if (Buffer.byteLength(buffer) > 1024 ** 2) overflow = true;
        if (overflow) { buffer = ''; record.observationIncomplete = true; }
      }
      callback(null, chunk);
    } });
  }
  const server = createServer((incoming, outgoing) => {
    if (stopping || performance.now() >= deadline) { outgoing.writeHead(503); outgoing.end(); return; }
    if (incoming.method !== 'POST' || incoming.url !== '/v1/responses') { outgoing.writeHead(404); outgoing.end(); return; }
    const record = { number: ++forwarded, status: 'dispatched' };
    if (records.length < 1024) records.push(record);
    const upstream = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, { method: 'POST', headers: {
      'content-type': incoming.headers['content-type'] ?? 'application/json', accept: 'text/event-stream', ...headers,
    } });
    let providerResponse, settled = false;
    const operation = { cancel() { upstream.destroy(); providerResponse?.destroy(); outgoing.destroy(); settle('TRANSPORT_CANCELLED'); } };
    pending.add(operation);
    function settle(code) { if (settled) return; settled = true; pending.delete(operation); finish(record, code); }
    incoming.on('data', chunk => { inputBytes = sum(inputBytes, chunk.length); });
    incoming.on('aborted', () => operation.cancel());
    incoming.on('error', () => operation.cancel());
    outgoing.on('close', () => { if (!outgoing.writableFinished) operation.cancel(); });
    upstream.on('error', () => {
      settle('UPSTREAM_TRANSPORT_UNKNOWN');
      if (!outgoing.headersSent) { outgoing.writeHead(502); outgoing.end(); } else outgoing.destroy();
    });
    upstream.on('response', response => {
      providerResponse = response;
      record.httpStatus = response.statusCode;
      const responseHeaders = Object.fromEntries(Object.entries(response.headers).filter(([key]) => ![
        'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
      ].includes(key)));
      outgoing.writeHead(response.statusCode, responseHeaders);
      response.on('error', () => { settle('UPSTREAM_TRANSPORT_UNKNOWN'); outgoing.destroy(); });
      response.on('aborted', () => { settle('UPSTREAM_TRANSPORT_UNKNOWN'); outgoing.destroy(); });
      const observer = meter(record);
      observer.on('end', () => settle());
      response.pipe(observer).pipe(outgoing);
    });
    incoming.pipe(upstream);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  async function close({ timeoutMs = 5000 } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw fail('TIMED_UPSTREAM_CLOSE_INVALID');
    if (!closeWork) {
      stopping = true; clearTimeout(timer);
      closeWork = (async () => {
        const stopped = new Promise(resolve => server.close(resolve));
        // Stop model transport immediately; timeout only bounds listener teardown.
        for (const operation of [...pending]) operation.cancel();
        server.closeAllConnections();
        let closeTimer;
        try { await Promise.race([stopped, new Promise((_, reject) => { closeTimer = setTimeout(() => reject(fail('TIMED_UPSTREAM_CLOSE_UNKNOWN')), timeoutMs); })]); closed = true; }
        finally { clearTimeout(closeTimer); }
        return receipt();
      })();
    }
    return closeWork;
  }
  function schedule() {
    const remaining = deadline - performance.now();
    if (remaining > 0) { timer = setTimeout(schedule, Math.min(remaining, 2147483647)); return; }
    deadlineReached = true; notify(onDeadline, { code: 'TIMED_UPSTREAM_DEADLINE' });
    void close().catch(() => notify(onFailure, { code: 'TIMED_UPSTREAM_CLOSE_UNKNOWN' }));
  }
  const url = `http://127.0.0.1:${server.address().port}/v1/responses`;
  schedule();
  return Object.freeze({ url, receipt, close });
}

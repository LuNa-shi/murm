import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createCappedUpstream } from './fixtures/core-capped-upstream.js';

async function localUpstream(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}/v1/responses`;
}

test('opted-in request options retain only fixed enums and encrypted-content membership', async t => {
  const received = [];
  const sse = 'data: ' + JSON.stringify({ type: 'response.completed', response: {
    id: 'local-options', model: 'k3', status: 'completed', usage: { input_tokens: 1, output_tokens: 7 },
  } }) + '\n\n';
  const upstreamUrl = await localUpstream(t, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks)));
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(sse);
  });
  const absent = { reasoningEffort: null, reasoningSummary: null, includeReasoningEncryptedContent: null };
  const cases = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(effort => ({
    options: { reasoning: { effort, summary: 'auto' }, include: ['reasoning.encrypted_content'] },
    expected: { reasoningEffort: effort, reasoningSummary: 'auto', includeReasoningEncryptedContent: true },
  }));
  cases.push(
    { options: {}, expected: absent },
    { options: { reasoning: null, include: null }, expected: absent },
    { options: { reasoning: 'PRIVATE', include: 'reasoning.encrypted_content' }, expected: absent },
    { options: { reasoning: { effort: ['medium'], summary: { PRIVATE: 'auto' } }, include: [] },
      expected: { ...absent, includeReasoningEncryptedContent: false } },
    { options: { reasoning: { effort: 'medium\u0000PRIVATE', summary: 'PRIVATE'.repeat(1024), PRIVATE: 'PRIVATE' },
      include: [{ PRIVATE: 'reasoning.encrypted_content' }, 'PRIVATE'] }, expected: { ...absent, includeReasoningEncryptedContent: false } },
    { options: { reasoning: { effort: 1, summary: 'concise' }, include: Array(256).fill('PRIVATE').concat('reasoning.encrypted_content') },
      expected: { ...absent, reasoningSummary: 'concise', includeReasoningEncryptedContent: true } },
    { options: { reasoning: { effort: false, summary: 'detailed' }, include: ['reasoning.encrypted_content.PRIVATE'] },
      expected: { ...absent, reasoningSummary: 'detailed', includeReasoningEncryptedContent: false } },
  );
  const cap = await createCappedUpstream({ upstreamUrl, deadlineAt: Date.now() + 5000, maxRequests: cases.length,
    maxOutputTokens: 64, filename: 'unused', marker: 'unused', failFast: true, recordGeometry: true });
  t.after(() => cap.close());
  for (const [index, { options, expected }] of cases.entries()) {
    const body = { model: 'k3', input: [], max_output_tokens: 9999, ...options };
    const response = await fetch(cap.url, { method: 'POST', body: JSON.stringify(body) });
    assert.equal(await response.text(), sse);
    assert.deepEqual(received[index], { ...body, max_output_tokens: 64 });
    assert.deepEqual(cap.receipt().requests[index].requestOptions, expected);
  }
  const receipt = cap.receipt();
  assert.equal(receipt.reservedOutputTokens, cases.length * 64);
  assert.equal(receipt.failure, undefined);
  assert.equal(JSON.stringify(receipt).includes('PRIVATE'), false);
});

test('opted-in terminal geometry records safe provider counts without changing capped forwarding or SSE bytes', async t => {
  let received;
  const terminal = {
    type: 'response.completed',
    response: {
      id: 'local-terminal', model: 'k3', status: 'completed', max_output_tokens: 768,
      usage: { input_tokens: 10, output_tokens: 700, output_tokens_details: { reasoning_tokens: 600, private: 'private-detail' } },
      output: [
        { type: 'reasoning', summary: [{ text: 'private-reasoning' }] },
        { type: 'function_call', arguments: 'private-arguments' },
        { type: 'message', content: 'private-content' },
        { type: 'private-output-type', private: 'private-item' },
      ],
    },
  };
  const sse = 'data: ' + JSON.stringify(terminal) + '\n\n';
  const upstreamUrl = await localUpstream(t, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(sse);
  });
  const cap = await createCappedUpstream({ upstreamUrl, deadlineAt: Date.now() + 2000, maxRequests: 1,
    maxOutputTokens: 768, filename: 'unused', marker: 'unused', failFast: true, recordGeometry: true });
  t.after(() => cap.close());
  const response = await fetch(cap.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input: [], max_output_tokens: 9999 }) });
  assert.equal(await response.text(), sse);
  assert.equal(received.max_output_tokens, 768);
  const receipt = cap.receipt();
  assert.deepEqual(receipt.requests[0].terminalGeometry, {
    status: 'completed', modelMatches: true, maxOutputTokens: 768, reasoningTokens: 600,
    outputItems: { reasoning: 1, message: 1, function_call: 1, other: 1 }, outputItemsTruncated: false,
  });
  assert.deepEqual(receipt.requests[0].usage, { inputTokens: 10, outputTokens: 700 });
  assert.equal(receipt.reservedOutputTokens, 768);
  assert.equal(receipt.failure, undefined);
  assert.equal(JSON.stringify(receipt).includes('private-'), false);
});

test('optional terminal details stay bounded and cannot bypass the first output overage fence', async t => {
  const malformed = [undefined, null, 'private-detail', { reasoning_tokens: -1 },
    { reasoning_tokens: 1.5 }, { reasoning_tokens: Number.MAX_SAFE_INTEGER + 1 },
    { reasoning_tokens: { private: 'private-token-value' } }];
  for (const [index, details] of malformed.entries()) await t.test(`optional detail case ${index}`, async t => {
    const output = [null, { type: { toString: null } }, ...Array.from({ length: 128 }, () => ({ type: 'message' }))];
    const first = { type: 'response.completed', response: {
      id: 'first-overage', model: 'private-model', status: 'private-status', max_output_tokens: -1,
      usage: { input_tokens: 10, output_tokens: 865, output_tokens_details: details }, output,
    } };
    const second = { type: 'response.completed', response: {
      id: 'first-overage', model: 'k3', status: 'completed', max_output_tokens: 768,
      usage: { input_tokens: 10, output_tokens: 3, output_tokens_details: { reasoning_tokens: 0 } }, output: [],
    } };
    const upstreamUrl = await localUpstream(t, (request, response) => {
      request.resume();
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: ' + JSON.stringify(first) + '\n\ndata: ' + JSON.stringify(second) + '\n\n');
    });
    const cap = await createCappedUpstream({ upstreamUrl, deadlineAt: Date.now() + 2000, maxRequests: 2,
      maxOutputTokens: 768, filename: 'unused', marker: 'unused', failFast: true, recordGeometry: true });
    t.after(() => cap.close());
    const send = () => fetch(cap.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input: [],
      reasoning: { effort: { private: 'private-effort' }, summary: ['private-summary'] }, include: 'private-include' }) });
    const response = await send().catch(() => null);
    await response?.text().catch(() => {});
    const receipt = cap.receipt();
    assert.deepEqual(receipt.failure, { code: 'LIVE_OUTPUT_LIMIT_EXCEEDED', number: 1, maxOutputTokens: 768, outputTokens: 865 });
    assert.deepEqual(receipt.requests[0].usage, { inputTokens: 10, outputTokens: 865 });
    assert.deepEqual(receipt.requests[0].requestOptions, {
      reasoningEffort: null, reasoningSummary: null, includeReasoningEncryptedContent: null,
    });
    assert.deepEqual(receipt.requests[0].terminalGeometry, {
      status: 'other', modelMatches: false,
      outputItems: { reasoning: 0, message: 126, function_call: 0, other: 2 }, outputItemsTruncated: true,
    });
    assert.equal(receipt.requests[0].transport.firstTermination.kind, 'output_limit_exceeded');
    assert.equal(JSON.stringify(receipt).includes('private-'), false);
    assert.equal((await send()).status, 400);
    assert.equal(cap.receipt().forwarded, 1);
  });
});

test('terminal geometry keeps the first replay observation and omits unavailable optional fields', async t => {
  const first = { type: 'response.completed', response: {
    id: 'stable-terminal', usage: { input_tokens: 10, output_tokens: 7 },
  } };
  const replay = { type: 'response.completed', response: {
    ...first.response, model: 'k3', status: 'completed', max_output_tokens: 0,
    usage: { ...first.response.usage, output_tokens_details: { reasoning_tokens: 0 } }, output: [],
  } };
  const sse = 'data: ' + JSON.stringify(first) + '\n\ndata: ' + JSON.stringify(replay) + '\n\n';
  const upstreamUrl = await localUpstream(t, (request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(sse);
  });
  const cap = await createCappedUpstream({ upstreamUrl, deadlineAt: Date.now() + 2000, maxRequests: 2,
    maxOutputTokens: 768, filename: 'unused', marker: 'unused', failFast: true, recordGeometry: true });
  t.after(() => cap.close());
  const response = await fetch(cap.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input: [] }) });
  assert.equal(await response.text(), sse);
  const receipt = cap.receipt();
  assert.deepEqual(receipt.requests[0].terminalGeometry, { status: 'other', modelMatches: false });
  assert.equal(receipt.failure, undefined);
  assert.equal(receipt.reservedOutputTokens, 768);
});

test('conflicting hosted terminal usage cannot replace the first metered receipt or admit another request', async t => {
  const upstreamUrl = await localUpstream(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const outputTokens of [700, 3]) response.write('data: ' + JSON.stringify({ type: 'response.completed', response: {
      id: 'same-response', usage: { input_tokens: 10, output_tokens: outputTokens }, output: [] } }) + '\n\n');
    response.end();
  });
  const cap = await createCappedUpstream({ upstreamUrl, deadlineAt: Date.now() + 2000, maxRequests: 2,
    maxOutputTokens: 768, filename: 'unused', marker: 'unused', failFast: true });
  t.after(() => cap.close());
  const send = () => fetch(cap.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input: [] }) });
  const response = await send();
  try { await response.text(); } catch { /* The conflicting stream is terminated. */ }
  const receipt = cap.receipt();
  assert.deepEqual(receipt.failure, { code: 'LIVE_TERMINAL_CONFLICT', number: 1 });
  assert.deepEqual(receipt.requests[0].usage, { inputTokens: 10, outputTokens: 700 });
  assert.deepEqual(receipt.requests[0].terminalConflict, { terminal: 'response.completed', responseIdentityMatches: true,
    usage: { inputTokens: 10, outputTokens: 3 } });
  assert.equal((await send()).status, 400);
  assert.equal(cap.receipt().forwarded, 1);
});

test('hosted terminal replay is idempotent but remapped response identity fails without retaining the new identity', async t => {
  for (const remapped of [false, true]) await t.test(remapped ? 'remapped identity' : 'identical replay', async t => {
    const originalId = 'a'.repeat(256) + '-original', replacementId = 'a'.repeat(256) + '-private-remap';
    const upstreamUrl = await localUpstream(t, (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const id of [originalId, remapped ? replacementId : originalId]) response.write('data: ' + JSON.stringify({ type: 'response.completed', response: {
        id, usage: { input_tokens: 10, output_tokens: 700 }, output: [] } }) + '\n\n');
      response.end();
    });
    const cap = await createCappedUpstream({ upstreamUrl, deadlineAt: Date.now() + 2000, maxRequests: 2,
      maxOutputTokens: 768, filename: 'unused', marker: 'unused', failFast: true });
    t.after(() => cap.close());
    const send = () => fetch(cap.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input: [] }) });
    const response = await send();
    try { await response.text(); } catch { /* A conflicting stream is terminated. */ }
    const receipt = cap.receipt();
    assert.deepEqual(receipt.requests[0].usage, { inputTokens: 10, outputTokens: 700 });
    assert.equal(receipt.reservedOutputTokens, 768);
    assert.equal(JSON.stringify(receipt).includes('private-remap'), false);
    if (remapped) {
      assert.equal(receipt.failure.code, 'LIVE_TERMINAL_CONFLICT');
      assert.equal(receipt.requests[0].terminalConflict.responseIdentityMatches, false);
      assert.equal((await send()).status, 400);
    } else {
      assert.equal(receipt.failure, undefined);
      const next = await send(); await next.text();
      assert.equal(cap.receipt().forwarded, 2);
    }
  });
});

test('hosted terminal usage fences an overage even when optional tool output is malformed', { timeout: 3000 }, async t => {
  let upstreamResponse;
  const upstreamUrl = await localUpstream(t, (_request, response) => {
    upstreamResponse = response;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(':started\n\n');
  });
  const cap = await createCappedUpstream({ upstreamUrl, deadlineAt: Date.now() + 2000, maxRequests: 2,
    maxOutputTokens: 768, filename: 'unused', marker: 'unused', failFast: true, recordGeometry: true });
  t.after(() => cap.close());
  const send = () => fetch(cap.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input: [] }) });
  const response = await send();
  const terminal = (outputTokens, output) => 'data: ' + JSON.stringify({ type: 'response.completed', response: {
    id: 'metered-response', usage: { input_tokens: 10, output_tokens: outputTokens }, output } }) + '\n\n';
  upstreamResponse.end(terminal(865, { unexpected: true }) + terminal(3, []));
  let stream = '';
  try { stream = await response.text(); } catch { /* The overage terminates the stream. */ }
  const receipt = cap.receipt();
  assert.deepEqual(receipt.failure, { code: 'LIVE_OUTPUT_LIMIT_EXCEEDED', number: 1, maxOutputTokens: 768, outputTokens: 865 });
  assert.deepEqual(receipt.requests[0].usage, { inputTokens: 10, outputTokens: 865 });
  assert.deepEqual(receipt.requests[0].terminalGeometry, { status: 'other', modelMatches: false });
  assert.equal(stream.includes('response.completed'), false);
  assert.equal((await send()).status, 400);
  assert.equal(cap.receipt().forwarded, 1);
});

test('hosted output overage fences forwarding and cancels the active peer before exposing that terminal chunk', { timeout: 3000 }, async t => {
  const requested = [], held = [], failures = [];
  const upstreamUrl = await localUpstream(t, async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    requested.push(JSON.parse(Buffer.concat(chunks)).max_output_tokens);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(':held\n\n'); held.push(response);
  });
  const cap = await createCappedUpstream({ upstreamUrl, deadlineAt: Date.now() + 2000, maxRequests: 20,
    maxOutputTokens: 768, maxConcurrent: 2, maxAggregateOutputTokens: 15360, filename: 'unused', marker: 'unused',
    failFast: true, onFailure: failure => failures.push(failure) });
  t.after(() => cap.close());
  const send = () => fetch(cap.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input: [], max_output_tokens: 9999 }) });
  async function collect(response) {
    let body = '';
    try { for await (const chunk of response.body) body += Buffer.from(chunk).toString(); } catch { return body; }
    return body;
  }
  const peer = await send(), peerBody = collect(peer);
  const offender = await send(), offenderBody = collect(offender);
  held[1].end('data: ' + JSON.stringify({ type: 'response.completed', response: {
    id: 'local-overage', usage: { input_tokens: 10, output_tokens: 865 }, output: [] } }) + '\n\n');
  // One overage terminal must abort both readers without waiting for work expiry.
  const bodies = await Promise.all([peerBody, offenderBody]);
  assert.ok(bodies.every(body => !body.includes('response.completed')));
  assert.equal((await send()).status, 400);
  const before = cap.receipt();
  assert.deepEqual(requested, [768, 768]); assert.equal(before.forwarded, 2);
  assert.equal(before.deadlineReached, false); assert.equal(before.rejectedArrivals, 1);
  assert.deepEqual(before.failure, { code: 'LIVE_OUTPUT_LIMIT_EXCEEDED', number: 2, maxOutputTokens: 768, outputTokens: 865 });
  assert.deepEqual(failures, [before.failure]);
  assert.deepEqual(before.requests[1].usage, { inputTokens: 10, outputTokens: 865 });
  assert.equal(before.requests[1].transport.firstTermination.kind, 'output_limit_exceeded');
  assert.equal(before.requests[0].transport.firstTermination.kind, 'output_limit_abort');
  await cap.close();
  assert.deepEqual(cap.receipt().failure, before.failure); assert.equal(failures.length, 1);
});

test('ordinary proxy usage observation retains an overreported output without enabling the hosted fence', async t => {
  const requested = [], failures = [];
  const upstreamUrl = await localUpstream(t, async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    requested.push(JSON.parse(Buffer.concat(chunks)).max_output_tokens);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: ' + JSON.stringify({ type: 'response.completed', response: {
      id: 'local-generic', usage: { input_tokens: 10, output_tokens: 865 }, output: [] } }) + '\n\n');
  });
  const cap = await createCappedUpstream({ upstreamUrl, deadlineAt: Date.now() + 2000, maxRequests: 2,
    maxOutputTokens: 768, filename: 'unused', marker: 'unused', onFailure: failure => failures.push(failure) });
  t.after(() => cap.close());
  for (let index = 0; index < 2; index++) {
    const response = await fetch(cap.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input: [] }) });
    assert.equal(response.status, 200); assert.ok((await response.text()).includes('response.completed'));
  }
  assert.deepEqual(requested, [768, 768]); assert.equal(cap.receipt().forwarded, 2);
  assert.equal(cap.receipt().failure, undefined); assert.deepEqual(failures, []);
  assert.ok(cap.receipt().requests.every(row => row.status === 'complete' && row.usage.outputTokens === 865));
});

test('a valid excessive output count fences even when the terminal input count is missing', async t => {
  const upstreamUrl = await localUpstream(t, (request, response) => {
    request.resume(); response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: ' + JSON.stringify({ type: 'response.completed', response: {
      id: 'local-missing-input', usage: { output_tokens: 865 }, output: [] } }) + '\n\n');
  });
  const cap = await createCappedUpstream({ upstreamUrl, deadlineAt: Date.now() + 2000, maxOutputTokens: 768,
    filename: 'unused', marker: 'unused', failFast: true });
  t.after(() => cap.close());
  const response = await fetch(cap.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input: [] }) }).catch(() => null);
  await response?.text().catch(() => {});
  assert.deepEqual(cap.receipt().failure, { code: 'LIVE_OUTPUT_LIMIT_EXCEEDED', number: 1, maxOutputTokens: 768, outputTokens: 865 });
});

test('hosted success without valid usage fences its terminal and the next arrival', { timeout: 4000 }, async t => {
  const invalidUsages = [undefined, {}, { input_tokens: 1 }, { input_tokens: -1, output_tokens: 5 },
    { input_tokens: 1, output_tokens: -1 }, { input_tokens: 1, output_tokens: 1.5 }];
  for (const [index, usage] of invalidUsages.entries()) await t.test(`invalid usage case ${index}`, async t => {
    let calls = 0;
    const failures = [];
    const upstreamUrl = await localUpstream(t, (request, response) => {
      request.resume(); calls++;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'unmetered', usage, output: [] } }) + '\n\n');
    });
    const cap = await createCappedUpstream({ upstreamUrl, deadlineAt: Date.now() + 3000, filename: 'unused', marker: 'unused',
      failFast: true, onFailure: failure => failures.push(failure) });
    t.after(() => cap.close());
    const send = () => fetch(cap.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input: [] }) });
    const response = await send().catch(() => null);
    const body = await response?.text().catch(() => '');
    assert.ok(!body?.includes('response.completed'));
    assert.equal((await send()).status, 400);
    assert.equal(calls, 1);
    const receipt = cap.receipt();
    assert.deepEqual(receipt.failure, { code: 'LIVE_TERMINAL_USAGE_INVALID', number: 1 });
    assert.deepEqual(failures, [receipt.failure]);
    assert.equal(receipt.requests[0].usage, undefined);
    await cap.close();
    assert.deepEqual(cap.receipt().failure, receipt.failure);
  });
});

test('hosted stream ending without a terminal fences siblings and later arrivals', { timeout: 4000 }, async t => {
  const held = [], failures = [];
  const upstreamUrl = await localUpstream(t, (request, response) => {
    request.resume(); response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(':held\n\n'); held.push(response);
  });
  const cap = await createCappedUpstream({ upstreamUrl, deadlineAt: Date.now() + 3000, filename: 'unused', marker: 'unused',
    maxConcurrent: 2, failFast: true, onFailure: failure => failures.push(failure) });
  t.after(() => cap.close());
  const send = () => fetch(cap.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input: [] }) });
  const peer = await send(), peerBody = peer.text().catch(() => 'cancelled');
  const offender = await send(), offenderBody = offender.text().catch(() => 'cancelled');
  held[1].end();
  await Promise.all([peerBody, offenderBody]);
  assert.equal((await send()).status, 400);
  const receipt = cap.receipt();
  assert.equal(receipt.forwarded, 2); assert.equal(receipt.deadlineReached, false);
  assert.deepEqual(receipt.failure, { code: 'LIVE_TERMINAL_MISSING', number: 2 });
  assert.deepEqual(failures, [receipt.failure]);
  assert.equal(receipt.requests[1].transport.firstTermination.kind, 'upstream_end');
  assert.equal(receipt.requests[0].transport.firstTermination.kind, 'terminal_missing_abort');
});

test('hosted unmetered transport loss fences later dispatches exactly once', { timeout: 5000 }, async t => {
  for (const mode of ['stream', 'request', 'client']) await t.test(mode, async t => {
    let held, calls = 0;
    const failures = [];
    const upstreamUrl = await localUpstream(t, (request, response) => {
      request.resume(); calls++;
      if (mode === 'request') { request.socket.destroy(); return; }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(':held\n\n'); held = response;
    });
    const cap = await createCappedUpstream({ upstreamUrl, deadlineAt: Date.now() + 3000,
      filename: 'unused', marker: 'unused', failFast: true, onFailure: failure => failures.push(failure) });
    t.after(() => cap.close());
    const send = options => fetch(cap.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input: [] }), ...options });
    const controller = new AbortController();
    const first = await send({ signal: controller.signal }).catch(() => null);
    const body = first?.text().catch(() => 'cancelled');
    if (mode === 'stream') held.destroy();
    if (mode === 'client') controller.abort();
    await body;
    // A client abort resolves locally before the proxy receives its close event.
    if (mode === 'client') await once(held, 'close');
    assert.equal((await send()).status, 400);
    const receipt = cap.receipt();
    assert.equal(calls, 1); assert.equal(receipt.forwarded, 1);
    assert.equal(receipt.reservedOutputTokens, receipt.maxOutputTokens);
    assert.equal(receipt.requests[0].usage, undefined);
    assert.equal(receipt.deadlineReached, false);
    assert.deepEqual(receipt.failure, { code: 'LIVE_UNMETERED_TRANSPORT_LOSS', number: 1 });
    assert.deepEqual(failures, [receipt.failure]);
    assert.equal(receipt.requests[0].transport.firstTermination.kind,
      mode === 'stream' ? 'upstream_error' : mode === 'request' ? 'request_error' : 'client_close');
    await cap.close();
    assert.deepEqual(cap.receipt().failure, receipt.failure); assert.equal(failures.length, 1);
  });
});

test('hosted transport loss cancels an unmetered peer without replacing the first failure', { timeout: 3000 }, async t => {
  const held = [], failures = [];
  const upstreamUrl = await localUpstream(t, (request, response) => {
    request.resume(); response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(':held\n\n'); held.push(response);
  });
  const cap = await createCappedUpstream({ upstreamUrl, deadlineAt: Date.now() + 2000,
    filename: 'unused', marker: 'unused', failFast: true, onFailure: failure => failures.push(failure) });
  t.after(() => cap.close());
  const send = () => fetch(cap.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input: [] }) });
  const peer = await send(), peerBody = peer.text().catch(() => 'cancelled');
  const offender = await send(), offenderBody = offender.text().catch(() => 'cancelled');
  held[1].destroy();
  await Promise.all([peerBody, offenderBody]);
  const receipt = cap.receipt();
  assert.deepEqual(receipt.failure, { code: 'LIVE_UNMETERED_TRANSPORT_LOSS', number: 2 });
  assert.deepEqual(failures, [receipt.failure]);
  assert.equal(receipt.requests[0].transport.firstTermination.kind, 'unmetered_transport_abort');
  assert.equal(receipt.requests[1].transport.firstTermination.kind, 'upstream_error');
  assert.equal(receipt.forwarded, 2); assert.equal(receipt.deadlineReached, false);
  assert.equal((await send()).status, 400);
});

test('hosted transport loss after verified terminal usage retains accounting and allows another request', async t => {
  const held = [];
  const upstreamUrl = await localUpstream(t, (request, response) => {
    request.resume(); response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: ' + JSON.stringify({ type: 'response.completed', response: {
      usage: { input_tokens: 2, output_tokens: 3 }, output: [] } }) + '\n\n'); held.push(response);
  });
  const cap = await createCappedUpstream({ upstreamUrl, deadlineAt: Date.now() + 2000,
    filename: 'unused', marker: 'unused', failFast: true });
  t.after(() => cap.close());
  for (let index = 0; index < 2; index++) {
    const response = await fetch(cap.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input: [] }) });
    const body = response.text().catch(() => 'cancelled');
    held[index].destroy(); await body;
  }
  const receipt = cap.receipt();
  assert.equal(receipt.failure, undefined); assert.equal(receipt.forwarded, 2);
  assert.ok(receipt.requests.every(row => row.usage.inputTokens === 2 && row.usage.outputTokens === 3));
});

test('explicit hosted close preserves host cancellation without classifying a missing terminal', { timeout: 3000 }, async t => {
  const upstreamUrl = await localUpstream(t, (request, response) => {
    request.resume(); response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(':held\n\n');
  });
  const failures = [];
  const cap = await createCappedUpstream({ upstreamUrl, deadlineAt: Date.now() + 2000, filename: 'unused', marker: 'unused',
    failFast: true, onFailure: failure => failures.push(failure) });
  t.after(() => cap.close());
  const response = await fetch(cap.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input: [] }) });
  const body = response.text().catch(() => 'cancelled');
  await cap.close(); await body;
  assert.equal(cap.receipt().failure, undefined); assert.deepEqual(failures, []);
  assert.equal(cap.receipt().requests[0].transport.firstTermination.kind, 'proxy_close');
});

test('closing a held HTTP200 stream records host cancellation before its resulting transport error', { timeout: 3000 }, async t => {
  const upstreamUrl = await localUpstream(t, (request, response) => {
    request.resume(); response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(':held\n\n');
  });
  const cap = await createCappedUpstream({ upstreamUrl, deadlineAt: Date.now() + 2000, filename: 'unused', marker: 'unused' });
  t.after(() => cap.close());
  const response = await fetch(cap.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input: [] }) });
  const body = response.text().catch(() => 'aborted');
  await cap.close(); await body;
  const receipt = cap.receipt(), row = receipt.requests[0];
  assert.equal(row.statusCode, 200); assert.equal(row.terminal, undefined); assert.equal(row.usage, undefined);
  assert.equal(row.status, 'stream_failed', 'Legacy status alone must not be interpreted as the cause');
  assert.equal(row.transport.firstTermination.kind, 'proxy_close');
  const events = row.transport.events;
  assert.ok(events.some(event => event.kind === 'upstream_error'));
  assert.ok(events.find(event => event.kind === 'headers').order < row.transport.firstTermination.order);
  for (const event of events.filter(event => ['upstream_error', 'request_error'].includes(event.kind))) {
    assert.ok(event.order > row.transport.firstTermination.order);
  }
  assert.ok(events.every((event, index) => Object.keys(event).sort().join(',') === 'elapsedMs,kind,order' && Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0 &&
    (index === 0 || (event.order > events[index - 1].order && event.elapsedMs >= events[index - 1].elapsedMs))));
  assert.equal(receipt.forwarded, 1); assert.equal(receipt.rejectedArrivals, 0);
});

test('an independently broken upstream stream remains the first termination after later proxy close', { timeout: 3000 }, async t => {
  let held;
  const upstreamUrl = await localUpstream(t, (request, response) => {
    request.resume(); response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(':PRIVATE\n\n'); held = response;
  });
  const cap = await createCappedUpstream({ upstreamUrl, deadlineAt: Date.now() + 2000, filename: 'unused', marker: 'unused' });
  t.after(() => cap.close());
  const response = await fetch(cap.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input: [] }) });
  const body = response.text().catch(() => 'aborted');
  held.destroy(); await body;
  const before = cap.receipt().requests[0].transport.firstTermination;
  assert.equal(before.kind, 'upstream_error');
  await cap.close();
  const row = cap.receipt().requests[0];
  assert.deepEqual(row.transport.firstTermination, before);
  assert.ok(row.transport.events.find(event => event.kind === 'proxy_close').order > before.order);
  assert.equal(row.terminal, undefined); assert.equal(row.statusCode, 200);
  assert.equal(JSON.stringify(cap.receipt()).includes('PRIVATE'), false);
});

test('live peer allowance forwards at most twenty capped requests with recorded usage and cumulative input', async t => {
  let calls = 0;
  const upstreamUrl = await localUpstream(t, async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); assert.equal(body.max_output_tokens, 768); calls++;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: `live-${calls}`, usage: { input_tokens: 10, output_tokens: 5 }, output: [] } }) + '\n\n');
  });
  const cap = await createCappedUpstream({ upstreamUrl, deadlineAt: Date.now() + 180_000, maxRequests: 20, maxConcurrent: 2,
    maxOutputTokens: 768, maxAggregateOutputTokens: 15360, maxInputBytes: 128 * 1024, maxAggregateInputBytes: 512 * 1024, filename: 'unused', marker: 'unused' });
  t.after(() => cap.close());
  for (let index = 0; index < 20; index++) {
    const response = await fetch(cap.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input: [], max_output_tokens: 9999 }) });
    assert.equal(response.status, 200); await response.text();
  }
  assert.equal((await fetch(cap.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input: [] }) })).status, 429);
  const receipt = cap.receipt(); assert.equal(calls, 20); assert.equal(receipt.forwarded, 20); assert.equal(receipt.reservedOutputTokens, 15360);
  assert.equal(receipt.rejectedArrivals, 1); assert.equal(receipt.arrivals, 21);
  assert.equal(receipt.reservedInputBytes, receipt.requests.reduce((sum, row) => sum + row.inputBytes, 0));
  assert.ok(receipt.requests.every(row => row.usage.inputTokens === 10 && row.usage.outputTokens === 5));
});

test('two held peer requests exhaust concurrency without forwarding a third', async t => {
  const held = [];
  const upstreamUrl = await localUpstream(t, (request, response) => {
    request.resume(); response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(':held\n\n'); held.push(response);
  });
  const cap = await createCappedUpstream({ upstreamUrl, deadlineAt: Date.now() + 5000, maxRequests: 20, maxConcurrent: 2,
    maxOutputTokens: 768, maxAggregateOutputTokens: 15360, filename: 'unused', marker: 'unused' });
  t.after(() => cap.close());
  const send = () => fetch(cap.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input: [] }) });
  const first = await send(), second = await send(); assert.equal((await send()).status, 429);
  assert.equal(held.length, 2); assert.equal(cap.receipt().forwarded, 2); assert.equal(cap.receipt().peakConcurrent, 2);
  held.forEach(response => response.end()); await Promise.all([first.text(), second.text()]);
});

test('aggregate input and output budgets reject before forwarding and malformed envelopes spend no allowance', async t => {
  let calls = 0;
  const upstreamUrl = await localUpstream(t, (request, response) => { request.resume(); calls++; response.end(); });
  for (const limit of ['input', 'output']) {
    const cap = await createCappedUpstream({ upstreamUrl, deadlineAt: Date.now() + 5000, maxRequests: 20, maxConcurrent: 2,
      maxOutputTokens: 768, maxAggregateOutputTokens: limit === 'output' ? 768 : 15360, maxInputBytes: 512,
      maxAggregateInputBytes: limit === 'input' ? 100 : 10240, filename: 'unused', marker: 'unused' });
    t.after(() => cap.close());
    const before = calls, send = body => fetch(cap.url, { method: 'POST', body: JSON.stringify(body) });
    assert.equal((await send({ model: 'other', input: [] })).status, 400);
    assert.equal((await send({ model: 'k3', input: {} })).status, 400);
    assert.equal((await send({ model: 'k3', input: ['x'.repeat(600)] })).status, 400);
    assert.equal(cap.receipt().forwarded, 0);
    const body = { model: 'k3', input: ['first'] };
    const first = await send(body); assert.equal(first.status, 200); await first.text();
    assert.equal((await send(body)).status, 429); assert.equal(calls - before, 1);
    assert.equal(cap.receipt().forwarded, 1); assert.equal(cap.receipt().rejectedArrivals, 4);
  }
});

test('capped upstream limits actual forwarding and preserves SSE IDs with capped output', async t => {
  const received = [];
  const sse = 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_preserved","status":"completed","output":[]}}\n\n';
  const upstreamUrl = await localUpstream(t, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({ body: JSON.parse(Buffer.concat(chunks).toString()), headers: request.headers });
    response.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'upstream-id' });
    response.end(sse);
  });
  const cap = await createCappedUpstream({ upstreamUrl, upstreamHeaders: { authorization: 'Bearer local-test-only' },
    deadlineAt: Date.now() + 2000, maxRequests: 1, maxOutputTokens: 64, filename: 'check.txt', marker: 'EXPECTED' });
  t.after(() => cap.close());
  const body = JSON.stringify({ model: 'k3', input: [], max_output_tokens: 1000 });
  const first = await fetch(cap.url, { method: 'POST', headers: { 'x-swarmenv-request-id': 'original-id' }, body });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('x-request-id'), 'upstream-id');
  assert.equal(await first.text(), sse);
  assert.deepEqual(cap.receipt().requests[0].transport.events.map(event => event.kind), ['headers', 'terminal', 'upstream_end']);
  assert.equal(cap.receipt().requests[0].transport.firstTermination.kind, 'upstream_end');
  assert.equal(received[0].body.max_output_tokens, 64);
  assert.equal(cap.receipt().requests[0].geometry, undefined);
  assert.equal(cap.receipt().requests[0].requestOptions, undefined);
  assert.equal(cap.receipt().requests[0].terminalGeometry, undefined);
  assert.equal(received[0].headers['x-swarmenv-request-id'], 'original-id');
  assert.equal(received[0].headers.authorization, 'Bearer local-test-only');
  assert.equal((await fetch(cap.url, { method: 'POST', body })).status, 429);
  assert.equal(received.length, 1);
  assert.equal(cap.receipt().forwarded, 1);
  assert.equal(cap.receipt().arrivals, 2);
  assert.equal(JSON.stringify(cap.receipt()).includes('local-test-only'), false);
});

test('deadline aborts an active upstream and prevents any later forwarding', async t => {
  for (const failFast of [false, true]) await t.test(`failFast ${failFast}`, async t => {
    let requests = 0;
    const upstreamUrl = await localUpstream(t, (_request, response) => {
      requests += 1;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('event: response.created\ndata: {"type":"response.created","response":{"id":"r"}}\n\n');
    });
    const cap = await createCappedUpstream({ upstreamUrl, deadlineAt: Date.now() + 100,
      filename: 'check.txt', marker: 'EXPECTED', failFast });
    t.after(() => cap.close());
    const request = await fetch(cap.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input: [] }) });
    await assert.rejects(request.text());
    assert.equal(cap.receipt().deadlineReached, true);
    assert.equal(cap.receipt().requests[0].transport.firstTermination.kind, 'work_expiry');
    assert.equal((await fetch(cap.url, { method: 'POST', body: '{}' })).status, 429);
    assert.equal(requests, 1);
    assert.equal(cap.receipt().failure, undefined);
    await cap.close();
    assert.equal(cap.receipt().requests[0].transport.firstTermination.kind, 'work_expiry');
  });
});

test('only correlated Bash and read tool results verify the requested file effect', async t => {
  let count = 0;
  const upstreamUrl = await localUpstream(t, async (request, response) => {
    for await (const _chunk of request) { /* Consume the request before responding. */ }
    count += 1;
    const item = count === 1
      ? { type: 'function_call', name: 'bash', call_id: 'bash-real', arguments: JSON.stringify({ command: "printf 'EXPECTED' > check.txt" }) }
      : { type: 'function_call', name: 'read', call_id: 'read-real', arguments: JSON.stringify({ path: '/workspace/project/check.txt' }) };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ type: 'response.output_item.done', item })}\n\n`);
  });
  const cap = await createCappedUpstream({ upstreamUrl, deadlineAt: Date.now() + 2000, filename: 'check.txt', marker: 'EXPECTED' });
  t.after(() => cap.close());
  const send = async input => {
    const response = await fetch(cap.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input }) });
    await response.text();
  };
  await send([{ role: 'assistant', content: 'EXPECTED' }]);
  assert.equal(cap.receipt().readVerified, false);
  await send([{ type: 'function_call_output', call_id: 'bash-real', output: '(no tool output)' }]);
  assert.equal(cap.receipt().bashReturned, true);
  await send([{ type: 'function_call_output', call_id: 'unrelated', output: 'EXPECTED' }]);
  assert.equal(cap.receipt().readVerified, false);
  await send([{ type: 'function_call_output', call_id: 'read-real', output: ' EXPECTED\n' }]);
  assert.equal(cap.receipt().readVerified, false);
  await send([{ type: 'function_call_output', call_id: 'read-real', output: 'EXPECTED' }]);
  assert.equal(cap.receipt().readVerified, false);
  await send([{ type: 'function_call_output', call_id: 'read-real', output: 'EXPECTED\n' }]);
  assert.equal(cap.receipt().readVerified, true);
});

test('invalid credentials and provider failures produce sanitized proxy errors', async t => {
  const upstreamUrl = await localUpstream(t, () => {});
  const cap = await createCappedUpstream({ upstreamUrl, upstreamHeaders: { authorization: 'private\nvalue' },
    deadlineAt: Date.now() + 2000, filename: 'check.txt', marker: 'EXPECTED' });
  t.after(() => cap.close());
  const response = await fetch(cap.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input: [] }) });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: { code: 'LIVE_UPSTREAM_FAILED', message: 'LIVE_UPSTREAM_FAILED' } });
  assert.equal(JSON.stringify(cap.receipt()).includes('private'), false);
  await assert.rejects(createCappedUpstream({ upstreamUrl: 'not a url secret', deadlineAt: Date.now() + 2000,
    filename: 'check.txt', marker: 'EXPECTED' }), { message: 'LIVE_UPSTREAM_CONFIGURATION_INVALID' });
});

test('selection-only capped upstream omits tool definitions and tool_choice for its single request', async t => {
  let actual;
  const upstreamUrl = await localUpstream(t, async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    actual = JSON.parse(Buffer.concat(chunks));
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('data: [DONE]\n\n');
  });
  const cap = await createCappedUpstream({ upstreamUrl, deadlineAt: Date.now() + 2000, maxRequests: 1, maxOutputTokens: 512,
    filename: 'unused', marker: 'FLAT_SELECTION_OK', disableTools: true });
  t.after(() => cap.close());
  await (await fetch(cap.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input: [], tools: [{ type: 'function', name: 'bash', parameters: { type: 'object' } }], tool_choice: 'auto' }) })).text();
  assert.equal(Object.hasOwn(actual, 'tools'), false);
  assert.equal(Object.hasOwn(actual, 'tool_choice'), false);
  assert.equal(actual.max_output_tokens, 512);
  assert.equal(cap.receipt().forwarded, 1);
  assert.equal(cap.receipt().requests[0].toolsMode, 'omitted');
});

test('provider rejection records only status and finite whitelisted classification without raw secrets', async t => {
  const upstreamUrl = await localUpstream(t, async (request, response) => {
    for await (const _chunk of request) { /* consume */ }
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { code: 'unsupported_parameter', type: 'invalid_request_error', param: 'tool_choice', message: 'private-raw-provider-message' } }));
  });
  const cap = await createCappedUpstream({ upstreamUrl, deadlineAt: Date.now() + 2000, maxRequests: 1,
    maxOutputTokens: 512, filename: 'unused', marker: 'FLAT_SELECTION_OK', disableTools: true });
  t.after(() => cap.close());
  const response = await fetch(cap.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input: [] }) });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: { code: 'LIVE_PROVIDER_REJECTED', message: 'LIVE_PROVIDER_REJECTED' } });
  const receipt = cap.receipt();
  assert.equal(receipt.forwarded, 1);
  assert.deepEqual(receipt.requests[0].rejection, { code: 'unsupported_parameter', type: 'invalid_request_error', param: 'tool_choice' });
  assert.equal(receipt.requests[0].statusCode, 400);
  assert.equal(receipt.requests[0].status, 'rejected');
  assert.equal(JSON.stringify(receipt).includes('private-raw'), false);
});

test('unknown provider error labels and oversized rejection bodies collapse to fixed other fields', async t => {
  for (const body of [JSON.stringify({ error: { code: 'private-secret-code', type: 'private-secret-type', param: 'private-secret-param', message: 'private-secret-message' } }), 'private-secret-body'.repeat(5000)]) {
    const upstreamUrl = await localUpstream(t, async (request, response) => {
      for await (const _chunk of request) { /* consume */ }
      response.writeHead(400); response.end(body);
    });
    const cap = await createCappedUpstream({ upstreamUrl, deadlineAt: Date.now() + 2000, maxRequests: 1,
      maxOutputTokens: 512, filename: 'unused', marker: 'FLAT_SELECTION_OK', disableTools: true });
    t.after(() => cap.close());
    const response = await fetch(cap.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input: [] }) });
    assert.deepEqual(await response.json(), { error: { code: 'LIVE_PROVIDER_REJECTED', message: 'LIVE_PROVIDER_REJECTED' } });
    assert.deepEqual(cap.receipt().requests[0].rejection, { code: 'other', type: 'other', param: 'other' });
    assert.equal(JSON.stringify(cap.receipt()).includes('private-secret'), false);
  }
});

test('hosted fail-fast fences all later forwards after the first classified provider rejection', async t => {
  let calls = 0, failures = 0;
  const upstreamUrl = await localUpstream(t, (request, response) => {
    request.resume(); calls++;
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { code: 'invalid_request_error', type: 'invalid_request_error', param: 'private-param', message: 'private-provider-detail' } }));
  });
  const cap = await createCappedUpstream({ upstreamUrl, deadlineAt: Date.now() + 5000, filename: 'unused', marker: 'unused',
    failFast: true, onFailure: failure => { failures++; assert.equal(failure.code, 'LIVE_PROVIDER_REJECTED'); } });
  t.after(() => cap.close());
  const send = () => fetch(cap.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input: [] }) });
  const first = await send(); assert.equal(first.status, 400); await first.text();
  const retries = await Promise.all(Array.from({ length: 4 }, send));
  for (const retry of retries) { assert.equal(retry.status, 400); await retry.text(); }
  assert.equal(calls, 1); assert.equal(failures, 1); assert.equal(cap.receipt().forwarded, 1);
  assert.equal(cap.receipt().rejectedArrivals, 4);
  assert.deepEqual(cap.receipt().failure, { code: 'LIVE_PROVIDER_REJECTED', number: 1, statusCode: 400,
    rejection: { code: 'invalid_request_error', type: 'invalid_request_error', param: 'other' } });
  assert.equal(JSON.stringify(cap.receipt()).includes('private'), false);
});

test('hosted first rejection cancels an already active peer and prevents a callback race from forwarding', async t => {
  let calls = 0, cap, raced;
  const upstreamUrl = await localUpstream(t, (request, response) => {
    request.resume(); calls++;
    if (calls === 1) { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(':held\n\n'); }
    else { response.writeHead(400); response.end('{"error":{"code":"invalid_request_error"}}'); }
  });
  const send = () => fetch(cap.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input: [] }) });
  cap = await createCappedUpstream({ upstreamUrl, deadlineAt: Date.now() + 5000, filename: 'unused', marker: 'unused',
    maxConcurrent: 2, failFast: true, onFailure: () => { raced = send(); } });
  t.after(() => cap.close());
  const peer = await send(); const peerBody = assert.rejects(peer.text());
  const rejected = await send(); assert.equal(rejected.status, 400); await rejected.text(); await peerBody;
  const race = await raced; assert.equal(race.status, 400); await race.text();
  assert.equal(calls, 2); assert.equal(cap.receipt().forwarded, 2); assert.equal(cap.receipt().failure.number, 2);
  assert.equal(cap.receipt().requests[0].status, 'failure_aborted');
});

test('provider history diagnostics retain finite protocol hints without indexed paths or raw error text', async t => {
  const upstreamUrl = await localUpstream(t, (request, response) => {
    request.resume(); response.writeHead(400);
    response.end(JSON.stringify({ error: { code: 'invalid_request_error', type: 'invalid_request_error',
      param: 'input[4].reasoning_content', message: 'private text: required reasoning_content missing for function_call; call_id not found' } }));
  });
  const cap = await createCappedUpstream({ upstreamUrl, deadlineAt: Date.now() + 5000, filename: 'unused', marker: 'unused', failFast: true });
  t.after(() => cap.close());
  const response = await fetch(cap.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input: [
    { type: 'reasoning', id: 'rs_local', status: 'completed', summary: [{ type: 'summary_text', text: 'local private reasoning' }] },
    { type: 'function_call', id: 'fc_local', call_id: 'bash_local', name: 'bash', arguments: '{}' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '', annotations: [] }] },
    { type: 'function_call_output', call_id: 'bash_local', output: 'local private result' },
  ] }) });
  await response.text();
  assert.deepEqual(cap.receipt().failure.rejection.hints, ['reasoning_content', 'call_id', 'function_call', 'missing', 'unmatched']);
  const serialized = JSON.stringify(cap.receipt());
  for (const raw of ['private', 'input[4]', 'rs_local', 'bash_local', 'fc_local']) assert.equal(serialized.includes(raw), false);
});

test('hosted rejection headers fence and cancel the peer while the error body remains held', async t => {
  let calls = 0, failures = 0, releaseHeaders;
  const headersSent = new Promise(resolve => { releaseHeaders = resolve; });
  const held = [];
  const upstreamUrl = await localUpstream(t, (request, response) => {
    request.resume(); calls++; held.push(response);
    if (calls === 1) { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(':held\n\n'); }
    else if (calls === 2) { response.writeHead(400); response.flushHeaders(); releaseHeaders(); }
    else response.end();
  });
  const cap = await createCappedUpstream({ upstreamUrl, deadlineAt: Date.now() + 5000, filename: 'unused', marker: 'unused',
    maxConcurrent: 2, failFast: true, onFailure: () => { failures++; } });
  t.after(() => cap.close());
  const send = () => fetch(cap.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input: [] }) });
  const peer = await send(); const peerBody = peer.text().catch(() => 'aborted');
  const rejected = send(); await headersSent;
  // A local event-loop barrier lets the proxy receive the flushed headers.
  await new Promise(resolve => setTimeout(resolve, 20));
  const snapshot = cap.receipt();
  const later = await send(); await later.text();
  held.forEach(response => response.end('{"error":{"code":"invalid_request_error"}}'));
  await (await rejected).text(); await peerBody;
  assert.equal(snapshot.failure?.number, 2); assert.equal(failures, 1);
  assert.equal(later.status, 400); assert.equal(calls, 2);
  assert.equal(snapshot.requests[0].status, 'failure_aborted');
  assert.equal(cap.receipt().failure.rejection.code, 'invalid_request_error');
});

test('hosted abort/close preserves the first rejection while the error parse window is bounded', async t => {
  let cap, closed;
  const upstreamUrl = await localUpstream(t, (request, response) => {
    request.resume(); response.writeHead(400); response.flushHeaders();
    response.write('{"error":{"message":"private incomplete');
  });
  cap = await createCappedUpstream({ upstreamUrl, deadlineAt: Date.now() + 5000, filename: 'unused', marker: 'unused',
    failFast: true, onFailure: () => { closed = cap.close(); } });
  t.after(() => cap.close());
  const started = Date.now();
  const response = await fetch(cap.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input: [] }) });
  await response.text(); await closed;
  assert.ok(Date.now() - started < 1500);
  assert.equal(cap.receipt().requests[0].rejectionRead, 'timeout');
  assert.equal(cap.receipt().requests[0].status, 'rejected');
  assert.equal(cap.receipt().failure.number, 1); assert.equal(cap.receipt().failure.statusCode, 400);
  assert.deepEqual(cap.receipt().failure.rejection, { code: 'other', type: 'other', param: 'other' });
  assert.equal(JSON.stringify(cap.receipt()).includes('private'), false);
});

test('opted-in outgoing geometry contains only bounded allowlisted structure and exact call matching', async t => {
  const upstreamUrl = await localUpstream(t, (request, response) => { request.resume(); response.end(); });
  const cap = await createCappedUpstream({ upstreamUrl, deadlineAt: Date.now() + 5000, filename: 'unused', marker: 'unused', recordGeometry: true });
  t.after(() => cap.close());
  const send = async input => { const response = await fetch(cap.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input }) }); await response.text(); };
  const input = [
    { role: 'user', content: 'PRIVATE' },
    { type: 'reasoning', summary: [{ type: 'summary_text', text: 'PRIVATE' }], encrypted_content: 'PRIVATE' },
    { type: 'function_call', call_id: 'PRIVATE', arguments: '{"PRIVATE":true}' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '' }] },
    { type: 'function_call_output', call_id: 'PRIVATE', output: 'PRIVATE' },
    { type: 'PRIVATE', content: 'PRIVATE' },
  ];
  await send(input);
  assert.deepEqual(cap.receipt().requests[0].geometry, { itemTypes: ['message', 'reasoning', 'function_call', 'message', 'function_call_output', 'other'],
    itemTypesTruncated: false, functionCalls: 1, functionCallOutputs: 1, callIdsMatched: true, reasoningItems: 1,
    emptyAssistantMessages: 1, emptyAssistantText: 1, reasoningSummaryPresent: 1, reasoningEncryptedContentPresent: 1 });
  await send([...input, { type: 'function_call_output', call_id: 'PRIVATE', output: 'PRIVATE' }]);
  assert.equal(cap.receipt().requests[1].geometry.callIdsMatched, false);
  await send(Array.from({ length: 200 }, () => ({ type: 'PRIVATE' })));
  assert.equal(cap.receipt().requests[2].geometry.itemTypes.length, 128); assert.equal(cap.receipt().requests[2].geometry.itemTypesTruncated, true);
  assert.equal(JSON.stringify(cap.receipt()).includes('PRIVATE'), false);
});

test('hosted redirect headers also fence as non-2xx without following another provider request', async t => {
  let calls = 0;
  const upstreamUrl = await localUpstream(t, (request, response) => { request.resume(); calls++; response.writeHead(302, { location: '/private' }); response.end(); });
  const cap = await createCappedUpstream({ upstreamUrl, deadlineAt: Date.now() + 5000, filename: 'unused', marker: 'unused', failFast: true });
  t.after(() => cap.close());
  const send = () => fetch(cap.url, { method: 'POST', redirect: 'manual', body: JSON.stringify({ model: 'k3', input: [] }) });
  const response = await send(); await response.text(); assert.equal(response.status, 302);
  const later = await send(); await later.text(); assert.equal(later.status, 400);
  assert.equal(calls, 1); assert.equal(cap.receipt().failure.statusCode, 302);
  assert.equal(JSON.stringify(cap.receipt()).includes('private'), false);
});

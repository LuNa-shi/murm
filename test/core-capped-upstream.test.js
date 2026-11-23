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
  assert.equal(received[0].body.max_output_tokens, 64);
  assert.equal(received[0].headers['x-swarmenv-request-id'], 'original-id');
  assert.equal(received[0].headers.authorization, 'Bearer local-test-only');
  assert.equal((await fetch(cap.url, { method: 'POST', body })).status, 429);
  assert.equal(received.length, 1);
  assert.equal(cap.receipt().forwarded, 1);
  assert.equal(cap.receipt().arrivals, 2);
  assert.equal(JSON.stringify(cap.receipt()).includes('local-test-only'), false);
});

test('deadline aborts an active upstream and prevents any later forwarding', async t => {
  let requests = 0;
  const upstreamUrl = await localUpstream(t, (_request, response) => {
    requests += 1;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('event: response.created\ndata: {"type":"response.created","response":{"id":"r"}}\n\n');
  });
  const cap = await createCappedUpstream({ upstreamUrl, deadlineAt: Date.now() + 100,
    filename: 'check.txt', marker: 'EXPECTED' });
  t.after(() => cap.close());
  const request = await fetch(cap.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input: [] }) });
  await assert.rejects(request.text());
  assert.equal(cap.receipt().deadlineReached, true);
  assert.equal((await fetch(cap.url, { method: 'POST', body: '{}' })).status, 429);
  assert.equal(requests, 1);
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

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

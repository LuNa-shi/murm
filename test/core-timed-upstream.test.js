import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createTimedUpstreamMeter } from '../src/environments/endurance/timed-upstream.js';

async function fixture(t, handle, options = {}) {
  const upstream = createServer(handle); upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const meter = await createTimedUpstreamMeter({ upstreamUrl: `http://127.0.0.1:${upstream.address().port}/v1/responses`,
    upstreamHeaders: { authorization: 'Bearer private-controlled' }, deadlineAt: Date.now() + 5000, ...options });
  t.after(() => meter.close()); return meter;
}
const frame = (n, extra = {}) => 'event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response: {
  status: 'completed', model: 'k3', usage: { input_tokens: 2, output_tokens: n }, ...extra } }) + '\n\n';
const send = (meter, body = { model: 'k3', input: 'controlled' }) => fetch(meter.url, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('natural meter preserves wire bytes and admits concurrency and actual usage beyond old token limits', async t => {
  let active = 0, peak = 0; const bodies = [];
  const meter = await fixture(t, async (request, response) => {
    active++; peak = Math.max(peak, active); const chunks = [];
    for await (const chunk of request) chunks.push(chunk); bodies.push(Buffer.concat(chunks).toString());
    await new Promise(resolve => setTimeout(resolve, 20)); response.setHeader('content-type', 'text/event-stream');
    response.end(frame(1111)); active--;
  });
  const body = { model: 'k3', input: 'controlled', reasoning: { effort: 'medium' } };
  const responses = await Promise.all(Array.from({ length: 6 }, () => send(meter, body)));
  assert.deepEqual(await Promise.all(responses.map(response => response.text())), Array(6).fill(frame(1111)));
  assert.equal(peak, 6); assert.ok(bodies.every(value => value === JSON.stringify(body)));
  const receipt = await meter.close();
  assert.equal(receipt.profile, 'time_only'); assert.equal(receipt.forwarded, 6); assert.equal(receipt.actualOutputTokens, 6666);
  assert.equal(receipt.peakConcurrent, 6);
  assert.equal(receipt.actualInputTokens, 12); assert.equal(receipt.unknownRequests, 0); assert.equal(receipt.closed, true);
  assert.ok(!JSON.stringify(receipt).includes('private-controlled')); assert.ok(!JSON.stringify(receipt).includes('controlled'));
});

test('a provider rejection records only finite diagnostics while preserving both request and response', async t => {
  const input = [
    { type: 'reasoning', encrypted_content: 'do-not-record-reasoning' },
    { type: 'function_call', call_id: 'do-not-record-id', arguments: 'do-not-record-arguments' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '' }] },
    { type: 'function_call_output', call_id: 'do-not-record-id', output: 'do-not-record-tool-output' },
  ];
  const body = { model: 'k3', input, reasoning: { effort: 'medium' }, max_output_tokens: 98_000 };
  const rejection = JSON.stringify({ error: { code: 'invalid_request_error', message: 'required reasoning_content missing. do-not-record-message' } });
  const meter = await fixture(t, async (request, response) => {
    const bytes = Buffer.from(JSON.stringify(body));
    assert.equal(request.headers['content-length'], String(bytes.length));
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), bytes);
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(rejection);
  });
  const response = await send(meter, body);
  assert.equal(response.status, 400); assert.equal(await response.text(), rejection);
  const receipt = await meter.close(), [record] = receipt.requests;
  assert.equal(receipt.unknownRequests, 1);
  assert.deepEqual(record.request, { messages: 1, reasoning: 1, calls: 1, results: 1, emptyAssistant: 1,
    encryptedReasoning: 1, callIdsMatched: true, reasoningEffort: 'medium', maxOutputTokens: 98_000 });
  assert.deepEqual(record.rejection, { code: 'invalid_request_error', hints: ['reasoning_content', 'missing'] });
  assert.ok(!JSON.stringify(receipt).includes('do-not-record'));
});

test('unknown usage and conflicting replay stay visible while independent requests and provider errors continue normally', async t => {
  let n = 0;
  const meter = await fixture(t, async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    n++; response.setHeader('content-type', 'text/event-stream');
    if (n === 1) { response.writeHead(429, { 'retry-after': '2' }); response.end('provider ordinary retry response'); }
    else if (n === 2) response.end(frame(964) + frame(964));
    else if (n === 3) response.end(frame(1111) + frame(1112));
    else response.end(frame(7));
  });
  const first = await send(meter); assert.equal(first.status, 429); assert.equal(first.headers.get('retry-after'), '2');
  assert.equal(await first.text(), 'provider ordinary retry response');
  for (let i = 0; i < 3; i++) await (await send(meter)).text();
  const receipt = await meter.close();
  assert.equal(receipt.forwarded, 4); assert.equal(receipt.unknownRequests, 2); assert.equal(receipt.conflicts, 1);
  assert.equal(receipt.actualOutputTokens, 2082); assert.deepEqual(receipt.requests.map(row => row.status), ['unknown', 'complete', 'conflict', 'complete']);
});

test('time expiry cancels outstanding transport and closes listener without fabricating missing usage', async t => {
  let deadlineEvents = 0;
  const meter = await fixture(t, async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    response.setHeader('content-type', 'text/event-stream'); response.write(': waiting\n\n');
  }, { deadlineAt: Date.now() + 250, onDeadline: () => deadlineEvents++ });
  const response = await send(meter);
  await assert.rejects(response.text());
  const receipt = await meter.close();
  assert.equal(deadlineEvents, 1); assert.equal(receipt.deadlineReached, true); assert.equal(receipt.active, 0);
  assert.equal(receipt.unknownRequests, 1); assert.equal(receipt.actualOutputTokens, 0); assert.equal(receipt.closed, true);
});

test('unobservable oversized terminal framing is unknown and never truncates model response delivery', async t => {
  const body = frame(3) + 'data: ' + 'x'.repeat(1024 ** 2 + 1) + '\n\n' + frame(4);
  const meter = await fixture(t, async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    response.setHeader('content-type', 'text/event-stream'); response.end(body);
  });
  assert.equal(await (await send(meter)).text(), body);
  const receipt = await meter.close();
  assert.equal(receipt.unknownRequests, 1); assert.equal(receipt.requests[0].observationIncomplete, true);
});

test('a foreign model terminal never becomes trusted usage for this private owner', async t => {
  const meter = await fixture(t, async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    response.setHeader('content-type', 'text/event-stream'); response.end(frame(900, { model: 'foreign' }));
  });
  await (await send(meter)).text(); const receipt = await meter.close();
  assert.equal(receipt.unknownRequests, 1); assert.equal(receipt.actualOutputTokens, 0);
});

test('metadata retention does not become a request admission cap', async t => {
  const meter = await fixture(t, async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    response.setHeader('content-type', 'text/event-stream'); response.end(frame(1));
  }, { deadlineAt: Date.now() + 15000 });
  for (let offset = 0; offset < 1024; offset += 32) {
    await Promise.all(Array.from({ length: 32 }, async () => { const response = await send(meter); assert.equal(response.status, 200); await response.text(); }));
  }
  await (await send(meter)).text(); const receipt = await meter.close();
  assert.equal(receipt.forwarded, 1025); assert.equal(receipt.requests.length, 1024); assert.equal(receipt.recordsTruncated, true);
  assert.equal(receipt.actualOutputTokens, 1025); assert.equal(receipt.unknownRequests, 0);
});

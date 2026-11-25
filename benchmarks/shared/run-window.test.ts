import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ResponsesBudgetGateway } from '../../dist/src/agent/responses-budget-gateway.js';
import { createRunWindow } from './run-window.ts';

const completion = 'data: ' + JSON.stringify({ type: 'response.completed',
  response: { model: 'k3', status: 'completed', usage: { input_tokens: 3, output_tokens: 5 } } }) + '\n\n';

async function serve(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/responses`;
}

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'pastel-window-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function send(url, headers, fields = {}) {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ model: 'k3', input: [], stream: true, store: false, ...fields }) });
}

test('Core gateway meters a request and the run fence preserves a pre-deadline archive', async t => {
  const path = await directory(t);
  const observed = [];
  const upstreamUrl = await serve(t, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    observed.push({ authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(completion);
  });
  let tick = 12_000;
  const window = await createRunWindow({ directory: path, upstreamUrl, upstreamHeaders: { authorization: 'Bearer loopback-only' },
    now: () => tick, maxRequests: 1 });
  t.after(() => window.close());
  const db = new DatabaseSync(':memory:');
  const gateway = new ResponsesBudgetGateway({ db, upstream: { ...window.upstream, model: 'k3' },
    timeBounds: { maxOutputTokens: 8192, requestTimeoutMs: 3_000 },
    validateBot: () => ({ phase: 'work', deadline: Date.now() + 3_000 }) });
  t.after(async () => { await gateway.stop(); db.close(); });
  const { baseUrl } = await gateway.start();
  const token = gateway.issueToken({ runtimeId: 'runtime', botId: 'bot' });
  const headers = { authorization: `Bearer ${token}` };

  const before = await send(baseUrl + '/responses', headers);
  assert.equal(before.status, 502);
  await before.text();
  assert.equal(observed.length, 0);
  await assert.rejects(window.checkpoint({ archive: Buffer.from('a'), sourceRevision: 'revision-a' }), /closed/);
  window.start();
  const accepted = await send(baseUrl + '/responses', headers, { max_output_tokens: 6000 });
  assert.equal(accepted.status, 200);
  assert.equal(await accepted.text(), completion);
  assert.equal(gateway.observedUsage('runtime').observed_output_tokens, 5);
  assert.equal(observed[0].body.max_output_tokens, 4096);
  assert.equal(observed[0].body.store, false);
  assert.equal(observed[0].authorization, 'Bearer loopback-only');
  const extra = await send(window.upstream.url, window.upstream.headers);
  assert.equal(extra.status, 429);
  assert.equal((await extra.json()).error.code, 'request_limit');

  tick += 1_799_998;
  const archive = Buffer.from('candidate-bytes');
  const checkpoint = await window.checkpoint({ archive, sourceRevision: 'revision-a' });
  assert.equal(checkpoint.sha256, createHash('sha256').update(archive).digest('hex'));
  archive.fill(0);
  const afterEdge = window.checkpoint({ archive: Buffer.from('late-candidate'), sourceRevision: 'revision-b' });
  tick += 2;
  await assert.rejects(afterEdge, /before checkpoint persisted/);
  const after = await send(window.upstream.url, window.upstream.headers);
  assert.equal(after.status, 403);
  await after.text();
  assert.equal(window.receipt().closedElapsedMs, 1_800_000);
  assert.equal(window.receipt().stopReason, 'deadline');
  assert.equal(window.receipt().attempts.length, 1);
  assert.equal(window.receipt().checkpoints.length, 1);
  assert.equal(window.receipt().latestCheckpoint.sourceRevision, 'revision-a');
  assert.equal((await readFile(checkpoint.path)).toString(), 'candidate-bytes');
  assert.equal((await readdir(path)).length, 1);
  assert.throws(() => window.start(), /reopened/);
});

test('the real timer interrupts a stream and the concurrency fence prevents dispatch', async t => {
  let upstreamCalls = 0;
  let upstreamClosed;
  const closed = new Promise(resolve => { upstreamClosed = resolve; });
  const upstreamUrl = await serve(t, (request, response) => {
    upstreamCalls++;
    response.once('close', upstreamClosed);
    request.resume();
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"type":"response.created"}\n\n');
  });
  const window = await createRunWindow({ directory: await directory(t), upstreamUrl,
    durationMs: 400, maxConcurrent: 1 });
  t.after(() => window.close());
  window.start();
  const first = await send(window.upstream.url, window.upstream.headers);
  assert.equal(first.status, 200);
  const aborted = assert.rejects(first.text(), /terminated|abort|socket/i);
  const extra = await send(window.upstream.url, window.upstream.headers);
  assert.equal(extra.status, 429);
  assert.equal((await extra.json()).error.code, 'concurrent_limit');
  await aborted;
  const timeout = new AbortController();
  try {
    await Promise.race([closed, delay(2_000, null, { signal: timeout.signal }).then(() => {
      assert.fail('Upstream socket did not close');
    })]);
  } finally {
    timeout.abort();
  }
  assert.equal(upstreamCalls, 1);
  const receipt = window.receipt();
  assert.equal(receipt.stopReason, 'deadline');
  assert.equal(receipt.closedElapsedMs, 400);
  assert.equal(receipt.attempts[0].transport, 'aborted');
});

test('a one-hour acceptance window can forward past 48 requests without an output clamp', async t => {
  const observed = [];
  const upstreamUrl = await serve(t, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    observed.push(JSON.parse(Buffer.concat(chunks).toString('utf8')).max_output_tokens);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(completion);
  });
  let tick = 1000;
  const path = await directory(t);
  const durationMs = 3_600_000;
  await assert.rejects(createRunWindow({ directory: path, upstreamUrl, durationMs: durationMs + 1 }), /Invalid benchmark run bounds/);
  const window = await createRunWindow({ directory: path, upstreamUrl, durationMs,
    maxRequests: null, maxOutputTokens: null, now: () => tick });
  t.after(() => window.close());
  window.start();
  for (let sent = 0; sent < 49; sent++) {
    const response = await send(window.upstream.url, window.upstream.headers, { max_output_tokens: 16_384 });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), completion);
  }
  tick += durationMs - 1;
  const final = await send(window.upstream.url, window.upstream.headers);
  assert.equal(final.status, 200);
  assert.equal(await final.text(), completion);
  assert.deepEqual(observed, [...Array(49).fill(16_384), undefined]);
  tick++;
  const late = await send(window.upstream.url, window.upstream.headers);
  assert.equal(late.status, 403);
  await late.text();
  assert.equal(window.receipt().closedElapsedMs, durationMs);
  assert.equal(window.receipt().attempts.length, 50);
});

test('a deadline receipt reports the configured duration with a fractional monotonic start', async t => {
  const upstreamUrl = await serve(t, (_request, response) => response.end());
  const durationMs = 30_000;
  const startTick = 10_000.001;
  let tick = startTick;
  const window = await createRunWindow({ directory: await directory(t), upstreamUrl,
    durationMs, now: () => tick });
  t.after(() => window.close());

  window.start();
  tick = startTick + durationMs;
  const receipt = window.receipt();
  assert.equal(receipt.stopReason, 'deadline');
  assert.equal(receipt.closedElapsedMs, durationMs);
});

test('the registered comparison model is forwarded and a different model is rejected', async t => {
  const forwarded = [];
  const upstreamUrl = await serve(t, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    forwarded.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(completion);
  });
  const window = await createRunWindow({ directory: await directory(t), upstreamUrl, model: 'gpt-6.1-sol', maxOutputTokens: null });
  t.after(() => window.close());
  window.start();
  const rejected = await send(window.upstream.url, window.upstream.headers);
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).error.code, 'invalid_request');
  const accepted = await send(window.upstream.url, window.upstream.headers, { model: 'gpt-6.1-sol' });
  assert.equal(accepted.status, 200);
  await accepted.text();
  assert.deepEqual(forwarded.map(body => body.model), ['gpt-6.1-sol']);
  assert.equal(forwarded[0].max_output_tokens, undefined);
  assert.equal(window.receipt().attempts.length, 1);
});

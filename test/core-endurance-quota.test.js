import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { createCappedUpstream } from './fixtures/core-capped-upstream.js';

function configuration(upstreamUrl) {
  return { upstreamUrl, profile: 'endurance', deadlineAt: Date.now() + 4_200_000,
    phases: { setupMs: 600_000, workMs: 3_600_000, cleanupMs: 180_000, recoveryMs: 300_000, marginMs: 120_000 },
    maxRequests: 96, maxConcurrent: 2, generationOutputTokens: 768, maxOutputTokens: 1024,
    maxAggregateOutputTokens: 98_304, maxInputBytes: 128 * 1024, maxAggregateInputBytes: 8 * 1024 ** 2,
    filename: 'unused', marker: 'unused', failFast: true };
}

async function upstream(t, handler) {
  const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}/v1/responses`;
}

test('endurance quota owner keeps one URL and cumulative raw accounting across host stages', async t => {
  let calls = 0;
  const url = await upstream(t, (request, response) => {
    request.resume(); calls++;
    response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { id: `turn-${calls}`, model: 'k3', status: 'completed', usage: { input_tokens: 30, output_tokens: 865 } } })}\n\n`);
  });
  const config = configuration(url), original = structuredClone(config);
  const owner = await createCappedUpstream(config); t.after(() => owner.close());
  config.maxRequests = 256; config.phases.workMs = 3_900_000;
  const stableUrl = owner.url;
  for (const stage of ['setup', 'window-1', 'window-4']) {
    const response = await fetch(owner.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input: [stage] }) });
    assert.equal(response.status, 200); await response.text(); assert.equal(owner.url, stableUrl);
  }
  const receipt = owner.receipt();
  assert.equal(receipt.profile, 'endurance'); assert.equal(receipt.model, 'k3');
  assert.equal(receipt.deadlineAt, original.deadlineAt);
  assert.equal(receipt.ownerDeadlineAt, original.deadlineAt + 600_000);
  assert.equal(receipt.frozenPolicy.maxRequests, 96); assert.equal(receipt.frozenPolicy.phases.workMs, 3_600_000);
  assert.equal(receipt.forwarded, 3); assert.equal(receipt.observedOutputTokens, 2595);
  assert.equal(receipt.outstandingOutputTokens, 0); assert.equal(receipt.activeRequests, 0);
  receipt.frozenPolicy.phases.workMs = 1;
  assert.equal(owner.receipt().frozenPolicy.phases.workMs, 3_600_000);
  await owner.close(); assert.equal(owner.receipt().closed, true);
});

test('endurance cannot obtain expanded defaults or undeclared phase and budget values', async () => {
  const base = configuration('http://127.0.0.1:1/v1/responses');
  const changes = [
    row => { delete row.maxRequests; }, row => { delete row.maxAggregateOutputTokens; }, row => { delete row.maxAggregateInputBytes; },
    row => { row.profile = 'unbounded'; }, row => { row.renew = true; }, row => { row.phases.extra = 1; },
    row => { row.phases.workMs = 3_599_999; }, row => { row.phases.cleanupMs = 600_001; },
    row => { row.deadlineAt = Date.now() + 1000; }, row => { row.deadlineAt = Date.now() + 4_300_000; },
    row => { row.maxRequests = 257; }, row => { row.maxConcurrent = 5; }, row => { row.maxOutputTokens = 1025; },
    row => { row.generationOutputTokens = 1024; }, row => { row.generationOutputTokens = 769; }, row => { row.maxAggregateOutputTokens = 196_609; },
    row => { row.maxAggregateInputBytes = 32 * 1024 ** 2 + 1; }, row => { row.failFast = false; },
  ];
  for (const change of changes) {
    const config = structuredClone(base); change(config);
    await assert.rejects(createCappedUpstream(config), { message: 'LIVE_UPSTREAM_CONFIGURATION_INVALID' });
  }
  const short = { ...base, profile: 'short' };
  await assert.rejects(createCappedUpstream(short), { message: 'LIVE_UPSTREAM_CONFIGURATION_INVALID' });
});

test('endurance owner enforces its own final close deadline without a new listener', async t => {
  const timers = [];
  const schedule = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
    const timer = schedule(callback, ms, ...args);
    if (ms > 3_000_000) timers.push({ callback, ms });
    return timer;
  });
  const owner = await createCappedUpstream(configuration('http://127.0.0.1:1/v1/responses'));
  t.after(() => owner.close());
  assert.equal(timers.length, 2);
  assert.ok(timers[1].ms > timers[0].ms);
  timers[1].callback(); await owner.close();
  assert.equal(owner.receipt().closed, true);
  await assert.rejects(fetch(owner.url, { method: 'POST', body: '{}' }));
});

test('endurance unknown metering cancels the active peer and preserves both reservations', async t => {
  let calls = 0, notified = 0;
  const url = await upstream(t, (request, response) => {
    request.resume(); calls++;
    if (calls === 1) { response.writeHead(200); response.write(':held\n\n'); }
    else response.end('data: {"type":"response.completed","response":{"id":"unknown","model":"k3","status":"completed"}}\n\n');
  });
  const owner = await createCappedUpstream({ ...configuration(url), onFailure: () => { notified++; } });
  t.after(() => owner.close());
  const send = () => fetch(owner.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input: [] }) });
  const first = await send(); const cancelled = first.text().catch(() => undefined);
  await (await send()).text().catch(() => undefined); await cancelled;
  const later = await send(); assert.equal(later.status, 400); await later.text();
  const receipt = owner.receipt();
  assert.equal(calls, 2); assert.equal(notified, 1); assert.equal(receipt.failure.code, 'LIVE_TERMINAL_USAGE_INVALID');
  assert.equal(receipt.outstandingOutputTokens, 2048); assert.equal(receipt.settledOutputTokens, 0);
});

test('expired dispatch admission stays closed when the wall clock rolls back', async t => {
  const timers = [], schedule = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
    const timer = schedule(callback, ms, ...args); if (ms > 3_000_000) timers.push(callback); return timer;
  });
  let calls = 0;
  const url = await upstream(t, (request, response) => { request.resume(); calls++; response.end(); });
  const owner = await createCappedUpstream(configuration(url)); t.after(() => owner.close());
  timers[0]();
  t.mock.method(Date, 'now', () => owner.receipt().createdAt);
  const response = await fetch(owner.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input: [] }) });
  assert.equal(response.status, 429); await response.text();
  assert.equal(calls, 0); assert.equal(owner.receipt().deadlineReached, true);
});

test('an observed wall-clock expiry latches before its timer and cancels an active peer', async t => {
  let calls = 0;
  const url = await upstream(t, (request, response) => { request.resume(); calls++; response.writeHead(200); response.write(':held\n\n'); });
  const owner = await createCappedUpstream(configuration(url)); t.after(() => owner.close());
  const send = () => fetch(owner.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input: [] }) });
  const peer = await send(); const cancelled = peer.text().catch(() => undefined);
  const policy = owner.receipt(); let wallNow = policy.deadlineAt + 1;
  t.mock.method(Date, 'now', () => wallNow);
  const expired = await send(); assert.equal(expired.status, 429); await expired.text();
  assert.equal(owner.receipt().deadlineReached, true);
  await cancelled;
  wallNow = policy.createdAt;
  const rolledBack = await send(); assert.equal(rolledBack.status, 429); await rolledBack.text();
  const receipt = owner.receipt(); assert.equal(calls, 1); assert.equal(receipt.forwarded, 1);
  assert.equal(receipt.outstandingOutputTokens, 1024);
  assert.equal(receipt.requests[0].transport.firstTermination.kind, 'work_expiry');
});

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { ResponsesBudgetGateway } from '../src/agent/responses-budget-gateway.js';

const model = 'gpt-6.1-sol';
const limits = {
  mission: { requests: 4, inputTokens: 800, outputTokens: 160, cost: 3000 },
  bot: { requests: 4, inputTokens: 800, outputTokens: 160, cost: 3000 },
  selection: { requests: 1, inputTokens: 200, outputTokens: 40, cost: 600 },
  closeout: { requests: 1, inputTokens: 200, outputTokens: 40, cost: 600 },
};
const contract = {
  maxInputTokens: 100, maxOutputTokens: 20, maxFanout: 2, costUnit: 'fixture-units',
  inputCostPerToken: 2, outputCostPerToken: 3, fixedAttemptCost: 5,
  requestTimeoutMs: 2000, boundEvidence: 'fixture enforces an independent processed token bound',
};

function completion(usage = { input_tokens: 4, output_tokens: 3 }) {
  return 'event: response.completed\ndata: ' +
    JSON.stringify({ type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', model, usage } }) + '\n\n';
}

async function fixture(t, fn, { timeBounds } = {}) {
  const requests = [];
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.setHeader('content-type', 'text/event-stream');
    if (fn) fn(req, res); else res.end(completion());
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const db = new DatabaseSync(':memory:');
  const phases = new Map([['b', 'selection'], ['c', 'work']]);
  const upstreamOptions = {
    url: `http://127.0.0.1:${upstream.address().port}/v1/responses`, model, contract: timeBounds ? undefined : contract,
    headers: { authorization: 'Bearer host-secret', 'x-openai-actor-authorization': 'host-actor' },
  };
  const options = { db, upstream: upstreamOptions, limits: timeBounds ? undefined : limits, timeBounds,
    validateBot: ({ botId }) => ({ phase: phases.get(botId) }) };
  const gateway = new ResponsesBudgetGateway(options);
  const { baseUrl } = await gateway.start();
  t.after(async () => {
    await gateway.stop();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    db.close();
  });
  const call = (token, id, body = { model, input: 'prove' }, request = {}) => fetch(`${baseUrl}/responses`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', authorization: `Bearer ${token}`,
      'x-swarmenv-request-id': id, 'x-openai-actor-authorization': 'guest injection',
    },
    body: JSON.stringify(body),
    ...request,
  });
  return { db, gateway, baseUrl, requests, phases, options, call };
}

test('time-bounded Responses uses real usage only, and preserves scope and replay without financial configuration', async t => {
  const { db, gateway, call, requests } = await fixture(t, (_, response) => {
    response.end(requests.length === 1 ? completion() : 'event: unrecognized\ndata: {}\n\n');
  }, { timeBounds: { requestTimeoutMs: 1000, maxOutputTokens: 64 } });
  const token = gateway.issueToken({ missionId: 'm', botId: 'b' });
  const body = { model, input: 'prove', max_output_tokens: 100 };
  assert.equal((await call(token, 'one', body)).status, 200);
  assert.equal(await (await call(token, 'one', body)).text(), completion());
  assert.equal((await call(token, 'one', { ...body, input: 'changed' })).status, 409);
  assert.equal((await call(token, 'two', { ...body, background: true })).status, 400);
  assert.equal((await call(token, 'two', body)).status, 200);
  assert.equal((await call(token, 'two', body)).status, 409);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.max_output_tokens, 64);
  assert.equal(requests[0].headers.authorization, 'Bearer host-secret');
  assert.deepEqual({ ...gateway.observedUsage('m') }, { requests: 2, requests_with_usage: 1, unknown_requests: 1,
    pending_requests: 0, observed_input_tokens: 4, observed_output_tokens: 3 });
  const rows = db.prepare('SELECT cost, input_tokens, output_tokens FROM responses_timed_attempts ORDER BY request_id').all();
  assert.deepEqual(rows.map(row => ({ ...row })), [{ cost: null, input_tokens: 4, output_tokens: 3 },
    { cost: null, input_tokens: null, output_tokens: null }]);
  gateway.revokeToken(token);
  assert.equal((await call(token, 'three')).status, 401);
});

test('validates actual Pi Responses item shapes, forwards only configured credentials, and replays receipt', async t => {
  const { gateway, call, requests } = await fixture(t);
  const token = gateway.issueToken({ missionId: 'm', botId: 'b' });
  const body = {
    model, stream: true, store: false, max_output_tokens: 30, prompt_cache_key: 'pi-session',
    input: [
      { role: 'developer', content: 'Be useful.' },
      { role: 'user', content: [{ type: 'input_text', text: 'prove' }] },
      { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'encrypted' },
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'proof' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok', annotations: [] }] },
    ],
    tools: [{ type: 'function', name: 'read', parameters: { type: 'object' }, strict: false }],
    include: ['reasoning.encrypted_content'], reasoning: { effort: 'high', summary: 'auto' },
  };
  const result = await call(token, 'one', body);
  assert.equal(result.status, 200);
  const receipt = await result.text();
  const replay = await call(token, 'one', body);
  assert.equal(replay.status, 200);
  assert.equal(await replay.text(), receipt);
  const conflict = await call(token, 'one', { ...body, input: 'changed' });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, 'request_payload_conflict');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.max_output_tokens, 20);
  assert.equal(requests[0].headers.authorization, 'Bearer host-secret');
  assert.equal(requests[0].headers['x-openai-actor-authorization'], 'host-actor');
  assert.deepEqual({ ...gateway.totals({ missionId: 'm' }) }, {
    requests: 1, inputTokens: 104, outputTokens: 23, cost: 287,
  });
  assert.equal((await call(token, 'two')).status, 429);
  assert.equal(gateway.revokeToken(token), true);
  assert.equal((await call(token, 'one', body)).status, 401);
});

test('rejects alternate routes, tools, remote inputs, tier and stateful Responses modes', async t => {
  const { gateway, call, requests } = await fixture(t);
  const token = gateway.issueToken({ missionId: 'm', botId: 'b' });
  for (const patch of [
    { model: 'other' }, { background: true }, { conversation: 'conv_1' }, { previous_response_id: 'resp_1' },
    { service_tier: 'priority' }, { tools: [{ type: 'web_search' }] },
    { tools: [{ type: 'function', name: 'remote', parameters: { $ref: 'https://example.com/a' } }] },
    { input: [{ type: 'item_reference', id: 'ref_1' }] },
    { input: [{ type: 'reasoning', summary: [], content: [{ type: 'input_image', image_url: 'https://example.com/a' }] }] },
    { input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://example.com/a' }] }] },
  ]) {
    assert.equal((await call(token, 'one', { input: 'x', ...patch })).status, 400);
  }
  assert.equal(requests.length, 0);
});

test('concurrent reservations preserve closeout capacity and keep ambiguous usage after restart', async t => {
  const { db, gateway, call, phases, requests, options } = await fixture(t, (_req, res) => res.end('data: {}\n\n'));
  const token = gateway.issueToken({ missionId: 'm', botId: 'c' });
  const work = await Promise.all(['1', '2', '3', '4'].map(id => call(token, id)));
  assert.deepEqual(work.map(r => r.status).sort(), [200, 200, 200, 429]);
  await Promise.all(work.map(r => r.text()));
  assert.equal(gateway.totals({ missionId: 'm' }).inputTokens, 600);
  phases.set('c', 'closeout');
  assert.equal((await call(token, '5')).status, 200);
  await gateway.stop();
  const next = new ResponsesBudgetGateway(options);
  const { baseUrl } = await next.start();
  t.after(() => next.stop());
  const nextToken = next.issueToken({ missionId: 'm', botId: 'c' });
  const replay = await fetch(`${baseUrl}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${nextToken}`, 'x-swarmenv-request-id': '5' },
    body: JSON.stringify({ model, input: 'prove' }),
  });
  assert.equal(replay.status, 409);
  assert.equal((await replay.json()).error.code, 'request_unknown');
  assert.equal(requests.length, 4);
  assert.equal(next.totals({ missionId: 'm' }).outputTokens, 160);
  assert.equal(db.prepare("SELECT count(*) AS n FROM responses_budget_attempts WHERE reason = 'no_trusted_terminal_usage'").get().n, 4);
  await next.stop();
});

test('stop terminates actual upstream stream and preserves reservation on disconnect', async t => {
  let confirmClosed;
  const closed = new Promise(resolve => { confirmClosed = resolve; });
  const { gateway, call, db } = await fixture(t, (_req, res) => {
    res.once('close', confirmClosed);
    res.write('data: {}\n\n');
  });
  const token = gateway.issueToken({ missionId: 'm', botId: 'c' });
  const result = await call(token, 'one');
  assert.equal(result.status, 200);
  const replayWhilePending = await call(token, 'one');
  assert.equal(replayWhilePending.status, 409);
  assert.equal((await replayWhilePending.json()).error.code, 'request_pending');
  await gateway.stop();
  await closed;
  const row = db.prepare('SELECT state, reason, cost FROM responses_budget_attempts').get();
  assert.deepEqual({ ...row }, { state: 'unknown', reason: 'transport_interrupted', cost: 530 });
});

test('rejects missing contract evidence and burns no quota', async t => {
  const { options } = await fixture(t);
  const missing = { ...options, upstream: { ...options.upstream, contract: { ...contract, boundEvidence: '' } } };
  assert.throws(() => new ResponsesBudgetGateway(missing), /complete trusted/);
});

test('locally installed Pi replays provider reasoning with empty content through the gateway over real SSE', async t => {
  const packageRoot = process.env.SWARMENV_TEST_PI_AI_ROOT;
  if (!packageRoot) return t.skip('set SWARMENV_TEST_PI_AI_ROOT to the installed Pi AI package');
  const { stream } = await import(new URL('dist/api/openai-responses.js', pathToFileURL(packageRoot + '/')));
  const reasoning = { type: 'reasoning', id: 'rs_fixture', summary: [{ type: 'summary_text', text: 'Fixture summary' }],
    encrypted_content: 'fixture-encrypted', content: [] };
  const { gateway, baseUrl, requests } = await fixture(t, (_request, response) => {
    response.end('event: response.output_item.done\ndata: ' +
      JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: reasoning }) + '\n\n' + completion());
  });
  const token = gateway.issueToken({ missionId: 'm', botId: 'c' });
  const provider = {
    id: model, name: model, api: 'openai-responses', provider: 'gpt_proxy', baseUrl,
    input: ['text'], reasoning: true, contextWindow: 500000, maxTokens: 128000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'prove' }], timestamp: 1 }];
  const result = await stream(provider, { systemPrompt: 'Solve', messages, tools: [] }, {
    apiKey: token, maxTokens: 20, reasoningEffort: 'high', maxRetries: 0,
  }).result();
  assert.equal(result.stopReason, 'stop', result.errorMessage);
  assert.equal(result.usage.output, 3);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.include[0], 'reasoning.encrypted_content');
  assert.equal(requests[0].body.max_output_tokens, 20);
  assert.deepEqual(JSON.parse(result.content.find(part => part.type === 'thinking').thinkingSignature), reasoning);
  const continued = await stream(provider, { systemPrompt: 'Solve', messages: [...messages, result,
    { role: 'user', content: [{ type: 'text', text: 'Continue' }], timestamp: 2 }], tools: [] }, {
    apiKey: token, maxTokens: 20, reasoningEffort: 'high', maxRetries: 0,
  }).result();
  assert.equal(continued.stopReason, 'stop', continued.errorMessage);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].body.input.find(item => item.type === 'reasoning'), reasoning);
});


test('rejected upstream HTTP responses retain safe diagnostics without changing Bot errors or unknown usage', async t => {
  const { db, gateway, call } = await fixture(t, (_, response) => {
    response.writeHead(503, { 'content-type': 'application/json', 'x-request-id': 'req_provider_fixture',
      'retry-after': '12', 'x-private-header': 'sensitive-header' });
    response.end('{"private":"sensitive-body"}');
  }, { timeBounds: { requestTimeoutMs: 1000, maxOutputTokens: 64 } });
  const token = gateway.issueToken({ missionId: 'm', botId: 'b' });
  const response = await call(token, 'http-rejected');
  assert.equal(response.status, 502);
  const error = await response.text();
  assert.match(error, /upstream_rejected/);
  assert.doesNotMatch(error, /sensitive|503|req_provider_fixture/);
  const row = db.prepare(`SELECT state, reason, settled, input_tokens, output_tokens, cost, upstream_request_id,
    upstream_status, upstream_content_type_valid, upstream_body_present, upstream_rejection_kind,
    upstream_retry_after_seconds FROM responses_timed_attempts`).get();
  assert.deepEqual({ ...row }, { state: 'unknown', reason: 'upstream_http_error', settled: 0,
    input_tokens: null, output_tokens: null, cost: null, upstream_request_id: 'req_provider_fixture',
    upstream_status: 503, upstream_content_type_valid: 0, upstream_body_present: 1,
    upstream_rejection_kind: 'non_2xx', upstream_retry_after_seconds: 12 });
  assert.equal(gateway.observedUsage('m').unknown_requests, 1);
  assert.equal((await call(token, 'http-rejected')).status, 409);
});


test('successful HTTP with non-SSE content retains a distinct rejection and discards unsafe Retry-After', async t => {
  const { db, gateway, call } = await fixture(t, (_, response) => {
    response.writeHead(200, { 'content-type': 'application/json; private=sensitive-header',
      'retry-after': 'sensitive-header' });
    response.end('{"private":"sensitive-body"}');
  }, { timeBounds: { requestTimeoutMs: 1000, maxOutputTokens: 64 } });
  const token = gateway.issueToken({ missionId: 'm', botId: 'b' });
  const response = await call(token, 'wrong-content-type');
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /sensitive|content.type/);
  assert.deepEqual({ ...db.prepare(`SELECT upstream_status, upstream_content_type_valid, upstream_body_present,
    upstream_rejection_kind, upstream_retry_after_seconds, state, reason FROM responses_timed_attempts`).get() },
  { upstream_status: 200, upstream_content_type_valid: 0, upstream_body_present: 1,
    upstream_rejection_kind: 'invalid_content_type', upstream_retry_after_seconds: null,
    state: 'unknown', reason: 'upstream_http_error' });
});


for (const scenario of [
  { name: 'rate limit', status: 429, contentTypeValid: 1, bodyPresent: 1, kind: 'non_2xx', retry: '86401', clientStatus: 429 },
  { name: 'missing response body', status: 204, contentTypeValid: 1, bodyPresent: 0, kind: 'missing_body',
    retry: 'Wed, 21 Oct 2030 07:28:00 GMT', clientStatus: 502 },
]) {
  test(`financial gateway records ${scenario.name} without releasing its reservation`, async t => {
    const { db, gateway, call } = await fixture(t, (_, response) => {
      response.writeHead(scenario.status, { 'retry-after': scenario.retry });
      response.end();
    });
    const token = gateway.issueToken({ missionId: 'm', botId: 'b' });
    const response = await call(token, 'financial-rejected');
    assert.equal(response.status, scenario.clientStatus);
    await response.text();
    const row = db.prepare(`SELECT upstream_status, upstream_content_type_valid, upstream_body_present,
      upstream_rejection_kind, upstream_retry_after_seconds, state, reason, settled, cost FROM responses_budget_attempts`).get();
    assert.deepEqual({ ...row }, { upstream_status: scenario.status, upstream_content_type_valid: scenario.contentTypeValid,
      upstream_body_present: scenario.bodyPresent, upstream_rejection_kind: scenario.kind, upstream_retry_after_seconds: null,
      state: 'unknown', reason: 'upstream_http_error', settled: 0, cost: 530 });
  });
}

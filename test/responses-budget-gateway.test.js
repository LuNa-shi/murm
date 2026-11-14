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

async function fixture(t, fn) {
  const requests = [];
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (fn) fn(req, res); else res.end(completion());
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const db = new DatabaseSync(':memory:');
  const phases = new Map([['b', 'selection'], ['c', 'work']]);
  const upstreamOptions = {
    url: `http://127.0.0.1:${upstream.address().port}/v1/responses`, model, contract,
    headers: { authorization: 'Bearer host-secret', 'x-openai-actor-authorization': 'host-actor' },
  };
  const options = { db, upstream: upstreamOptions, limits, validateBot: ({ botId }) => ({ phase: phases.get(botId) }) };
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

test('locally installed Pi provider communicates with the gateway over real SSE', async t => {
  const packageRoot = process.env.SWARMENV_TEST_PI_AI_ROOT;
  if (!packageRoot) return t.skip('set SWARMENV_TEST_PI_AI_ROOT to the installed Pi AI package');
  const { stream } = await import(new URL('dist/api/openai-responses.js', pathToFileURL(packageRoot + '/')));
  const { gateway, baseUrl, requests } = await fixture(t);
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
});

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createCoreModelAccess } from '../src/core/model-access.js';
import { selectExecutorDriver } from '../src/core/executor-driver.js';

function completion(model = 'k3') {
  return `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed',
    response: { status: 'completed', model, usage: { input_tokens: 3, output_tokens: 2 } } })}\n\n`;
}

async function fixture(t, { reply, requestTimeoutMs = 2000, maxOutputTokens = 64, models, provider = 'kimi_proxy', model = 'k3',
  protocol, capabilities, executor } = {}) {
  const outputDir = await mkdtemp(join(tmpdir(), 'core-model-'));
  const requests = [];
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ headers: request.headers, body });
    response.setHeader('content-type', 'text/event-stream');
    if (reply) reply(request, response, body);
    else response.end(completion(body.model));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const endpoint = protocol === 'chat-completions' ? 'chat/completions' : 'responses';
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1/${endpoint}`;
  const agents = new Map([['agent-a', { profile: 'writer', model: 'default', status: 'idle' }]]);
  let access;
  t.after(async () => {
    await access?.close();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    await rm(outputDir, { recursive: true, force: true });
  });
  const config = {
    driver: selectExecutorDriver(executor),
    modelGateway: { host: '127.0.0.1', advertiseHost: '127.0.0.1', requestTimeoutMs, maxOutputTokens },
    models: models ?? { default: { provider, model, protocol, capabilities,
      upstream: { url: upstreamUrl, headers: { authorization: 'Bearer upstream-private' } } } },
  };
  access = await createCoreModelAccess({ runtimeId: 'runtime-a', outputDir, config,
    getAgent: agentId => agents.get(agentId) ?? null });
  const credentials = access.credentialsForAgent('agent-a', 'default');
  const call = async (requestId = 'request-a', body = { model, input: 'Return a small result.' }) => {
    const response = await fetch(`${credentials.baseUrl}/${endpoint}`, {
      method: 'POST', headers: { authorization: `Bearer ${Object.values(credentials.secretEnvironment)[0]}`,
        'content-type': 'application/json', 'x-murm-request-id': requestId }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.text() };
  };
  return { access, agents, requests, credentials, call, outputDir, config };
}

test('Chat Completions uses its own route, model limits, split terminal frames and usage receipts', async t => {
  const frame = value => `data: ${JSON.stringify(value)}\n\n`;
  const output = frame({ model: 'local-chat', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] }) +
    frame({ model: 'local-chat', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  const f = await fixture(t, { protocol: 'chat-completions', model: 'local-chat', provider: 'local',
    capabilities: { contextWindow: 16384, maxOutputTokens: 32, tools: false, reasoning: false },
    reply(request, response) {
      assert.equal(request.url, '/v1/chat/completions');
      response.write(output.slice(0, 50));
      response.end(output.slice(50) + 'data: [DONE]\n\n');
    },
  });
  const catalog = JSON.parse(f.credentials.catalogContent);
  assert.equal(catalog.providers.local.api, 'openai-completions');
  assert.equal(catalog.providers.local.models[0].contextWindow, 16384);
  assert.equal(catalog.providers.local.models[0].maxTokens, 32);
  const payload = { model: 'local-chat', messages: [{ role: 'user', content: 'hello' }],
    stream: true, max_completion_tokens: 512 };
  assert.equal((await f.call('chat', { ...payload, tools: [{ type: 'function', function: { name: 'read' } }] })).status, 400);
  assert.deepEqual(await f.call('chat', payload), { status: 200, body: output + 'data: [DONE]\n\n' });
  assert.equal(f.requests[0].body.max_completion_tokens, 32);
  assert.equal(f.requests[0].headers.authorization, 'Bearer upstream-private');
  assert.equal((await f.call('chat', payload)).status, 200);
  assert.equal(f.requests.length, 1);
  const [filename] = await readdir(join(f.outputDir, 'model-access'));
  const ledger = new DatabaseSync(join(f.outputDir, 'model-access', filename), { readOnly: true });
  t.after(() => ledger.close());
  assert.deepEqual({ ...ledger.prepare('SELECT state, input_tokens, output_tokens FROM runtime_model_attempts').get() },
    { state: 'completed', input_tokens: null, output_tokens: null });
});

test('Runtime model access propagates explicit natural output policy while retaining Agent credentials and usage evidence', async t => {
  const { call, requests, access } = await fixture(t, { maxOutputTokens: null });
  const response = await call('natural-runtime', { model: 'k3', input: 'controlled natural work', max_output_tokens: 128000 });
  assert.equal(response.status, 200); assert.equal(requests[0].body.max_output_tokens, 128000);
  assert.equal(requests[0].headers.authorization, 'Bearer upstream-private');
  assert.ok(access);
});

test('a generic Runtime Agent calls the shipped model with private upstream credentials and a model receipt', async t => {
  const f = await fixture(t);
  assert.equal(f.requests.length, 0);
  assert.equal((await f.call()).body, completion());
  assert.equal(f.requests[0].headers.authorization, 'Bearer upstream-private');
  assert.equal(f.requests[0].body.max_output_tokens, 64);
  assert.deepEqual(f.credentials.environment, { PI_KIMI_PROXY_BASE_URL: f.credentials.baseUrl });
  assert.notEqual(f.credentials.secretEnvironment.PI_KIMI_PROXY_API_KEY, 'upstream-private');
  assert.deepEqual(Object.keys(f.credentials.secretEnvironment), ['PI_KIMI_PROXY_API_KEY']);
  assert.equal(f.credentials.catalogResource.path, '/opt/murm/pi-agent/models.json');
  assert.match(f.credentials.catalogResource.sha256, /^[a-f0-9]{64}$/);
  assert.equal((await f.call()).body, completion());
  assert.equal(f.requests.length, 1);
  const [filename] = await readdir(join(f.outputDir, 'model-access'));
  const ledger = new DatabaseSync(join(f.outputDir, 'model-access', filename), { readOnly: true });
  t.after(() => ledger.close());
  assert.deepEqual({ ...ledger.prepare('SELECT runtime_id, agent_id, request_id, phase, state, input_tokens, output_tokens FROM runtime_model_attempts').get() },
    { runtime_id: 'runtime-a', agent_id: 'agent-a', request_id: 'request-a', phase: 'runtime', state: 'completed', input_tokens: 3, output_tokens: 2 });
  assert.equal(ledger.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name LIKE '%mission%' OR name LIKE '%task%' OR name LIKE '%execution%'").get().count, 0);
});

test('K3 tool continuation omits only the exact empty completed Pi message and preserves original request identity', async t => {
  // Structural provider stand-in, not evidence of native Pi execution or the
  // hosted rejection's cause. Shape matches Pi 1.3's Responses conversion.
  const empty = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '', annotations: [] }], status: 'completed', id: 'msg_tool_continuation' };
  const history = () => [
    { role: 'user', content: [{ type: 'input_text', text: 'Run the fixed tool and report its result.' }] },
    { type: 'reasoning', id: 'rs_retained', summary: [{ type: 'summary_text', text: 'Retain this summary.' }], encrypted_content: 'opaque-retained-signature' },
    { type: 'function_call', id: 'fc_retained', call_id: 'call_retained', name: 'bash', arguments: '{"command":"printf fixed"}', status: 'completed' },
    structuredClone(empty),
    { type: 'function_call_output', call_id: 'call_retained', output: 'fixed' },
    { type: 'message', role: 'assistant', id: 'msg_retained', status: 'completed', phase: 'final_answer',
      content: [{ type: 'output_text', text: 'A nonempty prior answer.', annotations: [] }] },
  ];
  function addParallelTool(input, resultId = 'call_parallel') {
    input.splice(3, 0, { type: 'function_call', id: 'fc_parallel', call_id: 'call_parallel',
      name: 'read', arguments: '{"path":"work.txt"}', status: 'completed' });
    input.splice(6, 0, { type: 'function_call_output', call_id: resultId, output: 'parallel-result' });
  }
  const cases = [
    { name: 'only the empty item is omitted', remove: true },
    { name: 'a complete parallel tool group omits the same empty item', remove: true, change: addParallelTool },
    { name: 'an unmatched parallel tool group is not rewritten', reject: true, change: input => addParallelTool(input, 'different_parallel_call') },
    { name: 'a nonempty assistant item is retained', change: input => { input[3].content[0].text = 'Retain me.'; } },
    { name: 'unsupported annotations are not laundered by removal', deny: true, change: input => { input[3].content[0].annotations = [{ type: 'url_citation', url: 'https://example.invalid/retained' }]; } },
    { name: 'unsupported metadata is not laundered by removal', deny: true, change: input => { input[3].metadata = { source: 'retained' }; } },
    { name: 'phase is retained', change: input => { input[3].phase = 'commentary'; } },
    { name: 'missing call identity still fails schema admission', deny: true, change: input => { delete input[2].call_id; } },
    { name: 'mismatched call identity is retained', reject: true, change: input => { input[4].call_id = 'different_call'; } },
    { name: 'the shipped GPT route retains the same empty item', provider: 'gpt_proxy', model: 'gpt-6.1-sol' },
  ];
  for (const scenario of cases) await t.test(scenario.name, async t => {
    const input = history(); scenario.change?.(input);
    const original = structuredClone(input);
    const f = await fixture(t, { provider: scenario.provider, model: scenario.model, reply: (_request, response, body) => {
      // The local strict K3 stand-in rejects precisely the observed item. Its
      // predicate intentionally makes no claim about other history variants.
      if (body.model === 'k3' && body.input.some(item => JSON.stringify(item) === JSON.stringify(empty))) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { code: 'invalid_request_error' } }));
      } else response.end(completion(body.model));
    } });
    const payload = { model: scenario.model ?? 'k3', input };
    const result = await f.call('native-tool-history', payload);
    if (scenario.deny) {
      assert.equal(result.status, 400); assert.equal(f.requests.length, 0);
      assert.deepEqual(input, original, 'Invalid history remains rejected, never stripped into an admissible request');
      return;
    }
    const retained = original.filter(item => item.id !== empty.id);
    assert.deepEqual(f.requests[0].body.input, scenario.remove ? retained : original);
    assert.deepEqual(input, original, 'Client history must not be mutated');
    assert.equal(result.status, scenario.reject ? 502 : 200);
    if (scenario.remove) {
      assert.deepEqual(await f.call('native-tool-history', payload), result, 'The same original request replays its receipt');
      assert.equal(f.requests.length, 1);
      assert.equal((await f.call('native-tool-history', { ...payload, input: retained })).status, 409,
        'Original client history, including the empty item, owns the stable request fingerprint');
      assert.equal(f.requests.length, 1);
    }
  });
});

test('model credentials reject unknown identities and requests fail before effects after identity or profile changes', async t => {
  const f = await fixture(t);
  assert.throws(() => f.access.credentialsForAgent('foreign-agent', 'default'), { code: 'NOT_ALLOWED' });
  assert.throws(() => f.access.credentialsForAgent('agent-a', 'unknown'), { code: 'NOT_ALLOWED' });
  assert.equal((await f.call('conflict')).status, 200);
  assert.equal((await f.call('conflict', { model: 'k3', input: 'Changed input.' })).status, 409);
  assert.equal((await f.call('invalid-model', { model: 'other', input: 'Try another model.' })).status, 400);
  const agent = f.agents.get('agent-a');
  agent.status = 'starting';
  assert.equal((await f.call('not-ready')).status, 403);
  agent.status = 'idle';
  agent.model = 'another';
  assert.equal((await f.call('foreign-model')).status, 403);
  agent.model = 'default';
  for (const status of ['closing', 'exited', 'closed']) {
    agent.status = status;
    assert.equal((await f.call(status)).status, 403);
  }
  f.agents.delete('agent-a');
  assert.equal((await f.call('missing')).status, 403);
  assert.equal(f.requests.length, 1);
});

test('revoking a live Agent aborts its model stream and prevents replacement credentials', async t => {
  const dispatched = Promise.withResolvers();
  const upstreamClosed = Promise.withResolvers();
  const f = await fixture(t, { reply: (_request, response) => {
    dispatched.resolve();
    response.once('close', () => upstreamClosed.resolve());
  } });
  const call = f.call().catch(() => ({ status: 502 }));
  await dispatched.promise;
  f.access.revokeAgent('agent-a');
  assert.equal((await call).status, 502);
  await upstreamClosed.promise;
  assert.equal((await f.call('revoked')).status, 401);
  assert.throws(() => f.access.credentialsForAgent('agent-a', 'default'), { code: 'NOT_ALLOWED' });
  assert.equal(f.requests.length, 1);
});

test('the configured request deadline bounds a held upstream and retains an unknown request identity', async t => {
  const dispatched = Promise.withResolvers();
  const f = await fixture(t, { requestTimeoutMs: 120, reply: () => dispatched.resolve() });
  const startedAt = Date.now();
  const call = f.call();
  await dispatched.promise;
  assert.equal((await call).status, 502);
  assert.ok(Date.now() - startedAt < 1200);
  assert.equal((await f.call()).status, 409);
  assert.equal(f.requests.length, 1);
});

test('invalid model identifiers, malformed endpoints and nonfinite limits fail before Agent allocation', async t => {
  const cases = [
    { models: { default: { provider: '', model: 'gpt-5.4', upstream: { url: 'http://127.0.0.1/v1/responses' } } } },
    { models: { default: { provider: 'bad provider', model: 'gpt-5.4', upstream: { url: 'http://127.0.0.1/v1/responses' } } } },
    { models: { default: { provider: 'openai', model: '../escape', upstream: { url: 'http://127.0.0.1/v1/responses' } } } },
    { models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: 'https://secret@host.test/v1/responses' } } } },
    { models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: 'https://host.test/v1/chat/completions' } } } },
    { requestTimeoutMs: Infinity },
    { requestTimeoutMs: -1 },
  ];
  for (const options of cases) await assert.rejects(fixture(t, options), { code: 'INVALID_CONFIG' });
});

test('Pi accepts shipped OpenAI models and synthesizes attested catalogs for custom Responses models', async t => {
  const shipped = await fixture(t, { provider: 'openai', model: 'gpt-5.4' });
  assert.equal(shipped.credentials.catalogResource?.path, '/opt/murm/pi-agent/models.json');
  assert.equal(shipped.credentials.catalogContent, undefined);
  assert.ok(shipped.credentials.environment.PI_OPENAI_BASE_URL?.endsWith('/v1'));
  assert.ok(shipped.credentials.secretEnvironment.PI_OPENAI_API_KEY);
  assert.equal((await shipped.call('req-openai')).status, 200);

  const custom = await fixture(t, { provider: 'openrouter', model: 'anthropic/claude-sonnet-4' });
  assert.equal(custom.credentials.catalogResource?.path, '/workspace/runtime/pi-agent/models.json');
  assert.ok(typeof custom.credentials.catalogContent === 'string' && custom.credentials.catalogContent.includes('"anthropic/claude-sonnet-4"'));
  assert.equal(custom.credentials.environment.PI_OPENROUTER_BASE_URL, custom.credentials.baseUrl);
  assert.ok(custom.credentials.secretEnvironment.PI_OPENROUTER_API_KEY);
  assert.equal((await custom.call('req-custom')).status, 200);
});

test('close aborts live model requests, revokes credentials and is idempotent', async t => {
  const dispatched = Promise.withResolvers();
  const f = await fixture(t, { reply: () => dispatched.resolve() });
  const call = f.call().catch(() => ({ status: 502 }));
  await dispatched.promise;
  const closing = f.access.close();
  assert.equal(f.access.close(), closing);
  await closing;
  await call;
  assert.throws(() => f.access.credentialsForAgent('agent-a', 'default'), { code: 'NOT_ALLOWED' });
});

test('a public transport uses the scoped gateway and shared ledger', async t => {
  /** @type {import('@luna-shi/murm').ModelTransport} */
  const protocol = {
    id: 'external-transport', version: '1', clientProtocol: 'responses', path: '/v1/responses',
    validateUpstream: url => url.pathname === '/v1/responses',
    prepareRequest(body, policy) {
      if (body?.input !== 'fixture' || body.model !== policy.model) return null;
      return { model: policy.model, query: body.input, cap: policy.maxOutputTokens };
    },
    stream(model) {
      return { accept(data) {
        const event = JSON.parse(data);
        if (event.model === model && event.done === true) {
          return { status: 'completed', usage: { inputTokens: 4, outputTokens: 2 } };
        }
      } };
    },
  };
  const f = await fixture(t, { protocol, reply(_request, response, body) {
    response.end(`data: ${JSON.stringify({ model: body.model, done: true })}\n\n`);
  } });
  const payload = { model: 'k3', input: 'fixture' };
  assert.equal((await f.call('external', payload)).status, 200);
  assert.equal((await f.call('external', payload)).status, 200);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0].body, { model: 'k3', query: 'fixture', cap: 64 });
  const [filename] = await readdir(join(f.outputDir, 'model-access'));
  const ledger = new DatabaseSync(join(f.outputDir, 'model-access', filename), { readOnly: true });
  t.after(() => ledger.close());
  assert.deepEqual({ ...ledger.prepare('SELECT state, input_tokens, output_tokens FROM runtime_model_attempts').get() },
    { state: 'completed', input_tokens: 4, output_tokens: 2 });
  f.access.revokeAgent('agent-a');
  assert.equal((await f.call('external', payload)).status, 401);
});

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

function completion(model = 'k3') {
  return `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed',
    response: { status: 'completed', model, usage: { input_tokens: 3, output_tokens: 2 } } })}\n\n`;
}

async function fixture(t, { reply, modelAccessPolicy, requestTimeoutMs = 2000, maxOutputTokens = 64, models, provider = 'kimi_proxy', model = 'k3' } = {}) {
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
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1/responses`;
  const bots = new Map([['bot-a', { profile: 'writer', model: 'default', status: 'idle' }]]);
  let access;
  t.after(async () => {
    await access?.close();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    await rm(outputDir, { recursive: true, force: true });
  });
  const config = {
    modelGateway: { host: '127.0.0.1', advertiseHost: '127.0.0.1', requestTimeoutMs, maxOutputTokens },
    models: models ?? { default: { provider, model,
      upstream: { url: upstreamUrl, headers: { authorization: 'Bearer upstream-private' } } } },
  };
  access = await createCoreModelAccess({ runtimeId: 'runtime-a', outputDir, config,
    getBot: botId => bots.get(botId) ?? null, modelAccessPolicy });
  const credentials = access.credentialsForBot('bot-a', 'default');
  const call = async (requestId = 'request-a', body = { model, input: 'Return a small result.' }) => {
    const response = await fetch(`${credentials.baseUrl}/responses`, {
      method: 'POST', headers: { authorization: `Bearer ${Object.values(credentials.secretEnvironment)[0]}`,
        'content-type': 'application/json', 'x-swarmenv-request-id': requestId }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.text() };
  };
  return { access, bots, requests, credentials, call, outputDir, config };
}

test('Runtime model access propagates explicit natural output policy while retaining Bot credentials and usage evidence', async t => {
  const { call, requests, access } = await fixture(t, { maxOutputTokens: null });
  const response = await call('natural-runtime', { model: 'k3', input: 'controlled natural work', max_output_tokens: 128000 });
  assert.equal(response.status, 200); assert.equal(requests[0].body.max_output_tokens, 128000);
  assert.equal(requests[0].headers.authorization, 'Bearer upstream-private');
  assert.ok(access);
});

test('a generic Runtime Bot calls the shipped model with private upstream credentials and a work receipt', async t => {
  const f = await fixture(t);
  assert.equal(f.requests.length, 0);
  assert.equal((await f.call()).body, completion());
  assert.equal(f.requests[0].headers.authorization, 'Bearer upstream-private');
  assert.equal(f.requests[0].body.max_output_tokens, 64);
  assert.deepEqual(f.credentials.environment, { PI_KIMI_PROXY_BASE_URL: f.credentials.baseUrl });
  assert.notEqual(f.credentials.secretEnvironment.PI_KIMI_PROXY_API_KEY, 'upstream-private');
  assert.deepEqual(Object.keys(f.credentials.secretEnvironment), ['PI_KIMI_PROXY_API_KEY']);
  assert.equal(f.credentials.catalogResource.path, '/opt/swarmenv/pi-agent/models.json');
  assert.match(f.credentials.catalogResource.sha256, /^[a-f0-9]{64}$/);
  assert.equal((await f.call()).body, completion());
  assert.equal(f.requests.length, 1);
  const [filename] = await readdir(join(f.outputDir, 'model-access'));
  const ledger = new DatabaseSync(join(f.outputDir, 'model-access', filename), { readOnly: true });
  t.after(() => ledger.close());
  assert.deepEqual({ ...ledger.prepare('SELECT runtime_id, bot_id, request_id, phase, state, input_tokens, output_tokens FROM runtime_model_attempts').get() },
    { runtime_id: 'runtime-a', bot_id: 'bot-a', request_id: 'request-a', phase: 'work', state: 'completed', input_tokens: 3, output_tokens: 2 });
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
  const cases = [
    { name: 'only the empty item is omitted', remove: true },
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
    assert.deepEqual(f.requests[0].body.input, scenario.remove ? original.filter((_, index) => index !== 3) : original);
    assert.deepEqual(input, original, 'Client history must not be mutated');
    assert.equal(result.status, scenario.reject ? 502 : 200);
    if (scenario.remove) {
      assert.deepEqual(await f.call('native-tool-history', payload), result, 'The same original request replays its receipt');
      assert.equal(f.requests.length, 1);
      assert.equal((await f.call('native-tool-history', { ...payload, input: original.filter((_, index) => index !== 3) })).status, 409,
        'Original client history, including the empty item, owns the stable request fingerprint');
      assert.equal(f.requests.length, 1);
    }
  });
});

test('model credentials reject unknown identities and requests fail before effects after identity or profile changes', async t => {
  const f = await fixture(t);
  assert.throws(() => f.access.credentialsForBot('foreign-bot', 'default'), { code: 'NOT_ALLOWED' });
  assert.throws(() => f.access.credentialsForBot('bot-a', 'unknown'), { code: 'NOT_ALLOWED' });
  assert.equal((await f.call('conflict')).status, 200);
  assert.equal((await f.call('conflict', { model: 'k3', input: 'Changed input.' })).status, 409);
  assert.equal((await f.call('invalid-model', { model: 'other', input: 'Try another model.' })).status, 400);
  const bot = f.bots.get('bot-a');
  bot.status = 'starting';
  assert.equal((await f.call('not-ready')).status, 403);
  bot.status = 'idle';
  bot.model = 'another';
  assert.equal((await f.call('foreign-model')).status, 403);
  bot.model = 'default';
  for (const status of ['closing', 'exited', 'closed']) {
    bot.status = status;
    assert.equal((await f.call(status)).status, 403);
  }
  f.bots.delete('bot-a');
  assert.equal((await f.call('missing')).status, 403);
  assert.equal(f.requests.length, 1);
});

test('optional model policy receives trusted generic identity within one synchronous commit', async t => {
  let inCommit = false;
  let commitCount = 0;
  const callers = [];
  const f = await fixture(t, { modelAccessPolicy: {
    withCommit(commit) {
      inCommit = true;
      commitCount++;
      try { return commit(); }
      finally { inCommit = false; }
    },
    authorize(caller) {
      assert.equal(inCommit, true);
      callers.push(caller);
      return { phase: 'work', deadlineAt: Date.now() + 1000,
        lease: { key: 'allocation-a', version: 7, expiresAt: Date.now() + 1000 } };
    },
  } });
  assert.equal((await f.call()).status, 200);
  assert.equal(commitCount, 1);
  assert.deepEqual(callers, [{ runtimeId: 'runtime-a', botId: 'bot-a', profile: 'writer', model: 'default' }]);
});

test('invalid model permits deny requests before upstream effects', async t => {
  let permit;
  const f = await fixture(t, { modelAccessPolicy: { withCommit: commit => commit(), authorize: () => permit } });
  const valid = { phase: 'work', deadlineAt: Date.now() + 1000 };
  const cases = [null, {}, { ...valid, phase: 'unknown' }, { ...valid, deadlineAt: Infinity },
    { ...valid, deadlineAt: Date.now() - 1 }, { ...valid, lease: null }, { ...valid, lease: false },
    { ...valid, lease: { key: 'allocation', version: -1, expiresAt: Date.now() + 1000 } },
    { ...valid, lease: { key: 'allocation', version: 1, expiresAt: Date.now() - 1 } }];
  for (const [index, value] of cases.entries()) {
    permit = value;
    assert.equal((await f.call(`invalid-${index}`)).status, 403);
  }
  assert.equal(f.requests.length, 0);
});

test('revoking a live Bot aborts its model stream and prevents replacement credentials', async t => {
  const dispatched = Promise.withResolvers();
  const upstreamClosed = Promise.withResolvers();
  const f = await fixture(t, { reply: (_request, response) => {
    dispatched.resolve();
    response.once('close', () => upstreamClosed.resolve());
  } });
  const call = f.call().catch(() => ({ status: 502 }));
  await dispatched.promise;
  f.access.revokeBot('bot-a');
  assert.equal((await call).status, 502);
  await upstreamClosed.promise;
  assert.equal((await f.call('revoked')).status, 401);
  assert.throws(() => f.access.credentialsForBot('bot-a', 'default'), { code: 'NOT_ALLOWED' });
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

test('stream authority follows renewal of the same generic lease and aborts changed ownership', async t => {
  for (const outcome of ['renewed', 'version-changed', 'key-changed', 'expired', 'denied']) {
    await t.test(outcome, { timeout: 3000 }, async t => {
      const dispatched = Promise.withResolvers();
      let finish;
      let permit;
      const f = await fixture(t, { reply: (_request, response) => {
        finish = () => response.end(completion());
        dispatched.resolve();
      }, modelAccessPolicy: { withCommit: commit => commit(), authorize: () => permit } });
      const firstExpiry = Date.now() + 120;
      permit = { phase: 'work', deadlineAt: Date.now() + 1800,
        lease: { key: 'allocation-a', version: 1, expiresAt: firstExpiry } };
      const call = f.call();
      await dispatched.promise;
      if (outcome === 'denied') permit = null;
      else if (outcome !== 'expired') permit.lease.expiresAt = Date.now() + 1500;
      if (outcome === 'version-changed') permit.lease.version = 2;
      if (outcome === 'key-changed') permit.lease.key = 'allocation-b';
      if (outcome === 'renewed') {
        await delay(Math.max(0, firstExpiry - Date.now()) + 40);
        finish();
        assert.equal((await call).status, 200);
      } else {
        assert.equal((await call).status, 502);
        assert.ok(Date.now() < firstExpiry + 1000);
      }
      assert.equal(f.requests.length, 1);
    });
  }
});

test('unsupported catalog entries, malformed endpoints and nonfinite limits fail before Bot allocation', async t => {
  const cases = [
    { models: { default: { provider: 'openai', model: 'k3', upstream: { url: 'http://127.0.0.1/v1/responses' } } } },
    { models: { default: { provider: 'kimi_proxy', model: 'unsupported', upstream: { url: 'http://127.0.0.1/v1/responses' } } } },
    { models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: 'https://secret@host.test/v1/responses' } } } },
    { models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: 'https://host.test/v1/chat/completions' } } } },
    { requestTimeoutMs: Infinity },
    { requestTimeoutMs: -1 },
    { modelAccessPolicy: { async authorize() {}, withCommit: commit => commit() } },
    { modelAccessPolicy: { authorize: () => null, async withCommit(commit) { return commit(); } } },
  ];
  for (const options of cases) await assert.rejects(fixture(t, options), { code: 'INVALID_CONFIG' });
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
  assert.throws(() => f.access.credentialsForBot('bot-a', 'default'), { code: 'NOT_ALLOWED' });
});

test('a deferred model commit cannot dispatch after its synchronous admission window closes', async t => {
  const f = await fixture(t, { modelAccessPolicy: {
    authorize: () => ({ phase: 'work', deadlineAt: Date.now() + 1000 }),
    withCommit(commit) { queueMicrotask(commit); },
  } });
  assert.equal((await f.call()).status, 502);
  await delay(10);
  assert.equal(f.requests.length, 0);
});

test('an asynchronous permit returned by an ordinary function is denied without unhandled rejection', async t => {
  const f = await fixture(t, { modelAccessPolicy: {
    authorize() { return Promise.reject(new Error('invalid asynchronous authority')); },
    withCommit: commit => commit(),
  } });
  assert.equal((await f.call()).status, 403);
  assert.equal(f.requests.length, 0);
});

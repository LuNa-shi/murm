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

async function fixture(t, { reply, modelAccessPolicy, requestTimeoutMs = 2000, models } = {}) {
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
    modelGateway: { host: '127.0.0.1', advertiseHost: '127.0.0.1', requestTimeoutMs, maxOutputTokens: 64 },
    models: models ?? { default: { provider: 'kimi_proxy', model: 'k3',
      upstream: { url: upstreamUrl, headers: { authorization: 'Bearer upstream-private' } } } },
  };
  access = await createCoreModelAccess({ runtimeId: 'runtime-a', outputDir, config,
    getBot: botId => bots.get(botId) ?? null, modelAccessPolicy });
  const credentials = access.credentialsForBot('bot-a', 'default');
  const call = async (requestId = 'request-a', body = { model: 'k3', input: 'Return a small result.' }) => {
    const response = await fetch(`${credentials.baseUrl}/responses`, {
      method: 'POST', headers: { authorization: `Bearer ${credentials.secretEnvironment.PI_KIMI_PROXY_API_KEY}`,
        'content-type': 'application/json', 'x-swarmenv-request-id': requestId }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.text() };
  };
  return { access, bots, requests, credentials, call, outputDir, config };
}

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

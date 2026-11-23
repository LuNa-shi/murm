import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { BotModelAccess, assertBenchmarkModelPair } from '../src/agent/bot-model-access.js';

async function fixture(t, { fetchImpl, autoStart = true, timeBounded = false, requestTimeoutMs = 1000 } = {}) {
  const db = new DatabaseSync(':memory:');
  const bot = { bot_id: 'b', mission_id: 'm', state: 'UNBOUND', hard_deadline: new Date(Date.now() + 60_000).toISOString(),
    selection_deadline: new Date(Date.now() + 30_000).toISOString() };
  const execution = { execution_id: 'e', owner_ref: 'b', state: 'RUNNING', fencing_version: 1, execution_deadline: bot.hard_deadline, lease_expires_at: bot.hard_deadline };
  let stopping = false;
  let accepted = false;
  let closeoutDeadline = Infinity;
  const requests = [];
  const allowance = { requests: 20, inputTokens: 10_000, outputTokens: 10_000, cost: 100_000 };
  const access = new BotModelAccess({ db, missionId: 'm', provider: 'gpt_proxy', model: 'fixed',
    taskService: { withServiceLifecycleWrite: commit => commit(), getBot: () => bot, getExecution: () => execution, isMissionStopped: () => accepted },
    deadline: () => Date.now() + 60_000, closeoutDeadline: () => closeoutDeadline, isStopping: () => stopping,
    upstream: { url: 'http://upstream.test/v1/responses', headers: { authorization: 'Bearer host-secret' } },
    timeBounded,
    configuration: timeBounded ? { requestTimeoutMs } : { limits: { mission: allowance, bot: allowance, selection: allowance,
      closeout: { requests: 2, inputTokens: 200, outputTokens: 200, cost: 400 } },
      contract: { maxInputTokens: 100, maxOutputTokens: 100, maxFanout: 1, inputCostPerToken: 1,
        outputCostPerToken: 1, fixedAttemptCost: 0, costUnit: 'test-units', requestTimeoutMs, boundEvidence: 'controlled upstream' } },
    fetchImpl: fetchImpl ?? (async (url, options) => {
      requests.push({ url, options });
      return new Response('event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
        { headers: { 'content-type': 'text/event-stream' } });
    }) });
  t.after(async () => { await access.stop(); db.close(); });
  if (!autoStart) return { access };
  await access.start();
  const credential = access.credentialsForBot(bot);
  const call = async () => {
    const response = await fetch(`${credential.environment.PI_GPT_PROXY_BASE_URL}/responses`, { method: 'POST',
      headers: { authorization: `Bearer ${credential.secretEnvironment.PI_GPT_PROXY_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fixed', input: 'research' }) });
    await response.text();
    return response.status;
  };
  return { access, bot, execution, requests, call, credential,
    accept: () => { accepted = true; }, stop: () => { stopping = true; }, expireCloseout: () => { closeoutDeadline = 0; } };
}

test('model gateway uses current Bot authority for selection, work, closeout and revocation', async t => {
  const f = await fixture(t);
  assert.equal(await f.call(), 200);
  assert.equal(f.access.gateway.totals({ missionId: 'm', phase: 'selection' }).requests, 1);
  f.bot.state = 'PREPARING';
  assert.equal(await f.call(), 403);
  f.bot.state = 'ACTIVE'; f.bot.execution_id = 'e';
  assert.equal(await f.call(), 200);
  assert.equal(f.access.gateway.totals({ missionId: 'm', phase: 'work' }).requests, 1);
  f.accept();
  assert.equal(await f.call(), 403);
  f.execution.handoff_reminder_sent_at = new Date().toISOString();
  assert.equal(await f.call(), 200);
  assert.equal(f.access.gateway.totals({ missionId: 'm', phase: 'closeout' }).requests, 1);
  f.expireCloseout();
  assert.equal(await f.call(), 403);
  f.access.revokeBot('b');
  assert.equal(await f.call(), 401);
  assert.equal(f.requests.length, 3);
  assert.ok(f.requests.every(row => row.options.headers.get('authorization') === 'Bearer host-secret'));
  assert.notEqual(f.credential.secretEnvironment.PI_GPT_PROXY_API_KEY, 'host-secret');
});

test('hard deadline and stopping deny new model work before delayed Runtime cleanup', async t => {
  const f = await fixture(t, { timeBounded: true });
  f.bot.hard_deadline = new Date(0).toISOString();
  assert.equal(await f.call(), 403);
  f.bot.hard_deadline = new Date(Date.now() + 60_000).toISOString();
  f.stop();
  assert.equal(await f.call(), 403);
  assert.equal(f.requests.length, 0);
  const evidence = f.access.evidence();
  assert.equal(evidence.mode, 'time_bounded');
  assert.equal(evidence.cost, null);
  assert.equal(evidence.observed_usage.observed_input_tokens, null);
  assert.equal(evidence.observed_usage.requests, 0);
});

test('gateway aborts a held upstream request at the earlier Bot deadline and retains its reservation', async t => {
  let observedAbort;
  const aborted = new Promise(resolve => { observedAbort = resolve; });
  let seen;
  const started = new Promise(resolve => { seen = resolve; });
  const f = await fixture(t, { fetchImpl: async (_url, { signal }) => {
    signal.addEventListener('abort', () => observedAbort(Date.now()), { once: true });
    seen();
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const hardAt = Date.now() + 300;
  f.bot.hard_deadline = new Date(hardAt).toISOString();
  const call = f.call();
  await started;
  const abortAt = await aborted;
  assert.ok(abortAt >= hardAt - 25 && abortAt < hardAt + 400, `aborted at ${abortAt}, deadline ${hardAt}`);
  assert.equal(await call, 502);
  const accounted = f.access.gateway.totals({ missionId: 'm' });
  assert.deepEqual({ ...accounted }, { requests: 1, inputTokens: 100, outputTokens: 100, cost: 200 });
});

test('held model HTTP requests follow a renewed lease for the same Execution and fence', async t => {
  for (const outcome of ['renewed', 'unrenewed', 'finished', 'owner-changed', 'execution-changed', 'fenced', 'revoked', 'request-deadline']) {
    await t.test(outcome, { timeout: 3000 }, async t => {
      const { promise: started, resolve: dispatch } = Promise.withResolvers();
      const { promise: terminal, resolve: complete } = Promise.withResolvers();
      const { promise: aborted, resolve: recordAbort } = Promise.withResolvers();
      let upstreamCalls = 0;
      const f = await fixture(t, {
        timeBounded: true, requestTimeoutMs: outcome === 'request-deadline' ? 450 : 1500,
        fetchImpl: async (_url, { signal }) => {
          upstreamCalls++;
          const abort = new Promise((_, reject) => signal.addEventListener('abort', () => {
            recordAbort(Date.now());
            reject(signal.reason);
          }, { once: true }));
          dispatch(Date.now());
          await Promise.race([terminal, abort]);
          return new Response('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","model":"fixed","usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
            { headers: { 'content-type': 'text/event-stream' } });
        },
      });
      f.bot.state = 'ACTIVE';
      f.bot.execution_id = 'e';
      const leaseAt = Date.now() + 250;
      f.execution.lease_expires_at = new Date(leaseAt).toISOString();
      const call = f.call();
      const startedAt = await started;
      if (outcome !== 'unrenewed') f.execution.lease_expires_at = new Date(leaseAt + 10_000).toISOString();
      if (outcome === 'finished') f.execution.state = 'SUCCEEDED';
      if (outcome === 'execution-changed') {
        f.bot.execution_id = 'replacement';
        f.execution.execution_id = 'replacement';
      }
      if (outcome === 'owner-changed') f.execution.owner_ref = 'another-bot';
      if (outcome === 'fenced') f.execution.fencing_version++;
      if (outcome === 'revoked') f.access.revokeBot('b');
      if (outcome === 'renewed') {
        await delay(leaseAt - Date.now() + 75);
        complete();
        assert.equal(await call, 200);
        assert.equal(f.access.evidence().observed_usage.requests_with_usage, 1);
      } else {
        const abortedAt = await aborted;
        assert.equal(await call, 502);
        assert.equal(f.access.evidence().observed_usage.unknown_requests, 1);
        if (outcome === 'request-deadline') assert.ok(abortedAt >= startedAt + 425 && abortedAt < startedAt + 850);
        else if (outcome !== 'revoked') assert.ok(abortedAt >= leaseAt - 15 && abortedAt < leaseAt + 400);
      }
      assert.equal(upstreamCalls, 1);
    });
  }
});

test('gateway stop during listen settles startup and repeated stop', async t => {
  const { access } = await fixture(t, { autoStart: false });
  const start = access.start();
  const stop = access.stop();
  assert.equal(access.stop(), stop);
  await assert.rejects(start, /stopped during startup/);
  await stop;
  assert.equal(access.baseUrl, undefined);
  await assert.rejects(access.start(), /cannot start again/);
});

test('timed model pairing uses the actual shipped Responses catalog and requires direct Pi', async () => {
  const pair = { provider: 'gpt_proxy', model: 'gpt-6.1-sol', command: 'pi' };
  const catalog = await readFile(new URL('../services/opensandbox-agent/pi-models.json', import.meta.url));
  const resource = { path: '/opt/swarmenv/pi-agent/models.json', sha256: createHash('sha256').update(catalog).digest('hex') };
  assert.deepEqual(await assertBenchmarkModelPair(pair), resource);
  assert.deepEqual(await assertBenchmarkModelPair({ provider: 'kimi_proxy', model: 'k3', command: 'pi' }), resource);
  await assertBenchmarkModelPair({ ...pair, command: '/usr/local/bin/pi' });
  await assert.rejects(assertBenchmarkModelPair({ ...pair, provider: 'openai' }), /Responses catalog/);
  await assert.rejects(assertBenchmarkModelPair({ ...pair, provider: 'constructor' }), /Responses catalog/);
  await assert.rejects(assertBenchmarkModelPair({ ...pair, model: 'unsupported' }), /Responses catalog/);
  await assert.rejects(assertBenchmarkModelPair({ ...pair, command: 'alternate-launcher' }), /require direct Pi/);
});

test('model reservation and upstream dispatch hold real Task authority against another connection exit', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { TaskService } = await import('../src/task/task-service.js');
  const { makeEnvelope } = await import('../src/protocol/envelope.js');
  const root = await mkdtemp(join(tmpdir(), 'model-lifecycle-'));
  const tasks = new TaskService(join(root, 'tasks.sqlite'));
  const other = new TaskService(join(root, 'tasks.sqlite'));
  other.db.exec('PRAGMA busy_timeout = 0');
  const modelDb = new DatabaseSync(':memory:');
  const envelope = () => makeEnvelope({ actorRef: 'b' });
  tasks.createMission({ mission_id: 'm', goal: 'Model admission race' }, makeEnvelope({ actorRef: 'operator' }));
  tasks.registerBot({ botId: 'b', coreId: 'c', missionId: 'm', selectionDeadline: new Date(Date.now() + 60_000).toISOString() });
  tasks.recordBotSandbox('b', { provider: 'controlled', sandboxId: 's' });
  tasks.markBotReady('b');
  let release, dispatched;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { dispatched = resolve; });
  const allowance = { requests: 10, inputTokens: 10000, outputTokens: 10000, cost: 10000 };
  let calls = 0;
  const access = new BotModelAccess({ db: modelDb, taskService: tasks, missionId: 'm', provider: 'gpt_proxy', model: 'fixed', deadline: () => Date.now() + 60_000,
    upstream: { url: 'http://upstream.test/v1/responses' }, configuration: {
      limits: { mission: allowance, bot: allowance, selection: allowance, closeout: { requests: 0, inputTokens: 0, outputTokens: 0, cost: 0 } },
      contract: { maxInputTokens: 100, maxOutputTokens: 100, maxFanout: 1, inputCostPerToken: 1, outputCostPerToken: 1,
        fixedAttemptCost: 0, costUnit: 'test-units', requestTimeoutMs: 2000, boundEvidence: 'controlled test' } },
    fetchImpl: () => {
      calls++;
      assert.equal(access.gateway.totals({ missionId: 'm' }).requests, 1);
      assert.throws(() => other.dispatch('bot_exit', { reason: 'selection-budget' }, envelope()), /locked|busy/i);
      dispatched();
      return held;
    } });
  await access.start();
  t.after(async () => { release(new Response('', { headers: { 'content-type': 'text/event-stream' } })); await access.stop(); other.close(); tasks.close(); modelDb.close(); await rm(root, { recursive: true, force: true }); });
  const credential = access.credentialsForBot(tasks.getBot('b'));
  const call = async () => {
    const response = await fetch(`${access.baseUrl}/responses`, { method: 'POST', headers: { authorization: `Bearer ${credential.secretEnvironment.PI_GPT_PROXY_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ input: 'test' }) });
    await response.text(); return response.status;
  };
  const first = call();
  await started;
  other.requestBotStop('b', 'selection-budget');
  assert.equal(await call(), 403);
  release(new Response('event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n', { headers: { 'content-type': 'text/event-stream' } }));
  assert.equal(await first, 200);
  assert.equal(calls, 1);
});

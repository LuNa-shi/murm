import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createRuntime } from '@murm/core';
import { createPiOpenSandboxBackend } from '@murm/core/backends/pi-opensandbox';
import { ServiceRegistry, createHttpJsonAdapter } from '@murm/core/services';
import { createNotesService, notesManifest } from './fixtures/core-notes-service.js';
import { createNotesUpstream, notesCommand } from './fixtures/core-notes-upstream.js';
import { cleanupRuntimes } from './fixtures/core-runtime-cleanup.js';
import { ownedContainers } from './fixtures/core-runtime-containers.js';

test('real Pi Bash holds the same execution through a long authenticated HTTP Service wait', {
  skip: process.env.SWARMENV_CORE_SERVICE_REAL_TEST !== '1' && 'Independent review and explicit controlled local opt-in required', timeout: 160_000,
}, async t => {
  const image = process.env.SWARMENV_CORE_TEST_IMAGE; assert.ok(image);
  const plan = {};
  const upstream = await createNotesUpstream(plan);
  t.after(() => upstream.close());
  const local = createNotesService(); const remote = createNotesService();
  const { promise: waiting, resolve: observeWait } = Promise.withResolvers();
  const { promise: release, resolve: deliver } = Promise.withResolvers();
  t.after(deliver);
  const hostToken = randomBytes(32).toString('hex');
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${hostToken}`) { request.resume(); response.writeHead(403); response.end(); return; }
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; assert.ok(bytes < 64 * 1024); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const operation = request.url.slice(1);
      assert.ok(['put', 'get'].includes(operation));
      if (operation === 'get') {
        observeWait();
        await release;
      }
      const result = remote.adapter.invoke({ ...body, capability: { operation } });
      response.end(JSON.stringify({ ok: true, result }));
    } catch { response.writeHead(400); response.end(JSON.stringify({ ok: false, error: { code: 'INVALID_CONTRACT' } })); }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const registry = new ServiceRegistry();
  registry.registerService({ manifest: notesManifest(), adapter: {
    ...local.adapter,
    exportState: () => ({ notes: [...local.entries.values()] }),
  } });
  const remoteManifest = notesManifest('remote-notes');
  remoteManifest.endpoint = { transport: 'http-json', url: `http://127.0.0.1:${server.address().port}` };
  for (const capability of remoteManifest.capabilities) capability.path = '/' + capability.operation;
  remoteManifest.capabilities.find(capability => capability.operation === 'get').timeout_ms = 40_000;
  registry.registerService({ manifest: remoteManifest, adapter: createHttpJsonAdapter({ token: hostToken, timeoutMs: 41_000 }) });
  const outputDir = join(process.cwd(), 'experiments', `core-service-${Date.now()}`);
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const runtimes = []; const resources = {}; const report = { failure: true };
  const deadline = setTimeout(() => { for (const runtime of runtimes) void runtime.close({ timeoutMs: 1 }).catch(() => {}); }, 120_000);
  t.after(() => clearTimeout(deadline));
  t.after(async () => {
    report.cleanup = await cleanupRuntimes(runtimes, { inspect: ownedContainers, resources });
    Object.assign(report, { resources, upstream: upstream.receipt(), local: { writes: local.writes, calls: local.calls }, remote: { writes: remote.writes, calls: remote.calls } });
    await writeFile(join(outputDir, 'acceptance.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    assert.ok(report.cleanup.every(row => row.cleanup === 'complete'));
    assert.ok(Object.values(resources).every(row => row.empty));
  });
  const host = process.env.SWARMENV_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1';
  const runtime = await createRuntime({ backend: createPiOpenSandboxBackend({
    sandbox: { lifecycleBaseUrl: process.env.SWARMENV_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
      endpointHost: process.env.SWARMENV_CORE_TEST_ENDPOINT_HOST ?? '127.0.0.1', apiKey: process.env.SWARMENV_CORE_TEST_API_KEY,
      resourceLimits: { cpu: '1', memory: '1Gi' }, commandTimeoutMs: 20_000 },
    bridge: { host: '0.0.0.0', publicUrl: `http://${host}:{port}` },
    modelGateway: { host: '0.0.0.0', advertiseHost: host, requestTimeoutMs: 80_000, maxOutputTokens: 128 },
    models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: upstream.url, headers: {} } } },
    isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } },
  }), profiles: { worker: { prompt: 'Execute the fixed Notes checks using Bash.', image, model: 'default', writable: false,
    services: { notes: ['put', 'get'], 'remote-notes': ['put', 'get'] } } }, services: registry, maxBots: 1, outputDir });
  runtimes.push(runtime);
  const bot = await runtime.spawn({ requestId: 'notes-spawn', profile: 'worker', bindings: { notes: 'local-account', 'remote-notes': 'remote-account' } });
  report.runtimeId = runtime.id; report.botId = bot.id;
  assert.equal((await ownedContainers(runtime.id)).length, 1);
  plan.command = notesCommand(bot.id, 45_000);
  let resolve;
  const settled = new Promise(done => { resolve = done; });
  const unsubscribe = runtime.onEvent(event => { if (event.botId === bot.id && event.type === 'settled') resolve(event); });
  t.after(unsubscribe);
  const timer = setTimeout(() => resolve({ outcome: 'timeout' }), 90_000); t.after(() => clearTimeout(timer));
  const receipt = await runtime.send(bot.id, 'FIXED_NOTES_EXCHANGE', { requestId: 'notes-input', mode: 'followUp' });
  assert.equal(receipt.status, 'accepted'); report.input = receipt;
  await Promise.race([waiting, settled.then(() => assert.fail('Pi settled before entering the Service wait'))]);
  await delay(31_000);
  assert.equal((await runtime.get(bot.id)).status, 'running');
  assert.equal(upstream.receipt().requests, 1, 'The next LLM request waits for the same Bash tool call');
  deliver();
  const outcome = await settled; assert.equal(outcome.outcome, 'completed'); assert.equal(outcome.output, 'NOTES_OK');
  for (const [service, binding] of [[local, 'local-account'], [remote, 'remote-account']]) {
    assert.equal(service.writes, 1); assert.equal(service.calls.length, 2);
    assert.deepEqual(service.entries.get('fixed'), { key: 'fixed', text: 'handoff', author: bot.id });
    for (const call of service.calls) assert.deepEqual(call.caller, { runtimeId: runtime.id, botId: bot.id, profile: 'worker', binding });
  }
  assert.equal(upstream.receipt().requests, 2); assert.equal(upstream.receipt().failure, undefined);
  assert.equal((await runtime.close()).cleanup, 'complete');
  const trace = await readFile(join(outputDir, runtime.id, 'service-calls.jsonl'), 'utf8');
  assert.ok(!trace.includes(hostToken));
  const longWait = trace.trim().split('\n').map(JSON.parse)
    .find(row => row.operation_id === 'remote-notes-read' && row.phase === 'settled');
  assert.equal(longWait.caller.botId, bot.id);
  assert.equal(longWait.output.text, 'handoff');
  assert.ok(Date.parse(longWait.endedAt) - Date.parse(longWait.startedAt) >= 31_000);
  const serviceState = JSON.parse(await readFile(join(outputDir, runtime.id, 'service-state.notes.json'), 'utf8'));
  assert.deepEqual(serviceState.state.notes, [local.entries.get('fixed')]);
  report.failure = false;
});

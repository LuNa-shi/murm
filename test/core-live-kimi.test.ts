import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCappedUpstream } from './fixtures/core-capped-upstream.js';
import { ownedContainers } from './fixtures/core-runtime-containers.js';

test('public Core live Kimi K3 acceptance verifies actual file tools within the authorized cap', {
  skip: process.env.SWARMENV_CORE_LIVE_KIMI_TEST !== '1' && 'Live Kimi acceptance requires explicit run authorization and opt-in configuration',
  timeout: 155_000,
}, async t => {
  const startedAt = Date.now();
  const deadlineAt = startedAt + 120_000;
  const outputDir = join(process.cwd(), 'experiments', `core-live-kimi-${startedAt}`);
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const reportPath = join(outputDir, 'acceptance.json');
  const filename = 'core-live-smoke.txt';
  const marker = 'CORE_LIVE_TOOL_EFFECT_CONFIRMED';
  const events = [];
  let runtime;
  let botId;
  let proxy;
  let stop;
  let close;
  let sendStatus;
  let inputId;
  let outcome;
  let expectedOutput = false;
  let expectedLatestOutput = false;
  let closedSendRejected = false;
  const resources = {};
  let phase = 'configuration';
  let failurePhase;
  let failure = false;
  let deadlineExpired = false;
  let resolveSettled;
  const settled = new Promise(resolve => { resolveSettled = resolve; });
  const workTimer = setTimeout(() => {
    deadlineExpired = true;
    resolveSettled({ outcome: 'deadline' });
    if (runtime) void runtime.close({ timeoutMs: 1 }).catch(() => undefined);
  }, Math.max(1, deadlineAt - Date.now()));
  const remaining = () => Math.max(1, deadlineAt - Date.now());
  const receiptProjection = receipt => receipt && {
    execution: receipt.execution, cleanup: receipt.cleanup,
    artifacts: receipt.artifacts?.length ?? 0,
    errors: receipt.errors?.map(error => ({ code: error.code, retryable: error.retryable })),
  };
  try {
    const { createRuntime } = await import('@swarmenv/core');
    const { ServiceRegistry } = await import('@swarmenv/core/services');
    const { createPiOpenSandboxBackend } = await import('@swarmenv/core/backends/pi-opensandbox');
    let upstreamHeaders;
    try { upstreamHeaders = JSON.parse(process.env.SWARMENV_CORE_LIVE_UPSTREAM_HEADERS_JSON ?? '{}'); }
    catch { throw new Error('LIVE_HEADERS_INVALID'); }
    const image = process.env.SWARMENV_CORE_TEST_IMAGE;
    if (!image) throw new Error('LIVE_IMAGE_REQUIRED');
    proxy = await createCappedUpstream({
      upstreamUrl: process.env.SWARMENV_CORE_LIVE_UPSTREAM_URL,
      upstreamHeaders, deadlineAt, maxRequests: 8, maxOutputTokens: 4096, filename, marker,
    });
    const backend = createPiOpenSandboxBackend({
      sandbox: {
        lifecycleBaseUrl: process.env.SWARMENV_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
        endpointHost: process.env.SWARMENV_CORE_TEST_ENDPOINT_HOST ?? '127.0.0.1',
        apiKey: process.env.SWARMENV_CORE_TEST_API_KEY, commandTimeoutMs: 20_000,
      },
      bridge: { host: '0.0.0.0', publicUrl: process.env.SWARMENV_CORE_TEST_BRIDGE_URL ?? 'http://172.17.0.1:{port}' },
      modelGateway: { host: '0.0.0.0', advertiseHost: process.env.SWARMENV_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1',
        requestTimeoutMs: 30_000, maxOutputTokens: 4096 },
      models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: proxy.url, headers: {} } } },
      isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 * 1024, inodes: 4096 } },
    });
    phase = 'runtime_create';
    runtime = await createRuntime({ backend, profiles: {
      worker: { prompt: 'Use the requested Bash and read tools directly. Verify the file contents before reporting completion. Keep the response brief.',
        model: 'default', image, writable: true, services: {} },
    }, services: new ServiceRegistry(), maxBots: 1, outputDir });
    if (Date.now() >= deadlineAt) throw new Error('LIVE_DEADLINE');
    resources.beforeSpawnEmpty = (await ownedContainers(runtime.id)).length === 0;
    assert.equal(resources.beforeSpawnEmpty, true);
    phase = 'spawn';
    const bot = await runtime.spawn({ requestId: 'live-kimi-spawn', profile: 'worker' });
    botId = bot.id;
    assert.equal(bot.status, 'idle');
    assert.equal(proxy.receipt().forwarded, 0);
    const active = await ownedContainers(runtime.id);
    resources.spawnOne = active.length === 1;
    assert.equal(resources.spawnOne, true);
    if (Date.now() >= deadlineAt) throw new Error('LIVE_DEADLINE');
    runtime.onEvent(event => {
      events.push({ type: event.type, botId: event.botId, seq: event.seq,
        outcome: event.outcome, expected: event.expected, errorCode: event.error?.code });
      if (event.botId === botId && event.type === 'settled') resolveSettled({ outcome: event.outcome, output: event.output });
    });
    const input = `Use the bash tool to create ${filename} containing exactly ${marker} and a newline. Then use the read tool on ${filename}. After verifying its exact contents, reply FILE_OK.`;
    phase = 'send';
    const sent = await runtime.send(botId, input, { requestId: 'live-kimi-input', mode: 'followUp' });
    sendStatus = sent.status;
    inputId = sent.inputId;
    assert.equal(sendStatus, 'accepted');
    phase = 'settled';
    const result = await settled;
    outcome = result.outcome;
    assert.equal(outcome, 'completed');
    expectedOutput = result.output === 'FILE_OK';
    assert.equal(expectedOutput, true);
    assert.equal(deadlineExpired, false);
    phase = 'result_evidence';
    const current = await runtime.get(botId);
    assert.equal(current.status, 'idle');
    expectedLatestOutput = current.latestOutput === 'FILE_OK';
    assert.equal(expectedLatestOutput, true);
    const idleResources = await ownedContainers(runtime.id);
    resources.settledRetained = idleResources.length === active.length && idleResources.every(value => active.includes(value));
    assert.equal(resources.settledRetained, true);
    const evidence = proxy.receipt();
    assert.equal(evidence.bashReturned, true);
    assert.equal(evidence.readVerified, true);
    assert.ok(evidence.forwarded > 0 && evidence.forwarded <= 8);
    phase = 'stop';
    stop = await runtime.stop(botId, { timeoutMs: Math.min(30_000, remaining()) });
    assert.equal(stop.execution, 'stopped');
    assert.equal(stop.cleanup, 'complete');
    resources.afterStopEmpty = (await ownedContainers(runtime.id)).length === 0;
    assert.equal(resources.afterStopEmpty, true);
    assert.equal((await runtime.get(botId)).status, 'closed');
    phase = 'closed_send_rejection';
    await assert.rejects(runtime.send(botId, 'closed Bot rejection check', { requestId: 'live-kimi-closed-check' }), {
      code: 'NOT_ALLOWED', runtimeId: runtime.id, botId, requestId: 'live-kimi-closed-check',
    });
    closedSendRejected = true;
    phase = 'close';
    close = await runtime.close({ timeoutMs: Math.min(30_000, remaining()) });
    assert.equal(close.cleanup, 'complete');
    assert.equal(deadlineExpired, false);
  } catch {
    failure = true;
    failurePhase = phase;
  } finally {
    clearTimeout(workTimer);
    try {
      if (runtime && close?.cleanup !== 'complete') close = await runtime.close({ timeoutMs: 30_000 });
    } catch { failure = true; failurePhase ??= 'cleanup'; }
    if (proxy) await proxy.close();
    try {
      await writeFile(reportPath, JSON.stringify({
        provider: 'kimi_proxy', model: 'k3', workloadLimitMs: 120_000, cleanupTailLimitMs: 30_000,
        runtimeId: runtime?.id, botId, requestId: 'live-kimi-input', inputId, sendStatus, outcome,
        acceptedInputCount: sendStatus === 'accepted' ? 1 : 0,
        expectedOutput, expectedLatestOutput, closedSendRejected, resources, failurePhase,
        deadlineExpired, elapsedMs: Date.now() - startedAt, failure,
        upstream: proxy?.receipt(), events,
        stop: receiptProjection(stop),
        close: close && { cleanup: close.cleanup, bots: close.bots.map(receiptProjection),
          errors: close.errors.map(error => ({ code: error.code, retryable: error.retryable })) },
      }, null, 2), { mode: 0o600 });
    } catch { failure = true; failurePhase ??= 'report'; }
  }
  if (failure) throw new Error('LIVE_CORE_ACCEPTANCE_FAILED. Inspect the redacted local acceptance receipt.');
  t.diagnostic('Live Kimi K3 acceptance passed. Redacted receipt saved under ignored experiments/core-live-kimi-*/acceptance.json.');
});

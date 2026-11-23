import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createControlledUpstream } from './fixtures/core-controlled-upstream.js';

test('public Core runs a no-Task Bot through real Pi/OpenSandbox and verifies a Bash file effect', {
  skip: process.env.SWARMENV_CORE_REAL_TEST !== '1' && 'Set SWARMENV_CORE_REAL_TEST=1 with a verified local OpenSandbox image',
  timeout: 180_000,
}, async t => {
  const { createRuntime } = await import('@swarmenv/core');
  const { ServiceRegistry } = await import('@swarmenv/core/services');
  const { createPiOpenSandboxBackend } = await import('@swarmenv/core/backends/pi-opensandbox');
  const image = process.env.SWARMENV_CORE_TEST_IMAGE;
  assert.ok(image, 'SWARMENV_CORE_TEST_IMAGE must identify a verified Pi/OpenSandbox image');
  const upstream = await createControlledUpstream();
  t.after(() => upstream.close());
  const outputDir = await mkdtemp(join(tmpdir(), 'swarmenv-core-smoke-'));
  const backend = createPiOpenSandboxBackend({
    sandbox: {
      lifecycleBaseUrl: process.env.SWARMENV_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
      endpointHost: process.env.SWARMENV_CORE_TEST_ENDPOINT_HOST ?? '127.0.0.1',
      apiKey: process.env.SWARMENV_CORE_TEST_API_KEY,
      commandTimeoutMs: 30_000,
    },
    bridge: { host: '0.0.0.0', publicUrl: process.env.SWARMENV_CORE_TEST_BRIDGE_URL ?? 'http://172.17.0.1:{port}' },
    modelGateway: { host: '0.0.0.0', advertiseHost: process.env.SWARMENV_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1',
      requestTimeoutMs: 20_000, maxOutputTokens: 128 },
    models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: upstream.url, headers: {} } } },
    isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 * 1024, inodes: 4096 } },
  });
  const runtime = await createRuntime({ backend, profiles: {
    worker: { prompt: 'Perform the requested local file operation and return its verified result.', model: 'default', image,
      writable: true, services: {} },
  }, services: new ServiceRegistry(), maxBots: 1, outputDir });
  let close;
  t.after(async () => { close ??= await runtime.close({ timeoutMs: 30_000 }); });
  const bot = await runtime.spawn({ requestId: 'smoke-spawn', profile: 'worker' });
  assert.equal(bot.status, 'idle');
  assert.equal(upstream.requests.length, 0, 'spawn must not submit model work');
  const events = [];
  let resolveSettled;
  const settled = new Promise(resolve => { resolveSettled = resolve; });
  const unsubscribe = runtime.onEvent(event => {
    events.push(event);
    if (event.botId === bot.id && event.type === 'settled') resolveSettled(event);
  });
  t.after(unsubscribe);
  const timer = setTimeout(() => resolveSettled({ type: 'timeout' }), 90_000);
  t.after(() => clearTimeout(timer));
  const receipt = await runtime.send(bot.id, 'Create core-smoke.txt using Bash, read it, and report the verified result.',
    { requestId: 'smoke-input', mode: 'followUp' });
  assert.equal(receipt.status, 'accepted');
  const outcome = await settled;
  assert.equal(outcome.type, 'settled', JSON.stringify(events));
  assert.equal(outcome.outcome, 'completed', JSON.stringify(outcome));
  assert.equal(outcome.output?.trim(), 'FILE_OK');
  assert.equal(upstream.failure, undefined);
  assert.equal(upstream.requests.length, 3);
  const idle = await runtime.get(bot.id);
  assert.equal(idle.status, 'idle');
  assert.equal(idle.latestOutput?.trim(), 'FILE_OK');
  const stop = await runtime.stop(bot.id, { timeoutMs: 30_000 });
  assert.equal(stop.execution, 'stopped');
  assert.equal(stop.cleanup, 'complete');
  assert.equal((await runtime.get(bot.id)).status, 'closed');
  await assert.rejects(runtime.send(bot.id, 'rejected after close', { requestId: 'closed-input' }));
  close = await runtime.close({ timeoutMs: 30_000 });
  assert.equal(close.cleanup, 'complete');
  assert.ok(close.bots.some(value => value.botId === bot.id && value.cleanup === 'complete'));
  t.diagnostic(`Controlled local Responses upstream, real Pi/OpenSandbox, output directory ${outputDir}`);
});

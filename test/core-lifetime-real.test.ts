import { runtimeSettings } from './fixtures/core-runtime-settings.js';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { test } from 'node:test';
import { admitLifetime } from './fixtures/lifetime-host-observation.js';
import { ownedContainers } from './fixtures/core-runtime-containers.js';
import { createLifetimeProbeBudget, lifetimeProbePlan, runLifetimeProbe } from './fixtures/native-lifetime-probe.js';

test('four idle native Core Agents attest actual provider lifetime and terminal deletion without model work', {
  skip: process.env.MURM_CORE_LIFETIME_REAL_TEST !== '1' && 'Set MURM_CORE_LIFETIME_REAL_TEST=1 after exact artifact review',
  timeout: 180000,
}, async () => {
  const budget = createLifetimeProbeBudget();
  const image = process.env.MURM_CORE_TEST_IMAGE;
  assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/);
  // No hosted configuration is consumed, and even accidental local model work fails.
  let requests = 0;
  const upstream = createServer((req, res) => { requests++; req.resume(); res.writeHead(503); res.end(); });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const root = resolve('experiments'); await mkdir(root, { recursive: true, mode: 0o700 });
  assert.equal(await realpath(root), root, 'experiment parent must not traverse symlinks');
  const outputDir = await mkdtemp(join(root, 'core-lifetime-')); await chmod(outputDir, 0o700);
  const lifecycle = process.env.MURM_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1';
  const apiKey = process.env.MURM_CORE_TEST_API_KEY;
  const headers = apiKey ? { 'OPEN-SANDBOX-API-KEY': apiKey } : {};
  let runtime, receiptSaved = false, probing = false;
  try {
    const { createRuntime } = await import('@luna-shi/murm');
    const { ServiceRegistry } = await import('@luna-shi/murm');

    const backend = runtimeSettings({
      sandbox: { lifecycleBaseUrl: lifecycle, apiKey,
        timeoutSeconds: lifetimeProbePlan.timeoutSeconds, resourceLimits: lifetimeProbePlan.resourceLimits, commandTimeoutMs: 30000 },
      bridge: { host: '0.0.0.0', publicUrl: process.env.MURM_CORE_TEST_BRIDGE_URL ?? 'http://172.17.0.1:{port}' },
      modelGateway: { host: '0.0.0.0', advertiseHost: process.env.MURM_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1', ...lifetimeProbePlan.modelGatewayLimits },
      models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: `http://127.0.0.1:${upstream.address().port}/v1/responses`, headers: {} } } },
      isolation: { network: 'api' },
    });
    runtime = await budget.run(async () => {
      const created = await createRuntime({ ...backend, outputDir, maxAgents: lifetimeProbePlan.agents, services: new ServiceRegistry(),
      profiles: { worker: { image, prompt: 'Wait for host input.', writable: false, model: 'default', services: {} } } });
      runtime = created;
      await writeFile(join(outputDir, 'lifetime-owner.json'), JSON.stringify({ runtimeId: created.id, plan: lifetimeProbePlan,
        state: 'created-before-spawn', elapsedMs: budget.elapsedMs() }) + '\n', { mode: 0o600, flag: 'wx' });
      if (budget.elapsedMs() >= 100000) { await created.close({ timeoutMs: Math.max(1, 160000 - budget.elapsedMs()) }); throw Error('LIFETIME_PROBE_TIMEOUT'); }
      return created;
    }, 100000);
    probing = true;
    const receipt = await runLifetimeProbe({ runtime, budget, upstreamRequests: () => requests,
      admit: agentIds => admitLifetime({ runtime, outputDir, agentIds, workMs: lifetimeProbePlan.workMs, cleanupMs: lifetimeProbePlan.cleanupMs, recoveryMs: lifetimeProbePlan.recoveryMs, marginMs: lifetimeProbePlan.marginMs,
        provider: { baseUrl: lifecycle, headers, uncertaintyMs: 1000 } }),
      verifyDeleted: async admission => {
        // Include allocations whose startup failed before admission; never infer deletion from close alone.
        const rows = (await readFile(join(outputDir, runtime.id, 'evidence.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
        const ids = [...new Set(rows.filter(row => row.type === 'spawn' && row.state === 'allocation-observed').map(row => row.sandboxId))];
        const statuses = await Promise.all(ids.map(async id => {
          const response = await fetch(`${lifecycle.replace(/\/$/, '')}/sandboxes/${encodeURIComponent(id)}`, { headers, redirect: 'error', signal: AbortSignal.timeout(5000) });
          await response.body?.cancel(); return { sandboxId: id, status: response.status };
        }));
        const containers = await ownedContainers(runtime.id, { timeoutMs: 5000 });
        return { complete: ids.length === lifetimeProbePlan.agents && statuses.every(row => row.status === 404) && containers.length === 0 &&
          (!admission || admission.resources.every(row => ids.includes(row.sandboxId))), statuses, remainingOwnedContainers: containers.length };
      } });
    receipt.elapsedMs = budget.elapsedMs();
    if (receipt.elapsedMs > 180000) receipt.status = 'failed';
    await writeFile(join(outputDir, 'lifetime-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    receiptSaved = true;
    assert.equal(receipt.status, 'passed', 'LIFETIME_NATIVE_PROBE_FAILED; retained private receipt');
  } catch {
    if (runtime && !probing) {
      try { await budget.run(() => runtime.close({ timeoutMs: Math.max(1, 160000 - budget.elapsedMs()) }), 160000); } catch { /* owner receipt remains for targeted reconciliation */ }
    }
    if (!receiptSaved) await writeFile(join(outputDir, 'lifetime-receipt.json'), JSON.stringify({
      status: 'failed', stage: 'setup', modelRequests: requests, actualHourVerified: false, businessVerified: false,
      elapsedMs: budget.elapsedMs(),
    }) + '\n', { mode: 0o600, flag: 'wx' });
    throw Error('LIFETIME_NATIVE_PROBE_FAILED; retained private receipt');
  } finally {
    // A thrown setup error before spawn has no allocated resources. Otherwise the probe already closes.
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  }
});

test('one idle Agent remains usable past the observed initial lease and exports its files', {
  skip: process.env.MURM_CORE_RENEWAL_REAL_TEST !== '1', timeout: 120_000,
}, async t => {
  const { createRuntime, ServiceRegistry } = await import('@luna-shi/murm');
  const { resolveSandboxConnection } = await import('../src/core/sandbox/sandbox-connection.js');
  const { OpenSandboxSdk } = await import('../src/core/sandbox/opensandbox-sdk.js');
  const { setTimeout: delay } = await import('node:timers/promises');
  const { rm } = await import('node:fs/promises');
  const image = process.env.MURM_CORE_TEST_IMAGE;
  assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/);
  const lifecycle = process.env.MURM_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1';
  const apiKey = process.env.MURM_CORE_TEST_API_KEY;
  const connection = resolveSandboxConnection({ lifecycleBaseUrl: lifecycle, apiKey });
  const sdk = new OpenSandboxSdk({ ...connection, useServerProxy: false, fetchImpl: fetch });
  t.after(() => sdk.close());
  const root = resolve('experiments');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const outputDir = await mkdtemp(join(root, 'core-renewal-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const host = process.env.MURM_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1';
  const settings = runtimeSettings({
    sandbox: { lifecycleBaseUrl: lifecycle, apiKey, timeoutSeconds: 60, resourceLimits: { cpu: '1', memory: '1Gi' } },
    bridge: { host: '0.0.0.0', publicUrl: `http://${host}:{port}` },
    models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: 'http://127.0.0.1:1/v1/responses', headers: {} } } },
    isolation: { network: 'api' },
  });
  const runtime = await createRuntime({ ...settings, outputDir, maxAgents: 1, services: new ServiceRegistry(),
    profiles: { worker: { image, prompt: 'Wait for host input.', writable: true, model: 'default', services: {},
      collect: { paths: ['renewal.txt'], maxBytes: 1024, includeGit: false, required: true } } } });
  try {
    const bytes = Buffer.from('available after the initial lease');
    const agent = await runtime.spawn({ requestId: 'lease', profile: 'worker',
      files: { 'renewal.txt': { encoding: 'base64', data: bytes.toString('base64') } } });
    const evidence = (await readFile(join(outputDir, runtime.id, 'evidence.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    const allocation = evidence.find(row => row.type === 'spawn' && row.state === 'allocation-observed');
    assert.ok(allocation?.sandboxId);
    const initial = Date.parse(allocation.expiresAt);
    assert.ok(initial > Date.now() && initial <= Date.now() + 61_000);
    await delay(initial + 500 - Date.now());
    const observed = await sdk.sandboxes.getSandbox(allocation.sandboxId);
    assert.ok(observed.expiresAt.getTime() > initial);
    assert.equal((await runtime.get(agent.id)).status, 'idle');
    const captured = await runtime.files.snapshot(agent.id, { requestId: 'after-initial-ttl', paths: ['renewal.txt'] });
    assert.deepEqual(Buffer.from(captured.files['renewal.txt'].data, 'base64'), bytes);
    const stopped = await runtime.stop(agent.id);
    assert.equal(stopped.cleanup, 'complete');
    assert.ok(stopped.artifacts.length);
    assert.deepEqual(await ownedContainers(runtime.id), []);
  } finally {
    assert.equal((await runtime.close()).cleanup, 'complete');
  }
});

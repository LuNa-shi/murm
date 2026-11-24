import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { test } from 'node:test';
import { admitLifetime } from './fixtures/lifetime-host-observation.js';
import { ownedContainers } from './fixtures/core-runtime-containers.js';
import { lifetimeProbePlan, runLifetimeProbe } from './fixtures/native-lifetime-probe.js';

test('four idle native Core Bots attest actual provider lifetime and terminal deletion without model work', {
  skip: process.env.SWARMENV_CORE_LIFETIME_REAL_TEST !== '1' && 'Set SWARMENV_CORE_LIFETIME_REAL_TEST=1 after exact artifact review',
  timeout: 180000,
}, async () => {
  const image = process.env.SWARMENV_CORE_TEST_IMAGE;
  assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/);
  // No hosted configuration is consumed, and even accidental local model work fails.
  let requests = 0;
  const upstream = createServer((req, res) => { requests++; req.resume(); res.writeHead(503); res.end(); });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const root = resolve('experiments'); await mkdir(root, { recursive: true, mode: 0o700 });
  assert.equal(await realpath(root), root, 'experiment parent must not traverse symlinks');
  const outputDir = await mkdtemp(join(root, 'core-lifetime-')); await chmod(outputDir, 0o700);
  const lifecycle = process.env.SWARMENV_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1';
  const apiKey = process.env.SWARMENV_CORE_TEST_API_KEY;
  const headers = apiKey ? { 'OPEN-SANDBOX-API-KEY': apiKey } : {};
  let runtime, receiptSaved = false;
  const start = performance.now();
  const bounded = async (promise, ms) => {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('LIFETIME_PROBE_TIMEOUT')), ms); })]); }
    finally { clearTimeout(timer); }
  };
  try {
    const { createRuntime } = await import('@swarmenv/core');
    const { ServiceRegistry } = await import('@swarmenv/core/services');
    const { createPiOpenSandboxBackend } = await import('@swarmenv/core/backends/pi-opensandbox');
    const backend = createPiOpenSandboxBackend({
      sandbox: { lifecycleBaseUrl: lifecycle, endpointHost: process.env.SWARMENV_CORE_TEST_ENDPOINT_HOST ?? '127.0.0.1', apiKey,
        timeoutSeconds: lifetimeProbePlan.timeoutSeconds, resourceLimits: lifetimeProbePlan.resourceLimits, commandTimeoutMs: 30000 },
      bridge: { host: '0.0.0.0', publicUrl: process.env.SWARMENV_CORE_TEST_BRIDGE_URL ?? 'http://172.17.0.1:{port}' },
      modelGateway: { host: '0.0.0.0', advertiseHost: process.env.SWARMENV_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1', requestTimeoutMs: 1000, maxOutputTokens: 1 },
      models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: `http://127.0.0.1:${upstream.address().port}/v1/responses`, headers: {} } } },
      isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 * 1024, inodes: 4096 } },
    });
    runtime = await createRuntime({ backend, outputDir, maxBots: lifetimeProbePlan.bots, services: new ServiceRegistry(),
      profiles: { worker: { image, prompt: 'Wait for host input.', model: 'default', services: {} } } });
    const receipt = await runLifetimeProbe({ runtime, bounded, upstreamRequests: () => requests,
      admit: botIds => admitLifetime({ runtime, outputDir, botIds, workMs: lifetimeProbePlan.workMs, cleanupMs: lifetimeProbePlan.cleanupMs, recoveryMs: lifetimeProbePlan.recoveryMs, marginMs: lifetimeProbePlan.marginMs,
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
        return { complete: ids.length === lifetimeProbePlan.bots && statuses.every(row => row.status === 404) && containers.length === 0 &&
          (!admission || admission.resources.every(row => ids.includes(row.sandboxId))), statuses, remainingOwnedContainers: containers.length };
      } });
    receipt.elapsedMs = performance.now() - start;
    if (receipt.elapsedMs > 180000) receipt.status = 'failed';
    await writeFile(join(outputDir, 'lifetime-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    receiptSaved = true;
    assert.equal(receipt.status, 'passed', 'LIFETIME_NATIVE_PROBE_FAILED; retained private receipt');
  } catch {
    if (!receiptSaved) await writeFile(join(outputDir, 'lifetime-receipt.json'), JSON.stringify({
      status: 'failed', stage: 'setup', modelRequests: requests, actualHourVerified: false, businessVerified: false,
      elapsedMs: performance.now() - start,
    }) + '\n', { mode: 0o600, flag: 'wx' });
    throw Error('LIFETIME_NATIVE_PROBE_FAILED; retained private receipt');
  } finally {
    // A thrown setup error before spawn has no allocated resources. Otherwise the probe already closes.
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  }
});

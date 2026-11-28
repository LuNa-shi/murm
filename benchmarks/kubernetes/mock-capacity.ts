import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ConnectionConfig, SandboxApiException, SandboxManager } from '@alibaba-group/opensandbox';
import { createRuntime, createSandbox, ServiceRegistry } from '@luna-shi/murm';
import { createMockSandboxProvider } from './mock-provider.js';
import { checkLedger } from './check-ledger.js';

export interface MockCapacityOptions {
  tier: number;
  outputDirectory: string;
  waves?: number;
  rounds?: number;
  concurrency?: number;
  maxDurationMs?: number;
}

async function mapBounded<T>(items: T[], concurrency: number, action: (item: T, index: number) => Promise<void>) {
  let next = 0;
  const results = await Promise.allSettled(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) { const index = next++; await action(items[index], index); }
  }));
  const failed = results.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}

function mockLimits(options: MockCapacityOptions) {
  const { tier, outputDirectory } = options;
  assert.ok([32, 128, 1024].includes(tier), 'Mock API tiers are 32, 128 and 1024');
  assert.ok(typeof outputDirectory === 'string' && outputDirectory.trim());
  const waves = options.waves ?? (tier === 32 ? 3 : 1);
  const rounds = options.rounds ?? 2;
  const concurrency = options.concurrency ?? 16;
  const maxDurationMs = options.maxDurationMs ?? 600_000;
  for (const value of [waves, rounds, concurrency, maxDurationMs]) assert.ok(Number.isSafeInteger(value) && value > 0);
  assert.ok(waves <= 3 && rounds <= 100 && concurrency <= 32 && maxDurationMs <= 1_800_000, 'Mock test exceeds its local bounds');
  return { tier, outputDirectory, waves, rounds, concurrency, maxDurationMs };
}

export function mockCapacityPlan(manifest: any) {
  assert.equal(manifest.workloadMode, 'mock-api', 'Tiers of 32 and above require workloadMode mock-api');
  assert.equal(manifest.schemaVersion, 1);
  const limits = mockLimits(manifest);
  return { schemaVersion: 1, status: 'not-run', workloadMode: 'mock-api', ...limits, modelRequests: 0, capacityClaim: false,
    manifestSha256: createHash('sha256').update(JSON.stringify(manifest)).digest('hex') };
}

/** Production Runtime and SDK paths talk only to a loopback simulated provider. */
export async function runMockCapacity(options: MockCapacityOptions) {
  const { tier, outputDirectory, waves, rounds, concurrency, maxDurationMs } = mockLimits(options);
  const directory = resolve(outputDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, 'mock-manifest.json'), JSON.stringify(options, null, 2), { mode: 0o600, flag: 'wx' });
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const callbackPort = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const provider = await createMockSandboxProvider();
  const connection = new ConnectionConfig({ domain: provider.url, apiKey: provider.apiKey, disableMetrics: true,
    requestTimeoutSeconds: 5, wakeRetryEnabled: false }).withTransportIfMissing();
  const lifecycle = SandboxManager.create({ connectionConfig: connection });
  const started = performance.now();
  const controlLatency: number[] = [];
  const eventLatency: number[] = [];
  const report = { schemaVersion: 1, status: 'failed-mock-api', topology: 'loopback-http-simulation', tier,
    manifestSha256: createHash('sha256').update(JSON.stringify(options)).digest('hex'),
    executableSha256: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),
    fixtureSha256: createHash('sha256').update(await readFile(new URL('./mock-provider.js', import.meta.url))).digest('hex'),
    error: undefined as { code: string; message: string } | undefined,
    capacityClaim: false, modelRequests: 0, pending: 0, remainingResources: 0, inputs: 0, elapsedMs: 0,
    waves: [] as { allocations: number; cleanup: string; ledger: ReturnType<typeof checkLedger> }[],
    metrics: {} as Record<string, unknown>, limits: { maxDurationMs, concurrency, waves, rounds },
    limitations: ['External Lifecycle, Execd and Agent APIs are simulated.', 'No VM, Pod, CNI, kernel isolation or real executor capacity is measured.'] };
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
  const checkDeadline = () => assert.ok(performance.now() - started < maxDurationMs, 'Mock run exceeded its deadline');
  try {
    for (let wave = 0; wave < waves; wave++) {
      checkDeadline();
      const baseline = provider.counts().allocations;
      runtime = await createRuntime({ executor: 'pi', sandbox: createSandbox({ endpoint: provider.url, apiKey: provider.apiKey, egressMode: 'dns+nft', timeoutSeconds: 600 }),
        maxAgents: tier, outputDir: directory, services: new ServiceRegistry(),
        persistence: { deploymentId: 'loopback-mock-api', contract: 'mock-capacity-v1' },
        operationLimits: { prepare: concurrency, stop: concurrency, transfer: concurrency, queued: tier + 32, waitMs: 60_000 },
        connection: { bindHost: '127.0.0.1', bindPort: callbackPort, publicUrl: `http://192.0.2.1:${callbackPort}` },
        models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: 'http://127.0.0.1:1/v1/responses', headers: {} } } },
        profiles: { probe: { image: 'mock-api-worker', model: 'default', prompt: 'Simulated API input', writable: true, services: {},
          collect: { paths: ['proof.txt'], maxBytes: 4096, includeGit: false, required: true } } } });
      const current = runtime;
      const agents: Awaited<ReturnType<typeof current.spawn>>[] = new Array(tier);
      await mapBounded(Array.from({ length: tier }), concurrency, async (_unused, index) => {
        checkDeadline(); agents[index] = await current.spawn({ profile: 'probe', requestId: `spawn-${index}` });
      });
      assert.equal(provider.counts().allocations - baseline, tier);
      await assert.rejects(current.spawn({ profile: 'probe', requestId: 'over-capacity' }), { code: 'CONFLICT' });
      for (let round = 0; round < rounds; round++) {
        await mapBounded(agents, concurrency, async (agent, slot) => {
          checkDeadline();
          const at = performance.now();
          const receipt = await current.send(agent.id, `mock-${wave}-${slot}-${round}`, { requestId: `input-${slot}-${round}`, mode: round % 2 ? 'followUp' : 'steer' });
          assert.equal(receipt.status, 'accepted'); controlLatency.push(performance.now() - at);
          const replay = await current.send(agent.id, `mock-${wave}-${slot}-${round}`, { requestId: `input-${slot}-${round}`, mode: round % 2 ? 'followUp' : 'steer' });
          assert.equal(replay.inputId, receipt.inputId);
          const probe = await current.probeWorkerEvent(agent.id, { requestId: `probe-${slot}-${round}`, timeoutMs: 10_000 });
          eventLatency.push(probe.elapsedMs);
        });
      }
      // A management deletion outage keeps stopped executions and slots pending.
      provider.blockDeletion(true);
      const failedStop = await current.stop(agents[0].id, { timeoutMs: 2000 });
      assert.equal(failedStop.execution, 'stopped'); assert.equal(failedStop.cleanup, 'pending');
      await assert.rejects(current.spawn({ profile: 'probe', requestId: 'pending-capacity' }), { code: 'CONFLICT' });
      assert.equal(provider.counts().remainingResources, tier);
      provider.blockDeletion(false);
      await mapBounded(agents, concurrency, async (agent, slot) => {
        const stopped = await current.stop(agent.id, { timeoutMs: 30_000 });
        assert.equal(stopped.cleanup, 'complete');
        const files = stopped.artifacts.find(path => path.endsWith('/artifacts/files'));
        assert.ok(files);
        const expected = createHash('sha256').update(`mock-${wave}-${slot}-${rounds - 1}`).digest('hex');
        assert.equal(await readFile(join(files, 'proof.txt'), 'utf8'), `MOCK_API_OK ${expected}`);
      });
      const closed = await current.close({ timeoutMs: 30_000 });
      assert.equal(closed.cleanup, 'complete');
      report.pending += closed.pending.length;
      const ledger = checkLedger(join(directory, current.id), current.id, tier);
      assert.equal(ledger.complete, true); assert.equal(provider.counts().remainingResources, 0);
      const listed = await lifecycle.listSandboxInfos({ page: 1, pageSize: 100 });
      assert.equal(listed.items.length, 0);
      await mapBounded(ledger.sandboxIds, concurrency, async sandboxId => {
        await assert.rejects(lifecycle.getSandboxInfo(sandboxId), (error: unknown) =>
          error instanceof SandboxApiException && error.statusCode === 404);
      });
      report.waves.push({ allocations: tier, cleanup: closed.cleanup, ledger });
      runtime = undefined;
    }
    report.status = 'passed-mock-api';
  } catch (error) {
    report.error = { code: (error as { code?: string }).code ?? 'MOCK_API_FAILED', message: (error as Error).message };
    throw error;
  } finally {
    provider.blockDeletion(false);
    if (runtime) {
      try {
        const cleanup = await runtime.close({ timeoutMs: 30_000 });
        report.pending += cleanup.pending.length;
      } catch (error) {
        report.status = 'failed-mock-api';
        report.error ??= { code: 'MOCK_CLEANUP_UNKNOWN', message: (error as Error).message };
      }
    }
    const counts = provider.counts();
    Object.assign(report, { remainingResources: counts.remainingResources, inputs: counts.inputs, elapsedMs: performance.now() - started });
    const quantiles = (values: number[]) => {
      const ordered = [...values].sort((left, right) => left - right);
      return { samples: ordered.length, p50: ordered[Math.ceil(ordered.length * .5) - 1] ?? null,
        p95: ordered[Math.ceil(ordered.length * .95) - 1] ?? null, p99: ordered[Math.ceil(ordered.length * .99) - 1] ?? null };
    };
    report.metrics = { controlMs: quantiles(controlLatency), eventMs: quantiles(eventLatency), requests: counts.requests,
      rssBytes: process.memoryUsage().rss, eventWaitersAfterCleanup: counts.eventWaiters };
    await lifecycle.close();
    await connection.closeTransport();
    await provider.close();
    await writeFile(join(directory, 'mock-result.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  }
  return report;
}

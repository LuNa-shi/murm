import { runtimeSettings } from './fixtures/core-runtime-settings.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLifetimeProbeBudget, lifetimeProbePlan, runLifetimeProbe } from './fixtures/native-lifetime-probe.js';

for (const failure of ['none', 'spawn', 'admission', 'cleanup', 'deletion', 'upstream', 'requested', 'expiry', 'deadline']) {
  test(`lifetime preparation preserves zero-input and cleanup contract: ${failure}`, async () => {
    let spawned = 0, closed = 0, verified = 0;
    const runtime = {
      async spawn(options) { assert.deepEqual(Object.keys(options).sort(), ['profile', 'requestId']); const id = String(++spawned); if (failure === 'spawn') throw Error(); return { id, status: 'idle' }; },
      async close() { closed++; return { cleanup: failure === 'cleanup' ? 'pending' : 'complete', agents: Array.from({ length: 4 }, () => ({ execution: 'stopped', cleanup: 'complete' })) }; },
      send() { assert.fail('probe must never send'); },
    };
    const result = await runLifetimeProbe({ runtime, budget: { run: factory => factory(), elapsedMs: () => 0 },
      admit: async ids => { assert.equal(ids.length, 4); if (failure === 'admission') throw Error(); return { observedAtMs: 0, workDeadlineAtMs: 3600000, stopAtMs: failure === 'deadline' ? 3599999 : 3600000, resources: ids.map(id => ({ id, requestedSeconds: failure === 'requested' ? 3600 : 5100, expiresAtMs: failure === 'expiry' ? 4199999 : 4200000 })) }; },
      verifyDeleted: async () => { verified++; return { complete: failure !== 'deletion' }; },
      upstreamRequests: () => failure === 'upstream' ? 1 : 0 });
    assert.equal(spawned, 4); assert.equal(closed, 1); assert.equal(verified, 1);
    assert.equal(result.status, failure === 'none' ? 'passed' : 'failed');
    assert.equal(result.actualHourVerified, false); assert.equal(result.businessVerified, false);
  });
}


test('native lifetime gateway limits start production Core without allocating or requesting a model', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createRuntime } = await import('@luna-shi/murm');
  const { ServiceRegistry } = await import('@luna-shi/murm');

  const root = await mkdtemp(join(tmpdir(), 'lifetime-config-'));
  let runtime;
  t.after(async () => { try { if (runtime) await runtime.close({ timeoutMs: 1000 }); } finally { await rm(root, { recursive: true, force: true }); } });
  runtime = await createRuntime({ outputDir: root, services: new ServiceRegistry(), maxAgents: lifetimeProbePlan.agents,
    profiles: { worker: { image: 'fixture', prompt: 'Wait.', writable: false, model: 'default', services: {} } },
    ...runtimeSettings({
      sandbox: { lifecycleBaseUrl: 'http://127.0.0.1:1/v1', timeoutSeconds: lifetimeProbePlan.timeoutSeconds, resourceLimits: lifetimeProbePlan.resourceLimits },
      bridge: { host: '127.0.0.1', publicUrl: 'http://172.17.0.1:{port}' },
      modelGateway: { host: '127.0.0.1', advertiseHost: '172.17.0.1', ...lifetimeProbePlan.modelGatewayLimits },
      models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: 'http://127.0.0.1:1/v1/responses', headers: {} } } },
      isolation: { network: 'local-docker', disk: { bytes: 67108864, inodes: 4096 } },
    }),
  });
  const close = await runtime.close({ timeoutMs: 1000 });
  assert.equal(close.cleanup, 'complete');
  assert.deepEqual(close.agents, []);
});


test('slow Runtime assembly exhausts shared startup phase before any Agent allocation', async () => {
  let time = 0, spawned = 0, closed = 0;
  const budget = createLifetimeProbeBudget({ now: () => time });
  await budget.run(async () => { time = 100001; }, 100000);
  const result = await runLifetimeProbe({ budget, runtime: {
    spawn() { spawned++; throw Error('must not allocate'); },
    async close() { closed++; return { cleanup: 'complete', agents: [] }; },
  }, admit() { assert.fail('no admission'); }, verifyDeleted: async () => ({ complete: true }), upstreamRequests: () => 0 });
  assert.equal(spawned, 0); assert.equal(closed, 1); assert.equal(result.status, 'failed');
});

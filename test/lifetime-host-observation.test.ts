import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLifecycleProvider } from './fixtures/core-lifecycle-provider.js';
import { admitLifetime } from './fixtures/lifetime-host-observation.js';
async function fixture(t, modify = value => value) {
  const gets = [];
  let runtime;
  t.after(async () => { await runtime?.close(); });
  const provider = await createLifecycleProvider(t, { createExpiresAt: () => new Date(Date.now() + 5100000).toISOString(),
    onGet(id, resource, response) { gets.push(id); return modify({ id, status: { state: 'Running' }, metadata: resource.labels, expiresAt: new Date(Date.now() + 5000000).toISOString() }, response); } });
  provider.allowDeletion();
  const { createRuntime } = await import('@murm/core');
  const { createPiOpenSandboxBackend } = await import('@murm/core/backends/pi-opensandbox');
  const { ServiceRegistry } = await import('@murm/core/services');
  const outputDir = await mkdtemp(join(tmpdir(), 'lifetime-observation-'));
  runtime = await createRuntime({ backend: createPiOpenSandboxBackend({
    sandbox: { lifecycleBaseUrl: provider.url, timeoutSeconds: 5100 }, bridge: { host: '127.0.0.1', publicUrl: 'http://192.0.2.1:{port}' },
    modelGateway: { host: '127.0.0.1', advertiseHost: '192.0.2.1' },
    models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: 'http://127.0.0.1:1/v1/responses', headers: {} } } },
    isolation: { network: 'local-docker', disk: { bytes: 32 * 1024 ** 2, inodes: 2048 } },
  }), profiles: { peer: { image: 'fixture', model: 'default', prompt: 'fixed', writable: false, services: {} } }, services: new ServiceRegistry(), maxAgents: 4, outputDir });
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const agents = []; for (let i = 0; i < 4; i++) agents.push(await runtime.spawn({ profile: 'peer', requestId: `spawn-${i}` }));
  const options = { runtime, outputDir, agentIds: agents.map(agent => agent.id), workMs: 3600000, cleanupMs: 180000, recoveryMs: 300000, marginMs: 120000,
    observationTimeoutMs: 2000, maxObservationAgeMs: 1000, provider: { baseUrl: provider.url, uncertaintyMs: 1000 } };
  return { options, gets, runtime };
}
test('four actual Core resources receive conservative host lifetime admission from targeted provider reads', async t => {
  const f = await fixture(t);
  const startedAtMs = performance.now();
  const receipt = await admitLifetime(f.options);
  assert.equal(receipt.runtimeId, f.runtime.id);
  assert.equal(receipt.resources.length, 4);
  assert.deepEqual(new Set(f.gets), new Set(['fixture-1', 'fixture-2', 'fixture-3', 'fixture-4']));
  assert.equal(receipt.workDeadlineAtMs - receipt.observedAtMs, 3600000);
  assert.ok(receipt.workDeadlineAtMs <= receipt.stopAtMs);
  assert.ok(receipt.resources.every(row => row.expiresAtMs > receipt.stopAtMs && row.requestedSeconds === 5100));
  assert.deepEqual(receipt.resources.map(row => row.requestId), ['spawn-0', 'spawn-1', 'spawn-2', 'spawn-3']);
  assert.ok(receipt.resources.every(row => row.source === 'host' && row.allocationSeq < row.readySeq && row.uncertaintyMs === 2000));
  assert.ok(receipt.resources.every(row => row.expiresAtMs - startedAtMs > 4990000 && row.expiresAtMs - startedAtMs <= 5000000));
});

for (const [name, modify, code] of [
  ['missing expiry', value => ({ ...value, expiresAt: undefined }), 'LIFETIME_EXPIRY_UNKNOWN'],
  ['invalid calendar', value => ({ ...value, expiresAt: '2099-02-30T00:00:00Z' }), 'LIFETIME_EXPIRY_UNKNOWN'],
  ['shorter actual expiry', value => ({ ...value, expiresAt: new Date(Date.now() + 3600000).toISOString() }), 'LIFETIME_TOO_SHORT'],
  ['foreign identity', value => ({ ...value, id: 'other' }), 'LIFETIME_RESOURCE_MISMATCH'],
  ['foreign owner', value => ({ ...value, metadata: { ...value.metadata, agent_key: 'other' } }), 'LIFETIME_RESOURCE_MISMATCH'],
  ['not running', value => ({ ...value, status: { state: 'Stopped' } }), 'LIFETIME_RESOURCE_MISMATCH'],
  ['missing server clock', (value, response) => { response.sendDate = false; return value; }, 'LIFETIME_CLOCK_UNVERIFIED'],
  ['stale server clock', (value, response) => { response.setHeader('date', 'Mon, 01 Jan 2001 00:00:00 GMT'); return value; }, 'LIFETIME_CLOCK_UNVERIFIED'],
  ['oversized provider body', value => ({ ...value, extra: 'x'.repeat(65536) }), 'LIFETIME_PROVIDER_INVALID'],
]) test(`${name} rejects lifetime admission`, async t => {
  const f = await fixture(t, modify);
  await assert.rejects(admitLifetime(f.options), { code });
});

test('corrupt Core evidence is rejected before any provider lookup', async t => {
  const f = await fixture(t);
  await new Promise(resolve => setTimeout(resolve, 20));
  const path = join(f.options.outputDir, f.runtime.id, 'evidence.jsonl');
  const original = await readFile(path, 'utf8');
  await writeFile(path, original.replace('allocation-observed', 'untrusted-observation'));
  await assert.rejects(admitLifetime(f.options), { code: 'LIFETIME_EVIDENCE_INVALID' });
  assert.deepEqual(f.gets, []);
});

test('an unavailable Core Agent rejects before provider lookup', async t => {
  const f = await fixture(t);
  await f.runtime.stop(f.options.agentIds[0]);
  await assert.rejects(admitLifetime(f.options), { code: 'LIFETIME_AGENT_UNAVAILABLE' });
  assert.deepEqual(f.gets, []);
});

test('a slow provider is cancelled within the observation budget', async t => {
  const f = await fixture(t, async value => { await new Promise(resolve => setTimeout(resolve, 100)); return value; });
  await assert.rejects(admitLifetime({ ...f.options, observationTimeoutMs: 20 }), { code: 'LIFETIME_OBSERVATION_ABORTED' });
});

test('explicit cancellation prevents resource admission', async t => {
  const f = await fixture(t); const controller = new AbortController(); controller.abort();
  await assert.rejects(admitLifetime({ ...f.options, signal: controller.signal }), { code: 'LIFETIME_OBSERVATION_ABORTED' });
  assert.deepEqual(f.gets, []);
});

test('an early resource observation cannot become stale while another query finishes', async t => {
  const f = await fixture(t, async value => {
    if (value.id === 'fixture-4') await new Promise(resolve => setTimeout(resolve, 50));
    return value;
  });
  await assert.rejects(admitLifetime({ ...f.options, maxObservationAgeMs: 10 }), { code: 'LIFETIME_OBSERVATION_STALE' });
});

test('Core close during provider observation prevents admission after otherwise valid reads', async t => {
  let stop;
  const f = await fixture(t, async value => {
    if (value.id === 'fixture-1') await stop();
    return value;
  });
  stop = () => f.runtime.stop(f.options.agentIds[0]);
  await assert.rejects(admitLifetime(f.options), { code: 'LIFETIME_AGENT_UNAVAILABLE' });
});

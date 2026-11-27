import { runtimeSettings } from './fixtures/core-runtime-settings.js';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLifecycleProvider } from './fixtures/core-lifecycle-provider.js';

// The infrastructure port is loopback-only. Core, the Pi backend, allocation
// ownership, closing gates and report persistence remain production modules.
test('Core close stops a ready sibling while a late allocation keeps its original Slot', { timeout: 8000 }, async t => {
  let entered, release;
  const allocating = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const starts = [];
  const provider = await createLifecycleProvider(t, {
    async onCreate(id) { if (id === 'fixture-2') { entered(); await gate; } },
    onStart(body) { starts.push(body); },
  });
  const { createRuntime } = await import('@luna-shi/murm');
  const { ServiceRegistry } = await import('@luna-shi/murm');

  const outputDir = await mkdtemp(join(tmpdir(), 'core-startup-slots-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const runtime = await createRuntime({ ...runtimeSettings({
    sandbox: { lifecycleBaseUrl: provider.url }, bridge: { host: '127.0.0.1', publicUrl: 'http://192.0.2.1:{port}' },
    modelGateway: { host: '127.0.0.1', advertiseHost: '192.0.2.1' },
    models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: 'http://127.0.0.1:1/v1/responses', headers: {} } } },
    isolation: { network: 'local-docker', disk: { bytes: 32 * 1024 ** 2, inodes: 2048 } },
  }), profiles: { worker: { image: 'fixture-image', model: 'default', prompt: 'Controlled startup', writable: false, services: {} } },
  services: new ServiceRegistry(), maxAgents: 2, outputDir });
  t.after(async () => { release(); provider.allowDeletion(); await runtime.close(); });
  const ready = await runtime.spawn({ requestId: 'ready-sibling', profile: 'worker' });
  const spawning = runtime.spawn({ requestId: 'held-allocation', profile: 'worker' }).catch(error => error);
  await allocating;
  const input = await runtime.send(ready.id, 'Controlled input', { requestId: 'sibling-input' });
  assert.equal(input.status, 'accepted');
  await assert.rejects(runtime.spawn({ requestId: 'third', profile: 'worker' }), { code: 'CONFLICT' });
  const closing = await runtime.close({ timeoutMs: 20 });
  assert.equal(closing.cleanup, 'pending');
  const pending = closing.agents.find(row => row.agentId !== ready.id);
  assert.ok(pending);
  assert.equal((await runtime.get(pending.agentId)).status, 'closing');
  await assert.rejects(runtime.spawn({ requestId: 'after-close', profile: 'worker' }), { code: 'NOT_ALLOWED' });
  assert.equal(provider.allocations(), 2);
  provider.allowDeletion();
  const sibling = await runtime.stop(ready.id);
  assert.equal(sibling.execution, 'stopped');
  assert.equal(sibling.cleanup, 'complete');
  assert.equal((await runtime.get(pending.agentId)).status, 'closing');
  release();
  const failure = await spawning;
  assert.equal(failure.agentId, pending.agentId);
  assert.equal(failure.operation, 'spawn');
  const replay = await runtime.spawn({ requestId: 'held-allocation', profile: 'worker' }).catch(error => error);
  assert.equal(replay.agentId, pending.agentId);
  const closed = await runtime.close();
  assert.equal(closed.cleanup, 'complete');
  assert.equal(closed.agents.length, 2);
  assert.ok(closed.agents.every(row => row.execution === 'stopped' && row.cleanup === 'complete'));
  assert.equal(starts.length, 1, 'late allocation cannot start a Worker after closure');
  assert.equal(provider.allocations(), 2, 'same request never creates a successor');
  const saved = JSON.parse(await readFile(closed.reportPath, 'utf8'));
  assert.equal(saved.status, 'closed');
  assert.deepEqual(saved.agents, closed.agents);
});

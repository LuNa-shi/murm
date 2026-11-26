import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLifecycleProvider } from './fixtures/core-lifecycle-provider.js';

async function wait(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Fixture observation timed out')), 1000); })]); }
  finally { clearTimeout(timer); }
}

test('running, unexpectedly exited and pending cleanup Agents retain capacity until confirmed closed', { timeout: 8000 }, async t => {
  const provider = await createLifecycleProvider(t);
  const { createRuntime } = await import('@murm/core');
  const { ServiceRegistry } = await import('@murm/core/services');
  const { createPiOpenSandboxBackend } = await import('@murm/core/backends/pi-opensandbox');
  const outputDir = await mkdtemp(join(tmpdir(), 'core-capacity-fixture-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const runtime = await createRuntime({ backend: createPiOpenSandboxBackend({
    sandbox: { lifecycleBaseUrl: provider.url }, bridge: { host: '127.0.0.1', publicUrl: 'http://192.0.2.1:{port}' },
    modelGateway: { host: '127.0.0.1', advertiseHost: '192.0.2.1' },
    models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: 'http://127.0.0.1:1/v1/responses', headers: {} } } },
    isolation: { network: 'local-docker', disk: { bytes: 32 * 1024 ** 2, inodes: 2048 } },
  }), profiles: { worker: { image: 'fixture-image', model: 'default', prompt: 'fixture', writable: true, services: {} } },
  services: new ServiceRegistry(), maxAgents: 1, outputDir });
  try {
  const agent = await runtime.spawn({ requestId: 'first', profile: 'worker' });
  async function full(status) {
    assert.equal((await runtime.get(agent.id)).status, status);
    await assert.rejects(runtime.spawn({ requestId: `capacity-${status}`, profile: 'worker' }), { code: 'CONFLICT' });
    assert.equal(provider.allocations(), 1);
  }
  await full('idle');
  assert.equal((await runtime.send(agent.id, 'held work', { requestId: 'work' })).status, 'accepted');
  await full('running');
  let resolveExit;
  const exited = new Promise(resolve => { resolveExit = resolve; });
  const unsubscribe = runtime.onEvent(event => { if (event.agentId === agent.id && event.type === 'exit') resolveExit(event); });
  t.after(unsubscribe);
  provider.unexpectedExit();
  assert.equal((await wait(exited)).expected, false);
  await full('exited');
  const stopping = runtime.stop(agent.id, { timeoutMs: 10 });
  await wait(provider.deletionStarted);
  const pending = await stopping;
  assert.equal(pending.cleanup, 'pending');
  await full('closing');
  provider.releaseDeletion();
  const failed = await runtime.stop(agent.id);
  assert.equal(failed.cleanup, 'pending');
  assert.equal(failed.execution, 'stopped');
  await full('closing');
  provider.allowDeletion();
  assert.equal((await runtime.stop(agent.id)).cleanup, 'complete');
  assert.equal((await runtime.get(agent.id)).status, 'closed');
  const replacement = await runtime.spawn({ requestId: 'replacement', profile: 'worker' });
  assert.equal(replacement.status, 'idle');
  assert.notEqual(replacement.id, agent.id);
  assert.equal(provider.allocations(), 2);
  } finally { provider.allowDeletion(); await runtime.close(); }
});

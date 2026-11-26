import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { provider } from './fixtures/core-pi-transport.js';

const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/src/core/opensandbox-backend.js') &&
      /\/runtime\/(opensandbox-manager|docker-agent-network|docker-agent-disk)\.js$/.test(specifier)) {
    return { url: new URL('./fixtures/core-pi-transport.js', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
} });
const { createRuntime } = await import('@murm/core');
const { createOpenSandboxBackend } = await import('@murm/core/backends/opensandbox');
const { ServiceRegistry } = await import('@murm/core/services');
hooks.deregister();

test('Codex uses an Agent gateway token and retains one executor across inputs while rejecting unsupported steering before dispatch', async t => {
  provider.reset();
  const outputDir = await mkdtemp(join(tmpdir(), 'core-codex-input-'));
  const runtime = await createRuntime({
    backend: createOpenSandboxBackend({
      executor: 'codex',
      sandbox: { lifecycleBaseUrl: 'http://127.0.0.1:1/v1' },
      bridge: { host: '127.0.0.1', publicUrl: 'http://172.17.0.1:{port}' },
      modelGateway: { host: '127.0.0.1', advertiseHost: '172.17.0.1', maxOutputTokens: null },
      models: { default: { provider: 'openai', model: 'explicit-codex-model', upstream: { url: 'http://127.0.0.1:1/v1/responses', headers: { authorization: 'Bearer host-only-secret' } } } },
      isolation: { network: 'local-docker', disk: { bytes: 32 * 1024 ** 2, inodes: 2048 } },
    }),
    profiles: { worker: { model: 'default', image: 'codex-test', writable: true, services: {} } },
    services: new ServiceRegistry(), maxAgents: 1, outputDir,
  });
  t.after(async () => { await runtime.close(); await rm(outputDir, { recursive: true, force: true }); });
  const agent = await runtime.spawn({ profile: 'worker', requestId: 'spawn' });
  const startup = provider.starts.get(agent.id);
  assert.equal(startup.command, 'codex');
  assert.deepEqual(startup.args, []);
  assert.equal(startup.codex.model, 'explicit-codex-model');
  assert.equal(startup.codex.version, '0.172.0');
  assert.match(startup.codex.baseUrl, /^http:\/\/172\.17\.0\.1:\d+\/v1$/);
  assert.ok(startup.secretEnvironment.OPENAI_API_KEY);
  assert.equal(JSON.stringify(startup).includes('host-only-secret'), false);
  assert.equal(startup.modelCatalogResource, undefined);
  const before = provider.messages.length;
  await assert.rejects(runtime.send(agent.id, 'unsupported', { requestId: 'rejected', steeringMode: 'one-at-a-time' }), { code: 'NOT_ALLOWED' });
  assert.equal(provider.messages.length, before);
  provider.wait = async message => {
    provider.responses.set(message.id, { response: { id: message.id, command: 'prompt', success: true, data: { disposition: 'started' } }, records: [] });
  };
  const first = await runtime.send(agent.id, 'first', { requestId: 'one' });
  assert.equal(first.status, 'accepted');
  assert.deepEqual(await runtime.send(agent.id, 'first', { requestId: 'one' }), first);
  await assert.rejects(runtime.send(agent.id, 'changed', { requestId: 'one' }), { code: 'CONFLICT' });
  assert.equal((await runtime.send(agent.id, 'second', { requestId: 'two' })).status, 'accepted');
  assert.equal(provider.starts.size, 1);
  assert.equal(provider.messages.filter(message => message.type === 'prompt').length, 2);
  assert.equal((await runtime.close()).cleanup, 'complete');
});

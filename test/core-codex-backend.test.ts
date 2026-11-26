import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntime } from '@murm/core';
import { createCodexOpenSandboxBackend } from '@murm/core/backends/codex-opensandbox';
import { ServiceRegistry } from '@murm/core/services';

const configuration = {
  sandbox: { lifecycleBaseUrl: 'http://127.0.0.1:1/v1' },
  bridge: { host: '127.0.0.1', publicUrl: 'http://172.17.0.1:{port}' },
  modelGateway: { host: '127.0.0.1', advertiseHost: '172.17.0.1', maxOutputTokens: null },
  models: { default: { provider: 'openai', model: 'configured-codex-model', upstream: { url: 'http://127.0.0.1:1/v1/responses', headers: {} } } },
  isolation: { network: 'local-docker', disk: { bytes: 32 * 1024 ** 2, inodes: 2048 } },
};

test('Codex Runtime accepts an explicitly configured model and rejects Context Fork before Slot allocation', async t => {
  const outputDir = await mkdtemp(join(tmpdir(), 'core-codex-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const runtime = await createRuntime({
    backend: createCodexOpenSandboxBackend(configuration),
    profiles: { worker: { model: 'default', image: 'codex-test', writable: true, services: {} } },
    services: new ServiceRegistry(), maxAgents: 1, outputDir,
  });
  t.after(() => runtime.close());
  await assert.rejects(runtime.spawn({ profile: 'worker', requestId: 'fork', forkFrom: 'absent' }), { code: 'NOT_ALLOWED' });
  await assert.rejects(runtime.spawn({ profile: 'worker', requestId: 'override', secretEnv: { CODEX_HOME: '/foreign-session' } }), { code: 'INVALID_CONTRACT' });
  assert.deepEqual(await runtime.list(), []);
  const report = JSON.parse(await readFile(join(outputDir, runtime.id, 'runtime.json'), 'utf8'));
  assert.equal(report.config.backend.type, 'codex-opensandbox');
  assert.equal(report.config.backend.codexVersion, '0.172.0');
  assert.equal(report.config.backend.capabilities.contextFork, false);
  assert.equal((await runtime.close()).cleanup, 'complete');
});

test('Codex rejects executor configuration through ordinary Profile environment before opening a listener', async () => {
  for (const key of ['CODEX_HOME', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'OPENAI_BASE_URL', 'OPENAI_API_KEY']) {
    await assert.rejects(createRuntime({
      backend: createCodexOpenSandboxBackend(configuration),
      profiles: { worker: { model: 'default', image: 'codex-test', writable: true, services: {}, env: { [key]: 'override' } } },
      services: new ServiceRegistry(), maxAgents: 1, outputDir: '/unallocated-codex-runtime',
    }), { code: 'INVALID_CONTRACT', cleanup: 'complete' });
  }
});


test('Codex rejects a Profile granting unsupported Context Fork before assembly', async () => {
  await assert.rejects(createRuntime({
    backend: createCodexOpenSandboxBackend(configuration),
    profiles: { worker: { model: 'default', image: 'codex-test', writable: true, services: {}, allowContextFork: true } },
    services: new ServiceRegistry(), maxAgents: 1, outputDir: '/unallocated-codex-runtime',
  }), { code: 'INVALID_CONTRACT', cleanup: 'complete' });
});

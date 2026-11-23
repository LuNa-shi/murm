import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntime } from '@swarmenv/core';
import { createPiOpenSandboxBackend } from '@swarmenv/core/backends/pi-opensandbox';
import { ServiceRegistry } from '@swarmenv/core/services';

function options(outputDir) {
  return {
    backend: createPiOpenSandboxBackend({
      sandbox: { lifecycleBaseUrl: 'http://127.0.0.1:1/v1' },
      bridge: { host: '127.0.0.1', publicUrl: 'http://172.17.0.1:{port}' },
      modelGateway: { host: '127.0.0.1', advertiseHost: '172.17.0.1' },
      models: {
        default: {
          provider: 'kimi_proxy',
          model: 'k3',
          upstream: { url: 'http://127.0.0.1:1/v1/responses', headers: {} },
        },
      },
      isolation: {
        network: 'local-docker',
        disk: { bytes: 32 * 1024 ** 2, inodes: 2048 },
      },
    }),
    profiles: {
      writer: {
        prompt: 'Write a file when instructed.',
        model: 'missing-model',
        image: 'swarmenv-agent:core-test',
        writable: true,
        services: {},
      },
    },
    services: new ServiceRegistry(),
    maxBots: 1,
    outputDir,
  };
}

test('Runtime rejects an unknown Profile model before creating a Bot', async t => {
  const outputDir = await mkdtemp(join(tmpdir(), 'swarmenv-core-test-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));

  await assert.rejects(createRuntime(options(outputDir)), error => {
    assert.equal(error.code, 'INVALID_CONTRACT');
    assert.equal(error.operation, 'createRuntime');
    assert.match(error.runtimeId, /^[a-f0-9-]{36}$/);
    assert.equal(error.cleanup, 'complete');
    assert.match(error.message, /missing-model/);
    return true;
  });
});

test('An empty Runtime opens and closes without contacting an unavailable sandbox lifecycle', async t => {
  const outputDir = await mkdtemp(join(tmpdir(), 'swarmenv-core-test-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const config = options(outputDir);
  config.profiles.writer.model = 'default';

  const runtime = await createRuntime(config);
  try {
    const path = join(outputDir, runtime.id, 'runtime.json');
    assert.equal(JSON.parse(await readFile(path, 'utf8')).status, 'open');
    await assert.rejects(runtime.get('absent'), { code: 'NOT_FOUND', operation: 'get', runtimeId: runtime.id });
    const receipt = await runtime.close();
    assert.equal(receipt.cleanup, 'complete');
    assert.deepEqual(receipt.bots, []);
    assert.equal(receipt.reportPath, path);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).status, 'closed');
    assert.deepEqual(await runtime.close(), receipt);
    await assert.rejects(runtime.spawn({ profile: 'writer', requestId: 'closed-runtime-spawn' }), {
      code: 'NOT_ALLOWED', operation: 'spawn', runtimeId: runtime.id, requestId: 'closed-runtime-spawn',
    });
  } finally {
    await runtime.close();
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createPiOpenSandboxBackend, claimPiOpenSandboxBackend } from '../src/core/pi-opensandbox-backend.js';

test('backend rejects unsupported deployment before allocating resources', () => {
  assert.throws(() => createPiOpenSandboxBackend({ isolation: { network: 'remote' } }), { code: 'INVALID_CONTRACT' });
});

test('backend accepts the supported local deployment as an opaque handle', () => {
  const config = {
    sandbox: { lifecycleBaseUrl: 'http://127.0.0.1:8080/v1' },
    bridge: { host: '0.0.0.0', publicUrl: 'http://172.17.0.1:{port}' },
    modelGateway: { host: '0.0.0.0', advertiseHost: '172.17.0.1' },
    models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: 'http://127.0.0.1:9999/v1/responses', headers: {} } } },
    isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } },
  };
  const handle = createPiOpenSandboxBackend(config);
  assert.ok(Object.isFrozen(handle));
  assert.deepEqual(Object.keys(handle), []);
  assert.throws(() => createPiOpenSandboxBackend({ ...config, isolation: { network: 'local-docker' } }), { code: 'INVALID_CONTRACT' });
  assert.throws(() => createPiOpenSandboxBackend({ ...config, modelGateway: { host: '0.0.0.0', advertiseHost: 'localhost' } }), { code: 'INVALID_CONTRACT' });
});

test('backend validates finite sandbox lifetime bounds before allocating resources', async () => {
  const { configuration } = await import('./fixtures/core-input-backend.js');
  for (const timeoutSeconds of [null, '5100', 0, 59, 60.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createPiOpenSandboxBackend({ ...configuration, sandbox: { lifecycleBaseUrl: 'http://127.0.0.1:8080/v1', timeoutSeconds } }), { code: 'INVALID_CONTRACT' });
  }
  for (const timeoutSeconds of [60, 5100, 86400, Number.MAX_SAFE_INTEGER]) assert.ok(createPiOpenSandboxBackend({ ...configuration, sandbox: { lifecycleBaseUrl: 'http://127.0.0.1:8080/v1', timeoutSeconds } }));
});


test('backend snapshots the lifetime before the caller can mutate configuration', async () => {
  const { configuration } = await import('./fixtures/core-input-backend.js');
  const config = { ...configuration, sandbox: { lifecycleBaseUrl: 'http://127.0.0.1:8080/v1', timeoutSeconds: 5100 } };
  const handle = createPiOpenSandboxBackend(config);
  config.sandbox.timeoutSeconds = 7200;
  const frozen = claimPiOpenSandboxBackend(handle);
  assert.equal(frozen.sandbox.timeoutSeconds, 5100);
  assert.ok(Object.isFrozen(frozen.sandbox));
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createPiOpenSandboxBackend } from '../src/core/pi-opensandbox-backend.js';

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

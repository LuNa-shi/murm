import assert from 'node:assert/strict';
import test from 'node:test';
import { createSandbox, getExecutorCapabilities } from '@luna-shi/murm';
import { claimOpenSandboxBackend } from '../src/core/sandbox/opensandbox-backend.js';

const sandboxConfig = {
  lifecycleBaseUrl: 'http://127.0.0.1:8080/v1',
  isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } },
};
const runtimeConfig = {
  connection: { advertiseHost: '172.17.0.1' },
  models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: 'http://127.0.0.1:9999/v1/responses', headers: {} } } },
};

test('executor capabilities are static, immutable, and independent of Sandbox allocation', () => {
  const codex = getExecutorCapabilities('codex');
  assert.equal(codex.contextFork, false);
  assert.deepEqual(codex.steeringModes, ['all']);
  assert.ok(Object.isFrozen(codex));
  assert.ok(Object.isFrozen(codex.steeringModes));
  assert.equal(getExecutorCapabilities('pi').contextFork, true);
  assert.throws(() => getExecutorCapabilities('toString'), { code: 'INVALID_CONTRACT' });
  const sandbox = createSandbox(sandboxConfig);
  const selected = claimOpenSandboxBackend(sandbox, { ...runtimeConfig, executor: 'codex' });
  assert.equal(selected.driver.kind, 'codex');
  assert.equal(selected.driver.version, '0.172.0');
  assert.equal(selected.modelGateway.maxOutputTokens, null);
  assert.equal(claimOpenSandboxBackend(sandbox, runtimeConfig).driver.kind, 'pi');
});

test('the local Sandbox handle is opaque and Runtime owns executor, model and connection settings', () => {
  const sandbox = createSandbox(sandboxConfig);
  assert.ok(Object.isFrozen(sandbox));
  assert.deepEqual(Object.keys(sandbox), []);
  for (const config of [{
    ...sandboxConfig, isolation: { ...sandboxConfig.isolation, network: 'remote' },
  }, { ...sandboxConfig, isolation: { network: 'local-docker' } }, { ...sandboxConfig, executor: 'pi' }]) {
    assert.throws(() => createSandbox(config), { code: 'INVALID_CONTRACT' });
  }
  assert.throws(() => claimOpenSandboxBackend(sandbox, { ...runtimeConfig, connection: { advertiseHost: 'localhost' } }), { code: 'INVALID_CONTRACT' });
  assert.throws(() => claimOpenSandboxBackend(sandbox, { ...runtimeConfig, executor: 'toString' }), { code: 'INVALID_CONTRACT' });
  assert.throws(() => claimOpenSandboxBackend({}, runtimeConfig), { code: 'INVALID_CONTRACT' });
});

test('Sandbox validates finite lifetime bounds and snapshots the caller configuration', () => {
  for (const timeoutSeconds of [null, '5100', 0, 59, 60.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createSandbox({ ...sandboxConfig, timeoutSeconds }), { code: 'INVALID_CONTRACT' });
  }
  for (const timeoutSeconds of [60, 5100, Number.MAX_SAFE_INTEGER]) {
    assert.ok(createSandbox({ ...sandboxConfig, timeoutSeconds }));
  }
  const config = { ...sandboxConfig, timeoutSeconds: 5100 };
  const handle = createSandbox(config);
  config.timeoutSeconds = 7200;
  const frozen = claimOpenSandboxBackend(handle, runtimeConfig);
  assert.equal(frozen.sandbox.timeoutSeconds, 5100);
  assert.ok(Object.isFrozen(frozen.sandbox));
});

test('Runtime snapshots natural model output policy and validates bounds', () => {
  const sandbox = createSandbox(sandboxConfig);
  const config = { ...runtimeConfig, connection: { ...runtimeConfig.connection, modelGateway: { maxOutputTokens: null } } };
  const resolved = claimOpenSandboxBackend(sandbox, config);
  config.connection.modelGateway.maxOutputTokens = 16;
  assert.equal(resolved.modelGateway.maxOutputTokens, null);
  for (const maxOutputTokens of [false, 'none', 0, 15, NaN, Infinity, 16.5]) {
    assert.throws(() => claimOpenSandboxBackend(sandbox, {
      ...runtimeConfig, connection: { ...runtimeConfig.connection, modelGateway: { maxOutputTokens } },
    }), { code: 'INVALID_CONTRACT' });
  }
});

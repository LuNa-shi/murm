import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runLocalSmoke } from '../scripts/local-setup-smoke.js';

test('an interrupted setup probe reports complete cleanup before creating any resources', async () => {
  const controller = new AbortController();
  controller.abort();
  const receipt = await runLocalSmoke({ image: 'unused', lifecycleBaseUrl: 'http://127.0.0.1:1/v1',
    advertiseHost: '172.17.0.1', signal: controller.signal });
  assert.equal(receipt.ok, false);
  assert.equal(receipt.interrupted, true);
  assert.equal(receipt.cleanup, 'complete');
  assert.equal(receipt.runtimeId, undefined);
});

test('the setup probe verifies real local infrastructure and confirms exported bytes and deletion', {
  skip: process.env.MURM_SETUP_REAL_TEST !== '1' && 'Set MURM_SETUP_REAL_TEST=1 for the local Docker/OpenSandbox probe',
  timeout: 160_000,
}, async () => {
  const receipt = await runLocalSmoke({ image: process.env.MURM_CORE_TEST_IMAGE!,
    lifecycleBaseUrl: process.env.MURM_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
    endpointHost: process.env.MURM_CORE_TEST_ENDPOINT_HOST ?? '127.0.0.1',
    apiKey: process.env.MURM_CORE_TEST_API_KEY,
    advertiseHost: process.env.MURM_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1' });
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  assert.equal(receipt.cleanup, 'complete');
  assert.ok(receipt.checks.some(check => check.id === 'artifact-export' && check.status === 'passed'));
  assert.ok(receipt.checks.some(check => check.id === 'sandbox-deletion' && check.status === 'passed'));
});

test('interrupting an active local probe closes its owned resources', {
  skip: process.env.MURM_SETUP_REAL_TEST !== '1' && 'Set MURM_SETUP_REAL_TEST=1 for the local Docker/OpenSandbox probe',
  timeout: 60_000,
}, async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 600);
  try {
    const receipt = await runLocalSmoke({ image: process.env.MURM_CORE_TEST_IMAGE!,
      lifecycleBaseUrl: process.env.MURM_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
      endpointHost: process.env.MURM_CORE_TEST_ENDPOINT_HOST ?? '127.0.0.1',
      apiKey: process.env.MURM_CORE_TEST_API_KEY,
      advertiseHost: process.env.MURM_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1', signal: controller.signal });
    assert.equal(receipt.ok, false);
    assert.equal(receipt.interrupted, true);
    assert.ok(receipt.runtimeId);
    assert.equal(receipt.cleanup, 'complete', JSON.stringify(receipt));
  } finally { clearTimeout(timer); }
});

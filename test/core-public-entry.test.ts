import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as core from '@murm/core';

test('the Core package has one narrow public entry point', async () => {
  assert.deepEqual(Object.keys(core).sort(), [
    'ServiceRegistry', 'createHttpJsonAdapter', 'createInProcessAdapter', 'createRuntime',
    'createSandbox', 'getExecutorCapabilities',
  ]);
  for (const name of ['services', 'backends/opensandbox', 'backends/pi-opensandbox']) {
    await assert.rejects(import(`@murm/core/${name}`), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  }
});

test('Runtime exposes a live state getter through onEvent and one input method', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const outputDir = await mkdtemp(join(tmpdir(), 'core-public-events-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const runtime = await core.createRuntime({
    sandbox: core.createSandbox({ lifecycleBaseUrl: 'http://127.0.0.1:1/v1',
      isolation: { disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } } }),
    connection: { advertiseHost: '192.0.2.1', bridge: { host: '127.0.0.1' },
      modelGateway: { host: '127.0.0.1' } },
    models: { default: { provider: 'kimi_proxy', model: 'k3',
      upstream: { url: 'http://127.0.0.1:1/v1/responses', headers: {} } } },
    profiles: { worker: { model: 'default', image: 'unused', writable: true, services: {} } },
    maxAgents: 1, outputDir, services: new core.ServiceRegistry(),
  });
  t.after(() => runtime.close());
  assert.equal(runtime.state, 'open');
  for (const name of ['start', 'steer', 'observe']) assert.equal(name in runtime, false);
  const seen = [];
  const offCorrupt = runtime.onEvent(event => { event.type = 'corrupted'; throw new Error('synchronous'); });
  const offReject = runtime.onEvent(async () => { throw new Error('asynchronous'); });
  const off = runtime.onEvent(event => seen.push([event.type, runtime.state]));
  try {
    const closing = runtime.close();
    assert.equal(runtime.state, 'closing');
    assert.equal((await closing).cleanup, 'complete');
    assert.equal(runtime.state, 'closed');
    assert.deepEqual(seen, [['runtimeChanged', 'closing'], ['runtimeChanged', 'closed']]);
  } finally {
    off();
    offReject();
    offCorrupt();
  }
});

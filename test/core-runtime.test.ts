import { runtimeSettings } from './fixtures/core-runtime-settings.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { Server } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRuntime } from '@luna-shi/murm';

import { ServiceRegistry } from '@luna-shi/murm';

function options(outputDir, model = 'k3', sandbox = {}) {
  return {
    ...runtimeSettings({
      sandbox: { lifecycleBaseUrl: 'http://127.0.0.1:1/v1', ...sandbox },
      bridge: { host: '127.0.0.1', publicUrl: 'http://172.17.0.1:{port}' },
      modelGateway: { host: '127.0.0.1', advertiseHost: '172.17.0.1' },
      models: {
        default: {
          provider: 'kimi_proxy',
          model,
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
        image: 'murm-agent:core-test',
        writable: true,
        services: {},
      },
    },
    services: new ServiceRegistry(),
    maxAgents: 1,
    outputDir,
  };
}

test('Runtime rejects an unknown Profile model before creating a Agent', async t => {
  const outputDir = await mkdtemp(join(tmpdir(), 'murm-core-test-'));
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

test('Runtime rejects invalid Pi model identifiers and accepts custom Responses models', async t => {
  const outputDir = await mkdtemp(join(tmpdir(), 'murm-core-test-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const invalidConfig = options(outputDir, '../invalid-model');
  invalidConfig.profiles.writer.model = 'default';

  await assert.rejects(createRuntime(invalidConfig), {
    code: 'INVALID_CONTRACT', operation: 'createRuntime', cleanup: 'complete',
  });

  const customConfig = options(outputDir, 'custom-pi-model');
  customConfig.profiles.writer.model = 'default';
  const runtime = await createRuntime(customConfig);
  try {
    assert.equal(runtime.state, 'open');
  } finally {
    const receipt = await runtime.close();
    assert.equal(receipt.cleanup, 'complete');
  }
});

test('An empty Runtime opens and closes without contacting an unavailable sandbox lifecycle', async t => {
  const outputDir = await mkdtemp(join(tmpdir(), 'murm-core-test-'));
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
    assert.deepEqual(receipt.agents, []);
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

test('factory timeout retains its identity and reconciles a late model listener without opening the Bridge', { timeout: 5000 }, async t => {
  const outputDir = await mkdtemp(join(tmpdir(), 'murm-core-late-listener-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const config = options(outputDir);
  config.profiles.writer.model = 'default';
  let expire;
  const realSetTimeout = globalThis.setTimeout;
  const clock = t.mock.method(globalThis, 'setTimeout', function (callback, ms, ...args) {
    if (ms === 60_000 && !expire) expire = () => callback(...args);
    return Reflect.apply(realSetTimeout, this, [callback, ms, ...args]);
  });
  const originalListen = Server.prototype.listen;
  let release;
  let capture;
  let listeners = 0;
  const held = new Promise(resolve => { capture = resolve; });
  const interception = t.mock.method(Server.prototype, 'listen', function (...args) {
    listeners++;
    release = () => Reflect.apply(originalListen, this, args);
    capture();
    return this;
  });
  const starting = createRuntime(config);
  await held;
  try {
    expire();
    const failure = await starting.catch(error => error);
    assert.equal(failure.code, 'OPERATION_UNKNOWN');
    assert.equal(failure.cleanup, 'pending');
    assert.equal(failure.reportPath, join(outputDir, failure.runtimeId, 'runtime.json'));
    release();
    let record;
    for (let attempt = 0; attempt < 100; attempt++) {
      record = JSON.parse(await readFile(failure.reportPath, 'utf8'));
      if (record.status === 'initialization-failed') break;
      await delay(5);
    }
    assert.equal(listeners, 1);
    assert.equal(record.status, 'initialization-failed');
    assert.equal(record.cleanup, 'complete');
    assert.deepEqual(record.pending, []);
  } finally { interception.mock.restore(); clock.mock.restore(); }
});

test('close exposes a failed report save and later publishes the same closed Runtime', async t => {
  const outputDir = await mkdtemp(join(tmpdir(), 'murm-core-report-retry-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const config = options(outputDir);
  config.profiles.writer.model = 'default';
  const runtime = await createRuntime(config);
  const reportPath = join(outputDir, runtime.id, 'runtime.json');
  await rm(reportPath);
  await mkdir(reportPath);
  try {
    const failed = await runtime.close();
    assert.equal(failed.cleanup, 'pending');
    assert.equal(failed.reportPath, undefined);
    assert.equal(failed.pending[0].kind, 'report');
    assert.equal(failed.pending[0].error.code, 'REPORT_WRITE_FAILED');
  } finally {
    await rm(reportPath, { recursive: true, force: true });
  }
  const closed = await runtime.close();
  assert.equal(closed.cleanup, 'complete');
  assert.equal(closed.reportPath, reportPath);
  assert.equal(JSON.parse(await readFile(reportPath, 'utf8')).status, 'closed');
});


test('Runtime accepts a Profile network origin without allocating a sandbox', async t => {
  const outputDir = await mkdtemp(join(tmpdir(), 'murm-core-test-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const config = options(outputDir);
  config.profiles.writer.model = 'default';
  config.profiles.writer.env = { TOKENIZER: 'test-only-nonsecret' };
  config.profiles.writer.network = { allow: ['http://192.0.2.10:8080', 'https://192.0.2.11'] };
  const runtime = await createRuntime(config);
  t.after(() => runtime.close());
  assert.equal((await runtime.close()).cleanup, 'complete');
});


test('Runtime rejects reserved or unsupported ordinary environment values at assembly', async t => {
  const outputDir = await mkdtemp(join(tmpdir(), 'murm-core-test-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  for (const env of [{ MURM_WORKER_TOKEN: 'test-only' }, { PI_API_KEY: 'test-only' }, { lower_case: 'unsupported' }, { LABEL: 'x'.repeat(4097) }]) {
    const config = options(outputDir);
    config.profiles.writer.model = 'default';
    config.profiles.writer.env = env;
    await assert.rejects(async () => {
      const runtime = await createRuntime(config);
      t.after(() => runtime.close());
    }, { code: 'INVALID_CONTRACT', operation: 'createRuntime', cleanup: 'complete' });
  }
});


async function lifecycleFixture(t) {
  const requests = [];
  let received;
  const first = new Promise(resolve => { received = resolve; });
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    received(response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { requests, first, url: `http://127.0.0.1:${server.address().port}/v1`, reject(response) {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ message: 'Deterministic allocation rejection' }));
  } };
}

test('starting Agent reserves capacity before provider allocation and retains its identity on replay', { timeout: 5000 }, async t => {
  const outputDir = await mkdtemp(join(tmpdir(), 'murm-core-test-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const provider = await lifecycleFixture(t);
  const config = options(outputDir, 'k3', { lifecycleBaseUrl: provider.url });
  config.profiles.writer.model = 'default';
  const runtime = await createRuntime(config);
  t.after(() => runtime.close());
  const first = runtime.spawn({ requestId: 'first', profile: 'writer' }).catch(error => error);
  const response = await provider.first;
  const replay = runtime.spawn({ requestId: 'first', profile: 'writer' }).catch(error => error);
  await assert.rejects(runtime.spawn({ requestId: 'second', profile: 'writer' }), { code: 'CONFLICT' });
  assert.equal(provider.requests.length, 1);
  provider.reject(response);
  const [failure, replayFailure] = await Promise.all([first, replay]);
  assert.equal(failure.operation, 'spawn');
  assert.equal(replayFailure.agentId, failure.agentId);
  assert.equal((await runtime.get(failure.agentId)).id, failure.agentId);
  assert.equal((await runtime.close()).cleanup, 'complete');
});

test('Runtime snapshots Profiles and a reusable Sandbox creates independently owned Runtimes', { timeout: 5000 }, async t => {
  const outputDir = await mkdtemp(join(tmpdir(), 'murm-core-test-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const provider = await lifecycleFixture(t);
  const config = options(outputDir, 'k3', { lifecycleBaseUrl: provider.url });
  config.profiles.writer.model = 'default';
  const runtime = await createRuntime(config);
  t.after(() => runtime.close());
  const peerRuntime = await createRuntime(config);
  assert.notEqual(peerRuntime.id, runtime.id);
  assert.equal((await peerRuntime.close()).cleanup, 'complete');
  assert.equal(runtime.state, 'open');
  config.profiles.writer.image = 'mutated-image:must-not-run';
  config.profiles.writer.model = 'absent';
  config.profiles.added = { ...config.profiles.writer };
  await assert.rejects(runtime.spawn({ requestId: 'added-role', profile: 'added' }), { code: 'INVALID_CONTRACT' });
  const pending = runtime.spawn({ requestId: 'frozen-image', profile: 'writer' }).catch(error => error);
  const response = await provider.first;
  assert.equal(provider.requests[0].image.uri, 'murm-agent:core-test');
  provider.reject(response);
  const failure = await pending;
  assert.equal(failure.operation, 'spawn');
  const secondConfig = options(outputDir);
  secondConfig.profiles.writer.model = 'default';
  const other = await createRuntime(secondConfig);
  t.after(() => other.close());
  assert.notEqual(other.id, runtime.id);
  await assert.rejects(other.get(failure.agentId), { code: 'NOT_FOUND', runtimeId: other.id });
  assert.notEqual((await other.close()).outputDir, (await runtime.close()).outputDir);
});

test('Runtime rejects invalid capability and network configuration before resource creation', async t => {
  const outputDir = await mkdtemp(join(tmpdir(), 'murm-core-test-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const invalidProfiles = [
    { services: { absent: ['read'] } }, { spawnProfiles: ['absent'] },
    ...['http://127.0.0.1', 'https://example.com', 'http://192.0.2.1/path', 'http://192.0.2.1:0',
      'http://192.0.2.1:65536', 'ftp://192.0.2.1', 'http://0.0.0.0', 'http://[::1]'].map(url => ({ network: { allow: [url] } })),
  ];
  for (const profile of invalidProfiles) {
    const config = options(outputDir);
    Object.assign(config.profiles.writer, { model: 'default' }, profile);
    await assert.rejects(async () => {
      const runtime = await createRuntime(config);
      t.after(() => runtime.close());
    }, { code: 'INVALID_CONTRACT', operation: 'createRuntime', cleanup: 'complete' });
  }
});


test('spawn rejects reserved credentials and host policy overrides before dispatch', async t => {
  const outputDir = await mkdtemp(join(tmpdir(), 'murm-core-test-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const config = options(outputDir);
  config.profiles.writer.model = 'default';
  const runtime = await createRuntime(config);
  t.after(() => runtime.close());
  for (const override of [{ secretEnv: { MURM_WORKER_TOKEN: 'test-only' } },
    { secretEnv: { PI_KIMI_PROXY_API_KEY: 'test-only' } }, { network: { allow: [] } },
    { image: 'other-image' }, { model: 'other-model' }, { maxAgents: 99 }, { services: {} }]) {
    await assert.rejects(runtime.spawn({ requestId: 'invalid-override', profile: 'writer', ...override }), {
      code: 'INVALID_CONTRACT', operation: 'spawn',
    });
  }
});

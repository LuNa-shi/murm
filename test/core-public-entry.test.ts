import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as core from '@luna-shi/murm';
import { rootExports } from './fixtures/public-entry.js';

test('the Core package has one narrow public entry point', async () => {
  assert.deepEqual(Object.keys(core).sort(), rootExports);
  assert.match(core.DEFAULT_WORKER_IMAGE, /^ghcr\.io\/luna-shi\/murm-worker:\d+\.\d+\.\d+/);
  for (const name of ['services', 'backends/opensandbox', 'backends/pi-opensandbox']) {
    await assert.rejects(import(`@luna-shi/murm/${name}`), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
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
      isolation: { network: 'api' } }),
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

test('a packed SDK consumer can own a Sandbox through a custom Provider', { timeout: 45_000 }, async t => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { execute, preparePackageArchive } = await import('./fixtures/notes-installed-package.js');
  const directory = await mkdtemp(join(tmpdir(), 'murm-provider-consumer-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { archive } = await preparePackageArchive(directory);
  await writeFile(join(directory, 'package.json'), '{"type":"module","private":true}');
  await execute('npm', ['install', '--offline', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', archive], { cwd: directory });
  await writeFile(join(directory, 'provider.mjs'), `
    import assert from 'node:assert/strict';
    import { readFile } from 'node:fs/promises';
    import { createRuntime, createSandbox, ServiceRegistry } from '@luna-shi/murm';
    const calls = [];
    const provider = {
      id: 'external', version: '1.0.0', capabilities: {},
      async preflight() { calls.push('preflight'); },
      openManager(image) {
        assert.equal(image, 'my-worker');
        let agentId, stopped = false, stopAttempts = 0;
        return {
          async ensureExecution(request) {
            agentId = request.agentId;
            assert.equal(request.executionId, agentId);
            request.onCreateDispatch({ timeout_seconds: request.timeoutSeconds });
            request.onCreated({ sandbox_id: 'external-sandbox' });
            calls.push('allocate');
            return { sandbox_id: 'external-sandbox' };
          },
          async agentVersions() { return { piVersion: '1.3.0' }; },
          async startAgent(options) {
            options.beforeAgentStart();
            assert.equal(options.writable, true);
            calls.push('start');
          },
          async agentRpc(id, { type }) {
            assert.equal(id, agentId);
            return { response: { success: true, command: type } };
          },
          coreResource(id) {
            assert.equal(id, agentId);
            return { creation: 'created', sandboxId: 'external-sandbox', resourceKey: agentId, executionStopped: stopped };
          },
          async stopAgent(id, _signal, { preserveWorker }) {
            assert.equal(id, agentId);
            assert.equal(preserveWorker, true);
            calls.push('stop');
            if (++stopAttempts === 1) return false;
            stopped = true;
            return true;
          },
          async *collectCoreSession(id) {
            assert.equal(id, agentId);
            assert.ok(stopped);
            calls.push('archive');
            yield { type: 'end', totalBytes: 0, fileCount: 0, directoryCount: 0 };
          },
          async stopExecution(id) {
            assert.equal(id, agentId);
            assert.ok(stopped);
            calls.push('delete');
            return true;
          },
        };
      },
      async prepareSandbox(input) {
        assert.equal(input.sandboxId, 'external-sandbox');
        input.assertOpen();
        calls.push('prepare');
      },
    };
    const sandbox = createSandbox({ provider });
    provider.openManager = () => { throw new Error('Provider implementation replaced'); };
    const runtime = await createRuntime({
      sandbox, connection: { advertiseHost: '192.0.2.1' },
      models: { default: { provider: 'kimi_proxy', model: 'k3',
        upstream: { url: 'http://127.0.0.1:1/v1/responses', headers: {} } } },
      profiles: { worker: { image: 'my-worker', model: 'default', writable: true, services: {} } },
      services: new ServiceRegistry(), maxAgents: 1, outputDir: './runs',
    });
    try {
      const agent = await runtime.spawn({ profile: 'worker', requestId: 'external-spawn' });
      assert.equal(agent.status, 'idle');
      const uncertain = await runtime.stop(agent.id);
      assert.equal(uncertain.cleanup, 'pending');
      assert.deepEqual(calls, ['preflight', 'allocate', 'prepare', 'start', 'stop']);
      assert.equal((await runtime.stop(agent.id)).cleanup, 'complete');
    } finally {
      assert.equal((await runtime.close()).cleanup, 'complete');
    }
    assert.deepEqual(calls, ['preflight', 'allocate', 'prepare', 'start', 'stop', 'stop', 'archive', 'delete']);
    const summary = JSON.parse(await readFile('./runs/' + runtime.id + '/runtime.json', 'utf8'));
    assert.deepEqual(Object.values(summary.sandboxes), [{
      providerId: 'external', providerVersion: '1.0.0', sandboxId: 'external-sandbox', image: 'my-worker',
    }]);
  `);
  const env = { ...process.env };
  delete env.NODE_PATH;
  delete env.NODE_OPTIONS;
  await execute(process.execPath, ['provider.mjs'], { cwd: directory, env, timeout: 20_000 });
});


test('the public executor factories reject unverified versions and select matching images', () => {
  assert.equal(core.createPiExecutor().version, '1.3.0');
  assert.equal(core.createCodexExecutor().version, '0.172.0');
  assert.match(core.workerImageFor(core.createPiExecutor({ version: '1.4.0' })), /-pi-1\.4\.0$/);
  assert.match(core.workerImageFor('codex'), /-codex$/);
  assert.throws(() => core.createPiExecutor({ version: '10.0.0' }), { code: 'INVALID_CONTRACT' });
});

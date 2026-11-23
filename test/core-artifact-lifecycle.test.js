import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLifecycleProvider } from './fixtures/core-lifecycle-provider.js';

const content = Buffer.from([0, 255, 160, 10]);
const sha256 = createHash('sha256').update(content).digest('hex');
const collect = { paths: ['nested/file.bin'], maxBytes: 4, includeGit: false, required: true };
const records = [
  { type: 'directory', path: 'nested' },
  { type: 'file', path: 'nested/file.bin', mode: 0o644, bytes: 4 },
  { type: 'chunk', data: content.toString('base64') },
  { type: 'fileEnd', sha256 },
  { type: 'end', totalBytes: 4, fileCount: 1, directoryCount: 1 },
];

async function runtimeFixture(t, hooks, { collection = collect, maxBots = 1 } = {}) {
  const provider = await createLifecycleProvider(t, hooks);
  const { createRuntime } = await import('@swarmenv/core');
  const { ServiceRegistry } = await import('@swarmenv/core/services');
  const { createPiOpenSandboxBackend } = await import('@swarmenv/core/backends/pi-opensandbox');
  const outputDir = await mkdtemp(join(tmpdir(), 'core-artifacts-fixture-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const runtime = await createRuntime({ backend: createPiOpenSandboxBackend({
    sandbox: { lifecycleBaseUrl: provider.url }, bridge: { host: '127.0.0.1', publicUrl: 'http://192.0.2.1:{port}' },
    modelGateway: { host: '127.0.0.1', advertiseHost: '192.0.2.1' },
    models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: 'http://127.0.0.1:1/v1/responses', headers: {} } } },
    isolation: { network: 'local-docker', disk: { bytes: 32 * 1024 ** 2, inodes: 2048 } },
  }), profiles: { worker: { image: 'fixture', model: 'default', prompt: 'fixture', writable: true, services: {}, collect: collection } },
  services: new ServiceRegistry(), maxBots, outputDir });
  return { provider, runtime, outputDir: join(outputDir, runtime.id) };
}

test('required artifacts block deletion and retain the Slot until verified host save and confirmed teardown', { timeout: 8000 }, async t => {
  let started, release;
  const collecting = new Promise(resolve => { started = resolve; });
  const allowCollection = new Promise(resolve => { release = resolve; });
  let uploads = 0;
  let executionStops = 0;
  const specification = structuredClone(collect);
  const { provider, runtime, outputDir } = await runtimeFixture(t, {
    onStop() { executionStops++; return { stopped: true }; },
    async onCollect(spec) {
      uploads++;
      assert.deepEqual(spec, collect);
      started();
      await allowCollection;
      return { records };
    },
  }, { collection: specification });
  const spawn = requestId => runtime.spawn({ requestId, profile: 'worker' });
  try {
    await assert.rejects(runtime.spawn({ requestId: 'bad', profile: 'worker', collect: { ...collect, paths: ['../escape'] } }),
      { code: 'INVALID_CONTRACT' });
    assert.equal(provider.allocations(), 0);
    specification.paths[0] = 'changed-before-spawn';
    const bot = await spawn('first');
    const botDir = join(outputDir, bot.id);
    await writeFile(botDir, 'block file creation');
    const failed = await runtime.stop(bot.id);
    assert.equal(failed.execution, 'stopped');
    assert.equal(failed.cleanup, 'pending');
    assert.equal(failed.errors[0].code, 'ARTIFACT_WRITE_FAILED');
    assert.equal(failed.pending.action, 'collect-artifacts');
    assert.equal(failed.pending.sandboxId, 'fixture-1');
    assert.equal(uploads, 0);
    await assert.rejects(spawn('blocked-capacity'), { code: 'CONFLICT' });
    await rm(botDir);

    const earlyStop = runtime.stop(bot.id, { timeoutMs: 25 });
    await collecting;
    const early = await earlyStop;
    assert.equal(early.execution, 'stopped');
    assert.equal(early.pending.action, 'collect-artifacts');
    assert.equal((await runtime.get(bot.id)).lastStop.pending.action, 'collect-artifacts');
    const closing = runtime.close({ timeoutMs: 25 });
    const pendingClose = await closing;
    assert.ok(pendingClose.pending.some(item => item.kind === 'bot' && item.id === bot.id));
    assert.equal(uploads, 1);
    release();
    await provider.deletionStarted;
    provider.releaseDeletion();
    const failedDeletion = await runtime.stop(bot.id);
    assert.equal(failedDeletion.cleanup, 'pending');
    assert.equal(failedDeletion.pending.action, 'delete-sandbox');
    const [manifestPath, treePath] = failedDeletion.artifacts;
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.deepEqual(manifest.files, [{ path: 'nested/file.bin', bytes: 4, sha256, mode: 0o644 }]);
    assert.deepEqual(await readFile(join(treePath, 'nested/file.bin')), content);
    provider.allowDeletion();
    const closed = await runtime.close();
    assert.equal(closed.cleanup, 'complete');
    assert.deepEqual(closed.pending, []);
    assert.deepEqual(closed.bots[0].artifacts, failedDeletion.artifacts);
    assert.equal(JSON.parse(await readFile(closed.reportPath, 'utf8')).status, 'closed');
    assert.equal(uploads, 1);
    assert.equal(executionStops, 1);
  } finally {
    release();
    provider.allowDeletion();
    await runtime.close();
  }
});

test('unknown execution stop prevents collection, and optional invalid artifacts retain error after deletion', { timeout: 8000 }, async t => {
  let stopped = false;
  let uploads = 0;
  const { provider, runtime } = await runtimeFixture(t, {
    onStop: () => ({ stopped }),
    onCollect() {
      uploads++;
      return { records: records.map(record => record.type === 'fileEnd' ? { ...record, sha256: '0'.repeat(64) } : record) };
    },
  }, { collection: { ...collect, required: false } });
  provider.allowDeletion();
  try {
    const bot = await runtime.spawn({ requestId: 'first', profile: 'worker' });
    const unknown = await runtime.stop(bot.id);
    assert.equal(unknown.execution, 'unknown');
    assert.equal(unknown.pending.action, 'stop-execution');
    assert.equal(uploads, 0);
    stopped = true;
    const result = await runtime.close();
    assert.equal(result.cleanup, 'complete');
    assert.equal(result.bots[0].execution, 'stopped');
    assert.equal(result.bots[0].cleanup, 'complete');
    assert.deepEqual(result.bots[0].artifacts, []);
    assert.equal(result.bots[0].errors[0].code, 'ARTIFACT_INVALID');
    assert.equal(uploads, 1);
  } finally { stopped = true; await runtime.close(); }
});

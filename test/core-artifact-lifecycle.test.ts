import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { Server } from 'node:net';
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

async function runtimeFixture(t, hooks, { collection = collect, maxAgents = 1 } = {}) {
  const provider = await createLifecycleProvider(t, hooks);
  const { createRuntime } = await import('@murm/core');
  const { ServiceRegistry } = await import('@murm/core/services');
  const { createPiOpenSandboxBackend } = await import('@murm/core/backends/pi-opensandbox');
  const outputDir = await mkdtemp(join(tmpdir(), 'core-artifacts-fixture-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const runtime = await createRuntime({ backend: createPiOpenSandboxBackend({
    sandbox: { lifecycleBaseUrl: provider.url }, bridge: { host: '127.0.0.1', publicUrl: 'http://192.0.2.1:{port}' },
    modelGateway: { host: '127.0.0.1', advertiseHost: '192.0.2.1' },
    models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: 'http://127.0.0.1:1/v1/responses', headers: {} } } },
    isolation: { network: 'local-docker', disk: { bytes: 32 * 1024 ** 2, inodes: 2048 } },
  }), profiles: { worker: { image: 'fixture', model: 'default', prompt: 'fixture', writable: true, services: {}, collect: collection } },
  services: new ServiceRegistry(), maxAgents, outputDir });
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
    const agent = await spawn('first');
    const agentDir = join(outputDir, agent.id);
    await writeFile(agentDir, 'block file creation');
    const failed = await runtime.stop(agent.id);
    assert.equal(failed.execution, 'stopped');
    assert.equal(failed.cleanup, 'pending');
    assert.equal(failed.errors[0].code, 'ARTIFACT_WRITE_FAILED');
    assert.equal(failed.pending.action, 'archive-session');
    assert.equal(failed.pending.sandboxId, 'fixture-1');
    assert.equal(uploads, 0);
    await assert.rejects(spawn('blocked-capacity'), { code: 'CONFLICT' });
    await rm(agentDir);

    const stopping = runtime.stop(agent.id);
    await collecting;
    const early = await runtime.stop(agent.id, { timeoutMs: 25 });
    assert.equal(early.execution, 'stopped');
    assert.equal(early.pending.action, 'collect-artifacts');
    assert.equal(JSON.parse(await readFile(early.sessionArchive, 'utf8')).agentId, agent.id);
    assert.equal((await runtime.get(agent.id)).lastStop.pending.action, 'collect-artifacts');
    const closing = runtime.close({ timeoutMs: 25 });
    const pendingClose = await closing;
    assert.ok(pendingClose.pending.some(item => item.kind === 'agent' && item.id === agent.id));
    assert.equal(uploads, 1);
    release();
    await provider.deletionStarted;
    provider.releaseDeletion();
    const failedDeletion = await stopping;
    assert.equal(failedDeletion.cleanup, 'pending');
    assert.equal(failedDeletion.pending.action, 'delete-sandbox');
    const [manifestPath, treePath] = failedDeletion.artifacts;
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.deepEqual(manifest.files, [{ path: 'nested/file.bin', bytes: 4, sha256, mode: 0o644 }]);
    assert.deepEqual(await readFile(join(treePath, 'nested/file.bin')), content);
    assert.equal((await runtime.close()).cleanup, 'pending');
    provider.allowDeletion();
    const closed = await runtime.close();
    assert.equal(closed.cleanup, 'complete');
    assert.deepEqual(closed.pending, []);
    assert.deepEqual(closed.agents[0].artifacts, failedDeletion.artifacts);
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
    const agent = await runtime.spawn({ requestId: 'first', profile: 'worker' });
    const unknown = await runtime.stop(agent.id);
    assert.equal(unknown.execution, 'unknown');
    assert.equal(unknown.pending.action, 'stop-execution');
    assert.equal(uploads, 0);
    stopped = true;
    const result = await runtime.close();
    assert.equal(result.cleanup, 'complete');
    assert.equal(result.agents[0].execution, 'stopped');
    assert.equal(result.agents[0].cleanup, 'complete');
    assert.deepEqual(result.agents[0].artifacts, []);
    assert.equal(result.agents[0].errors[0].code, 'ARTIFACT_INVALID');
    assert.equal(uploads, 1);
  } finally { stopped = true; await runtime.close(); }
});

test('late creation remains registered across the host spawn deadline and a concurrent close', { timeout: 8000 }, async t => {
  let allocated, release;
  const allocation = new Promise(resolve => { allocated = resolve; });
  const providerReply = new Promise(resolve => { release = resolve; });
  const { provider, runtime } = await runtimeFixture(t, {
    async onCreate(sandboxId) {
      allocated(sandboxId);
      await providerReply;
    },
  });
  provider.allowDeletion();
  const setTimer = globalThis.setTimeout;
  let expireSpawn;
  const clock = t.mock.method(globalThis, 'setTimeout', function (handler, ms, ...args) {
    if (ms === 60_000 && !expireSpawn) expireSpawn = () => handler(...args);
    return Reflect.apply(setTimer, this, [handler, ms, ...args]);
  });
  try {
    const spawning = runtime.spawn({ requestId: 'late', profile: 'worker' });
    const sandboxId = await allocation;
    expireSpawn();
    const failure = await spawning.catch(error => error);
    assert.equal(failure.code, 'OPERATION_UNKNOWN');
    assert.equal(failure.cleanup, 'pending');
    assert.equal(failure.runtimeId, runtime.id);
    assert.equal(failure.requestId, 'late');
    assert.ok(failure.agentId);
    clock.mock.restore();
    const pending = await runtime.close({ timeoutMs: 10 });
    assert.equal(pending.cleanup, 'pending');
    assert.equal(pending.agents[0].pending.id, failure.agentId);
    assert.equal(pending.agents[0].pending.creation, 'pending');
    assert.equal(pending.agents[0].pending.action, 'await-startup');
    release();
    const closed = await runtime.close();
    assert.equal(closed.cleanup, 'complete');
    assert.equal(closed.agents[0].agentId, failure.agentId);
    assert.equal(closed.agents[0].execution, 'stopped');
    assert.equal((await fetch(`${provider.url}/sandboxes/${sandboxId}`)).status, 404);
    assert.equal(provider.allocations(), 1);
  } finally {
    clock.mock.restore();
    release();
    await runtime.close();
  }
});

test('close reports blocked Bridge and model entry failures and retries both owners', { timeout: 8000 }, async t => {
  const { runtime } = await runtimeFixture(t, {});
  const original = Server.prototype.close;
  let remaining = 2;
  const fault = t.mock.method(Server.prototype, 'close', function (callback) {
    if (remaining-- > 0) {
      queueMicrotask(() => callback(Object.assign(new Error('Controlled listener closure failure'), { code: 'EIO' })));
      return this;
    }
    return Reflect.apply(original, this, [callback]);
  });
  try {
    const pending = await runtime.close();
    assert.equal(pending.cleanup, 'pending');
    assert.equal(pending.pending.find(item => item.kind === 'bridge').id, runtime.id);
    const model = pending.pending.find(item => item.kind === 'model');
    assert.equal(model.id, `${runtime.id}:default`);
    assert.equal(model.error.code, 'MODEL_CLOSE_FAILED');
    const saved = JSON.parse(await readFile(pending.reportPath, 'utf8'));
    assert.deepEqual(saved.pending, pending.pending);
    assert.equal((await runtime.close()).cleanup, 'complete');
  } finally { fault.mock.restore(); await runtime.close(); }
});

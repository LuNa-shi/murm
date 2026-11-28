import { runtimeSettings } from './fixtures/core-runtime-settings.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLifecycleProvider } from './fixtures/core-lifecycle-provider.js';
import { completeDigest, decodeFileSeed, partialDigest } from '../src/core/files/core-file-seed.js';

const payload = { 'bin/sample': { encoding: 'base64', data: 'AP+A', mode: 0o755 } };

async function openHarness(t, hooks) {
  const provider = await createLifecycleProvider(t, hooks);
  const { createRuntime } = await import('@luna-shi/murm');
  const { ServiceRegistry } = await import('@luna-shi/murm');

  const outputDir = await mkdtemp(join(tmpdir(), 'core-file-controls-'));
  const runtime = await createRuntime({ ...runtimeSettings({
    sandbox: { lifecycleBaseUrl: provider.url },
    bridge: { host: '127.0.0.1', publicUrl: 'http://192.0.2.1:{port}' },
    modelGateway: { host: '127.0.0.1', advertiseHost: '192.0.2.1' },
    models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: 'http://127.0.0.1:1/v1/responses', headers: {} } } },
    isolation: { network: 'local-docker', disk: { bytes: 32 * 1024 ** 2, inodes: 2048 } },
  }), profiles: { worker: { image: 'fixture-image', model: 'default', prompt: 'fixture', writable: false, services: {} } },
  services: new ServiceRegistry(), maxAgents: 1, outputDir });
  provider.allowDeletion();
  return { runtime, provider, async cleanup() {
    try { assert.equal((await runtime.close()).cleanup, 'complete'); }
    finally { await rm(outputDir, { recursive: true, force: true }); }
  } };
}

test('spawn validates and freezes seed bytes before worker startup and checks the writable attestation', { timeout: 8000 }, async t => {
  let seed;
  let attest = true;
  const { runtime, provider, cleanup } = await openHarness(t, { onStart(body, result) {
    seed = body.files;
    if (!attest) result.project_files.writable = false;
  } });
  try {
    await assert.rejects(runtime.spawn({ requestId: 'invalid', profile: 'worker', files: { '../outside': payload['bin/sample'] } }),
      { code: 'INVALID_CONTRACT' });
    assert.equal(provider.allocations(), 0);
    const input = { 'bin/sample': { ...payload['bin/sample'] } };
    const pending = runtime.spawn({ requestId: 'seeded', profile: 'worker', writable: true, files: input });
    input['bin/sample'].data = 'AA==';
    const ready = await pending;
    assert.equal(ready.status, 'idle');
    assert.deepEqual(seed, payload);
    assert.equal((await runtime.stop(ready.id)).cleanup, 'complete');
    attest = false;
    await assert.rejects(runtime.spawn({ requestId: 'bad-attestation', profile: 'worker', writable: true, files: payload }),
      { code: 'AGENT_STARTUP_CONTRACT', operation: 'spawn' });
  } finally { await cleanup(); }
});

const digest = files => completeDigest(decodeFileSeed(files).digest);

test('replacement retries the original Worker request and never writes again after completion', async t => {
  let calls = 0;
  let writes = 0;
  let previous;
  let current = {};
  const { runtime, cleanup } = await openHarness(t, { fileOperation(action, input) {
    if (action === 'snapshot') return { body: { result: { requestId: input.requestId, version: 1, files: current,
      scope: 'complete', digest: digest(current) } } };
    assert.equal(action, 'replace');
    calls++;
    if (previous) return { body: { result: previous } };
    assert.equal(input.expectedDigest, digest(current));
    writes++;
    current = input.files;
    previous = { status: 'completed', requestId: input.requestId, digest: digest(current), writable: true };
    return { disconnect: true };
  } });
  try {
    const agent = await runtime.spawn({ requestId: 'readonly', profile: 'worker' });
    const before = await runtime.files.snapshot(agent.id, { requestId: 'capture', paths: ['.'] });
    const options = { requestId: 'replace', expectedDigest: before.digest, files: payload, writable: true };
    assert.deepEqual(await runtime.files.replace(agent.id, options), { agentId: agent.id, requestId: 'replace', status: 'unknown' });
    current = { 'agent-edit': { encoding: 'utf8', data: 'must survive' } };
    await assert.rejects(runtime.send(agent.id, 'held', { requestId: 'blocked' }), { code: 'NOT_ALLOWED' });
    await assert.rejects(runtime.files.replace(agent.id, { ...options, writable: undefined }), { code: 'CONFLICT' });
    await assert.rejects(runtime.files.replace('another-agent', options), { code: 'CONFLICT' });
    const [one, two] = await Promise.all([runtime.files.replace(agent.id, options), runtime.files.replace(agent.id, options)]);
    assert.deepEqual(one, { agentId: agent.id, ...previous });
    assert.equal(one, two);
    assert.equal(await runtime.files.replace(agent.id, options), one);
    assert.equal(calls, 2);
    assert.equal(writes, 1);
    assert.ok(current['agent-edit']);
    await runtime.stop(agent.id);
    assert.equal(await runtime.files.replace(agent.id, options), one);
  } finally { await cleanup(); }
});

test('a partial snapshot cannot authorize replacement and can be replayed after cleanup', async t => {
  const partial = partialDigest(decodeFileSeed(payload).digest);
  let calls = 0;
  const { runtime, cleanup } = await openHarness(t, { fileOperation(action, input) {
    assert.equal(action, 'snapshot');
    calls++;
    return { body: { result: { requestId: input.requestId, version: 1, files: payload, scope: 'partial', digest: partial } } };
  } });
  try {
    const agent = await runtime.spawn({ requestId: 'readonly', profile: 'worker', files: payload });
    const options = { requestId: 'capture', paths: ['bin/sample'] };
    const receipt = await runtime.files.snapshot(agent.id, options);
    assert.equal(receipt.digest, partial);
    await assert.rejects(runtime.files.replace(agent.id, { requestId: 'bad', expectedDigest: receipt.digest, files: {} }), { code: 'INVALID_CONTRACT' });
    await assert.rejects(runtime.files.snapshot(agent.id, { ...options, paths: ['.'] }), { code: 'CONFLICT' });
    await assert.rejects(runtime.files.snapshot(agent.id, { requestId: 'git', paths: ['nested/.git/config'] }), { code: 'INVALID_CONTRACT' });
    await runtime.stop(agent.id);
    assert.equal(await runtime.files.snapshot(agent.id, options), receipt);
    assert.equal(calls, 1);
  } finally { await cleanup(); }
});

test('an unconfirmed replacement racing stop cannot establish a completed receipt', async t => {
  const reached = Promise.withResolvers();
  const release = Promise.withResolvers();
  const { runtime, cleanup } = await openHarness(t, { async fileOperation(_action, input) {
    reached.resolve();
    await release.promise;
    return { body: { result: { requestId: input.requestId, digest: digest(payload), writable: true, status: 'completed' } } };
  } });
  try {
    const agent = await runtime.spawn({ requestId: 'readonly', profile: 'worker' });
    const request = { requestId: 'race', expectedDigest: digest({}), files: payload, writable: true };
    const pending = runtime.files.replace(agent.id, request);
    await reached.promise;
    assert.equal((await runtime.stop(agent.id)).cleanup, 'complete');
    release.resolve();
    assert.equal((await pending).status, 'unknown');
    assert.equal((await runtime.files.replace(agent.id, request)).status, 'unknown');
    await assert.rejects(runtime.files.replace(agent.id, { ...request, requestId: 'fresh' }), { code: 'NOT_ALLOWED' });
  } finally { release.resolve(); await cleanup(); }
});

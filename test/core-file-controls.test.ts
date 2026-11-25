import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLifecycleProvider } from './fixtures/core-lifecycle-provider.js';
import { decodeFileSeed } from '../scripts/core-file-seed.js';

const payload = { 'bin/sample': { encoding: 'base64', data: 'AP+A', mode: 0o755 } };

async function openHarness(t, hooks) {
  const provider = await createLifecycleProvider(t, hooks);
  const { createRuntime } = await import('@swarmenv/core');
  const { ServiceRegistry } = await import('@swarmenv/core/services');
  const { createPiOpenSandboxBackend } = await import('@swarmenv/core/backends/pi-opensandbox');
  const outputDir = await mkdtemp(join(tmpdir(), 'core-file-controls-'));
  const runtime = await createRuntime({ backend: createPiOpenSandboxBackend({
    sandbox: { lifecycleBaseUrl: provider.url },
    bridge: { host: '127.0.0.1', publicUrl: 'http://192.0.2.1:{port}' },
    modelGateway: { host: '127.0.0.1', advertiseHost: '192.0.2.1' },
    models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: 'http://127.0.0.1:1/v1/responses', headers: {} } } },
    isolation: { network: 'local-docker', disk: { bytes: 32 * 1024 ** 2, inodes: 2048 } },
  }), profiles: { worker: { image: 'fixture-image', model: 'default', prompt: 'fixture', writable: false, services: {} } },
  services: new ServiceRegistry(), maxBots: 1, outputDir });
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
    await assert.rejects(runtime.files.prepare(ready.id, { requestId: 'writable', files: {} }), { code: 'CONFLICT' });
    assert.equal((await runtime.stop(ready.id)).cleanup, 'complete');
    attest = false;
    await assert.rejects(runtime.spawn({ requestId: 'bad-attestation', profile: 'worker', writable: true, files: payload }),
      { code: 'BOT_STARTUP_CONTRACT', operation: 'spawn' });
  } finally { await cleanup(); }
});

test('file controls require the issued receipt, correlate replays and preserve unknown grant until recovered', { timeout: 8000 }, async t => {
  let prepares = 0;
  let grantCalls = 0;
  const grantEffects = new Set();
  const { runtime, cleanup } = await openHarness(t, { async fileOperation(action, request) {
    if (action === 'prepare') {
      prepares++;
      return { body: { result: { version: request.version, digest: decodeFileSeed(request.files).digest } } };
    }
    grantEffects.add(request.version);
    if (++grantCalls === 1) return { disconnect: true };
    return { body: { result: { ...request, writable: true } } };
  } });
  try {
    const bot = await runtime.spawn({ requestId: 'readonly', profile: 'worker' });
    assert.equal((await runtime.send(bot.id, 'discovery waiting for a handoff', { requestId: 'discovery' })).status, 'accepted');
    assert.equal((await runtime.get(bot.id)).status, 'running');
    const empty = await runtime.files.prepare(bot.id, { requestId: 'empty', files: {} });
    const first = { requestId: 'seed', files: payload };
    const [prepared, same] = await Promise.all([runtime.files.prepare(bot.id, first), runtime.files.prepare(bot.id, first)]);
    assert.equal(prepared, same);
    assert.equal(prepared.version, empty.version + 1);
    assert.equal(prepared.digest, decodeFileSeed(payload).digest);
    assert.equal(prepares, 2);
    await assert.rejects(runtime.files.prepare(bot.id, { ...first, files: {} }), { code: 'CONFLICT' });
    await assert.rejects(runtime.files.grant({ requestId: 'stale', prepared: empty }), { code: 'CONFLICT' });
    await assert.rejects(runtime.files.grant({ requestId: 'copy', prepared: { ...prepared } }), { code: 'CONFLICT' });
    await assert.rejects(runtime.files.grant({ requestId: 'foreign', prepared: { ...prepared, botId: 'foreign' } }), { code: 'NOT_FOUND' });

    const grant = { requestId: 'grant', prepared };
    await assert.rejects(runtime.files.grant(grant), { code: 'OPERATION_UNKNOWN', operation: 'files.grant', requestId: 'grant', cleanup: 'pending' });
    await assert.rejects(runtime.send(bot.id, 'follow-up', { requestId: 'blocked' }), { code: 'NOT_ALLOWED' });
    const [settled, replay] = await Promise.all([runtime.files.grant(grant), runtime.files.grant(grant)]);
    assert.equal(replay, settled);
    assert.deepEqual(settled, { botId: bot.id, version: prepared.version, writable: true });
    assert.equal(grantCalls, 2);
    assert.equal(grantEffects.size, 1);
    assert.equal((await runtime.send(bot.id, 'follow-up', { requestId: 'allowed' })).status, 'accepted');
  } finally { await cleanup(); }
});

test('a grant racing Bot stop retains its request and cannot return a new writable receipt', { timeout: 8000 }, async t => {
  const reached = Promise.withResolvers();
  const release = Promise.withResolvers();
  let grantCalls = 0;
  const { runtime, cleanup } = await openHarness(t, { async fileOperation(action, request) {
    if (action === 'prepare') return { body: { result: { version: request.version, digest: decodeFileSeed(request.files).digest } } };
    grantCalls++;
    reached.resolve();
    await release.promise;
    return { body: { result: { ...request, writable: true } } };
  } });
  try {
    const bot = await runtime.spawn({ requestId: 'readonly', profile: 'worker' });
    const prepared = await runtime.files.prepare(bot.id, { requestId: 'seed', files: payload });
    const request = { requestId: 'grant-race', prepared };
    const pending = assert.rejects(runtime.files.grant(request), { code: 'OPERATION_UNKNOWN', requestId: 'grant-race' });
    await reached.promise;
    assert.equal((await runtime.stop(bot.id)).cleanup, 'complete');
    release.resolve();
    await pending;
    await assert.rejects(runtime.files.grant(request), { code: 'OPERATION_UNKNOWN', requestId: 'grant-race' });
    assert.equal(grantCalls, 1);
    await assert.rejects(runtime.files.grant({ ...request, requestId: 'new-grant' }), { code: 'NOT_ALLOWED' });
  } finally { release.resolve(); await cleanup(); }
});

test('host snapshots retain stable bytes and replay after cleanup while rejecting changed selection', async t => {
  const { digest } = decodeFileSeed(payload);
  let calls = 0;
  const { runtime, cleanup } = await openHarness(t, { async fileOperation(action, input) {
    assert.equal(action, 'snapshot'); calls++;
    return { body: { result: { requestId: input.requestId, version: 1, digest, files: payload } } };
  } });
  try {
    const bot = await runtime.spawn({ profile: 'worker', requestId: 'snapshot-bot', writable: true });
    const options = { requestId: 'capture', paths: ['bin/sample'] };
    const receipt = await runtime.files.snapshot(bot.id, options);
    assert.deepEqual(receipt.files, payload); assert.equal(receipt.digest, digest);
    assert.equal(receipt.botId, bot.id); assert.equal(receipt.version, 1);
    await assert.rejects(runtime.files.snapshot(bot.id, { ...options, paths: ['different'] }), { code: 'CONFLICT' });
    await runtime.stop(bot.id);
    assert.deepEqual(await runtime.files.snapshot(bot.id, options), receipt);
    assert.equal(calls, 1);
    await assert.rejects(runtime.files.snapshot(bot.id, { ...options, requestId: 'new' }), { code: 'NOT_ALLOWED' });
  } finally { await cleanup(); }
});

test('only the host can select a scoped shared workspace or a frozen private copy', async t => {
  let started;
  const { runtime, cleanup } = await openHarness(t, { onStart(body) { started = body; } });
  try {
    const bot = await runtime.spawn({ profile: 'worker', requestId: 'frozen', workspace: { mode: 'frozen-copy', files: payload }, writable: true });
    assert.deepEqual(started.files, payload);
    assert.equal((await runtime.stop(bot.id)).cleanup, 'complete');
    await assert.rejects(runtime.spawn({ profile: 'worker', requestId: 'invalid-shared', workspace: { id: '../escape', mode: 'read-write' } }), { code: 'INVALID_CONTRACT' });
    await assert.rejects(runtime.spawn({ profile: 'worker', requestId: 'shared-seed', workspace: { id: 'project', mode: 'read-write' }, files: payload }), { code: 'INVALID_CONTRACT' });
    await assert.rejects(runtime.spawn({ profile: 'worker', requestId: 'readonly-writable', workspace: { id: 'project', mode: 'read-only' }, writable: true }), { code: 'INVALID_CONTRACT' });
  } finally { await cleanup(); }
});

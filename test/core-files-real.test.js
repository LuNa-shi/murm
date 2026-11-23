import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { createRuntime } from '@swarmenv/core';
import { createPiOpenSandboxBackend } from '@swarmenv/core/backends/pi-opensandbox';
import { ServiceRegistry } from '@swarmenv/core/services';
import { createFilesUpstream, seededFiles, preparedFiles } from './fixtures/core-files-upstream.js';
import { cleanupRuntimes } from './fixtures/core-runtime-cleanup.js';
import { ownedContainers } from './fixtures/core-runtime-containers.js';
import { openSandboxBotKey } from '../src/runtime/opensandbox-metadata.js';

const execute = promisify(execFile);

test('actual no-Task Bots verify initial seeds and readonly prepare/grant with native file writes', {
  skip: process.env.SWARMENV_CORE_FILES_REAL_TEST !== '1' && 'Combined implementation pin and fixed local gate require independent review', timeout: 220_000,
}, async t => {
  const image = process.env.SWARMENV_CORE_TEST_IMAGE; assert.ok(image);
  const upstream = await createFilesUpstream(); t.after(() => upstream.close());
  const outputDir = join(process.cwd(), 'experiments', `core-files-${Date.now()}`);
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const runtimes = []; const resources = {};
  const report = { failure: true, image, turns: {}, rejections: [], workloadLimitMs: 180_000, cleanupLimitMs: 30_000 };
  let deadlineExpired = false;
  const deadline = setTimeout(() => {
    deadlineExpired = true;
    for (const runtime of runtimes) void runtime.close({ timeoutMs: 1 }).catch(() => {});
  }, 180_000);
  t.after(() => clearTimeout(deadline));
  t.after(async () => {
    report.cleanup = await cleanupRuntimes(runtimes, { inspect: ownedContainers, resources });
    Object.assign(report, { resources, upstream: upstream.receipt(), deadlineExpired });
    report.failure ||= deadlineExpired || report.cleanup.some(row => row.cleanup !== 'complete') || Object.values(resources).some(row => !row.empty);
    await writeFile(join(outputDir, 'acceptance.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    assert.ok(report.cleanup.every(row => row.cleanup === 'complete'));
    assert.ok(Object.values(resources).every(row => row.empty));
  });
  const host = process.env.SWARMENV_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1';
  const runtime = await createRuntime({ backend: createPiOpenSandboxBackend({
    sandbox: { lifecycleBaseUrl: process.env.SWARMENV_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
      endpointHost: process.env.SWARMENV_CORE_TEST_ENDPOINT_HOST ?? '127.0.0.1', apiKey: process.env.SWARMENV_CORE_TEST_API_KEY,
      resourceLimits: { cpu: '1', memory: '1Gi' }, commandTimeoutMs: 20_000 },
    bridge: { host: '0.0.0.0', publicUrl: `http://${host}:{port}` },
    modelGateway: { host: '0.0.0.0', advertiseHost: host, requestTimeoutMs: 30_000, maxOutputTokens: 128 },
    models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: upstream.url, headers: {} } } },
    isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } },
  }), profiles: {
    seeded: { prompt: 'Perform the fixed initial file checks.', model: 'default', image, writable: true, services: {} },
    discovery: { prompt: 'Perform the fixed readonly and file handoff checks.', model: 'default', image, writable: false, services: {} },
  }, services: new ServiceRegistry(), maxBots: 2, outputDir });
  runtimes.push(runtime); report.runtimeId = runtime.id;
  assert.deepEqual(await ownedContainers(runtime.id), []);
  const a = await runtime.spawn({ profile: 'seeded', requestId: 'seeded-spawn', files: seededFiles });
  const b = await runtime.spawn({ profile: 'discovery', requestId: 'readonly-spawn' });
  report.bots = [a, b].map(bot => ({ botId: bot.id, status: bot.status, profile: bot.profile }));
  assert.equal(a.status, 'idle'); assert.equal(b.status, 'idle');
  const containers = await ownedContainers(runtime.id); assert.equal(containers.length, 2);
  report.containers = containers;
  const identities = await Promise.all(containers.map(async container => ({ container,
    botKey: JSON.parse((await execute('docker', ['inspect', '--format', '{{json .Config.Labels.bot_key}}', container], { timeout: 5000 })).stdout) })));
  const bContainer = identities.find(row => row.botKey === openSandboxBotKey(b.id)).container;
  const docker = (...args) => execute('docker', ['exec', bContainer, ...args], { timeout: 5000 });
  // A fixed outside-workDir sentinel detects path escape without reading private conversations.
  await docker('sh', '-c', "printf 'OUTSIDE_UNCHANGED\\n' > /workspace/core-files-outside-probe");
  async function turn(bot, id) {
    assert.equal(deadlineExpired, false);
    assert.equal((await runtime.get(bot.id)).status, 'idle');
    let resolve;
    const settled = new Promise(done => { resolve = done; });
    const unsubscribe = runtime.onEvent(event => { if (event.botId === bot.id && event.type === 'settled') resolve(event); });
    const timer = setTimeout(() => resolve({ outcome: 'timeout' }), 35_000);
    try {
      const input = await runtime.send(bot.id, id, { requestId: id, mode: 'followUp' });
      assert.equal(input.status, 'accepted');
      const result = await settled; assert.equal(result.outcome, 'completed'); assert.equal(result.output, `${id}_OK`);
      report.turns[id] = { input, outcome: result.outcome, cursor: (await runtime.get(bot.id)).cursor };
    } finally { clearTimeout(timer); unsubscribe(); }
  }
  async function rejects(label, task) {
    await assert.rejects(task, error => {
      assert.ok(['INVALID_CONTRACT', 'NOT_ALLOWED', 'NOT_FOUND', 'CONFLICT'].includes(error.code));
      report.rejections.push({ label, code: error.code, operation: error.operation, botId: error.botId, requestId: error.requestId });
      return true;
    });
  }
  await turn(a, 'F06_A1');
  await turn(b, 'F06_B1');
  for (const [label, files] of [
    ['relative-escape', { '../core-files-outside-probe': { encoding: 'utf8', data: 'BAD' } }],
    ['absolute-path', { '/workspace/core-files-outside-probe': { encoding: 'utf8', data: 'BAD' } }],
    ['unsupported-mode', { bad: { encoding: 'utf8', data: 'BAD', mode: 0o600 } }],
    ['oversized-file', { huge: { encoding: 'utf8', data: 'x'.repeat(2 * 1024 * 1024 + 1) } }],
  ]) await rejects(label, () => runtime.files.prepare(b.id, { requestId: label, files }));
  assert.equal((await docker('cat', '/workspace/core-files-outside-probe')).stdout, 'OUTSIDE_UNCHANGED\n');
  const [prepared, duplicate] = await Promise.all([
    runtime.files.prepare(b.id, { requestId: 'fixed-prepare', files: preparedFiles }),
    runtime.files.prepare(b.id, { requestId: 'fixed-prepare', files: preparedFiles }),
  ]);
  assert.deepEqual(prepared, duplicate); assert.equal(prepared.botId, b.id);
  assert.ok(Number.isSafeInteger(prepared.version) && prepared.version > 0);
  assert.match(prepared.digest, /^[a-f0-9]{64}$/); report.prepared = prepared;
  await rejects('prepare-request-conflict', () => runtime.files.prepare(b.id, { requestId: 'fixed-prepare', files: seededFiles }));
  await rejects('nonempty-workdir', () => runtime.files.prepare(b.id, { requestId: 'no-overwrite', files: preparedFiles }));
  for (const [label, forged] of [
    ['forged-copy', { ...prepared }], ['wrong-bot', { ...prepared, botId: a.id }],
    ['stale-version', { ...prepared, version: prepared.version - 1 }], ['wrong-digest', { ...prepared, digest: '0'.repeat(64) }],
  ]) await rejects(label, () => runtime.files.grant({ requestId: label, prepared: forged }));
  await turn(b, 'F06_B2');
  const [grant, grantReplay] = await Promise.all([
    runtime.files.grant({ requestId: 'fixed-grant', prepared }),
    runtime.files.grant({ requestId: 'fixed-grant', prepared }),
  ]);
  assert.deepEqual(grant, { botId: b.id, version: prepared.version, writable: true }); assert.deepEqual(grantReplay, grant);
  report.grant = grant;
  await rejects('grant-request-conflict', () => runtime.files.grant({ requestId: 'fixed-grant', prepared: { ...prepared, digest: 'f'.repeat(64) } }));
  await turn(b, 'F06_B3');
  await turn(a, 'F06_A2');
  assert.equal((await docker('cat', '/workspace/core-files-outside-probe')).stdout, 'OUTSIDE_UNCHANGED\n');
  assert.deepEqual(await ownedContainers(runtime.id), containers);
  assert.equal(upstream.receipt().receipts.length, 10); assert.equal(upstream.receipt().failure, undefined);
  assert.equal(Object.keys(upstream.receipt().evidence).length, 5);
  report.failure = false;
});

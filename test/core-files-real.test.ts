import { runtimeSettings } from './fixtures/core-runtime-settings.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { createRuntime } from '@luna-shi/murm';

import { ServiceRegistry } from '@luna-shi/murm';
import { createFilesUpstream, seededFiles, preparedFiles } from './fixtures/core-files-upstream.js';
import { cleanupRuntimes } from './fixtures/core-runtime-cleanup.js';
import { ownedContainers } from './fixtures/core-runtime-containers.js';
import { openSandboxAgentKey } from '../src/runtime/opensandbox-metadata.js';

const execute = promisify(execFile);

test('actual no-Task Agents verify initial files and readonly replacement with native file writes', {
  skip: process.env.MURM_CORE_FILES_REAL_TEST !== '1' && 'Combined implementation pin and fixed local gate require independent review', timeout: 220_000,
}, async t => {
  const image = process.env.MURM_CORE_TEST_IMAGE; assert.ok(image);
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
    report.failure ||= deadlineExpired || report.upstream.failure !== undefined || report.upstream.arrivals !== 10 ||
      report.cleanup.some(row => row.cleanup !== 'complete') || Object.values(resources).some(row => !row.empty);
    await writeFile(join(outputDir, 'acceptance.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    assert.equal(report.failure, false, 'Acceptance receipt must confirm workload bounds and complete cleanup');
  });
  const host = process.env.MURM_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1';
  const runtime = await createRuntime({ ...runtimeSettings({
    sandbox: { lifecycleBaseUrl: process.env.MURM_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
      endpointHost: process.env.MURM_CORE_TEST_ENDPOINT_HOST ?? '127.0.0.1', apiKey: process.env.MURM_CORE_TEST_API_KEY,
      resourceLimits: { cpu: '1', memory: '1Gi' }, commandTimeoutMs: 20_000 },
    bridge: { host: '0.0.0.0', publicUrl: `http://${host}:{port}` },
    modelGateway: { host: '0.0.0.0', advertiseHost: host, requestTimeoutMs: 30_000, maxOutputTokens: 128 },
    models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: upstream.url, headers: {} } } },
    isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } },
  }), profiles: {
    seeded: { prompt: 'Perform the fixed initial file checks.', model: 'default', image, writable: true, services: {} },
    discovery: { prompt: 'Perform the fixed readonly and file handoff checks.', model: 'default', image, writable: false, services: {} },
  }, services: new ServiceRegistry(), maxAgents: 2, outputDir });
  runtimes.push(runtime); report.runtimeId = runtime.id;
  assert.deepEqual(await ownedContainers(runtime.id), []);
  const a = await runtime.spawn({ profile: 'seeded', requestId: 'seeded-spawn', files: seededFiles });
  const b = await runtime.spawn({ profile: 'discovery', requestId: 'readonly-spawn' });
  report.agents = [a, b].map(agent => ({ agentId: agent.id, status: agent.status, profile: agent.profile }));
  assert.equal(a.status, 'idle'); assert.equal(b.status, 'idle');
  const containers = await ownedContainers(runtime.id); assert.equal(containers.length, 2);
  report.containers = containers;
  const identities = await Promise.all(containers.map(async container => ({ container,
    agentKey: JSON.parse((await execute('docker', ['inspect', '--format', '{{json .Config.Labels.agent_key}}', container], { timeout: 5000 })).stdout) })));
  const bContainer = identities.find(row => row.agentKey === openSandboxAgentKey(b.id)).container;
  const docker = (...args) => execute('docker', ['exec', bContainer, ...args], { timeout: 5000 });
  // A fixed outside-workDir sentinel detects path escape without reading private conversations.
  await docker('sh', '-c', "printf 'OUTSIDE_UNCHANGED\\n' > /workspace/core-files-outside-probe");
  async function turn(agent, id) {
    assert.equal(deadlineExpired, false);
    assert.equal((await runtime.get(agent.id)).status, 'idle');
    let resolve;
    const settled = new Promise(done => { resolve = done; });
    const unsubscribe = runtime.onEvent(event => { if (event.agentId === agent.id && event.type === 'settled') resolve(event); });
    const timer = setTimeout(() => resolve({ outcome: 'timeout' }), 35_000);
    try {
      const input = await runtime.send(agent.id, id, { requestId: id, mode: 'followUp' });
      assert.equal(input.status, 'accepted');
      const result = await settled; assert.equal(result.outcome, 'completed'); assert.equal(result.output, `${id}_OK`);
      report.turns[id] = { input, outcome: result.outcome, status: (await runtime.get(agent.id)).status };
    } finally { clearTimeout(timer); unsubscribe(); }
  }
  async function rejects(label, task) {
    await assert.rejects(task, error => {
      assert.ok(['INVALID_CONTRACT', 'NOT_ALLOWED', 'NOT_FOUND', 'CONFLICT'].includes(error.code));
      report.rejections.push({ label, code: error.code, operation: error.operation, agentId: error.agentId, requestId: error.requestId });
      return true;
    });
  }
  await turn(a, 'F06_A1');
  await turn(b, 'F06_B1');
  const before = await runtime.files.snapshot(b.id, { requestId: 'before', paths: ['.'] });
  for (const [label, files] of [
    ['relative-escape', { '../core-files-outside-probe': { encoding: 'utf8', data: 'BAD' } }],
    ['absolute-path', { '/workspace/core-files-outside-probe': { encoding: 'utf8', data: 'BAD' } }],
    ['unsupported-mode', { bad: { encoding: 'utf8', data: 'BAD', mode: 0o600 } }],
    ['oversized-file', { huge: { encoding: 'utf8', data: 'x'.repeat(2 * 1024 * 1024 + 1) } }],
  ]) await rejects(label, () => runtime.files.replace(b.id, { requestId: label, expectedDigest: before.digest, files }));
  assert.equal((await docker('cat', '/workspace/core-files-outside-probe')).stdout, 'OUTSIDE_UNCHANGED\n');
  const initial = { requestId: 'readonly-replace', files: preparedFiles, expectedDigest: before.digest };
  const [installed, duplicate] = await Promise.all([
    runtime.files.replace(b.id, initial), runtime.files.replace(b.id, initial),
  ]);
  assert.deepEqual(installed, duplicate);
  assert.equal(installed.status, 'completed'); assert.equal(installed.writable, false);
  assert.match(installed.digest, /^complete:sha256:[a-f0-9]{64}$/); report.installed = installed;
  await rejects('target-change', () => runtime.files.replace(b.id, { ...initial, files: seededFiles }));
  await rejects('writable-change', () => runtime.files.replace(b.id, { ...initial, writable: true }));
  await rejects('digest-changed', () => runtime.files.replace(b.id, { ...initial, requestId: 'stale' }));
  await turn(b, 'F06_B2');
  const granted = await runtime.files.replace(b.id, { requestId: 'writable-replace', expectedDigest: installed.digest, files: preparedFiles, writable: true });
  assert.equal(granted.status, 'completed'); assert.equal(granted.writable, true);
  report.granted = granted;
  await turn(b, 'F06_B3');
  await turn(a, 'F06_A2');
  assert.equal((await docker('cat', '/workspace/core-files-outside-probe')).stdout, 'OUTSIDE_UNCHANGED\n');
  assert.deepEqual(await ownedContainers(runtime.id), containers);
  assert.equal(upstream.receipt().arrivals, 10);
  assert.equal(upstream.receipt().receipts.length, 10); assert.equal(upstream.receipt().failure, undefined);
  assert.equal(Object.keys(upstream.receipt().evidence).length, 5);
  report.failure = false;
});

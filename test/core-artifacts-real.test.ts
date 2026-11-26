import { runtimeSettings } from './fixtures/core-runtime-settings.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, lstat, writeFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { createRuntime } from '@murm/core';

import { ServiceRegistry } from '@murm/core';
import { createArtifactsUpstream } from './fixtures/core-artifacts-upstream.js';
import { ownedContainers } from './fixtures/core-runtime-containers.js';
import { cleanupRuntimes } from './fixtures/core-runtime-cleanup.js';
import { AGENT_UID } from '../scripts/sandbox-project.js';

const execute = promisify(execFile);
const collect = { paths: ['tracked.txt', 'uncommitted.txt'], includeGit: true, maxBytes: 1024 ** 2, required: true };

const processProbe = `const fs = require('node:fs');
  const statuses = fs.readdirSync('/proc').filter(path => /^\\d+$/.test(path));
  let count = 0;
  for (const pid of statuses) {
    try {
      const status = fs.readFileSync('/proc/' + pid + '/status', 'utf8');
      if (Number(/^Uid:\\s+(\\d+)/m.exec(status)?.[1]) === ${AGENT_UID} && !/^State:\\s+Z/m.test(status)) count++;
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
    }
  }
  console.log(count);`;

test('sandbox stop probe counts live Agent UID processes and excludes unrelated UIDs', () => {
  const states = new Map([
    ['1', 'Uid:\t0\t0\t0\t0\nState:\tS'], ['8', 'Uid:\t1000\t1000\t1000\t1000\nState:\tR'],
    ['9', `Uid:\t${AGENT_UID}\t${AGENT_UID}\t${AGENT_UID}\t${AGENT_UID}\nState:\tS`],
    ['10', `Uid:\t${AGENT_UID}\t${AGENT_UID}\t${AGENT_UID}\t${AGENT_UID}\nState:\tZ`],
  ]);
  const counters = [];
  runInNewContext(processProbe, {
    require: () => ({ readdirSync: () => [...states.keys()], readFileSync: path => states.get(path.split('/')[2]) }),
    console: { log: count => counters.push(count) },
  });
  assert.deepEqual(counters, [1]);
});

export async function verifyArtifactTree({ manifestPath, filesPath, agentId, commit }) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.version, 1); assert.equal(manifest.agentId, agentId);
  assert.deepEqual(manifest.collect, collect);
  assert.ok(Array.isArray(manifest.files) && manifest.files.length >= 3);
  assert.ok(Array.isArray(manifest.directories));
  const paths = manifest.files.map(row => row.path);
  assert.deepEqual(paths, [...paths].sort()); assert.equal(new Set(paths).size, paths.length);
  assert.deepEqual(manifest.directories, [...manifest.directories].sort());
  assert.ok(manifest.directories.includes('.git'));
  for (const path of [...paths, ...manifest.directories]) {
    assert.equal(isAbsolute(path), false); assert.ok(!path.split('/').includes('..'));
  }
  let totalBytes = 0;
  for (const entry of manifest.files) {
    const path = join(filesPath, entry.path);
    const info = await lstat(path); assert.ok(info.isFile() && !info.isSymbolicLink());
    const bytes = await readFile(path);
    assert.equal(entry.bytes, bytes.length); assert.equal(entry.mode, info.mode & 0o777);
    assert.equal(entry.sha256, createHash('sha256').update(bytes).digest('hex'));
    totalBytes += bytes.length;
  }
  assert.equal(manifest.totalBytes, totalBytes); assert.ok(totalBytes <= collect.maxBytes);
  assert.ok(paths.includes('tracked.txt') && paths.includes('uncommitted.txt') && paths.includes('.git/HEAD'));
  assert.equal(await readFile(join(filesPath, 'tracked.txt'), 'utf8'), 'COMMITTED_T07\n');
  assert.equal(await readFile(join(filesPath, 'uncommitted.txt'), 'utf8'), 'UNCOMMITTED_T07\n');
  const git = async (...args) => (await execute('git', ['-C', filesPath, ...args], { timeout: 5000, maxBuffer: 1024 ** 2 })).stdout.trim();
  assert.equal(await git('rev-parse', 'HEAD'), commit);
  assert.equal(await git('log', '--format=%s'), 'Fixed local artifact receipt');
  assert.equal(await git('show', 'HEAD:tracked.txt'), 'COMMITTED_T07');
  assert.equal(await git('status', '--porcelain'), '?? uncommitted.txt');
  assert.equal(await git('remote'), '');
  await git('fsck', '--no-reflogs');
  return { manifestVersion: manifest.version, files: paths.length, directories: manifest.directories.length,
    totalBytes, contentHashesVerified: true, uncommittedVerified: true, commitVerified: commit, gitObjectsVerified: true };
}

for (const executor of ['pi', 'codex'] as const) test(`${executor}: required artifacts survive a recoverable host save failure and remain readable after sandbox deletion`, {
  skip: process.env[executor === 'pi' ? 'MURM_CORE_ARTIFACTS_REAL_TEST' : 'MURM_CODEX_ARTIFACTS_REAL_TEST'] !== '1' && 'Review combined implementation/image pin before fixed local opt-in', timeout: 160_000,
}, async t => {
  const image = process.env.MURM_CORE_TEST_IMAGE; assert.ok(image);
  const outputDir = join(process.cwd(), 'experiments', `core-artifacts-${Date.now()}`);
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const upstream = await createArtifactsUpstream(executor); t.after(() => upstream.close());
  const runtimes = []; const resources = {};
  const report = { version: 1, failure: true, image, executor, workloadLimitMs: 120_000, cleanupLimitMs: 30_000, actions: [], stops: [] };
  let blockerPath;
  let blockerArmed = false;
  let deadlineExpired = false;
  const deadline = setTimeout(() => {
    deadlineExpired = true;
    for (const runtime of runtimes) void runtime.close({ timeoutMs: 1 }).catch(() => {});
  }, 120_000);
  t.after(() => clearTimeout(deadline));
  t.after(async () => {
    if (blockerArmed) {
      try { await rm(blockerPath); blockerArmed = false; report.actions.push({ action: 'remove-save-blocker-during-cleanup', outcome: 'complete' }); }
      catch { report.actions.push({ action: 'remove-save-blocker-during-cleanup', outcome: 'failed' }); report.failure = true; }
    }
    report.cleanup = await cleanupRuntimes(runtimes, { inspect: ownedContainers, resources });
    Object.assign(report, { resources, upstream: upstream.receipt(), deadlineExpired });
    report.failure ||= deadlineExpired || upstream.receipt().failure !== undefined ||
      report.cleanup.some(row => row.cleanup !== 'complete') || Object.values(resources).some(row => !row.empty);
    await writeFile(join(outputDir, 'acceptance.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    assert.equal(report.failure, false, 'Evidence receipt cannot report failure while the test passes');
    assert.ok(report.cleanup.every(row => row.cleanup === 'complete'));
    assert.ok(Object.values(resources).every(row => row.empty));
  });
  const host = process.env.MURM_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1';
  const runtime = await createRuntime({ ...runtimeSettings({ executor,
    sandbox: { lifecycleBaseUrl: process.env.MURM_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
      endpointHost: process.env.MURM_CORE_TEST_ENDPOINT_HOST ?? '127.0.0.1', apiKey: process.env.MURM_CORE_TEST_API_KEY,
      resourceLimits: { cpu: '1', memory: '1Gi' }, commandTimeoutMs: 20_000 },
    bridge: { host: '0.0.0.0', publicUrl: `http://${host}:{port}` },
    modelGateway: { host: '0.0.0.0', advertiseHost: host, requestTimeoutMs: 30_000, maxOutputTokens: 128 },
    models: { default: { provider: executor === 'codex' ? 'openai' : 'kimi_proxy', model: executor === 'codex' ? 'gpt-5.4' : 'k3', upstream: { url: upstream.url, headers: {} } } },
    isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } },
  }), profiles: { worker: { prompt: 'Execute the fixed local artifact command without any network publication.', model: 'default', image, writable: true, services: {} } },
    services: new ServiceRegistry(), maxAgents: 1, outputDir });
  runtimes.push(runtime); report.runtimeId = runtime.id;
  const agent = await runtime.spawn({ requestId: 'artifact-spawn', profile: 'worker', collect });
  report.agentId = agent.id;
  const active = await ownedContainers(runtime.id); assert.equal(active.length, 1); report.containers = active;
  async function countAgentProcesses() {
    const result = await execute('docker', ['exec', active[0], 'node', '-e', processProbe], { timeout: 5000 });
    const count = Number(result.stdout.trim());
    assert.ok(Number.isSafeInteger(count) && count >= 0);
    return count;
  }
  report.runningAgentProcesses = await countAgentProcesses();
  assert.ok(report.runningAgentProcesses > 0);
  const sandboxId = (await execute('docker', ['inspect', '--format', '{{index .Config.Labels "opensandbox.io/id"}}', active[0]], { timeout: 5000 })).stdout.trim();
  assert.ok(sandboxId);
  let resolve;
  const settled = new Promise(done => { resolve = done; });
  const unsubscribe = runtime.onEvent(event => { if (event.agentId === agent.id && event.type === 'settled') resolve(event); });
  t.after(unsubscribe);
  const timer = setTimeout(() => resolve({ outcome: 'timeout' }), 40_000); t.after(() => clearTimeout(timer));
  report.input = await runtime.send(agent.id, 'FIXED_ARTIFACT_CAPTURE', { requestId: 'artifact-input', mode: 'followUp' });
  assert.equal(report.input.status, 'accepted');
  const result = await settled; assert.equal(result.outcome, 'completed'); assert.equal(result.output, 'T07_ARTIFACTS_READY');
  assert.equal(upstream.receipt().arrivals, 2); assert.equal(upstream.receipt().failure, undefined);
  const expectedCommit = upstream.receipt().evidence.commit;
  if (executor === 'codex') {
    report.agentProcessesBeforeStop = await countAgentProcesses();
    assert.ok(report.agentProcessesBeforeStop >= 2, 'The live detached shell child must be included in stop confirmation');
  }
  blockerPath = join(outputDir, runtime.id, agent.id);
  await writeFile(blockerPath, 'CONTROLLED_REQUIRED_SAVE_BLOCKER\n', { flag: 'wx', mode: 0o600 }); blockerArmed = true;
  report.actions.push({ action: 'install-required-save-blocker', outcome: 'complete' });
  const pending = await runtime.stop(agent.id, { timeoutMs: 20_000 }); report.stops.push(pending);
  assert.equal(pending.execution, 'stopped'); assert.equal(pending.cleanup, 'pending');
  assert.deepEqual(pending.artifacts, []); assert.ok(pending.errors.some(error => error.code === 'ARTIFACT_WRITE_FAILED'));
  assert.equal(pending.pending.kind, 'agent'); assert.equal(pending.pending.id, agent.id);
  assert.equal(pending.pending.action, 'archive-session');
  assert.equal(pending.pending.providerId, 'local');
  assert.equal(pending.pending.resourceKey, agent.id);
  assert.equal(pending.pending.sandboxId, sandboxId);
  assert.equal((await runtime.get(agent.id)).status, 'closing');
  assert.deepEqual(await ownedContainers(runtime.id), active);
  const remainingAgentProcesses = await countAgentProcesses();
  assert.equal(remainingAgentProcesses, 0);
  await assert.rejects(runtime.spawn({ requestId: 'retained-slot', profile: 'worker' }), { code: 'CONFLICT' });
  report.actions.push({ action: 'observe-required-export-pending', execution: 'stopped', cleanup: 'pending', slotRetained: true, sandboxRetained: true, remainingAgentProcesses });
  await rm(blockerPath); blockerArmed = false; report.actions.push({ action: 'remove-required-save-blocker', outcome: 'complete' });
  const stopped = await runtime.stop(agent.id, { timeoutMs: 20_000 }); report.stops.push(stopped);
  assert.equal(stopped.execution, 'stopped'); assert.equal(stopped.cleanup, 'complete');
  const manifestPath = join(blockerPath, 'artifacts', 'manifest.json');
  const filesPath = join(blockerPath, 'artifacts', 'files');
  assert.deepEqual([...stopped.artifacts].sort(), [manifestPath, filesPath].sort());
  assert.equal((await runtime.get(agent.id)).status, 'closed'); assert.deepEqual(await ownedContainers(runtime.id), []);
  report.actions.push({ action: 'retry-required-export', execution: 'stopped', cleanup: 'complete', sandboxDeleted: true });
  report.artifacts = await verifyArtifactTree({ manifestPath, filesPath, agentId: agent.id, commit: expectedCommit });
  report.actions.push({ action: 'verify-host-artifacts-after-deletion', outcome: 'complete' });
  const replay = await runtime.stop(agent.id, { timeoutMs: 5000 }); assert.deepEqual(replay, stopped);
  report.repeatedStopStable = true;
  const close = await runtime.close({ timeoutMs: 20_000 });
  assert.equal(close.cleanup, 'complete');
  assert.equal(close.evidence.lost, 0); assert.equal(close.evidence.pending, 0);
  const summary = JSON.parse(await readFile(close.reportPath, 'utf8'));
  const lines = (await readFile(close.evidence.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(summary.runtimeId, runtime.id);
  assert.equal(summary.config.models.default.maxOutputTokens, 128);
  assert.equal(summary.config.models.default.requestTimeoutMs, 30_000);
  assert.deepEqual(summary.agents, [stopped]);
  if (executor === 'codex') {
    const ready = lines.find(row => row.type === 'spawn' && row.state === 'ready');
    assert.equal(ready.backend.kind, 'codex');
    assert.equal(ready.backend.version, '0.172.0');
    assert.equal(ready.backend.authMode, 'api-key');
    assert.match(ready.backend.threadId, /^[a-f0-9-]{36}$/);
  }
  assert.equal(close.evidence.recorded, lines.length);
  assert.ok(lines.every((row, index) => row.runtimeId === runtime.id && row.seq === index + 1));
  assert.ok(lines.some(row => row.type === 'spawn' && row.agentId === agent.id && row.requestId === 'artifact-spawn'));
  assert.ok(lines.some(row => row.type === 'input' && row.agentId === agent.id && row.requestId === 'artifact-input' &&
    row.inputId === report.input.inputId && row.state === 'accepted'));
  assert.ok(lines.some(row => row.type === 'event' && row.agentId === agent.id && row.event.type === 'settled' && row.event.outcome === 'completed'));
  const stops = lines.filter(row => row.type === 'stop' && row.agentId === agent.id && row.state === 'observed');
  assert.deepEqual(stops.map(row => row.receipt), [pending, stopped]);
  report.coreEvidence = { rows: lines.length, modelLimits: summary.config.models.default,
    stopStates: stops.map(row => row.receipt.cleanup), matchingNativeSandbox: stops[0].receipt.pending.sandboxId === sandboxId };
  assert.equal(deadlineExpired, false);
  report.failure = false;
});

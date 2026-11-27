import { runtimeSettings } from './fixtures/core-runtime-settings.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createInputUpstream } from './fixtures/core-input-upstream.js';
import { ownedContainers } from './fixtures/core-runtime-containers.js';

test('real Pi batches steer before start and preserves Session and files across a fenced interrupt', {
  skip: process.env.MURM_CORE_INPUT_REAL_TEST !== '1' && 'Controlled Pi/OpenSandbox input acceptance requires independent review and explicit opt-in',
  timeout: 180_000,
}, async t => {
  const { createRuntime } = await import('@murm/core');

  const { ServiceRegistry } = await import('@murm/core');
  const image = process.env.MURM_CORE_TEST_IMAGE;
  assert.ok(image);
  const outputDir = join(process.cwd(), 'experiments', `core-input-${Date.now()}`);
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const upstream = await createInputUpstream();
  let runtime;
  let agent;
  let active = [];
  let cleanup;
  let deleted = false;
  const receipts = [];
  const events = [];
  const resources = {};
  t.after(async () => {
    try {
      if (runtime) {
        cleanup = await runtime.close({ timeoutMs: 30_000 });
        deleted = (await ownedContainers(runtime.id)).length === 0;
      }
    } finally {
      await upstream.close();
      await writeFile(join(outputDir, 'acceptance.json'), JSON.stringify({
        runtimeId: runtime?.id, agentId: agent?.id, receipts, events, resources,
        upstream: upstream.receipt(), cleanup: cleanup?.cleanup, deleted,
      }, null, 2), { mode: 0o600 });
    }
    assert.equal(cleanup?.cleanup, 'complete');
    assert.equal(deleted, true);
  });
  runtime = await createRuntime({
    ...runtimeSettings({
      sandbox: { lifecycleBaseUrl: process.env.MURM_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
        endpointHost: process.env.MURM_CORE_TEST_ENDPOINT_HOST ?? '127.0.0.1', apiKey: process.env.MURM_CORE_TEST_API_KEY,
        commandTimeoutMs: 30_000 },
      bridge: { host: '0.0.0.0', publicUrl: process.env.MURM_CORE_TEST_BRIDGE_URL ?? 'http://172.17.0.1:{port}' },
      modelGateway: { host: '0.0.0.0', advertiseHost: process.env.MURM_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1', requestTimeoutMs: 20_000, maxOutputTokens: 128 },
      models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: upstream.url, headers: {} } } },
      isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } },
    }),
    profiles: { worker: { prompt: 'Perform the exact requested tool steps.', model: 'default', image, writable: true, services: {} } },
    services: new ServiceRegistry(), maxAgents: 1, outputDir,
  });
  assert.deepEqual(await ownedContainers(runtime.id), []);
  agent = await runtime.spawn({ profile: 'worker', requestId: 'input-acceptance-spawn' });
  active = await ownedContainers(runtime.id);
  assert.equal(active.length, 1);
  const docker = (...args) => promisify(execFile)('docker', ['exec', active[0], ...args], { timeout: 5000 });
  const sessionFiles = async () => (await docker('find', '/workspace/runtime/pi-session', '-type', 'f', '-name', '*.jsonl')).stdout.trim();
  const settled = [];
  let wake;
  runtime.onEvent(event => {
    events.push({ type: event.type, outcome: event.outcome, expected: event.expected, errorCode: event.error?.code });
    if (event.type === 'settled') { settled.push(event); wake?.(); }
  });
  async function waitSettled(index, outcome = 'completed') {
    const deadline = Date.now() + 40_000;
    while (settled.length <= index) {
      if (Date.now() >= deadline) throw new Error('CONTROLLED_SETTLED_TIMEOUT');
      await Promise.race([new Promise(resolve => { wake = resolve; }), delay(100)]);
    }
    assert.equal(settled[index].outcome, outcome);
    return settled[index];
  }
  async function send(input, requestId, mode) {
    const receipt = await runtime.send(agent.id, input, { requestId, ...(mode ? { mode } : {}) });
    receipts.push({ requestId, ...receipt });
    assert.equal(receipt.status, 'accepted');
    return receipt;
  }
  for (const mode of ['steer', 'followUp']) {
    const options = { requestId: 'idle-' + mode, mode, wakeIfIdle: false };
    const receipt = await runtime.send(agent.id, 'IDLE_MESSAGE_MUST_NOT_RUN', options);
    assert.deepEqual(receipt, { inputId: receipt.inputId, status: 'not-accepted', reason: 'idle' });
    assert.deepEqual(await runtime.send(agent.id, 'IDLE_MESSAGE_MUST_NOT_RUN', options), receipt);
  }
  assert.equal((await runtime.get(agent.id)).status, 'idle');
  // These first two associations require idle, one input source, and no queued
  // or automatic continuation. Busy inputs below intentionally share one run.
  await send('ROUND_ONE: write the persistent file.', 'round-one');
  assert.equal((await waitSettled(0)).output, 'ROUND_ONE_OK');
  const firstSession = await sessionFiles();
  assert.ok(firstSession.endsWith('.jsonl'));
  await send('ROUND_TWO: read persistent.txt from the prior round.', 'round-two', 'steer');
  assert.equal((await waitSettled(1)).output, 'ROUND_TWO_OK');
  resources.sameSession = await sessionFiles() === firstSession;
  assert.equal(resources.sameSession, true);
  assert.deepEqual(await ownedContainers(runtime.id), active);
  await send('BUSY_ROUND: execute the fixed long Bash operation.', 'busy-start');
  const busyDeadline = Date.now() + 10_000;
  while (!(await docker('cat', '/workspace/project/busy-ready.txt').then(value => value.stdout === 'READY\n', () => false))) {
    assert.ok(Date.now() < busyDeadline, 'Bash never reached the execution boundary');
    await delay(50);
  }
  assert.equal((await runtime.get(agent.id)).status, 'running');
  const steers = await Promise.all(['A', 'B'].map(suffix => runtime.send(agent.id, `STEER_AT_TOOL_BOUNDARY_${suffix}`, {
    requestId: `busy-steer-${suffix}`, steeringMode: 'all', source: 'controlled-upstream', wakeIfIdle: false,
  })));
  const followUp = await runtime.send(agent.id, 'FOLLOW_UP_AFTER_CURRENT', { mode: 'followUp', requestId: 'busy-follow-up', wakeIfIdle: false });
  assert.ok(steers.every(steer => steer.status === 'accepted' && steer.disposition === 'queued'));
  assert.equal(followUp.disposition, 'queued');
  resources.bashStillRunningAfterQueue = await docker('test', '-e', '/workspace/project/busy-finished.txt').then(() => false, () => true);
  assert.equal(resources.bashStillRunningAfterQueue, true);
  assert.equal((await waitSettled(2)).output, 'BUSY_ROUND_OK');
  assert.equal(settled.length, 3, 'Busy inputs may share one settled; no per-input completion assumption');
  assert.equal((await runtime.send(agent.id, 'INTERRUPT_HELD_TOOL', { mode: 'followUp', requestId: 'held-tool' })).disposition, 'started');
  const interruptDeadline = Date.now() + 10_000;
  while (!(await docker('test', '-e', '/workspace/project/interrupt-ready.txt').then(() => true, () => false))) {
    assert.ok(Date.now() < interruptDeadline, 'Pi never entered the Bash operation to interrupt');
    await delay(50);
  }
  assert.equal((await runtime.send(agent.id, 'CANCEL_QUEUED_PHASE', { mode: 'followUp', requestId: 'old-queued' })).disposition, 'queued');
  const interrupt = await runtime.interrupt(agent.id, { requestId: 'interrupt' });
  assert.equal(interrupt.status, 'interrupted');
  assert.ok(interrupt.discardedInputHashes?.includes(createHash('sha256').update('CANCEL_QUEUED_PHASE').digest('hex')));
  await waitSettled(3, 'aborted');
  assert.equal(await sessionFiles(), firstSession);
  assert.equal((await runtime.send(agent.id, 'RESUME_AFTER_INTERRUPT', { requestId: 'resume', steeringMode: 'one-at-a-time' })).disposition, 'started');
  assert.deepEqual(await runtime.interrupt(agent.id, { requestId: 'interrupt' }), interrupt);
  assert.equal((await waitSettled(4)).output, 'RESUMED_OK');
  assert.equal((await runtime.send(agent.id, 'FAIL_MODEL', { mode: 'followUp', requestId: 'failed' })).disposition, 'started');
  await waitSettled(5, 'failed');
  assert.deepEqual(upstream.receipt(), { requests: 11, failure: undefined, persistedRead: true, bashCompleted: true,
    steerAtBoundary: true, followUpAfterCurrent: true, resumedAfterInterrupt: true });
  resources.sameContainer = JSON.stringify(await ownedContainers(runtime.id)) === JSON.stringify(active);
  assert.equal(resources.sameContainer, true);
  const stop = await runtime.stop(agent.id, { timeoutMs: 30_000 });
  assert.equal(stop.cleanup, 'complete');
  const session = await readFile(join(stop.sessionArchive, '..', 'files', firstSession.split('/').at(-1)), 'utf8');
  for (const marker of ['ROUND_ONE_OK', 'INTERRUPT_HELD_TOOL', 'RESUMED_OK', 'FAIL_MODEL']) assert.ok(session.includes(marker));
  assert.ok(!session.includes('CANCEL_QUEUED_PHASE'));
  const modelTrace = join(outputDir, runtime.id, 'model-trace');
  const attempts = await readdir(modelTrace);
  assert.equal(attempts.length, 11);
  const modelResults = await Promise.all(attempts.map(async id =>
    JSON.parse(await readFile(join(modelTrace, id, 'result.json'), 'utf8'))));
  assert.equal(modelResults.filter(result => result.state === 'completed').length, 10);
  assert.equal(modelResults.filter(result => result.state === 'failed').length, 1);
  assert.deepEqual(await ownedContainers(runtime.id), []);
  assert.equal(events.filter(event => event.type === 'exit' && event.expected).length, 1);
});

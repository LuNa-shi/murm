import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRuntime, createPiExecutor, ServiceRegistry } from '@luna-shi/murm';
import { runtimeSettings } from './fixtures/core-runtime-settings.js';
import { ownedContainers } from './fixtures/core-runtime-containers.js';
import { createAgentControlsUpstream } from './fixtures/core-agent-controls-upstream.js';

test('real Runtime and OpenSandbox commit three automatic compactions, fence the fourth, and recover required export', {
  skip: process.env.MURM_CORE_AGENT_CONTROLS_REAL_TEST !== '1' && 'Set MURM_CORE_AGENT_CONTROLS_REAL_TEST=1 for the bounded local controlled model path',
  timeout: 180_000,
}, async t => {
  const image = process.env.MURM_CORE_TEST_IMAGE;
  assert.ok(image, 'A pinned Worker image is required');
  const outputDir = join(process.cwd(), 'experiments', `core-agent-controls-${Date.now()}`);
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const upstream = await createAgentControlsUpstream({ requestLimit: 16 });
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
  let agentA: any;
  let blockerPath: string | undefined;
  let unblock: (() => void) | undefined;
  const records: any[] = [];
  const hooks: any[] = [];
  const receipts: any[] = [];
  let cleanup: any;
  t.after(async () => {
    unblock?.();
    if (blockerPath) await rm(blockerPath, { force: true });
    try { if (runtime) cleanup = await runtime.close({ timeoutMs: 30000 }); }
    finally {
      await upstream.close();
      await writeFile(join(outputDir, 'acceptance.json'), JSON.stringify({ runtimeId: runtime?.id, image,
        piVersion: process.env.MURM_CORE_TEST_PI_VERSION ?? '1.3.0', hooks, receipts,
        requests: upstream.requests.map(request => ({ kind: request.kind })), records, cleanup }, null, 2), { mode: 0o600 });
    }
    if (runtime) assert.deepEqual(await ownedContainers(runtime.id), []);
    if (runtime) assert.equal(cleanup.cleanup, 'complete');
  });
  const waitFor = async <T>(read: () => T | Promise<T>, predicate: (value: T) => boolean, label: string): Promise<T> => {
    const deadline = Date.now() + 45000;
    while (true) {
      const value = await read();
      if (predicate(value)) return value;
      assert.ok(Date.now() < deadline, label);
      await delay(25);
    }
  };
  runtime = await createRuntime({ ...runtimeSettings({
    sandbox: { lifecycleBaseUrl: process.env.MURM_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
      endpointHost: process.env.MURM_CORE_TEST_ENDPOINT_HOST ?? '127.0.0.1', apiKey: process.env.MURM_CORE_TEST_API_KEY,
      commandTimeoutMs: 30000 },
    bridge: { host: '0.0.0.0', publicUrl: process.env.MURM_CORE_TEST_BRIDGE_URL ?? 'http://172.17.0.1:{port}' },
    modelGateway: { host: '0.0.0.0', advertiseHost: process.env.MURM_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1', requestTimeoutMs: 10000, maxOutputTokens: 1000 },
    models: { default: { provider: 'controlled', model: 'k3', capabilities: { tools: true, reasoning: false, contextWindow: 8000, maxOutputTokens: 1000 },
      upstream: { url: upstream.url + '/responses', headers: {} } } },
    executor: createPiExecutor({ version: process.env.MURM_CORE_TEST_PI_VERSION ?? '1.3.0' }),
    isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } },
  }), profiles: {
    controlled: { prompt: 'Act on controlled input.', image, model: 'default', services: {}, writable: true,
      session: { tools: [], compaction: { enabled: true, reserveTokens: 3000, keepRecentTokens: 500 }, retry: { enabled: false } } },
  }, maxAgents: 2, services: new ServiceRegistry(), outputDir, hooks: { beforeCompact: { timeoutMs: 10000,
    async handler(request) {
      hooks.push({ agentId: request.agentId, compactionId: request.compactionId, count: request.successfulAutoCompactions, reason: request.reason });
      if (request.agentId !== agentA?.id || request.successfulAutoCompactions < 3) return 'allow';
      await new Promise<void>(resolve => { unblock = resolve; });
      return 'stop';
    } } } });
  runtime.onEvent(event => {
    records.push(event.type === 'session' ? { type: event.type, agentId: event.agentId, event: event.event } :
      { type: event.type, agentId: event.agentId, outcome: (event as any).outcome });
  });
  agentA = await runtime.spawn({ requestId: 'native-controls-a', profile: 'controlled' });
  const agentB = await runtime.spawn({ requestId: 'native-controls-b', profile: 'controlled', session: { compaction: { enabled: false } } });
  assert.equal((await runtime.session.getState(agentA.id)).executor.version, process.env.MURM_CORE_TEST_PI_VERSION ?? '1.3.0');
  assert.equal(upstream.requests.length, 0);
  for (let round = 0; round < 4; round++) {
    const settled = records.filter(event => event.type === 'settled' && event.agentId === agentA.id).length;
    receipts.push(await runtime.send(agentA.id, `ROUND ${round} ` + 'long history content '.repeat(500), { requestId: `native-round-${round}` }));
    await waitFor(() => records.filter(event => event.type === 'settled' && event.agentId === agentA.id).length,
      count => count > settled, 'A did not settle');
  }
  assert.equal((await runtime.session.getStats(agentA.id)).compactions.successfulAutoCompactions, 3);
  assert.equal(upstream.requests.filter(request => request.kind === 'summary').length, 3);
  blockerPath = join(outputDir, runtime.id, agentA.id);
  await writeFile(blockerPath, 'CONTROLLED_REQUIRED_EXPORT_BLOCKER', { mode: 0o600, flag: 'wx' });
  receipts.push(await runtime.send(agentA.id, 'ROUND 4 ' + 'long history content '.repeat(500), { requestId: 'native-fourth-trigger' }));
  await waitFor(() => Boolean(unblock), ready => ready, 'Fourth compaction gate was not reached');
  const late = await runtime.send(agentA.id, 'LATE_FOLLOW_UP_MUST_NOT_EXECUTE', { requestId: 'native-late-work', mode: 'followUp' });
  receipts.push(late);
  assert.equal(late.status, 'accepted');
  assert.equal(late.status === 'accepted' && late.disposition, 'queued');
  unblock!();
  const pending = await waitFor(() => runtime!.get(agentA.id), state => state.lastStop?.cleanup === 'pending', 'Required export did not retain the sandbox');
  assert.equal(pending.status, 'closing');
  assert.equal(pending.lastStop?.execution, 'stopped');
  assert.equal((await ownedContainers(runtime.id)).length, 2);
  const bSettled = records.filter(event => event.type === 'settled' && event.agentId === agentB.id).length;
  receipts.push(await runtime.send(agentB.id, 'B independent work after A policy stop', { requestId: 'native-b-continues' }));
  await waitFor(() => records.filter(event => event.type === 'settled' && event.agentId === agentB.id).length,
    count => count > bSettled, 'B did not continue');
  assert.equal((await runtime.get(agentB.id)).status, 'idle');
  await rm(blockerPath); blockerPath = undefined;
  const recovered = await runtime.stop(agentA.id, { timeoutMs: 30000 });
  receipts.push(recovered);
  assert.equal(recovered.cleanup, 'complete');
  assert.ok(recovered.sessionArchive);
  const archiveDir = join(recovered.sessionArchive, '..', 'files');
  const archive = (await readdir(archiveDir)).filter(path => path.endsWith('.jsonl'));
  assert.equal(archive.length, 1);
  const entries = (await readFile(join(archiveDir, archive[0]), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(entries.filter(entry => entry.type === 'compaction').length, 3);
  assert.equal(upstream.requests.filter(request => request.kind === 'summary').length, 3);
  assert.ok(!upstream.requests.some(request => JSON.stringify(request.body).includes('LATE_FOLLOW_UP_MUST_NOT_EXECUTE')));
  assert.equal(upstream.failure, undefined);
  assert.deepEqual(hooks.filter(request => request.agentId === agentA.id).map(request => request.count), [0, 1, 2, 3]);
});

for (const fault of ['timeout', 'throw']) test(`real Runtime and Guest ${fault} compaction decision fences A while B continues`, {
  skip: process.env.MURM_CORE_AGENT_CONTROLS_REAL_TEST !== '1' && 'Bounded local OpenSandbox compaction fault acceptance', timeout: 90000,
}, async t => {
  const image = process.env.MURM_CORE_TEST_IMAGE;
  assert.ok(image);
  const outputDir = join(process.cwd(), 'experiments', `core-agent-controls-${fault}-${Date.now()}`);
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const upstream = await createAgentControlsUpstream({ requestLimit: 8 });
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
  const events: any[] = [];
  let cleanup: any;
  let resolveLate: ((value: 'allow') => void) | undefined;
  t.after(async () => {
    resolveLate?.('allow');
    try { if (runtime) cleanup = await runtime.close({ timeoutMs: 30000 }); }
    finally {
      await upstream.close();
      await writeFile(join(outputDir, 'acceptance.json'), JSON.stringify({ image, fault, events, requests: upstream.requests.map(request => ({ kind: request.kind })), cleanup }, null, 2), { mode: 0o600 });
    }
    if (runtime) assert.deepEqual(await ownedContainers(runtime.id), []);
    if (runtime) assert.equal(cleanup.cleanup, 'complete');
  });
  runtime = await createRuntime({ ...runtimeSettings({
    sandbox: { lifecycleBaseUrl: process.env.MURM_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
      endpointHost: process.env.MURM_CORE_TEST_ENDPOINT_HOST ?? '127.0.0.1', apiKey: process.env.MURM_CORE_TEST_API_KEY, commandTimeoutMs: 30000 },
    bridge: { host: '0.0.0.0', publicUrl: process.env.MURM_CORE_TEST_BRIDGE_URL ?? 'http://172.17.0.1:{port}' },
    modelGateway: { host: '0.0.0.0', advertiseHost: process.env.MURM_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1', requestTimeoutMs: 10000, maxOutputTokens: 1000 },
    models: { default: { provider: 'controlled', model: 'k3', capabilities: { tools: true, reasoning: false, contextWindow: 8000, maxOutputTokens: 1000 },
      upstream: { url: upstream.url + '/responses', headers: {} } } },
    executor: createPiExecutor({ version: process.env.MURM_CORE_TEST_PI_VERSION ?? '1.3.0' }),
    isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } },
  }), profiles: { worker: { prompt: 'Act on controlled input.', image, model: 'default', services: {}, writable: true,
    session: { tools: [], compaction: { enabled: true, reserveTokens: 3000, keepRecentTokens: 500 }, retry: { enabled: false } } } },
    maxAgents: 2, services: new ServiceRegistry(), outputDir,
    hooks: { beforeCompact: { timeoutMs: 100,
      handler() { if (fault === 'throw') throw new Error('CONTROLLED_HOOK_FAILURE'); return new Promise(resolve => { resolveLate = resolve; }); } } } });
  runtime.onEvent(event => events.push(event.type === 'session' ? { type: event.type, agentId: event.agentId, event: event.event } :
    { type: event.type, agentId: event.agentId }));
  const a = await runtime.spawn({ profile: 'worker', requestId: 'fault-a' });
  const b = await runtime.spawn({ profile: 'worker', requestId: 'fault-b', session: { compaction: { enabled: false } } });
  const wait = async (predicate: () => Promise<boolean> | boolean) => {
    const deadline = Date.now() + 30000;
    while (!await predicate()) { assert.ok(Date.now() < deadline, 'Compaction fault did not settle'); await delay(25); }
  };
  await runtime.send(a.id, 'FIRST ' + 'long history content '.repeat(500), { requestId: 'fault-first' });
  await wait(() => events.some(event => event.type === 'settled' && event.agentId === a.id));
  await runtime.send(a.id, 'SECOND ' + 'long history content '.repeat(500), { requestId: 'fault-second' });
  await wait(async () => (await runtime!.get(a.id)).status === 'closed');
  assert.equal(upstream.requests.filter(request => request.kind === 'summary').length, 0);
  resolveLate?.('allow');
  await runtime.send(b.id, 'B CONTINUES AFTER FAILED A GATE', { requestId: 'fault-b-continue' });
  await wait(() => events.some(event => event.type === 'settled' && event.agentId === b.id));
  assert.equal((await runtime.get(b.id)).status, 'idle');
  assert.equal(upstream.requests.length, 3);
  assert.equal(upstream.failure, undefined);
  if (fault === 'throw') assert.ok(events.some(event => event.event?.error?.code === 'HOOK_FAILED'));
  else assert.ok(events.some(event => event.event?.reason === 'HOOK_TIMEOUT' || event.event?.error?.code === 'HOOK_TIMEOUT'));
});

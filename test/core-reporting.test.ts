import { runtimeSettings } from './fixtures/core-runtime-settings.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLifecycleProvider } from './fixtures/core-lifecycle-provider.js';
import { notesManifest } from './fixtures/core-notes-service.js';

const explicitSecret = 'explicit-test-secret\$[]';
const upstreamSecret = 'test-upstream-bearer';
const profileValue = 'configured-profile-value';

async function fixture(t, hooks, { registrations = [], grants = {}, sandbox = {}, modelGateway = {} } = {}) {
  const provider = await createLifecycleProvider(t, hooks);
  provider.allowDeletion();
  const { createRuntime } = await import('@murm/core');

  const { ServiceRegistry } = await import('@murm/core');
  const outputDir = await mkdtemp(join(tmpdir(), 'core-report-evidence-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  function makeOptions(directory = outputDir) {
    const services = new ServiceRegistry();
    for (const registration of registrations) services.registerService(registration);
    return {
      ...runtimeSettings({
        sandbox: { lifecycleBaseUrl: provider.url, resourceLimits: { cpu: '1', memory: '1Gi' }, ...sandbox },
        bridge: { host: '127.0.0.1', publicUrl: 'http://192.0.2.1:{port}' },
        modelGateway: { host: '127.0.0.1', advertiseHost: '192.0.2.1', requestTimeoutMs: 8000, maxOutputTokens: 256, ...modelGateway },
        models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: 'http://127.0.0.1:1/v1/responses',
          headers: { authorization: `Bearer ${upstreamSecret}` } } } },
        isolation: { network: 'local-docker', disk: { bytes: 32 * 1024 ** 2, inodes: 2048 } },
      }),
      profiles: { worker: { image: 'fixture', model: 'default', prompt: 'fixture', writable: true, services: grants,
        env: { CORE_REPORT_DATA: profileValue } } },
      services, maxAgents: 2, outputDir: directory,
    };
  }
  return { provider, outputDir, makeRuntime: directory => createRuntime(makeOptions(directory)) };
}

test('actual Runtime report retains null natural output policy instead of reporting the legacy default cap', async t => {
  const f = await fixture(t, undefined, { modelGateway: { maxOutputTokens: null } });
  const runtime = await f.makeRuntime();
  const receipt = await runtime.close();
  const report = JSON.parse(await readFile(receipt.reportPath, 'utf8'));
  assert.equal(report.config.models.default.maxOutputTokens, null);
  assert.equal(report.config.models.default.requestTimeoutMs, 8000);
});

test('Runtime records identity, unknown input reconciliation, sanitised settled snapshots and independent configurations', { timeout: 8000 }, async t => {
  let workerToken, bridgeToken, modelToken, submitted;
  let prompts = 0;
  const { provider, makeRuntime } = await fixture(t, {
    onCreate(_id, body) { workerToken = body.env.MURM_WORKER_TOKEN; },
    onStart(body) {
      bridgeToken = body.secret_env.MURM_BRIDGE_TOKEN;
      modelToken = body.secret_env.PI_KIMI_PROXY_API_KEY;
    },
    onRpc(message) {
      if (message.type === 'prompt') {
        submitted = message.id;
        prompts++;
        return false;
      }
      if (message.type === 'get_rpc_result') return { status: 'complete', response: {
        id: submitted, command: 'prompt', success: true, data: { disposition: 'started' },
      }, records: [] };
    },
  });
  const runtime = await makeRuntime();
  const siblingRun = await makeRuntime();
  try {
    const parent = await runtime.spawn({ requestId: 'root', profile: 'worker' });
    const agent = await runtime.spawn({ requestId: 'child', parentId: parent.id, profile: 'worker', secretEnv: { PRIVATE_VALUE: explicitSecret } });
    const secrets = [explicitSecret, upstreamSecret, workerToken, bridgeToken, modelToken];
    assert.ok(secrets.every(secret => typeof secret === 'string' && secret.length));
    const options = { requestId: 'fixed-work' };
    const unknown = await runtime.send(agent.id, 'fixed input omitted from evidence', options);
    assert.equal(unknown.status, 'unknown');
    const recovered = await runtime.send(agent.id, 'fixed input omitted from evidence', options);
    assert.deepEqual(recovered, { inputId: unknown.inputId, status: 'accepted', disposition: 'started' });
    assert.equal(prompts, 1);
    const observed = [];
    const unsubscribe = runtime.onEvent(event => { if (event.agentId === agent.id) observed.push(event); });
    const unsubFailure = runtime.onEvent(() => { throw Object.assign(new Error('local callback assertion'), { name: explicitSecret }); });
    const unsubObjectFailure = runtime.onEvent(() => Promise.reject({ name: { explicitSecret } }));
    try {
      provider.publish({ type: 'agent_start' });
      provider.publish({ type: 'message_end', message: {
        role: 'assistant', stopReason: 'error', content: [{ type: 'text', text: `available evidence ${secrets.join(' ')}` }],
        errorMessage: `model failed ${secrets.join(' ')}`,
      } });
      provider.publish({ type: 'agent_settled' });
      const event = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { stop(); reject(new Error('Fixture settled was not observed')); }, 1000);
        const stop = runtime.onEvent(row => {
          if (row.agentId === agent.id && row.type === 'settled') { clearTimeout(timer); stop(); resolve(row); }
        });
      });
      assert.equal(event.outcome, 'failed');
      assert.match(event.error.message, /model failed \[redacted\]/);
      const info = await runtime.get(agent.id);
      for (const secret of secrets) {
        assert.equal(JSON.stringify(observed).includes(secret), false);
        assert.equal(JSON.stringify(info).includes(secret), false);
      }
    } finally { unsubscribe(); unsubFailure(); unsubObjectFailure(); }

    const receipt = await runtime.close();
    const other = await siblingRun.close();
    assert.equal(receipt.cleanup, 'complete');
    assert.equal(other.cleanup, 'complete');
    assert.notEqual(receipt.evidence.path, other.evidence.path);
    const summary = await readFile(receipt.reportPath, 'utf8');
    const evidence = await readFile(receipt.evidence.path, 'utf8');
    for (const secret of [...secrets, profileValue, 'fixed input omitted from evidence']) {
      assert.equal(summary.includes(secret) || evidence.includes(secret), false);
    }
    const report = JSON.parse(summary);
    assert.equal(report.config.schemaVersion, 1);
    assert.equal(report.config.waiting.hostDefaultMs, 60_000);
    assert.deepEqual(report.config.models.default, { provider: 'kimi_proxy', model: 'k3', requestTimeoutMs: 8000, maxOutputTokens: 256 });
    assert.deepEqual(report.config.profiles.worker.environmentKeys, ['CORE_REPORT_DATA']);
    assert.equal(report.modelLedgers.length, 1);
    assert.equal(report.modelLedgers[0].alias, 'default');
    assert.equal((await stat(report.modelLedgers[0].path)).mode & 0o777, 0o600);
    assert.ok(report.handlerErrorCount >= 2);
    assert.equal(report.evidence.lost, 0);
    assert.equal((await stat(receipt.evidence.path)).mode & 0o777, 0o600);
    const rows = evidence.trim().split('\n').map(line => JSON.parse(line));
    assert.ok(rows.every((row, index) => row.seq === index + 1 && row.runtimeId === runtime.id));
    assert.ok(rows.some(row => row.type === 'spawn' && row.state === 'registered' && row.agentId === agent.id && row.parentId === parent.id));
    const inputs = rows.filter(row => row.type === 'input');
    assert.deepEqual(inputs.map(row => row.state), ['registered', 'dispatched', 'unknown', 'receipt-query', 'accepted']);
    assert.ok(inputs.every(row => row.inputId === unknown.inputId && row.requestId === 'fixed-work' && row.source === 'host'));
    assert.equal(inputs.find(row => row.state === 'unknown').reason, 'worker-transport');
    assert.ok(rows.some(row => row.type === 'event' && row.event.type === 'settled' && row.event.outcome === 'failed'));
    assert.ok(rows.some(row => row.type === 'subscriber-error' && row.name === '[redacted]'));
    assert.equal((await readFile(other.evidence.path, 'utf8')).includes(agent.id), false);
  } finally { await Promise.all([runtime.close(), siblingRun.close()]); }
});

test('Runtime report joins a rejected Service write to its trusted caller and effective adapter timeout', async t => {
  const { createHttpJsonAdapter } = await import('@murm/core');
  const manifest = notesManifest();
  manifest.endpoint = { transport: 'http-json', url: 'https://example.invalid' };
  const serviceToken = 'fixture-adapter-credential';
  const writes = [];
  const adapter = createHttpJsonAdapter({ token: serviceToken, timeoutMs: 1234, fetchImpl(_url, options) {
    assert.equal(options.headers.authorization, `Bearer ${serviceToken}`);
    writes.push(JSON.parse(options.body));
    return Response.json({ ok: true, result: { invalid: 'invalid-adapter-output' } });
  } });
  let credentials;
  const { makeRuntime } = await fixture(t, { onStart(body) { credentials = body; } },
    { registrations: [{ manifest, adapter }], grants: { notes: ['put'] } });
  const runtime = await makeRuntime();
  t.after(() => runtime.close({ timeoutMs: 100 }));
  const privateMarker = 'private-agent-marker';
  const agent = await runtime.spawn({ requestId: 'service-reporter', profile: 'worker', secretEnv: { PRIVATE_MARKER: privateMarker } });
  const url = new URL(credentials.env.MURM_BRIDGE_URL);
  url.hostname = '127.0.0.1';
  url.pathname = '/call';
  const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${credentials.secret_env.MURM_BRIDGE_TOKEN}` },
    body: JSON.stringify({ service_id: 'notes', operation: 'put', operation_id: 'fixed-write',
      payload: { key: 'one', text: 'omitted-service-input' }, caller: { agentId: 'forged' } }) });
  assert.equal((await response.json()).error.code, 'SERVICE_OUTPUT_INVALID');
  const denied = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${credentials.secret_env.MURM_BRIDGE_TOKEN}` },
    body: JSON.stringify({ service_id: privateMarker, operation: privateMarker, operation_id: privateMarker }) });
  assert.equal(denied.status, 403);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].caller.agentId, agent.id);
  const close = await runtime.close();
  assert.equal(close.cleanup, 'complete');
  const raw = await readFile(close.evidence.path, 'utf8');
  const report = await readFile(close.reportPath, 'utf8');
  for (const marker of [privateMarker, serviceToken, 'omitted-service-input', 'invalid-adapter-output', 'forged']) {
    assert.equal(raw.includes(marker) || report.includes(marker), false);
  }
  assert.deepEqual(JSON.parse(report).config.services, [
    { id: 'notes', transport: 'http-json', timeoutMs: 1234 }, { id: 'agent', transport: 'in-process' },
  ]);
  const service = raw.trim().split('\n').map(line => JSON.parse(line)).filter(row => row.type === 'service');
  assert.equal(service.length, 5);
  const deniedRow = service.at(-1);
  assert.deepEqual([deniedRow.serviceId, deniedRow.operation, deniedRow.operationId], Array(3).fill('[redacted]'));
  assert.ok(service.slice(0, 4).every(row => row.runtimeId === runtime.id && row.agentId === agent.id && row.profile === 'worker' &&
    row.operationId === 'fixed-write' && row.operation === 'put'));
  assert.deepEqual(service.slice(0, 4).map(row => [row.state, row.outcome]), [
    ['validation', 'pending'], ['validation', 'passed'], ['invocation', 'pending'], ['settled', 'unknown'],
  ]);
});

test('Core records provider lifetime observations before readiness and after partial startup', async t => {
  const requests = [];
  let starts = 0;
  const badExpiry = '2099-02-30T11:00:00Z';
  const { makeRuntime } = await fixture(t, {
    onCreate(id, body) { requests.push({ id, timeoutSeconds: body.timeout }); },
    createExpiresAt: id => id === 'fixture-1' ? '2099-01-03T10:59:17.420+02:00' : badExpiry,
    onStart(_body, result) { if (++starts === 2) result.project_files.version += 1; },
  });
  const runtime = await makeRuntime();
  t.after(() => runtime.close());
  const healthy = await runtime.spawn({ requestId: 'ready', profile: 'worker' });
  let failedAgent;
  await assert.rejects(runtime.spawn({ requestId: 'partial', profile: 'worker' }), error => {
    assert.equal(error.operation, 'spawn');
    failedAgent = error.agentId;
    return true;
  });
  const close = await runtime.close();
  assert.equal(close.cleanup, 'complete');
  const evidence = await readFile(close.evidence.path, 'utf8');
  assert.ok(!evidence.includes(badExpiry));
  const spawn = evidence.trim().split('\n').map(JSON.parse).filter(row => row.type === 'spawn');
  assert.deepEqual(spawn.filter(row => row.agentId === healthy.id).map(row => row.state),
    ['registered', 'allocation-dispatched', 'allocation-observed', 'ready']);
  assert.deepEqual(spawn.filter(row => row.agentId === failedAgent).map(row => row.state),
    ['registered', 'allocation-dispatched', 'allocation-observed']);
  const observed = spawn.filter(row => row.state === 'allocation-observed');
  assert.deepEqual(observed.map(row => [row.requestId, row.sandboxId, row.observation, row.expiresAt]), [
    ['ready', requests[0].id, 'create-response', '2099-01-03T08:59:17.420Z'],
    ['partial', requests[1].id, 'create-response', null],
  ]);
  assert.deepEqual(spawn.filter(row => row.state === 'allocation-dispatched').map(row => row.timeoutSeconds),
    requests.map(row => row.timeoutSeconds));
  assert.ok(requests.every(row => row.timeoutSeconds === 3600));
});

test('Core distinguishes a sandbox found by cleanup when the creation response was lost', async t => {
  const { provider, makeRuntime } = await fixture(t, { onCreate: () => false });
  const runtime = await makeRuntime();
  t.after(() => runtime.close());
  let agentId;
  await assert.rejects(runtime.spawn({ requestId: 'lost', profile: 'worker' }), error => {
    assert.equal(error.cleanup, 'pending');
    agentId = error.agentId;
    return true;
  });
  const close = await runtime.close();
  assert.equal(close.cleanup, 'complete');
  assert.equal(provider.allocations(), 1);
  assert.equal((await fetch(`${provider.url}/sandboxes/fixture-1`)).status, 404);
  const evidence = await readFile(close.evidence.path, 'utf8');
  const spawn = evidence.trim().split('\n').map(JSON.parse).filter(row => row.type === 'spawn');
  assert.deepEqual(spawn.map(row => row.state), ['registered', 'allocation-dispatched', 'allocation-observed']);
  const observation = spawn.at(-1);
  assert.deepEqual([observation.agentId, observation.requestId, observation.sandboxId, observation.observation, observation.expiresAt],
    [agentId, 'lost', 'fixture-1', 'cleanup-lookup', null]);
});

test('cleanup of an unknown creation leaves a sibling Runtime live and owns only its resource', { timeout: 5000 }, async t => {
  const { provider, makeRuntime } = await fixture(t, { onCreate: id => id !== 'fixture-2' });
  const live = await makeRuntime();
  const failed = await makeRuntime();
  try {
    const agent = await live.spawn({ requestId: 'live', profile: 'worker' });
    await assert.rejects(failed.spawn({ requestId: 'lost', profile: 'worker' }), error => {
      assert.equal(error.cleanup, 'pending');
      return true;
    });
    await assert.rejects(failed.get(agent.id), { code: 'NOT_FOUND' });
    await assert.rejects(failed.stop(agent.id), { code: 'NOT_FOUND' });
    const receipt = await failed.close();
    assert.equal(receipt.cleanup, 'complete');
    assert.equal(provider.allocations(), 2);
    assert.equal((await fetch(`${provider.url}/sandboxes/fixture-2`)).status, 404);
    assert.equal((await fetch(`${provider.url}/sandboxes/fixture-1`)).status, 200);
    assert.equal((await live.get(agent.id)).status, 'idle');
    assert.equal((await failed.close()).cleanup, 'complete');
    assert.equal((await fetch(`${provider.url}/sandboxes/fixture-1`)).status, 200);
    assert.equal((await live.close()).cleanup, 'complete');
    assert.equal((await fetch(`${provider.url}/sandboxes/fixture-1`)).status, 404);
  } finally { await failed.close(); await live.close(); }
});

test('evidence write failure stays visible after resources close and an invalid output directory has no report path', async t => {
  const { outputDir, makeRuntime } = await fixture(t, {});
  const blocked = join(outputDir, 'blocked');
  await writeFile(blocked, 'not a directory');
  await assert.rejects(makeRuntime(blocked), error => {
    assert.equal(error.operation, 'createRuntime');
    assert.ok(error.runtimeId && error.details.length);
    assert.equal(error.reportPath, undefined);
    return true;
  });
  const runtime = await makeRuntime();
  const evidence = join(outputDir, runtime.id, 'evidence.jsonl');
  await rm(evidence);
  await mkdir(evidence);
  const receipt = await runtime.close();
  assert.equal(receipt.cleanup, 'pending');
  assert.equal(receipt.evidence.pending, 0);
  assert.ok(receipt.evidence.lost > 0);
  assert.equal(receipt.pending[0].kind, 'report');
  assert.equal(receipt.pending[0].error.code, 'EVIDENCE_INCOMPLETE');
  assert.deepEqual(receipt.agents, []);
  assert.equal(JSON.parse(await readFile(receipt.reportPath)).evidence.lost, receipt.evidence.lost);
});

test('a failed Runtime summary write reports its pending save and a retry publishes the closed receipt', async t => {
  const { outputDir, makeRuntime } = await fixture(t, {});
  const runtime = await makeRuntime();
  const path = join(outputDir, runtime.id, 'runtime.json');
  await rm(path);
  await mkdir(path);
  const pending = await runtime.close();
  assert.equal(pending.cleanup, 'pending');
  assert.equal(pending.reportPath, undefined);
  assert.equal(pending.evidence.lost, 0);
  assert.deepEqual(pending.pending.map(item => [item.kind, item.id, item.action, item.error?.code]), [
    ['report', runtime.id, 'save', 'REPORT_WRITE_FAILED'],
  ]);
  await rm(path, { recursive: true });
  const closed = await runtime.close();
  assert.equal(closed.cleanup, 'complete');
  assert.equal(closed.reportPath, path);
  const summary = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(summary.status, 'closed');
  assert.equal(summary.config.models.default.maxOutputTokens, 256);
  assert.equal(summary.config.waiting.hostDefaultMs, 60_000);
});


test('frozen host lifetime reaches actual provider requests and never replaces actual expiry', async t => {
  const requested = [];
  const sandbox = { timeoutSeconds: 5100 };
  const { makeRuntime } = await fixture(t, {
    onCreate(id, body) { requested.push({ id, timeout: body.timeout }); },
    createExpiresAt: id => id === 'fixture-1' ? '2099-01-03T08:00:00Z' : undefined,
  }, { sandbox });
  const runtime = await makeRuntime();
  t.after(() => runtime.close());
  sandbox.timeoutSeconds = 7200;
  await assert.rejects(runtime.spawn({ requestId: 'guest-override', profile: 'worker', timeoutSeconds: 7200 }), { code: 'INVALID_CONTRACT' });
  const first = await runtime.spawn({ requestId: 'configured', profile: 'worker' });
  const second = await runtime.spawn({ requestId: 'same-frozen-config', profile: 'worker' });
  const closed = await runtime.close();
  const rows = (await readFile(closed.evidence.path, 'utf8')).trim().split('\n').map(JSON.parse).filter(row => row.type === 'spawn');
  assert.deepEqual(requested.map(row => row.timeout), [5100, 5100]);
  assert.deepEqual(rows.filter(row => row.state === 'allocation-dispatched').map(row => row.timeoutSeconds), [5100, 5100]);
  assert.deepEqual(rows.filter(row => row.state === 'allocation-observed').map(row => [row.agentId, row.sandboxId, row.expiresAt]), [
    [first.id, requested[0].id, '2099-01-03T08:00:00.000Z'],
    [second.id, requested[1].id, null],
  ]);
});

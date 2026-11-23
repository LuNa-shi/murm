import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLifecycleProvider } from './fixtures/core-lifecycle-provider.js';

const explicitSecret = 'explicit-test-secret\$[]';
const upstreamSecret = 'test-upstream-bearer';
const profileValue = 'configured-profile-value';

async function fixture(t, hooks) {
  const provider = await createLifecycleProvider(t, hooks);
  provider.allowDeletion();
  const { createRuntime } = await import('@swarmenv/core');
  const { createPiOpenSandboxBackend } = await import('@swarmenv/core/backends/pi-opensandbox');
  const { ServiceRegistry } = await import('@swarmenv/core/services');
  const outputDir = await mkdtemp(join(tmpdir(), 'core-report-evidence-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  function makeOptions(directory = outputDir) {
    return {
      backend: createPiOpenSandboxBackend({
        sandbox: { lifecycleBaseUrl: provider.url, resourceLimits: { cpu: '1', memory: '1Gi' } },
        bridge: { host: '127.0.0.1', publicUrl: 'http://192.0.2.1:{port}' },
        modelGateway: { host: '127.0.0.1', advertiseHost: '192.0.2.1', requestTimeoutMs: 8000, maxOutputTokens: 256 },
        models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: 'http://127.0.0.1:1/v1/responses',
          headers: { authorization: `Bearer ${upstreamSecret}` } } } },
        isolation: { network: 'local-docker', disk: { bytes: 32 * 1024 ** 2, inodes: 2048 } },
      }),
      profiles: { worker: { image: 'fixture', model: 'default', prompt: 'fixture', writable: true, services: {},
        env: { CORE_REPORT_DATA: profileValue } } },
      services: new ServiceRegistry(), maxBots: 2, outputDir: directory,
    };
  }
  return { provider, outputDir, makeRuntime: directory => createRuntime(makeOptions(directory)) };
}

test('Runtime records identity, unknown input reconciliation, sanitised settled snapshots and independent configurations', { timeout: 8000 }, async t => {
  let workerToken, bridgeToken, modelToken, submitted;
  let prompts = 0;
  const { provider, makeRuntime } = await fixture(t, {
    onCreate(_id, body) { workerToken = body.env.SWARMENV_WORKER_TOKEN; },
    onStart(body) {
      bridgeToken = body.secret_env.SWARMENV_BRIDGE_TOKEN;
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
    const bot = await runtime.spawn({ requestId: 'child', parentId: parent.id, profile: 'worker', secretEnv: { PRIVATE_VALUE: explicitSecret } });
    const secrets = [explicitSecret, upstreamSecret, workerToken, bridgeToken, modelToken];
    assert.ok(secrets.every(secret => typeof secret === 'string' && secret.length));
    const options = { requestId: 'fixed-work' };
    const unknown = await runtime.send(bot.id, 'fixed input omitted from evidence', options);
    assert.equal(unknown.status, 'unknown');
    const recovered = await runtime.send(bot.id, 'fixed input omitted from evidence', options);
    assert.deepEqual(recovered, { inputId: unknown.inputId, status: 'accepted', disposition: 'started' });
    assert.equal(prompts, 1);
    const observed = [];
    const unsubscribe = runtime.onEvent(event => { if (event.botId === bot.id) observed.push(event); });
    const unsubFailure = runtime.onEvent(() => { throw Object.assign(new Error('local callback assertion'), { name: explicitSecret }); });
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
          if (row.botId === bot.id && row.type === 'settled') { clearTimeout(timer); stop(); resolve(row); }
        });
      });
      assert.equal(event.outcome, 'failed');
      assert.match(event.error.message, /model failed \[redacted\]/);
      const info = await runtime.get(bot.id);
      for (const secret of secrets) {
        assert.equal(JSON.stringify(observed).includes(secret), false);
        assert.equal(JSON.stringify(info).includes(secret), false);
      }
    } finally { unsubscribe(); unsubFailure(); }

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
    assert.ok(report.handlerErrorCount >= 2);
    assert.equal(report.evidence.lost, 0);
    assert.equal((await stat(receipt.evidence.path)).mode & 0o777, 0o600);
    const rows = evidence.trim().split('\n').map(line => JSON.parse(line));
    assert.ok(rows.every((row, index) => row.seq === index + 1 && row.runtimeId === runtime.id));
    assert.ok(rows.some(row => row.type === 'spawn' && row.state === 'registered' && row.botId === bot.id && row.parentId === parent.id));
    const inputs = rows.filter(row => row.type === 'input');
    assert.deepEqual(inputs.map(row => row.state), ['registered', 'dispatched', 'unknown', 'receipt-query', 'accepted']);
    assert.ok(inputs.every(row => row.inputId === unknown.inputId && row.requestId === 'fixed-work' && row.source === 'host'));
    assert.equal(inputs.find(row => row.state === 'unknown').reason, 'worker-transport');
    assert.ok(rows.some(row => row.type === 'event' && row.event.type === 'settled' && row.event.outcome === 'failed'));
    assert.ok(rows.some(row => row.type === 'subscriber-error' && row.name === '[redacted]'));
    assert.equal((await readFile(other.evidence.path, 'utf8')).includes(bot.id), false);
  } finally { await Promise.all([runtime.close(), siblingRun.close()]); }
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
  assert.deepEqual(receipt.bots, []);
  assert.equal(JSON.parse(await readFile(receipt.reportPath)).evidence.lost, receipt.evidence.lost);
});

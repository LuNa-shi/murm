import assert from 'node:assert/strict';
import { execFile, fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { isIPv4 } from 'node:net';
import { isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { checkLedger } from '../benchmarks/kubernetes/check-ledger.js';
import { openSandboxRuntimeKey } from '../src/core/sandbox/opensandbox-metadata.js';
import { ownedContainers } from './fixtures/core-runtime-containers.js';

const kubernetes = process.env.MURM_CORE_TEST_KUBERNETES === '1';
const execute = promisify(execFile);

async function listen(server: Server, host = '0.0.0.0') {
  server.listen(0, host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return address.port;
}

async function terminate(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, 'exit');
  child.kill('SIGKILL');
  await exit;
}

function next(child: ChildProcess) {
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Controller did not report before its deadline')); }, kubernetes ? 100_000 : 35_000);
    const exit = (code: number | null, signal: string | null) => { cleanup(); reject(new Error(`Controller exited: ${code ?? signal}`)); };
    function cleanup() {
      clearTimeout(timer);
      child.off('exit', exit);
      child.off('message', message);
    }
    function message(value: any) {
      cleanup();
      if (value.step === 'error') reject(Object.assign(new Error(JSON.stringify(value)), { code: value.code }));
      else resolve(value);
    }
    child.once('exit', exit);
    child.once('message', message);
  });
}

async function verifyKubernetesCleanup(runtimeId: string) {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const { stdout } = await execute('kubectl', ['-n', 'opensandbox', 'get', 'pods,batchsandboxes',
      '-l', `runtime_key=${openSandboxRuntimeKey(runtimeId)}`, '-o', 'json'], { timeout: 10_000 });
    const rows = JSON.parse(stdout).items;
    if (rows.length === 0) return;
    assert.ok(Date.now() < deadline, 'Kubernetes still reports Pods or BatchSandbox objects after close');
    await delay(1000);
  }
}

async function probeRecovery(retainExport: boolean) {
  const image = process.env.MURM_CORE_TEST_IMAGE;
  assert.match(image ?? '', kubernetes ? /@sha256:[a-f0-9]{64}$/ : /^sha256:[a-f0-9]{64}$/);
  const callbackHost = process.env.MURM_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1';
  const lifecycle = process.env.MURM_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1';
  const apiKey = process.env.MURM_CORE_TEST_API_KEY;
  const root = process.env.MURM_CORE_TEST_OUTPUT_DIR ?? resolve('experiments');
  let callbackPort = Number(process.env.MURM_CORE_TEST_CALLBACK_PORT);
  if (kubernetes) {
    assert.ok(isIPv4(callbackHost) && !!process.env.MURM_CORE_TEST_ADVERTISE_HOST);
    assert.ok(Number.isSafeInteger(callbackPort) && callbackPort > 0 && callbackPort <= 65_535);
    assert.ok(apiKey && process.env.MURM_CORE_TEST_LIFECYCLE_URL && process.env.MURM_CORE_TEST_OUTPUT_DIR && isAbsolute(root));
  } else {
    const reservation = createServer();
    callbackPort = await listen(reservation);
    await new Promise<void>(resolve => reservation.close(() => resolve()));
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const outputDir = await mkdtemp(join(root, 'runtime-recovery-'));
  let arrivals = 0;
  const gateway = createServer((req, res) => {
    arrivals++;
    req.resume();
    const item = { type: 'message', id: 'msg_local', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'RECOVERY SCRIPTED', annotations: [] }] };
    const response = { id: 'resp_local', object: 'response', status: 'completed', model: 'k3', output: [item],
      usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } };
    const event = (type: string, fields: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(event('response.created', { response: { ...response, status: 'in_progress', output: [] } }) +
      event('response.output_item.added', { output_index: 0, item: { ...item, content: [] } }) +
      event('response.output_text.delta', { output_index: 0, item_id: item.id, content_index: 0, delta: item.content[0].text }) +
      event('response.output_item.done', { output_index: 0, item }) + event('response.completed', { response }));
  });
  const modelPort = await listen(gateway, '127.0.0.1');
  const config = JSON.stringify({ callbackPort, modelPort, image, deploymentId: 'recovery-test', callbackHost, kubernetes });
  const fixture = fileURLToPath(new URL('./fixtures/runtime-recovery-controller.js', import.meta.url));
  const run = (mode: string, directory = '') => fork(fixture, [mode, outputDir, config, directory], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  let controller = run(retainExport ? 'retain' : 'start');
  let original: string | undefined;
  let complete = false;
  try {
    const opened = await next(controller);
    assert.equal(opened.step, 'runtime');
    const runtimeId: string = opened.runId;
    original = join(outputDir, runtimeId);
    const admitted = await next(controller);
    assert.equal(admitted.step, 'started');
    assert.equal(admitted.receipt.status, 'accepted');
    assert.equal(admitted.probe.requestId, 'before');
    assert.equal(arrivals, 1);
    if (!retainExport) {
      const contender = run('recover', original);
      try { await assert.rejects(next(contender), { code: 'LEDGER_UNAVAILABLE' }); }
      finally { await terminate(contender); }
    }
    let blocker: string | undefined;
    if (retainExport) {
      blocker = join(original, admitted.agentId, 'artifacts');
      await mkdir(join(original, admitted.agentId), { recursive: true, mode: 0o700 });
      await writeFile(blocker, 'intentionally obstruct this export', { flag: 'wx', mode: 0o600 });
      const response = next(controller);
      controller.send('close');
      const deferred = await response;
      assert.equal(deferred.step, 'retained');
      assert.equal(deferred.receipt.cleanup, 'pending');
      const pending = deferred.receipt.pending.find((item: any) => item.action === 'collect-artifacts');
      assert.ok(pending?.retention?.deadline && pending.retention.owner === runtimeId);
      assert.ok(Date.parse(pending.expiresAt) > Date.now());
    }
    await terminate(controller);
    if (blocker) await rm(blocker);
    controller = run(retainExport ? 'finish-close' : 'recover', original);
    const recovered = await next(controller);
    assert.equal(recovered.step, 'closed');
    if (!retainExport) {
      assert.equal(recovered.agentId, admitted.agentId);
      assert.deepEqual(recovered.replay, admitted.receipt);
      assert.equal(recovered.probe.requestId, 'after');
      assert.equal(Buffer.from(recovered.content.data, 'base64').toString(), 'survives controller restart\n');
    }
    assert.equal(await readFile(join(original, admitted.agentId, 'artifacts', 'files', 'recovered.txt'), 'utf8'), 'survives controller restart\n');
    assert.equal(recovered.receipt.cleanup, 'complete', JSON.stringify(recovered.receipt.pending));
    complete = true;
    assert.equal(arrivals, 1);
    if (kubernetes) await verifyKubernetesCleanup(runtimeId);
    else assert.deepEqual(await ownedContainers(runtimeId), []);
    assert.equal(checkLedger(original, runtimeId, 1).complete, true);
    const baseline = (await readFile(join(original, 'evidence.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    const allocations = baseline.filter(row => row.state === 'allocation-observed');
    assert.equal(allocations.length, 1);
    const provider = await fetch(`${lifecycle.replace(/\/$/, '')}/sandboxes/${allocations[0].sandboxId}`, {
      headers: apiKey ? { 'OPEN-SANDBOX-API-KEY': apiKey } : {}, signal: AbortSignal.timeout(5000),
    });
    await provider.body?.cancel();
    assert.equal(provider.status, 404);
  } finally {
    await terminate(controller);
    if (!complete && original) {
      controller = run('cleanup', original);
      try { await next(controller); } catch { /* the durable owner remains on disk */ }
      finally { await terminate(controller); }
    }
    gateway.closeAllConnections();
    await new Promise<void>(resolve => gateway.close(() => resolve()));
  }
}

const native = { skip: process.env.MURM_CORE_RECOVERY_REAL_TEST !== '1', timeout: kubernetes ? 300_000 : 115_000 };
test('one real Worker survives Controller SIGKILL, replays a known input and exports from the existing Sandbox', native,
  () => probeRecovery(false));
test('a later Controller finishes retained export without reopening a durably closing Run', native,
  () => probeRecovery(true));

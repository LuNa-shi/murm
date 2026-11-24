import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createRuntime } from '@swarmenv/core';
import { ServiceRegistry } from '@swarmenv/core/services';
import { createPiOpenSandboxBackend } from '@swarmenv/core/backends/pi-opensandbox';
import { streamResponse } from './fixtures/core-controlled-upstream.js';
import { ownedContainers } from './fixtures/core-runtime-containers.js';

async function upstream(commands) {
  let requests = 0;
  const results = new Map();
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      const user = body.input.filter(item => item.role === 'user').at(-1);
      const id = typeof user.content === 'string' ? user.content : user.content.map(item => item.text ?? '').join('');
      assert.ok(commands.has(id)); assert.ok(++requests <= 30);
      const callId = `workspace_${id}`;
      const output = body.input.find(item => item.type === 'function_call_output' && item.call_id === callId);
      let item;
      if (output) {
        assert.equal(output.output.trim(), 'PASS'); results.set(id, true);
        item = { type: 'message', id: `message_${requests}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `${id}_OK`, annotations: [] }] };
      } else item = { type: 'function_call', id: `fc_${callId}`, call_id: callId, name: 'bash', arguments: JSON.stringify({ command: commands.get(id), timeout: 15 }) };
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(streamResponse('k3', requests, item));
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'WORKSPACE_PROBE_FAILED' } }));
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}/v1/responses`, results,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

const python = source => `python3 - <<'WORKSPACE_PROBE'\n${source}\nprint('PASS')\nWORKSPACE_PROBE`;

test('native running snapshots preserve random bytes and scoped shared workspaces enforce readonly mounts and private control state', {
  skip: process.env.SWARMENV_CORE_WORKSPACE_REAL_TEST !== '1', timeout: 240_000,
}, async t => {
  const image = process.env.SWARMENV_CORE_TEST_IMAGE; assert.ok(image);
  const bytes = randomBytes(64);
  const commands = new Map([
    ['write', python(`import pathlib,time\npathlib.Path('random.bin').write_bytes(bytes.fromhex('${bytes.toString('hex')}'))\npathlib.Path('text.txt').write_text('snapshot λ\\n')\npathlib.Path('ready').write_text('ready')\ntime.sleep(4)`)],
    ['read', python(`import pathlib\nassert pathlib.Path('random.bin').read_bytes().hex()=='${bytes.toString('hex')}'\nassert pathlib.Path('text.txt').read_text()=='snapshot λ\\n'\ntry:\n pathlib.Path('forbidden').write_text('bad')\n raise AssertionError('readonly mount was writable')\nexcept OSError as error:\n assert error.errno in (13,30)\nassert not pathlib.Path('/workspace/runtime/parent-only').exists()`)],
    ['mark', python(`import pathlib\npathlib.Path('/workspace/runtime/parent-only').write_text('private')\npathlib.Path('shared').write_text('visible')`)],
    ['isolated', python(`import pathlib\nassert list(pathlib.Path('.').iterdir())==[]\nassert not pathlib.Path('/workspace/runtime/parent-only').exists()\npathlib.Path('private').write_text('own')`)],
    ['continue', python(`import pathlib\nassert pathlib.Path('shared').read_text()=='visible'\nassert pathlib.Path('/workspace/runtime/parent-only').read_text()=='private'\npathlib.Path('after-peer-stop').write_text('continued')`)],
    ['frozen', python(`import pathlib\nassert pathlib.Path('random.bin').read_bytes().hex()=='${bytes.toString('hex')}'\nassert not pathlib.Path('after-peer-stop').exists()\npathlib.Path('only-frozen').write_text('private copy')`)],
  ]);
  const provider = await upstream(commands); t.after(() => provider.close());
  const outputDir = join(process.cwd(), 'experiments', `core-workspace-${Date.now()}`);
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const runtimes = [];
  const report = { image, snapshots: [], cleanup: [] };
  t.after(async () => {
    for (const runtime of runtimes) {
      const receipt = await runtime.close({ timeoutMs: 30_000 });
      report.cleanup.push({ runtimeId: runtime.id, cleanup: receipt.cleanup, containers: await ownedContainers(runtime.id) });
      assert.equal(receipt.cleanup, 'complete'); assert.deepEqual(await ownedContainers(runtime.id), []);
    }
    await writeFile(join(outputDir, 'receipt.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  });
  const host = process.env.SWARMENV_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1';
  async function runtime() {
    const result = await createRuntime({ backend: createPiOpenSandboxBackend({
      sandbox: { lifecycleBaseUrl: process.env.SWARMENV_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1', endpointHost: '127.0.0.1', resourceLimits: { cpu: '1', memory: '1Gi' }, commandTimeoutMs: 20_000 },
      bridge: { host: '0.0.0.0', publicUrl: `http://${host}:{port}` },
      modelGateway: { host: '0.0.0.0', advertiseHost: host, requestTimeoutMs: 30_000, maxOutputTokens: 128 },
      models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: provider.url, headers: {} } } },
      isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } },
    }), profiles: { worker: { prompt: 'Execute the fixed probe.', model: 'default', image, writable: true, services: {} } }, services: new ServiceRegistry(), maxBots: 4, outputDir });
    runtimes.push(result); return result;
  }
  async function turn(runtime, bot, id) {
    let resolve;
    const settled = new Promise(done => { resolve = done; });
    const unsubscribe = runtime.onEvent(event => { if (event.botId === bot.id && event.type === 'settled') resolve(event); });
    const timer = setTimeout(() => resolve({ outcome: 'timeout' }), 25_000);
    try {
      assert.equal((await runtime.send(bot.id, id, { requestId: id, mode: 'followUp' })).status, 'accepted');
      const event = await settled; assert.equal(event.outcome, 'completed'); assert.equal(event.output, `${id}_OK`);
    } finally { clearTimeout(timer); unsubscribe(); }
  }
  const a = await runtime();
  const writer = await a.spawn({ requestId: 'writer', profile: 'worker', workspace: { id: 'shared', mode: 'read-write' } });
  await turn(a, writer, 'mark');
  const reader = await a.spawn({ requestId: 'reader', profile: 'worker', workspace: { id: 'shared', mode: 'read-only' } });
  const running = turn(a, writer, 'write');
  let capture;
  for (let index = 0; index < 40; index++) {
    try { capture = await a.files.snapshot(reader.id, { requestId: `ready-${index}`, paths: ['ready', 'random.bin', 'text.txt'] }); break; }
    catch (error) { if (!['INVALID_CONTRACT', 'WORKSPACE_BUSY'].includes(error.code)) throw error; await delay(100); }
  }
  assert.ok(capture); assert.equal((await a.get(writer.id)).status, 'running');
  assert.deepEqual(Buffer.from(capture.files['random.bin'].data, 'base64'), bytes);
  assert.equal(Buffer.from(capture.files['text.txt'].data, 'base64').toString(), 'snapshot λ\n');
  report.snapshots.push({ version: capture.version, digest: capture.digest, binarySha256: createHash('sha256').update(bytes).digest('hex') });
  assert.deepEqual(await a.files.snapshot(reader.id, { requestId: capture.requestId, paths: ['ready', 'random.bin', 'text.txt'] }), capture);
  await running;
  await turn(a, reader, 'read');
  const frozen = await a.spawn({ requestId: 'frozen', profile: 'worker', workspace: { mode: 'frozen-copy', files: capture.files } });
  await a.stop(reader.id); await turn(a, writer, 'continue'); await turn(a, frozen, 'frozen');
  const b = await runtime();
  const other = await b.spawn({ requestId: 'same-name', profile: 'worker', workspace: { id: 'shared', mode: 'read-write' } });
  await turn(b, other, 'isolated');
  assert.equal(provider.results.size, commands.size);
});

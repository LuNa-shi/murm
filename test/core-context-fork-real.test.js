import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { streamResponse } from './fixtures/core-controlled-upstream.js';
import { ownedContainers } from './fixtures/core-runtime-containers.js';

// Uses real Pi, Worker and OpenSandbox with a loopback model. No paid provider.
test('Core Context Fork inherits a live native Session with isolated credentials and workDir', {
  skip: process.env.SWARMENV_CORE_FORK_REAL_TEST !== '1' && 'Real OpenSandbox Context Fork probe requires opt-in',
  timeout: 180000,
}, async t => {
  const { createRuntime } = await import('@swarmenv/core');
  const { createPiOpenSandboxBackend } = await import('@swarmenv/core/backends/pi-opensandbox');
  const { ServiceRegistry } = await import('@swarmenv/core/services');
  const image = process.env.SWARMENV_CORE_TEST_IMAGE;
  assert.ok(image);
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    requests.push(body);
    const contents = JSON.stringify(body.input);
    const item = requests.length === 1
      ? { type: 'function_call', id: 'fc_parent', call_id: 'parent_tool', name: 'bash',
        arguments: JSON.stringify({ command: 'echo READY > fork-ready.txt; sleep 8; echo PARENT_FILE > parent-only.txt', timeout: 15 }) }
      : { type: 'message', id: `message_${requests.length}`, role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: contents.includes('CHILD_CONTINUE') ? 'CHILD_DONE' : 'PARENT_DONE', annotations: [] }] };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(streamResponse('k3', requests.length, item));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let runtime;
  t.after(async () => {
    if (runtime) {
      assert.equal((await runtime.close({ timeoutMs: 30000 })).cleanup, 'complete');
      assert.deepEqual(await ownedContainers(runtime.id), []);
    }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const outputDir = join(process.cwd(), 'experiments', `core-fork-${Date.now()}`);
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  runtime = await createRuntime({
    backend: createPiOpenSandboxBackend({
      sandbox: { lifecycleBaseUrl: process.env.SWARMENV_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
        endpointHost: process.env.SWARMENV_CORE_TEST_ENDPOINT_HOST ?? '127.0.0.1', apiKey: process.env.SWARMENV_CORE_TEST_API_KEY,
        commandTimeoutMs: 30000 },
      bridge: { host: '0.0.0.0', publicUrl: process.env.SWARMENV_CORE_TEST_BRIDGE_URL ?? 'http://172.17.0.1:{port}' },
      modelGateway: { host: '0.0.0.0', advertiseHost: process.env.SWARMENV_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1', requestTimeoutMs: 20000, maxOutputTokens: 128 },
      models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: `http://127.0.0.1:${server.address().port}/v1/responses`, headers: {} } } },
      isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } },
    }),
    profiles: { worker: { prompt: 'Perform the requested steps.', model: 'default', image, writable: true, services: {} } },
    services: new ServiceRegistry(), maxBots: 2, outputDir,
  });
  const events = [];
  runtime.onEvent(event => events.push(event));
  const parent = await runtime.spawn({ profile: 'worker', requestId: 'parent', secretEnv: { PARENT_CREDENTIAL: 'PARENT_PRIVATE_TOKEN' } });
  const [parentContainer] = await ownedContainers(runtime.id);
  const docker = (...args) => promisify(execFile)('docker', ['exec', ...args], { timeout: 5000 });
  await runtime.send(parent.id, 'FORK_MARKER PARENT_PRIVATE_TOKEN', { requestId: 'parent-input' });
  const readyDeadline = Date.now() + 20000;
  while (!(await docker(parentContainer, 'test', '-f', '/workspace/project/fork-ready.txt').then(() => true, () => false))) {
    assert.ok(Date.now() < readyDeadline, 'Parent tool did not start');
    await delay(50);
  }
  assert.equal((await runtime.get(parent.id)).status, 'running');
  const child = await runtime.spawn({ profile: 'worker', forkFrom: parent.id, requestId: 'fork' });
  assert.deepEqual(await runtime.spawn({ profile: 'worker', forkFrom: parent.id, requestId: 'fork' }), child);
  await runtime.send(child.id, 'CHILD_CONTINUE', { requestId: 'child-input' });
  const deadline = Date.now() + 30000;
  while (!events.some(event => event.botId === child.id && event.type === 'settled') ||
         !events.some(event => event.botId === parent.id && event.type === 'settled')) {
    assert.ok(Date.now() < deadline, 'Forked Bots did not settle');
    await delay(50);
  }
  const childRequest = requests.find(request => JSON.stringify(request.input).includes('CHILD_CONTINUE'));
  assert.ok(JSON.stringify(childRequest.input).includes('FORK_MARKER'));
  assert.ok(!JSON.stringify(childRequest.input).includes('PARENT_PRIVATE_TOKEN'));
  assert.ok(!childRequest.input.some(entry => entry.type === 'function_call'));
  const parentRequest = requests.find(request => request.input.some(entry => entry.type === 'function_call_output'));
  assert.ok(parentRequest);
  assert.ok(!JSON.stringify(parentRequest.input).includes('CHILD_CONTINUE'));
  const childContainer = (await ownedContainers(runtime.id)).find(id => id !== parentContainer);
  assert.equal((await docker(parentContainer, 'cat', '/workspace/project/parent-only.txt')).stdout, 'PARENT_FILE\n');
  await docker(childContainer, 'test', '!', '-e', '/workspace/project/parent-only.txt');
  assert.equal(events.find(event => event.botId === child.id && event.type === 'settled').outcome, 'completed');
});

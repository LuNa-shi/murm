import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { WorkerClient } from '../src/core/sandbox/worker-client.js';
import { WORKER_PROTOCOL } from '../src/core/worker-image.js';
import { fileProtocol, fileTransferProtocol } from '../src/core/files/core-file-seed.js';
import { createWorkerControl, WORKER_CONTROL_PROTOCOL } from '../src/core/worker-control.js';
import { createWorkerEventStream, WORKER_EVENT_PROTOCOL } from '../src/core/worker-event-stream.js';

async function fixture(t) {
  const events = createWorkerEventStream({ workerInstanceId: 'worker', streamEpoch: 'stream' });
  const controls = createWorkerControl({ workerInstanceId: 'worker', initialEpoch: 1 });
  const requests: { path: string; epoch: string | string[] | undefined }[] = [];
  let loseTakeoverResponse = false;
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== 'Bearer ingress-route' || request.headers['x-murm-worker-token'] !== 'private-worker') {
      response.writeHead(401).end('{}'); return;
    }
    const path = new URL(request.url!, 'http://fixture').pathname;
    requests.push({ path, epoch: request.headers['x-murm-controller-epoch'] });
    const send = value => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ result: value }));
    try {
      if (path === '/prefix/worker/core/contract') {
        send({ worker_protocol: WORKER_PROTOCOL, file_protocol: fileProtocol, file_transfer: fileTransferProtocol,
          event_protocol: WORKER_EVENT_PROTOCOL, control_protocol: WORKER_CONTROL_PROTOCOL,
          worker_instance_id: 'worker', stream_epoch: 'stream', controller_epoch: controls.controllerEpoch,
          executor_started: true, executor_launched: true, execution_stopped: false });
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString());
      if (path.endsWith('/core/control/takeover')) {
        const receipt = await controls.takeover(input);
        if (loseTakeoverResponse) { loseTakeoverResponse = false; response.destroy(); return; }
        send(receipt); return;
      }
      controls.assertEpoch(Number(request.headers['x-murm-controller-epoch']));
      if (path.endsWith('/core/events')) {
        const owner = new AbortController();
        response.on('close', () => owner.abort());
        send(await events.poll(input, owner.signal)); return;
      }
      if (path.endsWith('/rpc')) {
        send(await controls.run(Number(request.headers['x-murm-controller-epoch']), async () => ({ response: { success: true }, records: [] })));
        return;
      }
      throw new Error('Unrecognized fixture route');
    } catch (error: any) {
      if (!response.destroyed) response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: error.message, code: error.code }));
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => { events.close(); server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address() as { port: number };
  const executions = new Map<string, any>([['agent', { sandboxId: 'sandbox' }]]);
  const client = new WorkerClient({ executions, projectInstallReceipts: new Map(),
    resolveEndpoint: async () => ({ url: `http://127.0.0.1:${address.port}/prefix/worker`, headers: { authorization: 'Bearer ingress-route' } }),
    checkAgentBoundary: async () => ({}), fetch, requireManagementAuth: true, useServerProxy: false,
    workerPort: 44100, commandTimeoutMs: 1000, logger: null, now: Date.now });
  const attach = (epoch = 1) => client.attach('agent', { workerToken: 'private-worker', workerInstanceId: 'worker', streamEpoch: 'stream', controllerEpoch: epoch });
  return { client, executions, controls, events, requests, attach, loseTakeover() { loseTakeoverResponse = true; } };
}

test('WorkerClient recovers the original identity and preserves ingress authentication and path prefix', async t => {
  const { client, events, requests, attach } = await fixture(t);
  const identity = await attach();
  assert.equal(identity.executorStarted, true);
  assert.equal(identity.workerInstanceId, 'worker');
  assert.equal(identity.observedControllerEpoch, 1);
  events.publish({ type: 'probe', traceId: 'probe-1' });
  const page = await client.readEvents('agent', { workerInstanceId: 'worker', streamEpoch: 'stream', afterSequence: 0, waitMs: 0 });
  assert.equal(page.nextSequence, 1);
  assert.deepEqual(requests.map(row => row.path), ['/prefix/worker/core/contract', '/prefix/worker/core/events']);
  assert.equal(requests.at(-1).epoch, '1');
});

test('WorkerClient retries an uncertain takeover using the original receipt and fences old RPC headers', async t => {
  const { client, executions, controls, attach, loseTakeover } = await fixture(t);
  await attach();
  const request = { requestId: 'recover-2', workerInstanceId: 'worker', expectedEpoch: 1, nextEpoch: 2 };
  loseTakeover();
  await assert.rejects(client.takeover('agent', request));
  assert.equal(controls.controllerEpoch, 2);
  assert.equal(executions.get('agent').agent.controllerEpoch, 1);
  await assert.rejects(client.agentRpc('agent', { type: 'get_rpc_result', id: 'known' }, { timeoutMs: 100 }));
  assert.equal((await client.takeover('agent', request)).controllerEpoch, 2);
  assert.equal(executions.get('agent').agent.controllerEpoch, 2);
  assert.equal((await client.agentRpc('agent', { type: 'get_rpc_result', id: 'known' }, { timeoutMs: 100 })).response.success, true);
});

test('attach rejects a replacement Worker and retains the original recovery responsibility', async t => {
  const { client, executions } = await fixture(t);
  await assert.rejects(client.attach('agent', { workerToken: 'private-worker', workerInstanceId: 'replaced', streamEpoch: 'stream', controllerEpoch: 1 }), { code: 'AGENT_STARTUP_CONTRACT' });
  assert.equal(executions.get('agent').sandboxId, 'sandbox');
  assert.equal(executions.get('agent').agent, undefined);
});

test('a pending event transport has one owner and cancellation permits a later read', async t => {
  const { client, events, attach } = await fixture(t);
  await attach();
  const cursor = { workerInstanceId: 'worker', streamEpoch: 'stream', afterSequence: 0, waitMs: 1000 };
  const owner = new AbortController();
  const waiting = assert.rejects(client.readEvents('agent', { ...cursor, signal: owner.signal }));
  await assert.rejects(client.readEvents('agent', cursor), { code: 'NOT_ALLOWED' });
  owner.abort();
  await waiting;
  const page = await client.readEvents('agent', { ...cursor, waitMs: 0 });
  assert.equal(page.nextSequence, 0);
  events.close();
});

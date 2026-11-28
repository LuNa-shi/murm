import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { callCoordinatorPeer } from '../examples/taskpool/deploy/service-hosts/coordinator-peer-client.js';

async function peer(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { url: `http://127.0.0.1:${server.address().port}`, token: 'controlled-private-peer-token', actorRef: 'service:test', operation: 'work', input: { revision: '0.1' } };
}

test('private peer preserves authenticated JSON and waits for delayed response headers', async t => {
  const input = await peer(t, async (request, response) => {
    assert.equal(request.url, '/v1/work');
    assert.equal(request.headers.authorization, 'Bearer controlled-private-peer-token');
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    assert.equal(payload.role, 'recovery');
    assert.deepEqual(payload.input, { revision: '0.1' });
    setTimeout(() => response.end(JSON.stringify({ ok: true, result: { checked: true } })), 100);
  });
  assert.deepEqual(await callCoordinatorPeer({ ...input, timeoutMs: 1000 }), { checked: true });
});

for (const headersSent of [false, true]) test(`private peer deadline closes a pending ${headersSent ? 'body' : 'header'} response`, async t => {
  let closed;
  const socketClosed = new Promise(resolve => { closed = resolve; });
  const input = await peer(t, (request, response) => {
    request.socket.once('close', closed);
    if (headersSent) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"ok":true,');
    }
  });
  await assert.rejects(callCoordinatorPeer({ ...input, timeoutMs: 100 }), { code: 'SERVICE_UNAVAILABLE', retryable: true });
  await socketClosed;
});

test('private peer preserves structured nonretryable domain errors', async t => {
  const input = await peer(t, (request, response) => {
    response.writeHead(409, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: false, error: { code: 'CONFLICT', message: 'Fixed revision changed', details: { revision: '0.2' }, retryable: false } }));
  });
  await assert.rejects(callCoordinatorPeer(input), { code: 'CONFLICT', retryable: false, details: { revision: '0.2' } });
});

test('private peer honors a configured header wait beyond the native fetch five-minute limit', {
  skip: process.env.MURM_TEST_LONG_PEER !== 'true', timeout: 340_000,
}, async t => {
  const input = await peer(t, (request, response) => {
    const timer = setTimeout(() => response.end(JSON.stringify({ ok: true, result: 'long-check-complete' })), 310_000);
    t.after(() => clearTimeout(timer));
  });
  assert.equal(await callCoordinatorPeer({ ...input, timeoutMs: 330_000 }), 'long-check-complete');
});

test('private peer rejects invalid deadlines before opening a connection', async () => {
  for (const timeoutMs of [0, -1, 1.5, NaN, Infinity, 2_147_483_648]) {
    await assert.rejects(callCoordinatorPeer({ url: 'http://127.0.0.1:1', timeoutMs }), /positive timer-safe integer/);
  }
});

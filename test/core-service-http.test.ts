import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createHttpJsonAdapter } from '../src/core/services.js';
import { notesManifest, setup } from './fixtures/core-notes-service.js';

test('authenticated HTTP Service receives the same trusted caller as in-process dispatch', async t => {
  const calls = [];
  let saved;
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer host-test-only');
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push({ route: request.url, ...body });
    if (request.url === '/put') saved = { ...body.input, author: body.caller.agentId };
    response.end(JSON.stringify({ ok: true, result: saved ?? null }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const manifest = notesManifest();
  manifest.endpoint = { transport: 'http-json', url: `http://127.0.0.1:${server.address().port}` };
  for (const capability of manifest.capabilities) capability.path = '/' + capability.operation;
  const { call } = await setup(t, createHttpJsonAdapter({ token: 'host-test-only' }), { manifest });
  assert.equal((await call('put', { key: 'one', text: 'fixed' }, { caller: { agentId: 'forged' } })).result.author, 'agent-one');
  assert.deepEqual((await call('get', { key: 'one' })).result, saved);
  assert.equal(calls.length, 2);
  for (const request of calls) {
    assert.deepEqual(request.caller, { runtimeId: 'run-one', agentId: 'agent-one', profile: 'writer', binding: 'notes-account' });
    assert.deepEqual(request.envelope, { operation_id: 'fixed-request' });
  }
});

test('HTTP Service transport failures, timeout and bad output remain distinct without write retries', async t => {
  let count = 0;
  const server = createServer(async (request, response) => {
    count++;
    if (request.url === '/slow') return;
    if (request.url === '/redirect') { response.writeHead(302, { location: '/effect' }); response.end(); return; }
    response.end(JSON.stringify({ ok: true, result: { unexpected: true } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  for (const [route, code] of [['/bad', 'SERVICE_OUTPUT_INVALID'], ['/slow', 'SERVICE_TIMEOUT'], ['/redirect', 'SERVICE_UNAVAILABLE']]) {
    const manifest = notesManifest();
    manifest.endpoint = { transport: 'http-json', url: `http://127.0.0.1:${server.address().port}` };
    manifest.capabilities[0].path = route;
    const { call } = await setup(t, createHttpJsonAdapter({ timeoutMs: 30 }), { manifest });
    const before = count;
    const result = await call('put', { key: 'one', text: 'fixed' });
    assert.equal(result.error.code, code);
    assert.equal(result.error.details.operation_id, 'fixed-request');
    assert.equal(count, before + 1);
  }
});

test('authorized HTTP Service named constructor receives the same absent binding as in-process', async t => {
  let caller;
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    caller = JSON.parse(Buffer.concat(chunks).toString()).caller;
    response.end(JSON.stringify({ ok: true, result: null }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const manifest = notesManifest('constructor');
  manifest.endpoint = { transport: 'http-json', url: `http://127.0.0.1:${server.address().port}` };
  const { agent, call } = await setup(t, createHttpJsonAdapter(), { manifest });
  agent.services = { constructor: ['get'] }; agent.bindings = {};
  assert.equal((await call('get', { key: 'one' }, { service_id: 'constructor' })).ok, true);
  assert.deepEqual(caller, { runtimeId: 'run-one', agentId: 'agent-one', profile: 'writer' });
});

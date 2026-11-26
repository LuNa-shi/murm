import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { setup, notesManifest } from './fixtures/core-notes-service.js';

test('host Service capability timeout permits a same-turn wait beyond the Bridge default', async t => {
  const manifest = notesManifest();
  manifest.capabilities[1].timeout_ms = 250;
  const { call } = await setup(t, { async invoke({ signal, assertAuthorized }) {
    await delay(60, undefined, { signal });
    assertAuthorized();
    return { key: 'one', text: 'delivered', author: 'external-service' };
  } }, { manifest, bridge: { serviceTimeoutMs: 20 } });
  const response = await call('get', { key: 'one' });
  assert.equal(response.ok, true);
  assert.equal(response.result.text, 'delivered');
});

test('disconnecting a waiting Agent request cancels the Service and revokes late mutation authority', { timeout: 2000 }, async t => {
  let started, cancelled;
  const ready = new Promise(resolve => { started = resolve; });
  const aborted = new Promise(resolve => { cancelled = resolve; });
  let authorize;
  const { bridge, credentials } = await setup(t, { invoke({ signal, assertAuthorized }) {
    authorize = assertAuthorized;
    signal.addEventListener('abort', cancelled, { once: true });
    started();
    return new Promise(() => {});
  } });
  const controller = new AbortController();
  const request = fetch(bridge.publicUrl + '/call', { method: 'POST', signal: controller.signal,
    headers: { authorization: `Bearer ${credentials.secretEnvironment.MURM_BRIDGE_TOKEN}` },
    body: JSON.stringify({ service_id: 'notes', operation: 'get', operation_id: 'wait-one', payload: { key: 'one' } }) });
  await ready;
  controller.abort();
  await assert.rejects(request);
  await aborted;
  assert.throws(authorize, { code: 'NOT_ALLOWED' });
});

test('external mailbox owns same-turn wait, tree directory and scope policy across trusted Agent callers', { timeout: 2000 }, async t => {
  const { createCoreBridge } = await import('../src/core/bridge.js');
  const { ServiceRegistry, snapshotServiceRegistry } = await import('../src/core/services.js');
  const messages = new Map();
  const pending = new Map();
  const directory = new Map([['parent', { path: '/team', parentId: null }], ['child', { path: '/team/child', parentId: 'parent' }], ['foreign', { path: '/other', parentId: null }]]);
  const manifest = notesManifest('mail');
  manifest.capabilities = ['directory', 'wait', 'publish'].map(operation => ({ name: operation, operation,
    description: operation, side_effect: operation === 'publish' ? 'write' : 'read', idempotent: true,
    timeout_ms: 1000, help: { when: operation }, errors: [{ code: 'NOT_ALLOWED', retryable: false }],
    input_schema: { type: 'object' }, output_schema: {} }));
  const registry = new ServiceRegistry();
  registry.registerService({ manifest, adapter: { invoke({ capability, input, caller, signal, assertAuthorized }) {
    const own = directory.get(caller.agentId);
    if (capability.operation === 'directory') return [...directory].filter(([, node]) => node.path.startsWith(own.path)).map(([agentId, node]) => ({ agentId, ...node }));
    if (capability.operation === 'publish') {
      if (!directory.get(input.to)?.path.startsWith(own.path)) throw Object.assign(new Error('Outside caller subtree'), { code: 'NOT_ALLOWED' });
      assertAuthorized();
      const message = { from: caller.agentId, text: input.text };
      messages.set(input.to, message);
      pending.get(input.to)?.(message);
      return { delivered: true };
    }
    const existing = messages.get(caller.agentId);
    if (existing) return existing;
    return new Promise((resolve, reject) => {
      const settle = message => { pending.delete(caller.agentId); signal.removeEventListener('abort', cancel); assertAuthorized(); resolve(message); };
      const cancel = () => { pending.delete(caller.agentId); reject(new Error('Wait cancelled')); };
      signal.addEventListener('abort', cancel, { once: true });
      pending.set(caller.agentId, settle);
    });
  } } });
  const bridge = await createCoreBridge({ runtimeId: 'mailbox-run', configuration: { host: '127.0.0.1', publicUrl: 'http://127.0.0.1:{port}' },
    registrations: snapshotServiceRegistry(registry), getAgent: id => directory.has(id) ? { profile: 'mail-user', status: 'running', services: { mail: ['directory', 'wait', 'publish'] } } : null });
  t.after(() => bridge.close());
  const tokens = Object.fromEntries([...directory.keys()].map(id => [id, bridge.credentialsForAgent(id).secretEnvironment.MURM_BRIDGE_TOKEN]));
  const call = async (agentId, operation, payload = {}) => (await fetch(bridge.publicUrl + '/call', { method: 'POST',
    headers: { authorization: `Bearer ${tokens[agentId]}` }, body: JSON.stringify({ service_id: 'mail', operation, operation_id: `${agentId}:${operation}`, payload }) })).json();
  assert.deepEqual((await call('parent', 'directory')).result.map(item => item.agentId), ['parent', 'child']);
  const waiting = call('child', 'wait');
  while (!pending.has('child')) await delay(1);
  assert.equal((await call('foreign', 'publish', { to: 'child', text: 'forbidden' })).error.code, 'NOT_ALLOWED');
  assert.equal((await call('parent', 'publish', { to: 'child', text: 'continue same turn' })).ok, true);
  assert.deepEqual((await waiting).result, { from: 'parent', text: 'continue same turn' });
});

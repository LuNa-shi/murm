import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ServiceRegistry } from '@murm/core/services';
import { transport } from './fixtures/core-agent-service-backend.js';

const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === './opensandbox-backend.js' && context.parentURL?.endsWith('/src/core/index.js')) {
    return { url: new URL('./fixtures/core-agent-service-backend.js', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
} });
const { createRuntime } = await import('@murm/core');
hooks.deregister();

const initial = { prompt: 'Initial Worker', model: 'default', image: 'test', writable: true, services: {} };

async function setup(t) {
  transport.reset();
  const outputDir = await mkdtemp(join(tmpdir(), 'murm-dynamic-registry-'));
  const runtime = await createRuntime({
    backend: {}, services: new ServiceRegistry(), profiles: { worker: initial }, maxAgents: 3, outputDir,
  });
  t.after(async () => {
    await runtime.close();
    await rm(outputDir, { recursive: true, force: true });
  });
  return runtime;
}

test('a Runtime registers a copied Profile once and spawns it through the same live directory', async t => {
  const runtime = await setup(t);
  const worker = await runtime.spawn({ profile: 'worker', requestId: 'worker' });
  const changes = runtime.observe();
  t.after(() => changes.cancel());
  assert.deepEqual(changes.snapshot.management.profiles.map(entry => entry.id), ['worker']);

  const profile = { ...initial, prompt: 'Review delivered orders' };
  const input = { id: 'orders-checker', requestId: 'register-checker', profile };
  const [first, duplicate] = await Promise.all([
    runtime.profiles.register(input),
    runtime.profiles.register(structuredClone(input)),
  ]);
  assert.deepEqual(duplicate, first);
  assert.match(first.digest, /^[a-f0-9]{64}$/);
  profile.prompt = 'mutated caller object';
  await assert.rejects(runtime.profiles.register(input), { code: 'CONFLICT' });
  await assert.rejects(runtime.profiles.register({ ...input, requestId: 'replace' }), { code: 'CONFLICT' });
  await assert.rejects(runtime.profiles.register({
    id: 'wrong-model', requestId: 'bad', profile: { ...initial, model: 'unknown' },
  }), { code: 'INVALID_CONTRACT' });
  const { value: observed } = await changes.events.next();
  assert.equal(observed.type, 'management');
  assert.equal(observed.change.operation, 'profile.register');
  assert.equal(observed.change.sequence, first.sequence);
  assert.equal((await runtime.profiles.get('orders-checker')).profile.prompt, 'Review delivered orders');
  assert.deepEqual((await runtime.profiles.list()).map(entry => entry.id), ['worker', 'orders-checker']);

  const checker = await runtime.spawn({ profile: 'orders-checker', requestId: 'checker' });
  assert.equal(transport.spawns.get(checker.id).profile.prompt, 'Review delivered orders');
  assert.deepEqual(await runtime.get(worker.id), worker);

  const closed = await runtime.close();
  assert.equal(closed.cleanup, 'complete');
  assert.deepEqual(await runtime.profiles.register({ ...input, profile: { ...initial, prompt: 'Review delivered orders' } }), first);
  await assert.rejects(runtime.profiles.register({ id: 'late', requestId: 'late', profile: initial }), { code: 'NOT_ALLOWED' });
  const rows = (await readFile(closed.evidence.path, 'utf8')).trim().split('\n').map(row => JSON.parse(row));
  const registration = rows.filter(row => row.type === 'management');
  assert.equal(registration.length, 1);
  assert.equal(registration[0].requestId, 'register-checker');
  assert.equal(registration[0].definition.digest, first.digest);
  assert.equal(rows.find(row => row.type === 'spawn' && row.agentId === checker.id && row.state === 'registered').profileDigest, first.digest);
});

const checkManifest = {
  id: 'check-orders', title: 'Orders', purpose: 'Checks orders', provider_version: '1', contract_version: '2',
  endpoint: { transport: 'in-process' },
  capabilities: [{
    name: 'check', operation: 'check', description: 'Check', side_effect: 'read', idempotent: true,
    help: { when: 'Checking a candidate' }, input_schema: { type: 'object' },
    output_schema: { type: 'boolean' }, errors: [],
  }],
};

async function call(agentId, operation, payload = {}, service_id) {
  const { secretEnvironment } = transport.spawns.get(agentId).credentials;
  const response = await fetch(transport.url + '/call', {
    method: 'POST', headers: { authorization: `Bearer ${secretEnvironment.MURM_BRIDGE_TOKEN}` },
    body: JSON.stringify({ service_id, operation, operation_id: 'fixture-call', payload }),
  });
  return response.json();
}

test('service retirement hides the service immediately and reconciles original drain and export', async t => {
  const runtime = await setup(t);
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  let exports = 0;
  const registration = {
    requestId: 'deploy', deploymentRef: 'fixture', implementationId: 'fixture-v1', ownership: 'run',
    registration: { manifest: structuredClone(checkManifest), adapter: {
      async invoke(request) {
        started.resolve();
        await release.promise;
        request.assertAuthorized();
        return true;
      },
      exportState() { exports++; return { check: 'saved' }; },
    } },
  };
  const registered = await runtime.services.register(registration);
  assert.deepEqual(await runtime.services.register(registration), registered);
  await assert.rejects(runtime.services.register({ ...registration, implementationId: 'wrong' }), { code: 'CONFLICT' });
  assert.equal(registered.state, 'ready');

  const profile = { ...initial, services: { 'check-orders': ['check'] } };
  await runtime.profiles.register({ id: 'checker', requestId: 'checker-profile', profile });
  const checker = await runtime.spawn({ profile: 'checker', requestId: 'checker' });
  const work = call(checker.id, 'check', {}, 'check-orders');
  await started.promise;
  const request = { serviceId: 'check-orders', requestId: 'retire', timeoutMs: 5 };
  const pending = await runtime.services.retire(request);
  assert.equal(pending.state, 'retiring');
  assert.equal(exports, 0);
  assert.equal((await call(checker.id, 'list_services')).result.services.length, 0);
  assert.equal((await call(checker.id, 'check', {}, 'check-orders')).error.code, 'NOT_ALLOWED');
  await assert.rejects(runtime.spawn({ profile: 'checker', requestId: 'late-checker' }), { code: 'NOT_ALLOWED' });
  assert.equal((await runtime.spawn({ profile: 'checker', requestId: 'checker' })).id, checker.id);

  release.resolve();
  assert.deepEqual(await work, { ok: true, result: true });
  const retired = await runtime.services.retire({ ...request, timeoutMs: 5000 });
  assert.equal(retired.state, 'retired');
  assert.equal(exports, 1);
  assert.deepEqual(await runtime.services.get('check-orders'), retired);
  await assert.rejects(runtime.services.register({ ...registration, requestId: 'replace' }), { code: 'CONFLICT' });
  assert.equal((await runtime.close()).cleanup, 'complete');
  assert.equal(exports, 1);
});

test('instance revocation fences the old invocation through regrant and preserves the Agent', async t => {
  const runtime = await setup(t);
  const old = Promise.withResolvers();
  const release = Promise.withResolvers();
  const finished = Promise.withResolvers();
  t.after(() => release.resolve());
  let sideEffects = 0;
  await runtime.services.register({
    requestId: 'check-deploy', deploymentRef: 'fixture', implementationId: 'check-v1', ownership: 'run',
    registration: { manifest: structuredClone(checkManifest), adapter: { async invoke(request) {
      if (request.input.wait) {
        old.resolve();
        await release.promise;
      }
      try {
        request.assertAuthorized();
        sideEffects++;
        return true;
      } finally {
        if (request.input.wait) finished.resolve();
      }
    } } },
  });
  const profile = { ...initial, services: { 'check-orders': ['check'] } };
  await runtime.profiles.register({ id: 'checker', requestId: 'checker-profile', profile });
  const worker = await runtime.spawn({ profile: 'checker', requestId: 'worker' });
  const other = await runtime.spawn({ profile: 'checker', requestId: 'other' });
  const startup = transport.spawns.get(worker.id);
  const inflight = call(worker.id, 'check', { wait: true }, 'check-orders');

  await old.promise;
  const revoke = { agentId: worker.id, serviceId: 'check-orders', operations: ['check'], requestId: 'revoke' };
  const revoked = await runtime.access.revoke(revoke);
  assert.deepEqual(await runtime.access.revoke(revoke), revoked);
  assert.equal(revoked.version, 1);
  assert.deepEqual(revoked.services, {});
  assert.equal((await call(worker.id, 'list_services')).result.services.length, 0);
  assert.equal((await call(worker.id, 'check', {}, 'check-orders')).error.code, 'NOT_ALLOWED');
  assert.equal((await call(other.id, 'check', {}, 'check-orders')).result, true);

  const granted = await runtime.access.grant({ ...revoke, requestId: 'regrant', binding: 'orders-binding' });
  assert.equal(granted.version, 2);
  await assert.rejects(runtime.access.grant({ ...revoke, requestId: 'replace-binding', binding: 'other-binding' }), { code: 'CONFLICT' });
  assert.equal((await call(worker.id, 'check', {}, 'check-orders')).result, true);
  release.resolve();
  await finished.promise;
  assert.equal((await inflight).ok, false);
  assert.equal(sideEffects, 2);
  assert.equal(transport.spawns.get(worker.id), startup);
  assert.deepEqual(await runtime.get(worker.id), worker);
  assert.deepEqual(await runtime.access.get(worker.id), granted);
});

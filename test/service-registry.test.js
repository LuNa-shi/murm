import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ERROR_CODES,
  ServiceRegistry,
  SwarmEnvError,
  createHttpJsonAdapter,
  createServiceHost,
  createServiceManifest,
  makeEnvelope,
} from '../src/index.js';

function schema(properties = {}) {
  return { type: 'object', properties, additionalProperties: false };
}

function manifest({ id = 'fake', endpoint = { transport: 'in-process' }, audience = ['bound', 'recovery'], name = 'echo' } = {}) {
  return createServiceManifest({
    id,
    title: `${id} provider`,
    purpose: `Provider for ${id} tests`,
    provider_version: '1.0.0',
    contract_version: '1',
    endpoint,
    capabilities: [{
      name,
      description: `Run ${name}`,
      input_schema: schema({ value: { type: 'string' } }),
      output_schema: schema({ value: { type: 'string' } }),
      audience,
      side_effect: 'read',
      idempotent: true,
      context: [],
      help: { when: `When ${name} is needed`, ref: `${id}.${name}` },
    }],
  });
}

test('Service Manifest rejects open-ended schemas and duplicate capabilities', () => {
  assert.throws(
    () => createServiceManifest({
      ...manifest(),
      capabilities: [{
        ...manifest().capabilities[0],
        input_schema: { type: 'object', properties: {}, additionalProperties: true },
      }],
    }),
    (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.SERVICE_MANIFEST_INVALID,
  );
  const first = manifest().capabilities[0];
  assert.throws(
    () => createServiceManifest({ ...manifest(), capabilities: [first, first] }),
    (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.SERVICE_MANIFEST_INVALID,
  );
});

test('Service Registry is the source for metadata, role profiles, and invocation', async () => {
  const registry = new ServiceRegistry();
  registry.registerService({
    manifest: manifest({ audience: ['selection'] }),
    adapter: { invoke: async ({ input, envelope }) => ({ value: input.value, operation_id: envelope.operation_id }) },
  });
  registry.registerService({
    manifest: manifest({ id: 'bound-only', audience: ['bound', 'recovery'] }),
    adapter: { invoke: async ({ input }) => ({ value: input.value }) },
  });

  assert.deepEqual(registry.listServices().map((service) => service.service_id), ['bound-only', 'fake']);
  assert.deepEqual(registry.listTools().map((tool) => `${tool.service_id}.${tool.name}`), ['bound-only.echo', 'fake.echo']);
  const selection = registry.getCapabilityProfile('selection');
  assert.equal(selection.capabilities.length, 1);
  assert.equal(selection.capabilities[0].service_id, 'fake');
  assert.equal(selection.profileHash, selection.profile_hash);
  assert.equal(selection.profileHash, registry.getCapabilityProfile('selection').profileHash);
  assert.equal(registry.getCapabilityProfile('bound').capabilities[0].service_id, 'bound-only');
  const envelope = makeEnvelope({ operationId: 'echo-1', actorRef: 'agent:selection' });
  assert.deepEqual(await registry.invoke({ serviceId: 'fake', capability: 'echo', input: { value: 'ok' }, envelope, role: 'selection' }), { value: 'ok', operation_id: 'echo-1' });
  await assert.rejects(
    registry.invoke({ serviceId: 'fake', capability: 'echo', input: { value: 'no' }, envelope, role: 'bound' }),
    (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.SERVICE_CAPABILITY_NOT_ALLOWED,
  );
});

test('HTTP ServiceHost and adapter expose manifest, health, readiness, and structured invocation', async () => {
  const initial = manifest({ id: 'remote', endpoint: { transport: 'http-json', url: 'http://127.0.0.1:0' }, audience: ['selection'] });
  const host = createServiceHost({
    manifest: initial,
    token: 'test-token',
    handler: async ({ capability, input, envelope }) => ({ capability: capability.name, value: input.value, operation_id: envelope.operation_id }),
  });
  const environment = await host.start();
  try {
    const remote = createServiceManifest({ ...initial, endpoint: { transport: 'http-json', url: environment.url } });
    const adapter = createHttpJsonAdapter({ token: 'test-token' });
    const registry = new ServiceRegistry();
    registry.registerService({ manifest: remote, adapter });
    assert.deepEqual((await adapter.health(remote)).ok, true);
    assert.deepEqual((await adapter.readiness(remote)).ok, true);
    const envelope = makeEnvelope({ operationId: 'remote-1', actorRef: 'agent:selection' });
    assert.deepEqual(await registry.invoke({ serviceId: 'remote', capability: 'echo', input: { value: 'remote' }, envelope, role: 'selection' }), { capability: 'echo', value: 'remote', operation_id: 'remote-1' });
    const manifestResponse = await fetch(`${environment.url}/v1/manifest`);
    assert.equal(manifestResponse.status, 200);
    const manifestBody = await manifestResponse.json();
    assert.equal(manifestBody.result.service_id, 'remote');
    const unauthorized = await fetch(`${environment.url}/v1/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ envelope, input: { value: 'no' } }) });
    assert.equal(unauthorized.status, 401);
    const invalid = await fetch(`${environment.url}/v1/echo`, { method: 'POST', headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' }, body: JSON.stringify({ envelope: { actor_ref: 'missing-operation-id' }, input: {} }) });
    assert.equal(invalid.status, 400);
    const invalidBody = await invalid.json();
    assert.equal(invalidBody.error.code, ERROR_CODES.INVALID_CONTRACT);
  } finally {
    await host.stop();
  }
});

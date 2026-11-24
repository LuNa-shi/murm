import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ERROR_CODES, SwarmEnvError } from '../src/errors.js';
import { ServiceRegistry } from '../src/sdk/service-registry.js';
import { createBuiltinServiceRegistry } from '../src/sdk/builtin-registry.js';
import { makeEnvelope } from '../src/protocol/envelope.js';
import { loadServiceBundle, resolveBundleDocument } from '../src/sdk/service-bundle.js';

const schema = {
  type: 'object',
  properties: { query: { type: 'string' } },
  required: ['query'],
  additionalProperties: false,
};

function manifest(overrides = {}) {
  return {
    id: 'locked-research',
    title: 'Locked Research',
    purpose: 'Search a locked research index.',
    provider_version: '1.2.3',
    contract_version: '1',
    endpoint: { transport: 'in-process' },
    documentation: { skill: 'SKILL.md', references: ['references/upstream.md'] },
    secret_refs: { token: 'env:LOCKED_RESEARCH_TOKEN' },
    capabilities: [{
      name: 'research_search',
      description: 'Search the locked index.',
      audience: ['bound'],
      side_effect: 'read',
      idempotent: true,
      context: ['task', 'execution'],
      requires_binding: true,
      help: { when: 'Before proposing a route.', ref: 'service://locked-research/skill' },
      input_schema: schema,
      output_schema: { type: 'object', properties: { results: { type: 'array' } }, additionalProperties: false },
      path: '/v1/research_search',
      errors: [{ code: ERROR_CODES.SERVICE_TIMEOUT, retryable: true }],
    }],
    ...overrides,
  };
}

async function bundleDir(root, overrides = {}, { skill = '# Locked Research\n\nSearch the locked index.\n' } = {}) {
  const dir = join(root, 'locked-research');
  await mkdir(join(dir, 'references'), { recursive: true });
  await writeFile(join(dir, 'service.json'), JSON.stringify(manifest(overrides), null, 2));
  if (skill !== null) await writeFile(join(dir, 'SKILL.md'), skill);
  await writeFile(join(dir, 'references', 'upstream.md'), '# Upstream\n\nResponses are normalized and bounded.\n');
  return dir;
}

test('service bundle loads required docs and binds them to the manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swarmenv-bundle-'));
  try {
    const dir = await bundleDir(root);
    const bundle = await loadServiceBundle(dir, { rootDir: root });
    assert.equal(bundle.service_id, 'locked-research');
    assert.deepEqual(bundle.documents.map((document) => document.id), ['skill', 'references/upstream.md']);
    assert.ok(bundle.documents.every((document) => document.sha256.length === 64));
    assert.ok(bundle.manifest.metadata.documentation.every((document) => document.sha256.length === 64));
    assert.deepEqual(bundle.secret_refs, { token: 'env:LOCKED_RESEARCH_TOKEN' });
    const resolved = resolveBundleDocument(bundle, 'service://locked-research/skill');
    assert.match(resolved.text, /Search the locked index/);

    const registry = new ServiceRegistry();
    registry.registerBundle({ bundle, adapter: { invoke: async () => ({ results: [] }) } });
    const help = registry.resolveHelpRef('service://locked-research/skill');
    assert.equal(help.document_sha256, bundle.documents[0].sha256);
    const profile = registry.getCapabilityProfile('bound');
    assert.equal(profile.services[0].documentation.length, 2);
    assert.match(help.text, /Search the locked index/);
    const catalog = createBuiltinServiceRegistry();
    catalog.registerBundle({ bundle, adapter: { invoke: async () => ({ results: [] }) } });
    const metadata = await catalog.invoke({ serviceId: 'catalog', capability: 'get_service_metadata', input: { service: 'locked-research' }, envelope: makeEnvelope({ actorRef: 'agent:bound', operationId: 'service-docs' }), role: 'bound' });
    assert.equal(metadata.documents.length, 2);
    assert.match(metadata.documents[0].text, /Search the locked index/);
    assert.equal(metadata.documents[0].sha256, bundle.documents[0].sha256);
    const hidden = await catalog.invoke({ serviceId: 'catalog', capability: 'get_service_metadata', input: { service: 'locked-research' }, envelope: makeEnvelope({ actorRef: 'agent:recovery', operationId: 'service-docs-hidden' }), role: 'recovery' });
    assert.deepEqual(hidden.capabilities, []);
    assert.deepEqual(hidden.documents, []);
    assert.throws(() => registry.resolveHelpRef('/etc/passwd'), (error) => error.code === ERROR_CODES.SERVICE_MANIFEST_INVALID);
    assert.throws(() => registry.resolveHelpRef('service://locked-research/../secret'), (error) => error.code === ERROR_CODES.SERVICE_MANIFEST_INVALID);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('service bundle rejects missing docs, traversal, and embedded credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swarmenv-bundle-invalid-'));
  try {
    const missingSkill = await bundleDir(root, {}, { skill: null });
    await assert.rejects(loadServiceBundle(missingSkill, { rootDir: root }), (error) => error.code === ERROR_CODES.SERVICE_MANIFEST_INVALID);

    const traversal = await bundleDir(root, { documentation: { skill: 'SKILL.md', references: ['../secret.md'] } });
    await assert.rejects(loadServiceBundle(traversal, { rootDir: root }), (error) => error.code === ERROR_CODES.SERVICE_MANIFEST_INVALID);

    const credential = await bundleDir(root, { endpoint: { transport: 'in-process', token: 'literal-secret' } });
    await assert.rejects(loadServiceBundle(credential, { rootDir: root }), (error) => error.code === ERROR_CODES.SERVICE_MANIFEST_INVALID);

    const metadataCredential = await bundleDir(root, { metadata: { headers: { Authorization: 'Bearer abcdefghijklmnop' } } });
    await assert.rejects(loadServiceBundle(metadataCredential, { rootDir: root }), (error) => error.code === ERROR_CODES.SERVICE_MANIFEST_INVALID);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('service bundle rejects a help ref that is not a bundle resource', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swarmenv-bundle-ref-'));
  try {
    const dir = await bundleDir(root, {
      capabilities: [{
        ...manifest().capabilities[0],
        help: { when: 'Read external docs.', ref: 'https://example.invalid/docs' },
      }],
    });
    await assert.rejects(loadServiceBundle(dir, { rootDir: root }), (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.SERVICE_MANIFEST_INVALID);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('service bundle rejects a directory outside the configured service root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swarmenv-bundle-root-'));
  const outside = await mkdtemp(join(tmpdir(), 'swarmenv-bundle-outside-'));
  try {
    const dir = await bundleDir(outside);
    await assert.rejects(loadServiceBundle(dir, { rootDir: root }), (error) => error.code === ERROR_CODES.SERVICE_MANIFEST_INVALID);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
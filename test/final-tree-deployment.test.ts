import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFinalTreeArtifactLock, createLockedFinalTreeVerifier, fingerprintFinalTreeArtifact, FINAL_TREE_SOURCE_PINS } from '../src/judge/final-tree-deployment.js';
import { stableStringify } from '../src/protocol/envelope.js';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = { checker_ref: 'lean-final-tree', checker_version: '1', environment_ref: 'test' };
const configuration = {
  identity, leanRoot: '/not-installed', libraryRoots: ['/nominal-dependency'],
  comparatorLibraryRoots: ['/nominal-comparator', '/nominal-export-lib'], exporterPath: '/nominal-export',
};

test('checker deployment rejects retired benchmark profiles before invoking tools or reading fixtures', async () => {
  for (const benchmarkProfile of ['arbitrary', 'openai-math-v1', 'flt10-dag-v1', 'flt10-subtree-v1']) {
    await assert.rejects(createFinalTreeArtifactLock({ configuration: { ...configuration, benchmarkProfile } }), /benchmark profile/i);
    await assert.rejects(createLockedFinalTreeVerifier({ configuration: { ...configuration, benchmarkProfile } }), /benchmark profile/i);
  }
});

test('deployment gate requires the lock and rejects altered content or selection before invoking tools', async () => {
  await assert.rejects(createLockedFinalTreeVerifier({ configuration }), /artifact lock is required/);
  const manifest = {
    version: 1, configuration: { ...configuration, bubblewrap: '/usr/bin/bwrap', localModules: [], timeoutMs: 120_000 },
    sources: FINAL_TREE_SOURCE_PINS, artifacts: [],
  };
  const lock = { ...manifest, sha256: sha256(stableStringify(manifest)) };
  for (const artifactLock of [{ ...lock, sha256: 'unknown' }, { ...lock, artifacts: [{}] }]) {
    await assert.rejects(createLockedFinalTreeVerifier({ configuration: { ...configuration, artifactLock } }), /lock does not match/);
  }
  await assert.rejects(createLockedFinalTreeVerifier({
    configuration: { ...configuration, libraryRoots: ['/different'], artifactLock: lock },
  }), /lock does not match/);
  for (const altered of [{ resources: { memory_bytes: 8 * 1024 ** 3 } }, { projectJobs: 4 }]) {
    await assert.rejects(createLockedFinalTreeVerifier({ configuration: { ...configuration, ...altered, artifactLock: lock } }), /lock does not match/);
  }
});

test('nested artifact bytes, paths and modes are pinned, and symlink escapes fail closed', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'murm-checker-artifacts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'library');
  await mkdir(join(root, 'nested'), { recursive: true });
  const artifact = join(root, 'nested', 'Imported.olean');
  await writeFile(artifact, 'original');
  await symlink('nested/Imported.olean', join(root, 'internal-link'));
  const fingerprint = () => fingerprintFinalTreeArtifact(root, { label: 'dependency' });
  const initial = await fingerprint();
  assert.equal(initial.entries, 4);
  assert.deepEqual(await fingerprint(), initial);
  await writeFile(artifact, 'modified');
  const changed = await fingerprint();
  assert.notEqual(changed.sha256, initial.sha256);
  await chmod(artifact, 0o700);
  assert.notEqual((await fingerprint()).sha256, changed.sha256);
  await writeFile(join(directory, 'outside'), 'outside');
  await symlink('../outside', join(root, 'outside'));
  await assert.rejects(fingerprint(), /symlink outside/);
  await symlink(root, join(directory, 'root-alias'));
  await assert.rejects(fingerprintFinalTreeArtifact(join(directory, 'root-alias'), { label: 'alias' }), /canonical absolute path/);
});

test('real artifact lock validates the pinned production deployment and cgroup', {
  skip: !process.env.MURM_TEST_ARTIFACT_LOCK,
}, async () => {
  const artifactLock = process.env.MURM_TEST_ARTIFACT_LOCK;
  const lock = JSON.parse(await readFile(artifactLock, 'utf8'));
  const source = 'theorem toy : True := by sorry\n';
  const { adapter, evidence } = await createLockedFinalTreeVerifier({
    configuration: { ...lock.configuration, artifactLock },
    problem: { id: 'toy', problem_file: 'Toy.lean', source, source_hash: sha256(source) },
  });
  assert.equal(adapter.resourceLimits, true);
  assert.ok(!JSON.stringify(evidence).includes(lock.configuration.leanRoot));
  assert.ok(adapter.identity.environment_ref.endsWith(lock.sha256));
  assert.equal(evidence.artifact_lock_sha256, lock.sha256);
  assert.equal(evidence.resources.max_tasks, 64);
});

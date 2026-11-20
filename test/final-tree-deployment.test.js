import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFinalTreeArtifactLock, createLockedFinalTreeVerifier, fingerprintFinalTreeArtifact, FINAL_TREE_SOURCE_PINS, OPENAI_MATH_SOURCE_PINS } from '../src/judge/final-tree-deployment.js';
import { stableStringify } from '../src/protocol/envelope.js';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = { checker_ref: 'lean-final-tree', checker_version: '1', environment_ref: 'test' };
const configuration = {
  identity, leanRoot: '/not-installed', libraryRoots: ['/nominal-dependency'],
  comparatorLibraryRoots: ['/nominal-comparator', '/nominal-export-lib'], exporterPath: '/nominal-export',
};

test('checker lock rejects unknown benchmark profiles before tool invocation', async () => {
  await assert.rejects(createFinalTreeArtifactLock({ configuration: { ...configuration, benchmarkProfile: 'arbitrary' } }), /benchmark profile/);
});

test('OpenAI Math profile selects its Lean 4.34.1 source pins and still requires a trusted lock', async () => {
  assert.equal(OPENAI_MATH_SOURCE_PINS.lean, '4.34.1');
  assert.equal(OPENAI_MATH_SOURCE_PINS.mathlib, 'd13f23b723b8a846827a245b89c10fc7d3f11612');
  await assert.rejects(createLockedFinalTreeVerifier({
    configuration: { ...configuration, benchmarkProfile: 'openai-math-v1' },
    problem: { problem_file: 'lean/ComparatorChallenges/PlaneColoring.lean', source_hash: 'a'.repeat(64), declaration_name: 'OAI.Problem160.properColoring_seven' },
  }), /artifact lock is required/);
});

test('root-only deployment binds the target and declaration to its foundation manifest', async t => {
  const root = await mkdtemp(join(tmpdir(), 'swarmenv-foundation-target-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = JSON.stringify({ target_sha256: 'a'.repeat(64), declaration_name: 'Target.goal' });
  await writeFile(join(root, 'foundation-manifest.json'), bytes);
  const deployment = { ...configuration, benchmarkProfile: 'flt10-subtree-v1', checkpoint: 20,
    projectionRoot: root, foundationSha256: sha256(bytes) };
  const problem = { checkpoint: 20, source_hash: 'a'.repeat(64), declaration_name: 'Target.goal' };
  for (const altered of [{ ...problem, source_hash: 'b'.repeat(64) }, { ...problem, declaration_name: 'Helper.goal' }]) {
    await assert.rejects(createLockedFinalTreeVerifier({ configuration: deployment, problem: altered }), /locked foundation target/);
  }
  await assert.rejects(createLockedFinalTreeVerifier({ configuration: deployment, problem }), /artifact lock is required/);
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
  const directory = await mkdtemp(join(tmpdir(), 'swarmenv-checker-artifacts-'));
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
  skip: !process.env.SWARMENV_TEST_ARTIFACT_LOCK,
}, async () => {
  const artifactLock = process.env.SWARMENV_TEST_ARTIFACT_LOCK;
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

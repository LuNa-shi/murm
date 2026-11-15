import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runBenchmarkProject } from '../src/benchmark/putnam-runner.js';
import { readBenchmarkFixture, verifyBenchmarkFixtureCheckout } from '../src/benchmark/benchmark-fixture.js';
import { beginPrivateAudit } from '../src/observability/private-audit-retention.js';

const path = 'lean4/putnam.lean';
const original = 'theorem preuve_é : True := by\n  sorry\n\n';
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'swarm-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'lean4'));
  await writeFile(join(root, path), original);
  git(root, 'init', '-q');
  git(root, 'add', '--', path);
  git(root, '-c', 'user.email=fixture@example.test', '-c', 'user.name=Fixture', 'commit', '-qm', 'Pin theorem');
  return { root, commit: git(root, 'rev-parse', 'HEAD'), path };
}

test('verified fixture is fixed to original committed bytes, including all trailing newlines', async t => {
  const input = await fixture(t);
  await verifyBenchmarkFixtureCheckout(input);
  assert.deepEqual(await readBenchmarkFixture(input), {
    sourcePath: join(input.root, path), source: original,
    sourceHash: 'dfd66e8ad1aadebbeafb01591478b8d0b1153b5ce76d63a09b87210ea1dddac5',
  });

  await writeFile(join(input.root, path), 'theorem preuve_é : False := by\n  sorry\n');
  await verifyBenchmarkFixtureCheckout(input);
  await assert.rejects(readBenchmarkFixture(input), /does not match the pinned blob/);
});

test('fixture rejects abbreviated and nonmatching commit references', async t => {
  const input = await fixture(t);
  for (const commit of ['HEAD', input.commit.slice(0, 12)]) {
    await assert.rejects(verifyBenchmarkFixtureCheckout({ ...input, commit }), /full lowercase 40-hex/);
    await assert.rejects(readBenchmarkFixture({ ...input, commit }), /full lowercase 40-hex/);
  }
  git(input.root, '-c', 'user.email=fixture@example.test', '-c', 'user.name=Fixture', 'commit', '--allow-empty', '-qm', 'Advance HEAD');
  await assert.rejects(verifyBenchmarkFixtureCheckout(input), /does not match pinned commit/);
});

test('fixture rejects path escapes and symlink substitutions even when bytes are unchanged', async t => {
  const input = await fixture(t);
  for (const path of ['/tmp/outside.lean', '../outside.lean', 'lean4/../outside.lean', 'lean4\\outside.lean']) {
    await assert.rejects(readBenchmarkFixture({ ...input, path }), /unsafe repository-relative/);
  }
  await writeFile(join(input.root, 'same-bytes.lean'), original);
  await rm(join(input.root, path));
  await symlink('../same-bytes.lean', join(input.root, path));
  await assert.rejects(readBenchmarkFixture(input), /must be a regular file/);
});

test('diagnostic read preserves current UTF-8 bytes and rejects invalid UTF-8', async t => {
  const { root } = await fixture(t);
  const source = '\ufeffexample : True := by\r\n  sorry\r\n';
  await writeFile(join(root, path), source);
  assert.equal((await readBenchmarkFixture({ root, path })).source, source);
  await writeFile(join(root, path), Buffer.from([0xc2, 0x0a]));
  await assert.rejects(readBenchmarkFixture({ root, path }), /valid for encoding utf-8/);
});

test('timed runner verifies prepared fixture fields even if the caller claims a verified fixture', async t => {
  const input = await fixture(t);
  const verified = await readBenchmarkFixture(input);
  const config = { putnam_bench_root: input.root, putnambench_commit: input.commit };
  const problem = { id: 'putnam_2025_b1', problem_file: input.path, source: verified.source,
    source_hash: verified.sourceHash, source_path: verified.sourcePath, fixture_verified: true };
  const run = overrides => runBenchmarkProject({ ...problem, ...overrides }, config, { timeboxMs: 1 });
  for (const overrides of [{ source: 'replaced' }, { source_hash: 'wrong' }, { source_path: '/tmp/unrelated.lean' }]) {
    await assert.rejects(run(overrides), error => error.code === 'SERVICE_NOT_READY' &&
      /prepared benchmark problem/i.test(error.cause?.message));
  }
  await assert.rejects(run({ fixture_verified: false }), /explicit valid Mission coordination grant/);
  await writeFile(verified.sourcePath, 'different file in worktree');
  await assert.rejects(run({}), error => error.code === 'SERVICE_NOT_READY' && /pinned blob/.test(error.cause?.message));
});

test('timed benchmark admits host-only model routing without a financial budget and still requires a locked checker', async t => {
  const input = await fixture(t);
  const prepared = await readBenchmarkFixture(input);
  const experimentDir = join(input.root, 'experiment');
  const privateAudit = await beginPrivateAudit({ root: input.root, directory: experimentDir });
  const config = { putnam_bench_root: input.root, putnambench_commit: input.commit };
  const problem = { id: 'putnam_2025_b1', problem_file: input.path, source: prepared.source,
    source_hash: prepared.sourceHash, source_path: prepared.sourcePath };
  const options = { timeboxMs: 1000, experimentDir, privateAudit, coordinationPermissions: ['mission_submit'],
    provider: 'gpt_proxy', model: 'gpt-6.1-sol', command: 'pi', serviceEndpoints: {} };
  try {
    await assert.rejects(runBenchmarkProject(problem, config, options), /host-side model endpoint and credential/);
    await assert.rejects(runBenchmarkProject(problem, config, {
      ...options, modelUpstream: { url: 'http://127.0.0.1:1/v1/responses', headers: { authorization: 'Bearer local-fixture' } },
    }), /requires locked final and source checkers/);
  } finally {
    await privateAudit.close();
  }
});

test('timed entry rejects remote/custom service bypasses while local composition stays available', async () => {
  const { assertTimedServiceComposition } = await import('../src/benchmark/benchmark-fixture.js');
  assert.throws(() => assertTimedServiceComposition({ timeboxMs: 1, customServices: [{}] }, {}), /resource contract/);
  assert.throws(() => assertTimedServiceComposition({ timeboxMs: 1, serviceEndpoints: null }, { SWARMENV_TASK_SERVICE_URL: 'http://billable.test' }), /resource contract/);
  assert.throws(() => assertTimedServiceComposition({ timeboxMs: 1 }, { SWARMENV_MATHLIB_SEARCH_URL: 'http://billable.test' }), /resource contract/);
  assert.throws(() => assertTimedServiceComposition({ timeboxMs: 1, serviceRegistry: {} }, {}), /resource contract/);
  assert.doesNotThrow(() => assertTimedServiceComposition({ timeboxMs: 1, serviceEndpoints: {}, mathlibSearchUrl: '' }, { SWARMENV_TASK_SERVICE_URL: 'http://not-selected.test' }));
  assert.doesNotThrow(() => assertTimedServiceComposition({ timeboxMs: 0, customServices: [{}] }, {}));
});

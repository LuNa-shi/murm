import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadBenchmarkConfig } from '../src/benchmark/putnam-runner.js';
import { createHash } from 'node:crypto';
import { assertBenchmarkReady, readBenchmarkContext } from '../src/benchmark/benchmark-context.js';
import { fileURLToPath } from 'node:url';

test('FLT10 loads all ten pinned statements with distinct project and Lean declaration names', async t => {
  const root = await mkdtemp(join(tmpdir(), 'swarm-flt-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(new URL('../benchmarks/flt10/', import.meta.url), root, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Pin FLT statements');
  const config = JSON.parse(await readFile(new URL('../config/flt10.json', import.meta.url)));
  config.fixture_commit = git('rev-parse', 'HEAD');
  for (const problem of config.problems) problem.problem_file = `q${problem.checkpoint}/baseline/q${problem.checkpoint}.lean`;
  const path = join(root, 'config.json');
  await writeFile(path, JSON.stringify(config));
  const loaded = await loadBenchmarkConfig(path, { putnamBenchRoot: root, verifyPinnedCheckout: true });
  assert.equal(loaded.problems.length, 10);
  assert.equal(loaded.problems[0].declaration_name, 'FLT10Bench.q10_of_counterexample');
  assert.equal(loaded.problems[1].declaration_name, 'FLT10Bench.q20_frey_reducible_hasCofixedLine');
  assert.equal(loaded.problems[0].source_hash, '70b457388c35e492ae048993586fcafdae2f0cdaf28b02ca24810d68909f88c4');
  assert.equal(loaded.problems[1].source_hash, '822ab7414a071d2ef44e2490ad175dc5547797a8e5d9cf8d146fdb12855c393f');
  assert.equal(loaded.fixture_commit, config.fixture_commit);
});

test('FLT graph preparation excludes untracked and ignored source modules', async t => {
  const root = await mkdtemp(join(tmpdir(), 'swarm-flt-graph-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'Definitions'));
  await writeFile(join(root, 'Definitions/Kept.lean'), 'def kept : Nat := 1\n');
  await writeFile(join(root, '.gitignore'), 'Definitions/Ignored.lean\n');
  const git = (...args) => execFileSync('git', ['-C', root, ...args]);
  git('init', '-q'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Pin graph');
  await writeFile(join(root, 'Definitions/Untracked.lean'), 'theorem leaked : True := trivial\n');
  await writeFile(join(root, 'Definitions/Ignored.lean'), 'theorem hidden : True := trivial\n');
  const output = join(root, 'graph.json');
  execFileSync('python3', ['-B', fileURLToPath(new URL('../scripts/benchmarks/build_flt10_statement_graph.py', import.meta.url)),
    '--project-root', root, '--output', output]);
  const graph = JSON.parse(await readFile(output));
  assert.deepEqual(Object.keys(graph.framework.nodes), ['Definitions.Kept']);
});

test('benchmark context retains binary metadata and rejects mutated or escaping files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'swarm-flt-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0]);
  const hash = value => createHash('sha256').update(value).digest('hex');
  await writeFile(join(root, 'graph.xz'), bytes);
  const manifest = JSON.stringify({ files: [{ path: 'benchmark/graph.xz', source_path: 'graph.xz', sha256: hash(bytes) }] });
  await writeFile(join(root, 'manifest.json'), manifest);
  const problem = { context_manifest: 'manifest.json', context_sha256: hash(manifest) };
  const config = { benchmark: 'flt10', benchmark_context_root: root };
  assert.deepEqual(await readBenchmarkContext(problem, config), { 'benchmark/graph.xz': bytes });
  await writeFile(join(root, 'graph.xz'), 'changed');
  await assert.rejects(readBenchmarkContext(problem, config), /digest mismatch/);
  await assert.rejects(readBenchmarkContext({ ...problem, context_manifest: '../outside' }, config), /unsafe/);
});

test('a new benchmark loads one configured target without adding a runner branch', async t => {
  const root = await mkdtemp(join(tmpdir(), 'swarm-generic-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'Target.lean'), 'theorem Example.target : True := by sorry\n');
  const config = { benchmark: 'example-subtree-v1', fixture_commit: 'local', instructions_path: 'benchmark/README.md',
    problems: [{ id: 'example', problem_file: 'Target.lean', declaration_name: 'Example.target' }] };
  await writeFile(join(root, 'config.json'), JSON.stringify(config));
  const loaded = await loadBenchmarkConfig(join(root, 'config.json'), { putnamBenchRoot: root });
  assert.equal(loaded.problems.length, 1);
  assert.equal(loaded.problems[0].declaration_name, 'Example.target');
  assert.equal(loaded.instructions_path, 'benchmark/README.md');
});

test('a nested Lean benchmark project uses its configured subdirectory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'swarm-openai-math-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'lean/ComparatorChallenges'), { recursive: true });
  await writeFile(join(root, 'lean/lean-toolchain'), 'leanprover/lean4:v4.34.1\n');
  const source = 'namespace OAI\nnamespace Problem160\ntheorem properColoring_seven : True := by sorry\nend Problem160\nend OAI\n';
  await writeFile(join(root, 'lean/ComparatorChallenges/PlaneColoring.lean'), source);
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Pin nested Lean fixture');
  const config = { benchmark: 'openai_math_v1', fixture_commit: git('rev-parse', 'HEAD'),
    lean_project_subdir: 'lean', problems: [{ id: 'plane_coloring', problem_file: 'lean/ComparatorChallenges/PlaneColoring.lean',
      declaration_name: 'OAI.Problem160.properColoring_seven' }] };
  const path = join(root, 'config.json');
  await writeFile(path, JSON.stringify(config));
  const loaded = await loadBenchmarkConfig(path, { putnamBenchRoot: root, verifyPinnedCheckout: true });
  assert.equal(loaded.lean_project_root, join(root, 'lean'));
  assert.equal(loaded.problems[0].source, source);
  assert.equal(loaded.problems[0].source_hash, createHash('sha256').update(source).digest('hex'));
});

test('a Lean project subdirectory cannot escape the benchmark root', async t => {
  const root = await mkdtemp(join(tmpdir(), 'swarm-openai-math-path-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'Target.lean'), 'theorem Example.target : True := by sorry\n');
  const config = { benchmark: 'openai_math_v1', fixture_commit: 'local', lean_project_subdir: '../outside',
    problems: [{ id: 'example', problem_file: 'Target.lean', declaration_name: 'Example.target' }] };
  const path = join(root, 'config.json');
  await writeFile(path, JSON.stringify(config));
  await assert.rejects(loadBenchmarkConfig(path, { putnamBenchRoot: root }), /invalid Lean project subdirectory/);
});

test('the embedded OpenAI Math fixture loads from this repository checkout', async () => {
  const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
  const config = await loadBenchmarkConfig(join(repositoryRoot, 'config/openai-math-12.json'), {
    putnamBenchRoot: repositoryRoot,
    verifyPinnedCheckout: true,
  });
  assert.equal(config.problems.length, 12);
  assert.equal(config.lean_project_root, join(repositoryRoot, 'benchmarks/openai-math-12/lean'));
  assert.equal(config.problems[0].source_path, join(repositoryRoot, config.problems[0].problem_file));
  assert.equal(config.smoke_problem.problem_file, 'benchmarks/openai-math-12/lean/ComparatorChallenges/PlaneColoring.lean');
});

test('formal readiness requires a complete target receipt bound to its context and checker', async t => {
  const root = await mkdtemp(join(tmpdir(), 'swarm-validation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { validation_required: true, benchmark_validation_root: root };
  const problem = { source_hash: 'target', context_sha256: 'public-context', validation_manifest: 'receipt.json' };
  const checker = { artifactLock: { sha256: 'a'.repeat(64) } };
  await assert.rejects(assertBenchmarkReady(problem, config, checker), /not ready/);
  const receipt = { verdict: 'PASS', scope: 'complete-target', initial_compilation: true, statement_identity: true,
    visibility_audit: true, target_sha256: 'target', context_sha256: 'public-context', checker_lock_sha256: 'a'.repeat(64),
    witness_tree_sha256: 'c'.repeat(64), check_result: { verdict: 'PASS', checked_tree: 'sha256:' + 'c'.repeat(64),
      check_result_id: 'treecheck:00000000-0000-4000-a000-000000000001' } };
  const check = async changes => {
    const bytes = JSON.stringify({ ...receipt, ...changes });
    await writeFile(join(root, 'receipt.json'), bytes);
    return assertBenchmarkReady({ ...problem, validation_sha256: createHash('sha256').update(bytes).digest('hex') }, config, checker);
  };
  await check({});
  for (const changes of [{ scope: 'helper' }, { target_sha256: 'other' }, { context_sha256: 'old' },
    { checker_lock_sha256: 'b'.repeat(64) }, { visibility_audit: false }, { statement_identity: false },
    { witness_tree_sha256: 'd'.repeat(64) }, { check_result: { verdict: 'FAIL' } }]) {
    await assert.rejects(check(changes), /not ready/);
  }
});

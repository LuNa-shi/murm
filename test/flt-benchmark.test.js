import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadBenchmarkConfig } from '../src/benchmark/putnam-runner.js';
import { createHash } from 'node:crypto';
import { readBenchmarkContext } from '../src/benchmark/benchmark-context.js';

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

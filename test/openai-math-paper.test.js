import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBenchmarkConfig } from '../src/benchmark/putnam-runner.js';
import { readBenchmarkContext, selectOpenAiMathContext } from '../src/benchmark/benchmark-context.js';
import { MissionWorkspace } from '../src/runtime/mission-workspace.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('Seymour paper condition materializes the verified manuscript alongside the original goal', async t => {
  const config = await loadBenchmarkConfig(join(root, 'config/openai-math-12.json'), {
    putnamBenchRoot: root, verifyPinnedCheckout: true,
  });
  const [seymour] = config.problems;
  const control = await selectOpenAiMathContext(config, [seymour], 'none');
  assert.deepEqual(await readBenchmarkContext(control.problems[0], control.config), {});
  await assert.rejects(selectOpenAiMathContext(config, [
    { ...seymour, paper: { ...seymour.paper, sha256: '0'.repeat(64) } },
  ], 'paper'), /digest mismatch/);
  const treatment = await selectOpenAiMathContext(config, [seymour], 'paper');
  const paper = await readBenchmarkContext(treatment.problems[0], treatment.config);
  assert.deepEqual(Object.keys(paper).sort(), ['benchmark/paper.pdf', 'benchmark/paper.txt']);
  const dir = await mkdtemp(join(tmpdir(), 'openai-math-paper-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ws = new MissionWorkspace({ rootDir: join(dir, 'store') });
  await ws.create({ missionId: 'test', workspaceId: 'seymour', initialFiles: {
    ...paper, [seymour.problem_file]: seymour.source,
  } });
  const targetDir = join(dir, 'checkout');
  await ws.materialize({ workspaceId: 'seymour', targetDir });
  assert.equal(hash(await readFile(join(targetDir, seymour.problem_file))), seymour.source_hash);
  assert.equal(hash(await readFile(join(targetDir, 'benchmark/paper.pdf'))),
    '20be859799f83e3412dba6fd645a72a0d929cbe05ca546807c591f001f9e6e82');
  assert.match(await readFile(join(targetDir, 'benchmark/paper.txt'), 'utf8'), /pruning/i);
  await assert.rejects(selectOpenAiMathContext(config, [seymour], 'papers'), /paper mode/);
  await assert.rejects(selectOpenAiMathContext(config, [{ id: 'no_paper' }], 'paper'), /no pinned paper/);
});

test('every configured goal has a pinned paper and a connected paper-route rubric', async () => {
  const config = await loadBenchmarkConfig(join(root, 'config/openai-math-12.json'), {
    putnamBenchRoot: root, verifyPinnedCheckout: true,
  });
  const base = join(root, config.embedded_fixture_root);
  const treatment = await selectOpenAiMathContext(config, config.problems, 'paper');
  const control = await selectOpenAiMathContext(config, config.problems, 'none');
  const manuscripts = new Map();
  for (const [i, problem] of treatment.problems.entries()) {
    const name = basename(problem.problem_file, '.lean');
    const label = problem.id;
    assert.deepEqual(await readBenchmarkContext(control.problems[i], control.config), {}, label);
    assert.equal(problem.source_hash, control.problems[i].source_hash, label);
    const inputs = await readBenchmarkContext(problem, treatment.config);
    assert.deepEqual(Object.keys(inputs).sort(), ['benchmark/paper.pdf', 'benchmark/paper.txt'], label);
    assert.equal(inputs['benchmark/paper.pdf'].subarray(0, 5).toString(), '%PDF-', label);
    const manuscriptText = inputs['benchmark/paper.txt'].toString('utf8');
    assert.ok(manuscriptText.length > 1000, label);
    assert.doesNotMatch(manuscriptText, /[\x00-\x08\x0b-\x1f\x7f]/, label);
    manuscripts.set(name, hash(inputs['benchmark/paper.pdf']));
    const manifest = JSON.parse(await readFile(join(base, 'papers', problem.paper.manifest)));
    const rubric = JSON.parse(await readFile(join(base, 'paper-progress', name + '.json')));
    const article = await readFile(join(base, 'paper-progress', name + '.md'), 'utf8');
    assert.equal(rubric.paper, '../papers/' + problem.paper.manifest, label);
    assert.equal(rubric.upstream_commit, manifest.upstream_commit, label);
    assert.equal(manifest.upstream_commit, config.upstream_commit, label);
    assert.equal(rubric.root, problem.declaration_name, label);
    assert.equal(rubric.problem, name, label);
    const ancestors = new Map();
    for (const row of rubric.milestones) {
      assert.ok(!ancestors.has(row.id), row.id);
      assert.ok(row.title && row.statement && row.acceptance && row.allowed_assumptions.length, row.id);
      assert.ok(row.paper_path.startsWith(dirname(manifest.upstream_path) + '/'), row.id);
      assert.ok(row.line_start > 0 && row.line_start <= row.line_end, row.id);
      assert.ok(article.includes('## ' + row.id + ' · ' + row.title), row.id);
      const dependencies = new Set();
      for (const dep of row.depends_on) {
        assert.ok(ancestors.has(dep), row.id + ' requires ' + dep);
        dependencies.add(dep);
        for (const ancestor of ancestors.get(dep)) dependencies.add(ancestor);
      }
      ancestors.set(row.id, dependencies);
    }
    assert.equal(ancestors.get(rubric.milestones.at(-1).id).size, rubric.milestones.length - 1, label);
  }
  assert.equal(manuscripts.size, 12);
  assert.equal(new Set(manuscripts.values()).size, 11);
  assert.equal(manuscripts.get('EgyptianFractions'), manuscripts.get('ShortEgyptianFractions'));
});

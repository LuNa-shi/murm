import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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

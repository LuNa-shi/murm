import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadPutnamB1, putnamB1 } from './case.ts';

test('the benchmark input rejects replacement of the original declaration', async t => {
  const root = await mkdtemp(join(tmpdir(), 'flat-putnam-case-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'lean4/src'), { recursive: true });
  await writeFile(join(root, putnamB1.problem_file), 'theorem putnam_2025_b1 : True := trivial\n');
  await assert.rejects(loadPutnamB1(root), /original PutnamBench 2025 B1/);
});

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadPutnamB1, putnamB1, putnamWindowMs } from './case.ts';

test('the benchmark input rejects replacement of the original declaration', async t => {
  const root = await mkdtemp(join(tmpdir(), 'flat-putnam-case-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'lean4/src'), { recursive: true });
  await writeFile(join(root, putnamB1.problem_file), 'theorem putnam_2025_b1 : True := trivial\n');
  await assert.rejects(loadPutnamB1(root), /original PutnamBench 2025 B1/);
});

test('Putnam defaults to one hour and permits a registered shorter window', () => {
  assert.equal(putnamWindowMs(), 3_600_000);
  assert.equal(putnamWindowMs('3305'), 3_305_000);
  for (const value of ['', '0', '3601', '1e2', '1.5']) {
    assert.throws(() => putnamWindowMs(value), /between 1 and 3600 whole seconds/);
  }
});

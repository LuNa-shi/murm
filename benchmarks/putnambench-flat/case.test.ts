import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadPutnamB1, putnamB1, putnamModel, putnamSelectionMs, putnamWindowMs } from './case.ts';

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

test('a registered Putnam selection window stays inside the shared research window', () => {
  assert.equal(putnamSelectionMs(3_600_000), 300_000);
  assert.equal(putnamSelectionMs(120_000), 120_000);
  assert.equal(putnamSelectionMs(3_600_000, '600'), 600_000);
  for (const value of ['0', '121', '1.5', '1e2']) {
    assert.throws(() => putnamSelectionMs(120_000, value), /between 1 and 120 whole seconds/);
  }
});

test('Putnam defaults to K3 and supports the explicit GPT 6.1 Sol comparison', () => {
  assert.deepEqual(putnamModel(), { provider: 'kimi_proxy', model: 'k3' });
  assert.deepEqual(putnamModel('gpt-6.1-sol'), { provider: 'gpt_proxy', model: 'gpt-6.1-sol' });
  assert.throws(() => putnamModel('unregistered'), /model must be/);
});

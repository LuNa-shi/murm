import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('../scripts/run-putnambench-benchmark.mjs', import.meta.url));

test('benchmark CLI exposes one Mission Task model and rejects the removed model flags', () => {
  const help = spawnSync(process.execPath, [runner, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.doesNotMatch(help.stdout, /--task-model|--normal-flow/);
  for (const flag of ['--task-model=legacy', '--task-model=flat', '--normal-flow']) {
    const result = spawnSync(process.execPath, [runner, flag], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, flag);
    assert.match(result.stderr, /unknown option:/, flag);
  }
});

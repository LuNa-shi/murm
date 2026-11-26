import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../scripts/murm.js', import.meta.url));
const setup = fileURLToPath(new URL('../../scripts/setup', import.meta.url));

test('the host bin and checkout entry advertise the same setup command', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.bin.murm, 'dist/scripts/murm.js');
  assert.equal(manifest.bin.swarm, 'dist/scripts/swarm.js');
  const result = execFileSync(process.execPath, [cli, 'setup', '--help'], { encoding: 'utf8' });
  assert.match(result, /murm setup --template subagents --dir/);
  assert.equal(execFileSync(setup, ['--help'], { encoding: 'utf8' }), result);
});

test('murm rejects an invalid argument before loading developer configuration', () => {
  const result = spawnSync(process.execPath, [cli, 'doctor', '--config', '/does-not-exist', '--unknown'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: murm doctor/);
});

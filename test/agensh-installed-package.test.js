import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { installNotesExample, execute } from './fixtures/notes-installed-package.js';

test('offline archive ships the native Agensh host configuration and declared foreground entries', { timeout: 180_000 }, async t => {
  const installed = await installNotesExample(); t.after(() => installed.close());
  const root = join(installed.directory, 'node_modules/@swarmenv/core');
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.ok(metadata.exports['./backends/pi-opensandbox']);
  for (const path of ['test/fixtures/agensh-installed-host.mjs', 'scripts/run-environment.mjs', 'scripts/read-environment-result.mjs']) {
    await execute(process.execPath, ['--check', join(root, path)], { cwd: installed.directory, env: installed.env, timeout: 10_000 });
  }
  const help = await execute(process.execPath, [join(root, 'scripts/run-environment.mjs'), '--help'], { cwd: installed.directory, env: installed.env, timeout: 10_000 });
  assert.match(help.stdout, /--config <host-module.mjs>/); assert.match(help.stdout, /status, kickoff, input, wait or stop/);
});

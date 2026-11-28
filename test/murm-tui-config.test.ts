import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LauncherConfiguration } from '../scripts/murm-tui-config.js';

test('launcher configuration preserves precedence, scopes environment and remembers only an explicit path', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'murm-launcher-'));
  const workspace = join(directory, 'work');
  const prefs = join(directory, 'prefs');
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = prefs;
  t.after(async () => {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(workspace);
  await writeFile(join(workspace, 'main.js'), 'throw new Error("main must not load");\n');
  await writeFile(join(workspace, 'config.js'), 'throw new Error("untrusted config must not load");\n');
  await writeFile(join(directory, 'trusted.mjs'), 'export default {source: process.env.MURM_TUI_CONFIG_SCOPE};\n');
  await writeFile(join(directory, '.env'), 'MURM_TUI_CONFIG_SCOPE="local"\n');
  const create = (path?: string, id = 'out-of-tree') => new LauncherConfiguration(id, './harness.mjs', directory, 'work', path);
  const explicit = create('trusted.mjs');
  await explicit.refresh();
  assert.equal(explicit.workspace, workspace);
  assert.equal(explicit.configuration?.source, 'local');
  assert.equal(process.env.MURM_TUI_CONFIG_SCOPE, undefined);
  await explicit.remember();
  const preferencePath = join(prefs, 'murm', 'launcher.json');
  assert.equal((await stat(preferencePath)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(preferencePath, 'utf8')), {
    version: 1, harness: 'out-of-tree', configPath: join(directory, 'trusted.mjs'),
  });
  const remembered = create();
  await remembered.refresh();
  assert.equal(remembered.source, 'remembered');
  assert.equal(remembered.configuration?.source, 'local');
  const otherHarness = create(undefined, 'other');
  await otherHarness.refresh();
  assert.equal(otherHarness.configuration, undefined);
  const invalid = create('missing.mjs');
  await invalid.refresh();
  assert.equal(invalid.source, '--config');
  assert.match(invalid.error!, /Could not load/);
  await invalid.select('trusted.mjs');
  assert.equal(invalid.configuration?.source, 'local');
  await rm(join(directory, 'trusted.mjs'));
  await remembered.refresh();
  assert.match(remembered.error!, /Could not load/);
  await writeFile(preferencePath, '{"version": 99}\n', { mode: 0o600 });
  await remembered.refresh();
  assert.match(remembered.error!, /preferences/);
  await remembered.forget();
  assert.equal(remembered.error, undefined);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execute, installNotesExample } from './fixtures/notes-installed-package.js';

const fixture = new URL('./fixtures/notes-installed-package.js', import.meta.url).href;
test('frozen archive requires an explicit SHA-256 and rejects changed bytes before any npm consumption', async t => {
  const root = await mkdtemp(join(tmpdir(), 'notes-frozen-guard-')); t.after(() => rm(root, { recursive: true, force: true }));
  const archive = join(root, 'candidate.tgz'); await writeFile(archive, 'changed candidate');
  const script = `import assert from 'node:assert/strict'; import {installNotesExample} from ${JSON.stringify(fixture)};
    for (const options of [ {archive:${JSON.stringify(archive)}}, {expectedSha256:'a'.repeat(64)}, {archive:${JSON.stringify(archive)},expectedSha256:'invalid'} ]) {
      await assert.rejects(installNotesExample(options), {code:'INVALID_FROZEN_PACKAGE'});
    }
    await assert.rejects(installNotesExample({archive:${JSON.stringify(archive)},expectedSha256:'a'.repeat(64)}), error => {
      assert.equal(error.code,'FROZEN_PACKAGE_DIGEST_MISMATCH');
      assert.equal(error.message,'Frozen package digest does not match'); return true;
    });`;
  await execute(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, PATH: '' }, timeout: 5000 });
});

test('matching frozen archive installs its exact bytes outside checkout without attributing current Git provenance', { timeout: 30_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'notes-frozen-install-')); t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, 'package');
  await mkdir(join(packageRoot, 'examples/notes-environment'), { recursive: true });
  await mkdir(join(packageRoot, 'src/environments/shared'), { recursive: true });
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@swarmenv/core', version: '0.0.0-frozen-fixture', type: 'module', exports: './examples/notes-environment/main.mjs' }));
  await writeFile(join(packageRoot, 'examples/notes-environment/main.mjs'), "export const marker = 'frozen-candidate';\n");
  for (const name of ['run-input', 'run-report']) await writeFile(join(packageRoot, `src/environments/shared/${name}.js`), `export const name = '${name}';\n`);
  const archive = join(root, 'candidate.tgz');
  await execute('tar', ['-czf', archive, 'package'], { cwd: root, timeout: 5000 });
  const bytes = await readFile(archive), expectedSha256 = createHash('sha256').update(bytes).digest('hex');
  const installed = await installNotesExample({ archive, expectedSha256 }); t.after(() => installed.close());
  assert.deepEqual(installed.metadata, { name: '@swarmenv/core', version: '0.0.0-frozen-fixture', sourceCommit: null, sourceDirty: null, sha256: expectedSha256 });
  assert.deepEqual(await readFile(join(installed.directory, 'frozen-package.tgz')), bytes);
  const result = await execute(process.execPath, ['--input-type=module', '-e', "import assert from 'node:assert/strict'; import {marker} from '@swarmenv/core'; import {name} from './run-input.mjs'; assert.equal(marker,'frozen-candidate'); assert.equal(name,'run-input');"], { cwd: installed.directory, env: installed.env, timeout: 5000 });
  assert.equal(result.stderr, '');
  assert.deepEqual(await readFile(archive), bytes);
});

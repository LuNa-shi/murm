import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { execute } from './fixtures/notes-installed-package.js';

for (const [file, missing] of [
  ['package-third-party-notices.test.js', 'src/judge/lean-module-verify.LICENSE.txt'],
  ['shipped-image-build-inputs.test.js', 'services/opensandbox-agent/Dockerfile'],
]) {
  test(`archive audit ${file} consumes the selected frozen bytes instead of repacking the checkout`, { timeout: 30_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'archive-audit-selection-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await mkdir(join(directory, 'package'));
    await writeFile(join(directory, 'package/package.json'), JSON.stringify({ name: 'incomplete-audit-fixture', version: '0.0.0' }));
    const archive = join(directory, 'candidate.tgz');
    await execute('tar', ['-czf', archive, 'package'], { cwd: directory, timeout: 5000 });
    const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
    const env = { ...process.env, MURM_TEST_PACKAGE_ARCHIVE: archive, MURM_TEST_PACKAGE_SHA256: digest };
    delete env.NODE_TEST_CONTEXT;
    await assert.rejects(execute(process.execPath, ['--test', fileURLToPath(new URL(file, import.meta.url))], {
      cwd: directory, env, timeout: 25_000, maxBuffer: 2 * 1024 ** 2,
    }), error => {
      assert.ok((error.stdout + error.stderr).includes(missing), 'audit must report the missing file from the selected archive');
      return true;
    });
  });
}

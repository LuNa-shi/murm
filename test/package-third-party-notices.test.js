import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { preparePackageArchive } from './fixtures/notes-installed-package.js';

const execute = promisify(execFile);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('actual candidate archive carries pinned third-party sources, licenses and scoped notices', { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'package-third-party-notices-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { archive } = await preparePackageArchive(directory);
  const listing = await execute('tar', ['-tzf', archive], { timeout: 5000, maxBuffer: 4 * 1024 ** 2 });
  const files = new Set(listing.stdout.trim().split('\n').filter(path => !path.endsWith('/')).map(path => path.replace(/^package\//, '')));
  const readEntry = async path => {
    assert.ok(files.has(path), `Missing third-party distribution file: ${path}`);
    return (await execute('tar', ['-xOf', archive, `package/${path}`], { encoding: 'buffer' })).stdout;
  };
  // Check the exact bytes from the pinned upstream LICENSE.
  const license = await readEntry('src/judge/lean-module-verify.LICENSE.txt');
  assert.equal(sha256(license), '8b28515ffffc5c0fe2807d8ae3735b00b324d9b7ce807dd63ff6ac8922fbce7e');
  const leanNotice = (await readEntry('src/judge/lean-module-verify.NOTICE.md')).toString();
  assert.ok(leanNotice.includes('leanprover/lean4/blob/v4.33.1/src/LeanChecker.lean'));
  assert.ok(leanNotice.includes('Modified in SwarmEnv'));
  const driver = (await readEntry('src/judge/lean-module-verify.lean')).toString();
  assert.ok(driver.includes('Copyright (c) 2023 Kim Morrison. All rights reserved.'));
  assert.ok(driver.includes('Authors: Kim Morrison, Sebastian Ullrich'));
  assert.ok(driver.includes('Modified in SwarmEnv'));

  const boardSchema = await readEntry('test/fixtures/agensh-board-schema.sql');
  assert.equal(sha256(boardSchema), 'baa0ce607371751d6e7a526179512f2ff3a59ede88749059bed1a2522b3f3bb2');
  const boardLicense = await readEntry('test/fixtures/agensh-board-schema.LICENSE.txt');
  assert.equal(sha256(boardLicense), 'a933571159c8bd878114a7b7206964c2ae9b7ff45fd80e3021e0c699d38412da');
  const boardNotice = boardLicense.toString();
  assert.ok(boardNotice.includes('Source: third_party/agensh/mini-router/sql/03_board_schema.sql'));
  assert.ok(boardNotice.includes('Revision: 2dae4e14a653da48549fd9aa093f834841475d6c'));
  assert.ok(boardNotice.includes('MIT License'));
  assert.ok(boardNotice.includes('Copyright (c) Microsoft Corporation.'));
});

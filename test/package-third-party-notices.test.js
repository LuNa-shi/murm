import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const execute = promisify(execFile);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('actual candidate archive carries the pinned Lean license and scoped source notice', { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'package-third-party-notices-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const packed = await execute('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', directory], {
    cwd: new URL('..', import.meta.url), timeout: 20_000, maxBuffer: 4 * 1024 ** 2,
  });
  const manifest = JSON.parse(packed.stdout)[0];
  const files = new Set(manifest.files.map(file => file.path));
  const archive = join(directory, manifest.filename);
  const readEntry = async path => {
    assert.ok(files.has(path), `Missing third-party distribution file: ${path}`);
    return (await execute('tar', ['-xOf', archive, `package/${path}`], { encoding: 'buffer' })).stdout;
  };
  // Exact bytes from the pinned upstream LICENSE file, not a shortened label
  // or a synthesized license that could lose source-specific text.
  for (const [path, expected] of [
    ['src/judge/lean-module-verify.LICENSE.txt', '8b28515ffffc5c0fe2807d8ae3735b00b324d9b7ce807dd63ff6ac8922fbce7e'],
  ]) assert.equal(sha256(await readEntry(path)), expected);
  const leanNotice = (await readEntry('src/judge/lean-module-verify.NOTICE.md')).toString();
  assert.ok(leanNotice.includes('leanprover/lean4/blob/v4.33.1/src/LeanChecker.lean'));
  assert.ok(leanNotice.includes('Modified in SwarmEnv'));
  const driver = (await readEntry('src/judge/lean-module-verify.lean')).toString();
  assert.ok(driver.includes('Copyright (c) 2023 Kim Morrison. All rights reserved.'));
  assert.ok(driver.includes('Authors: Kim Morrison, Sebastian Ullrich'));
  assert.ok(driver.includes('Modified in SwarmEnv'));
  const packageMetadata = JSON.parse((await readEntry('package.json')).toString());
  assert.equal(packageMetadata.private, true);
  assert.equal(Object.hasOwn(packageMetadata, 'license'), false);
});

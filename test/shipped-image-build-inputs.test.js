import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);

test('shipped image contexts contain every COPY input and install their locked dependencies offline', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'swarmenv-image-build-inputs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const packed = await execute('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', directory], {
    cwd: new URL('..', import.meta.url), timeout: 20_000, maxBuffer: 4 * 1024 ** 2,
  });
  const manifest = JSON.parse(packed.stdout)[0];
  const files = manifest.files.map(file => file.path);
  await execute('tar', ['-xzf', join(directory, manifest.filename), '-C', directory]);
  const root = join(directory, 'package');
  for (const name of ['opensandbox-agent', 'builtin', 'mathlib-search']) {
    const dockerfile = await readFile(join(root, 'services', name, 'Dockerfile'), 'utf8');
    for (const line of dockerfile.split('\n').filter(line => line.startsWith('COPY ') && !line.includes('--from='))) {
      const inputs = line.split(/\s+/).slice(1, -1).filter(part => !part.startsWith('--'));
      for (const input of inputs) {
        assert.ok(files.some(path => path === input || path.startsWith(`${input}/`)), `${name} image COPY input is absent from the archive: ${input}`);
      }
    }
  }
  await execute('npm', ['ci', '--offline', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: root, timeout: 30_000, maxBuffer: 4 * 1024 ** 2,
  });
  await execute('npm', ['install', '--offline', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: root, timeout: 15_000, maxBuffer: 4 * 1024 ** 2,
  });
  const pi = JSON.parse(await readFile(join(root, 'node_modules/@earendil-works/pi-coding-agent/package.json'), 'utf8'));
  assert.equal(pi.version, '1.3.0');
});

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { preparePackageArchive } from './fixtures/notes-installed-package.js';

const execute = promisify(execFile);

test('shipped image contexts contain every COPY input and install their locked dependencies offline', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'murm-image-build-inputs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { archive } = await preparePackageArchive(directory);
  const listing = await execute('tar', ['-tzf', archive], { timeout: 5000, maxBuffer: 4 * 1024 ** 2 });
  const files = listing.stdout.trim().split('\n').filter(path => !path.endsWith('/')).map(path => path.replace(/^package\//, ''));
  await execute('tar', ['-xzf', archive, '-C', directory]);
  const root = join(directory, 'package');
  for (const name of ['worker', 'builtin-services', 'mathlib-search']) {
    const dockerfile = await readFile(join(root, 'deploy', name, 'Dockerfile'), 'utf8');
    for (const line of dockerfile.split('\n').filter(line => line.startsWith('COPY ') && !line.includes('--from='))) {
      const inputs = line.split(/\s+/).slice(1, -1).filter(part => !part.startsWith('--'));
      for (const input of inputs) {
        assert.ok(files.some(path => path === input || path.startsWith(`${input}/`)), `${name} image COPY input is absent from the archive: ${input}`);
      }
    }
  }
  for (const resource of [
    'deploy/opensandbox/config.toml', 'deploy/builtin-services/compose.yaml', 'dist/deploy/worker/pi-models.json',
    'scripts/local-setup/templates/config.js', 'scripts/local-setup/templates/environment.js',
    'src/services/mathlib-search/service.json', 'src/services/mathlib-search/SKILL.md',
    'src/services/mathlib-search/references/loogle.md', 'dist/src/services/mathlib-search/service.js',
  ]) {
    assert.ok(files.includes(resource), `runtime or deployment resource is absent from the archive: ${resource}`);
  }
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.devDependencies['@earendil-works/pi-coding-agent'], '1.3.0');
  await execute('npm', ['ci', '--offline', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: root, timeout: 30_000, maxBuffer: 4 * 1024 ** 2,
  });
  await assert.rejects(readFile(join(root, 'node_modules/@earendil-works/pi-coding-agent/package.json')), { code: 'ENOENT' });
  await rm(join(root, 'node_modules'), { recursive: true });
  await execute('npm', ['install', '--offline', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: root, timeout: 15_000, maxBuffer: 4 * 1024 ** 2,
  });
  await assert.rejects(readFile(join(root, 'node_modules/@earendil-works/pi-coding-agent/package.json')), { code: 'ENOENT' });
});

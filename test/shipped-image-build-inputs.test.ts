import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
  const composePath = join(root, 'examples/taskpool/deploy/service-hosts/compose.yaml');
  const compose = await readFile(composePath, 'utf8');
  const context = compose.match(/^  context: (.+)$/m)?.[1];
  const recipe = compose.match(/^  dockerfile: (.+)$/m)?.[1];
  assert.ok(context && recipe, 'TaskPool Compose declares its build context and Dockerfile');
  const composeRoot = resolve(dirname(composePath), context);
  assert.equal(composeRoot, root, 'TaskPool Compose builds from the installed package root');
  await readFile(resolve(composeRoot, recipe), 'utf8');
  for (const recipe of [
    'deploy/worker/Dockerfile',
    'examples/taskpool/deploy/service-hosts/Dockerfile',
    'examples/services/mathlib-search/Dockerfile',
  ]) {
    const dockerfile = await readFile(join(root, recipe), 'utf8');
    for (const line of dockerfile.split('\n').filter(line => line.startsWith('COPY ') && !line.includes('--from='))) {
      const inputs = line.split(/\s+/).slice(1, -1).filter(part => !part.startsWith('--'));
      for (const input of inputs) {
        assert.ok(files.some(path => path === input || path.startsWith(`${input}/`)), `${recipe} COPY input is absent from the archive: ${input}`);
      }
    }
  }
  for (const resource of [
    'deploy/opensandbox/config.toml', 'examples/taskpool/deploy/service-hosts/compose.yaml', 'dist/deploy/worker/pi-models.json',
    'scripts/local-setup/templates/config.js', 'scripts/local-setup/templates/environment.js',
    'examples/services/mathlib-search/service.json', 'examples/services/mathlib-search/SKILL.md',
    'examples/services/mathlib-search/references/loogle.md', 'dist/examples/services/mathlib-search/service.js',
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

import { spawnSync } from 'node:child_process';
import { chmod, cp, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = resolve(root, 'dist');
const compiler = fileURLToPath(new URL('./bin/tsc', import.meta.resolve('typescript/package.json')));

await rm(dist, { recursive: true, force: true });
const result = spawnSync(process.execPath, [compiler, '--project', 'tsconfig.json'], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

// Preserve the relative locations used by runtime scripts and compiled tests.
// The Docker build supplies the production trees only.
for (const directory of ['src', 'scripts', 'services', 'examples', 'test']) {
  const source = resolve(root, directory);
  if (!(await stat(source).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  }))) continue;
  await cp(source, resolve(dist, directory), {
    recursive: true,
    filter: (path) => !/\.[cm]?[jt]s$/.test(path),
  });
}

// During incremental migration the three JavaScript public entries still
// use their existing declarations. This copy retires with the TypeScript entries.
for (const path of ['src/core/index.d.ts', 'src/core/services.d.ts', 'src/core/backends/pi-opensandbox.d.ts']) {
  const source = resolve(root, path);
  if (await stat(source).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  })) await cp(source, resolve(dist, path));
}
await chmod(resolve(dist, 'scripts/swarm.mjs'), 0o755);

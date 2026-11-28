import { spawnSync } from 'node:child_process';
import { chmod, cp, readdir, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = resolve(root, 'dist');
const compiler = fileURLToPath(new URL('./bin/tsc', import.meta.resolve('typescript/package.json')));

function compile(project: string) {
  const result = spawnSync(process.execPath, [compiler, '--project', project], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

await rm(resolve(root, 'node_modules/.murm-setup-build'), { force: true });
await rm(dist, { recursive: true, force: true });
compile('tsconfig.json');

// Preserve the relative locations used by runtime scripts and compiled tests.
// The Docker build supplies the production trees only.
for (const directory of ['src', 'scripts', 'deploy', 'examples', 'benchmarks/fate', 'benchmarks/lead-worker-orders', 'test']) {
  const source = resolve(root, directory);
  if (!(await stat(source).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  }))) continue;
  if (directory === 'test') compile('tsconfig.tests.json');
  await cp(source, resolve(dist, directory), {
    recursive: true,
    filter: path => (!/\.[cm]?[jt]s$/.test(path) || path.includes('/lead-worker-orders/fixtures/')) &&
      !/\/(?:dist|node_modules|\.murm)(?:\/|$)/.test(path.slice(root.length)) &&
      !/\/examples\/[^/]+\/(?:package(?:-lock)?|tsconfig)\.json$/.test(path.slice(root.length)),
  });
}

// TypeScript emits package boundaries for separately installable examples.
// The bundled CLI resolves those same modules inside the SDK package scope.
for (const example of await readdir(resolve(dist, 'examples'), { withFileTypes: true })) {
  if (example.isDirectory()) await rm(resolve(dist, 'examples', example.name, 'package.json'), { force: true });
}

// Ship the zero-dependency Trace Viewer modules and browser assets alongside compiled src/.
const traceViewerSource = resolve(root, 'src/trace-viewer');
if (await stat(traceViewerSource).catch(error => {
  if (error.code === 'ENOENT') return null;
  throw error;
})) {
  await cp(traceViewerSource, resolve(dist, 'src/trace-viewer'), { recursive: true });
}

for (const name of ['murm', 'swarm']) {
  await chmod(resolve(dist, `scripts/${name}.js`), 0o755);
}

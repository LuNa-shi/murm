import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = fileURLToPath(import.meta.url);
const sourceModule = (file: string) => new URL(file, import.meta.url).href;
const { parseMurmCommand, setupUsage } = await import(sourceModule('murm-arguments.ts')) as typeof import('./murm-arguments.js');

function failure(id: string, detail: string, remedy: string) {
  console.log(JSON.stringify({ command: 'setup', ok: false, checks: [{ id, ok: false, detail, remedy }] }, null, 2));
}

async function exists(path: string) {
  return access(path).then(() => true, () => false);
}

async function buildFingerprint(lock: string) {
  const hash = createHash('sha256').update(lock);
  async function add(path: string) {
    hash.update(path).update('\0').update(await readFile(join(root, path))).update('\0');
  }
  async function walk(directory: string) {
    const entries = await readdir(join(root, directory), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const path = join(directory, entry.name);
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) await add(path);
    }
  }
  await add('tsconfig.json');
  await add('tsconfig.tests.json');
  for (const path of ['src', 'scripts', 'services', 'examples', 'test', 'test-support']) await walk(path);
  return hash.digest('hex');
}

const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => controller.abort(signal));
}
const { signal } = controller;
const signalStatus = () => signal.reason === 'SIGTERM' ? 143 : 130;

function child(file: string, args: string[], env = process.env, forwardStdout = false): Promise<number> {
  signal.throwIfAborted();
  const running = spawn(file, args, {
    cwd: root, env, stdio: ['inherit', forwardStdout ? 'inherit' : 2, 'inherit'],
  });
  const cancel = () => running.kill(signal.reason as NodeJS.Signals);
  signal.addEventListener('abort', cancel, { once: true });
  return new Promise<number>((resolve, reject) => {
    running.once('error', reject);
    running.once('close', (status, killedWith) => resolve(status ?? (killedWith === 'SIGINT' ? 130 : 143)));
  }).finally(() => signal.removeEventListener('abort', cancel));
}

async function lockedSetup(startedAt: number) {
  const bootstrap: { startedAt: number; timings: { id: string; elapsedMs: number; cached: boolean }[] } = { startedAt, timings: [] };
  const manifest = await readFile(join(root, 'package.json'));
  const shrinkwrap = await readFile(join(root, 'npm-shrinkwrap.json'));
  const lock = createHash('sha256').update(process.versions.node).update(manifest).update(shrinkwrap).digest('hex');
  const depsStamp = join(root, 'node_modules/.murm-setup-lock');
  const distStamp = join(root, 'node_modules/.murm-setup-build');
  const matches = (path: string, value: string) => readFile(path, 'utf8').then(previous => previous === value, () => false);
  let start = performance.now();
  const depsCached = await matches(depsStamp, lock) && await exists(join(root, 'node_modules/.bin/tsc'));
  if (!depsCached) {
    if (await child('npm', ['ci', '--include=dev', '--prefer-offline', '--ignore-scripts', '--no-audit', '--no-fund']) !== 0) {
      failure('dependencies', 'npm could not install the locked checkout dependencies.', 'Check npm connectivity, cache and disk space, then rerun setup.');
      return signal.aborted ? signalStatus() : 1;
    }
    await writeFile(depsStamp, lock, { mode: 0o600 });
  }
  bootstrap.timings.push({ id: 'dependencies', elapsedMs: Math.round(performance.now() - start), cached: depsCached });

  start = performance.now();
  const build = await buildFingerprint(lock);
  const cli = join(root, 'dist/scripts/murm.js');
  const buildCached = await matches(distStamp, build) && await exists(cli);
  if (!buildCached) {
    if (await child(process.execPath, [join(root, 'scripts/build.ts')]) !== 0) {
      failure('build', 'The checkout did not compile.', 'Fix the build error above and rerun setup.');
      return signal.aborted ? signalStatus() : 1;
    }
    await writeFile(distStamp, build, { mode: 0o600 });
  }
  bootstrap.timings.push({ id: 'build', elapsedMs: Math.round(performance.now() - start), cached: buildCached });

  return child(process.execPath, [cli, 'setup'],
    { ...process.env, MURM_SETUP_BOOTSTRAP: JSON.stringify(bootstrap) }, true);
}

const args = process.argv.slice(2);
const lockInvocation = args[0] === '--under-checkout-lock';
try {
  if (lockInvocation) {
    process.exitCode = await lockedSetup(Number(args[1]));
  } else {
    const startedAt = Date.now();
    const command = parseMurmCommand(['setup', ...args]);
    if ('help' in command) {
      console.log(command.help);
    } else {
      const { resolveSubagentsEnvironment, checkLocalHost } = await import(sourceModule('local-environment.ts')) as typeof import('./local-environment.js');
      const config = await resolveSubagentsEnvironment();
      signal.throwIfAborted();
      const checks = await checkLocalHost(config);
      signal.throwIfAborted();
      if (checks.some(check => !check.ok)) {
        console.log(JSON.stringify({ command: 'setup', ok: false, checks, elapsedMs: Date.now() - startedAt }, null, 2));
        process.exitCode = 1;
      } else {
        process.exitCode = await child('flock', ['--no-fork', '--exclusive', '--timeout', '180', '--conflict-exit-code', '73',
          root, process.execPath, '--disable-warning=ExperimentalWarning', script, '--under-checkout-lock',
          String(startedAt)], process.env, true);
        if (process.exitCode === 73) {
          failure('checkout-lock', 'Another setup still holds the checkout lock.', 'Wait for the other invocation and rerun setup.');
          process.exitCode = 1;
        }
      }
    }
  }
} catch (error) {
  if (signal.aborted) {
    failure('interrupted', 'Setup was interrupted before infrastructure preparation.', 'Rerun setup to continue.');
    process.exitCode = signalStatus();
  } else if (error instanceof Error && error.message === setupUsage) {
    console.error(setupUsage);
    process.exitCode = 2;
  } else {
    failure('bootstrap', 'The checkout could not be prepared.', 'Check Node.js, npm, flock and permissions on this checkout.');
    process.exitCode = 1;
  }
}

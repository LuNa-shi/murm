import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { createSubagentsHarness } from '../examples/subagents/main.js';
import { resolveLocalDocker, resolveSubagentsEnvironment } from './local-environment.js';
import { loadMurmConfig } from '../src/core/sandbox-connection.js';
import { workerImageFor } from '../src/core/worker-image.js';

const execute = promisify(execFile);
const packageRoot = fileURLToPath(new URL('../../', import.meta.url));

export interface SubagentsProjectOptions {
  directory: string;
  image: string;
  lifecycleBaseUrl: string;
  endpointHost?: string;
  advertiseHost?: string;
  packageArchive?: string;
  signal?: AbortSignal;
}

export type LocalProjectConfig = Parameters<typeof createSubagentsHarness>[0];

export async function loadLocalProjectConfig(filename: string): Promise<LocalProjectConfig> {
  return await loadMurmConfig(filename) as LocalProjectConfig;
}

async function exists(filename: string) {
  try { await stat(filename); return true; }
  catch (error: any) { if (error.code === 'ENOENT') return false; throw error; }
}

function environment(options: SubagentsProjectOptions) {
  const fields = {
    MURM_SUBAGENTS_IMAGE: options.image,
    MURM_SUBAGENTS_LIFECYCLE_URL: options.lifecycleBaseUrl,
    MURM_SUBAGENTS_ENDPOINT_HOST: options.endpointHost,
    MURM_SUBAGENTS_ADVERTISE_HOST: options.advertiseHost,
    MURM_SUBAGENTS_MODEL_URL: '',
    MURM_SUBAGENTS_MODEL_TOKEN: '',
    MURM_SUBAGENTS_LIFECYCLE_TOKEN: '',
  };
  return '# Set your Responses endpoint and credentials, then run murm in this directory.\n' +
    Object.entries(fields).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n';
}

/** Generate editable host files and install the actual distributable archive. */
export async function prepareSubagentsProject(options: SubagentsProjectOptions) {
  const directory = resolve(options.directory);
  const createdFiles: string[] = [];
  const preservedFiles: string[] = [];
  options.signal?.throwIfAborted();
  await mkdir(directory, { recursive: true });
  const lock = join(directory, '.murm-setup.lock');
  try { await mkdir(lock); }
  catch (error: any) {
    if (error.code === 'EEXIST') throw Object.assign(new Error('Another murm init owns this directory. Wait for it to finish, or remove .murm-setup.lock after confirming its process has stopped.'), { code: 'SETUP_BUSY', directory });
    throw error;
  }
  let temporary: string | undefined;
  try {
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const metadata = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    temporary = await mkdtemp(join(tmpdir(), 'murm-template-'));
    let archive = options.packageArchive && resolve(options.packageArchive);
    if (!archive) {
      const packed = await execute('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], {
        cwd: packageRoot, signal: options.signal, timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
      });
      archive = join(temporary, JSON.parse(packed.stdout)[0].filename);
    }
    let archiveMetadata;
    try {
      const extracted = await execute('tar', ['-xOf', archive, 'package/package.json'], {
        signal: options.signal, timeout: 10_000, maxBuffer: 1024 * 1024,
      });
      archiveMetadata = JSON.parse(extracted.stdout);
    } catch (error) {
      options.signal?.throwIfAborted();
      throw Object.assign(new Error('The candidate archive must contain a valid package/package.json.'), { code: 'PACKAGE_ARCHIVE_INVALID', cause: error });
    }
    if (archiveMetadata.name !== '@luna-shi/murm' || archiveMetadata.version !== metadata.version) {
      throw Object.assign(new Error('The candidate archive identity must match this setup package.'), { code: 'PACKAGE_IDENTITY_MISMATCH' });
    }
    const archiveSha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
    const archiveName = `core-${archiveSha256}.tgz`;
    const privateDirectory = join(directory, '.murm');
    await mkdir(privateDirectory, { recursive: true });
    const destinationArchive = join(privateDirectory, archiveName);
    if (!(await exists(destinationArchive))) {
      // A killed copy cannot leave a partial archive that blocks a retry.
      const localArchive = join(privateDirectory, `${archiveName}.${randomUUID()}`);
      try {
        await copyFile(archive, localArchive);
        await rename(localArchive, destinationArchive);
      } finally {
        await rm(localArchive, { force: true });
      }
    }

    async function create(filename: string, contents: string, mode = 0o644) {
      options.signal?.throwIfAborted();
      try {
        await writeFile(join(directory, filename), contents, { flag: 'wx', mode });
        createdFiles.push(filename);
      } catch (error: any) {
        if (error.code !== 'EEXIST') throw error;
        preservedFiles.push(filename);
      }
    }
    await create('package.json', JSON.stringify({ name: 'my-murm', version: '1.0.0', private: true, type: 'module',
      scripts: { start: 'murm', doctor: 'murm doctor --config config.js' },
      dependencies: { '@luna-shi/murm': `file:.murm/${archiveName}` },
    }, null, 2) + '\n');
    const projectPackage = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    if (projectPackage.type !== 'module') throw Object.assign(new Error('The target package.json must declare type "module" for this Subagents project.'), { code: 'PROJECT_PACKAGE_INCOMPATIBLE' });
    for (const filename of ['main', 'controller', 'collaboration-service', 'prompts']) {
      const text = await readFile(join(packageRoot, 'dist/examples/subagents', `${filename}.js`), 'utf8');
      await create(`${filename}.js`, filename === 'main' ? `import './environment.js';\n${text}` : text);
    }
    await create('run-report.js', await readFile(join(packageRoot, 'dist/src/harnesses/shared/run-report.js'), 'utf8'));
    for (const filename of ['environment.js', 'config.js']) {
      await create(filename, await readFile(join(packageRoot, 'scripts/local-setup/templates', filename), 'utf8'));
    }
    await create('.env', environment(options), 0o600);
    await create('.gitignore', 'node_modules/\n.env\n.murm/\n.murm-setup.lock/\nsubagents-runs/\n');

    const installedMetadata = join(directory, 'node_modules/@luna-shi/murm/package.json');
    const installedRecord = join(privateDirectory, 'installed.json');
    let installed = false;
    const record = await readFile(installedRecord, 'utf8').then(JSON.parse).catch(() => undefined);
    if (!record || record.archiveSha256 !== archiveSha256 || !(await exists(installedMetadata))) {
      await execute('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline', '--no-save', '--package-lock=false', destinationArchive], {
        cwd: directory, signal: options.signal, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
      });
      const candidate = JSON.parse(await readFile(installedMetadata, 'utf8'));
      if (candidate.name !== '@luna-shi/murm' || candidate.version !== metadata.version) throw Object.assign(new Error('Installed package identity does not match the setup package.'), { code: 'PACKAGE_IDENTITY_MISMATCH' });
      const nextRecord = `${installedRecord}.${randomUUID()}`;
      await writeFile(nextRecord, JSON.stringify({ archiveSha256, version: candidate.version }) + '\n');
      await rename(nextRecord, installedRecord);
      installed = true;
    }
    return { directory, configPath: join(directory, 'config.js'), archiveSha256, createdFiles, preservedFiles, installed };
  } catch (error: any) {
    throw Object.assign(error, { directory, createdFiles, preservedFiles });
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}

export async function initializeSubagentsProject(directory: string, signal: AbortSignal) {
  const start = performance.now();
  try {
    const config = await resolveSubagentsEnvironment();
    const advertiseHost = config.advertiseHost ?? (config.mode === 'local'
      ? (await resolveLocalDocker().catch(() => undefined))?.advertiseHost : undefined);
    const project = await prepareSubagentsProject({
      directory, image: config.image ?? workerImageFor(process.env.MURM_EXECUTOR ?? process.env.MURM_SUBAGENTS_EXECUTOR),
      lifecycleBaseUrl: config.lifecycleBaseUrl, endpointHost: config.endpointHost,
      advertiseHost, signal,
    });
    return { command: 'init', ok: true, project, elapsedMs: Math.round(performance.now() - start) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const detail = signal.aborted ? 'Project initialization was interrupted.'
      : code === 'SETUP_BUSY' ? 'Another murm init owns this directory.'
      : code === 'PROJECT_PACKAGE_INCOMPATIBLE' ? 'The target package.json must declare type "module".'
      : 'Could not initialize the Subagents project. Check the target directory and npm access, then rerun murm init.';
    return { command: 'init', ok: false, detail, interrupted: signal.aborted, elapsedMs: Math.round(performance.now() - start) };
  }
}

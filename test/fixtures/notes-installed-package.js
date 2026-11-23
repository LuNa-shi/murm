import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

export const execute = promisify(execFile);
const repository = resolve(import.meta.dirname, '../..');

// Install the real archive: no checkout symlink, NODE_PATH or loader hooks.
export async function installNotesExample() {
  const directory = await mkdtemp(join(tmpdir(), 'swarmenv-notes-installed-'));
  try {
    const revision = await execute('git', ['rev-parse', 'HEAD'], { cwd: repository });
    const status = await execute('git', ['status', '--porcelain'], { cwd: repository });
    const packed = await execute('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', directory],
      { cwd: repository, timeout: 60_000, maxBuffer: 4 * 1024 ** 2 });
    const metadata = JSON.parse(packed.stdout)[0];
    const archive = join(directory, metadata.filename);
    await writeFile(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    await execute('npm', ['install', '--offline', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', archive],
      { cwd: directory, timeout: 120_000, maxBuffer: 4 * 1024 ** 2 });
    const installed = join(directory, 'node_modules', '@swarmenv', 'core');
    await copyFile(join(installed, 'examples/notes-environment/main.mjs'), join(directory, 'main.mjs'));
    for (const name of ['run-input', 'run-report']) {
      await copyFile(join(installed, `src/environments/shared/${name}.js`), join(directory, `${name}.mjs`));
    }
    const env = { ...process.env }; delete env.NODE_PATH; delete env.NODE_OPTIONS;
    return { directory, env, metadata: { name: metadata.name, version: metadata.version,
      sourceCommit: revision.stdout.trim(), sourceDirty: Boolean(status.stdout.trim()),
      sha256: createHash('sha256').update(await readFile(archive)).digest('hex') },
    close: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}

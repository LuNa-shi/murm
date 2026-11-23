import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

export const execute = promisify(execFile);
const repository = resolve(import.meta.dirname, '../..');

// Install the real archive: no checkout symlink, NODE_PATH or loader hooks.
export async function installNotesExample({ archive: frozenArchive, expectedSha256 } = {}) {
  const frozen = frozenArchive !== undefined || expectedSha256 !== undefined;
  if (frozen && (typeof frozenArchive !== 'string' || !frozenArchive || typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256))) {
    throw Object.assign(new Error('Frozen package requires an archive and expected SHA-256'), { code: 'INVALID_FROZEN_PACKAGE' });
  }
  // Snapshot and verify before npm sees the supplied artifact. Install these
  // exact bytes, so replacing the original path cannot change consumption.
  const bytes = frozen ? await readFile(resolve(frozenArchive)) : undefined;
  if (frozen && createHash('sha256').update(bytes).digest('hex') !== expectedSha256) {
    throw Object.assign(new Error('Frozen package digest does not match'), { code: 'FROZEN_PACKAGE_DIGEST_MISMATCH' });
  }
  const directory = await mkdtemp(join(tmpdir(), 'swarmenv-notes-installed-'));
  try {
    let sourceCommit = null, sourceDirty = null, archive;
    if (frozen) {
      archive = join(directory, 'frozen-package.tgz');
      await writeFile(archive, bytes, { flag: 'wx', mode: 0o600 });
    } else {
      const revision = await execute('git', ['rev-parse', 'HEAD'], { cwd: repository });
      const status = await execute('git', ['status', '--porcelain'], { cwd: repository });
      sourceCommit = revision.stdout.trim(); sourceDirty = Boolean(status.stdout.trim());
      const packed = await execute('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', directory],
        { cwd: repository, timeout: 60_000, maxBuffer: 4 * 1024 ** 2 });
      archive = join(directory, JSON.parse(packed.stdout)[0].filename);
    }
    await writeFile(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    await execute('npm', ['install', '--offline', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', archive],
      { cwd: directory, timeout: 120_000, maxBuffer: 4 * 1024 ** 2 });
    const installed = join(directory, 'node_modules', '@swarmenv', 'core');
    const metadata = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
    await copyFile(join(installed, 'examples/notes-environment/main.mjs'), join(directory, 'main.mjs'));
    for (const name of ['run-input', 'run-report']) {
      await copyFile(join(installed, `src/environments/shared/${name}.js`), join(directory, `${name}.mjs`));
    }
    const env = { ...process.env }; delete env.NODE_PATH; delete env.NODE_OPTIONS;
    return { directory, env, metadata: { name: metadata.name, version: metadata.version,
      sourceCommit, sourceDirty,
      sha256: createHash('sha256').update(await readFile(archive)).digest('hex') },
    close: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}

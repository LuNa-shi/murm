import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, realpath, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

export const execute = promisify(execFile);
const repository = resolve(import.meta.dirname, '../../..');

// Select and snapshot the actual package before audits or installation consume it.
export async function preparePackageArchive(directory, { archive: frozenArchive, expectedSha256 } = {
  archive: process.env.SWARMENV_TEST_PACKAGE_ARCHIVE,
  expectedSha256: process.env.SWARMENV_TEST_PACKAGE_SHA256,
}, { requireCleanCheckout = false } = {}) {
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
  let sourceCommit = null, sourceDirty = null, archive;
  if (frozen) {
    archive = join(directory, 'frozen-package.tgz');
    await writeFile(archive, bytes, { flag: 'wx', mode: 0o600 });
  } else {
    const revision = await execute('git', ['rev-parse', 'HEAD'], { cwd: repository });
    const status = await execute('git', ['status', '--porcelain'], { cwd: repository });
    sourceCommit = revision.stdout.trim(); sourceDirty = Boolean(status.stdout.trim());
    if (requireCleanCheckout && sourceDirty) {
      throw Object.assign(new Error('Native acceptance requires a clean package source pin'), { code: 'DIRTY_PACKAGE_SOURCE' });
    }
    const packed = await execute('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', directory],
      { cwd: repository, timeout: 60_000, maxBuffer: 4 * 1024 ** 2 });
    archive = join(directory, JSON.parse(packed.stdout)[0].filename);
  }
  return { archive, sourceCommit, sourceDirty };
}

// Native evidence is private and retained beneath the attempt, not OS temporary storage.
export async function createNativeEvidenceDirectory(name) {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(name)) throw new TypeError('A native evidence name is required');
  const root = join(process.cwd(), 'experiments');
  await mkdir(root, { recursive: true, mode: 0o700 });
  return mkdtemp(join(root, `${name}-`));
}

// Reject real checkout ancestry, including linked worktrees and symlinked TMPDIRs.
async function outsideCheckout(directory) {
  let current = await realpath(directory);
  for (;;) {
    if (await lstat(join(current, '.git')).then(() => true, error => {
      if (error.code === 'ENOENT') return false;
      throw error;
    })) return false;
    const parent = dirname(current);
    if (parent === current) return true;
    current = parent;
  }
}

// Install the real archive outside checkout ancestry: no symlink, NODE_PATH or loader hooks.
export async function installNotesExample(selection, { requireCleanCheckout = false, parentDirectory } = {}) {
  let parent;
  if (parentDirectory !== undefined) {
    if (typeof parentDirectory !== 'string' || !parentDirectory) throw Object.assign(new TypeError('A private installation parent directory is required'), { code: 'INVALID_INSTALL_PARENT' });
    parent = resolve(parentDirectory);
    const info = await lstat(parent).catch(() => null);
    if (!info?.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700) {
      throw Object.assign(new Error('Installation parent must be an owned private directory'), { code: 'INVALID_INSTALL_PARENT' });
    }
    if (!await outsideCheckout(parent)) throw Object.assign(new Error('Installation parent must be outside source checkouts'), { code: 'INSTALL_PARENT_IN_CHECKOUT' });
  } else {
    for (const candidate of [...new Set(requireCleanCheckout ? ['/var/tmp', tmpdir(), '/tmp'] : [tmpdir(), '/var/tmp', '/tmp'])]) {
      try { if (await outsideCheckout(candidate)) { parent = await realpath(candidate); break; } }
      catch (error) { if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) throw error; }
    }
    if (!parent) throw Object.assign(new Error('No external installation parent is available'), { code: 'INSTALL_PARENT_IN_CHECKOUT' });
  }
  if (process.env.HOME && !await outsideCheckout(process.env.HOME)) throw Object.assign(new Error('Installation HOME must be outside source checkouts'), { code: 'INSTALL_HOME_IN_CHECKOUT' });
  const directory = await mkdtemp(join(parent, 'swarmenv-notes-installed-'));
  try {
    const { archive, sourceCommit, sourceDirty } = await preparePackageArchive(directory, selection, { requireCleanCheckout });
    await writeFile(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    await execute('npm', ['install', '--offline', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', archive],
      { cwd: directory, timeout: 120_000, maxBuffer: 4 * 1024 ** 2 });
    const installed = join(directory, 'node_modules', '@swarmenv', 'core');
    const metadata = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
    const compiled = metadata.exports?.['.']?.default?.startsWith('./dist/');
    const executableRoot = compiled ? join(installed, 'dist') : installed;
    const extension = compiled ? 'js' : 'mjs';
    await copyFile(join(executableRoot, `examples/notes-environment/main.${extension}`), join(directory, 'main.mjs'));
    for (const name of ['run-input', 'run-report', 'read-result']) {
      await copyFile(join(executableRoot, `src/environments/shared/${name}.js`), join(directory, `${name}.${extension}`));
    }
    const env = { ...process.env }; delete env.NODE_PATH; delete env.NODE_OPTIONS;
    return { directory, env, metadata: { name: metadata.name, version: metadata.version,
      sourceCommit, sourceDirty,
      sha256: createHash('sha256').update(await readFile(archive)).digest('hex') },
    close: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}

// Native gates may consume an explicitly verified frozen archive or a clean checkout.
export function installNativeNotesExample({ parentDirectory } = {}) {
  return installNotesExample(undefined, { requireCleanCheckout: true, parentDirectory });
}

import { execFile } from 'node:child_process';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, opendir, realpath, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify, TextDecoder } from 'node:util';
import { completeDigest, isFileTreePath, isGitPath, maxFileBytes, maxFiles, maxTotalBytes, snapshotFileSeed } from '../../../scripts/core-file-seed.js';
import type { FileEntry } from '../../core/types.js';

const git = promisify(execFile);
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const maxPathBytes = 4095;
const maxPathDepth = 128;
const maxDirectoryEntries = 50_000;
const directoryFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY;
const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export function projectError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

export class ProjectPreflightError extends TypeError {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function resolveHarnessInput(value: unknown, launchDirectory: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => key !== 'cwd' && key !== 'prompt')) {
    throw projectError('INVALID_HARNESS_INPUT', 'Expected cwd and prompt');
  }
  const { cwd, prompt } = value as { cwd?: unknown; prompt?: unknown };
  if (typeof prompt !== 'string' || !prompt.trim() || !prompt.isWellFormed() ||
      (cwd !== undefined && (typeof cwd !== 'string' || !cwd || cwd.includes('\0') || !cwd.isWellFormed()))) {
    throw projectError('INVALID_HARNESS_INPUT', 'Expected a non-blank prompt and a valid directory path');
  }
  return Object.freeze({ cwd: resolve(launchDirectory, cwd ?? '.'), prompt });
}

export function isInside(directory: string, path: string) {
  const offset = relative(directory, path);
  return !isAbsolute(offset) && offset !== '..' && !offset.startsWith('..' + sep);
}

function normalizedPath(path: string) {
  const parts = path.split('/');
  if (!isFileTreePath(path)) {
    throw projectError('PROJECT_PATH_INVALID', `Invalid relative project path ${JSON.stringify(path)}`);
  }
  if (parts.length > maxPathDepth) {
    throw projectError('PROJECT_PATH_LIMIT', `Project path exceeds the capture depth limit: ${JSON.stringify(path)}`);
  }
  return parts;
}

function decodePath(bytes: Buffer | string) {
  if (typeof bytes === 'string') return bytes;
  try {
    return utf8.decode(bytes);
  } catch {
    throw projectError('PROJECT_PATH_INVALID', 'A project path cannot be represented as UTF-8');
  }
}

function sameFile(a: BigIntStats, b: BigIntStats) {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink &&
    a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

function sourceChanged(path: string) {
  return projectError('PROJECT_SOURCE_CHANGED', `Project source changed while capturing ${JSON.stringify(path)}`);
}

function accessPath(directory: FileHandle, name: string) {
  return `/proc/self/fd/${directory.fd}/${name}`;
}

async function gitFiles(cwd: string, signal: AbortSignal) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  const options = {
    cwd, signal, timeout: 10_000, env: { ...env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' },
    encoding: 'buffer' as const, maxBuffer: (maxPathBytes + 128) * maxFiles,
  };
  let workTree: string;
  try {
    const { stdout } = await git('git', ['rev-parse', '--is-inside-work-tree'], options);
    workTree = String(stdout).trim();
  } catch (error) {
    signal.throwIfAborted();
    const { stderr, code } = error as { stderr?: Buffer; code?: string | number };
    if (code === 128 && String(stderr).includes('not a git repository')) return null;
    throw projectError('PROJECT_GIT_FAILED', 'Could not determine the Git project scope');
  }
  if (workTree !== 'true') throw projectError('INVALID_PROJECT_DIRECTORY', 'Git administration paths cannot be used as a project directory');
  let tracked: Buffer;
  let untracked: Buffer;
  try {
    [{ stdout: tracked }, { stdout: untracked }] = await Promise.all([
      git('git', ['ls-files', '--stage', '-z', '--', '.'], options),
      git('git', ['ls-files', '--others', '--exclude-standard', '-z', '--', '.'], options),
    ]);
  } catch {
    signal.throwIfAborted();
    throw projectError('PROJECT_GIT_FAILED', 'Could not enumerate project files within the Git scope or listing limit');
  }
  const paths = new Map<string, { tracked: boolean; gitlink: boolean }>();
  for (const record of decodePath(tracked).split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    const path = record.slice(tab + 1);
    paths.set(path, { tracked: true, gitlink: record.startsWith('160000 ') || paths.get(path)?.gitlink === true });
  }
  for (const path of decodePath(untracked).split('\0')) {
    if (path && !paths.has(path)) paths.set(path, { tracked: false, gitlink: false });
  }
  return paths;
}

export async function resolveProjectDirectory(cwd: string) {
  try {
    const path = await realpath(cwd);
    if (!path.split('/').includes('.git') && (await lstat(path)).isDirectory()) return path;
  } catch {
    // All inaccessible or invalid roots are startup errors.
  }
  throw projectError('INVALID_PROJECT_DIRECTORY', `Project directory is unavailable: ${JSON.stringify(cwd)}`);
}

export async function captureProject(cwd: string, outputDir: string, signal: AbortSignal) {
  const deadline = AbortSignal.timeout(30_000);
  const bounded = AbortSignal.any([signal, deadline]);
  try {
    return await readProject(cwd, outputDir, bounded);
  } catch (error) {
    if (bounded.aborted && bounded.reason === deadline.reason) {
      throw projectError('PROJECT_FILE_LIMIT', 'Project capture exceeded its 30-second time limit');
    }
    throw error;
  }
}

async function readProject(cwd: string, outputDir: string, signal: AbortSignal) {
  const excluded = isInside(cwd, outputDir) ? relative(cwd, outputDir) : null;
  const entries: Record<string, FileEntry> = Object.create(null);
  const skip = (path: string) => isGitPath(path) ||
    (excluded !== null && (path === excluded || path.startsWith(excluded + '/')));
  let bytes = 0;
  let count = 0;
  let enumerated = 0;

  async function openChecked(path: string, before: BigIntStats, flags: number, label: string) {
    const handle = await open(path, flags).catch(() => { throw sourceChanged(label); });
    try {
      if (!sameFile(before, await handle.stat({ bigint: true }))) throw sourceChanged(label);
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async function captureFile(parent: FileHandle, name: string, path: string, info: BigIntStats) {
    signal.throwIfAborted();
    if (!info.isFile() || info.nlink !== 1n) {
      throw projectError('PROJECT_FILE_UNSUPPORTED', `Project path is not a supported ordinary file: ${JSON.stringify(path)}`);
    }
    if (++count > maxFiles || info.size > BigInt(maxFileBytes) ||
        info.size > BigInt(maxTotalBytes - bytes)) {
      throw projectError('PROJECT_FILE_LIMIT', `Project exceeds the file count or byte limit at ${JSON.stringify(path)}`);
    }
    const location = accessPath(parent, name);
    const file = await openChecked(location, info, fileFlags, path);
    try {
      const content = Buffer.alloc(Number(info.size) + 1);
      let length = 0;
      while (length < content.length) {
        signal.throwIfAborted();
        const part = await file.read(content, length, content.length - length, length);
        if (part.bytesRead === 0) break;
        length += part.bytesRead;
      }
      if (length !== Number(info.size) || !sameFile(info, await file.stat({ bigint: true })) ||
          !sameFile(info, await lstat(location, { bigint: true }).catch(() => { throw sourceChanged(path); }))) {
        throw sourceChanged(path);
      }
      const data = content.subarray(0, length);
      if (data.length <= 1024 && /^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\n(?:ext-[^\r\n]+\r?\n)*oid sha256:[0-9a-f]{64}\r?\nsize [0-9]+\r?\n?$/.test(data.toString('utf8'))) {
        throw projectError('PROJECT_LFS_POINTER', `Git LFS content is not present: ${JSON.stringify(path)}`);
      }
      entries[path] = { encoding: 'base64', data: data.toString('base64'), mode: (info.mode & 0o111n) ? 0o755 : 0o644 };
      bytes += length;
    } finally {
      await file.close();
    }
  }

  async function inDirectory(parent: FileHandle, name: string, path: string, info: BigIntStats,
    visit: (child: FileHandle) => Promise<void>) {
    if (!info.isDirectory()) {
      throw projectError('PROJECT_FILE_UNSUPPORTED', `Project ancestor is not a directory: ${JSON.stringify(path)}`);
    }
    const location = accessPath(parent, name);
    const child = await openChecked(location, info, directoryFlags, path);
    try {
      await visit(child);
      if (!sameFile(info, await child.stat({ bigint: true })) ||
          !sameFile(info, await lstat(location, { bigint: true }).catch(() => { throw sourceChanged(path); }))) {
        throw sourceChanged(path);
      }
    } finally {
      await child.close();
    }
  }

  async function captureGitFile(parent: FileHandle, parts: string[], depth: number, tracked: boolean, gitlink: boolean) {
    signal.throwIfAborted();
    const name = parts[depth];
    const path = parts.slice(0, depth + 1).join('/');
    const info = await lstat(accessPath(parent, name), { bigint: true }).catch(error => {
      if (error.code === 'ENOENT' && tracked) return null;
      if (error.code === 'ENOENT') throw sourceChanged(path);
      throw error;
    });
    if (!info) return;
    if (depth === parts.length - 1) {
      if (gitlink) throw projectError('PROJECT_GITLINK_UNSUPPORTED', `Git submodule is in the project scope: ${JSON.stringify(path)}`);
      await captureFile(parent, name, path, info);
    } else {
      await inDirectory(parent, name, path, info, child => captureGitFile(child, parts, depth + 1, tracked, gitlink));
    }
  }

  async function walk(directory: FileHandle, prefix = '') {
    // Node returns byte names for this option, which the opendir types omit.
    const listing = await opendir(accessPath(directory, '.'), { encoding: 'buffer' as BufferEncoding });
    for await (const entry of listing) {
      signal.throwIfAborted();
      const name = decodePath(entry.name);
      const path = prefix + name;
      if (++enumerated > maxDirectoryEntries) {
        throw projectError('PROJECT_FILE_LIMIT', `Project exceeds the directory enumeration limit at ${JSON.stringify(path)}`);
      }
      if (skip(path)) continue;
      normalizedPath(path);
      const info = await lstat(accessPath(directory, name), { bigint: true }).catch(() => { throw sourceChanged(path); });
      if (info.isDirectory()) await inDirectory(directory, name, path, info, child => walk(child, path + '/'));
      else await captureFile(directory, name, path, info);
    }
  }

  signal.throwIfAborted();
  const before = await lstat(cwd, { bigint: true });
  const root = await openChecked(cwd, before, directoryFlags, '.');
  let selection: 'git-working-tree' | 'directory';
  try {
    const paths = await gitFiles(cwd, signal);
    selection = paths ? 'git-working-tree' : 'directory';
    if (paths) {
      for (const [path, { tracked, gitlink }] of paths) {
        if (skip(path)) continue;
        if (path.endsWith('/')) {
          throw projectError('PROJECT_GITLINK_UNSUPPORTED', `Nested repository is in the project scope: ${JSON.stringify(path)}`);
        }
        await captureGitFile(root, normalizedPath(path), 0, tracked, gitlink);
      }
    } else {
      await walk(root);
    }
    if (!sameFile(before, await root.stat({ bigint: true })) ||
        !sameFile(before, await lstat(cwd, { bigint: true }).catch(() => { throw sourceChanged('.'); }))) {
      throw sourceChanged('.');
    }
  } finally {
    await root.close();
  }
  signal.throwIfAborted();
  const snapshot = snapshotFileSeed(entries);
  for (const file of Object.values(snapshot.files)) Object.freeze(file);
  return Object.freeze({
    files: Object.freeze(snapshot.files),
    digest: completeDigest(snapshot.digest),
    selection, fileCount: count, bytes, excludedOutputDirectory: excluded,
  });
}

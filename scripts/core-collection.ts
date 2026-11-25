import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const MAX_COLLECTION_CHUNK_BYTES = 64 * 1024;
export const MAX_COLLECTION_LINE_BYTES = 128 * 1024;
export const MAX_COLLECTION_ENTRIES = 1_000_000;
export const MAX_COLLECTION_METADATA_BYTES = 16 * 1024 ** 2;
const failure = (message: string, code = 'INVALID_CONTRACT') => Object.assign(new Error(message), { code });

export function isCollectionPath(path: unknown, allowRoot = false): path is string {
  if (allowRoot && path === '.') return true;
  return typeof path === 'string' && path.isWellFormed() && Buffer.byteLength(path) <= 4095 &&
    !/[\\\0]/.test(path) && !/^[a-z]:\//i.test(path) &&
    path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

function pathName(path: unknown, root = false) {
  if (!isCollectionPath(path, root)) throw failure('Collection requires normalized relative paths');
  return path;
}

export function snapshotCollectionSpec(input: any) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['paths', 'includeGit', 'maxBytes', 'required'].includes(key)) ||
      !Array.isArray(input.paths) || input.paths.length > MAX_COLLECTION_ENTRIES ||
      typeof input.includeGit !== 'boolean' || typeof input.required !== 'boolean' ||
      !Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1) {
    throw failure('Collection requires paths, includeGit, required and a positive safe integer maxBytes');
  }
  const paths = [...new Set(Array.from(input.paths, (path: unknown) => pathName(path, true)))].sort();
  if (!input.includeGit && paths.some(path => path === '.git' || path.startsWith('.git/'))) {
    throw failure('Collection paths requesting root .git require includeGit');
  }
  const spec = { paths, includeGit: input.includeGit, maxBytes: input.maxBytes, required: input.required };
  if (Buffer.byteLength(JSON.stringify(spec)) > MAX_COLLECTION_LINE_BYTES) throw failure('Collection path metadata exceeds the supported limit');
  return Object.freeze({ ...spec, paths: Object.freeze(paths) });
}

function assertGitEntry(path: string, bytes: Buffer) {
  if (/^\.git\/(?:.*\/)?commondir$/.test(path) || (/^\.git\/(?:.*\/)?objects\/info\/(?:http-)?alternates$/.test(path) && bytes.toString('utf8').trim()) ||
      (/^\.git\/(?:.*\/)?config$/.test(path) && (/^\s*\[include(?:if\b|\s*\])/im.test(bytes.toString('utf8')) || /^\s*worktree\s*=/im.test(bytes.toString('utf8'))))) {
    throw failure('Collection does not support external Git configuration, common dirs or object stores');
  }
}

type CollectionRecord =
  | { type: 'directory'; path: string }
  | { type: 'file'; path: string; mode: number; bytes: number }
  | { type: 'chunk'; data: string }
  | { type: 'fileEnd'; sha256: string }
  | { type: 'end'; totalBytes: number; fileCount: number; directoryCount: number };

export async function* collectCoreWorkDir(root: string, input: any, { signal, maxEntries = MAX_COLLECTION_ENTRIES }: { signal?: AbortSignal; maxEntries?: number } = {}) {
  const spec = snapshotCollectionSpec(input);
  const deadline = performance.now() + 20_000;
  const visited = new Set<string>();
  const directories = new Set<string>();
  let totalBytes = 0;
  let fileCount = 0;
  let metadata = 0;
  const check = () => {
    signal?.throwIfAborted();
    if (performance.now() >= deadline) throw failure('Collection exceeded the twenty-second traversal deadline', 'SERVICE_UNAVAILABLE');
    if (visited.size > Math.min(maxEntries, MAX_COLLECTION_ENTRIES) || metadata > MAX_COLLECTION_METADATA_BYTES) throw failure('Collection inventory exceeds supported entry or metadata limits');
  };
  function remember(path: string) {
    visited.add(path);
    metadata += Buffer.byteLength(JSON.stringify(path)) + 128;
    check();
  }
  async function* walk(path: string): AsyncGenerator<CollectionRecord> {
    check();
    if (visited.has(path)) return;
    const target = path === '.' ? root : join(root, path);
    const info = await lstat(target);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()) || (info.isFile() && info.nlink !== 1)) throw failure('Collection permits only ordinary files and directories without links');
    if (path === '.git' && !info.isDirectory()) throw failure('Collection requires an ordinary root .git directory');
    if (path !== '.') remember(path);
    if (info.isDirectory()) {
      if (path !== '.') { directories.add(path); yield { type: 'directory', path }; }
      const directory = await opendir(target);
      for await (const entry of directory) {
        check();
        const child = path === '.' ? entry.name : `${path}/${entry.name}`;
        pathName(child);
        if (!spec.includeGit && child === '.git') continue;
        yield* walk(child);
      }
      return;
    }
    totalBytes += info.size;
    if (totalBytes > spec.maxBytes) throw failure('Collection exceeds maxBytes');
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev || opened.nlink !== 1 || opened.size !== info.size) throw failure('Collection file changed during traversal');
      // Git configuration can refer to files outside workDir. Bound and inspect
      // these control files before declaring even a staged export successful.
      if (/^\.git\/(?:.*\/)?(?:commondir|config|objects\/info\/(?:http-)?alternates)$/.test(path)) {
        if (info.size > 1024 ** 2) throw failure('Git control file exceeds the supported metadata limit');
        const bytes = await handle.readFile();
        assertGitEntry(path, bytes);
      }
      fileCount++;
      yield { type: 'file', path, mode: info.mode & 0o777, bytes: info.size };
      const digest = createHash('sha256');
      let position = 0;
      const buffer = Buffer.allocUnsafe(MAX_COLLECTION_CHUNK_BYTES);
      while (position < info.size) {
        check();
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, info.size - position), position);
        if (!bytesRead) throw failure('Collection file ended before its declared size');
        const bytes = buffer.subarray(0, bytesRead);
        position += bytesRead;
        digest.update(bytes);
        yield { type: 'chunk', data: bytes.toString('base64') };
      }
      const after = await handle.stat();
      if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw failure('Collection file changed during read');
      yield { type: 'fileEnd', sha256: digest.digest('hex') };
    } finally { await handle.close(); }
  }
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory()) throw failure('Collection workDir must be an ordinary directory');
  try {
    // Shorter ancestors first ensure every requested directory gets traversed,
    // even when paths overlap. Parent directories are emitted exactly once.
    const paths = [...new Set([...spec.paths, ...(spec.includeGit ? ['.git'] : [])])].sort((a: any, b: any) => a.split('/').length - b.split('/').length || a.localeCompare(b));
    for (const path of paths) {
      if (path !== '.') {
        const parts = path.split('/');
        for (let index = 1; index < parts.length; index++) {
          const parent = parts.slice(0, index).join('/');
          const info = await lstat(join(root, parent));
          if (!info.isDirectory()) throw failure('Collection ancestors must be ordinary directories');
          if (!directories.has(parent)) {
            directories.add(parent);
            remember(parent);
            yield { type: 'directory', path: parent };
          }
        }
      }
      yield* walk(path);
    }
  } catch (error: any) {
    if (error.code === 'ENOENT') throw failure('Collection requested a missing path');
    throw error;
  }
  check();
  yield { type: 'end', totalBytes, fileCount, directoryCount: directories.size };
}

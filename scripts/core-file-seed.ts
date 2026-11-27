import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isCollectionPath, snapshotCollectionSpec } from './core-collection.js';
import { DEFAULT_FILE_POLICY, type FileBudget } from '../src/core/file-policy.js';
import type { CompleteFileDigest, FileTree, FileSnapshotOptions, PartialFileDigest } from '../src/core/types.js';

interface DecodedFile {
  path: string;
  bytes: Buffer;
  mode: number;
}

export const maxFileBytes = 2 * 1024 ** 2;
export const maxTotalBytes = 16 * 1024 ** 2;
export const maxFiles = 10_000;

export type FileManifestEntry = { path: string; mode: 0o644 | 0o755; bytes: number; sha256: string };
export type SpoolFile = FileManifestEntry & { file: string };
export interface SpooledTree { directory: string; entries: readonly SpoolFile[]; digest: string }
const spools = new WeakMap<FileTree, SpooledTree>();

export function fileManifestDigest(entries: readonly FileManifestEntry[]) {
  return hash(JSON.stringify(entries.map(({ path, mode, sha256 }) => [path, mode, sha256])));
}

export function stagedFiles(directory: string, entries: readonly SpoolFile[]): FileTree {
  const sorted = [...entries].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const view: Record<string, FileTree[string]> = Object.create(null);
  for (const entry of sorted) {
    Object.defineProperty(view, entry.path, { enumerable: true, get: () => Object.freeze({
      encoding: 'base64', data: readFileSync(join(directory, entry.file)).toString('base64'), mode: entry.mode,
    }) });
  }
  const files = Object.freeze(view);
  spools.set(files, { directory, entries: sorted, digest: fileManifestDigest(sorted) });
  return files;
}

export function fileSpool(files: FileTree | undefined) {
  return files && spools.get(files);
}

export function assertFileManifest(entries: readonly FileManifestEntry[], budget: FileBudget) {
  if (entries.length > budget.maxFiles) throw invalid('FileTree exceeds its file count limit');
  const paths = new Set(entries.map(entry => entry.path));
  if (paths.size !== entries.length) throw invalid('FileTree contains a repeated path');
  const directories = new Set<string>();
  let totalBytes = 0;
  for (const entry of entries) {
    if (!isFileTreePath(entry.path)) throw invalid('FileTree requires a normalized relative path outside Git data');
    const parts = entry.path.split('/');
    if (parts.length > 128) throw invalid('FileTree exceeds its path depth limit');
    for (let depth = 1; depth < parts.length; depth++) {
      const parent = parts.slice(0, depth).join('/');
      if (paths.has(parent)) throw invalid('FileTree paths collide with a parent file');
      directories.add(parent);
    }
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > budget.maxFileBytes ||
        entry.bytes > budget.maxBytes - totalBytes || ![0o644, 0o755].includes(entry.mode) ||
        !/^[a-f0-9]{64}$/.test(entry.sha256)) throw invalid('FileTree exceeds its byte limits or has invalid metadata');
    totalBytes += entry.bytes;
  }
  if (entries.length + directories.size > budget.maxEntries) throw invalid('FileTree exceeds its inventory limit');
  return { totalBytes, fileCount: entries.length, directoryCount: directories.size };
}

function invalid(message: string) {
  return Object.assign(new TypeError(message), { code: 'INVALID_CONTRACT' });
}

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hash(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

export function fileSeedDigest(entries: readonly DecodedFile[]) {
  return hash(JSON.stringify(entries.map(({ path, bytes, mode }) => [path, mode, hash(bytes)])));
}

function* validatedFileEntries(files: unknown, budget: FileBudget) {
  if (!record(files)) throw invalid('FileTree must be a map of ordinary files');
  const paths = Object.keys(files).sort();
  if (paths.length > budget.maxFiles) throw invalid('FileTree exceeds the file count limit');

  let total = 0;
  for (const path of paths) {
    if (!isFileTreePath(path)) throw invalid('FileTree requires a normalized relative path outside Git data');
    const file = files[path];
    if (!record(file) || Object.keys(file).some(key => !['encoding', 'data', 'mode'].includes(key)) ||
        typeof file.data !== 'string' || !['utf8', 'base64'].includes(file.encoding as string)) {
      throw invalid('FileTree entries require utf8 or base64 data for ordinary files');
    }
    const { encoding, data, mode = 0o644 } = file;
    const encodedLimit = encoding === 'base64' ? 4 * Math.ceil(budget.maxFileBytes / 3) : budget.maxFileBytes;
    if (mode !== 0o644 && mode !== 0o755 || data.length > encodedLimit || !data.isWellFormed()) {
      throw invalid('FileTree entry has an unsupported mode, encoding, or byte count');
    }
    const bytes = Buffer.from(data, encoding as 'utf8' | 'base64');
    const base64 = bytes.toString('base64');
    total += bytes.length;
    if (bytes.length > budget.maxFileBytes || total > budget.maxBytes || (encoding === 'base64' && base64 !== data)) {
      throw invalid('FileTree bytes exceed the configured limits or base64 is malformed');
    }
    yield { path, bytes, mode: mode as 0o644 | 0o755, data: encoding === 'base64' ? data : base64, sha256: hash(bytes) };
  }
}

export function decodeFileSeed(files: unknown, budget: FileBudget = DEFAULT_FILE_POLICY.initial) {
  const entries: DecodedFile[] = [];
  const manifest: FileManifestEntry[] = [];
  for (const { path, bytes, mode, sha256 } of validatedFileEntries(files, budget)) {
    manifest.push({ path, mode, bytes: bytes.length, sha256 });
    entries.push({ path, mode, bytes });
  }
  assertFileManifest(manifest, budget);
  return { entries, digest: fileManifestDigest(manifest) };
}

export function snapshotFileSeed(files: unknown, budget: FileBudget = DEFAULT_FILE_POLICY.initial): { files: FileTree; digest: string } {
  const spool = record(files) ? fileSpool(files as FileTree) : undefined;
  if (spool) {
    assertFileManifest(spool.entries, budget);
    return { files: files as FileTree, digest: spool.digest };
  }
  const snapshot: Record<string, FileTree[string]> = Object.create(null);
  const manifest: FileManifestEntry[] = [];
  for (const { path, bytes, mode, data, sha256 } of validatedFileEntries(files, budget)) {
    manifest.push({ path, mode, bytes: bytes.length, sha256 });
    snapshot[path] = { encoding: 'base64', data, mode };
  }
  assertFileManifest(manifest, budget);
  return { files: { ...snapshot }, digest: fileManifestDigest(manifest) };
}

export const fileProtocol = 'file-tree-v1';
export const fileTransferProtocol = 'file-ndjson-v1';
export const isGitPath = (path: string) => path.split('/').includes('.git');

export function isFileTreePath(path: unknown): path is string {
  return isCollectionPath(path) && !isGitPath(path) && path.split('/').every(part => Buffer.byteLength(part) <= 255);
}

export function fileSnapshotSelection(options: Omit<FileSnapshotOptions, 'requestId'>, budget: FileBudget = DEFAULT_FILE_POLICY.snapshot) {
  const { paths, maxBytes = budget.maxBytes } = options;
  if (!Array.isArray(paths) || !paths.length || !paths.every(path => path === '.' || isFileTreePath(path)) ||
      maxBytes > budget.maxBytes) throw invalid('Invalid FileTree snapshot paths or maxBytes');
  return snapshotCollectionSpec({ paths: paths.includes('.') ? ['.'] : paths, maxBytes, includeGit: false, required: true });
}

export function completeDigest(digest: string): CompleteFileDigest {
  return `complete:sha256:${digest}`;
}

export function partialDigest(digest: string): PartialFileDigest {
  return `partial:sha256:${digest}`;
}

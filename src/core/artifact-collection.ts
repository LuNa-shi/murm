import type { Hash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import type { createRedactor } from './run-records.js';
import type { CollectionSpec } from './types.js';

export type ArtifactRecord =
  | { type: 'directory'; path: string }
  | { type: 'file'; path: string; mode: number; bytes: number }
  | { type: 'chunk'; data: string }
  | { type: 'fileEnd'; sha256: string }
  | { type: 'end'; totalBytes: number; fileCount: number; directoryCount: number };

interface ArtifactFile {
  path: string;
  mode: number;
  bytes: number;
  received: number;
  written: number;
  redact?: ReturnType<ReturnType<typeof createRedactor>['stream']>;
  outputHash: Hash;
  hash: Hash;
  handle: FileHandle;
  target: string;
}

import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createReadStream } from 'node:fs';
import { stableStringify } from '../protocol/stable-json.js';
import { isCollectionPath, MAX_COLLECTION_CHUNK_BYTES as chunkLimit } from './files/core-collection.js';

function collectionError(code: string, message: string, retryable = false) {
  return Object.assign(new Error(message), { code, retryable });
}

function valid(condition: unknown, message: string): asserts condition {
  if (!condition) throw collectionError('ARTIFACT_INVALID', message);
}

async function recoverPublishedArchive(directory: string, agentId: string, collect: CollectionSpec,
  bounds: { bytes: number; inodes: number; maxFileBytes?: number; maxFiles?: number }) {
  const existing = await lstat(directory).catch(error => {
    if (error.code === 'ENOENT') return;
    throw error;
  });
  if (!existing) return;
  valid(existing.isDirectory() && await realpath(directory) === directory, 'Published artifact directory is invalid');
  const manifestPath = join(directory, 'manifest.json');
  const manifestStat = await lstat(manifestPath);
  valid(manifestStat.isFile() && manifestStat.size <= 8 * 1024 ** 2, 'Published artifact manifest is invalid');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  valid(manifest.version === 1 && manifest.agentId === agentId && stableStringify(manifest.collect) === stableStringify(collect) &&
    Array.isArray(manifest.files) && Array.isArray(manifest.directories) && manifest.files.length <= (bounds.maxFiles ?? bounds.inodes) &&
    manifest.files.length + manifest.directories.length <= bounds.inodes, 'Published artifact manifest does not match this export');
  const tree = join(directory, 'files');
  valid((await lstat(tree)).isDirectory(), 'Published artifact tree is invalid');
  const seen = new Set<string>();
  let total = 0;
  for (const entry of manifest.directories) {
    const path = typeof entry === 'string' ? join(tree, entry) : '';
    valid(isCollectionPath(entry) && !seen.has(entry) && (await lstat(path)).isDirectory() &&
      await realpath(path) === path, 'Published artifact directory differs from its manifest');
    seen.add(entry);
  }
  for (const entry of manifest.files) {
    valid(entry && isCollectionPath(entry.path) && !seen.has(entry.path), 'Published artifact file path is invalid');
    const path = join(tree, entry.path);
    const stat = await lstat(path);
    const sourceBytes = entry.sourceBytes ?? entry.bytes;
    valid(stat.isFile() && await realpath(path) === path && stat.size === entry.bytes &&
      (stat.mode & 0o777) === entry.mode && Number.isSafeInteger(sourceBytes) && sourceBytes >= 0 &&
      sourceBytes <= Math.min(bounds.maxFileBytes ?? bounds.bytes, Math.min(collect.maxBytes, bounds.bytes) - total) &&
      entry.bytes <= Math.max(1024, sourceBytes * 4), 'Published artifact file differs from its manifest');
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(path)) hash.update(bytes);
    valid(hash.digest('hex') === entry.sha256, 'Published artifact file digest differs from its manifest');
    total += sourceBytes;
    seen.add(entry.path);
  }
  valid(total === manifest.totalBytes && collect.paths.every(path => path === '.' || seen.has(path)) &&
    (!collect.includeGit || collect.allowMissingGit || manifest.directories.includes('.git')), 'Published artifact coverage is incomplete');
  return [manifestPath, tree];
}

export async function saveAgentArtifacts({ outputDir, agentId, collect, records, bounds, destination = 'artifacts', redactStream, privateFiles = false, recoverPublished = false }: {
  outputDir: string;
  agentId: string;
  collect: CollectionSpec;
  records: () => AsyncIterable<ArtifactRecord>;
  bounds: { bytes: number; inodes: number; maxFiles?: number; maxFileBytes?: number; timeoutMs?: number };
  destination?: string;
  redactStream?: ReturnType<typeof createRedactor>['stream'];
  privateFiles?: boolean;
  recoverPublished?: boolean;
}) {
  const agentDir = join(outputDir, agentId);
  const finalDir = join(agentDir, destination);
  let staging: string | undefined;
  let file: ArtifactFile | undefined;
  const files = [];
  const directories = [];
  const seen = new Set();
  let totalBytes = 0;
  let complete = false;
  const deadline = performance.now() + (bounds.timeoutMs ?? Infinity);
  try {
    await mkdir(agentDir, { mode: 0o700 }).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
    if (!(await lstat(agentDir)).isDirectory()) throw collectionError('ARTIFACT_WRITE_FAILED', 'Agent artifact parent is not a directory', true);
    if (recoverPublished) {
      const existing = await recoverPublishedArchive(finalDir, agentId, collect, bounds);
      if (existing) return existing;
    }
    staging = await mkdtemp(join(agentDir, '.collect-'));
    const tree = join(staging, 'files');
    await mkdir(tree, { mode: 0o700 });
    const includePath = (path: string) => (path === '.git' || path.startsWith('.git/'))
      ? collect.includeGit
      : collect.paths.some(scope => scope === '.' || path === scope ||
        path.startsWith(`${scope}/`) || scope.startsWith(`${path}/`));
    for await (const record of records()) {
      if (performance.now() >= deadline) throw collectionError('ARTIFACT_TIMEOUT', 'Artifact export exceeded its allowed time', true);
      valid(!complete, 'Artifact stream continued after final record');
      if (record?.type === 'directory' || record?.type === 'file') {
        const { path } = record;
        valid(!file && isCollectionPath(path) && !seen.has(path) && includePath(path) &&
          seen.size < bounds.inodes, 'Artifact stream contains an invalid, repeated or undeclared path');
        seen.add(path);
        if (record.type === 'directory') {
          await mkdir(join(tree, path), { recursive: true, mode: 0o700 });
          directories.push(path);
        } else {
          const { mode, bytes } = record;
          valid(Number.isInteger(mode) && mode >= 0 && mode <= 0o777 &&
            files.length < (bounds.maxFiles ?? bounds.inodes) && bytes <= (bounds.maxFileBytes ?? bounds.bytes) &&
            Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= Math.min(collect.maxBytes, bounds.bytes) - totalBytes,
          'Artifact file exceeds its declared mode or byte bounds');
          const target = join(tree, path);
          await mkdir(dirname(target), { recursive: true, mode: 0o700 });
          file = { path, mode: privateFiles ? 0o600 : mode, bytes, received: 0, written: 0, redact: redactStream?.(),
            outputHash: createHash('sha256'), hash: createHash('sha256'), handle: await open(target, 'wx', 0o600), target };
        }
      } else if (record?.type === 'chunk') {
        const { data } = record;
        valid(file && typeof data === 'string' && data.length <= 4 * Math.ceil(chunkLimit / 3), 'Invalid artifact byte chunk');
        const chunk = Buffer.from(data, 'base64');
        valid(chunk.length > 0 && chunk.length <= chunkLimit && chunk.toString('base64') === data &&
          file.received + chunk.length <= file.bytes, 'Invalid or oversized artifact byte chunk');
        const output = file.redact ? Buffer.from(file.redact.write(chunk)) : chunk;
        await file.handle.writeFile(output);
        file.outputHash.update(output);
        file.written += output.length;
        file.hash.update(chunk);
        file.received += chunk.length;
      } else if (record?.type === 'fileEnd') {
        valid(file && file.received === file.bytes && file.hash.digest('hex') === record.sha256,
          'Artifact bytes or digest did not match the Worker manifest');
        if (file.redact) {
          const tail = Buffer.from(file.redact.end());
          await file.handle.writeFile(tail);
          file.outputHash.update(tail);
          file.written += tail.length;
        }
        await file.handle.close();
        await chmod(file.target, file.mode);
        files.push({ path: file.path, mode: file.mode, bytes: file.written, sha256: file.outputHash.digest('hex'),
          ...(file.redact ? { sourceBytes: file.bytes, sourceSha256: record.sha256 } : {}) });
        totalBytes += file.bytes;
        file = undefined;
      } else {
        valid(record?.type === 'end' && !file && record.totalBytes === totalBytes &&
          record.fileCount === files.length && record.directoryCount === directories.length,
        'Artifact stream did not confirm its final manifest');
        complete = true;
      }
    }
    valid(complete, 'Artifact stream ended without final confirmation');
    valid(collect.paths.every(path => path === '.' || seen.has(path)) && (!collect.includeGit || collect.allowMissingGit || directories.includes('.git')),
      'Artifact stream omitted a requested file or directory');
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    directories.sort();
    await writeFile(join(staging, 'manifest.json'), JSON.stringify({ version: 1, agentId, collect, totalBytes, files, directories }, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 });
    await rename(staging, finalDir);
    staging = undefined;
    return [join(finalDir, 'manifest.json'), join(finalDir, 'files')];
  } catch (caught) {
    const error = caught as Error & { code?: string };
    if (error.code?.startsWith('ARTIFACT_')) throw error;
    throw collectionError('ARTIFACT_WRITE_FAILED', 'Host could not save the verified Agent artifact', true);
  } finally {
    await file?.handle.close().catch(() => {});
    if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

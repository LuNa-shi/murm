import type { Hash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
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
  hash: Hash;
  handle: FileHandle;
  target: string;
}

import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isCollectionPath, MAX_COLLECTION_CHUNK_BYTES as chunkLimit } from '../../scripts/core-collection.mjs';

function collectionError(code: string, message: string, retryable = false) {
  return Object.assign(new Error(message), { code, retryable });
}

function valid(condition: unknown, message: string): asserts condition {
  if (!condition) throw collectionError('ARTIFACT_INVALID', message);
}

export async function saveBotArtifacts({ outputDir, botId, collect, records, bounds }: {
  outputDir: string;
  botId: string;
  collect: CollectionSpec;
  records: () => AsyncIterable<ArtifactRecord>;
  bounds: { bytes: number; inodes: number };
}): Promise<string[]> {
  const botDir = join(outputDir, botId);
  const finalDir = join(botDir, 'artifacts');
  let staging: string | undefined;
  let file: ArtifactFile | undefined;
  const files: { path: string; mode: number; bytes: number; sha256: string }[] = [];
  const directories: string[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  let complete = false;
  try {
    await mkdir(botDir, { mode: 0o700 }).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
    if (!(await lstat(botDir)).isDirectory()) throw collectionError('ARTIFACT_WRITE_FAILED', 'Bot artifact parent is not a directory', true);
    staging = await mkdtemp(join(botDir, '.collect-'));
    const tree = join(staging, 'files');
    await mkdir(tree, { mode: 0o700 });
    const includePath = (path: string) => (path === '.git' || path.startsWith('.git/'))
      ? collect.includeGit
      : collect.paths.some(scope => scope === '.' || path === scope ||
        path.startsWith(`${scope}/`) || scope.startsWith(`${path}/`));
    for await (const record of records()) {
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
            Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= Math.min(collect.maxBytes, bounds.bytes) - totalBytes,
          'Artifact file exceeds its declared mode or byte bounds');
          const target = join(tree, path);
          await mkdir(dirname(target), { recursive: true, mode: 0o700 });
          file = { path, mode, bytes, received: 0, hash: createHash('sha256'), handle: await open(target, 'wx', 0o600), target };
        }
      } else if (record?.type === 'chunk') {
        const { data } = record;
        valid(file && typeof data === 'string' && data.length <= 4 * Math.ceil(chunkLimit / 3), 'Invalid artifact byte chunk');
        const chunk = Buffer.from(data, 'base64');
        valid(chunk.length > 0 && chunk.length <= chunkLimit && chunk.toString('base64') === data &&
          file.received + chunk.length <= file.bytes, 'Invalid or oversized artifact byte chunk');
        await file.handle.writeFile(chunk);
        file.hash.update(chunk);
        file.received += chunk.length;
      } else if (record?.type === 'fileEnd') {
        valid(file && file.received === file.bytes && file.hash.digest('hex') === record.sha256,
          'Artifact bytes or digest did not match the Worker manifest');
        await file.handle.close();
        await chmod(file.target, file.mode);
        files.push({ path: file.path, mode: file.mode, bytes: file.bytes, sha256: record.sha256 });
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
    valid(collect.paths.every(path => path === '.' || seen.has(path)) && (!collect.includeGit || directories.includes('.git')),
      'Artifact stream omitted a requested file or directory');
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    directories.sort();
    await writeFile(join(staging, 'manifest.json'), JSON.stringify({ version: 1, botId, collect, totalBytes, files, directories }, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 });
    await rename(staging, finalDir);
    staging = undefined;
    return [join(finalDir, 'manifest.json'), join(finalDir, 'files')];
  } catch (caught) {
    const error = caught as Error & { code?: string };
    if (error.code?.startsWith('ARTIFACT_')) throw error;
    throw collectionError('ARTIFACT_WRITE_FAILED', 'Host could not save the verified Bot artifact', true);
  } finally {
    await file?.handle.close().catch(() => {});
    if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

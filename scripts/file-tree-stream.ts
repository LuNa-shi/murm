import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, rm, statfs, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileBudget } from '../src/core/file-policy.js';
import type { FileTree } from '../src/core/types.js';
import { MAX_COLLECTION_CHUNK_BYTES as chunkBytes, MAX_COLLECTION_LINE_BYTES as lineBytes } from './core-collection.js';
import { assertFileManifest, fileManifestDigest, fileSpool, isFileTreePath, stagedFiles,
  type FileManifestEntry, type SpoolFile } from './core-file-seed.js';

const fault = (message: string, code = 'INVALID_CONTRACT') => Object.assign(new Error(message), { code });

export async function checkFileSpace(directory: string, bytes: number, inodes: number, label: string) {
  const { bavail, bsize, ffree, files } = await statfs(directory, { bigint: true });
  const available = bavail * bsize;
  // Allow for block rounding when many small files are written.
  if (available < BigInt(bytes) + BigInt(inodes) * bsize || (files > 0n && ffree < BigInt(inodes))) {
    throw fault(`${label} does not have enough free bytes or inodes for the file operation`, 'FILE_SPACE_INSUFFICIENT');
  }
}

export async function* fileTreeFrames(files: FileTree, budget: FileBudget, meta: object, signal: AbortSignal) {
  const spool = fileSpool(files);
  const entries: readonly FileManifestEntry[] = spool?.entries ?? Object.keys(files).sort().map(path => {
    const item = files[path];
    const bytes = Buffer.from(item.data, item.encoding);
    return { path, mode: item.mode ?? 0o644, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  const counts = assertFileManifest(entries, budget);
  const digest = spool?.digest ?? fileManifestDigest(entries);
  const encode = (record: object) => Buffer.from(JSON.stringify(record) + '\n');
  const first = encode({ type: 'tree', meta, digest, ...counts });
  if (first.length > lineBytes) throw fault('File transfer metadata exceeds its byte limit');
  yield first;
  for (const [index, entry] of entries.entries()) {
    signal.throwIfAborted();
    yield encode({ type: 'file', path: entry.path, bytes: entry.bytes, mode: entry.mode });
    const chunks = spool
      ? createReadStream(join(spool.directory, spool.entries[index].file), { highWaterMark: chunkBytes, signal })
      : bufferChunks(Buffer.from(files[entry.path].data, files[entry.path].encoding));
    for await (const chunk of chunks) {
      signal.throwIfAborted();
      yield encode({ type: 'chunk', data: chunk.toString('base64') });
    }
    yield encode({ type: 'fileEnd', sha256: entry.sha256 });
  }
  yield encode({ type: 'end', digest, ...counts });
}

function* bufferChunks(bytes: Buffer) {
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) yield bytes.subarray(offset, offset + chunkBytes);
}

export async function* fileStreamLines(chunks: AsyncIterable<Uint8Array>, signal: AbortSignal) {
  let parts: Buffer[] = [];
  let length = 0;
  for await (const chunk of chunks) {
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let from = 0;
    while (from < bytes.length) {
      signal.throwIfAborted();
      const newline = bytes.indexOf(0x0a, from);
      const end = newline < 0 ? bytes.length : newline;
      const part = bytes.subarray(from, end);
      length += part.length;
      if (length > lineBytes) throw fault('File transfer frame exceeds its byte limit');
      if (part.length) parts.push(part);
      if (newline < 0) break;
      let row;
      try { row = JSON.parse(Buffer.concat(parts, length).toString('utf8')); }
      catch { throw fault('File transfer frame is invalid'); }
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw fault('File transfer requires object frames');
      yield row;
      parts = [];
      length = 0;
      from = newline + 1;
    }
  }
  if (length) throw fault('File transfer ended in a partial frame');
}

export async function receiveFileTree(chunks: AsyncIterable<Uint8Array>, { parent, budget, maxSpoolBytes, signal, label }: {
  parent: string; budget: FileBudget; maxSpoolBytes: number; signal: AbortSignal; label: string;
}) {
  const entries: SpoolFile[] = [];
  const known = new Set<string>();
  let directory: string | undefined;
  let declaration: Record<string, any> | undefined;
  let meta: Record<string, any> | undefined;
  let current: Omit<SpoolFile, 'sha256'> | undefined;
  let digest = createHash('sha256');
  let length = 0;
  let received = 0;
  let complete = false;
  let file: FileHandle | undefined;
  try {
    for await (const row of fileStreamLines(chunks, signal)) {
      if (complete) throw fault('File transfer continued after completion');
      if (!declaration) {
        if (row.type !== 'tree' || !/^[a-f0-9]{64}$/.test(row.digest) || !row.meta || typeof row.meta !== 'object' ||
            !Number.isSafeInteger(row.fileCount) || row.fileCount < 0 || row.fileCount > budget.maxFiles ||
            !Number.isSafeInteger(row.directoryCount) || row.directoryCount < 0 || row.fileCount + row.directoryCount > budget.maxEntries ||
            !Number.isSafeInteger(row.totalBytes) || row.totalBytes < 0 || row.totalBytes > Math.min(budget.maxBytes, maxSpoolBytes)) {
          throw fault('Declared file transfer exceeds its configured bounds');
        }
        await checkFileSpace(parent, row.totalBytes, row.fileCount + 1, label);
        directory = await mkdtemp(join(parent, '.murm-files-'));
        declaration = row;
        meta = row.meta;
      } else if (row.type === 'file' && !current) {
        if (!isFileTreePath(row.path) || known.has(row.path) || entries.length >= declaration.fileCount ||
            ![0o644, 0o755].includes(row.mode) || !Number.isSafeInteger(row.bytes) || row.bytes < 0 ||
            row.bytes > budget.maxFileBytes || row.bytes > declaration.totalBytes - received) throw fault('Invalid file transfer entry');
        known.add(row.path);
        current = { path: row.path, bytes: row.bytes, mode: row.mode, file: String(entries.length) };
        file = await open(join(directory!, current.file), 'wx', 0o600);
        digest = createHash('sha256');
        length = 0;
      } else if (row.type === 'chunk' && current && file) {
        if (typeof row.data !== 'string' || !row.data.length || row.data.length > 4 * Math.ceil(chunkBytes / 3)) throw fault('Invalid file chunk');
        const buffer = Buffer.from(row.data, 'base64');
        if (!buffer.length || buffer.length > chunkBytes || buffer.toString('base64') !== row.data ||
            buffer.length > current.bytes - length) throw fault('Invalid file chunk length or encoding');
        await file.writeFile(buffer);
        digest.update(buffer);
        length += buffer.length;
      } else if (row.type === 'fileEnd' && current && file) {
        if (length !== current.bytes || row.sha256 !== digest.digest('hex')) throw fault('File transfer digest or length did not match');
        await file.close();
        file = undefined;
        entries.push({ ...current, sha256: row.sha256 });
        received += length;
        current = undefined;
      } else if (row.type === 'end' && !current) {
        const counts = assertFileManifest(entries, budget);
        if (!Object.entries(counts).every(([key, value]) => row[key] === value && declaration![key] === value) ||
            row.digest !== declaration.digest) throw fault('File transfer did not confirm its inventory');
        complete = true;
      } else {
        throw fault('Unexpected file transfer frame');
      }
    }
    signal.throwIfAborted();
    if (!complete || !directory || !declaration || !meta) throw fault('File transfer ended without confirmation');
    const files = stagedFiles(directory, entries);
    if (fileSpool(files)!.digest !== declaration.digest) throw fault('File transfer manifest digest did not match');
    const staged = directory;
    directory = undefined;
    return { files, meta, dispose: () => rm(staged, { recursive: true, force: true }) };
  } catch (error) {
    if (['ENOSPC', 'EDQUOT'].includes((error as NodeJS.ErrnoException)?.code ?? '')) {
      throw fault(`${label} ran out of space while receiving the file tree`, 'FILE_SPACE_INSUFFICIENT');
    }
    throw error;
  } finally {
    await file?.close().catch(() => {});
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

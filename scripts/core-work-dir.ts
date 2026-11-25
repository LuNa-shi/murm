import { chmod, chown, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FileSnapshot, FileSeed } from '../src/core/types.js';
import { collectCoreWorkDir, snapshotCollectionSpec } from './core-collection.js';
import { decodeFileSeed, fileSeedDigest } from './core-file-seed.js';

function failure(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

interface ExpectedFile {
  path: string;
  size: number;
  mode: number;
}

interface PreparedReceipt {
  version: number;
  digest: string;
}

export class CoreWorkDir {
  declare path: string;
  declare uid: number;
  declare gid: number;
  declare assertOpen: () => void;

  #pending: Promise<unknown> = Promise.resolve();
  #prepared = new Map<number, PreparedReceipt>();
  #current?: { receipt: PreparedReceipt; entries: ExpectedFile[] };
  #writable = false;
  #shared = false;
  #snapshots = new Map<string, { identity: string; receipt: Omit<FileSnapshot, 'botId'> }>();
  #snapshotVersion = 0;

  constructor({ path, uid, gid, assertOpen }: { path: string; uid: number; gid: number; assertOpen: () => void }) {
    this.path = path;
    this.uid = uid;
    this.gid = gid;
    this.assertOpen = assertOpen;
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.#pending.then(operation);
    this.#pending = work.catch(() => undefined);
    return work;
  }

  drain() { return this.#pending; }

  async initialize({ files, writable, shared = false }: { files?: unknown; writable: boolean; shared?: boolean }) {
    this.#shared = shared;
    if (shared) { this.#writable = writable; return { writable, version: 0 }; }
    if (files === undefined && !writable) return { writable: false, version: 0 };
    const prepared = await this.prepare({ version: 1, files: files ?? {} });
    if (writable) return this.grant(prepared);
    return { ...prepared, writable: false };
  }

  async #readInstalled(entries: ExpectedFile[]) {
    const root = await lstat(this.path);
    if (!root.isDirectory() || root.uid !== process.getuid!() || (root.mode & 0o022) !== 0) {
      throw failure('CONFLICT', 'Prepared FileSeed root is no longer controlled by the Worker');
    }
    const actual = [];
    const checkedDirectories = new Set<string>();
    for (const entry of entries) {
      this.assertOpen();
      const target = join(this.path, entry.path);
      for (let directory = dirname(target); directory !== this.path; directory = dirname(directory)) {
        if (checkedDirectories.has(directory)) continue;
        const info = await lstat(directory);
        if (!info.isDirectory() || info.uid !== process.getuid!() || (info.mode & 0o022) !== 0) {
          throw failure('CONFLICT', 'Prepared FileSeed directory is no longer controlled by the Worker');
        }
        checkedDirectories.add(directory);
      }
      const info = await lstat(target);
      if (!info.isFile() || info.uid !== process.getuid!() || info.nlink !== 1 ||
          (info.mode & 0o7777) !== entry.mode || info.size !== entry.size) {
        throw failure('CONFLICT', 'Installed FileSeed differs from its expected ordinary file and mode');
      }
      actual.push({ path: entry.path, mode: info.mode & 0o7777, bytes: await readFile(target) });
    }
    return fileSeedDigest(actual);
  }

  snapshot(input?: { requestId?: unknown; paths?: unknown; includeGit?: unknown; maxBytes?: unknown }) {
    return this.#serialize(async () => {
      this.assertOpen();
      const { requestId, ...selection } = input ?? {};
      if (typeof requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(requestId)) throw failure('INVALID_CONTRACT', 'Snapshot requires requestId');
      const spec = snapshotCollectionSpec(selection);
      if (spec.maxBytes > 16 * 1024 ** 2) throw failure('INVALID_CONTRACT', 'Snapshot exceeds 16 MiB limit');
      const identity = JSON.stringify(spec);
      const previous = this.#snapshots.get(requestId);
      if (previous) {
        if (previous.identity !== identity) throw failure('CONFLICT', 'Snapshot requestId has different paths or limits');
        return previous.receipt;
      }
      const files: Record<string, FileSeed[string]> = Object.create(null);
      let current!: { path: string; mode: number };
      let chunks!: Buffer[];
      for await (const entry of collectCoreWorkDir(this.path, spec)) {
        this.assertOpen();
        if (entry.type === 'file') { current = entry; chunks = []; }
        if (entry.type === 'chunk') chunks.push(Buffer.from(entry.data, 'base64'));
        if (entry.type === 'fileEnd') {
          files[current.path] = { encoding: 'base64', data: Buffer.concat(chunks).toString('base64'), mode: current.mode & 0o111 ? 0o755 : 0o644 };
        }
      }
      const { digest } = decodeFileSeed(files);
      const receipt = { requestId, version: ++this.#snapshotVersion, digest, files };
      this.#snapshots.set(requestId, { identity, receipt });
      return receipt;
    });
  }

  prepare({ version, files }: { version: number; files: unknown }) {
    return this.#serialize(async () => {
      this.assertOpen();
      if (this.#shared) throw failure('NOT_ALLOWED', 'Shared workspace cannot be prepared or granted');
      if (!Number.isSafeInteger(version) || version < 1) throw failure('INVALID_CONTRACT', 'File preparation requires a positive version');
      const seed = decodeFileSeed(files);
      const expected = seed.entries.map(({ path, bytes, mode }) => ({ path, size: bytes.length, mode }));
      const previous = this.#prepared.get(version);
      if (previous) {
        if (previous.digest !== seed.digest) throw failure('CONFLICT', 'File preparation version has different bytes, paths or modes');
        return previous;
      }
      if (this.#writable || (this.#current && version <= this.#current.receipt.version)) {
        throw failure('CONFLICT', 'File preparation requires a new version of a read-only workDir');
      }
      const root = await lstat(this.path);
      if (!root.isDirectory() || root.uid !== process.getuid!() || (root.mode & 0o7777) !== 0o555 || (await readdir(this.path)).length !== 0) {
        throw failure('CONFLICT', 'File preparation requires an empty read-only workDir controlled by the Worker');
      }

      this.assertOpen();
      try {
        await chmod(this.path, 0o700);
        for (const entry of seed.entries) {
          this.assertOpen();
          const target = join(this.path, entry.path);
          await mkdir(dirname(target), { recursive: true, mode: 0o755 });
          await writeFile(target, entry.bytes, { flag: 'wx', mode: entry.mode });
          await chmod(target, entry.mode);
        }
        if (await this.#readInstalled(expected) !== seed.digest) {
          throw failure('CONFLICT', 'Installed FileSeed digest differs from the supplied bytes');
        }
        this.assertOpen();
        await chmod(this.path, 0o555);
        this.assertOpen();
      } catch (error: any) {
        try {
          for (const name of await readdir(this.path)) await rm(join(this.path, name), { recursive: true, force: true });
          await chmod(this.path, 0o555);
        } catch {
          throw failure('OPERATION_UNKNOWN', 'Worker could not confirm safe rollback of file preparation');
        }
        if (error.code === 'ENOSPC') throw failure('INVALID_CONTRACT', 'FileSeed exceeds the available workDir quota');
        throw error;
      }

      const receipt = Object.freeze({ version, digest: seed.digest });
      this.#prepared.set(version, receipt);
      this.#current = { receipt, entries: expected };
      return receipt;
    });
  }

  grant({ version, digest }: PreparedReceipt) {
    return this.#serialize(async () => {
      this.assertOpen();
      if (this.#shared) throw failure('NOT_ALLOWED', 'Shared workspace cannot be prepared or granted');
      const current = this.#current;
      if (!current || current.receipt.version !== version || current.receipt.digest !== digest) {
        throw failure('CONFLICT', 'Write grant does not match the current FileSeed preparation');
      }
      if (this.#writable) return { ...current.receipt, writable: true };
      if (await this.#readInstalled(current.entries) !== digest) throw failure('CONFLICT', 'Prepared files changed before write grant');

      this.assertOpen();
      try {
        await chmod(this.path, 0o500);
        const directories = new Set<string>();
        for (const entry of current.entries) {
          this.assertOpen();
          const target = join(this.path, entry.path);
          await chown(target, this.uid, this.gid);
          await chmod(target, entry.mode);
          for (let directory = dirname(target); directory !== this.path; directory = dirname(directory)) directories.add(directory);
        }
        for (const directory of directories) {
          this.assertOpen();
          await chown(directory, this.uid, this.gid);
          await chmod(directory, 0o755);
        }
        this.assertOpen();
        await chown(this.path, this.uid, this.gid);
        this.assertOpen();
        await chmod(this.path, 0o755);
        this.assertOpen();
      } catch {
        throw failure('OPERATION_UNKNOWN', 'Worker could not confirm completion of the workDir write grant');
      }
      this.#writable = true;
      return { ...current.receipt, writable: true };
    });
  }
}

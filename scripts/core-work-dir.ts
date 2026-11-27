import { chmod, chown, copyFile, lstat, mkdir, mkdtemp, open, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { DEFAULT_FILE_POLICY, type FileBudget, type ResolvedFilePolicy } from '../src/core/file-policy.js';
import { checkFileSpace } from './file-tree-stream.js';
import type { FileReplaceOptions, FileSnapshotOptions, FileTree } from '../src/core/types.js';
import type { WorkerFileReplace, WorkerFileSnapshot } from '../src/core/file-controls.js';
import { collectCoreWorkDir } from './core-collection.js';
import { ProjectInstaller, canonical } from './project-install.js';
import {
  assertFileManifest, completeDigest, decodeFileSeed, fileManifestDigest, fileSnapshotSelection,
  fileSpool, isFileTreePath, isGitPath, partialDigest, stagedFiles, type FileManifestEntry, type SpoolFile,
} from './core-file-seed.js';

const failure = (code: string, message: string) => Object.assign(new Error(message), { code });
const requestIdValid = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const modes = (mode: number) => mode & 0o111 ? 0o755 as const : 0o644 as const;
function decodedTree(files: FileTree, budget: FileBudget) {
  const spool = fileSpool(files);
  if (spool) {
    assertFileManifest(spool.entries, budget);
    return { source: spool.entries.map(entry => ({ path: entry.path, mode: entry.mode,
      bytes: { file: join(spool.directory, entry.file) } })),
      inventory: spool.entries, digest: spool.digest };
  }
  const result = decodeFileSeed(files, budget);
  return { source: result.entries, digest: result.digest, inventory: result.entries.map(entry => ({
    path: entry.path, mode: modes(entry.mode), bytes: entry.bytes.length,
    sha256: createHash('sha256').update(entry.bytes).digest('hex'),
  })) };
}

function installTree(files: FileTree, budget: FileBudget) {
  const { inventory, source } = decodedTree(files, budget);
  const manifest = Object.fromEntries(inventory.map(({ path, bytes, sha256 }) => [path, { bytes, content_hash: sha256 }]));
  return { manifest, bytes: Object.fromEntries(source.map(({ path, bytes }) => [path, bytes])),
    content_hash: digest(canonical(manifest)) };
}

const rootOwner = { uid: 0, gid: 0 };

type FileSpec = ReturnType<typeof fileSnapshotSelection>;

export class CoreWorkDir {
  #pending: Promise<unknown> = Promise.resolve();
  #writable = false;
  #shared = false;
  #snapshotVersion = 0;
  #snapshots = new Map<string, { identity: string; receipt: WorkerFileSnapshot }>();
  #replacements = new Map<string, { identity: string; work?: WorkerFileReplace; plan?: Record<string, unknown> }>();
  #installer: ProjectInstaller;
  #grantUnknown = false;
  #retainedBytes = 0;
  #snapshotsOnDisk: (() => Promise<void>)[] = [];
  #temporaryBytes = 0;
  private readonly policy: ResolvedFilePolicy;
  private readonly path: string;
  private readonly uid: number;
  private readonly gid: number;
  private readonly assertOpen: () => void;

  constructor({ path, uid, gid, assertOpen, policy = DEFAULT_FILE_POLICY }:
    { path: string; uid: number; gid: number; assertOpen: () => void; policy?: ResolvedFilePolicy }) {
    this.path = path;
    this.uid = uid;
    this.gid = gid;
    this.assertOpen = assertOpen;
    this.policy = policy;
    this.#installer = new ProjectInstaller({
      projectDir: path, controlDir: join(dirname(path), '.core-file-installs'), uid, decode: (files: FileTree) => installTree(files, policy.replace),
      owner: () => this.#writable ? { uid, gid } : rootOwner, excluded: isGitPath,
      assertOpen, snapshot: (_input: unknown, options?: { retainBytes?: boolean }) => this.#projectSnapshot(policy.replace, options?.retainBytes),
    });
  }

  #serialize<T>(operation: () => Promise<T>) {
    const work = this.#pending.then(operation);
    this.#pending = work.catch(() => undefined);
    return work;
  }

  async drain() {
    await this.#pending;
    for (const dispose of this.#snapshotsOnDisk) await dispose();
    this.#snapshotsOnDisk = [];
  }

  async initialize({ files, writable, shared = false }: { files?: FileTree; writable: boolean; shared?: boolean }) {
    this.#shared = shared;
    if (shared) { this.#writable = writable; return { writable, version: 0 }; }
    if (files === undefined && !writable) return { writable: false, version: 0 };
    const tree = decodedTree(files ?? {}, this.policy.initial);
    const { totalBytes, fileCount, directoryCount } = assertFileManifest(tree.inventory, this.policy.initial);
    await checkFileSpace(this.path, totalBytes, fileCount + directoryCount, 'Sandbox workDir');
    try {
      for (const entry of tree.source) {
        this.assertOpen();
        const path = join(this.path, entry.path);
        await mkdir(dirname(path), { recursive: true, mode: 0o755 });
        if (Buffer.isBuffer(entry.bytes)) await writeFile(path, entry.bytes, { flag: 'wx', mode: entry.mode });
        else await copyFile(entry.bytes.file, path, constants.COPYFILE_EXCL);
        await chmod(path, entry.mode);
      }
    } catch (error) {
      if (['ENOSPC', 'EDQUOT'].includes((error as NodeJS.ErrnoException)?.code ?? '')) {
        throw failure('FILE_SPACE_INSUFFICIENT', 'Sandbox workDir ran out of space during initial installation');
      }
      throw error;
    }
    if ((await this.#projectSnapshot(this.policy.initial)).file_digest !== completeDigest(tree.digest)) {
      throw failure('CONFLICT', 'Initial project does not match the FileTree');
    }
    if (writable) await this.#grantWrite(tree.source);
    return { writable, version: 1, digest: tree.digest };
  }

  async #grantWrite(entries: readonly { path: string }[]) {
    const directories = new Set([this.path]);
    for (const entry of entries) {
      this.assertOpen();
      const path = join(this.path, entry.path);
      await chown(path, this.uid, this.gid);
      for (let directory = dirname(path); directory !== this.path; directory = dirname(directory)) directories.add(directory);
    }
    for (const directory of directories) {
      this.assertOpen();
      await chown(directory, this.uid, this.gid);
      await chmod(directory, 0o755);
    }
    for (const path of [...directories, ...entries.map(entry => join(this.path, entry.path))]) {
      const info = await lstat(path);
      if (info.uid !== this.uid || info.gid !== this.gid || (info.mode & 0o200) === 0) {
        throw failure('OPERATION_UNKNOWN', 'WorkDir ownership and write permissions were not confirmed');
      }
    }
    this.#writable = true;
  }

  snapshot(input: FileSnapshotOptions) {
    return this.#serialize(async () => {
      this.assertOpen();
      const { requestId, ...selection } = input ?? {};
      if (!requestIdValid(requestId)) throw failure('INVALID_CONTRACT', 'Snapshot requires requestId');
      const spec = fileSnapshotSelection(selection, this.policy.snapshot);
      const identity = JSON.stringify(spec);
      const previous = this.#snapshots.get(requestId);
      if (previous) {
        if (previous.identity !== identity) throw failure('CONFLICT', 'Snapshot requestId has different paths or limits');
        return previous.receipt;
      }
      const captured = await this.#capture(spec, this.policy.snapshot, true);
      const { files, digest } = captured;
      this.#retainedBytes += captured.bytes;
      this.#snapshotsOnDisk.push(captured.dispose!);
      const base = { requestId, version: ++this.#snapshotVersion, files: files! };
      const receipt: WorkerFileSnapshot = spec.paths[0] === '.'
        ? { ...base, scope: 'complete', digest: completeDigest(digest) }
        : { ...base, scope: 'partial', digest: partialDigest(digest) };
      this.#snapshots.set(requestId, { identity, receipt });
      return receipt;
    });
  }

  async #capture(spec: FileSpec, budget: FileBudget, retainBytes = false) {
    const entries: SpoolFile[] = [];
    let current!: Omit<SpoolFile, 'sha256'>;
    let bytes = 0;
    let handle: FileHandle | undefined;
    let directory = retainBytes ? await mkdtemp(join(dirname(this.path), '.core-file-staging-')) : undefined;
    const fileTree = { validPath: isFileTreePath, excluded: isGitPath, maxFiles: budget.maxFiles, maxFileBytes: budget.maxFileBytes };
    try {
      for await (const record of collectCoreWorkDir(this.path, spec, { fileTree, maxEntries: budget.maxEntries, timeoutMs: budget.timeoutMs })) {
        this.assertOpen();
        if (record.type === 'file') {
          current = { path: record.path, mode: modes(record.mode), bytes: record.bytes, file: String(entries.length) };
          bytes += record.bytes;
          if (directory) {
            if (bytes + this.#retainedBytes + this.#temporaryBytes > this.policy.workerSpoolBytes) {
              throw failure('FILE_SPACE_INSUFFICIENT', 'Sandbox staging exceeds its configured byte budget');
            }
            await checkFileSpace(directory, record.bytes, 1, 'Sandbox staging');
            handle = await open(join(directory, current.file), 'wx', 0o600);
          }
        } else if (record.type === 'chunk' && handle) {
          await handle.writeFile(Buffer.from(record.data, 'base64'));
        } else if (record.type === 'fileEnd') {
          await handle?.close();
          handle = undefined;
          entries.push({ ...current, sha256: record.sha256 });
        }
      }
      entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      assertFileManifest(entries, budget);
      const hash = fileManifestDigest(entries);
      const staged = directory;
      const files = staged ? stagedFiles(staged, entries) : undefined;
      directory = undefined;
      return { files, entries, bytes, digest: hash, dispose: staged ? () => rm(staged, { recursive: true, force: true }) : undefined };
    } catch (error) {
      if (['EDQUOT', 'ENOSPC'].includes((error as NodeJS.ErrnoException)?.code ?? '')) {
        throw failure('FILE_SPACE_INSUFFICIENT', 'Sandbox workDir ran out of space during capture');
      }
      throw error;
    } finally {
      await handle?.close().catch(() => {});
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }

  async #projectSnapshot(budget: FileBudget, retainBytes = false) {
    const spec = fileSnapshotSelection({ paths: ['.'] }, budget);
    const capture = await this.#capture(spec, budget, retainBytes);
    const manifest = Object.fromEntries(capture.entries.map(({ path, bytes, sha256 }) => [path, { bytes, content_hash: sha256 }]));
    return { files: capture.files, manifest, content_hash: digest(canonical(manifest)), file_digest: completeDigest(capture.digest),
      dispose: capture.dispose };
  }

  get installPending() { return this.#installer.held !== null || this.#grantUnknown; }

  replace(input: FileReplaceOptions, pids: number[]) {
    return this.#serialize(async (): Promise<WorkerFileReplace> => {
      this.assertOpen();
      const { requestId, expectedDigest, writable } = input ?? {};
      if (this.#shared) throw failure('NOT_ALLOWED', 'File replacement requires a private workDir');
      if (!requestIdValid(requestId) || !/^complete:sha256:[a-f0-9]{64}$/.test(expectedDigest) ||
          (writable !== undefined && writable !== true)) {
        throw failure('INVALID_CONTRACT', 'Replacement requires requestId, a complete digest and optional writable: true');
      }
      const target = decodedTree(input.files, this.policy.replace);
      const digest = completeDigest(target.digest);
      const identity = JSON.stringify([expectedDigest, digest, writable ?? null]);
      let record = this.#replacements.get(requestId);
      if (record && record.identity !== identity) throw failure('CONFLICT', 'Replacement requestId already has different input');
      if (record?.work) return record.work;
      if (!record) {
        if (this.installPending) throw failure('WORKSPACE_BUSY', 'A replacement is awaiting verification');
        record = { identity };
        this.#replacements.set(requestId, record);
      }
      if (!record.plan) {
        const before = await this.#projectSnapshot(this.policy.replace);
        if (before.file_digest !== expectedDigest) throw failure('CONFLICT', 'The complete workDir digest changed after capture');
        const tree = installTree(input.files, this.policy.replace);
        await this.#installer.initialize();
        record.plan = {
          request_id: requestId, execution_id: 'core-files', binding_version: 1,
          expected_content_hash: before.content_hash, expected_file_digest: expectedDigest,
          content_hash: tree.content_hash, file_digest: digest,
          file_modes: Object.fromEntries(target.source.map(entry => [entry.path, entry.mode])),
        };
      }
      const counts = assertFileManifest(target.inventory, this.policy.replace);
      const previous = this.#installer.query(record.plan);
      if (previous.phase === 'not_found') {
        await checkFileSpace(this.path, counts.totalBytes, counts.fileCount + counts.directoryCount, 'Sandbox workDir replacement');
      }
      this.#temporaryBytes = fileSpool(input.files) ? counts.totalBytes : 0;
      let receipt;
      try { receipt = await this.#installer.install({ ...record.plan, files: input.files }, pids); }
      finally { this.#temporaryBytes = 0; }
      if (receipt.phase === 'failed') {
        const error = { code: 'WORKSPACE_REQUEST_ABORTED', message: 'Replacement rolled back and restored the workDir', retryable: false };
        return record.work = { requestId, status: 'failed', error };
      }
      if (!['installed', 'committed'].includes(receipt.phase)) throw failure('OPERATION_UNKNOWN', 'Replacement is awaiting reconciliation');
      if (writable && !this.#writable) {
        this.#grantUnknown = true;
        await this.#grantWrite(target.source);
        this.#grantUnknown = false;
      }
      this.assertOpen();
      this.#installer.confirm(record.plan);
      return record.work = { requestId, status: 'completed', digest, writable: this.#writable };
    });
  }
}

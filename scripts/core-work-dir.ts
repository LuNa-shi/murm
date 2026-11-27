import { chmod, chown, lstat, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FileReplaceOptions, FileSnapshotOptions, FileTree } from '../src/core/types.js';
import type { WorkerFileReplace, WorkerFileSnapshot } from '../src/core/file-controls.js';
import { collectCoreWorkDir } from './core-collection.js';
import { ProjectInstaller, decodeProjectFiles } from './project-install.js';
import {
  completeDigest, decodeFileSeed, fileSnapshotSelection, isFileTreePath, isGitPath, maxFileBytes, maxFiles, partialDigest,
} from './core-file-seed.js';

const failure = (code: string, message: string) => Object.assign(new Error(message), { code });
const requestIdValid = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const decodeFiles = (files: Record<string, string>) => decodeProjectFiles(files, isFileTreePath);
const encodeEntries = (entries: ReturnType<typeof decodeFileSeed>['entries']) =>
  Object.fromEntries(entries.map(entry => [entry.path, entry.bytes.toString('base64')]));
const rootOwner = { uid: 0, gid: 0 };

type FileSpec = ReturnType<typeof fileSnapshotSelection>;
const wholeTree = fileSnapshotSelection({ paths: ['.'] });

export class CoreWorkDir {
  #pending: Promise<unknown> = Promise.resolve();
  #writable = false;
  #shared = false;
  #snapshotVersion = 0;
  #snapshots = new Map<string, { identity: string; receipt: WorkerFileSnapshot }>();
  #replacements = new Map<string, { identity: string; work?: WorkerFileReplace; plan?: Record<string, unknown> }>();
  #installer: ProjectInstaller;
  #grantUnknown = false;
  private readonly path: string;
  private readonly uid: number;
  private readonly gid: number;
  private readonly assertOpen: () => void;

  constructor({ path, uid, gid, assertOpen }: { path: string; uid: number; gid: number; assertOpen: () => void }) {
    this.path = path;
    this.uid = uid;
    this.gid = gid;
    this.assertOpen = assertOpen;
    this.#installer = new ProjectInstaller({
      projectDir: path, controlDir: join(dirname(path), '.core-file-installs'), uid, decode: decodeFiles,
      owner: () => this.#writable ? { uid, gid } : rootOwner, excluded: isGitPath,
      assertOpen, snapshot: () => this.#projectSnapshot(),
    });
  }

  #serialize<T>(operation: () => Promise<T>) {
    const work = this.#pending.then(operation);
    this.#pending = work.catch(() => undefined);
    return work;
  }

  drain() { return this.#pending; }

  async initialize({ files, writable, shared = false }: { files?: unknown; writable: boolean; shared?: boolean }) {
    this.#shared = shared;
    if (shared) { this.#writable = writable; return { writable, version: 0 }; }
    if (files === undefined && !writable) return { writable: false, version: 0 };
    const tree = decodeFileSeed(files ?? {});
    for (const entry of tree.entries) {
      this.assertOpen();
      const path = join(this.path, entry.path);
      await mkdir(dirname(path), { recursive: true, mode: 0o755 });
      await writeFile(path, entry.bytes, { flag: 'wx', mode: entry.mode });
      await chmod(path, entry.mode);
    }
    if ((await this.#projectSnapshot()).file_digest !== completeDigest(tree.digest)) {
      throw failure('CONFLICT', 'Initial project does not match the FileTree');
    }
    if (writable) await this.#grantWrite(tree.entries);
    return { writable, version: 1, digest: tree.digest };
  }

  async #grantWrite(entries: ReturnType<typeof decodeFileSeed>['entries']) {
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
      const spec = fileSnapshotSelection(selection);
      const identity = JSON.stringify(spec);
      const previous = this.#snapshots.get(requestId);
      if (previous) {
        if (previous.identity !== identity) throw failure('CONFLICT', 'Snapshot requestId has different paths or limits');
        return previous.receipt;
      }
      const files = await this.#capture(spec);
      const { digest } = decodeFileSeed(files);
      const base = { requestId, version: ++this.#snapshotVersion, files };
      const receipt: WorkerFileSnapshot = spec.paths[0] === '.'
        ? { ...base, scope: 'complete', digest: completeDigest(digest) }
        : { ...base, scope: 'partial', digest: partialDigest(digest) };
      this.#snapshots.set(requestId, { identity, receipt });
      return receipt;
    });
  }

  async #capture(spec: FileSpec) {
    const files: Record<string, FileTree[string]> = Object.create(null);
    let current!: { path: string; mode: number };
    let chunks!: Buffer[];
    const fileTree = { validPath: isFileTreePath, excluded: isGitPath, maxFiles, maxFileBytes };
    for await (const entry of collectCoreWorkDir(this.path, spec, { fileTree })) {
      this.assertOpen();
      if (entry.type === 'file') { current = entry; chunks = []; }
      if (entry.type === 'chunk') chunks.push(Buffer.from(entry.data, 'base64'));
      if (entry.type === 'fileEnd') {
        files[current.path] = { encoding: 'base64', data: Buffer.concat(chunks).toString('base64'), mode: current.mode & 0o111 ? 0o755 : 0o644 };
      }
    }
    return files;
  }

  async #projectSnapshot() {
    const decoded = decodeFileSeed(await this.#capture(wholeTree));
    const files = encodeEntries(decoded.entries);
    const snapshot = decodeFiles(files);
    return { files, manifest: snapshot.manifest, content_hash: snapshot.content_hash, file_digest: completeDigest(decoded.digest) };
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
      const target = decodeFileSeed(input.files);
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
        const before = await this.#projectSnapshot();
        if (before.file_digest !== expectedDigest) throw failure('CONFLICT', 'The complete workDir digest changed after capture');
        const files = encodeEntries(target.entries);
        const tree = decodeFiles(files);
        await this.#installer.initialize();
        record.plan = {
          request_id: requestId, execution_id: 'core-files', binding_version: 1,
          expected_content_hash: before.content_hash, expected_file_digest: expectedDigest,
          content_hash: tree.content_hash, file_digest: digest, files,
          file_modes: Object.fromEntries(target.entries.map(entry => [entry.path, entry.mode])),
        };
      }
      const receipt = await this.#installer.install(record.plan, pids);
      if (receipt.phase === 'failed') {
        const error = { code: 'WORKSPACE_REQUEST_ABORTED', message: 'Replacement rolled back and restored the workDir', retryable: false };
        return record.work = { requestId, status: 'failed', error };
      }
      if (!['installed', 'committed'].includes(receipt.phase)) throw failure('OPERATION_UNKNOWN', 'Replacement is awaiting reconciliation');
      if (writable && !this.#writable) {
        this.#grantUnknown = true;
        await this.#grantWrite(target.entries);
        this.#grantUnknown = false;
      }
      this.assertOpen();
      this.#installer.confirm(record.plan);
      return record.work = { requestId, status: 'completed', digest, writable: this.#writable };
    });
  }
}

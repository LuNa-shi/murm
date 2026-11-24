import { createHash } from 'node:crypto';
import { chmod, chown, lstat, mkdir, opendir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ProjectInstaller, decodeProjectFiles, canonical } from './project-install.mjs';

export const BOT_UID = 10001;
export const PROJECT_DIR = '/workspace/project';
export const RUNTIME_DIR = '/workspace/runtime';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const busy = message => Object.assign(new Error(message), { code: 'WORKSPACE_BUSY' });

function projectPath(path) {
  if (typeof path !== 'string' || path.includes('\\') || path.includes('\0') || path.split('/').some(part => !part || ['.', '..', '.git', '.pi', '.swarm', '.env', 'node_modules'].includes(part) || part.startsWith('.swarm-') || part.startsWith('.env.'))) throw new Error('invalid project path');
  return path;
}

// This object is reachable only through the authenticated root worker. Pi is
// a different uid and never receives the worker credential or parent write bit.
export class SandboxProject {
  constructor() {
    this.state = 'UNBOUND';
    this.binding = null;
    this.closing = false;
    this.pending = Promise.resolve();
    this.installer = new ProjectInstaller({ projectDir: PROJECT_DIR, controlDir: '/workspace/.swarm-project-control', uid: BOT_UID,
      snapshot: input => this.#capture(input), assertOpen: input => this.#active(input) });
  }

  async initialize({ shared = false } = {}) {
    this.shared = shared;
    if (process.getuid?.() !== 0) throw new Error('trusted project worker must run as root');
    for (const directory of ['/workspace', PROJECT_DIR, RUNTIME_DIR]) {
      await mkdir(directory, { recursive: true });
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('worker directories cannot be symlinks');
    }
    if (!shared && (await readdir(PROJECT_DIR)).length) throw new Error('new Bot project must be empty');
    await chown('/workspace', 0, 0);
    await chmod('/workspace', 0o755);
    if (!shared) { await chown(PROJECT_DIR, 0, 0); await chmod(PROJECT_DIR, 0o555); }
    await chown(RUNTIME_DIR, BOT_UID, BOT_UID);
    await chmod(RUNTIME_DIR, 0o700);
    await this.installer.initialize();
  }

  #open() { if (this.closing || this.state === 'CLOSED') throw new Error('Bot project is closing'); }
  #locked(operation) {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => undefined);
    return result;
  }
  #identity(input) {
    if (typeof input.execution_id !== 'string' || !input.execution_id || !Number.isInteger(input.binding_version) || input.binding_version < 1) throw new Error('project requires a reserved Execution and fence');
    return { execution_id: input.execution_id, binding_version: input.binding_version };
  }

  prepare(input) {
    return this.#locked(async () => {
      this.#open();
      const identity = this.#identity(input);
      if (!input.manifest || typeof input.manifest !== 'object' || Array.isArray(input.manifest)) throw new Error('project manifest is required');
      const manifest = Object.fromEntries(Object.entries(input.manifest).sort(([a], [b]) => a.localeCompare(b)).map(([path, entry]) => {
        projectPath(path);
        if (!entry || !/^[0-9a-f]{64}$/.test(entry.content_hash) || !Number.isInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > 2 * 1024 * 1024) throw new Error('invalid project manifest entry');
        return [path, { content_hash: entry.content_hash, bytes: entry.bytes }];
      }));
      const supplied = input.files === undefined ? null : decodeProjectFiles(input.files);
      if (supplied && canonical(supplied.manifest) !== canonical(manifest)) throw new Error('supplied project bytes differ from pinned input manifest');
      const fingerprint = JSON.stringify({ ...identity, manifest });
      if (this.binding) {
        if (this.binding.fingerprint !== fingerprint) throw new Error('project already belongs to another input or Execution');
        if (this.state !== 'PREPARED') throw new Error('project preparation is already closed');
        return { state: this.state, ...identity };
      }
      if (supplied) {
        if (!shared && (await readdir(PROJECT_DIR)).length) throw new Error('new Bot project input must be empty');
        try {
          for (const [path, content] of Object.entries(supplied.bytes)) {
            this.#open();
            const target = join(PROJECT_DIR, path);
            await mkdir(dirname(target), { recursive: true, mode: 0o700 });
            await writeFile(target, content, { flag: 'wx', mode: 0o400 });
          }
        } catch (error) {
          for (const name of await readdir(PROJECT_DIR)) await rm(join(PROJECT_DIR, name), { recursive: true, force: true });
          throw error;
        }
      }
      const actual = Object.create(null);
      let bytes = 0;
      const visit = async (directory, prefix = '') => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          this.#open();
          const path = projectPath(prefix ? `${prefix}/${entry.name}` : entry.name);
          const absolute = join(PROJECT_DIR, path);
          if (entry.isDirectory()) { await visit(absolute, path); await chown(absolute, 0, 0); await chmod(absolute, 0o555); }
          else if (entry.isFile()) {
            const info = await lstat(absolute);
            bytes += info.size;
            if (info.size > 2 * 1024 * 1024 || bytes > 16 * 1024 * 1024) throw new Error('project input exceeds byte bounds');
            const content = await readFile(absolute);
            actual[path] = { content_hash: digest(content), bytes: content.length };
            await chown(absolute, 0, 0); await chmod(absolute, 0o444);
          } else throw new Error('project input contains a symlink or special file');
        }
      };
      await visit(PROJECT_DIR);
      this.#open();
      const ordered = Object.fromEntries(Object.entries(actual).sort(([a], [b]) => a.localeCompare(b)));
      if (JSON.stringify(ordered) !== JSON.stringify(manifest)) throw new Error('guest project differs from pinned input manifest');
      this.binding = { ...identity, fingerprint };
      this.state = 'PREPARED';
      return { state: this.state, ...identity, file_count: Object.keys(actual).length, bytes };
    });
  }

  grant(input) {
    return this.#locked(async () => {
      this.#open();
      const identity = this.#identity(input);
      if (!this.binding || this.binding.execution_id !== identity.execution_id || this.binding.binding_version !== identity.binding_version) throw new Error('project grant does not match its prepared Execution');
      if (this.state === 'ACTIVE') return { state: this.state, ...identity, granted_at: this.binding.granted_at };
      if (this.state !== 'PREPARED') throw new Error('project is not prepared');
      // Block pathname traversal while ownership changes. The worker also
      // pauses every Bot process so pre-opened descriptors cannot bypass it.
      try {
        await chmod(PROJECT_DIR, 0o500);
        this.#open();
        const grantDirectory = async directory => {
          for await (const entry of await opendir(directory)) {
            this.#open();
            const target = join(directory, entry.name);
            if (entry.isDirectory()) await grantDirectory(target);
            else if (entry.isFile()) { await chown(target, BOT_UID, BOT_UID); await chmod(target, 0o644); }
            else throw new Error('project grant encountered a symlink or special file');
          }
          this.#open();
          if (directory !== PROJECT_DIR) { await chown(directory, BOT_UID, BOT_UID); await chmod(directory, 0o755); }
        };
        await grantDirectory(PROJECT_DIR);
        this.#open();
        await chmod(PROJECT_DIR, 0o000);
        await chown(PROJECT_DIR, BOT_UID, BOT_UID);
        this.#open();
        await chmod(PROJECT_DIR, 0o755);
        this.#open();
        this.state = 'ACTIVE';
        this.binding.granted_at = Date.now();
        return { state: this.state, ...identity, granted_at: this.binding.granted_at };
      } catch (error) { this.beginClose(); throw error; }
    });
  }

  #active(input) {
    this.#open();
    const identity = this.#identity(input);
    if (this.state !== 'ACTIVE' || this.binding?.execution_id !== identity.execution_id || this.binding?.binding_version !== identity.binding_version) throw new Error('project operation requires its active E binding');
  }

  get installPending() { return this.installer.held !== null; }
  install(input, pids) { return this.#locked(() => this.installer.install(input, pids)); }
  queryInstall(input) { this.#identity(input); return this.installer.query(input); }
  installReceipts() { return this.installer.receipts(); }
  confirmInstall(input) { return this.#locked(() => this.installer.confirm(input)); }
  snapshot(input) {
    return this.#locked(() => {
      if (this.installPending) throw busy('Apply is awaiting durable acknowledgement');
      return this.#capture(input);
    });
  }

  async #capture(input) {
      this.#open();
      const identity = this.#identity(input);
      if (this.state !== 'ACTIVE' || this.binding?.execution_id !== identity.execution_id || this.binding?.binding_version !== identity.binding_version) throw new Error('snapshot requires the active project binding');
      const deadline = Date.now() + 10_000;
      const collect = async includeFiles => {
        const files = Object.create(null);
        const manifest = Object.create(null);
        let totalBytes = 0;
        let entries = 0;
        const visit = async (directory, prefix = '') => {
          const names = new Set();
          for await (const entry of await opendir(directory)) {
            this.#open();
            if (++entries > 10_000 || Date.now() >= deadline) throw busy('project exceeds the bounded snapshot window');
            // An invalid-byte POSIX filename can decode to the same string as
            // a legitimate U+FFFD name. Never silently drop the colliding file.
            if (names.has(entry.name)) throw new Error('snapshot rejects ambiguous decoded filenames');
            names.add(entry.name);
            const path = projectPath(prefix ? `${prefix}/${entry.name}` : entry.name);
            const absolute = join(PROJECT_DIR, path);
            const info = await lstat(absolute);
            if (info.isDirectory()) await visit(absolute, path);
            else if (info.isFile() && info.nlink === 1) {
              totalBytes += info.size;
              if (info.size > 2 * 1024 * 1024 || totalBytes > 16 * 1024 * 1024) throw new Error('project exceeds snapshot byte bounds');
              const bytes = await readFile(absolute);
              if (bytes.length !== info.size) throw busy('project changed during snapshot');
              manifest[path] = { bytes: bytes.length, content_hash: digest(bytes) };
              if (includeFiles) files[path] = bytes.toString('base64');
            } else throw new Error('snapshot rejects symlinks, hardlinks and special files');
          }
        };
        await visit(PROJECT_DIR);
        // Same canonical key order as the controller's stableStringify.
        const ordered = Object.fromEntries(Object.keys(manifest).sort().map(path => [path, manifest[path]]));
        const canonical = `{${Object.keys(ordered).sort().map(path => `${JSON.stringify(path)}:${JSON.stringify(ordered[path])}`).join(',')}}`;
        return { files, manifest: ordered, content_hash: digest(canonical), bytes: totalBytes };
      };
      const captured = await collect(true);
      const checked = await collect(false);
      this.#open();
      if (captured.content_hash !== checked.content_hash || Date.now() >= deadline) throw busy('project changed or exceeded the stable snapshot window');
      return { state: this.state, ...identity, ...captured };
  }

  beginClose() { this.closing = true; }
  close() {
    this.beginClose();
    return this.#locked(async () => {
      if (!this.shared) { await chown(PROJECT_DIR, 0, 0); await chmod(PROJECT_DIR, 0o555); }
      this.state = 'CLOSED';
      return { state: this.state };
    });
  }
}

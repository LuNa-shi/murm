import { createHash } from 'node:crypto';
import { chmod, chown, lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const BOT_UID = 10001;
export const PROJECT_DIR = '/workspace/project';
export const RUNTIME_DIR = '/workspace/runtime';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

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
  }

  async initialize() {
    if (process.getuid?.() !== 0) throw new Error('trusted project worker must run as root');
    for (const directory of ['/workspace', PROJECT_DIR, RUNTIME_DIR]) {
      await mkdir(directory, { recursive: true });
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('worker directories cannot be symlinks');
    }
    if ((await readdir(PROJECT_DIR)).length) throw new Error('new Bot project must be empty');
    await chown('/workspace', 0, 0);
    await chmod('/workspace', 0o755);
    await chown(PROJECT_DIR, 0, 0);
    await chmod(PROJECT_DIR, 0o555);
    await chown(RUNTIME_DIR, BOT_UID, BOT_UID);
    await chmod(RUNTIME_DIR, 0o700);
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
      const fingerprint = JSON.stringify({ ...identity, manifest });
      if (this.binding) {
        if (this.binding.fingerprint !== fingerprint) throw new Error('project already belongs to another input or Execution');
        if (this.state !== 'PREPARED') throw new Error('project preparation is already closed');
        return { state: this.state, ...identity };
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
          for (const entry of await readdir(directory, { withFileTypes: true })) {
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

  beginClose() { this.closing = true; }
  close() {
    this.beginClose();
    return this.#locked(async () => {
      await chown(PROJECT_DIR, 0, 0);
      await chmod(PROJECT_DIR, 0o555);
      this.state = 'CLOSED';
      return { state: this.state };
    });
  }
}

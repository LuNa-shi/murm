import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, chown, lstat, mkdir, opendir, rm, rmdir, writeFile } from 'node:fs/promises';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const hash = (value: any) => createHash('sha256').update(value).digest('hex');
export const canonical = (value: any): string => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort().map((key: any) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const busy = (message: any) => Object.assign(new Error(message), { code: 'WORKSPACE_BUSY' });
const invalid = (message: any) => Object.assign(new Error(message), { code: 'INVALID_CONTRACT' });
const pathValid = (path: any) => typeof path === 'string' && !path.includes('\\') && !path.includes('\0') && !path.split('/').some((part: any) => !part || ['.', '..', '.git', '.pi', '.swarm', '.env', 'node_modules'].includes(part) || part.startsWith('.swarm-') || part.startsWith('.env.'));
const changes = (a: any, b: any) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((path: any) => a[path]?.content_hash !== b[path]?.content_hash || a[path]?.bytes !== b[path]?.bytes).sort();

function writeReceipt(path: any, receipt: any, fault: any = null) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(receipt)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
    fault?.('after_receipt_rename');
    const directory = openSync(dirname(path), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally { try { unlinkSync(temporary); } catch {} }
}

export function decodeProjectFiles(files: any) {
  if (!files || typeof files !== 'object' || Array.isArray(files) || Object.keys(files).length > 10_000) throw invalid('Install requires a bounded complete file map');
  const bytes: Record<string, Buffer> = Object.create(null);
  const manifest: Record<string, { bytes: number; content_hash: string }> = Object.create(null);
  let total = 0;
  for (const path of Object.keys(files).sort()) {
    if (!pathValid(path) || typeof files[path] !== 'string' || files[path].length > 4 * Math.ceil(2 * 1024 * 1024 / 3)) throw invalid('Install file is outside its bounds');
    const value = Buffer.from(files[path], 'base64');
    total += value.length;
    if (value.toString('base64') !== files[path] || value.length > 2 * 1024 * 1024 || total > 16 * 1024 * 1024) throw invalid('Install file encoding or bytes are invalid');
    bytes[path] = value;
    manifest[path] = { bytes: value.length, content_hash: hash(value) };
  }
  // Reject file/directory collisions before touching the project.
  for (const path of Object.keys(files)) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) if (Object.hasOwn(files, parts.slice(0, i).join('/'))) throw invalid('Install file/directory paths collide');
  }
  return { bytes, manifest, content_hash: hash(canonical(manifest)) };
}

/** Trusted worker-only transaction. Call install with every Bot process paused.
 * The project root inode is never replaced. Installed content remains paused
 * until the controller acknowledges its durable E state via confirm.
 */
export class ProjectInstaller {
  declare projectDir: any;
  declare controlDir: any;
  declare uid: any;
  declare snapshot: any;
  declare assertOpen: any;
  declare fault: any;

  declare held: any;

  constructor({ projectDir, controlDir, uid, snapshot, assertOpen, fault = null }: any) {
    Object.assign(this, { projectDir, controlDir, uid, snapshot, assertOpen, fault });
    this.held = null;
  }

  async initialize() {
    await mkdir(this.controlDir, { mode: 0o700, recursive: true });
    await chown(this.controlDir, 0, 0);
    await chmod(this.controlDir, 0o700);
  }

  #key(input: any) {
    if (typeof input.request_id !== 'string' || !input.request_id || input.request_id.length > 512 || typeof input.execution_id !== 'string' || !Number.isInteger(input.binding_version)) throw invalid('Install requires request, E and fence');
    return join(this.controlDir, `${hash(canonical([input.execution_id, input.binding_version, input.request_id]))}.json`);
  }

  #public(receipt: any) {
    return { request_id: receipt.request_id, execution_id: receipt.execution_id, binding_version: receipt.binding_version,
      phase: receipt.phase === 'committed' && this.held === this.#key(receipt) ? 'installed' : receipt.phase,
      fingerprint: receipt.fingerprint, content_hash: receipt.content_hash, expected_content_hash: receipt.expected_content_hash,
      changed_paths: receipt.changed_paths, error: receipt.error ?? null };
  }

  query(input: any) {
    const key = this.#key(input);
    return existsSync(key) ? this.#public(JSON.parse(readFileSync(key, 'utf8'))) : { request_id: input.request_id, phase: 'not_found', execution_id: input.execution_id, binding_version: input.binding_version };
  }

  async receipts() {
    const receipts: any[] = [];
    for await (const entry of await opendir(this.controlDir)) {
      if (entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name)) receipts.push(this.#public(JSON.parse(readFileSync(join(this.controlDir, entry.name), 'utf8'))));
    }
    return receipts;
  }

  confirm(input: any) {
    this.assertOpen(input);
    const key = this.#key(input);
    if (!existsSync(key)) throw invalid('Install acknowledgement has no receipt');
    const receipt = JSON.parse(readFileSync(key, 'utf8'));
    if (input.content_hash !== receipt.content_hash) throw invalid('Install acknowledgement hash differs');
    if (receipt.phase === 'committed' && this.held !== key) return this.#public(receipt);
    if (!['installed', 'committed'].includes(receipt.phase) || this.held !== key) throw invalid('Install is not awaiting acknowledgement');
    receipt.phase = 'committed';
    writeReceipt(key, receipt, this.fault);
    this.held = null;
    try { unlinkSync(`${key}.capture`); } catch {} // A stale private capture is safe after the durable receipt.
    return this.#public(receipt);
  }

  async #writeTree(before: any, target: any, changed: any, modes: any = Object.create(null)) {
    // Preserve all unaffected file/directory inodes. Only directories that
    // would collide with a target file are removed; ordinary empty dirs stay.
    const deadline = Date.now() + 15_000;
    for (const path of [...changed].sort((a: any, b: any) => b.split('/').length - a.split('/').length)) {
      if (Date.now() >= deadline) throw busy('Project installation exceeded its write window');
      const absolute = join(this.projectDir, path);
      if (Object.hasOwn(before, path)) {
        try { if ((await lstat(absolute)).isFile()) await rm(absolute); }
        catch (error: any) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
      }
    }
    for (const path of changed.filter((path: any) => Object.hasOwn(target, path))) {
      if (Date.now() >= deadline) throw busy('Project installation exceeded its write window');
      const absolute = join(this.projectDir, path);
      try { if ((await lstat(absolute)).isDirectory()) await rm(absolute, { recursive: true }); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      await mkdir(dirname(absolute), { recursive: true, mode: 0o755 });
      const parents = path.split('/').slice(0, -1);
      for (let i = 1; i <= parents.length; i++) await chown(join(this.projectDir, ...parents.slice(0, i)), this.uid, this.uid);
      const mode = Object.hasOwn(modes, path) ? modes[path] : 0o644;
      await writeFile(absolute, target[path], { flag: 'wx', mode });
      await chown(absolute, this.uid, this.uid);
      await chmod(absolute, mode);
      this.fault?.('after_file_write');
      const file = openSync(absolute, 'r');
      try { fsyncSync(file); } finally { closeSync(file); }
      const directory = openSync(dirname(absolute), 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
    const parents = new Set(['']);
    for (const path of changed) {
      const segments = path.split('/').slice(0, -1);
      for (let i = 1; i <= segments.length; i++) parents.add(segments.slice(0, i).join('/'));
    }
    for (const path of parents) {
      let descriptor;
      try { descriptor = openSync(join(this.projectDir, path), 'r'); fsyncSync(descriptor); }
      catch (error: any) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
      finally { if (descriptor !== undefined) closeSync(descriptor); }
    }
  }

  async #directories() {
    const result = Object.create(null);
    let count = 0;
    const visit = async (path: any) => {
      if (++count > 10_000) throw busy('Directory topology exceeds install bounds');
      const absolute = join(this.projectDir, path);
      const info = await lstat(absolute);
      result[path] = { mode: info.mode & 0o7777, uid: info.uid, gid: info.gid };
      for await (const entry of await opendir(absolute)) if (entry.isDirectory()) await visit(path ? `${path}/${entry.name}` : entry.name);
    };
    await visit('');
    return result;
  }

  async #restoreDirectories(original: any) {
    const current = await this.#directories();
    for (const path of Object.keys(current).sort((a: any, b: any) => b.split('/').length - a.split('/').length)) {
      if (!Object.hasOwn(original, path)) await rmdir(join(this.projectDir, path));
    }
    for (const path of Object.keys(original).sort((a: any, b: any) => a.split('/').length - b.split('/').length)) {
      const absolute = join(this.projectDir, path), info = original[path];
      await mkdir(absolute, { recursive: true });
      await chown(absolute, info.uid, info.gid);
      await chmod(absolute, info.mode);
    }
    if (canonical(await this.#directories()) !== canonical(original)) throw new Error('Apply rollback directory topology differs');
    for (const path of Object.keys(original)) {
      const directory = openSync(join(this.projectDir, path), 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
  }

  async install(input: any, pids: any) {
    this.assertOpen(input);
    const key = this.#key(input);
    const target = decodeProjectFiles(input.files);
    if (target.content_hash !== input.content_hash || !/^[a-f0-9]{64}$/.test(input.expected_content_hash)) throw invalid('Install manifest hashes disagree');
    const fileModes = input.file_modes;
    if (fileModes !== undefined && (!fileModes || Object.keys(fileModes).sort().join('\0') !== Object.keys(target.bytes).sort().join('\0') ||
        Object.values(fileModes).some(mode => ![0o644, 0o755].includes(mode as number)))) throw invalid('Install file modes disagree with the complete tree');
    const fingerprint = hash(canonical({ ...(fileModes ? { file_modes: fileModes } : {}), expected_content_hash: input.expected_content_hash, content_hash: target.content_hash }));
    if (existsSync(key)) {
      const previous = JSON.parse(readFileSync(key, 'utf8'));
      if (previous.fingerprint !== fingerprint) throw invalid('Install request ID was reused with a different tree');
      return this.#public(previous);
    }
    if (this.held) throw busy('Another install is awaiting durable acknowledgement');
    const original = await this.snapshot(input);
    if (original.content_hash !== input.expected_content_hash) throw Object.assign(busy('Project changed after apply capture; save before applying again'), { applyBlocker: 'dirty' });
    const changed = changes(original.manifest, target.manifest);
    if (fileModes) for (const path of Object.keys(fileModes)) {
      try {
        if (((await lstat(join(this.projectDir, path))).mode & 0o7777) !== fileModes[path] && !changed.includes(path)) changed.push(path);
      } catch (error: any) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
    }
    const replacedDirectories: any[] = [];
    const modes = Object.create(null);
    for (const path of changed) {
      try {
        const info = await lstat(join(this.projectDir, path));
        if (info.isDirectory() && Object.hasOwn(target.bytes, path)) replacedDirectories.push(path);
        if (info.isFile()) modes[path] = info.mode & 0o7777;
      } catch (error: any) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    }
    const inspect = { pids, projectDir: this.projectDir, changedPaths: changed, replacedDirectories };
    const inspectionInput = JSON.stringify(inspect);
    if (Buffer.byteLength(inspectionInput) > 32 * 1024 * 1024) throw invalid('Process inspection metadata exceeds its 32 MiB bound');
    try {
      const stdout = await new Promise<any>((resolve: any, reject: any) => {
        const child = execFile('/usr/bin/setpriv', [`--reuid=${this.uid}`, `--regid=${this.uid}`, '--clear-groups', '--no-new-privs', '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all',
          process.execPath, fileURLToPath(new URL('./project-processes.js', import.meta.url))], { env: { PATH: '/usr/local/bin:/usr/bin:/bin' }, cwd: '/', timeout: 5000, maxBuffer: 64 * 1024 },
        (error: any, stdout: any) => error ? reject(error) : resolve(stdout));
        child.stdin!.on('error', reject);
        child.stdin!.end(inspectionInput);
      });
      if (JSON.parse(stdout).safe !== true) throw new Error('Project process inspection was inconclusive');
    } catch (error: any) { throw Object.assign(busy('An open project file, mapped file or cwd prevents safe installation'), { applyBlocker: 'active_writer' }); }
    this.assertOpen(input);
    const directories = await this.#directories();
    // Large immutable bytes are written once. Phase transitions only replace a
    // small receipt, avoiding two simultaneous copies of both complete trees.
    const { files, ...identity } = input;
    writeReceipt(`${key}.capture`, { files, original, modes, directories });
    const receipt = { ...identity, fingerprint, phase: 'installing', changed_paths: changed };
    try { writeReceipt(key, receipt); }
    catch (error: any) { try { unlinkSync(`${key}.capture`); } catch {} throw error; }
    try {
      this.fault?.('before_write');
      await this.#writeTree(decodeProjectFiles(original.files).bytes, target.bytes, changed, fileModes ?? modes);
      this.fault?.('after_write');
      this.assertOpen(input);
      const observed = await this.snapshot(input);
      if (observed.content_hash !== target.content_hash) throw new Error('Installed project differs from the planned tree');
      receipt.phase = 'installed';
      writeReceipt(key, receipt);
      this.held = key;
      this.fault?.('after_installed');
      return this.#public(receipt);
    } catch (error: any) {
      if (this.held === key) throw Object.assign(new Error('Installed apply result needs acknowledgement; query the original request'), { code: 'WORKSPACE_RESULT_UNKNOWN', cause: error });
      try {
        // Writers are still paused. Restore all changed paths, including a
        // partial write, and verify bytes before permitting any resume.
        const old = decodeProjectFiles(original.files);
        const actual = Object.fromEntries(changed.map((path: any) => [path, true]));
        await this.#writeTree(actual, old.bytes, changed, modes);
        await this.#restoreDirectories(directories);
        const restored = await this.snapshot(input);
        if (restored.content_hash !== original.content_hash) throw new Error('Apply rollback hash differs');
        receipt.phase = 'failed'; receipt.error = { code: 'WORKSPACE_REQUEST_ABORTED', message: 'Apply installation rolled back; use a new request ID' };
        writeReceipt(key, receipt);
        try { unlinkSync(`${key}.capture`); } catch {}
        return this.#public(receipt);
      } catch (rollbackError: any) {
        this.held = key; // Worker must keep writers paused and close this Bot.
        throw Object.assign(new Error('Apply rollback could not be verified; Bot must stop'), { code: 'WORKSPACE_RECONCILIATION_REQUIRED', cause: rollbackError });
      }
    }
  }
}

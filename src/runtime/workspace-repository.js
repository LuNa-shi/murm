import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFile as nodeExecFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { ERROR_CODES, SwarmEnvError } from '../errors.js';

const execFile = promisify(nodeExecFile);
const writers = new Map();
const META = '.swarm-workspace.json';
const JOURNAL = '.swarm-journal.json';
const ZERO = '0'.repeat(40);
const GIT_IDENTITY = ['-c', 'user.name=SwarmEnv Runtime', '-c', 'user.email=runtime@swarmenv.invalid'];

function syncDirectory(path) {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function writeWorkspaceJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
  syncDirectory(dirname(path));
}

function gitEnvironment(extra = {}) {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1', ...extra };
}

function gitSync(root, args) {
  try { return execFileSync('git', ['-C', root, ...args], { env: gitEnvironment(), encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch (error) { throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Workspace Git operation failed', { operation: args[0] }, { cause: error }); }
}

async function git(root, args, options = {}) {
  try { return (await execFile('git', ['-C', root, ...args], { env: gitEnvironment(), timeout: 30_000, maxBuffer: 32 * 1024 * 1024, ...options })).stdout; }
  catch (error) { throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Workspace Git operation failed', { operation: args[0] }, { cause: error }); }
}

// The helper's stdin is owned only by this coordinator. Process loss closes
// that pipe and releases the OS lock; no stale PID file or lease expiry can
// steal ownership from a live writer.
async function acquireWriter(root, lockName = '.swarm-writer.lock') {
  const helper = spawn('flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '75', join(root, lockName),
    process.execPath, '-e', "process.stdout.write('locked\\n'); process.stdin.resume(); process.stdin.on('end', () => process.exit(0));"], { stdio: ['pipe', 'pipe', 'pipe'] });
  let acquired = false;
  let output = '';
  const closed = new Promise(resolve => helper.once('close', code => resolve(code)));
  await new Promise((resolve, reject) => {
    helper.once('error', error => reject(new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Workspace writer lock could not start', undefined, { cause: error })));
    helper.stdout.on('data', chunk => {
      output += chunk;
      if (!acquired && output.includes('locked\n')) { acquired = true; resolve(); }
    });
    helper.once('close', code => { if (!acquired) reject(new SwarmEnvError(code === 75 ? 'WORKSPACE_BUSY' : ERROR_CODES.SERVICE_UNAVAILABLE, 'Workspace writer lock is unavailable', undefined, { retryable: code === 75 })); });
  });
  return async () => { helper.stdin.end(); await closed; };
}

/** Git objects, single-writer exclusion and ref/index crash recovery for one Workspace. */
export class WorkspaceRepository {
  constructor({ fault = null } = {}) { this.fault = fault; }

  async locked(root, operation) {
    const prior = writers.get(root) ?? Promise.resolve();
    let unlock;
    const pending = new Promise(resolve => { unlock = resolve; });
    writers.set(root, pending);
    await prior;
    let release = null;
    try {
      await mkdir(root, { recursive: true });
      release = await acquireWriter(root);
      this.recover(root);
      return await operation();
    } finally {
      try { await release?.(); }
      finally {
        if (writers.get(root) === pending) writers.delete(root);
        unlock();
      }
    }
  }

  async requestLocked(root, key, operation) {
    await mkdir(join(root, '.swarm-request-locks'), { recursive: true });
    const release = await acquireWriter(root, join('.swarm-request-locks', `${key}.lock`));
    try { return await operation(); } finally { await release(); }
  }

  hasIntent(root) { return existsSync(join(root, JOURNAL)); }

  async initialize(root) { await git(root, ['init', '--initial-branch=main', '--template=', root]); }

  async importTree(root, files, parentCommits, message) {
    const stageRoot = join(root, '.swarm-staging');
    await mkdir(stageRoot, { recursive: true });
    const stage = await mkdtemp(join(stageRoot, 'tree-'));
    const worktree = join(stage, 'files');
    await mkdir(worktree);
    try {
      const entries = [];
      for (const [path, content] of Object.entries(files)) {
        const target = join(worktree, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content);
        const blob = String(await git(root, ['hash-object', '--no-filters', '-w', '--', target])).trim();
        entries.push(`100644 ${blob}\t${path}\0`);
      }
      const env = gitEnvironment({ GIT_INDEX_FILE: join(stage, 'index') });
      await git(root, ['read-tree', '--empty'], { env });
      await new Promise((resolve, reject) => {
        const child = nodeExecFile('git', ['-C', root, 'update-index', '-z', '--index-info'], { env, timeout: 30_000 }, error => error ? reject(error) : resolve());
        child.stdin.on('error', reject);
        child.stdin.end(entries.join(''));
      });
      const tree = String(await git(root, ['write-tree'], { env })).trim();
      return { tree, commit: await this.commitTree(root, tree, parentCommits, message) };
    } finally { await rm(stage, { recursive: true, force: true }); }
  }

  async commitTree(root, tree, parents, message) {
    return String(await git(root, [...GIT_IDENTITY, 'commit-tree', tree, ...parents.flatMap(parent => ['-p', parent]), '-m', message])).trim();
  }

  async readTree(root, tree) {
    const listing = String(await git(root, ['ls-tree', '-rz', '--full-tree', tree]));
    const files = Object.create(null);
    for (const entry of listing.split('\0').filter(Boolean)) {
      const tab = entry.indexOf('\t');
      const [mode, type, object] = entry.slice(0, tab).split(' ');
      if (type !== 'blob' || !['100644', '100755'].includes(mode)) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Workspace tree contains a non-regular file');
      const content = await git(root, ['cat-file', 'blob', object], { encoding: 'buffer' });
      const text = content.toString('utf8');
      files[entry.slice(tab + 1)] = !content.includes(0) && Buffer.from(text).equals(content) ? text : content;
    }
    return files;
  }

  async mergeTrees(root, main, source) {
    try {
      await execFile('git', ['-C', root, 'merge-base', '--is-ancestor', source, main], { env: gitEnvironment(), timeout: 30_000 });
      return { alreadyIncluded: true };
    } catch (error) { if (error.code !== 1) throw error; }
    try {
      const result = await execFile('git', ['-C', root, 'merge-tree', '--write-tree', '--name-only', '-z', main, source], { env: gitEnvironment(), timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
      return { tree: result.stdout.split('\0')[0].trim(), conflicts: [] };
    } catch (error) {
      if (error.code !== 1) throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Workspace Git merge failed', undefined, { cause: error });
      const fields = String(error.stdout).split('\0');
      const end = fields.indexOf('', 1);
      return { tree: fields[0].trim(), conflicts: fields.slice(1, end < 0 ? fields.length : end) };
    }
  }

  commit(root, { kind, oldMain, newMain, record, revision, receipt = null }) {
    this.assertMain(root, oldMain);
    const intent = { version: 1, kind, old_main: oldMain, new_main: newMain, record, revision, receipt };
    writeWorkspaceJson(join(root, JOURNAL), intent);
    this.fault?.('after_intent');
    if (newMain !== oldMain) gitSync(root, ['update-ref', 'refs/heads/main', newMain, oldMain ?? ZERO]);
    this.fault?.('after_main_ref');
    this.#retain(root, revision);
    this.fault?.('after_ref');
    this.#finish(root, intent);
  }

  assertMain(root, expected) {
    let actual = null;
    try { actual = gitSync(root, ['rev-parse', '--verify', 'refs/heads/main']); } catch { /* Initial creation has no main ref. */ }
    if (actual !== expected) throw new SwarmEnvError('WORKSPACE_RECONCILIATION_REQUIRED', 'Workspace main and index disagree');
  }

  recover(root) {
    const path = join(root, JOURNAL);
    if (!existsSync(path)) return;
    const intent = JSON.parse(readFileSync(path, 'utf8'));
    if (intent.version !== 1 || !intent.record || !intent.revision) throw new SwarmEnvError('WORKSPACE_RECONCILIATION_REQUIRED', 'Workspace intent is invalid');
    let observed = null;
    try { observed = gitSync(root, ['rev-parse', '--verify', 'refs/heads/main']); } catch { /* Initial creation may not have a ref yet. */ }
    if (observed !== intent.old_main && observed !== intent.new_main) throw new SwarmEnvError('WORKSPACE_RECONCILIATION_REQUIRED', 'Workspace main matches neither committed intent value');
    if (intent.kind === 'merge' && observed === intent.old_main && intent.new_main !== intent.old_main) {
      if (intent.receipt) this.writeReceipt(root, { ...intent.receipt, error: { code: 'WORKSPACE_REQUEST_ABORTED', message: 'Merge stopped before main update; use a new attempt ID' }, result: null });
      unlinkSync(path);
      syncDirectory(root);
      return;
    }
    this.#retain(root, intent.revision);
    if (observed !== intent.new_main && intent.new_main) gitSync(root, ['update-ref', 'refs/heads/main', intent.new_main, observed ?? ZERO]);
    this.#finish(root, intent, false);
  }

  readReceipt(root, requestHash) {
    const path = join(root, '.swarm-requests', `${requestHash}.json`);
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  }

  writeReceipt(root, receipt) { writeWorkspaceJson(join(root, '.swarm-requests', `${receipt.key}.json`), receipt); }

  #retain(root, revision) {
    const ref = `refs/swarm/revisions/${revision.revision}`;
    let previous = null;
    try { previous = gitSync(root, ['rev-parse', '--verify', ref]); } catch { /* New revision. */ }
    if (previous && previous !== revision.git_commit) throw new SwarmEnvError('WORKSPACE_RECONCILIATION_REQUIRED', 'Immutable revision ref conflicts with commit intent');
    if (!previous) gitSync(root, ['update-ref', ref, revision.git_commit, ZERO]);
  }

  #finish(root, intent, injectFault = true) {
    writeWorkspaceJson(join(root, '.swarm-revisions', `${intent.revision.revision}.json`), intent.revision);
    writeWorkspaceJson(join(root, META), intent.record);
    if (injectFault) this.fault?.('after_index');
    if (intent.receipt) this.writeReceipt(root, intent.receipt);
    if (injectFault) this.fault?.('after_receipt');
    unlinkSync(join(root, JOURNAL));
    syncDirectory(root);
  }
}

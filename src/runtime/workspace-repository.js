import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFile as nodeExecFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { ERROR_CODES, SwarmEnvError } from '../errors.js';

const execFile = promisify(nodeExecFile);
const writers = new Map();
const META = '.swarm-workspace.json';
const JOURNAL = '.swarm-journal.json';
export const WORKSPACE_HISTORY_DIR = '.swarm-history';
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

const historyFile = sequence => `${String(sequence).padStart(12, '0')}.json`;

/** Read-only committed event history; missing entries are never silently skipped. */
export function readWorkspaceHistory(root) {
  const path = join(root, WORKSPACE_HISTORY_DIR);
  if (!existsSync(path)) return [];
  const files = readdirSync(path).filter(name => /^\d{12}\.json$/.test(name)).sort();
  let previous = null;
  const events = files.map((name, index) => {
    const event = JSON.parse(readFileSync(join(path, name), 'utf8'));
    if (name !== historyFile(index + 1) || event.version !== 1 || event.sequence !== index + 1 ||
        typeof event.event_id !== 'string' || !Number.isFinite(Date.parse(event.committed_at)) ||
        event.previous_event_id !== (previous?.event_id ?? null) ||
        (previous && event.committed_at < previous.committed_at)) {
      throw new SwarmEnvError('REPLAY_HISTORY_INCOMPLETE', 'Workspace history has a missing or invalid event', { file: name });
    }
    previous = event;
    return event;
  });
  const headPath = join(path, 'head.json');
  const head = existsSync(headPath) ? JSON.parse(readFileSync(headPath, 'utf8')) : null;
  if (!events.length || head?.sequence !== events.length || head.event_id !== previous.event_id || head.committed_at !== previous.committed_at) {
    throw new SwarmEnvError('REPLAY_HISTORY_INCOMPLETE', 'Workspace history head does not cover its committed events');
  }
  return events;
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
  constructor({ fault = null, clock = Date.now } = {}) { this.fault = fault; this.clock = clock; }

  async locked(root, operation, { signal = null } = {}) {
    signal?.throwIfAborted();
    const prior = writers.get(root) ?? Promise.resolve();
    let unlock;
    const pending = new Promise(resolve => { unlock = resolve; });
    writers.set(root, pending);
    let operationStarted = false;
    const work = (async () => {
      let release = null;
      try {
        await prior;
        signal?.throwIfAborted();
        await mkdir(root, { recursive: true });
        release = await acquireWriter(root);
        signal?.throwIfAborted();
        // Cancellation only withdraws queued work. Once admitted under the
        // lock, the operation and lock release must settle normally.
        operationStarted = true;
        this.recover(root);
        return await operation();
      } finally {
        try { await release?.(); }
        finally {
          if (writers.get(root) === pending) writers.delete(root);
          unlock();
        }
      }
    })();
    if (!signal) return work;
    return new Promise((resolve, reject) => {
      const aborted = () => { if (!operationStarted) reject(signal.reason); };
      signal.addEventListener('abort', aborted, { once: true });
      // Keep the queue slot until its predecessor releases, even if its
      // caller leaves early. Later writers must not overtake that predecessor.
      work.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
      if (signal.aborted) aborted();
    });
  }

  async requestLocked(root, key, operation) {
    await mkdir(join(root, '.swarm-request-locks'), { recursive: true });
    const release = await acquireWriter(root, join('.swarm-request-locks', `${key}.lock`));
    try { return await operation(); } finally { await release(); }
  }

  hasIntent(root) { return existsSync(join(root, JOURNAL)); }

  async initialize(root) { await git(root, ['init', '--initial-branch=main', '--template=', root]); }

  async createInitialTree(root, files) {
    await this.initialize(root);
    const imported = await this.importTree(root, files, [], 'Initial Execution project input');
    gitSync(root, ['update-ref', 'refs/heads/main', imported.commit, ZERO]);
    gitSync(root, ['read-tree', '--reset', imported.commit]);
    return imported;
  }

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
      const result = await execFile('git', ['-C', root, `--attr-source=${main}`, 'merge-tree', '--write-tree', '--name-only', '-z', main, source], { env: gitEnvironment(), timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
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
    const intent = { version: 2, event_id: randomUUID(), kind, old_main: oldMain, new_main: newMain, record, revision, receipt };
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
    if (![1, 2].includes(intent.version) || !intent.record || (!intent.revision && !['freeze', 'unfreeze', 'receipt'].includes(intent.kind))) throw new SwarmEnvError('WORKSPACE_RECONCILIATION_REQUIRED', 'Workspace intent is invalid');
    let observed = null;
    try { observed = gitSync(root, ['rev-parse', '--verify', 'refs/heads/main']); } catch { /* Initial creation may not have a ref yet. */ }
    if (observed !== intent.old_main && observed !== intent.new_main) throw new SwarmEnvError('WORKSPACE_RECONCILIATION_REQUIRED', 'Workspace main matches neither committed intent value');
    if (intent.kind === 'merge' && observed === intent.old_main && intent.new_main !== intent.old_main) {
      // Abort the unpublished merge first. The terminal receipt is a separate
      // durable event; it must not replace an intent that recovery still owns.
      unlinkSync(path);
      syncDirectory(root);
      if (intent.receipt) this.writeReceipt(root, { ...intent.receipt, error: { code: 'WORKSPACE_REQUEST_ABORTED', message: 'Merge stopped before main update; use a new attempt ID' }, result: null });
      return;
    }
    if (intent.revision) this.#retain(root, intent.revision);
    if (observed !== intent.new_main && intent.new_main) gitSync(root, ['update-ref', 'refs/heads/main', intent.new_main, observed ?? ZERO]);
    this.#finish(root, intent, false);
  }

  readReceipt(root, requestHash) {
    const path = join(root, '.swarm-requests', `${requestHash}.json`);
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  }

  writeReceipt(root, receipt) {
    const record = JSON.parse(readFileSync(join(root, META), 'utf8'));
    this.#commitRecord(root, 'receipt', record, receipt);
  }

  writeRecord(root, record, { kind }) {
    if (!['freeze', 'unfreeze'].includes(kind)) throw new TypeError('Unsupported Workspace metadata event');
    this.#commitRecord(root, kind, record);
  }

  #commitRecord(root, kind, record, receipt = null) {
    this.assertMain(root, record.main_commit);
    const intent = { version: 2, event_id: randomUUID(), kind, old_main: record.main_commit,
      new_main: record.main_commit, record, revision: null, receipt };
    writeWorkspaceJson(join(root, JOURNAL), intent);
    this.#finish(root, intent, false);
  }

  #retain(root, revision) {
    const ref = `refs/swarm/revisions/${revision.revision}`;
    let previous = null;
    try { previous = gitSync(root, ['rev-parse', '--verify', ref]); } catch { /* New revision. */ }
    if (previous && previous !== revision.git_commit) throw new SwarmEnvError('WORKSPACE_RECONCILIATION_REQUIRED', 'Immutable revision ref conflicts with commit intent');
    if (!previous) gitSync(root, ['update-ref', ref, revision.git_commit, ZERO]);
  }

  #finish(root, intent, injectFault = true) {
    if (intent.revision) writeWorkspaceJson(join(root, '.swarm-revisions', `${intent.revision.revision}.json`), intent.revision);
    writeWorkspaceJson(join(root, META), intent.record);
    if (injectFault) this.fault?.('after_index');
    if (intent.receipt) writeWorkspaceJson(join(root, '.swarm-requests', `${intent.receipt.key}.json`), intent.receipt);
    if (injectFault) this.fault?.('after_receipt');
    this.#recordHistory(root, intent, injectFault);
    unlinkSync(join(root, JOURNAL));
    syncDirectory(root);
  }

  #recordHistory(root, intent, injectFault) {
    const directory = join(root, WORKSPACE_HISTORY_DIR);
    const headPath = join(directory, 'head.json');
    let head = existsSync(headPath) ? JSON.parse(readFileSync(headPath, 'utf8')) : null;
    // If a process stopped after publishing an event but before its head, keep
    // that event. Event files are immutable and are never overwritten on retry.
    while (existsSync(join(directory, historyFile((head?.sequence ?? 0) + 1)))) {
      const next = JSON.parse(readFileSync(join(directory, historyFile((head?.sequence ?? 0) + 1)), 'utf8'));
      if (next.sequence !== (head?.sequence ?? 0) + 1 || next.previous_event_id !== (head?.event_id ?? null)) {
        throw new SwarmEnvError('REPLAY_HISTORY_INCOMPLETE', 'Workspace history head is inconsistent');
      }
      head = next;
    }
    const eventId = intent.event_id ?? `recovered:${createHash('sha256').update(JSON.stringify(intent)).digest('hex')}`;
    if (head?.event_id === eventId) {
      writeWorkspaceJson(headPath, { sequence: head.sequence, event_id: head.event_id, committed_at: head.committed_at });
      return;
    }
    const committedAt = new Date(Math.max(Number(new Date(this.clock())), head ? Date.parse(head.committed_at) : -Infinity)).toISOString();
    const event = { version: 1, sequence: (head?.sequence ?? 0) + 1, event_id: eventId,
      previous_event_id: head?.event_id ?? null, committed_at: committedAt,
      kind: intent.kind, record: intent.record, revision: intent.revision ?? null, receipt: intent.receipt ?? null };
    writeWorkspaceJson(join(directory, historyFile(event.sequence)), event);
    if (injectFault) this.fault?.('after_history_event');
    writeWorkspaceJson(headPath, { sequence: event.sequence, event_id: event.event_id, committed_at: event.committed_at });
  }
}

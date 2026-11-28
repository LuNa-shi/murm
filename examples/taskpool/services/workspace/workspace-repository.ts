import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFile as nodeExecFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { commitGitTree, importGitTree, initializeGitRepository, isGitTreePath } from '@luna-shi/murm';
import { ERROR_CODES, MurmError } from '../../errors.js';

export { isGitTreePath as isWorkspaceGitPath };

const execFile = promisify(nodeExecFile);
const writers = new Map<any, any>();
const META = '.swarm-workspace.json';
const JOURNAL = '.swarm-journal.json';
export const WORKSPACE_HISTORY_DIR = '.swarm-history';
const ZERO = '0'.repeat(40);
function syncDirectory(path: any) {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function writeWorkspaceJson(path: any, value: any) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
  syncDirectory(dirname(path));
}

const historyFile = (sequence: any) => `${String(sequence).padStart(12, '0')}.json`;

/** Read-only committed event history; missing entries are never silently skipped. */
export function readWorkspaceHistory(root: any) {
  const path = join(root, WORKSPACE_HISTORY_DIR);
  if (!existsSync(path)) return [];
  const files = readdirSync(path).filter((name: any) => /^\d{12}\.json$/.test(name)).sort();
  let previous: any = null;
  const events = files.map((name: any, index: any) => {
    const event = JSON.parse(readFileSync(join(path, name), 'utf8'));
    if (name !== historyFile(index + 1) || event.version !== 1 || event.sequence !== index + 1 ||
        typeof event.event_id !== 'string' || !Number.isFinite(Date.parse(event.committed_at)) ||
        event.previous_event_id !== (previous?.event_id ?? null) ||
        (previous && event.committed_at < previous.committed_at)) {
      throw new MurmError('REPLAY_HISTORY_INCOMPLETE', 'Workspace history has a missing or invalid event', { file: name });
    }
    previous = event;
    return event;
  });
  const headPath = join(path, 'head.json');
  const head = existsSync(headPath) ? JSON.parse(readFileSync(headPath, 'utf8')) : null;
  if (!events.length || head?.sequence !== events.length || head.event_id !== previous.event_id || head.committed_at !== previous.committed_at) {
    throw new MurmError('REPLAY_HISTORY_INCOMPLETE', 'Workspace history head does not cover its committed events');
  }
  return events;
}

function gitEnvironment(extra: any = {}) {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([name]: any) => !name.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1', ...extra };
}

function gitSync(root: any, args: any) {
  try { return execFileSync('git', ['-C', root, ...args], { env: gitEnvironment(), encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch (error: any) { throw new MurmError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Workspace Git operation failed', { operation: args[0] }, { cause: error }); }
}

async function git(root: any, args: any, options: any = {}) {
  try { return (await execFile('git', ['-C', root, ...args], { env: gitEnvironment(), timeout: 30_000, maxBuffer: 32 * 1024 * 1024, ...options })).stdout; }
  catch (error: any) { throw new MurmError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Workspace Git operation failed', { operation: args[0] }, { cause: error }); }
}

// The helper's stdin is owned only by this coordinator. Process loss closes
// that pipe and releases the OS lock; no stale PID file or lease expiry can
// steal ownership from a live writer.
async function acquireWriter(root: any, lockName: any = '.swarm-writer.lock') {
  const helper = spawn('flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '75', join(root, lockName),
    process.execPath, '-e', "process.stdout.write('locked\\n'); process.stdin.resume(); process.stdin.on('end', () => process.exit(0));"], { stdio: ['pipe', 'pipe', 'pipe'] });
  let acquired = false;
  let output = '';
  const closed = new Promise<any>((resolve: any) => helper.once('close', (code: any) => resolve(code)));
  await new Promise<any>((resolve: any, reject: any) => {
    helper.once('error', (error: any) => reject(new MurmError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Workspace writer lock could not start', undefined, { cause: error })));
    helper.stdout.on('data', (chunk: any) => {
      output += chunk;
      if (!acquired && output.includes('locked\n')) { acquired = true; resolve(); }
    });
    helper.once('close', (code: any) => { if (!acquired) reject(new MurmError(code === 75 ? 'WORKSPACE_BUSY' : ERROR_CODES.SERVICE_UNAVAILABLE, 'Workspace writer lock is unavailable', undefined, { retryable: code === 75 })); });
  });
  return async () => { helper.stdin.end(); await closed; };
}

/** Git objects, single-writer exclusion and ref/index crash recovery for one Workspace. */
export class WorkspaceRepository {
  declare fault: any;
  declare clock: any;

  constructor({ fault = null, clock = Date.now }: any = {}) { this.fault = fault; this.clock = clock; }

  async locked(root: any, operation: any, { signal = null }: any = {}) {
    signal?.throwIfAborted();
    const prior = writers.get(root) ?? Promise.resolve();
    let unlock;
    const pending = new Promise<any>((resolve: any) => { unlock = resolve; });
    writers.set(root, pending);
    let operationStarted = false;
    const work = (async () => {
      let release: any = null;
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
          unlock!();
        }
      }
    })();
    if (!signal) return work;
    return new Promise<any>((resolve: any, reject: any) => {
      const aborted = () => { if (!operationStarted) reject(signal.reason); };
      signal.addEventListener('abort', aborted, { once: true });
      // Keep the queue slot until its predecessor releases, even if its
      // caller leaves early. Later writers must not overtake that predecessor.
      work.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
      if (signal.aborted) aborted();
    });
  }

  async requestLocked(root: any, key: any, operation: any) {
    await mkdir(join(root, '.swarm-request-locks'), { recursive: true });
    const release = await acquireWriter(root, join('.swarm-request-locks', `${key}.lock`));
    try { return await operation(); } finally { await release(); }
  }

  hasIntent(root: any) { return existsSync(join(root, JOURNAL)); }

  initialize = initializeGitRepository;
  importTree = importGitTree;
  commitTree = commitGitTree;

  async createInitialTree(root: string, files: Record<string, string | Uint8Array>, { modes, stagingDirectory }: {
    modes?: Readonly<Record<string, 0o644 | 0o755>>;
    stagingDirectory?: string;
  } = {}) {
    await this.initialize(root);
    const imported = await this.importTree(root, files, [], 'Initial Execution project input', modes, stagingDirectory);
    gitSync(root, ['update-ref', 'refs/heads/main', imported.commit, ZERO]);
    gitSync(root, ['read-tree', '--reset', imported.commit]);
    return imported;
  }

  async #listTree(root: string, tree: string) {
    const listing = String(await git(root, ['ls-tree', '-rz', '--full-tree', tree]));
    return listing.split('\0').filter(Boolean).map(entry => {
      const tab = entry.indexOf('\t');
      const [mode, type, object] = entry.slice(0, tab).split(' ');
      if (type !== 'blob' || !['100644', '100755'].includes(mode)) throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Workspace tree contains a non-regular file');
      return { path: entry.slice(tab + 1), object, mode: mode === '100755' ? 0o755 as const : 0o644 as const };
    });
  }

  async readModes(root: string, tree: string) {
    return Object.fromEntries((await this.#listTree(root, tree)).map(({ path, mode }) => [path, mode]));
  }

  async readTree(root: any, tree: any, modes?: Record<string, 0o644 | 0o755>) {
    const files = Object.create(null);
    for (const { path, mode, object } of await this.#listTree(root, tree)) {
      const content = await git(root, ['cat-file', 'blob', object], { encoding: 'buffer' });
      const text = content.toString('utf8');
      if (modes) modes[path] = mode;
      files[path] = !content.includes(0) && Buffer.from(text).equals(content) ? text : content;
    }
    return files;
  }

  async mergeTrees(root: any, main: any, source: any) {
    try {
      await execFile('git', ['-C', root, 'merge-base', '--is-ancestor', source, main], { env: gitEnvironment(), timeout: 30_000 });
      return { alreadyIncluded: true };
    } catch (error: any) { if (error.code !== 1) throw error; }
    try {
      const result = await execFile('git', ['-C', root, `--attr-source=${main}`, 'merge-tree', '--write-tree', '--name-only', '-z', main, source], { env: gitEnvironment(), timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
      return { tree: result.stdout.split('\0')[0].trim(), conflicts: [] };
    } catch (error: any) {
      if (error.code !== 1) throw new MurmError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Workspace Git merge failed', undefined, { cause: error });
      const fields = String(error.stdout).split('\0');
      const end = fields.indexOf('', 1);
      return { tree: fields[0].trim(), conflicts: fields.slice(1, end < 0 ? fields.length : end) };
    }
  }

  async applyTree(root: any, current: any, source: any) {
    let output, conflicted = false;
    try {
      output = (await execFile('git', ['-C', root, `--attr-source=${current}`, 'merge-tree', '--write-tree', '--messages', '-z', current, source],
        { env: gitEnvironment(), timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })).stdout;
    } catch (error: any) {
      if (error.code !== 1) throw new MurmError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Workspace apply planning failed', undefined, { cause: error });
      output = error.stdout;
      conflicted = true;
    }
    // Git's -z format separates tree, conflict stages, and typed messages.
    // Preserve stage objects and every involved path, including rename/delete
    // conflicts that cannot be reconstructed from marker text alone.
    const fields = String(output).split('\0');
    const tree = fields.shift()!.trim();
    if (!/^[a-f0-9]{40,64}$/.test(tree)) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Git apply result has no tree');
    const stages = [];
    while (fields[0]) {
      const line = fields.shift()!;
      const match = /^([0-7]{6}) ([a-f0-9]{40,64}) ([123])\t([\s\S]+)$/.exec(line);
      if (!match) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Git apply conflict stage is malformed');
      stages.push({ mode: match[1], object: match[2], stage: Number(match[3]), path: match[4] });
    }
    fields.shift();
    const messages = [];
    while (fields[0]) {
      const count = Number(fields.shift());
      if (!Number.isInteger(count) || count < 1 || count > 10_000 || fields.length < count + 2) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Git apply conflict message is malformed');
      const paths = fields.splice(0, count);
      const type = fields.shift(), message = fields.shift();
      messages.push({ paths, type, message });
    }
    return { tree, conflicted, stages, messages };
  }

  async isAncestor(root: any, ancestor: any, descendant: any) {
    try {
      await execFile('git', ['-C', root, 'merge-base', '--is-ancestor', ancestor, descendant], { env: gitEnvironment(), timeout: 30_000 });
      return true;
    } catch (error: any) {
      if (error.code === 1) return false;
      throw new MurmError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Workspace ancestry is unavailable', undefined, { cause: error });
    }
  }

  async readBlob(root: any, object: any) {
    if (!/^[a-f0-9]{40,64}$/.test(object)) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Invalid Git blob identity');
    return git(root, ['cat-file', 'blob', object], { encoding: 'buffer' });
  }

  commit(root: any, { kind, oldMain, newMain, record, revision, receipt = null }: any) {
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

  assertMain(root: any, expected: any) {
    let actual: any = null;
    try { actual = gitSync(root, ['rev-parse', '--verify', 'refs/heads/main']); } catch { /* Initial creation has no main ref. */ }
    if (actual !== expected) throw new MurmError('WORKSPACE_RECONCILIATION_REQUIRED', 'Workspace main and index disagree');
  }

  recover(root: any) {
    const path = join(root, JOURNAL);
    if (!existsSync(path)) return;
    const intent = JSON.parse(readFileSync(path, 'utf8'));
    if (![1, 2].includes(intent.version) || !intent.record || (!intent.revision && !['freeze', 'unfreeze', 'receipt'].includes(intent.kind))) throw new MurmError('WORKSPACE_RECONCILIATION_REQUIRED', 'Workspace intent is invalid');
    let observed: any = null;
    try { observed = gitSync(root, ['rev-parse', '--verify', 'refs/heads/main']); } catch { /* Initial creation may not have a ref yet. */ }
    if (observed !== intent.old_main && observed !== intent.new_main) throw new MurmError('WORKSPACE_RECONCILIATION_REQUIRED', 'Workspace main matches neither committed intent value');
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

  readReceipt(root: any, requestHash: any) {
    const path = join(root, '.swarm-requests', `${requestHash}.json`);
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  }

  writeReceipt(root: any, receipt: any) {
    const record = JSON.parse(readFileSync(join(root, META), 'utf8'));
    this.#commitRecord(root, 'receipt', record, receipt);
  }

  writeRecord(root: any, record: any, { kind }: any) {
    if (!['freeze', 'unfreeze'].includes(kind)) throw new TypeError('Unsupported Workspace metadata event');
    this.#commitRecord(root, kind, record);
  }

  #commitRecord(root: any, kind: any, record: any, receipt: any = null) {
    this.assertMain(root, record.main_commit);
    const intent = { version: 2, event_id: randomUUID(), kind, old_main: record.main_commit,
      new_main: record.main_commit, record, revision: null, receipt };
    writeWorkspaceJson(join(root, JOURNAL), intent);
    this.#finish(root, intent, false);
  }

  #retain(root: any, revision: any) {
    const ref = `refs/swarm/revisions/${revision.revision}`;
    let previous: any = null;
    try { previous = gitSync(root, ['rev-parse', '--verify', ref]); } catch { /* New revision. */ }
    if (previous && previous !== revision.git_commit) throw new MurmError('WORKSPACE_RECONCILIATION_REQUIRED', 'Immutable revision ref conflicts with commit intent');
    if (!previous) gitSync(root, ['update-ref', ref, revision.git_commit, ZERO]);
  }

  #finish(root: any, intent: any, injectFault: any = true) {
    if (intent.revision) writeWorkspaceJson(join(root, '.swarm-revisions', `${intent.revision.revision}.json`), intent.revision);
    writeWorkspaceJson(join(root, META), intent.record);
    if (injectFault) this.fault?.('after_index');
    if (intent.receipt) writeWorkspaceJson(join(root, '.swarm-requests', `${intent.receipt.key}.json`), intent.receipt);
    if (injectFault) this.fault?.('after_receipt');
    this.#recordHistory(root, intent, injectFault);
    unlinkSync(join(root, JOURNAL));
    syncDirectory(root);
  }

  #recordHistory(root: any, intent: any, injectFault: any) {
    const directory = join(root, WORKSPACE_HISTORY_DIR);
    const headPath = join(directory, 'head.json');
    let head = existsSync(headPath) ? JSON.parse(readFileSync(headPath, 'utf8')) : null;
    // If a process stopped after publishing an event but before its head, keep
    // that event. Event files are immutable and are never overwritten on retry.
    while (existsSync(join(directory, historyFile((head?.sequence ?? 0) + 1)))) {
      const next = JSON.parse(readFileSync(join(directory, historyFile((head?.sequence ?? 0) + 1)), 'utf8'));
      if (next.sequence !== (head?.sequence ?? 0) + 1 || next.previous_event_id !== (head?.event_id ?? null)) {
        throw new MurmError('REPLAY_HISTORY_INCOMPLETE', 'Workspace history head is inconsistent');
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

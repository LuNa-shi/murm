import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { ERROR_CODES, MurmError } from '../errors.js';
import { stableStringify } from '../protocol/envelope.js';
import { WorkspaceRepository } from './workspace-repository.js';

export const WORKSPACE_CONFLICT_HELP = Object.freeze({
  guidance: `Workspace apply has unresolved conflicts. The ordinary project tree contains Git's editable merge result.
The base/current/incoming files here preserve the exact alternatives, including binary, rename and deletion conflicts.
Resolve the intended ordinary project paths, remove this alternatives directory, then call swarm workspace save --resolved.
Resolution records your decision; it does not establish correctness or replace a required check.
`,
});

const META = '.swarm-workspace.json';
const REVISION_DIR = '.swarm-revisions';
const pendingRequests = new Map<any, any>();

const textHash = (value: any) => createHash('sha256').update(value).digest('hex');
const required = (value: any, name: any) => {
  if (typeof value !== 'string' || value.length === 0) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, `${name} is required`);
  return value;
};

function safePath(value: any) {
  required(value, 'path');
  if (isAbsolute(value) || value.includes('\0')) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'workspace path must be relative');
  const normalized = value.replaceAll('\\', '/');
  const segments = normalized.split('/');
  if (segments.some((part: any) => ['', '.', '..', '.git', '.pi', '.swarm', 'node_modules'].includes(part) || part.startsWith('.swarm-') || part === '.env' || part.startsWith('.env.'))) {
    throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'workspace path is outside the public project tree');
  }
  return normalized;
}

async function exists(path: any) {
  try { await stat(path); return true; } catch { return false; }
}


function revisionNumber(value: any) {
  if (!/^\d+\.\d+$/.test(String(value))) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'workspace revision must use major.minor form');
  return String(value);
}

function resolvedRevision(value: any, record: any) {
  if (value === undefined || value === null || value === 'main') return record.main_revision;
  return revisionNumber(value);
}

function publicPage({ kind, workspaceId, selectors, cursor = null, limit, maxLimit }: any) {
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
    throw new MurmError(ERROR_CODES.INVALID_CONTRACT, `Workspace page limit must be 1..${maxLimit}`);
  }
  let previous: any = null;
  const fingerprint = (revisions: any) => textHash(stableStringify({ kind, workspaceId, selectors, revisions }));
  if (cursor !== null) {
    try {
      if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{1,2048}$/.test(cursor)) throw new Error();
      previous = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (!Array.isArray(previous.revisions) || !previous.revisions.every((value: any) => typeof value === 'string' && /^\d+\.\d+$/.test(value)) ||
          previous.fingerprint !== fingerprint(previous.revisions) ||
          !Number.isSafeInteger(previous.offset) || previous.offset < 1) throw new Error();
    } catch {
      throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Workspace cursor does not match this query');
    }
  }
  return {
    limit, offset: previous?.offset ?? 0,
    resolve(record: any, ...requested: any[]) {
      if (!previous) return requested.map((value: any) => resolvedRevision(value, record));
      if (previous.revisions.length !== requested.length || requested.some((value: any, index: any) => value != null && value !== 'main' && value !== previous.revisions[index])) {
        throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Workspace cursor does not match the requested revision');
      }
      return previous.revisions;
    },
    next(revisions: any, offset: any) {
      return Buffer.from(JSON.stringify({ revisions, offset, fingerprint: fingerprint(revisions) })).toString('base64url');
    },
  };
}

function matchesPrefix(path: any, prefix: any) {
  return !prefix || path === prefix || path.startsWith(`${prefix}/`);
}

function nextRevision(value: any) {
  const [major, minor] = revisionNumber(value).split('.').map(Number);
  return `${major}.${minor + 1}`;
}

function fileEntries(files: any) {
  return Object.fromEntries(Object.entries(files).sort(([a]: any, [b]: any) => a.localeCompare(b)).map(([path, content]: any) => {
    const bytes = Buffer.byteLength(content);
    return [path, { content_hash: textHash(content), bytes }];
  }));
}

/**
 * Runtime-owned Mission Workspace repository.
 *
 * This module deliberately keeps Git and revision metadata outside an
 * Execution directory. Agents only receive materialized files and high-level
 * save and checked merge operations; they never receive a repository path or Git
 * credentials.
 */
export class MissionWorkspace {
  declare repository: any;
  declare clock: any;
  declare fault: any;
  declare rootDir: any;

  constructor({ rootDir, fault = null, clock = Date.now }: any) {
    this.repository = new WorkspaceRepository({ fault, clock });
    this.clock = () => new Date(clock()).toISOString();
    this.fault = fault;
    this.rootDir = resolve(required(rootDir, 'rootDir'));
  }

  workspacePath(workspaceId: any) {
    const id = required(workspaceId, 'workspace_id');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'workspace_id is not safe');
    return join(this.rootDir, id);
  }

  async create({ missionId, workspaceId = `workspace-${randomUUID()}`, initialFiles = {}, metadata = {} }: any) {
    required(missionId, 'mission_id');
    const root = this.workspacePath(workspaceId);
    return this.repository.locked(this.rootDir, async () => {
      for (const entry of await readdir(this.rootDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === workspaceId || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.name)) continue;
        const otherRoot = this.workspacePath(entry.name);
        if (!await exists(join(otherRoot, META)) && !this.repository.hasIntent(otherRoot)) continue;
        const owner = await this.repository.locked(otherRoot, async () => (await this.#read(otherRoot)).mission_id);
        if (owner === missionId) throw new MurmError(ERROR_CODES.CONFLICT, 'Mission already has a Workspace');
      }
      const target = await lstat(root).catch((error: any) => { if (error.code !== 'ENOENT') throw error; return null; });
      if (target && !target.isDirectory()) throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Workspace repository path must be a directory');
      return this.repository.locked(root, async () => {
        if (await exists(join(root, META))) {
          const existing = await this.#read(root);
          if (existing.mission_id !== missionId) throw new MurmError(ERROR_CODES.CONFLICT, 'Workspace belongs to another Mission');
          return this.#public(existing);
        }
        const files = this.#normalizeTree(initialFiles);
        await this.repository.initialize(root);
        const imported = await this.repository.importTree(root, files, [], 'Workspace revision 0.1');
        const revision = this.#revision('0.1', [], files, 'initial', imported);
        const record = { format_version: 2, workspace_id: workspaceId, mission_id: missionId, main_revision: '0.1', main_commit: imported.commit,
          next_revision: '0.2', revisions: ['0.1'], frozen_submission_id: null, metadata, created_at: this.clock(), updated_at: this.clock() };
        this.repository.commit(root, { kind: 'create', oldMain: null, newMain: imported.commit, record, revision });
        return this.#public(record);
      });
    });
  }

  async get({ signal = null, workspaceId }: any) {
    const root = this.workspacePath(workspaceId);
    return this.repository.locked(root, async () => this.#public(await this.#read(root)), { signal });
  }

  async publicChangeToken({ workspaceId }: any) {
    const root = this.workspacePath(workspaceId);
    return this.repository.locked(root, async () => {
      const record = await this.#read(root);
      return { workspace_id: workspaceId, next_revision: record.next_revision, main_revision: record.main_revision };
    });
  }

  async listRevisions({ workspaceId }: any) {
    const root = this.workspacePath(workspaceId);
    return this.repository.locked(root, async () => {
      const record = await this.#read(root);
      return Promise.all(record.revisions.map((revision: any) => this.#revisionMetadata(root, revision)));
    });
  }

  async history({ signal = null, workspaceId, all = false, sourceTask = null, sourceExecution = null, materialId = null, path = null, limit = 25, cursor = null }: any) {
    if (typeof all !== 'boolean' || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'History requires boolean all and limit 1..100');
    for (const value of [sourceTask, sourceExecution, materialId]) if (value !== null) required(value, 'history source filter');
    const prefix = path === null ? null : safePath(path);
    const filter = textHash(stableStringify({ workspaceId, all, sourceTask, sourceExecution, materialId, path: prefix }));
    let continuation: any = null;
    if (cursor !== null) {
      try { continuation = JSON.parse(Buffer.from(required(cursor, 'cursor'), 'base64url').toString('utf8')); } catch { throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Invalid history cursor'); }
      if (continuation?.filter !== filter || !Number.isInteger(continuation.offset) || continuation.offset < 0) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'History cursor does not match its filters');
    }
    const root = this.workspacePath(workspaceId);
    return this.repository.locked(root, async () => {
      const record = await this.#read(root);
      const asOf = continuation?.as_of_revision ?? record.revisions.at(-1);
      const main = continuation?.main_revision ?? record.main_revision;
      const end = record.revisions.indexOf(asOf);
      if (end < 0 || !record.revisions.slice(0, end + 1).includes(main)) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'History cursor references an unavailable snapshot');
      const revisions = record.revisions.slice(0, end + 1);
      const cache = new Map<any, any>();
      const metadata: any = async (revision: any) => {
        if (!cache.has(revision)) {
          if (cache.size >= 8) cache.delete(cache.keys().next().value);
          cache.set(revision, await this.#revisionMetadata(root, revision));
        }
        return cache.get(revision);
      };
      const reachable = new Set(), pending = [main];
      while (pending.length) {
        const revision = pending.pop();
        if (reachable.has(revision)) continue;
        reachable.add(revision);
        pending.push(...(await metadata(revision)).parents);
      }
      const offset = continuation?.offset ?? 0;
      const items: any[] = [];
      let matched = 0, more = false;
      for (const revision of [...revisions].reverse()) {
        if (!all && !reachable.has(revision)) continue;
        const item = await metadata(revision);
        if (sourceTask && item.source?.task_id !== sourceTask || sourceExecution && item.source?.execution_id !== sourceExecution) continue;
        if (materialId && !item.source?.material_uses?.some((use: any) => use.material_id === materialId)) continue;
        const before = item.parents.length ? (await metadata(item.parents[0])).files : {};
        const paths = this.#changed(before, item.files);
        if (prefix && !paths.some((changed: any) => changed === prefix || changed.startsWith(`${prefix}/`))) continue;
        if (matched++ < offset) continue;
        if (items.length === limit) { more = true; break; }
        items.push({ revision, parents: item.parents, source: item.source, created_at: item.created_at,
          git_commit: item.git_commit, content_hash: item.content_hash, reachable_from_main: reachable.has(revision), changed_paths: paths });
      }
      if (offset > matched) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'History cursor is outside the snapshot');
      return { workspace_id: workspaceId, main_revision: main, as_of_revision: asOf, all, items,
        next_cursor: more ? Buffer.from(JSON.stringify({ filter, main_revision: main, as_of_revision: asOf, offset: offset + items.length })).toString('base64url') : null };
    }, { signal });
  }

  async read({ signal = null, workspaceId, revision = undefined, path, maxBytes = 1_000_000 }: any) {
    const root = this.workspacePath(workspaceId);
    return this.repository.locked(root, async () => {
      const record = await this.#read(root);
      const selected = resolvedRevision(revision, record);
      const relativePath = safePath(path);
      const tree = await this.#tree(root, selected);
      if (!Object.hasOwn(tree, relativePath)) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'file is unavailable at requested revision');
      if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'max_bytes must be positive');
      const content = Buffer.from(tree[relativePath]);
      const binary = Buffer.isBuffer(tree[relativePath]);
      return { workspace_id: record.workspace_id, revision: selected, path: relativePath,
        content: content.subarray(0, maxBytes).toString(binary ? 'base64' : 'utf8'), encoding: binary ? 'base64' : 'utf8',
        content_hash: textHash(content), bytes: content.length, truncated: content.length > maxBytes };
    }, { signal });
  }

  async files({ signal = null, workspaceId, revision = undefined, prefix = '', limit = 100, cursor = null }: any) {
    const normalized = prefix ? safePath(prefix) : '';
    const page = publicPage({ kind: 'files', workspaceId, selectors: { prefix: normalized }, limit, cursor, maxLimit: 100 });
    const root = this.workspacePath(workspaceId);
    return this.repository.locked(root, async () => {
      const record = await this.#read(root);
      const revisions = page.resolve(record, revision);
      const [selected] = revisions;
      const files = await this.#snapshot(root, selected);
      const entries = new Map<any, any>();
      for (const path of Object.keys(files).sort()) {
        if (!matchesPrefix(path, normalized)) continue;
        entries.set(path, { path, type: 'file', ...files[path] });
        for (let slash = path.lastIndexOf('/'); slash !== -1; slash = path.lastIndexOf('/', slash - 1)) {
          const parent = path.slice(0, slash);
          if (!matchesPrefix(parent, normalized) || entries.has(parent)) break;
          entries.set(parent, { path: parent, type: 'directory', bytes: null });
        }
      }
      const sorted = [...entries.keys()].sort();
      const window = sorted.slice(page.offset, page.offset + page.limit).map((path: any) => entries.get(path));
      const end = page.offset + window.length;
      return { workspace_id: record.workspace_id, revision: selected, files: window,
        next_cursor: end < sorted.length ? page.next(revisions, end) : null };
    }, { signal });
  }

  async search({ signal = null, workspaceId, revision = undefined, query, prefix = '', maxResults = 100, cursor = null }: any) {
    required(query, 'query');
    if (query.length > 1024) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Workspace search query is too long');
    const normalized = prefix ? safePath(prefix) : '';
    const page = publicPage({ kind: 'search', workspaceId, selectors: { prefix: normalized, query }, limit: maxResults, cursor, maxLimit: 500 });
    const root = this.workspacePath(workspaceId);
    return this.repository.locked(root, async () => {
      const record = await this.#read(root);
      const revisions = page.resolve(record, revision);
      const [selected] = revisions;
      const tree = await this.#tree(root, selected);
      const matches: any[] = [];
      let binaryFiles = 0, offset = 0, more = false;
      const add = (hit: any) => {
        if (offset++ < page.offset) return;
        if (matches.length === page.limit) more = true;
        else matches.push(hit);
      };
      for (const path of Object.keys(tree).sort()) {
        if (!matchesPrefix(path, normalized)) continue;
        const content = tree[path];
        if (typeof content !== 'string') binaryFiles += 1;
        if (more) continue;
        if (path.includes(query)) add({ path, kind: 'path' });
        if (typeof content !== 'string') continue;
        for (const [index, line] of content.split(/\r?\n/).entries()) {
          const found = line.indexOf(query);
          if (found < 0) continue;
          const start = Math.max(0, found - 128);
          const end = Math.min(line.length, start + 2048);
          add({ path, kind: 'text', line: index + 1, text: line.slice(start, end), text_truncated: start > 0 || end < line.length });
          if (more) break;
        }
      }
      return { workspace_id: record.workspace_id, revision: selected, query, matches, truncated: more, binary_text_skipped: binaryFiles,
        next_cursor: more ? page.next(revisions, page.offset + matches.length) : null };
    }, { signal });
  }

  async diff({ signal = null, workspaceId, from, to, prefix = '', limit = 100, cursor = null }: any) {
    required(from, 'from');
    required(to, 'to');
    const normalized = prefix ? safePath(prefix) : '';
    const page = publicPage({ kind: 'diff', workspaceId, selectors: { prefix: normalized }, limit, cursor, maxLimit: 100 });
    const root = this.workspacePath(workspaceId);
    return this.repository.locked(root, async () => {
      const record = await this.#read(root);
      const revisions = page.resolve(record, from, to, 'main');
      const [fromRevision, toRevision, mainRevision] = revisions;
      const [before, after] = await Promise.all([fromRevision, toRevision].map((revision: any) => this.#revisionMetadata(root, revision)));
      const reachable = new Set(), pending = [mainRevision];
      while (pending.length && (!reachable.has(fromRevision) || !reachable.has(toRevision))) {
        const revision = pending.pop();
        if (reachable.has(revision)) continue;
        reachable.add(revision);
        const metadata: any = revision === before.revision ? before : revision === after.revision ? after : await this.#revisionMetadata(root, revision);
        pending.push(...metadata.parents);
      }
      const info = ({ revision, git_commit, source }: any) => ({ revision, git_commit, source, reachable_from_main: reachable.has(revision) });
      const paths = this.#changed(before.files, after.files).filter((path: any) => matchesPrefix(path, normalized));
      const changes = paths.slice(page.offset, page.offset + page.limit).map((path: any) => ({
        path, change: !Object.hasOwn(before.files, path) ? 'added' : !Object.hasOwn(after.files, path) ? 'deleted' : 'modified',
        before: Object.hasOwn(before.files, path) ? before.files[path] : null,
        after: Object.hasOwn(after.files, path) ? after.files[path] : null,
      }));
      const end = page.offset + changes.length;
      return { workspace_id: record.workspace_id, main_revision: mainRevision, from: info(before), to: info(after), changes,
        next_cursor: end < paths.length ? page.next(revisions, end) : null };
    }, { signal });
  }

  async apply({ workspaceId, revision = undefined, targetDir }: any) {
    return this.materialize({ workspaceId, revision, targetDir });
  }

  async freeze({ workspaceId, submissionId, expectedMainRevision = undefined, coordinate = null }: any) {
    required(submissionId, 'submission_id');
    const root = this.workspacePath(workspaceId);
    return this.repository.locked(root, async () => {
      const record = await this.#read(root);
      if (expectedMainRevision !== undefined && resolvedRevision(expectedMainRevision, record) !== record.main_revision) throw new MurmError('MAIN_MOVED', 'main revision changed before Mission submission');
      const next = { ...record, frozen_submission_id: submissionId,
        freeze_epoch: (record.freeze_epoch ?? 0) + (record.frozen_submission_id ? 0 : 1), updated_at: this.clock() };
      const publish = () => {
        if (record.frozen_submission_id && record.frozen_submission_id !== submissionId) {
          throw new MurmError(ERROR_CODES.CONFLICT, 'Workspace main is frozen by another Mission submission');
        }
        this.repository.writeRecord(root, next, { kind: 'freeze' });
      };
      if (coordinate) {
        const result = coordinate({ previous: this.#public(record), frozen: this.#public(next), publish });
        if (result?.then) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Workspace freeze coordination must be synchronous');
        return result;
      }
      publish();
      return this.#public(next);
    });
  }

  async withSubmissionFreeze({ workspaceId, inspect }: any) {
    const root = this.workspacePath(workspaceId);
    return this.repository.locked(root, async () => {
      const record = await this.#read(root);
      const result = inspect(this.#public(record));
      if (result?.then) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Workspace freeze inspection must be synchronous');
      return result;
    });
  }

  async unfreeze({ workspaceId, submissionId }: any) {
    required(submissionId, 'submission_id');
    const root = this.workspacePath(workspaceId);
    return this.repository.locked(root, async () => {
      const record = await this.#read(root);
      if (record.frozen_submission_id && record.frozen_submission_id !== submissionId) throw new MurmError(ERROR_CODES.FENCED, 'Workspace freeze belongs to another Mission submission');
      record.frozen_submission_id = null;
      record.updated_at = this.clock();
      this.repository.writeRecord(root, record, { kind: 'unfreeze' });
      return this.#public(record);
    });
  }

  async save(options: any) {
    const normalized = { ...options, requestId: options.requestId ?? randomUUID() };
    const { workspaceId, baseRevision, parentRevisions = null, source = 'execution', requestId, conflicts = [] } = normalized;
    const tree = this.#normalizeTree(normalized.files);
    normalized.files = tree;
    const request: any = this.#request(requestId, { operation: 'save', workspaceId, baseRevision, parentRevisions, files: fileEntries(tree), source, ...(conflicts.length ? { conflicts } : {}) });
    return this.#runRequest(this.workspacePath(workspaceId), request, () => this.#save(normalized));
  }

  // Reconcile an already-published save without granting permission to create
  // one. In particular, an E may have closed since Git committed its receipt.
  async replaySave(options: any) {
    const { workspaceId, baseRevision, parentRevisions = null, source = 'execution', requestId, conflicts = [] } = options;
    const tree = this.#normalizeTree(options.files);
    const request: any = this.#request(required(requestId, 'request_id'), { operation: 'save', workspaceId, baseRevision, parentRevisions, files: fileEntries(tree), source, ...(conflicts.length ? { conflicts } : {}) });
    const root = this.workspacePath(workspaceId);
    return this.repository.locked(root, () => this.#replay(root, request));
  }

  async merge(options: any) {
    const normalized = { ...options, requestId: options.requestId ?? randomUUID() };
    const { workspaceId, fromRevision, expectedMainRevision, requestId, source = null, checkPolicy = null } = normalized;
    const request: any = this.#request(requestId, { operation: 'merge', workspaceId, fromRevision, expectedMainRevision,
      ...(source ? { source, checkPolicy } : {}) });
    request.owner_id = randomUUID();
    return this.#runRequest(this.workspacePath(workspaceId), request, () => this.#merge(normalized, request));
  }

  #runRequest(root: any, request: any, run: any) {
    const key = `${root}:${request.key}`;
    const existing = pendingRequests.get(key);
    if (existing) {
      if (existing.fingerprint !== request.fingerprint) return Promise.reject(new MurmError(ERROR_CODES.CONFLICT, 'Workspace request ID has different pending input'));
      return existing.promise;
    }
    const promise = this.repository.requestLocked(root, request.key, async () => {
      try { return await run(); }
      catch (error: any) {
        let reported = error;
        if (!this.repository.hasIntent(root)) {
          try {
            await this.repository.locked(root, async () => {
              const stored = this.repository.readReceipt(root, request.key);
              const checking = stored?.phase === 'checking' && stored.owner_id === request.owner_id;
              const definitive = ['CONFLICT', 'MAIN_MOVED', 'MISSION_SUBMITTING', 'NOT_ALLOWED', 'INVALID_CONTRACT', 'SERVICE_NOT_READY', 'SERVICE_TIMEOUT', 'WORKSPACE_BUSY'].includes(error.code);
              if ((!stored && definitive) || checking) {
                const outcome = definitive ? { code: error.code, message: error.message, details: error.details, retryable: error.retryable }
                  : { code: 'WORKSPACE_REQUEST_ABORTED', message: 'Workspace attempt stopped without a committed result; use a new attempt ID', details: { cause_code: error.code ?? 'INTERNAL_ERROR' }, retryable: false };
                this.repository.writeReceipt(root, { ...request, error: outcome });
                reported = new MurmError(outcome.code, outcome.message, outcome.details, { retryable: outcome.retryable, cause: error });
              }
            });
          } catch (persistenceError: any) {
            throw new MurmError('WORKSPACE_RESULT_UNKNOWN', 'Workspace result is not yet available; query or retry the original request ID', undefined, { retryable: true, cause: persistenceError });
          }
        }
        if (this.repository.hasIntent(root)) throw new MurmError('WORKSPACE_RESULT_UNKNOWN', 'Workspace result is not yet available; query or retry the original request ID', undefined, { retryable: true, cause: error });
        throw reported;
      }

    }).finally(() => { if (pendingRequests.get(key)?.promise === promise) pendingRequests.delete(key); });
    pendingRequests.set(key, { fingerprint: request.fingerprint, promise });
    return promise;
  }

  async #save({ workspaceId, baseRevision, parentRevisions = null, files, source = 'execution', conflicts = [], requestId = randomUUID(), guard = null, withPublication = (publish: any) => publish() }: any) {
    const root = this.workspacePath(workspaceId);
    const tree = this.#normalizeTree(files);
    if (!Array.isArray(conflicts)) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Workspace conflicts must be an array');
    const request: any = this.#request(requestId, { operation: 'save', workspaceId, baseRevision, parentRevisions, files: fileEntries(tree), source, ...(conflicts.length ? { conflicts } : {}) });
    return this.repository.locked(root, async () => {
      const replay = this.#replay(root, request);
      if (replay) return replay;
      const record = await this.#read(root);
      const base = revisionNumber(baseRevision ?? record.main_revision);
      const parents = parentRevisions ?? [base];
      if (!Array.isArray(parents) || parents.length === 0 || !parents.includes(base) || new Set(parents).size !== parents.length) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'save parents must include its actual base exactly once');
      const parentMetadata = await Promise.all(parents.map((parent: any) => this.#revisionMetadata(root, parent)));
      const before = await this.#snapshot(root, base);
      const revision = record.next_revision;
      const imported = await this.repository.importTree(root, tree, parentMetadata.map((parent: any) => parent.git_commit), `Workspace revision ${revision}`);
      const metadata: any = this.#revision(revision, parents, tree, source, imported, requestId, conflicts);
      const result = { workspace_id: workspaceId, revision, base_revision: base, parents, git_commit: imported.commit,
        files: metadata.files, changed_files: this.#changed(before, metadata.files), content_hash: metadata.content_hash, git_tree: imported.tree, source, conflicts };
      record.revisions.push(revision); record.next_revision = nextRevision(revision); record.updated_at = this.clock();
      const published = withPublication(() => {
        this.#guard(guard);
        this.repository.commit(root, { kind: 'save', oldMain: record.main_commit, newMain: record.main_commit, record, revision: metadata, receipt: { ...request, result } });
      });
      if (published?.then) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Workspace publication must be synchronous');
      return result;
    });
  }

  async #merge({ workspaceId, fromRevision, expectedMainRevision, checker = null, requestId = randomUUID(), guard = null,
    source: contributionSource = 'merge', withPublication = (publish: any) => publish() }: any, request: any) {
    const root = this.workspacePath(workspaceId);
    const plan = await this.repository.locked(root, async () => {
      const replay = this.#replay(root, request);
      if (replay) return { replay };
      const record = await this.#read(root);
      this.#assertMergeAllowed(record, guard);
      const expected = resolvedRevision(expectedMainRevision, record);
      if (expected !== record.main_revision) throw new MurmError('MAIN_MOVED', 'main revision changed', { expected: record.main_revision, received: expected });
      const source = await this.#revisionMetadata(root, revisionNumber(fromRevision));
      if (source.conflicts?.length) throw new MurmError(ERROR_CODES.CONFLICT, 'Saved revision has unresolved Workspace conflicts', { conflicts: source.conflicts });
      this.repository.writeReceipt(root, { ...request, phase: 'checking', pinned_main_revision: record.main_revision, pinned_main_commit: record.main_commit, source_revision: source.revision });
      return { record, source };
    });
    if (plan.replay) return plan.replay;
    const { record: pinned, source } = plan;
    const merged = await this.repository.mergeTrees(root, pinned.main_commit, source.git_commit);
    if (merged.conflicts?.length) throw new MurmError(ERROR_CODES.CONFLICT, 'Workspace merge has unresolved file conflicts', { base_revision: pinned.main_revision, source_revision: source.revision, conflicts: merged.conflicts });
    const files = merged.alreadyIncluded ? null : this.#normalizeTree(await this.repository.readTree(root, merged.tree));
    let check: any = null;
    if (!merged.alreadyIncluded && typeof checker === 'function') {
      check = await checker({ workspaceId, revision: source.revision, mainRevision: pinned.main_revision, tree: merged.tree, files: Object.fromEntries(Object.entries(files).map(([path, content]: any) => [path, Buffer.isBuffer(content) ? Buffer.from(content) : content])) });
      if (check !== true && check?.verdict !== 'PASS') throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'final Workspace tree check failed', {
        workspace_id: workspaceId, main_revision: pinned.main_revision, source_revision: source.revision, checked_tree: merged.tree, check,
      });
    }
    return this.repository.locked(root, async () => {
      const replay = this.#replay(root, request);
      if (replay) return replay;
      const record = await this.#read(root);
      this.#assertMergeAllowed(record, guard);
      if ((record.freeze_epoch ?? 0) !== (pinned.freeze_epoch ?? 0)) throw new MurmError('MISSION_SUBMITTING', 'Mission submission invalidated this merge attempt; retry with a new request ID');
      if (record.main_revision !== pinned.main_revision || record.main_commit !== pinned.main_commit) throw new MurmError('MAIN_MOVED', 'main changed while the merge was being checked', {
        observed_revision: pinned.main_revision, actual_revision: record.main_revision, source_revision: source.revision,
      });
      if (merged.alreadyIncluded) {
        const result = { ...this.#public(record), already_included: true, merged_from: source.revision };
        const published = withPublication(() => {
          this.#assertMergeAllowed(record, guard);
          this.repository.writeReceipt(root, { ...request, result });
        });
        if (published?.then) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Workspace publication must be synchronous');
        return result;
      }
      const revision = record.next_revision;
      const parents = [pinned.main_revision, source.revision];
      const commit = await this.repository.commitTree(root, merged.tree, [pinned.main_commit, source.git_commit], `Merge Workspace revision ${source.revision}`);
      const mergeSource = contributionSource && source.source?.material_uses?.length
        ? { ...contributionSource, material_uses: source.source.material_uses }
        : contributionSource;
      const metadata: any = this.#revision(revision, parents, files, mergeSource, { commit, tree: merged.tree }, requestId);
      metadata.check = check === true ? { verdict: 'PASS', tree: merged.tree } : check;
      const before = await this.#snapshot(root, pinned.main_revision);
      record.revisions.push(revision); record.main_revision = revision; record.main_commit = commit; record.next_revision = nextRevision(revision); record.updated_at = this.clock();
      const result = { ...this.#public(record), merged_from: source.revision, parents, changed_files: this.#changed(before, metadata.files), source_commit: source.git_commit, check: metadata.check };
      const published = withPublication(() => {
        this.#assertMergeAllowed(record, guard);
        this.repository.commit(root, { kind: 'merge', oldMain: pinned.main_commit, newMain: commit, record, revision: metadata, receipt: { ...request, result } });
      });
      if (published?.then) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Workspace publication must be synchronous');
      return result;
    });
  }

  // Trusted Runtime export: resolve main once and read all bytes under the
  // recovery barrier. This is not a model-supplied tree or a host-path API.
  async exportRevision({ workspaceId, revision = 'main', signal = null }: any) {
    const root = this.workspacePath(workspaceId);
    return this.repository.locked(root, async () => {
      const record = await this.#read(root);
      const selected = resolvedRevision(revision, record);
      const metadata: any = await this.#revisionMetadata(root, selected);
      return { workspace_id: workspaceId, mission_id: record.mission_id, revision: selected,
        git_commit: metadata.git_commit, git_tree: metadata.git_tree, content_hash: metadata.content_hash,
        manifest: metadata.files, conflicts: metadata.conflicts ?? [], files: await this.#tree(root, selected) };
    }, { signal });
  }

  async planApply({ workspaceId, baseRevision, fromRevision, requestId }: any) {
    required(requestId, 'request_id');
    const root = this.workspacePath(workspaceId);
    return this.repository.locked(root, async () => {
      const record = await this.#read(root);
      const base = await this.#revisionMetadata(root, revisionNumber(baseRevision));
      const source = await this.#revisionMetadata(root, resolvedRevision(fromRevision, record));
      const alreadyIncluded = await this.repository.isAncestor(root, source.git_commit, base.git_commit);
      const merged = alreadyIncluded ? { tree: base.git_tree, conflicted: false, stages: [], messages: [] }
        : await this.repository.applyTree(root, base.git_commit, source.git_commit);
      const files = this.#normalizeTree(await this.repository.readTree(root, merged.tree));
      const conflicts = [...(base.conflicts ?? []), ...(alreadyIncluded ? [] : source.conflicts ?? [])];
      if (merged.conflicted) {
        const id = textHash(stableStringify({ workspaceId, requestId, base: base.revision, source: source.revision })).slice(0, 24);
        const stem = `workspace-conflicts-${id}`;
        let artifacts = stem, suffix = 0;
        const collides = (prefix: any) => Object.keys(files).some(path => path === prefix || path.startsWith(`${prefix}/`) || prefix.startsWith(`${path}/`));
        while (collides(artifacts)) artifacts = `${stem}-${++suffix}`;
        const stages: any[] = [];
        for (const entry of merged.stages) {
          if (!['100644', '100755'].includes(entry.mode)) throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Apply conflict contains a non-regular file');
          const path = safePath(entry.path);
          const artifact = `${artifacts}/${({ 1: 'base', 2: 'current', 3: 'incoming' } as Record<number, string>)[entry.stage]}/${path}`;
          files[artifact] = await this.repository.readBlob(root, entry.object);
          stages.push({ ...entry, path, artifact_path: artifact });
        }
        const paths = [...new Set([...stages.map((stage: any) => stage.path), ...merged.messages.flatMap((message: any) => message.paths)])].sort();
        const markerLines = [];
        for (const path of paths) {
          if (files[path] === undefined) continue;
          const lines = Buffer.from(files[path]).toString('utf8').split('\n');
          const generated = new Map();
          let width = 0;
          for (const line of lines) {
            const opening = /^(<+) /.exec(line);
            if (opening && line.includes(base.git_commit)) width = opening[1].length;
            if (!width) continue;
            const closing = line.startsWith('>'.repeat(width) + ' ') && line.includes(source.git_commit);
            if (opening || closing || line === '='.repeat(width) || line.startsWith('|'.repeat(width) + ' ')) generated.set(line, (generated.get(line) ?? 0) + 1);
            if (closing) width = 0;
          }
          const alternatives = stages.filter((stage: any) => stage.path === path).map((stage: any) => Buffer.from(files[stage.artifact_path]).toString('utf8').split('\n'));
          for (const [line, count] of generated) markerLines.push({ path, line,
            allowed_count: Math.max(lines.filter((value: any) => value === line).length - count, ...alternatives.map((values: any) => values.filter((value: any) => value === line).length)) });
        }
        files[`${artifacts}/README.txt`] = WORKSPACE_CONFLICT_HELP.guidance;
        conflicts.push({ conflict_id: id, kind: 'git-merge', base_revision: base.revision, source_revision: source.revision,
          paths, stages, messages: merged.messages, artifact_root: artifacts, marker_labels: [base.git_commit, source.git_commit],
          marker_lines: markerLines });
      }
      const complete = this.#normalizeTree(files);
      const manifest = fileEntries(complete);
      return { workspace_id: workspaceId, base_revision: base.revision, source_revision: source.revision, already_included: alreadyIncluded,
        parents: alreadyIncluded ? [base.revision] : [...new Set([base.revision, source.revision])],
        expected_content_hash: base.content_hash, content_hash: textHash(stableStringify(manifest)), manifest, files: complete,
        changed_paths: this.#changed(base.files, manifest), conflicts: [...new Map(conflicts.map(conflict => [conflict.conflict_id, conflict])).values()] };
    });
  }


  async materialize({ workspaceId, revision = undefined, targetDir }: any) {
    required(targetDir, 'target_dir');
    const root = this.workspacePath(workspaceId);
    const snapshot = await this.repository.locked(root, async () => {
      const record = await this.#read(root);
      const selected = resolvedRevision(revision, record);
      return { selected, tree: await this.#tree(root, selected) };
    });
    const target = resolve(targetDir);
    const lexicalOffset = relative(root, target);
    if (lexicalOffset !== '..' && !lexicalOffset.startsWith(`..${sep}`)) throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'execution directory must be separate from repository');
    await this.#assertNoSymlinkDirectories(target);
    await mkdir(target, { recursive: true });
    const actualRoot = await realpath(root);
    const actualTarget = await realpath(target);
    const offset = relative(actualRoot, actualTarget);
    if (offset !== '..' && !offset.startsWith(`..${sep}`)) throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'execution directory must be separate from repository');
    return this.repository.requestLocked(dirname(actualTarget), `materialize-${textHash(actualTarget)}`, async () => {
      await this.#assertNoSymlinkDirectories(actualTarget);
      if ((await readdir(actualTarget)).length) throw new MurmError('WORKSPACE_BUSY', 'Initial materialization requires an empty project directory');
      const stage = await mkdtemp(join(dirname(actualTarget), '.swarm-materialize-'));
      try {
        await this.#materialize(stage, snapshot.tree);
        await this.#assertNoSymlinkDirectories(actualTarget);
        if ((await readdir(actualTarget)).length) throw new MurmError('WORKSPACE_BUSY', 'Project changed during initial materialization');
        // Directory rename publishes the whole tree or fails; a concurrent
        // writer making the destination nonempty cannot be overwritten.
        await rename(stage, actualTarget);
      } finally { await rm(stage, { recursive: true, force: true }); }
      return { workspace_id: workspaceId, revision: snapshot.selected, target_dir: target, files: fileEntries(snapshot.tree) };
    });
  }

  async #read(root: any) {
    let record;
    try { record = JSON.parse(await readFile(join(root, META), 'utf8')); }
    catch (error: any) { throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'unknown Workspace', undefined, { cause: error }); }
    this.repository.assertMain(root, record.main_commit);
    return record;
  }
  // Caller holds the Task lifecycle writer lock also used by Git publication.
  readDeliveryRevision({ workspaceId, missionId, revision }: any) {
    const root = this.workspacePath(workspaceId);
    const selected = revisionNumber(revision);
    if (this.repository.hasIntent(root)) {
      throw new MurmError(ERROR_CODES.WORKSPACE_BUSY, 'Workspace publication is pending reconciliation', undefined, { retryable: true });
    }
    const record = JSON.parse(readFileSync(join(root, META), 'utf8'));
    if (record.mission_id !== missionId || !record.revisions.includes(selected)) return null;
    this.repository.assertMain(root, record.main_commit);
    return JSON.parse(readFileSync(join(root, REVISION_DIR, `${selected}.json`), 'utf8'));
  }

  async #revisionMetadata(root: any, revision: any) {
    revisionNumber(revision);
    const record = await this.#read(root);
    if (!record.revisions.includes(revision)) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Workspace revision is not published');
    return JSON.parse(await readFile(join(root, REVISION_DIR, `${revision}.json`), 'utf8'));
  }
  async #snapshot(root: any, revision: any) { return (await this.#revisionMetadata(root, revision)).files; }
  async #tree(root: any, revision: any) {
    const metadata: any = await this.#revisionMetadata(root, revision);
    return this.repository.readTree(root, metadata.git_tree);
  }
  #normalizeTree(files: any) {
    if (!files || typeof files !== 'object' || Array.isArray(files)) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'save requires a complete file tree');
    const tree = Object.create(null);
    let total = 0;
    for (const [path, content] of Object.entries(files)) {
      const normalized = safePath(path);
      if (Object.hasOwn(tree, normalized)) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Workspace paths collide after normalization');
      if (typeof content !== 'string' && !Buffer.isBuffer(content)) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Workspace files must contain actual bytes');
      const bytes = Buffer.byteLength(content);
      total += bytes;
      if (bytes > 2 * 1024 * 1024 || total > 16 * 1024 * 1024) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Workspace exceeds its file or tree byte bound');
      tree[normalized] = Buffer.isBuffer(content) ? Buffer.from(content) : content;
    }
    return tree;
  }
  #revision(revision: any, parents: any, tree: any, source: any, imported: any, requestId: any = null, conflicts: any = []) {
    const files = fileEntries(tree);
    return { revision, parents, git_commit: imported.commit, git_tree: imported.tree, files, content_hash: textHash(stableStringify(files)), source, conflicts, request_id: requestId, created_at: this.clock() };
  }
  #request(id: any, payload: any) { required(id, 'request_id'); return { request_id: id, key: textHash(id), fingerprint: textHash(stableStringify(payload)) }; }
  #replay(root: any, request: any) {
    const stored = this.repository.readReceipt(root, request.key);
    if (!stored) return null;
    if (stored.fingerprint !== request.fingerprint) throw new MurmError(ERROR_CODES.CONFLICT, 'Workspace request ID has different input');
    if (stored.phase === 'checking') {
      if (stored.owner_id === request.owner_id) return null;
      // This caller owns the per-request OS lock. A different saved owner
      // therefore lost its process before publishing a result; do not charge
      // another checker or silently select a newer main for the old ID.
      const error = { code: 'WORKSPACE_REQUEST_ABORTED', message: 'Previous Workspace attempt lost its result; use a new attempt ID' };
      this.repository.writeReceipt(root, { ...request, error });
      throw new MurmError(error.code, error.message);
    }
    if (stored.error) throw new MurmError(stored.error.code, stored.error.message, stored.error.details, { retryable: stored.error.retryable });
    return stored.result;
  }
  #guard(guard: any) {
    if (!guard) return;
    const allowed = guard();
    if (allowed === false || allowed?.then) throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Workspace final authorization must be synchronous and current');
  }
  #assertMergeAllowed(record: any, guard: any) {
    if (record.frozen_submission_id) throw new MurmError('MISSION_SUBMITTING', 'Workspace main is frozen for Mission submission');
    this.#guard(guard);
  }

  async #assertNoSymlinkDirectories(target: any) {
    const absolute = resolve(target);
    const base = parse(absolute).root;
    let current = base;
    for (const part of relative(base, absolute).split(sep).filter(Boolean)) {
      current = join(current, part);
      try {
        const entry = await lstat(current);
        if (entry.isSymbolicLink() || !entry.isDirectory()) throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Project directory cannot traverse a symlink or non-directory');
      } catch (error: any) { if (error.code === 'ENOENT') return; throw error; }
    }
  }
  async #materialize(root: any, tree: any) {
    for (const [path, content] of Object.entries(tree)) {
      const target = join(root, safePath(path));
      await this.#assertNoSymlinkDirectories(dirname(target));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content as string | Uint8Array, { flag: 'wx' });
      await this.fault?.('materialize_file');
    }
  }

  #changed(before: any, after: any) { return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((path: any) => Object.hasOwn(before, path) !== Object.hasOwn(after, path) || before[path]?.content_hash !== after[path]?.content_hash || before[path]?.bytes !== after[path]?.bytes).sort(); }
  #public(record: any) { const { repository: _privateRepository, ...result } = record; return { ...result, revisions: [...record.revisions] }; }
}

export function candidateFileRef({ workspaceId, revision, path }: any) { return { workspace_id: required(workspaceId, 'workspace_id'), revision: revisionNumber(revision), path: safePath(path) }; }

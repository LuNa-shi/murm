import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { ERROR_CODES, SwarmEnvError } from '../errors.js';

const execFile = promisify(nodeExecFile);
const META = '.swarm-workspace.json';
const REVISION_DIR = '.swarm-revisions';

const textHash = (value) => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const required = (value, name) => {
  if (typeof value !== 'string' || value.length === 0) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `${name} is required`);
  return value;
};

function safePath(value) {
  required(value, 'path');
  if (isAbsolute(value) || value.includes('\0')) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'workspace path must be relative');
  const normalized = value.replaceAll('\\', '/');
  if (normalized.split('/').includes('..') || normalized === '' || normalized.startsWith('.swarm-')) {
    throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'workspace path is outside the public project tree');
  }
  return normalized;
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

async function git(repo, args) {
  try {
    const result = await execFile('git', ['-C', repo, ...args], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    return String(result.stdout ?? '').trim();
  } catch (error) {
    throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, `Workspace Git operation failed: ${error.message}`, { args }, { cause: error });
  }
}

function revisionNumber(value) {
  if (!/^\d+\.\d+$/.test(String(value))) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'workspace revision must use major.minor form');
  return String(value);
}

function nextRevision(value) {
  const [major, minor] = revisionNumber(value).split('.').map(Number);
  return `${major}.${minor + 1}`;
}

function fileEntries(files) {
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([path, content]) => {
    const bytes = Buffer.byteLength(String(content));
    return [path, { content_hash: textHash(String(content)), bytes }];
  }));
}

/**
 * Runtime-owned Mission Workspace repository.
 *
 * This module deliberately keeps Git and revision metadata outside an
 * Execution directory. Bots only receive materialized files and high-level
 * save/apply/merge operations; they never receive a repository path or Git
 * credentials. The older WorkspaceManager remains available for compatibility
 * with execution-local records while new callers should use this class.
 */
export class MissionWorkspace {
  constructor({ rootDir }) {
    this.rootDir = resolve(required(rootDir, 'rootDir'));
  }

  workspacePath(workspaceId) {
    const id = required(workspaceId, 'workspace_id');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'workspace_id is not safe');
    return join(this.rootDir, id);
  }

  async create({ missionId, workspaceId = `workspace-${randomUUID()}`, initialFiles = {}, metadata = {} }) {
    required(missionId, 'mission_id');
    const root = this.workspacePath(workspaceId);
    const metaPath = join(root, META);
    if (await exists(metaPath)) return this.#read(root);
    await mkdir(root, { recursive: true });
    await mkdir(join(root, REVISION_DIR, '0.1'), { recursive: true });
    const files = {};
    for (const [inputPath, content] of Object.entries(initialFiles)) {
      const path = safePath(inputPath);
      if (typeof content !== 'string' && !Buffer.isBuffer(content)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `file ${path} must be text`);
      files[path] = Buffer.isBuffer(content) ? content.toString('utf8') : content;
    }
    await this.#writeSnapshot(root, '0.1', files);
    await writeFile(join(root, '.gitignore'), `${META}\n${REVISION_DIR}/\n`);
    await execFile('git', ['init', '--initial-branch=main', root], { timeout: 30_000 });
    await this.#materialize(root, files);
    await git(root, ['add', '-A']);
    await execFile('git', ['-C', root, '-c', 'user.name=SwarmEnv Runtime', '-c', 'user.email=runtime@swarmenv.invalid', 'commit', '--allow-empty', '-m', 'Workspace revision 0.1'], { timeout: 30_000 });
    const commit = await git(root, ['rev-parse', 'HEAD']);
    const revision = { revision: '0.1', git_commit: commit, parents: [], files: fileEntries(files), content_hash: textHash(JSON.stringify(fileEntries(files))), created_at: now(), source: 'initial' };
    await writeFile(join(root, REVISION_DIR, '0.1.json'), JSON.stringify(revision, null, 2));
    const record = { workspace_id: workspaceId, mission_id: missionId, repository: root, main_revision: '0.1', main_commit: commit, next_revision: '0.2', revisions: ['0.1'], metadata, created_at: now(), updated_at: now() };
    await this.#write(root, record);
    return this.#public(record);
  }

  async get({ workspaceId }) { return this.#public(await this.#read(this.workspacePath(workspaceId))); }

  async listRevisions({ workspaceId }) {
    const root = this.workspacePath(workspaceId);
    const record = await this.#read(root);
    const revisions = [];
    for (const revision of record.revisions) revisions.push(JSON.parse(await readFile(join(root, REVISION_DIR, `${revision}.json`), 'utf8')));
    return revisions;
  }

  async read({ workspaceId, revision = undefined, path, maxBytes = 1_000_000 }) {
    const root = this.workspacePath(workspaceId);
    const record = await this.#read(root);
    const selected = revision ?? record.main_revision;
    const snapshot = await this.#snapshot(root, selected);
    const relativePath = safePath(path);
    if (!snapshot[relativePath]) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'file is unavailable at requested revision');
    const content = await readFile(join(root, REVISION_DIR, selected, 'files', relativePath));
    if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'max_bytes must be positive');
    return { workspace_id: record.workspace_id, revision: selected, path: relativePath, content: content.subarray(0, maxBytes).toString(), content_hash: snapshot[relativePath].content_hash, bytes: content.byteLength, truncated: content.byteLength > maxBytes };
  }

  async files({ workspaceId, revision = undefined, prefix = '' }) {
    const root = this.workspacePath(workspaceId);
    const record = await this.#read(root);
    const selected = revision ?? record.main_revision;
    const files = await this.#snapshot(root, selected);
    const normalized = prefix ? safePath(prefix) : '';
    return { workspace_id: record.workspace_id, revision: selected, files: Object.entries(files).filter(([path]) => !normalized || path === normalized || path.startsWith(`${normalized}/`)).map(([path, entry]) => ({ path, ...entry })) };
  }

  async search({ workspaceId, revision = undefined, query, prefix = '', maxResults = 100 }) {
    required(query, 'query');
    const listing = await this.files({ workspaceId, revision, prefix });
    const matches = [];
    for (const file of listing.files) {
      const result = await this.read({ workspaceId, revision: listing.revision, path: file.path, maxBytes: 10_000_000 });
      for (const [index, line] of result.content.split(/\r?\n/).entries()) if (line.includes(query)) { matches.push({ path: file.path, line: index + 1, text: line }); if (matches.length >= maxResults) break; }
      if (matches.length >= maxResults) break;
    }
    return { ...listing, query, matches, truncated: matches.length >= maxResults };
  }

  async save({ workspaceId, baseRevision, files, source = 'execution' }) {
    const root = this.workspacePath(workspaceId);
    const record = await this.#read(root);
    const base = revisionNumber(baseRevision ?? record.main_revision);
    const parent = await this.#snapshot(root, base);
    if (!files || typeof files !== 'object' || Array.isArray(files)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'save requires a complete file tree');
    const tree = {};
    for (const [inputPath, content] of Object.entries(files)) { const path = safePath(inputPath); if (typeof content !== 'string' && !Buffer.isBuffer(content)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `file ${path} must be text`); tree[path] = Buffer.isBuffer(content) ? content.toString() : content; }
    const revision = nextRevision(record.revisions.at(-1));
    await this.#writeSnapshot(root, revision, tree);
    await this.#writeRevision(root, revision, { parents: [base], tree, source });
    record.revisions.push(revision); record.next_revision = nextRevision(revision); record.updated_at = now();
    await this.#write(root, record);
    return { workspace_id: record.workspace_id, revision, base_revision: base, parents: [base], files: fileEntries(tree), changed_files: this.#changed(parent, tree) };
  }

  async merge({ workspaceId, fromRevision, expectedMainRevision, checker = null }) {
    const root = this.workspacePath(workspaceId);
    const record = await this.#read(root);
    const expected = revisionNumber(expectedMainRevision ?? record.main_revision);
    if (expected !== record.main_revision) throw new SwarmEnvError(ERROR_CODES.STALE_VERSION, 'main revision changed', { expected: record.main_revision, received: expected });
    const sourceRevision = revisionNumber(fromRevision);
    const oldMain = record.main_revision;
    const source = await this.#tree(root, sourceRevision);
    const sourceMeta = JSON.parse(await readFile(join(root, REVISION_DIR, `${sourceRevision}.json`), 'utf8'));
    if (typeof checker === 'function' && !(await checker({ workspaceId, revision: sourceRevision, files: source }))) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'workspace revision check failed');
    const main = await this.#tree(root, oldMain);
    const revision = nextRevision(record.revisions.at(-1));
    await this.#writeSnapshot(root, revision, source);
    const commit = await this.#materializeCommit(root, source, `Merge Workspace revision ${sourceRevision}`);
    await this.#writeRevision(root, revision, { parents: [oldMain, sourceRevision], tree: source, source: 'merge', git_commit: commit });
    record.revisions.push(revision); record.main_revision = revision; record.main_commit = commit; record.next_revision = nextRevision(revision); record.updated_at = now();
    await this.#write(root, record);
    return { ...this.#public(record), merged_from: sourceRevision, parents: [oldMain, sourceRevision], changed_files: this.#changed(main, source), source_commit: sourceMeta.git_commit ?? null };
  }

  async materialize({ workspaceId, revision = undefined, targetDir }) {
    required(targetDir, 'target_dir');
    const root = this.workspacePath(workspaceId); const record = await this.#read(root); const selected = revision ?? record.main_revision; const tree = await this.#snapshot(root, selected);
    const target = resolve(targetDir); if (target === root || relative(root, target) === '') throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'execution directory must be separate from repository');
    await mkdir(target, { recursive: true }); await this.#materialize(target, tree); return { workspace_id: record.workspace_id, revision: selected, target_dir: target, files: fileEntries(tree) };
  }

  async #read(root) { try { return JSON.parse(await readFile(join(root, META), 'utf8')); } catch (error) { throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown Workspace: ${root}`, undefined, { cause: error }); } }
  async #write(root, record) { await writeFile(join(root, META), JSON.stringify(record, null, 2)); }
  async #snapshot(root, revision) { revisionNumber(revision); const metadata = JSON.parse(await readFile(join(root, REVISION_DIR, `${revision}.json`), 'utf8')); return metadata.files; }
  async #tree(root, revision) {
    const files = await this.#snapshot(root, revision);
    const tree = {};
    for (const path of Object.keys(files)) tree[path] = await readFile(join(root, REVISION_DIR, revision, 'files', path), 'utf8');
    return tree;
  }
  async #writeSnapshot(root, revision, tree) { const dir = join(root, REVISION_DIR, revision, 'files'); await rm(dir, { recursive: true, force: true }); await mkdir(dir, { recursive: true }); await this.#materialize(dir, tree); }
  async #writeRevision(root, revision, { parents, tree, source, git_commit = null }) { const metadata = { revision, git_commit, parents, files: fileEntries(tree), content_hash: textHash(JSON.stringify(fileEntries(tree))), source, created_at: now() }; await writeFile(join(root, REVISION_DIR, `${revision}.json`), JSON.stringify(metadata, null, 2)); return metadata; }
  async #materialize(root, tree) { for (const [path, content] of Object.entries(tree)) { const target = join(root, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, content); } }
  async #materializeCommit(root, tree, message) { await this.#materialize(root, tree); await git(root, ['add', '-A']); const status = await git(root, ['status', '--porcelain']); if (status) await execFile('git', ['-C', root, '-c', 'user.name=SwarmEnv Runtime', '-c', 'user.email=runtime@swarmenv.invalid', 'commit', '-m', message], { timeout: 30_000 }); return git(root, ['rev-parse', 'HEAD']); }
  #changed(before, after) { return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((path) => before[path]?.content_hash !== after[path]?.content_hash || before[path]?.bytes !== after[path]?.bytes).sort(); }
  #public(record) { return { ...record, revisions: [...record.revisions] }; }
}

export function candidateFileRef({ workspaceId, revision, path }) { return { workspace_id: required(workspaceId, 'workspace_id'), revision: revisionNumber(revision), path: safePath(path) }; }

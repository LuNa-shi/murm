import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, lstat, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative as pathRelative, resolve } from 'node:path';
import { ERROR_CODES, SwarmEnvError } from '../errors.js';
import { stableStringify } from '../protocol/envelope.js';
import { WorkspaceRepository } from './workspace-repository.js';
import {
  assertReadableWorkspacePath,
  normalizeWorkspaceContract,
  validateRequiredWorkspaceInputs,
} from './workspace-contract.js';

const META_DIR = '.swarm';
const META_FILE = 'workspace.json';

function hash(value: any) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function textHash(value: any) {
  return createHash('sha256').update(value).digest('hex');
}

function requireString(value: any, field: any) {
  if (typeof value !== 'string' || value.length === 0) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `${field} is required`);
  return value;
}

function safePath(relativePath: any) {
  requireString(relativePath, 'workspace file path');
  if (isAbsolute(relativePath) || relativePath.includes('\0')) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'workspace file path must be relative');
  const portablePath = relativePath.replaceAll('\\', '/');
  if (portablePath.split('/').includes('..')) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'workspace files cannot address parent directories');
  const normalized = resolve('/', portablePath).slice(1);
  if (!normalized || normalized === META_DIR || normalized.startsWith(`${META_DIR}/`)) {
    throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'workspace files cannot address Runtime metadata or parent directories');
  }
  return normalized;
}

function safeDirectoryPath(relativePath: any) {
  if (relativePath === undefined || relativePath === null || relativePath === '') return '';
  return safePath(relativePath);
}

function contentEntry(content: any) {
  return { content_hash: textHash(content), bytes: Buffer.byteLength(content) };
}

async function exists(path: any) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export class WorkspaceManager {
  declare rootDir: any;

  constructor({ rootDir }: any) {
    this.rootDir = resolve(requireString(rootDir, 'rootDir'));
  }

  workspacePath(executionId: any) {
    const id = requireString(executionId, 'execution_id');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'execution_id is not a safe workspace path segment');
    return join(this.rootDir, id);
  }

  async createWorkspace(options: any) {
    if (!options.publicSnapshot) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'publicSnapshot is required for Execution preparation');
    const target = this.#assertWorkspacePath(options.workspaceRef ?? this.workspacePath(options.executionId));
    await mkdir(this.rootDir, { recursive: true });
    await this.#assertNoSymlinkAncestors(this.rootDir, target);
    const repository = new WorkspaceRepository();
    return repository.requestLocked(this.rootDir, `prepare-${textHash(target)}`, async () => {
      if (await exists(join(target, META_DIR, META_FILE))) {
        const existing = await this.#readMetadata(target);
        const input = Object.fromEntries(Object.entries(options.publicSnapshot).filter(([key]: any) => key !== 'files'));
        if (existing.execution_id !== options.executionId || existing.fencing_version !== options.fencingVersion || existing.released_at ||
            stableStringify(existing.public_workspace_input) !== stableStringify(input)) {
          throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Execution directory already records different input or lifecycle ownership');
        }
        return this.#publicMetadata(existing);
      }
      if (await exists(target) && (await readdir(target)).length) throw new SwarmEnvError('WORKSPACE_BUSY', 'Execution input target is not empty');
      const stage = await mkdtemp(join(this.rootDir, '.swarm-prepare-'));
      try {
        const prepared = await this.#createWorkspace({ ...options, workspaceRef: stage, publishedWorkspaceRef: target });
        await this.#assertNoSymlinkAncestors(this.rootDir, target);
        await rename(stage, target);
        return prepared;
      } finally { await rm(stage, { recursive: true, force: true }); }
    });
  }

  async #createWorkspace({ executionId, fencingVersion, task, workspaceRef = this.workspacePath(executionId), publicSnapshot, publishedWorkspaceRef = workspaceRef }: any) {
    workspaceRef = this.#assertWorkspacePath(workspaceRef);
    await mkdir(this.rootDir, { recursive: true });
    await this.#assertNoSymlinkAncestors(this.rootDir, workspaceRef);
    await mkdir(join(workspaceRef, META_DIR, 'revisions'), { recursive: true });
    const metadataPath = join(workspaceRef, META_DIR, META_FILE);
    if (await exists(metadataPath)) {
      const existing = await this.#readMetadata(workspaceRef);
      if (existing.execution_id !== executionId || existing.fencing_version !== fencingVersion) {
        throw new SwarmEnvError(ERROR_CODES.FENCED, 'workspace already belongs to another execution fence');
      }
      return this.#publicMetadata(existing);
    }
    if (!task || typeof task !== 'object' || Array.isArray(task)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'task is required to create a Workspace');
    }
    const taskWorkspace = task.workspace && typeof task.workspace === 'object' ? task.workspace : {};
    const workspaceContract = normalizeWorkspaceContract(taskWorkspace);
    const files = publicSnapshot.files;
    const fileManifest = Object.create(null);
    const normalizedFiles = Object.entries(files).map(([inputPath, content]: any) => [safePath(inputPath), content]);
    for (const [relativePath, content] of normalizedFiles) {
      const target = join(workspaceRef, relativePath);
      await this.#assertNoSymlinkAncestors(workspaceRef, target);
      await this.#assertWritableFileTarget(target);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, 'utf8');
      fileManifest[relativePath] = contentEntry(content);
    }
    validateRequiredWorkspaceInputs(fileManifest, workspaceContract);
    if (stableStringify(fileManifest) !== stableStringify(publicSnapshot.manifest)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Initial project bytes do not match the public revision manifest');
    }
    const gitCommit = (await new WorkspaceRepository().createInitialTree(workspaceRef, files)).commit;
    const metadata = {
      execution_id: executionId,
      workspace_ref: publishedWorkspaceRef,
      fencing_version: fencingVersion,
      workspace_revision: 1,
      content_hash: hash({ revision: 1, files: fileManifest }),
      git_commit: gitCommit,
      git_worktree: publishedWorkspaceRef,
      files: fileManifest,
      workspace_contract: workspaceContract,
      public_workspace_input: Object.fromEntries(Object.entries(publicSnapshot).filter(([key]: any) => key !== 'files')),
      changed_files: Object.keys(fileManifest),
      released_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await this.#writeMetadata(workspaceRef, metadata);
    await this.#writeRevisionSnapshot(workspaceRef, metadata);
    return this.#publicMetadata(metadata);
  }

  async listFiles({ workspaceRef, executionId, fencingVersion = undefined, path = '' }: any) {
    const metadata = await this.#readOwnedMetadata({ workspaceRef, executionId, fencingVersion });
    const prefix = safeDirectoryPath(path);
    if (prefix) assertReadableWorkspacePath(prefix, metadata.workspace_contract ?? normalizeWorkspaceContract({}), new Set(Object.keys(metadata.files ?? {})));
    const files = Object.entries(metadata.files ?? {})
      .filter(([relativePath]: any) => !prefix || relativePath === prefix || relativePath.startsWith(`${prefix}/`))
      .map(([relativePath, file]: any) => ({ path: relativePath, type: 'file', ...file }))
      .sort((left: any, right: any) => left.path.localeCompare(right.path));
    return {
      workspace_ref: metadata.workspace_ref,
      workspace_revision: metadata.workspace_revision,
      content_hash: metadata.content_hash,
      workspace_contract: metadata.workspace_contract ?? normalizeWorkspaceContract({}),
      files,
    };
  }

  async restoreWorkspace({ workspaceRef, executionId, fencingVersion = undefined }: any) {
    const metadata = await this.#readOwnedMetadata({ workspaceRef, executionId, fencingVersion });
    return this.#publicMetadata(metadata);
  }

  async #readOwnedMetadata({ workspaceRef, executionId, fencingVersion = undefined }: any) {
    const metadata = await this.#readMetadata(workspaceRef);
    if (metadata.execution_id !== executionId) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'workspace execution_id does not match');
    if (fencingVersion !== undefined && metadata.fencing_version !== fencingVersion) throw new SwarmEnvError(ERROR_CODES.FENCED, 'workspace fence is stale');
    return metadata;
  }

  async listRevisions({ workspaceRef, executionId, fencingVersion = undefined }: any) {
    const metadata = await this.restoreWorkspace({ workspaceRef, executionId, fencingVersion });
    const revisionDir = join(metadata.workspace_ref, META_DIR, 'revisions');
    const names = await readdir(revisionDir);
    const revisions: any[] = [];
    for (const name of names.filter((candidate: any) => /^\d+\.json$/.test(candidate)).sort((left: any, right: any) => Number(left.slice(0, -5)) - Number(right.slice(0, -5)))) {
      revisions.push(JSON.parse(await readFile(join(revisionDir, name), 'utf8')));
    }
    return revisions.map((revision: any) => ({
      workspace_ref: metadata.workspace_ref,
      workspace_revision: revision.workspace_revision,
      content_hash: revision.content_hash,
      git_commit: revision.git_commit ?? null,
      git_worktree: revision.git_worktree ?? metadata.workspace_ref,
      changed_files: revision.changed_files ?? [],
    }));
  }

  async releaseWorkspace({ workspaceRef, executionId, fencingVersion }: any) {
    const metadata = await this.#readMetadata(workspaceRef);
    if (metadata.execution_id !== executionId) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'workspace execution_id does not match');
    if (metadata.fencing_version !== fencingVersion) throw new SwarmEnvError(ERROR_CODES.FENCED, 'workspace fence is stale');
    // Retry both writes: the previous call may have persisted the primary
    // release before failing to update revision metadata.
    const next = metadata.released_at ? metadata : { ...metadata, released_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    await this.#writeMetadata(workspaceRef, next);
    await this.#writeRevisionMetadata(workspaceRef, next);
    return this.#publicMetadata(next);
  }

  async fenceWorkspace({ workspaceRef, executionId, fencingVersion, newFencingVersion }: any) {
    const metadata = await this.#readMetadata(workspaceRef);
    if (metadata.execution_id !== executionId) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'workspace execution_id does not match');
    if (metadata.fencing_version !== fencingVersion) throw new SwarmEnvError(ERROR_CODES.FENCED, 'workspace fence is stale');
    if (!Number.isInteger(newFencingVersion) || newFencingVersion <= fencingVersion) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'new fencing version must increase');
    const next = { ...metadata, fencing_version: newFencingVersion, released_at: null, updated_at: new Date().toISOString() };
    await this.#writeMetadata(workspaceRef, next);
    await this.#writeRevisionMetadata(workspaceRef, next);
    return this.#publicMetadata(next);
  }

  async #assertReadableFileTarget(target: any) {
    let info;
    try {
      info = await lstat(target);
    } catch (error: any) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `workspace file is unavailable: ${error.message}`, undefined, { cause: error });
    }
    if (info.isSymbolicLink()) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Workspace symbolic links are not readable');
    if (!info.isFile()) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Workspace path is not a regular file');
  }

  async #assertNoSymlinkAncestors(root: any, target: any) {
    let current = root;
    let rootInfo;
    try {
      rootInfo = await lstat(current);
    } catch (error: any) {
      if (error?.code === 'ENOENT') return;
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `Workspace root cannot be inspected: ${error.message}`, undefined, { cause: error });
    }
    if (rootInfo.isSymbolicLink()) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Workspace root symbolic links are not accessible');
    if (!rootInfo.isDirectory()) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Workspace root is not a directory');
    for (const part of pathRelative(root, target).split(/[\\/]/).filter(Boolean)) {
      current = join(current, part);
      let info;
      try {
        info = await lstat(current);
      } catch (error: any) {
        if (error?.code === 'ENOENT') return;
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `Workspace path cannot be inspected: ${error.message}`, undefined, { cause: error });
      }
      if (info.isSymbolicLink()) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Workspace symbolic links are not accessible');
      if (current !== target && !info.isDirectory()) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Workspace path parent is not a directory');
    }
  }

  async #assertWritableFileTarget(target: any) {
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Workspace symbolic links are not writable');
      if (!info.isFile()) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Workspace path is not a regular file');
    } catch (error: any) {
      if (error?.code === 'ENOENT') return;
      if (error instanceof SwarmEnvError) throw error;
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `Workspace path cannot be written: ${error.message}`, undefined, { cause: error });
    }
  }

  async #writeRevisionSnapshot(workspaceRef: any, metadata: any) {
    await this.#writeRevisionMetadata(workspaceRef, metadata);
    const snapshotRoot = join(workspaceRef, META_DIR, 'revisions', String(metadata.workspace_revision), 'files');
    await mkdir(snapshotRoot, { recursive: true });
    for (const relativePath of Object.keys(metadata.files ?? {})) {
      const source = join(workspaceRef, relativePath);
      const target = join(snapshotRoot, relativePath);
      await this.#assertNoSymlinkAncestors(workspaceRef, source);
      await this.#assertReadableFileTarget(source);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, await readFile(source));
    }
  }

  async #writeRevisionMetadata(workspaceRef: any, metadata: any) {
    const target = join(workspaceRef, META_DIR, 'revisions', `${metadata.workspace_revision}.json`);
    await this.#atomicWrite(target, JSON.stringify(metadata, null, 2));
  }

  async #readMetadata(workspaceRef: any) {
    const resolvedWorkspace = this.#assertWorkspacePath(workspaceRef);
    await this.#assertNoSymlinkAncestors(this.rootDir, resolvedWorkspace);
    try {
      return JSON.parse(await readFile(join(resolvedWorkspace, META_DIR, META_FILE), 'utf8'));
    } catch (error: any) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `workspace metadata is unavailable: ${error.message}`, undefined, { cause: error });
    }
  }

  #assertWorkspacePath(workspaceRef: any) {
    requireString(workspaceRef, 'workspace_ref');
    const resolvedWorkspace = resolve(workspaceRef);
    if (resolvedWorkspace === this.rootDir || !resolvedWorkspace.startsWith(`${this.rootDir}/`)) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'workspace_ref is outside Runtime rootDir');
    }
    return resolvedWorkspace;
  }

  async #writeMetadata(workspaceRef: any, metadata: any) {
    await this.#atomicWrite(join(workspaceRef, META_DIR, META_FILE), JSON.stringify(metadata, null, 2));
  }

  async #atomicWrite(target: any, content: any) {
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, 'utf8');
      await rename(temporary, target);
    } catch (error: any) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  #publicMetadata(metadata: any) {
    return {
      workspace_ref: metadata.workspace_ref,
      public_workspace_input: metadata.public_workspace_input ?? null,
      execution_id: metadata.execution_id,
      fencing_version: metadata.fencing_version,
      workspace_revision: metadata.workspace_revision,
      content_hash: metadata.content_hash,
      git_commit: metadata.git_commit ?? null,
      git_worktree: metadata.git_worktree ?? metadata.workspace_ref,
      task_id: metadata.task_id ?? null,
      workspace_contract: metadata.workspace_contract ?? normalizeWorkspaceContract({}),
      changed_files: metadata.changed_files ?? [],
      released_at: metadata.released_at,
    };
  }
}

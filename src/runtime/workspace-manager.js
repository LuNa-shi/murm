import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { ERROR_CODES, SwarmEnvError } from '../errors.js';
import { stableStringify } from '../protocol/envelope.js';

const META_DIR = '.swarm';
const META_FILE = 'workspace.json';

function hash(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function textHash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `${field} is required`);
  return value;
}

function safePath(relativePath) {
  requireString(relativePath, 'workspace file path');
  if (isAbsolute(relativePath) || relativePath.includes('\0')) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'workspace file path must be relative');
  if (relativePath.split(/[\\/]/).includes('..')) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'workspace files cannot address parent directories');
  const normalized = resolve('/', relativePath).slice(1);
  if (!normalized || normalized === META_DIR || normalized.startsWith(`${META_DIR}/`)) {
    throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'workspace files cannot address Runtime metadata or parent directories');
  }
  return normalized;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export class WorkspaceManager {
  constructor({ rootDir }) {
    this.rootDir = resolve(requireString(rootDir, 'rootDir'));
  }

  workspacePath(executionId) {
    const id = requireString(executionId, 'execution_id');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'execution_id is not a safe workspace path segment');
    return join(this.rootDir, id);
  }

  async createWorkspace({ executionId, fencingVersion, task, workspaceManifest, workspaceRef = this.workspacePath(executionId), inputSnapshotManifest = {}, runtimeManifest = {} }) {
    workspaceRef = resolve(workspaceRef);
    if (workspaceRef !== this.rootDir && !workspaceRef.startsWith(`${this.rootDir}/`)) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'workspace_ref escapes the Workspace Manager root');
    }
    await mkdir(this.rootDir, { recursive: true });
    await mkdir(join(workspaceRef, META_DIR, 'revisions'), { recursive: true });
    await mkdir(join(workspaceRef, META_DIR, 'checkpoints'), { recursive: true });
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
    const files = {
      'README.md': [
        `# ${task.goal}`,
        '',
        `Expected output: ${task.expected_output}`,
        '',
        'Acceptance conditions:',
        '```json',
        JSON.stringify(task.acceptance_conditions ?? {}, null, 2),
        '```',
        '',
        'Task instructions:',
        task.task_instructions ?? '',
        '',
      ].join('\n'),
      'workspace-manifest.json': JSON.stringify({
        task_id: task.task_id,
        root_id: task.root_id,
        task_type: task.task_type,
        goal: task.goal,
        expected_output: task.expected_output,
        workspace: taskWorkspace,
        workspace_manifest: workspaceManifest ?? null,
        input_snapshot: inputSnapshotManifest,
      }, null, 2),
      'runtime-manifest.json': JSON.stringify(runtimeManifest, null, 2),
    };
    if (typeof taskWorkspace.formal_source === 'string' && taskWorkspace.formal_source.length > 0) {
      files[taskWorkspace.problem_file ?? 'problem.lean'] = taskWorkspace.formal_source;
    }
    const fileManifest = {};
    for (const [relativePath, content] of Object.entries(files)) {
      const target = join(workspaceRef, relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, 'utf8');
      fileManifest[relativePath] = { content_hash: textHash(content), bytes: Buffer.byteLength(content) };
    }
    const metadata = {
      execution_id: executionId,
      workspace_ref: workspaceRef,
      fencing_version: fencingVersion,
      workspace_revision: 1,
      content_hash: hash({ revision: 1, files: fileManifest }),
      files: fileManifest,
      checkpoint_ref: null,
      checkpoint_hash: null,
      released_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await this.#writeMetadata(workspaceRef, metadata);
    await writeFile(join(workspaceRef, META_DIR, 'revisions', '1.json'), JSON.stringify(metadata, null, 2), 'utf8');
    return this.#publicMetadata(metadata);
  }

  /**
   * Materialize a new Workspace from a prior revision. A resumed Execution
   * gets its own writable directory while retaining explicit parent lineage;
   * the source Workspace is never re-owned by the new Execution.
   */
  async cloneWorkspace({ sourceWorkspaceRef, targetWorkspaceRef, executionId, fencingVersion, revision = null, task, workspaceManifest = {}, inputSnapshotManifest = {}, runtimeManifest = {} }) {
    const source = await this.#readMetadata(sourceWorkspaceRef);
    const selectedRevision = revision ?? source.workspace_revision;
    if (!Number.isInteger(selectedRevision) || selectedRevision < 1 || selectedRevision > source.workspace_revision) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'workspace revision is outside the source Workspace history');
    }
    const revisionPath = join(source.workspace_ref, META_DIR, 'revisions', `${selectedRevision}.json`);
    const selected = JSON.parse(await readFile(revisionPath, 'utf8'));
    const target = this.#assertWorkspacePath(targetWorkspaceRef);
    if (target === source.workspace_ref) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'resumed Workspace must use a new writable path');
    const existingMetadataPath = join(target, META_DIR, META_FILE);
    if (await exists(existingMetadataPath)) {
      const existing = await this.#readMetadata(target);
      if (existing.execution_id !== executionId || existing.fencing_version !== fencingVersion) {
        throw new SwarmEnvError(ERROR_CODES.FENCED, 'target Workspace already belongs to another execution fence');
      }
      return this.#publicMetadata(existing);
    }
    await mkdir(join(target, META_DIR, 'revisions'), { recursive: true });
    await mkdir(join(target, META_DIR, 'checkpoints'), { recursive: true });
    const files = {};
    for (const [relativePath, file] of Object.entries(selected.files ?? {})) {
      const content = await readFile(join(source.workspace_ref, relativePath));
      const targetPath = join(target, relativePath);
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, content);
      files[relativePath] = { content_hash: file.content_hash, bytes: file.bytes };
    }
    const metadata = {
      execution_id: executionId,
      workspace_ref: target,
      fencing_version: fencingVersion,
      workspace_revision: selectedRevision,
      content_hash: selected.content_hash,
      files,
      checkpoint_ref: null,
      checkpoint_hash: null,
      released_at: null,
      parent_workspace_ref: source.workspace_ref,
      parent_workspace_revision: selectedRevision,
      task_id: task?.task_id ?? null,
      workspace_manifest: workspaceManifest,
      input_snapshot: inputSnapshotManifest,
      runtime_manifest: runtimeManifest,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await this.#writeMetadata(target, metadata);
    await writeFile(join(target, META_DIR, 'revisions', `${selectedRevision}.json`), JSON.stringify(metadata, null, 2), 'utf8');
    return this.#publicMetadata(metadata);
  }

  async saveWorkspaceRevision({ workspaceRef, executionId, fencingVersion, files = {} }) {
    const metadata = await this.#assertWritable(workspaceRef, executionId, fencingVersion);
    const revision = metadata.workspace_revision + 1;
    const nextFiles = { ...metadata.files };
    for (const [inputPath, rawContent] of Object.entries(files)) {
      const relativePath = safePath(inputPath);
      const content = Buffer.isBuffer(rawContent) ? rawContent : String(rawContent);
      const target = join(workspaceRef, relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
      nextFiles[relativePath] = { content_hash: textHash(content), bytes: Buffer.byteLength(content) };
    }
    const next = {
      ...metadata,
      workspace_revision: revision,
      content_hash: hash({ revision, files: nextFiles }),
      files: nextFiles,
      released_at: null,
      updated_at: new Date().toISOString(),
    };
    await this.#writeMetadata(workspaceRef, next);
    await writeFile(join(workspaceRef, META_DIR, 'revisions', `${revision}.json`), JSON.stringify(next, null, 2), 'utf8');
    return this.#publicMetadata(next);
  }

  async saveCheckpoint({ workspaceRef, executionId, fencingVersion, checkpoint = {}, checkpointRef = randomUUID() }) {
    const metadata = await this.#assertWritable(workspaceRef, executionId, fencingVersion);
    const content = JSON.stringify({ execution_id: executionId, workspace_revision: metadata.workspace_revision, checkpoint }, null, 2);
    const checkpointHash = textHash(content);
    const ref = join(workspaceRef, META_DIR, 'checkpoints', `${checkpointRef}.json`);
    await writeFile(ref, content, 'utf8');
    const next = { ...metadata, checkpoint_ref: ref, checkpoint_hash: checkpointHash, updated_at: new Date().toISOString() };
    await this.#writeMetadata(workspaceRef, next);
    return { checkpoint_ref: ref, checkpoint_hash: checkpointHash, workspace_revision: metadata.workspace_revision };
  }

  async restoreWorkspace({ workspaceRef, executionId, fencingVersion = undefined }) {
    const metadata = await this.#readMetadata(workspaceRef);
    if (metadata.execution_id !== executionId) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'workspace execution_id does not match');
    if (fencingVersion !== undefined && metadata.fencing_version !== fencingVersion) throw new SwarmEnvError(ERROR_CODES.FENCED, 'workspace fence is stale');
    return this.#publicMetadata(metadata);
  }

  async listRevisions({ workspaceRef, executionId, fencingVersion = undefined }) {
    const metadata = await this.restoreWorkspace({ workspaceRef, executionId, fencingVersion });
    const revisionDir = join(metadata.workspace_ref, META_DIR, 'revisions');
    const names = await readdir(revisionDir);
    const revisions = [];
    for (const name of names.filter((candidate) => /^\d+\.json$/.test(candidate)).sort((left, right) => Number(left.slice(0, -5)) - Number(right.slice(0, -5)))) {
      revisions.push(JSON.parse(await readFile(join(revisionDir, name), 'utf8')));
    }
    return revisions.map((revision) => ({
      workspace_ref: metadata.workspace_ref,
      workspace_revision: revision.workspace_revision,
      content_hash: revision.content_hash,
      checkpoint_ref: revision.checkpoint_ref,
      checkpoint_hash: revision.checkpoint_hash,
    }));
  }

  async releaseWorkspace({ workspaceRef, executionId, fencingVersion }) {
    const metadata = await this.#assertWritable(workspaceRef, executionId, fencingVersion);
    const next = { ...metadata, released_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    await this.#writeMetadata(workspaceRef, next);
    return this.#publicMetadata(next);
  }

  async fenceWorkspace({ workspaceRef, executionId, fencingVersion, newFencingVersion }) {
    const metadata = await this.#readMetadata(workspaceRef);
    if (metadata.execution_id !== executionId) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'workspace execution_id does not match');
    if (metadata.fencing_version !== fencingVersion) throw new SwarmEnvError(ERROR_CODES.FENCED, 'workspace fence is stale');
    if (!Number.isInteger(newFencingVersion) || newFencingVersion <= fencingVersion) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'new fencing version must increase');
    const next = { ...metadata, fencing_version: newFencingVersion, released_at: null, updated_at: new Date().toISOString() };
    await this.#writeMetadata(workspaceRef, next);
    return this.#publicMetadata(next);
  }

  async #assertWritable(workspaceRef, executionId, fencingVersion) {
    const metadata = await this.#readMetadata(workspaceRef);
    if (metadata.execution_id !== executionId) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'workspace execution_id does not match');
    if (metadata.fencing_version !== fencingVersion) throw new SwarmEnvError(ERROR_CODES.FENCED, 'workspace write uses an old fencing version');
    return metadata;
  }

  async #readMetadata(workspaceRef) {
    const resolvedWorkspace = this.#assertWorkspacePath(workspaceRef);
    try {
      return JSON.parse(await readFile(join(resolvedWorkspace, META_DIR, META_FILE), 'utf8'));
    } catch (error) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `workspace metadata is unavailable: ${error.message}`, undefined, { cause: error });
    }
  }

  #assertWorkspacePath(workspaceRef) {
    requireString(workspaceRef, 'workspace_ref');
    const resolvedWorkspace = resolve(workspaceRef);
    if (resolvedWorkspace !== this.rootDir && !resolvedWorkspace.startsWith(`${this.rootDir}/`)) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'workspace_ref is outside Runtime rootDir');
    }
    return resolvedWorkspace;
  }

  async #writeMetadata(workspaceRef, metadata) {
    await writeFile(join(workspaceRef, META_DIR, META_FILE), JSON.stringify(metadata, null, 2), 'utf8');
  }

  #publicMetadata(metadata) {
    return {
      workspace_ref: metadata.workspace_ref,
      execution_id: metadata.execution_id,
      fencing_version: metadata.fencing_version,
      workspace_revision: metadata.workspace_revision,
      content_hash: metadata.content_hash,
      parent_workspace_ref: metadata.parent_workspace_ref ?? null,
      parent_workspace_revision: metadata.parent_workspace_revision ?? null,
      task_id: metadata.task_id ?? null,
      workspace_manifest: metadata.workspace_manifest ?? null,
      input_snapshot: metadata.input_snapshot ?? null,
      checkpoint_ref: metadata.checkpoint_ref,
      checkpoint_hash: metadata.checkpoint_hash,
      released_at: metadata.released_at,
    };
  }
}

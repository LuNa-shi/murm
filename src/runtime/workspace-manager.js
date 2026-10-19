import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, lstat, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative as pathRelative, resolve } from 'node:path';
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
  const portablePath = relativePath.replaceAll('\\', '/');
  if (portablePath.split('/').includes('..')) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'workspace files cannot address parent directories');
  const normalized = resolve('/', portablePath).slice(1);
  if (!normalized || normalized === META_DIR || normalized.startsWith(`${META_DIR}/`)) {
    throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'workspace files cannot address Runtime metadata or parent directories');
  }
  return normalized;
}

function safeDirectoryPath(relativePath) {
  if (relativePath === undefined || relativePath === null || relativePath === '') return '';
  return safePath(relativePath);
}

function contentEntry(content) {
  return { content_hash: textHash(content), bytes: Buffer.byteLength(content) };
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
    workspaceRef = this.#assertWorkspacePath(workspaceRef);
    await mkdir(this.rootDir, { recursive: true });
    await this.#assertNoSymlinkAncestors(this.rootDir, workspaceRef);
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
    const normalizedFiles = Object.entries(files).map(([inputPath, content]) => [safePath(inputPath), content]);
    for (const [relativePath, content] of normalizedFiles) {
      const target = join(workspaceRef, relativePath);
      await this.#assertNoSymlinkAncestors(workspaceRef, target);
      await this.#assertWritableFileTarget(target);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, 'utf8');
      fileManifest[relativePath] = contentEntry(content);
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
      changed_files: Object.keys(fileManifest),
      released_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await this.#writeMetadata(workspaceRef, metadata);
    await this.#writeRevisionSnapshot(workspaceRef, metadata);
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
    const selectedSnapshotRoot = join(source.workspace_ref, META_DIR, 'revisions', String(selectedRevision), 'files');
    const target = this.#assertWorkspacePath(targetWorkspaceRef);
    await this.#assertNoSymlinkAncestors(this.rootDir, target);
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
    // A fork keeps the selected revision as its current tip, but its local
    // revision history must still be usable for diffs and later forks. The
    // source Workspace is already Runtime-owned and path-checked, so copy the
    // inherited metadata and snapshots before materializing the new tip.
    for (let inheritedRevision = 1; inheritedRevision < selectedRevision; inheritedRevision += 1) {
      const inheritedMetadataPath = join(source.workspace_ref, META_DIR, 'revisions', `${inheritedRevision}.json`);
      const inheritedSnapshotRoot = join(source.workspace_ref, META_DIR, 'revisions', String(inheritedRevision), 'files');
      const inheritedMetadata = JSON.parse(await readFile(inheritedMetadataPath, 'utf8'));
      await writeFile(join(target, META_DIR, 'revisions', `${inheritedRevision}.json`), JSON.stringify({
        ...inheritedMetadata,
        execution_id: executionId,
        workspace_ref: target,
        fencing_version: fencingVersion,
      }, null, 2), 'utf8');
      await cp(inheritedSnapshotRoot, join(target, META_DIR, 'revisions', String(inheritedRevision), 'files'), { recursive: true });
    }
    const files = {};
    for (const [relativePath, file] of Object.entries(selected.files ?? {})) {
      let content;
      try {
        await this.#assertNoSymlinkAncestors(source.workspace_ref, join(source.workspace_ref, relativePath));
        await this.#assertNoSymlinkAncestors(source.workspace_ref, join(selectedSnapshotRoot, relativePath));
        content = await readFile(join(selectedSnapshotRoot, relativePath));
      } catch (error) {
        // Workspaces created before revision snapshots existed can still be
        // resumed at their current revision. Refuse to silently fork stale
        // historical metadata when the requested revision has no content.
        if (error instanceof SwarmEnvError) throw error;
        if (selectedRevision !== source.workspace_revision) {
          throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `workspace revision content is unavailable: ${error.message}`, undefined, { cause: error });
        }
        content = await readFile(join(source.workspace_ref, relativePath));
      }
      const targetPath = join(target, relativePath);
      await this.#assertNoSymlinkAncestors(target, targetPath);
      await this.#assertWritableFileTarget(targetPath);
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
      changed_files: selected.changed_files ?? Object.keys(files),
      runtime_manifest: runtimeManifest,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await this.#writeMetadata(target, metadata);
    await this.#writeRevisionSnapshot(target, metadata);
    return this.#publicMetadata(metadata);
  }

  async saveWorkspaceRevision({ workspaceRef, executionId, fencingVersion, files = {}, expectedRevision = undefined }) {
    const metadata = await this.#assertWritable(workspaceRef, executionId, fencingVersion);
    if (expectedRevision !== undefined && expectedRevision !== metadata.workspace_revision) {
      throw new SwarmEnvError(ERROR_CODES.STALE_VERSION, 'workspace_revision is stale', {
        expected: metadata.workspace_revision,
        received: expectedRevision,
      });
    }
    const revision = metadata.workspace_revision + 1;
    const nextFiles = { ...metadata.files };
    const changedFiles = [];
    for (const [inputPath, rawContent] of Object.entries(files)) {
      const relativePath = safePath(inputPath);
      if (typeof rawContent !== 'string' && !Buffer.isBuffer(rawContent)) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `workspace file content must be text: ${relativePath}`);
      }
      const content = Buffer.isBuffer(rawContent) ? rawContent : String(rawContent);
      const target = join(workspaceRef, relativePath);
      await this.#assertNoSymlinkAncestors(workspaceRef, target);
      await this.#assertWritableFileTarget(target);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
      nextFiles[relativePath] = contentEntry(content);
      changedFiles.push(relativePath);
    }
    const next = {
      ...metadata,
      workspace_revision: revision,
      content_hash: hash({ revision, files: nextFiles }),
      files: nextFiles,
      changed_files: changedFiles,
      released_at: null,
      updated_at: new Date().toISOString(),
    };
    await this.#writeMetadata(workspaceRef, next);
    await this.#writeRevisionSnapshot(workspaceRef, next);
    return this.#publicMetadata(next);
  }

  async listFiles({ workspaceRef, executionId, fencingVersion = undefined, path = '' }) {
    const metadata = await this.#readOwnedMetadata({ workspaceRef, executionId, fencingVersion });
    const prefix = safeDirectoryPath(path);
    const files = Object.entries(metadata.files ?? {})
      .filter(([relativePath]) => !prefix || relativePath === prefix || relativePath.startsWith(`${prefix}/`))
      .map(([relativePath, file]) => ({ path: relativePath, type: 'file', ...file }))
      .sort((left, right) => left.path.localeCompare(right.path));
    return {
      workspace_ref: metadata.workspace_ref,
      workspace_revision: metadata.workspace_revision,
      content_hash: metadata.content_hash,
      files,
    };
  }

  async readWorkspaceFile({ workspaceRef, executionId, fencingVersion = undefined, path, maxBytes = 1_000_000 }) {
    const metadata = await this.#readOwnedMetadata({ workspaceRef, executionId, fencingVersion });
    const relativePath = safePath(path);
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 10_000_000) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'max_bytes must be an integer between 1 and 10000000');
    }
    const target = join(metadata.workspace_ref, relativePath);
    await this.#assertNoSymlinkAncestors(metadata.workspace_ref, target);
    await this.#assertReadableFileTarget(target);
    const content = await readFile(target);
    const entry = metadata.files?.[relativePath] ?? contentEntry(content);
    const truncated = content.byteLength > maxBytes;
    return {
      workspace_ref: metadata.workspace_ref,
      workspace_revision: metadata.workspace_revision,
      path: relativePath,
      content: content.subarray(0, maxBytes).toString('utf8'),
      content_hash: entry.content_hash,
      bytes: content.byteLength,
      truncated,
    };
  }

  async diff({ workspaceRef, executionId, fencingVersion = undefined, fromRevision = null, toRevision = null }) {
    const current = await this.#readOwnedMetadata({ workspaceRef, executionId, fencingVersion });
    const from = await this.#revisionMetadata(current, fromRevision ?? Math.max(1, current.workspace_revision - 1));
    const to = await this.#revisionMetadata(current, toRevision ?? current.workspace_revision);
    const paths = new Set([...Object.keys(from.files ?? {}), ...Object.keys(to.files ?? {})]);
    const changedFiles = [...paths].sort().flatMap((path) => {
      const before = from.files?.[path] ?? null;
      const after = to.files?.[path] ?? null;
      if (before?.content_hash === after?.content_hash && before?.bytes === after?.bytes) return [];
      return [{
        path,
        status: before === null ? 'added' : after === null ? 'removed' : 'modified',
        before,
        after,
      }];
    });
    return {
      workspace_ref: current.workspace_ref,
      from_revision: from.workspace_revision,
      to_revision: to.workspace_revision,
      changed_files: changedFiles,
    };
  }

  async saveCheckpoint({ workspaceRef, executionId, fencingVersion, checkpoint = {}, checkpointRef = randomUUID() }) {
    const metadata = await this.#assertWritable(workspaceRef, executionId, fencingVersion);
    const content = JSON.stringify({ execution_id: executionId, workspace_revision: metadata.workspace_revision, checkpoint }, null, 2);
    const checkpointHash = textHash(content);
    const ref = join(workspaceRef, META_DIR, 'checkpoints', `${checkpointRef}.json`);
    await writeFile(ref, content, 'utf8');
    const next = { ...metadata, checkpoint_ref: ref, checkpoint_hash: checkpointHash, updated_at: new Date().toISOString() };
    await this.#writeMetadata(workspaceRef, next);
    await this.#writeRevisionMetadata(workspaceRef, next);
    return { checkpoint_ref: ref, checkpoint_hash: checkpointHash, workspace_revision: metadata.workspace_revision };
  }

  async restoreWorkspace({ workspaceRef, executionId, fencingVersion = undefined }) {
    const metadata = await this.#readOwnedMetadata({ workspaceRef, executionId, fencingVersion });
    return this.#publicMetadata(metadata);
  }

  async #readOwnedMetadata({ workspaceRef, executionId, fencingVersion = undefined }) {
    const metadata = await this.#readMetadata(workspaceRef);
    if (metadata.execution_id !== executionId) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'workspace execution_id does not match');
    if (fencingVersion !== undefined && metadata.fencing_version !== fencingVersion) throw new SwarmEnvError(ERROR_CODES.FENCED, 'workspace fence is stale');
    return metadata;
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
      changed_files: revision.changed_files ?? [],
    }));
  }

  async releaseWorkspace({ workspaceRef, executionId, fencingVersion }) {
    const metadata = await this.#assertWritable(workspaceRef, executionId, fencingVersion);
    const next = { ...metadata, released_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    await this.#writeMetadata(workspaceRef, next);
    await this.#writeRevisionMetadata(workspaceRef, next);
    return this.#publicMetadata(next);
  }

  async fenceWorkspace({ workspaceRef, executionId, fencingVersion, newFencingVersion }) {
    const metadata = await this.#readMetadata(workspaceRef);
    if (metadata.execution_id !== executionId) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'workspace execution_id does not match');
    if (metadata.fencing_version !== fencingVersion) throw new SwarmEnvError(ERROR_CODES.FENCED, 'workspace fence is stale');
    if (!Number.isInteger(newFencingVersion) || newFencingVersion <= fencingVersion) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'new fencing version must increase');
    const next = { ...metadata, fencing_version: newFencingVersion, released_at: null, updated_at: new Date().toISOString() };
    await this.#writeMetadata(workspaceRef, next);
    await this.#writeRevisionMetadata(workspaceRef, next);
    return this.#publicMetadata(next);
  }

  async #assertWritable(workspaceRef, executionId, fencingVersion) {
    const metadata = await this.#readMetadata(workspaceRef);
    if (metadata.execution_id !== executionId) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'workspace execution_id does not match');
    if (metadata.fencing_version !== fencingVersion) throw new SwarmEnvError(ERROR_CODES.FENCED, 'workspace write uses an old fencing version');
    return metadata;
  }

  async #assertReadableFileTarget(target) {
    let info;
    try {
      info = await lstat(target);
    } catch (error) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `workspace file is unavailable: ${error.message}`, undefined, { cause: error });
    }
    if (info.isSymbolicLink()) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Workspace symbolic links are not readable');
    if (!info.isFile()) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Workspace path is not a regular file');
  }

  async #assertNoSymlinkAncestors(root, target) {
    let current = root;
    let rootInfo;
    try {
      rootInfo = await lstat(current);
    } catch (error) {
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
      } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `Workspace path cannot be inspected: ${error.message}`, undefined, { cause: error });
      }
      if (info.isSymbolicLink()) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Workspace symbolic links are not accessible');
      if (current !== target && !info.isDirectory()) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Workspace path parent is not a directory');
    }
  }

  async #assertWritableFileTarget(target) {
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Workspace symbolic links are not writable');
      if (!info.isFile()) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Workspace path is not a regular file');
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      if (error instanceof SwarmEnvError) throw error;
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `Workspace path cannot be written: ${error.message}`, undefined, { cause: error });
    }
  }

  async #revisionMetadata(metadata, revision) {
    if (!Number.isInteger(revision) || revision < 1 || revision > metadata.workspace_revision) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'workspace revision is outside the Workspace history');
    }
    if (revision === metadata.workspace_revision) return metadata;
    try {
      return JSON.parse(await readFile(join(metadata.workspace_ref, META_DIR, 'revisions', `${revision}.json`), 'utf8'));
    } catch (error) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `workspace revision is unavailable: ${error.message}`, undefined, { cause: error });
    }
  }

  async #writeRevisionSnapshot(workspaceRef, metadata) {
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

  async #writeRevisionMetadata(workspaceRef, metadata) {
    await writeFile(join(workspaceRef, META_DIR, 'revisions', `${metadata.workspace_revision}.json`), JSON.stringify(metadata, null, 2), 'utf8');
  }

  async #readMetadata(workspaceRef) {
    const resolvedWorkspace = this.#assertWorkspacePath(workspaceRef);
    await this.#assertNoSymlinkAncestors(this.rootDir, resolvedWorkspace);
    try {
      return JSON.parse(await readFile(join(resolvedWorkspace, META_DIR, META_FILE), 'utf8'));
    } catch (error) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `workspace metadata is unavailable: ${error.message}`, undefined, { cause: error });
    }
  }

  #assertWorkspacePath(workspaceRef) {
    requireString(workspaceRef, 'workspace_ref');
    const resolvedWorkspace = resolve(workspaceRef);
    if (resolvedWorkspace === this.rootDir || !resolvedWorkspace.startsWith(`${this.rootDir}/`)) {
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
      changed_files: metadata.changed_files ?? [],
      released_at: metadata.released_at,
    };
  }
}

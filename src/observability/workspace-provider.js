import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function publicWorkspace(metadata) {
  if (!metadata) return null;
  return {
    execution_id: metadata.execution_id,
    workspace_ref: metadata.workspace_ref,
    fencing_version: metadata.fencing_version,
    workspace_revision: metadata.workspace_revision,
    content_hash: metadata.content_hash,
    files: metadata.files ?? {},
    checkpoint_ref: metadata.checkpoint_ref ?? null,
    checkpoint_hash: metadata.checkpoint_hash ?? null,
    released_at: metadata.released_at ?? null,
    parent_workspace_ref: metadata.parent_workspace_ref ?? null,
    parent_workspace_revision: metadata.parent_workspace_revision ?? null,
    created_at: metadata.created_at ?? null,
    updated_at: metadata.updated_at ?? null,
  };
}

/**
 * Read-only Workspace projection for the operator UI. It only follows a
 * workspace_ref that was already emitted by the Runtime observation stream.
 */
export class FileWorkspaceProvider {
  constructor({ observationStore }) {
    if (!observationStore) throw new TypeError('FileWorkspaceProvider requires observationStore');
    this.observationStore = observationStore;
  }

  async get({ experimentId, executionId }) {
    const events = this.observationStore.listEvents({
      experimentId,
      executionId,
      kinds: ['execution_assigned', 'execution_observed', 'workspace_revision_saved'],
      limit: 1_000,
    }).events;
    const workspaceRef = [...events].reverse().map((event) => event.payload?.workspace_ref).find(Boolean);
    if (!workspaceRef) return null;
    const metadataPath = join(workspaceRef, '.swarm', 'workspace.json');
    const metadata = await readJson(metadataPath);
    const files = Object.entries(metadata.files ?? {}).map(([path, file]) => ({ path, type: 'file', ...file })).sort((a, b) => a.path.localeCompare(b.path));
    const revisionDir = join(workspaceRef, '.swarm', 'revisions');
    const revisionNames = (await readdir(revisionDir)).filter((name) => /^\d+\.json$/.test(name)).sort((a, b) => Number(a.slice(0, -5)) - Number(b.slice(0, -5)));
    const revisions = await Promise.all(revisionNames.map(async (name) => {
      const revision = await readJson(join(revisionDir, name));
      return {
        workspace_ref: revision.workspace_ref ?? workspaceRef,
        workspace_revision: revision.workspace_revision,
        content_hash: revision.content_hash,
        checkpoint_ref: revision.checkpoint_ref ?? null,
        checkpoint_hash: revision.checkpoint_hash ?? null,
        changed_files: revision.changed_files ?? [],
      };
    }));
    return { workspace: publicWorkspace(metadata), files, revisions };
  }
}

export function createFileWorkspaceProvider(options) {
  return new FileWorkspaceProvider(options);
}

/** Public Workspace argument mapping shared by the v1 and Core Flat adapters.
 * Callers own admission, Mission scope, cancellation and replay policy. */
export const MISSION_WORKSPACE_READS = Object.freeze({
  workspace_public_view: (workspace, input, signal) => workspace.get({ signal, workspaceId: input.workspace_id }),
  workspace_public_history: (workspace, input, signal) => workspace.history({ signal, workspaceId: input.workspace_id, all: input.all,
    sourceTask: input.producer_task_id, sourceExecution: input.producer_execution_id, materialId: input.material_id, path: input.path, limit: input.limit, cursor: input.cursor }),
  workspace_public_diff: (workspace, input, signal) => workspace.diff({ signal, workspaceId: input.workspace_id, from: input.from, to: input.to,
    prefix: input.path, limit: input.limit, cursor: input.cursor }),
  workspace_public_files: (workspace, input, signal) => workspace.files({ signal, workspaceId: input.workspace_id, revision: input.revision,
    prefix: input.path, limit: input.limit, cursor: input.cursor }),
  workspace_public_read: (workspace, input, signal) => workspace.read({ signal, workspaceId: input.workspace_id, revision: input.revision,
    path: input.path, maxBytes: input.max_bytes }),
  workspace_public_search: (workspace, input, signal) => workspace.search({ signal, workspaceId: input.workspace_id, revision: input.revision,
    prefix: input.path, query: input.query, maxResults: input.max_results, cursor: input.cursor }),
});

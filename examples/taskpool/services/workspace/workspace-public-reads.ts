/** Public Workspace argument mapping shared by the v1 Registry and TaskPool adapters.
 * Callers own admission, Mission scope, cancellation and replay policy. */
export const MISSION_WORKSPACE_READS = Object.freeze({
  workspace_public_view: (workspace: any, input: any, signal: any) => workspace.get({ signal, workspaceId: input.workspace_id }),
  workspace_public_history: (workspace: any, input: any, signal: any) => workspace.history({ signal, workspaceId: input.workspace_id, all: input.all,
    sourceTask: input.producer_task_id, sourceExecution: input.producer_execution_id, materialId: input.material_id, path: input.path, limit: input.limit, cursor: input.cursor }),
  workspace_public_diff: (workspace: any, input: any, signal: any) => workspace.diff({ signal, workspaceId: input.workspace_id, from: input.from, to: input.to,
    prefix: input.path, limit: input.limit, cursor: input.cursor }),
  workspace_public_files: (workspace: any, input: any, signal: any) => workspace.files({ signal, workspaceId: input.workspace_id, revision: input.revision,
    prefix: input.path, limit: input.limit, cursor: input.cursor }),
  workspace_public_read: (workspace: any, input: any, signal: any) => workspace.read({ signal, workspaceId: input.workspace_id, revision: input.revision,
    path: input.path, maxBytes: input.max_bytes }),
  workspace_public_search: (workspace: any, input: any, signal: any) => workspace.search({ signal, workspaceId: input.workspace_id, revision: input.revision,
    prefix: input.path, query: input.query, maxResults: input.max_results, cursor: input.cursor }),
});

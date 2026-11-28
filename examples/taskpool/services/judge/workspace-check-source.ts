import { createHash } from 'node:crypto';
import { ERROR_CODES, MurmError } from '../../errors.js';

/** Prepare only an immutable public revision; caller supplies its live domain guard. */
export async function prepareWorkspaceCheckSource(input: any, { workspace, workspaceId, projectCheck = false, guard }: any) {
  await guard();
  const allowed: any = new Set(['workspace_id', 'revision', 'path', 'request_key', 'check_mode']);
  const checkMode = input?.check_mode ?? 'lean-project';
  const hasPath = input?.path !== undefined;
  if (!input || !['lean-project', 'lean-module'].includes(checkMode) ||
      (checkMode === 'lean-module' && (!projectCheck || !hasPath || typeof input.path !== 'string' || !input.path.endsWith('.lean'))) ||
      Object.keys(input).some((key: any) => !allowed.has(key)) || !/^\d+\.\d+$/.test(input.revision ?? '') ||
      (!hasPath && !projectCheck) ||
      (hasPath && (typeof input.path !== 'string' || !input.path || input.path.startsWith('/') || input.path.includes('\\') || input.path.split('/').some((part: any) => !part || part === '.' || part === '..')))) {
    throw new MurmError(ERROR_CODES.INVALID_CONTRACT, projectCheck
      ? 'Judge check requires a fixed public revision and a valid optional file path; save the project first'
      : 'Judge check requires a fixed public revision and path; save the project first');
  }
  if (input.workspace_id !== undefined && input.workspace_id !== workspaceId) throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Judge input must belong to the Agent Mission Workspace');
  if (projectCheck) return { workspace_id: workspaceId, revision: input.revision,
    ...(hasPath ? { path: input.path } : {}), check_mode: checkMode };
  const snapshot = await workspace.exportRevision({ workspaceId, revision: input.revision });
  await guard();
  if (!Object.hasOwn(snapshot.files, input.path)) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Judge file is unavailable at the fixed public revision');
  const bytes = Buffer.from(snapshot.files[input.path]);
  const content = bytes.toString('utf8');
  if (!Buffer.from(content).equals(bytes) || bytes.includes(0)) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Configured source checker requires a complete UTF-8 text file');
  return { workspace_id: snapshot.workspace_id, revision: snapshot.revision, workspace_revision: snapshot.revision,
    path: input.path, content, content_hash: createHash('sha256').update(bytes).digest('hex'),
    git_commit: snapshot.git_commit, git_tree: snapshot.git_tree, tree_content_hash: snapshot.content_hash };
}

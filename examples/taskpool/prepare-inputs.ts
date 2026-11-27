import { createHash } from 'node:crypto';
import { stableStringify } from '../../src/protocol/envelope.js';
import { snapshotFileSeed } from '../../scripts/core-file-seed.js';
import { MurmError } from '../../src/errors.js';

const deny = (message: any) => { throw new MurmError('NOT_ALLOWED', message); };

/** TaskPool selects domain inputs; Core receives only their deterministic bytes. */
export async function prepareTaskPoolInputs({ execution, taskService, missionWorkspace, workspaceId, workspaceManager, contextService, preview, check }: any) {
  check();
  const task = taskService.getTask(execution.task_id);
  if (!task || execution.workspace_ref) deny('TaskPool preparation requires an unprepared Task Execution');
  const selectedWorkspace = task.workspace?.workspace_id ?? workspaceId;
  if (!selectedWorkspace || selectedWorkspace !== workspaceId) deny('Task Workspace must match the configured Mission Workspace');
  const snapshot = await missionWorkspace.exportRevision({ workspaceId: selectedWorkspace, revision: task.workspace?.revision ?? 'main', withModes: true });
  check();
  if (snapshot.mission_id !== task.mission_id || snapshot.workspace_id !== selectedWorkspace) deny('Task Workspace inputs belong to another Mission');
  const files = Object.create(null);
  for (const [path, content] of Object.entries((snapshot.files as Record<string, any>))) {
    if (!Buffer.isBuffer(content) && (typeof content !== 'string' || !content.isWellFormed())) deny('Public Workspace file content must be exact bytes or well-formed UTF-8 text');
    const bytes = Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(content, 'utf8');
    const expected = snapshot.manifest[path];
    if (expected?.bytes !== bytes.length || expected.content_hash !== createHash('sha256').update(bytes).digest('hex')) deny('Public Workspace bytes differ from the pinned manifest');
    files[path] = { encoding: 'base64', data: bytes.toString('base64'), mode: snapshot.file_modes?.[path] ?? 0o644 };
  }
  if (Object.keys(snapshot.files).length !== Object.keys(snapshot.manifest).length) deny('Public Workspace manifest is incomplete');
  const seed = snapshotFileSeed(files);
  const refs = execution.input_material_refs;
  if (refs.length && !contextService) deny('Task Materials require the authoritative Context Service');
  snapshot.material_inputs = refs.length ? contextService.readTakeMaterialInputs({ missionId: task.mission_id, materialIds: refs }) : [];
  const materials = snapshot.material_inputs.map((ref: any) => {
    const material = contextService.getMaterial(ref.material_id, { verifyIntegrity: true });
    if (!material || material.version !== ref.version || material.content_hash !== ref.content_hash) deny('Pinned Material changed during preparation');
    return { ...ref, content: structuredClone(material.content) };
  });
  snapshot.preview = preview ?? null;
  snapshot.preview_changed = preview ? preview.revision !== snapshot.revision : null;
  snapshot.reread_required = snapshot.preview_changed === true;
  if (snapshot.reread_required) {
    const diff = await missionWorkspace.diff({ workspaceId: selectedWorkspace, from: preview.revision, to: snapshot.revision, limit: 20 });
    check();
    snapshot.reread_notice = `Execution ${execution.execution_id} starts from ${snapshot.revision}, different from preview ${preview.revision}; reread the affected project files.`;
    snapshot.preview_diff = { from: diff.from.revision, to: diff.to.revision, changes: diff.changes, truncated: Boolean(diff.next_cursor), next_cursor: diff.next_cursor };
  }
  check();
  const workspace = await workspaceManager.createWorkspace({ executionId: execution.execution_id, fencingVersion: execution.fencing_version, task, publicSnapshot: snapshot });
  check();
  // The Workspace Manager verifies and publishes a fixed tree. Preserve that
  // exact input when heartbeat writes advance only the Execution CAS version.
  for (let attempt = 0; attempt < 3; attempt++) {
    check();
    const current = taskService.getExecution(execution.execution_id);
    try {
      taskService.dispatch('save_workspace_revision', { workspace_ref: workspace.workspace_ref,
        workspace_revision: workspace.workspace_revision, workspace_content_hash: workspace.content_hash,
        workspace_input: workspace.public_workspace_input }, executionEnvelope(current, `taskpool:workspace:${execution.execution_id}`));
      break;
    } catch (error: any) { if (error.code !== 'STALE_VERSION' || attempt === 2) throw error; }
  }
  return { files: seed.files, workspace, materials };
}

export function executionEnvelope(execution: any, operationId: any) {
  return { operation_id: operationId, actor_ref: 'taskpool:host', task_id: execution.task_id,
    execution_id: execution.execution_id, spec_version: execution.spec_version,
    state_version: execution.state_version, fencing_version: execution.fencing_version };
}

export function inputFingerprint(value: any) { return createHash('sha256').update(stableStringify(value)).digest('hex'); }

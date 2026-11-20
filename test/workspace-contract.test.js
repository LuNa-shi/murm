import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { SwarmEnvError } from '../src/errors.js';
import {
  WORKSPACE_ERROR_CODES,
  normalizeWorkspaceContract,
} from '../src/runtime/workspace-contract.js';
import { WorkspaceManager } from '../src/runtime/workspace-manager.js';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function withManager(run) {
  const rootDir = await mkdtemp('/tmp/swarmenv-workspace-contract-');
  const manager = new WorkspaceManager({ rootDir });
  try {
    return await run(manager, rootDir);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

test('Workspace contract normalizes required inputs and declared outputs', () => {
  const source = 'theorem input : True := by trivial\n';
  const contract = normalizeWorkspaceContract({
    problem_file: 'inputs/problem.lean',
    required_inputs: [{ path: 'inputs/problem.lean', content_hash: sha256(source) }],
    allowed_outputs: ['candidate.lean', { path: 'notes/route.md' }],
  });
  assert.deepEqual(contract.required_inputs, [{ path: 'inputs/problem.lean', content_hash: sha256(source) }]);
  assert.deepEqual(contract.allowed_outputs, [{ path: 'candidate.lean' }, { path: 'notes/route.md' }]);
  assert.deepEqual(contract.internal_runtime_outputs, ['.pi/settings.json']);
});

function snapshot(files) {
  return { files, manifest: Object.fromEntries(Object.entries(files).map(([path, content]) => [path, { content_hash: sha256(content), bytes: Buffer.byteLength(content) }])) };
}

test('Workspace Manager prepares required inputs only from an immutable public snapshot', async () => {
  await withManager(async manager => {
    const source = 'theorem input : True := by trivial\n';
    const task = { task_id: 'task-contract', workspace: {
      problem_file: 'inputs/problem.lean',
      required_inputs: [{ path: 'inputs/problem.lean', content_hash: sha256(source) }],
      allowed_outputs: ['candidate.lean'],
    } };
    const workspace = await manager.createWorkspace({ executionId: 'execution-contract', fencingVersion: 1,
      task, publicSnapshot: snapshot({ 'inputs/problem.lean': source }) });
    assert.deepEqual(workspace.workspace_contract.required_inputs, [{ path: 'inputs/problem.lean', content_hash: sha256(source) }]);
    const files = await manager.listFiles({ workspaceRef: workspace.workspace_ref, executionId: 'execution-contract', fencingVersion: 1 });
    assert.deepEqual(files.files.map(file => file.path), ['inputs/problem.lean']);
    await assert.rejects(manager.createWorkspace({ executionId: 'legacy-input', fencingVersion: 1, task }), /publicSnapshot is required/);
  });
});

test('missing required public input and hash mismatch reject before publishing a private directory', async () => {
  await withManager(async manager => {
    const task = { workspace: { required_inputs: [{ path: 'input.txt', content_hash: sha256('expected') }] } };
    await assert.rejects(manager.createWorkspace({ executionId: 'missing', fencingVersion: 1, task, publicSnapshot: snapshot({}) }),
      error => error instanceof SwarmEnvError && error.code === WORKSPACE_ERROR_CODES.INPUT_MISSING);
    await assert.rejects(manager.createWorkspace({ executionId: 'mismatched', fencingVersion: 1, task, publicSnapshot: snapshot({ 'input.txt': 'changed' }) }),
      error => error instanceof SwarmEnvError && error.code === WORKSPACE_ERROR_CODES.INPUT_HASH_MISMATCH);
  });
});

test('Workspace contract rejects paths addressing Runtime metadata or parent directories', () => {
  for (const path of ['../outside.txt', '.swarm/workspace.json']) {
    assert.throws(() => normalizeWorkspaceContract({ allowed_outputs: [path] }),
      error => error instanceof SwarmEnvError && error.code === 'NOT_ALLOWED' && error.details.path_class === 'forbidden');
  }
});

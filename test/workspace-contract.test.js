import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { SwarmEnvError } from '../src/errors.js';
import {
  WORKSPACE_ERROR_CODES,
  normalizeWorkspaceContract,
  workspaceCapabilityDescriptor,
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

test('Workspace contract classifies Runtime capability as bound-only', () => {
  const descriptor = workspaceCapabilityDescriptor();
  assert.equal(descriptor.id, 'runtime.workspace');
  assert.equal(descriptor.ownership, 'runtime');
  assert.deepEqual(descriptor.roles, ['bound', 'recovery']);
  assert.ok(descriptor.tools.includes('read_workspace_file'));
  assert.deepEqual(descriptor.path_classes, ['required_input', 'allowed_output', 'forbidden']);
});

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

test('Workspace Manager enforces required input and declared output path classes', async () => {
  await withManager(async (manager) => {
    const source = 'theorem input : True := by trivial\n';
    const task = {
      task_id: 'task-contract',
      root_id: 'task-contract',
      task_type: 'proof',
      goal: 'workspace contract',
      expected_output: 'candidate',
      acceptance_conditions: {},
      workspace: {
        problem_file: 'inputs/problem.lean',
        formal_source: source,
        required_inputs: [{ path: 'inputs/problem.lean', content_hash: sha256(source) }],
        allowed_outputs: ['candidate.lean', 'notes/route.md'],
      },
    };
    const workspace = await manager.createWorkspace({
      executionId: 'execution-contract',
      fencingVersion: 1,
      task,
      workspaceManifest: {},
      inputSnapshotManifest: {},
    });
    assert.deepEqual(workspace.workspace_contract.required_inputs, [{ path: 'inputs/problem.lean', content_hash: sha256(source) }]);
    assert.deepEqual(workspace.workspace_contract.allowed_outputs, [{ path: 'candidate.lean' }, { path: 'notes/route.md' }]);

    const files = await manager.listFiles({
      workspaceRef: workspace.workspace_ref,
      executionId: 'execution-contract',
      fencingVersion: 1,
    });
    assert.equal(files.workspace_contract.allowed_outputs[0].path, 'candidate.lean');
    assert.ok(files.files.some((file) => file.path === 'inputs/problem.lean'));
    const input = await manager.readWorkspaceFile({
      workspaceRef: workspace.workspace_ref,
      executionId: 'execution-contract',
      fencingVersion: 1,
      path: 'inputs/problem.lean',
    });
    assert.equal(input.content, source);

    await assert.rejects(
      () => manager.saveWorkspaceRevision({
        workspaceRef: workspace.workspace_ref,
        executionId: 'execution-contract',
        fencingVersion: 1,
        expectedRevision: 1,
        files: { 'inputs/problem.lean': 'mutated' },
      }),
      (error) => error instanceof SwarmEnvError
        && error.code === WORKSPACE_ERROR_CODES.INPUT_READ_ONLY
        && error.details.path_class === 'required_input'
        && /separate declared output/i.test(error.details.remediation),
    );

    await assert.rejects(
      () => manager.saveWorkspaceRevision({
        workspaceRef: workspace.workspace_ref,
        executionId: 'execution-contract',
        fencingVersion: 1,
        expectedRevision: 1,
        files: { 'undeclared.txt': 'not allowed' },
      }),
      (error) => error instanceof SwarmEnvError
        && error.code === WORKSPACE_ERROR_CODES.OUTPUT_NOT_DECLARED
        && error.details.path === 'undeclared.txt'
        && /allowed_outputs/i.test(error.details.remediation),
    );

    const next = await manager.saveWorkspaceRevision({
      workspaceRef: workspace.workspace_ref,
      executionId: 'execution-contract',
      fencingVersion: 1,
      expectedRevision: 1,
      files: { 'candidate.lean': 'theorem candidate : True := by trivial\n' },
    });
    assert.equal(next.workspace_revision, 2);
    const candidate = await manager.readWorkspaceFile({
      workspaceRef: workspace.workspace_ref,
      executionId: 'execution-contract',
      fencingVersion: 1,
      path: 'candidate.lean',
    });
    assert.equal(candidate.path, 'candidate.lean');
    assert.equal(candidate.workspace_revision, 2);
    assert.equal(candidate.content_hash, sha256(candidate.content));
  });
});

test('missing required input is a contract blocker while missing output is not classified as input failure', async () => {
  await withManager(async (manager) => {
    await assert.rejects(
      () => manager.createWorkspace({
        executionId: 'execution-missing-input',
        fencingVersion: 1,
        task: {
          task_id: 'task-missing-input',
          root_id: 'task-missing-input',
          task_type: 'research',
          goal: 'missing fixture',
          expected_output: 'notes',
          acceptance_conditions: {},
          workspace: { required_inputs: ['fixture/input.txt'], allowed_outputs: ['notes.md'] },
        },
        workspaceManifest: {},
        inputSnapshotManifest: {},
      }),
      (error) => error instanceof SwarmEnvError
        && error.code === WORKSPACE_ERROR_CODES.INPUT_MISSING
        && error.details.path === 'fixture/input.txt'
        && /fixture|manifest/i.test(error.details.remediation),
    );

    const workspace = await manager.createWorkspace({
      executionId: 'execution-output',
      fencingVersion: 1,
      task: {
        task_id: 'task-output',
        root_id: 'task-output',
        task_type: 'research',
        goal: 'declared output',
        expected_output: 'notes',
        acceptance_conditions: {},
        workspace: { allowed_outputs: ['notes.md'] },
      },
      workspaceManifest: {},
      inputSnapshotManifest: {},
    });
    await assert.rejects(
      () => manager.readWorkspaceFile({
        workspaceRef: workspace.workspace_ref,
        executionId: 'execution-output',
        fencingVersion: 1,
        path: 'notes.md',
      }),
      (error) => error instanceof SwarmEnvError
        && error.code !== WORKSPACE_ERROR_CODES.INPUT_MISSING,
    );
  });
});

test('Workspace contract keeps parent and Runtime metadata paths typed and forbidden', async () => {
  await withManager(async (manager) => {
    const task = {
      task_id: 'task-forbidden',
      root_id: 'task-forbidden',
      task_type: 'research',
      goal: 'forbidden paths',
      expected_output: 'notes',
      acceptance_conditions: {},
      workspace: { allowed_outputs: ['notes.md'] },
    };
    await assert.rejects(
      () => manager.createWorkspace({
        executionId: 'execution-forbidden',
        fencingVersion: 1,
        task: { ...task, workspace: { ...task.workspace, allowed_outputs: ['../outside.txt'] } },
        workspaceManifest: {},
        inputSnapshotManifest: {},
      }),
      (error) => error instanceof SwarmEnvError
        && error.code === 'NOT_ALLOWED'
        && error.details.path_class === 'forbidden'
        && Boolean(error.details.remediation),
    );
  });
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ServicesBridge } from '../src/agent/services-bridge.js';
import { JudgeService } from '../src/judge/judge-service.js';
import { createBuiltinServiceRegistry } from '../src/sdk/builtin-registry.js';

const fixture = {
  fixture_id: 'direct-submit-test',
  putnambench_commit: 'a'.repeat(40),
  problem_file: 'src/problem.lean',
  problem_file_hash: 'b'.repeat(64),
  lean_toolchain: 'leanprover/lean4:v4.33.1',
  mathlib_version: 'test-mathlib',
  checker_ref: 'lean',
  checker_version: 'mvp-1',
  environment_ref: 'env:test',
  project_root: '/tmp/direct-submit-test',
};

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function setup() {
  const task = {
    task_id: 'task:direct-submit',
    mission_id: 'mission:direct-submit',
    spec_version: 1,
    workspace: { input_metadata: fixture },
    completion_contract: {},
  };
  const execution = {
    execution_id: 'execution:direct-submit',
    task_id: task.task_id,
    spec_version: 1,
    state_version: 1,
    fencing_version: 1,
    input_snapshot_hash: 'input-snapshot',
    workspace_ref: 'workspace://direct-submit',
    workspace_revision: 1,
    state: 'RUNNING',
  };
  let content = 'theorem invalid : True := by exact nope';
  let checks = 0;
  const judge = new JudgeService(new DatabaseSync(':memory:'), {
    fixtureManifest: fixture,
    checker: {
      preflight: async () => ({
        status: 'healthy',
        checker_process_status: 'completed',
        evidence: { input_binding_verified: true, toolchain_version_verified: true, checker_version_verified: true },
      }),
      check: async ({ workspace_source }) => {
        checks += 1;
        return workspace_source.content.includes('valid-proof')
          ? { verdict: 'PASS', evidence: { checker_started: true, exit_code: 0 } }
          : { verdict: 'FAIL', evidence: { checker_started: true, exit_code: 1, diagnostic: 'type mismatch' } };
      },
    },
  });
  const taskService = {
    getTask: (taskId) => taskId === task.task_id ? task : null,
    getExecution: (executionId) => executionId === execution.execution_id ? execution : null,
    dispatch: () => { throw new Error('Task Service must not relay direct Workspace check'); },
  };
  const contextService = {};
  const registry = createBuiltinServiceRegistry({ taskService, contextService, judgeService: judge });
  const runtime = {
    readWorkspaceFile: async () => ({
      workspace_revision: content.includes('valid-proof') ? 2 : 1,
      content,
      content_hash: sha256(content),
    }),
  };
  const bridge = new ServicesBridge({
    taskService,
    contextService,
    runtime,
    registry,
    taskId: task.task_id,
    executionId: execution.execution_id,
    actorRef: 'agent:direct-submit',
  });
  return {
    task,
    execution,
    judge,
    bridge,
    setContent(value) { content = value; },
    getChecks() { return checks; },
  };
}

test('direct Workspace check checks a Workspace file and supports same-Execution revision', async () => {
  const state = setup();
  try {
    const failed = await state.bridge.call({ operation: 'workspace_check', payload: { path: 'workspace/proof.lean', workspace_revision: 1 } });
    assert.equal(failed.verdict, 'FAIL');
    assert.equal(failed.result_class, 'source_failure');
    assert.match(failed.diagnostic_excerpt, /type mismatch/);

    state.setContent('theorem valid-proof : True := by trivial');
    const passed = await state.bridge.call({ operation: 'workspace_check', payload: { path: 'workspace/proof.lean', workspace_revision: 2 } });
    assert.equal(passed.verdict, 'PASS');
    assert.equal(passed.result_class, 'PASS');
    assert.equal(state.getChecks(), 2);
  } finally {
    await state.bridge.stop();
    state.judge.close();
  }
});

test('direct Workspace check rejects a stale Workspace revision before checking', async () => {
  const state = setup();
  try {
    await assert.rejects(
      () => state.bridge.call({ operation: 'workspace_check', payload: { path: 'workspace/proof.lean', workspace_revision: 99 } }),
      (error) => error.code === 'STALE_VERSION',
    );
    assert.equal(state.getChecks(), 0);
  } finally {
    await state.bridge.stop();
    state.judge.close();
  }
});

test('direct Judge binds a transport request key to the submitted source', async () => {
  const state = setup();
  try {
    const first = await state.bridge.call({
      operation: 'workspace_check',
      operation_id: 'direct-submit-idempotency',
      payload: { path: 'workspace/proof.lean', workspace_revision: 1 },
    });
    assert.equal(first.verdict, 'FAIL');
    state.setContent('theorem valid-proof-changed : True := by trivial');
    await assert.rejects(
      () => state.bridge.call({
        operation: 'workspace_check',
        operation_id: 'direct-submit-idempotency',
        payload: { path: 'workspace/proof.lean', workspace_revision: 2 },
      }),
      (error) => error.code === 'CONFLICT',
    );
  } finally {
    await state.bridge.stop();
    state.judge.close();
  }
});

test('direct Workspace check is idempotent and rejects unsafe paths or hashes', async () => {
  const state = setup();
  try {
    await assert.rejects(
      () => state.bridge.call({ operation: 'workspace_check', payload: { path: '../workspace/proof.lean' } }),
      (error) => error.code === 'INVALID_CONTRACT',
    );
    await assert.rejects(
      () => state.bridge.call({ operation: 'workspace_check', payload: { path: 'workspace/proof.lean', content_hash: 'wrong' } }),
      (error) => error.code === 'STALE_VERSION',
    );
    const first = await state.bridge.call({ operation: 'workspace_check', payload: { path: 'workspace/proof.lean', workspace_revision: 1 } });
    const replay = await state.bridge.call({ operation: 'workspace_check', payload: { path: 'workspace/proof.lean', workspace_revision: 1 } });
    assert.equal(replay.check_result_id, first.check_result_id);
    assert.equal(state.getChecks(), 1);
  } finally {
    await state.bridge.stop();
    state.judge.close();
  }
});

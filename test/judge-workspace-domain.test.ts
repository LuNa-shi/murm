import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ContextService } from '../examples/taskpool/services/material/context-service.js';
import { JudgeService } from '../examples/taskpool/services/judge/judge-service.js';
import { LeanChecker } from '../examples/taskpool/services/judge/lean-adapter.js';
import { makeEnvelope } from '../examples/taskpool/persistence/envelope.js';
import { MissionWorkspace } from '../examples/taskpool/services/workspace/mission-workspace.js';
import { WorkspaceManager } from '../examples/taskpool/services/workspace/workspace-manager.js';
import { TaskService } from '../examples/taskpool/services/task/task-service.js';
import { prepareTaskPoolInputs } from '../examples/taskpool/harness/prepare-inputs.js';

const checkerIdentity = { checker_ref: 'lean', checker_version: 'test', environment_ref: 'test-project' };
const initialFiles = {
  'input.txt': 'public project input',
  'Proof.lean': 'import Helper\n/- No axiom. /- No admit. -/ -/\ntheorem proof : True := helper -- no sorry',
  'Helper.lean': 'theorem helper : True := True.intro',
};

async function fixture(t, { sourceFile = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'judge-workspace-domain-'));
  const tasks = new TaskService(join(root, 'tasks.sqlite'));
  const context = new ContextService(':memory:', { taskService: tasks });
  let judge;
  t.after(async () => {
    await judge?.waitForIdle();
    judge?.close();
    context.close();
    tasks.close();
    await rm(root, { recursive: true, force: true });
  });
  const missionId = 'mission:judge-domain';
  const workspaceId = 'judge-public';
  tasks.createMission({ mission_id: missionId, goal: 'Check immutable public project delivery' }, makeEnvelope({ actorRef: 'operator:test' }));
  const workspace = new MissionWorkspace({ rootDir: join(root, 'public') });
  await workspace.create({ missionId, workspaceId, initialFiles });
  const manager = new WorkspaceManager({ rootDir: join(root, 'private') });
  const agent = tasks.registerAgent({ missionId, coreId: 'judge-domain-slot', selectionDeadline: new Date(Date.now() + 60_000).toISOString() });
  tasks.recordAgentSandbox(agent.agent_id, { provider: 'controlled', sandboxId: 'no-physical-resource' });
  tasks.markAgentReady(agent.agent_id);
  const task = tasks.createTask({ mission_id: missionId, summary: 'Deliver the checked proof',
    expected_output: 'A fixed public proof', acceptance_conditions: ['Fixed tree verified'],
    completion_contract: { workspace_delivery: { paths: ['Proof.lean'], check: checkerIdentity } },
  }, makeEnvelope({ actorRef: 'operator:test' })).task;
  let execution = tasks.takeTask(task.task_id, { owner_ref: agent.agent_id, core_id: agent.core_id, take_key: 'domain-take' }).execution;
  const envelope = operationId => {
    const current = tasks.getExecution(execution.execution_id);
    return makeEnvelope({ operationId, actorRef: agent.agent_id, taskId: task.task_id, executionId: current.execution_id,
      specVersion: current.spec_version, stateVersion: current.state_version, fencingVersion: current.fencing_version });
  };
  await prepareTaskPoolInputs({ execution, taskService: tasks, missionWorkspace: workspace, workspaceId,
    workspaceManager: manager, contextService: context, check() {} });
  execution = tasks.dispatch('start_execution', {}, envelope('domain-start')).execution;
  const builds = [];
  const checker = new LeanChecker({ projectChecker: async ({ files, tree, path, checkMode, missionId, startProcess }) => {
    if (Object.hasOwn(files, 'Outside.lean')) return { verdict: 'FAIL', diagnostic: 'Lean source is outside the project source directory' };
    return startProcess(async () => {
      builds.push({ files, tree, path, checkMode, missionId });
      return { verdict: 'PASS', checked_tree: tree,
        ...(checkMode === 'lean-module' ? { scope: 'module', requested_path: path } : {}),
        checked_paths: ['Helper.lean', 'Proof.lean'], warnings: ['Helper.lean: provisional proof'] };
    });
  } });
  checker.preflight = async () => ({ status: 'healthy', checker_process_status: 'completed',
    evidence: { input_binding_verified: true, toolchain_version_verified: true, checker_version_verified: true } });
  const sourceChecker = { preflight: checker.preflight, check: async input => {
    builds.push(input);
    return { verdict: 'PASS', evidence: { checker_started: true, exit_code: 0,
      private_internal_field: 'private checker stream', diagnostic: 'verified input' } };
  } };
  const judgeOptions = { taskService: tasks, checker: sourceFile ? sourceChecker : checker,
    readProjectRevision: sourceFile ? null : reference => workspace.exportRevision(reference),
    fixtureManifest: { fixture_id: 'project-source', fixture_commit: 'a'.repeat(40), problem_file: 'input.txt',
      problem_file_hash: 'b'.repeat(64), lean_toolchain: 'leanprover/lean4:v4.33.1', mathlib_version: 'test', ...checkerIdentity } };
  const openJudge = () => {
    judge = new JudgeService(join(root, 'judge.sqlite'), judgeOptions);
    tasks.setCheckResultReader(id => judge.getCheckResult(id));
    return judge;
  };
  openJudge();
  tasks.setWorkspaceDeliveryReader(reference => workspace.readDeliveryRevision(reference));
  const check = async (revision, requestId, path, checkMode = 'lean-project') => {
    let source = { workspace_id: workspaceId, revision, ...(path === undefined ? {} : { path }), check_mode: checkMode };
    if (sourceFile) {
      const snapshot = await workspace.exportRevision({ workspaceId, revision });
      const content = String(snapshot.files[path]);
      source = { workspace_id: workspaceId, revision, workspace_revision: revision, path, content,
        content_hash: createHash('sha256').update(content).digest('hex'),
        git_commit: snapshot.git_commit, git_tree: snapshot.git_tree, tree_content_hash: snapshot.content_hash };
    }
    const result = await judge.checkWorkspaceSource({ request_key: requestId, source }, envelope(requestId));
    return judge.getAgentCheckResult(result.check_result_id);
  };
  const save = (files, requestId) => workspace.save({ workspaceId, baseRevision: '0.1', files, requestId,
    source: { mission_id: missionId, task_id: task.task_id, execution_id: execution.execution_id,
      agent_id: agent.agent_id, fencing_version: execution.fencing_version, operation: 'save' } });
  const finish = (revision, checkId, requestId) => tasks.dispatch('task_finish', {
    outcome: 'done', workspace_revision: revision, check_result_id: checkId,
  }, envelope(requestId));
  return { tasks, workspace, workspaceId, execution, builds, check, save, finish,
    judge: () => judge, reopenJudge() { judge.close(); return openJudge(); } };
}

test('Judge domain checks immutable public project and module bytes and persists safe receipts', async t => {
  const f = await fixture(t);
  const saved = await f.save(initialFiles, 'fixed-project');
  await writeFile(join(f.execution.workspace_ref, 'Helper.lean'), 'unsaved private edit');
  const project = await f.check(saved.revision, 'project-check');
  assert.equal(project.verdict, 'PASS');
  assert.equal(project.mathematical_outcome, 'unassessed');
  assert.equal(project.workspace_input.git_tree, saved.git_tree);
  assert.equal(project.workspace_input.check_mode, 'lean-project');
  assert.equal(project.workspace_input.path, undefined);
  assert.deepEqual(project.build, { scope: 'project', requested_path: null, cache: null, checked_paths_truncated: false,
    checked_count: 2, checked_paths: ['Helper.lean', 'Proof.lean'], warnings: ['Helper.lean: provisional proof'] });
  assert.equal(String(f.builds[0].files['Helper.lean']), initialFiles['Helper.lean']);
  assert.equal(f.builds[0].tree, saved.git_tree);
  assert.equal(project.evidence, undefined);
  assert.doesNotMatch(JSON.stringify(project), /private checker stream/);
  assert.deepEqual(f.judge().getAgentCheckResult(project.check_result_id), project);
  assert.deepEqual(await f.check(saved.revision, 'project-check'), project);
  assert.equal(f.builds.length, 1);
  assert.throws(() => f.finish(saved.revision, project.check_result_id, 'finish-project'), /did not pass for this delivery/);

  const scoped = await f.check(saved.revision, 'delivery-check', 'Proof.lean');
  assert.equal(scoped.workspace_input.path, 'Proof.lean');
  assert.equal(scoped.workspace_input.git_tree, saved.git_tree);
  assert.equal(scoped.workspace_input.content_hash, createHash('sha256').update(initialFiles['Proof.lean']).digest('hex'));
  assert.equal(String(f.builds[1].files['Helper.lean']), String(f.builds[0].files['Helper.lean']));
  const alias = await f.check(saved.revision, 'delivery-alias', 'Proof.lean');
  assert.equal(alias.check_result_id, scoped.check_result_id);
  assert.equal(f.builds.length, 2);
  const module = await f.check(saved.revision, 'module-check', 'Proof.lean', 'lean-module');
  assert.equal(module.workspace_input.check_mode, 'lean-module');
  assert.equal(module.build.scope, 'module');
  assert.equal(module.build.requested_path, 'Proof.lean');
  assert.equal(module.mathematical_outcome, 'unassessed');
  assert.deepEqual(f.judge().dispatch('get_check_result', { request_key: 'module-check' }, makeEnvelope({ actorRef: 'operator:test' })), module);
  assert.equal(f.builds.at(-1).checkMode, 'lean-module');
  assert.equal(f.builds.at(-1).missionId, f.tasks.getTask(f.execution.task_id).mission_id);
  assert.throws(() => f.finish(saved.revision, module.check_result_id, 'finish-module'), /did not pass for this delivery/);
  await assert.rejects(f.check(saved.revision, 'missing-module-path', undefined, 'lean-module'), { code: 'INVALID_CONTRACT' });

  const receipt = f.judge().getByRequestKey('delivery-alias');
  assert.equal(receipt.target_task_id, f.execution.task_id);
  assert.equal(receipt.execution_id, f.execution.execution_id);
  assert.equal(receipt.evidence.workspace_input.git_tree, saved.git_tree);
  f.reopenJudge();
  assert.deepEqual(f.judge().dispatch('get_check_result', { request_key: 'delivery-alias' }, makeEnvelope({ actorRef: 'operator:test' })), scoped);
  assert.deepEqual(await f.check(saved.revision, 'delivery-alias', 'Proof.lean'), scoped);
  assert.equal(f.builds.length, 3);
  await assert.rejects(f.check('0.1', 'delivery-alias', 'Proof.lean'), { code: 'CONFLICT' });
});

test('Judge domain records public project input failures as readable receipts', async t => {
  const f = await fixture(t);
  const changed = { ...initialFiles, notes: 'containing project' };
  const partial = await f.save({ ...changed, 'lakefile.lean': '-- Candidate Lake configuration is ignored',
    'Helper.lean': 'theorem helper : True := by sorry' }, 'rejected-paths');
  const observedFailure = async (path, revision, diagnosticCode) => {
    const result = await f.check(revision, diagnosticCode, path);
    assert.equal(result.result_class, 'request_failure');
    assert.equal(result.diagnostic_code, diagnosticCode);
    assert.deepEqual(f.judge().getAgentCheckResult(result.check_result_id), result);
  };
  await observedFailure('lakefile.lean', partial.revision, 'project_path_uncovered');
  await observedFailure('Helper.lean', partial.revision, 'forbidden_placeholder');
  const invalid = await f.save({ ...changed, 'Outside.lean': 'theorem outside : True := True.intro' }, 'invalid-layout');
  await observedFailure('Proof.lean', invalid.revision, 'project_input_invalid');
});

test('Task delivery rejects a public source PASS from another containing tree of the same file', async t => {
  const f = await fixture(t, { sourceFile: true });
  const files = { ...initialFiles, 'Proof.lean': 'theorem local : True := by trivial' };
  const before = await f.save(files, 'delivery-before');
  const first = await f.check(before.revision, 'before-check', 'Proof.lean');
  assert.equal(first.verdict, 'PASS');
  assert.equal(f.builds[0].workspace_source.content, files['Proof.lean']);
  assert.equal(f.judge().getCheckResult(first.check_result_id).evidence.private_internal_field, 'private checker stream');
  assert.equal(first.evidence, undefined);
  assert.doesNotMatch(JSON.stringify(first), /private checker stream/);
  const after = await f.save({ ...files, notes: 'changed the containing tree' }, 'delivery-after');
  assert.throws(() => f.finish(after.revision, first.check_result_id, 'wrong-tree-finish'), /did not pass for this delivery/);
  const second = await f.check(after.revision, 'after-check', 'Proof.lean');
  assert.equal(second.verdict, 'PASS');
  assert.notEqual(second.check_result_id, first.check_result_id);
  assert.notEqual(after.git_tree, before.git_tree);
  assert.equal(second.workspace_input.content_hash, first.workspace_input.content_hash);
  assert.equal(second.workspace_input.git_tree, after.git_tree);
  assert.equal(f.finish(after.revision, second.check_result_id, 'valid-finish').workspace_delivery.check.checked_tree, after.git_tree);
});

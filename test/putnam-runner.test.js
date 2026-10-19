import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { runBenchmarkBatch, runBenchmarkProject, validateBenchmarkReport } from '../src/benchmark/putnam-runner.js';

const source = 'import Mathlib\ntheorem benchmark : True := by\n  sorry\n';
const config = {
  putnambench_commit: 'a635813f5edf297d928f9bd5ef8324a26bdde09c',
  lean_project_root: '/tmp/putnambench-test-lean',
  checker_ref: 'lean',
  checker_version: 'mvp-1',
  environment_ref: 'putnambench-lean4@test',
  lean_toolchain: 'leanprover/lean4:v4.33.1',
  mathlib_version: 'test-mathlib',
};
function problem(id) {
  return {
    id,
    problem_file: `lean4/src/${id}.lean`,
    source,
    source_hash: 'a'.repeat(64),
    tags: ['test'],
  };
}

class FakeSession extends EventEmitter {
  constructor(env, cheat = false, noWork = false, fileCandidate = false, invalidClaim = false) {
    super();
    this.env = env;
    this.cheat = cheat;
    this.noWork = noWork;
    this.fileCandidate = fileCandidate;
    this.invalidClaim = invalidClaim;
    this.invalidClaimUsed = false;
    this.rpcRecords = [];
    this.closed = false;
  }

  async waitForReady() {}

  async prompt() {
    if (this.noWork) return { data: { disposition: 'handled' } };
    const call = async (operation, payload) => {
      this.rpcRecords.push({ type: 'tool_call', tool_name: 'swarmenv_call' });
      const response = await fetch(`${this.env.SWARMENV_BRIDGE_URL}/call`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.env.SWARMENV_BRIDGE_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ operation, payload }),
      });
      const body = await response.json();
      if (!body.ok) {
        const error = new Error(body.error?.message ?? 'fake bridge call failed');
        error.code = body.error?.code;
        throw error;
      }
      this.rpcRecords.push({ type: 'tool_result', tool_name: 'swarmenv_call' });
      return body.result;
    };
    await call('list_services', {});
    await call('list_tools', {});
    let tasks = await call('list_tasks', { limit: 10 });
    if (tasks.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      tasks = await call('list_tasks', { limit: 10 });
    }
    if (tasks.length === 0) return { data: { disposition: 'handled' } };
    if (this.invalidClaim && !this.invalidClaimUsed) {
      this.invalidClaimUsed = true;
      try {
        await call('claim', {
          task_id: tasks[0].task_id,
          claim_key: `fake-invalid-claim-${this.env.SWARMENV_BRIDGE_TOKEN}`,
          workspace_mode: 'clean',
          workspace_revision: 1,
        });
      } catch (error) {
        assert.equal(error.code, 'INVALID_CONTRACT');
        return { data: { disposition: 'handled' } };
      }
    }
    let claim;
    try {
      claim = await call('claim', {
        task_id: tasks[0].task_id,
        claim_key: `fake-claim-${this.env.SWARMENV_BRIDGE_TOKEN}`,
        workspace_mode: 'clean',
      });
    } catch {
      this.invalidClaimUsed = true;
      tasks = await call('list_tasks', { limit: 10 });
      if (tasks.length === 0) return { data: { disposition: 'handled' } };
      claim = await call('claim', {
        task_id: tasks[0].task_id,
        claim_key: `fake-claim-${this.env.SWARMENV_BRIDGE_TOKEN}`,
        workspace_mode: 'clean',
      });
    }
    await call('get_task', {});
    await call('get_execution', {});
    const currentWorkspace = await call('get_workspace', {});
    const baselineRevision = currentWorkspace.workspace.workspace_revision;
    await call('list_workspace_files', {});
    await call('read_workspace_file', { path: 'README.md' });
    await call('write_workspace_file', {
      path: `agent-${this.env.SWARMENV_BRIDGE_TOKEN}.md`,
      content: `Agent ${this.env.SWARMENV_BRIDGE_TOKEN} inspected the Workspace.\n`,
      expected_revision: baselineRevision,
    });
    await call('workspace_diff', { from_revision: baselineRevision, to_revision: baselineRevision + 1 });
    let candidateContent = this.cheat ? 'by sorry' : 'def benchmarkRootArtifact : Nat := 0';
    if (this.fileCandidate) {
      const candidatePath = 'candidate.lean';
      const candidateWrite = await call('write_workspace_file', {
        path: candidatePath,
        content: 'import Mathlib\ntheorem workspace_candidate : True := by trivial\n',
        expected_revision: baselineRevision + 1,
      });
      candidateContent = {
        path: candidatePath,
        workspace_revision: candidateWrite.workspace.workspace_revision,
        content_hash: candidateWrite.file.content_hash,
        description: 'candidate metadata mentions sorry but the Workspace source is clean',
      };
    }
    if (claim.task.parent_id === null) {
      await call('create_child_task', {
        child_creation_key: `fake-child-${this.env.SWARMENV_BRIDGE_TOKEN}`,
        task_type: 'proof',
        goal: 'Produce a real Lean proof candidate for the current problem',
        expected_output: 'A compiled Lean source with no placeholders',
        acceptance_conditions: { source_hash: 'a'.repeat(64) },
        priority: 100,
        completion_contract: {
          required_candidate: { kind: 'artifact', scope: 'proof_relevant' },
          required_check: { checker_ref: 'lean', checker_version: 'mvp-1', environment_ref: 'putnambench-lean4@test' },
        },
      });
      await call('create_child_task', {
        child_creation_key: `fake-research-${this.env.SWARMENV_BRIDGE_TOKEN}`,
        task_type: 'research',
        goal: 'Research a reusable lemma or proof route for the current problem',
        expected_output: 'A shared research Material',
        acceptance_conditions: { source_hash: 'a'.repeat(64) },
        priority: 90,
      });
      const material = await call('publish_material', {
        kind: 'artifact',
        scope: 'proof_relevant',
        content: candidateContent,
      });
      await call('submit_candidate', { candidate_material_id: material.material.material_id });
      return { data: { disposition: 'handled' } };
    }
    await call('read_materials', {});
    const material = await call('publish_material', {
      kind: 'artifact',
      scope: 'proof_relevant',
      content: this.fileCandidate ? {
        path: 'candidate.lean',
        workspace_revision: baselineRevision + 1,
        description: 'candidate metadata mentions sorry but the Workspace source is clean',
      } : (this.cheat ? 'by sorry' : 'def benchmarkArtifact : Nat := 0'),
    });
    await call('submit_candidate', { candidate_material_id: material.material.material_id });
    return { data: { disposition: 'handled' } };
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.emit('close', { code: 0, signal: 'SIGTERM' }));
  }
}

class FakeAdapter {
  constructor({ env, cheat = false, noWork = false, fileCandidate = false, invalidClaim = false }) {
    this.env = env;
    this.cheat = cheat;
    this.noWork = noWork;
    this.fileCandidate = fileCandidate;
    this.invalidClaim = invalidClaim;
    this.starts = [];
  }

  async start(options = {}) {
    this.starts.push(options);
    const { logger } = options;
    logger?.append({ type: 'fake-agent-start' });
    const isWorkerSession = String(options.executionId ?? '').startsWith('worker-');
    const session = new FakeSession(this.env, this.cheat, this.noWork, this.fileCandidate, this.invalidClaim && isWorkerSession);
    session.manifest = { fake: true, pi_version: 'fake' };
    return session;
  }
}

class CollaborationSession extends EventEmitter {
  constructor(adapter, options) {
    super();
    this.adapter = adapter;
    this.options = options;
    this.rpcRecords = [];
    this.closed = false;
    this.bound = !String(options.executionId ?? '').startsWith('worker-');
  }

  async waitForReady() {}

  async call(operation, payload = {}) {
    this.rpcRecords.push({ type: 'tool_call', tool_name: 'swarmenv_call' });
    const response = await fetch(`${this.adapter.env.SWARMENV_BRIDGE_URL}/call`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.adapter.env.SWARMENV_BRIDGE_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ operation, payload }),
    });
    const body = await response.json();
    this.rpcRecords.push({ type: 'tool_result', tool_name: 'swarmenv_call' });
    if (!body.ok) throw new Error(body.error?.message ?? `${operation} failed`);
    return body.result;
  }

  async waitForTask(predicate) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const tasks = await this.call('list_tasks', { limit: 100 });
      const match = tasks.find(predicate);
      if (match) return match;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    return null;
  }

  async claimTask(task) {
    this.adapter.claimSequence += 1;
    return this.call('claim', {
      task_id: task.task_id,
      claim_key: `collaboration-claim-${this.adapter.role}-${this.adapter.claimSequence}`,
      workspace_mode: 'resume',
    });
  }

  async workClaimedTask() {
    await this.call('get_task', {});
    await this.call('get_execution', {});
    const currentWorkspace = await this.call('get_workspace', {});
    const baselineRevision = currentWorkspace.workspace.workspace_revision;
    await this.call('list_workspace_files', {});
    await this.call('read_workspace_file', { path: 'README.md' });
    await this.call('write_workspace_file', {
      path: `notes/${this.adapter.role}.md`,
      content: `${this.adapter.role} made an auditable Workspace contribution.\n`,
      expected_revision: baselineRevision,
    });
    await this.call('workspace_diff', { from_revision: baselineRevision, to_revision: baselineRevision + 1 });
  }

  async prompt() {
    if (!this.bound) {
      if (this.adapter.role === 'root') {
        if (this.adapter.rootFinished) return { data: { disposition: 'handled' } };
        const root = await this.waitForTask((task) => task.parent_id === null);
        if (!root) return { data: { disposition: 'handled' } };
        await this.claimTask(root);
        return { data: { disposition: 'handled' } };
      }
      if (this.adapter.finished) return { data: { disposition: 'handled' } };
      const target = await this.waitForTask((task) => task.parent_id !== null && task.task_id === this.adapter.targetTaskId);
      if (!target) return { data: { disposition: 'handled' } };
      await this.claimTask(target);
      return { data: { disposition: 'handled' } };
    }

    if (this.adapter.role === 'root') {
      await this.workClaimedTask();
      if (!this.adapter.rootCreated) {
        this.adapter.rootCreated = true;
        const checks = { checker_ref: 'lean', checker_version: 'mvp-1', environment_ref: config.environment_ref };
        await this.call('create_child_task', {
          task_id: 'collab-proof-a', child_creation_key: 'collab-proof-a', task_type: 'proof',
          goal: 'Collaboration proof route A', expected_output: 'A checked proof artifact', acceptance_conditions: { route: 'a' },
          completion_contract: { required_candidate: { kind: 'artifact', scope: 'proof_relevant' }, required_check: checks },
        });
        await this.call('create_child_task', {
          task_id: 'collab-research', child_creation_key: 'collab-research', task_type: 'research',
          goal: 'Collaboration research route', expected_output: 'A reusable research Material', acceptance_conditions: { route: 'research' },
        });
        await this.call('create_child_task', {
          task_id: 'collab-proof-b', child_creation_key: 'collab-proof-b', task_type: 'proof',
          goal: 'Collaboration proof route B', expected_output: 'A second checked proof artifact', acceptance_conditions: { route: 'b' },
          completion_contract: { required_candidate: { kind: 'artifact', scope: 'proof_relevant' }, required_check: checks },
        });
        await this.call('publish_material', { kind: 'experience', scope: 'proof_relevant', content: { route: 'root exploration complete' } });
        await this.call('request_wait', {
          wait_condition: { type: 'child_task_terminal', child_task_id: 'collab-proof-a' },
          checkpoint: { phase: 'root-exploration-complete' },
        });
        return { data: { disposition: 'handled' } };
      }

      const tasks = await this.call('list_tasks', {
        available_only: false,
        states: ['OPEN', 'RUNNING', 'WAITING', 'SATISFIED', 'FAILED', 'CANCELLED', 'REJECTED'],
        limit: 100,
      });
      const proofB = tasks.find((task) => task.task_id === 'collab-proof-b');
      if (proofB?.state !== 'SATISFIED') {
        await this.call('request_wait', {
          wait_condition: { type: 'child_task_terminal', child_task_id: 'collab-proof-b' },
          checkpoint: { phase: 'root-awaiting-second-proof' },
        });
        return { data: { disposition: 'handled' } };
      }
      const research = tasks.find((task) => task.task_id === 'collab-research');
      await this.call('read_materials', {});
      if (research?.state === 'WAITING') {
        await this.call('accept_task', { target_task_id: research.task_id, target_state_version: research.state_version });
      }
      const material = await this.call('publish_material', { kind: 'artifact', scope: 'proof_relevant', content: 'def collaborationRoot : Nat := 0' });
      await this.call('submit_candidate', { candidate_material_id: material.material.material_id });
      this.adapter.rootFinished = true;
      return { data: { disposition: 'handled' } };
    }

    await this.workClaimedTask();
    if (this.adapter.role === 'worker-research') {
      const material = await this.call('publish_material', { kind: 'fact', scope: 'proof_relevant', content: { route: 'reusable research result' } });
      assert.ok(material.material.material_id);
      await this.call('request_wait', {
        wait_condition: { type: 'parent_review' },
        checkpoint: { phase: 'research-delivered' },
      });
    } else {
      const material = await this.call('publish_material', { kind: 'artifact', scope: 'proof_relevant', content: `def ${this.adapter.role.replaceAll('-', '_')} : Nat := 0` });
      await this.call('submit_candidate', { candidate_material_id: material.material.material_id });
      await this.call('request_wait', {
        wait_condition: { type: 'check_result_arrived', check_request_key: `unused-check-key-${this.adapter.role}` },
        checkpoint: { phase: 'candidate-submitted' },
      });
    }
    this.adapter.finished = true;
    return { data: { disposition: 'handled' } };
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.emit('close', { code: 0, signal: 'SIGTERM' }));
  }
}

class CollaborationAdapter {
  constructor({ env, role, targetTaskId }) {
    this.env = env;
    this.role = role;
    this.targetTaskId = targetTaskId;
    this.starts = [];
    this.rootCreated = false;
    this.rootFinished = false;
    this.finished = false;
    this.claimSequence = 0;
  }

  async start(options = {}) {
    this.starts.push(options);
    const session = new CollaborationSession(this, options);
    session.manifest = { fake: true, pi_version: 'collaboration' };
    return session;
  }
}

async function runFixture({ reportDir, experimentDir = reportDir, id = 'putnam_test', cheat = false, noWork = false, fileCandidate = false, invalidClaim = false, onAdapter = null, checker = null }) {
  return runBenchmarkProject(problem(id), config, {
    experimentDir,
    reportDir,
    timeboxMs: 500,
    pollMs: 1,
    turnTimeoutMs: 100,
    turnIntervalMs: 10_000,
    stopOnSolved: true,
    agentAdapterFactory: ({ env, index }) => {
      const adapter = new FakeAdapter({ env, cheat, noWork: noWork || (invalidClaim && index !== 1), fileCandidate, invalidClaim: invalidClaim && index === 1 });
      onAdapter?.(adapter);
      return adapter;
    },
    checker: checker ?? {
      async check() {
        return { verdict: 'PASS', evidence: { exit_code: 0 } };
      },
    },
  });
}

test('benchmark project starts four isolated cores and redacts candidate content', async () => {
  const experimentDir = await mkdtemp('/tmp/swarmenv-benchmark-experiment-');
  const reportDir = await mkdtemp('/tmp/swarmenv-benchmark-report-');
  try {
    const adapters = [];
    const report = await runFixture({ reportDir, experimentDir, onAdapter: (adapter) => adapters.push(adapter) });
    assert.equal(report.protocol.core_count, 4);
    assert.ok(report.project.task_tree.length >= 2);
    assert.ok(report.project.task_tree.some((task) => task.task_type === 'proof' && task.parent_id === null));
    assert.ok(report.project.task_tree.some((task) => task.task_type === 'research'));
    assert.ok(adapters.some((adapter) => adapter.starts.some((start) => start.executionId && start.cwd?.includes('/workspaces/projects/putnam_test/') && !start.cwd.includes('/core-'))));
    assert.equal(report.run.solved, true);
    assert.equal(report.run.protocol_valid, true);
    assert.equal(report.run.made_progress, true);
    assert.ok(report.run.progress_evidence.workspace_write_count > 0);
    assert.ok(report.cores.every((core) => core.claims.every((claim) => Number.isInteger(claim.workspace_revision_start) && Number.isInteger(claim.workspace_revision_end))));
    assert.equal(report.audit.invalid, false);
    assert.equal(report.cores.length, 4);
    assert.ok(report.cores.some((core) => core.workspace_writes.length > 0));
    assert.ok(report.cores.some((core) => core.task_state === 'SATISFIED'));
    assert.ok(report.cores.every((core) => core.tool_events.includes('swarmenv_call')));
    assert.equal(JSON.stringify(report).includes('formal_source'), false);
    assert.equal(JSON.stringify(report).includes('benchmarkArtifact'), false);
    assert.equal(JSON.stringify(report).includes('candidate contents'), false);
    assert.match(report.project.database_path, /state\/projects\/putnam_test\/project\.sqlite$/);
    await access(`${reportDir}/putnam_test/report.json`);
    for (const path of [
      `${experimentDir}/logs/projects/putnam_test/services/task-service.ndjson`,
      `${experimentDir}/logs/projects/putnam_test/services/context-service.ndjson`,
      `${experimentDir}/logs/projects/putnam_test/services/service-router.ndjson`,
      `${experimentDir}/logs/projects/putnam_test/services/judge-service.ndjson`,
      `${experimentDir}/logs/projects/putnam_test/runtime/core-1.ndjson`,
      `${experimentDir}/logs/projects/putnam_test/bridge/core-1.ndjson`,
      `${experimentDir}/logs/projects/putnam_test/agents/core-1.ndjson`,
    ]) await access(path);
  } finally {
    await rm(experimentDir, { recursive: true, force: true });
    await rm(reportDir, { recursive: true, force: true });
  }
});

test('a clean Agent exit without Task or Workspace contribution is not reported as solved', async () => {
  const experimentDir = await mkdtemp('/tmp/swarmenv-benchmark-no-work-');
  const reportDir = await mkdtemp('/tmp/swarmenv-benchmark-no-work-report-');
  try {
    const report = await runFixture({ reportDir, experimentDir, id: 'putnam_no_work_test', noWork: true });
    assert.equal(report.run.protocol_valid, true);
    assert.equal(report.run.made_progress, false);
    assert.equal(report.run.solved, false);
    assert.equal(report.run.progress_evidence.child_task_count, 0);
    assert.equal(report.run.progress_evidence.workspace_write_count, 0);
    assert.equal(report.run.progress_evidence.candidate_check_count, 0);
  } finally {
    await rm(experimentDir, { recursive: true, force: true });
    await rm(reportDir, { recursive: true, force: true });
  }
});

test('INVALID_CONTRACT is returned as recoverable Agent feedback and does not invalidate the run', async () => {
  const experimentDir = await mkdtemp('/tmp/swarmenv-benchmark-recoverable-error-');
  const reportDir = await mkdtemp('/tmp/swarmenv-benchmark-recoverable-error-report-');
  try {
    const report = await runFixture({ reportDir, experimentDir, id: 'putnam_recoverable_error_test', invalidClaim: true });
    assert.equal(report.run.protocol_valid, true);
    assert.equal(report.run.tool_protocol_error_count, 0);
    assert.ok(report.run.tool_error_count >= 1);
    assert.equal(report.audit.invalid, false);
    assert.ok(report.cores.some((core) => core.tool_errors.some((error) => error.code === 'INVALID_CONTRACT' && error.recoverable === true)));
  } finally {
    await rm(experimentDir, { recursive: true, force: true });
    await rm(reportDir, { recursive: true, force: true });
  }
});

test('placeholder candidates are invalid even when the checker reports PASS', async () => {
  const reportDir = await mkdtemp('/tmp/swarmenv-benchmark-cheat-');
  try {
    const report = await runFixture({ reportDir, id: 'putnam_cheat_test', cheat: true });
    assert.equal(report.run.solved, false);
    assert.equal(report.audit.invalid, true);
    assert.deepEqual(report.audit.invalid_reasons, ['forbidden_placeholder']);
  } finally {
    await rm(reportDir, { recursive: true, force: true });
  }
});

test('Workspace-referenced candidates are checked from the Workspace source file', async () => {
  const reportDir = await mkdtemp('/tmp/swarmenv-benchmark-workspace-candidate-report-');
  const experimentDir = await mkdtemp('/tmp/swarmenv-benchmark-workspace-candidate-');
  let checkedContent = '';
  try {
    const report = await runFixture({
      reportDir,
      experimentDir,
      id: 'putnam_workspace_candidate_test',
      fileCandidate: true,
      checker: {
        async check({ candidate }) {
          checkedContent = candidate.content;
          return { verdict: 'PASS', evidence: { exit_code: 0 } };
        },
      },
    });
    assert.match(checkedContent, /theorem workspace_candidate/);
    assert.doesNotMatch(checkedContent, /candidate metadata mentions sorry/);
    assert.equal(report.run.solved, true);
    assert.equal(report.run.protocol_valid, true);
    assert.equal(report.audit.invalid, false);
  } finally {
    await rm(experimentDir, { recursive: true, force: true });
    await rm(reportDir, { recursive: true, force: true });
  }
});

test('short four-core collaboration proves root decomposition, parallel work, wait/resume, and parent review', async () => {
  const experimentDir = await mkdtemp('/tmp/swarmenv-benchmark-collaboration-');
  const reportDir = await mkdtemp('/tmp/swarmenv-benchmark-collaboration-report-');
  try {
    const adapters = [];
    const report = await runBenchmarkProject(problem('putnam_collaboration_test'), config, {
      experimentDir,
      reportDir,
      timeboxMs: 5_000,
      pollMs: 2,
      turnTimeoutMs: 3_000,
      turnIntervalMs: 10_000,
      stopOnSolved: true,
      agentAdapterFactory: ({ env, index }) => {
        const roles = ['root', 'worker-proof-a', 'worker-research', 'worker-proof-b'];
        const targets = [null, 'collab-proof-a', 'collab-research', 'collab-proof-b'];
        const adapter = new CollaborationAdapter({ env, role: roles[index - 1], targetTaskId: targets[index - 1] });
        adapters.push(adapter);
        return adapter;
      },
      checker: { async check() { return { verdict: 'PASS', evidence: { exit_code: 0 } }; } },
    });
    assert.equal(report.run.protocol_valid, true);
    assert.equal(report.run.made_progress, true);
    assert.equal(report.run.solved, true);
    assert.equal(report.project.task_tree.filter((task) => task.parent_id !== null).length, 3);
    assert.ok(report.run.claim_count >= 4, `expected root and three child claims, got ${report.run.claim_count}`);
    assert.ok(report.run.child_claim_count >= 3, `expected every child to be claimed, got ${report.run.child_claim_count}`);
    assert.ok(report.run.root_claim_count >= 2, `expected root to be reclaimed after waiting, got ${report.run.root_claim_count}`);
    assert.ok(report.run.resumed_execution_count >= 1, `expected at least one Execution to be resumed; root=${report.run.root_claim_count}, claims=${report.run.claim_count}, details=${JSON.stringify(report.project.execution_history)}`);
    assert.ok(report.run.progress_evidence.workspace_write_count >= 4);
    assert.ok(report.cores.filter((core) => core.workspace_writes.length > 0).length >= 4);
    assert.ok(report.cores.some((core) => core.claims.length >= 2), 'root core should reclaim after waiting');
    assert.ok(report.project.task_tree.some((task) => task.task_id === 'collab-research' && task.state === 'SATISFIED'));
    assert.ok(report.run.candidate_check_count >= 3, 'two child candidates and one root candidate should be checked');
    assert.equal(report.audit.invalid, false);
    assert.ok(adapters.every((adapter) => adapter.starts.length >= 2));
  } finally {
    await rm(experimentDir, { recursive: true, force: true });
    await rm(reportDir, { recursive: true, force: true });
  }
});

test('batch runner isolates projects and preserves per-project results', async () => {
  const reportDir = await mkdtemp('/tmp/swarmenv-benchmark-batch-');
  try {
    const reports = await runBenchmarkBatch([problem('putnam_a_test'), problem('putnam_b_test')], config, {
      reportDir,
      timeboxMs: 500,
      pollMs: 1,
      turnTimeoutMs: 100,
      turnIntervalMs: 10_000,
      stopOnSolved: true,
      projectParallelism: 2,
      agentAdapterFactory: ({ env }) => new FakeAdapter({ env }),
      checker: { async check() { return { verdict: 'PASS', evidence: { exit_code: 0 } }; } },
    });
    assert.equal(reports.length, 2);
    assert.ok(reports.every((report) => report.run.solved));
    assert.notEqual(reports[0].project.database_path, reports[1].project.database_path);
    assert.notEqual(reports[0].project.problem_id, reports[1].project.problem_id);
  } finally {
    await rm(reportDir, { recursive: true, force: true });
  }
});

test('report validator rejects proof-bearing fields', () => {
  assert.throws(() => validateBenchmarkReport({
    schema_version: 1,
    protocol: {},
    project: {},
    run: {},
    audit: { formal_source: 'leaked proof', raw_transcript_exported: false, proof_contents_exported: false },
  }), /redacted fields/);
});

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
  constructor(env, cheat = false) {
    super();
    this.env = env;
    this.cheat = cheat;
    this.rpcRecords = [];
    this.closed = false;
  }

  async waitForReady() {}

  async prompt() {
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
      if (!body.ok) throw new Error(body.error?.message ?? 'fake bridge call failed');
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
    let claim;
    try {
      claim = await call('claim', {
        task_id: tasks[0].task_id,
        claim_key: `fake-claim-${this.env.SWARMENV_BRIDGE_TOKEN}`,
        workspace_mode: 'clean',
      });
    } catch {
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
        content: this.cheat ? 'by sorry' : 'def benchmarkRootArtifact : Nat := 0',
      });
      await call('submit_candidate', { candidate_material_id: material.material.material_id });
      return { data: { disposition: 'handled' } };
    }
    await call('read_materials', {});
    const material = await call('publish_material', {
      kind: 'artifact',
      scope: 'proof_relevant',
      content: this.cheat ? 'by sorry' : 'def benchmarkArtifact : Nat := 0',
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
  constructor({ env, cheat = false }) {
    this.env = env;
    this.cheat = cheat;
    this.starts = [];
  }

  async start(options = {}) {
    this.starts.push(options);
    const { logger } = options;
    logger?.append({ type: 'fake-agent-start' });
    const session = new FakeSession(this.env, this.cheat);
    session.manifest = { fake: true, pi_version: 'fake' };
    return session;
  }
}

async function runFixture({ reportDir, experimentDir = reportDir, id = 'putnam_test', cheat = false, onAdapter = null }) {
  return runBenchmarkProject(problem(id), config, {
    experimentDir,
    reportDir,
    timeboxMs: 500,
    pollMs: 1,
    turnTimeoutMs: 100,
    turnIntervalMs: 10_000,
    stopOnSolved: true,
    agentAdapterFactory: ({ env }) => {
      const adapter = new FakeAdapter({ env, cheat });
      onAdapter?.(adapter);
      return adapter;
    },
    checker: {
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
    assert.equal(report.audit.invalid, false);
    assert.equal(report.cores.length, 4);
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

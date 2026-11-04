import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { BenchmarkAgentCoreAdapter, runBenchmarkBatch, runBenchmarkProject, validateBenchmarkReport } from '../src/benchmark/putnam-runner.js';
import { ObservationStore } from '../src/observability/observation-store.js';

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

const toolNameForOperation = Object.freeze({
  list_services: 'catalog_list_services',
  get_service_metadata: 'catalog_get_service_metadata',
  list_tools: 'catalog_list_tools',
  list_tasks: 'task_discover',
  list_claimable_tasks: 'task_list_claimable',
  get_task: 'task_view',
  get_execution: 'execution_get',
  claim: 'task_claim',
  publish_material: 'context_publish',
  read_materials: 'context_read',
  consume_materials: 'context_consume',
  submit_candidate: 'judge_submit_candidate',
  get_check_result: 'judge_get_check_result',
  task_block: 'task_block',
  accept_task: 'task_complete',
  get_workspace: 'workspace_get',
  list_workspace_files: 'workspace_list_files',
  read_workspace_file: 'workspace_read_file',
  write_workspace_file: 'workspace_write_file',
  workspace_diff: 'workspace_diff',
});
function namedTool(operation) {
  return `swarmenv_${toolNameForOperation[operation] ?? operation}`;
}

function checkerWithPreflight(checker) {
  if (typeof checker.preflight === 'function') return checker;
  return {
    ...checker,
    preflight: async ({ fixtureManifest }) => ({
      status: 'healthy',
      checker_process_status: 'completed',
      evidence: {
        preflight_supported: true,
        preflight_verified: true,
        input_binding_verified: true,
        toolchain_version_verified: true,
        checker_version_verified: true,
        expected_checker_version: fixtureManifest.checker_version,
        observed_checker_version: fixtureManifest.checker_version,
      },
    }),
  };
}

test('benchmark Agent sessions explicitly deny Pi parallel coordination', () => {
  const adapter = new BenchmarkAgentCoreAdapter({
    provider: 'openai',
    model: 'gpt-test',
    sessionDir: '/tmp/swarmenv-benchmark-session',
  });
  const args = adapter.buildLaunchArgs({ executionId: 'benchmark-execution' });
  assert.ok(args.includes('--no-tools'));
  assert.ok(!args.includes('--no-builtin-tools'));
  assert.ok(args.includes('--tools'));
  const allowedTools = args[args.indexOf('--tools') + 1].split(',');
  assert.ok(allowedTools.includes('swarmenv_task_complete'));
  assert.ok(!allowedTools.some((name) => /wait|wake|select_task|swarmenv_call/i.test(name)));
  assert.deepEqual(args.slice(args.indexOf('--exclude-tools'), args.indexOf('--exclude-tools') + 2), ['--exclude-tools', 'parallel']);
});

class FakeSession extends EventEmitter {
  constructor(env, cheat = false, noWork = false, fileCandidate = false, invalidClaim = false, hardToolError = false, bound = false, selectionOnly = false) {
    super();
    this.env = env;
    this.cheat = cheat;
    this.noWork = noWork;
    this.fileCandidate = fileCandidate;
    this.invalidClaim = invalidClaim;
    this.invalidClaimUsed = false;
    this.hardToolError = hardToolError;
    this.hardToolErrorUsed = false;
    this.bound = bound;
    this.selectionOnly = selectionOnly;
    this.rpcRecords = [];
    this.promptMessages = [];
    this.closed = false;
    this.candidateResults = [];
    this._settled = null;
    this._resolveSettled = null;
  }

  async waitForReady() {}

  async waitForSettled() {
    if (this._settled) await this._settled;
  }

  async prompt(message) {
    if (typeof message === 'string') this.promptMessages.push(message);
    this._settled = new Promise((resolve) => { this._resolveSettled = resolve; });
    try {
      return await this.#promptTurn(message);
    } finally {
      this._resolveSettled?.();
      this._resolveSettled = null;
    }
  }

  async #promptTurn(message) {
    if (this.noWork) return { data: { disposition: 'handled' } };
    const call = async (operation, payload) => {
      this.rpcRecords.push({ type: 'tool_call', tool_name: namedTool(operation) });
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
      this.rpcRecords.push({ type: 'tool_result', tool_name: namedTool(operation) });
      return body.result;
    };
    let claim;
    if (this.bound) {
      claim = { task: await call('get_task', {}), execution: await call('get_execution', {}) };
    } else {
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
          await call('task_take', {
            task_id: tasks[0].task_id,
            claim_key: `fake-invalid-take-${this.env.SWARMENV_BRIDGE_TOKEN}`,
            workspace_mode: 'invalid-mode',
          });
        } catch (error) {
          assert.equal(error.code, 'INVALID_CONTRACT');
          return { data: { disposition: 'handled' } };
        }
      }
      const take = async (taskId) => call('task_take', {
        task_id: taskId,
        claim_key: `fake-take-${this.env.SWARMENV_BRIDGE_TOKEN}-${taskId}`,
        workspace_mode: 'clean',
      });
      try {
        claim = await take(tasks[0].task_id);
      } catch {
        // Another Core may have one the same Task first. Re-read the queue and
        // take one still-claimable Task; do not invent a second Execution.
        tasks = await call('list_tasks', { limit: 10 });
        if (tasks.length === 0) return { data: { disposition: 'handled' } };
        claim = await take(tasks[0].task_id);
      }
      // Same identity: the task_take turn continues into bound research work.
      this.bound = true;
    }
    if (this.hardToolError && !this.hardToolErrorUsed) {
      this.hardToolErrorUsed = true;
      try {
        await call('request_rework', {
          target_task_id: claim.task.task_id,
          instruction: 'This root is not waiting for parent review.',
        });
      } catch (error) {
        assert.equal(error.code, 'NOT_ALLOWED');
      }
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
      this.candidateResults.push(await call('submit_candidate', { candidate_material_id: material.material.material_id }));
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
    this.candidateResults.push(await call('submit_candidate', { candidate_material_id: material.material.material_id }));
    return { data: { disposition: 'handled' } };
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.emit('close', { code: 0, signal: 'SIGTERM' }));
  }
}

class FakeAdapter {
  constructor({ env, cheat = false, noWork = false, fileCandidate = false, invalidClaim = false, hardToolError = false, selectionOnly = false }) {
    this.env = env;
    this.cheat = cheat;
    this.noWork = noWork;
    this.fileCandidate = fileCandidate;
    this.invalidClaim = invalidClaim;
    this.hardToolError = hardToolError;
    this.selectionOnly = selectionOnly;
    this.starts = [];
    this.sessions = [];
  }

  async start(options = {}) {
    this.starts.push(options);
    const { logger } = options;
    logger?.append({ type: 'fake-agent-start' });
    const isWorkerSession = String(options.executionId ?? '').startsWith('worker-');
    const session = new FakeSession(this.env, this.cheat, this.noWork, this.fileCandidate, this.invalidClaim && isWorkerSession, this.hardToolError && isWorkerSession, !isWorkerSession, this.selectionOnly);
    this.sessions.push(session);
    session.manifest = { fake: true, pi_version: 'fake' };
    return session;
  }
}

class FlatFailureSession extends EventEmitter {
  constructor(env, options) {
    super();
    this.env = env;
    this.options = options;
    this.bound = !String(options.executionId ?? '').startsWith('worker-');
    this.closed = false;
    this.finished = false;
    this.rpcRecords = [];
    this.manifest = { fake: true, pi_version: 'flat-failure' };
  }

  async waitForReady() {}

  async call(operation, payload = {}) {
    this.rpcRecords.push({ type: 'tool_call', tool_name: namedTool(operation) });
    const response = await fetch(`${this.env.SWARMENV_BRIDGE_URL}/call`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.env.SWARMENV_BRIDGE_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ operation, payload }),
    });
    const body = await response.json();
    if (!body.ok) throw Object.assign(new Error(body.error?.message ?? `${operation} failed`), { code: body.error?.code });
    this.rpcRecords.push({ type: 'tool_result', tool_name: namedTool(operation) });
    return body.result;
  }

  async waitForSettled() {
    if (this._settled) await this._settled;
  }

  async prompt() {
    this._settled = new Promise((resolve) => { this._resolveSettled = resolve; });
    try {
      return await this.#promptTurn();
    } finally {
      this._resolveSettled?.();
      this._resolveSettled = null;
    }
  }

  async #promptTurn() {
    if (!this.bound) {
      const tasks = await this.call('list_tasks', { limit: 10 });
      if (!tasks[0]) return { data: { disposition: 'handled' } };
      await this.call('task_take', { task_id: tasks[0].task_id, claim_key: `flat-failure-${this.options.executionId}`, workspace_mode: 'resume' });
      this.bound = true;
    }
    if (this.finished) return { data: { disposition: 'handled' } };
    const view = await this.call('get_task', {});
    const task = view.task ?? view;
    if (task.task_type !== 'proof') return { data: { disposition: 'handled' } };
    const material = await this.call('publish_material', {
      kind: 'artifact', scope: 'proof_relevant', content: 'def flatFailureCandidate : Nat := 0',
    });
    const first = await this.call('submit_candidate', { candidate_material_id: material.material.material_id });
    if (first.check_result?.result_class === 'source_failure') {
      const revised = await this.call('publish_material', {
        kind: 'artifact', scope: 'proof_relevant', content: 'def revisedFlatFailureCandidate : Nat := 1',
      });
      await this.call('submit_candidate', { candidate_material_id: revised.material.material_id });
    }
    this.finished = true;
    return { data: { disposition: 'handled' } };
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.emit('close', { code: 0, signal: 'SIGTERM' }));
  }
}

class FlatFailureAdapter {
  constructor({ env }) {
    this.env = env;
    this.sessions = [];
  }

  async start(options = {}) {
    const session = new FlatFailureSession(this.env, options);
    this.sessions.push(session);
    return session;
  }
}

class PromptFailureSession extends EventEmitter {
  constructor() {
    super();
    this.rpcRecords = [];
    this.closed = false;
    this.manifest = { fake: true, pi_version: 'prompt-failure' };
  }

  async waitForReady() {}

  async prompt() {
    throw Object.assign(new Error('synthetic prompt startup failure'), { code: 'PROMPT_START_FAILED' });
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.emit('close', { code: 0, signal: 'SIGTERM' }));
  }
}

class PromptFailureAdapter {
  constructor() {
    this.starts = 0;
  }

  async start() {
    this.starts += 1;
    return new PromptFailureSession();
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
    this.rpcRecords.push({ type: 'tool_call', tool_name: namedTool(operation) });
    const response = await fetch(`${this.adapter.env.SWARMENV_BRIDGE_URL}/call`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.adapter.env.SWARMENV_BRIDGE_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ operation, payload }),
    });
    const body = await response.json();
    this.rpcRecords.push({ type: 'tool_result', tool_name: namedTool(operation) });
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
    return this.call('task_take', {
      task_id: task.task_id,
      claim_key: `collaboration-take-${this.adapter.role}-${this.adapter.claimSequence}`,
      workspace_mode: 'resume',
    });
  }

  async waitForSettled() {
    if (this._settled) await this._settled;
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
    this._settled = new Promise((resolve) => { this._resolveSettled = resolve; });
    try {
      return await this.#promptTurn();
    } finally {
      this._resolveSettled?.();
      this._resolveSettled = null;
    }
  }

  async #promptTurn() {
    if (!this.bound) {
      let taken = null;
      if (this.adapter.role === 'root' && !this.adapter.rootFinished) {
        taken = await this.waitForTask((task) => task.parent_id === null);
      }
      // A reusable unbound Agent discovers whichever child Task is READY;
      // the fixed role only makes the deterministic fixture easier to read.
      taken = taken ?? await this.waitForTask((task) => task.parent_id !== null);
      if (!taken) return { data: { disposition: 'handled' } };
      try {
        await this.claimTask(taken);
      } catch {
        return { data: { disposition: 'handled' } };
      }
      // Same identity: continue this turn as the bound owner.
      this.bound = true;
    }

    const currentTask = await this.call('get_task', {});
    if (currentTask.parent_id === null) {
      await this.workClaimedTask();
      const existingTasks = await this.call('list_tasks', { available_only: false, limit: 100 });
      if (!this.adapter.rootCreated && !existingTasks.some((task) => task.parent_id === currentTask.task_id)) {
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
          completion_contract: { required_materials: [{ kinds: ['fact'], scope: 'proof_relevant', min_count: 1 }] },
        });
        await this.call('create_child_task', {
          task_id: 'collab-proof-b', child_creation_key: 'collab-proof-b', task_type: 'proof',
          goal: 'Collaboration proof route B', expected_output: 'A second checked proof artifact', acceptance_conditions: { route: 'b' },
          completion_contract: { required_candidate: { kind: 'artifact', scope: 'proof_relevant' }, required_check: checks },
        });
        await this.call('publish_material', { kind: 'experience', scope: 'proof_relevant', content: { route: 'root exploration complete' } });
        await this.call('task_block', {
          reason: 'proof route A is still running',
          dependency: { dependency_kind: 'TASK', prerequisite_task_id: 'collab-proof-a' },
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
        await this.call('task_block', {
          reason: 'proof route B is still running',
          dependency: { dependency_kind: 'TASK', prerequisite_task_id: 'collab-proof-b' },
          checkpoint: { phase: 'root-awaiting-second-proof' },
        });
        return { data: { disposition: 'handled' } };
      }
      const research = tasks.find((task) => task.task_id === 'collab-research');
      const materialsRead = await this.call('read_materials', {});
      const consumedMaterialIds = materialsRead.map((material) => material.material_id).filter(Boolean);
      await this.call('consume_materials', {
        material_ids: consumedMaterialIds,
        action: 'integration',
        action_ref: 'collaboration-root',
      });
      await this.call('publish_material', {
        kind: 'artifact',
        scope: 'root_integration',
        content: 'def collaborationRoot : Nat := 0',
        provenance: { consumed_material_ids: consumedMaterialIds },
      });
      const material = await this.call('publish_material', {
        kind: 'artifact',
        scope: 'proof_relevant',
        content: 'def collaborationRoot : Nat := 0',
      });
      await this.call('submit_candidate', { candidate_material_id: material.material.material_id });
      this.adapter.rootFinished = true;
      return { data: { disposition: 'handled' } };
    }

    await this.workClaimedTask();
    if (currentTask.task_type === 'research') {
      const material = await this.call('publish_material', { kind: 'fact', scope: 'proof_relevant', content: { route: 'reusable research result' } });
      assert.ok(material.material.material_id);
      await this.call('accept_task', {
        target_task_id: currentTask.task_id,
        target_state_version: currentTask.state_version,
      });
    } else {
      const material = await this.call('publish_material', { kind: 'artifact', scope: 'proof_relevant', content: `def ${this.adapter.role.replaceAll('-', '_')} : Nat := 0` });
      await this.call('submit_candidate', { candidate_material_id: material.material.material_id });
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

class DynamicCollaborationSession extends EventEmitter {
  constructor(adapter, options) {
    super();
    this.adapter = adapter;
    this.options = options;
    this.rpcRecords = [];
    this.closed = false;
    this.bound = !String(options.executionId ?? '').startsWith('worker-');
  }

  async waitForReady() {}

  async waitForSettled() {}

  async call(operation, payload = {}) {
    this.rpcRecords.push({ type: 'tool_call', tool_name: namedTool(operation) });
    const response = await fetch(`${this.adapter.env.SWARMENV_BRIDGE_URL}/call`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.adapter.env.SWARMENV_BRIDGE_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ operation, payload }),
    });
    const body = await response.json();
    this.rpcRecords.push({ type: 'tool_result', tool_name: namedTool(operation) });
    if (!body.ok) {
      const error = new Error(body.error?.message ?? `${operation} failed`);
      error.code = body.error?.code;
      throw error;
    }
    return body.result;
  }

  async claimAvailableTask() {
    const tasks = await this.call('list_tasks', { limit: 100 });
    const task = tasks.find((candidate) => candidate.parent_id !== null) ?? tasks.find((candidate) => candidate.parent_id === null);
    if (!task) return false;
    try {
      await this.call('task_take', {
        task_id: task.task_id,
        claim_key: `dynamic-take-${this.options.executionId}-${this.adapter.claimSequence++}`,
        workspace_mode: 'resume',
      });
      return true;
    } catch (error) {
      if (error.code === 'CONFLICT' || error.code === 'STALE_VERSION') return false;
      throw error;
    }
  }

  async workClaimedTask(task) {
    const workspace = await this.call('get_workspace', {});
    let revision = workspace.workspace.workspace_revision;
    await this.call('read_workspace_file', { path: 'README.md' });
    const first = await this.call('write_workspace_file', {
      path: `notes/${task.task_id}.md`,
      content: `The worker inspected the locked input and recorded the route for ${task.task_id}.\n`,
      expected_revision: revision,
    });
    revision = first.workspace.workspace_revision;
    await this.call('write_workspace_file', {
      path: `analysis/${task.task_id}.md`,
      content: `The worker compared intermediate cases and documented follow-up context for ${task.task_id}.\n`,
      expected_revision: revision,
    });
    const material = await this.call('publish_material', {
      kind: task.task_type === 'research' ? 'fact' : 'artifact',
      scope: 'proof_relevant',
      content: task.task_type === 'research'
        ? { task_id: task.task_id, result: 'multi-step route and intermediate context' }
        : `def ${task.task_id.replaceAll('-', '_')} : Nat := 0`,
    });
    if (task.task_type === 'research') {
      await this.call('accept_task', {
        target_task_id: task.task_id,
        target_state_version: task.state_version,
      });
    } else {
      await this.call('submit_candidate', { candidate_material_id: material.material.material_id });
    }
  }

  async waitForSettled() {
    if (this._settled) await this._settled;
  }

  async prompt() {
    this._settled = new Promise((resolve) => { this._resolveSettled = resolve; });
    try {
      return await this.#promptTurn();
    } finally {
      this._resolveSettled?.();
      this._resolveSettled = null;
    }
  }

  async #promptTurn() {
    if (this.adapter.state.rootFinished) return { data: { disposition: 'handled' } };
    if (!this.bound) {
      await this.call('list_services', {});
      await this.call('list_tools', {});
      if (!await this.claimAvailableTask()) return { data: { disposition: 'handled' } };
      // Same identity: continue this turn as the bound owner.
      this.bound = true;
    }
    if (this.adapter.state.queueOnly) {
      const task = await this.call('get_task', {});
      await this.workClaimedTask(task);
      return { data: { disposition: 'handled' } };
    }

    const task = await this.call('get_task', {});
    if (task.parent_id !== null) {
      await this.workClaimedTask(task);
      return { data: { disposition: 'handled' } };
    }

    await this.call('read_workspace_file', { path: 'README.md' });
    if (!this.adapter.state.rootCreated) {
      const initialTasks = await this.call('list_tasks', { available_only: false, limit: 100 });
      this.adapter.state.initialTaskCount = initialTasks.length;
      this.adapter.state.rootCreated = true;
      for (let index = 0; index < 8; index += 1) {
        const taskType = index < 4 ? 'research' : 'proof';
        const childTaskId = `dynamic-child-${index}`;
        this.adapter.state.childTaskIds.push(childTaskId);
        await this.call('create_child_task', {
          task_id: childTaskId,
          child_creation_key: childTaskId,
          task_type: taskType,
          goal: `Perform the multi-step ${taskType} route for ${childTaskId}`,
          expected_output: taskType === 'research' ? 'A research result with intermediate context' : 'A checked proof artifact',
          acceptance_conditions: { scenario_task: childTaskId },
          task_instructions: 'Inspect the locked Workspace, compare intermediate cases, record the route, and publish the result for the parent Task.',
          completion_contract: taskType === 'proof' ? {
            required_candidate: { kind: 'artifact', scope: 'proof_relevant' },
            required_check: { checker_ref: 'lean', checker_version: 'mvp-1', environment_ref: config.environment_ref },
          } : { required_materials: [{ kinds: ['fact'], scope: 'proof_relevant', min_count: 1 }] },
        });
      }
      const firstChild = this.adapter.state.childTaskIds[0];
      await this.call('task_block', {
        reason: 'dynamic child work is still running',
        dependency: { dependency_kind: 'TASK', prerequisite_task_id: firstChild },
        checkpoint: { phase: 'dynamic-children-created', prerequisite_task_id: firstChild },
      });
      return { data: { disposition: 'handled' } };
    }

    await this.call('read_materials', {});
    const tasks = await this.call('list_tasks', {
      available_only: false,
      states: ['OPEN', 'RUNNING', 'SATISFIED', 'FAILED', 'CANCELLED', 'REJECTED'],
      limit: 100,
    });
    const pendingChild = tasks.find((candidate) => this.adapter.state.childTaskIds.includes(candidate.task_id) &&
      !['SATISFIED', 'FAILED', 'CANCELLED', 'REJECTED'].includes(candidate.state));
    if (pendingChild) {
      await this.call('task_block', {
        reason: 'dynamic child work is still running',
        dependency: { dependency_kind: 'TASK', prerequisite_task_id: pendingChild.task_id },
        checkpoint: { phase: 'awaiting-dynamic-child', prerequisite_task_id: pendingChild.task_id },
      });
      return { data: { disposition: 'handled' } };
    }
    const material = await this.call('publish_material', {
      kind: 'artifact',
      scope: 'proof_relevant',
      content: 'def dynamicRootArtifact : Nat := 0',
    });
    await this.call('submit_candidate', { candidate_material_id: material.material.material_id });
    this.adapter.state.rootFinished = true;
    return { data: { disposition: 'handled' } };
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.emit('close', { code: 0, signal: 'SIGTERM' }));
  }
}

class DynamicCollaborationAdapter {
  constructor({ env, state }) {
    this.env = env;
    this.starts = [];
    this.claimSequence = 0;
    this.state = state;
  }

  async start(options = {}) {
    this.starts.push(options);
    const session = new DynamicCollaborationSession(this, options);
    session.manifest = { fake: true, pi_version: 'dynamic-collaboration' };
    return session;
  }
}

async function runFixture({ reportDir, experimentDir = reportDir, id = 'putnam_test', cheat = false, noWork = false, fileCandidate = false, invalidClaim = false, hardToolError = false, selectionOnly = false, taskModel = undefined, agentAdapterFactory = null, onAdapter = null, checker = null, observationStore = null, watchdogTimeoutMs = undefined, watchdogIntervalMs = undefined, maxInfrastructureRetries = undefined, timeboxMs = 500, normalFlow = undefined }) {
  return runBenchmarkProject(problem(id), config, {
    experimentDir,
    reportDir,
    timeboxMs,
    pollMs: 1,
    turnTimeoutMs: 100,
    turnIntervalMs: 10_000,
    watchdogTimeoutMs,
    watchdogIntervalMs,
    maxInfrastructureRetries,
    ...(normalFlow === undefined ? {} : { normalFlow }),
    ...(taskModel === undefined ? {} : { taskModel }),
    stopOnSolved: true,
    repositoryCommit: 'test-repository-commit',
    repositoryWorktreeDirty: false,
    observationStore,
    agentAdapterFactory: ({ env, index }) => {
      if (agentAdapterFactory) {
        const adapter = agentAdapterFactory({ env, index });
        onAdapter?.(adapter);
        return adapter;
      }
      const adapter = new FakeAdapter({ env, cheat, noWork: noWork || (invalidClaim && index !== 1), fileCandidate, invalidClaim: invalidClaim && index === 1, hardToolError: hardToolError && index === 1, selectionOnly });
      onAdapter?.(adapter);
      return adapter;
    },
    checker: checkerWithPreflight(checker ?? {
      async check() {
        return { verdict: 'PASS', evidence: { exit_code: 0 } };
      },
    }),
  });
}

test('benchmark runtime publishes live core, execution, service, and completion observations', async () => {
  const experimentDir = await mkdtemp('/tmp/swarmenv-observed-benchmark-experiment-');
  const reportDir = await mkdtemp('/tmp/swarmenv-observed-benchmark-report-');
  const observationStore = new ObservationStore(':memory:');
  try {
    const report = await runFixture({ reportDir, experimentDir, observationStore });
    const experiment = observationStore.getExperiment(report.project.run_id);
    const events = observationStore.listEvents({ experimentId: report.project.run_id, limit: 1_000 }).events;
    assert.equal(experiment.status, 'SUCCEEDED');
    assert.ok(events.some((event) => event.kind === 'experiment_started'));
    assert.ok(events.some((event) => event.kind === 'execution_assigned' && event.execution_id));
    assert.ok(events.filter((event) => event.kind === 'execution_released').every((event) => event.task_id && event.execution_id));
    assert.ok(events.filter((event) => event.kind === 'core_capacity_released').every((event) => !event.task_id && !event.execution_id));
    assert.ok(events.some((event) => event.kind === 'workspace_revision_saved'));
    assert.ok(events.some((event) => event.source === 'task-service' && event.kind === 'dispatch.start'));
    assert.ok(events.some((event) => event.kind === 'experiment_finished'));
  } finally {
    observationStore.close();
    await rm(experimentDir, { recursive: true, force: true });
    await rm(reportDir, { recursive: true, force: true });
  }
});

test('Issue #100 benchmark profile uses a flat Mission queue and 30/25 minute Executions', async () => {
  const experimentDir = await mkdtemp('/tmp/swarmenv-flat-benchmark-experiment-');
  const reportDir = await mkdtemp('/tmp/swarmenv-flat-benchmark-report-');
  const adapters = [];
  try {
    const report = await runFixture({
      reportDir,
      experimentDir,
      id: 'putnam_flat_task_model_test',
      taskModel: 'flat',
      timeboxMs: 1_500,
      onAdapter: (adapter) => adapters.push(adapter),
    });
    assert.equal(report.protocol.task_model, 'flat');
    assert.equal(report.protocol.execution_timeout_ms, 30 * 60_000);
    assert.equal(report.protocol.handoff_reminder_ms, 25 * 60_000);
    assert.equal(report.protocol.dynamic_task_budget, null);
    assert.equal(report.project.task_count, 1);
    assert.ok(report.project.task_tree.every((task) => task.mission_id));
    assert.equal(report.project.task_tree.filter((task) => task.task_type === 'research').length, 0);
    const proofTask = report.project.task_tree.find((task) => task.task_type === 'proof');
    assert.ok(proofTask);
    assert.equal(report.project.task_tree[0].parent_id, null);
    assert.equal(report.run.protocol_valid, true);
    const boundPrompts = adapters.flatMap((adapter) => adapter.sessions.flatMap((session) => session.promptMessages));
    assert.ok(boundPrompts.length > 0);
    const prompt = boundPrompts.join('\n');
    assert.match(prompt, /current Task/);
    assert.match(prompt, /source-level Judge FAIL/);
    assert.match(prompt, /submit_candidate again/);
    assert.doesNotMatch(prompt, /required Response handoff/);
    assert.match(prompt, /bounded Materials for distinct findings or checkpoints/);
    assert.match(prompt, /do not publish duplicate copies/);
    assert.doesNotMatch(prompt, /publish two bounded Materials/);
    assert.doesNotMatch(prompt, /Branch Task|branch group|required subtask|parent review|root integration/i);
  } finally {
    await rm(experimentDir, { recursive: true, force: true });
    await rm(reportDir, { recursive: true, force: true });
  }
});

test('same identity keeps its Session through task_take and Runtime bind', async () => {
  const experimentDir = await mkdtemp('/tmp/swarmenv-take-bind-experiment-');
  const reportDir = await mkdtemp('/tmp/swarmenv-take-bind-report-');
  try {
    const report = await runFixture({
      reportDir,
      experimentDir,
      id: 'putnam_take_bind_test',
      timeboxMs: 2_000,
    });
    assert.equal(report.run.protocol_valid, true);
    assert.equal(report.run.solved, true);
    assert.ok(report.run.claim_count > 0);
    assert.ok(report.run.progress_evidence.workspace_write_count > 0);
    assert.ok(report.run.candidate_check_count > 0);
    assert.ok(report.cores.some((core) => core.claims.some((claim) => claim.workspace_revision_start !== null)));
    assert.equal(report.audit.invalid, false);
  } finally {
    await rm(experimentDir, { recursive: true, force: true });
    await rm(reportDir, { recursive: true, force: true });
  }
});

test('benchmark bounds retries after an unbound prompt startup failure', async () => {
  const experimentDir = await mkdtemp('/tmp/swarmenv-benchmark-prompt-failure-experiment-');
  const reportDir = await mkdtemp('/tmp/swarmenv-benchmark-prompt-failure-report-');
  const adapter = new PromptFailureAdapter();
  try {
    const report = await runBenchmarkProject(problem('putnam_prompt_failure_test'), config, {
      experimentDir,
      reportDir,
      timeboxMs: 2_500,
      pollMs: 1,
      turnTimeoutMs: 100,
      stopOnSolved: false,
      maxStartupAttempts: 2,
      repositoryCommit: 'test-repository-commit',
      repositoryWorktreeDirty: false,
      agentAdapterFactory: () => adapter,
      checker: checkerWithPreflight({ async check() { return { verdict: 'PASS', evidence: { exit_code: 0 } }; } }),
    });
    assert.ok(adapter.starts >= 2);
    assert.ok(adapter.starts <= 8);
    // A failed unbound prompt is retried on the same identity Session, so turn
    // attempts can exceed process starts; both counts must still be bounded.
    assert.ok(report.run.scheduler.startup_attempt_count >= adapter.starts);
    // A failed prompt on an existing Session is a turn failure, not a new
    // process start, so failures can exceed starts. Both remain bounded.
    assert.ok(report.run.scheduler.startup_failure_count >= report.run.scheduler.startup_attempt_count);
    assert.ok(report.run.scheduler.startup_failure_count <= 8);
    assert.ok(report.run.scheduler.bounded_startup_exhausted_count >= 1);
    assert.ok(report.run.scheduler.bounded_startup_exhausted_count <= 4);
    assert.equal(report.run.scheduler.dispatch_count, 0);
    assert.ok(Array.isArray(report.run.identity_loop_errors));
    assert.ok(Array.isArray(report.run.cleanup_errors));
    assert.ok(Array.isArray(report.run.unhandled_rejections));
  } finally {
    await rm(experimentDir, { recursive: true, force: true });
    await rm(reportDir, { recursive: true, force: true });
  }
});

test('benchmark invokes the Runtime watchdog and reports its activity', async () => {
  const experimentDir = await mkdtemp('/tmp/swarmenv-benchmark-watchdog-experiment-');
  const reportDir = await mkdtemp('/tmp/swarmenv-benchmark-watchdog-report-');
  try {
    const report = await runFixture({
      reportDir,
      experimentDir,
      id: 'putnam_watchdog_test',
      noWork: true,
      watchdogTimeoutMs: 1,
      watchdogIntervalMs: 1,
    });
    assert.ok(report.run.watchdog_sweep_count > 0);
    assert.equal(report.run.watchdog_error_count, 0);
  } finally {
    await rm(experimentDir, { recursive: true, force: true });
    await rm(reportDir, { recursive: true, force: true });
  }
});

test('benchmark project starts four isolated cores and redacts candidate content', async () => {
  const experimentDir = await mkdtemp('/tmp/swarmenv-benchmark-experiment-');
  const reportDir = await mkdtemp('/tmp/swarmenv-benchmark-report-');
  try {
    const adapters = [];
    const report = await runFixture({ reportDir, experimentDir, onAdapter: (adapter) => adapters.push(adapter) });
    assert.equal(report.protocol.core_count, 4);
    assert.equal(report.protocol.repository_commit, 'test-repository-commit');
    assert.equal(report.protocol.repository_worktree_dirty, false);
    assert.equal(report.parallelism.core_count, 4);
    assert.ok(Array.isArray(report.parallelism.agent_turn_intervals));
    assert.equal(report.parallelism.total_core_capacity_ms, report.parallelism.core_count * report.parallelism.elapsed_ms);
    assert.ok(Array.isArray(report.parallelism.core_state_intervals));
    assert.equal(typeof report.parallelism.decomposition_available, 'boolean');
    assert.ok(report.parallelism.decomposition_evidence.scheduler_status_count >= 0);
    assert.ok(Array.isArray(report.run.lifecycle_events));
    assert.ok(report.parallelism.work_units.every((unit) => !Object.hasOwn(unit, 'duplicate_of')));
    assert.ok(report.parallelism.work_units.every((unit) => !Object.hasOwn(unit, 'goal_fingerprint')));
    assert.ok(report.parallelism.work_units.every((unit) => !Object.hasOwn(unit, 'output_fingerprint')));
    assert.equal(typeof report.parallelism.eligible_window_ms, 'number');
    assert.ok(Object.hasOwn(report.parallelism, 'eligible_mean_active_core_count'));
    assert.ok(report.project.task_tree.length >= 2);
    assert.ok(report.project.task_tree.some((task) => task.task_type === 'proof' && task.parent_id === null));
    assert.ok(report.project.task_tree.some((task) => task.task_type === 'research'));
    assert.ok(Array.isArray(report.project.readiness.intervals));
    assert.ok(report.project.readiness.sample_count > 0);
    assert.ok(Array.isArray(report.project.structure.events));
    assert.ok(Array.isArray(report.project.structure.completion.task_contracts));
    assert.ok(Array.isArray(report.project.structure.completion.branch_and_subtask_groups));
    // Same-identity execution: every transport is the Core's reusable worker
    // Session. Bound research happens in that Session after task_take, not in
    // a separate selection/handoff process.
    assert.ok(adapters.every((adapter) => adapter.starts.every((start) => String(start.executionId ?? '').startsWith('worker-'))));
    assert.ok(adapters.some((adapter) => adapter.sessions.some((session) => session.candidateResults.length > 0)));
    assert.equal(report.run.solved, true);
    assert.equal(report.run.protocol_valid, true);
    assert.equal(report.run.made_progress, true);
    assert.ok(report.run.progress_evidence.workspace_write_count > 0);
    assert.ok(report.cores.every((core) => core.claims.every((claim) => Number.isInteger(claim.workspace_revision_start) && Number.isInteger(claim.workspace_revision_end))));
    assert.equal(report.audit.invalid, false);
    assert.equal(report.cores.length, 4);
    assert.ok(report.cores.some((core) => core.workspace_writes.length > 0));
    assert.ok(report.cores.some((core) => core.task_state === 'SATISFIED'));
    const claimedCores = report.cores.filter((core) => core.claims.length > 0);
    assert.ok(claimedCores.length > 0);
    assert.ok(claimedCores.every((core) => core.tool_events.every((tool) => tool.startsWith('swarmenv_'))));
    assert.ok(claimedCores.every((core) => !core.tool_events.includes('swarmenv_call')));
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
    assert.ok(report.cores.some((core) => core.tool_errors.some((error) =>
      error.code === 'INVALID_CONTRACT' && error.recoverable === true && error.protocol === false)));
  } finally {
    await rm(experimentDir, { recursive: true, force: true });
    await rm(reportDir, { recursive: true, force: true });
  }
});

test('non-retryable Service errors are Agent feedback and do not invalidate the run', async () => {
  const experimentDir = await mkdtemp('/tmp/swarmenv-benchmark-hard-tool-error-');
  const reportDir = await mkdtemp('/tmp/swarmenv-benchmark-hard-tool-error-report-');
  try {
    const report = await runFixture({ reportDir, experimentDir, id: 'putnam_hard_tool_error_test', hardToolError: true });
    assert.equal(report.run.protocol_valid, true);
    assert.equal(report.run.tool_protocol_error_count, 0);
    assert.ok(report.run.tool_error_count >= 1);
    assert.equal(report.audit.invalid, false);
    assert.ok(report.cores.some((core) => core.tool_errors.some((error) =>
      error.code === 'NOT_ALLOWED' && error.recoverable === false && error.protocol === false)));
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

test('checker infrastructure errors returned by submit_candidate retain actionable safe process details', async () => {
  const reportDir = await mkdtemp('/tmp/swarmenv-benchmark-checker-error-report-');
  const experimentDir = await mkdtemp('/tmp/swarmenv-benchmark-checker-error-');
  try {
    const report = await runFixture({
      reportDir,
      experimentDir,
      id: 'putnam_checker_error_test',
      maxInfrastructureRetries: 1,
      timeboxMs: 1_500,
      normalFlow: true,
      checker: {
        preflight: async () => ({ status: 'healthy', checker_process_status: 'completed', evidence: { exit_code: 0 } }),
        check: async () => ({ verdict: 'ERROR', evidence: { checker_started: false, error_code: 'ENOENT', diagnostic: 'spawn lake ENOENT' } }),
      },
    });
    const checks = report.cores.flatMap((core) => core.checks);
    assert.ok(checks.length > 0);
    assert.ok(checks.every((check) => check.result_class === 'infrastructure_failure'));
    assert.ok(checks.every((check) => check.mathematical_outcome === 'unassessed'));
    assert.ok(checks.every((check) => check.checker_process_status === 'not_started'));
    assert.ok(checks.every((check) => check.diagnostic_code === 'checker_unavailable'));
    assert.ok(checks.every((check) => Object.hasOwn(check, 'process_evidence')));
    assert.ok(checks.every((check) => check.process_evidence.error_code === 'ENOENT'));
    assert.ok(report.run.checker_infrastructure_failure_count >= 1);
    assert.ok(report.run.checker_unassessed_count >= 1);
    assert.ok(report.run.lifecycle_events.some((event) => event.operation === 'block_task' && event.dependency_kind === 'CHECK_RESULT'));
    assert.ok(report.cores.every((core) => core.execution_state === null || ['FAILED', 'FENCED'].includes(core.execution_state)));
    assert.equal(report.audit.invalid, false);
  } finally {
    await rm(experimentDir, { recursive: true, force: true });
    await rm(reportDir, { recursive: true, force: true });
  }
});

test('benchmark submit_candidate returns Agent feedback separately from the redacted report projection', async () => {
  const experimentDir = await mkdtemp('/tmp/swarmenv-agent-feedback-experiment-');
  const reportDir = await mkdtemp('/tmp/swarmenv-agent-feedback-report-');
  const adapters = [];
  try {
    const report = await runFixture({
      reportDir,
      experimentDir,
      id: 'putnam_agent_feedback_test',
      timeboxMs: 1_000,
      onAdapter: (adapter) => adapters.push(adapter),
      checker: {
        async check() {
          return {
            verdict: 'FAIL',
            evidence: {
              checker_started: true,
              exit_code: 1,
              diagnostic: 'Candidate.lean:7:4: error: type mismatch',
              stdout: 'private checker stdout',
              stderr: 'private checker stderr',
            },
          };
        },
      },
    });
    const feedback = adapters.flatMap((adapter) => adapter.sessions).flatMap((session) => session.candidateResults);
    assert.ok(feedback.length > 0, 'at least one candidate must reach the Agent tool boundary');
    const check = feedback[0].check_result;
    assert.equal(check.result_class, 'source_failure');
    assert.equal(check.status, 'APPLIED');
    assert.equal(check.mathematical_outcome, 'FAIL');
    assert.match(check.diagnostic_excerpt, /type mismatch/);
    assert.deepEqual(check.diagnostic_location, { file: 'Candidate.lean', line: 7, column: 4 });
    assert.equal(check.evidence, undefined);
    assert.equal(check.stdout, undefined);
    assert.equal(check.stderr, undefined);
    assert.ok(report.cores.flatMap((core) => core.checks).some((row) => row.diagnostic_class === 'lean_proof_error'));
    assert.equal(report.audit.invalid, false);
  } finally {
    await rm(experimentDir, { recursive: true, force: true });
    await rm(reportDir, { recursive: true, force: true });
  }
});

test('flat Judge source failure stays on the same Task and each Execution can revise in place', async () => {
  const experimentDir = await mkdtemp('/tmp/swarmenv-flat-feedback-task-experiment-');
  const reportDir = await mkdtemp('/tmp/swarmenv-flat-feedback-task-report-');
  try {
    const report = await runFixture({
      reportDir,
      experimentDir,
      id: 'putnam_flat_feedback_task_test',
      taskModel: 'flat',
      timeboxMs: 1_500,
      agentAdapterFactory: ({ env }) => new FlatFailureAdapter({ env }),
      checker: {
        async check({ candidate }) {
          return {
            verdict: candidate.content.includes('revised') ? 'PASS' : 'FAIL',
            evidence: { checker_started: true, exit_code: candidate.content.includes('revised') ? 0 : 1, diagnostic: candidate.content.includes('revised') ? 'checked' : 'type mismatch' },
          };
        },
      },
    });
    assert.equal(report.run.protocol_valid, true);
    assert.equal(report.run.dynamic_task_count, 0);
    assert.equal(report.project.task_count, 1);
    assert.equal(report.project.task_tree.filter((task) => task.responsibility_key?.startsWith('flat:proof-feedback:')).length, 0);
    // The Mission entry is intentionally shareable after Issue #111.  Each
    // reusable Core may therefore run its own FAIL -> revision chain on the
    // same logical Task; the invariant is that no repair Task or response
    // gate is created, and each chain stays on its bound Execution.
    assert.ok(report.run.candidate_check_count >= 2);
  } finally {
    await rm(experimentDir, { recursive: true, force: true });
    await rm(reportDir, { recursive: true, force: true });
  }
});

test('short four-core collaboration proves root decomposition, parallel work, typed blocking, and task completion', async () => {
  const experimentDir = await mkdtemp('/tmp/swarmenv-benchmark-collaboration-');
  const reportDir = await mkdtemp('/tmp/swarmenv-benchmark-collaboration-report-');
  try {
    const adapters = [];
    const report = await runBenchmarkProject(problem('putnam_collaboration_test'), config, {
      experimentDir,
      reportDir,
      timeboxMs: 20_000,
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
      checker: checkerWithPreflight({ async check() { return { verdict: 'PASS', evidence: { exit_code: 0 } }; } }),
    });
    assert.equal(report.run.protocol_valid, true);
    assert.equal(report.run.made_progress, true);
    assert.equal(report.run.solved, true);
    // Concurrent generic discovery may observe the same READY Task; the
    // Service conflict is recoverable Agent feedback, not a protocol failure.
    assert.ok(report.parallelism.claim_conflict_count <= report.run.claim_count);
    assert.ok(report.parallelism.max_active_core_count >= 2);
    assert.ok(report.parallelism.work_units.some((unit) => unit.progress_kind === 'child_task'));
    assert.ok(report.run.accept_count + report.run.rework_count > 0);
    assert.equal(report.parallelism.decomposition_available, true);
    assert.ok(report.run.lifecycle_events.some((event) => event.operation === 'block_task' && event.dependency_ids.length > 0));
    assert.equal(report.run.wait_count, 0);
    assert.equal(report.run.wake_count, 0);
    assert.ok(report.cores.some((core) => core.material_reads.some((read) => read.source_task_ids.includes('collab-research'))));
    const rootTaskId = report.project.task_tree.find((task) => task.parent_id === null).task_id;
    const rootNarratives = report.project.execution_narratives.filter((item) => item.task_id === rootTaskId);
    assert.ok(rootNarratives.some((item) => item.actions.some((event) => event.kind === 'material_read')),
      'Root Material reads must be bounded operator observations');
    assert.ok(rootNarratives.some((item) => item.actions.some((event) => event.kind === 'material_published')),
      'Root downstream integration must be durable operator evidence');
    assert.equal(report.project.task_tree.filter((task) => task.parent_id !== null).length, 3);
    assert.ok(report.run.claim_count >= 4, `expected root and three child claims, got ${report.run.claim_count}`);
    assert.ok(report.run.child_claim_count >= 3, `expected every child to be claimed, got ${report.run.child_claim_count}`);
    assert.ok(report.run.root_claim_count >= 2, `expected root to be reclaimed after typed blocking, got ${report.run.root_claim_count}`);
    const rootExecutionIds = new Set(report.cores.flatMap((core) => core.claims)
      .filter((claim) => claim.task_id === rootTaskId)
      .map((claim) => claim.execution_id));
    assert.ok(rootExecutionIds.size >= 2, 'typed blocking releases the root and a later claim starts a new Execution');
    assert.ok(report.run.progress_evidence.workspace_write_count >= 4);
    assert.ok(report.cores.filter((core) => core.workspace_writes.length > 0).length >= 2);
    assert.ok(report.cores.some((core) => core.claims.length >= 2), 'root core should reclaim after waiting');
    assert.ok(report.project.task_tree.some((task) => task.task_id === 'collab-research' && task.state === 'SATISFIED'));
    assert.ok(report.run.candidate_check_count >= 3, 'two child candidates and one root candidate should be checked');
    assert.equal(report.audit.invalid, false);
    assert.ok(adapters.every((adapter) => adapter.starts.length >= 1), JSON.stringify(adapters.map((adapter) => adapter.starts.length)));
    // The same identity Session continues across the Tasks it takes.
    assert.ok(adapters.every((adapter) => adapter.starts.length === 1));
  } finally {
    await rm(experimentDir, { recursive: true, force: true });
    await rm(reportDir, { recursive: true, force: true });
  }
});

test('production queue dynamically reuses Cores across typed blocking waves', async () => {
  const experimentDir = await mkdtemp('/tmp/swarmenv-benchmark-dynamic-collaboration-');
  const reportDir = await mkdtemp('/tmp/swarmenv-benchmark-dynamic-collaboration-report-');
  try {
    const adapters = [];
    const state = { rootCreated: false, rootFinished: false, childTaskIds: [], initialTaskCount: null };
    const report = await runBenchmarkProject(problem('putnam_dynamic_collaboration_test'), config, {
      experimentDir,
      reportDir,
      timeboxMs: 15_000,
      pollMs: 5_000,
      turnTimeoutMs: 1_000,
      turnIntervalMs: 10_000,
      stopOnSolved: true,
      agentAdapterFactory: ({ env }) => {
        const adapter = new DynamicCollaborationAdapter({ env, state });
        adapters.push(adapter);
        return adapter;
      },
      checker: checkerWithPreflight({ async check() { return { verdict: 'PASS', evidence: { exit_code: 0 } }; } }),
    });
    const childTasks = report.project.task_tree.filter((task) => task.parent_id !== null);
    const childTaskIds = new Set(childTasks.map((task) => task.task_id));
    const childClaims = report.cores.flatMap((core) => core.claims.filter((claim) => childTaskIds.has(claim.task_id)));
    const coreTaskSets = report.cores.map((core) => new Set(core.claims.filter((claim) => childTaskIds.has(claim.task_id)).map((claim) => claim.task_id)));
    assert.equal(report.run.protocol_valid, true);
    assert.equal(report.run.solved, true);
    assert.equal(state.initialTaskCount, 1, 'Gate A must start with only the Root Task');
    assert.equal(childTasks.length, 8);
    assert.ok(childClaims.length >= 8, `expected all children to be claimed, got ${childClaims.length}`);
    assert.ok(coreTaskSets.some((tasks) => tasks.size >= 2), 'a Core must claim different Tasks across waves');
    assert.equal(report.run.rework_count, 0);
    assert.ok(report.run.accept_count >= 4);
    assert.equal(report.run.wait_count, 0);
    assert.equal(report.run.wake_count, 0);
    assert.equal(report.run.resumed_execution_count, 0);
    assert.ok(report.parallelism.eligible_window_ms > 0);
    assert.ok(report.cores.some((core) => core.material_reads.some((read) =>
      childTaskIds.size === new Set([...childTaskIds].filter((taskId) => read.source_task_ids.includes(taskId))).size)));
    assert.ok(adapters.every((adapter) => adapter.starts.length >= 1));
    assert.ok(adapters.every((adapter) => adapter.starts.every((start) => String(start.executionId ?? '').startsWith('worker-'))), 'every transport is a reusable identity session, not a separate selection Agent');
  } finally {
    await rm(experimentDir, { recursive: true, force: true });
    await rm(reportDir, { recursive: true, force: true });
  }
});

test('production queue consumes pre-existing independent Tasks without Root synthesis', async () => {
  const experimentDir = await mkdtemp('/tmp/swarmenv-benchmark-queue-consumption-');
  const reportDir = await mkdtemp('/tmp/swarmenv-benchmark-queue-consumption-report-');
  const state = { queueOnly: true, rootCreated: false, rootFinished: false, reworkRequested: false, childTaskIds: [] };
  try {
    const adapters = [];
    const report = await runBenchmarkProject(problem('putnam_queue_consumption_test'), config, {
      experimentDir,
      reportDir,
      timeboxMs: 2_000,
      pollMs: 5_000,
      turnTimeoutMs: 1_000,
      turnIntervalMs: 10_000,
      stopOnSolved: true,
      prepareProject: ({ owner, root, taskService }) => {
        const rootClaim = owner.claim({ claim_key: 'gate-b-root-setup-claim', workspace_mode: 'clean' }, {
          operationId: 'gate-b-root-setup-claim',
          taskId: root.task_id,
          specVersion: root.spec_version,
          stateVersion: root.state_version,
        });
        const parent = owner.withContext({
          taskId: root.task_id,
          executionId: rootClaim.execution.execution_id,
          specVersion: rootClaim.execution.spec_version,
          fencingVersion: rootClaim.execution.fencing_version,
        });
        const checks = { checker_ref: 'lean', checker_version: 'mvp-1', environment_ref: config.environment_ref };
        for (let index = 0; index < 8; index += 1) {
          const currentRoot = taskService.getTask(root.task_id);
          parent.createChildTask({
            task_id: `queue-child-${index}`,
            child_creation_key: `queue-child-${index}`,
            task_type: 'proof',
            goal: `Complete the independent queue route ${index}`,
            expected_output: 'A checked proof artifact from a multi-step Workspace route',
            acceptance_conditions: { queue_route: index },
            task_instructions: 'Inspect the Workspace, compare intermediate cases, record the route in two files, publish the artifact, and submit it for checking.',
            completion_contract: {
              required_candidate: { kind: 'artifact', scope: 'proof_relevant' },
              required_check: checks,
            },
          }, {
            operationId: `gate-b-create-${index}`,
            stateVersion: currentRoot.state_version,
          });
          state.childTaskIds.push(`queue-child-${index}`);
        }
      },
      agentAdapterFactory: ({ env }) => {
        const adapter = new DynamicCollaborationAdapter({ env, state });
        adapters.push(adapter);
        return adapter;
      },
      checker: checkerWithPreflight({ async check() { return { verdict: 'PASS', evidence: { exit_code: 0 } }; } }),
    });
    const rootTask = report.project.task_tree.find((task) => task.parent_id === null);
    const childTasks = report.project.task_tree.filter((task) => task.parent_id !== null);
    const childTaskIds = new Set(childTasks.map((task) => task.task_id));
    const childClaims = report.cores.flatMap((core) => core.claims.filter((claim) => childTaskIds.has(claim.task_id)));
    const coreTaskSets = report.cores.map((core) => new Set(core.claims.filter((claim) => childTaskIds.has(claim.task_id)).map((claim) => claim.task_id)));
    assert.equal(report.run.protocol_valid, true);
    assert.equal(report.run.solved, false);
    assert.equal(report.run.root_claim_count, 0);
    assert.equal(state.rootCreated, false, 'Gate B must not enter the Root synthesis path');
    assert.equal(rootTask.state, 'RUNNING');
    assert.equal(childTasks.length, 8);
    assert.ok(childTasks.every((task) => task.state === 'SATISFIED'));
    // A failed Runtime handoff may fence and reclaim one independent Task;
    // acceptance is that every queued responsibility is consumed, not that
    // recovery is indistinguishable from a first attempt.
    assert.ok(childClaims.length >= 8);
    assert.ok(childClaims.length <= childTasks.length * 2, 'claim recovery must remain bounded per queued Task');
    assert.equal(new Set(childClaims.map((claim) => claim.task_id)).size, 8);
    assert.ok(coreTaskSets.some((tasks) => tasks.size >= 2), 'a Core must claim different pre-existing Tasks across waves');
    assert.ok(report.run.candidate_check_count >= 8);
    assert.ok(report.parallelism.eligible_window_ms > 0);
    // The same identity Session takes subsequent Tasks; a Core does not start a
    // replacement Session merely because an Execution completed.
    assert.ok(adapters.every((adapter) => adapter.starts.length === 1), `starts=${adapters.map((adapter) => adapter.starts.length).join(',')}`);
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
      checker: checkerWithPreflight({ async check() { return { verdict: 'PASS', evidence: { exit_code: 0 } }; } }),
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

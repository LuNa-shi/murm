import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { ContextService } from '../context/context-service.js';
import { JudgeService } from '../judge/judge-service.js';
import { ServicesRouter } from '../sdk/service-router.js';
import { ServicesSDK } from '../sdk/services-sdk.js';
import { TaskService } from '../task/task-service.js';
import { Runtime } from '../runtime/runtime.js';
import { WorkspaceManager } from '../runtime/workspace-manager.js';
import { GENERIC_AGENT_PROMPT } from '../agent/agent-prompt.js';

class ScriptSession extends EventEmitter {
  constructor(executionId) {
    super();
    this.executionId = executionId;
    this.closed = false;
    this.manifest = {
      agent: 'script-executor',
      script_version: 'mvp-1',
      node_version: process.versions.node,
      execution_id: executionId,
    };
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.emit('close', { code: 0, signal: 'SIGTERM' }));
  }
}

export class ScriptAgentAdapter {
  constructor() {
    this.sessions = [];
  }

  async start({ executionId }) {
    const session = new ScriptSession(executionId);
    this.sessions.push(session);
    return session;
  }
}

export function createScriptFixtureEnvironment({ database = ':memory:', rootDir, fixtureManifest, checker } = {}) {
  const databaseConnection = database instanceof DatabaseSync ? database : new DatabaseSync(database);
  const contextService = new ContextService(databaseConnection);
  const taskService = new TaskService(databaseConnection, { contextService });
  contextService.taskService = taskService;
  const configuredChecker = typeof checker === 'function' ? { check: checker } : checker;
  // ScriptExecutor is a deterministic protocol fixture rather than a real
  // Lean environment. It still supplies the same preflight seam explicitly
  // so Judge never treats a checker without a health gate as available.
  const normalizedChecker = !configuredChecker || typeof configuredChecker.preflight === 'function'
    ? configuredChecker
    : {
        ...configuredChecker,
        preflight: async ({ fixtureManifest: manifest }) => ({
          status: 'healthy',
          checker_process_status: 'completed',
          evidence: {
            preflight_supported: true,
            preflight_verified: true,
            deterministic_fixture: true,
            input_binding_verified: true,
            toolchain_version_verified: true,
            checker_version_verified: true,
            expected_checker_version: manifest.checker_version,
            observed_checker_version: manifest.checker_version,
          },
        }),
      };
  const judgeService = new JudgeService(databaseConnection, { checker: normalizedChecker });
  taskService.setCheckerHealthReader((preflightKey) => judgeService.getCheckerPreflight(preflightKey));
  const router = new ServicesRouter({ taskService, contextService });
  const sdk = new ServicesSDK(router, { actorRef: 'owner:root' });
  const agentAdapter = new ScriptAgentAdapter();
  const runtime = new Runtime({
    taskService,
    contextService,
    workspaceManager: new WorkspaceManager({ rootDir }),
    agentAdapter,
    actorRef: 'runtime:local',
  });
  return { database: databaseConnection, contextService, taskService, judgeService, router, sdk, runtime, fixtureManifest };
}

export class ScriptExecutor {
  constructor({ environment, fixtureManifest, firstCandidate = 'import Mathlib\ntheorem swarmenv_candidate : True := by exact this_is_not_a_proof', fixedCandidate = 'import Mathlib\ntheorem swarmenv_candidate : True := by trivial', executionId = 'script-execution' } = {}) {
    if (!environment) throw new TypeError('ScriptExecutor requires an environment');
    this.environment = environment;
    this.fixtureManifest = fixtureManifest ?? environment.fixtureManifest;
    this.firstCandidate = firstCandidate;
    this.fixedCandidate = fixedCandidate;
    this.executionId = executionId;
  }

  async run() {
    const { contextService, taskService, judgeService, sdk, runtime } = this.environment;
    const task = sdk.proposeTask({
      task_type: 'proof',
      goal: 'Prove the locked PutnamBench fixture theorem',
      expected_output: 'A Lean proof Artifact compiled in the locked fixture',
      acceptance_conditions: { fixture_id: this.fixtureManifest.fixture_id },
      owner_ref: 'owner:root',
      completion_contract: {
        required_candidate: { kind: 'artifact', scope: 'proof_relevant' },
        required_check: {
          checker_ref: this.fixtureManifest.checker_ref,
          checker_version: this.fixtureManifest.checker_version,
          environment_ref: this.fixtureManifest.environment_ref,
        },
      },
    }, { operationId: 'script:propose' }).task;
    const claimed = sdk.withContext({ taskId: task.task_id, specVersion: task.spec_version, stateVersion: task.state_version }).claim({
      execution_id: this.executionId,
      claim_key: `script:claim:${this.executionId}`,
      owner_ref: 'agent:script',
      agent_prompt: GENERIC_AGENT_PROMPT,
      input_material_refs: [],
    }, { operationId: 'script:claim' });
    const agent = sdk.withContext({
      actorRef: 'agent:script', taskId: task.task_id, executionId: this.executionId,
      specVersion: task.spec_version, stateVersion: claimed.execution.state_version, fencingVersion: claimed.execution.fencing_version,
    });
    const firstRun = await runtime.startExecution(this.executionId);
    let current = firstRun.execution;
    const firstMaterial = agent.withContext({ stateVersion: current.state_version }).publishMaterial({
      kind: 'artifact', scope: 'proof_relevant', content: this.firstCandidate,
    }, { operationId: 'script:candidate:fail' }).material;
    let submitted = agent.withContext({ stateVersion: current.state_version }).submitCandidate({ candidate_material_id: firstMaterial.material_id }, { operationId: 'script:submit:fail' });
    const firstWait = await runtime.requestWait(this.executionId, {
      waitCondition: { type: 'check_result_arrived', check_request_key: 'script:check:fail' },
      checkpoint: { phase: 'before-first-check', candidate_material_id: firstMaterial.material_id },
      files: { 'candidate.lean': this.firstCandidate },
    });
    const workspace = {
      task_id: task.task_id,
      execution_id: this.executionId,
      input_snapshot_hash: firstWait.execution.input_snapshot_hash,
      workspace_ref: firstWait.execution.workspace_ref,
      workspace_revision: firstWait.execution.workspace_revision,
    };
    const firstResult = await judgeService.judgeCandidate(this.#checkRequest({
      task: taskService.getTask(task.task_id), execution: firstWait.execution, workspace, material: firstMaterial,
      content: this.firstCandidate, requestKey: 'script:check:fail',
    }));
    const failed = sdk.withContext({
      taskId: task.task_id, executionId: this.executionId, specVersion: current.spec_version,
      stateVersion: firstWait.execution.state_version, fencingVersion: firstWait.execution.fencing_version,
    }).applyCheckResult({ check_result_id: firstResult.check_result_id }, { operationId: 'script:apply:fail' });
    const restored = await runtime.wakeExecution(this.executionId);
    current = restored.execution;
    const secondMaterial = agent.withContext({ stateVersion: current.state_version }).publishMaterial({
      kind: 'artifact', scope: 'proof_relevant', content: this.fixedCandidate, supersedes: firstMaterial.material_id,
    }, { operationId: 'script:candidate:pass' }).material;
    submitted = agent.withContext({ stateVersion: current.state_version }).submitCandidate({ candidate_material_id: secondMaterial.material_id }, { operationId: 'script:submit:pass' });
    const secondWait = await runtime.requestWait(this.executionId, {
      waitCondition: { type: 'check_result_arrived', check_request_key: 'script:check:pass' },
      checkpoint: { phase: 'before-second-check', candidate_material_id: secondMaterial.material_id },
      files: { 'candidate.lean': this.fixedCandidate },
    });
    const secondResult = await judgeService.judgeCandidate(this.#checkRequest({
      task: taskService.getTask(task.task_id), execution: secondWait.execution, workspace, material: secondMaterial,
      content: this.fixedCandidate, requestKey: 'script:check:pass',
    }));
    const completed = sdk.withContext({
      taskId: task.task_id, executionId: this.executionId, specVersion: current.spec_version,
      stateVersion: secondWait.execution.state_version, fencingVersion: secondWait.execution.fencing_version,
    }).applyCheckResult({ check_result_id: secondResult.check_result_id }, { operationId: 'script:apply:pass' });
    const finalTask = taskService.getTask(task.task_id);
    const finalExecution = taskService.getExecution(this.executionId);
    return {
      fixture: this.fixtureManifest,
      task: finalTask,
      execution: finalExecution,
      task_id: task.task_id,
      execution_id: this.executionId,
      material_id: secondMaterial.material_id,
      check_result_id: secondResult.check_result_id,
      material_ids: [firstMaterial.material_id, secondMaterial.material_id],
      check_result_ids: [firstResult.check_result_id, secondResult.check_result_id],
      versions: {
        node: process.version,
        script_executor: 'mvp-1',
        checker: this.fixtureManifest.checker_version,
        lean_toolchain: this.fixtureManifest.lean_toolchain,
        mathlib: this.fixtureManifest.mathlib_version,
      },
      workspace,
      materials: [firstMaterial, secondMaterial],
      check_results: [taskService.getCheckResult(firstResult.check_result_id), taskService.getCheckResult(secondResult.check_result_id)],
      workspace: {
        input_snapshot_hash: workspace.input_snapshot_hash,
        first: firstRun.workspace,
        first_wait: firstWait.execution.workspace_ref,
        restored: restored.workspace,
        second_wait: secondWait.execution.workspace_ref,
        same_lineage: firstWait.execution.workspace_ref === secondWait.execution.workspace_ref,
      },
      checkpoints: [firstWait.execution.checkpoint_ref, secondWait.execution.checkpoint_ref],
      process_sessions: runtime.agentAdapter.sessions.length,
      completed: completed.task.state === 'SATISFIED' && completed.execution.state === 'SUCCEEDED',
      failure_evidence: failed.check_result.evidence,
      stdout: '',
      stderr: '',
    };
  }

  #checkRequest({ task, execution, workspace, material, content, requestKey }) {
    return {
      request_key: requestKey,
      candidate_material_id: material.material_id,
      target_task_id: task.task_id,
      target_spec_version: task.spec_version,
      input_snapshot_hash: workspace.input_snapshot_hash,
      checker_ref: this.fixtureManifest.checker_ref,
      checker_version: this.fixtureManifest.checker_version,
      environment_ref: this.fixtureManifest.environment_ref,
      execution_id: execution.execution_id,
      state_version: execution.state_version,
      candidate: { material_id: material.material_id, content },
      target_task: task,
      workspace,
      fixture_manifest: this.fixtureManifest,
    };
  }
}

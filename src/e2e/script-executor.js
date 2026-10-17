import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { ContextService } from '../context/context-service.js';
import { JudgeService } from '../judge/judge-service.js';
import { ServicesRouter } from '../sdk/service-router.js';
import { ServicesSDK } from '../sdk/services-sdk.js';
import { TaskService } from '../task/task-service.js';
import { Runtime } from '../runtime/runtime.js';
import { WorkspaceManager } from '../runtime/workspace-manager.js';

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
  const normalizedChecker = typeof checker === 'function' ? { check: checker } : checker;
  const judgeService = new JudgeService(databaseConnection, { checker: normalizedChecker });
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
    const frozen = sdk.freezeInitialContext({
      freeze_key: `script:freeze:${this.executionId}`,
      task_id: task.task_id,
      execution_id: this.executionId,
      spec_version: task.spec_version,
      spec_hash: task.spec_hash,
      task_spec: { ...task, fixture_manifest: this.fixtureManifest },
      initial_prompt: 'Use the frozen PutnamBench fixture and submit a proof Artifact.',
      material_refs: [],
      service_environment: { fixture_manifest: this.fixtureManifest, checker: this.fixtureManifest.checker_ref },
    }, { operationId: 'script:freeze', taskId: task.task_id, executionId: this.executionId, specVersion: task.spec_version, fencingVersion: 1 });
    const claimed = sdk.withContext({ taskId: task.task_id, specVersion: task.spec_version, stateVersion: task.state_version }).claim({
      execution_id: this.executionId,
      claim_key: `script:claim:${this.executionId}`,
      owner_ref: 'agent:script',
      initial_prompt: 'Use the frozen PutnamBench fixture and submit a proof Artifact.',
      initial_context_ref: frozen.initial_context_ref,
      input_snapshot_hash: frozen.input_snapshot_hash,
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
    const initialContext = contextService.getInitialContext(this.executionId);
    const firstResult = await judgeService.judgeCandidate(this.#checkRequest({
      task: taskService.getTask(task.task_id), execution: firstWait.execution, initialContext, material: firstMaterial,
      content: this.firstCandidate, requestKey: 'script:check:fail',
    }));
    const failed = sdk.withContext({
      taskId: task.task_id, executionId: this.executionId, specVersion: current.spec_version,
      stateVersion: firstWait.execution.state_version, fencingVersion: firstWait.execution.fencing_version,
    }).applyCheckResult({ check_result_id: firstResult.check_result_id }, { operationId: 'script:apply:fail' });
    const restored = await runtime.startExecution(this.executionId);
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
      task: taskService.getTask(task.task_id), execution: secondWait.execution, initialContext, material: secondMaterial,
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
      initial_context: initialContext,
      materials: [firstMaterial, secondMaterial],
      check_results: [taskService.getCheckResult(firstResult.check_result_id), taskService.getCheckResult(secondResult.check_result_id)],
      workspace: {
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

  #checkRequest({ task, execution, initialContext, material, content, requestKey }) {
    return {
      request_key: requestKey,
      candidate_material_id: material.material_id,
      target_task_id: task.task_id,
      target_spec_version: task.spec_version,
      input_snapshot_hash: initialContext.input_snapshot_hash,
      checker_ref: this.fixtureManifest.checker_ref,
      checker_version: this.fixtureManifest.checker_version,
      environment_ref: this.fixtureManifest.environment_ref,
      execution_id: execution.execution_id,
      state_version: execution.state_version,
      candidate: { material_id: material.material_id, content },
      target_task: task,
      initial_context: initialContext,
      fixture_manifest: this.fixtureManifest,
    };
  }
}

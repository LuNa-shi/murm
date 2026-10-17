import { execFile as defaultExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { AgentCoreAdapter, resolveAgentCoreRoute } from '../agent/pi-adapter.js';
import { ContextService } from '../context/context-service.js';
import { ServicesBridge } from '../agent/services-bridge.js';
import { ServicesRouter } from '../sdk/service-router.js';
import { ServicesSDK } from '../sdk/services-sdk.js';
import { TaskService } from '../task/task-service.js';
import { Runtime } from '../runtime/runtime.js';
import { WorkspaceManager } from '../runtime/workspace-manager.js';
import { JudgeService } from '../judge/judge-service.js';
import { LeanChecker } from '../judge/lean-adapter.js';
import { validateFixtureManifest } from '../judge/fixture.js';
import { DatabaseSync } from 'node:sqlite';

const execFile = promisify(defaultExecFile);
const extensionPath = fileURLToPath(new URL('../agent/swarmenv-extension.mjs', import.meta.url));
const ROUTING_FIELDS = Object.freeze([
  'NUROUTER_PI_PROVIDER',
  'NUROUTER_PI_MODEL',
]);

function present(value) {
  return typeof value === 'string' && value.length > 0;
}

function safeVersion(value) {
  return typeof value === 'string' ? value.trim().split(/\r?\n/, 1)[0].slice(0, 200) : null;
}

async function commandVersion(command) {
  try {
    const result = await execFile(command, ['--version'], { timeout: 5_000, maxBuffer: 16 * 1024 });
    return { available: true, version: safeVersion(result.stdout || result.stderr) };
  } catch (error) {
    return { available: false, error: error.code === 'ENOENT' ? 'not installed' : error.message };
  }
}

export async function probeRealAgentConfig({ env = process.env } = {}) {
  const missing = ROUTING_FIELDS.filter((field) => !present(env[field]));
  const routeBlockers = [];
  if (present(env.NUROUTER_PI_PROVIDER)) {
    try {
      resolveAgentCoreRoute({
        provider: env.NUROUTER_PI_PROVIDER,
        account: env.NUROUTER_PI_ACCOUNT,
        group: env.NUROUTER_PI_GROUP,
      });
    } catch (error) {
      routeBlockers.push(error.message);
    }
  }
  const [node, nurouter, pi, lean, lake] = await Promise.all([
    Promise.resolve({ available: true, version: process.version }),
    commandVersion('nurouter'),
    commandVersion('pi'),
    commandVersion('lean'),
    commandVersion('lake'),
  ]);
  const unavailableTools = [
    ['nurouter', nurouter], ['pi', pi], ['lean', lean], ['lake', lake],
  ].filter(([, result]) => !result.available).map(([name]) => name);
  const blockers = [];
  if (missing.length > 0) blockers.push('missing NuRouter/Pi routing configuration');
  blockers.push(...routeBlockers);
  if (unavailableTools.length > 0) blockers.push(`missing local commands: ${unavailableTools.join(', ')}`);
  return {
    status: blockers.length === 0 ? 'READY_TO_LAUNCH' : 'BLOCKED',
    missing,
    blockers,
    versions: { node, nurouter, pi, lean, lake },
    secret_values_recorded: false,
  };
}

function promptForCandidate({ phase, candidate, previousMaterialId = null }) {
  const supersedes = previousMaterialId ? ` Set supersedes to ${previousMaterialId}.` : '';
  return [
    `You are running phase ${phase} of the current SwarmEnv proof Execution.`,
    'Use the public swarmenv_call tool for every Task, Execution, Material, and candidate operation.',
    'First call get_task and get_execution so you work against the current versions.',
    `Publish the following exact Lean source as one artifact Material with kind=artifact and scope=proof_relevant.${supersedes}`,
    'Then call submit_candidate with the returned material_id. Do not call request_wait; the Runtime controller will save the checkpoint after your turn.',
    'Do not claim completion in prose. Finish after the candidate submission.',
    'Candidate source:',
    candidate,
  ].join('\n');
}

async function runAgentTurn(session, prompt, { timeoutMs = 180_000 } = {}) {
  await session.waitForReady({ timeoutMs: 15_000 });
  const sequence = session.rpcRecords.length;
  const response = await session.prompt(prompt, { timeoutMs: 30_000 });
  const settled = response?.data?.disposition === 'handled'
    ? { type: 'agent_settled', handled: true }
    : await session.waitForSettled({ timeoutMs, afterSequence: sequence });
  return { response, settled, rpc_records: session.rpcRecords.slice(sequence).map((record) => record.type) };
}

function latestArtifact(contextService, executionId, previousId = null) {
  return contextService.readMaterials({ source_execution: executionId, kind: 'artifact' })
    .filter((material) => material.material_id !== previousId)
    .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.material_id.localeCompare(right.material_id))
    .at(-1) ?? null;
}

function checkRequest({ task, execution, initialContext, fixtureManifest, material, requestKey }) {
  return {
    request_key: requestKey,
    candidate_material_id: material.material_id,
    target_task_id: task.task_id,
    target_spec_version: task.spec_version,
    input_snapshot_hash: initialContext.input_snapshot_hash,
    checker_ref: fixtureManifest.checker_ref,
    checker_version: fixtureManifest.checker_version,
    environment_ref: fixtureManifest.environment_ref,
    execution_id: execution.execution_id,
    state_version: execution.state_version,
    candidate: { material_id: material.material_id, content: material.content },
    target_task: task,
    initial_context: initialContext,
    fixture_manifest: fixtureManifest,
  };
}

export async function runRealAgentPath({
  database = ':memory:',
  rootDir,
  fixtureManifest,
  firstCandidate = null,
  fixedCandidate = null,
  env = process.env,
  command = 'nurouter',
  timeoutMs = 180_000,
} = {}) {
  const probe = await probeRealAgentConfig({ env });
  const report = {
    mode: 'real-agent',
    status: probe.status === 'READY_TO_LAUNCH' ? 'RUNNING' : probe.status,
    probe,
    task_id: null,
    execution_id: null,
    material_ids: [],
    check_result_ids: [],
    secret_values_recorded: false,
  };
  if (probe.status !== 'READY_TO_LAUNCH') {
    report.reason = 'Real Agent Core cannot run until the local Lean/Lake toolchain and NuRouter/Pi routing configuration are available.';
    return report;
  }
  if (!rootDir || !firstCandidate || !fixedCandidate) {
    report.status = 'FAILED_TO_LAUNCH';
    report.reason = 'real-agent path requires rootDir, firstCandidate, and fixedCandidate';
    return report;
  }

  const lockedFixture = { ...fixtureManifest };
  if (env.SWARMENV_PUTNAMBENCH_ROOT) lockedFixture.project_root = env.SWARMENV_PUTNAMBENCH_ROOT;
  validateFixtureManifest(lockedFixture);
  const databaseConnection = database instanceof DatabaseSync ? database : new DatabaseSync(database);
  const contextService = new ContextService(databaseConnection);
  const taskService = new TaskService(databaseConnection, { contextService });
  contextService.taskService = taskService;
  const judgeService = new JudgeService(databaseConnection, { checker: new LeanChecker({ workRoot: rootDir }) });
  const router = new ServicesRouter({ taskService, contextService });
  const ownerSdk = new ServicesSDK(router, { actorRef: 'owner:root' });
  const task = ownerSdk.proposeTask({
    task_type: 'proof',
    goal: 'Prove the locked PutnamBench fixture theorem with the real Agent Core',
    expected_output: 'A Lean proof Artifact compiled in the locked fixture',
    acceptance_conditions: { fixture_id: lockedFixture.fixture_id },
    owner_ref: 'owner:root',
    completion_contract: {
      required_candidate: { kind: 'artifact', scope: 'proof_relevant' },
      required_check: {
        checker_ref: lockedFixture.checker_ref,
        checker_version: lockedFixture.checker_version,
        environment_ref: lockedFixture.environment_ref,
      },
    },
  }, { operationId: 'real:propose' }).task;
  const executionId = 'real-agent-execution';
  const frozen = ownerSdk.freezeInitialContext({
    freeze_key: `real:freeze:${executionId}`, task_id: task.task_id, execution_id: executionId,
    spec_version: task.spec_version, spec_hash: task.spec_hash, task_spec: { ...task, fixture_manifest: lockedFixture },
    initial_prompt: 'Use the locked fixture and the public SwarmEnv Services SDK bridge to submit a proof candidate.',
    material_refs: [], service_environment: { fixture_manifest: lockedFixture, checker: lockedFixture.checker_ref },
  }, { operationId: 'real:freeze', taskId: task.task_id, executionId, specVersion: task.spec_version, fencingVersion: 1 });
  const claimed = ownerSdk.withContext({ actorRef: 'agent:real', taskId: task.task_id, specVersion: task.spec_version, stateVersion: task.state_version }).claim({
    execution_id: executionId, claim_key: `real:claim:${executionId}`, owner_ref: 'agent:real',
    initial_prompt: 'Use the locked fixture and the public SwarmEnv Services SDK bridge to submit a proof candidate.',
    initial_context_ref: frozen.initial_context_ref, input_snapshot_hash: frozen.input_snapshot_hash, input_material_refs: [],
  }, { operationId: 'real:claim' });
  report.task_id = task.task_id;
  report.execution_id = executionId;
  report.initial_context = {
    initial_context_ref: frozen.initial_context_ref,
    input_snapshot_hash: frozen.input_snapshot_hash,
    spec_version: frozen.initial_context.spec_version,
    spec_hash: frozen.initial_context.spec_hash,
  };
  report.claim = {
    execution_id: claimed.execution.execution_id,
    state_version: claimed.execution.state_version,
    fencing_version: claimed.execution.fencing_version,
  };

  const childEnv = { ...env };
  const adapter = new AgentCoreAdapter({
    command,
    provider: env.NUROUTER_PI_PROVIDER,
    model: env.NUROUTER_PI_MODEL,
    account: env.NUROUTER_PI_ACCOUNT,
    group: env.NUROUTER_PI_GROUP,
    extensionPath,
    env: childEnv,
  });
  const runtime = new Runtime({ taskService, contextService, workspaceManager: new WorkspaceManager({ rootDir }), agentAdapter: adapter, actorRef: 'runtime:local' });
  const bridge = new ServicesBridge({ taskService, contextService, runtime, router, taskId: task.task_id, executionId });
  let firstRun;
  let secondRun;
  let firstWait;
  let secondWait;
  let firstResult;
  let secondResult;
  try {
    Object.assign(childEnv, await bridge.start());
    firstRun = await runtime.startExecution(executionId);
    report.launch = { workspace_ref: firstRun.execution.workspace_ref, runtime_manifest: firstRun.session.manifest };
    report.first_agent = await runAgentTurn(firstRun.session, promptForCandidate({ phase: 'first invalid candidate', candidate: firstCandidate }), { timeoutMs });
    const firstMaterial = latestArtifact(contextService, executionId);
    if (!firstMaterial) throw new Error('real Agent did not publish a first artifact Material through Services SDK');
    report.material_ids.push(firstMaterial.material_id);
    firstWait = await runtime.requestWait(executionId, {
      waitCondition: { type: 'check_result_arrived', check_request_key: 'real:check:fail' },
      checkpoint: { phase: 'before-first-check', candidate_material_id: firstMaterial.material_id },
      files: { 'candidate.lean': firstMaterial.content },
    });
    const initialContext = contextService.getInitialContext(executionId);
    firstResult = await judgeService.judgeCandidate(checkRequest({ task: taskService.getTask(task.task_id), execution: firstWait.execution, initialContext, fixtureManifest: lockedFixture, material: firstMaterial, requestKey: 'real:check:fail' }));
    const failed = ownerSdk.withContext({ actorRef: 'owner:root', taskId: task.task_id, executionId, specVersion: firstWait.execution.spec_version, stateVersion: firstWait.execution.state_version, fencingVersion: firstWait.execution.fencing_version }).applyCheckResult({ check_result_id: firstResult.check_result_id }, { operationId: 'real:apply:fail' });
    report.check_result_ids.push(firstResult.check_result_id);
    report.failure_evidence = failed.check_result.evidence;
    if (firstResult.verdict !== 'FAIL') throw new Error(`real Agent first candidate expected FAIL, got ${firstResult.verdict}`);

    secondRun = await runtime.startExecution(executionId);
    report.second_agent = await runAgentTurn(secondRun.session, promptForCandidate({ phase: 'fixed candidate', candidate: fixedCandidate, previousMaterialId: firstMaterial.material_id }), { timeoutMs });
    const secondMaterial = latestArtifact(contextService, executionId, firstMaterial.material_id);
    if (!secondMaterial) throw new Error('real Agent did not publish a superseding artifact Material through Services SDK');
    if (secondMaterial.supersedes !== firstMaterial.material_id) throw new Error('real Agent fixed candidate did not supersede the failed artifact');
    report.material_ids.push(secondMaterial.material_id);
    secondWait = await runtime.requestWait(executionId, {
      waitCondition: { type: 'check_result_arrived', check_request_key: 'real:check:pass' },
      checkpoint: { phase: 'before-second-check', candidate_material_id: secondMaterial.material_id },
      files: { 'candidate.lean': secondMaterial.content },
    });
    const secondContext = contextService.getInitialContext(executionId);
    secondResult = await judgeService.judgeCandidate(checkRequest({ task: taskService.getTask(task.task_id), execution: secondWait.execution, initialContext: secondContext, fixtureManifest: lockedFixture, material: secondMaterial, requestKey: 'real:check:pass' }));
    const completed = ownerSdk.withContext({ actorRef: 'owner:root', taskId: task.task_id, executionId, specVersion: secondWait.execution.spec_version, stateVersion: secondWait.execution.state_version, fencingVersion: secondWait.execution.fencing_version }).applyCheckResult({ check_result_id: secondResult.check_result_id }, { operationId: 'real:apply:pass' });
    report.check_result_ids.push(secondResult.check_result_id);
    report.fixture = lockedFixture;
    report.versions = { node: process.version, pi: secondRun.session.manifest.pi_version ?? null, nurouter: secondRun.session.manifest.nurouter_version ?? null, lean_toolchain: lockedFixture.lean_toolchain, mathlib: lockedFixture.mathlib_version, checker: lockedFixture.checker_version };
    report.workspace = { first: firstRun.workspace, first_wait: firstWait.execution.workspace_ref, restored: secondRun.workspace, second_wait: secondWait.execution.workspace_ref, same_lineage: firstWait.execution.workspace_ref === secondWait.execution.workspace_ref, checkpoints: [firstWait.execution.checkpoint_ref, secondWait.execution.checkpoint_ref] };
    report.check_results = [taskService.getCheckResult(firstResult.check_result_id), taskService.getCheckResult(secondResult.check_result_id)];
    report.materials = [contextService.getMaterial(report.material_ids[0]), contextService.getMaterial(report.material_ids[1])];
    report.task = completed.task;
    report.execution = completed.execution;
    report.status = completed.task.state === 'SATISFIED' && completed.execution.state === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED';
    return report;
  } catch (error) {
    report.status = 'FAILED';
    report.reason = error.message;
    report.task = taskService.getTask(task.task_id);
    report.execution = taskService.getExecution(executionId);
    if (firstResult) report.check_results = [taskService.getCheckResult(firstResult.check_result_id)];
    if (secondResult) report.check_results?.push(taskService.getCheckResult(secondResult.check_result_id));
    return report;
  } finally {
    const execution = taskService.getExecution(executionId);
    if (execution?.state === 'RUNNING') await runtime.stopExecution(executionId, 'FAILED').catch(() => undefined);
    await bridge.stop();
    taskService.close();
  }
}

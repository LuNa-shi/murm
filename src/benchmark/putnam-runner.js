import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { cpus, freemem, totalmem } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { AgentCoreAdapter } from '../agent/pi-adapter.js';
import { ContextService } from '../context/context-service.js';
import { JudgeService } from '../judge/judge-service.js';
import { LeanChecker } from '../judge/lean-adapter.js';
import { Runtime } from '../runtime/runtime.js';
import { WorkspaceManager } from '../runtime/workspace-manager.js';
import { ServicesBridge } from '../agent/services-bridge.js';
import { ServicesRouter } from '../sdk/service-router.js';
import { ServicesSDK } from '../sdk/services-sdk.js';
import { TaskService } from '../task/task-service.js';
import { makeEnvelope, stableStringify } from '../protocol/envelope.js';
import { DurableEventLog } from '../observability/durable-event-log.js';
import { GENERIC_AGENT_PROMPT } from '../agent/agent-prompt.js';

const execFileAsync = (command, args) => new Promise((resolvePromise, reject) => {
  execFile(command, args, { encoding: 'utf8' }, (error, stdout) => {
    if (error) reject(error);
    else resolvePromise(String(stdout).trim());
  });
});

const FORBIDDEN_PLACEHOLDER = /\b(?:sorry|admit|axiom)\b/i;
const SAFE_PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function inputSnapshotHash(task, inputMaterialRefs) {
  return sha256(stableStringify({
    task_id: task.task_id,
    spec_hash: task.spec_hash,
    workspace: task.workspace,
    input_material_refs: inputMaterialRefs,
  }));
}

function safeDiagnostic(value) {
  const text = String(value ?? '');
  if (!text) return null;
  if (/unknown module prefix 'Mathlib'/.test(text)) return 'missing_mathlib_build';
  if (/sorry|admit|axiom/i.test(text)) return 'forbidden_placeholder';
  if (/timed out|timeout/i.test(text)) return 'checker_timeout';
  if (/unknown identifier|type mismatch|unsolved goals|application type mismatch/i.test(text)) return 'lean_proof_error';
  return 'lean_checker_error';
}

function required(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} is required`);
  return value;
}

function sdk(router, context) {
  return new ServicesSDK(router, context);
}

function executionContext(router, execution, actorRef) {
  return sdk(router, {
    actorRef,
    taskId: execution.task_id,
    executionId: execution.execution_id,
    specVersion: execution.spec_version,
    stateVersion: execution.state_version,
    fencingVersion: execution.fencing_version,
  });
}

function taskContext(router, task, actorRef) {
  return sdk(router, {
    actorRef,
    taskId: task.task_id,
    specVersion: task.spec_version,
    stateVersion: task.state_version,
  });
}

function fixtureManifest(problem, sourceHash, leanProjectRoot, config) {
  return {
    fixture_id: `putnam-${problem.id}`,
    putnambench_commit: config.putnambench_commit,
    problem_file: problem.problem_file,
    problem_file_hash: sourceHash,
    lean_toolchain: config.lean_toolchain,
    mathlib_version: config.mathlib_version,
    checker_ref: config.checker_ref,
    checker_version: config.checker_version,
    environment_ref: config.environment_ref,
    project_root: leanProjectRoot,
  };
}

function validateProblemInput(problem, source) {
  if (!SAFE_PROJECT_ID.test(problem.id)) throw new TypeError(`unsafe problem id: ${problem.id}`);
  if (problem.problem_file.includes('solution') || problem.problem_file.includes('candidate')) {
    throw new TypeError(`problem file is outside the input policy: ${problem.problem_file}`);
  }
  if (!/\bsorry\b/.test(source)) {
    throw new TypeError(`problem input must be an unsolved formalization: ${problem.id}`);
  }
}

function restrictedArgs(args) {
  return [
    ...args,
    '--no-builtin-tools',
    '--no-skills',
    '--no-prompt-templates',
    '--no-context-files',
    '--thinking',
    'high',
  ];
}

function collectToolEvents(core, records) {
  for (const record of records) {
    const tool = record.toolName ?? record.tool_name ?? record.name;
    if (record.type === 'tool_call' || record.type === 'tool_result' || tool) {
      core.toolEvents.push(tool ?? record.type);
    }
  }
}

export class BenchmarkAgentCoreAdapter extends AgentCoreAdapter {
  buildLaunchArgs(options) {
    return restrictedArgs(super.buildLaunchArgs(options));
  }
}

export async function loadBenchmarkConfig(configPath, { putnamBenchRoot, verifyPinnedCheckout = false } = {}) {
  const config = JSON.parse(await readFile(resolve(configPath), 'utf8'));
  required(putnamBenchRoot, 'putnamBenchRoot');
  if (!Array.isArray(config.problems) || config.problems.length !== 12) {
    throw new TypeError('benchmark config must contain exactly 12 problems');
  }
  const root = resolve(putnamBenchRoot);
  if (verifyPinnedCheckout) {
    const actualCommit = await execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD']);
    if (actualCommit !== config.putnambench_commit) {
      throw new TypeError(`PutnamBench checkout does not match pinned commit ${config.putnambench_commit}`);
    }
  }
  const leanProjectRoot = resolve(root, 'lean4');
  const projectRoot = await readFile(join(leanProjectRoot, 'lean-toolchain'), 'utf8')
    .then(() => leanProjectRoot)
    .catch(() => root);
  const seen = new Set();
  const problems = [];
  for (const problem of config.problems) {
    if (seen.has(problem.id)) throw new TypeError(`duplicate problem id: ${problem.id}`);
    seen.add(problem.id);
    const sourcePath = join(root, problem.problem_file);
    const sourceRelativePath = relative(root, sourcePath);
    if (sourceRelativePath.startsWith('..') || sourceRelativePath.includes('\\')) {
      throw new TypeError(`problem file escapes PutnamBench root: ${problem.problem_file}`);
    }
    const source = await readFile(sourcePath, 'utf8');
    validateProblemInput(problem, source);
    problems.push({
      ...problem,
      source_path: sourcePath,
      source_hash: sha256(source),
      source,
    });
  }
  return { ...config, putnam_bench_root: root, lean_project_root: projectRoot, problems };
}

async function runTurn(core, prompt, timeoutMs) {
  if (core.turnInFlight) return;
  core.turnInFlight = true;
  const session = core.session;
  if (!session) {
    core.turnInFlight = false;
    return;
  }
  const sequence = session.rpcRecords.length;
  try {
    await session.waitForReady({ timeoutMs: Math.min(timeoutMs, 30_000) });
    const response = await session.prompt(prompt, { timeoutMs: Math.min(timeoutMs, 30_000) });
    if (response?.data?.disposition !== 'handled') {
      await session.waitForSettled({ timeoutMs, afterSequence: sequence });
    }
    core.turns += 1;
    core.lastTurn = { status: 'settled', elapsed_ms: Date.now() - core.turnStartedAt };
    core.turnDurationsMs.push(core.lastTurn.elapsed_ms);
  } catch (error) {
    core.turns += 1;
    if (!core.stopping) {
      const expectedHandoff = session.expectedStop || core.session !== session;
      if (!expectedHandoff) {
        core.errors.push({
          code: error.code ?? error.name,
          class: safeDiagnostic(error.message) ?? 'agent_turn_error',
        });
      }
    }
    if (/timeout|timed out/i.test(`${error.code ?? ''} ${error.message ?? ''}`)) core.turnTimeoutCount += 1;
    core.lastTurn = {
      status: 'error',
      code: error.code ?? error.name,
      class: safeDiagnostic(error.message) ?? 'agent_turn_error',
    };
    core.turnDurationsMs.push(Date.now() - core.turnStartedAt);
  } finally {
    collectToolEvents(core, session.rpcRecords.slice(sequence));
    core.turnInFlight = false;
    core.nextTurnAt = Date.now() + core.turnIntervalMs;
  }
}

function scheduleTurn(core, prompt, timeoutMs) {
  if (core.turnInFlight || Date.now() < core.nextTurnAt) return;
  core.turnStartedAt = Date.now();
  core.turnPromise = runTurn(core, prompt, timeoutMs);
}

async function startAgentSession(core) {
  core.sessionNumber += 1;
  const suffix = core.sessionNumber === 1 ? 'worker-session' : `worker-session-${core.sessionNumber}`;
  const session = await core.adapter.start({
    executionId: `worker-${core.startConfig.problem.id}-core-${core.index}-session-${core.sessionNumber}`,
    sessionDir: join(core.coreDir, '.swarm', suffix),
    cwd: core.coreDir,
    logger: new DurableEventLog(join(core.startConfig.logRoot, 'agents', `core-${core.index}.ndjson`), { raw: true, scope: `agent:core-${core.index}` }),
  });
  core.session = session;
  core.sessionHistory.push(session);
  core.versionManifest = session.manifest ?? null;
  await session.waitForReady({ timeoutMs: core.startConfig.options.turnTimeoutMs ?? 30_000 });
  const initialSequence = session.rpcRecords.length;
  core.turnInFlight = true;
  core.turnStartedAt = Date.now();
  const initialResponse = await session.prompt(GENERIC_AGENT_PROMPT, { timeoutMs: core.startConfig.options.turnTimeoutMs ?? 30_000 });
  core.initialTurnPromise = (async () => {
    try {
      if (initialResponse?.data?.disposition !== 'handled' && typeof session.waitForSettled === 'function') {
        await session.waitForSettled({ timeoutMs: Math.max(core.startConfig.options.turnTimeoutMs ?? 30_000, 180_000), afterSequence: initialSequence });
      }
      core.lastTurn = { status: 'settled', elapsed_ms: Date.now() - core.turnStartedAt };
    } catch (error) {
      const expectedHandoff = session.expectedStop || core.session !== session;
      if (!core.stopping && !expectedHandoff) core.errors.push({ code: error.code ?? error.name, class: safeDiagnostic(error.message) ?? 'agent_turn_error' });
      core.lastTurn = { status: 'error', code: error.code ?? error.name, class: safeDiagnostic(error.message) ?? 'agent_turn_error' };
      if (/timeout|timed out/i.test(`${error.code ?? ''} ${error.message ?? ''}`)) core.turnTimeoutCount += 1;
    } finally {
      collectToolEvents(core, session.rpcRecords.slice(initialSequence));
      core.turns += 1;
      core.turnDurationsMs.push(core.lastTurn.elapsed_ms ?? Date.now() - core.turnStartedAt);
      if (core.session === session) {
        core.turnInFlight = false;
        core.nextTurnAt = Date.now();
      }
      if (core.session !== session && !session.closed) session.stop();
    }
  })();
}

async function ensureAgentSession(core) {
  if (core.releasedSession) {
    if (!core.releasedSession.closed) return;
    core.releasedSession = null;
  }
  if (core.session?.closed) core.session = null;
  if (core.stopping || core.session || core.turnInFlight) return;
  try {
    await startAgentSession(core);
  } catch (error) {
    if (!core.stopping) core.errors.push({ code: error.code ?? error.name, class: safeDiagnostic(error.message) ?? 'agent_session_error' });
  }
}

async function releaseTerminalExecution(core) {
  if (!core.executionId) return;
  const execution = core.runtime.taskService.getExecution(core.executionId);
  if (!execution || !['SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED', 'FENCED', 'SUPERSEDED'].includes(execution.state)) return;
  const active = core.runtime.activeProcesses.get(core.executionId);
  if (active) {
    active.session.stop();
    core.runtime.activeProcesses.delete(core.executionId);
  } else {
    core.session?.stop();
  }
  if (execution.workspace_ref) {
    await core.workspaceManager.releaseWorkspace({
      workspaceRef: execution.workspace_ref,
      executionId: execution.execution_id,
      fencingVersion: execution.fencing_version,
    }).catch(() => undefined);
  }
  await core.bridge.releaseClaim({ result: { execution } });
}

function sanitizedCheck(result, material) {
  return {
    candidate_material_id: material.material_id,
    material_hash: material.content_hash,
    verdict: result.verdict,
    check_result_id: result.check_result_id,
    diagnostic_class: safeDiagnostic(result.evidence?.diagnostic),
  };
}

function sanitizedVersionManifest(manifest) {
  if (!manifest) return null;
  return {
    pi_package: manifest.pi_package ?? null,
    pi_version: manifest.pi_version ?? null,
    nurouter_version: manifest.nurouter_version ?? null,
    node_version: manifest.node_version ?? null,
  };
}

function reportKeyViolations(value, path = 'report', violations = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => reportKeyViolations(item, `${path}[${index}]`, violations));
    return violations;
  }
  if (!value || typeof value !== 'object') return violations;
  const forbiddenKeys = new Set(['formal_source', 'candidate_content', 'proof_text', 'raw_transcript', 'stdout', 'stderr']);
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKeys.has(key)) violations.push(`${path}.${key}`);
    reportKeyViolations(child, `${path}.${key}`, violations);
  }
  return violations;
}

export function validateBenchmarkReport(report) {
  if (!report || report.schema_version !== 1 || !report.protocol || !report.project || !report.run || !report.audit) {
    throw new TypeError('benchmark report has an invalid schema');
  }
  const violations = reportKeyViolations(report);
  if (violations.length > 0) throw new TypeError(`benchmark report contains redacted fields: ${violations.join(', ')}`);
  if (report.audit.raw_transcript_exported || report.audit.proof_contents_exported) {
    throw new TypeError('benchmark report export policy was violated');
  }
  return true;
}

function resourceSnapshot() {
  return {
    logical_cpus: cpus().length,
    total_memory_bytes: totalmem(),
    available_memory_bytes: freemem(),
  };
}

async function publishFeedback(state, core, material, result, { taskId = core.taskId, executionId = core.executionId } = {}) {
  const execution = state.taskService.getExecution(executionId);
  if (!execution || !['CREATED', 'RUNNING', 'WAITING'].includes(execution.state)) return;
  state.contextService.dispatch('publish_material', {
    kind: 'experience',
    scope: 'judge_feedback',
    evidence_state: 'checked',
    content: {
      project: state.problem.id,
      target_material_hash: material.content_hash,
      verdict: result.verdict,
      check_result_id: result.check_result_id,
      diagnostic_class: safeDiagnostic(result.evidence?.diagnostic),
    },
    provenance: { actor_ref: 'judge:lean', project: state.problem.id, target_task_id: taskId },
  }, makeEnvelope({
    operationId: `benchmark:feedback:${state.runId}:${core.index}:${result.check_result_id}`,
    actorRef: 'judge:lean',
    taskId: core.taskId,
    executionId: core.executionId,
    specVersion: execution.spec_version,
    stateVersion: execution.state_version,
    fencingVersion: execution.fencing_version,
  }));
}

async function judgeCandidate(state, core) {
  const pending = [...core.claimHistory].reverse().map((claim) => ({
    taskId: claim.task_id,
    executionId: claim.execution_id,
    execution: state.taskService.getExecution(claim.execution_id),
  })).find(({ execution }) => execution && ['CREATED', 'RUNNING', 'WAITING'].includes(execution.state) && execution.candidate_material_id && !core.checked.has(execution.candidate_material_id));
  if (!pending) return;
  const task = state.taskService.getTask(pending.taskId);
  const execution = pending.execution;
  if (!task) return;
  const candidateId = execution.candidate_material_id;
  const material = state.contextService.getMaterial(candidateId);
  if (!material) return;
  core.checked.add(candidateId);
  const content = typeof material.content === 'string' ? material.content : JSON.stringify(material.content);
  if (FORBIDDEN_PLACEHOLDER.test(content)) {
    core.cheatingFlags.push({ kind: 'forbidden_placeholder', material_hash: material.content_hash });
  }
  const workspace = {
    execution_id: pending.executionId,
    task_id: task.task_id,
    input_snapshot_hash: execution.input_snapshot_hash,
    workspace_ref: execution.workspace_ref,
    workspace_revision: execution.workspace_revision,
    manifest: {
      input_snapshot_hash: execution.input_snapshot_hash,
      task_spec: task,
      workspace: task.workspace,
    },
  };
  const checkStartedAt = Date.now();
  const result = await state.judgeService.judgeCandidate({
    request_key: `benchmark:check:${state.runId}:${core.index}:${candidateId}`,
    candidate_material_id: candidateId,
    target_task_id: task.task_id,
    target_spec_version: task.spec_version,
    input_snapshot_hash: workspace.input_snapshot_hash,
    checker_ref: state.fixtureManifest.checker_ref,
    checker_version: state.fixtureManifest.checker_version,
    environment_ref: state.fixtureManifest.environment_ref,
    execution_id: pending.executionId,
    state_version: execution.state_version,
    candidate: { material_id: candidateId, content },
    target_task: task,
    workspace,
    fixture_manifest: state.fixtureManifest,
  }, {
    operationId: `benchmark:judge:${state.runId}:${core.index}:${candidateId}`,
    actorRef: 'judge:lean',
  });
  const fresh = state.taskService.getExecution(pending.executionId);
  const applied = executionContext(state.router, fresh, 'judge:controller').applyCheckResult({
    check_result_id: result.check_result_id,
  }, {
    operationId: `benchmark:apply:${state.runId}:${core.index}:${candidateId}`,
  });
  core.checks.push({ ...sanitizedCheck(result, material), check_elapsed_ms: Date.now() - checkStartedAt });
  await publishFeedback(state, core, material, result, { taskId: pending.taskId, executionId: pending.executionId });
  if (result.verdict === 'PASS' && applied.task.state === 'SATISFIED') {
    state.solvedAt = Date.now();
    state.solvedBy = core.index;
  }
}

async function stopCore(state, core) {
  core.stopping = true;
  const execution = core.executionId ? state.taskService.getExecution(core.executionId) : null;
  const active = core.executionId ? core.runtime.activeProcesses.get(core.executionId) : null;
  if (active) {
    active.session.stop();
    core.runtime.activeProcesses.delete(core.executionId);
  } else if (core.session) {
    core.session.stop();
  } else if (core.releasedSession) {
    core.releasedSession.stop?.();
  }
  if (core.turnPromise) {
    await Promise.race([
      core.turnPromise.catch(() => undefined),
      sleep(5_000),
    ]);
  }
  if (execution?.workspace_ref) {
    await core.workspaceManager.releaseWorkspace({
      workspaceRef: execution.workspace_ref,
      executionId: core.executionId,
      fencingVersion: execution.fencing_version,
    }).catch(() => undefined);
  }
  const current = core.executionId ? state.taskService.getExecution(core.executionId) : null;
  if (current && ['CREATED', 'RUNNING', 'WAITING'].includes(current.state)) {
    await core.runtime.stopExecution(core.executionId, 'FAILED').catch(() => undefined);
  }
  await core.bridge.stop().catch(() => undefined);
}

function projectReport(state, startedAt, deadline) {
  for (const core of state.cores) {
    for (const session of core.sessionHistory) collectToolEvents(core, session.rpcRecords);
  }
  const materials = state.contextService.readMaterials({});
  const taskTree = state.taskService.listTasks({
    rootId: state.rootTaskId,
    states: ['OPEN', 'BLOCKED', 'RUNNING', 'WAITING', 'SATISFIED', 'FAILED', 'CANCELLED', 'REJECTED'],
    limit: 100,
    availableOnly: false,
  });
  const claimHistory = state.cores.flatMap((core) => core.claimHistory);
  const allowedTaskIds = new Set([state.rootTaskId, ...claimHistory.map((claim) => claim.task_id)]);
  const allowedExecutionIds = new Set(claimHistory.map((claim) => claim.execution_id));
  const materialBoundaryViolation = materials.some((material) =>
    !allowedTaskIds.has(material.source_task) || !allowedExecutionIds.has(material.source_execution));
  const rootTask = state.taskService.getTask(state.rootTaskId);
  const inputMaterialViolation = !rootTask?.workspace || rootTask.workspace.source_hash !== state.inputMaterialHash;
  const workspaceViolation = claimHistory.some((claim) => {
    const execution = state.taskService.getExecution(claim.execution_id);
    const task = state.taskService.getTask(claim.task_id);
    return !execution || !task?.workspace || execution.input_material_refs.length !== 0 ||
      execution.input_snapshot_hash !== inputSnapshotHash(task, execution.input_material_refs);
  });
  const cores = state.cores.map((core) => {
    const task = state.taskService.getTask(core.taskId);
    const execution = state.taskService.getExecution(core.executionId);
    return {
      core: core.index,
      task_id: core.taskId,
      execution_id: core.executionId,
      turns: core.turns,
      turn_durations_ms: core.turnDurationsMs,
      turn_timeout_count: core.turnTimeoutCount,
      checks: core.checks,
      errors: core.errors,
      cheating_flags: core.cheatingFlags,
      claims: core.claimHistory,
      tool_events: [...new Set(core.toolEvents)],
      task_state: task?.state ?? null,
      execution_state: execution?.state ?? null,
      input_snapshot_hash: execution?.input_snapshot_hash ?? null,
      workspace_ref: execution?.workspace_ref ?? null,
      versions: sanitizedVersionManifest(core.versionManifest),
    };
  });
  const toolViolation = cores.some((core) => core.tool_events.some((tool) => tool !== 'swarmenv_call' && !String(tool).startsWith('swarmenv_')));
  const claimedExecutionIds = [...new Set(claimHistory.map((claim) => claim.execution_id))];
  const workspaceRefs = claimedExecutionIds.map((executionId) => state.taskService.getExecution(executionId)?.workspace_ref).filter(Boolean);
  const workspaceBoundaryViolation = workspaceRefs.length !== claimedExecutionIds.length || new Set(workspaceRefs).size !== workspaceRefs.length;
  const candidateBoundaryViolation = claimHistory.some((claim) => {
    const execution = state.taskService.getExecution(claim.execution_id);
    if (!execution?.candidate_material_id) return false;
    const material = state.contextService.getMaterial(execution.candidate_material_id);
    return !material || material.source_task !== claim.task_id || material.source_execution !== claim.execution_id;
  });
  const invalid = toolViolation || materialBoundaryViolation || inputMaterialViolation || workspaceViolation || workspaceBoundaryViolation ||
    candidateBoundaryViolation || cores.some((core) => core.cheating_flags.length > 0);
  const report = {
    schema_version: 1,
    protocol: {
      project_isolation: true,
      core_count: 4,
      input_policy: 'pinned formalization only; no candidate or solution input',
      tool_policy: 'registered swarmenv_* Service tools; swarmenv_call is compatibility-only',
      cheating_policy: 'placeholder or non-SwarmEnv tool event invalidates the project',
    },
    project: {
      problem_id: state.problem.id,
      tags: state.problem.tags ?? [],
      source_hash: state.problem.source_hash,
      fixture_id: state.fixtureManifest.fixture_id,
      putnambench_commit: state.fixtureManifest.putnambench_commit,
      lean_toolchain: state.fixtureManifest.lean_toolchain,
      mathlib_version: state.fixtureManifest.mathlib_version,
      checker_version: state.fixtureManifest.checker_version,
      run_id: state.runId,
      database_path: state.databasePath,
      input_workspace_hash: state.inputMaterialHash,
      task_count: taskTree.length,
      task_tree: taskTree.map((task) => ({
        task_id: task.task_id,
        parent_id: task.parent_id,
        task_type: task.task_type,
        priority: task.priority,
        state: task.state,
      })),
    },
    run: {
      started_at: new Date(startedAt).toISOString(),
      ended_at: new Date().toISOString(),
      elapsed_ms: Date.now() - startedAt,
      deadline_ms: deadline - startedAt,
      solved: state.solvedAt !== null && !invalid,
      solved_by_core: invalid ? null : state.solvedBy,
      solved_at_ms: state.solvedAt === null ? null : state.solvedAt - startedAt,
      material_count: materials.length,
      project_material_count: materials.filter((material) => material.source_task === state.rootTaskId).length,
      candidate_count: cores.reduce((count, core) => count + core.checks.length, 0),
      ended_early: state.stopOnSolved && state.solvedAt !== null,
      deadline_reached: Date.now() >= deadline,
      cleanup_elapsed_ms: state.cleanupElapsedMs,
      resources_at_start: state.resourcesAtStart,
      resources_at_end: resourceSnapshot(),
      heartbeat_count: state.heartbeatCount,
      heartbeat_error_count: state.heartbeatErrorCount,
      candidate_check_count: cores.reduce((count, core) => count + core.checks.length, 0),
      claimed_core_count: new Set(state.cores.filter((core) => core.claimHistory.length > 0).map((core) => core.index)).size,
      claim_count: claimHistory.length,
    },
    cores,
    audit: {
      input_source_hash: state.problem.source_hash,
      prompt_hashes: state.cores.map((core) => ({ core: core.index, prompt_hash: sha256(core.prompt) })),
      all_tool_events: [...new Set(cores.flatMap((core) => core.tool_events))],
      invalid,
      invalid_reasons: [
        ...(toolViolation ? ['non_swarmenv_tool_event'] : []),
        ...(materialBoundaryViolation ? ['material_boundary_violation'] : []),
        ...(inputMaterialViolation ? ['input_material_violation'] : []),
      ...(workspaceViolation ? ['workspace_violation'] : []),
        ...(workspaceBoundaryViolation ? ['workspace_boundary_violation'] : []),
        ...(candidateBoundaryViolation ? ['candidate_provenance_violation'] : []),
        ...(cores.some((core) => core.cheating_flags.length > 0) ? ['forbidden_placeholder'] : []),
      ],
      candidate_materials: cores.flatMap((core) => core.checks),
      raw_transcript_exported: false,
      proof_contents_exported: false,
    },
  };
  validateBenchmarkReport(report);
  return report;
}

async function createProjectState(problem, config, options) {
  const runId = options.runId ?? randomUUID();
  const experimentRoot = resolve(options.experimentDir ?? options.reportDir);
  const reportRoot = resolve(options.reportDir ?? join(experimentRoot, 'reports'));
  const projectDir = join(experimentRoot, 'state', 'projects', problem.id);
  const reportProjectDir = join(reportRoot, problem.id);
  const workspaceRoot = join(experimentRoot, 'workspaces', 'projects', problem.id);
  const logRoot = join(experimentRoot, 'logs', 'projects', problem.id);
  await Promise.all([
    mkdir(projectDir, { recursive: true }),
    mkdir(reportProjectDir, { recursive: true }),
    mkdir(workspaceRoot, { recursive: true }),
    mkdir(logRoot, { recursive: true }),
  ]);
  const databasePath = join(projectDir, 'project.sqlite');
  const serviceLogger = (name) => new DurableEventLog(join(logRoot, 'services', `${name}.ndjson`), { scope: name });
  const taskLogger = serviceLogger('task-service');
  const contextLogger = serviceLogger('context-service');
  const routerLogger = serviceLogger('service-router');
  const judgeLogger = serviceLogger('judge-service');
  const checkerLogger = new DurableEventLog(join(logRoot, 'judge', 'lean-checker.ndjson'), { raw: true, scope: 'judge:lean-checker' });
  const database = new DatabaseSync(databasePath);
  const contextService = new ContextService(database, { logger: contextLogger });
  const taskService = new TaskService(database, { contextService, logger: taskLogger });
  contextService.taskService = taskService;
  const router = new ServicesRouter({ taskService, contextService, logger: routerLogger });
  const owner = sdk(router, { actorRef: 'owner:benchmark' });
  const fixture = fixtureManifest(problem, problem.source_hash, config.lean_project_root ?? config.putnam_bench_root, config);
  const inputMetadata = {
    putnambench_commit: fixture.putnambench_commit,
    lean_toolchain: fixture.lean_toolchain,
    mathlib_version: fixture.mathlib_version,
    checker_ref: fixture.checker_ref,
    checker_version: fixture.checker_version,
    environment_ref: fixture.environment_ref,
  };
  const judgeService = new JudgeService(database, {
    logger: judgeLogger,
    checker: options.checker ?? new LeanChecker({
      workRoot: join(projectDir, 'judge-work'),
      logger: checkerLogger,
      command: options.leanCommand ?? 'lake',
      timeoutMs: options.checkerTimeoutMs ?? 120_000,
    }),
  });
  const root = owner.proposeTask({
    task_type: 'proof',
    goal: `Prove ${problem.id}`,
    expected_output: 'A verified Lean proof for the locked PutnamBench problem',
    task_instructions: 'Attempt the proof in the Workspace and submit only a real Lean proof artifact. Use only the locked problem Workspace and registered SwarmEnv Services; do not use external answers, hidden solution files, shell, web, or solution-derived input. Do not submit sorry, admit, axiom, or placeholder code. If the route is incomplete, publish the blocker and either create a focused child Task or wait according to the Task contract.',
    completion_contract: {
      required_candidate: { kind: 'artifact', scope: 'proof_relevant' },
      required_check: {
        checker_ref: fixture.checker_ref,
        checker_version: fixture.checker_version,
        environment_ref: fixture.environment_ref,
      },
    },
    acceptance_conditions: { project: problem.id, source_hash: problem.source_hash },
    owner_ref: 'owner:benchmark',
    workspace: {
      project: problem.id,
      problem_file: problem.problem_file,
      source_hash: problem.source_hash,
      input_metadata: inputMetadata,
      formal_source: problem.source,
    },
    max_children: 32,
    max_depth: 3,
  }, { operationId: `benchmark:root:propose:${runId}` }).task;
  const cores = [];
  try {
    for (let index = 1; index <= 4; index += 1) {
    const coreDir = join(workspaceRoot, `core-${index}`);
    const childEnv = { ...process.env };
    const adapter = options.agentAdapterFactory
      ? options.agentAdapterFactory({ index, problem, executionId: null, coreDir, env: childEnv })
      : new BenchmarkAgentCoreAdapter({
        command: options.command ?? 'nurouter',
        provider: options.provider ?? process.env.NUROUTER_PI_PROVIDER,
        model: options.model ?? process.env.NUROUTER_PI_MODEL,
        account: options.account ?? process.env.NUROUTER_PI_ACCOUNT,
        group: options.group ?? process.env.NUROUTER_PI_GROUP,
        extensionPath: options.extensionPath ?? resolve(new URL('../agent/swarmenv-extension.mjs', import.meta.url).pathname),
        cwd: coreDir,
        sessionDir: join(coreDir, '.swarm', 'pi-session'),
        env: childEnv,
      });
    // All reusable slots must be able to resume an Execution created by any
    // other slot. The physical Workspace is execution-owned and unique, but
    // its Runtime root is project-wide rather than core-private.
    const workspaceManager = new WorkspaceManager({ rootDir: workspaceRoot });
    const runtime = new Runtime({
      taskService,
      contextService,
      workspaceManager,
      agentAdapter: adapter,
      maxWorkers: 1,
      actorRef: `runtime:core-${index}`,
      logger: new DurableEventLog(join(logRoot, 'runtime', `core-${index}.ndjson`), { scope: `runtime:core-${index}` }),
      agentLogger: new DurableEventLog(join(logRoot, 'agents', `core-${index}.ndjson`), { raw: true, scope: `agent:core-${index}` }),
    });
    const core = {
      index,
      coreDir,
      adapter,
      childEnv,
      taskId: null,
      executionId: null,
      prompt: GENERIC_AGENT_PROMPT,
      claim: null,
      claimHistory: [],
      runtime,
      workspaceManager,
      bridge: null,
      session: null,
      releasedSession: null,
      sessionHistory: [],
      sessionNumber: 0,
      startConfig: { problem, logRoot, options },
      turnInFlight: false,
      turnPromise: null,
      initialTurnPromise: null,
      turnStartedAt: 0,
      nextTurnAt: 0,
      turnIntervalMs: options.turnIntervalMs ?? 10 * 60_000,
      turns: 0,
      toolEvents: [],
      errors: [],
      checks: [],
      checked: new Set(),
      cheatingFlags: [],
      stopping: false,
      turnDurationsMs: [],
      turnTimeoutCount: 0,
      versionManifest: null,
    };
    const bridge = new ServicesBridge({
      taskService,
      contextService,
      runtime,
      router,
      actorRef: `agent:core-${index}`,
      onClaim: async (claim) => {
        core.taskId = claim.task.task_id;
        core.executionId = claim.execution.execution_id;
        core.claim = claim;
        const workerSession = core.session;
        if (!workerSession) throw new Error('Agent claimed a Task before its session was registered');
        await runtime.bindAgentExecution(claim.execution.execution_id, null, {
          workspaceRef: join(workspaceRoot, claim.execution.execution_id),
          startSession: async ({ execution, workspace }) => {
            const session = await core.adapter.start({
              executionId: execution.execution_id,
              sessionDir: join(workspace.workspace_ref, '.swarm', 'pi-session'),
              cwd: workspace.workspace_ref,
              logger: new DurableEventLog(join(logRoot, 'agents', `core-${core.index}.ndjson`), { raw: true, scope: `agent:core-${core.index}` }),
            });
            core.session = session;
            core.sessionHistory.push(session);
            core.versionManifest = session.manifest ?? null;
            return session;
          },
          agentPrompt: GENERIC_AGENT_PROMPT,
        });
        const boundSession = core.session;
        if (boundSession && core.runtime.activeProcesses.has(claim.execution.execution_id)) {
          core.turnInFlight = true;
          void (async () => {
            try {
              if (typeof boundSession.waitForSettled === 'function') await boundSession.waitForSettled({ timeoutMs: Math.max(core.startConfig.options.turnTimeoutMs ?? 30_000, 180_000) });
            } catch (error) {
              const expectedHandoff = boundSession.expectedStop || core.session !== boundSession || core.stopping;
              if (!expectedHandoff) core.errors.push({ code: error.code ?? error.name, class: safeDiagnostic(error.message) ?? 'agent_turn_error' });
            } finally {
              collectToolEvents(core, boundSession.rpcRecords ?? []);
              if (core.session === boundSession) {
                core.turns += 1;
                core.turnInFlight = false;
                core.nextTurnAt = Date.now();
              }
            }
          })();
        }
        core.claimHistory.push({ task_id: claim.task.task_id, execution_id: claim.execution.execution_id });
        // The worker session is only the claim transport. Its handoff is
        // completed after its current prompt settles; the bound session is
        // already running in the selected Workspace.
        if (core.session === workerSession) core.session = null;
      },
      onRelease: async ({ taskId, executionId }) => {
        if (core.taskId === taskId && core.executionId === executionId) {
          core.releasedSession = core.session;
          core.taskId = null;
          core.executionId = null;
          core.claim = null;
          core.session = null;
          core.turnInFlight = false;
        }
      },
      logger: new DurableEventLog(join(logRoot, 'bridge', `core-${index}.ndjson`), { scope: `bridge:core-${index}` }),
    });
    core.bridge = bridge;
    cores.push(core);
    }
    await Promise.all(cores.map(async (core) => {
      Object.assign(core.childEnv, await core.bridge.start());
      await startAgentSession(core);
    }));
  } catch (error) {
    for (const core of cores.reverse()) {
      core.session?.stop();
      if (core.executionId && core.runtime.activeProcesses.has(core.executionId)) {
        await core.runtime.stopExecution(core.executionId, 'FAILED').catch(() => undefined);
      }
      await core.bridge?.stop().catch(() => undefined);
    }
    taskService.close();
    throw error;
  }
  return {
    runId,
    problem,
    config,
    fixtureManifest: fixture,
    databasePath,
    projectDir,
    rootTaskId: root.task_id,
    reportProjectDir,
    experimentDir: experimentRoot,
    logRoot,
    inputMaterialId: null,
    inputMaterialHash: problem.source_hash,
    taskService,
    contextService,
    router,
    judgeService,
    cores,
    solvedAt: null,
    solvedBy: null,
    stopOnSolved: options.stopOnSolved === true,
    cleanupElapsedMs: null,
    heartbeatCount: 0,
    heartbeatErrorCount: 0,
    resourcesAtStart: resourceSnapshot(),
  };
}

export async function runBenchmarkProject(problem, config, options = {}) {
  const state = await createProjectState(problem, config, options);
  const startedAt = Date.now();
  const durationMs = options.timeboxMs ?? 60 * 60_000;
  const deadline = startedAt + durationMs;
  const turnTimeoutMs = options.turnTimeoutMs ?? 9 * 60_000;
  const basePrompt = (core) => core.taskId
    ? 'This is a follow-up turn for your current claimed Execution. Read all new Materials, especially judge_feedback, inspect the current Workspace and Execution state, and refine or submit your route.'
    : core.prompt;
  try {
    await Promise.all(state.cores.map(async (core) => {
      core.nextTurnAt = Date.now();
    }));
    const heartbeat = setInterval(() => {
      for (const core of state.cores) {
        const execution = state.taskService.getExecution(core.executionId);
        if (execution && ['CREATED', 'RUNNING'].includes(execution.state)) {
          try {
            core.runtime.heartbeat(core.executionId);
            state.heartbeatCount += 1;
          } catch (error) {
            state.heartbeatErrorCount += 1;
            core.errors.push({ code: error.code ?? error.name, class: safeDiagnostic(error.message) ?? 'heartbeat_error' });
          }
        }
      }
    }, options.heartbeatMs ?? 10_000);
    try {
      while (Date.now() < deadline && (!state.stopOnSolved || state.solvedAt === null)) {
        await sleep(options.pollMs ?? 5_000);
        for (const core of state.cores) {
          await ensureAgentSession(core);
          await judgeCandidate(state, core).catch((error) => {
            core.errors.push({ code: error.code ?? error.name, class: safeDiagnostic(error.message) ?? 'judge_error' });
          });
          if (state.solvedAt === null) await releaseTerminalExecution(core);
          if (!core.turnInFlight && Date.now() < deadline && state.solvedAt === null) {
            scheduleTurn(core, basePrompt(core), turnTimeoutMs);
          }
        }
      }
    } finally {
      clearInterval(heartbeat);
    }
    for (const core of state.cores) {
      await judgeCandidate(state, core).catch((error) => {
        core.errors.push({ code: error.code ?? error.name, class: safeDiagnostic(error.message) ?? 'final_judge_error' });
      });
    }
  } finally {
    const cleanupStartedAt = Date.now();
    for (const core of state.cores) await stopCore(state, core);
    state.cleanupElapsedMs = Date.now() - cleanupStartedAt;
  }
  const report = projectReport(state, startedAt, deadline);
  await writeFile(join(state.reportProjectDir, 'report.json'), JSON.stringify(report, null, 2));
  state.taskService.close();
  return report;
}

export async function runBenchmarkBatch(problems, config, options = {}) {
  const concurrency = Math.max(1, Math.min(options.projectParallelism ?? 1, problems.length));
  const reports = [];
  let next = 0;
  async function worker() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= problems.length) return;
      try {
        reports[index] = await runBenchmarkProject(problems[index], config, options);
      } catch (error) {
        const report = {
          schema_version: 1,
          protocol: {
            project_isolation: true,
            core_count: 4,
            input_policy: 'pinned formalization only; no candidate or solution input',
            tool_policy: 'registered swarmenv_* Service tools; swarmenv_call is compatibility-only',
            cheating_policy: 'placeholder or non-SwarmEnv tool event invalidates the project',
          },
          project: { problem_id: problems[index].id, source_hash: problems[index].source_hash ?? null },
          run: { solved: false, elapsed_ms: null, deadline_reached: false, cleanup_elapsed_ms: null },
          audit: { invalid: true, invalid_reasons: ['project_runner_error'], raw_transcript_exported: false, proof_contents_exported: false },
          error: { code: error.code ?? error.name, class: safeDiagnostic(error.message) ?? 'project_runner_error' },
        };
        validateBenchmarkReport(report);
        reports[index] = report;
        const projectDir = join(resolve(options.reportDir ?? options.experimentDir), problems[index].id);
        await mkdir(projectDir, { recursive: true });
        await writeFile(join(projectDir, 'report.json'), JSON.stringify(report, null, 2));
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return reports;
}

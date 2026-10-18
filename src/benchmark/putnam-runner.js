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
import { makeEnvelope } from '../protocol/envelope.js';

const execFileAsync = (command, args) => new Promise((resolvePromise, reject) => {
  execFile(command, args, { encoding: 'utf8' }, (error, stdout) => {
    if (error) reject(error);
    else resolvePromise(String(stdout).trim());
  });
});

const DEFAULT_ROLES = Object.freeze([
  'independent proof planner',
  'library researcher',
  'adversarial checker',
  'integrator',
]);
const FORBIDDEN_PLACEHOLDER = /\b(?:sorry|admit|axiom)\b/i;
const SAFE_PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
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
    const tool = record.tool_name ?? record.name;
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

function projectPrompt(problem, coreIndex, role) {
  return [
    `You are Agent Core ${coreIndex} of 4 in the isolated SwarmEnv project ${problem.id}.`,
    `Your role is ${role}. The only mathematical input is the shared Context Service Material with scope=problem_statement.`,
    'That Material is the pinned formal theorem statement with a sorry placeholder and contains no solution.',
    'Use only the public swarmenv_call tool. Built-in filesystem, shell, web, skill, prompt-template, and context-file tools are disabled.',
    'Do not use external references, hidden files, answer corpora, known candidates, or any solution-derived input.',
    'Do not use sorry, admit, axiom, or any placeholder. The submitted artifact must be a real Lean source candidate.',
    'At the start of each turn call get_task, get_execution, and read_materials. Read sibling Materials before proposing a route.',
    'Publish reasoning as kind=experience or conjecture, scope=proof_relevant. Publish a complete source as kind=artifact, scope=proof_relevant, then submit_candidate.',
    'A candidate is only a proposal until the Lean Judge accepts it. Read judge_feedback Materials and revise after FAIL.',
  ].join('\n');
}

async function runTurn(core, prompt, timeoutMs) {
  if (core.turnInFlight) return;
  core.turnInFlight = true;
  const sequence = core.session.rpcRecords.length;
  try {
    await core.session.waitForReady({ timeoutMs: Math.min(timeoutMs, 30_000) });
    const response = await core.session.prompt(prompt, { timeoutMs: Math.min(timeoutMs, 30_000) });
    if (response?.data?.disposition !== 'handled') {
      await core.session.waitForSettled({ timeoutMs, afterSequence: sequence });
    }
    core.turns += 1;
    core.lastTurn = { status: 'settled', elapsed_ms: Date.now() - core.turnStartedAt };
    core.turnDurationsMs.push(core.lastTurn.elapsed_ms);
  } catch (error) {
    core.turns += 1;
    core.errors.push({
      code: error.code ?? error.name,
      class: safeDiagnostic(error.message) ?? 'agent_turn_error',
    });
    if (/timeout|timed out/i.test(`${error.code ?? ''} ${error.message ?? ''}`)) core.turnTimeoutCount += 1;
    core.lastTurn = {
      status: 'error',
      code: error.code ?? error.name,
      class: safeDiagnostic(error.message) ?? 'agent_turn_error',
    };
    core.turnDurationsMs.push(Date.now() - core.turnStartedAt);
  } finally {
    collectToolEvents(core, core.session.rpcRecords.slice(sequence));
    core.turnInFlight = false;
    core.nextTurnAt = Date.now() + core.turnIntervalMs;
  }
}

function scheduleTurn(core, prompt, timeoutMs) {
  if (core.turnInFlight || Date.now() < core.nextTurnAt) return;
  core.turnStartedAt = Date.now();
  core.turnPromise = runTurn(core, prompt, timeoutMs);
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

async function publishFeedback(state, core, material, result) {
  const execution = state.taskService.getExecution(core.executionId);
  if (!execution || !['CREATED', 'RUNNING'].includes(execution.state)) return;
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
    provenance: { actor_ref: 'judge:lean', project: state.problem.id, target_task_id: core.taskId },
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
  const task = state.taskService.getTask(core.taskId);
  const execution = state.taskService.getExecution(core.executionId);
  if (!task || !execution || !['CREATED', 'RUNNING'].includes(execution.state)) return;
  const candidateId = execution.candidate_material_id;
  if (!candidateId || core.checked.has(candidateId)) return;
  const material = state.contextService.getMaterial(candidateId);
  if (!material) return;
  core.checked.add(candidateId);
  const content = typeof material.content === 'string' ? material.content : JSON.stringify(material.content);
  if (FORBIDDEN_PLACEHOLDER.test(content)) {
    core.cheatingFlags.push({ kind: 'forbidden_placeholder', material_hash: material.content_hash });
  }
  const initialContext = state.contextService.getInitialContext(core.executionId);
  const checkStartedAt = Date.now();
  const result = await state.judgeService.judgeCandidate({
    request_key: `benchmark:check:${state.runId}:${core.index}:${candidateId}`,
    candidate_material_id: candidateId,
    target_task_id: task.task_id,
    target_spec_version: task.spec_version,
    input_snapshot_hash: initialContext.input_snapshot_hash,
    checker_ref: state.fixtureManifest.checker_ref,
    checker_version: state.fixtureManifest.checker_version,
    environment_ref: state.fixtureManifest.environment_ref,
    execution_id: core.executionId,
    state_version: execution.state_version,
    candidate: { material_id: candidateId, content },
    target_task: task,
    initial_context: initialContext,
    fixture_manifest: state.fixtureManifest,
  }, {
    operationId: `benchmark:judge:${state.runId}:${core.index}:${candidateId}`,
    actorRef: 'judge:lean',
  });
  const fresh = state.taskService.getExecution(core.executionId);
  const applied = executionContext(state.router, fresh, 'judge:controller').applyCheckResult({
    check_result_id: result.check_result_id,
  }, {
    operationId: `benchmark:apply:${state.runId}:${core.index}:${candidateId}`,
  });
  core.checks.push({ ...sanitizedCheck(result, material), check_elapsed_ms: Date.now() - checkStartedAt });
  await publishFeedback(state, core, material, result);
  if (result.verdict === 'PASS' && applied.task.state === 'SATISFIED') {
    state.solvedAt = Date.now();
    state.solvedBy = core.index;
  }
}

async function stopCore(state, core) {
  const execution = state.taskService.getExecution(core.executionId);
  const active = core.runtime.activeProcesses.get(core.executionId);
  if (active) {
    active.session.stop();
    core.runtime.activeProcesses.delete(core.executionId);
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
  const current = state.taskService.getExecution(core.executionId);
  if (current && ['CREATED', 'RUNNING', 'WAITING'].includes(current.state)) {
    await core.runtime.stopExecution(core.executionId, 'FAILED').catch(() => undefined);
  }
  await core.bridge.stop().catch(() => undefined);
}

function projectReport(state, startedAt, deadline) {
  const materials = state.contextService.readMaterials({});
  const allowedTaskIds = new Set([state.rootTaskId, ...state.cores.map((core) => core.taskId)]);
  const allowedExecutionIds = new Set([state.rootExecutionId, ...state.cores.map((core) => core.executionId)]);
  const materialBoundaryViolation = materials.some((material) =>
    !allowedTaskIds.has(material.source_task) || !allowedExecutionIds.has(material.source_execution));
  const inputMaterial = state.contextService.getMaterial(state.inputMaterialId);
  const inputMaterialViolation = !inputMaterial || inputMaterial.content_hash !== state.inputMaterialHash ||
    inputMaterial.source_task !== state.rootTaskId || inputMaterial.source_execution !== state.rootExecutionId;
  const initialContextViolation = state.cores.some((core) => {
    const execution = state.taskService.getExecution(core.executionId);
    const initialContext = state.contextService.getInitialContext(core.executionId);
    return !execution || !initialContext || execution.input_snapshot_hash !== initialContext.input_snapshot_hash ||
      !execution.input_material_refs.some((reference) => reference === state.inputMaterialId);
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
      tool_events: [...new Set(core.toolEvents)],
      task_state: task?.state ?? null,
      execution_state: execution?.state ?? null,
      input_snapshot_hash: execution?.input_snapshot_hash ?? null,
      workspace_ref: execution?.workspace_ref ?? null,
      versions: sanitizedVersionManifest(core.versionManifest),
    };
  });
  const toolViolation = cores.some((core) => core.tool_events.some((tool) => tool !== 'swarmenv_call'));
  const workspaceRefs = cores.map((core) => core.workspace_ref).filter(Boolean);
  const workspaceBoundaryViolation = workspaceRefs.length !== 4 || new Set(workspaceRefs).size !== workspaceRefs.length;
  const candidateBoundaryViolation = state.cores.some((core) => {
    const execution = state.taskService.getExecution(core.executionId);
    if (!execution?.candidate_material_id) return false;
    const material = state.contextService.getMaterial(execution.candidate_material_id);
    return !material || material.source_task !== core.taskId || material.source_execution !== core.executionId;
  });
  const invalid = toolViolation || materialBoundaryViolation || inputMaterialViolation || initialContextViolation || workspaceBoundaryViolation ||
    candidateBoundaryViolation || cores.some((core) => core.cheating_flags.length > 0);
  const report = {
    schema_version: 1,
    protocol: {
      project_isolation: true,
      core_count: 4,
      input_policy: 'pinned formalization only; no candidate or solution input',
      tool_policy: 'swarmenv_call only',
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
      input_material_hash: state.inputMaterialHash,
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
        ...(initialContextViolation ? ['initial_context_violation'] : []),
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
  const projectDir = join(resolve(options.reportDir), problem.id);
  await mkdir(projectDir, { recursive: true });
  const databasePath = join(projectDir, 'project.sqlite');
  const database = new DatabaseSync(databasePath);
  const contextService = new ContextService(database);
  const taskService = new TaskService(database, { contextService });
  contextService.taskService = taskService;
  const router = new ServicesRouter({ taskService, contextService });
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
    checker: options.checker ?? new LeanChecker({
      workRoot: projectDir,
      command: options.leanCommand ?? 'lake',
      timeoutMs: options.checkerTimeoutMs ?? 120_000,
    }),
  });
  const root = owner.proposeTask({
    task_type: 'default',
    goal: `Run four collaborative proof cores for ${problem.id}`,
    expected_output: 'Four isolated proof Executions sharing Context Service Material',
    acceptance_conditions: { project: problem.id, core_count: 4, source_hash: problem.source_hash },
    owner_ref: 'owner:benchmark',
    max_children: 4,
    max_depth: 3,
  }, { operationId: `benchmark:root:propose:${runId}` }).task;
  const controllerExecutionId = `benchmark-${problem.id}-controller`;
  const rootFrozen = owner.freezeInitialContext({
    freeze_key: `benchmark:root:freeze:${runId}`,
    task_id: root.task_id,
    execution_id: controllerExecutionId,
    spec_version: root.spec_version,
    spec_hash: root.spec_hash,
    task_spec: { task_id: root.task_id, task_type: root.task_type, project: problem.id },
    initial_prompt: 'The benchmark controller owns orchestration only.',
    material_refs: [],
    service_environment: { project: problem.id, ...inputMetadata },
  }, {
    operationId: `benchmark:root:freeze:${runId}`,
    taskId: root.task_id,
    executionId: controllerExecutionId,
    specVersion: root.spec_version,
    fencingVersion: 1,
  });
  const rootClaim = taskContext(router, root, 'owner:benchmark').claim({
    execution_id: controllerExecutionId,
    claim_key: `benchmark:root:claim:${runId}`,
    owner_ref: 'owner:benchmark',
    initial_prompt: 'The benchmark controller owns orchestration only.',
    initial_context_ref: rootFrozen.initial_context_ref,
    input_snapshot_hash: rootFrozen.initial_context.input_snapshot_hash,
    input_material_refs: [],
  }, { operationId: `benchmark:root:claim:${runId}` });
  const rootExecutionSdk = executionContext(router, rootClaim.execution, 'owner:benchmark');
  const sourceMaterial = rootExecutionSdk.publishMaterial({
    kind: 'fact',
    scope: 'problem_statement',
    evidence_state: 'observed',
    content: {
      project: problem.id,
      source_path: problem.problem_file,
      source_hash: problem.source_hash,
      input_metadata: inputMetadata,
      formal_source: problem.source,
    },
    provenance: { actor_ref: 'owner:benchmark', input: 'official_formalization_only' },
  }, { operationId: `benchmark:input:${runId}` }).material;
  let parentSdk = taskContext(router, taskService.getTask(root.task_id), 'owner:benchmark');
  const cores = [];
  for (let index = 1; index <= 4; index += 1) {
    const child = parentSdk.createChildTask({
      child_creation_key: `benchmark:child:${runId}:${index}`,
      task_type: 'proof',
      goal: `Produce a real Lean proof candidate for ${problem.id}`,
      expected_output: 'A compiled Lean source with no placeholders',
      acceptance_conditions: { project: problem.id, core: index, source_hash: problem.source_hash },
      owner_ref: `agent:core-${index}`,
      input_material_refs: [sourceMaterial.material_id],
      completion_contract: {
        required_candidate: { kind: 'artifact', scope: 'proof_relevant' },
        required_check: {
          checker_ref: fixture.checker_ref,
          checker_version: fixture.checker_version,
          environment_ref: fixture.environment_ref,
        },
      },
      max_children: 0,
    }, { operationId: `benchmark:child:create:${runId}:${index}` }).task;
    parentSdk = parentSdk.withContext({ stateVersion: taskService.getTask(root.task_id).state_version });
    const executionId = `benchmark-${problem.id}-core-${index}`;
    const prompt = projectPrompt(problem, index, DEFAULT_ROLES[index - 1]);
    const frozen = owner.freezeInitialContext({
      freeze_key: `benchmark:context:${runId}:${index}`,
      task_id: child.task_id,
      execution_id: executionId,
      spec_version: child.spec_version,
      spec_hash: child.spec_hash,
      task_spec: { task_id: child.task_id, task_type: child.task_type, project: problem.id, core: index },
      initial_prompt: prompt,
      material_refs: [{ material_id: sourceMaterial.material_id, content_hash: sourceMaterial.content_hash }],
      service_environment: {
        project: problem.id,
        ...inputMetadata,
        tool_policy: 'swarmenv_call_only',
      },
    }, {
      operationId: `benchmark:context:freeze:${runId}:${index}`,
      taskId: child.task_id,
      executionId,
      specVersion: child.spec_version,
      fencingVersion: 1,
    });
    const claim = taskContext(router, child, `agent:core-${index}`).claim({
      execution_id: executionId,
      claim_key: `benchmark:claim:${runId}:${index}`,
      owner_ref: `agent:core-${index}`,
      initial_prompt: prompt,
      initial_context_ref: frozen.initial_context_ref,
      input_snapshot_hash: frozen.initial_context.input_snapshot_hash,
      input_material_refs: [sourceMaterial.material_id],
    }, { operationId: `benchmark:claim:${runId}:${index}` });
    const coreDir = join(projectDir, `core-${index}`);
    const childEnv = { ...process.env };
    const adapter = options.agentAdapterFactory
      ? options.agentAdapterFactory({ index, problem, executionId, coreDir, env: childEnv })
      : new BenchmarkAgentCoreAdapter({
        command: options.command ?? 'nurouter',
        provider: options.provider ?? process.env.NUROUTER_PI_PROVIDER ?? 'openai',
        model: options.model ?? process.env.NUROUTER_PI_MODEL,
        account: options.account ?? process.env.NUROUTER_PI_ACCOUNT,
        group: options.group ?? process.env.NUROUTER_PI_GROUP,
        extensionPath: options.extensionPath ?? resolve(new URL('../agent/swarmenv-extension.mjs', import.meta.url).pathname),
        cwd: coreDir,
        sessionDir: join(coreDir, '.swarm', 'pi-session'),
        env: childEnv,
      });
    const workspaceManager = new WorkspaceManager({ rootDir: coreDir });
    const runtime = new Runtime({
      taskService,
      contextService,
      workspaceManager,
      agentAdapter: adapter,
      maxWorkers: 1,
      actorRef: `runtime:core-${index}`,
    });
    const bridge = new ServicesBridge({
      taskService,
      contextService,
      runtime,
      router,
      actorRef: `agent:core-${index}`,
      taskId: child.task_id,
      executionId,
    });
    Object.assign(childEnv, await bridge.start());
    cores.push({
      index,
      taskId: child.task_id,
      executionId,
      prompt,
      claim,
      runtime,
      workspaceManager,
      bridge,
      session: null,
      turnInFlight: false,
      turnPromise: null,
      turnStartedAt: 0,
      nextTurnAt: 0,
      turnIntervalMs: options.turnIntervalMs ?? 10 * 60_000,
      turns: 0,
      toolEvents: [],
      errors: [],
      checks: [],
      checked: new Set(),
      cheatingFlags: [],
      turnDurationsMs: [],
      turnTimeoutCount: 0,
      versionManifest: null,
      role: DEFAULT_ROLES[index - 1],
    });
  }
  return {
    runId,
    problem,
    config,
    fixtureManifest: fixture,
    databasePath,
    projectDir,
    rootTaskId: root.task_id,
    rootExecutionId: controllerExecutionId,
    inputMaterialId: sourceMaterial.material_id,
    inputMaterialHash: sourceMaterial.content_hash,
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

async function stopRoot(state) {
  const execution = state.taskService.getExecution(state.rootExecutionId);
  if (!execution || !['CREATED', 'RUNNING', 'WAITING'].includes(execution.state)) return;
  executionContext(state.router, execution, 'owner:benchmark').fenceExecution({
    runtime_generation: execution.runtime_generation + 1,
  }, { operationId: `benchmark:root:fence:${state.runId}` });
}

export async function runBenchmarkProject(problem, config, options = {}) {
  const state = await createProjectState(problem, config, options);
  const startedAt = Date.now();
  const durationMs = options.timeboxMs ?? 60 * 60_000;
  const deadline = startedAt + durationMs;
  const turnTimeoutMs = options.turnTimeoutMs ?? 9 * 60_000;
  const basePrompt = (core) => [
    core.prompt,
    'This is a follow-up turn. Read all new Materials, especially judge_feedback, and refine your route.',
  ].join('\n');
  try {
    await Promise.all(state.cores.map(async (core) => {
      const run = await core.runtime.startExecution(core.executionId);
      core.session = run.session;
      core.versionManifest = run.session.manifest ?? null;
      core.nextTurnAt = Date.now();
      scheduleTurn(core, core.prompt, turnTimeoutMs);
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
          await judgeCandidate(state, core).catch((error) => {
            core.errors.push({ code: error.code ?? error.name, class: safeDiagnostic(error.message) ?? 'judge_error' });
          });
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
    await stopRoot(state).catch(() => undefined);
  }
  const report = projectReport(state, startedAt, deadline);
  await writeFile(join(state.projectDir, 'report.json'), JSON.stringify(report, null, 2));
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
            tool_policy: 'swarmenv_call only',
            cheating_policy: 'placeholder or non-SwarmEnv tool event invalidates the project',
          },
          project: { problem_id: problems[index].id, source_hash: problems[index].source_hash ?? null },
          run: { solved: false, elapsed_ms: null, deadline_reached: false, cleanup_elapsed_ms: null },
          audit: { invalid: true, invalid_reasons: ['project_runner_error'], raw_transcript_exported: false, proof_contents_exported: false },
          error: { code: error.code ?? error.name, class: safeDiagnostic(error.message) ?? 'project_runner_error' },
        };
        validateBenchmarkReport(report);
        reports[index] = report;
        const projectDir = join(resolve(options.reportDir), problems[index].id);
        await mkdir(projectDir, { recursive: true });
        await writeFile(join(projectDir, 'report.json'), JSON.stringify(report, null, 2));
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return reports;
}

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
import { agentCheckResult } from '../judge/check-result.js';
import { Runtime } from '../runtime/runtime.js';
import { WorkspaceManager } from '../runtime/workspace-manager.js';
import { ServicesBridge } from '../agent/services-bridge.js';
import { ServicesRouter } from '../sdk/service-router.js';
import { ServicesSDK } from '../sdk/services-sdk.js';
import { TaskService } from '../task/task-service.js';
import { makeEnvelope, stableStringify } from '../protocol/envelope.js';
import { DurableEventLog } from '../observability/durable-event-log.js';
import { ObservationStore } from '../observability/observation-store.js';
import { BOUND_AGENT_PROMPT, GENERIC_AGENT_PROMPT } from '../agent/agent-prompt.js';
import { AGENT_ROLES, buildCapabilityProfile } from '../agent/capability-profile.js';
import { createBuiltinServiceRegistry, registerUserService } from '../sdk/builtin-registry.js';
import { createHttpJsonAdapter } from '../sdk/service-adapter.js';
import { createMathlibSearchManifest } from '../services/mathlib-search-service.js';
import { runtimeCapabilityList } from '../runtime/runtime-capabilities.js';
import { CoreDaemon, SELECTION_AGENT_PROMPT } from '../runtime/core-daemon.js';
import { TaskController } from '../runtime/task-controller.js';
import { CoreParallelismTracker } from './parallelism.js';

const execFileAsync = (command, args) => new Promise((resolvePromise, reject) => {
  execFile(command, args, { encoding: 'utf8' }, (error, stdout) => {
    if (error) reject(error);
    else resolvePromise(String(stdout).trim());
  });
});

const FORBIDDEN_PLACEHOLDER = /\b(?:sorry|admit|axiom)\b/i;
const SAFE_PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PARALLEL_MODES = new Set(['direct', 'semantic', 'root-only']);
const STRUCTURE_OPERATIONS = new Set([
  'create_branch_group', 'add_required_subtask', 'propose_structure_change', 'create_rework_task',
]);

function completedTaskState(state) {
  return state === 'DONE' || state === 'SATISFIED';
}

function parallelMode(options = {}) {
  const mode = options.parallelMode ?? 'direct';
  if (!PARALLEL_MODES.has(mode)) throw new TypeError(`parallelMode must be one of ${[...PARALLEL_MODES].join(', ')}`);
  return mode;
}

function modePrompt(mode, prompt) {
  if (mode === 'semantic') {
    return [
      'This run is the Issue #56 semantic-structure treatment. Before doing proof work on a root Task, use the registered swarmenv_task_create_branch_group tool to create at least two genuinely different ordinary alternative Tasks. When a Branch Task is bound, its Agent must use swarmenv_task_add_required_subtask at least twice to create one jointly required group before finishing either route. Give every Task a concrete goal, expected output, acceptance condition, and real Workspace or Material result. Read swarmenv_task_get_structure and swarmenv_task_explain_readiness after each mutation. Do not replace these relations with generic child creation. Continue useful root and Branch work after the structure is created; the shared queue must keep the resulting Tasks claimable by other Cores.',
      'The semantic run also requires an observable delivery loop: after child or branch Materials exist, the Root must read them through swarmenv_context_read, call swarmenv_context_consume with the bounded Material IDs and action integration, write a bounded integration note in its own Workspace, and publish one root-owned Material with scope root_integration whose provenance names exactly those consumed Material IDs. A proof failure does not excuse skipping this integration step; preserve the integration evidence and then block on the typed proof/check dependency if needed.',
      prompt,
    ].join('\n');
  }
  if (mode === 'root-only') {
    return [
      'This run is the Root-only control. Work only on the currently bound root Task and do not create child Tasks, Branch groups, required-subtask groups, dependencies, or rework Tasks. Do not call the semantic structure mutation tools. Keep all proof work and checking on the root responsibility.',
      prompt,
    ].join('\n');
  }
  return prompt;
}
function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function waitDependencyIds(condition) {
  if (!condition || typeof condition !== 'object') return [];
  if (condition.type === 'child_task_terminal') {
    return [condition.child_task_id ?? condition.task_id].filter(Boolean);
  }
  if (condition.type === 'children_all_terminal') {
    return Array.isArray(condition.child_task_ids) ? [...condition.child_task_ids] : [];
  }
  if (condition.type === 'parent_review') {
    return condition.parent_task_id ? [condition.parent_task_id] : [];
  }
  if (condition.type === 'check_result_arrived') {
    return [condition.check_request_key ?? condition.request_key ?? condition.candidate_material_id].filter(Boolean);
  }
  return [];
}

function lifecycleEvents(taskService) {
  const rows = taskService.db.prepare("SELECT operation_id, operation, result_json, created_at FROM operations WHERE operation IN ('request_wait', 'wake_execution', 'resume_execution', 'block_task') ORDER BY created_at, operation_id").all();
  return rows.map((row) => {
    let result = null;
    try { result = JSON.parse(row.result_json); } catch { /* sanitized event remains available without result details */ }
    const execution = result?.execution ?? null;
    const condition = execution?.wait_condition ?? null;
    let dependencyRequirement = result?.dependency?.requirement ?? null;
    if (!dependencyRequirement && typeof result?.dependency?.requirement_json === 'string') {
      try { dependencyRequirement = JSON.parse(result.dependency.requirement_json); } catch { dependencyRequirement = null; }
    }
    const dependencyCondition = dependencyRequirement?.checker_health ? { type: 'checker_health' } : null;
    return {
      operation_id: row.operation_id,
      operation: row.operation,
      created_at: row.created_at,
      task_id: execution?.task_id ?? null,
      execution_id: execution?.execution_id ?? null,
      dependency_kind: result?.dependency?.dependency_kind ?? null,
      wait_condition_type: condition?.type ?? dependencyCondition?.type ?? null,
      dependency_ids: waitDependencyIds(condition).concat(result?.dependency?.dependency_id ?? []),
    };
  });
}

const ADMISSION_OPERATIONS = new Set([
  'propose_task', 'create_child_task', 'create_branch_group', 'add_required_subtask',
  'create_rework_task', 'propose_structure_change',
]);

function taskLifecycleEvents(taskService) {
  const rows = taskService.db.prepare('SELECT operation_id, operation, result_json, created_at FROM operations ORDER BY created_at, operation_id').all();
  return rows.map((row) => {
    let result = null;
    try { result = JSON.parse(row.result_json); } catch { /* IDs remain null for an unreadable result. */ }
    const execution = result?.execution ?? result?.authority_execution ?? result?.parent_execution ?? null;
    const task = result?.task ?? result?.rework_task ?? result?.child ?? result?.subtask ?? result?.parent ?? null;
    return {
      operation_id: row.operation_id,
      operation: row.operation,
      created_at: row.created_at,
      task_id: task?.task_id ?? execution?.task_id ?? null,
      execution_id: execution?.execution_id ?? null,
      state: task?.state ?? execution?.state ?? null,
    };
  });
}

function safeObservationEvent(event) {
  return {
    sequence: event.sequence,
    occurred_at: event.occurred_at,
    source: event.source,
    kind: event.kind,
    core_id: event.core_id,
    session_id: event.session_id,
  };
}

function executionNarratives(state, taskTree, materials) {
  return taskTree.flatMap((task) => {
    const structure = state.taskService.getTaskStructure(task.task_id);
    return state.taskService.listExecutions(task.task_id).map((execution) => {
      const events = state.observationStore.listEvents({
        experimentId: state.runId,
        executionId: execution.execution_id,
        limit: 1_000,
      }).events.map(safeObservationEvent);
      const outputs = materials
        .filter((material) => material.source_execution === execution.execution_id)
        .map((material) => ({
          material_id: material.material_id,
          kind: material.kind,
          scope: material.scope,
          evidence_state: material.evidence_state,
          content_hash: material.content_hash,
          version: material.version,
        }));
      const dependencies = structure.dependencies.map((dependency) => ({
        dependency_id: dependency.dependency_id,
        dependency_kind: dependency.dependency_kind,
        prerequisite_task_id: dependency.prerequisite_task_id,
        material_id: dependency.material_id,
        check_result_id: dependency.check_result_id,
        satisfied: dependency.satisfied,
      }));
      return {
        execution_id: execution.execution_id,
        task_id: execution.task_id,
        parent_id: task.parent_id,
        task_type: task.task_type,
        goal: task.goal,
        expected_output: task.expected_output,
        state: execution.state,
        attempt_no: execution.attempt_no,
        owner_ref: execution.owner_ref,
        core_id: execution.core_id,
        workspace_ref: execution.workspace_ref,
        workspace_revision: execution.workspace_revision,
        candidate_material_id: execution.candidate_material_id,
        terminal_reason: safeLifecycleReason(execution.terminal_reason),
        block_reason: task.state === 'BLOCKED' ? safeLifecycleReason(task.block_reason) : null,
        wait_condition_type: execution.wait_condition?.type ?? null,
        wait_dependency_ids: waitDependencyIds(execution.wait_condition),
        dependencies,
        actions: events,
        outputs,
      };
    });
  });
}

function inputSnapshotHash(task, inputMaterialRefs) {
  return sha256(stableStringify({
    task_id: task.task_id,
    spec_hash: task.spec_hash,
    workspace: task.workspace,
    input_material_refs: inputMaterialRefs,
  }));
}

function observedEligibleWorkCount(state, readyTasks) {
  const tasks = state.taskService.listTasks({
    rootId: state.rootTaskId,
    states: ['OPEN', 'RUNNING'],
    limit: 100,
    availableOnly: false,
  });
  const readyIds = new Set(readyTasks.map((task) => task.task_id));
  return tasks.filter((task) => {
    if (task.parent_id === null) return false;
    if (readyIds.has(task.task_id)) return true;
    if (task.state !== 'RUNNING') return false;
    const execution = task.latest_execution ?? state.taskService.listExecutions(task.task_id, { includeTerminal: false })[0];
    return execution && ['CREATED', 'RUNNING'].includes(execution.state);
  }).length;
}

function isPhysicallyAvailableCore(core) {
  return !core.taskId && !core.turnInFlight && !core.dispatchReserved && !core.stopping &&
    !core.recoveryInFlight && (core.runtime?.getActiveProcessCount?.() ?? 0) === 0;
}

function observeReadyTasks(state, tasks, at = Date.now()) {
  for (const task of tasks) {
    const taskId = task?.task_id;
    if (!taskId) continue;
    if (!state.readyObservedAt.has(taskId)) state.readyObservedAt.set(taskId, at);
    const execution = task.latest_execution;
    if (task.state === 'WAITING' && execution?.execution_id && !state.waitEligibilityAt.has(execution.execution_id)) {
      state.waitEligibilityAt.set(execution.execution_id, at);
    }
  }
}

function safeDiagnostic(value) {
  const text = String(value ?? '');
  if (!text) return null;
  if (/spawn .*ENOENT|command not found|checker unavailable|executable/i.test(text)) return 'checker_unavailable';
  if (/unknown module prefix 'Mathlib'/.test(text)) return 'missing_mathlib_build';
  if (/timed out|timeout/i.test(text)) return 'checker_timeout';
  if (/unknown identifier|type mismatch|unsolved goals|application type mismatch/i.test(text)) return 'lean_proof_error';
  return 'lean_checker_error';
}

// Agent-supplied block/terminal reasons are useful for a narrative only as a
// bounded lifecycle class. Keep arbitrary text, proof fragments, and secret
// material out of the sanitized report while retaining the operator signal.
function safeLifecycleReason(value) {
  const text = String(value ?? '').toLowerCase();
  if (!text) return null;
  if (text.includes('dependency') || text.includes('blocked')) return 'dependency_blocked';
  if (text.includes('checker') || text.includes('preflight')) return 'checker_health';
  if (text.includes('timeout') || text.includes('timed out')) return 'timeout';
  if (text.includes('cancel')) return 'canceled';
  if (text.includes('fenc') || text.includes('lease') || text.includes('handoff')) return 'fenced';
  if (text.includes('provider') || text.includes('process') || text.includes('session') || text.includes('startup')) return 'runtime_failure';
  if (text.includes('accept') || text.includes('complete') || text.includes('success') || text === 'done') return 'completed';
  return 'other';
}

async function resolveCandidateSource(runtime, material, execution) {
  if (typeof material.content === 'string') {
    return { content: material.content, contentHash: null };
  }
  const reference = material.content;
  if (!reference || typeof reference !== 'object' || Array.isArray(reference) || typeof reference.path !== 'string') {
    throw new TypeError('candidate artifact must contain a Workspace file path or direct source text');
  }
  if (reference.workspace_revision !== undefined && reference.workspace_revision !== execution.workspace_revision) {
    throw new TypeError(`candidate Workspace revision ${reference.workspace_revision} does not match Execution revision ${execution.workspace_revision}`);
  }
  const file = await runtime.readWorkspaceFile(execution.execution_id, { path: reference.path });
  if (reference.workspace_revision !== undefined && reference.workspace_revision !== file.workspace_revision) {
    throw new TypeError(`candidate Workspace revision ${reference.workspace_revision} does not match readable revision ${file.workspace_revision}`);
  }
  if (reference.content_hash !== undefined && reference.content_hash !== file.content_hash) {
    throw new TypeError(`candidate Workspace file hash does not match ${reference.path}`);
  }
  return { content: file.content, contentHash: file.content_hash };
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

function fanoutLogger(...loggers) {
  return {
    append(event) {
      for (const logger of loggers) logger?.append(event);
    },
  };
}

function observationLogger(observationStore, experimentId, source) {
  return {
    append(event = {}) {
      const envelope = event.envelope ?? {};
      observationStore.append({
        experimentId,
        source,
        kind: event.event ?? `${source}_event`,
        taskId: event.task_id ?? envelope.task_id ?? null,
        executionId: event.execution_id ?? envelope.execution_id ?? null,
        correlationId: event.operation_id ?? envelope.operation_id ?? null,
        visibility: 'private',
        payload: event,
      });
    },
  };
}

export class BenchmarkAgentCoreAdapter extends AgentCoreAdapter {
  constructor({ allowedToolNames = null, ...options } = {}) {
    super(options);
    this.allowedToolNames = allowedToolNames;
  }

  buildLaunchArgs(options) {
    // Pi keeps its coordinator tools enabled when only built-ins are disabled.
    // Start from a completely empty tool set, then add the explicit
    // SwarmEnv allowlist below. This keeps the benchmark boundary closed even
    // when a Pi version treats coordinator tools as non-built-ins.
    const args = restrictedArgs(super.buildLaunchArgs(options)).map((arg) =>
      arg === '--no-builtin-tools' ? '--no-tools' : arg);
    // NuRouter/Pi versions have differed in how --no-builtin-tools is
    // forwarded. An explicit allowlist makes the benchmark boundary
    // deterministic: only named SwarmEnv extension tools are enabled.
    const tools = this.allowedToolNames ?? [
      'swarmenv_catalog_get_service_metadata', 'swarmenv_catalog_list_services', 'swarmenv_catalog_list_tools',
      'swarmenv_context_consume', 'swarmenv_context_publish', 'swarmenv_context_read',
      'swarmenv_judge_get_check_result', 'swarmenv_judge_submit_candidate',
      'swarmenv_execution_get', 'swarmenv_task_block', 'swarmenv_task_claim', 'swarmenv_task_complete',
      'swarmenv_task_create_child', 'swarmenv_task_discover', 'swarmenv_task_list_claimable',
      'swarmenv_task_list_executions', 'swarmenv_task_view',
      'swarmenv_workspace_diff', 'swarmenv_workspace_get', 'swarmenv_workspace_list_files',
      'swarmenv_workspace_read_file', 'swarmenv_workspace_write_file',
    ];
    args.push('--tools', tools.join(','));
    // Pi exposes its `parallel` coordinator even when built-in tools are
    // disabled. It can issue unregistered tool events and invalidate an
    // otherwise compliant benchmark run, so deny it explicitly at the
    // benchmark boundary.
    args.push('--exclude-tools', 'parallel');
    return args;
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
  const countsAsAgentTurn = Boolean(core.taskId && core.executionId);
  if (countsAsAgentTurn) {
    core.parallelism.beginAgentTurn(core.index, {
      task_id: core.taskId,
      execution_id: core.executionId,
      reason: 'follow_up_turn',
    }, core.turnStartedAt || Date.now());
    core.agentTurnSession = session;
  }
  if (!session) {
    if (countsAsAgentTurn && core.agentTurnSession === session) {
      core.parallelism.endAgentTurn(core.index, Date.now(), 'missing_session');
      core.agentTurnSession = null;
    }
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
    core.parallelism.recordTurnTime(core.lastTurn.elapsed_ms);
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
    core.parallelism.recordTurnTime(core.turnDurationsMs.at(-1));
  } finally {
    collectToolEvents(core, session.rpcRecords.slice(sequence));
    if (countsAsAgentTurn && core.agentTurnSession === session) {
      core.parallelism.endAgentTurn(core.index, Date.now());
      core.agentTurnSession = null;
    }
    // A discovery turn can synchronously claim a Task and hand off to a new
    // bound session. Do not let the discovery transport's finally block clear
    // the bound session's in-flight flag or start an overlapping follow-up.
    const handedOff = core.session !== session && Boolean(
      core.taskId && core.executionId && core.runtime.hasActiveExecution(core.executionId),
    );
    if (!handedOff) {
      // A legacy claim may enter onClaim before Runtime rejects the permanent
      // Core binding (for example, two selectors race for a resumable wait).
      // Clear that provisional local ownership or the selection transport
      // would keep this Core permanently marked turn-in-flight.
      if (core.session !== session && !core.runtime.hasActiveExecution(core.executionId ?? '')) {
        core.taskId = null;
        core.executionId = null;
        core.claim = null;
      }
      core.turnInFlight = false;
      core.nextTurnAt = core.taskId ? Date.now() + core.turnIntervalMs : Date.now();
    }
    if (!core.taskId) core.dispatchReserved = false;
  }
}

function scheduleTurn(core, prompt, timeoutMs) {
  // A bound Execution owns its Session continuation. The periodic repair
  // loop must not open a second prompt during the short interval between two
  // continuation turns.
  if (core.turnInFlight || core.boundTurnPromise || Date.now() < core.nextTurnAt) return false;
  core.turnStartedAt = Date.now();
  core.turnPromise = runTurn(core, prompt, timeoutMs);
  return true;
}

async function startAgentSession(core) {
  core.bridge.actorRef = core.actorRef;
  core.childEnv.SWARMENV_AGENT_ROLE = AGENT_ROLES.SELECTION;
  core.sessionNumber += 1;
  const suffix = core.sessionNumber === 1 ? 'worker-session' : `worker-session-${core.sessionNumber}`;
  const session = await core.adapter.start({
    executionId: `worker-${core.startConfig.problem.id}-core-${core.index}-session-${core.sessionNumber}`,
    sessionDir: join(core.coreDir, '.swarm', suffix),
    cwd: core.coreDir,
    logger: new DurableEventLog(join(core.startConfig.logRoot, 'agents', `core-${core.index}.ndjson`), { raw: true, scope: `agent:core-${core.index}` }),
    observation: core.observe,
    observationContext: { coreId: `core-${core.index}`, taskId: null, executionId: null },
  });
  core.session = session;
  core.sessionHistory.push(session);
  core.versionManifest = session.manifest ?? null;
  await session.waitForReady({ timeoutMs: core.startConfig.options.turnTimeoutMs ?? 30_000 });
  // Selection is now a separate CoreDaemon turn. Starting the process must
  // not itself ask the Agent to inspect or claim work; the Daemon supplies a
  // bounded shortlist and owns the subsequent durable claim.
  core.unboundSessionCount += 1;
  core.initialTurnPromise = null;
}

function attachRecoveredSession(core, { execution, session }) {
  if (!session || core.session === session) return;
  const turnStartedAt = Date.now();
  // A Runtime recovery can race with the old runTurn finally block or with a
  // scheduler tick that observed the old Session as idle. Close whichever
  // Agent-time interval is currently open before assigning the replacement.
  // endAgentTurn is idempotent when no interval is open.
  core.parallelism.endAgentTurn(core.index, turnStartedAt, 'session_recovery');
  core.session = session;
  core.sessionHistory.push(session);
  core.sessionRecoveryCount = (core.sessionRecoveryCount ?? 0) + 1;
  core.versionManifest = session.manifest ?? core.versionManifest;
  core.recoveryInFlight = true;
  core.turnInFlight = true;
  core.turnStartedAt = turnStartedAt;
  core.parallelism.beginAgentTurn(core.index, {
    task_id: execution.task_id,
    execution_id: execution.execution_id,
    reason: 'session_recovery',
  }, turnStartedAt);
  core.agentTurnSession = session;
  const afterSequence = session.rpcRecords?.length ?? 0;
  void (async () => {
    try {
      await session.waitForSettled?.({
        timeoutMs: Math.max(core.startConfig.options.turnTimeoutMs ?? 30_000, 180_000),
        afterSequence,
      });
    } catch (error) {
      const expectedHandoff = session.expectedStop || core.session !== session || core.stopping;
      if (!expectedHandoff) core.errors.push({ code: error.code ?? error.name, class: safeDiagnostic(error.message) ?? 'recovery_turn_error' });
    } finally {
      const now = Date.now();
      collectToolEvents(core, session.rpcRecords ?? []);
      if (core.agentTurnSession === session) {
        core.parallelism.endAgentTurn(core.index, now, 'session_recovery_settled');
        core.agentTurnSession = null;
      }
      if (core.session === session) {
        core.recoveryInFlight = false;
        if (core.runtime.hasActiveExecution(execution.execution_id)) {
          core.turns += 1;
          core.turnInFlight = false;
          core.nextTurnAt = now;
        } else {
          core.turnInFlight = false;
        }
      }
      core.stateRef?.requestDaemonWake?.();
    }
  })();
}

async function ensureAgentSession(core) {
  if (core.releasedSession) {
    if (!core.releasedSession.closed) await Promise.resolve(core.releasedSession.stop?.()).catch(() => undefined);
    core.releasedSession = null;
  }
  if (core.session?.closed) core.session = null;
  // A failed legacy claim can clear the bridge binding after the transport
  // Session has already been replaced. Repair the stale local occupancy when
  // no Session, Task, Execution, recovery, or handoff promise remains.
  if (core.turnInFlight && !core.session && !core.taskId && !core.executionId && !core.boundTurnPromise && !core.recoveryInFlight) {
    core.turnInFlight = false;
  }
  if (core.stopping || core.turnInFlight) return false;
  if (core.session) return core.session;
  core.sessionStartAttempts = (core.sessionStartAttempts ?? 0) + 1;
  try {
    await startAgentSession(core);
    return core.session ?? null;
  } catch (error) {
    core.sessionStartFailures = (core.sessionStartFailures ?? 0) + 1;
    if (!core.stopping) core.errors.push({ code: error.code ?? error.name, class: safeDiagnostic(error.message) ?? 'agent_session_error' });
    await Promise.resolve(core.session?.stop?.()).catch(() => undefined);
    core.session = null;
    core.turnInFlight = false;
    core.initialTurnPromise = null;
    core.nextTurnAt = Date.now();
    core.dispatchReserved = false;
    return false;
  }
}

function selectionView(candidates) {
  return candidates.map((candidate) => ({
    task_id: candidate.task_id,
    task_type: candidate.task_type,
    parent_id: candidate.parent_id,
    goal: candidate.goal,
    expected_output: candidate.expected_output,
    task_instructions: candidate.task_instructions,
    acceptance_conditions: candidate.acceptance_conditions,
    completion_contract: candidate.completion_contract,
    priority: candidate.priority,
    state: candidate.state,
    age_ms: candidate.age_ms,
    fairness_protected: candidate.fairness_protected,
    selection_rank: candidate.selection_rank,
  }));
}

/**
 * Run one stateless selection turn. The Selection Agent owns the bounded
 * choice and durable claim. CoreDaemon accepts the returned claim and owns
 * only the Runtime handoff; a bound Agent never receives the claim surface.
 */
async function selectTaskWithAgent(core, candidates, prompt) {
  const session = await ensureAgentSession(core);
  if (!session) return core.turnInFlight ? { selection_deferred: true } : null;
  const sequence = session.rpcRecords?.length ?? 0;
  core.selectionClaim = null;
  core.selectionActive = true;
  core.dispatchReserved = true;
  core.turnInFlight = true;
  core.turnStartedAt = Date.now();
  core.selectionTurnCount = (core.selectionTurnCount ?? 0) + 1;
  core.bridge.setSelectionCandidates(candidates);
  const message = `${prompt}\n\nBounded shortlist (call task.claim exactly once for one listed task):\n${JSON.stringify(selectionView(candidates))}`;
  try {
    const response = await session.prompt(message, { timeoutMs: Math.min(core.startConfig.options.turnTimeoutMs ?? 30_000, 30_000) });
    if (response?.data?.disposition !== 'handled' && typeof session.waitForSettled === 'function') {
      await session.waitForSettled({ timeoutMs: Math.max(core.startConfig.options.turnTimeoutMs ?? 30_000, 180_000), afterSequence: sequence });
    }
    if (core.selectionClaim?.task?.task_id) return core.selectionClaim;
    if (core.bridge.selectionClaimAttempted || Object.hasOwn(session, 'bound')) return { selection_deferred: true };
    return null;
  } catch (error) {
    if (core.bridge.selectionClaimAttempted || Object.hasOwn(session, 'bound')) return { selection_deferred: true };
    core.sessionStartFailures = (core.sessionStartFailures ?? 0) + 1;
    if (!core.stopping) core.errors.push({ code: error.code ?? error.name, class: safeDiagnostic(error.message) ?? 'selection_turn_error' });
    return null;
  } finally {
    collectToolEvents(core, session.rpcRecords?.slice(sequence) ?? []);
    core.bridge.setSelectionCandidates(null);
    core.selectionActive = false;
    core.turns += 1;
    const duration = Date.now() - core.turnStartedAt;
    core.turnDurationsMs.push(duration);
    core.parallelism.recordTurnTime(duration);
    const handedOff = core.session !== session && Boolean(core.taskId && core.executionId);
    // Keep the Core reserved across the claim and Runtime handoff. Invalid or
    // empty selections do not reserve the Core.
    const selectedTaskId = core.selectionClaim?.task?.task_id ?? null;
    const handoffPending = !handedOff && typeof selectedTaskId === 'string' &&
      candidates.some((candidate) => String(candidate.task_id ?? candidate.taskId ?? candidate.id) === selectedTaskId);
    if (!handedOff && !handoffPending) {
      core.turnInFlight = false;
      core.dispatchReserved = false;
      core.nextTurnAt = Date.now();
    }
    if (handoffPending) {
      core.turnInFlight = true;
      core.dispatchReserved = true;
      core.nextTurnAt = Date.now();
    }
    if (!handedOff && !handoffPending && !core.taskId && core.session === session) {
      // Empty, invalid, or failed selection turns have no claim to hand off;
      // release their transport so bounded startup retry accounting remains
      // meaningful. A valid claim takes the path above and is retained until
      // CoreDaemon finishes the Runtime handoff boundary.
      core.session = null;
      await Promise.resolve(session.stop?.()).catch(() => undefined);
    }
    // Keep the selection Session alive until its claim and Runtime handoff
    // have completed. The bound Session is started by the claim callback;
    // normal project cleanup stops both transports through stopCore.
    core.stateRef?.requestDaemonWake?.();
  }
}

async function releaseTerminalExecution(core) {
  if (!core.executionId) return;
  const execution = core.runtime.taskService.getExecution(core.executionId);
  if (!execution || !['SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED', 'FENCED', 'SUPERSEDED'].includes(execution.state)) return;
  core.parallelism.transition(core.index, 'IDLE', {
    task_id: execution.task_id,
    execution_id: execution.execution_id,
    reason: `terminal:${execution.state.toLowerCase()}`,
  });
  await core.runtime.releaseExecution(core.executionId).catch(() => undefined);
  await core.bridge.releaseClaim({ result: { execution } });
}

function sanitizedCheck(result, material) {
  const evidence = result.evidence ?? {};
  const checkerProcessStatus = result.checker_process_status ?? evidence.checker_process_status ?? 'unknown';
  const resultClass = result.result_class ?? evidence.result_class ?? 'unassessed';
  const mathematicalOutcome = evidence.mathematical_outcome ?? (resultClass === 'PASS' ? 'PASS' : resultClass === 'source_failure' ? 'FAIL' : 'unassessed');
  return {
    candidate_material_id: material.material_id,
    material_hash: material.content_hash,
    verdict: result.verdict,
    mathematical_outcome: mathematicalOutcome,
    judge_operation_status: result.judge_operation_status ?? 'persisted',
    checker_ref: result.checker_ref ?? null,
    checker_version: result.checker_version ?? null,
    environment_ref: result.environment_ref ?? null,
    checker_process_status: checkerProcessStatus,
    checker_started: evidence.checker_started ?? (checkerProcessStatus === 'started' || checkerProcessStatus === 'completed'),
    result_class: resultClass,
    retryable: result.retryable ?? Boolean(evidence.retryable),
    diagnostic_code: result.diagnostic_code ?? evidence.diagnostic_code ?? null,
    preflight_key: evidence.preflight_key ?? null,
    preflight_status: evidence.preflight_status ?? null,
    preflight_verified: evidence.preflight_verified ?? null,
    input_binding_verified: evidence.input_binding_verified ?? null,
    toolchain_version_verified: evidence.toolchain_version_verified ?? null,
    checker_ref_verified: evidence.checker_ref_verified ?? null,
    checker_version_verified: evidence.checker_version_verified ?? null,
    checker_identity_verified: evidence.checker_identity_verified ?? null,
    health_fingerprint: evidence.health_fingerprint ?? null,
    infrastructure_attempt_count: evidence.infrastructure_attempt_count ?? null,
    retry_exhausted: Boolean(evidence.retry_exhausted),
    process_evidence: {
      exit_code: evidence.exit_code ?? null,
      signal: evidence.signal ?? null,
      timed_out: Boolean(evidence.timed_out),
      error_code: evidence.error_code ?? null,
    },
    check_result_id: result.check_result_id,
    diagnostic_class: evidence.forbidden_placeholder === true
      ? 'forbidden_placeholder'
      : safeDiagnostic(evidence.diagnostic),
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
  const published = state.contextService.dispatch('publish_material', {
    kind: 'experience',
    scope: 'judge_feedback',
    evidence_state: 'checked',
    content: {
      project: state.problem.id,
      target_material_hash: material.content_hash,
      verdict: result.verdict,
      result_class: result.result_class ?? result.evidence?.result_class ?? 'unassessed',
      checker_process_status: result.checker_process_status ?? result.evidence?.checker_process_status ?? 'unknown',
      mathematical_outcome: result.evidence?.mathematical_outcome ?? 'unassessed',
      retryable: result.retryable ?? Boolean(result.evidence?.retryable),
      diagnostic_code: result.diagnostic_code ?? result.evidence?.diagnostic_code ?? null,
      preflight_key: result.evidence?.preflight_key ?? null,
      preflight_status: result.evidence?.preflight_status ?? null,
      preflight_verified: result.evidence?.preflight_verified ?? null,
      input_binding_verified: result.evidence?.input_binding_verified ?? null,
      toolchain_version_verified: result.evidence?.toolchain_version_verified ?? null,
      checker_ref_verified: result.evidence?.checker_ref_verified ?? null,
      checker_version_verified: result.evidence?.checker_version_verified ?? null,
      checker_identity_verified: result.evidence?.checker_identity_verified ?? null,
      health_fingerprint: result.evidence?.health_fingerprint ?? null,
      infrastructure_attempt_count: result.evidence?.infrastructure_attempt_count ?? null,
      retry_exhausted: Boolean(result.evidence?.retry_exhausted),
      process_evidence: {
        exit_code: result.evidence?.exit_code ?? null,
        signal: result.evidence?.signal ?? null,
        timed_out: Boolean(result.evidence?.timed_out),
        error_code: result.evidence?.error_code ?? null,
      },
      check_result_id: result.check_result_id,
      diagnostic_class: result.evidence?.forbidden_placeholder === true
        ? 'forbidden_placeholder'
        : safeDiagnostic(result.evidence?.diagnostic),
    },
    provenance: { actor_ref: 'judge:lean', project: state.problem.id, target_task_id: taskId },
  }, makeEnvelope({
    operationId: `benchmark:feedback:${state.runId}:${core.index}:${result.check_result_id}`,
    actorRef: 'judge:lean',
    taskId,
    executionId,
    specVersion: execution.spec_version,
    stateVersion: execution.state_version,
    fencingVersion: execution.fencing_version,
  }));
  const feedback = published?.material ?? published ?? {};
  core.observe({
    source: 'context-service', kind: 'material_published', visibility: 'operator',
    taskId, executionId, coreId: `core-${core.index}`,
    payload: {
      material_id: feedback.material_id ?? null,
      kind: feedback.kind ?? 'experience',
      scope: feedback.scope ?? 'judge_feedback',
      source_task: feedback.source_task ?? taskId,
      source_execution: feedback.source_execution ?? executionId,
      publish_reason: 'judge_feedback',
    },
  });
  return feedback;
}

async function judgeCandidate(state, core, candidateMaterialId = null) {
  const pending = [...core.claimHistory].reverse().map((claim) => ({
    taskId: claim.task_id,
    executionId: claim.execution_id,
    execution: state.taskService.getExecution(claim.execution_id),
  })).find(({ execution }) => execution && ['CREATED', 'RUNNING', 'WAITING'].includes(execution.state) && execution.candidate_material_id && (!candidateMaterialId || execution.candidate_material_id === candidateMaterialId) && !core.checked.has(execution.candidate_material_id));
  if (!pending) return;
  const task = state.taskService.getTask(pending.taskId);
  const execution = pending.execution;
  if (!task) return;
  const candidateId = execution.candidate_material_id;
  const material = state.contextService.getMaterial(candidateId);
  if (!material) return;
  const { content, contentHash } = await resolveCandidateSource(core.runtime, material, execution);
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
  const checkAttempt = (core.checkAttempts.get(candidateId) ?? 0) + 1;
  core.checkAttempts.set(candidateId, checkAttempt);
  const result = await state.judgeService.judgeCandidate({
    request_key: `benchmark:check:${state.runId}:${core.index}:${candidateId}:${checkAttempt}`,
    candidate_material_id: candidateId,
    target_task_id: task.task_id,
    target_spec_version: task.spec_version,
    input_snapshot_hash: workspace.input_snapshot_hash,
    checker_ref: state.fixtureManifest.checker_ref,
    checker_version: state.fixtureManifest.checker_version,
    environment_ref: state.fixtureManifest.environment_ref,
    execution_id: pending.executionId,
    state_version: execution.state_version,
    candidate: { material_id: candidateId, content, content_hash: contentHash ?? undefined },
    target_task: task,
    workspace,
    fixture_manifest: state.fixtureManifest,
  }, {
    operationId: `benchmark:judge:${state.runId}:${core.index}:${candidateId}:${checkAttempt}`,
    actorRef: 'judge:lean',
  });
  state.cores[core.index - 1].parallelism.recordJudgeTime(Date.now() - checkStartedAt);
  const fresh = state.taskService.getExecution(pending.executionId);
  let applied = executionContext(state.router, fresh, 'judge:controller').applyCheckResult({
    check_result_id: result.check_result_id,
    ...(state.normalFlow === true ? { defer_execution_block: true } : {}),
  }, {
    operationId: `benchmark:apply:${state.runId}:${core.index}:${candidateId}:${checkAttempt}`,
  });
  const persistedResult = state.taskService.getCheckResult(result.check_result_id);
  const retryableInfrastructure = persistedResult.result_class === 'infrastructure_failure' && persistedResult.retryable && !persistedResult.evidence?.retry_exhausted;
  const normalFlow = state.normalFlow === true;
  // A transient checker failure must leave the candidate eligible for a later
  // retry. Source-level results and exhausted infrastructure failures are
  // terminal for this candidate.
  if (!retryableInfrastructure) core.checked.add(candidateId);
  core.checks.push({ ...sanitizedCheck(persistedResult, material), check_elapsed_ms: Date.now() - checkStartedAt });
  core.parallelism.recordWorkUnit({
    task_id: pending.taskId,
    execution_id: pending.executionId,
    core: core.index,
    progress_kind: 'candidate_check',
  });
  await publishFeedback(state, core, material, result, { taskId: pending.taskId, executionId: pending.executionId });
  let deferredWait = null;
  let deferredBlock = null;
  if (retryableInfrastructure) {
    const preflightKey = result.evidence?.preflight_key;
    const preflight = preflightKey ? state.judgeService.getCheckerPreflight(preflightKey) : null;
    if (!preflight?.health_fingerprint) {
      throw new Error('retryable checker failure has no durable preflight health fingerprint');
    }
    // The checker result is synchronous from the Agent's perspective. Stage
    // the typed dependency block for ServicesBridge to flush after its HTTP
    // response has been written, so
    // Runtime cannot stop the Session before the Agent sees the result.
    const lifecycle = {
      waitCondition: {
        type: 'checker_health',
        preflight_key: preflightKey,
        health_fingerprint: preflight.health_fingerprint,
        diagnostic_code: persistedResult.diagnostic_code,
        candidate_material_id: candidateId,
      },
      checkpoint: {
        phase: 'checker_unavailable',
        candidate_material_id: candidateId,
        check_result_id: persistedResult.check_result_id,
        preflight_key: preflightKey,
        diagnostic_code: persistedResult.diagnostic_code,
      },
    };
    if (normalFlow) {
      deferredWait = null;
      deferredBlock = {
        reason: 'checker health unavailable',
        dependency: {
          dependency_kind: 'CHECK_RESULT',
          check_result_id: persistedResult.check_result_id,
          requirement: {
            checker_health: {
              preflight_key: preflightKey,
              health_fingerprint: preflight.health_fingerprint,
            },
          },
        },
        checkpoint: lifecycle.checkpoint,
        terminal_state: 'FAILED',
      };
    } else {
      deferredWait = lifecycle;
    }
  } else if (normalFlow && persistedResult.result_class === 'infrastructure_failure') {
    const preflightKey = persistedResult.evidence?.preflight_key;
    const preflight = preflightKey ? state.judgeService.getCheckerPreflight(preflightKey) : null;
    if (preflightKey && preflight?.health_fingerprint) {
      deferredBlock = {
        reason: 'checker health unavailable',
        dependency: {
          dependency_kind: 'CHECK_RESULT',
          check_result_id: persistedResult.check_result_id,
          requirement: {
            checker_health: {
              preflight_key: preflightKey,
              health_fingerprint: preflight.health_fingerprint,
            },
          },
        },
        checkpoint: {
          phase: 'checker_unavailable',
          candidate_material_id: candidateId,
          check_result_id: persistedResult.check_result_id,
          preflight_key: preflightKey,
          diagnostic_code: persistedResult.diagnostic_code,
        },
        terminal_state: 'FAILED',
      };
    } else {
      // The Judge normally records a health fingerprint for every checker
      // infrastructure result. Keep a typed CheckResult dependency even when
      // an unusual adapter omits it; the Controller will leave the Task
      // blocked until an operator supplies a new accepted CheckResult.
      deferredBlock = {
        reason: 'checker health unavailable',
        dependency: {
          dependency_kind: 'CHECK_RESULT',
          check_result_id: persistedResult.check_result_id,
        },
        checkpoint: {
          phase: 'checker_unavailable',
          candidate_material_id: candidateId,
          check_result_id: persistedResult.check_result_id,
          diagnostic_code: persistedResult.diagnostic_code,
        },
        terminal_state: 'FAILED',
      };
    }
  }
  if (result.verdict === 'PASS' && completedTaskState(applied.task.state) && pending.taskId === state.rootTaskId) {
    state.solvedAt = Date.now();
    state.solvedBy = core.index;
  }
  // The report keeps its redacted operational projection above, while the
  // synchronous Agent tool receives bounded diagnostic feedback that can guide
  // the next candidate.
  return {
    // Apply the durable result before returning it so the synchronous Agent
    // view agrees with a subsequent judge_get_check_result read.
    check_result: agentCheckResult(persistedResult),
    applied,
    ...(deferredWait ? { deferred_wait: deferredWait } : {}),
    ...(deferredBlock ? { deferred_block: deferredBlock } : {}),
  };
}

async function stopCore(state, core) {
  core.stopping = true;
  if (core.taskId && core.executionId) {
    core.parallelism.transition(core.index, 'STOPPING', {
      task_id: core.taskId,
      execution_id: core.executionId,
      reason: 'benchmark_cleanup',
    });
  }
  const sessions = new Set([
    ...core.sessionHistory,
    core.session,
    core.releasedSession,
  ].filter(Boolean));
  // Runtime owns process termination, capacity release, fencing, and recovery
  // suppression. Keep those effects behind its public shutdown seam.
  await core.runtime.shutdown({ terminalState: 'FAILED', terminalReason: 'benchmark_deadline_cleanup' });
  await Promise.all([...sessions].map(async (session) => {
    try {
      await session.stop?.();
    } catch {
      // Cleanup must continue so the remaining Core sessions and Services are
      // released even when one Agent process exits with an error.
    }
  }));
  if (core.turnPromise) {
    await Promise.race([
      core.turnPromise.catch(() => undefined),
      sleep(5_000),
    ]);
  }
  if (core.boundTurnPromise) await core.boundTurnPromise.catch(() => undefined);
  const current = core.executionId ? state.taskService.getExecution(core.executionId) : null;
  if (core.parallelism) core.parallelism.transition(core.index, 'IDLE', {
    task_id: current?.task_id ?? null,
    execution_id: current?.execution_id ?? null,
    reason: 'benchmark_cleanup_complete',
  });
  await core.bridge.stop().catch(() => undefined);
}

function structureEvidence(taskService, taskTree, cores, mode) {
  const structures = taskTree.map((task) => taskService.getTaskStructure(task.task_id));
  const structureByTaskId = new Map(structures.map((structure) => [structure.task.task_id, structure]));
  const safePayload = (payload) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const keys = ['child_task_id', 'rework_task_id', 'prior_task_id', 'relationship', 'group_id', 'task_id', 'task_ids',
      'dependency_id', 'source_material_count', 'source_material_refs'];
    const safe = Object.fromEntries(keys.filter((key) => Object.hasOwn(payload, key)).map((key) => [key, payload[key]]));
    if (payload.dependency && typeof payload.dependency === 'object' && !Array.isArray(payload.dependency)) {
      const dependencyKeys = ['dependency_id', 'dependency_kind', 'prerequisite_task_id', 'material_id', 'check_result_id'];
      const dependency = Object.fromEntries(dependencyKeys
        .filter((key) => Object.hasOwn(payload.dependency, key))
        .map((key) => [key, payload.dependency[key]]));
      if (Object.keys(dependency).length > 0) safe.dependency = dependency;
    }
    return safe;
  };
  const events = structures.flatMap((structure) => structure.events.map((event) => ({
    task_id: structure.task.task_id,
    structural_version: event.structural_version,
    event_type: event.event_type,
    actor_ref: event.actor_ref,
    execution_id: event.execution_id,
    created_at: event.created_at,
    payload: safePayload(event.payload),
  }))).sort((left, right) => left.created_at.localeCompare(right.created_at) || left.task_id.localeCompare(right.task_id) || left.structural_version - right.structural_version);
  const groups = structures.flatMap((structure) => [...structure.branch_groups, ...structure.required_subtask_groups].map((group) => ({
    group_id: group.group_id,
    owner_task_id: group.owner_task_id,
    group_kind: group.group_kind,
    structural_version: group.structural_version,
    member_count: group.members.length,
    member_task_ids: group.members.map((member) => member.task_id),
    members: group.members.map((member) => ({
      task_id: member.task_id,
      state: member.state,
      satisfied: member.satisfied,
      readiness: member.readiness?.status ?? null,
    })),
    satisfaction: group.satisfaction,
    satisfied: group.satisfied,
    created_by_task_id: group.created_by_task_id,
    created_by_execution_id: group.created_by_execution_id,
    created_by_actor_ref: group.created_by_actor_ref,
    created_at: group.created_at,
  })));
  const provenance = [...structures.reduce((counts, structure) => {
    const kind = structure.provenance?.creation_kind;
    if (kind) counts.set(kind, (counts.get(kind) ?? 0) + 1);
    return counts;
  }, new Map())].sort(([left], [right]) => left.localeCompare(right)).map(([creation_kind, count]) => ({ creation_kind, count }));
  const agentOperations = cores.flatMap((core) => core.structureOperations.map((operation) => ({ core: core.index, ...operation })));
  const operationCounts = Object.fromEntries([...new Set(agentOperations.map((operation) => operation.operation))]
    .map((operation) => [operation, agentOperations.filter((candidate) => candidate.operation === operation).length]));
  const root = taskTree.find((task) => task.parent_id === null) ?? null;
  const completion = {
    task_contracts: taskTree.map((task) => ({
      task_id: task.task_id,
      state: task.state,
      satisfied: completedTaskState(task.state),
      structure_satisfied: structureByTaskId.get(task.task_id)?.satisfaction.satisfied ?? false,
    })),
    branch_and_subtask_groups: groups.map((group) => ({
      group_id: group.group_id,
      owner_task_id: group.owner_task_id,
      group_kind: group.group_kind,
      satisfaction: group.satisfaction,
      satisfied: group.satisfied,
      member_task_ids: group.member_task_ids,
    })),
    root: root ? {
      task_id: root.task_id,
      state: root.state,
      task_contract_satisfied: completedTaskState(root.state),
      structure_satisfied: structureByTaskId.get(root.task_id)?.satisfaction.satisfied ?? false,
    } : null,
  };
  return {
    mode,
    agent_operation_count: agentOperations.length,
    agent_operation_counts: operationCounts,
    agent_operations: agentOperations,
    event_count: events.length,
    events,
    branch_group_count: groups.filter((group) => group.group_kind === 'BRANCH').length,
    required_subtask_group_count: groups.filter((group) => group.group_kind === 'REQUIRED_SUBTASK').length,
    groups,
    completion,
    creation_provenance_counts: provenance,
  };
}

function readinessEvidence(samples, endedAt) {
  const byTask = new Map();
  for (const sample of samples) {
    for (const task of sample.tasks) {
      const entries = byTask.get(task.task_id) ?? [];
      entries.push({ at_ms: sample.at_ms, readiness: task.readiness, missing: task.missing });
      byTask.set(task.task_id, entries);
    }
  }
  const intervals = [];
  for (const [taskId, entries] of byTask.entries()) {
    let current = null;
    for (const entry of entries) {
      const key = stableStringify({ readiness: entry.readiness, missing: entry.missing });
      if (!current) {
        current = { task_id: taskId, start_ms: entry.at_ms, end_ms: entry.at_ms, readiness: entry.readiness, missing: entry.missing, key };
      } else if (current.key === key) {
        current.end_ms = entry.at_ms;
      } else {
        delete current.key;
        intervals.push(current);
        current = { task_id: taskId, start_ms: entry.at_ms, end_ms: entry.at_ms, readiness: entry.readiness, missing: entry.missing, key };
      }
    }
    if (current) {
      current.end_ms = endedAt;
      delete current.key;
      intervals.push(current);
    }
  }
  intervals.sort((left, right) => left.start_ms - right.start_ms || left.task_id.localeCompare(right.task_id));
  return {
    sample_count: samples.length,
    task_count: byTask.size,
    intervals,
  };
}

function recordReadinessSnapshot(state, at = Date.now()) {
  const tasks = state.taskService.listTasks({
    rootId: state.rootTaskId,
    states: ['OPEN', 'BLOCKED', 'RUNNING', 'DONE', 'CLOSED', 'CANCELED', 'WAITING', 'SATISFIED', 'FAILED', 'CANCELLED', 'REJECTED'],
    limit: 100,
    availableOnly: false,
  });
  state.readinessSamples.push({
    at_ms: at,
    tasks: tasks.map((task) => {
      const explanation = state.taskService.explainTaskReadiness(task.task_id);
      return { task_id: task.task_id, readiness: explanation.readiness, missing: explanation.missing };
    }),
  });
}

function projectReport(state, startedAt, deadline) {
  const endedAt = Date.now();
  for (const core of state.cores) {
    for (const session of core.sessionHistory) collectToolEvents(core, session.rpcRecords);
  }
  const materials = state.contextService.readMaterials({});
  const materialConsumptions = state.contextService.listMaterialConsumptions({});
  const taskTree = state.taskService.listTasks({
    rootId: state.rootTaskId,
    states: ['OPEN', 'BLOCKED', 'RUNNING', 'DONE', 'CLOSED', 'CANCELED', 'WAITING', 'SATISFIED', 'FAILED', 'CANCELLED', 'REJECTED'],
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
  const allowedInputMaterialIds = new Set(materials
    .filter((material) => allowedTaskIds.has(material.source_task) && allowedExecutionIds.has(material.source_execution))
    .map((material) => material.material_id));
  const workspaceViolation = claimHistory.some((claim) => {
    const execution = state.taskService.getExecution(claim.execution_id);
    const task = state.taskService.getTask(claim.task_id);
    const inputMaterialRefs = execution?.input_material_refs ?? [];
    return !execution || !task?.workspace || inputMaterialRefs.some((materialId) => !allowedInputMaterialIds.has(materialId)) ||
      execution.input_snapshot_hash !== inputSnapshotHash(task, execution.input_material_refs);
  });
  const cores = state.cores.map((core) => {
    const lastClaim = core.claimHistory.at(-1);
    const taskId = core.taskId ?? lastClaim?.task_id ?? null;
    const executionId = core.executionId ?? lastClaim?.execution_id ?? null;
    const task = taskId ? state.taskService.getTask(taskId) : null;
    const execution = executionId ? state.taskService.getExecution(executionId) : null;
    return {
      core: core.index,
      task_id: taskId,
      execution_id: executionId,
      turns: core.turns,
      turn_durations_ms: core.turnDurationsMs,
      turn_timeout_count: core.turnTimeoutCount,
      session_count: core.sessionHistory.length,
      session_recovery_count: core.sessionRecoveryCount,
      checks: core.checks,
      errors: core.errors,
      cheating_flags: core.cheatingFlags,
      claims: core.claimHistory.map((claim) => ({
        ...claim,
        workspace_revision_end: state.taskService.getExecution(claim.execution_id)?.workspace_revision ?? null,
      })),
      latency_samples: core.latencySamples,
      tool_events: [...new Set(core.toolEvents)],
      workspace_writes: core.workspaceWrites,
      structure_operations: core.structureOperations,
      tool_errors: core.toolErrors,
      material_reads: core.materialReads,
      material_consumptions: core.materialConsumptions,
      task_state: task?.state ?? null,
      execution_state: execution?.state ?? null,
      input_snapshot_hash: execution?.input_snapshot_hash ?? null,
      workspace_ref: execution?.workspace_ref ?? null,
      versions: sanitizedVersionManifest(core.versionManifest),
    };
  });
  const toolViolation = cores.some((core) => core.tool_events.some((tool) => {
    const name = String(tool);
    return !name.startsWith('swarmenv_');
  }));
  const toolErrorCount = cores.reduce((count, core) => count + core.tool_errors.length, 0);
  // A Service tool can reject an Agent request because the model supplied a
  // stale version, an invalid state transition, or a boundary-incompatible
  // payload. The bridge returns that error to the Agent as tool feedback. It
  // is not a protocol violation and must not invalidate the whole project.
  const toolProtocolErrorCount = cores.reduce((count, core) => count + core.tool_errors.filter((error) => error.protocol === true).length, 0);
  const claimedExecutionIds = [...new Set(claimHistory.map((claim) => claim.execution_id))];
  const workspaceRefs = claimedExecutionIds.map((executionId) => state.taskService.getExecution(executionId)?.workspace_ref).filter(Boolean);
  const workspaceBoundaryViolation = workspaceRefs.length !== claimedExecutionIds.length || new Set(workspaceRefs).size !== workspaceRefs.length;
  const candidateBoundaryViolation = claimHistory.some((claim) => {
    const execution = state.taskService.getExecution(claim.execution_id);
    if (!execution?.candidate_material_id) return false;
    const material = state.contextService.getMaterial(execution.candidate_material_id);
    return !material || material.source_task !== claim.task_id || material.source_execution !== claim.execution_id;
  });
  const invalid = toolViolation || toolProtocolErrorCount > 0 || materialBoundaryViolation || inputMaterialViolation || workspaceViolation || workspaceBoundaryViolation ||
    candidateBoundaryViolation || cores.some((core) => core.cheating_flags.length > 0);
  const childTaskCount = taskTree.filter((task) => task.parent_id !== null).length;
  const decompositionAvailable = childTaskCount > 0;
  const lifecycle = lifecycleEvents(state.taskService);
  const taskLifecycle = taskLifecycleEvents(state.taskService);
  const admissionEvents = taskLifecycle.filter((event) => ADMISSION_OPERATIONS.has(event.operation));
  const narratives = executionNarratives(state, taskTree, materials);
  const invalidWaitAttemptCount = cores.reduce((count, core) => count + (core.toolErrors ?? []).filter((error) =>
    error.operation === 'request_wait' && ['INVALID_CONTRACT', 'NOT_ALLOWED', 'FENCED'].includes(error.code)).length, 0);
  const taskById = new Map(taskTree.map((task) => [task.task_id, task]));
  const childClaimCount = claimHistory.filter((claim) => taskById.get(claim.task_id)?.parent_id !== null).length;
  const rootClaimCount = claimHistory.filter((claim) => claim.task_id === state.rootTaskId).length;
  const executionClaimCounts = new Map();
  for (const claim of claimHistory) executionClaimCounts.set(claim.execution_id, (executionClaimCounts.get(claim.execution_id) ?? 0) + 1);
  const resumedExecutionCount = [...executionClaimCounts.values()].filter((count) => count > 1).length;
  const workspaceWriteCount = cores.reduce((count, core) => count + core.workspace_writes.length, 0);
  const meaningfulMaterialCount = materials.filter((material) => !['failure', 'blocker'].includes(material.kind)).length;
  const candidateCount = cores.reduce((count, core) => count + core.checks.length, 0);
  const structure = structureEvidence(state.taskService, taskTree, state.cores, state.parallelMode);
  const madeProgress = childTaskCount > 0 || workspaceWriteCount > 0 || meaningfulMaterialCount > 0 || candidateCount > 0;
  const parallelism = state.parallelism.snapshot({ endedAt });
  const checkerPreflights = state.judgeService.listCheckerPreflights().map((row) => ({
    preflight_key: row.preflight_key,
    fixture_id: row.fixture_id,
    checker_ref: row.checker_ref,
    checker_version: row.checker_version,
    environment_ref: row.environment_ref,
    status: row.status,
    checker_process_status: row.checker_process_status,
    diagnostic_code: row.diagnostic_code,
    retryable: row.retryable,
    attempt_count: row.attempt_count,
    preflight_supported: row.evidence?.preflight_supported ?? null,
    preflight_verified: row.evidence?.preflight_verified ?? null,
    input_binding_verified: row.evidence?.input_binding_verified ?? null,
    toolchain_version_verified: row.evidence?.toolchain_version_verified ?? null,
    checker_ref_verified: row.evidence?.checker_ref_verified ?? null,
    checker_version_verified: row.evidence?.checker_version_verified ?? null,
    checker_identity_verified: row.evidence?.checker_identity_verified ?? null,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
  }));
  const report = {
    schema_version: 1,
    protocol: {
      project_isolation: true,
      core_count: 4,
      repository_commit: state.repositoryCommit,
      repository_worktree_dirty: state.repositoryWorktreeDirty,
      parallel_mode: state.parallelMode,
      normal_flow: state.normalFlow,
      input_policy: 'pinned formalization only; no candidate or solution input',
      tool_policy: 'registered swarmenv_* Service tools; Pi built-in tools, shell, web, and external context are disabled; generic service calls are rejected',
      registered_services: state.capabilityRegistry.listServices().map((service) => ({
        service_id: service.service_id,
        provider_version: service.provider_version,
        contract_version: service.contract_version,
        manifest_hash: service.manifest_hash,
        tool_count: service.tool_count,
      })),
      allowed_agent_tool_names: [...state.allowedAgentToolNames].sort(),
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
      structure,
      readiness: readinessEvidence(state.readinessSamples, endedAt),
      // Keep the historical field name while carrying the same bounded
      // narrative used by operators: goal, actions, outputs, dependencies,
      // and terminal/block reasons without proof contents or raw payloads.
      execution_history: narratives,
      execution_narratives: narratives,
    },
    parallelism: {
      ...parallelism,
      decomposition_available: decompositionAvailable,
      decomposition_evidence: {
        definition: 'true only when an independent child Task was actually created and recorded; false means no independent child work was observed in this run',
        observed_child_task_count: childTaskCount,
        scheduler_status_count: state.schedulerStatusCount,
        ready_work_ms: parallelism.ready_work_ms,
        ready_unassigned_ms: parallelism.ready_unassigned_ms,
      },
    },
    run: {
      started_at: new Date(startedAt).toISOString(),
      ended_at: new Date(endedAt).toISOString(),
      elapsed_ms: endedAt - startedAt,
      deadline_ms: deadline - startedAt,
      protocol_valid: !invalid,
      made_progress: madeProgress,
      progress_evidence: {
        child_task_count: childTaskCount,
        workspace_write_count: workspaceWriteCount,
        meaningful_material_count: meaningfulMaterialCount,
        candidate_check_count: candidateCount,
      },
      solved: state.solvedAt !== null && !invalid && madeProgress,
      solved_by_core: invalid || !madeProgress ? null : state.solvedBy,
      solved_at_ms: state.solvedAt === null ? null : state.solvedAt - startedAt,
      material_count: materials.length,
      material_consumption_count: materialConsumptions.length,
      material_consumptions: materialConsumptions.map((row) => ({
        operation_id: row.operation_id,
        material_id: row.material_id,
        reader_task: row.reader_task,
        reader_execution: row.reader_execution,
        action: row.action,
        action_ref: row.action_ref,
        created_at: row.created_at,
      })),
      project_material_count: materials.filter((material) => material.source_task === state.rootTaskId).length,
      candidate_count: cores.reduce((count, core) => count + core.checks.length, 0),
      ended_early: state.stopOnSolved && state.solvedAt !== null,
      deadline_reached: Date.now() >= deadline,
      cleanup_elapsed_ms: state.cleanupElapsedMs,
      resources_at_start: state.resourcesAtStart,
      resources_at_end: resourceSnapshot(),
      heartbeat_count: state.heartbeatCount,
      heartbeat_error_count: state.heartbeatErrorCount,
      watchdog_sweep_count: state.watchdogSweepCount,
      watchdog_recovery_count: state.watchdogRecoveryCount,
      watchdog_error_count: state.watchdogErrorCount,
      execution_timeout_sweep_count: state.executionTimeoutSweepCount,
      execution_timeout_error_count: state.executionTimeoutErrorCount,
      candidate_check_count: cores.reduce((count, core) => count + core.checks.length, 0),
      tool_error_count: toolErrorCount,
      tool_protocol_error_count: toolProtocolErrorCount,
      invalid_wait_attempt_count: invalidWaitAttemptCount,
      scheduler_status_count: state.schedulerStatusCount,
      core_daemons: state.daemons?.map((daemon) => daemon.snapshot()) ?? [],
      daemon_events: state.daemonEvents ?? [],
      // Kept as a compatibility projection for existing report consumers;
      // production decisions are owned by Controller and CoreDaemon above.
      scheduler: state.scheduler?.snapshot() ?? null,
      scheduler_events: state.schedulerEvents,
      controller: state.controller?.snapshot() ?? null,
      controller_events: state.controllerEvents,
      latency_samples: cores.flatMap((core) => core.latency_samples ?? []),
      latency_summary: {
        ready_to_session_start_ms: state.schedulerEvents
          .filter((event) => event.kind === 'scheduler_dispatch_started' && Number.isFinite(event.ready_to_dispatch_ms))
          .map((event) => event.ready_to_dispatch_ms),
        ready_to_claim_ms: cores.flatMap((core) => core.latency_samples ?? [])
          .map((sample) => sample.ready_to_claim_ms).filter(Number.isFinite),
        claim_to_first_turn_ms: cores.flatMap((core) => core.latency_samples ?? [])
          .map((sample) => sample.claim_to_first_turn_ms).filter(Number.isFinite),
        wait_to_core_release_ms: cores.flatMap((core) => core.latency_samples ?? [])
          .map((sample) => sample.wait_to_core_release_ms).filter(Number.isFinite),
        condition_to_resumed_turn_ms: cores.flatMap((core) => core.latency_samples ?? [])
          .map((sample) => sample.condition_to_resumed_turn_ms).filter(Number.isFinite),
      },
      decomposition_available: decompositionAvailable,
      lifecycle_events: lifecycle,
      task_lifecycle_events: taskLifecycle,
      admission_events: admissionEvents,
      tool_error_classes: [...new Set(cores.flatMap((core) => core.tool_errors.map((error) => error.code)))],
      claimed_core_count: new Set(state.cores.filter((core) => core.claimHistory.length > 0).map((core) => core.index)).size,
      claim_count: claimHistory.length,
      child_claim_count: childClaimCount,
      root_claim_count: rootClaimCount,
      resumed_execution_count: resumedExecutionCount,
      wait_count: state.taskService.db.prepare("SELECT COUNT(*) AS count FROM operations WHERE operation = 'request_wait'").get().count,
      wake_count: state.taskService.db.prepare("SELECT COUNT(*) AS count FROM operations WHERE operation = 'wake_execution'").get().count,
      accept_count: state.taskService.db.prepare("SELECT COUNT(*) AS count FROM operations WHERE operation = 'accept_task'").get().count,
      rework_count: state.taskService.db.prepare("SELECT COUNT(*) AS count FROM operations WHERE operation = 'request_rework'").get().count,
      resume_count: state.taskService.db.prepare("SELECT COUNT(*) AS count FROM operations WHERE operation = 'resume_execution'").get().count,
      checker_preflights: checkerPreflights,
      checker_infrastructure_failure_count: cores.reduce((count, core) => count + core.checks.filter((check) => check.result_class === 'infrastructure_failure').length, 0),
      checker_source_failure_count: cores.reduce((count, core) => count + core.checks.filter((check) => check.result_class === 'source_failure').length, 0),
      checker_unassessed_count: cores.reduce((count, core) => count + core.checks.filter((check) => check.mathematical_outcome === 'unassessed').length, 0),
    },
    cores,
    audit: {
      input_source_hash: state.problem.source_hash,
      prompt_hashes: state.cores.map((core) => ({ core: core.index, prompt_hash: sha256(core.prompt) })),
      all_tool_events: [...new Set(cores.flatMap((core) => core.tool_events))],
      invalid,
      invalid_reasons: [
        ...(toolViolation ? ['non_swarmenv_tool_event'] : []),
        ...(toolProtocolErrorCount > 0 ? ['agent_tool_protocol_error'] : []),
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
  const selectedParallelMode = parallelMode(options);
  const normalFlow = options.normalFlow ?? selectedParallelMode === 'semantic';
  const runId = options.runId ?? randomUUID();
  const startedAt = options.startedAt ?? Date.now();
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
  const database = new DatabaseSync(databasePath);
  const observationStore = options.observationStore ?? new ObservationStore(database);
  const serviceLogger = (name) => fanoutLogger(
    new DurableEventLog(join(logRoot, 'services', `${name}.ndjson`), { scope: name }),
    observationLogger(observationStore, runId, name),
  );
  const taskLogger = serviceLogger('task-service');
  const contextLogger = serviceLogger('context-service');
  const routerLogger = serviceLogger('service-router');
  const judgeLogger = serviceLogger('judge-service');
  const checkerLogger = fanoutLogger(
    new DurableEventLog(join(logRoot, 'judge', 'lean-checker.ndjson'), { raw: true, scope: 'judge:lean-checker' }),
    observationLogger(observationStore, runId, 'judge'),
  );
  const contextService = new ContextService(database, { logger: contextLogger });
  const taskService = new TaskService(database, { contextService, logger: taskLogger });
  contextService.taskService = taskService;
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
    maxInfrastructureRetries: options.maxInfrastructureRetries,
    checker: options.checker ?? new LeanChecker({
      workRoot: join(projectDir, 'judge-work'),
      logger: checkerLogger,
      command: options.leanCommand ?? 'lake',
      timeoutMs: options.checkerTimeoutMs ?? 120_000,
    }),
  });
  taskService.setCheckerHealthReader((preflightKey) => judgeService.getCheckerPreflight(preflightKey));
  judgeService.setDependencyEventSink((event) => taskService.notifyDependencyEvent(event));
  const mathlibSearchUrl = options.mathlibSearchUrl ?? process.env.SWARMENV_MATHLIB_SEARCH_URL ?? null;
  const serviceEndpoints = options.serviceEndpoints ?? Object.fromEntries(
    ['task', 'context', 'judge', 'catalog']
      .map((serviceId) => {
        const key = serviceId.toUpperCase();
        const url = process.env[`SWARMENV_${key}_SERVICE_URL`];
        if (!url) return [serviceId, undefined];
        return [serviceId, {
          url,
          token: process.env[`SWARMENV_${key}_SERVICE_TOKEN`] ?? null,
        }];
      })
      .filter(([, endpoint]) => endpoint !== undefined),
  );
  const capabilityRegistry = options.serviceRegistry ?? createBuiltinServiceRegistry({
    taskService,
    contextService,
    judgeService,
    serviceEndpoints,
    customServices: options.customServices ?? [],
  });
  if (!options.serviceRegistry && mathlibSearchUrl) {
    registerUserService(capabilityRegistry, {
      manifest: createMathlibSearchManifest({
        endpoint: { transport: 'http-json', url: mathlibSearchUrl },
        mathlibRevision: options.mathlibRevision ?? fixture.mathlib_version ?? null,
        leanVersion: options.leanVersion ?? fixture.lean_toolchain ?? null,
      }),
      adapter: createHttpJsonAdapter({ token: options.mathlibSearchToken ?? process.env.SWARMENV_MATHLIB_SEARCH_TOKEN ?? null }),
    });
    await capabilityRegistry.checkReadiness('mathlib-search');
  }
  // Owner/controller SDK calls are synchronous local transactions. Keep that
  // control-plane registry local even when Agent-facing providers are remote;
  // ServicesBridge uses capabilityRegistry for the named HTTP calls.
  const routerRegistry = createBuiltinServiceRegistry({ taskService, contextService, judgeService });
  const router = new ServicesRouter({ taskService, contextService, judgeService, registry: routerRegistry, logger: routerLogger });
  const allowedAgentToolNames = [...new Set([
    AGENT_ROLES.SELECTION,
    AGENT_ROLES.BOUND,
    AGENT_ROLES.RECOVERY,
  ].flatMap((role) => buildCapabilityProfile({
    role,
    registry: capabilityRegistry,
    runtimeCapabilities: role === AGENT_ROLES.SELECTION ? [] : runtimeCapabilityList(),
  }).capabilities.map((capability) => `swarmenv_${capability.tool_name ?? capability.name}`)))];
  const owner = sdk(router, { actorRef: 'owner:benchmark' });
  observationStore.registerExperiment({ experimentId: runId, status: 'CREATED', metadata: { problem_id: problem.id } });
  const modeInstructions = selectedParallelMode === 'semantic'
    ? 'This is the semantic-structure treatment. Before proof work, call swarmenv_task_create_branch_group with at least two genuinely different ordinary Tasks. If this Task is a Branch member, call swarmenv_task_add_required_subtask at least twice for one separable required group before finishing either route. Read swarmenv_task_get_structure and swarmenv_task_explain_readiness after each change. These must be real claimable responsibilities with concrete outputs; do not use generic child creation for these routes. After child or branch Materials exist, the Root must read them with swarmenv_context_read, durably record the bounded handoff with swarmenv_context_consume using action integration, make a bounded Workspace integration note, and publish one root-owned Material with scope root_integration whose provenance names the consumed Material IDs before blocking or claiming the collaboration loop complete.'
    : selectedParallelMode === 'root-only'
      ? 'This is the Root-only control. Keep all work on this root Task. Do not create child Tasks, Branch groups, required-subtask groups, dependencies, or rework Tasks.'
      : 'Use direct child Tasks only when a genuinely separable route emerges.';
  const dependencyInstruction = normalFlow
    ? 'When a real external dependency blocks progress, preserve useful Workspace and Materials and call execution_block with a typed dependency; this ends the Execution and releases the Core. Do not call request_wait in the normal-flow treatment.'
    : 'Before waiting, preserve useful Workspace and Material contributions and use a wait condition that reflects the actual dependency.';
  const root = owner.proposeTask({
    task_type: 'proof',
    goal: `Prove ${problem.id}`,
    expected_output: 'A verified Lean proof for the locked PutnamBench problem',
    task_instructions: `The sole goal of this root Task is to prove the locked PutnamBench problem. Start by reading the real Workspace, inspect only file paths returned by list_workspace_files, inspect the formalization and toolchain, then work toward a real Lean proof and the completion contract. Use only the locked problem Workspace and registered SwarmEnv Services; do not use external answers, hidden solution files, shell, web, or solution-derived input. The locked formalization is read-only input and may contain sorry as the unsolved-problem marker; never publish or submit that input file as a candidate. Create a separate candidate file, read it back, and verify it contains a real proof with no sorry, admit, axiom, or other placeholder. If no honest candidate is ready, preserve useful evidence and block on a concrete dependency instead of submitting the input file. ${modeInstructions} Child contracts may require research Materials or proof candidates according to the route. The root completion contract requires its final candidate to be checked by the configured Lean Judge. ${dependencyInstruction} Later reclaim the root to read child Workspace changes, Materials, and Judge feedback, then accept completed work or request focused rework before integrating it into the proof.`,
    completion_contract: {
      ...(normalFlow ? { normal_flow: true } : {}),
      ...(selectedParallelMode === 'semantic' ? {
        required_materials: [{ kinds: ['artifact', 'fact', 'experience', 'failure'], scope: 'root_integration', min_count: 1, requires_consumption: true, action: 'integration' }],
      } : {}),
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
  observationStore.registerExperiment({ experimentId: runId, rootTaskId: root.task_id, status: 'RUNNING', metadata: { problem_id: problem.id } });
  observationStore.append({
    experimentId: runId,
    source: 'runtime',
    kind: 'experiment_started',
    taskId: root.task_id,
    payload: { problem_id: problem.id, core_count: 4, timebox_ms: options.timeboxMs ?? 60 * 60_000, parallel_mode: selectedParallelMode, normal_flow: normalFlow },
  });
  // Deterministic queue scenarios may seed durable Tasks before reusable Core
  // sessions start. The hook uses the same Task Service boundary as Agent
  // operations; it does not replace queue claim, Runtime, or dispatch logic.
  await options.prepareProject?.({ owner, root, taskService, contextService, router, fixture, problem });
  const parallelism = new CoreParallelismTracker({ coreCount: 4, startedAt });
  const cores = [];
  try {
    for (let index = 1; index <= 4; index += 1) {
    const coreDir = join(workspaceRoot, `core-${index}`);
    const childEnv = { ...process.env };
    const adapter = options.agentAdapterFactory
      ? options.agentAdapterFactory({ index, problem, executionId: null, coreDir, env: childEnv })
      : new BenchmarkAgentCoreAdapter({
        command: options.command ?? (options.provider === 'openai-codex' ? 'pi' : 'nurouter'),
        provider: options.provider ?? process.env.NUROUTER_PI_PROVIDER,
        model: options.model ?? process.env.NUROUTER_PI_MODEL,
        account: options.account ?? process.env.NUROUTER_PI_ACCOUNT,
        group: options.group ?? process.env.NUROUTER_PI_GROUP,
        extensionPath: options.extensionPath ?? resolve(new URL('../agent/swarmenv-extension.mjs', import.meta.url).pathname),
        cwd: coreDir,
        sessionDir: join(coreDir, '.swarm', 'pi-session'),
        env: childEnv,
        allowedToolNames: allowedAgentToolNames,
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
      capabilityRegistry,
      maxWorkers: 1,
      coreIds: [`core-${index}`],
      actorRef: `runtime:core-${index}`,
      watchdogTimeoutMs: options.watchdogTimeoutMs,
      executionTimeoutMs: options.executionTimeoutMs,
      handoffReminderMs: options.handoffReminderMs,
      logger: new DurableEventLog(join(logRoot, 'runtime', `core-${index}.ndjson`), { scope: `runtime:core-${index}` }),
      agentLogger: new DurableEventLog(join(logRoot, 'agents', `core-${index}.ndjson`), { raw: true, scope: `agent:core-${index}` }),
      onSessionStarted: ({ execution, session, recovery }) => {
        if (recovery) attachRecoveredSession(core, { execution, session });
      },
    });
    const core = {
      index,
      actorRef: `agent:core-${index}`,
      coreDir,
      adapter,
      childEnv,
      taskId: null,
      executionId: null,
      prompt: GENERIC_AGENT_PROMPT,
      claim: null,
      claimHistory: [],
      latencySamples: [],
      latencyByExecution: new Map(),
      runtime,
      workspaceManager,
      bridge: null,
      session: null,
      releasedSession: null,
      waitingExecutionId: null,
      sessionHistory: [],
      sessionNumber: 0,
      sessionRecoveryCount: 0,
      startConfig: { problem, logRoot, options },
      turnInFlight: false,
      recoveryInFlight: false,
      agentTurnSession: null,
      turnPromise: null,
      initialTurnPromise: null,
      boundTurnPromise: null,
      turnStartedAt: 0,
      nextTurnAt: 0,
      turnIntervalMs: options.turnIntervalMs ?? 1_000,
      turns: 0,
      toolEvents: [],
      workspaceWrites: [],
      toolErrors: [],
      errors: [],
      materialReads: [],
      structureOperations: [],
      checks: [],
      checked: new Set(),
      checkAttempts: new Map(),
      cheatingFlags: [],
      materialConsumptions: [],
      stopping: false,
      turnDurationsMs: [],
      turnTimeoutCount: 0,
      watchdogPromise: null,
      dispatchReserved: false,
      sessionStartAttempts: 0,
      sessionStartFailures: 0,
      selectionActive: false,
      selectionClaim: null,
      selectionTurnCount: 0,
      daemon: null,
      unboundSessionCount: 0,
      parallelism,
      versionManifest: null,
      observe(event) {
        observationStore.append({ experimentId: runId, ...event });
      },
    };
    core.observe({
      source: 'runtime', kind: 'core_state_changed', visibility: 'operator',
      coreId: `core-${core.index}`,
      payload: { state: 'IDLE', reason: 'core_ready' },
    });
    const bridge = new ServicesBridge({
      taskService,
      contextService,
      runtime,
      router,
      registry: capabilityRegistry,
      actorRef: `agent:core-${index}`,
      onClaim: async (claim) => {
        if (core.selectionActive) core.selectionClaim = claim;
        core.dispatchReserved = false;
        const claimedAt = Date.now();
        const priorWaitingExecutionId = core.waitingExecutionId;
        core.waitingExecutionId = null;
        core.parallelism.transition(core.index, 'ASSIGNED', {
          task_id: claim.task.task_id,
          execution_id: claim.execution.execution_id,
          reason: 'claim_succeeded',
        });
        core.taskId = claim.task.task_id;
        core.executionId = claim.execution.execution_id;
        core.claim = claim;
        const workerSession = core.session;
        if (!workerSession) throw new Error('Agent claimed a Task before its session was registered');
        const claimRecord = {
          task_id: claim.task.task_id,
          execution_id: claim.execution.execution_id,
          workspace_revision_start: null,
          claimed_at: new Date(claimedAt).toISOString(),
          ready_observed_at: core.stateRef?.readyObservedAt.get(claim.task.task_id)
            ? new Date(core.stateRef.readyObservedAt.get(claim.task.task_id)).toISOString()
            : null,
          ready_to_claim_ms: core.stateRef?.readyObservedAt.has(claim.task.task_id)
            ? Math.max(0, claimedAt - core.stateRef.readyObservedAt.get(claim.task.task_id))
            : null,
          resumed_from_wait: priorWaitingExecutionId === claim.execution.execution_id || claim.execution.attempt_no > 1,
        };
        core.latencySamples.push(claimRecord);
        core.latencyByExecution.set(claim.execution.execution_id, claimRecord);
        core.claimHistory.push(claimRecord);
        const bound = await runtime.bindAgentExecution(claim.execution.execution_id, null, {
          workspaceRef: join(workspaceRoot, claim.execution.execution_id),
          startSession: async ({ execution, workspace }) => {
            core.childEnv.SWARMENV_AGENT_ROLE = AGENT_ROLES.BOUND;
            const session = await core.adapter.start({
              executionId: execution.execution_id,
              sessionDir: join(workspace.workspace_ref, '.swarm', 'pi-session'),
              cwd: workspace.workspace_ref,
              logger: new DurableEventLog(join(logRoot, 'agents', `core-${core.index}.ndjson`), { raw: true, scope: `agent:core-${core.index}` }),
              observation: core.observe,
              observationContext: { coreId: `core-${core.index}`, taskId: execution.task_id, executionId: execution.execution_id },
            });
            // Deterministic compatibility adapters may attach a one-shot
            // fault policy to the reusable worker Session. Preserve that
            // policy when the Daemon hands the claim to the fresh bound
            // Session; real Pi sessions do not expose these fields.
            for (const field of ['hardToolError', 'invalidClaim']) {
              if (field in workerSession && field in session) session[field] = workerSession[field];
            }
            core.session = session;
            core.sessionHistory.push(session);
            core.versionManifest = session.manifest ?? null;
            if (core.agentTurnSession) {
              // The unbound discovery turn is still awaiting its transport
              // settlement when claim handoff starts this bound session. End
              // that interval before opening the bound Agent interval; the
              // Runtime process is already registered at this point, so an
              // active-process count cannot distinguish the two turns.
              core.parallelism.endAgentTurn(core.index, Date.now(), 'claim_handoff');
              core.agentTurnSession = null;
            }
            core.parallelism.transition(core.index, 'RUNNING', {
              task_id: execution.task_id,
              execution_id: execution.execution_id,
              reason: 'execution_started',
            });
            core.parallelism.beginAgentTurn(core.index, {
              task_id: execution.task_id,
              execution_id: execution.execution_id,
              reason: 'initial_bound_turn',
            });
            core.agentTurnSession = session;
            const latency = core.latencyByExecution.get(execution.execution_id);
            if (latency && !latency.first_turn_started_at) {
              const firstTurnAt = Date.now();
              latency.first_turn_started_at = new Date(firstTurnAt).toISOString();
              latency.claim_to_first_turn_ms = Math.max(0, firstTurnAt - Date.parse(latency.claimed_at));
              const eligibilityAt = core.stateRef?.waitEligibilityAt.get(execution.execution_id);
              if (eligibilityAt !== undefined) {
                latency.condition_satisfied_observed_at = new Date(eligibilityAt).toISOString();
                latency.resume_eligible_at = new Date(eligibilityAt).toISOString();
                latency.condition_to_resumed_turn_ms = Math.max(0, firstTurnAt - eligibilityAt);
              }
            }
            return session;
          },
          agentPrompt: modePrompt(selectedParallelMode, BOUND_AGENT_PROMPT),
        });
        const boundSession = core.session;
        const boundExecutionId = claim.execution.execution_id;
        if (boundSession && core.runtime.hasActiveExecution(claim.execution.execution_id)) {
          core.turnInFlight = true;
          let boundTurnPromise;
          boundTurnPromise = (async () => {
            try {
              if (typeof boundSession.waitForSettled === 'function') await boundSession.waitForSettled({ timeoutMs: Math.max(core.startConfig.options.turnTimeoutMs ?? 30_000, 180_000) });
              // A settled Agent turn does not necessarily release its
              // Execution: source-level checker feedback, incremental edits,
              // and ordinary progress may leave the Task RUNNING. Continue
              // that same bound Session until Runtime observes a wait or a
              // terminal Task state; CoreDaemon must not wait forever for a
              // release that only a later turn can produce.
              while (!core.stopping && core.session === boundSession && core.executionId === boundExecutionId) {
                const current = taskService.getExecution(boundExecutionId);
                if (!current || current.state !== 'RUNNING') break;
                await new Promise((resolve) => setTimeout(resolve, Math.min(core.turnIntervalMs ?? 1_000, 100)));
                if (core.stopping || core.session !== boundSession || core.executionId !== boundExecutionId) break;
                core.turnStartedAt = Date.now();
                core.turnInFlight = false;
                await runTurn(core, modePrompt(selectedParallelMode, BOUND_AGENT_PROMPT), core.startConfig.options.turnTimeoutMs ?? 30_000);
              }
            } catch (error) {
              const expectedHandoff = boundSession.expectedStop || core.session !== boundSession || core.stopping;
              if (!expectedHandoff) core.errors.push({ code: error.code ?? error.name, class: safeDiagnostic(error.message) ?? 'agent_turn_error' });
            } finally {
              collectToolEvents(core, boundSession.rpcRecords ?? []);
              if (core.agentTurnSession === boundSession) {
                core.parallelism.endAgentTurn(core.index, Date.now());
                core.agentTurnSession = null;
              }
              if (core.session === boundSession || (!core.executionId && !core.runtime.hasActiveExecution(boundExecutionId))) {
                core.turns += 1;
                core.turnInFlight = false;
                core.nextTurnAt = Date.now();
              }
              // CoreDaemon waits for the Runtime release boundary. Terminal
              // Task transitions must therefore release the bridge binding
              // here, rather than relying on the benchmark's periodic repair
              // sweep to break a handoff wait.
              if (core.executionId === boundExecutionId) {
                const settled = taskService.getExecution(boundExecutionId);
                if (settled && ['SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED', 'FENCED', 'SUPERSEDED'].includes(settled.state)) {
                  await releaseTerminalExecution(core);
                }
              }
              core.stateRef?.requestDaemonWake?.();
              if (core.boundTurnPromise === boundTurnPromise) core.boundTurnPromise = null;
            }
          })();
          core.boundTurnPromise = boundTurnPromise;
        }
        claimRecord.workspace_revision_start = bound.workspace.workspace_revision;
        core.observe({
          source: 'runtime', kind: 'execution_assigned', visibility: 'operator',
          taskId: claim.task.task_id, executionId: claim.execution.execution_id,
          sessionId: core.session?.sessionId ?? null, coreId: `core-${core.index}`,
          payload: {
            workspace_ref: bound.workspace.workspace_ref,
            workspace_revision: bound.workspace.workspace_revision,
            workspace_content_hash: bound.workspace.content_hash,
            state: claim.execution.state,
          },
        });
        core.observe({
          source: 'runtime', kind: 'core_state_changed', visibility: 'operator',
          taskId: claim.task.task_id, executionId: claim.execution.execution_id,
          sessionId: core.session?.sessionId ?? null, coreId: `core-${core.index}`,
          payload: { state: 'RUNNING', reason: 'execution_bound' },
        });
        // The worker session is only the claim transport. The handoff result
        // tells the current turn to stop; once that turn settles, the
        // existing cleanup path stops this transport session.
        // Runtime replaces core.session with the newly started bound session,
        // so checking core.session for equality here is too late. The claim
        // transport must always stop after a successful handoff before the
        // model can issue another claim or a claimed-only call.
        if (workerSession !== core.session) await Promise.resolve(workerSession.stop?.()).catch(() => undefined);
      },
      onClaimAccepted: async () => {
      },
      onSubmitCandidate: async ({ payload }) => {
        // Candidate checking is synchronous tool work. Source-level results
        // stay in the current Execution; retryable checker health failures
        // are staged by judgeCandidate and checkpointed only after the bridge
        // has flushed the tool result to the Agent.
        return (await judgeCandidate(core.stateRef, core, payload.candidate_material_id)) ?? {};
      },
      onSchedulerStatus: async (payload) => {
        if (core.stateRef) core.stateRef.schedulerStatusCount += 1;
        const cores = core.stateRef?.cores ?? [core];
        const readyTasks = taskService.listTasks({
          rootId: payload.root_id ?? core.stateRef?.rootTaskId ?? null,
          states: ['OPEN', 'RUNNING'],
          limit: payload.limit ?? 100,
          availableOnly: true,
        });
        const activeCoreCount = cores.filter((candidate) => candidate.taskId || candidate.dispatchReserved || candidate.turnInFlight).length;
        const waitingOwners = new Set(taskService.listActiveExecutions()
          .filter((execution) => execution.state === 'WAITING')
          .map((execution) => execution.owner_ref));
        return {
          core_count: cores.length,
          active_core_count: activeCoreCount,
          idle_core_count: Math.max(0, cores.length - activeCoreCount),
          waiting_core_count: waitingOwners.size,
          waiting_execution_count: taskService.listActiveExecutions().filter((execution) => execution.state === 'WAITING').length,
          ready_task_count: readyTasks.length,
          ready_task_ids: readyTasks.map((task) => task.task_id),
          ready_tasks: readyTasks,
          current_task_id: payload.task_id ?? core.taskId,
          current_execution_id: payload.execution_id ?? core.executionId,
          current_root_id: payload.root_id ?? core.stateRef?.rootTaskId ?? null,
        };
      },
      onRelease: async ({ taskId, executionId }) => {
        const releasedAt = Date.now();
        const hasTaskLineage = typeof taskId === 'string' && taskId.length > 0;
        const hasExecutionLineage = typeof executionId === 'string' && executionId.length > 0;
        if (!hasTaskLineage || !hasExecutionLineage) {
          // A duplicate release can race bound-turn cleanup with the
          // periodic terminal sweep. It releases physical capacity, but it
          // does not identify an owned Execution and must not masquerade as
          // an Execution lifecycle boundary.
          core.observe({
            source: 'runtime', kind: 'core_capacity_released', visibility: 'operator',
            taskId: null, executionId: null, sessionId: core.session?.sessionId ?? null, coreId: `core-${core.index}`,
            payload: { state: 'IDLE', reason: 'unbound_or_duplicate_release' },
          });
          core.stateRef?.requestDaemonWake?.();
          return;
        }
        const releaseLatency = core.latencyByExecution.get(executionId);
        if (releaseLatency) {
          releaseLatency.core_released_at = new Date(releasedAt).toISOString();
          if (releaseLatency.wait_requested_at) {
            releaseLatency.wait_to_core_release_ms = Math.max(0, releasedAt - Date.parse(releaseLatency.wait_requested_at));
          }
        }
        const releasedExecution = executionId ? taskService.getExecution(executionId) : null;
        const releasedState = releasedExecution?.state ?? 'RELEASED';
        const legacyWaiting = releasedState === 'WAITING' && core.stateRef?.normalFlow !== true;
        const coreProjection = legacyWaiting ? 'WAITING' : 'IDLE';
        // A claim record is created before Runtime binds its Workspace. If a
        // very short bound turn fails before the handoff callback records the
        // starting revision, retain the attempted ownership with the durable
        // revision that Runtime prepared instead of emitting a null lineage.
        const latestClaim = core.claimHistory.at(-1);
        if (latestClaim?.task_id === taskId && latestClaim.execution_id === executionId &&
          latestClaim.workspace_revision_start === null && Number.isInteger(releasedExecution?.workspace_revision)) {
          latestClaim.workspace_revision_start = releasedExecution.workspace_revision;
        }
        core.observe({
          source: 'runtime', kind: 'execution_released', visibility: 'operator',
          taskId, executionId, sessionId: core.session?.sessionId ?? null, coreId: `core-${core.index}`,
          payload: { state: releasedState },
        });
        core.observe({
          source: 'runtime', kind: 'core_state_changed', visibility: 'operator',
          taskId, executionId, sessionId: core.session?.sessionId ?? null, coreId: `core-${core.index}`,
          payload: {
            state: coreProjection,
            reason: legacyWaiting ? 'execution_waiting' : 'execution_released',
          },
        });
        core.parallelism.transition(core.index, coreProjection, {
          task_id: taskId,
          execution_id: executionId,
          reason: legacyWaiting ? releasedExecution.wait_condition?.type ?? 'request_wait' : releasedExecution?.state?.toLowerCase() ?? 'claim_released',
        });
        if (core.taskId === taskId && core.executionId === executionId) {
          core.releasedSession = core.session;
          core.waitingExecutionId = legacyWaiting ? executionId : null;
          core.taskId = null;
          core.executionId = null;
          core.claim = null;
          core.session = null;
          // Runtime has already removed and stopped the active process before
          // invoking this callback. The transport turn still owns the
          // dispatch reservation until its promise settles, so another Daemon
          // cannot start a second worker against this Core during handoff.
        }
        core.stateRef?.requestDaemonWake?.();
      },
      onWorkspaceWrite: async ({ taskId, executionId, result }) => {
        core.observe({
          source: 'workspace', kind: 'workspace_revision_saved', visibility: 'operator',
          taskId, executionId, coreId: `core-${core.index}`,
          payload: {
            workspace_ref: result.workspace?.workspace_ref ?? taskService.getExecution(executionId)?.workspace_ref ?? null,
            workspace_revision: result.workspace?.workspace_revision ?? null,
            workspace_content_hash: result.workspace?.content_hash ?? null,
            path: result.file?.path ?? null,
            file_content_hash: result.file?.content_hash ?? null,
            changed_files: result.diff?.changed_files?.map((file) => ({ path: file.path, status: file.status })) ?? [],
          },
        });
        core.workspaceWrites.push({
          task_id: taskId,
          execution_id: executionId,
          path: result.file?.path ?? null,
          file_content_hash: result.file?.content_hash ?? null,
          workspace_revision: result.workspace?.workspace_revision ?? null,
          workspace_content_hash: result.workspace?.content_hash ?? null,
          changed_files: result.diff?.changed_files?.map((file) => ({ path: file.path, status: file.status })) ?? [],
        });
        core.parallelism.recordWorkUnit({
          task_id: taskId,
          execution_id: executionId,
          core: core.index,
          progress_kind: 'workspace_revision',
        });
      },
      onWorkUnit: async ({ operation, taskId, executionId, payload, result }) => {
        if (['publish_material', 'accept_task', 'request_rework', 'submit_candidate'].includes(operation)) {
          core.stateRef?.requestDaemonWake?.();
        }
        if (STRUCTURE_OPERATIONS.has(operation)) {
          const structureResult = result && typeof result === 'object' ? result : {};
          const operationEvidence = {
            operation,
            task_id: taskId,
            execution_id: executionId,
            group_id: structureResult.group?.group_id ?? payload?.group_id ?? null,
            task_ids: [
              ...(Array.isArray(structureResult.tasks) ? structureResult.tasks.map((task) => task?.task_id) : []),
              structureResult.task?.task_id,
              structureResult.rework_link?.rework_task_id,
            ].filter(Boolean),
            dependency_id: structureResult.change?.dependency_id ?? null,
          };
          core.structureOperations.push(operationEvidence);
          core.observe({
            source: 'task-service', kind: 'semantic_structure_operation', visibility: 'operator',
            taskId, executionId, coreId: `core-${core.index}`,
            payload: operationEvidence,
          });
          core.parallelism.recordWorkUnit({
            task_id: taskId,
            execution_id: executionId,
            core: core.index,
            progress_kind: 'semantic_structure',
          });
          core.stateRef?.requestDaemonWake?.();
        } else if (operation === 'read_materials') {
          const materialsRead = Array.isArray(result) ? result : [];
          const materialRead = {
            read_at: new Date().toISOString(),
            reader_task_id: taskId,
            reader_execution_id: executionId,
            material_ids: materialsRead.map((material) => material.material_id).filter(Boolean).slice(0, 100),
            source_task_ids: [...new Set(materialsRead.map((material) => material.source_task).filter(Boolean))].slice(0, 100),
          };
          core.materialReads.push(materialRead);
          // Reading is intentionally separate from durable consumption. Only
          // identifiers and source Task IDs are recorded; Material contents
          // never enter the observation payload.
          core.observe({
            source: 'context-service', kind: 'material_read', visibility: 'operator',
            taskId, executionId, coreId: `core-${core.index}`,
            payload: {
              material_ids: materialRead.material_ids,
              source_task_ids: materialRead.source_task_ids,
              count: materialRead.material_ids.length,
            },
          });
        } else if (operation === 'consume_materials') {
          const consumedIds = Array.isArray(result?.material_ids)
            ? result.material_ids.filter((id) => typeof id === 'string').slice(0, 100)
            : Array.isArray(payload?.material_ids)
              ? payload.material_ids.filter((id) => typeof id === 'string').slice(0, 100)
              : [];
          const consumption = {
            consumed_at: new Date().toISOString(),
            reader_task_id: taskId,
            reader_execution_id: executionId,
            material_ids: consumedIds,
            action: typeof result?.action === 'string' ? result.action : payload?.action ?? null,
            action_ref: typeof result?.action_ref === 'string' ? result.action_ref : payload?.action_ref ?? null,
          };
          core.materialConsumptions.push(consumption);
          core.observe({
            source: 'context-service', kind: 'material_consumed', visibility: 'operator',
            taskId, executionId, coreId: `core-${core.index}`,
            payload: {
              material_ids: consumedIds,
              action: consumption.action,
              action_ref: consumption.action_ref,
              count: consumedIds.length,
              durable: true,
            },
          });
          core.parallelism.recordWorkUnit({
            task_id: taskId,
            execution_id: executionId,
            core: core.index,
            progress_kind: 'material_consumption',
          });
        } else if (operation === 'create_child_task') {
          const child = result?.task ?? result;
          core.parallelism.recordWorkUnit({
            task_id: child?.task_id ?? taskId,
            execution_id: executionId,
            core: core.index,
            progress_kind: 'child_task',
          });
          core.stateRef?.requestDaemonWake?.();
        } else if (operation === 'publish_material') {
          const published = result?.material ?? result ?? {};
          core.observe({
            source: 'context-service', kind: 'material_published', visibility: 'operator',
            taskId, executionId, coreId: `core-${core.index}`,
            payload: {
              material_id: published.material_id ?? null,
              kind: published.kind ?? payload?.kind ?? null,
              scope: published.scope ?? payload?.scope ?? null,
              source_task: published.source_task ?? taskId,
              source_execution: published.source_execution ?? executionId,
              consumed_material_ids: Array.isArray(published.provenance?.consumed_material_ids)
                ? published.provenance.consumed_material_ids.filter((id) => typeof id === 'string').slice(0, 100)
                : [],
              publish_reason: payload?.scope === 'judge_feedback' ? 'judge_feedback' : null,
            },
          });
          core.parallelism.recordWorkUnit({
            task_id: taskId,
            execution_id: executionId,
            core: core.index,
            progress_kind: 'material',
          });
        } else if (operation === 'accept_task' || operation === 'request_rework') {
          const reviewed = result?.task ?? result?.target_task ?? result ?? {};
          core.observe({
            source: 'task-service', kind: 'task_review', visibility: 'operator',
            taskId, executionId, coreId: `core-${core.index}`,
            payload: {
              decision: operation === 'accept_task' ? 'accept' : 'request_rework',
              target_task_id: payload?.target_task_id ?? reviewed.task_id ?? null,
            },
          });
          core.parallelism.recordWorkUnit({
            task_id: payload?.target_task_id ?? taskId,
            execution_id: executionId,
            core: core.index,
            progress_kind: 'parent_review',
          });
        } else if (operation === 'submit_candidate') {
          const check = result?.check_result ?? result?.checkResult ?? {};
          core.observe({
            source: 'judge-service', kind: 'candidate_submitted', visibility: 'operator',
            taskId, executionId, coreId: `core-${core.index}`,
            payload: {
              candidate_material_id: payload?.candidate_material_id ?? result?.candidate_material_id ?? null,
              check_result_id: check.check_result_id ?? result?.check_result_id ?? null,
              verdict: check.verdict ?? result?.verdict ?? null,
            },
          });
          core.parallelism.recordWorkUnit({
            task_id: taskId,
            execution_id: executionId,
            core: core.index,
            progress_kind: 'candidate_submission',
          });
        } else if (operation === 'request_wait') {
          const waitLatency = core.latencyByExecution.get(executionId);
          if (waitLatency && !waitLatency.wait_requested_at) {
            waitLatency.wait_requested_at = new Date(Date.now()).toISOString();
          }
          core.parallelism.recordWorkUnit({
            task_id: taskId,
            execution_id: executionId,
            core: core.index,
            progress_kind: 'coordination',
          });
        }
      },
      onError: async ({ operation, operationId, error }) => {
        core.toolErrors.push({
          operation,
          code: error.code ?? error.name,
          message_class: safeDiagnostic(error.message) ?? error.code ?? 'tool_error',
          // A Service contract error is feedback for the Agent to correct and
          // retry. It is not a protocol violation by itself. Multiple
          // unbound slots may also observe the same OPEN Task before one
          // claim commits; that scheduling contention is recoverable too.
          recoverable: error.code === 'INVALID_CONTRACT' || (error.code === 'CONFLICT' && operation === 'claim'),
          protocol: false,
        });
        if (error.code === 'CONFLICT' && operation === 'claim') {
          core.parallelism.recordClaimConflict(operationId ? `bridge:${operationId}` : null);
        }
      },
      logger: new DurableEventLog(join(logRoot, 'bridge', `core-${index}.ndjson`), { scope: `bridge:core-${index}` }),
    });
    core.bridge = bridge;
    cores.push(core);
    }
    await Promise.all(cores.map(async (core) => {
      Object.assign(core.childEnv, await core.bridge.start());
    }));
  } catch (error) {
    for (const core of cores.reverse()) {
      await Promise.resolve(core.session?.stop?.()).catch(() => undefined);
      await core.runtime.shutdown({ terminalState: 'FAILED' }).catch(() => undefined);
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
    observationStore,
    taskService,
    contextService,
    router,
    capabilityRegistry,
    allowedAgentToolNames,
    judgeService,
    cores,
    solvedAt: null,
    solvedBy: null,
    stopOnSolved: options.stopOnSolved === true,
    cleanupElapsedMs: null,
    heartbeatCount: 0,
    heartbeatErrorCount: 0,
    watchdogSweepCount: 0,
    watchdogRecoveryCount: 0,
    watchdogErrorCount: 0,
    executionTimeoutSweepCount: 0,
    executionTimeoutErrorCount: 0,
    schedulerStatusCount: 0,
    schedulerEvents: [],
    daemonEvents: [],
    daemons: [],
    daemonRuns: [],
    daemonAbortController: null,
    unsubscribeTaskEvents: null,
    controllerEvents: [],
    controller: null,
    readyObservedAt: new Map(),
    waitEligibilityAt: new Map(),
    resourcesAtStart: resourceSnapshot(),
    repositoryCommit: options.repositoryCommit ?? null,
    repositoryWorktreeDirty: options.repositoryWorktreeDirty ?? null,
    parallelism,
    parallelMode: selectedParallelMode,
    normalFlow,
    readinessSamples: [],
  };
}

export async function runBenchmarkProject(problem, config, options = {}) {
  const state = await createProjectState(problem, config, options);
  for (const core of state.cores) core.stateRef = state;
  state.controller = new TaskController({
    taskService: state.taskService,
    shortlistLimit: options.controllerShortlistLimit ?? 16,
    // The benchmark loop is already the bounded repair sweep. Keeping a
    // second five-second Controller timer would duplicate reconciliations and
    // wake attempts while the durable Task event path is quiet.
    sweepIntervalMs: options.controllerSweepIntervalMs ?? 0,
    listDaemons: () => state.cores.map((core) => core.daemon?.snapshot?.() ?? {
      core_id: `core-${core.index}`,
      state: core.taskId ? 'RUNNING' : (core.turnInFlight || core.dispatchReserved ? 'SELECTING' : 'IDLE'),
      healthy: !core.stopping,
    }),
    signalIdleDaemon: (_daemon, payload) => {
      // This callback runs inside a Controller reconciliation pass.  The
      // general wake helper also asks the Controller to reconcile, which would
      // queue another pass from this callback and self-trigger on an OPEN
      // Task. Wake the selected Daemon directly; durable Task events and the
      // periodic sweep remain the Controller re-entry paths.
      const reason = payload.reason ?? 'controller_signal';
      state.daemonWakeRequested = true;
      resolveDaemonWake?.();
      const target = state.daemons?.find((daemon) => daemon.coreId === payload.core_id);
      target?.notify?.(reason);
    },
    requestDaemonRecovery: async (daemon, payload) => {
      const core = state.cores.find((candidate) => `core-${candidate.index}` === payload.core_id);
      if (core && !core.stopping) await core.runtime.restart().catch(() => undefined);
      state.controllerEvents.push({ kind: 'controller_daemon_recovery_requested', core_id: payload.core_id, reason: payload.reason ?? null, timestamp: Date.now() });
    },
    onEvent: (event) => {
      const sanitized = {
        kind: event.kind,
        core_id: event.core_id ?? null,
        task_id: event.task_id ?? null,
        reason: event.reason ?? null,
        block_reason: event.block_reason ?? null,
        claimable_count: event.claimable_count ?? null,
        blocked_count: event.blocked_count ?? null,
        healthy_daemon_count: event.healthy_daemon_count ?? null,
        idle_daemon_count: event.idle_daemon_count ?? null,
        signaled_daemon_count: event.signaled_daemon_count ?? null,
        recovery_requested_count: event.recovery_requested_count ?? null,
        repaired_task_count: event.repaired_task_count ?? null,
        claim_count: event.claim_count ?? null,
        timestamp: event.timestamp ?? Date.now(),
      };
      state.controllerEvents.push(sanitized);
      state.observationStore.append({ experimentId: state.runId, source: 'task-controller', kind: sanitized.kind, taskId: sanitized.task_id, coreId: sanitized.core_id, visibility: 'operator', payload: sanitized });
    },
  });
  state.controller.start();
  let resolveDaemonWake;
  let daemonWake = new Promise((resolve) => { resolveDaemonWake = resolve; });
  state.daemonWakeRequested = false;
  const startedAt = Date.now();
  state.parallelism.start(startedAt);
  recordReadinessSnapshot(state, startedAt);
  const durationMs = options.timeboxMs ?? 60 * 60_000;
  const deadline = startedAt + durationMs;
  const turnTimeoutMs = options.turnTimeoutMs ?? 9 * 60_000;
  // CoreDaemon waits for the whole Runtime Execution to release after a
  // successful claim. Keep that ownership deadline at least as long as the
  // durable Runtime deadline; a turn timeout is only the per-prompt bound.
  const executionTimeoutMs = options.executionTimeoutMs ?? 60 * 60_000;
  const basePrompt = (core) => core.taskId
      ? `${BOUND_AGENT_PROMPT}\nThis is a follow-up turn for the current bound Execution. Continue from the current Workspace revision and make a concrete verified contribution; a read-only turn is not complete. Read new Materials and Judge feedback before refining, publishing, submitting, accepting, requesting rework, or blocking on a typed dependency.`
      : GENERIC_AGENT_PROMPT;
  state.daemonEvents = state.daemonEvents ?? [];
  state.daemons = state.cores.map((core) => {
    const daemon = new CoreDaemon({
      coreId: `core-${core.index}`,
      shortlistLimit: options.controllerShortlistLimit ?? 16,
      maxSelectionAttempts: options.maxStartupAttempts ?? 3,
      maxClaimRescans: options.maxClaimRescans ?? 1,
      // Controller/task events wake an idle Daemon immediately.  Keep the
      // fallback long enough to be a repair path rather than a 10Hz empty
      // queue poll when an event source is quiet or unavailable.
      idleBackoffMs: options.daemonIdleBackoffMs ?? 5_000,
      taskService: state.taskService,
      listClaimableTasks: () => state.taskService.listClaimableTasks({
        rootId: state.rootTaskId,
        limit: options.controllerShortlistLimit ?? 16,
      }),
      selectTask: ({ candidates, prompt }) => selectTaskWithAgent(core, candidates, prompt),
      claimTask: async (selectedTaskId, context) => {
        // The Selection Agent may already have claimed the Task. Reuse that
        // durable result rather than creating a second Execution.
        if (core.selectionClaim?.task?.task_id === selectedTaskId) {
          return core.selectionClaim;
        }
        const selectedTask = state.taskService.getTask(selectedTaskId);
        if (!selectedTask) {
          core.turnInFlight = false;
          core.dispatchReserved = false;
          core.nextTurnAt = Date.now();
          throw new Error(`selected Task disappeared: ${selectedTaskId}`);
        }
        try {
          return state.taskService.claimTask(selectedTaskId, {
            ...context,
            owner_ref: core.actorRef,
            core_id: `core-${core.index}`,
            agent_prompt: selectedTask.task_instructions ?? BOUND_AGENT_PROMPT,
            workspace_mode: 'resume',
          });
        } catch (error) {
          // A lost race or admission rejection must release the provisional
          // Core reservation before the Daemon returns to its bounded idle loop.
          core.turnInFlight = false;
          core.dispatchReserved = false;
          core.nextTurnAt = Date.now();
          throw error;
        }
      },
      runtime: core.runtime,
      runExecution: async (claim) => {
        if (core.selectionClaim?.execution?.execution_id === claim.execution.execution_id) {
          return { execution: state.taskService.getExecution(claim.execution.execution_id) };
        }
        try {
          await core.bridge.bindClaim(claim);
          return { execution: state.taskService.getExecution(claim.execution.execution_id) };
        } catch (error) {
          // ServicesBridge invokes its release hook for a failed bind, but the
          // Core's provisional selection reservation still belongs to this
          // failed handoff. Clear it before CoreDaemon rescan/backoff.
          core.turnInFlight = false;
          core.dispatchReserved = false;
          core.nextTurnAt = Date.now();
          throw error;
        }
      },
      handoffTimeoutMs: options.handoffTimeoutMs ?? Math.max(executionTimeoutMs, turnTimeoutMs * 2),
      releaseExecution: async (execution, { error } = {}) => {
        const errorText = `${error?.code ?? ''} ${error?.message ?? ''}`;
        const result = await core.runtime.fenceExecution(execution.execution_id, {
          reason: core.stopping
            ? 'benchmark_deadline_cleanup'
            : /handoff deadline|did not release/i.test(errorText)
            ? 'handoff_timeout'
            : 'runtime_handoff_failed',
        });
        if (core.executionId === execution.execution_id) await core.bridge.releaseClaim({ result });
        return result;
      },
      onEvent: (event) => {
        const sanitized = {
          kind: event.kind,
          core_id: event.core_id ?? `core-${core.index}`,
          task_id: event.task_id ?? null,
          execution_id: event.execution_id ?? null,
          rescan: event.rescan ?? null,
          state: event.state ?? null,
          execution_state: event.execution_state ?? null,
          changed: event.changed ?? null,
          reason: event.reason ?? null,
          candidate_count: event.candidate_count ?? null,
          task_ids: event.task_ids ?? null,
          timestamp: event.timestamp ?? Date.now(),
        };
        state.daemonEvents.push(sanitized);
        if (sanitized.kind === 'daemon_claim_conflict') {
          const conflictKey = [
            sanitized.core_id,
            sanitized.task_id,
            sanitized.reason,
            sanitized.rescan,
            sanitized.timestamp,
          ].join(':');
          state.parallelism.recordClaimConflict(`daemon:${conflictKey}`);
        }
        state.observationStore.append({
          experimentId: state.runId,
          source: 'core-daemon',
          kind: sanitized.kind,
          taskId: sanitized.task_id,
          executionId: sanitized.execution_id,
          coreId: sanitized.core_id,
          visibility: 'operator',
          payload: sanitized,
        });
        if (sanitized.kind === 'daemon_state_changed' && sanitized.changed === true && sanitized.state === 'IDLE' &&
          ['execution_released', 'runtime_failed', 'selection_failed', 'selection_invalid', 'claim_conflict', 'claim_failed', 'claim_invalid'].includes(sanitized.reason)) {
          // The release event can arrive while CoreDaemon is still inside its
          // handoff. Wake this Daemon once it has actually returned to IDLE,
          // then reconcile for durable projections. The direct wake avoids a
          // same-signature Controller signal being incorrectly deduplicated
          // after a fast handoff that the Controller never observed as RUNNING.
          queueMicrotask(() => {
            daemon.notify('daemon_idle');
            void state.controller?.notify('daemon_idle').catch(() => undefined);
          });
        }
      },
    });
    core.daemon = daemon;
    return daemon;
  });
  state.requestDaemonWake = (reason = 'event') => {
    state.daemonWakeRequested = true;
    resolveDaemonWake();
    void state.controller.notify(reason).catch(() => undefined);
  };
  state.unsubscribeTaskEvents = state.taskService.subscribeTaskEvents((event) => {
    // Task Service emits only after its mutation transaction commits. This is
    // the low-latency path; the Controller's periodic sweep remains the
    // repair path for missed notifications or a restarted process.
    state.requestDaemonWake(event?.kind ?? 'task_event');
  });
  // Compatibility metrics keep the old report field readable while the
  // production composition has no Scheduler instance or Scheduler decision
  // maker. Every value is derived from CoreDaemon lifecycle counters.
  state.scheduler = { snapshot: () => ({
    ready_count: state.taskService.listClaimableTasks({ rootId: state.rootTaskId, limit: 100 }).length,
    dispatch_count: state.daemons.reduce((count, daemon) => count + daemon.snapshot().claim_count, 0),
    startup_attempt_count: state.cores.reduce((count, candidate) => count + (candidate.sessionStartAttempts ?? 0), 0),
    startup_failure_count: state.cores.reduce((count, candidate) => count + (candidate.sessionStartFailures ?? 0), 0),
    bounded_startup_exhausted_count: state.daemons.filter((daemon) => daemon.snapshot().selection_exhausted).length,
    duplicate_suppression_count: 0,
    dispatch_latencies_ms: [],
    in_flight_core_ids: state.daemons.filter((daemon) => daemon.snapshot().state !== 'IDLE').map((daemon) => daemon.coreId),
    stopped: state.daemons.every((daemon) => daemon.snapshot().stopped),
  }) };
  try {
    // Demand-driven startup observes the queue before touching Pi/provider
    // capacity. A root-only queue starts one unbound session; an empty queue
    // starts none.
    await state.controller.reconcile({ reason: 'initial' });
    // Each physical Core owns one long-lived Daemon supervisor. The
    // Controller only reconciles durable readiness and wakes these loops; it
    // never performs a selection or claim itself.
    state.daemonAbortController = new AbortController();
    state.daemonRuns = state.daemons.map((daemon) => daemon.run({ signal: state.daemonAbortController.signal }));
    for (const core of state.cores) core.nextTurnAt = Date.now();
    const heartbeat = setInterval(() => {
      for (const core of state.cores) {
        const execution = state.taskService.getExecution(core.executionId);
        // Heartbeats belong to an active Runtime session. During the
        // CREATED-to-RUNNING handoff, bindAgentExecution is still performing
        // Workspace and Session startup; advancing state_version there can
        // race the startup CAS and invalidate its envelope.
        if (execution && execution.state === 'RUNNING' && core.runtime.activeProcesses.has(core.executionId)) {
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
    const watchdog = setInterval(() => {
      for (const core of state.cores) {
        if (core.watchdogPromise) continue;
        state.watchdogSweepCount += 1;
        const sweep = core.runtime.sweepWatchdog()
          .then((recovered) => {
            state.watchdogRecoveryCount += recovered.length;
            if (recovered.length > 0) state.requestDaemonWake?.();
          })
          .catch((error) => {
            state.watchdogErrorCount += 1;
            core.errors.push({ code: error.code ?? error.name, class: safeDiagnostic(error.message) ?? 'watchdog_error' });
          })
          .finally(() => {
            core.watchdogPromise = null;
          });
        core.watchdogPromise = sweep;
      }
    }, options.watchdogIntervalMs ?? 10_000);
    let executionTimeoutSweepPromise = null;
    const executionTimeoutSweep = setInterval(() => {
      if (executionTimeoutSweepPromise) return;
      const sweepTargets = state.cores
        .filter((core) => core.executionId)
        .map((core) => core.runtime.sweepExecutionTimeouts(undefined, { executionIds: [core.executionId] })
          .then((events) => ({ core, events }))
          .catch((error) => ({ core, error })));
      if (sweepTargets.length === 0) return;
      state.executionTimeoutSweepCount += 1;
      executionTimeoutSweepPromise = Promise.all(sweepTargets)
        .then((results) => {
          for (const { core, events, error } of results) {
            if (error) {
              state.executionTimeoutErrorCount += 1;
              core.errors.push({ code: error.code ?? error.name, class: safeDiagnostic(error.message) ?? 'execution_timeout_error' });
            } else if (events.length > 0) {
              state.requestDaemonWake?.();
            }
          }
        })
        .finally(() => {
          executionTimeoutSweepPromise = null;
        });
    }, options.executionTimeoutSweepMs ?? 10_000);
    try {
      while (Date.now() < deadline && (!state.stopOnSolved || state.solvedAt === null)) {
        if (!state.daemonWakeRequested) {
          await Promise.race([sleep(options.pollMs ?? 5_000), daemonWake]);
        }
        const reconcileReason = state.daemonWakeRequested ? 'event' : 'poll';
        state.daemonWakeRequested = false;
        daemonWake = new Promise((resolve) => { resolveDaemonWake = resolve; });
        const readyStartedAt = Date.now();
        const readyTasks = state.taskService.listTasks({
          rootId: state.rootTaskId,
          states: ['OPEN', 'RUNNING', 'WAITING'],
          limit: 100,
          availableOnly: true,
        });
        observeReadyTasks(state, readyTasks);
        state.parallelism.recordSchedulerPoll(Date.now() - readyStartedAt);
        state.parallelism.recordReadyWork({
          readyCount: readyTasks.length,
          idleCoreCount: state.cores.filter(isPhysicallyAvailableCore).length,
          eligibleWorkCount: observedEligibleWorkCount(state, readyTasks),
        });
        for (const core of state.cores) {
          if (state.solvedAt === null) await releaseTerminalExecution(core);
        }
        // The Controller owns reconciliation and signals each idle Daemon;
        // each long-lived Daemon owns its bounded selection/claim loop. The
        // main loop is only the periodic repair and observability sweep.
        await state.controller.reconcile({ reason: reconcileReason });
        for (const core of state.cores) {
          if (state.solvedAt !== null) break;
          if (!core.turnInFlight && !core.recoveryInFlight && Date.now() < deadline && state.solvedAt === null) {
            const bound = Boolean(core.taskId);
            if (bound) scheduleTurn(core, basePrompt(core), turnTimeoutMs);
          }
        }
      }
    } finally {
      clearInterval(heartbeat);
      clearInterval(watchdog);
      clearInterval(executionTimeoutSweep);
      await executionTimeoutSweepPromise;
      await Promise.all(state.cores.map((core) => core.watchdogPromise ?? Promise.resolve()));
    }
  } finally {
    const cleanupStartedAt = Date.now();
    state.unsubscribeTaskEvents?.();
    await state.controller?.stop?.();
    state.daemonAbortController?.abort();
    for (const daemon of state.daemons ?? []) daemon.stop();
    await Promise.all(state.daemonRuns ?? []);
    for (const core of state.cores) await stopCore(state, core);
    state.cleanupElapsedMs = Date.now() - cleanupStartedAt;
  }
  const report = projectReport(state, startedAt, deadline);
  state.observationStore.append({
    experimentId: state.runId,
    source: 'runtime',
    kind: 'experiment_finished',
    taskId: state.rootTaskId,
    payload: { solved: report.run.solved, protocol_valid: report.run.protocol_valid, made_progress: report.run.made_progress },
  });
  state.observationStore.finishExperiment(state.runId, { status: report.run.solved ? 'SUCCEEDED' : 'FINISHED' });
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
        const parallelism = new CoreParallelismTracker({ coreCount: 4, startedAt: 0 }).snapshot({ endedAt: 0 });
        const report = {
          schema_version: 1,
          protocol: {
            project_isolation: true,
            core_count: 4,
            input_policy: 'pinned formalization only; no candidate or solution input',
            tool_policy: 'registered swarmenv_* Service tools; Pi built-in tools, shell, web, and external context are disabled; generic service calls are rejected',
            cheating_policy: 'placeholder or non-SwarmEnv tool event invalidates the project',
          },
          parallelism,
          project: { problem_id: problems[index].id, source_hash: problems[index].source_hash ?? null },
          run: {
            protocol_valid: false,
            made_progress: false,
            progress_evidence: { child_task_count: 0, workspace_write_count: 0, meaningful_material_count: 0, candidate_check_count: 0 },
            solved: false,
            ended_early: false,
            elapsed_ms: null,
            deadline_reached: false,
            cleanup_elapsed_ms: null,
          },
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

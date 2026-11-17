import { startIndependentServices } from '../sdk/independent-services.js';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { cpus, freemem, totalmem } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DockerBotDisk } from '../runtime/docker-bot-disk.js';
import { DockerBotNetwork } from '../runtime/docker-bot-network.js';
import { BotModelAccess, assertBenchmarkModelPair } from '../agent/bot-model-access.js';
import { OpenSandboxAgentAdapter } from '../agent/opensandbox-agent-adapter.js';
import { ContextService } from '../context/context-service.js';
import { JudgeService, normalizeJudgeMissionBudget } from '../judge/judge-service.js';
import { LeanChecker } from '../judge/lean-adapter.js';
import { Runtime } from '../runtime/runtime.js';
import { WorkspaceManager } from '../runtime/workspace-manager.js';
import { MissionWorkspace } from '../runtime/mission-workspace.js';
import { createMissionCoordination } from '../runtime/mission-coordination.js';
import { createLockedFinalTreeVerifier } from '../judge/final-tree-deployment.js';
import { requirePrivateAudit } from '../observability/private-audit-retention.js';
import { ServicesBridge } from '../agent/services-bridge.js';
import { ServicesRouter } from '../sdk/service-router.js';
import { ServicesSDK } from '../sdk/services-sdk.js';
import { TaskService, fixedExecutionInputHash } from '../task/task-service.js';
import { isSoftCloseout } from '../task/execution-budget.js';
import { verifyBenchmarkFixtureCheckout, readBenchmarkFixture, verifyBenchmarkRunFixture, assertTimedServiceComposition } from './benchmark-fixture.js';
import { makeEnvelope, stableStringify } from '../protocol/envelope.js';
import { DurableEventLog } from '../observability/durable-event-log.js';
import { ObservationStore } from '../observability/observation-store.js';
import { agentContract, buildSolverContinuationMessage, SOLVER_CONTINUATION_MESSAGE, BOT_SYSTEM_PROMPT, BOT_CONTINUATION_MESSAGE, buildBotContinuationMessage, BOT_TOOL_NAMES, buildBotStartupMessage, botServiceDirectory } from '../agent/bot-contract.js';
import { AGENT_ROLES } from '../agent/capability-profile.js';
import { createBuiltinServiceRegistry, registerUserService } from '../sdk/builtin-registry.js';
import { createHttpJsonAdapter, createInProcessAdapter } from '../sdk/service-adapter.js';
import { loadServiceBundle } from '../sdk/service-bundle.js';
import { createMathlibSearchManifest, createMathlibSearchService } from '../services/mathlib-search-service.js';
import { runtimeCapabilityList } from '../runtime/runtime-capabilities.js';
import { IdentityTaskLoop } from '../runtime/identity-task-loop.js';
import { OpenSandboxManager } from '../runtime/opensandbox-manager.js';
import { TaskController } from '../runtime/task-controller.js';
import { CoreParallelismTracker } from './parallelism.js';
import { ERROR_CODES, SwarmEnvError } from '../errors.js';

const execFileAsync = (command, args) => new Promise((resolvePromise, reject) => {
  execFile(command, args, { encoding: 'utf8' }, (error, stdout) => {
    if (error) reject(error);
    else resolvePromise(String(stdout).trim());
  });
});

const SAFE_PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

class SerialTaskCreateAdmission {
  constructor() {
    this.tail = Promise.resolve();
  }

  run(work) {
    const previous = this.tail;
    let release;
    this.tail = new Promise((resolvePromise) => { release = resolvePromise; });
    return previous.then(work).finally(() => release());
  }
}
function assertCurrentParallelConfiguration(options) {
  if (options.agentMode !== undefined && !['swarm', 'solver'].includes(options.agentMode)) throw new TypeError('Unknown agent mode');
  if (options.agentMode === 'solver') {
    if (options.cores !== 1 || !Number.isSafeInteger(options.attemptIndex) || options.attemptIndex < 1) throw new TypeError('Solver attempts require one Core and an explicit attemptIndex');
    return;
  }
  if (Object.hasOwn(options, 'parallelMode')) throw new TypeError('parallelMode has been retired; omit it to use four independent Core loops');
  if (options.cores !== undefined && options.cores !== 4) throw new TypeError('Benchmark projects require four independent Core loops');
  const stagger = options.initialBotStaggerMs ?? 0;
  if (!Number.isSafeInteger(stagger) || stagger < 0 || stagger > Math.floor(2_147_483_647 / 3)) {
    throw new TypeError('initialBotStaggerMs must be a nonnegative integer within the four-Core timer limit');
  }
}

function projectTasks(state, {
  states = ['OPEN', 'BLOCKED', 'RUNNING', 'DONE', 'CLOSED', 'CANCELED', 'WAITING', 'SATISFIED', 'FAILED', 'CANCELLED', 'REJECTED'],
  limit = 100,
  availableOnly = false,
} = {}) {
  return state.taskService.listMissionTasks({
    mission_id: state.missionId,
    states,
    limit,
    available_only: availableOnly,
  });
}

function projectEligibleTasks(state, { limit = 100 } = {}) {
  return state.taskService.listEligibleTasks({ missionId: state.missionId, limit });
}

// Flat model: one Execution may run for the whole run; the reminder lead is
// five minutes (or a tenth of a short run) before the run deadline.
function flatExecutionTimeoutMs(options) {
  return options.timeboxMs ?? 60 * 60_000;
}

function flatHandoffReminderMs(options) {
  const timeoutMs = options.executionTimeoutMs ?? options.botMaxMs ?? flatExecutionTimeoutMs(options);
  return Math.max(1, timeoutMs - Math.min(5 * 60_000, Math.floor(timeoutMs / 10)));
}

// Runtime fences a bind that fails before the Execution starts durably
// (bind_prepare_failed), so the terminal state may be FENCED rather than
// FAILED. r15: a rejected workspace_revision on task_take invalidated the
// whole run as a workspace boundary violation.
export function isPreparationFailure(execution) {
  return ['FAILED', 'FENCED'].includes(execution?.state)
    && ['task_take_bind_failed', 'startup_prepare_failed', 'bind_prepare_failed', 'startup_failed'].includes(execution.terminal_reason);
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
    return [condition.check_request_key ?? condition.request_key ?? condition.workspace_source_id].filter(Boolean);
  }
  return [];
}

function lifecycleEvents() { return []; }

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
    const materialLinks = taskMaterialLinks(state, task);
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
      const dependencies = (task.relations?.depends_on ?? []).map((dependency) => ({
        dependency_id: dependency.relation_id,
        dependency_kind: 'TASK',
        prerequisite_task_id: dependency.related_task_id,
        satisfied: !(task.blockers ?? []).some((blocker) => blocker.related_task_id === dependency.related_task_id),
      }));
      return {
        execution_id: execution.execution_id,
        task_id: execution.task_id,
        task_type: task.task_type,
        goal: task.goal,
        expected_output: task.expected_output,
        acceptance_conditions: task.acceptance_conditions ?? null,
        timebox_ms: task.timebox_ms ?? null,
        state: execution.state,
        attempt_no: execution.attempt_no,
        owner_ref: execution.owner_ref,
        core_id: execution.core_id,
        workspace_ref: execution.workspace_ref,
        workspace_revision: execution.workspace_revision,
        workspace_source_id: execution.workspace_source_id,
        terminal_reason: safeLifecycleReason(execution.terminal_reason),
        block_reason: task.state === 'BLOCKED' ? safeLifecycleReason(task.block_reason) : null,
        wait_condition_type: execution.wait_condition?.type ?? null,
        wait_dependency_ids: waitDependencyIds(execution.wait_condition),
        dependencies,
        material_links: materialLinks.map((link) => ({
          link_id: link.link_id,
          task_id: link.task_id,
          material_id: link.material_id,
          role: link.role,
          receiving_task_id: link.receiving_task_id ?? null,
          producer_task_id: link.producer_task_id ?? null,
          producer_execution_id: link.producer_execution_id ?? null,
          accepted_at: link.accepted_at ?? null,
        })),
        actions: events,
        outputs,
      };
    });
  });
}

function taskMaterialLinks(state, task) {
  return task.materials ?? state.taskService.listTaskMaterials?.(task.task_id)?.links ?? [];
}

function inputSnapshotHash(task, inputMaterialRefs) {
  return sha256(stableStringify({
    task_id: task.task_id,
    spec_hash: task.spec_hash,
    workspace: task.workspace,
    input_material_refs: inputMaterialRefs,
  }));
}

export function missionTaskEvidence(state) {
  return state.taskService.taskStatus({ mission_id: state.missionId, limit: 100,
    states: ['OPEN', 'BLOCKED', 'RUNNING', 'DONE', 'CLOSED', 'CANCELED', 'WAITING', 'SATISFIED', 'FAILED', 'CANCELLED', 'REJECTED'] });
}

export function observedEligibleWorkCount(state, readyTasks) {
  const status = state.taskService.taskStatus({ mission_id: state.missionId, limit: 1 });
  return new Set([...readyTasks.map(task => task.task_id), ...status.lanes
    .filter(lane => ['CREATED', 'RUNNING'].includes(lane.state)).map(lane => lane.task_id)]).size;
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

function required(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} is required`);
  return value;
}

function sdk(router, context) {
  return new ServicesSDK(router, context);
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
        payload: { event: event.event ?? null, event_hash: createHash('sha256').update(JSON.stringify(event)).digest('hex') },
      });
    },
  };
}

export async function loadBenchmarkConfig(configPath, { putnamBenchRoot, verifyPinnedCheckout = false } = {}) {
  const config = JSON.parse(await readFile(resolve(configPath), 'utf8'));
  required(putnamBenchRoot, 'putnamBenchRoot');
  if (!Array.isArray(config.problems) || config.problems.length !== 12) {
    throw new TypeError('benchmark config must contain exactly 12 problems');
  }
  const root = resolve(putnamBenchRoot);
  if (verifyPinnedCheckout) await verifyBenchmarkFixtureCheckout({ root, commit: config.putnambench_commit });
  const leanProjectRoot = resolve(root, 'lean4');
  const projectRoot = await readFile(join(leanProjectRoot, 'lean-toolchain'), 'utf8')
    .then(() => leanProjectRoot)
    .catch(() => root);
  const seen = new Set();
  const problems = [];
  for (const problem of config.problems) {
    if (seen.has(problem.id)) throw new TypeError(`duplicate problem id: ${problem.id}`);
    seen.add(problem.id);
    const { sourcePath, source, sourceHash } = await readBenchmarkFixture({ root, path: problem.problem_file, commit: verifyPinnedCheckout ? config.putnambench_commit : null });
    validateProblemInput(problem, source);
    problems.push({
      ...problem,
      source_path: sourcePath,
      source_hash: sourceHash,
      source,
    });
  }
  return { ...config, putnam_bench_root: root, lean_project_root: projectRoot, problems };
}

export async function runTurn(core, prompt, timeoutMs) {
  if (core.turnInFlight) return;
  core.turnInFlight = true;
  const session = core.session;
  const boundExecutionId = core.executionId;
  const countsAsAgentTurn = Boolean(core.taskId && boundExecutionId);
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
    if (core.stopping || core.session !== session || core.executionId !== boundExecutionId) return;
    if (countsAsAgentTurn) {
      const execution = core.runtime.taskService.getExecution(boundExecutionId);
      if (execution?.state !== 'RUNNING' || (core.runtime.taskService.isMissionStopped(core.runtime.taskService.getTask(execution.task_id)?.mission_id) && !isSoftCloseout(execution))) return;
      const bot = core.runtime.taskService.getBot(execution.owner_ref);
      if (bot && (bot.state !== 'ACTIVE' || bot.execution_id !== boundExecutionId)) return;
      core.runtime.taskService.assertBotDeadline(execution.owner_ref);
      prompt = core.startConfig?.options.agentMode === 'solver' ? buildSolverContinuationMessage(execution, prompt) : buildBotContinuationMessage(execution, { ordinary: prompt });
    }
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
    // A discovery turn can synchronously take a Task and hand off to a new
    // bound session. Do not let the discovery transport's finally block clear
    // the bound session's in-flight flag or start an overlapping follow-up.
    const handedOff = core.session !== session && Boolean(
      core.taskId && core.executionId && core.runtime.hasActiveExecution(core.executionId),
    );
    if (!handedOff) {
      // A retired take may enter onTake before Runtime rejects the permanent
      // Core binding (for example, two selectors race for a resumable wait).
      // Clear that provisional local ownership or the selection transport
      // would keep this Core permanently marked turn-in-flight.
      if (core.session !== session && !core.runtime.hasActiveExecution(core.executionId ?? '')) {
        core.taskId = null;
        core.executionId = null;
        core.take = null;
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
  if (core.stateRef?.startupFailure || core.turnInFlight || core.boundTurnPromise || Date.now() < core.nextTurnAt) return false;
  core.turnStartedAt = Date.now();
  core.turnPromise = runTurn(core, prompt, timeoutMs);
  // Install a rejection handler at creation time. Cleanup may stop the Pi
  // process before the main loop gets a chance to await this turn; an already
  // handled promise must not surface a late PROCESS_EXITED as an unhandled
  // rejection during report finalization.
  void core.turnPromise.catch(() => undefined);
  return true;
}

async function startAgentSession(core) {
  core.childEnv.SWARMENV_AGENT_ROLE = AGENT_ROLES.BOUND;
  core.sessionNumber += 1;
  const suffix = `bot-session-${core.sessionNumber}`;
  const { bot, session } = await core.runtime.startBot({
    missionId: core.stateRef.mission.mission_id,
    coreId: `core-${core.index}`,
    selectionTimeoutMs: core.startConfig.options.selectionTimeoutMs ?? Math.min(300_000, core.startConfig.options.botMaxMs ?? flatExecutionTimeoutMs(core.startConfig.options)),
    maxLifetimeMs: core.startConfig.options.botMaxMs ?? flatExecutionTimeoutMs(core.startConfig.options),
    readyTimeoutMs: core.startConfig.options.turnTimeoutMs ?? 30_000,
    startSession: async ({ bot: startingBot, signal, assertStartupAllowed, onSandboxCreateDispatch, onSandboxCreateRejected, onSandboxCreated }) => {
      core.actorRef = startingBot.bot_id;
      Object.assign(core.childEnv, core.bridge.startBotIdentity(startingBot.bot_id));
      return core.adapter.start({
        executionId: startingBot.resource_key,
        bot: startingBot,
        signal,
        assertStartupAllowed,
        onSandboxCreated,
        onSandboxCreateDispatch,
        onSandboxCreateRejected,
        sessionDir: join(core.coreDir, '.swarm', suffix),
        cwd: core.coreDir,
        logger: new DurableEventLog(join(core.startConfig.logRoot, 'agents', `core-${core.index}.ndjson`), { raw: true, scope: startingBot.bot_id }),
        observation: core.observe,
        observationContext: { coreId: `core-${core.index}`, taskId: null, executionId: null },
      });
    },
  });
  if (core.stopping) {
    core.runtime.taskService.requestBotStop(bot.bot_id, 'core-stopped');
    await core.runtime.releaseBot(bot.bot_id);
    throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Core stopped during Bot startup');
  }
  core.botId = bot.bot_id;
  core.botDiscoveryTurns = 0;
  session.identitySession = true;
  core.session = session;
  core.sessionHistory.push(session);
  core.versionManifest = session.manifest ?? null;
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
  session.identitySession = true;
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
      core.stateRef?.requestIdentityWake?.();
    }
  })();
}

export async function ensureAgentSession(core) {
  try {
    if (core.releasedSession) {
      await core.releasedSession.stop?.();
      if (core.releasedSession.closed === false) throw new Error('Released Bot stop is unconfirmed');
      core.releasedSession = null;
    }
    if (core.session && (core.session.closed || core.sessionCleanupPending)) {
      await core.session.stop?.();
      if (core.session.closed === false) throw new Error('Bot stop is unconfirmed');
      core.session = null;
      core.sessionCleanupPending = false;
    }
  } catch (error) {
    core.errors.push({ code: error?.code ?? 'SESSION_CLEANUP_PENDING', class: 'session_cleanup_pending' });
    return false;
  }
  // A failed retired take can clear the bridge binding after the transport
  // Session has already been replaced. Repair the stale local occupancy when
  // no Session, Task, Execution, recovery, or handoff promise remains.
  if (core.turnInFlight && !core.session && !core.taskId && !core.executionId && !core.boundTurnPromise && !core.recoveryInFlight) {
    core.turnInFlight = false;
  }
  if (!discoveryOpen(core) || core.turnInFlight) return false;
  if (core.session) return core.session;
  if (core.sessionStartPromise) return false;
  core.sessionStartAttempts = (core.sessionStartAttempts ?? 0) + 1;
  try {
    core.sessionStartPromise = startAgentSession(core);
    await core.sessionStartPromise;
    return core.session ?? null;
  } catch (error) {
    core.sessionStartFailures = (core.sessionStartFailures ?? 0) + 1;
    const state = core.stateRef;
    const startupContractRejected = core.startConfig.options.requireThirdPartySandbox === true &&
      error.code === ERROR_CODES.BOT_STARTUP_CONTRACT;
    if (startupContractRejected && discoveryOpen(core)) {
      state.startupFailure = { core_id: `core-${core.index}`, code: error.code, class: 'bot_startup_contract' };
      state.requestIdentityWake?.('bot_startup_contract');
    }
    if (!core.stopping) core.errors.push({
      code: error.code ?? error.name,
      class: startupContractRejected ? 'bot_startup_contract' : safeDiagnostic(error.message) ?? 'agent_session_error',
    });
    core.sessionCleanupPending = Boolean(core.session);
    try {
      await core.session?.stop?.();
      if (core.session?.closed === false) throw new Error('Bot stop is unconfirmed');
      core.session = null;
      core.sessionCleanupPending = false;
    } catch (cleanupError) {
      core.errors.push({ code: cleanupError?.code ?? 'SESSION_CLEANUP_PENDING', class: 'startup_cleanup_pending' });
    }
    core.turnInFlight = false;
    core.initialTurnPromise = null;
    core.nextTurnAt = Date.now();
    core.dispatchReserved = false;
    return false;
  } finally {
    core.sessionStartPromise = null;
  }
}

function selectionView(candidates) {
  return candidates.map((candidate) => ({
    task_id: candidate.task_id,
    mission_id: candidate.mission_id ?? null,
    summary: candidate.summary ?? null,
    relations: candidate.relations ?? null,
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

function discoveryOpen(core) {
  const state = core.stateRef;
  return !core.stopping && !state?.stopping && !state?.startupFailure && !state?.signal?.aborted &&
    Date.now() < (state?.runDeadlineAt ?? Infinity) &&
    !(state?.mission && core.runtime.taskService.isMissionStopped(state.mission.mission_id));
}

/**
 * Run one bounded task-discovery turn on the reusable Core identity.  The
 * identity itself chooses a Task and calls the canonical `task_take` seam;
 * there is deliberately no separate old selection transport/session in production.
 * IdentityTaskLoop still owns the durable handoff bookkeeping, but it receives the
 * already-created take from this same identity and never asks another
 * process to choose on its behalf.
 */
async function takeSolverTask(core) {
  if (!discoveryOpen(core) || core.taskId || core.executionId || core.solverAttemptStarted) return { take_deferred: true };
  // One start per predetermined sample; a failed trajectory must not become a fresh sample.
  core.solverAttemptStarted = true;
  const session = await ensureAgentSession(core);
  if (!session || !discoveryOpen(core)) return { no_work: true };
  const taskId = core.stateRef.initialTaskIds[0];
  const take = await core.bridge.controlCall({ operation: 'task_take', operation_id: `solver-take:${core.botId}`, payload: { task_id: taskId } });
  const prompt = `${SOLVER_CONTINUATION_MESSAGE}\n${JSON.stringify({ problem: core.stateRef.problem.id, target_path: core.stateRef.problem.problem_file, project_path: '/workspace/project', deadline: new Date(core.stateRef.runDeadlineAt).toISOString() })}`;
  scheduleTurn(core, prompt, core.startConfig.options.turnTimeoutMs ?? 540_000);
  return take;
}

function continuation(core) {
  return core.startConfig?.options.agentMode === 'solver' ? SOLVER_CONTINUATION_MESSAGE : buildBotContinuationMessage(core.runtime.taskService.getExecution(core.executionId));
}

export async function takeTaskWithAgent(core, candidates) {
  if (core.startConfig?.options.agentMode === 'solver') return takeSolverTask(core);
  // An active Execution owns the identity. Never open a parallel discovery
  // turn or ask the model to take a second responsibility.
  if (!discoveryOpen(core) || core.taskId || core.executionId) return { take_deferred: true };
  core.bridge.beginTakeAttempt?.();
  const session = await ensureAgentSession(core);
  if (!discoveryOpen(core)) return { take_deferred: true };
  if (!session) return core.turnInFlight ? { take_deferred: true } : { take_failed: true, error: { code: 'SERVICE_UNAVAILABLE', message: 'Bot session could not start' } };
  const discoveryBotId = core.botId;
  const exitedWithoutWork = () => {
    const bot = core.runtime.taskService.getBot(discoveryBotId);
    return bot && !bot.execution_id && ['CLOSING', 'CLOSED'].includes(bot.state) && ['no-work', 'selection-budget', 'bot-lifetime-budget'].includes(bot.exit_reason);
  };
  const sequence = session.rpcRecords?.length ?? 0;
  core.takeResult = null;
  core.takeActive = true;
  core.dispatchReserved = true;
  core.turnInFlight = true;
  core.turnStartedAt = Date.now();
  core.parallelism.beginAgentTurn(core.index, {
    task_id: null,
    execution_id: null,
    reason: 'task_discovery_and_take',
  }, core.turnStartedAt);
  core.agentTurnSession = session;
  core.takeTurnCount = (core.takeTurnCount ?? 0) + 1;
  try {
    const workspace = await core.runtime.missionWorkspace.get({ workspaceId: core.runtime.missionWorkspaceId });
    const bot = core.runtime.taskService.getBot(discoveryBotId);
    if (!discoveryOpen(core) || core.session !== session || core.botId !== discoveryBotId || session.closed || bot?.state !== 'UNBOUND') return { take_deferred: true };
    core.runtime.taskService.assertBotDeadline(discoveryBotId);
    if (Date.now() >= Date.parse(bot.selection_deadline)) return { take_deferred: true };
    const message = buildBotStartupMessage({
      mission: core.runtime.taskService.getMission(bot.mission_id), bot, workspace, sessionId: session.sessionId,
      budget: { run_deadline: core.runtime.runDeadlineAt == null ? null : new Date(core.runtime.runDeadlineAt).toISOString(),
        execution_max_ms: core.runtime.executionTimeoutMs, soft_closeout_lead_ms: core.runtime.executionTimeoutMs - core.runtime.handoffReminderMs,
        supervisor_max_take_attempts: core.startConfig.options.maxStartupAttempts ?? 3,
        compaction_max: core.runtime.maxCompactions, context_closeout_fraction: core.runtime.handoffWindowRatio },
      services: botServiceDirectory(core.bridge.getCapabilityProfile()),
      project: { project_id: core.stateRef.problem.id, problem_file: core.stateRef.problem.problem_file, source_hash: core.stateRef.problem.source_hash, input_policy: 'locked unsolved formalization only; no external answers or solution-derived candidates' },
      eligibleTasks: selectionView(candidates), firstTurn: core.botDiscoveryTurns === 0,
    });
    core.runtime.recordBotWorkspacePreview({ botId: discoveryBotId, session, workspace });
    core.botDiscoveryTurns += 1;
    core.observe?.({ source: 'agent', kind: 'bot_prompt_composed', visibility: 'operator',
      payload: { bot_id: bot.bot_id, prompt_sha256: createHash('sha256').update(message).digest('hex'), preview_revision: workspace.main_revision }, sessionId: session.sessionId });
    const response = await session.prompt(message, { timeoutMs: Math.min(core.startConfig.options.turnTimeoutMs ?? 30_000, 30_000) });
    if (response?.data?.disposition !== 'handled' && typeof session.waitForSettled === 'function') {
      await session.waitForSettled({ timeoutMs: Math.max(core.startConfig.options.turnTimeoutMs ?? 30_000, 180_000), afterSequence: sequence });
    }
    if (core.takeResult?.task?.task_id) return core.takeResult;
    if (exitedWithoutWork()) return { no_work: true };
    if (core.bridge.lastTakeOutcome?.attempted && !core.bridge.lastTakeOutcome.ok) {
      return { take_failed: true, error: core.bridge.lastTakeOutcome };
    }
    if (core.taskId || core.executionId) return { take_deferred: true };
    return { take_failed: true, error: { code: 'DISCOVERY_INCOMPLETE', message: 'Discovery settled without an accepted take or an explicit no-work outcome' } };
  } catch (error) {
    if (exitedWithoutWork()) return { no_work: true };
    if (core.bridge.lastTakeOutcome?.attempted && !core.bridge.lastTakeOutcome.ok) {
      return { take_failed: true, error: core.bridge.lastTakeOutcome };
    }
    if (core.taskId || core.executionId) return { take_deferred: true };
    core.sessionStartFailures = (core.sessionStartFailures ?? 0) + 1;
    if (!core.stopping) core.errors.push({ code: error.code ?? error.name, class: safeDiagnostic(error.message) ?? 'take_turn_error' });
    return { take_failed: true, error: { code: error.code ?? 'RPC_ERROR', message: error.message } };
  } finally {
    collectToolEvents(core, session.rpcRecords?.slice(sequence) ?? []);
    core.takeActive = false;
    if (core.agentTurnSession === session && !core.runtime.hasActiveExecution(core.executionId ?? '')) {
      core.parallelism.endAgentTurn(core.index, Date.now(), 'task_discovery_settled');
      core.agentTurnSession = null;
    }
    core.turns += 1;
    const duration = Date.now() - core.turnStartedAt;
    core.turnDurationsMs.push(duration);
    core.parallelism.recordTurnTime(duration);
    const handedOff = core.session !== session && Boolean(core.taskId && core.executionId);
    // Keep the Core reserved across the take and Runtime handoff. Invalid or
    // empty selections do not reserve the Core.
    const selectedTaskId = core.takeResult?.task?.task_id ?? null;
    const handoffPending = !handedOff && selectedTaskId !== null;
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
    // An empty or failed take turn does not retire the identity. Keep the
    // Session for the next wake; only explicit recovery/rotation replaces it.
    // A valid take stays reserved until Runtime finishes the handoff.

  }
}

export async function releaseTerminalExecution(core) {
  const executionId = core.executionId;
  if (!executionId) return;
  let execution = core.runtime.taskService.getExecution(executionId);
  if (!execution || !['CLOSING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED', 'FENCED', 'HANDED_OFF', 'SUPERSEDED'].includes(execution.state)) return;
  const activeWorkspace = core.runtime.activeProcesses?.get?.(executionId)?.workspace;
  const latestTake = core.latencyByExecution?.get?.(executionId);
  if (latestTake && activeWorkspace?.git_commit) latestTake.workspace_git_commit_end = activeWorkspace.git_commit;
  try {
    await core.runtime.releaseExecution(executionId);
    execution = core.runtime.taskService.getExecution(executionId);
  } catch (error) {
    core.errors.push({ code: error?.code ?? 'CLEANUP_PENDING', class: 'execution_cleanup_pending' });
    return { cleanup_pending: true, execution_id: executionId };
  }
  if (core.executionId !== executionId || core.bridge.executionId !== executionId) return;
  core.parallelism.transition(core.index, 'IDLE', {
    task_id: execution.task_id,
    execution_id: execution.execution_id,
    reason: `terminal:${execution.state.toLowerCase()}`,
  });
  await core.bridge.releaseTake({ result: { execution } });
}

export function sanitizedCheck(result, material) {
  const evidence = result.evidence ?? {};
  const processEvidence = result.process_evidence ?? {};
  const checkerProcessStatus = result.checker_process_status ?? evidence.checker_process_status ?? 'unknown';
  const resultClass = result.result_class ?? evidence.result_class ?? 'unassessed';
  const mathematicalOutcome = result.mathematical_outcome ?? evidence.mathematical_outcome ??
    (resultClass === 'PASS' ? 'PASS' : resultClass === 'source_failure' ? 'FAIL' : 'unassessed');
  return {
    workspace_source_id: material.material_id,
    material_hash: material.content_hash,
    verdict: result.verdict,
    mathematical_outcome: mathematicalOutcome,
    judge_operation_status: result.judge_operation_status ?? 'persisted',
    checker_ref: result.checker_ref ?? null,
    checker_version: result.checker_version ?? null,
    environment_ref: result.environment_ref ?? null,
    checker_process_status: checkerProcessStatus,
    checker_started: evidence.checker_started ?? result.checker_started ?? (checkerProcessStatus === 'started' || checkerProcessStatus === 'completed'),
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
      exit_code: evidence.exit_code ?? processEvidence.exit_code ?? null,
      signal: evidence.signal ?? processEvidence.signal ?? null,
      timed_out: Boolean(evidence.timed_out ?? processEvidence.timed_out),
      error_code: evidence.error_code ?? processEvidence.error_code ?? null,
    },
    check_result_id: result.check_result_id,
    diagnostic_class: evidence.forbidden_placeholder === true || result.diagnostic_code === 'forbidden_placeholder'
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

async function joinCleanup(promises) {
  const results = await Promise.allSettled(promises);
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  return results.map(result => result.value);
}

function operatorStop() {
  return Object.assign(new Error('Benchmark stopped by operator'), { code: 'BENCHMARK_OPERATOR_STOPPED' });
}

async function settleBy(promise, deadline, signal) {
  let timer, onAbort;
  try {
    const stopped = signal && new Promise(resolve => {
      onAbort = () => resolve({ status: 'aborted' });
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    return await Promise.race([
      ...(stopped ? [stopped] : []),
      Promise.resolve(promise).then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ status: 'pending' }), Math.max(0, deadline - Date.now())); }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

// This deadline bounds orchestration waits, not just individual model turns.
// The underlying operation remains tracked and joins the shutdown boundary.
export async function withinRunDeadline(state, operation, deadline) {
  if (state.signal?.aborted) throw operatorStop();
  if (Date.now() >= deadline) throw Object.assign(new Error('Benchmark execution timebox elapsed'), { code: 'BENCHMARK_TIMEBOX_EXPIRED' });
  const promise = typeof operation === 'function' ? operation() : operation;
  state.pendingRunOperations ??= new Set();
  const tracked = Promise.resolve(promise).finally(() => state.pendingRunOperations.delete(tracked));
  state.pendingRunOperations.add(tracked);
  const result = await settleBy(tracked, deadline, state.signal);
  if (result.status === 'aborted') throw operatorStop();
  if (result.status === 'rejected') throw result.reason;
  if (result.status === 'pending') {
    const error = new Error('Benchmark execution timebox elapsed');
    error.code = 'BENCHMARK_TIMEBOX_EXPIRED';
    throw error;
  }
  return result.value;
}

export async function stopCore(state, core, { cleanupGraceMs = 30_000, cleanupDeadline = Date.now() + cleanupGraceMs } = {}) {
  let cleanupFailed = false;
  const recordCleanupError = error => { cleanupFailed = true; state.cleanupErrors.push({ ...error, core_id: `core-${core.index}` }); };
  core.stopping = true;
  core.parallelism?.transition(core.index, 'STOPPING', { task_id: core.taskId ?? null,
    execution_id: core.executionId ?? null, reason: 'benchmark_cleanup' });
  const sessions = new Set([...(core.sessionHistory ?? []), core.session, core.releasedSession].filter(Boolean));
  // Start all termination paths before joining any of them. In particular a
  // Bridge client or startup wait may need Runtime shutdown in order to end.
  const jobs = [
    ['STARTUP_CLEANUP', () => joinCleanup([
      core.adapter?.cleanupPendingStarts?.({ shutdown: true }),
      // A rejected launch also settles the startup. Adapter and Runtime
      // shutdown independently confirm that any resources were removed.
      Promise.allSettled([core.sessionStartPromise]),
    ])],
    ['RUNTIME_SHUTDOWN', () => core.runtime.shutdown({ terminalState: 'FAILED',
      terminalReason: state.operatorStopped ? 'operator_stop' : 'benchmark_deadline_cleanup' })],
    ['BRIDGE_CLEANUP', () => core.bridge.stop()],
    ['SESSION_CLEANUP', () => joinCleanup([...sessions].map(async session => {
      await session.stop?.();
      if (session.closed === false) throw new Error('Bot process stop was not confirmed');
    }))],
    ['TURN_CLEANUP', () => Promise.allSettled([core.turnPromise, core.boundTurnPromise])],
    ['RUNTIME_SETTLE', () => core.runtime.waitForSettled?.()],
  ].map(([name, run]) => {
    const promise = Promise.resolve().then(run);
    return { name, promise };
  });
  core.cleanupPromise = Promise.allSettled(jobs.map(job => job.promise));
  await Promise.all(jobs.map(async ({ name, promise }) => {
    const result = await settleBy(promise, cleanupDeadline);
    if (result.status === 'pending') recordCleanupError({ code: `${name}_TIMEOUT`, class: `${name.toLowerCase()}_timeout` });
    else if (result.status === 'rejected') recordCleanupError({ code: result.reason?.code ?? `${name}_PENDING`, class: `${name.toLowerCase()}_pending` });
    else if (name === 'RUNTIME_SHUTDOWN' && (result.value.active_process_count !== 0 ||
        (result.value.cleanup_pending_session_count ?? 0) !== 0 || (result.value.cleanup_pending_bot_ids?.length ?? 0) !== 0)) {
      recordCleanupError({ code: 'RUNTIME_CLEANUP_PENDING', class: 'runtime_cleanup_pending' });
    }
  }));
  // Runtime owns the durable CLOSING/owner boundary until physical stop is
  // confirmed. A reporting timeout must never manufacture capacity release.
  if (!cleanupFailed) core.parallelism?.transition(core.index, 'IDLE', {
    task_id: core.taskId ?? null, execution_id: core.executionId ?? null, reason: 'benchmark_cleanup_complete' });
  return { complete: !cleanupFailed };
}

export async function finishSolverTask(state, core) {
  return withinRunDeadline(state, () => core.bridge.controlCall({ operation: 'task_finish', operation_id: `solver-finish:${core.executionId}`, payload: { outcome: 'done', summary: 'Fixed solution accepted by the trusted final verifier' } }), Math.min(state.runDeadlineAt, state.missionCloseoutDeadline));
}

export function beginMissionCloseout(state, submission) {
  const acceptedAt = Date.parse(submission.finished_at);
  const allowance = state.missionCloseoutMs ?? 30_000;
  if (!Number.isFinite(acceptedAt) || !Number.isFinite(allowance) || allowance <= 0) throw new TypeError('Invalid Mission closeout budget');
  if (state.missionCloseoutDeadline === undefined) {
    state.solvedAt = acceptedAt;
    state.solvedBy = state.taskService.getBot(submission.actor_ref)?.core_id ?? null;
    state.acceptedSubmissionId = submission.submission_id;
    state.missionCloseoutDeadline = Math.min(state.runDeadlineAt, acceptedAt + allowance);
    // Solver finish is host-driven after acceptance. stop() fences a live
    // Execution, so retain its loop until that genuine finish has settled.
    // Mission stop and the fixed-attempt guard already forbid new discovery.
    if (state.agentMode !== 'solver') for (const loop of state.identityLoops ?? []) loop.stop();
    state.backgroundStopPromises ??= [];
    if (state.controller) {
      const stop = Promise.resolve().then(() => state.controller.stop());
      // Observe rejection immediately, but retain the original outcome for the
      // cleanup join. A PASS callback must not lose an in-flight physical stop.
      stop.catch(() => {});
      state.backgroundStopPromises.push(stop);
    }
  }
  // The durable acceptance callback can be retried after a partial reminder
  // failure. Preserve the original deadline, skip committed reminders and
  // finish the remaining notifications before acknowledging the callback.
  for (const execution of state.taskService.listActiveExecutions()) {
    if (state.taskService.getTask(execution.task_id)?.mission_id !== state.missionId || execution.state !== 'RUNNING' || execution.handoff_reminder_sent_at) continue;
    state.taskService.recordHandoffReminder({ reminded_at: new Date(acceptedAt).toISOString() }, makeEnvelope({
      operationId: `mission-closeout:${submission.submission_id}:${execution.execution_id}`, actorRef: execution.owner_ref,
      taskId: execution.task_id, executionId: execution.execution_id, specVersion: execution.spec_version,
      stateVersion: execution.state_version, fencingVersion: execution.fencing_version,
    }));
  }
  state.requestIdentityWake?.('mission_accepted_closeout');
}

export async function stopBenchmarkRuntime(state, { cleanupGraceMs = 30_000 } = {}) {
  if (!Number.isFinite(cleanupGraceMs) || cleanupGraceMs <= 0) throw new TypeError('cleanupGraceMs must be finite and positive');
  const started = Date.now();
  const deadline = started + cleanupGraceMs;
  state.cleanupDeadline = deadline;
  state.stopping = true;
  state.unsubscribeTaskEvents?.();
  state.identityLoopAbortController?.abort();
  for (const loop of state.identityLoops ?? []) loop.stop();
  const controller = Promise.resolve().then(() => state.controller?.stop?.());
  const jobs = [
    ['CONTROLLER_STOP', controller],
    ['JUDGE_STOP', Promise.resolve().then(async () => { await state.judgeService?.waitForIdle(); await state.judgeService?.verifyCleanup?.(); })],
    ['MODEL_GATEWAY_STOP', Promise.resolve().then(() => state.modelAccess?.stop())],
    ['MISSION_STOP', Promise.resolve().then(() => state.missionId ? state.missionSubmissionStore?.stop({ missionId: state.missionId }) : state.missionSubmissionStore?.shutdown())],
    ['IDENTITY_LOOP_STOP', joinCleanup(state.identityLoopRuns ?? [])],
    ['BACKGROUND_STOP', joinCleanup([...(state.pendingRunOperations ?? []), ...(state.backgroundStopPromises ?? [])])],
    ...state.cores.map(core => [`CORE_${core.index}_STOP`, stopCore(state, core, { cleanupDeadline: deadline }), true]),
  ];
  state.cleanupPromise = Promise.allSettled(jobs.map(([, promise]) => promise))
    .then(() => Promise.allSettled(state.cores.map(core => core.cleanupPromise)));
  await Promise.all(jobs.map(async ([name, promise, alreadyBounded]) => {
    const result = alreadyBounded
      ? await promise.then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }))
      : await settleBy(promise, deadline);
    if (result.status !== 'fulfilled') state.cleanupErrors.push({ code: result.status === 'pending' ? `${name}_TIMEOUT` : result.reason?.code ?? `${name}_ERROR`, class: name.toLowerCase() });
  }));
  state.cleanupElapsedMs = Date.now() - started;
}

export function closeProjectStores(state, closeStores, options) {
  if (state.cleanupErrors.length === 0) {
    return closeStores();
  }
  const finished = state.cleanupPromise.finally(closeStores);
  finished.catch(() => {});
  options.onCleanupPending?.(finished);
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
  const tasks = projectTasks(state, { limit: 100, availableOnly: false });
  state.readinessSamples.push({
    at_ms: at,
    tasks: tasks.map((task) => {
      const blockers = task.blockers ?? [];
      const readiness = blockers.length > 0 ? 'BLOCKED'
        : task.state === 'RUNNING' ? 'RUNNING'
          : task.state === 'DONE' || task.state === 'CLOSED' || task.state === 'CANCELED' ? task.state
            : 'READY';
      return { task_id: task.task_id, readiness, missing: blockers.map((blocker) => blocker.related_task_id ?? blocker.dependency_id ?? blocker.dependency_kind) };
    }),
  });
}

export function projectReport(state, startedAt, deadline) {
  const endedAt = Date.now();
  for (const core of state.cores) {
    for (const session of core.sessionHistory) collectToolEvents(core, session.rpcRecords);
  }
  const materials = state.contextService.readMaterials({});
  const materialConsumptions = state.contextService.listMaterialConsumptions({});
  const taskEvidence = missionTaskEvidence(state);
  const taskTree = taskEvidence.tasks;
  const takeHistory = state.cores.flatMap((core) => core.takeHistory);
  const allowedTaskIds = new Set(takeHistory.map((take) => take.task_id));
  const allowedExecutionIds = new Set(takeHistory.map((take) => take.execution_id));
  const materialBoundaryViolation = materials.some((material) =>
    !allowedTaskIds.has(material.source_task) || !allowedExecutionIds.has(material.source_execution));
  const inputMaterialViolation = state.publicWorkspace.mission_id !== state.missionId || state.publicWorkspace.metadata.input_snapshot_hash !== state.inputMaterialHash;
  const allowedInputMaterialIds = new Set(materials
    .filter((material) => allowedTaskIds.has(material.source_task) && allowedExecutionIds.has(material.source_execution))
    .map((material) => material.material_id));
  const workspaceViolation = takeHistory.some((take) => {
    const execution = state.taskService.getExecution(take.execution_id);
    const task = state.taskService.getTask(take.task_id);
    const inputMaterialRefs = execution?.input_material_refs ?? [];
    if (!execution || !task?.workspace) return true;
    if (Array.isArray(execution.workspace_input?.material_inputs)) {
      return execution.input_snapshot_hash !== fixedExecutionInputHash(task, execution.workspace_input);
    }
    return inputMaterialRefs.some((materialId) => !allowedInputMaterialIds.has(materialId)) ||
      execution.input_snapshot_hash !== inputSnapshotHash(task, inputMaterialRefs);
  });
  const cores = state.cores.map((core) => {
    const lastTake = core.takeHistory.at(-1);
    const taskId = core.taskId ?? lastTake?.task_id ?? null;
    const executionId = core.executionId ?? lastTake?.execution_id ?? null;
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
      takes: core.takeHistory.map((take) => ({
        ...take,
        workspace_revision_end: state.taskService.getExecution(take.execution_id)?.workspace_revision ?? null,
        initial_public_workspace_input: state.taskService.getExecution(take.execution_id)?.workspace_input ?? null,
      })),
      latency_samples: core.latencySamples,
      tool_events: [...new Set(core.toolEvents)],
      workspace_writes: core.workspaceWrites,
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
    return !BOT_TOOL_NAMES.includes(name);
  }));
  const toolErrorCount = cores.reduce((count, core) => count + core.tool_errors.length, 0);
  // A Service tool can reject an Agent request because the model supplied a
  // stale version, an invalid state transition, or a boundary-incompatible
  // payload. The bridge returns that error to the Agent as tool feedback. It
  // is not a protocol violation and must not invalidate the whole project.
  const toolProtocolErrorCount = cores.reduce((count, core) => count + core.tool_errors.filter((error) => error.protocol === true).length, 0);
  const takenExecutionIds = [...new Set(takeHistory.map((take) => take.execution_id))];
  const takenExecutions = takenExecutionIds.map((executionId) => state.taskService.getExecution(executionId));
  const workspaceRefs = takenExecutions.map((execution) => execution?.workspace_ref).filter(Boolean);
  // A preparation/bind failure is allowed to end before a Workspace exists
  // (B09). It is not a boundary violation; every Execution that actually
  // materialized a Workspace must still have a unique one.
  const preparationFailure = isPreparationFailure;
  const workspaceBoundaryViolation = takenExecutions.some((execution) => !execution
    || (!execution.workspace_ref && !preparationFailure(execution)))
    || new Set(workspaceRefs).size !== workspaceRefs.length;
  const workspaceSourceBoundaryViolation = takeHistory.some((take) => {
    const execution = state.taskService.getExecution(take.execution_id);
    if (!execution?.workspace_source_id) return false;
    const material = state.contextService.getMaterial(execution.workspace_source_id);
    return !material || material.source_task !== take.task_id || material.source_execution !== take.execution_id;
  });
  const cleanupPending = (state.cleanupErrors?.length ?? 0) > 0;
  const invalid = cleanupPending || toolViolation || toolProtocolErrorCount > 0 || materialBoundaryViolation || inputMaterialViolation || workspaceViolation || workspaceBoundaryViolation ||
    workspaceSourceBoundaryViolation || cores.some((core) => core.cheating_flags.length > 0);
  const proposedTaskCount = taskEvidence.counts.total;
  const lifecycle = lifecycleEvents(state.taskService);
  const taskLifecycle = taskLifecycleEvents(state.taskService);
  const notifications = state.taskService.listNotifications?.({ missionId: state.missionId }) ?? [];
  const narratives = executionNarratives(state, taskTree, materials);
  const invalidWaitAttemptCount = 0;
  const executionTakeCounts = new Map();
  for (const take of takeHistory) executionTakeCounts.set(take.execution_id, (executionTakeCounts.get(take.execution_id) ?? 0) + 1);
  const resumedExecutionCount = [...executionTakeCounts.values()].filter((count) => count > 1).length;
  const workspaceWriteCount = cores.reduce((count, core) => count + core.workspace_writes.length, 0);
  const meaningfulMaterialCount = materials.filter((material) => !['failure', 'blocker'].includes(material.kind)).length;
  const checkCount = cores.reduce((count, core) => count + core.checks.length, 0);
  const legacyCheckObserved = cores.some(core => core.checks.some(check => check.workspace_input?.check_mode !== 'lean-project'));
  const madeProgress = workspaceWriteCount > 0 || meaningfulMaterialCount > 0 || legacyCheckObserved;
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
      core_count: state.cores.length,
      initial_bot_stagger_ms: state.initialBotStaggerMs ?? 0,
      project_parallelism: state.projectParallelism ?? 1,
      repository_commit: state.repositoryCommit,
      repository_worktree_dirty: state.repositoryWorktreeDirty,
      normal_flow: state.normalFlow,
      task_model: 'flat',
      provider: state.provider ?? null,
      model: state.model ?? null,
      timebox_ms: state.timeboxMs ?? null,
      mission_id: state.missionId,
      workspace_id: state.workspaceId,
      workspace_main_revision: '0.1',
      candidate_model: 'workspace_file_ref',
      initial_task_count: state.initialTaskIds.length,
      proposed_task_count: proposedTaskCount,
      bot_max_ms: state.botMaxMs,
      selection_timeout_ms: state.selectionTimeoutMs,
      execution_timeout_ms: state.executionTimeoutMs,
      handoff_reminder_ms: state.handoffReminderMs,
      input_policy: 'pinned formalization only; no candidate or solution input',
      tool_policy: 'Pi read/write/edit/bash; services through authenticated swarm CLI; ambient extensions, skills, prompt templates and project context discovery disabled',
      registered_services: state.capabilityRegistry.listServices().map((service) => ({
        service_id: service.service_id,
        provider_version: service.provider_version,
        contract_version: service.contract_version,
        manifest_hash: service.manifest_hash,
        tool_count: service.tool_count,
      })),
      allowed_agent_tool_names: [...state.allowedAgentToolNames].sort(),
      cheating_policy: 'A recorded forbidden candidate placeholder or tool event outside read/write/edit/bash invalidates the project; ordinary project diagnostics do not establish a policy violation',
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
      service_deployment: state.serviceDeployment ?? { deployment: 'in-process' },
      workspace_id: state.workspaceId,
      database_path: state.databasePath,
      input_workspace_hash: state.inputMaterialHash,
      task_count: proposedTaskCount,
      task_page: taskEvidence.page,
      task_tree: taskTree.map((task) => ({
        expected_output: task.expected_output ?? null,
        acceptance_conditions: task.acceptance_conditions ?? null,
        timebox_ms: task.timebox_ms ?? null,
        material_links: taskMaterialLinks(state, task).map((link) => ({
          link_id: link.link_id,
          material_id: link.material_id,
          role: link.role,
          receiving_task_id: link.receiving_task_id ?? null,
          producer_task_id: link.producer_task_id ?? null,
          producer_execution_id: link.producer_execution_id ?? null,
          accepted_at: link.accepted_at ?? null,
        })),
        task_id: task.task_id,
        mission_id: task.mission_id ?? state.missionId ?? null,
        summary: task.summary ?? null,
        relations: task.relations ?? null,
        task_type: task.task_type,
        priority: task.priority,
        responsibility_key: task.responsibility_key ?? null,
        state: task.state,
      })),
      readiness: readinessEvidence(state.readinessSamples, endedAt),
      // Keep the historical field name while carrying the same bounded
      // narrative used by operators: goal, actions, outputs, dependencies,
      // and terminal/block reasons without proof contents or raw payloads.
      execution_history: narratives,
      execution_narratives: narratives,
    },
    parallelism: {
      ...parallelism,
      proposal_evidence: {
        definition: 'All admitted Mission Tasks, including the first proposal. Creation alone does not establish independent progress or successful execution.',
        observed_task_count: proposedTaskCount,
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
      final_tree_checker: state.finalTreeEvidence ?? null,
      progress_evidence: {
        proposed_task_count: proposedTaskCount,
        workspace_write_count: workspaceWriteCount,
        meaningful_material_count: meaningfulMaterialCount,
        candidate_check_count: checkCount,
      },
      solved: state.missionSubmissionStore.isAccepted(state.missionId),
      accepted_at: state.solvedAt === null ? null : new Date(state.solvedAt).toISOString(),
      attempt_index: state.attemptIndex ?? null,
      solved_by_core: state.solvedBy,
      solved_at_ms: state.solvedAt === null ? null : state.solvedAt - startedAt,
      sandbox: state.sandboxManager?.snapshot() ?? null,
      material_count: materials.length,
      material_consumption_count: materialConsumptions.length,
      material_consumptions: materialConsumptions.map((row) => ({
        operation_id: row.operation_id,
        material_id: row.material_id,
        reader_task: row.reader_task,
        reader_execution: row.reader_execution,
        action: row.action,
        action_ref: row.action_ref,
        material_version: row.material_version,
        material_content_hash: row.material_content_hash,
        impact_recorded: Boolean(row.impact),
        created_at: row.created_at,
      })),
      notifications: notifications.map((notification) => ({
        notification_id: notification.notification_id,
        delivery_key: notification.delivery_key,
        mission_id: notification.mission_id,
        recipient_task_id: notification.recipient_task_id,
        recipient_execution_id: notification.recipient_execution_id,
        notification_type: notification.notification_type,
        material_id: notification.material_id,
        source_task_id: notification.source_task_id,
        source_execution_id: notification.source_execution_id,
        delivery_attempts: notification.delivery_attempts,
        delivered_at: notification.delivered_at,
        delivered_execution_id: notification.delivered_execution_id,
        created_at: notification.created_at,
      })),
      notification_count: notifications.length,
      project_material_count: materials.filter((material) => allowedTaskIds.has(material.source_task)).length,
      mission_final_check_budget: state.missionSubmissionStore?.getFinalCheckBudget(state.missionId) ?? null,
      judge_check_budget: state.judgeService?.getMissionCheckBudget(state.missionId) ?? null,
      check_count: cores.reduce((count, core) => count + core.checks.length, 0),
      ended_early: state.solvedAt !== null,
      deadline_reached: Date.now() >= deadline,
      cleanup_elapsed_ms: state.cleanupElapsedMs,
      cleanup_errors: state.cleanupErrors ?? [],
      unhandled_rejections: state.unhandledRejections ?? [],
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
      identity_loops: state.identityLoops?.map((loop) => loop.snapshot()) ?? [],
      identity_loop_events: state.identityLoopEvents ?? [],
      identity_loop_errors: state.identityLoopErrors ?? [],
      // Kept as a compatibility projection for existing report consumers;
      // production decisions are owned by Controller and IdentityTaskLoop above.
      scheduler: state.scheduler?.snapshot() ?? null,
      scheduler_events: state.schedulerEvents,
      controller: state.controller?.snapshot() ?? null,
      controller_events: state.controllerEvents,
      latency_samples: cores.flatMap((core) => core.latency_samples ?? []),
      latency_summary: {
        ready_to_session_start_ms: state.schedulerEvents
          .filter((event) => event.kind === 'scheduler_dispatch_started' && Number.isFinite(event.ready_to_dispatch_ms))
          .map((event) => event.ready_to_dispatch_ms),
        ready_to_take_ms: cores.flatMap((core) => core.latency_samples ?? [])
          .map((sample) => sample.ready_to_take_ms).filter(Number.isFinite),
        take_to_first_turn_ms: cores.flatMap((core) => core.latency_samples ?? [])
          .map((sample) => sample.take_to_first_turn_ms).filter(Number.isFinite),
        wait_to_core_release_ms: cores.flatMap((core) => core.latency_samples ?? [])
          .map((sample) => sample.wait_to_core_release_ms).filter(Number.isFinite),
        condition_to_resumed_turn_ms: cores.flatMap((core) => core.latency_samples ?? [])
          .map((sample) => sample.condition_to_resumed_turn_ms).filter(Number.isFinite),
      },
      // Count every Task admitted after Mission initialization.  The previous
      // projection counted only controller-generated `flat:proof-feedback:*`
      // Tasks and therefore hid Agent-created responsibilities from the
      // benchmark report and budget accounting.
      dynamic_task_count: proposedTaskCount - state.initialTaskIds.length,
      dynamic_task_events: state.dynamicTaskEvents,
      // Source-level Judge feedback is diagnostic. There is no controller
      // route gate or required Response handoff between candidate attempts.
      route_gates: [],
      lifecycle_events: lifecycle,
      task_lifecycle_events: taskLifecycle,
      admission_events: [],
      tool_error_classes: [...new Set(cores.flatMap((core) => core.tool_errors.map((error) => error.code)))],
      taken_core_count: new Set(state.cores.filter((core) => core.takeHistory.length > 0).map((core) => core.index)).size,
      take_count: takeHistory.length,
      resumed_execution_count: resumedExecutionCount,
      wait_count: 0,
      wake_count: 0,
      accept_count: 0,
      rework_count: 0,
      resume_count: 0,
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
        ...(cleanupPending ? ['cleanup_pending'] : []),
        ...(toolViolation ? ['non_swarmenv_tool_event'] : []),
        ...(toolProtocolErrorCount > 0 ? ['agent_tool_protocol_error'] : []),
        ...(materialBoundaryViolation ? ['material_boundary_violation'] : []),
        ...(inputMaterialViolation ? ['input_material_violation'] : []),
      ...(workspaceViolation ? ['workspace_violation'] : []),
        ...(workspaceBoundaryViolation ? ['workspace_boundary_violation'] : []),
        ...(workspaceSourceBoundaryViolation ? ['candidate_provenance_violation'] : []),
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
  const assertInitializing = () => { if (options.signal?.aborted) throw operatorStop(); };
  assertInitializing();
  // The Mission-scoped Task lifecycle is the only supported model.
  // Reject removed programmatic mode toggles rather than silently ignoring them.
  if (Object.hasOwn(options, 'taskModel') || Object.hasOwn(options, 'taskOriented')) {
    throw new TypeError('taskModel/taskOriented have been removed; Mission Task is the only runtime model');
  }
  if (options.missionCloseoutMs !== undefined && (!Number.isFinite(options.missionCloseoutMs) || options.missionCloseoutMs <= 0)) throw new TypeError('missionCloseoutMs must be finite and positive');
  if ((options.timeboxMs ?? 60 * 60_000) > 0) {
    const permissions = options.coordinationPermissions ?? config.mission_coordination_permissions ?? [];
    if (!Array.isArray(permissions) || !permissions.includes('mission_submit') || permissions.some(value =>
      !['unsupersede', 'task_cancel', 'task_dependency_replace', 'mission_submit'].includes(value))) {
      throw new SwarmEnvError(ERROR_CODES.SERVICE_NOT_READY, 'Timed benchmarks require an explicit valid Mission coordination grant including mission_submit');
    }
    requirePrivateAudit(options.privateAudit, options.experimentDir);
  }
  const normalFlow = true; // The Mission Task contract always uses typed normal-flow lifecycle.
  const runId = options.runId ?? randomUUID();
  const solver = options.agentMode === 'solver';
  const coreCount = solver ? 1 : 4;
  const artifactKey = solver ? `${problem.id}-attempt-${options.attemptIndex}` : problem.id;
  const contract = agentContract(solver ? 'solver' : 'swarm');
  const startedAt = options.startedAt ?? Date.now();
  const experimentRoot = resolve(options.experimentDir ?? options.reportDir);
  const reportRoot = resolve(options.reportDir ?? join(experimentRoot, 'reports'));
  const projectDir = join(experimentRoot, 'state', 'projects', artifactKey);
  const reportProjectDir = join(reportRoot, artifactKey);
  const workspaceRoot = join(experimentRoot, 'workspaces', 'projects', artifactKey);
  const missionWorkspaceRoot = join(projectDir, 'mission-workspace');
  const missionWorkspace = new MissionWorkspace({ rootDir: missionWorkspaceRoot });
  let missionSubmissionStore = null;
  let modelAccess = null;
  let modelDatabase = null;
  let projectState = null;
  let acceptedMission = null;
  // Final acceptance has a distinct locked target and identity from the
  // diagnostic single-source checker. Configuration is trusted host input.
  assertTimedServiceComposition(options);
  const modelBudget = options.modelBudget ?? config.model_budget;
  const modelGateway = options.modelGateway ?? config.model_gateway;
  const judgeMissionBudget = normalizeJudgeMissionBudget(options.judgeMissionBudget ?? config.judge_mission_budget);
  if ((options.timeboxMs ?? 60 * 60_000) > 0 && !options.modelUpstream) {
    throw new SwarmEnvError(ERROR_CODES.SERVICE_NOT_READY, 'Timed benchmarks require a host-side model endpoint and credential');
  }
  let modelCatalogResource = null;
  if ((options.timeboxMs ?? 60 * 60_000) > 0) {
    try {
      modelCatalogResource = await assertBenchmarkModelPair({
        provider: options.provider ?? process.env.PI_PROVIDER ?? process.env.NUROUTER_PI_PROVIDER,
        model: options.model ?? process.env.PI_MODEL ?? process.env.NUROUTER_PI_MODEL,
        command: options.command ?? 'pi',
      });
    } catch (error) {
      assertInitializing();
      throw new SwarmEnvError(ERROR_CODES.SERVICE_NOT_READY, error.message, {}, { cause: error });
    }
  }
  assertInitializing();
  const finalTreeConfiguration = options.finalTreeCheckerConfig ?? config.final_tree_checker;
  const timedBenchmark = (options.timeboxMs ?? 60 * 60_000) > 0;
  if (timedBenchmark && (!finalTreeConfiguration || options.finalTreeChecker || options.checker)) {
    throw new SwarmEnvError(ERROR_CODES.SERVICE_NOT_READY, 'A timed benchmark requires locked final and source checkers from the configured deployment');
  }
  const finalTreeDeployment = finalTreeConfiguration ? await createLockedFinalTreeVerifier({ configuration: finalTreeConfiguration, problem })
    .catch(error => { assertInitializing(); throw error; }) : null;
  assertInitializing();
  const finalTreeChecker = options.finalTreeChecker ?? finalTreeDeployment?.adapter ?? null;
  const lockedSourceRunner = finalTreeDeployment?.adapter.runSourceDiagnostic.bind(finalTreeDeployment.adapter);
  const projectChecker = finalTreeDeployment?.adapter.projectChecks
    ? finalTreeDeployment.adapter.checkProject.bind(finalTreeDeployment.adapter) : null;
  const sourceCheckerTimeoutMs = Math.min(options.checkerTimeoutMs ?? 120_000, finalTreeDeployment?.adapter.timeoutMs ?? Infinity);
  let sandboxObservationStore = null;
  const sandboxConfig = options.sandbox ?? {};
  const timeBoundedModel = modelBudget == null && timedBenchmark;
  const modelConfiguration = modelBudget ?? (timeBoundedModel ? {
    host: sandboxConfig.bridgeHost ?? '127.0.0.1',
    advertiseHost: sandboxConfig.bridgeUrl ? new URL(sandboxConfig.bridgeUrl.replaceAll('{port}', '80')).hostname : undefined,
    ...modelGateway,
  } : null);
  const networkConfiguration = sandboxConfig.networkIsolation ?? config.sandbox_network;
  if ((options.timeboxMs ?? 60 * 60_000) > 0 && networkConfiguration?.mode !== 'local-docker') {
    throw new SwarmEnvError(ERROR_CODES.SERVICE_NOT_READY, 'Timed benchmarks require verified Bot network isolation');
  }
  const networkIsolation = networkConfiguration?.mode === 'local-docker'
    ? new DockerBotNetwork({ additionalEndpoints: networkConfiguration.additionalEndpoints ?? [] }) : null;
  const diskConfiguration = sandboxConfig.diskIsolation ?? config.sandbox_disk;
  if ((options.timeboxMs ?? 60 * 60_000) > 0 && (diskConfiguration?.mode !== 'local-docker-tmpfs-landlock' ||
      !Number.isSafeInteger(diskConfiguration.bytes) || !Number.isSafeInteger(diskConfiguration.inodes) || sandboxConfig.volumes?.length)) {
    throw new SwarmEnvError(ERROR_CODES.SERVICE_NOT_READY, 'Timed benchmarks require explicit Bot disk and inode quotas and no extra Sandbox volumes');
  }
  const diskIsolation = diskConfiguration?.mode === 'local-docker-tmpfs-landlock' ? new DockerBotDisk(diskConfiguration) : null;
  const sandboxProvider = String(sandboxConfig.provider ?? process.env.SWARMENV_SANDBOX_PROVIDER ?? 'opensandbox').toLowerCase();
  const usesOpenSandbox = sandboxProvider === 'opensandbox' || sandboxProvider === 'open-sandbox';
  if (sandboxConfig.enabled !== true || !usesOpenSandbox) {
    throw new TypeError('PutnamBench runs require sandbox.enabled=true with sandbox.provider=opensandbox');
  }
  const sandboxManager = new OpenSandboxManager({
        lifecycleBaseUrl: sandboxConfig.lifecycleBaseUrl ?? process.env.SWARMENV_OPENSANDBOX_URL,
        endpointHost: sandboxConfig.endpointHost ?? process.env.SWARMENV_OPENSANDBOX_ENDPOINT_HOST ?? null,
        apiKey: sandboxConfig.apiKey ?? process.env.OPEN_SANDBOX_API_KEY ?? null,
        execdToken: sandboxConfig.execdToken ?? process.env.SWARMENV_EXECD_ACCESS_TOKEN ?? null,
        image: sandboxConfig.image,
        resourceLimits: sandboxConfig.resourceLimits,
        environment: sandboxConfig.environment,
        volumes: sandboxConfig.volumes,
        execdPort: sandboxConfig.execdPort,
        commandTimeoutMs: sandboxConfig.commandTimeoutMs,
        maxOutputBytes: sandboxConfig.maxOutputBytes,
        // Execd v1.1's session endpoint is not a durable stdin transport for
        // direct Pi workers. Use the command endpoint by default; callers may
        // opt into sessions only after verifying provider support.
        foregroundSession: sandboxConfig.foregroundSession ?? false,
        logger: (event) => {
          if (sandboxObservationStore?.getExperiment?.(runId)) sandboxObservationStore.append({ experimentId: runId, source: 'runtime', kind: 'sandbox_event', payload: event });
        },
      });
  await sandboxManager.preflight({ timeoutMs: sandboxConfig.preflightTimeoutMs ?? 20_000 })
    .catch(error => { assertInitializing(); throw error; });
  assertInitializing();
  const logRoot = join(experimentRoot, 'logs', 'projects', artifactKey);
  await Promise.all([
    mkdir(projectDir, { recursive: true }),
    mkdir(reportProjectDir, { recursive: true }),
    mkdir(workspaceRoot, { recursive: true }),
    mkdir(logRoot, { recursive: true }),
  ]);
  assertInitializing();
  const databasePath = join(projectDir, 'project.sqlite');
  const database = new DatabaseSync(databasePath);
  let contextService;
  let judgeService;
  let independentServices;
  const closeStores = async () => {
    await independentServices?.close();
    try { judgeService?.close(); }
    finally { try { contextService?.close(); } finally { try { modelDatabase?.close(); } finally { database.close(); } } }
  };
  const cores = [];
  try { return await initializeProjectState(); }
  catch (error) {
    const cleanup = { cores, cleanupErrors: [], missionSubmissionStore, modelAccess, judgeService, operatorStopped: options.signal?.aborted === true };
    await stopBenchmarkRuntime(cleanup, { cleanupGraceMs: options.cleanupGraceMs ?? 30_000 });
    await closeProjectStores(cleanup, closeStores, options);
    if (cleanup.operatorStopped) {
      const stopped = operatorStop();
      stopped.cleanupErrors = cleanup.cleanupErrors;
      throw stopped;
    }
    throw error;
  }

  async function initializeProjectState() {
    const observationStore = options.observationStore ?? new ObservationStore(database);
    sandboxObservationStore = observationStore;
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
    const taskService = new TaskService(database, { logger: taskLogger });
    const fixture = fixtureManifest(problem, problem.source_hash, config.lean_project_root ?? config.putnam_bench_root, config);
    if (projectChecker) fixture.environment_ref = `${fixture.environment_ref}:lean-project:sha256:${finalTreeDeployment.evidence.artifact_lock_sha256}`;
    const workspaceMergeChecker = projectChecker ? {
      identity: { checker_ref: fixture.checker_ref, checker_version: fixture.checker_version, environment_ref: fixture.environment_ref },
      timeoutMs: sourceCheckerTimeoutMs,
      async check(plan) {
        const result = await projectChecker(plan);
        if (result.checked_tree !== plan.tree) return { verdict: 'ERROR', diagnostic: 'Project check result does not identify the combined Workspace tree' };
        return { ...result, check_mode: 'lean-project', check_result_id: `projectcheck:${randomUUID()}` };
      },
    } : null;
    const serviceDeployment = options.serviceDeployment ?? (timedBenchmark ? 'independent' : 'in-process');
    if (!['independent', 'in-process'].includes(serviceDeployment)) throw new TypeError('serviceDeployment must be independent or in-process');
    if (serviceDeployment === 'independent') {
      if (options.checker) throw new TypeError('Independent Judge uses its own configured checker, not a shared injected object');
      independentServices = await startIndependentServices({ taskService, projectDir, logRoot,
        fixtureManifest: fixture, finalTreeConfiguration, problem, missionBudget: judgeMissionBudget,
        maxInfrastructureRetries: options.maxInfrastructureRetries, checkerTimeoutMs: sourceCheckerTimeoutMs,
        readProjectRevision: projectChecker ? reference => missionWorkspace.exportRevision(reference) : null,
        leanCommand: options.leanCommand ?? 'lake', contextLogger, judgeLogger });
      contextService = independentServices.context;
      judgeService = independentServices.judge;
    } else {
      contextService = new ContextService(join(projectDir, 'context.sqlite'), { logger: contextLogger });
      contextService.taskService = taskService;
      taskService.contextService = contextService;
    judgeService = new JudgeService(join(projectDir, 'judge.sqlite'), {
      missionBudget: judgeMissionBudget,
      taskService,
      logger: judgeLogger,
      maxInfrastructureRetries: options.maxInfrastructureRetries,
      fixtureManifest: fixture,
      readProjectRevision: projectChecker ? reference => missionWorkspace.exportRevision(reference) : null,
      checker: options.checker ?? new LeanChecker({
        workRoot: join(projectDir, 'judge-work'),
        logger: checkerLogger,
        command: options.leanCommand ?? 'lake',
        timeoutMs: sourceCheckerTimeoutMs,
        runner: lockedSourceRunner,
        projectChecker,
      }),
    });
    }
    taskService.setCheckerHealthReader((preflightKey) => judgeService.getCheckerPreflight(preflightKey));
    taskService.setCheckResultReader((checkResultId) => judgeService.getCheckResult(checkResultId));
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
    // Flat Mission Tasks finish through the single registered Task capability.
    const runtimeCapabilities = runtimeCapabilityList()
      .filter((capability) => sandboxManager || !['sandbox_exec', 'sandbox_job'].includes(capability.operation));
    const allowedAgentToolNames = [...BOT_TOOL_NAMES];
    const taskCreateMutex = new SerialTaskCreateAdmission();
    observationStore.registerExperiment({ experimentId: runId, status: 'CREATED', metadata: { problem_id: problem.id } });
    const mission = taskService.createMission({
      mission_id: `mission:${problem.id}:${runId}`,
      goal: solver ? `Solve ${problem.id} independently.` : `Solve ${problem.id} through independent, shared Task work.`,
      ...(workspaceMergeChecker ? { merge_required_check: workspaceMergeChecker.identity } : {}),
      acceptance_conditions: {
        project: problem.id,
        source_hash: problem.source_hash,
        theorem: problem.id,
        target_path: problem.problem_file,
        required_check: finalTreeChecker?.identity ?? null,
      },
    }, makeEnvelope({ actorRef: 'owner:benchmark', operationId: `benchmark:mission:create:${runId}` })).mission;
    const workspaceId = `workspace-${problem.id}-${runId}`;
    const publicWorkspace = await missionWorkspace.create({
      missionId: mission.mission_id,
      workspaceId,
      initialFiles: { [problem.problem_file]: problem.source },
      metadata: { input_snapshot_hash: problem.source_hash, checker: fixture.checker_ref, environment: fixture.environment_ref },
    });
    missionSubmissionStore = createMissionCoordination({ taskService, contextService, workspace: missionWorkspace,
      workspaceId, missionId: mission.mission_id, checker: finalTreeChecker,
      deadline: startedAt + (options.timeboxMs ?? 60 * 60_000),
      isStopping: () => projectState?.stopping === true,
      maxInfrastructureRetries: options.maxInfrastructureRetries ?? 0,
      maxFinalChecks: options.maxFinalChecks ?? config.mission_final_check_budget?.maxChecks,
      maxConcurrentFinalChecks: options.maxConcurrentFinalChecks ?? config.mission_final_check_budget?.maxConcurrent,
      onAccepted: submission => {
        acceptedMission = submission;
        if (projectState) beginMissionCloseout(projectState, submission);
      },
    });
    taskService.setMissionStopReader(id => id === mission.mission_id &&
      (projectState?.stopping === true || options.signal?.aborted === true || Date.now() >= startedAt + (options.timeboxMs ?? 60 * 60_000) || missionSubmissionStore.isAccepted(id)));
    await missionSubmissionStore.reconcile({ missionId: mission.mission_id });
    const capabilityRegistry = options.serviceRegistry ?? createBuiltinServiceRegistry({
      taskService,
      contextService,
      judgeService,
      missionWorkspace,
      missionSubmissionStore,
      serviceEndpoints,
      customServices: options.customServices ?? [],
    });
    if (!options.serviceRegistry && Array.isArray(options.serviceBundles) && options.serviceBundles.length > 0) {
      for (const bundleDir of options.serviceBundles) {
        const loaded = await loadServiceBundle(bundleDir, { rootDir: options.serviceBundleRoot ?? undefined });
        const configured = options.serviceBundleEndpoints?.[loaded.service_id] ?? null;
        const endpoint = configured
          ? { transport: 'http-json', url: typeof configured === 'string' ? configured : configured.url }
          : null;
        const bundle = endpoint
          ? await loadServiceBundle(bundleDir, { rootDir: options.serviceBundleRoot ?? undefined, manifestOverrides: { endpoint } })
          : loaded;
        if (capabilityRegistry.listServices().some((service) => service.service_id === bundle.service_id)) continue;
        let adapter = options.serviceBundleAdapters?.[bundle.service_id] ?? null;
        if (!adapter && bundle.manifest.endpoint.transport === 'http-json') {
          const tokenRef = bundle.secret_refs?.token ?? null;
          const token = tokenRef ? process.env[tokenRef.slice('env:'.length)] ?? null : null;
          adapter = createHttpJsonAdapter({ token });
        }
        if (!adapter) throw new TypeError(`service bundle ${bundle.service_id} requires an adapter for ${bundle.manifest.endpoint.transport}`);
        await capabilityRegistry.registerBundle({ bundle, adapter });
        if (bundle.manifest.endpoint.transport === 'http-json') await capabilityRegistry.checkReadiness(bundle.service_id);
      }
    }
    if (!options.serviceRegistry && mathlibSearchUrl && !capabilityRegistry.listServices().some((service) => service.service_id === 'mathlib-search')) {
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
    if (!options.serviceRegistry && !mathlibSearchUrl && !capabilityRegistry.listServices().some((service) => service.service_id === 'mathlib-search')) {
      // The locked PutnamBench checkout already contains the Mathlib source
      // used by Lean. Register the local provider in-process when no external
      // endpoint was configured, so research admission and Agent search use the
      // same pinned project rather than silently exposing no mathlib capability.
      const sourceRoot = options.mathlibSearchSourceRoot
        ?? process.env.MATHLIB_SEARCH_SOURCE_ROOT
        ?? join(config.lean_project_root, '.lake', 'packages', 'mathlib', 'Mathlib');
      try {
        await access(sourceRoot);
        const provider = createMathlibSearchService({
          endpoint: { transport: 'in-process' },
          sourceRoot,
          projectRoot: config.lean_project_root,
          mathlibRevision: options.mathlibRevision ?? fixture.mathlib_version ?? null,
          leanVersion: options.leanVersion ?? fixture.lean_toolchain ?? null,
        });
        registerUserService(capabilityRegistry, {
          manifest: provider.manifest,
          adapter: createInProcessAdapter({ invoke: provider.handler, readiness: provider.readiness }),
        });
      } catch (error) {
        if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
        // A synthetic/unit fixture may not ship Mathlib. The capability remains
        // absent and Task admission will return a structured, actionable error.
      }
    }
    // Owner/controller SDK calls are synchronous local transactions. Keep that
    // control-plane registry local even when Agent-facing providers are remote;
    // ServicesBridge uses capabilityRegistry for the named HTTP calls.

    const routerRegistry = createBuiltinServiceRegistry({ taskService, contextService, judgeService, missionWorkspace, missionSubmissionStore });
    const router = new ServicesRouter({ taskService, contextService, judgeService, missionWorkspace, missionSubmissionStore, registry: routerRegistry, logger: routerLogger });
    const owner = sdk(router, { actorRef: 'owner:benchmark' });
    // Swarm starts empty; Pass@K seeds one complete responsibility through Task Service.
    observationStore.registerExperiment({ experimentId: runId, status: 'CREATED', metadata: {
      problem_id: problem.id,
      task_model: 'flat',
      mission_id: mission?.mission_id ?? null,
      initial_task_count: 0,
      workspace_id: publicWorkspace.workspace_id,
    } });
    observationStore.append({ experimentId: runId, source: 'runtime', kind: 'mission_started_zero_tasks', payload: { mission_id: mission.mission_id, workspace_id: publicWorkspace.workspace_id } });
    const initialTasks = [];
    if (solver) initialTasks.push(taskService.createTask({
      mission_id: mission.mission_id, summary: `Independently solve the complete original theorem ${problem.id}`,
      goal: mission.goal, expected_output: 'Complete Lean proof accepted by the fixed final verifier',
      acceptance_conditions: ['The original theorem passes the fixed theorem, axiom and kernel verification'],
      workspace: { enabled: true }, base_revision: publicWorkspace.main_revision,
      timebox_ms: options.timeboxMs ?? 3_600_000,
    }, makeEnvelope({ actorRef: 'owner:passk', operationId: `solver-task:${runId}` })).task);

    observationStore.registerExperiment({ experimentId: runId, status: 'RUNNING', metadata: { initial_task_count: initialTasks.length, proposed_task_count: 0, workspace_id: publicWorkspace.workspace_id } });
    observationStore.append({
      experimentId: runId,
      source: 'runtime',
      kind: 'experiment_started',
      taskId: null,
      payload: {
        problem_id: problem.id,
        core_count: coreCount,
        initial_bot_stagger_ms: options.initialBotStaggerMs ?? 0,
        timebox_ms: options.timeboxMs ?? 60 * 60_000,
        task_model: 'flat',
        mission_id: mission?.mission_id ?? null,
        workspace_id: publicWorkspace.workspace_id,
        initial_task_count: initialTasks.length,
        proposed_task_count: 0,
        normal_flow: normalFlow,
      },
    });
    // Deterministic queue scenarios may seed durable Tasks before reusable Core
    // sessions start. The hook uses the same Task Service boundary as Agent
    // operations; it does not replace queue take, Runtime, or dispatch logic.
    await options.prepareProject?.({ owner, root: null, mission, publicWorkspace, initialTasks, taskService, contextService, router, fixture, problem });
    assertInitializing();
    if (modelConfiguration !== null) {
      modelDatabase = new DatabaseSync(join(projectDir, 'model-budget.sqlite'));
      modelAccess = new BotModelAccess({ db: modelDatabase, taskService, missionId: mission.mission_id,
        provider: options.provider ?? process.env.PI_PROVIDER ?? process.env.NUROUTER_PI_PROVIDER,
        model: options.model ?? process.env.PI_MODEL ?? process.env.NUROUTER_PI_MODEL,
        upstream: options.modelUpstream, configuration: modelConfiguration, timeBounded: timeBoundedModel,
        deadline: () => projectState?.runDeadlineAt ?? startedAt + (options.timeboxMs ?? 60 * 60_000),
        closeoutDeadline: () => projectState?.missionCloseoutDeadline ?? Infinity,
        isStopping: () => projectState?.stopping === true });
      await modelAccess.start();
    }
    const parallelism = new CoreParallelismTracker({ coreCount, startedAt });
      for (let index = 1; index <= coreCount; index += 1) {
      const coreDir = join(workspaceRoot, `core-${index}`);
      await mkdir(coreDir, { recursive: true });
      assertInitializing();
      const childEnv = { ...process.env };
      const adapter = new OpenSandboxAgentAdapter({
          agentMode: solver ? 'solver' : 'swarm',
          sandboxManager,
          modelAccess,
          networkIsolation,
          diskIsolation,
          modelCatalogResource,
          command: options.command ?? 'pi',
          provider: options.provider ?? process.env.PI_PROVIDER ?? process.env.NUROUTER_PI_PROVIDER,
          model: options.model ?? process.env.PI_MODEL ?? process.env.NUROUTER_PI_MODEL,
          account: options.account ?? process.env.NUROUTER_PI_ACCOUNT,
          group: options.group ?? process.env.NUROUTER_PI_GROUP,
          env: childEnv,
          agentEnvironment: sandboxConfig.agentEnvironment ?? {},
          secretEnv: sandboxConfig.secretEnvironment ?? {},
          systemPrompt: contract.systemPrompt,
        });
      // All reusable slots must be able to resume an Execution created by any
      // other slot. The physical Workspace is execution-owned and unique, but
      // its Runtime root is project-wide rather than core-private.
      const workspaceManager = new WorkspaceManager({ rootDir: workspaceRoot });
      const runtime = new Runtime({
        agentMode: solver ? 'solver' : 'swarm',
        taskService,
        contextService,
        workspaceManager,
        missionWorkspace,
        missionWorkspaceId: publicWorkspace.workspace_id,
        missionSubmissionStore,
        workspaceProjectCheck: Boolean(projectChecker),
        workspaceMergeChecker,
        coordinationPermissions: options.coordinationPermissions ?? config.mission_coordination_permissions ?? [],
        agentAdapter: adapter,
        runtimeCapabilities,
        sandboxManager,
        cleanExecutionWorkspaces: true,
        freshBotPerExecution: true,
        capabilityRegistry,
        maxWorkers: 1,
        coreIds: [`core-${index}`],
        actorRef: `runtime:core-${index}`,
        watchdogTimeoutMs: options.watchdogTimeoutMs,
        // Keep transient provider/session failures on the same durable
        // Execution. Fencing after one retry lets a recovered identity start a
        // second Task and invalidates a bounded formal run.
        maxRecoveryAttempts: solver ? 0 : options.maxRecoveryAttempts ?? 5,
        // Execution, Task, Bot and Mission limits intersect. Bot lifetime starts
        // before discovery and cannot reset when take becomes active.
        executionTimeoutMs: options.executionTimeoutMs ?? options.botMaxMs ?? flatExecutionTimeoutMs(options),
        handoffReminderMs: options.handoffReminderMs ?? flatHandoffReminderMs(options),
        logger: new DurableEventLog(join(logRoot, 'runtime', `core-${index}.ndjson`), { scope: `runtime:core-${index}` }),
        agentLogger: new DurableEventLog(join(logRoot, 'agents', `core-${index}.ndjson`), { raw: true, scope: `agent:core-${index}` }),
        onSessionStarted: ({ execution, session, recovery }) => {
          if (recovery) {
            // Recovery reuses the durable Execution. Restore the benchmark's
            // local binding before the recovered prompt can issue any tool call;
            // otherwise a late runTurn cleanup can make the Bridge look unbound
            // and the model may create a second Execution with task_take.
            const recoveredTask = taskService.getTask(execution.task_id);
            core.taskId = execution.task_id;
            core.executionId = execution.execution_id;
            core.take = recoveredTask ? { task: recoveredTask, execution } : { task: { task_id: execution.task_id }, execution };
            if (core.bridge && (!core.bridge.taskId || core.bridge.taskId === execution.task_id)) {
              core.bridge.taskId = execution.task_id;
              core.bridge.executionId = execution.execution_id;
              core.bridge.role = AGENT_ROLES.BOUND;
              core.bridge.capabilityProfile = null;
              core.bridge.capabilityProfileRegistryRevision = null;
            }
            attachRecoveredSession(core, { execution, session });
            return;
          }
          if (core.executionId !== execution.execution_id || core.session === session) return;
          // Explicit identity rotation replaced the Session in the same
          // Execution. Runtime has already sent the initial prompt; track the
          // replacement so the next idle wake does not start a competing turn.
          session.identitySession = true;
          core.session = session;
          core.sessionHistory.push(session);
          core.versionManifest = session.manifest ?? core.versionManifest;
          core.turnInFlight = true;
          core.agentTurnSession = session;
          core.sessionRotationCount = (core.sessionRotationCount ?? 0) + 1;
          void (async () => {
            try {
              await session.waitForSettled?.({ timeoutMs: Math.max(core.startConfig.options.turnTimeoutMs ?? 30_000, 180_000) });
            } catch (error) {
              const expected = session.expectedStop || core.session !== session || core.stopping;
              if (!expected) core.errors.push({ code: error.code ?? error.name, class: safeDiagnostic(error.message) ?? 'rotation_turn_error' });
            } finally {
              if (core.agentTurnSession === session) {
                core.parallelism.endAgentTurn(core.index, Date.now(), 'identity_rotation_settled');
                core.agentTurnSession = null;
              }
              if (core.session === session) {
                core.turnInFlight = false;
                core.nextTurnAt = Date.now();
              }
              core.stateRef?.requestIdentityWake?.();
            }
          })();
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
        prompt: BOT_CONTINUATION_MESSAGE,
        take: null,
        takeHistory: [],
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
        takeActive: false,
        takeResult: null,
        takeTurnCount: 0,
        identityLoop: null,
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
        agentMode: solver ? 'solver' : 'swarm',
        taskService,
        contextService,
        runtime,
        router,
        runtimeCapabilities,
        registry: capabilityRegistry,
        actorRef: `agent:core-${index}`,
        // The bridge, not the model payload, owns the lane identity.
        coreId: `core-${index}`,
        // This is an active reusable identity even while it has no current
        // Execution.  BOUND is intentional: it exposes task_status/task_take
        // and prevents the retired Selection role from becoming a second Agent.
        role: AGENT_ROLES.BOUND,
        taskCreateMutex,
        agentPrompt: contract.systemPrompt,
        // OpenSandbox workers cannot reach the controller's loopback address.
        // Deployments that expose the bridge to a provider network must bind it
        // explicitly and advertise a reachable host with `{port}`.
        host: (sandboxProvider === 'opensandbox' || sandboxProvider === 'open-sandbox')
          ? (sandboxConfig.bridgeHost ?? '127.0.0.1')
          : '127.0.0.1',
        publicUrl: (sandboxProvider === 'opensandbox' || sandboxProvider === 'open-sandbox')
          ? (sandboxConfig.bridgeUrl ?? process.env.SWARMENV_BRIDGE_PUBLIC_URL ?? null)
          : null,
        // Mission Task creation is governed by the Task Service contract and
        // responsibility-key idempotency. The benchmark must not add a hidden
        // count quota or reject independent work after a fixed number of Tasks.
        onTake: async (take) => {
          // task_take is invoked by this Core's reusable identity. Keep the
          // durable result available to IdentityTaskLoop so it does not issue a
          // second take or manufacture a separate selection handoff.
          core.dispatchReserved = false;
          const takenAt = Date.now();
          const priorWaitingExecutionId = core.waitingExecutionId;
          core.waitingExecutionId = null;
          core.parallelism.transition(core.index, 'ASSIGNED', {
            task_id: take.task.task_id,
            execution_id: take.execution.execution_id,
            reason: 'take_succeeded',
          });
          core.taskId = take.task.task_id;
          core.executionId = take.execution.execution_id;
          core.take = take;
          const workerSession = core.session;
          if (!workerSession) throw new Error('Agent took a Task before its session was registered');
          // Deterministic compatibility adapters expose a `bound` marker to
          // choose their scripted prompt path.  The real Pi Session has no such
          // field; updating it here preserves the same-identity transition
          // without creating a second Session.
          if ('bound' in workerSession) workerSession.bound = true;
          const takeRecord = {
            task_id: take.task.task_id,
            execution_id: take.execution.execution_id,
            workspace_revision_start: null,
          workspace_git_commit_start: null,
            taken_at: new Date(takenAt).toISOString(),
            ready_observed_at: core.stateRef?.readyObservedAt.get(take.task.task_id)
              ? new Date(core.stateRef.readyObservedAt.get(take.task.task_id)).toISOString()
              : null,
            ready_to_take_ms: core.stateRef?.readyObservedAt.has(take.task.task_id)
              ? Math.max(0, takenAt - core.stateRef.readyObservedAt.get(take.task.task_id))
              : null,
            resumed_from_wait: priorWaitingExecutionId === take.execution.execution_id || take.execution.attempt_no > 1,
          };
          core.latencySamples.push(takeRecord);
          core.latencyByExecution.set(take.execution.execution_id, takeRecord);
          core.takeHistory.push(takeRecord);
          const bound = await runtime.bindAgentExecution(take.execution.execution_id, workerSession, {
            workspaceRef: join(workspaceRoot, take.execution.execution_id),
            // The current Agent turn is already the first bound turn.  Sending
            // another initial prompt from inside task_take would race the
            // in-flight RPC and violate the single-turn ordering contract.
            sendInitialPrompt: false,
            agentPrompt: contract.systemPrompt,
          });
          // Publish a usable receipt only after Runtime binding succeeds.
          take.execution = bound.execution;
          take.workspace = bound.workspace;
          core.takeResult = take;
          const boundSession = core.session;
          const boundExecutionId = take.execution.execution_id;
          core.parallelism.transition(core.index, 'RUNNING', {
            task_id: take.task.task_id,
            execution_id: boundExecutionId,
            reason: 'execution_started_same_identity',
          });
          const latency = core.latencyByExecution.get(boundExecutionId);
          if (latency && !latency.first_turn_started_at) {
            const firstTurnAt = Date.now();
            latency.first_turn_started_at = new Date(firstTurnAt).toISOString();
            latency.take_to_first_turn_ms = Math.max(0, firstTurnAt - Date.parse(latency.taken_at));
            const eligibilityAt = core.stateRef?.waitEligibilityAt.get(boundExecutionId);
            if (eligibilityAt !== undefined) {
              latency.condition_satisfied_observed_at = new Date(eligibilityAt).toISOString();
              latency.resume_eligible_at = new Date(eligibilityAt).toISOString();
              latency.condition_to_resumed_turn_ms = Math.max(0, firstTurnAt - eligibilityAt);
            }
          }
          if (!solver && boundSession && core.runtime.hasActiveExecution(take.execution.execution_id)) {
            core.turnInFlight = true;
            let boundTurnPromise;
            boundTurnPromise = (async () => {
              try {
                if (typeof boundSession.waitForSettled === 'function') await boundSession.waitForSettled({ timeoutMs: Math.max(core.startConfig.options.turnTimeoutMs ?? 30_000, 180_000) });
                // A settled Agent turn does not necessarily release its
                // Execution: source-level checker feedback, incremental edits,
                // and ordinary progress may leave the Task RUNNING. Continue
                // that same bound Session until Runtime observes a wait or a
                // terminal Task state; IdentityTaskLoop must not wait forever for a
                // release that only a later turn can produce.
                while (!core.stopping && core.session === boundSession && core.executionId === boundExecutionId) {
                  const current = taskService.getExecution(boundExecutionId);
                  if (!current || current.state !== 'RUNNING') break;
                  await new Promise((resolve) => setTimeout(resolve, Math.min(core.turnIntervalMs ?? 1_000, 100)));
                  if (core.stopping || core.session !== boundSession || core.executionId !== boundExecutionId) break;
                  core.turnStartedAt = Date.now();
                  core.turnInFlight = false;
                  await runTurn(core, buildBotContinuationMessage(core.runtime.taskService.getExecution(boundExecutionId)), core.startConfig.options.turnTimeoutMs ?? 30_000);
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
                // IdentityTaskLoop waits for the Runtime release boundary. Terminal
                // Task transitions must therefore release the bridge binding
                // here, rather than relying on the benchmark's periodic repair
                // sweep to break a handoff wait.
                if (core.executionId === boundExecutionId) {
                  const settled = taskService.getExecution(boundExecutionId);
                  if (settled && ['SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED', 'FENCED', 'HANDED_OFF', 'SUPERSEDED'].includes(settled.state)) {
                    await releaseTerminalExecution(core);
                  }
                }
                core.stateRef?.requestIdentityWake?.();
                if (core.boundTurnPromise === boundTurnPromise) core.boundTurnPromise = null;
              }
            })();
            core.boundTurnPromise = boundTurnPromise;
            void boundTurnPromise.catch(() => undefined);
          }
          takeRecord.workspace_revision_start = bound.workspace.workspace_revision;
          takeRecord.workspace_git_commit_start = bound.workspace.git_commit ?? null;
          core.observe({
            source: 'runtime', kind: 'execution_assigned', visibility: 'operator',
            taskId: take.task.task_id, executionId: take.execution.execution_id,
            sessionId: core.session?.sessionId ?? null, coreId: `core-${core.index}`,
            payload: {
              workspace_ref: bound.workspace.workspace_ref,
              workspace_revision: bound.workspace.workspace_revision,
              workspace_content_hash: bound.workspace.content_hash,
              state: take.execution.state,
            },
          });
          core.observe({
            source: 'runtime', kind: 'core_state_changed', visibility: 'operator',
            taskId: take.task.task_id, executionId: take.execution.execution_id,
            sessionId: core.session?.sessionId ?? null, coreId: `core-${core.index}`,
            payload: { state: 'RUNNING', reason: 'execution_bound' },
          });
          // The worker session is only the take transport. The handoff result
          // tells the current turn to stop; once that turn settles, the
          // existing cleanup path stops this transport session.
          // Runtime replaces core.session with the newly started bound session,
          // so checking core.session for equality here is too late. The take
          // transport must always stop after a successful handoff before the
          // model can issue another take or a take-only call.
          if (workerSession !== core.session) await Promise.resolve(workerSession.stop?.()).catch(() => undefined);
        },
        onTakeAccepted: async () => {
        },
        onSchedulerStatus: async (payload) => {
          if (core.stateRef) core.stateRef.schedulerStatusCount += 1;
          const cores = core.stateRef?.cores ?? [core];
          const readyTasks = projectTasks(core.stateRef, {
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
            core.stateRef?.requestIdentityWake?.();
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
          const coreProjection = 'IDLE';
          // A take record is created before Runtime binds its Workspace. If a
          // very short bound turn fails before the handoff callback records the
          // starting revision, retain the attempted ownership with the durable
          // revision that Runtime prepared instead of emitting a null lineage.
          const latestTake = core.takeHistory.at(-1);
          if (latestTake?.task_id === taskId && latestTake.execution_id === executionId &&
            latestTake.workspace_revision_start === null && Number.isInteger(releasedExecution?.workspace_revision)) {
            latestTake.workspace_revision_start = releasedExecution.workspace_revision;
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
              reason: 'execution_released',
            },
          });
          core.parallelism.transition(core.index, coreProjection, {
            task_id: taskId,
            execution_id: executionId,
            reason: releasedExecution?.state?.toLowerCase() ?? 'take_released',
          });
          if (core.taskId === taskId && core.executionId === executionId) {
            core.waitingExecutionId = null;
            core.taskId = null;
            core.executionId = null;
            core.take = null;
            // Production closes this Bot before the Core starts its successor.
            // Deterministic adapters use `bound` only for their scripted path.
            if (core.session && 'bound' in core.session) core.session.bound = false;
            // Runtime has already detached the process before invoking this
            // callback. The transport turn still owns the dispatch reservation
            // until its promise settles, so another identity loop cannot start a
            // second worker against this Core during handoff.
          }
          core.stateRef?.requestIdentityWake?.();
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
          const materialPublishOperation = operation === 'publish_material' || operation === 'context_publish_material';
          if (materialPublishOperation || ['task_link_material', 'workspace_check', 'workspace_save', 'workspace_merge'].includes(operation)) {
            core.stateRef?.requestIdentityWake?.();
          }
          if (['workspace_save', 'workspace_merge'].includes(operation) && !result.already_included) {
            const revision = operation === 'workspace_save' ? result.revision : result.main_revision;
            if (!core.workspaceWrites.some(write => write.workspace_id === result.workspace_id && write.workspace_revision === revision && write.operation === operation)) {
              const changedPaths = result.changed_paths ?? result.changed_files ?? [];
              core.workspaceWrites.push({ operation, task_id: taskId, execution_id: executionId, workspace_id: result.workspace_id,
                workspace_revision: revision, workspace_content_hash: result.content_hash ?? null, changed_paths: changedPaths });
              core.observe({ source: 'workspace', kind: operation === 'workspace_save' ? 'workspace_revision_saved' : 'workspace_revision_merged', visibility: 'operator',
                taskId, executionId, coreId: `core-${core.index}`, payload: { workspace_id: result.workspace_id, revision, changed_count: changedPaths.length } });
              if (changedPaths.length) core.parallelism.recordWorkUnit({ task_id: taskId, execution_id: executionId, core: core.index, progress_kind: 'workspace_revision' });
            }
          }
          if (['read_materials', 'context_search_materials', 'context_get_material'].includes(operation)) {
            const materialsRead = operation === 'context_get_material'
              ? [result?.material ?? result].filter(Boolean)
              : Array.isArray(result) ? result : Array.isArray(result?.materials) ? result.materials : [];
            const materialRead = {
              read_at: new Date().toISOString(),
              reader_task_id: taskId,
              reader_execution_id: executionId,
              material_ids: materialsRead.map((material) => material.material_id).filter(Boolean).slice(0, 100),
              source_task_ids: [...new Set(materialsRead.map((material) => material.producer_task_id ?? material.source_task).filter(Boolean))].slice(0, 100),
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
            core.parallelism.recordWorkUnit({
              task_id: taskId,
              execution_id: executionId,
              core: core.index,
              progress_kind: 'material_read',
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
              impact_recorded: typeof payload?.impact === 'string' && payload.impact.trim().length > 0,
            };
            core.materialConsumptions.push(consumption);
            const state = core.stateRef;
            core.observe({
              source: 'context-service', kind: 'material_consumed', visibility: 'operator',
              taskId, executionId, coreId: `core-${core.index}`,
              payload: {
                material_ids: consumedIds,
                action: consumption.action,
                action_ref: consumption.action_ref,
                impact_recorded: consumption.impact_recorded,
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
          } else if (operation === 'task_create') {
            const created = result?.task ?? result ?? {};
            const state = core.stateRef;
            const dynamic = Boolean(created.task_id && state && !state.initialTaskIds.includes(created.task_id));
            if (dynamic && state) {
              state.dynamicTaskEvents.push({
                task_id: created.task_id ?? null,
                source_task_id: taskId,
                source_execution_id: executionId,
                responsibility_key: created.responsibility_key ?? payload?.responsibility_key ?? null,
                status: result?.deduplicated === true ? 'deduplicated' : 'created',
                origin: 'agent',
              });
            }
            core.observe({
              source: 'task-service', kind: 'task_created', visibility: 'operator',
              taskId: created.task_id ?? null, executionId, coreId: `core-${core.index}`,
              payload: {
                task_id: created.task_id ?? null,
                mission_id: created.mission_id ?? payload?.mission_id ?? null,
                responsibility_key: created.responsibility_key ?? payload?.responsibility_key ?? null,
                deduplicated: result?.deduplicated === true,
                dynamic,
              },
            });
            core.parallelism.recordWorkUnit({
              task_id: created.task_id ?? taskId,
              execution_id: executionId,
              core: core.index,
              progress_kind: 'task_create',
            });
            core.stateRef?.requestIdentityWake?.();
          } else if (materialPublishOperation) {
            const published = result?.material ?? result ?? {};
            core.observe({
              source: 'context-service', kind: 'material_published', visibility: 'operator',
              taskId, executionId, coreId: `core-${core.index}`,
              payload: {
                material_id: published.material_id ?? null,
                kind: published.kind ?? payload?.kind ?? null,
                scope: published.scope ?? payload?.scope ?? null,
                source_task: published.producer_task_id ?? published.source_task ?? taskId,
                source_execution: published.producer_execution_id ?? published.source_execution ?? executionId,
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
          } else if (operation === 'task_link_material') {
            const link = result?.link ?? result ?? {};
            const state = core.stateRef;
            core.observe({
              source: 'task-service', kind: 'material_linked', visibility: 'operator',
              taskId, executionId, coreId: `core-${core.index}`,
              payload: {
                material_id: link.material_id ?? payload?.material_id ?? null,
                role: link.role ?? payload?.role ?? null,
                receiving_task_id: link.receiving_task_id ?? payload?.receiving_task_id ?? payload?.task_id ?? null,
                producer_task_id: link.producer_task_id ?? null,
                producer_execution_id: link.producer_execution_id ?? null,
              },
            });
            core.parallelism.recordWorkUnit({
              task_id: taskId,
              execution_id: executionId,
              core: core.index,
              progress_kind: 'material_link',
            });
          } else if (operation === 'task_finish') {
            const lifecycleResult = result && typeof result === 'object' ? result : {};
            const lifecycleEvidence = {
              operation,
              task_id: taskId,
              execution_id: executionId,
              disposition: lifecycleResult.disposition ?? payload?.outcome ?? null,
              task_state: lifecycleResult.task?.state ?? null,
              execution_state: lifecycleResult.execution?.state ?? null,
              dependency_kind: lifecycleResult.dependency?.dependency_kind ?? payload?.dependency?.dependency_kind ?? null,
            };
            core.observe({
              source: 'runtime', kind: 'task_lifecycle_operation', visibility: 'operator',
              taskId, executionId, coreId: `core-${core.index}`,
              payload: lifecycleEvidence,
            });
            core.parallelism.recordWorkUnit({
              task_id: taskId,
              execution_id: executionId,
              core: core.index,
              progress_kind: 'coordination',
            });
            core.stateRef?.requestIdentityWake?.();
          } else if (operation === 'workspace_check') {
            const check = result?.check_result ?? result?.checkResult ?? result ?? {};
            const projectCheck = check.workspace_input?.check_mode === 'lean-project';
            if (projectCheck && core.checks.some(prior => prior.check_result_id === check.check_result_id)) return;
            const candidateMaterial = {
              material_id: check.workspace_source_id ?? payload?.workspace_source_id ?? null,
              content_hash: check.workspace_input?.content_hash ?? check.content_hash ?? null,
            };
            const observedCheck = sanitizedCheck(check, candidateMaterial);
            const sourcePath = check.workspace_input?.path ?? payload?.path ?? null;
            const projectEvidence = projectCheck ? { task_id: taskId, execution_id: executionId, workspace_input: check.workspace_input, build: check.build } : {};
            core.checks.push({ ...observedCheck, source_path: sourcePath, ...projectEvidence });
            if (!projectCheck && observedCheck.diagnostic_class === 'forbidden_placeholder') {
              core.cheatingFlags.push({ kind: 'forbidden_placeholder', material_hash: check.material_hash ?? null });
            }
            core.observe({
              source: 'judge-service', kind: 'workspace_checked', visibility: 'operator',
              taskId, executionId, coreId: `core-${core.index}`,
              payload: {
                candidate_path: sourcePath,
                workspace_source_id: candidateMaterial.material_id,
                check_result_id: check.check_result_id ?? result?.check_result_id ?? null,
                verdict: check.verdict ?? result?.verdict ?? null,
                ...(projectCheck ? { result_class: check.result_class, diagnostic_code: check.diagnostic_code,
                  workspace_input: check.workspace_input, build: check.build } : {}),
              },
            });
            if (!projectCheck) core.parallelism.recordWorkUnit({
              task_id: taskId,
              execution_id: executionId,
              core: core.index,
              progress_kind: 'workspace_check',
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
            // take commits; that scheduling contention is recoverable too.
            recoverable: ['INVALID_CONTRACT', 'INVALID_TASK_CONTRACT'].includes(error.code) || (error.code === 'CONFLICT' && operation === 'task_take'),
            protocol: false,
          });
          if (error.code === 'CONFLICT' && operation === 'task_take') {
            core.parallelism.recordTakeConflict(operationId ? `bridge:${operationId}` : null);
          }
        },
        logger: new DurableEventLog(join(logRoot, 'bridge', `core-${index}.ndjson`), { scope: `bridge:core-${index}` }),
      });
      core.bridge = bridge;
      cores.push(core);
      }
      const recovery = await cores[0].runtime.reconcileProviderExecutions({ missionId: mission.mission_id,
        timeoutMs: options.cleanupGraceMs ?? 30_000 });
      if (recovery.pending.length > 0) {
        throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Provider startup reconciliation left cleanup pending',
          { pending: recovery.pending });
      }
      await Promise.all(cores.map(async (core) => {
        Object.assign(core.childEnv, await core.bridge.start());
      }));
    const state = {
      runId,
      problem,
      config,
      provider: options.provider ?? process.env.PI_PROVIDER ?? process.env.NUROUTER_PI_PROVIDER ?? null,
      model: options.model ?? process.env.PI_MODEL ?? process.env.NUROUTER_PI_MODEL ?? null,
      agentMode: solver ? 'solver' : 'swarm',
      attemptIndex: options.attemptIndex ?? null,
      timeboxMs: options.timeboxMs ?? 60 * 60_000,
      initialBotStaggerMs: options.initialBotStaggerMs ?? 0,
      signal: options.signal,
      runDeadlineAt: startedAt + (options.timeboxMs ?? 60 * 60_000),
      missionCloseoutMs: options.missionCloseoutMs ?? 30_000,
      fixtureManifest: fixture,
      finalTreeEvidence: finalTreeDeployment?.evidence ?? null,
      serviceDeployment: independentServices?.evidence ?? { deployment: serviceDeployment },
      databasePath,
      projectDir,
      initialTaskIds: initialTasks.map((task) => task.task_id),
      reportProjectDir,
      experimentDir: experimentRoot,
      logRoot,
      inputMaterialId: null,
      inputMaterialHash: problem.source_hash,
      observationStore,
      closeStores,
      taskService,
      contextService,
      router,
      capabilityRegistry,
      mission,
      publicWorkspace,
      allowedAgentToolNames,
      judgeService,
      sandboxManager,
      cores,
      solvedAt: null,
      solvedBy: null,
      stopOnSolved: options.stopOnSolved === true,
      cleanupElapsedMs: null,
      cleanupErrors: [],
      heartbeatCount: 0,
      heartbeatErrorCount: 0,
      watchdogSweepCount: 0,
      watchdogRecoveryCount: 0,
      watchdogErrorCount: 0,
      executionTimeoutSweepCount: 0,
      executionTimeoutErrorCount: 0,
      schedulerStatusCount: 0,
      schedulerEvents: [],
      identityLoopEvents: [],
      identityLoops: [],
      identityLoopRuns: [],
      identityLoopErrors: [],
      unhandledRejections: [],
      identityLoopAbortController: null,
      unsubscribeTaskEvents: null,
      controllerEvents: [],
      controller: null,
      readyObservedAt: new Map(),
      waitEligibilityAt: new Map(),
      resourcesAtStart: resourceSnapshot(),
      repositoryCommit: options.repositoryCommit ?? null,
      repositoryWorktreeDirty: options.repositoryWorktreeDirty ?? null,
      parallelism,
      projectParallelism: options.projectParallelism ?? 1,
      missionId: mission.mission_id,
      workspaceId: publicWorkspace.workspace_id,
      missionWorkspace,
      missionSubmissionStore,
      modelAccess,
      taskCreateMutex,
      dynamicTaskEvents: [],
      botMaxMs: options.botMaxMs ?? flatExecutionTimeoutMs(options),
      selectionTimeoutMs: options.selectionTimeoutMs ?? Math.min(300_000, options.botMaxMs ?? flatExecutionTimeoutMs(options)),
      executionTimeoutMs: options.executionTimeoutMs ?? options.botMaxMs ?? flatExecutionTimeoutMs(options),
      handoffReminderMs: options.handoffReminderMs ?? flatHandoffReminderMs(options),
      normalFlow,
      readinessSamples: [],
    };
    projectState = state;
    const prior = await missionSubmissionStore.get({ missionId: mission.mission_id });
    acceptedMission ??= prior?.submissions.find(row => row.state === 'accepted') ?? null;
    if (acceptedMission) beginMissionCloseout(state, acceptedMission);
    return state;
  }
}

async function runProject(problem, config, options) {
  assertCurrentParallelConfiguration(options);
  if (!SAFE_PROJECT_ID.test(problem.id)) throw new TypeError(`unsafe problem id: ${problem.id}`);
  if (options.signal?.aborted) throw operatorStop();
  if ((options.timeboxMs ?? 60 * 60_000) > 0) {
    problem = { ...problem };
    config = { ...config };
    const verified = await verifyBenchmarkRunFixture({ root: config.putnam_bench_root, commit: config.putnambench_commit, problem })
      .catch(error => {
        if (options.signal?.aborted) throw operatorStop();
        throw new SwarmEnvError(ERROR_CODES.SERVICE_NOT_READY, 'Timed benchmarks require a verified committed fixture', {}, { cause: error });
      });
    validateProblemInput(problem, verified.source);
  }
  if (!Number.isFinite(options.cleanupGraceMs ?? 30_000) || (options.cleanupGraceMs ?? 30_000) <= 0) throw new TypeError('cleanupGraceMs must be finite and positive');
  const state = await createProjectState(problem, config, options);
  try { return await executeBenchmarkProject(state, problem, config, options); }
  finally {
    if (!state.cleanupPromise) await stopBenchmarkRuntime(state, { cleanupGraceMs: options.cleanupGraceMs ?? 30_000 });
    if (state.unhandledRejectionHandler) process.off('unhandledRejection', state.unhandledRejectionHandler);
    // Also owns exceptions during orchestration, report generation and write.
    // A timed-out join retains the store until all admitted work settles.
    await closeProjectStores(state, state.closeStores, options);
  }
}

export async function runBenchmarkProject(problem, config, options = {}) {
  try { return await runProject(problem, config, options); }
  catch (error) {
    if (error.code !== 'BENCHMARK_OPERATOR_STOPPED') throw error;
    return writeUnavailableProjectReport(problem, options, error, { operatorStopped: true });
  }
}

async function executeBenchmarkProject(state, problem, config, options) {
  const unhandledRejectionHandler = (reason) => {
    const record = {
      code: reason?.code ?? reason?.name ?? 'UNHANDLED_REJECTION',
      class: safeDiagnostic(reason?.message) ?? 'unhandled_rejection',
    };
    state.unhandledRejections.push(record);
    state.observationStore.append({
      experimentId: state.runId,
      source: 'runtime',
      kind: 'benchmark_unhandled_rejection',
      visibility: 'operator',
      payload: record,
    });
  };
  // A provider/session promise must not abort report generation. Keep this
  // handler scoped to this benchmark lifecycle and preserve the error as
  // explicit evidence; normal paths still attach their own catches.
  state.unhandledRejectionHandler = unhandledRejectionHandler;
  process.on('unhandledRejection', unhandledRejectionHandler);
  for (const core of state.cores) core.stateRef = state;
  state.controller = new TaskController({
    taskService: state.taskService,
    readPublicChangeToken: async () => ({
      tasks: state.taskService.publicChangeToken(state.missionId),
      materials: state.contextService.publicChangeToken(state.missionId),
      workspace: await state.missionWorkspace.publicChangeToken({ workspaceId: state.workspaceId }),
    }),
    listEligibleTasks: () => projectEligibleTasks(state, { limit: options.controllerShortlistLimit ?? 16 }),
    shortlistLimit: options.controllerShortlistLimit ?? 16,
    // The benchmark loop is already the bounded repair sweep. Keeping a
    // second five-second Controller timer would duplicate reconciliations and
    // wake attempts while the durable Task event path is quiet.
    sweepIntervalMs: options.controllerSweepIntervalMs ?? 0,
    listIdentityLoops: () => state.cores.map((core) => core.identityLoop?.snapshot?.() ?? {
      core_id: `core-${core.index}`,
      state: core.taskId ? 'RUNNING' : (core.turnInFlight || core.dispatchReserved ? 'TAKING' : 'IDLE'),
      healthy: !core.stopping,
    }),
    signalIdleIdentity: (_loop, payload) => {
      if (state.signal?.aborted) return;
      // This callback runs inside a Controller reconciliation pass.  The
      // general wake helper also asks the Controller to reconcile, which would
      // queue another pass from this callback and self-trigger on an OPEN
      // Task. Wake the selected identity loop directly; durable Task events and the
      // periodic sweep remain the Controller re-entry paths.
      const reason = payload.reason ?? 'controller_signal';
      state.identityWakeRequested = true;
      resolveIdentityWake?.();
      const target = state.identityLoops?.find((loop) => loop.coreId === payload.core_id);
      target?.notify?.(reason);
    },
    requestIdentityRecovery: async (loop, payload) => {
      const core = state.cores.find((candidate) => `core-${candidate.index}` === payload.core_id);
      if (core && !core.stopping) await core.runtime.restart().catch(() => undefined);
      state.controllerEvents.push({ kind: 'controller_identity_loop_recovery_requested', core_id: payload.core_id, reason: payload.reason ?? null, timestamp: Date.now() });
    },
    onEvent: (event) => {
      const sanitized = {
        kind: event.kind,
        core_id: event.core_id ?? null,
        task_id: event.task_id ?? null,
        reason: event.reason ?? null,
        block_reason: event.block_reason ?? null,
        eligible_count: event.eligible_count ?? null,
        blocked_count: event.blocked_count ?? null,
        healthy_identity_loop_count: event.healthy_loop_count ?? event.healthy_identity_loop_count ?? null,
        idle_identity_loop_count: event.idle_loop_count ?? event.idle_identity_loop_count ?? null,
        signaled_identity_loop_count: event.signaled_loop_count ?? event.signaled_identity_loop_count ?? null,
        recovery_requested_count: event.recovery_requested_count ?? null,
        repaired_task_count: event.repaired_task_count ?? null,
        take_count: event.take_count ?? null,
        timestamp: event.timestamp ?? Date.now(),
      };
      state.controllerEvents.push(sanitized);
      state.observationStore.append({ experimentId: state.runId, source: 'task-controller', kind: sanitized.kind, taskId: sanitized.task_id, coreId: sanitized.core_id, visibility: 'operator', payload: sanitized });
    },
  });
  state.controller.start();
  let resolveIdentityWake;
  let identityWake = new Promise((resolve) => { resolveIdentityWake = resolve; });
  state.identityWakeRequested = false;
  const startedAt = Date.now();
  state.parallelism.start(startedAt);
  recordReadinessSnapshot(state, startedAt);
  const durationMs = options.timeboxMs ?? 60 * 60_000;
  const deadline = state.runDeadlineAt;
  for (const core of state.cores) core.runtime?.setRunDeadline?.(deadline);
  const turnTimeoutMs = options.turnTimeoutMs ?? 9 * 60_000;
  // IdentityTaskLoop waits for the whole Runtime Execution to release after a
  // successful take. Keep that ownership deadline at least as long as the
  // durable Runtime deadline; a turn timeout is only the per-prompt bound.
  const executionTimeoutMs = state.executionTimeoutMs;
  const basePrompt = continuation;
  state.identityLoopEvents = state.identityLoopEvents ?? [];
  state.identityLoops = state.cores.map((core) => {
    const loop = new IdentityTaskLoop({
      coreId: `core-${core.index}`,
      firstDiscoveryAt: startedAt + (core.index - 1) * state.initialBotStaggerMs,
      // This is a bounded discovery prompt for the reusable identity, not a
      // old selection transport SOP.  The identity must call task_take itself.
      takePrompt: 'Runtime composes the current unbound Bot context at dispatch.',
      shortlistLimit: options.controllerShortlistLimit ?? 16,
      maxTakeAttempts: options.maxStartupAttempts ?? 3,
      maxTakeRescans: options.maxTakeRescans ?? 1,
      // Controller/task events wake an idle identity loop immediately.  Keep the
      // fallback long enough to be a repair path rather than a 10Hz empty
      // queue poll when an event source is quiet or unavailable.
      idleBackoffMs: options.identityLoopIdleBackoffMs ?? 5_000,
      taskService: state.taskService,
      listEligibleTasks: () => projectEligibleTasks(state, { limit: options.controllerShortlistLimit ?? 16 }),
      takeTask: ({ candidates, prompt }) => takeTaskWithAgent(core, candidates, prompt),
      runtime: core.runtime,
      runExecution: async (take) => {
        if (core.takeResult?.execution?.execution_id === take.execution.execution_id) {
          return { execution: state.taskService.getExecution(take.execution.execution_id) };
        }
        throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Core handoff requires its already-bound Bot take receipt');
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
        if (core.executionId === execution.execution_id) await core.bridge.releaseTake({ result });
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
          operation_id: event.operation_id ?? null,
          check_count: event.check_count ?? null,
          task_ids: event.task_ids ?? null,
          timestamp: event.timestamp ?? Date.now(),
        };
        state.identityLoopEvents.push(sanitized);
        if (sanitized.kind === 'identity_loop_take_conflict') {
          const conflictKey = [
            sanitized.core_id,
            sanitized.task_id,
            sanitized.reason,
            sanitized.rescan,
            sanitized.timestamp,
          ].join(':');
          state.parallelism.recordTakeConflict(event.operation_id ? `bridge:${event.operation_id}` : `identity:${conflictKey}`);
        }
        state.observationStore.append({
          experimentId: state.runId,
          source: 'identity-task-loop',
          kind: sanitized.kind,
          taskId: sanitized.task_id,
          executionId: sanitized.execution_id,
          coreId: sanitized.core_id,
          visibility: 'operator',
          payload: sanitized,
        });
        if (sanitized.kind === 'identity_loop_state_changed' && sanitized.changed === true && sanitized.state === 'IDLE' &&
          ['execution_released', 'runtime_failed', 'take_conflict'].includes(sanitized.reason)) {
          // The release event can arrive while IdentityTaskLoop is still inside its
          // handoff. Wake this identity loop once it has actually returned to IDLE,
          // then reconcile for durable projections. The direct wake avoids a
          // same-signature Controller signal being incorrectly deduplicated
          // after a fast handoff that the Controller never observed as RUNNING.
          queueMicrotask(() => {
            loop.notify('identity_loop_idle');
            void state.controller?.notify('identity_loop_idle').catch(() => undefined);
          });
        }
      },
    });
    core.identityLoop = loop;
    return loop;
  });
  state.requestIdentityWake = (reason = 'event') => {
    if (state.stopping || state.signal?.aborted) return;
    state.identityWakeRequested = true;
    resolveIdentityWake();
    void state.controller.notify(reason).catch(() => undefined);
  };
  state.unsubscribeTaskEvents = state.taskService.subscribeTaskEvents((event) => {
    // Task Service emits only after its mutation transaction commits. This is
    // the low-latency path; the Controller's periodic sweep remains the
    // repair path for missed notifications or a restarted process.
    // Hints request reconciliation; durable tokens suppress replayed hints
    // and also repair missed or cross-process publication notifications.
    state.requestIdentityWake(event?.kind ?? 'task_event');
  });
  // Compatibility metrics keep the old report field readable while the
  // production composition has no Scheduler instance or Scheduler decision
  // maker. Every value is derived from IdentityTaskLoop lifecycle counters.
  state.scheduler = { snapshot: () => ({
    ready_count: projectEligibleTasks(state, { limit: 100 }).length,
    dispatch_count: state.identityLoops.reduce((count, loop) => count + loop.snapshot().take_count, 0),
    startup_attempt_count: state.cores.reduce((count, candidate) => count + (candidate.sessionStartAttempts ?? 0), 0),
    startup_failure_count: state.cores.reduce((count, candidate) => count + (candidate.sessionStartFailures ?? 0), 0),
    bounded_startup_exhausted_count: state.identityLoops.filter((loop) => loop.snapshot().take_exhausted).length,
    duplicate_suppression_count: 0,
    dispatch_latencies_ms: [],
    in_flight_core_ids: state.identityLoops.filter((loop) => loop.snapshot().state !== 'IDLE').map((loop) => loop.coreId),
    stopped: state.identityLoops.every((loop) => loop.snapshot().stopped),
  }) };
  let operatorStoppedAt;
  const acceptedAndClosed = () => state.missionSubmissionStore.isAccepted(state.missionId) &&
    !state.cores.some(core => core.executionId && state.taskService.getExecution(core.executionId)?.state === 'RUNNING');
  const onOperatorStop = () => {
    const at = Date.now();
    if (at < Math.min(deadline, state.missionCloseoutDeadline ?? deadline) && !acceptedAndClosed()) {
      operatorStoppedAt = at;
    }
    state.stopping = true;
    for (const core of state.cores) core.stopping = true;
    state.identityLoopAbortController?.abort();
    for (const loop of state.identityLoops) loop.stop();
    resolveIdentityWake();
  };
  state.signal?.addEventListener('abort', onOperatorStop, { once: true });
  try {
    if (state.signal?.aborted) { onOperatorStop(); throw operatorStop(); }
    // Every configured Core enters discovery, including a zero-Task Mission.
    // Readiness is context for the Bot, not permission to start discovery.
    if (state.missionCloseoutDeadline === undefined) await withinRunDeadline(state, () => state.controller.reconcile({ reason: 'initial' }), deadline);
    // Each physical Core owns one long-lived identity loop supervisor. The
    // Controller only reconciles durable readiness and wakes these loops; it
    // never performs a selection or take itself.
    state.identityLoopAbortController = new AbortController();
    if (state.missionCloseoutDeadline !== undefined) { for (const loop of state.identityLoops) loop.stop(); state.identityLoopAbortController.abort(); }
    state.identityLoopRuns = state.identityLoops.map((loop) => {
      const run = loop.run({ signal: state.identityLoopAbortController.signal });
      // A provider/session boundary must never become an unhandled rejection
      // that aborts the benchmark before its bounded report and cleanup run.
      // Keep the failure visible in the report and let the Controller/runtime
      // continue or fence the affected Core through their normal repair paths.
      return run.catch((error) => {
        const record = {
          core_id: loop.coreId,
          code: error?.code ?? error?.name ?? 'IDENTITY_LOOP_ERROR',
          class: safeDiagnostic(error?.message) ?? 'identity_loop_error',
        };
        state.identityLoopErrors.push(record);
        state.observationStore.append({
          experimentId: state.runId,
          source: 'identity-task-loop',
          kind: 'identity_loop_error',
          coreId: loop.coreId,
          visibility: 'operator',
          payload: record,
        });
        return { disposition: 'error', error: record };
      });
    });
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
            if (recovered.length > 0) state.requestIdentityWake?.();
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
              state.requestIdentityWake?.();
            }
          }
        })
        .finally(() => {
          executionTimeoutSweepPromise = null;
        });
    }, options.executionTimeoutSweepMs ?? 10_000);
    try {
      while (!state.startupFailure && !state.signal?.aborted && Date.now() < Math.min(deadline, state.missionCloseoutDeadline ?? deadline)) {
        // Acceptance may precede wake wiring. Nothing can start after PASS;
        // if no activated Execution needs closeout, proceed directly to stop.
        if (acceptedAndClosed()) break;
        if (!state.identityWakeRequested) {
          await Promise.race([sleep(Math.max(0, Math.min(options.pollMs ?? 5_000, Math.min(deadline, state.missionCloseoutDeadline ?? deadline) - Date.now()))), identityWake]);
        }
        if (state.startupFailure || state.signal?.aborted) break;
        const reconcileReason = state.identityWakeRequested ? 'event' : 'poll';
        state.identityWakeRequested = false;
        identityWake = new Promise((resolve) => { resolveIdentityWake = resolve; });
        if (state.missionSubmissionStore.isAccepted(state.missionId)) {
          if (state.missionCloseoutDeadline === undefined) {
            const accepted = await withinRunDeadline(state, () => state.missionSubmissionStore.get({ missionId: state.missionId }), deadline);
            if (state.signal?.aborted) break;
            beginMissionCloseout(state, accepted.submissions.find(row => row.state === 'accepted'));
          }
          const remaining = Math.min(deadline, state.missionCloseoutDeadline) - Date.now();
          if (state.agentMode === 'solver') {
            for (const core of state.cores) if (core.executionId && state.taskService.getExecution(core.executionId)?.state === 'RUNNING') {
              await finishSolverTask(state, core);
            }
          }
          const active = state.cores.filter(core => core.executionId && state.taskService.getExecution(core.executionId)?.state === 'RUNNING');
          if (!active.length || remaining <= 0) break;
          for (const core of active) if (!core.turnInFlight && !core.recoveryInFlight) {
            scheduleTurn(core, continuation(core), Math.min(turnTimeoutMs, remaining));
          }
          continue;
        }
        const readyStartedAt = Date.now();
        const readyTasks = projectTasks(state, {
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
          if (state.solvedAt === null) await withinRunDeadline(state, () => releaseTerminalExecution(core), deadline);
        }
        // The Controller owns reconciliation and signals each idle identity loop;
        // each long-lived identity loop owns its bounded take/take loop. The
        // main loop is only the periodic repair and observability sweep.
        await withinRunDeadline(state, () => state.controller.reconcile({ reason: reconcileReason }), deadline);
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
      state.backgroundStopPromises = [...(state.backgroundStopPromises ?? []), executionTimeoutSweepPromise, ...state.cores.map(core => core.watchdogPromise)].filter(Boolean);
    }
  } catch (error) {
    if (!['BENCHMARK_TIMEBOX_EXPIRED', 'BENCHMARK_OPERATOR_STOPPED'].includes(error.code)) throw error;
  } finally {
    state.signal?.removeEventListener('abort', onOperatorStop);
    state.operatorStopped = operatorStoppedAt !== undefined;
    await stopBenchmarkRuntime(state, { cleanupGraceMs: options.cleanupGraceMs ?? 30_000 });
  }
  const report = projectReport(state, startedAt, deadline);
  report.model_budget = state.modelAccess?.evidence() ?? null;
  // Reporting must not invent a submission or convert source diagnostics into
  // Mission acceptance. Only expose a submission already owned by its service.
  const submission = await settleBy(state.missionSubmissionStore.get({ missionId: state.missionId }), state.cleanupDeadline);
  report.mission_submission = submission.status === 'fulfilled' ? submission.value : null;
  if (submission.status !== 'fulfilled') {
    report.run.cleanup_errors.push({ code: 'MISSION_RESULT_READ_PENDING', class: 'mission_result_read_pending' });
    report.audit.invalid = true;
    report.run.protocol_valid = false;
    report.audit.invalid_reasons.push('cleanup_pending');
  }
  if (state.startupFailure) {
    report.run.startup_failure = state.startupFailure;
    report.run.protocol_valid = false;
    report.run.stop_reason = 'bot_startup_contract';
    report.run.deadline_reached = false;
    report.run.ended_early = true;
    report.audit.invalid = true;
    report.audit.invalid_reasons.push('bot_startup_contract');
  }
  if (state.operatorStopped) {
    report.run.protocol_valid = false;
    report.run.stop_reason = 'operator_stop';
    report.run.deadline_reached = false;
    report.run.ended_early = true;
    report.audit.invalid = true;
    report.audit.invalid_reasons.push('operator_stop');
  }
  state.observationStore.append({
    experimentId: state.runId,
    source: 'runtime',
    kind: 'experiment_finished',
    taskId: null,
    payload: { solved: report.run.solved, protocol_valid: report.run.protocol_valid, made_progress: report.run.made_progress },
  });
  state.observationStore.finishExperiment(state.runId, { status: report.run.solved && !state.operatorStopped && !state.startupFailure ? 'SUCCEEDED' : 'FINISHED' });
  await writeFile(join(state.reportProjectDir, 'report.json'), JSON.stringify(report, null, 2));
  return report;
}

export async function writeUnavailableProjectReport(problem, options, error, { operatorStopped = false } = {}) {
  const parallelism = new CoreParallelismTracker({ coreCount: options.agentMode === 'solver' ? 1 : 4, startedAt: 0 }).snapshot({ endedAt: 0 });
  const report = {
    schema_version: 1,
    protocol: {
      project_isolation: true,
      core_count: options.agentMode === 'solver' ? 1 : 4,
      initial_bot_stagger_ms: options.initialBotStaggerMs ?? 0,
      project_parallelism: options.projectParallelism ?? 1,
      task_model: 'flat',
      input_policy: 'pinned formalization only; no candidate or solution input',
      tool_policy: 'Pi read/write/edit/bash; services through authenticated swarm CLI; ambient extensions, skills, prompt templates and project context discovery disabled',
      cheating_policy: 'A recorded forbidden candidate placeholder or tool event outside read/write/edit/bash invalidates the project; ordinary project diagnostics do not establish a policy violation',
    },
    parallelism,
    project: { problem_id: problem.id, source_hash: problem.source_hash ?? null },
    run: {
      protocol_valid: false,
      made_progress: false,
      progress_evidence: { proposed_task_count: 0, workspace_write_count: 0, meaningful_material_count: 0, candidate_check_count: 0 },
      solved: false,
      ended_early: operatorStopped,
      ...(operatorStopped ? { stop_reason: 'operator_stop', cleanup_errors: error.cleanupErrors ?? [] } : {}),
      elapsed_ms: null,
      deadline_reached: false,
      cleanup_elapsed_ms: null,
    },
    audit: { invalid: true, invalid_reasons: [operatorStopped ? 'operator_stop' : 'project_runner_error',
      ...(error.cleanupErrors?.length ? ['cleanup_pending'] : [])], raw_transcript_exported: false, proof_contents_exported: false },
    error: { code: operatorStopped ? 'BENCHMARK_OPERATOR_STOPPED' : error.code ?? error.name, class: operatorStopped ? 'operator_stop' : safeDiagnostic(error.message) ?? 'project_runner_error' },
  };
  validateBenchmarkReport(report);
  const projectDir = join(resolve(options.reportDir ?? options.experimentDir), options.agentMode === 'solver' ? `${problem.id}-attempt-${options.attemptIndex}` : problem.id);
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, 'report.json'), JSON.stringify(report, null, 2));
  return report;
}

export async function runBenchmarkBatch(problems, config, options = {}) {
  assertCurrentParallelConfiguration(options);
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
        reports[index] = await writeUnavailableProjectReport(problems[index], options, error);
      }
    }
  }
  const workers = await Promise.allSettled(Array.from({ length: concurrency }, () => worker()));
  const failure = workers.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  return reports;
}

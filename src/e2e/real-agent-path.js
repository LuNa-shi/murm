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
import { agentCheckResult } from '../judge/check-result.js';
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

function positiveInteger(value) {
  if (!present(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
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

function promptForCandidates({ firstCandidate }) {
  return [
    'You are running one continuous SwarmEnv proof Execution.',
    'Use the named SwarmEnv Service tools for every Task, Execution, Material, Workspace, and candidate operation.',
    'First call get_task and get_execution so you work against the current versions.',
    'Publish the first source below as one artifact Material with kind=artifact and scope=proof_relevant, then call submit_candidate with its material_id.',
    'The first candidate is intentionally invalid. The submit_candidate result is synchronous and authoritative. Read the returned CheckResult, including its diagnostic, before doing anything else.',
    'When the result is a source_failure, use its diagnostic to make a repaired candidate in this same Agent turn. Publish the revised source as a second artifact Material with kind=artifact and scope=proof_relevant, set supersedes to the first material_id, and call submit_candidate again.',
    'Do not call request_wait. Do not stop after the first source failure. Finish only after the revised candidate submission.',
    'First candidate source:',
    firstCandidate,
  ].join('\n');
}

// A real-Agent report is an operator-facing acceptance artifact.  Keep its
// identity, lifecycle, hashes, and bounded checker classification, but never
// copy the private Task/Execution prompt, Material content, or canonical
// CheckResult evidence into it.
function reportCheckResult(result) {
  const projected = agentCheckResult(result);
  if (!projected) return null;
  const fields = [
    'check_result_id', 'request_key', 'candidate_material_id', 'target_task_id',
    'execution_id', 'status', 'verdict', 'judge_operation_status', 'checker_ref',
    'checker_version', 'environment_ref', 'checker_process_status', 'checker_started',
    'result_class', 'mathematical_outcome', 'retryable', 'diagnostic_code',
    'diagnostic_location', 'process_evidence', 'preflight_key', 'preflight_status',
    'preflight_verified', 'input_binding_verified', 'toolchain_version_verified',
    'checker_ref_verified', 'checker_version_verified', 'checker_identity_verified',
    'health_fingerprint', 'infrastructure_attempt_count', 'retry_exhausted',
  ];
  return Object.fromEntries(fields.map((field) => [field, projected[field] ?? null]));
}

function reportMaterial(material) {
  if (!material) return null;
  return {
    material_id: material.material_id ?? null,
    kind: material.kind ?? null,
    scope: material.scope ?? null,
    evidence_state: material.evidence_state ?? null,
    content_ref: material.content_ref ?? null,
    content_hash: material.content_hash ?? null,
    version: material.version ?? null,
    source_task: material.source_task ?? null,
    source_execution: material.source_execution ?? null,
    supersedes: material.supersedes ?? null,
    created_at: material.created_at ?? null,
  };
}

function reportTask(task) {
  if (!task) return null;
  return {
    task_id: task.task_id ?? null,
    root_id: task.root_id ?? null,
    parent_id: task.parent_id ?? null,
    owner_ref: task.owner_ref ?? null,
    task_type: task.task_type ?? null,
    task_type_version: task.task_type_version ?? null,
    state: task.state ?? null,
    state_version: task.state_version ?? null,
    spec_version: task.spec_version ?? null,
    spec_hash: task.spec_hash ?? null,
    goal: task.goal ?? null,
    expected_output: task.expected_output ?? null,
    acceptance_conditions: task.acceptance_conditions ?? null,
    completion_contract: task.completion_contract ?? null,
    input_material_refs: task.input_material_refs ?? [],
    priority: task.priority ?? null,
    parallel_quota: task.parallel_quota ?? null,
    max_depth: task.max_depth ?? null,
    max_children: task.max_children ?? null,
    max_attempts: task.max_attempts ?? null,
    block_reason: task.block_reason ?? null,
    created_at: task.created_at ?? null,
    updated_at: task.updated_at ?? null,
  };
}

function reportExecution(execution) {
  if (!execution) return null;
  const selection = execution.workspace_selection ?? {};
  return {
    execution_id: execution.execution_id ?? null,
    task_id: execution.task_id ?? null,
    owner_ref: execution.owner_ref ?? null,
    state: execution.state ?? null,
    state_version: execution.state_version ?? null,
    attempt_no: execution.attempt_no ?? null,
    fencing_version: execution.fencing_version ?? null,
    runtime_generation: execution.runtime_generation ?? null,
    spec_version: execution.spec_version ?? null,
    spec_hash: execution.spec_hash ?? null,
    workspace_manifest_ref: execution.workspace_manifest_ref ?? null,
    workspace_ref: execution.workspace_ref ?? null,
    workspace_revision: execution.workspace_revision ?? null,
    workspace_content_hash: execution.workspace_content_hash ?? null,
    input_snapshot_hash: execution.input_snapshot_hash ?? null,
    checkpoint_ref: execution.checkpoint_ref ?? null,
    checkpoint_hash: execution.checkpoint_hash ?? null,
    instruction_version: execution.instruction_version ?? null,
    workspace_selection: {
      mode: selection.mode ?? null,
      revision: selection.revision ?? null,
      source_execution_id: selection.source_execution_id ?? null,
      source_workspace_ref: selection.source_workspace_ref ?? null,
    },
    wait_condition_type: execution.wait_condition?.type ?? null,
    wait_deadline: execution.wait_deadline ?? null,
    created_at: execution.created_at ?? null,
    updated_at: execution.updated_at ?? null,
  };
}

function reportWorkspace(workspace) {
  if (!workspace) return null;
  return {
    workspace_ref: workspace.workspace_ref ?? null,
    workspace_revision: workspace.workspace_revision ?? null,
    content_hash: workspace.content_hash ?? null,
    execution_id: workspace.execution_id ?? null,
    fencing_version: workspace.fencing_version ?? null,
    parent_workspace_ref: workspace.parent_workspace_ref ?? null,
    parent_workspace_revision: workspace.parent_workspace_revision ?? null,
    changed_files: Array.isArray(workspace.changed_files) ? [...workspace.changed_files] : [],
    file_count: workspace.files && typeof workspace.files === 'object' ? Object.keys(workspace.files).length : null,
  };
}

function reportManifest(manifest) {
  if (!manifest) return null;
  return {
    pi_package: manifest.pi_package ?? null,
    pi_version: manifest.pi_version ?? null,
    nurouter_version: manifest.nurouter_version ?? null,
    node_version: manifest.node_version ?? null,
  };
}

function reportFixture(fixture) {
  if (!fixture) return null;
  return {
    fixture_id: fixture.fixture_id ?? null,
    putnambench_commit: fixture.putnambench_commit ?? null,
    problem_file: fixture.problem_file ?? null,
    problem_file_hash: fixture.problem_file_hash ?? null,
    lean_toolchain: fixture.lean_toolchain ?? null,
    mathlib_version: fixture.mathlib_version ?? null,
    checker_ref: fixture.checker_ref ?? null,
    checker_version: fixture.checker_version ?? null,
    environment_ref: fixture.environment_ref ?? null,
    project_root: fixture.project_root ?? null,
  };
}

function reportError(error) {
  const message = String(error?.message ?? error);
  const messageClass = /timed out|timeout/i.test(message)
    ? 'timeout'
    : /process|spawn|session/i.test(message)
      ? 'agent_process_error'
      : /source_failure|PASS|CheckResult|candidate/i.test(message)
        ? 'candidate_flow_error'
        : 'real_agent_path_error';
  return {
    code: error?.code ?? error?.name ?? 'Error',
    message_class: messageClass,
  };
}

function realReportKeyViolations(value, path = 'report', violations = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => realReportKeyViolations(item, `${path}[${index}]`, violations));
    return violations;
  }
  if (!value || typeof value !== 'object') return violations;
  const forbiddenKeys = new Set([
    'formal_source', 'candidate_content', 'proof_text', 'raw_transcript',
    'stdout', 'stderr', 'agent_prompt', 'task_instructions', 'content',
    'diagnostic_excerpt',
  ]);
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKeys.has(key)) violations.push(`${path}.${key}`);
    realReportKeyViolations(child, `${path}.${key}`, violations);
  }
  return violations;
}

export function validateRealAgentReport(report) {
  const violations = realReportKeyViolations(report);
  if (violations.length > 0) throw new TypeError(`real-agent report contains private fields: ${violations.join(', ')}`);
  return true;
}

function toolOperation(record) {
  const name = record?.toolName ?? record?.tool_name ?? record?.name ?? null;
  if (typeof name !== 'string') return null;
  if (name === 'swarmenv_call') {
    const payload = recordPayload(record);
    return typeof payload?.operation === 'string' ? payload.operation : name;
  }
  const operation = name.replace(/^swarmenv_/, '');
  // Pi's named-tool events carry the service prefix (for example
  // `judge_submit_candidate`), while the bridge RPC carries the registered
  // operation (`submit_candidate`). Normalize both forms before correlating
  // a tool result with its candidate submission.
  if (operation.endsWith('_submit_candidate')) return 'submit_candidate';
  if (operation.endsWith('_get_check_result')) return 'get_check_result';
  return operation;
}

function recordPayload(record) {
  const raw = record?.arguments ?? record?.args ?? record?.params ?? record?.input ?? null;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return raw;
}

function lineAt(source, lineNumber) {
  if (typeof source !== 'string' || !Number.isInteger(lineNumber) || lineNumber < 1) return null;
  return source.split(/\r?\n/)[lineNumber - 1] ?? null;
}

function candidateIdFromRecord(record) {
  const raw = recordPayload(record);
  const payload = raw?.payload ?? raw;
  return payload && typeof payload === 'object' ? payload.candidate_material_id ?? null : null;
}

function checkResultFromRecord(record) {
  const pending = [record?.result, record?.details, record?.data, record?.content];
  while (pending.length > 0) {
    const value = pending.shift();
    if (typeof value === 'string') {
      try { pending.push(JSON.parse(value)); } catch { /* tool text may be non-JSON */ }
      continue;
    }
    if (!value || typeof value !== 'object') continue;
    const result = value.check_result;
    if (result && typeof result === 'object') return result;
    if (Array.isArray(value)) {
      pending.push(...value);
    } else {
      pending.push(value.result, value.details, value.data, value.content, value.text);
    }
  }
  return null;
}

export function summarizeFeedbackTrace(records, { sessionId = null } = {}) {
  const events = records
    .filter((record) => ['tool_call', 'tool_result', 'tool_execution_start', 'tool_execution_end'].includes(record?.type))
    .map((record) => {
      const type = ['tool_call', 'tool_execution_start'].includes(record.type) ? 'tool_call' : 'tool_result';
      const checkResult = type === 'tool_result' ? checkResultFromRecord(record) : null;
      return {
        type,
        raw_type: record.type,
        session_id: sessionId,
        operation: toolOperation(record),
        candidate_material_id: type === 'tool_call' ? candidateIdFromRecord(record) : null,
        result_class: checkResult?.result_class ?? null,
        checker_process_status: checkResult?.checker_process_status ?? null,
        check_result_id: checkResult?.check_result_id ?? null,
        diagnostic_code: checkResult?.diagnostic_code ?? null,
        diagnostic_location: checkResult?.diagnostic_location ?? null,
        diagnostic_excerpt_present: typeof checkResult?.diagnostic_excerpt === 'string' && checkResult.diagnostic_excerpt.length > 0,
      };
    });
  let pendingCandidate = null;
  for (const event of events) {
    if (event.type === 'tool_call' && event.operation === 'submit_candidate') {
      pendingCandidate = event;
      continue;
    }
    if (event.type === 'tool_result' && pendingCandidate) {
      event.operation = 'submit_candidate';
      event.candidate_material_id ??= pendingCandidate.candidate_material_id;
      event.feedback_for_candidate = true;
      pendingCandidate = null;
    }
  }
  const firstFailureIndex = events.findIndex((event) => event.type === 'tool_result' && event.feedback_for_candidate === true && event.operation === 'submit_candidate' && event.result_class === 'source_failure');
  const revisionIndex = firstFailureIndex < 0
    ? -1
    : events.findIndex((event, index) => index > firstFailureIndex && event.type === 'tool_call' && event.operation === 'submit_candidate');
  const firstFailureEvent = firstFailureIndex >= 0 ? events[firstFailureIndex] : null;
  const revisionEvent = revisionIndex >= 0 ? events[revisionIndex] : null;
  return {
    events,
    first_source_failure_result_delivered: firstFailureIndex >= 0,
    first_source_failure_diagnostic_delivered: firstFailureIndex >= 0 && events[firstFailureIndex].diagnostic_excerpt_present === true,
    revision_submission_after_feedback: revisionIndex > firstFailureIndex,
    first_failure_event_index: firstFailureIndex >= 0 ? firstFailureIndex : null,
    revision_submission_event_index: revisionIndex >= 0 ? revisionIndex : null,
    first_failure_candidate_id: firstFailureEvent?.candidate_material_id ?? null,
    revision_candidate_id: revisionEvent?.candidate_material_id ?? null,
    first_failure_diagnostic_location: firstFailureEvent?.diagnostic_location ?? null,
  };
}

async function runAgentTurn(session, { timeoutMs = 180_000 } = {}) {
  await session.waitForReady({ timeoutMs: 15_000 });
  // Runtime sends the Execution's initial agent_prompt as part of
  // startExecution. Wait for that one turn; do not inject a second prompt
  // while the bound Session is working. The initial prompt itself contains
  // the controlled first candidate and asks the Agent to revise from the
  // synchronous CheckResult.
  let settled;
  try {
    settled = await session.waitForSettled({ timeoutMs, afterSequence: 0 });
  } catch (error) {
    // A candidate result can synchronously move the Execution to WAITING or
    // a terminal state. Runtime then intentionally stops this Session before
    // Pi emits agent_settled; that is a successful turn handoff, not a
    // provider/process failure.
    if (!session.expectedStop) throw error;
    settled = { type: 'agent_settled', expected_stop: true };
  }
  const records = session.rpcRecords;
  return {
    response_disposition: null,
    settled: {
      type: settled?.type ?? null,
      expected_stop: Boolean(settled?.expected_stop),
    },
    rpc_records: records.map((record) => record.type),
    feedback_trace: summarizeFeedbackTrace(records, { sessionId: session.sessionId ?? null }),
  };
}

function checkRequest({ task, execution, workspace, fixtureManifest, material, requestKey }) {
  return {
    request_key: requestKey,
    candidate_material_id: material.material_id,
    target_task_id: task.task_id,
    target_spec_version: task.spec_version,
    input_snapshot_hash: workspace.input_snapshot_hash,
    checker_ref: fixtureManifest.checker_ref,
    checker_version: fixtureManifest.checker_version,
    environment_ref: fixtureManifest.environment_ref,
    execution_id: execution.execution_id,
    state_version: execution.state_version,
    candidate: { material_id: material.material_id, content: material.content },
    target_task: task,
    workspace,
    fixture_manifest: fixtureManifest,
  };
}

export async function runRealAgentPath({
  database = ':memory:',
  rootDir,
  fixtureManifest,
  firstCandidate = null,
  env = process.env,
  command = null,
  timeoutMs = 180_000,
} = {}) {
  const probe = await probeRealAgentConfig({ env });
  const report = {
    mode: 'real-agent',
    status: probe.status === 'READY_TO_LAUNCH' ? 'RUNNING' : probe.status,
    probe,
    experiment: {
      implementation_commit: env.SWARMENV_IMPLEMENTATION_COMMIT ?? null,
      worktree_dirty: env.SWARMENV_WORKTREE_DIRTY === 'true'
        ? true
        : env.SWARMENV_WORKTREE_DIRTY === 'false'
          ? false
          : null,
      provider: env.NUROUTER_PI_PROVIDER ?? null,
      model: env.NUROUTER_PI_MODEL ?? null,
      core_count: 1,
      timebox_ms: positiveInteger(env.SWARMENV_TIMEBOX_MS),
      agent_turn_timeout_ms: timeoutMs,
      worktree_status: env.SWARMENV_WORKTREE_STATUS ?? null,
      putnambench_commit: fixtureManifest?.putnambench_commit ?? null,
      fixture_id: fixtureManifest?.fixture_id ?? null,
      lean_project_root: env.SWARMENV_PUTNAMBENCH_ROOT ?? fixtureManifest?.project_root ?? null,
    },
    task_id: null,
    execution_id: null,
    material_ids: [],
    check_result_ids: [],
    secret_values_recorded: false,
  };
  if (probe.status !== 'READY_TO_LAUNCH') {
    report.reason = 'Real Agent Core cannot run until the local Lean/Lake toolchain and NuRouter/Pi routing configuration are available.';
    validateRealAgentReport(report);
    return report;
  }
  if (!rootDir || !firstCandidate) {
    report.status = 'FAILED_TO_LAUNCH';
    report.reason = 'real-agent path requires rootDir and firstCandidate';
    validateRealAgentReport(report);
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
  taskService.setCheckerHealthReader((preflightKey) => judgeService.getCheckerPreflight(preflightKey));
  const router = new ServicesRouter({ taskService, contextService, judgeService });
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
  const candidatePrompt = promptForCandidates({ firstCandidate });
  const claimed = ownerSdk.withContext({ actorRef: 'agent:real', taskId: task.task_id, specVersion: task.spec_version, stateVersion: task.state_version }).claim({
    execution_id: executionId, claim_key: `real:claim:${executionId}`, owner_ref: 'agent:real',
    agent_prompt: candidatePrompt, input_material_refs: [],
  }, { operationId: 'real:claim' });
  report.task_id = task.task_id;
  report.execution_id = executionId;
  report.claim = {
    execution_id: claimed.execution.execution_id,
    state_version: claimed.execution.state_version,
    fencing_version: claimed.execution.fencing_version,
  };

  const childEnv = { ...env };
  const launchCommand = command ?? (env.NUROUTER_PI_PROVIDER === 'openai-codex' ? 'pi' : 'nurouter');
  const adapter = new AgentCoreAdapter({
    command: launchCommand,
    provider: env.NUROUTER_PI_PROVIDER,
    model: env.NUROUTER_PI_MODEL,
    account: env.NUROUTER_PI_ACCOUNT,
    group: env.NUROUTER_PI_GROUP,
    extensionPath,
    env: childEnv,
  });
  const runtimeLifecycleEvents = [];
  const runtime = new Runtime({
    taskService,
    contextService,
    workspaceManager: new WorkspaceManager({ rootDir }),
    agentAdapter: adapter,
    actorRef: 'runtime:local',
    logger: {
      append(event = {}) {
        if (!['runtime.request_wait', 'runtime.wake_execution', 'runtime.resume_execution'].includes(event.event)) return;
        if (event.execution_id !== executionId) return;
        runtimeLifecycleEvents.push({
          sequence: runtimeLifecycleEvents.length,
          event: event.event,
          execution_id: event.execution_id,
          wait_condition_type: event.wait_condition?.type ?? null,
          created_at: new Date().toISOString(),
        });
      },
    },
  });
  let bridge;
  const checkHistory = [];
  const checkAttempts = new Map();
  let candidateSubmission = Promise.resolve();
  const submitCandidate = async ({ taskId, executionId: submittedExecutionId, payload }) => {
    const currentTask = taskService.getTask(taskId);
    const currentExecution = taskService.getExecution(submittedExecutionId);
    const material = contextService.getMaterial(payload.candidate_material_id);
    if (!currentTask || !currentExecution || !material || typeof material.content !== 'string') {
      throw new Error('real-agent candidate submission has no checkable Material or Execution');
    }
    const workspaceMetadata = await runtime.getWorkspace(submittedExecutionId);
    const workspace = {
      task_id: taskId,
      execution_id: submittedExecutionId,
      input_snapshot_hash: currentExecution.input_snapshot_hash,
      workspace_ref: workspaceMetadata.workspace?.workspace_ref ?? currentExecution.workspace_ref,
      workspace_revision: workspaceMetadata.workspace?.workspace_revision ?? currentExecution.workspace_revision,
    };
    const attempt = (checkAttempts.get(material.material_id) ?? 0) + 1;
    checkAttempts.set(material.material_id, attempt);
    const requestKey = `real:check:${material.material_id}:${attempt}`;
    const result = await judgeService.judgeCandidate(checkRequest({
      task: currentTask,
      execution: currentExecution,
      workspace,
      fixtureManifest: lockedFixture,
      material,
      requestKey,
    }));
    const fresh = taskService.getExecution(submittedExecutionId);
    let applied = ownerSdk.withContext({
      taskId,
      executionId: submittedExecutionId,
      specVersion: fresh.spec_version,
      stateVersion: fresh.state_version,
      fencingVersion: fresh.fencing_version,
    }).applyCheckResult({ check_result_id: result.check_result_id }, { operationId: `real:apply:${material.material_id}:${attempt}` });
    const retryableInfrastructure = result.result_class === 'infrastructure_failure' && result.retryable && !result.evidence?.retry_exhausted;
    let deferredWait = null;
    if (retryableInfrastructure) {
      const preflight = judgeService.getCheckerPreflight(result.evidence?.preflight_key);
      if (!preflight?.health_fingerprint) throw new Error('real-agent retryable checker failure has no preflight fingerprint');
      deferredWait = {
        waitCondition: {
          type: 'checker_health',
          preflight_key: result.evidence.preflight_key,
          health_fingerprint: preflight.health_fingerprint,
          diagnostic_code: result.diagnostic_code,
          candidate_material_id: material.material_id,
        },
        checkpoint: {
          phase: 'checker_unavailable',
          candidate_material_id: material.material_id,
          check_result_id: result.check_result_id,
        },
      };
    }
    const record = { material_id: material.material_id, result: taskService.getCheckResult(result.check_result_id), applied };
    record.lifecycle_event_count_before = runtimeLifecycleEvents.length;
    checkHistory.push(record);
    record.lifecycle_event_count_after = runtimeLifecycleEvents.length;
    return {
      // Keep the synchronous tool response consistent with the durable Judge
      // read route after TaskService applies the result.
      check_result: agentCheckResult(taskService.getCheckResult(result.check_result_id)),
      applied,
      ...(deferredWait ? { deferred_wait: deferredWait } : {}),
    };
  };
  const onSubmitCandidate = (args) => {
    candidateSubmission = submitCandidate(args);
    return candidateSubmission;
  };
  bridge = new ServicesBridge({
    taskService,
    contextService,
    runtime,
    router,
    taskId: task.task_id,
    executionId,
    onSubmitCandidate,
    onRelease: async () => {
      // ServicesBridge clears its own binding before invoking this hook. The
      // callback is present so this path has the same explicit release seam as
      // the benchmark runner.
    },
  });
  let firstRun;
  let firstResult;
  let secondResult;
  let firstApplied;
  let secondApplied;
  try {
    Object.assign(childEnv, await bridge.start());
    firstRun = await runtime.startExecution(executionId);
    report.launch = { workspace_ref: firstRun.execution.workspace_ref, runtime_manifest: reportManifest(firstRun.session.manifest) };
    report.agent_flow = await runAgentTurn(firstRun.session, { timeoutMs });
    report.first_agent = report.agent_flow;
    report.second_agent = null;
    await candidateSubmission;
    const firstRecord = checkHistory[0];
    const secondRecord = checkHistory[1];
    const firstMaterial = firstRecord ? contextService.getMaterial(firstRecord.material_id) : null;
    if (!firstMaterial) throw new Error('real Agent did not publish a first artifact Material through Services SDK');
    report.material_ids.push(firstMaterial.material_id);
    ({ result: firstResult, applied: firstApplied } = firstRecord ?? {});
    if (!firstResult || !firstApplied) throw new Error('real Agent candidate submission did not return a CheckResult');
    report.check_result_ids.push(firstResult.check_result_id);
    report.failure_evidence = reportCheckResult(firstResult);
    if (firstResult.result_class !== 'source_failure') throw new Error(`real Agent first candidate expected source-level FAIL, got ${firstResult.result_class}`);
    if (firstApplied.execution.state !== 'RUNNING') throw new Error(`real Agent source-level failure changed Execution state to ${firstApplied.execution.state}`);
    if (!secondRecord) throw new Error('real Agent did not submit a repair candidate after receiving the first CheckResult');
    const secondMaterial = contextService.getMaterial(secondRecord.material_id);
    if (!secondMaterial) throw new Error('real Agent did not publish a superseding artifact Material through Services SDK');
    if (secondMaterial.supersedes !== firstMaterial.material_id) throw new Error('real Agent fixed candidate did not supersede the failed artifact');
    report.material_ids.push(secondMaterial.material_id);
    ({ result: secondResult, applied: secondApplied } = secondRecord);
    if (!secondResult || !secondApplied) throw new Error('real Agent fixed candidate did not return a CheckResult');
    if (secondResult.result_class !== 'PASS') throw new Error(`real Agent repair candidate returned ${secondResult.result_class}`);
    if (!report.agent_flow.feedback_trace.first_source_failure_result_delivered
      || !report.agent_flow.feedback_trace.first_source_failure_diagnostic_delivered
      || !report.agent_flow.feedback_trace.revision_submission_after_feedback) {
      throw new Error('real Agent repair did not follow delivery of the first source-level CheckResult');
    }
    const feedbackTrace = report.agent_flow.feedback_trace;
    const firstDiagnosticLocation = feedbackTrace.first_failure_diagnostic_location ?? reportCheckResult(firstResult)?.diagnostic_location;
    const firstDiagnosticLine = lineAt(firstMaterial.content, firstDiagnosticLocation?.line);
    const revisedDiagnosticLine = lineAt(secondMaterial.content, firstDiagnosticLocation?.line);
    const revisionMaterialChangedDiagnosticLocation = firstDiagnosticLine !== null
      && revisedDiagnosticLine !== null
      && firstDiagnosticLine !== revisedDiagnosticLine;
    const feedbackConsumptionEvidence = {
      diagnostic_delivered: feedbackTrace.first_source_failure_diagnostic_delivered,
      revision_after_delivery: feedbackTrace.revision_submission_after_feedback,
      failed_candidate_correlated: feedbackTrace.first_failure_candidate_id === firstMaterial.material_id,
      revision_candidate_correlated: feedbackTrace.revision_candidate_id === secondMaterial.material_id,
      revision_material_supersedes_failed_candidate: secondMaterial.supersedes === firstMaterial.material_id,
      revision_material_changed: firstMaterial.content_hash !== secondMaterial.content_hash,
      diagnostic_location: firstDiagnosticLocation,
      revision_changed_diagnostic_location: revisionMaterialChangedDiagnosticLocation,
    };
    if (!feedbackConsumptionEvidence.failed_candidate_correlated
      || !feedbackConsumptionEvidence.revision_candidate_correlated
      || !feedbackConsumptionEvidence.revision_material_supersedes_failed_candidate
      || !feedbackConsumptionEvidence.revision_material_changed
      || !feedbackConsumptionEvidence.revision_changed_diagnostic_location) {
      throw new Error('real Agent repair evidence did not correlate the diagnostic with the revised candidate');
    }
    const lifecycleEvents = runtimeLifecycleEvents.map((event) => ({ ...event }));
    const lifecycleEventsBetweenCandidates = runtimeLifecycleEvents
      .slice(firstRecord.lifecycle_event_count_after, secondRecord.lifecycle_event_count_before)
      .map((event) => ({ ...event }));
    const candidateSessionIds = new Set(report.agent_flow.feedback_trace.events
      .filter((event) => event.operation === 'submit_candidate' && event.session_id)
      .map((event) => event.session_id));
    const sameAgentSession = candidateSessionIds.size === 1 && candidateSessionIds.has(firstRun.session.sessionId ?? null);
    report.feedback_handoff = {
      same_agent_session: sameAgentSession,
      same_execution: firstApplied.execution.execution_id === secondApplied.execution.execution_id,
      source_failure_execution_state: firstApplied.execution.state,
      wait_between_candidates: lifecycleEventsBetweenCandidates.length > 0,
      lifecycle_events: lifecycleEvents,
      lifecycle_events_between_candidates: lifecycleEventsBetweenCandidates,
      session_id: firstRun.session.sessionId ?? null,
      first_check_result_id: firstResult.check_result_id,
      second_check_result_id: secondResult.check_result_id,
      first_result_delivered_before_revision: report.agent_flow.feedback_trace.revision_submission_after_feedback,
      first_diagnostic_delivered: report.agent_flow.feedback_trace.first_source_failure_diagnostic_delivered,
      first_failure_candidate_id: feedbackTrace.first_failure_candidate_id,
      revision_candidate_id: feedbackTrace.revision_candidate_id,
      revision_material_changed: firstMaterial.content_hash !== secondMaterial.content_hash,
      revision_changed_diagnostic_location: revisionMaterialChangedDiagnosticLocation,
      feedback_consumption_evidence: feedbackConsumptionEvidence,
    };
    if (!report.feedback_handoff.same_agent_session) throw new Error('real Agent repair did not use the same Agent session');
    if (!report.feedback_handoff.same_execution) throw new Error('real Agent repair changed Execution identity');
    if (report.feedback_handoff.wait_between_candidates) throw new Error('real Agent repair crossed a WAITING/wake lifecycle handoff');
    if (secondApplied.task.state !== 'SATISFIED' || secondApplied.execution.state !== 'SUCCEEDED') {
      throw new Error(`real Agent repair did not complete the Task: ${secondApplied.task.state}/${secondApplied.execution.state}`);
    }
    report.check_result_ids.push(secondResult.check_result_id);
    report.fixture = reportFixture(lockedFixture);
    report.versions = { node: process.version, pi: firstRun.session.manifest.pi_version ?? null, nurouter: firstRun.session.manifest.nurouter_version ?? null, lean_toolchain: lockedFixture.lean_toolchain, mathlib: lockedFixture.mathlib_version, checker: lockedFixture.checker_version };
    report.workspace = {
      input_snapshot_hash: firstRun.execution.input_snapshot_hash,
      first: reportWorkspace(firstRun.workspace),
      same_lineage: firstRun.execution.workspace_ref === secondApplied.execution.workspace_ref,
      checkpoints: [],
    };
    report.check_results = [reportCheckResult(taskService.getCheckResult(firstResult.check_result_id)), reportCheckResult(taskService.getCheckResult(secondResult.check_result_id))];
    report.materials = [reportMaterial(contextService.getMaterial(report.material_ids[0])), reportMaterial(contextService.getMaterial(report.material_ids[1]))];
    report.task = reportTask(secondApplied.task);
    report.execution = reportExecution(secondApplied.execution);
    report.status = secondApplied.task.state === 'SATISFIED' && secondApplied.execution.state === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED';
    validateRealAgentReport(report);
    return report;
  } catch (error) {
    report.status = 'FAILED';
    const failure = reportError(error);
    report.reason = failure.message_class;
    report.error = failure;
    report.task = reportTask(taskService.getTask(task.task_id));
    report.execution = reportExecution(taskService.getExecution(executionId));
    if (firstResult) report.check_results = [reportCheckResult(taskService.getCheckResult(firstResult.check_result_id))];
    if (secondResult) report.check_results?.push(reportCheckResult(taskService.getCheckResult(secondResult.check_result_id)));
    validateRealAgentReport(report);
    return report;
  } finally {
    const execution = taskService.getExecution(executionId);
    if (execution?.state === 'RUNNING') await runtime.stopExecution(executionId, 'FAILED').catch(() => undefined);
    const active = runtime.activeProcesses.get(executionId);
    if (active) {
      runtime.activeProcesses.delete(executionId);
      await Promise.resolve(active.session.stop?.()).catch(() => undefined);
    }
    await bridge.stop();
    taskService.close();
  }
}

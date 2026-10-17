import { execFile as defaultExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentCoreAdapter } from '../agent/pi-adapter.js';
import { ContextService } from '../context/context-service.js';
import { ServicesRouter } from '../sdk/service-router.js';
import { ServicesSDK } from '../sdk/services-sdk.js';
import { TaskService } from '../task/task-service.js';
import { Runtime } from '../runtime/runtime.js';
import { WorkspaceManager } from '../runtime/workspace-manager.js';
import { DatabaseSync } from 'node:sqlite';

const execFile = promisify(defaultExecFile);
const ROUTING_FIELDS = Object.freeze([
  'NUROUTER_PI_PROVIDER',
  'NUROUTER_PI_MODEL',
  'NUROUTER_PI_ACCOUNT',
  'NUROUTER_PI_GROUP',
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
  if (unavailableTools.length > 0) blockers.push(`missing local commands: ${unavailableTools.join(', ')}`);
  return {
    status: blockers.length === 0 ? 'READY_TO_LAUNCH' : 'BLOCKED',
    missing,
    blockers,
    versions: { node, nurouter, pi, lean, lake },
    secret_values_recorded: false,
  };
}

export async function runRealAgentPath({ database = ':memory:', rootDir, fixtureManifest, env = process.env, command = 'nurouter' } = {}) {
  const probe = await probeRealAgentConfig({ env });
  const report = {
    mode: 'real-agent',
    status: probe.status === 'READY_TO_LAUNCH' ? 'BLOCKED' : probe.status,
    probe,
    task_id: null,
    execution_id: null,
    reason: null,
    secret_values_recorded: false,
  };
  if (probe.status !== 'READY_TO_LAUNCH') {
    report.reason = 'Real Agent Core cannot be launched until the local Lean/Lake toolchain and NuRouter/Pi routing configuration are available.';
    return report;
  }

  const databaseConnection = database instanceof DatabaseSync ? database : new DatabaseSync(database);
  const contextService = new ContextService(databaseConnection);
  const taskService = new TaskService(databaseConnection, { contextService });
  contextService.taskService = taskService;
  const router = new ServicesRouter({ taskService, contextService });
  const sdk = new ServicesSDK(router, { actorRef: 'owner:root' });
  const task = sdk.proposeTask({
    task_type: 'proof',
    goal: 'Prove the locked PutnamBench fixture theorem with the real Agent Core',
    expected_output: 'A Lean proof Artifact compiled in the locked fixture',
    acceptance_conditions: { fixture_id: fixtureManifest.fixture_id },
    owner_ref: 'owner:root',
    completion_contract: {
      required_candidate: { kind: 'artifact', scope: 'proof_relevant' },
      required_check: {
        checker_ref: fixtureManifest.checker_ref,
        checker_version: fixtureManifest.checker_version,
        environment_ref: fixtureManifest.environment_ref,
      },
    },
  }, { operationId: 'real:propose' }).task;
  const adapter = new AgentCoreAdapter({
    command,
    provider: env.NUROUTER_PI_PROVIDER,
    model: env.NUROUTER_PI_MODEL,
    account: env.NUROUTER_PI_ACCOUNT,
    group: env.NUROUTER_PI_GROUP,
    env,
  });
  const runtime = new Runtime({
    taskService,
    contextService,
    workspaceManager: new WorkspaceManager({ rootDir }),
    agentAdapter: adapter,
    actorRef: 'runtime:local',
  });
  report.task_id = task.task_id;
  report.reason = 'The repository currently has no Agent-to-Services SDK bridge that can turn a Pi RPC conversation into candidate and CheckResult operations; the real path is therefore launch-ready but not claimed successful.';
  try {
    const frozen = sdk.freezeInitialContext({
      freeze_key: 'real:freeze', task_id: task.task_id, execution_id: 'real-agent-execution',
      spec_version: task.spec_version, spec_hash: task.spec_hash, task_spec: { ...task, fixture_manifest: fixtureManifest },
      initial_prompt: 'Use the locked fixture, write a candidate in the workspace, and use the public Services SDK for lifecycle operations.',
      material_refs: [], service_environment: { fixture_manifest: fixtureManifest, checker: fixtureManifest.checker_ref },
    }, { operationId: 'real:freeze', taskId: task.task_id, executionId: 'real-agent-execution', specVersion: task.spec_version, fencingVersion: 1 });
    const claimed = sdk.withContext({ actorRef: 'agent:real' }).claim({
      execution_id: 'real-agent-execution', claim_key: 'real:claim', owner_ref: 'agent:real',
      initial_prompt: 'Use the locked fixture, write a candidate in the workspace, and use the public Services SDK for lifecycle operations.',
      initial_context_ref: frozen.initial_context_ref, input_snapshot_hash: frozen.input_snapshot_hash, input_material_refs: [],
    }, { operationId: 'real:claim', taskId: task.task_id, specVersion: task.spec_version, stateVersion: task.state_version });
    report.execution_id = claimed.execution.execution_id;
    const started = await runtime.startExecution(claimed.execution.execution_id);
    report.launch = {
      workspace_ref: started.execution.workspace_ref,
      workspace_revision: started.execution.workspace_revision,
      runtime_manifest: started.session.manifest,
    };
    started.session.stop();
    await started.session.wait();
    report.status = 'BLOCKED';
  } catch (error) {
    report.status = 'FAILED_TO_LAUNCH';
    report.reason = error.message;
  } finally {
    taskService.close();
  }
  return report;
}

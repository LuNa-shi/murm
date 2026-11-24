import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRuntime } from '../../core/index.js';
import { ServiceRegistry } from '../../core/services.js';
import { TaskService } from '../../task/task-service.js';
import { ContextService } from '../../context/context-service.js';
import { MissionWorkspace } from '../../runtime/mission-workspace.js';
import { WorkspaceManager } from '../../runtime/workspace-manager.js';
import { makeEnvelope } from '../../protocol/envelope.js';
import { createFlatTaskService, flatResearcherProfile } from '../flat/task-service.js';
import { createFlatPublicationServices } from '../flat/publication-services.js';
import { createFlatController } from '../flat/controller.js';
import { createFlatModelAccessPolicy } from '../flat/model-access-policy.js';

export const FLAT_FIXED_PROMPT = 'Use public Flat Tasks. Read each Task contract, take one ready Task, inspect its fixed candidate revision, and check and merge it. Publish truthful evidence as a Material, link it to the Task, then finish with the checked main revision. Preserve stable request IDs; retry MAIN_MOVED with a new request ID only after re-reading public state. Do not claim you authored the host candidate. Private workspace save/status/diff are unavailable.';

const invalid = () => Object.assign(new Error('FLAT_FIXED_WORKLOAD_INVALID'), { code: 'FLAT_FIXED_WORKLOAD_INVALID' });
const privateWorkspace = new Set(['workspace_save', 'workspace_status', 'workspace_current_diff']);

/** Host-preseeded public candidates only. This is not the default Flat entry
 * point or a private WorkDir capture adapter. Stores are durable and owned here. */
export async function createFlatAffirmativeEnvironment({ backend, image, model = 'default', outputDir, deadlineAt,
  candidates, checker, signal, controller: controllerOptions = {}, collect,
  prompt = FLAT_FIXED_PROMPT }) {
  if (!Array.isArray(candidates) || candidates.length < 5 || candidates.length > 64 ||
      typeof outputDir !== 'string' || !outputDir || typeof checker?.check !== 'function' ||
      !['checker_ref', 'checker_version', 'environment_ref'].every(key => typeof checker.identity?.[key] === 'string' && checker.identity[key]) ||
      !Number.isFinite(checker.timeoutMs) || checker.timeoutMs <= 0 || !Number.isFinite(deadlineAt) || deadlineAt <= Date.now() ||
      (signal !== undefined && !(signal instanceof AbortSignal))) throw invalid();
  const frozen = structuredClone(candidates);
  const mergeChecker = { identity: structuredClone(checker.identity), timeoutMs: checker.timeoutMs, check: checker.check.bind(checker) };
  for (const candidate of frozen) {
    if (typeof candidate.summary !== 'string' || !candidate.summary.trim() || candidate.summary.length > 4000 ||
        !candidate.files || typeof candidate.files !== 'object' || Array.isArray(candidate.files) ||
        !Object.keys(candidate.files).length || Object.keys(candidate.files).length > 32 ||
        Object.entries(candidate.files).some(([path, value]) => !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.[A-Za-z0-9]+$/.test(path) ||
          typeof value !== 'string' || Buffer.byteLength(value) > 128 * 1024)) throw invalid();
  }
  const directory = join(resolve(outputDir), `flat-fixed-${randomUUID()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const tasks = new TaskService(join(directory, 'tasks.sqlite'));
  const context = new ContextService(join(directory, 'context.sqlite'), { taskService: tasks });
  tasks.contextService = context;
  const workspace = new MissionWorkspace({ rootDir: join(directory, 'public') });
  const manager = new WorkspaceManager({ rootDir: join(directory, 'private-inputs') });
  const missionId = `flat-fixed-${randomUUID()}`;
  let runtime, controller, discovery, publication, closed;
  const host = () => makeEnvelope({ actorRef: 'host' });
  const records = [];
  const halted = () => controller?.halt('host-stop');
  async function close({ timeoutMs = 30_000 } = {}) {
    if (closed) return structuredClone(closed);
    controller?.halt('host-stop'); publication?.close();
    const until = Date.now() + timeoutMs;
    await discovery?.close({ timeoutMs });
    const core = runtime ? await runtime.close({ timeoutMs: Math.max(1, until - Date.now()) }) : { cleanup: 'complete', bots: [] };
    await controller?.reconcileClose(core);
    const merges = publication ? await publication.waitForMerges({ timeoutMs: Math.max(1, until - Date.now()) }) : { cleanup: 'complete' };
    const receipt = { ...core, fixedWorkspace: { cleanup: merges.cleanup, source: 'host-preseeded-public-revisions', liveCapture: false } };
    if (core.cleanup === 'complete' && core.bots.every(bot => bot.execution === 'stopped' && bot.cleanup === 'complete') && merges.cleanup === 'complete') {
      signal?.removeEventListener('abort', halted); context.close(); tasks.close(); closed = receipt;
    } else receipt.cleanup = 'pending';
    return structuredClone(receipt);
  }
  try {
    signal?.throwIfAborted();
    tasks.createMission({ mission_id: missionId, goal: 'Independently verify and integrate fixed host-provided public candidates', merge_required_check: mergeChecker.identity }, host());
    const created = await workspace.create({ missionId, workspaceId: 'flat-fixed-public', initialFiles: { 'README.txt': 'Host-provided fixed candidates; no private live capture.\n' } });
    for (const [index, candidate] of frozen.entries()) {
      const saved = await workspace.save({ workspaceId: created.workspace_id, baseRevision: created.main_revision, files: candidate.files, source: 'host-fixed-candidate', requestId: `candidate-${index}` });
      const task = tasks.createTask({ mission_id: missionId, gap: candidate.summary, priority: 'medium', summary: candidate.summary,
        expected_output: `Inspect fixed candidate ${saved.revision}. Merge --from ${saved.revision}; publish and link truthful evidence; finish --workspace-revision with the returned fixed main_revision.`,
        acceptance_conditions: ['Trusted whole-tree checker PASS', 'Current Execution owns final checked main publication', 'Linked truthful Material'],
        workspace: { workspace_id: created.workspace_id, revision: saved.revision },
        completion_contract: { workspace_delivery: { paths: Object.keys(candidate.files), require_main: true, check: mergeChecker.identity } },
      }, host()).task;
      records.push({ taskId: task.task_id, revision: saved.revision, paths: Object.keys(candidate.files) });
    }
    discovery = createFlatTaskService({ runtime: () => runtime, taskService: tasks, contextService: context, missionWorkspace: workspace,
      workspaceManager: manager, missionId, workspaceId: created.workspace_id, missionDeadline: () => deadlineAt,
      executionTimeoutMs: Math.max(1, deadlineAt - Date.now()), handoffLeadMs: Math.min(10_000, Math.max(1, (deadlineAt - Date.now()) / 4)) });
    publication = createFlatPublicationServices({ runtime: () => runtime, taskService: tasks, contextService: context, missionWorkspace: workspace,
      missionId, workspaceId: created.workspace_id, deadline: () => deadlineAt, workspaceMergeChecker: mergeChecker, onFinish: () => controller?.notify() });
    const services = new ServiceRegistry(); services.registerService(publication.composeTask(discovery));
    for (const row of publication.registrations.filter(row => row.manifest.id !== 'task')) services.registerService(row);
    const profile = flatResearcherProfile({ prompt, model, image, ...(collect ? { collect } : {}) });
    profile.services = Object.fromEntries(publication.registrations.map(row => [row.manifest.id, row.manifest.capabilities.map(cap => cap.operation).filter(operation => !privateWorkspace.has(operation) && !operation.startsWith('workspace_check') && operation !== 'get_check_result')]));
    profile.services.task.push(...discovery.manifest.capabilities.map(cap => cap.operation));
    runtime = await createRuntime({ backend, profiles: { researcher: profile }, services, maxBots: 4, outputDir,
      modelAccessPolicy: createFlatModelAccessPolicy({ runtimeId: () => runtime?.id, taskService: tasks, missionId, deadline: () => deadlineAt, isStopping: () => controller?.snapshot().closing ?? false }) });
    controller = createFlatController({ ...controllerOptions, runtime, taskService: tasks, missionId, capacity: 4, deadlineAt,
      afterStopped: (id, options) => publication.reconcileWorkspace(id, options) });
    signal?.addEventListener('abort', halted, { once: true }); signal?.throwIfAborted();
    return Object.freeze({ id: runtime.id, runtime, controller, tasks, context, workspace, missionId, workspaceId: created.workspace_id,
      candidates: Object.freeze(records), directory, close, start: () => controller.start(),
      snapshot: () => ({ ...controller.snapshot(), source: 'host-preseeded-public-revisions', liveCapture: false, candidates: structuredClone(records) }) });
  } catch (error) {
    try { const receipt = await close(); if (receipt.cleanup !== 'complete') error.cleanup = 'pending'; }
    catch { error.cleanup = 'pending'; }
    throw error;
  }
}

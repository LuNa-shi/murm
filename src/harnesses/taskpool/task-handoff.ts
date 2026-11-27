import { randomUUID } from 'node:crypto';
import { MurmError } from '../../errors.js';
import { executionEnvelope, prepareTaskPoolInputs } from './prepare-inputs.js';

const failure = (message: any) => new MurmError('NOT_ALLOWED', message);
const errorInfo = (error: any) => ({ code: error?.code ?? 'SERVICE_UNAVAILABLE', message: error?.message ?? 'TaskPool handoff failed' });

export function startPreparationHeartbeat({ taskService, missionId, agentId, executionId, expectedFence, intervalMs, isClosing, checkSignal }: any) {
  let timer: any, error: any;
  const check = () => {
    if (error) throw error;
    checkSignal();
    taskService.assertMissionResearchOpen(missionId);
    taskService.assertAgentDeadline(agentId);
    const owner = taskService.getAgent(agentId), execution = taskService.getExecution(executionId);
    if (isClosing() || owner?.state !== 'PREPARING' || owner.execution_id !== executionId || execution?.state !== 'CREATED' ||
        execution.fencing_version !== expectedFence || Date.now() >= Date.parse(execution.lease_expires_at)) throw failure('TaskPool Task reservation is no longer current');
    return execution;
  };
  const renew = () => taskService.dispatch('heartbeat', {}, executionEnvelope(check(), `taskpool:heartbeat:${randomUUID()}`));
  renew();
  timer = setInterval(() => { try { renew(); } catch (caught: any) { error = caught; clearInterval(timer); } }, intervalMs);
  return { check, stop() { clearInterval(timer); } };
}

export async function runTaskPoolHandoff({ request, runtime, taskService, missionId, missionWorkspace, workspaceId, workspaceManager, contextService,
  executionTimeoutMs, handoffLeadMs, missionDeadline, heartbeatMs, stopTimeoutMs, preparationTimeoutMs, isClosing, signal, preview }: any) {
  const { agentId, taken, id } = request;
  const executionId = taken.execution.execution_id, fence = taken.execution.fencing_version;
  let deadlineAt: any;
  const checkSignal = () => {
    signal?.throwIfAborted();
    if (isClosing() || Date.now() >= deadlineAt) throw failure('TaskPool preparation closed or exceeded its deadline');
  };
  let lease: any;
  const bounded = async (task: any) => {
    checkSignal();
    let timer: any, abort: any;
    try {
      const work = Promise.resolve().then(task);
      request.inFlight = work;
      void work.finally(() => { if (request.inFlight === work) request.inFlight = undefined; }).catch(() => {});
      return await Promise.race([work, new Promise<any>((_: any, reject: any) => {
        timer = setTimeout(() => reject(failure('TaskPool preparation wait expired')), Math.max(1, deadlineAt - Date.now()));
        abort = () => reject(failure('TaskPool handoff was cancelled'));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      })]);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  };
  try {
    deadlineAt = Math.min(Date.now() + preparationTimeoutMs, missionDeadline(), Date.parse(taskService.getAgent(agentId)?.hard_deadline));
    if (!Number.isFinite(deadlineAt)) throw failure('No finite TaskPool preparation deadline');
    lease = startPreparationHeartbeat({ taskService, missionId, agentId, executionId, expectedFence: fence,
      intervalMs: heartbeatMs, isClosing, checkSignal });
    request.stage = 'prepare-inputs';
    const inputs = await bounded(() => prepareTaskPoolInputs({ execution: taken.execution, taskService, missionWorkspace, workspaceId, workspaceManager,
      contextService, preview, check: () => lease.check() }));
    lease.check();
    request.stage = 'capture-files';
    const snapshot = await bounded(() => runtime.files.snapshot(agentId, { requestId: `${id}:snapshot`, paths: ['.'] }));
    lease.check();
    lease.stop();
    // Refresh after stopping heartbeat; its last successful renewal may have
    // advanced state_version since the initial reservation.
    let execution = taskService.getExecution(executionId);
    const now = Date.now();
    const agent = taskService.getAgent(agentId), task = taskService.getTask(execution.task_id);
    const timeout = Math.min(task.timebox_ms ?? executionTimeoutMs, executionTimeoutMs, missionDeadline() - now, Date.parse(agent.hard_deadline) - now);
    if (!Number.isFinite(timeout) || timeout < 1) throw failure('No Execution budget remains');
    request.stage = 'start-execution';
    execution = taskService.dispatch('start_execution', { core_id: agent.core_id, started_at: new Date(now).toISOString(),
      execution_deadline: new Date(now + timeout).toISOString(), handoff_deadline: new Date(now + Math.max(0, timeout - handoffLeadMs)).toISOString() },
    executionEnvelope(execution, `${id}:start`)).execution;
    request.stage = 'replace-files';
    const options = { requestId: `${id}:replace`, expectedDigest: snapshot.digest, files: inputs.files, writable: true };
    let replacement = await bounded(() => runtime.files.replace(agentId, options));
    if (replacement.status === 'unknown') replacement = await bounded(() => runtime.files.replace(agentId, options));
    if (replacement.status === 'unknown') throw new MurmError('OPERATION_UNKNOWN', 'TaskPool file replacement has no receipt');
    if (replacement.status === 'failed') throw new MurmError(replacement.error.code, replacement.error.message);
    const core = await bounded(() => runtime.get(agentId));
    checkSignal();
    taskService.assertMissionResearchOpen(missionId); taskService.assertAgentDeadline(agentId);
    const owner = taskService.getAgent(agentId);
    execution = taskService.getExecution(executionId);
    if (owner?.state !== 'ACTIVE' || owner.execution_id !== executionId || execution.state !== 'RUNNING' || execution.owner_ref !== agentId ||
        execution.fencing_version !== fence || taskService.getTask(execution.task_id)?.spec_version !== execution.spec_version || Date.now() >= Math.min(Date.parse(execution.execution_deadline), Date.parse(execution.lease_expires_at))) {
      throw failure('TaskPool ownership changed during file replacement');
    }
    if (!['idle', 'running'].includes(core.status)) throw failure('Core Agent closed during taskpool handoff');
    const handoff: any = { agentId, executionId, executionFence: fence, replacement, workspaceRevision: execution.workspace_input.revision };
    request.stage = 'complete';
    request.handoff = handoff;
    return { task: taskService.getTask(execution.task_id), execution, materials: inputs.materials,
      workspace: { ...execution.workspace_input, workDir: '/workspace/project' }, handoff };
  } catch (error: any) {
    lease?.stop();
    request.stage = 'stop-after-failure';
    request.error = errorInfo(error);
    await stopFailedHandoff({ request, runtime, taskService, stopTimeoutMs });
    request.stage = 'failed';
    throw error;
  } finally { lease?.stop(); }
}

/** Explicit host retry preserves the original handoff error and owned request. */
export async function stopFailedHandoff({ request, runtime, taskService, stopTimeoutMs }: any) {
  const agentId = request.agentId, executionId = request.taken.execution.execution_id;
  try { taskService.requestAgentStop(agentId, 'taskpool-handoff-failed', { terminalState: 'FAILED' }); }
  catch (intentError: any) { request.intentError = errorInfo(intentError); }
  try {
    const stopped = await runtime.stop(agentId, { timeoutMs: stopTimeoutMs });
    request.stopped = stopped;
    request.cleanupError = undefined;
    if (stopped.execution === 'stopped') {
      const current = taskService.getExecution(executionId);
      if (['CREATED', 'RUNNING'].includes(current.state)) taskService.dispatch('stop_execution', { terminal_state: 'FAILED', terminal_reason: 'taskpool-handoff-failed' }, executionEnvelope(current, `${request.id}:failed`));
      if (stopped.cleanup === 'complete') taskService.finalizeAgentClose(agentId);
    }
  } catch (cleanupError: any) { request.cleanupError = errorInfo(cleanupError); }
}

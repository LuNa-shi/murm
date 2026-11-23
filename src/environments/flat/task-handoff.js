import { randomUUID } from 'node:crypto';
import { SwarmEnvError } from '../../errors.js';
import { executionEnvelope, prepareFlatInputs } from './prepare-inputs.js';

const failure = message => new SwarmEnvError('NOT_ALLOWED', message);
const errorInfo = error => ({ code: error?.code ?? 'SERVICE_UNAVAILABLE', message: error?.message ?? 'Flat handoff failed' });

export function startPreparationHeartbeat({ taskService, missionId, botId, executionId, expectedFence, intervalMs, isClosing, checkSignal }) {
  let timer, error;
  const check = () => {
    if (error) throw error;
    checkSignal();
    taskService.assertMissionResearchOpen(missionId);
    taskService.assertBotDeadline(botId);
    const owner = taskService.getBot(botId), execution = taskService.getExecution(executionId);
    if (isClosing() || owner?.state !== 'PREPARING' || owner.execution_id !== executionId || execution?.state !== 'CREATED' ||
        execution.fencing_version !== expectedFence || Date.now() >= Date.parse(execution.lease_expires_at)) throw failure('Flat Task reservation is no longer current');
    return execution;
  };
  const renew = () => taskService.dispatch('heartbeat', {}, executionEnvelope(check(), `flat:heartbeat:${randomUUID()}`));
  renew();
  timer = setInterval(() => { try { renew(); } catch (caught) { error = caught; clearInterval(timer); } }, intervalMs);
  return { check, stop() { clearInterval(timer); } };
}

export async function runFlatHandoff({ request, runtime, taskService, missionId, missionWorkspace, workspaceId, workspaceManager, contextService,
  executionTimeoutMs, handoffLeadMs, missionDeadline, heartbeatMs, stopTimeoutMs, preparationTimeoutMs, isClosing, signal, preview }) {
  const { botId, taken, id } = request;
  const executionId = taken.execution.execution_id, fence = taken.execution.fencing_version;
  let deadlineAt;
  const checkSignal = () => {
    signal?.throwIfAborted();
    if (isClosing() || Date.now() >= deadlineAt) throw failure('Flat preparation closed or exceeded its deadline');
  };
  let lease;
  const bounded = async task => {
    checkSignal();
    let timer, abort;
    try {
      const work = Promise.resolve().then(task);
      request.inFlight = work;
      void work.finally(() => { if (request.inFlight === work) request.inFlight = undefined; }).catch(() => {});
      return await Promise.race([work, new Promise((_, reject) => {
        timer = setTimeout(() => reject(failure('Flat preparation wait expired')), Math.max(1, deadlineAt - Date.now()));
        abort = () => reject(failure('Flat handoff was cancelled'));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      })]);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  };
  try {
    deadlineAt = Math.min(Date.now() + preparationTimeoutMs, missionDeadline(), Date.parse(taskService.getBot(botId)?.hard_deadline));
    if (!Number.isFinite(deadlineAt)) throw failure('No finite Flat preparation deadline');
    lease = startPreparationHeartbeat({ taskService, missionId, botId, executionId, expectedFence: fence,
      intervalMs: heartbeatMs, isClosing, checkSignal });
    request.stage = 'prepare-inputs';
    const inputs = await bounded(() => prepareFlatInputs({ execution: taken.execution, taskService, missionWorkspace, workspaceId, workspaceManager,
      contextService, preview, check: () => lease.check() }));
    lease.check();
    request.stage = 'prepare-files';
    const prepared = await bounded(() => runtime.files.prepare(botId, { requestId: `${id}:prepare`, files: inputs.files }));
    lease.check();
    request.prepared = prepared;
    lease.stop();
    // Refresh after stopping heartbeat; its last successful renewal may have
    // advanced state_version since the initial reservation.
    let execution = taskService.getExecution(executionId);
    const now = Date.now();
    const bot = taskService.getBot(botId), task = taskService.getTask(execution.task_id);
    const timeout = Math.min(task.timebox_ms ?? executionTimeoutMs, executionTimeoutMs, missionDeadline() - now, Date.parse(bot.hard_deadline) - now);
    if (!Number.isFinite(timeout) || timeout < 1) throw failure('No Execution budget remains');
    request.stage = 'start-execution';
    execution = taskService.dispatch('start_execution', { core_id: bot.core_id, started_at: new Date(now).toISOString(),
      execution_deadline: new Date(now + timeout).toISOString(), handoff_deadline: new Date(now + Math.max(0, timeout - handoffLeadMs)).toISOString() },
    executionEnvelope(execution, `${id}:start`)).execution;
    request.stage = 'grant-files';
    await bounded(() => runtime.files.grant({ requestId: `${id}:grant`, prepared }));
    const core = await bounded(() => runtime.get(botId));
    checkSignal();
    taskService.assertMissionResearchOpen(missionId); taskService.assertBotDeadline(botId);
    const owner = taskService.getBot(botId);
    execution = taskService.getExecution(executionId);
    if (owner?.state !== 'ACTIVE' || owner.execution_id !== executionId || execution.state !== 'RUNNING' || execution.owner_ref !== botId ||
        execution.fencing_version !== fence || taskService.getTask(execution.task_id)?.spec_version !== execution.spec_version || Date.now() >= Math.min(Date.parse(execution.execution_deadline), Date.parse(execution.lease_expires_at))) {
      throw failure('Flat ownership changed during file grant');
    }
    if (!['idle', 'running'].includes(core.status)) throw failure('Core Bot closed during flat handoff');
    const handoff = { botId, executionId, executionFence: fence, prepared: { ...prepared }, workspaceRevision: execution.workspace_input.revision };
    request.stage = 'complete';
    request.handoff = handoff;
    return { task: taskService.getTask(execution.task_id), execution, materials: inputs.materials,
      workspace: { ...execution.workspace_input, workDir: '/workspace/project' }, handoff };
  } catch (error) {
    lease?.stop();
    request.stage = 'stop-after-failure';
    request.error = errorInfo(error);
    await stopFailedHandoff({ request, runtime, taskService, stopTimeoutMs });
    request.stage = 'failed';
    throw error;
  } finally { lease?.stop(); }
}

/** Explicit host retry preserves the original handoff error and owned request. */
export async function stopFailedHandoff({ request, runtime, taskService, stopTimeoutMs }) {
  const botId = request.botId, executionId = request.taken.execution.execution_id;
  try { taskService.requestBotStop(botId, 'flat-handoff-failed', { terminalState: 'FAILED' }); }
  catch (intentError) { request.intentError = errorInfo(intentError); }
  try {
    const stopped = await runtime.stop(botId, { timeoutMs: stopTimeoutMs });
    request.stopped = stopped;
    request.cleanupError = undefined;
    if (stopped.execution === 'stopped') {
      const current = taskService.getExecution(executionId);
      if (['CREATED', 'RUNNING'].includes(current.state)) taskService.dispatch('stop_execution', { terminal_state: 'FAILED', terminal_reason: 'flat-handoff-failed' }, executionEnvelope(current, `${request.id}:failed`));
      if (stopped.cleanup === 'complete') taskService.finalizeBotClose(botId);
    }
  } catch (cleanupError) { request.cleanupError = errorInfo(cleanupError); }
}

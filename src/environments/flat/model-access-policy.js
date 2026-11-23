import { isSoftCloseout } from '../../task/execution-budget.js';

/** Task-owned authority shared by the legacy host and flat's Core policy. */
export function authorizeFlatBot({ taskService, missionId, botId, deadline, closeoutDeadline = () => Infinity, isStopping = () => false }) {
  const at = Date.now();
  const bot = taskService.getBot(botId);
  const missionDeadline = deadline();
  const hardDeadline = Date.parse(bot?.hard_deadline);
  if (isStopping() || bot?.mission_id !== missionId || !Number.isFinite(missionDeadline) ||
      !Number.isFinite(hardDeadline) || at >= Math.min(missionDeadline, hardDeadline)) return null;
  if (bot.state === 'UNBOUND') {
    const selectionDeadline = Date.parse(bot.selection_deadline);
    return !bot.execution_id && !taskService.isMissionStopped(missionId) && Number.isFinite(selectionDeadline) && at < selectionDeadline
      ? { phase: 'selection', deadlineAt: Math.min(missionDeadline, hardDeadline, selectionDeadline) } : null;
  }
  if (bot.state !== 'ACTIVE' || !bot.execution_id) return null;
  const execution = taskService.getExecution(bot.execution_id);
  const executionDeadline = Date.parse(execution?.execution_deadline);
  const leaseDeadline = Date.parse(execution?.lease_expires_at);
  if (execution?.owner_ref !== botId || execution.state !== 'RUNNING' ||
      !Number.isSafeInteger(execution.fencing_version) || execution.fencing_version < 0 ||
      !Number.isFinite(executionDeadline) || !Number.isFinite(leaseDeadline) || at >= Math.min(executionDeadline, leaseDeadline)) return null;
  const phase = isSoftCloseout(execution, at) ? 'closeout' : 'work';
  if (taskService.isMissionStopped(missionId) && phase !== 'closeout') return null;
  const deadlineAt = Math.min(missionDeadline, hardDeadline, executionDeadline, phase === 'closeout' ? closeoutDeadline() : Infinity);
  if (!Number.isFinite(deadlineAt) || at >= deadlineAt) return null;
  return { phase, deadlineAt, lease: { key: bot.execution_id, version: execution.fencing_version, expiresAt: leaseDeadline } };
}

/** Host-only adapter. Runtime identity comes from the host's Core instance. */
export function createFlatModelAccessPolicy({ runtimeId, ...authority }) {
  if ((typeof runtimeId !== 'string' && typeof runtimeId !== 'function') || !authority.taskService ||
      typeof authority.deadline !== 'function' || typeof authority.missionId !== 'string') {
    throw new TypeError('Flat model policy requires trusted Runtime and Task authority');
  }
  return Object.freeze({
    authorize(caller) {
      const expectedRuntimeId = typeof runtimeId === 'function' ? runtimeId() : runtimeId;
      if (!expectedRuntimeId || caller?.runtimeId !== expectedRuntimeId ||
          !['botId', 'profile', 'model'].every(key => typeof caller[key] === 'string' && caller[key])) return null;
      return authorizeFlatBot({ ...authority, botId: caller.botId });
    },
    withCommit(commit) { return authority.taskService.withServiceLifecycleWrite(commit); },
  });
}

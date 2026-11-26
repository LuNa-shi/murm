import { isSoftCloseout } from '../../src/task/execution-budget.js';

/** Task-owned authority shared by the legacy host and taskpool's Core policy. */
export function authorizeTaskPoolAgent({ taskService, missionId, agentId, deadline, closeoutDeadline = () => Infinity, isStopping = () => false }: any): import('../../src/core/index.js').ModelPermit | null {
  const at = Date.now();
  const agent = taskService.getAgent(agentId);
  const missionDeadline = deadline();
  const hardDeadline = Date.parse(agent?.hard_deadline);
  if (isStopping() || agent?.mission_id !== missionId || !Number.isFinite(missionDeadline) ||
      !Number.isFinite(hardDeadline) || at >= Math.min(missionDeadline, hardDeadline)) return null;
  if (agent.state === 'UNBOUND') {
    const selectionDeadline = Date.parse(agent.selection_deadline);
    return !agent.execution_id && !taskService.isMissionStopped(missionId) && Number.isFinite(selectionDeadline) && at < selectionDeadline
      ? { phase: 'selection', deadlineAt: Math.min(missionDeadline, hardDeadline, selectionDeadline) } : null;
  }
  if (agent.state !== 'ACTIVE' || !agent.execution_id) return null;
  const execution = taskService.getExecution(agent.execution_id);
  const executionDeadline = Date.parse(execution?.execution_deadline);
  const leaseDeadline = Date.parse(execution?.lease_expires_at);
  if (execution?.owner_ref !== agentId || execution.state !== 'RUNNING' ||
      !Number.isSafeInteger(execution.fencing_version) || execution.fencing_version < 0 ||
      !Number.isFinite(executionDeadline) || !Number.isFinite(leaseDeadline) || at >= Math.min(executionDeadline, leaseDeadline)) return null;
  const phase = isSoftCloseout(execution, at) ? 'closeout' : 'work';
  if (taskService.isMissionStopped(missionId) && phase !== 'closeout') return null;
  const deadlineAt = Math.min(missionDeadline, hardDeadline, executionDeadline, phase === 'closeout' ? closeoutDeadline() : Infinity);
  if (!Number.isFinite(deadlineAt) || at >= deadlineAt) return null;
  return { phase, deadlineAt, lease: { key: agent.execution_id, version: execution.fencing_version, expiresAt: leaseDeadline } };
}

/** Host-only adapter. Runtime identity comes from the host's Core instance. */
export function createTaskPoolModelAccessPolicy({ runtimeId, ...authority }: any): import('../../src/core/index.js').ModelAccessPolicy {
  if ((typeof runtimeId !== 'string' && typeof runtimeId !== 'function') || !authority.taskService ||
      typeof authority.deadline !== 'function' || typeof authority.missionId !== 'string') {
    throw new TypeError('TaskPool model policy requires trusted Runtime and Task authority');
  }
  return Object.freeze({
    authorize(caller: any): import('../../src/core/index.js').ModelPermit | null {
      const expectedRuntimeId = typeof runtimeId === 'function' ? runtimeId() : runtimeId;
      if (!expectedRuntimeId || caller?.runtimeId !== expectedRuntimeId ||
          !['agentId', 'profile', 'model'].every((key: any) => typeof caller[key] === 'string' && caller[key])) return null;
      return authorizeTaskPoolAgent({ ...authority, agentId: caller.agentId });
    },
    withCommit(commit: any) { return authority.taskService.withServiceLifecycleWrite(commit); },
  });
}

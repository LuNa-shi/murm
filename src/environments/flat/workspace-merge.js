import { ERROR_CODES, SwarmEnvError } from '../../errors.js';
import { assertNewExecutionWork } from '../../task/execution-budget.js';
import { publishWorkspace } from '../../runtime/workspace-publication.js';

/** Own the final-tree checker and publication policy for one trusted Flat or retained Bridge composition. */
export function createWorkspaceMergeService({ taskService, workspace, workspaceId, assertExecutionWorkspace, checker = null }) {
  if (!taskService || !workspace || typeof assertExecutionWorkspace !== 'function') throw new TypeError('Workspace merge requires trusted Task, Workspace and binding authority');
  if (checker && (typeof checker.check !== 'function' ||
      !['checker_ref', 'checker_version', 'environment_ref'].every(key => typeof checker.identity?.[key] === 'string' && checker.identity[key]) ||
      !Number.isFinite(checker.timeoutMs) || checker.timeoutMs <= 0)) {
    throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Workspace merge checker requires fixed identity and a positive timeout');
  }
  const adapter = checker ? { identity: Object.freeze(structuredClone(checker.identity)),
    timeoutMs: checker.timeoutMs, check: checker.check.bind(checker) } : null;
  let activeCheck = null;
  let closing = false;
  async function waitForSettled() {
    while (activeCheck) await Promise.allSettled([activeCheck.promise]);
  }
  async function close({ timeoutMs = 30_000 } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new TypeError('Workspace merge close timeout must be finite and nonnegative');
    closing = true;
    activeCheck?.controller.abort();
    let timer;
    try {
      await Promise.race([waitForSettled(), new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]);
      return { cleanup: activeCheck ? 'pending' : 'complete', pending_checks: activeCheck ? 1 : 0 };
    } finally { clearTimeout(timer); }
  }
  async function merge(input, identity) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'from') || !/^\d+\.\d+$/.test(input.from ?? '')) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Workspace merge requires --from a fixed public revision');
    }
    if (typeof identity.requestId !== 'string' || !identity.requestId) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Merge requires a stable request ID');
    const initial = assertExecutionWorkspace(identity, { receiptOnly: true });
    const task = taskService.getTask(initial.task_id);
    const requiredCheck = taskService.getMission(task.mission_id).merge_required_check;
    const delivery = task.completion_contract?.workspace_delivery;
    const deliveryCheck = delivery?.require_main ? delivery.check : null;
    const requirements = [requiredCheck, deliveryCheck].filter(value => value !== undefined && value !== null);
    const unavailableCheck = requirements.some(requirement => !requirement || typeof requirement !== 'object' || Array.isArray(requirement) ||
      !requirement.checker_ref || !requirement.checker_version || !adapter || Object.entries(requirement).some(([key, value]) => adapter.identity[key] !== value));
    const checkPolicy = { policy_version: 'workspace-merge-v2', mission: requiredCheck ?? null,
      task: { spec_version: task.spec_version, delivery_check: deliveryCheck ?? null }, configured: requirements.length ? adapter?.identity ?? null : null };
    const guard = () => {
      if (closing) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Workspace merge service is stopping');
      const execution = assertExecutionWorkspace(identity, { newWork: true });
      assertNewExecutionWork(execution);
      return execution;
    };
    return workspace.merge({ workspaceId: workspaceId, fromRevision: input.from,
      requestId: `execution:${identity.executionId}:merge:${identity.requestId}`,
      source: { operation: 'merge', mission_id: task.mission_id, task_id: task.task_id, execution_id: initial.execution_id, bot_id: initial.owner_ref, fencing_version: identity.fencingVersion },
      checkPolicy, guard,
      checker: unavailableCheck ? async () => { throw new SwarmEnvError(ERROR_CODES.SERVICE_NOT_READY, 'Mission or Task requires an unavailable trusted final-tree checker', { policy: checkPolicy }); } : requirements.length ? async plan => {
        const execution = guard();
        if (activeCheck) throw new SwarmEnvError(ERROR_CODES.WORKSPACE_BUSY, 'Previous final-tree checker has not confirmed completion; use a new attempt after it settles');
        const remaining = Math.min(adapter.timeoutMs, Date.parse(execution.handoff_deadline ?? execution.execution_deadline) - Date.now());
        if (!Number.isFinite(remaining) || remaining <= 0) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'No final-tree check budget remains');
        const controller = new AbortController();
        const aborted = () => controller.abort();
        identity.signal?.addEventListener('abort', aborted, { once: true });
        if (identity.signal?.aborted) aborted();
        const deadline = Date.now() + remaining;
        // Timeout requests cancellation. The slot and shutdown join retain
        // the checker until its promise confirms resource cleanup.
        const check = Promise.resolve().then(() => adapter.check({
          ...plan, signal: controller.signal, identity: adapter.identity,
          source: { task_id: task.task_id, execution_id: initial.execution_id }, deadline,
          startProcess: launch => taskService.withServiceLifecycleWrite(() => {
            guard();
            return launch();
          }),
        }));
        const active = { controller, promise: check.finally(() => {
          identity.signal?.removeEventListener('abort', aborted);
          if (activeCheck === active) activeCheck = null;
        }) };
        activeCheck = active;
        let timer;
        try {
          const result = await Promise.race([active.promise,
            new Promise((_, reject) => { timer = setTimeout(() => { reject(new SwarmEnvError('SERVICE_TIMEOUT', 'Final-tree check exceeded its deadline')); controller.abort(); }, remaining); })]);
          if (Date.now() >= deadline) throw new SwarmEnvError('SERVICE_TIMEOUT', 'Final-tree check exceeded its deadline');
          if (result?.check_mode === 'lean-module' || result?.scope === 'module') {
            throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Workspace merge requires a complete check; module-scoped evidence is insufficient');
          }
          const checkedPaths = Array.isArray(result?.checked_paths) ? result.checked_paths : [];
          return { verdict: result?.verdict, check_result_id: typeof result?.check_result_id === 'string' ? result.check_result_id.slice(0, 256) : null,
            diagnostic: typeof result?.diagnostic === 'string' ? result.diagnostic.slice(0, 2048) : null,
            ...(result?.check_mode === 'lean-project' ? { check_mode: result.check_mode, checked_count: checkedPaths.length, checked_paths: checkedPaths } : {}),
            checked_tree: plan.tree, checker: adapter.identity, policy: checkPolicy };
        } finally { clearTimeout(timer); }
      } : null,
      withPublication: publish => publishWorkspace(taskService.db, publish),
    });
  }

  return { merge, close, waitForSettled, status: () => ({ cleanup: activeCheck ? 'pending' : 'complete', pending_checks: activeCheck ? 1 : 0 }) };
}

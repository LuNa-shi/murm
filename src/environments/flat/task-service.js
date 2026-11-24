import { makeEnvelope, stableStringify } from '../../protocol/envelope.js';
import { SwarmEnvError } from '../../errors.js';
import { inputFingerprint } from './prepare-inputs.js';
import { runFlatHandoff, stopFailedHandoff } from './task-handoff.js';

const operations = ['task_list', 'task_view', 'task_take'];
const invalid = message => { throw new SwarmEnvError('INVALID_CONTRACT', message); };
const denied = message => { throw new SwarmEnvError('NOT_ALLOWED', message); };
const objectSchema = properties => ({ type: 'object', properties, additionalProperties: false });
const taskId = { type: 'string', minLength: 1, maxLength: 256 };

export function flatResearcherProfile({ prompt, model, image, ...options }) {
  if (Object.keys(options).some(key => !['env', 'network', 'collect'].includes(key))) invalid('Flat researcher only accepts readonly discovery resource defaults');
  return { ...options, prompt, model, image, writable: false, services: { task: [...operations] } };
}

/** Trusted host composition. The getter permits registration before Core assembly. */
export function createFlatTaskService({ runtime, taskService, missionId, missionWorkspace, workspaceId, workspaceManager, contextService,
  profile = 'researcher', researcherPrompt = '', missionDeadline, executionTimeoutMs = 60_000, handoffLeadMs = 10_000,
  heartbeatMs = 10_000, preparationTimeoutMs = 30_000, stopTimeoutMs = 30_000 }) {
  if ((!runtime || !['object', 'function'].includes(typeof runtime)) || !taskService || !missionWorkspace || !workspaceManager ||
      typeof missionId !== 'string' || !missionId || typeof workspaceId !== 'string' || !workspaceId ||
      typeof profile !== 'string' || !profile || typeof researcherPrompt !== 'string' || typeof missionDeadline !== 'function' ||
      ![executionTimeoutMs, handoffLeadMs, heartbeatMs, preparationTimeoutMs, stopTimeoutMs].every(value => Number.isFinite(value) && value > 0) || heartbeatMs > 10_000) {
    invalid('Flat Task Service requires trusted domain stores, Core, ordered finite budgets and a Mission deadline');
  }
  let closing = false;
  const requests = new Map();
  const active = new Set();
  const previews = new Map();
  const getRuntime = () => typeof runtime === 'function' ? runtime() : runtime;
  const inspectRequest = request => ({ botId: request.botId, requestId: request.requestId, executionId: request.taken.execution.execution_id,
    stage: request.stage, inputWorkPending: Boolean(request.inFlight), ...(request.handoff ? { handoff: request.handoff } : {}),
    ...(request.error ? { error: request.error } : {}), ...(request.stopped ? { stopped: request.stopped } : {}),
    ...(request.cleanupError ? { cleanupError: request.cleanupError } : {}), ...(request.intentError ? { intentError: request.intentError } : {}) });
  const manifest = { id: 'task', title: 'Flat Tasks', purpose: 'Discover and exclusively take fixed Mission work with controlled file handoff',
    provider_version: '1', contract_version: '2', endpoint: { transport: 'in-process' }, capabilities: [
      { name: 'list', operation: 'task_list', description: 'List this Mission Tasks while the project is readonly', side_effect: 'read', idempotent: true,
        help: { when: 'Discover work before taking a Task' }, errors: [], input_schema: objectSchema({ state: { type: 'string' }, query: { type: 'string', maxLength: 4000 }, states: { type: 'array', items: { type: 'string' } }, limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: { type: 'string' }, available_only: { type: 'boolean' } }), output_schema: { type: 'object' } },
      { name: 'view', operation: 'task_view', description: 'Read a Task contract and current provenance in this Mission', side_effect: 'read', idempotent: true,
        help: { when: 'Inspect one Task before take' }, errors: [], input_schema: { ...objectSchema({ task_id: taskId }), required: ['task_id'] }, output_schema: { type: 'object' } },
      { name: 'take', operation: 'task_take', description: 'Atomically reserve one Task, prepare fixed inputs and grant the current Bot write access', side_effect: 'write', idempotent: true,
        help: { when: 'Take selected work; retry an unknown result using the same request ID' }, errors: [{ code: 'CONFLICT', retryable: false }, { code: 'NOT_ALLOWED', retryable: false }], input_schema: { ...objectSchema({ task_id: taskId }), required: ['task_id'] }, output_schema: { type: 'object' } },
    ] };
  const adapter = { async invoke({ capability, input, caller, envelope, signal }) {
    const operation = capability?.operation;
    if (!operations.includes(operation) || !input || typeof input !== 'object' || Array.isArray(input)) invalid('Unsupported flat Task operation or payload');
    const allowed = operation === 'task_list' ? ['state', 'states', 'query', 'limit', 'cursor', 'available_only'] : ['task_id'];
    if (Object.keys(input).some(key => !allowed.includes(key)) || (operation !== 'task_list' && (typeof input.task_id !== 'string' || !input.task_id))) invalid('Flat Task payload cannot supply actor, owner, Execution or resource identity');
    const core = getRuntime();
    if (!core?.id || caller?.runtimeId !== core.id || caller.profile !== profile || typeof caller.botId !== 'string' ||
        typeof envelope?.operation_id !== 'string' || !envelope.operation_id || envelope.operation_id.length > 256) denied('Flat caller is not this Runtime researcher');
    const key = stableStringify([core.id, caller.botId, envelope.operation_id]);
    const fingerprint = stableStringify({ operation, input, profile: caller.profile });
    const previous = requests.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new SwarmEnvError('CONFLICT', 'Flat request ID has different parameters');
      return structuredClone(await previous.work);
    }
    if (closing) denied('Flat Task Service is closing');
    signal?.throwIfAborted();
    const bot = taskService.getBot(caller.botId);
    if (!bot || bot.mission_id !== missionId || bot.core_id === core.id || bot.sandbox_id || !['UNBOUND', 'ACTIVE'].includes(bot.state)) denied('Flat caller has no eligible registered Bot');
    taskService.assertMissionResearchOpen(missionId); taskService.assertBotDeadline(bot.bot_id);
    const live = await core.get(bot.bot_id);
    if (!['idle', 'running'].includes(live.status) || live.profile !== profile || closing || signal?.aborted) denied('Core researcher is unavailable');
    const joined = requests.get(key);
    if (joined) {
      if (joined.fingerprint !== fingerprint) throw new SwarmEnvError('CONFLICT', 'Flat request ID has different parameters');
      return structuredClone(await joined.work);
    }
    if (operation === 'task_list') return taskService.dispatch(operation, { ...input, mission_id: missionId }, makeEnvelope({ actorRef: bot.bot_id }));
    const task = taskService.getTask(input.task_id);
    if (!task || task.mission_id !== missionId) denied('Task does not belong to this Mission');
    if (operation === 'task_view') {
      if (task.workspace?.workspace_id && task.workspace.workspace_id !== workspaceId) denied('Task Workspace belongs to another Environment');
      const snapshot = await missionWorkspace.exportRevision({ workspaceId, revision: task.workspace?.revision ?? 'main', signal });
      signal?.throwIfAborted();
      if (closing) denied('Flat Task Service is closing');
      if (snapshot.mission_id !== missionId) denied('Preview Workspace belongs to another Mission');
      previews.set(bot.bot_id, { revision: snapshot.revision, workspace_id: workspaceId });
      return taskService.dispatch(operation, { task_id: task.task_id }, makeEnvelope({ actorRef: bot.bot_id, taskId: task.task_id }));
    }
    const id = `flat:${inputFingerprint([core.id, bot.bot_id, envelope.operation_id])}`;
    // Claim conflicts never enter compensation. No Core stop is issued for a
    // Bot that simply lost an ordinary race for someone else's ready Task.
    const taken = taskService.takeTask(task.task_id, { take_key: `${id}:take`, owner_ref: bot.bot_id, core_id: bot.core_id,
      agent_prompt: researcherPrompt, input_material_refs: task.input_material_refs }, makeEnvelope({ operationId: `${id}:take`, actorRef: bot.bot_id,
      taskId: task.task_id, specVersion: task.spec_version, stateVersion: task.state_version }));
    const request = { id, botId: bot.bot_id, requestId: envelope.operation_id, fingerprint, taken, stage: 'reserved' };
    // Register synchronously before entering any asynchronous preparation.
    const work = Promise.resolve().then(() => runFlatHandoff({ request, runtime: core, taskService, missionId, missionWorkspace, workspaceId,
      workspaceManager, contextService, executionTimeoutMs, handoffLeadMs, missionDeadline, heartbeatMs, preparationTimeoutMs, stopTimeoutMs,
      isClosing: () => closing, signal, preview: previews.get(bot.bot_id) }));
    request.work = work;
    requests.set(key, request); active.add(work);
    void work.finally(() => active.delete(work)).catch(() => {});
    return structuredClone(await work);
  } };
  return { manifest, adapter,
    inspect(botId, requestId) {
      const core = getRuntime();
      const request = requests.get(stableStringify([core?.id, botId, requestId]));
      return request ? structuredClone(inspectRequest(request)) : null;
    },
    async reconcile(botId, requestId) {
      const core = getRuntime();
      const request = requests.get(stableStringify([core?.id, botId, requestId]));
      if (!request || request.stage !== 'failed') denied('Only an owned failed flat handoff can be reconciled');
      await stopFailedHandoff({ request, runtime: core, taskService, stopTimeoutMs });
      return structuredClone(inspectRequest(request));
    },
    async close({ timeoutMs = stopTimeoutMs } = {}) {
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) invalid('Flat close timeout must be positive and finite');
      closing = true;
      let timer;
      try { await Promise.race([Promise.allSettled([...active]), new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]); }
      finally { clearTimeout(timer); }
      return { handoffs: [...requests.values()].map(inspectRequest), pending: active.size };
    },
  };
}

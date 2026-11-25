import { makeEnvelope, stableStringify } from '../../protocol/envelope.js';
import { MurmError } from '../../errors.js';
import { taskPoolCoordinationPermissions } from './coordination-permissions.js';
import { executionEnvelope, inputFingerprint } from './prepare-inputs.js';
import { listTools } from '../../sdk/service-catalog.js';
import { runTaskPoolHandoff, stopFailedHandoff } from './task-handoff.js';

const coordinationOperations = ['task_revise', 'task_cancel'];
const operations = ['task_list', 'task_view', 'task_take', ...coordinationOperations];
const coordinationTools = listTools('task').filter((tool: any) => coordinationOperations.includes(tool.operation));
const invalid = (message: any) => { throw new MurmError('INVALID_CONTRACT', message); };
const denied = (message: any) => { throw new MurmError('NOT_ALLOWED', message); };
const objectSchema = (properties: any) => ({ type: 'object', properties, additionalProperties: false });
const taskId: any = { type: 'string', minLength: 1, maxLength: 256 };

export function taskPoolResearcherProfile({ prompt, model, image, coordinationPermissions = [], autonomousTasks = false, ...options }: any) {
  if (typeof autonomousTasks !== 'boolean') invalid('Flat autonomous Task configuration must be boolean');
  if (Object.keys(options).some((key: any) => !['env', 'network', 'collect'].includes(key))) invalid('Flat researcher only accepts readonly discovery resource defaults');
  return { ...options, prompt, model, image, writable: false, services: { task: [...operations, ...(autonomousTasks ? ['task_create'] : []), ...taskPoolCoordinationPermissions(coordinationPermissions).filter((permission: any) => permission === 'task_dependency_replace')] } };
}

/** Trusted host composition. The getter permits registration before Core assembly. */
export function createTaskPoolTaskService({ runtime, taskService, missionId, missionWorkspace, workspaceId, workspaceManager, contextService,
  profile = 'researcher', researcherPrompt = '', missionDeadline, coordinationPermissions = [], autonomousTasks = false, executionTimeoutMs = 60_000, handoffLeadMs = 10_000,
  heartbeatMs = 10_000, preparationTimeoutMs = 30_000, stopTimeoutMs = 30_000 }: any) {
  if (typeof autonomousTasks !== 'boolean' || (!runtime || !['object', 'function'].includes(typeof runtime)) || !taskService || !missionWorkspace || !workspaceManager ||
      typeof missionId !== 'string' || !missionId || typeof workspaceId !== 'string' || !workspaceId ||
      typeof profile !== 'string' || !profile || typeof researcherPrompt !== 'string' || typeof missionDeadline !== 'function' ||
      ![executionTimeoutMs, handoffLeadMs, heartbeatMs, preparationTimeoutMs, stopTimeoutMs].every((value: any) => Number.isFinite(value) && value > 0) || heartbeatMs > 10_000) {
    invalid('Flat Task Service requires trusted domain stores, Core, ordered finite budgets and a Mission deadline');
  }
  const permissions = taskPoolCoordinationPermissions(coordinationPermissions).filter((permission: any) => permission === 'task_dependency_replace');
  const enabledCoordination = [...coordinationOperations, ...permissions];
  const enabledOperations = [...operations, ...permissions, ...(autonomousTasks ? ['task_create'] : [])];
  const enabledTools = [...coordinationTools, ...listTools('task').filter((tool: any) => permissions.includes(tool.operation))];
  let closing = false;
  const requests: any = new Map();
  const coordinationRequests: any = new Map();
  const active: any = new Set();
  const previews: any = new Map();
  const getRuntime = () => typeof runtime === 'function' ? runtime() : runtime;
  const inspectRequest = (request: any) => ({ botId: request.botId, requestId: request.requestId, executionId: request.taken.execution.execution_id,
    stage: request.stage, inputWorkPending: Boolean(request.inFlight), ...(request.handoff ? { handoff: request.handoff } : {}),
    ...(request.error ? { error: request.error } : {}), ...(request.stopped ? { stopped: request.stopped } : {}),
    ...(request.cleanupError ? { cleanupError: request.cleanupError } : {}), ...(request.intentError ? { intentError: request.intentError } : {}) });
  const createTool = listTools('task').find((tool: any) => tool.operation === 'task_create');
  const viewProperties = { task_id: taskId, contract_history_after_version: { type: 'integer', minimum: 0 },
    contract_history_limit: { type: 'integer', minimum: 1, maximum: 100 } };
  const createProperties = Object.fromEntries(Object.entries(createTool.parameters.properties).filter(([key]) => !['mission_id', 'workspace', 'timebox_ms'].includes(key)));
  const manifest: any = { id: 'task', title: 'Flat Tasks', purpose: 'Discover and exclusively take fixed Mission work with controlled file handoff',
    provider_version: '1', contract_version: '2', endpoint: { transport: 'in-process' }, capabilities: [
      ...(autonomousTasks ? [{ name: 'create', operation: 'task_create', description: 'Propose one concrete Task. You may call it repeatedly during discovery or while executing your current Task.', side_effect: 'write', idempotent: true, help: { when: 'Discover a missing lemma or other useful independent responsibility' }, errors: [], input_schema: { ...createTool.parameters, properties: createProperties }, output_schema: { type: 'object' } }] : []),
      ...enabledTools.map((tool: any) => ({ name: tool.operation.slice(5), operation: tool.operation, description: tool.description, side_effect: 'write', idempotent: true, help: { when: tool.operation === 'task_dependency_replace' ? 'An explicitly granted Bot may repair an unowned blocked Task using observed versions' : 'An UNBOUND Bot may correct unowned Mission work using observed versions' }, errors: [], input_schema: tool.parameters, output_schema: { type: 'object' } })),
      { name: 'list', operation: 'task_list', description: 'List Tasks by state, including work already in progress.', side_effect: 'read', idempotent: true,
        help: { when: 'Discover work before taking a Task' }, errors: [], input_schema: objectSchema({ state: { type: 'string' }, query: { type: 'string', maxLength: 4000 }, states: { type: 'array', items: { type: 'string' } }, limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: { type: 'string' }, available_only: { type: 'boolean' } }), output_schema: { type: 'object' } },
      { name: 'view', operation: 'task_view', description: 'Read a Task contract and current provenance in this Mission', side_effect: 'read', idempotent: true,
        help: { when: 'Inspect one Task before take' }, errors: [], input_schema: { ...objectSchema(viewProperties), required: ['task_id'] }, output_schema: { type: 'object' } },
      { name: 'take', operation: 'task_take', description: 'Atomically reserve one Task, prepare fixed inputs and grant the current Bot write access', side_effect: 'write', idempotent: true,
        help: { when: 'Take selected work; retry an unknown result using the same request ID' }, errors: [{ code: 'CONFLICT', retryable: false }, { code: 'NOT_ALLOWED', retryable: false }], input_schema: { ...objectSchema({ task_id: taskId }), required: ['task_id'] }, output_schema: { type: 'object' } },
    ] };
  function eligibleBot(botId: any, runtimeId: any) {
    if (closing) denied('Flat Task Service is closing');
    const bot = taskService.getBot(botId);
    if (!bot || bot.mission_id !== missionId || bot.core_id === runtimeId || bot.sandbox_id || !['UNBOUND', 'ACTIVE'].includes(bot.state)) denied('Flat caller has no eligible registered Bot');
    taskService.assertMissionResearchOpen(missionId);
    taskService.assertBotDeadline(botId);
    return bot;
  }
  const adapter: any = { async invoke({ capability, input, caller, envelope, signal, assertAuthorized }: any) {
    const operation = capability?.operation;
    if (!enabledOperations.includes(operation) || !input || typeof input !== 'object' || Array.isArray(input)) invalid('Unsupported flat Task operation or payload');
    const creating = operation === 'task_create';
    const coordination = enabledCoordination.includes(operation);
    const replacement = operation === 'task_dependency_replace';
    const allowed = creating ? Object.keys(createProperties) : coordination ? Object.keys(capability.input_schema.properties) : operation === 'task_list' ? ['state', 'states', 'query', 'limit', 'cursor', 'available_only']
      : operation === 'task_view' ? Object.keys(viewProperties) : ['task_id'];
    if (Object.keys(input).some((key: any) => !allowed.includes(key)) || (!creating && operation !== 'task_list' && (typeof input.task_id !== 'string' || !input.task_id))) invalid('Flat Task payload cannot supply actor, owner, Execution or resource identity');
    const core = getRuntime();
    if (!core?.id || caller?.runtimeId !== core.id || caller.profile !== profile || typeof caller.botId !== 'string' ||
        typeof envelope?.operation_id !== 'string' || !envelope.operation_id || envelope.operation_id.length > 256) denied('Flat caller is not this Runtime researcher');
    const key = stableStringify([core.id, caller.botId, envelope.operation_id]);
    const fingerprint = stableStringify({ operation, input, profile: caller.profile });
    const coordinated = coordinationRequests.get(key);
    if (coordinated && coordinated !== fingerprint) throw new MurmError('CONFLICT', 'Flat request ID has different parameters');
    const previous = requests.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new MurmError('CONFLICT', 'Flat request ID has different parameters');
      return structuredClone(await previous.work);
    }
    if (closing) denied('Flat Task Service is closing');
    signal?.throwIfAborted();
    const bot = eligibleBot(caller.botId, core.id);
    const admittedExecution = (replacement || creating) && bot.execution_id ? taskService.getExecution(bot.execution_id) : null;
    const live = await core.get(bot.bot_id);
    if (!['idle', 'running'].includes(live.status) || live.profile !== profile || closing || signal?.aborted) denied('Core researcher is unavailable');
    const coordinatedAfterAdmission = coordinationRequests.get(key);
    if (coordinatedAfterAdmission && coordinatedAfterAdmission !== fingerprint) throw new MurmError('CONFLICT', 'Flat request ID has different parameters');
    const joined = requests.get(key);
    if (joined) {
      if (joined.fingerprint !== fingerprint) throw new MurmError('CONFLICT', 'Flat request ID has different parameters');
      return structuredClone(await joined.work);
    }
    eligibleBot(bot.bot_id, core.id);
    if (operation === 'task_list') return taskService.dispatch(operation, { ...input, mission_id: missionId }, makeEnvelope({ actorRef: bot.bot_id }));
    if (creating) {
      assertAuthorized?.(); signal?.throwIfAborted();
      const current = eligibleBot(bot.bot_id, core.id);
      const execution = current.execution_id ? taskService.getExecution(current.execution_id) : null;
      if (current.execution_id !== bot.execution_id || execution?.fencing_version !== admittedExecution?.fencing_version) throw new MurmError('FENCED', 'Flat proposal binding changed during admission');
      const until = missionDeadline();
      if (!Number.isFinite(until) || Date.now() >= until) denied('Task proposal requires the current Mission budget');
      const id = `flat:proposal:${inputFingerprint([core.id, bot.bot_id, envelope.operation_id])}`;
      const domainEnvelope = execution ? { ...executionEnvelope(execution, id), actor_ref: bot.bot_id } : makeEnvelope({ operationId: id, actorRef: bot.bot_id });
      const result = taskService.dispatch(operation, { ...input, mission_id: missionId, workspace: { workspace_id: workspaceId } }, domainEnvelope);
      coordinationRequests.set(key, fingerprint);
      return result;
    }
    const task = taskService.getTask(input.task_id);
    if (!task || task.mission_id !== missionId) denied('Task does not belong to this Mission');
    if (coordination) {
      assertAuthorized?.(); signal?.throwIfAborted();
      const current = eligibleBot(bot.bot_id, core.id);
      const until = missionDeadline();
      if (!Number.isFinite(until) || Date.now() >= until) denied('Task correction requires the current Mission budget');
      if (!replacement && (current.state !== 'UNBOUND' || current.execution_id)) denied('Task revision and cancellation require an UNBOUND Bot');
      if (replacement && !current.coordination_permissions.includes(operation)) denied('Bot lacks the registered dependency-replacement grant');
      const execution = current.execution_id ? taskService.getExecution(current.execution_id) : null;
      if (replacement && (current.execution_id !== bot.execution_id || execution?.fencing_version !== admittedExecution?.fencing_version)) throw new MurmError('FENCED', 'Flat coordination binding changed during admission');
      const id = `flat:coordination:${inputFingerprint([core.id, bot.bot_id, envelope.operation_id])}`;
      // The target is input; ACTIVE authority is the caller's own Execution.
      // The domain owns durable replay, CAS and history. Replays repeat admission.
      const domainEnvelope = execution ? { ...executionEnvelope(execution, id), actor_ref: bot.bot_id } : makeEnvelope({ operationId: id, actorRef: bot.bot_id });
      if (replacement) taskService.assertMissionCoordination(domainEnvelope, operation);
      const result = taskService.dispatch(operation, input, domainEnvelope);
      coordinationRequests.set(key, fingerprint);
      return result;
    }
    if (operation === 'task_view') {
      if (task.workspace?.workspace_id && task.workspace.workspace_id !== workspaceId) denied('Task Workspace belongs to another Environment');
      const snapshot = await missionWorkspace.exportRevision({ workspaceId, revision: task.workspace?.revision ?? 'main', signal });
      signal?.throwIfAborted();
      eligibleBot(bot.bot_id, core.id);
      if (snapshot.mission_id !== missionId) denied('Preview Workspace belongs to another Mission');
      previews.set(bot.bot_id, { revision: snapshot.revision, workspace_id: workspaceId });
      return taskService.dispatch(operation, input, makeEnvelope({ actorRef: bot.bot_id, taskId: task.task_id }));
    }
    const id = `flat:${inputFingerprint([core.id, bot.bot_id, envelope.operation_id])}`;
    // Claim conflicts never enter compensation. No Core stop is issued for a
    // Bot that simply lost an ordinary race for someone else's ready Task.
    const taken = taskService.takeTask(task.task_id, { take_key: `${id}:take`, owner_ref: bot.bot_id, core_id: bot.core_id,
      agent_prompt: researcherPrompt, input_material_refs: task.input_material_refs }, makeEnvelope({ operationId: `${id}:take`, actorRef: bot.bot_id,
      taskId: task.task_id, specVersion: task.spec_version, stateVersion: task.state_version }));
    const request: any = { id, botId: bot.bot_id, requestId: envelope.operation_id, fingerprint, taken, stage: 'reserved' };
    // Register synchronously before entering any asynchronous preparation.
    const work = Promise.resolve().then(() => runTaskPoolHandoff({ request, runtime: core, taskService, missionId, missionWorkspace, workspaceId,
      workspaceManager, contextService, executionTimeoutMs, handoffLeadMs, missionDeadline, heartbeatMs, preparationTimeoutMs, stopTimeoutMs,
      isClosing: () => closing, signal, preview: previews.get(bot.bot_id) }));
    request.work = work;
    requests.set(key, request); active.add(work);
    void work.finally(() => active.delete(work)).catch(() => {});
    return structuredClone(await work);
  } };
  return { manifest, adapter,
    inspect(botId: any, requestId: any) {
      const core = getRuntime();
      const request = requests.get(stableStringify([core?.id, botId, requestId]));
      return request ? structuredClone(inspectRequest(request)) : null;
    },
    async reconcile(botId: any, requestId: any) {
      const core = getRuntime();
      const request = requests.get(stableStringify([core?.id, botId, requestId]));
      if (!request || request.stage !== 'failed') denied('Only an owned failed flat handoff can be reconciled');
      await stopFailedHandoff({ request, runtime: core, taskService, stopTimeoutMs });
      return structuredClone(inspectRequest(request));
    },
    async close({ timeoutMs = stopTimeoutMs }: any = {}) {
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) invalid('Flat close timeout must be positive and finite');
      closing = true;
      let timer: any;
      try { await Promise.race([Promise.allSettled([...active]), new Promise<any>((resolve: any) => { timer = setTimeout(resolve, timeoutMs); })]); }
      finally { clearTimeout(timer); }
      return { handoffs: [...requests.values()].map(inspectRequest), pending: active.size };
    },
  };
}

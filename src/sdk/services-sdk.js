import { asSwarmEnvError } from '../errors.js';
import { makeEnvelope } from '../protocol/envelope.js';

/**
 * Agent-facing public boundary. The method list is deliberately limited to
 * Task/Execution and Context Service operations; Workspace Manager is a
 * Runtime-internal capability and is not reachable from this class.
 */
export class ServicesSDK {
  constructor(service, context) {
    if (!service || typeof service.dispatch !== 'function') {
      throw new TypeError('ServicesSDK requires a service with dispatch(operation, payload, envelope)');
    }
    if (!context?.actorRef) throw new TypeError('ServicesSDK requires actorRef');
    this.service = service;
    this.context = { ...context };
  }

  withContext(overrides) {
    return new ServicesSDK(this.service, { ...this.context, ...overrides });
  }

  getTask(taskId = this.context.taskId) {
    return this.#read('get_task', { task_id: taskId });
  }

  getExecution(executionId = this.context.executionId) {
    return this.#read('get_execution', { execution_id: executionId });
  }

  listTasks(filters = {}) {
    return this.#read('list_tasks', filters);
  }

  /** Create a Mission objective; the Mission itself is never eligible. */
  createMission(mission, options = {}) {
    return this.#write('create_mission', mission, { ...options, taskId: null, executionId: null, fencingVersion: null });
  }

  getMission(missionId) {
    return this.#read('get_mission', { mission_id: missionId });
  }

  /** Create an ordinary Mission Task; a bound Execution may propose work without releasing itself. */
  createTask(task, options = {}) {
    return this.#write('create_task', task, options);
  }

  listMissionTasks(filters = {}) {
    return this.#read('list_task', filters);
  }

  /** Read the authoritative Mission/task view used by an active identity. */
  taskStatus(filters = {}) {
    return this.#read('task_status', filters);
  }

  viewTask(taskId = this.context.taskId) {
    return this.#read('view_task', { task_id: taskId });
  }

  linkMaterial(payload = {}, options = {}) {
    return this.#write('task_link_material', payload, options);
  }

  listTaskMaterials(taskId = this.context.taskId, filters = {}) {
    return this.#read('list_task_materials', { ...filters, task_id: taskId });
  }

  finishTask(payload = {}, options = {}) {
    return this.#write('task_finish', payload, options);
  }

  listExecutions(taskId = this.context.taskId, { includeTerminal = true } = {}) {
    return this.#read('list_executions', { task_id: taskId, include_terminal: includeTerminal });
  }

  listServices() {
    return this.#read('list_services', {});
  }

  getServiceMetadata(service) {
    return this.#read('get_service_metadata', { service });
  }

  listTools(service = null) {
    return this.#read('list_tools', service === null ? {} : { service });
  }

  readMaterials(filters = {}) {
    return this.#read('read_materials', filters);
  }

  searchMaterials(filters = {}) {
    return this.#read('context_search_materials', filters);
  }

  getMaterial(materialId) {
    return this.#read('context_get_material', { material_id: materialId });
  }

  publishCollaborationMaterial(material, options = {}) {
    return this.#write('context_publish_material', material, options);
  }

  /** Record the bounded Material IDs this Execution actually used. */
  consumeMaterials(payload = {}, options = {}) {
    return this.#write('consume_materials', payload, options);
  }

  listMaterialConsumptions(filters = {}) {
    return this.#read('list_material_consumptions', filters);
  }

  getCheckResult(checkResultId, { requestKey = null } = {}) {
    return this.#read('get_check_result', requestKey ? { request_key: requestKey } : { check_result_id: checkResultId });
  }

  /** Register one independent responsibility with the current identity provenance. */
  taskRegister(task, options = {}) {
    return this.#write('task_register', task, options);
  }

  /** Take an existing Mission/ordinary Task through the canonical Agent seam. */
  taskTake(payload = {}, options = {}) {
    const contextCoreId = this.context.coreId ?? this.context.core_id ?? null;
    return this.#write('task_take', {
      ...payload,
      // Agent identity and Core lane come from the bound SDK context. Keep
      // payload fields as a compatibility fallback only for unbound local
      // callers that have no lane context yet.
      owner_ref: this.context.actorRef,
      ...(contextCoreId !== null ? { core_id: contextCoreId } : {}),
    }, options);
  }

  /** Record the current Execution's decision and action for delivered feedback. */
  taskFeedback(payload = {}, options = {}) {
    return this.#write('task_feedback', payload, options);
  }

  /** Save Progress Material and checkpoint or hand off the current Execution. */
  executionProgress(payload = {}, options = {}) {
    return this.#write('execution_progress', payload, options);
  }

  heartbeat(payload = {}, options = {}) {
    return this.#write('heartbeat', payload, options);
  }

  requestWait(payload, options = {}) {
    return this.#write('request_wait', payload, options);
  }

  publishMaterial(material, options = {}) {
    return this.#write('publish_material', material, options);
  }

  #read(operation, payload) {
    try {
      return this.service.dispatch(operation, payload, this.#envelope({ operationId: undefined }));
    } catch (error) {
      throw asSwarmEnvError(error);
    }
  }

  #write(operation, payload, options) {
    try {
      return this.service.dispatch(operation, payload, this.#envelope(options));
    } catch (error) {
      throw asSwarmEnvError(error);
    }
  }

  #envelope({
    operationId,
    actorRef = this.context.actorRef,
    taskId = this.context.taskId ?? null,
    executionId = this.context.executionId ?? null,
    specVersion = this.context.specVersion ?? null,
    stateVersion = this.context.stateVersion ?? null,
    fencingVersion = this.context.fencingVersion ?? null,
  } = {}) {
    return makeEnvelope({
      operationId,
      actorRef,
      taskId,
      executionId,
      specVersion,
      stateVersion,
      fencingVersion,
    });
  }
}

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

  /** Create a Mission objective; the Mission itself is never eligible. */
  createMission(mission, options = {}) {
    return this.#write('mission_create', mission, { ...options, taskId: null, executionId: null, fencingVersion: null });
  }

  getMission(missionId) {
    return this.#read('mission_get', { mission_id: missionId });
  }

  /** Create an ordinary Mission Task; a bound Execution may propose work without releasing itself. */
  createTask(task, options = {}) {
    return this.#write('task_create', task, options);
  }

  listMissionTasks(filters = {}) {
    return this.#read('task_list', filters);
  }

  /** Read the authoritative Mission/task view used by an active identity. */
  taskStatus(filters = {}) {
    return this.#read('task_status', filters);
  }

  viewTask(taskId = this.context.taskId) {
    return this.#read('task_view', { task_id: taskId });
  }

  linkMaterial(payload = {}, options = {}) {
    return this.#write('task_link_material', payload, options);
  }

  listTaskMaterials(taskId = this.context.taskId, filters = {}) {
    return this.#read('task_materials', { ...filters, task_id: taskId });
  }

  finishTask(payload = {}, options = {}) {
    return this.#write('task_finish', payload, options);
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

  /** Take an existing Mission/ordinary Task through the canonical Agent seam. */
  taskTake(payload = {}, options = {}) {
    const contextCoreId = this.context.coreId ?? this.context.core_id ?? null;
    if (typeof this.context.actorRef !== 'string' || this.context.actorRef.length === 0) {
      throw new TypeError('task_take requires the authenticated actor context');
    }
    return this.#write('task_take', {
      ...payload,
      owner_ref: this.context.actorRef,
      ...(contextCoreId !== null ? { core_id: contextCoreId } : {}),
    }, options);
  }

  /** Record the current Execution's decision and action for delivered feedback. */
  taskFeedback(payload = {}, options = {}) {
    return this.#write('task_feedback', payload, options);
  }

  heartbeat(payload = {}, options = {}) {
    return this.#write('heartbeat', payload, options);
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

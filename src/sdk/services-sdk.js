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

  readMaterials(filters = {}) {
    return this.#read('read_materials', filters);
  }

  claim(payload = {}, options = {}) {
    return this.#write('claim', payload, options);
  }

  heartbeat(payload = {}, options = {}) {
    return this.#write('heartbeat', payload, options);
  }

  requestWait(payload, options = {}) {
    return this.#write('request_wait', payload, options);
  }

  submitCandidate(payload, options = {}) {
    return this.#write('submit_candidate', payload, options);
  }

  publishMaterial(material, options = {}) {
    return this.#write('publish_material', material, options);
  }

  abort(payload = {}, options = {}) {
    return this.#write('abort', payload, options);
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

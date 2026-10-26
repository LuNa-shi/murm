import { asSwarmEnvError } from '../errors.js';
import { makeEnvelope } from '../protocol/envelope.js';

function taskReadPayload(taskOrPayload) {
  if (taskOrPayload && typeof taskOrPayload === 'object' && !Array.isArray(taskOrPayload)) return taskOrPayload;
  return { task_id: taskOrPayload };
}

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

  listClaimableTasks(filters = {}) {
    return this.#read('list_claimable_tasks', filters);
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

  getCheckResult(checkResultId) {
    return this.#read('get_check_result', { check_result_id: checkResultId });
  }

  proposeTask(task, options = {}) {
    return this.#write('propose_task', task, { ...options, taskId: null, executionId: null, fencingVersion: null });
  }

  createChildTask(task, options = {}) {
    return this.#write('create_child_task', task, {
      ...options,
      stateVersion: options.stateVersion ?? options.taskStateVersion ?? this.context.stateVersion ?? this.context.taskStateVersion,
    });
  }

  /**
   * Create alternative ordinary Tasks that pursue the same parent objective.
   * The Task Service records the branch relationship; it is not an ownership
   * or implicit execution-wait dependency.
   */
  createBranchGroup(payload = {}, options = {}) {
    return this.#write('create_branch_group', payload, {
      ...options,
      stateVersion: options.stateVersion ?? options.taskStateVersion ?? this.context.stateVersion ?? this.context.taskStateVersion,
    });
  }

  /** Add a jointly required ordinary Task to an existing Task or branch. */
  addRequiredSubtask(payload = {}, options = {}) {
    return this.#write('add_required_subtask', payload, {
      ...options,
      stateVersion: options.stateVersion ?? options.taskStateVersion ?? this.context.stateVersion ?? this.context.taskStateVersion,
    });
  }

  /** Read the durable branch, subtask, dependency, and provenance structure. */
  getTaskStructure(taskOrPayload = this.context.taskId) {
    return this.#read('get_task_structure', taskReadPayload(taskOrPayload));
  }

  /** Propose an auditable additive or explicitly versioned structure change. */
  proposeStructureChange(payload = {}, options = {}) {
    return this.#write('propose_structure_change', payload, {
      ...options,
      stateVersion: options.stateVersion ?? options.taskStateVersion ?? this.context.stateVersion ?? this.context.taskStateVersion,
    });
  }

  /** Explain which contract or explicit dependency makes a Task ready/blocking. */
  explainTaskReadiness(taskOrPayload = this.context.taskId) {
    return this.#read('explain_task_readiness', taskReadPayload(taskOrPayload));
  }

  /** Create a new rework responsibility linked to prior evidence and feedback. */
  createReworkTask(payload = {}, options = {}) {
    return this.#write('create_rework_task', payload, {
      ...options,
      stateVersion: options.stateVersion ?? options.taskStateVersion ?? this.context.stateVersion ?? this.context.taskStateVersion,
    });
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

  acceptTask(payload = {}, options = {}) {
    return this.#write('accept_task', payload, options);
  }

  requestRework(payload, options = {}) {
    return this.#write('request_rework', payload, options);
  }

  applyCheckResult(payload, options = {}) {
    return this.#write('apply_check_result', payload, options);
  }

  wakeExecution(payload = {}, options = {}) {
    return this.#write('wake_execution', payload, options);
  }

  publishMaterial(material, options = {}) {
    return this.#write('publish_material', material, options);
  }

  abort(payload = {}, options = {}) {
    return this.#write('abort', payload, options);
  }

  startExecution(payload = {}, options = {}) {
    return this.#write('start_execution', payload, options);
  }

  resumeExecution(payload = {}, options = {}) {
    return this.#write('resume_execution', payload, options);
  }

  stopExecution(payload = {}, options = {}) {
    return this.#write('stop_execution', payload, options);
  }

  fenceExecution(payload = {}, options = {}) {
    return this.#write('fence_execution', payload, options);
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

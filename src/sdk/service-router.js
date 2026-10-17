const TASK_OPERATIONS = new Set([
  'abort', 'claim', 'create_child_task', 'fence_execution', 'get_execution', 'get_task', 'heartbeat', 'list_children',
  'propose_task', 'request_wait', 'resume_execution', 'start_execution', 'stop_execution',
]);
const CONTEXT_OPERATIONS = new Set(['freeze_initial_context', 'publish_material', 'read_materials']);

export class ServicesRouter {
  constructor({ taskService, contextService }) {
    this.taskService = taskService;
    this.contextService = contextService;
  }

  dispatch(operation, payload, envelope) {
    if (TASK_OPERATIONS.has(operation)) return this.taskService.dispatch(operation, payload, envelope);
    if (CONTEXT_OPERATIONS.has(operation)) return this.contextService.dispatch(operation, payload, envelope);
    throw new Error(`no service route for operation: ${operation}`);
  }
}

export function createServicesRouter(services) {
  return new ServicesRouter(services);
}

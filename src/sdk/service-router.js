import { getServiceMetadata, listServices, listTools } from './service-catalog.js';

const TASK_OPERATIONS = new Set([
  'abort', 'claim', 'create_child_task', 'fence_execution', 'get_execution', 'get_task', 'heartbeat', 'list_children', 'list_tasks', 'list_claimable_tasks', 'list_executions',
  'propose_task', 'request_wait', 'resume_execution', 'start_execution', 'stop_execution', 'submit_candidate',
  'accept_task', 'request_rework', 'apply_check_result', 'wake_execution',
  'create_branch_group', 'add_required_subtask', 'get_task_structure', 'propose_structure_change', 'explain_task_readiness', 'create_rework_task',
  'create_mission', 'get_mission', 'create_task', 'list_task', 'view_task', 'task_list', 'task_view', 'task_create',
  'link_material', 'task_link_material', 'list_task_materials', 'task_materials', 'complete_task', 'task_complete', 'close_task', 'task_close', 'handoff_task', 'task_handoff', 'block_task_semantic', 'task_block',
]);
const CONTEXT_OPERATIONS = new Set([
  'publish_material', 'context.publish_material', 'context_publish_material',
  'read_materials', 'context.read_materials', 'context_read_materials',
  'search_materials', 'context.search_materials', 'context_search_materials',
  'get_material', 'context.get_material', 'context_get_material',
  'consume_materials', 'list_material_consumptions',
]);
const JUDGE_OPERATIONS = new Set(['get_check_result']);

export class ServicesRouter {
  constructor({ taskService, contextService, judgeService = null, logger = null }) {
    this.taskService = taskService;
    this.contextService = contextService;
    this.judgeService = judgeService;
    this.logger = logger;
  }

  dispatch(operation, payload, envelope) {
    this.logger?.append({
      event: 'route.start',
      operation,
      actor_ref: envelope?.actor_ref ?? null,
      task_id: envelope?.task_id ?? null,
      execution_id: envelope?.execution_id ?? null,
    });
    try {
      const result = operation === 'list_services'
        ? { services: listServices() }
        : operation === 'get_service_metadata'
          ? getServiceMetadata(payload?.service ?? null)
          : operation === 'list_tools'
            ? { tools: listTools(payload?.service ?? null) }
            : TASK_OPERATIONS.has(operation)
        ? this.taskService.dispatch(operation, payload, envelope)
        : CONTEXT_OPERATIONS.has(operation)
          ? this.contextService.dispatch(operation, payload, envelope)
          : JUDGE_OPERATIONS.has(operation) && this.judgeService
            ? this.judgeService.dispatch(operation, payload, envelope)
            : (() => { throw new Error(`no service route for operation: ${operation}`); })();
      this.logger?.append({ event: 'route.complete', operation, ok: true });
      return result;
    } catch (error) {
      this.logger?.append({ event: 'route.complete', operation, ok: false, error: { name: error.name, code: error.code, message: error.message } });
      throw error;
    }
  }
}

export function createServicesRouter(services) {
  return new ServicesRouter(services);
}

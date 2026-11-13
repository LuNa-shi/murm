import { createBuiltinServiceRegistry } from './builtin-registry.js';
import { ERROR_CODES, SwarmEnvError } from '../errors.js';

const TASK_OPERATIONS = new Set([
  'abort', 'claim', 'fence_execution', 'get_execution', 'get_task', 'heartbeat', 'list_tasks', 'list_claimable_tasks', 'list_executions',
  'request_wait', 'resume_execution', 'start_execution', 'stop_execution', 'submit_candidate',
  'apply_check_result', 'wake_execution',
  'create_mission', 'get_mission', 'create_task', 'list_task', 'view_task', 'task_list', 'task_view', 'task_create',
  'task_status', 'task_register', 'task_take', 'task_feedback', 'execution_progress',
  'link_material', 'task_link_material', 'list_task_materials', 'task_materials', 'complete_task', 'task_complete', 'close_task', 'task_close', 'handoff_task', 'task_handoff', 'block_task_semantic', 'task_block',
]);
const CONTEXT_OPERATIONS = new Set([
  'publish_material', 'context.publish_material', 'context_publish_material',
  'read_materials', 'context.read_materials', 'context_read_materials',
  'search_materials', 'context.search_materials', 'context_search_materials',
  'get_material', 'context.get_material', 'context_get_material',
  'consume_materials', 'list_material_consumptions',
  'material.publish', 'material_publish', 'material.read', 'material_read',
  'material.search', 'material_search', 'material.get', 'material_get', 'material_dispute', 'material.dispute',
  'material_supersede', 'material.supersede', 'material_unsupersede', 'material.unsupersede',
]);
const JUDGE_OPERATIONS = new Set(['get_check_result']);

export class ServicesRouter {
  constructor({ taskService, contextService, judgeService = null, registry = null, serviceEndpoints = {}, customServices = [], logger = null } = {}) {
    this.taskService = taskService;
    this.contextService = contextService;
    this.judgeService = judgeService;
    this.registry = registry ?? createBuiltinServiceRegistry({ taskService, contextService, judgeService, serviceEndpoints, customServices });
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
      // ServicesSDK is intentionally synchronous because the local control
      // plane performs Task/Context/Judge writes in one SQLite transaction.
      // Remote HTTP providers are invoked asynchronously by ServicesBridge;
      // never leak an HTTP Promise through this legacy-free local router.
      const registered = this.registry?.listTools?.()
        .filter((candidate) => candidate.operation === operation || candidate.name === operation) ?? [];
      if (registered.length > 1) throw new Error(`ambiguous service route for operation: ${operation}`);
      const result = registered.length === 1
        ? (() => {
          const entry = this.registry.getCapability(registered[0].service_id, registered[0].name);
          if (entry.adapter?.kind === 'http-json') {
            throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, `HTTP Service ${registered[0].service_id} requires asynchronous dispatch`, {
              service_id: registered[0].service_id,
              capability: registered[0].name,
              dispatch: 'dispatchAsync',
            }, { retryable: true });
          }
          const localResult = this.registry.invokeSync({
            serviceId: registered[0].service_id,
            capability: registered[0].name,
            input: payload,
            envelope,
          });
          if (localResult && typeof localResult.then === 'function') {
            throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, `Service ${registered[0].service_id} returned an asynchronous result`, {
              service_id: registered[0].service_id,
              capability: registered[0].name,
              dispatch: 'dispatchAsync',
            }, { retryable: true });
          }
          return localResult;
        })()
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

  async dispatchAsync(operation, payload, envelope) {
    this.logger?.append({
      event: 'route.start',
      operation,
      actor_ref: envelope?.actor_ref ?? null,
      task_id: envelope?.task_id ?? null,
      execution_id: envelope?.execution_id ?? null,
    });
    try {
      const registered = this.registry?.listTools?.().filter((candidate) => candidate.operation === operation || candidate.name === operation) ?? [];
      if (registered.length > 1) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `ambiguous service route for operation: ${operation}`);
      if (registered.length === 1) {
        const result = await this.registry.invoke({
          serviceId: registered[0].service_id,
          capability: registered[0].name,
          input: payload,
          envelope,
        });
        this.logger?.append({ event: 'route.complete', operation, ok: true });
        return result;
      }
      const result = this.dispatch(operation, payload, envelope);
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

export const COMMAND_OPERATIONS = Object.freeze({
  'mathlib-search': { search: 'mathlib_search' },
  agent: { exit: 'agent_exit' },
  task: { create: 'task_create', list: 'task_list', view: 'task_view', take: 'task_take', finish: 'task_finish', feedback: 'task_feedback', link: 'task_link_material', status: 'task_status', revise: 'task_revise', cancel: 'task_cancel', 'dependency-replace': 'task_dependency_replace' },
  material: { list: 'read_materials', view: 'context_get_material', search: 'context_search_materials', publish: 'context_publish_material', consume: 'consume_materials', dispute: 'material_dispute', supersede: 'material_supersede', unsupersede: 'material_unsupersede' },
  workspace: { view: 'workspace_public_view', history: 'workspace_public_history', status: 'workspace_status', diff: 'workspace_current_diff', 'public-diff': 'workspace_public_diff', files: 'workspace_public_files', read: 'workspace_public_read', search: 'workspace_public_search', save: 'workspace_save', apply: 'workspace_apply', merge: 'workspace_merge' },
  mission: { view: 'mission_get', submit: 'mission_submit', 'submission view': 'mission_submission_get' },
  judge: { check: 'workspace_check', result: 'get_check_result' },
});

export function transportService(service: string) { return service === 'material' ? 'context' : service === 'agent' ? 'task' : service; }

const commands: Readonly<Record<string, Readonly<Record<string, string>>>> = COMMAND_OPERATIONS;

function serviceAliases(service: string) {
  return Object.hasOwn(commands, service) ? commands[service] : {};
}

export function operationForCommand(service: string, command: string): string | undefined {
  const aliases = serviceAliases(service);
  return Object.hasOwn(aliases, command) ? aliases[command] : undefined;
}

export function serviceCommand(service: string, operation: string): string {
  const group = service === 'context' ? 'material' : service === 'task' && operation === 'agent_exit' ? 'agent' : service;
  const aliases = serviceAliases(group);
  const alias = Object.keys(aliases).find(command => aliases[command] === operation);
  if (service === 'material' || service === 'service' || (group === 'mission' && operation === 'submission') ||
      (!alias && operationForCommand(group, operation))) {
    return `swarm service invoke ${service} ${operation}`;
  }
  const command = alias ?? operation;
  return `swarm ${group} ${command}`;
}

export const COMMAND_OPERATIONS = Object.freeze({
  'mathlib-search': { search: 'mathlib_search' },
  bot: { exit: 'bot_exit' },
  task: { list: 'task_list', view: 'task_view', take: 'task_take', finish: 'task_finish', feedback: 'task_feedback', link: 'task_link_material', status: 'task_status', revise: 'task_revise', cancel: 'task_cancel', 'dependency-replace': 'task_dependency_replace' },
  material: { list: 'read_materials', view: 'context_get_material', search: 'context_search_materials', publish: 'context_publish_material', consume: 'consume_materials', dispute: 'material_dispute', supersede: 'material_supersede', unsupersede: 'material_unsupersede' },
  workspace: { view: 'workspace_public_view', history: 'workspace_public_history', status: 'workspace_status', diff: 'workspace_current_diff', files: 'workspace_public_files', read: 'workspace_public_read', search: 'workspace_public_search', save: 'workspace_save', merge: 'workspace_merge' },
  mission: { view: 'mission_get', submit: 'mission_submit', 'submission view': 'mission_submission_get' },
  judge: { check: 'workspace_check', result: 'get_check_result' },
});

export function transportService(service: string) { return service === 'material' ? 'context' : service === 'bot' ? 'task' : service; }

export function serviceCommand(service: string, operation: string): string {
  const group = service === 'context' ? 'material' : service === 'task' && operation === 'bot_exit' ? 'bot' : service;
  const commands: Readonly<Record<string, Readonly<Record<string, string>>>> = COMMAND_OPERATIONS;
  const aliases = Object.hasOwn(commands, group) ? commands[group] : {};
  const command = Object.keys(aliases).find(alias => aliases[alias] === operation) ?? operation;
  return `swarm ${group} ${command}`;
}

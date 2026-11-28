import { isSoftCloseout } from '../services/task/execution-budget.js';

export const AGENT_CONTINUATION_MESSAGE = 'Continue the current Task/E. Check the remaining budget, actual Workspace state, and new Material or checker feedback before advancing your current responsibility. When closing out, save useful files and publish useful Material, then call swarm task finish with the actual outcome. Do not claim success for unsaved, unconfirmed, or failed operations.';


export const AGENT_SOFT_CLOSEOUT_MESSAGE = 'The current Task/E has entered its soft closeout window. Stop expanding your responsibility or starting new computation. Only save existing useful files, publish existing research content, and call swarm task finish with the actual outcome. Do not propose new Tasks, start new Judge checks or Mission acceptance, or merge main. Query or replay accepted requests with their original IDs. Do not claim success for results whose durable persistence has not been confirmed.';
export const AGENT_MATERIAL_CONTINUATION_MESSAGE = 'Continue the current Task/E. Check the remaining budget, public Workspace, and new Material or checker feedback before advancing your current responsibility. When closing out, publish useful Material and call swarm task finish according to the actual completion conditions. Only results with confirmed durable persistence can establish completion.';
export const AGENT_MATERIAL_SOFT_CLOSEOUT_MESSAGE = 'The current Task/E has entered its soft closeout window. Stop expanding your responsibility or starting new computation. Publish existing research content and call swarm task finish with the actual outcome. Do not start new Judge checks or Mission acceptance, or merge main. Query or replay accepted requests with their original IDs. Do not claim success for results whose durable persistence has not been confirmed.';

export function buildAgentSoftCloseoutNotice(executionId: any, deadline: any, at: any = Date.now(), { workspaceSaveAvailable = true }: any = {}) {
  const remaining = Math.max(0, Date.parse(deadline ?? '') - at);
  const closeout = workspaceSaveAvailable ? 'save existing files and research content' : 'publish existing research content';
  return `E ${executionId} is approaching its Execution time limit. Remaining closeout budget: ${Number.isFinite(remaining) ? remaining + ' ms' : 'unknown'}. Stop expanding work, ${closeout}, then finish with the actual outcome.`;
}

export function buildAgentContinuationMessage(execution: any, {
  workspaceSaveAvailable = true,
  ordinary = workspaceSaveAvailable ? AGENT_CONTINUATION_MESSAGE : AGENT_MATERIAL_CONTINUATION_MESSAGE,
  at = Date.now(),
}: any = {}) {
  if (!isSoftCloseout(execution, at)) return ordinary;
  const notice = buildAgentSoftCloseoutNotice(execution.execution_id, execution.execution_deadline, at, { workspaceSaveAvailable });
  return `${notice}\n${workspaceSaveAvailable ? AGENT_SOFT_CLOSEOUT_MESSAGE : AGENT_MATERIAL_SOFT_CLOSEOUT_MESSAGE}`;
}


export function buildAgentNotification(notification: any, { at = Date.now(), workspaceSaveAvailable = true }: any = {}) {
  const payload = notification.payload ?? {};
  if (notification.notification_type === 'handoff_warning') return `${buildAgentSoftCloseoutNotice(payload.execution_id, payload.deadline, at, { workspaceSaveAvailable })} Notification ID: ${notification.notification_id}`;
  if (notification.notification_type === 'material_available') return `Material ${notification.material_id ?? payload.material_id ?? '<unknown>'}, published by Task ${notification.source_task_id ?? payload.producer_task_id ?? '<unknown>'} / Execution ${notification.source_execution_id ?? payload.producer_execution_id ?? '<unknown>'}, is now linked to the current Task. Read it with swarm material view, assess its actual impact, and record your response with swarm task feedback --notification-id ${notification.notification_id} --decision ... --action ... . This notification does not establish that the result is correct or end the current E.`;
  return `Dependencies for Task ${notification.recipient_task_id} have changed. Check the current contract and state with swarm task view. This notification does not automatically grant a Task/E.`;
}


export function agentServiceDirectory(profile: any) {
  const entries: any[] = [];
  for (const service of profile.services ?? []) {
    const id = service.service_id ?? service.id;
    if (id === 'runtime') continue;
    const namespaces = id === 'task' ? ['mission', 'task', 'workspace', 'agent'] : id === 'context' ? ['material'] : id === 'catalog' ? ['service'] : [id];
    for (const name of namespaces) entries.push({ name, provider_service: id, provider_version: service.provider_version ?? null, manifest_hash: service.manifest_hash ?? null,
      help: `swarm ${name} --help`, manifest_help: `swarm service view ${id} --json`,
      documentation: service.documentation ?? [],
      permission: (({ mission: 'read public acceptance state; submit fixed main and explicit Materials only with a Mission coordination grant', task: 'Mission reads and direct take; Task creation requires an enabled task_create capability and permits UNBOUND or ACTIVE proposals in the same Mission; only UNBOUND may revise or cancel open unowned Tasks using observed versions; finish and feedback require current E; dependency replacement requires a coordination grant', workspace: 'public view/history/files/read/search and revision-pair diff before take; status/current-E diff/save and checked merge require current E', material: 'Mission reads/search; publication, use and correction require current E; explicitly granted coordination can only revoke a matching supersession', judge: 'checks and result reads require current active E', agent: 'exit only when unbound with no pending take', service: 'configured service metadata only' } as Record<string, any>))[name] ?? 'consult registered operation metadata; Bridge enforces current binding',
    });
  }
  return entries;
}

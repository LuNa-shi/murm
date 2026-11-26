import { isSoftCloseout } from '../task/execution-budget.js';

export const AGENT_CONTINUATION_MESSAGE = '继续当前 Task/E。先核对剩余预算、真实 Workspace 状态和新的 Material/检查反馈，再推进当前责任。需要收尾时先保存有用文件、发布有用 Material，再以真实 outcome 调用 swarm task finish；未保存、未确认或失败的操作不能声明成功。';


export const AGENT_SOFT_CLOSEOUT_MESSAGE = '当前 Task/E 已进入软收尾窗口。停止扩展责任和发起新计算；仅保存已有有用文件、发布已有研究内容并调用 swarm task finish 给出真实 outcome。不要提出新 Task、发起新 Judge 检查、Mission 验收或 merge main。已受理请求使用原 ID 查询或重放，未确认持久成功的成果不能声明成功。';
export const AGENT_MATERIAL_CONTINUATION_MESSAGE = '继续当前 Task/E。先核对剩余预算、公开 Workspace 和新的 Material/检查反馈，再推进当前责任。收尾时发布有用 Material，并按真实完成条件调用 swarm task finish；只有已确认持久保存的成果才能作为完成依据。';
export const AGENT_MATERIAL_SOFT_CLOSEOUT_MESSAGE = '当前 Task/E 已进入软收尾窗口。停止扩展责任和发起新计算；发布已有研究内容并调用 swarm task finish 给出真实 outcome。不要发起新 Judge 检查、Mission 验收或 merge main。已受理请求使用原 ID 查询或重放，未确认持久成功的成果不能声明成功。';

export function buildAgentSoftCloseoutNotice(executionId: any, deadline: any, at: any = Date.now(), { workspaceSaveAvailable = true }: any = {}) {
  const remaining = Math.max(0, Date.parse(deadline ?? '') - at);
  const closeout = workspaceSaveAvailable ? '保存已有文件和研究内容' : '发布已有研究内容';
  return `E ${executionId} 接近 Execution 时间上限，收尾额度为 ${Number.isFinite(remaining) ? remaining + ' ms' : '未知'}。停止扩展，${closeout}，再按真实结果 finish。`;
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
  if (notification.notification_type === 'handoff_warning') return `${buildAgentSoftCloseoutNotice(payload.execution_id, payload.deadline, at, { workspaceSaveAvailable })} 通知 ID: ${notification.notification_id}`;
  if (notification.notification_type === 'material_available') return `Task ${notification.source_task_id ?? payload.producer_task_id ?? '<unknown>'} / Execution ${notification.source_execution_id ?? payload.producer_execution_id ?? '<unknown>'} 发布的 Material ${notification.material_id ?? payload.material_id ?? '<unknown>'} 已关联到当前 Task。用 swarm material view 读取，判断实际影响，并用 swarm task feedback --notification-id ${notification.notification_id} --decision ... --action ... 记录处理。通知本身不证明成果正确，也不结束当前 E。`;
  return `Task ${notification.recipient_task_id} 的依赖状态已更新；通过 swarm task view 核对当前合同与状态。通知不自动授予 Task/E。`;
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

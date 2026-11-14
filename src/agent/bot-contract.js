import { isSoftCloseout } from '../task/execution-budget.js';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const BOT_PROTOCOL_VERSION = 'swarm-bot-v1-draft.2';
export const BOT_TOOL_NAMES = Object.freeze(['read', 'write', 'edit', 'bash']);
const body = name => readFileSync(new URL(`./bot-contract/${name}`, import.meta.url), 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');
export const BOT_SYSTEM_PROMPT = body('system.txt').trimEnd();
export const BOT_SYSTEM_HASH = hash(BOT_SYSTEM_PROMPT);
export const BOT_SYSTEM_RESOURCE = Object.freeze({ path: '/opt/swarmenv/src/agent/bot-contract/system.txt', sha256: hash(body('system.txt')) });
export const BOT_SKILLS = Object.freeze(['plan-task', 'use-material', 'use-workspace', 'finish-task'].map(name => {
  const content = body(`${name}.md`);
  return Object.freeze({ name, version: 'draft.2', path: `/opt/swarmenv/src/agent/bot-contract/${name}.md`,
    description: content.match(/^description: (.+)$/m)[1], sha256: hash(content) });
}));

export const BOT_RESOURCES = Object.freeze([BOT_SYSTEM_RESOURCE, ...BOT_SKILLS.map(({ path, sha256 }) => Object.freeze({ path, sha256 }))]);

export function buildBotStartupMessage({ mission, bot, workspace, sessionId, budget, services, project, eligibleTasks, observedAt = new Date().toISOString(), firstTurn = true }) {
  if (!mission?.mission_id || !bot?.bot_id || bot.mission_id !== mission.mission_id || bot.state !== 'UNBOUND' || bot.execution_id) throw new TypeError('startup message requires the current unbound Mission Bot');
  if (!workspace?.main_revision || workspace.mission_id !== mission.mission_id) throw new TypeError('startup preview must be resolved from this Mission Workspace');
  const context = {
    protocol_version: BOT_PROTOCOL_VERSION, observed_at: observedAt,
    system_prompt_sha256: BOT_SYSTEM_HASH, mission,
    bot: { bot_id: bot.bot_id, core_id: bot.core_id, sandbox_id: bot.sandbox_id, pi_session_id: sessionId, state: bot.state, execution_id: null, coordination_permissions: bot.coordination_permissions ?? [] },
    workspace_preview: { workspace_id: workspace.workspace_id, resolved_main_revision: workspace.main_revision, project_path: '/workspace/project',
      project_state: 'empty, protected; populated during take', note: 'This preview is not the actual take input. Take returns the pinned initial revision. If reread_required is true, reread its public input before continuing.' },
    budget: { ...budget, selection_deadline: bot.selection_deadline, bot_hard_deadline: bot.hard_deadline },
    project, services, skills: BOT_SKILLS,
    eligible_task_page: { tasks: eligibleTasks, complete_history: false },
  };
  return (firstTurn ? '你已在全新的 sandbox/Pi Session 启动，尚无 Execution。' : '你仍处于当前 Bot 的选工阶段，尚无 Execution。') + '通过 swarm CLI 读取相关公开工作，在预算内自主选择已有 Task，或先提出缺失的局部 Task 再 take。下方只是当前可领取任务的一页，不代表全部历史；空页不表示 Mission 完成。\n\n' + JSON.stringify(context, null, 2);
}

export const BOT_CONTINUATION_MESSAGE = '继续当前 Task/E。先核对剩余预算、真实 Workspace 状态和新的 Material/检查反馈，再推进当前责任。需要收尾时先保存有用文件、发布有用 Material，再以真实 outcome 调用 swarm task finish；未保存、未确认或失败的操作不能声明成功。';


export const BOT_SOFT_CLOSEOUT_MESSAGE = '当前 Task/E 已进入软收尾窗口。停止扩展责任和发起新计算；仅保存已有有用文件、发布已有研究内容并调用 swarm task finish 给出真实 outcome。不要提出新 Task、apply 新输入、发起新 Judge 检查、Mission 验收或 merge main。已受理请求使用原 ID 查询或重放，未确认持久成功的成果不能声明成功。';

export function buildBotSoftCloseoutNotice(executionId, deadline, at = Date.now()) {
  const remaining = Math.max(0, Date.parse(deadline ?? '') - at);
  return `E ${executionId} 接近 Execution 时间上限，收尾额度为 ${Number.isFinite(remaining) ? remaining + ' ms' : '未知'}。停止扩展，保存已有文件和研究内容，再按真实结果 finish。`;
}

export function buildBotContinuationMessage(execution, { ordinary = BOT_CONTINUATION_MESSAGE, at = Date.now() } = {}) {
  return isSoftCloseout(execution, at) ? `${buildBotSoftCloseoutNotice(execution.execution_id, execution.execution_deadline, at)}\n${BOT_SOFT_CLOSEOUT_MESSAGE}` : ordinary;
}

export const BOT_COMPACTION_MESSAGE = '上下文压缩已完成。压缩本身没有保存或发布工作成果。继续前核对 Task、剩余预算和 Workspace 状态；有值得保留的新成果时通过 swarm workspace save、swarm material publish 持久化，确认返回结果，不把压缩元数据当成交付。';

export function buildBotNotification(notification, { at = Date.now() } = {}) {
  const payload = notification.payload ?? {};
  if (notification.notification_type === 'handoff_warning') return `${buildBotSoftCloseoutNotice(payload.execution_id, payload.deadline, at)} 通知 ID: ${notification.notification_id}`;
  if (notification.notification_type === 'material_available') return `Task ${notification.source_task_id ?? payload.producer_task_id ?? '<unknown>'} / Execution ${notification.source_execution_id ?? payload.producer_execution_id ?? '<unknown>'} 发布的 Material ${notification.material_id ?? payload.material_id ?? '<unknown>'} 已关联到当前 Task。用 swarm material view 读取，判断实际影响，并用 swarm task feedback --notification-id ${notification.notification_id} --decision ... --action ... 记录处理。通知本身不证明成果正确，也不结束当前 E。`;
  return `Task ${notification.recipient_task_id} 的依赖状态已更新；通过 swarm task view 核对当前合同与状态。通知不自动授予 Task/E。`;
}


export function botServiceDirectory(profile) {
  const entries = [];
  for (const service of profile.services ?? []) {
    const id = service.service_id ?? service.id;
    if (id === 'runtime') continue;
    const namespaces = id === 'task' ? ['mission', 'task', 'workspace', 'bot'] : id === 'context' ? ['material'] : id === 'catalog' ? ['service'] : [id];
    for (const name of namespaces) entries.push({ name, provider_service: id, provider_version: service.provider_version ?? null, manifest_hash: service.manifest_hash ?? null,
      help: `swarm ${name} --help`, manifest_help: `swarm service view ${id} --json`,
      documentation: service.documentation ?? [],
      permission: ({ mission: 'read public acceptance state; submit fixed main and explicit Materials only with a Mission coordination grant', task: 'Mission reads, propose and take; finish and feedback require current E; unowned cancel and dependency repair require explicit coordination grants', workspace: 'public view/history/files/read/search and revision-pair diff before take; status/current-E diff/save/apply and checked merge require current E', material: 'Mission reads/search; publication, use and correction require current E; explicitly granted coordination can only revoke a matching supersession', judge: 'checks and result reads require current active E', bot: 'exit only when unbound with no pending take', service: 'configured service metadata only' })[name] ?? 'consult registered operation metadata; Bridge enforces current binding',
    });
  }
  return entries;
}

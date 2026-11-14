import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskService } from '../src/task/task-service.js';
import { MissionWorkspace } from '../src/runtime/mission-workspace.js';
import { makeEnvelope } from '../src/protocol/envelope.js';
import { takeTaskWithAgent } from '../src/benchmark/putnam-runner.js';
import { BOT_SKILLS, BOT_SYSTEM_HASH, botServiceDirectory } from '../src/agent/bot-contract.js';

test('four Core discovery send paths carry current durable identity and pinned preview from a zero-Task Mission', { timeout: 10_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'bot-message-'));
  const taskService = new TaskService();
  t.after(async () => { taskService.close(); await rm(root, { recursive: true, force: true }); });
  taskService.createMission({ mission_id: 'M-prompt', goal: 'Investigate independent bounded questions', acceptance_conditions: { criterion: 'verifiable results' } }, makeEnvelope({ actorRef: 'operator:test' }));
  const workspace = new MissionWorkspace({ rootDir: root });
  await workspace.create({ missionId: 'M-prompt', workspaceId: 'W-prompt', initialFiles: { 'input.txt': 'initial' } });
  const saved = await workspace.save({ workspaceId: 'W-prompt', baseRevision: '0.1', files: { 'input.txt': 'current preview' } });
  const merged = await workspace.merge({ workspaceId: 'W-prompt', fromRevision: saved.revision, expectedMainRevision: '0.1' });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const sent = [];
  const cores = Array.from({ length: 4 }, (_, index) => {
    const botId = `B-${index}`;
    const coreId = `core-${index}`;
    taskService.registerBot({ botId, missionId: 'M-prompt', coreId, selectionDeadline: new Date(Date.now() + 60_000).toISOString(), hardDeadline: new Date(Date.now() + 120_000).toISOString() });
    taskService.recordBotSandbox(botId, { provider: 'controlled', sandboxId: `S-${index}` });
    taskService.markBotReady(botId);
    const session = { sessionId: `Pi-${index}`, rpcRecords: [], async prompt(message) {
      sent.push({ index, message });
      if (sent.length === 4) release();
      await gate;
      taskService.requestBotStop(botId, 'no-work');
      return { data: { disposition: 'handled' } };
    } };
    return { index, botId, session, botDiscoveryTurns: 0, errors: [], toolEvents: [], turns: 0, turnDurationsMs: [],
      startConfig: { options: { turnTimeoutMs: 2000 } }, bridge: { getCapabilityProfile: () => ({ services: [{ service_id: 'task', provider_version: '1' }] }) },
      stateRef: { problem: { id: 'controlled-project', problem_file: 'input.txt', source_hash: 'controlled-hash' } },
      runtime: { taskService, missionWorkspace: workspace, missionWorkspaceId: 'W-prompt', hasActiveExecution: () => false,
        runDeadlineAt: Date.now() + 1800000, executionTimeoutMs: 120000, handoffReminderMs: 90000 },
      parallelism: { beginAgentTurn() {}, endAgentTurn() {}, recordTurnTime() {} },
    };
  });
  const results = await Promise.all(cores.map(core => takeTaskWithAgent(core, [])));
  assert.ok(results.every(result => result.no_work));
  assert.equal(taskService.listMissionTasks({ mission_id: 'M-prompt' }).length, 0);
  for (const { index, message } of sent) {
    const input = JSON.parse(message.slice(message.indexOf('{')));
    const bot = taskService.getBot(`B-${index}`);
    assert.equal(input.bot.bot_id, bot.bot_id);
    assert.equal(input.bot.core_id, bot.core_id);
    assert.equal(input.bot.sandbox_id, bot.sandbox_id);
    assert.equal(input.bot.pi_session_id, `Pi-${index}`);
    assert.equal(input.workspace_preview.resolved_main_revision, merged.main_revision);
    assert.equal(input.budget.bot_hard_deadline, bot.hard_deadline);
    assert.equal(input.budget.selection_deadline, bot.selection_deadline);
    assert.equal(input.system_prompt_sha256, BOT_SYSTEM_HASH);
    assert.deepEqual(input.skills, BOT_SKILLS);
    assert.deepEqual(input.eligible_task_page, { tasks: [], complete_history: false });
    assert.doesNotMatch(message, /swarmenv_task|execution_progress|identity rotation/);
  }
});

for (const boundary of ['closing', 'session-replaced', 'hard-deadline']) {
  test(`discovery does not dispatch across ${boundary} while Workspace resolution is pending`, async t => {
    const taskService = new TaskService(); t.after(() => taskService.close());
    taskService.createMission({ mission_id: 'M-late', goal: 'Inspect late prompt dispatch' }, makeEnvelope({ actorRef: 'operator:test' }));
    taskService.registerBot({ botId: 'B-late', missionId: 'M-late', coreId: 'core-0', selectionDeadline: new Date(Date.now() + 60000).toISOString() });
    taskService.recordBotSandbox('B-late', { provider: 'controlled', sandboxId: 'S-late' }); taskService.markBotReady('B-late');
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; }); const gate = new Promise(resolve => { release = resolve; });
    let sent = 0;
    const session = { sessionId: 'Pi-late', rpcRecords: [], prompt: async () => { sent += 1; } };
    const core = { index: 0, botId: 'B-late', session, errors: [], toolEvents: [], turns: 0, turnDurationsMs: [],
      startConfig: { options: {} }, bridge: { getCapabilityProfile: () => ({ services: [] }) }, stateRef: { problem: {} },
      runtime: { taskService, missionWorkspaceId: 'W-late', hasActiveExecution: () => false,
        missionWorkspace: { async get() { enter(); await gate; return { workspace_id: 'W-late', mission_id: 'M-late', main_revision: '0.1' }; } } },
      parallelism: { beginAgentTurn() {}, endAgentTurn() {}, recordTurnTime() {} },
    };
    const attempt = takeTaskWithAgent(core, []); await entered;
    if (boundary === 'closing') taskService.requestBotStop('B-late', 'selection-budget');
    if (boundary === 'session-replaced') core.session = { ...session, sessionId: 'replacement' };
    if (boundary === 'hard-deadline') taskService.db.prepare('UPDATE bots SET hard_deadline = ? WHERE bot_id = ?').run(new Date(Date.now() - 1).toISOString(), 'B-late');
    release(); await attempt;
    assert.equal(sent, 0);
  });
}

test('startup service directory names real CLI namespaces and excludes internal Runtime metadata', () => {
  const directory = botServiceDirectory({ services: ['task', 'context', 'catalog', 'runtime', 'judge', 'mathlib-search'].map(service_id => ({ service_id, provider_version: '1' })) });
  assert.deepEqual(directory.map(item => item.name), ['mission', 'task', 'workspace', 'bot', 'material', 'service', 'judge', 'mathlib-search']);
  assert.ok(directory.every(item => !item.help.includes('view runtime')));
  assert.equal(directory.find(item => item.name === 'material').manifest_help, 'swarm service view context --json');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskService } from '../src/task/task-service.js';
import { MissionWorkspace } from '../src/runtime/mission-workspace.js';
import { makeEnvelope } from '../src/protocol/envelope.js';
import { takeTaskWithAgent, observedEligibleWorkCount, projectReport, runBenchmarkBatch, runBenchmarkProject } from '../src/benchmark/putnam-runner.js';
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
  const previews = new Map();
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
        recordBotWorkspacePreview(input) { assert.equal(input.session, session); previews.set(input.botId, input.workspace.main_revision); },
        runDeadlineAt: Date.now() + 1800000, executionTimeoutMs: 120000, handoffReminderMs: 90000 },
      parallelism: { beginAgentTurn() {}, endAgentTurn() {}, recordTurnTime() {} },
    };
  });
  const results = await Promise.all(cores.map(core => takeTaskWithAgent(core, [])));
  assert.ok(results.every(result => result.no_work));
  assert.equal(taskService.listMissionTasks({ mission_id: 'M-prompt' }).length, 0);
  for (const { index, message } of sent) {
    assert.match(message.slice(0, message.indexOf('{')), /若无合适项.*swarm mission submission view.*提出可验证的局部 Task 再 take/);
    const input = JSON.parse(message.slice(message.indexOf('{')));
    const bot = taskService.getBot(`B-${index}`);
    assert.equal(input.bot.bot_id, bot.bot_id);
    assert.equal(input.bot.core_id, bot.core_id);
    assert.equal(input.bot.sandbox_id, bot.sandbox_id);
    assert.equal(input.bot.pi_session_id, `Pi-${index}`);
    assert.equal(input.workspace_preview.resolved_main_revision, merged.main_revision);
    assert.equal(previews.get(bot.bot_id), merged.main_revision);
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


test('the first Mission proposal remains visible in ready and running work accounting', () => {
  const service = new TaskService();
  try {
    const mission = service.createMission({ mission_id: 'M-first-proposal', goal: 'Build independent CSV features' }, makeEnvelope({ actorRef: 'operator:test' })).mission;
    const first = service.createTask({ mission_id: mission.mission_id, summary: 'Implement a reusable CSV filter with documented edge cases', expected_output: 'Filter implementation and evidence', acceptance_conditions: ['Test the documented input cases'] }, makeEnvelope({ actorRef: 'bot:first' })).task;
    const state = { taskService: service, missionId: mission.mission_id };
    assert.equal(observedEligibleWorkCount(state, service.listEligibleTasks({ missionId: mission.mission_id })), 1);
    service.takeTask(first.task_id, { owner_ref: 'bot:first', core_id: 'core-1', take_key: 'first', workspace_mode: 'clean' });
    assert.equal(observedEligibleWorkCount(state, []), 1);
    service.createTask({ mission_id: mission.mission_id, summary: 'Implement JSON output independently of CSV filtering', expected_output: 'JSON output and examples', acceptance_conditions: ['Output matches documented format'] }, makeEnvelope({ actorRef: 'bot:second' }));
    assert.equal(observedEligibleWorkCount(state, service.listEligibleTasks({ missionId: mission.mission_id })), 2);
  } finally { service.close(); }
});


test('proposal-only report counts more than one page exactly without claiming progress', () => {
  const service = new TaskService();
  try {
    const mission = service.createMission({ mission_id: 'M-large-proposals', goal: 'Inspect a bounded set of independent cases' }, makeEnvelope({ actorRef: 'operator:test' })).mission;
    let last;
    for (let index = 0; index < 105; index++) last = service.createTask({ mission_id: mission.mission_id,
      summary: `Investigate independent documented input case ${index}`, expected_output: 'Reproducible case result', acceptance_conditions: ['Publish evidence for this case'] }, makeEnvelope({ actorRef: 'bot:proposer' })).task;
    const state = { taskService: service, missionId: mission.mission_id, cores: [], initialTaskIds: [],
      contextService: { readMaterials: () => [], listMaterialConsumptions: () => [] },
      judgeService: { listCheckerPreflights: () => [], getMissionCheckBudget: () => null }, capabilityRegistry: { listServices: () => [] },
      parallelism: { snapshot: () => ({}) }, allowedAgentToolNames: ['read', 'write', 'edit', 'bash'],
      publicWorkspace: { mission_id: mission.mission_id, metadata: { input_snapshot_hash: 'test-input' } },
      inputMaterialHash: 'test-input', problem: { id: 'controlled', source_hash: 'test-input' }, fixtureManifest: {},
      readinessSamples: [], schedulerEvents: [], solvedAt: null, missionSubmissionStore: { isAccepted: () => false, getFinalCheckBudget: () => null },
    };
    const report = projectReport(state, Date.now() - 1000, Date.now());
    assert.equal(report.protocol.proposed_task_count, 105);
    assert.equal(Object.hasOwn(report.protocol, 'parallel_mode'), false);
    assert.equal(report.protocol.project_parallelism, 1);
    assert.equal(Object.hasOwn(report.project, 'structure'), false);
    assert.equal(Object.hasOwn(report.project.task_tree[0], 'parent_id'), false);
    assert.equal(report.project.task_count, 105);
    assert.equal(report.project.task_tree.length, 100);
    assert.equal(report.project.task_page.complete, false);
    assert.equal(report.parallelism.proposal_evidence.observed_task_count, 105);
    assert.equal(report.run.progress_evidence.proposed_task_count, 105);
    assert.equal(report.run.dynamic_task_count, 105);
    assert.equal(report.run.made_progress, false);
    assert.equal(report.run.solved, false);
    assert.equal(report.audit.invalid, false);
    assert.equal(Object.hasOwn(report.run, 'root_take_count'), false);
    assert.equal(Object.hasOwn(report.parallelism, 'decomposition_available'), false);
    assert.equal(observedEligibleWorkCount(state, [last]), 1, 'ready work outside the first page is still observed');
  } finally { service.close(); }
});

test('runner rejects old parallel treatment labels and inconsistent Core counts', async () => {
  for (const parallelMode of ['root-only', 'semantic', 'direct']) {
    await assert.rejects(runBenchmarkProject({}, {}, { parallelMode }), /parallelMode has been retired/);
    await assert.rejects(runBenchmarkBatch([], {}, { parallelMode }), /parallelMode has been retired/);
  }
  await assert.rejects(runBenchmarkProject({}, {}, { cores: 2 }), /require four independent Core loops/);
});

test('report distinguishes budget expiry before activation from missing or shared Workspaces', () => {
  const service = new TaskService();
  try {
    const mission = service.createMission({ mission_id: 'M-budget-report', goal: 'Check preparation deadline reporting' }, makeEnvelope({ actorRef: 'operator:test' })).mission;
    const taken = Array.from({ length: 2 }, (_, index) => {
      const task = service.createTask({ mission_id: mission.mission_id, summary: `Inspect deadline case ${index}`, expected_output: 'Evidence', acceptance_conditions: ['Record result'] }, makeEnvelope({ actorRef: `bot:${index}` })).task;
      return service.takeTask(task.task_id, { owner_ref: `bot:${index}`, core_id: `core-${index}`, take_key: `take:${index}` });
    });
    const state = { taskService: service, missionId: mission.mission_id, initialTaskIds: [],
      observationStore: { listEvents: () => ({ events: [] }) },
      cores: taken.map(({ task, execution }, index) => ({ index, taskId: task.task_id, executionId: execution.execution_id,
        prompt: 'Controlled diagnostic prompt',
        takeHistory: [{ task_id: task.task_id, execution_id: execution.execution_id }], sessionHistory: [],
        turnDurationsMs: [], checks: [], errors: [], cheatingFlags: [], latencySamples: [], toolEvents: [], workspaceWrites: [],
        toolErrors: [], materialReads: [], materialConsumptions: [] })),
      contextService: { readMaterials: () => [], listMaterialConsumptions: () => [] },
      judgeService: { listCheckerPreflights: () => [], getMissionCheckBudget: () => null }, capabilityRegistry: { listServices: () => [] },
      parallelism: { snapshot: () => ({}) }, allowedAgentToolNames: ['read', 'write', 'edit', 'bash'],
      publicWorkspace: { mission_id: mission.mission_id, metadata: { input_snapshot_hash: 'input' } },
      inputMaterialHash: 'input', problem: { id: 'controlled', source_hash: 'input' }, fixtureManifest: {},
      readinessSamples: [], schedulerEvents: [], solvedAt: null, missionSubmissionStore: { isAccepted: () => false, getFinalCheckBudget: () => null },
    };
    const set = (index, { state = 'FAILED', reason = 'bot-lifetime-budget', started = null, workspace = null } = {}) => {
      service.db.prepare('UPDATE executions SET state = ?, terminal_reason = ?, started_at = ?, workspace_ref = ? WHERE execution_id = ?')
        .run(state, reason, started, workspace, taken[index].execution.execution_id);
    };
    set(0, { started: new Date().toISOString(), workspace: '/controlled/first' });
    set(1);
    const report = () => projectReport(state, Date.now() - 1000, Date.now());
    assert.equal(report().audit.invalid, false, 'a durable budget stop before activation needs no Workspace');
    for (const reason of ['benchmark_deadline_cleanup', 'execution-timebox']) {
      set(1, { reason });
      assert.equal(report().audit.invalid, false);
    }
    for (const changed of [{ started: new Date().toISOString() }, { state: 'RUNNING' }, { reason: 'unknown-stop' }]) {
      set(1, changed);
      assert.ok(report().audit.invalid_reasons.includes('workspace_boundary_violation'));
    }
    set(1, { workspace: '/controlled/first' });
    assert.ok(report().audit.invalid_reasons.includes('workspace_boundary_violation'), 'budget stops cannot share a materialized Workspace');
    set(1, { workspace: '/controlled/second' });
    assert.equal(report().audit.invalid, false);
  } finally { service.close(); }
});

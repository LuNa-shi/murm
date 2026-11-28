import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRuntime } from '@luna-shi/murm';
import { ServiceRegistry } from '@luna-shi/murm';
import { createOwnedResources } from '../../../src/harness/owned-resources.js';
import { seededCheckoutInstruction } from '../../../src/harness/project-git.js';
import { runInput } from '../../../src/harness/run-input.js';
import { runWithReport } from '../../../src/harness/run-report.js';
import { createBoard, boardPermissions, projectBoardPermissions } from './board.js';
import { leadWorkerRoles } from './team.js';
import { createDynamicLeadWorker, dynamicServices, type DynamicLeadWorkerOptions } from './dynamic.js';
import { runDynamicSchedule } from './dynamic-scheduler.js';
import { prepareLeadWorkerGit, createLeadWorkerGit } from './git.js';
import { projectLeadPrompt, projectIntegrationInstruction, projectStaticWorkerPrompt, projectDynamicLeadPrompt, projectDynamicWorkerPrompt, leadPrompt, helperPrompt, dynamicLeadPrompt, dynamicWorkerPrompt, initializeInstruction, helperInitialInstruction, leadAdjustmentInstruction, helperFollowupInstruction } from './prompts.js';

const fail = (code: any) => Object.assign(new Error(code), { code });
const invalidConfiguration = (message: string) => Object.assign(new TypeError(message), { code: 'INVALID_RUN_CONFIGURATION' });
const bounded = (value: any, fallback: any, maximum: any) => { const result = value ?? fallback; if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw invalidConfiguration('Invalid lead-worker wait bound'); return result; };
export async function createLeadWorkerHarness(options: any) {
  const { runId, image, model = 'default', outputDir, sandbox, executor, models, connection, filePolicy, exportLimit = 64 * 1024 ** 2, helperCount = 2, includeGit = true } = options;
  const project = options.projectFiles !== undefined;
  let initialCommit: string | undefined;
  const dynamic: DynamicLeadWorkerOptions | undefined = options.dynamic;
  if (dynamic && (helperCount !== 2 || typeof dynamic.deploy !== 'function' || (!project && typeof dynamic.verifyFinal !== 'function') ||
    typeof dynamic.goal !== 'string' || !dynamic.goal.trim())) throw invalidConfiguration('Invalid dynamic Lead-Worker options');
  const roles = leadWorkerRoles(helperCount);
  const helperRoles = roles.slice(1);
  if (typeof includeGit !== 'boolean' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(runId ?? '') || typeof image !== 'string' || !image || typeof outputDir !== 'string' || !outputDir || !Number.isSafeInteger(exportLimit) || exportLimit < 1 || exportLimit > 64 * 1024 ** 2) throw invalidConfiguration('Invalid lead-worker run configuration');
  const turnTimeoutMs = bounded(options.turnTimeoutMs, 30_000, 300_000);
  const useRunDeadline = Boolean(dynamic && options.turnTimeoutMs === null);
  const workTimeoutMs = bounded(options.workTimeoutMs, 120_000, dynamic ? 1_800_000 : 900_000);
  const closeTimeoutMs = bounded(options.closeTimeoutMs, 30_000, 60_000);
  const resources = createOwnedResources(); const lifetime: any = new AbortController();
  const startup = AbortSignal.any([AbortSignal.timeout(120_000), ...(options.signal ? [options.signal] : [])]);
  const directory = join(resolve(outputDir), `lead-worker-${runId}`); await mkdir(directory, { recursive: true, mode: 0o700 });
  const boardPath = join(directory, 'board.sqlite');
  const secrets = [options.gitea?.adminToken, ...(options.secretValues ?? [])].filter((value: any) => typeof value === 'string' && value);
  let dynamicControl: ReturnType<typeof createDynamicLeadWorker> | undefined;
  let runtime: any; let board: any; let git: any; let unsubscribe: any; let closing = false; let closeWork: any; let complete: any; let workflowUsed = false; let boardFenceFailure: any;
  const pendingFences: any = new Map(); const activeInputs: any = new Set();
  const team: any = {}; const inputs: any[] = []; const events: any[] = [];
  const stages: any[] = []; const rejections: any[] = []; let stageActive = false; let preparedStages: any;
  const redact = (value: any) => { let body = JSON.stringify(value); for (const secret of [...secrets].sort((a: any, b: any) => b.length - a.length)) body = body.split(JSON.stringify(secret).slice(1, -1)).join('[redacted]'); return JSON.parse(body); };
  const snapshot = () => {
    let publicBoard: any; let boardReadFailure: any;
    try { publicBoard = board?.snapshot(); } catch { boardReadFailure = { code: 'BOARD_READ_FAILED' }; }
    return { runId, runtimeId: runtime?.id, initialCommit, initialDigest: options.initialDigest, boardPath, team: { ...team }, stages: structuredClone(stages), rejections: structuredClone(rejections), preparation: structuredClone(preparedStages ?? null), git: git?.identities(), board: publicBoard, ...(boardReadFailure ? { boardReadFailure } : {}), inputs: structuredClone(inputs), events: structuredClone(events),
      delivered: publicBoard?.subtasks.filter((row: any) => row.delivery?.verified) ?? [], unfinished: publicBoard?.subtasks.filter((row: any) => row.state !== 'complete') ?? [], inputUnknown: inputs.filter((row: any) => row.uncertain).map((row: any) => ({ agentId: row.agentId, requestId: row.requestId, inputId: row.inputId, code: row.code })), resources: resources.snapshot(),
      ...(boardFenceFailure ? { boardFenceFailure, pendingBoardFailures: [...pendingFences.values()] } : {}), ...(dynamicControl ? { dynamic: dynamicControl.snapshot() } : {}),
      limitations: ['Local SQLite Board and exclusive turn controller', dynamic ? 'One dynamic member and no claim reclamation' : 'Fixed preconfigured team; no replacement or claim reclamation', 'Upstream scale and performance not verified'] };
  };
  function recordFence(record?: any) {
    if (record?.agentId) pendingFences.set(record.agentId, record);
    try {
      board?.fence(record);
      if (record?.agentId) pendingFences.delete(record.agentId);
      if (!pendingFences.size) boardFenceFailure = undefined;
    } catch { boardFenceFailure = { code: 'BOARD_FENCE_FAILED' }; }
  }
  function stop() { if (!closing) { closing = true; lifetime.abort(); recordFence(); } }

  async function close({ timeoutMs = closeTimeoutMs }: any = {}) {
    stop(); if (complete) return structuredClone(complete);
    if (!closeWork) {
      // Public Core closes admission synchronously before the first await.
      const coreWork = runtime ? runtime.close({ timeoutMs }) : Promise.resolve({ cleanup: 'complete', agents: [], pending: [] });
      closeWork = (async () => {
        const core = await coreWork;
        let recordedFailures: any = {}; let boardReadFailed = false;
        try { recordedFailures = board?.snapshot().failures ?? {}; } catch { boardReadFailed = true; }
        const failures: any = new Map(Object.entries((recordedFailures as Record<string, any>)));
        for (const [agentId, failure] of pendingFences) failures.set(agentId, failure);
        for (const [agentId, failure] of failures) recordFence({ agentId, code: failure.code, execution: core.agents?.find((row: any) => row.agentId === agentId)?.execution === 'stopped' ? 'stopped' : 'unknown' });
        if (boardFenceFailure) recordFence();
        if (boardReadFailed || boardFenceFailure || pendingFences.size) return { ...core, cleanup: 'pending', harness: { cleanup: 'pending', pending: [{ kind: 'board-evidence', id: boardPath, action: 'persist-failure', error: { code: 'BOARD_FENCE_FAILED' } }], resources: resources.snapshot() } };
        if (core.cleanup !== 'complete' || core.agents.some((row: any) => row.execution !== 'stopped' || row.cleanup !== 'complete')) return { ...core, harness: { cleanup: 'pending', pending: resources.snapshot().filter((row: any) => !['closed', 'retained'].includes(row.state)) } };
        if (dynamicControl && !await dynamicControl.settled(timeoutMs)) {
          return { ...core, cleanup: 'pending', harness: { cleanup: 'pending', resources: resources.snapshot(),
            pending: [{ kind: 'management', id: runtime?.id, action: 'close' }] } };
        }
        unsubscribe?.(); const harness = await resources.close(); const receipt: any = { ...core, cleanup: harness.cleanup, harness }; if (harness.cleanup === 'complete') complete = receipt; return receipt;
      })().finally(() => { closeWork = undefined; });
    }
    return structuredClone(await closeWork);
  }
  const dispatch = async (role: any, requestId: any, payload: any, workSignal: any, deadlineAtMs?: number) => {
    if (workSignal.aborted || closing) throw fail('WORKFLOW_STOPPED');
    const timeoutMs = deadlineAtMs === undefined ? turnTimeoutMs : Math.ceil(deadlineAtMs - performance.now());
    if (timeoutMs < 1) throw fail('WORKFLOW_STOPPED');
    const row: any = { role, agentId: team[role], requestId, source: payload.type,
      ...(dynamic && payload.type === 'board-updates' ? { boardRevision: payload.revision, updates: structuredClone(payload.updates) } : {}) };
    inputs.push(row); activeInputs.add(team[role]);
    try {
      const result = await runInput(runtime, team[role], JSON.stringify(payload), { requestId, timeoutMs, signal: workSignal }); Object.assign(row, { inputId: result.inputId, receipt: result.receipt, state: 'completed', settled: { agentId: result.settled.agentId, outcome: result.settled.outcome } }); return result;
    } catch (error: any) { Object.assign(row, { inputId: error.inputId, receipt: error.receipt, state: 'failed', code: error.code ?? 'INPUT_FAILED', uncertain: !['input_failed', 'input_aborted'].includes(error.code) });
      if (dynamic && error.code === 'input_unknown') {
        const recorded = runtime.send(team[role], JSON.stringify(payload), { requestId, mode: 'followUp' });
        try { row.reconciledReceipt = await recorded; } catch { /* preserve original uncertainty */ }
      }
      recordFence({ agentId: team[role], code: row.code }); lifetime.abort(); throw error; }
    finally { activeInputs.delete(team[role]); }
  };
  const abortStartup = () => { if (runtime) void runtime.close({ timeoutMs: 1 }).catch(() => {}); };
  startup.addEventListener('abort', abortStartup, { once: true });
  try {
    if (startup.aborted) throw fail('HARNESS_START_ABORTED');
    const facilities = await (options.prepare ?? prepareLeadWorkerGit)({ ...options, helperCount, signal: startup, resources, ...(dynamic ? { initialFiles: dynamic.initialFiles } : {}) });
    for (const actor of Object.values((facilities.actors ?? {}) as Record<string, any>)) secrets.push(actor.token);
    if (facilities.runId !== runId || startup.aborted) throw fail('HARNESS_START_ABORTED');
    initialCommit = facilities.initialCommit;
    if (project && !/^[a-f0-9]{40}$/.test(initialCommit ?? '')) throw fail('PROJECT_GIT_SEED_FAILED');
    git = createLeadWorkerGit(facilities, helperCount, dynamic ? { isReady: id => board.snapshot().members[id]?.ready === true } : {});
    const candidate = createBoard({ path: boardPath, runId, helperCount, dynamic: !!dynamic, project, verifyDelivery: (value: any) => git.verifyDelivery(value) });
    if (candidate.snapshot().team || candidate.snapshot().fenced) { candidate.close(); throw fail('BOARD_ALREADY_OWNED'); }
    board = candidate;
    resources.own({ kind: 'board-data', id: boardPath, retained: true }); resources.own({ kind: 'board-connection', id: boardPath, close: () => board.close() });
    const services: any = new ServiceRegistry(); board.register(services); git.register(services);
    if (dynamic) {
      if (typeof facilities.prepareMember !== 'function') throw fail('INVALID_DYNAMIC_GIT');
      dynamicControl = createDynamicLeadWorker({ options: dynamic, getRuntime: () => runtime, team, runId, model, image, facilities,
        board, git, resources, signal: lifetime.signal, addSecret: token => secrets.push(token), includeGit, exportLimit });
      dynamicControl.register(services);
    }
    const profiles = Object.fromEntries(roles.map((role: any) => {
      const actor = facilities.actors[role];
      const isLead = role === 'lead';
      const prompt = project
        ? [dynamic ? (isLead ? projectDynamicLeadPrompt : projectDynamicWorkerPrompt) : (isLead ? projectLeadPrompt : projectStaticWorkerPrompt), seededCheckoutInstruction].join('\n\n')
        : dynamic ? (isLead ? dynamicLeadPrompt : dynamicWorkerPrompt) : (isLead ? leadPrompt : helperPrompt);
      return [role, { image, model, writable: true, prompt,
        env: { ...(initialCommit ? { RUN_INITIAL_COMMIT: initialCommit } : {}), RUN_REPOSITORY: facilities.repositoryUrl, WORK_BRANCH: actor.branch, GITEA_USERNAME: actor.username, GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: actor.username, GIT_AUTHOR_EMAIL: `${actor.username}@murm.invalid`, GIT_COMMITTER_NAME: actor.username, GIT_COMMITTER_EMAIL: `${actor.username}@murm.invalid`, RUN_OWNER: facilities.repository.owner, RUN_REPO: facilities.repository.name },
        network: { allow: [new URL(facilities.repositoryUrl).origin] }, services: dynamic ? dynamicServices(role === 'lead' ? 'lead' : 'helper') : { board: (project ? projectBoardPermissions : boardPermissions)[isLead ? 'lead' : 'helper'], gitea: ['pull_request_write'] } }];
    }));
    runtime = await createRuntime({ sandbox, executor, models, connection, filePolicy, services, profiles, maxAgents: roles.length + (dynamic ? 1 : 0), outputDir, ...(dynamicControl ? { agentAccessPolicy: dynamicControl.agentAccessPolicy } : {}) });
    if (startup.aborted) throw fail('HARNESS_START_ABORTED');
    options.onRuntime?.(runtime, snapshot);
    unsubscribe = runtime.onEvent((event: any) => {
      if (events.length < (dynamic ? 2048 : 256)) events.push({ agentId: event.agentId, seq: events.length + 1, type: event.type, ...(event.outcome ? { outcome: event.outcome } : {}) });
      if (!dynamic && events.length >= 256 || event.type === 'error' && event.fatal || event.type === 'settled' && event.outcome !== 'completed' || event.type === 'exit' && !event.expected) {
        if (!closing) { recordFence({ agentId: event.agentId, code: 'AGENT_FAILED' });
          // The exclusive helper owns terminal-event/late-receipt ordering.
          // Its catch cancels the team without replacing that original outcome.
          if (!activeInputs.has(event.agentId)) lifetime.abort(); }
      }
    });
    for (const role of roles) {
      if (startup.aborted || lifetime.signal.aborted) throw fail('HARNESS_START_ABORTED');
      const actor = facilities.actors[role]; const agent = await runtime.spawn({ requestId: `spawn-${role}`, profile: role, ...(project ? { files: options.projectFiles } : {}), ...(dynamic && role !== 'lead' ? { parentId: team.lead } : {}), bindings: { board: `${runId}:board`, gitea: actor.binding }, secretEnv: { GITEA_TOKEN: actor.token }, collect: { paths: ['.'], includeGit, maxBytes: exportLimit, required: true } }); team[role] = agent.id;
    }
    if (startup.aborted || lifetime.signal.aborted) throw fail('HARNESS_START_ABORTED');
    board.bindTeam(runtime.id, team); git.bindTeam(runtime.id, team);
    return Object.freeze({ id: runtime.id, snapshot, redact, close, get: (agentId: any) => runtime.get(agentId),
      async runDynamic({ signal }: { signal?: AbortSignal } = {}) {
        if (!dynamic || workflowUsed || closing) throw fail('INVALID_DYNAMIC_WORKFLOW');
        workflowUsed = true;
        const deadlineAtMs = performance.now() + workTimeoutMs;
        const dispatchWork: typeof dispatch = useRunDeadline ? (role, requestId, payload, signal) => dispatch(role, requestId, payload, signal, deadlineAtMs) : dispatch;
        const workSignal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(workTimeoutMs), ...(signal ? [signal] : [])]);
        try {
          workSignal.throwIfAborted();
          const submitted = await runDynamicSchedule({ board, team, goal: dynamic.goal, signal: workSignal, dispatch: dispatchWork });
          if (!dynamic.verifyFinal) return { submitted, harness: snapshot() };
          const verdict = await dynamic.verifyFinal({ repositoryUrl: facilities.repositoryUrl, token: facilities.actors.lead.token,
            commit: submitted.delivery.commit, sha256: submitted.delivery.sha256, signal: workSignal, resources });
          if (!verdict.ok) throw Object.assign(fail('ORDERS_ORACLE_FAILED'), { details: [verdict] });
          return { submitted, verdict, harness: snapshot() };
        } catch (error: any) {
          stop(); error.details = [...(error.details ?? []), snapshot()]; throw error;
        }
      },
      async prepareStages({ signal }: any = {}) {
        if (dynamic || closing || workflowUsed || stageActive || helperCount !== 3 ||
            (signal !== undefined && !(signal instanceof AbortSignal))) throw fail('INVALID_STAGE_PREPARATION');
        workflowUsed = true; stageActive = true;
        const workSignal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(workTimeoutMs), ...(signal ? [signal] : [])]);
        const startInput = inputs.length; const notes: any[] = [];
        try {
          for (const role of roles) {
            const readyNote = `Ready for staged workload: ${runtime.id}:${role}:${team[role]}`;
            const before = board.snapshot();
            await dispatch(role, `prepare-stage-${role}`, { type: 'prepare-stage', ready_note: readyNote,
              instruction: 'Read the public Board, verify your own trusted role and Agent identity, then publish exactly ready_note as a public unscoped Board note. Do not claim work or create an artifact. This is setup only.' }, workSignal);
            const after = board.snapshot();
            const note = after.notes.find((row: any) => row.actor === team[role] && row.text === readyNote && !row.subtask_id && !before.notes.some((old: any) => old.seq === row.seq));
            if (!note || !after.reads.some((row: any) => row.actor === team[role] && !before.reads.some((old: any) => old.seq === row.seq))) throw fail('STAGE_PREPARATION_INVALID');
            notes.push(note);
          }
          preparedStages = { notes, inputs: structuredClone(inputs.slice(startInput)) };
          return structuredClone(preparedStages);
        } catch (error: any) { stop(); error.details = [...(error.details ?? []), snapshot()]; throw error; }
        finally { stageActive = false; }
      },
      async runStage({ goal, supplement, paths, tasks, signal, deadlineAtMs, verifyCandidate }: any = {}) {
        const stage = stages.length;
        const text = stage === 0 ? goal : supplement;
        const remainingMs = deadlineAtMs === undefined ? workTimeoutMs : Math.ceil(deadlineAtMs - performance.now());
        if (dynamic || (deadlineAtMs !== undefined && (!Number.isFinite(deadlineAtMs) || remainingMs < 1 || remainingMs > 900_000)) || closing || stageActive || stage >= 4 || helperCount !== 3 || workflowUsed && stage === 0 && !preparedStages ||
            (verifyCandidate !== undefined && (typeof verifyCandidate !== 'function' || deadlineAtMs === undefined)) ||
            typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 8192 ||
            (signal !== undefined && !(signal instanceof AbortSignal)) ||
            (tasks !== undefined && (!tasks || Object.keys(tasks).length !== 3 || helperRoles.some((role: any) => !Object.hasOwn(tasks, role) ||
              typeof tasks[role] !== 'string' || !tasks[role].trim() || Buffer.byteLength(tasks[role]) > 4096))) ||
            !paths || Object.keys(paths).length !== 3 || helperRoles.some((role: any) => !Object.hasOwn(paths, role) || typeof paths[role] !== 'string' ||
              paths[role].length > 256 || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.[A-Za-z0-9]+$/.test(paths[role])) ||
            new Set(Object.values((paths as Record<string, any>))).size !== 3 || stages.some((prior: any) => Object.values((paths as Record<string, any>)).some((path: any) => Object.values((prior.paths as Record<string, any>)).includes(path)))) throw fail('INVALID_STAGE');
        const fixedPaths = structuredClone(paths);
        const fixedTasks = tasks === undefined ? undefined : structuredClone(tasks);
        workflowUsed = true; stageActive = true;
        const workSignal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(Math.min(workTimeoutMs, remainingMs)), ...(signal ? [signal] : [])]);
        const send = (role: any, payload: any) => dispatch(role, `stage-${stage}-${role}`, { ...payload, stage, paths: fixedPaths }, workSignal, deadlineAtMs);
        const helpers = Object.fromEntries(helperRoles.map((role: any) => [role, team[role]]));
        const previous = stages.at(-1); const startInput = inputs.length;
        try {
          const before = board.snapshot();
          if (stage === 0) await send('lead', { type: 'initialize', instruction: initializeInstruction + ' Use exactly the supplied role-to-path map for this stage.', goal: text, helpers });
          else {
            const userInputId = `lead-stage-${stage}`;
            board.registerUserInput(userInputId, text);
            await send('lead', { type: 'user-and-feedback', instruction: leadAdjustmentInstruction + ' Cite exactly the previous stage feedback_ids and use the supplied new role-to-path map.',
              user_input_id: userInputId, supplement: text, feedback_ids: previous.feedback.map((row: any) => row.seq) });
          }
          const announced = board.snapshot(); const direction = announced.directions.at(-1);
          if (!direction || direction.seq <= (before.directions.at(-1)?.seq ?? 0) ||
              helperRoles.some((role: any) => !announced.assignments.some((row: any) => row.helper_id === team[role]) ||
                !announced.subtasks.some((row: any) => row.path === fixedPaths[role] && row.state === 'ready' && !row.owner && !before.subtasks.some((old: any) => old.id === row.id)))) throw fail('STAGE_DIRECTION_INVALID');
          if (stage && (direction.text === previous.direction.text || direction.user_input_id !== `lead-stage-${stage}` ||
              direction.feedback_ids.length !== 3 || previous.feedback.some((note: any) => !direction.feedback_ids.includes(note.seq)))) throw fail('DIRECTION_ADJUSTMENT_INVALID');
          const results: any[] = await Promise.allSettled(helperRoles.map((role: any) => send(role, {
            type: stage ? 'helper-followup' : 'helper-initial', ...(fixedTasks ? { task: fixedTasks[role] } : {}),
            instruction: (stage ? helperFollowupInstruction : helperInitialInstruction) + ' Deliver only your supplied path and publish one new feedback note.' })));
          if (results.some((row: any) => row.status === 'rejected')) throw results.find((row: any) => row.status === 'rejected').reason;
          let final = board.snapshot();
          const deliveries = helperRoles.map((role: any) => final.subtasks.find((row: any) => row.owner === team[role] && row.path === fixedPaths[role] &&
            row.state === 'complete' && row.directionId === direction.seq && row.delivery?.verified && !before.subtasks.some((old: any) => old.id === row.id || old.delivery?.commit === row.delivery.commit)));
          if (deliveries.some((row: any) => !row)) throw fail('DIRECTION_NOT_ADOPTED');
          const rejected: any[] = [];
          if (verifyCandidate) {
            let candidateFailure: any;
            await Promise.allSettled(helperRoles.map(async (role: any, index: any) => {
              try {
                let attempt = 0;
                while (true) {
                  workSignal.throwIfAborted();
                  const task = deliveries[index];
                  const decision = await verifyCandidate(structuredClone(task), { stage, direction: structuredClone(direction), harness: snapshot(), signal: workSignal });
                  workSignal.throwIfAborted();
                  if (decision === true) break;
                  if (typeof decision?.correction !== 'string' || !decision.correction.trim() || decision.rejected?.code !== 'STAGE_CANDIDATE_REJECTED') throw fail('STAGE_CANDIDATE_UNCONFIRMED');
                  const input = structuredClone(inputs.findLast((row: any) => row.agentId === team[role]));
                  const rejection: any = { role, stage, attempt, task: structuredClone(task), input, ...structuredClone(decision.rejected) };
                  rejected.push(rejection); rejections.push(structuredClone(rejection));
                  const nextPath = fixedPaths[role].replace(/\.[^.]+$/, `-correction-${++attempt}.json`);
                  const subtaskId = `stage-${stage}-${role}-correction-${attempt}`;
                  if (board.snapshot().subtasks.some((row: any) => row.path === nextPath || row.id === subtaskId)) throw fail('STAGE_CORRECTION_CONFLICT');
                  const correctionPaths: any = { ...fixedPaths, [role]: nextPath };
                  const correctionTask = (fixedTasks?.[role] ?? '').replaceAll(fixedPaths[role], nextPath);
                  await dispatch(role, `stage-${stage}-${role}-correction-${attempt}`, {
                    type: 'helper-correction', stage, attempt, paths: correctionPaths, subtaskId,
                    task: correctionTask,
                    instruction: `${decision.correction} Preserve the rejected complete Board task and Git commit. Read the unchanged current direction, create a new subtask with id ${subtaskId} and path ${nextPath}, claim it yourself, and complete it with your corrected pushed delivery and a new task-scoped feedback note. Use only the existing Board capabilities; do not alter another task or direction.`,
                  }, workSignal, deadlineAtMs);
                  final = board.snapshot();
                  const replacement = final.subtasks.find((row: any) => row.id === subtaskId && row.path === nextPath && row.owner === team[role] && row.state === 'complete' && row.directionId === direction.seq && row.delivery?.verified && row.delivery.commit !== task.delivery.commit);
                  if (!replacement || JSON.stringify(final.subtasks.find((row: any) => row.id === task.id)) !== JSON.stringify(task) || final.directions.at(-1)?.seq !== direction.seq) throw fail('STAGE_CORRECTION_INVALID');
                  deliveries[index] = structuredClone(replacement);
                }
              } catch (error: any) { candidateFailure ??= error; stop(); throw error; }
            }));
            if (candidateFailure) throw candidateFailure;
          }
          final = board.snapshot();
          const feedback = deliveries.map((row: any) => final.notes.find((note: any) => note.actor === row.owner && note.subtask_id === row.id && note.seq > direction.seq && !before.notes.some((old: any) => old.seq === note.seq)));
          if (feedback.some((row: any) => !row)) throw fail('HELPER_FEEDBACK_INVALID');
          const attemptInputs = structuredClone(inputs.slice(startInput));
          const receipt: any = { stage, paths: fixedPaths, direction, deliveries, feedback, boardRevision: final.history.at(-1).seq,
            inputs: roles.map((role: any) => attemptInputs.findLast((row: any) => row.agentId === team[role])), attemptInputs, rejected };
          if (stage === 3) {
            receipt.pinnedDeliveries = [];
            for (const prior of [...stages, receipt]) for (const task of prior.deliveries) {
              if (workSignal.aborted || closing) throw fail('WORKFLOW_STOPPED');
              const proof = await git.verifyPinnedDelivery({ actor: task.owner, delivery: task.delivery, direction: prior.direction,
                requireDirectionText: prior.stage > 0, signal: workSignal });
              receipt.pinnedDeliveries.push({ stage: prior.stage, agentId: task.owner, ...proof });
            }
          }
          stages.push(receipt);
          return structuredClone(receipt);
        } catch (error: any) { stop(); error.details = [...(error.details ?? []), snapshot()]; throw error; }
        finally { stageActive = false; }
      },
      async runWorkflow({ goal, supplement, signal }: any = {}) {
        if (dynamic || closing || workflowUsed || !(project ? [goal] : [goal, supplement]).every((value: any) => typeof value === 'string' && value.trim() && Buffer.byteLength(value) <= (project ? 64 * 1024 : 8192))) throw fail('INVALID_WORKFLOW'); workflowUsed = true;
        const workSignal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(workTimeoutMs), ...(signal ? [signal] : [])]);
        const send = (role: any, requestId: any, payload: any) => dispatch(role, requestId, payload, workSignal);
        const helpers = Object.fromEntries(helperRoles.map((role: any) => [role, team[role]]));
        const helperIds = Object.values((helpers as Record<string, any>));
        try {
          await send('lead', 'lead-initialize', { type: 'initialize', instruction: initializeInstruction, goal, helpers });
          const initial = board.snapshot(); const original = initial.directions.at(-1);
          if (!original || helperIds.some((id: any) => !initial.assignments.some((row: any) => row.helper_id === id)) || initial.subtasks.filter((row: any) => row.state === 'ready' && !row.owner).length < helperCount) throw fail('INITIALIZATION_INVALID');
          const first: any[] = await Promise.allSettled(helperRoles.map((role: any) => send(role, `${role}-initial`, { type: 'helper-initial', instruction: helperInitialInstruction })));
          if (first.some((row: any) => row.status === 'rejected')) throw first.find((row: any) => row.status === 'rejected').reason;
          const feedback = board.snapshot(); const before = feedback.subtasks.filter((row: any) => row.state === 'complete' && row.delivery?.verified);
          if (helperIds.some((id: any) => !before.some((row: any) => row.owner === id) || !feedback.notes.some((row: any) => row.actor === id))) throw fail('HELPER_DELIVERY_INVALID');
          if (project) {
            const notes = feedback.notes.filter((row: any) => helperIds.includes(row.actor));
            await send('lead', 'lead-integrate', { type: 'project-integration',
              instruction: projectIntegrationInstruction, feedback_ids: notes.map((row: any) => row.seq) });
            const final = board.snapshot();
            if (!final.submitted || helperIds.some((id: any) => !notes.some((row: any) =>
              row.actor === id && final.submitted.feedbackIds.includes(row.seq)))) throw fail('PROJECT_DELIVERY_UNCONFIRMED');
            return { direction: original, submitted: final.submitted, harness: snapshot() };
          }
          board.registerUserInput('lead-adjust', supplement);
          await send('lead', 'lead-adjust', { type: 'user-and-feedback', instruction: leadAdjustmentInstruction, user_input_id: 'lead-adjust', supplement });
          const updated = board.snapshot(); const direction = updated.directions.at(-1);
          if (direction.seq <= original.seq || direction.text === original.text || direction.user_input_id !== 'lead-adjust' || helperIds.some((id: any) => !updated.notes.some((note: any) => note.actor === id && direction.feedback_ids.includes(note.seq)))) throw fail('DIRECTION_ADJUSTMENT_INVALID');
          const later: any[] = await Promise.allSettled(helperRoles.map((role: any) => send(role, `${role}-followup`, { type: 'helper-followup', instruction: helperFollowupInstruction })));
          if (later.some((row: any) => row.status === 'rejected')) throw later.find((row: any) => row.status === 'rejected').reason;
          const final = board.snapshot();
          if (helperIds.some((id: any) => !final.subtasks.some((row: any) => row.owner === id && row.state === 'complete' && row.directionId === direction.seq && row.delivery?.verified && !before.some((old: any) => old.id === row.id || old.delivery.commit === row.delivery.commit)))) throw fail('DIRECTION_NOT_ADOPTED');
          return { originalDirection: original, adjustedDirection: direction, harness: snapshot() };
        } catch (error: any) { stop(); error.details = [...(error.details ?? []), snapshot()]; throw error; }
      },
    });
  } catch (error: any) {
    let receipt: any; if (!runtime && error.cleanup === 'pending') receipt = { cleanup: 'pending' }; else { try { receipt = await close(); } catch { receipt = { cleanup: 'pending' }; } }
    throw Object.assign(new Error('Lead-Worker startup failed'), { code: startup.aborted ? 'HARNESS_START_ABORTED' : error.code ?? 'HARNESS_START_FAILED', runtimeId: runtime?.id ?? error.runtimeId, cleanup: receipt.cleanup, details: [snapshot(), receipt, ...(error.name === 'ResourceError' ? redact(error.details ?? []) : [])] });
  } finally { startup.removeEventListener('abort', abortStartup); }
}

export function runLeadWorker(options: any, input: any) {
  let owned: any;
  return runWithReport({ outputDir: options.outputDir, closeTimeoutMs: options.closeTimeoutMs ?? 30_000,
    createRuntime: async () => { owned = await createLeadWorkerHarness(options); return owned; },
    run: (harness: any) => {
      options.signal?.throwIfAborted();
      options.beforeInitialDispatch?.();
      return options.dynamic ? harness.runDynamic(input) : harness.runWorkflow(input);
    }, redact: (report: any) => owned ? owned.redact(report) : report });
}

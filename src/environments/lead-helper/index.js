import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRuntime } from '@swarmenv/core';
import { ServiceRegistry } from '@swarmenv/core/services';
import { createOwnedResources } from '../agensh/resources.js';
import { runInput } from '../shared/run-input.js';
import { runWithReport } from '../shared/run-report.js';
import { createBoard, boardPermissions } from './board.js';
import { leadHelperRoles } from './team.js';
import { prepareLeadHelperGit, createLeadHelperGit } from './git.js';
import { leadPrompt, helperPrompt, initializeInstruction, helperInitialInstruction, leadAdjustmentInstruction, helperFollowupInstruction } from './prompts.js';

const fail = code => Object.assign(new Error(code), { code });
const bounded = (value, fallback, maximum) => { const result = value ?? fallback; if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new TypeError('Invalid lead-helper wait bound'); return result; };
export async function createLeadHelperEnvironment(options) {
  const { runId, image, model = 'default', outputDir, backend, exportLimit = 64 * 1024 ** 2, helperCount = 2 } = options;
  const roles = leadHelperRoles(helperCount);
  const helperRoles = roles.slice(1);
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(runId ?? '') || typeof image !== 'string' || !image || typeof outputDir !== 'string' || !outputDir || !Number.isSafeInteger(exportLimit) || exportLimit < 1 || exportLimit > 64 * 1024 ** 2) throw new TypeError('Invalid lead-helper run configuration');
  const turnTimeoutMs = bounded(options.turnTimeoutMs, 30_000, 120_000); const workTimeoutMs = bounded(options.workTimeoutMs, 120_000, 120_000);
  const closeTimeoutMs = bounded(options.closeTimeoutMs, 30_000, 60_000);
  const resources = createOwnedResources(); const lifetime = new AbortController();
  const startup = AbortSignal.any([AbortSignal.timeout(120_000), ...(options.signal ? [options.signal] : [])]);
  const directory = join(resolve(outputDir), `lead-helper-${runId}`); await mkdir(directory, { recursive: true, mode: 0o700 });
  const boardPath = join(directory, 'board.sqlite');
  const secrets = [options.gitea?.adminToken, ...(options.secretValues ?? [])].filter(value => typeof value === 'string' && value);
  let runtime; let board; let git; let unsubscribe; let closing = false; let closeWork; let complete; let workflowUsed = false; let boardFenceFailure;
  const pendingFences = new Map(); const activeInputs = new Set();
  const team = {}; const inputs = []; const events = [];
  const stages = []; let stageActive = false; let preparedStages;
  const redact = value => { let body = JSON.stringify(value); for (const secret of [...secrets].sort((a, b) => b.length - a.length)) body = body.split(JSON.stringify(secret).slice(1, -1)).join('[redacted]'); return JSON.parse(body); };
  const snapshot = () => {
    let publicBoard; let boardReadFailure;
    try { publicBoard = board?.snapshot(); } catch { boardReadFailure = { code: 'BOARD_READ_FAILED' }; }
    return { runId, runtimeId: runtime?.id, boardPath, team: { ...team }, stages: structuredClone(stages), preparation: structuredClone(preparedStages ?? null), git: git?.identities(), board: publicBoard, ...(boardReadFailure ? { boardReadFailure } : {}), inputs: structuredClone(inputs), events: structuredClone(events),
      delivered: publicBoard?.subtasks.filter(row => row.delivery?.verified) ?? [], unfinished: publicBoard?.subtasks.filter(row => row.state !== 'complete') ?? [], inputUnknown: inputs.filter(row => row.uncertain).map(row => ({ botId: row.botId, requestId: row.requestId, inputId: row.inputId, code: row.code })), resources: resources.snapshot(),
      ...(boardFenceFailure ? { boardFenceFailure, pendingBoardFailures: [...pendingFences.values()] } : {}), limitations: ['Local SQLite Board and exclusive turn controller', 'Fixed preconfigured team; no replacement or claim reclamation', 'Upstream scale and performance not verified'] };
  };
  function recordFence(record) {
    if (record?.botId) pendingFences.set(record.botId, record);
    try {
      board?.fence(record);
      if (record?.botId) pendingFences.delete(record.botId);
      if (!pendingFences.size) boardFenceFailure = undefined;
    } catch { boardFenceFailure = { code: 'BOARD_FENCE_FAILED' }; }
  }
  function stop() { if (!closing) { closing = true; lifetime.abort(); recordFence(); } }

  async function close({ timeoutMs = closeTimeoutMs } = {}) {
    stop(); if (complete) return structuredClone(complete);
    if (!closeWork) {
      // Public Core closes admission synchronously before the first await.
      const coreWork = runtime ? runtime.close({ timeoutMs }) : Promise.resolve({ cleanup: 'complete', bots: [], pending: [] });
      closeWork = (async () => {
        const core = await coreWork;
        let recordedFailures = {}; let boardReadFailed = false;
        try { recordedFailures = board?.snapshot().failures ?? {}; } catch { boardReadFailed = true; }
        const failures = new Map(Object.entries(recordedFailures));
        for (const [botId, failure] of pendingFences) failures.set(botId, failure);
        for (const [botId, failure] of failures) recordFence({ botId, code: failure.code, execution: core.bots?.find(row => row.botId === botId)?.execution === 'stopped' ? 'stopped' : 'unknown' });
        if (boardFenceFailure) recordFence();
        if (boardReadFailed || boardFenceFailure || pendingFences.size) return { ...core, cleanup: 'pending', environment: { cleanup: 'pending', pending: [{ kind: 'board-evidence', id: boardPath, action: 'persist-failure', error: { code: 'BOARD_FENCE_FAILED' } }], resources: resources.snapshot() } };
        if (core.cleanup !== 'complete' || core.bots.some(row => row.execution !== 'stopped' || row.cleanup !== 'complete')) return { ...core, environment: { cleanup: 'pending', pending: resources.snapshot().filter(row => !['closed', 'retained'].includes(row.state)) } };
        unsubscribe?.(); const environment = await resources.close(); const receipt = { ...core, cleanup: environment.cleanup, environment }; if (environment.cleanup === 'complete') complete = receipt; return receipt;
      })().finally(() => { closeWork = undefined; });
    }
    return structuredClone(await closeWork);
  }
  const dispatch = async (role, requestId, payload, workSignal) => {
    if (workSignal.aborted || closing) throw fail('WORKFLOW_STOPPED');
    const row = { role, botId: team[role], requestId, source: payload.type }; inputs.push(row); activeInputs.add(team[role]);
    try {
      const result = await runInput(runtime, team[role], JSON.stringify(payload), { requestId, timeoutMs: turnTimeoutMs, signal: workSignal }); Object.assign(row, { inputId: result.inputId, receipt: result.receipt, state: 'completed', settledSeq: result.settled.seq, settled: { botId: result.settled.botId, seq: result.settled.seq, outcome: result.settled.outcome } }); return result;
    } catch (error) { Object.assign(row, { inputId: error.inputId, receipt: error.receipt, state: 'failed', code: error.code ?? 'INPUT_FAILED', uncertain: !['input_failed', 'input_aborted'].includes(error.code) }); recordFence({ botId: team[role], code: row.code }); lifetime.abort(); throw error; }
    finally { activeInputs.delete(team[role]); }
  };
  const abortStartup = () => { if (runtime) void runtime.close({ timeoutMs: 1 }).catch(() => {}); };
  startup.addEventListener('abort', abortStartup, { once: true });
  try {
    if (startup.aborted) throw fail('ENVIRONMENT_START_ABORTED');
    const facilities = await (options.prepare ?? prepareLeadHelperGit)({ ...options, helperCount, signal: startup, resources });
    for (const actor of Object.values(facilities.actors ?? {})) secrets.push(actor.token);
    if (facilities.runId !== runId || startup.aborted) throw fail('ENVIRONMENT_START_ABORTED');
    git = createLeadHelperGit(facilities, helperCount);
    const candidate = createBoard({ path: boardPath, runId, helperCount, verifyDelivery: value => git.verifyDelivery(value) });
    if (candidate.snapshot().team || candidate.snapshot().fenced) { candidate.close(); throw fail('BOARD_ALREADY_OWNED'); }
    board = candidate;
    resources.own({ kind: 'board-data', id: boardPath, retained: true }); resources.own({ kind: 'board-connection', id: boardPath, close: () => board.close() });
    const services = new ServiceRegistry(); board.register(services); git.register(services);
    const profiles = Object.fromEntries(roles.map(role => {
      const actor = facilities.actors[role];
      return [role, { image, model, writable: true, prompt: role === 'lead' ? leadPrompt : helperPrompt,
        env: { RUN_REPOSITORY: facilities.repositoryUrl, WORK_BRANCH: actor.branch, GITEA_USERNAME: actor.username, GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: actor.username, GIT_AUTHOR_EMAIL: `${actor.username}@swarmenv.invalid`, GIT_COMMITTER_NAME: actor.username, GIT_COMMITTER_EMAIL: `${actor.username}@swarmenv.invalid`, RUN_OWNER: facilities.repository.owner, RUN_REPO: facilities.repository.name },
        network: { allow: [new URL(facilities.repositoryUrl).origin] }, services: { board: boardPermissions[role === 'lead' ? 'lead' : 'helper'], gitea: ['pull_request_write'] } }];
    }));
    runtime = await createRuntime({ backend, services, profiles, maxBots: roles.length, outputDir });
    if (startup.aborted) throw fail('ENVIRONMENT_START_ABORTED');
    unsubscribe = runtime.onEvent(event => {
      if (events.length < 256) events.push({ botId: event.botId, seq: event.seq, type: event.type, ...(event.outcome ? { outcome: event.outcome } : {}) });
      if (events.length >= 256 || event.type === 'error' && event.fatal || event.type === 'settled' && event.outcome !== 'completed' || event.type === 'exit' && !event.expected) {
        if (!closing) { recordFence({ botId: event.botId, code: 'BOT_FAILED' });
          // The exclusive helper owns terminal-event/late-receipt ordering.
          // Its catch cancels the team without replacing that original outcome.
          if (!activeInputs.has(event.botId)) lifetime.abort(); }
      }
    });
    for (const role of roles) {
      if (startup.aborted || lifetime.signal.aborted) throw fail('ENVIRONMENT_START_ABORTED');
      const actor = facilities.actors[role]; const bot = await runtime.spawn({ requestId: `spawn-${role}`, profile: role, bindings: { board: `${runId}:board`, gitea: actor.binding }, secretEnv: { GITEA_TOKEN: actor.token }, collect: { paths: ['.'], includeGit: true, maxBytes: exportLimit, required: true } }); team[role] = bot.id;
    }
    if (startup.aborted || lifetime.signal.aborted) throw fail('ENVIRONMENT_START_ABORTED');
    board.bindTeam(runtime.id, team); git.bindTeam(runtime.id, team);
    return Object.freeze({ id: runtime.id, snapshot, redact, close, get: botId => runtime.get(botId),
      async prepareStages({ signal } = {}) {
        if (closing || workflowUsed || stageActive || helperCount !== 3 ||
            (signal !== undefined && !(signal instanceof AbortSignal))) throw fail('INVALID_STAGE_PREPARATION');
        workflowUsed = true; stageActive = true;
        const workSignal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(workTimeoutMs), ...(signal ? [signal] : [])]);
        const startInput = inputs.length; const notes = [];
        try {
          for (const role of roles) {
            const readyNote = `Ready for staged workload: ${runtime.id}:${role}:${team[role]}`;
            const before = board.snapshot();
            await dispatch(role, `prepare-stage-${role}`, { type: 'prepare-stage', ready_note: readyNote,
              instruction: 'Read the public Board, verify your own trusted role and Bot identity, then publish exactly ready_note as a public unscoped Board note. Do not claim work or create an artifact. This is setup only.' }, workSignal);
            const after = board.snapshot();
            const note = after.notes.find(row => row.actor === team[role] && row.text === readyNote && !row.subtask_id && !before.notes.some(old => old.seq === row.seq));
            if (!note || !after.reads.some(row => row.actor === team[role] && !before.reads.some(old => old.seq === row.seq))) throw fail('STAGE_PREPARATION_INVALID');
            notes.push(note);
          }
          preparedStages = { notes, inputs: structuredClone(inputs.slice(startInput)) };
          return structuredClone(preparedStages);
        } catch (error) { stop(); error.details = [...(error.details ?? []), snapshot()]; throw error; }
        finally { stageActive = false; }
      },
      async runStage({ goal, supplement, paths, signal } = {}) {
        const stage = stages.length;
        const text = stage === 0 ? goal : supplement;
        if (closing || stageActive || stage >= 4 || helperCount !== 3 || workflowUsed && stage === 0 && !preparedStages ||
            typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 8192 ||
            (signal !== undefined && !(signal instanceof AbortSignal)) ||
            !paths || Object.keys(paths).length !== 3 || helperRoles.some(role => !Object.hasOwn(paths, role) || typeof paths[role] !== 'string' ||
              paths[role].length > 256 || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.[A-Za-z0-9]+$/.test(paths[role])) ||
            new Set(Object.values(paths)).size !== 3 || stages.some(prior => Object.values(paths).some(path => Object.values(prior.paths).includes(path)))) throw fail('INVALID_STAGE');
        const fixedPaths = structuredClone(paths);
        workflowUsed = true; stageActive = true;
        const workSignal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(workTimeoutMs), ...(signal ? [signal] : [])]);
        const send = (role, payload) => dispatch(role, `stage-${stage}-${role}`, { ...payload, stage, paths: fixedPaths }, workSignal);
        const helpers = Object.fromEntries(helperRoles.map(role => [role, team[role]]));
        const previous = stages.at(-1); const startInput = inputs.length;
        try {
          const before = board.snapshot();
          if (stage === 0) await send('lead', { type: 'initialize', instruction: initializeInstruction + ' Use exactly the supplied role-to-path map for this stage.', goal: text, helpers });
          else {
            const userInputId = `lead-stage-${stage}`;
            board.registerUserInput(userInputId, text);
            await send('lead', { type: 'user-and-feedback', instruction: leadAdjustmentInstruction + ' Cite exactly the previous stage feedback_ids and use the supplied new role-to-path map.',
              user_input_id: userInputId, supplement: text, feedback_ids: previous.feedback.map(row => row.seq) });
          }
          const announced = board.snapshot(); const direction = announced.directions.at(-1);
          if (!direction || direction.seq <= (before.directions.at(-1)?.seq ?? 0) ||
              helperRoles.some(role => !announced.assignments.some(row => row.helper_id === team[role]) ||
                !announced.subtasks.some(row => row.path === fixedPaths[role] && row.state === 'ready' && !row.owner && !before.subtasks.some(old => old.id === row.id)))) throw fail('STAGE_DIRECTION_INVALID');
          if (stage && (direction.text === previous.direction.text || direction.user_input_id !== `lead-stage-${stage}` ||
              direction.feedback_ids.length !== 3 || previous.feedback.some(note => !direction.feedback_ids.includes(note.seq)))) throw fail('DIRECTION_ADJUSTMENT_INVALID');
          const results = [];
          // The cumulative hour owner permits two concurrent model requests.
          // Complete each pair of exclusive inputs before admitting the next.
          for (let offset = 0; offset < helperRoles.length; offset += 2) {
            results.push(...await Promise.allSettled(helperRoles.slice(offset, offset + 2).map(role => send(role, {
              type: stage ? 'helper-followup' : 'helper-initial',
              instruction: (stage ? helperFollowupInstruction : helperInitialInstruction) + ' Deliver only your supplied path and publish one new feedback note.' }))));
            if (results.some(row => row.status === 'rejected')) break;
          }
          if (results.some(row => row.status === 'rejected')) throw results.find(row => row.status === 'rejected').reason;
          const final = board.snapshot();
          const deliveries = helperRoles.map(role => final.subtasks.find(row => row.owner === team[role] && row.path === fixedPaths[role] &&
            row.state === 'complete' && row.directionId === direction.seq && row.delivery?.verified && !before.subtasks.some(old => old.id === row.id || old.delivery?.commit === row.delivery.commit)));
          if (deliveries.some(row => !row)) throw fail('DIRECTION_NOT_ADOPTED');
          const feedback = deliveries.map(row => final.notes.find(note => note.actor === row.owner && note.subtask_id === row.id && note.seq > direction.seq && !before.notes.some(old => old.seq === note.seq)));
          if (feedback.some(row => !row)) throw fail('HELPER_FEEDBACK_INVALID');
          const receipt = { stage, paths: fixedPaths, direction, deliveries, feedback, boardRevision: final.history.at(-1).seq,
            inputs: structuredClone(inputs.slice(startInput)) };
          if (stage === 3) {
            receipt.pinnedDeliveries = [];
            for (const prior of [...stages, receipt]) for (const task of prior.deliveries) {
              if (workSignal.aborted || closing) throw fail('WORKFLOW_STOPPED');
              const proof = await git.verifyPinnedDelivery({ actor: task.owner, delivery: task.delivery, direction: prior.direction,
                requireDirectionText: prior.stage > 0, signal: workSignal });
              receipt.pinnedDeliveries.push({ stage: prior.stage, botId: task.owner, ...proof });
            }
          }
          stages.push(receipt);
          return structuredClone(receipt);
        } catch (error) { stop(); error.details = [...(error.details ?? []), snapshot()]; throw error; }
        finally { stageActive = false; }
      },
      async runWorkflow({ goal, supplement, signal } = {}) {
        if (closing || workflowUsed || ![goal, supplement].every(value => typeof value === 'string' && value.trim() && Buffer.byteLength(value) <= 8192)) throw fail('INVALID_WORKFLOW'); workflowUsed = true;
        const workSignal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(workTimeoutMs), ...(signal ? [signal] : [])]);
        const send = (role, requestId, payload) => dispatch(role, requestId, payload, workSignal);
        const helpers = Object.fromEntries(helperRoles.map(role => [role, team[role]]));
        const helperIds = Object.values(helpers);
        try {
          await send('lead', 'lead-initialize', { type: 'initialize', instruction: initializeInstruction, goal, helpers });
          const initial = board.snapshot(); const original = initial.directions.at(-1);
          if (!original || helperIds.some(id => !initial.assignments.some(row => row.helper_id === id)) || initial.subtasks.filter(row => row.state === 'ready' && !row.owner).length < helperCount) throw fail('INITIALIZATION_INVALID');
          const first = await Promise.allSettled(helperRoles.map(role => send(role, `${role}-initial`, { type: 'helper-initial', instruction: helperInitialInstruction })));
          if (first.some(row => row.status === 'rejected')) throw first.find(row => row.status === 'rejected').reason;
          const feedback = board.snapshot(); const before = feedback.subtasks.filter(row => row.state === 'complete' && row.delivery?.verified);
          if (helperIds.some(id => !before.some(row => row.owner === id) || !feedback.notes.some(row => row.actor === id))) throw fail('HELPER_DELIVERY_INVALID');
          board.registerUserInput('lead-adjust', supplement);
          await send('lead', 'lead-adjust', { type: 'user-and-feedback', instruction: leadAdjustmentInstruction, user_input_id: 'lead-adjust', supplement });
          const updated = board.snapshot(); const direction = updated.directions.at(-1);
          if (direction.seq <= original.seq || direction.text === original.text || direction.user_input_id !== 'lead-adjust' || helperIds.some(id => !updated.notes.some(note => note.actor === id && direction.feedback_ids.includes(note.seq)))) throw fail('DIRECTION_ADJUSTMENT_INVALID');
          const later = await Promise.allSettled(helperRoles.map(role => send(role, `${role}-followup`, { type: 'helper-followup', instruction: helperFollowupInstruction })));
          if (later.some(row => row.status === 'rejected')) throw later.find(row => row.status === 'rejected').reason;
          const final = board.snapshot();
          if (helperIds.some(id => !final.subtasks.some(row => row.owner === id && row.state === 'complete' && row.directionId === direction.seq && row.delivery?.verified && !before.some(old => old.id === row.id || old.delivery.commit === row.delivery.commit)))) throw fail('DIRECTION_NOT_ADOPTED');
          return { originalDirection: original, adjustedDirection: direction, environment: snapshot() };
        } catch (error) { stop(); error.details = [...(error.details ?? []), snapshot()]; throw error; }
      },
    });
  } catch (error) {
    let receipt; if (!runtime && error.cleanup === 'pending') receipt = { cleanup: 'pending' }; else { try { receipt = await close(); } catch { receipt = { cleanup: 'pending' }; } }
    throw Object.assign(new Error('Lead-helper startup failed'), { code: startup.aborted ? 'ENVIRONMENT_START_ABORTED' : error.code ?? 'ENVIRONMENT_START_FAILED', runtimeId: runtime?.id ?? error.runtimeId, cleanup: receipt.cleanup, details: [snapshot(), receipt, ...(error.name === 'ResourceError' ? redact(error.details ?? []) : [])] });
  } finally { startup.removeEventListener('abort', abortStartup); }
}

export function runLeadHelper(options, input) {
  let owned;
  return runWithReport({ outputDir: options.outputDir, closeTimeoutMs: options.closeTimeoutMs ?? 30_000,
    createRuntime: async () => { owned = await createLeadHelperEnvironment(options); return owned; },
    run: environment => environment.runWorkflow(input), redact: report => owned ? owned.redact(report) : report });
}

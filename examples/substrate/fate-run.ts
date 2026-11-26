import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRuntime, type Backend, type ModelCaller, type Profile, type StopReceipt } from '@murm/core';
import { ServiceRegistry, type ServiceCaller } from '@murm/core/services';
import { runInput } from '../../src/harnesses/shared/run-input.js';
import { runWithReport } from '../../src/harnesses/shared/run-report.js';
import { createPaperSubstrate, type SharingMode } from '../../src/harnesses/substrate/paper-substrate.js';
import { MathlibSearchService } from '../../src/services/mathlib-search-service.js';
import { createFateChecker, loadFateProject, sha256, type FateBenchmark, type FateProject } from './fate-checker.js';
import { maxFateOperationsPerPeer, createFateTaskService, type FateCandidate, type MathlibMatch } from './fate-service.js';

export const fateSharingPrompt = [
  'When you start a new subgoal or hit a specific blocker, try searching substrate for the goal, blocker, or exact lemma name, even if an earlier search was empty.',
  'If you find something that could save another peer work, publish a short note when you have it. A candidate lemma and how to apply it, a solved subgoal, or a failed route and why it failed can each be useful before you have a full proof.',
  'Say what you have verified and what is still tentative.',
].join('\n');

export const fatePrivatePrompt = [
  'When you start a new subgoal or get stuck, search substrate for work on that specific subgoal.',
  'Publish reusable intermediate results as they become available and say what you have verified.',
].join('\n');

export const fateInput = 'Solve the original problem in problem.lean and problem.txt. The question resource address appears in problem.txt. Submit a Lean proof term using the fate Service.';

export function fateVerifiedInput(workTimeoutMs: number) {
  const workWindow = workTimeoutMs % 60_000 === 0 ? `${workTimeoutMs / 60_000}-minute` : `${workTimeoutMs / 1_000}-second`;
  return [
    fateInput,
    `You have a ${workWindow} work window from the time all peers are ready.`,
    'Keep working while you can still get a proof checked and submit it within your allowances and work window. If a proof fails, read the diagnostic, work on the missing subgoal or try a different approach, and continue.',
    'Before ending, run swarm fate check_lean on your exact proof and wait for status passed. Then submit the same proof with swarm fate submit and finish=true.',
    'Use finish=false to save an unfinished candidate and keep working. Reserve enough Service operations for your final check and submission.',
  ].join('\n');
}

export const fateVerificationContinuation = 'Continue in this Session. If swarm fate check_lean already returned passed for your exact proof, submit those same bytes with finish=true. Otherwise, work on an unresolved subgoal or try another approach. Reserve an operation to submit after your proof passes.';

const modes: SharingMode[] = ['shared', 'private', 'none'];
const submissionReceiptGraceMs = 1_000;
const noTime = () => new Error('Substrate FATE work is closed');
const durations = { setup: 180_000, work: 1_800_000, hardWork: 2_700_000, close: 120_000, score: 900_000 } as const;

interface FateOptions {
  projectRoot: string;
  leanRoot: string;
  benchmark?: FateBenchmark;
  mode?: SharingMode;
  setupTimeoutMs?: number;
  scoreTimeoutMs?: number;
  verifiedCompletion?: boolean;
}

interface RunOptions {
  backend: Backend;
  fate: FateOptions;
  runId: string;
  image: string;
  outputDir: string;
  model?: string;
  poolSize?: number;
  workTimeoutMs?: number;
  closeTimeoutMs?: number;
  checkpointAfterMs?: number;
}

type CompletionBudget = { remainingOperations: number; remainingChecks: number; hasPassingProof: boolean };
type Peer = {
  agentId: string; finish: AbortController; active: boolean; semanticOperations: number;
  endReason?: 'submitted' | 'settled' | 'deadline' | 'cancelled' | 'failed' | 'operation_limit' | 'check_limit';
  inputFailure?: { code: string; inputId?: string; receipt?: unknown }; startedAt?: string; endedAt?: string;
  inputId?: string; stop?: StopReceipt; stopFailure?: string;
  finishRequested?: boolean; finishTimer?: ReturnType<typeof setTimeout>;
  continuations?: number;
  completionBudget?: CompletionBudget;
};

type FrozenCandidates = {
  version: 1; runId: string; mode: SharingMode; benchmark?: FateBenchmark; problemId: number; problemSha256: string;
  frozenAt: string; scoreTimeoutMs: number; peers: { agentId: string; candidate: FateCandidate | null }[];
};

type Checkpoint = { state: 'not_reached'; afterMs: number } |
  { state: 'recorded'; afterMs: number; path: string; scheduledAt: string; capturedAt: string } |
  { state: 'failed'; afterMs: number; scheduledAt: string; capturedAt: string; code: 'FATE_CHECKPOINT_FAILED' };

async function writePrivateJson(path: string, value: unknown) {
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}

function createSearch(project: FateProject) {
  const library = new MathlibSearchService({
    upstreamUrl: null, sourceRoot: project.mathlibRoot, projectRoot: null,
    leanVersion: project.pins.leanVersion, mathlibRevision: project.pins.mathlibRevision, maxResults: 10,
  });
  return async (query: string, signal?: AbortSignal) => {
    const found = await library.handle({ input: { query, max_results: 10 }, signal });
    return found.results.map(({ name, type, module, source }: MathlibMatch) => ({ name, type, module, source })) as MathlibMatch[];
  };
}

export async function prepareFate(fate: Pick<FateOptions, 'projectRoot' | 'leanRoot' | 'benchmark'>) {
  const start = performance.now();
  const project = await loadFateProject(fate);
  const checker = await createFateChecker(project);
  try {
    const library = await createSearch(project)('Fintype.card');
    if (!library.length) throw new Error('Fixed Mathlib source index is empty');
    const negative = await checker.evaluate('by\n  exact True.intro', { timeoutMs: 60_000 });
    if (negative.status !== 'rejected' || negative.code !== 'LEAN_REJECTED') throw new Error('FATE checker did not reject a known false proof term');
    return { benchmark: project.benchmark, pins: project.pins, problemSha256: project.problemSha256, preparedMs: Math.round(performance.now() - start),
      negativeControlMs: negative.elapsedMs, mathlibResults: library.length };
  } finally { await checker.close(); }
}

async function evaluateFrozen(project: FateProject, bundle: FrozenCandidates) {
  if (bundle?.version !== 1 || (bundle.benchmark ?? 'FATE-M') !== project.benchmark || bundle.problemId !== project.pins.problemId ||
      bundle.problemSha256 !== project.problemSha256 ||
      !modes.includes(bundle.mode) || !Number.isSafeInteger(bundle.scoreTimeoutMs) || bundle.scoreTimeoutMs < 1 ||
      bundle.scoreTimeoutMs > durations.score || !Array.isArray(bundle.peers) ||
      new Set(bundle.peers.map(peer => peer.agentId)).size !== bundle.peers.length ||
      bundle.peers.some(({ agentId, candidate }) => typeof agentId !== 'string' || !agentId || (candidate !== null &&
        (candidate?.agentId !== agentId || typeof candidate.proof !== 'string' || sha256(candidate.proof) !== candidate.sha256)))) {
    throw new Error('Frozen candidate bundle identity or proof digest mismatch');
  }
  const start = performance.now();
  const checker = bundle.peers.some(peer => peer.candidate) ? await createFateChecker(project) : null;
  try {
    const scores = await Promise.all(bundle.peers.map(async ({ agentId, candidate }) => candidate ? {
      agentId, sha256: candidate.sha256, ...(await checker!.evaluate(candidate.proof, { timeoutMs: bundle.scoreTimeoutMs })),
    } : { agentId, sha256: null, status: 'no_submission', code: 'NO_SUBMISSION', elapsedMs: 0 }));
    return {
      runId: bundle.runId, mode: bundle.mode, benchmark: project.benchmark, problemId: bundle.problemId, problemSha256: bundle.problemSha256,
      teamSuccess: scores.some(score => score.status === 'passed'), candidates: scores,
      scoreElapsedMs: Math.round(performance.now() - start),
    };
  } finally { await checker?.close(); }
}

export async function rescoreFate(fate: Pick<FateOptions, 'projectRoot' | 'leanRoot'>, bundlePath: string) {
  const bundle: FrozenCandidates = JSON.parse(await readFile(bundlePath, 'utf8'));
  const project = await loadFateProject({ ...fate, benchmark: bundle?.benchmark });
  return evaluateFrozen(project, bundle);
}

async function measureEvidence(path: string | undefined, receipt: StopReceipt[] = []) {
  try {
    if (!path) throw new Error('Core report path unavailable');
    const report = JSON.parse(await readFile(path, 'utf8'));
    const usage = (report.modelLedgers as { alias: string; path: string }[]).map(ledger => {
      const db = new DatabaseSync(ledger.path, { readOnly: true });
      try {
        return { alias: ledger.alias, peers: db.prepare(`SELECT agent_id AS agentId, COUNT(*) AS requests,
          COUNT(*) FILTER (WHERE input_tokens IS NULL OR output_tokens IS NULL) AS requestsWithoutUsage,
          COUNT(*) FILTER (WHERE state='unknown') AS unknownRequests,
          COUNT(*) FILTER (WHERE state='pending') AS pendingRequests, SUM(input_tokens) AS inputTokens,
          SUM(output_tokens) AS outputTokens FROM runtime_model_attempts WHERE runtime_id=? GROUP BY agent_id ORDER BY agent_id`).all(report.runtimeId) };
      } finally { db.close(); }
    });
    const nativeTools = await Promise.all(receipt.map(async ({ agentId, sessionArchive }) => {
      try {
        if (!sessionArchive) return { agentId, state: 'unavailable', counts: null };
        const manifest = JSON.parse(await readFile(sessionArchive, 'utf8'));
        const sessions = (manifest.files as { path: string }[]).filter(file => file.path.endsWith('.jsonl'));
        if (!sessions.length) return { agentId, state: 'unavailable', counts: null };
        const calls = new Map<string, string>();
        for (const session of sessions) {
          const raw = await readFile(join(dirname(sessionArchive), 'files', session.path), 'utf8');
          for (const line of raw.trim().split('\n').filter(Boolean)) {
            const entry = JSON.parse(line);
            const content = entry.type === 'message' && entry.message.role === 'assistant' ? entry.message.content : [];
            if (!Array.isArray(content)) continue;
            for (const item of content) if (item.type === 'toolCall' && typeof item.id === 'string' && typeof item.name === 'string') calls.set(item.id, item.name);
          }
        }
        const counts: Record<string, number> = { read: 0, write: 0, edit: 0, bash: 0 };
        for (const name of calls.values()) counts[name] = (Object.hasOwn(counts, name) ? counts[name] : 0) + 1;
        return { agentId, state: 'recorded', counts };
      } catch { return { agentId, state: 'unavailable', counts: null }; }
    }));
    const tracePath = join(dirname(path), 'service-calls.jsonl');
    const serviceTrace = await stat(tracePath).then(info => ({ path: tracePath, bytes: info.size }), () => null);
    return { modelUsage: usage, modelTrace: report.modelTrace, serviceTrace, nativeToolCalls: nativeTools };
  } catch { return { modelUsage: null, modelTrace: null, serviceTrace: null, nativeToolCalls: null }; }
}

function limited<T>(promise: Promise<T>, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

export async function runFateSubstrate({
  backend, fate, runId, image, outputDir, model = 'default', poolSize = 4,
  workTimeoutMs = fate.benchmark === 'FATE-H' ? durations.hardWork : durations.work,
  closeTimeoutMs = durations.close, checkpointAfterMs,
}: RunOptions, externalSignal?: AbortSignal) {
  const { mode = 'shared', setupTimeoutMs = durations.setup, scoreTimeoutMs = durations.score, verifiedCompletion = false } = fate;
  const maxWorkMs = fate.benchmark === 'FATE-H' ? durations.hardWork : durations.work;
  const bounded = (value: number, max: number) => Number.isSafeInteger(value) && value >= 1 && value <= max;
  if (!modes.includes(mode) || typeof verifiedCompletion !== 'boolean' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(runId) ||
      ![1, 2, 4, 8, 16].includes(poolSize) || !bounded(workTimeoutMs, maxWorkMs) ||
      (checkpointAfterMs !== undefined && !bounded(checkpointAfterMs, workTimeoutMs - 1)) ||
      !bounded(setupTimeoutMs, durations.setup) || !bounded(closeTimeoutMs, durations.close) || !bounded(scoreTimeoutMs, durations.score) ||
      typeof image !== 'string' || !image || typeof outputDir !== 'string' || !outputDir) throw new TypeError('Invalid Substrate FATE configuration');
  externalSignal?.throwIfAborted();
  const preparationStarted = performance.now();
  const setup = AbortSignal.timeout(setupTimeoutMs);
  const setupSignal = externalSignal ? AbortSignal.any([setup, externalSignal]) : setup;
  const directory = join(outputDir, runId);
  let checkpoint: Checkpoint | null = checkpointAfterMs === undefined ? null : { state: 'not_reached', afterMs: checkpointAfterMs };
  await mkdir(outputDir, { mode: 0o700, recursive: true });
  await mkdir(directory, { mode: 0o700 }); // A group never attaches to an earlier run's evidence.
  let project: FateProject;
  let checker: Awaited<ReturnType<typeof createFateChecker>>;
  try {
    project = await loadFateProject({ ...fate, signal: setupSignal });
    checker = await createFateChecker(project, setupSignal);
  } catch (error) {
    const code = externalSignal?.aborted ? 'FATE_SETUP_CANCELLED' : setup.aborted ? 'FATE_SETUP_TIMEOUT' : 'FATE_CHECKER_SETUP_FAILED';
    const result = {
      runId, mode, runtimeId: null, reportPath: null, bundlePath: null, startedAt: null, setupFailed: true,
      setupElapsedMs: Math.round(performance.now() - preparationStarted), scoring: null, scoreFailure: null,
      businessFailure: { code, message: error instanceof Error && 'code' in error ? String(error.code) : 'FATE setup did not complete' },
      cleanup: null, cleanupFailure: null, reportSaveFailure: null, checkpoint,
    };
    await writePrivateJson(join(directory, 'fate-result.json'), result);
    return result;
  }
  const search = createSearch(project);
  const services = new ServiceRegistry();
  const peers = new Map<string, Peer>();
  const semanticRequests = new Map<string, Set<string>>();
  const work = new AbortController();
  const workSignal = externalSignal ? AbortSignal.any([work.signal, externalSignal]) : work.signal;
  let runtimeId: string | undefined;
  let startedAt: string | null = null;
  let setupElapsedMs: number | null = null;
  let deadlineMs = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const remainingMs = () => workSignal.aborted ? 0 : Math.max(0, deadlineMs - Date.now());
  const authorize = (caller: ServiceCaller | ModelCaller) => {
    if (!startedAt || caller.runtimeId !== runtimeId || caller.profile !== 'peer' || !peers.get(caller.agentId)?.active || remainingMs() === 0) {
      throw Object.assign(noTime(), { code: 'NOT_ALLOWED' });
    }
  };
  const countOperation = (agentId: string, operation: string, requestId: string) => {
    const peer = peers.get(agentId)!;
    const seen = semanticRequests.get(agentId)!;
    const key = JSON.stringify([operation, requestId]);
    if (seen.has(key)) return;
    if (peer.finishRequested) throw Object.assign(new Error('Peer has finished; only stable request replay is available'), { code: 'NOT_ALLOWED' });
    if (peer.semanticOperations >= maxFateOperationsPerPeer) throw Object.assign(new Error('Peer used its task and contribution operation allowance'), { code: 'OPERATION_LIMIT' });
    seen.add(key);
    peer.semanticOperations++;
  };
  let substrate: ReturnType<typeof createPaperSubstrate> | null = null;
  let task: ReturnType<typeof createFateTaskService> | undefined;
  try {
    const problemAddress = `fate:${project.pins.problemId}:${project.problemSha256}`;
    task = createFateTaskService({
      path: join(directory, 'fate-candidates.sqlite'), services, authorize, countOperation, remainingMs, signal: workSignal,
      problemAddress, shareMathlibResources: mode === 'shared', verifiedCompletion, search, check: checker.evaluate,
      validateReferences(agentId, rationale, refs) {
        if (substrate) substrate.validateReferences(agentId, rationale, refs);
        else if (refs.some(ref => !task!.resourceExists(agentId, ref))) throw Object.assign(new Error('Reference is outside the task resources'), { code: 'NOT_FOUND' });
      },
      onFinish(agentId) {
        const peer = peers.get(agentId)!;
        peer.finishRequested = true;
        // Allow Bridge to deliver the committed receipt and Pi to settle.
        // Fresh task/substrate requests are already fenced.
        peer.finishTimer = setTimeout(() => peer.finish.abort(), Math.min(submissionReceiptGraceMs, remainingMs()));
      },
    });
    if (mode !== 'none') substrate = createPaperSubstrate({
      databasePath: join(directory, 'substrate.sqlite'), runId, mode, services, authorize, countOperation, resourceExists: task.resourceExists,
    });
    const profile: Profile = {
      image, model, writable: true,
      ...(substrate ? { prompt: mode === 'shared' ? fateSharingPrompt : fatePrivatePrompt } : {}),
      services: { fate: ['search_mathlib', 'check_lean', 'submit'], ...(substrate ? { substrate: ['publish', 'search', 'visit'] } : {}) },
    };
    const report = await runWithReport({
      outputDir: directory, closeTimeoutMs,
      redact: (record: Record<string, unknown>) => ({
        ...record, mode, runId, startedAt, setupElapsedMs, checkpoint,
        peers: [...peers.values()].map(({ finish: _finish, active: _active, finishTimer: _timer, ...peer }) => peer),
        policy: { poolSize, workTimeoutMs, setupTimeoutMs, closeTimeoutMs, scoreTimeoutMs, checkpointAfterMs: checkpointAfterMs ?? null, maxFateOperationsPerPeer,
          verifiedCompletion,
          clock: 'new in-scope substrate operation, decay before execution, same-ID retry does not advance',
          tokenCounter: 'js-tiktoken@1.0.21/o200k_base', benchmark: project.benchmark, task: project.pins, problemSha256: project.problemSha256 },
        task: task!.snapshot(), substrate: substrate?.snapshot() ?? null,
      }),
      async createRuntime() {
        await limited(search('Fintype.card', setupSignal), setupSignal);
        return createRuntime({
          backend, outputDir: directory, services, maxAgents: poolSize, profiles: { peer: profile },
          modelAccessPolicy: {
            authorize(caller) {
              try { authorize(caller); return { phase: 'work', deadlineAt: deadlineMs }; } catch { return null; }
            },
            withCommit: commit => commit(),
          },
        });
      },
      async run(core: Awaited<ReturnType<typeof createRuntime>>) {
        runtimeId = core.id;
        substrate?.bindRuntime(runtimeId);
        try {
          for (let index = 0; index < poolSize; index++) {
            setupSignal.throwIfAborted();
            const agent = await limited(core.spawn({ requestId: `peer:${index}`, profile: 'peer', files: {
              'problem.lean': { data: project.formal, encoding: 'utf8' },
              'problem.txt': { data: `${project.informal}\n\nProblem resource: ${problemAddress}\n`, encoding: 'utf8' },
            } }), setupSignal);
            semanticRequests.set(agent.id, new Set());
            peers.set(agent.id, { agentId: agent.id, finish: new AbortController(), active: true, semanticOperations: 0 });
          }
          setupSignal.throwIfAborted();
        } catch (error) {
          setupElapsedMs = Math.round(performance.now() - preparationStarted);
          throw error;
        }
        setupElapsedMs = Math.round(performance.now() - preparationStarted);
        const openedAt = Date.now();
        startedAt = new Date(openedAt).toISOString();
        deadlineMs = openedAt + workTimeoutMs;
        timer = setTimeout(() => work.abort(), workTimeoutMs);
        let checkpointTimer: ReturnType<typeof setTimeout> | undefined;
        let checkpointWrite: Promise<void> | undefined;
        if (checkpointAfterMs !== undefined) {
          const scheduledMs = openedAt + checkpointAfterMs;
          const scheduledAt = new Date(scheduledMs).toISOString();
          const captureCheckpoint = () => {
            const activePeers = [...peers.values()];
            if (remainingMs() === 0 || !activePeers.some(peer => peer.active)) return;
            const capturedMs = Date.now();
            if (capturedMs < scheduledMs) {
              checkpointTimer = setTimeout(captureCheckpoint, scheduledMs - capturedMs);
              return;
            }
            const capturedAt = new Date(capturedMs).toISOString();
            const path = join(directory, 'fate-work-checkpoint.json');
            checkpointWrite = (async () => {
              try {
                const snapshot = task!.snapshot();
                await writePrivateJson(path, {
                  runId, runtimeId, mode, scheduledAt, capturedAt, benchmark: project.benchmark, problemId: project.pins.problemId,
                  peers: activePeers.map(({ agentId, active, startedAt, endedAt, finishRequested, semanticOperations }) =>
                    ({ agentId, active, startedAt, endedAt, finishRequested, semanticOperations })),
                  candidates: snapshot.candidates.map(({ agentId, requestId, sha256, submittedAt, refs }) => ({ agentId, requestId, sha256, submittedAt, refs })),
                  taskOperations: snapshot.operations, substrate: substrate?.snapshot() ?? null,
                });
                checkpoint = { state: 'recorded', afterMs: checkpointAfterMs, path, scheduledAt, capturedAt };
              } catch {
                checkpoint = { state: 'failed', afterMs: checkpointAfterMs, scheduledAt, capturedAt, code: 'FATE_CHECKPOINT_FAILED' };
              }
            })();
          };
          checkpointTimer = setTimeout(captureCheckpoint, Math.max(0, scheduledMs - Date.now()));
        }
        const initialInput = verifiedCompletion ? fateVerifiedInput(workTimeoutMs) : fateInput;
        const workDone = Promise.all([...peers.values()].map(async peer => {
          peer.startedAt = new Date().toISOString();
          if (verifiedCompletion) peer.continuations = 0;
          const signal = AbortSignal.any([workSignal, peer.finish.signal]);
          const completionState = () => ({
            remainingOperations: maxFateOperationsPerPeer - peer.semanticOperations,
            ...task!.completionStatus(peer.agentId),
          });
          function nextTurn() {
            if (peer.finishRequested) return 'submitted';
            if (externalSignal?.aborted) return 'cancelled';
            if (!remainingMs()) return 'deadline';
            const { remainingOperations, remainingChecks, hasPassingProof, checkPending } = completionState();
            if (!remainingOperations) return 'operation_limit';
            if (hasPassingProof || (remainingOperations >= 2 && remainingChecks > 0)) return 'continue';
            if (checkPending) return 'wait';
            return remainingOperations < 2 ? 'operation_limit' : 'check_limit';
          }
          const recheck = new Error('Continuation eligibility changed before send');
          let attempt = 0;
          function recordAccepted(inputId: string) {
            peer.inputId = inputId;
            if (attempt && peer.continuations !== undefined) peer.continuations++;
          }
          try {
            for (;; attempt++) {
              if (attempt) {
                const next = nextTurn();
                if (next === 'wait') {
                  await limited(task!.settleChecks(peer.agentId), signal);
                  continue;
                }
                if (next !== 'continue') {
                  peer.endReason = next;
                  break;
                }
              }
              const receipt = await runInput(core, peer.agentId, attempt ? fateVerificationContinuation : initialInput, {
                requestId: attempt ? `${peer.agentId}:continue:${attempt}` : `${peer.agentId}:problem`,
                timeoutMs: Math.max(1, remainingMs()), signal,
                beforeSend: attempt ? () => { if (nextTurn() !== 'continue') throw recheck; } : undefined,
              }).catch(error => {
                if (error === recheck) return null;
                throw error;
              });
              if (receipt) recordAccepted(receipt.inputId);
              if (!verifiedCompletion) {
                peer.endReason = peer.finishRequested ? 'submitted' : 'settled';
                break;
              }
            }
          } catch (error) {
            const detail = error as { code?: string; inputId?: string; receipt?: { status: string } };
            if (detail.inputId && detail.receipt?.status === 'accepted') recordAccepted(detail.inputId);
            peer.endReason = peer.finishRequested ? 'submitted' : externalSignal?.aborted ? 'cancelled' :
              !remainingMs() || detail.code === 'input_timeout' ? 'deadline' : 'failed';
            if (peer.endReason !== 'submitted') peer.inputFailure = {
              code: detail.code ?? 'PEER_WORK_FAILED', ...(detail.inputId ? { inputId: detail.inputId } : {}),
              ...(detail.receipt ? { receipt: detail.receipt } : {}),
            };
          } finally {
            peer.active = false;
            if (verifiedCompletion) {
              const { remainingOperations, remainingChecks, hasPassingProof } = completionState();
              peer.completionBudget = { remainingOperations, remainingChecks, hasPassingProof };
            }
            clearTimeout(peer.finishTimer);
            peer.endedAt = new Date().toISOString();
            try { peer.stop = await core.stop(peer.agentId, { timeoutMs: closeTimeoutMs }); }
            catch (error) { peer.stopFailure = (error as { code?: string }).code ?? 'PEER_STOP_FAILED'; }
          }
        }));
        try {
          await workDone;
        } finally {
          clearTimeout(checkpointTimer);
          await checkpointWrite;
        }
        return { peerIds: [...peers.keys()], workStartedAt: startedAt, workDeadlineAt: new Date(deadlineMs).toISOString() };
      },
    });
    work.abort();
    clearTimeout(timer);
    await task.settle();
    const byPeer = new Map(task.snapshot().candidates.map(candidate => [candidate.agentId, candidate]));
    const bundle: FrozenCandidates = {
      version: 1, runId, mode, benchmark: project.benchmark, problemId: project.pins.problemId, problemSha256: project.problemSha256,
      frozenAt: new Date().toISOString(), scoreTimeoutMs, peers: [...peers.keys()].map(agentId => ({ agentId, candidate: byPeer.get(agentId) ?? null })),
    };
    const bundlePath = join(directory, 'fate-frozen-candidates.json');
    await writePrivateJson(bundlePath, bundle);
    const coreReport = typeof report.cleanup?.reportPath === 'string' ? report.cleanup.reportPath :
      typeof report.reportPath === 'string' ? join(dirname(report.reportPath), 'runtime.json') : undefined;
    const evidence = await measureEvidence(coreReport, report.cleanup?.agents);
    let scoring;
    let scoreFailure = null;
    try {
      scoring = await evaluateFrozen(project, bundle);
      if (scoring.candidates.some(candidate => ['timeout', 'checker_error', 'aborted'].includes(candidate.status))) {
        scoreFailure = { code: 'FATE_SCORE_INCOMPLETE', message: 'A final candidate did not reach a trusted verdict' };
      }
    }
    catch (error) { scoreFailure = { code: 'FATE_SCORE_FAILED', message: (error as Error).message }; }
    const final = { ...report, bundlePath, evidence, scoring: scoring ?? null, scoreFailure, setupFailed: startedAt === null };
    await writePrivateJson(join(directory, 'fate-result.json'), final);
    return final;
  } finally {
    work.abort();
    clearTimeout(timer);
    await task?.settle();
    task?.close();
    substrate?.close();
    await checker.close();
  }
}

import { createRuntime } from '@swarmenv/core';
import { join } from 'node:path';
import { createSubstrateService } from './substrate.js';
import { runInput } from '../shared/run-input.js';
import { createInputAdmission } from '../shared/input-admission.js';
import { runWithReport } from '../shared/run-report.js';

export const peerPrompt = 'Work as one peer in a fixed pool. Search and visit shared substrate contributions before adopting them. Publish complete content with stable references through swarm substrate publish --input contribution.json --request-id <fresh-id>. Read the Service schema with swarm service view substrate. Preserve useful private work between turns. You cannot spawn peers. Shared content is immutable; publication is not a proof of correctness.';
export const cyclePrompt = 'Search relevant shared content, visit the originals, perform useful work, and publish a self-contained contribution with references to the content actually adopted. Keep evidence in your private work directory.';
const fail = (code: any) => Object.assign(new Error(code), { code });
const finite = (value: any) => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;

function waitFor(promise: any, signal: any) {
  let abort: any;
  return Promise.race([promise, new Promise<any>((_: any, reject: any) => {
    abort = () => reject(fail('SCALEMAS_WORK_ABORTED'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  })]).finally(() => signal.removeEventListener('abort', abort));
}

export function scaleMASPeerProfile({ image, model = 'default' }: any) {
  return { image, model, prompt: peerPrompt, writable: true, services: { substrate: ['publish', 'search', 'visit'] },
    collect: { paths: ['.'], includeGit: false, maxBytes: 2 * 1024 ** 2, required: true } };
}

/** Fixed no-Task pool. Environment owns content and drivers; Core owns all Bots. */
export async function runScaleMAS({ backend, runId, image, outputDir, question, model = 'default', poolSize = 3, maxRounds = 2,
  workTimeoutMs = 120_000, turnTimeoutMs = 30_000, closeTimeoutMs = 30_000, beforeCycle, onReady, onCycle, onPeerStop, questionForCycle, maxConcurrentInputs }: any, signal: any) {
  if (typeof outputDir !== 'string' || !outputDir || typeof question !== 'string' || !question.trim() || Buffer.byteLength(question) > 8192 ||
      typeof image !== 'string' || !image || !Number.isSafeInteger(maxRounds) || maxRounds < 2 || maxRounds > 32 ||
      ![workTimeoutMs, turnTimeoutMs, closeTimeoutMs].every(finite) || (signal !== undefined && !(signal instanceof AbortSignal)) ||
      (maxConcurrentInputs !== undefined && (!Number.isSafeInteger(maxConcurrentInputs) || maxConcurrentInputs < 1 || maxConcurrentInputs > poolSize)) ||
      [beforeCycle, onReady, onCycle, onPeerStop, questionForCycle].some((hook: any) => hook !== undefined && typeof hook !== 'function')) throw new TypeError('scaleMAS requires a question, image, output directory, two to 32 rounds, finite waits and an optional trusted host lifecycle functions');
  const substrate = createSubstrateService({ databasePath: join(outputDir, 'substrate.sqlite'), runId, poolSize });
  const peers: any[] = [], events: any[] = [];
  const controller: any = new AbortController();
  const workSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const admission = maxConcurrentInputs === undefined ? undefined : createInputAdmission({ maxConcurrent: maxConcurrentInputs, maxPending: poolSize, signal: workSignal });
  const deadlineAt = Date.now() + workTimeoutMs;
  const timer = setTimeout(() => controller.abort(), workTimeoutMs);
  let runtime: any; let workClosed = false;
  const remaining = () => {
    workSignal.throwIfAborted();
    const value = deadlineAt - Date.now();
    if (value <= 0 || workClosed) throw fail('SCALEMAS_WORK_ABORTED');
    return value;
  };
  const abort = () => { if (runtime) void runtime.close({ timeoutMs: 1 }).catch(() => {}); };
  workSignal.addEventListener('abort', abort, { once: true });
  try {
    return await runWithReport({ outputDir, closeTimeoutMs,
      redact: (report: any) => ({ ...report, peers, events, substrate: substrate.snapshot(), databasePath: join(outputDir, 'substrate.sqlite'),
        policy: { poolSize, maxRounds, workTimeoutMs, turnTimeoutMs, closeTimeoutMs, replacement: false,
          ranking: 'token occurrences descending, incoming references descending, stable address ascending', maxSearchResults: 8 } }),
      createRuntime: async () => {
        remaining();
        runtime = await createRuntime({ backend, outputDir, services: substrate.services, maxBots: poolSize, profiles: {
          peer: scaleMASPeerProfile({ image, model }),
        } });
        return runtime;
      },
      async run(core: any) {
        substrate.bindRuntime(core.id);
        const unsubscribe = core.onEvent((event: any) => events.push({ botId: event.botId, seq: event.seq, type: event.type, ...(event.outcome ? { outcome: event.outcome } : {}) }));
        try {
          for (let index = 0; index < poolSize; index++) {
            remaining();
            const bot = await waitFor(core.spawn({ requestId: `peer:${index}`, profile: 'peer', files: {
              'question.txt': { data: question, encoding: 'utf8' },
            } }), workSignal);
            remaining(); substrate.bindPeer(bot.id);
            peers.push({ index, botId: bot.id, turns: [], failure: null, stop: null });
          }
          if (onReady) await waitFor(Promise.resolve().then(() => onReady({ runtime:core, peerIds:peers.map((peer: any)=>peer.botId), snapshot:substrate.snapshot() })),workSignal);
          remaining();
          await Promise.all(peers.map(async (peer: any) => {
            try {
              for (let round = 0; round < maxRounds; round++) {
                if (beforeCycle) {
                  remaining();
                  await waitFor(Promise.resolve().then(() => beforeCycle({ peerIndex: peer.index, botId: peer.botId, round, signal: workSignal })), workSignal);
                  remaining();
                }
                const cycleQuestion = questionForCycle ? await waitFor(Promise.resolve().then(() =>
                  questionForCycle({ peerIndex: peer.index, botId: peer.botId, round, signal: workSignal })), workSignal) : question;
                if (typeof cycleQuestion !== 'string' || !cycleQuestion.trim() || Buffer.byteLength(cycleQuestion) > 8192) throw fail('SCALEMAS_QUESTION_INVALID');
                const requestId = `${peer.botId}:cycle:${round}`;
                const turn: any = { requestId, round, attempts: [] }; peer.turns.push(turn);
                // Correction is an explicit new input after a completed turn,
                // sharing the original monotonic turn deadline rather than
                // granting another turn budget. Unknown inputs never enter it.
                let turnDeadline: any;
                let correction: any, attempt = 0;
                while (true) {
                  if (turnDeadline !== undefined && turnDeadline - performance.now() < 1) throw fail('SCALEMAS_CORRECTION_WINDOW_CLOSED');
                  const currentRequestId = attempt ? `${requestId}:correction:${attempt}` : requestId;
                  const beforeSnapshot = substrate.snapshot();
                  const text = `scaleMAS peer=${peer.index} cycle=${round}\n${cycleQuestion}\n${cyclePrompt}` +
                    (attempt ? `\nCORRECTION_ATTEMPT_${attempt}: ${correction}` : '');
                  const sendInput = () => {
                    turnDeadline ??= performance.now() + Math.min(turnTimeoutMs, remaining());
                    const left = Math.floor(turnDeadline - performance.now());
                    if(left < 1) throw fail('SCALEMAS_CORRECTION_WINDOW_CLOSED');
                    return runInput(core, peer.botId, text,
                      { requestId: currentRequestId, timeoutMs: Math.min(left, remaining()), signal: workSignal });
                  };
                  const receipt = await (admission ? admission.run(sendInput) : sendInput());
                  const observed: any = { requestId: currentRequestId, inputId: receipt.inputId,
                    outcome: receipt.settled.outcome, seq: receipt.settled.seq, attempt };
                  turn.attempts.push(observed); Object.assign(turn, { inputId: observed.inputId, outcome: observed.outcome, seq: observed.seq });
                  const decision = onCycle ? await waitFor(Promise.resolve().then(() => onCycle({ peerIndex: peer.index,
                    botId: peer.botId, round, attempt, requestId: currentRequestId, result: receipt, beforeSnapshot, snapshot: substrate.snapshot(), signal: workSignal, deadlineAtMs: turnDeadline })), workSignal) : undefined;
                  if (decision?.correction === undefined) break;
                  if (typeof decision.correction !== 'string' || !decision.correction.trim() || Buffer.byteLength(decision.correction) > 4096 ||
                      !finite(decision.timeoutMs)) throw fail('SCALEMAS_CORRECTION_INVALID');
                  observed.rejected = structuredClone(decision.rejected);
                  correction = decision.correction;
                  turnDeadline = Math.min(turnDeadline, performance.now() + decision.timeoutMs);
                  attempt++;
                }
              }
            } catch (error: any) {
              peer.failure = { code: error.code ?? 'PEER_WORK_FAILED', ...(error.requestId ? { requestId: error.requestId } : {}),
                ...(error.inputId ? { inputId: error.inputId } : {}), ...(error.receipt ? { receipt: error.receipt } : {}) };
            } finally {
              substrate.retirePeer(peer.botId);
              try { peer.stop = await core.stop(peer.botId, { timeoutMs: Math.max(1, Math.min(closeTimeoutMs, deadlineAt - Date.now())) }); }
              catch (error: any) { peer.stopFailure = { code: error.code ?? 'PEER_STOP_FAILED', cleanup: 'pending' }; }
              if(onPeerStop && peer.stop) {
                try { await waitFor(Promise.resolve().then(()=>onPeerStop({peerIndex:peer.index,botId:peer.botId,receipt:structuredClone(peer.stop),snapshot:substrate.snapshot()})),workSignal); }
                catch(error: any) { peer.failure ??= {code:error.code ?? 'HOST_STOP_OBSERVATION_FAILED'}; }
              }
            }
          }));
          if (workSignal.aborted || Date.now() >= deadlineAt) throw fail('SCALEMAS_WORK_ABORTED');
          if (peers.some((peer: any) => peer.failure)) throw fail('SCALEMAS_PEERS_FAILED');
          return { peerIds: peers.map((peer: any) => peer.botId), completedRounds: peers.map((peer: any) => peer.turns.length) };
        } finally { workClosed = true; clearTimeout(timer); unsubscribe(); }
      },
    });
  } finally {
    admission?.close(); clearTimeout(timer); workSignal.removeEventListener('abort', abort); substrate.close();
  }
}

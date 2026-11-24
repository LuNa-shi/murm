import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createFlatAffirmativeEnvironment } from './flat.js';
import { createHourWindow, HOUR_MS, WINDOW_MS } from '../shared/hour-window.js';
import { checkHourLifetime } from './policy.js';
import { runInput } from '../shared/run-input.js';
import { runWithReport } from '../shared/run-report.js';
const fail = code => Object.assign(new Error(code), { code });
export const FLAT_STAGED_PROMPT = 'Use actual Flat Task Services to read and exclusively take one ready Task. Preserve this Task and Execution. After take, return briefly and wait for explicit host programming groups; do not finish until the host asks. Each group requires implementing/running the supplied program, inspecting and checking the public fixed candidate, publishing its new checked main revision and a new truthful Material, and linking evidence to your Task. Keep all program/stdout files until required export. Host-provided candidates are not your authored programs. Private workspace save/status/diff are unavailable.';

/** Actual four-slot host composition. Time-only owner/lifetime are caller-owned
 * trusted ports. Test clock injection permanently produces controlled evidence. */
export async function runFlatNaturalHour({ options, workload, admit, quota, modelGate, budgets, signal, clock, waitForMs, onReady }) {
  if (!options || !Array.isArray(options.candidates) || options.candidates.length !== 5 || options.candidates.some(candidate=>candidate.laterFiles?.length!==3) || typeof workload?.input !== 'function' || typeof workload?.verify !== 'function' || typeof admit !== 'function' ||
      typeof quota?.close !== 'function' || typeof quota?.receipt !== 'function' || typeof modelGate?.check !== 'function' ||
      !budgets || !['setupMs', 'workMs', 'turnMs', 'cleanupMs', 'recoveryMs', 'marginMs'].every(key => Number.isSafeInteger(budgets[key]) && budgets[key] >= (key === 'recoveryMs' ? 0 : 1)) ||
      budgets.workMs < HOUR_MS + budgets.turnMs || (clock !== undefined && typeof clock !== 'function') ||
      (waitForMs !== undefined && typeof waitForMs !== 'function') || (onReady !== undefined && typeof onReady !== 'function')) throw fail('FLAT_HOUR_PORT_INVALID');
  if (quota.receipt()?.profile !== 'time_only') throw fail('FLAT_HOUR_TIME_ONLY_REQUIRED');
  const life = new AbortController(), combined = signal ? AbortSignal.any([signal, life.signal]) : life.signal;
  const now = clock ?? (() => performance.now());
  let owned, monitor, original, lifetime, publisher, replacement, unsubscribe, timer, ended = false, fatal = false;
  const settled = new Map(), planned = new Set(), latest = new Map();
  const result = {}, proofs = [], admissions = [];
  timer = setTimeout(() => life.abort(), budgets.setupMs);
  const health = async () => {
    combined.throwIfAborted(); modelGate.check();
    if (fatal || owned.controller.snapshot().failures.length || owned.controller.snapshot().inputs.some(row => ['unknown', 'rejected'].includes(row.status))) throw fail('FLAT_HOUR_INPUT_FAILED');
    for (const id of [...(original ?? []).filter(id => !planned.has(id)), ...(replacement && !planned.has(replacement) ? [replacement] : [])]) {
      if (!['idle', 'running'].includes((await owned.runtime.get(id)).status)) throw fail('HOUR_PEER_UNAVAILABLE');
    }
  };
  const until = async condition => {
    while (!await condition()) { await health(); await delay(20, undefined, { signal: combined }); }
    await health();
  };
  const pauseUntil = async target => {
    while (monitor.elapsed() < target) {
      await health(); const ms = Math.min(30_000, target - monitor.elapsed());
      await (waitForMs ? waitForMs(ms, combined) : delay(ms, undefined, { signal: combined }));
    }
    await health();
  };
  const admission = async ({ runtime, botIds, signal: admissionSignal }) => {
    const workMs = monitor ? Math.max(1, Math.ceil(HOUR_MS - monitor.elapsed())) : budgets.workMs;
    const receipt = await admit({ runtime, outputDir: options.outputDir, botIds, workMs, cleanupMs: budgets.cleanupMs,
      recoveryMs: budgets.recoveryMs, marginMs: budgets.marginMs, signal: AbortSignal.any([combined, admissionSignal]) });
    checkHourLifetime(receipt, { runtimeId: runtime.id, botIds, workMs, now: now(), controlled: clock !== undefined });
    admissions.push(structuredClone(receipt));
    if (!original) { original = [...botIds]; lifetime = receipt; await onReady?.({ runtime, botIds: [...botIds] }); }
  };
  const binding = id => {
    const bot = owned.tasks.getBot(id), execution = bot?.execution_id && owned.tasks.getExecution(bot.execution_id);
    if (bot?.state !== 'ACTIVE' || execution?.state !== 'RUNNING') throw fail('FLAT_HOUR_BINDING_CHANGED');
    const candidate = owned.candidates.find(row => row.taskId === execution.task_id);
    if (!candidate) throw fail('FLAT_HOUR_TASK_CHANGED');
    return { execution, candidate };
  };
  const group = async (botId, peer, phase, adopted) => {
    const { execution, candidate } = binding(botId);
    const proofKey = `flat-hour-${randomUUID()}`;
    const input = workload.input({ peer, phase, proofKey, candidate: {...candidate,revision:candidate.stages[phase].revision}, adopted });
    const receipt = await runInput(owned.runtime, botId, input, { requestId: `flat-group-${peer}-${phase}`, timeoutMs: budgets.turnMs, signal: combined });
    const proof = await workload.verify({ owned, botId, peer, phase, proofKey, adopted });
    if (owned.tasks.getBot(botId).execution_id !== execution.execution_id) throw fail('FLAT_HOUR_BINDING_CHANGED');
    proofs.push({ botId, peer, phase, materialId: proof.reference, ...proof }); latest.set(botId, { materialId: proof.reference, ...proof });
    return { receipt, proof };
  };
  const finish = async botId => {
    const current = latest.get(botId), { execution } = binding(botId);
    planned.add(botId);
    // Finish may retire the Worker before its transport reply; only the durable
    // accepted finish plus confirmed stop/cleanup can explain that lost reply.
    await owned.controller.feedback({ taskId: execution.task_id, input: `Finish your actual Task now with outcome done, workspace_revision ${current.revision} and material_ids [${JSON.stringify(current.materialId)}]. Use the existing linked experience Material and a stable request ID.`, requestId: `flat-finish-${botId}`, mode: 'followUp' });
    await until(() => owned.tasks.getTask(execution.task_id).state === 'DONE' && owned.tasks.getBot(botId).state === 'CLOSED');
  };
  let report, closeFailure;
  try {
    modelGate.check();
    report = await runWithReport({ outputDir: options.outputDir, closeTimeoutMs: budgets.cleanupMs,
      async createRuntime() {
        owned = await createFlatAffirmativeEnvironment({ ...options, deadlineAt: Date.now() + budgets.setupMs + budgets.workMs,
          prompt: FLAT_STAGED_PROMPT, signal: combined, collect: {paths:['.'],includeGit:false,maxBytes:16*1024**2,...options.collect,required:true}, controller: { ...options.controller,
            selectionMs: budgets.setupMs, hardBudgetMs: budgets.setupMs + budgets.workMs, stallMs: budgets.setupMs + budgets.workMs,
            automaticContinuation: false, refillWhenNoReadyTask: false, beforeInitialDispatch: admission } });
        unsubscribe = owned.runtime.onEvent(event => {
          if (event.type === 'settled') settled.set(event.botId, event);
          if (!ended && !planned.has(event.botId) && (event.type === 'exit' || event.type === 'error' && event.fatal)) { fatal = true; life.abort(); }
        });
        return owned;
      },
      async run() {
        await owned.start();
        await until(async () => (await Promise.all(original.map(id => owned.runtime.get(id)))).every(row => row.status === 'idle') &&
          original.every(id => owned.tasks.getBot(id)?.state === 'ACTIVE' && settled.get(id)?.outcome === 'completed'));
        monitor = createHourWindow({ runtimeId: owned.id, mode: 'flat', botIds: original, clock });
        for (const id of original) {
          const input = owned.controller.snapshot().inputs.find(row => row.botId === id && row.source === 'discovery');
          const { execution } = binding(id);
          monitor.baseline(id, { inputId: input.receipt.inputId, receipt: input.receipt, settled: settled.get(id) },
            { reference: execution.execution_id, sha256: execution.input_snapshot_hash });
        }
        lifetime = await admit({ runtime: owned.runtime, outputDir: options.outputDir, botIds: original, workMs: budgets.workMs,
          cleanupMs: budgets.cleanupMs, recoveryMs: budgets.recoveryMs, marginMs: budgets.marginMs, signal: combined });
        checkHourLifetime(lifetime, { runtimeId: owned.id, botIds: original, workMs: budgets.workMs, now: now(), controlled: clock !== undefined });
        admissions.push(structuredClone(lifetime));
        monitor.open(); clearTimeout(timer); timer = setTimeout(() => life.abort(), budgets.workMs);
        for (let phase = 0; phase < 4; phase++) {
          await pauseUntil(phase * WINDOW_MS);
          await Promise.all(original.map(async (id, peer) => {
            const { receipt, proof } = await group(id, peer, phase);
            if (monitor.elapsed() >= (phase + 1) * WINDOW_MS) throw fail('FLAT_HOUR_GROUP_LATE');
            monitor.progress(id, receipt, proof);
          }));
        }
        publisher = original[0]; const published = latest.get(publisher);
        await finish(publisher);
        await until(() => { replacement = owned.controller.snapshot().bots.find(row => !original.includes(row.botId) && !row.released)?.botId;
          return replacement && owned.tasks.getBot(replacement)?.state === 'ACTIVE' && settled.get(replacement)?.outcome === 'completed'; });
        const adopted = { botId: publisher, materialId: published.materialId, revision: published.revision, materialHash: published.materialHash };
        const handoff = await group(replacement, 4, 3, adopted);
        monitor.handoff({ kind: 'flat-stopped-owner-public-adoption', reference: handoff.proof.reference, sha256: handoff.proof.sha256 });
        await pauseUntil(HOUR_MS); await health(); monitor.end(); ended = true;
        await Promise.all([...original.slice(1), replacement].map(finish));
        Object.assign(result, { proofs, publisher, replacement, lifetime, admissions, source: 'host-preseeded-public-revisions', liveCapture: false });
        return result;
      },
      async afterClose(cleanup) {
        await quota.close();
        if (ended) {
          if (cleanup.cleanup !== 'complete' || cleanup.bots.some(row => row.execution !== 'stopped' || row.cleanup !== 'complete' || clock===undefined && (!Array.isArray(row.artifacts) || row.artifacts.length!==2))) throw fail('HOUR_CLEANUP_PENDING');
          // Window membership is the original team; full Core cleanup remains
          // in the outer report and includes every actual replacement identity.
          Object.assign(result, monitor.finish({ ...cleanup, bots: cleanup.bots.filter(row => original.includes(row.botId)) }), { model: modelGate.check({ final: true }) });
        }
      },
    });
  } finally {
    clearTimeout(timer); unsubscribe?.(); life.abort();
    try { await quota.close(); } catch { closeFailure = { code: 'FLAT_HOUR_MODEL_CLOSE_UNKNOWN' }; }
  }
  return { ...report, mode: 'flat', accepted: false, ...(closeFailure ? { cleanupFailure: closeFailure } : {}), quota: quota.receipt() };
}

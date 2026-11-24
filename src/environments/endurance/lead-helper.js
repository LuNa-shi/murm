import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createLeadHelperEnvironment } from '../lead-helper/index.js';
import { runWithReport } from '../shared/run-report.js';
import { createHourWindow, HOUR_MS } from '../shared/hour-window.js';
import { validateHourBudgets, createHourQuotaGate, checkHourLifetime } from './policy.js';
const fail = code => Object.assign(new Error(code), { code });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const releases = Object.freeze([0, 900_000, 1_800_000, 3_300_000]);

/** Four business groups retain twelve deliveries. Readiness is setup evidence,
 * never an extra delivery group or a substitute for an effective work window. */
export async function runLeadHelperHour({ options, workload, admit, quota, budgets, signal, clock, waitForMs, onReady }) {
  if (!Array.isArray(workload?.stages) || workload.stages.length !== 4 || typeof workload.verify !== 'function' ||
      typeof admit !== 'function' || typeof quota?.receipt !== 'function' || typeof quota?.close !== 'function' ||
      (onReady !== undefined && typeof onReady !== 'function') ||
      (clock !== undefined && typeof clock !== 'function') || (waitForMs !== undefined && typeof waitForMs !== 'function')) throw fail('HOUR_PREFLIGHT_GATE_MISSING');
  const stages = structuredClone(workload.stages);
  const paths = new Set();
  for (const [stage, input] of stages.entries()) {
    const text = stage ? input?.supplement : input?.goal;
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 8192 || !input.paths ||
        Object.keys(input.paths).length !== 3 || ['helper1', 'helper2', 'helper3'].some(role => !Object.hasOwn(input.paths, role) ||
          typeof input.paths[role] !== 'string' || input.paths[role].length > 200 || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.[A-Za-z0-9]+$/.test(input.paths[role]))) throw fail('HOUR_STAGE_PLAN_INVALID');
    for (const path of Object.values(input.paths)) { if (paths.has(path)) throw fail('HOUR_STAGE_PLAN_INVALID'); paths.add(path); }
  }
  budgets = validateHourBudgets(budgets);
  const checkQuota = createHourQuotaGate(quota, budgets);
  const life = new AbortController();
  const combined = signal ? AbortSignal.any([life.signal, signal]) : life.signal;
  const timer = setTimeout(() => life.abort(), budgets.setupMs);
  let environment, monitor, botIds, lifetime, quotaFailure;
  const receipts = [];
  const admission = async () => checkHourLifetime(await admit({ runtime: environment, outputDir: options.outputDir, botIds,
    workMs: budgets.workMs, cleanupMs: budgets.cleanupMs, recoveryMs: budgets.recoveryMs, marginMs: budgets.marginMs, signal: combined }),
  { runtimeId: environment.id, botIds, workMs: budgets.workMs, now: clock ? clock() : performance.now(), controlled: clock !== undefined });
  const health = async () => {
    combined.throwIfAborted(); checkQuota();
    for (const botId of botIds) if (!['idle', 'running'].includes((await environment.get(botId)).status)) throw fail('HOUR_PEER_UNAVAILABLE');
  };
  const pauseUntil = async target => {
    while (monitor.elapsed() < target) {
      await health();
      const ms = Math.min(30_000, target - monitor.elapsed());
      await (waitForMs ? waitForMs(ms, combined) : delay(ms, undefined, { signal: combined }));
    }
    await health();
  };
  const verifyStage = async receipt => {
    const controller = new AbortController();
    const verificationSignal = AbortSignal.any([combined, controller.signal]);
    let timer, abort;
    try {
      const stopped = new Promise((_, reject) => {
        abort = () => reject(fail('HOUR_STAGE_VERIFICATION_UNKNOWN'));
        verificationSignal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => controller.abort(), Math.min(5000, budgets.turnMs));
        if (verificationSignal.aborted) abort();
      });
      return await Promise.race([Promise.resolve().then(() => workload.verify(receipt, { environment: environment.snapshot(), signal: verificationSignal })), stopped]);
    } finally { clearTimeout(timer); verificationSignal.removeEventListener('abort', abort); controller.abort(); }
  };
  let report;
  try {
    checkQuota();
    report = await runWithReport({ outputDir: options.outputDir, closeTimeoutMs: budgets.cleanupMs,
      redact: value => environment ? environment.redact(value) : value,
      async createRuntime() {
        environment = await createLeadHelperEnvironment({ ...options, helperCount: 3, signal: combined,
          exportLimit: Math.min(options.exportLimit ?? 16 * 1024 ** 2, 16 * 1024 ** 2),
          turnTimeoutMs: budgets.turnMs, workTimeoutMs: Math.min(120_000, budgets.workMs), closeTimeoutMs: Math.min(60_000, budgets.cleanupMs) });
        const team = environment.snapshot().team;
        botIds = ['lead', 'helper1', 'helper2', 'helper3'].map(role => team[role]);
        monitor = createHourWindow({ runtimeId: environment.id, mode: 'lead-helper', botIds, clock });
        // No owned handle may be lost if admission or a trusted observer fails.
        return { id: environment.id, close: options => environment.close(options) };
      },
      async run() {
        await admission(); await onReady?.(environment);
        const prepared = await environment.prepareStages({ signal: combined });
        for (const input of prepared.inputs) {
          const note = prepared.notes.find(row => row.actor === input.botId);
          if (!note) throw fail('HOUR_BASELINE_INVALID');
          monitor.baseline(input.botId, input, { reference: `board-note:${note.seq}`, sha256: hash(note) });
        }
        await health(); lifetime = await admission(); monitor.open(); clearTimeout(timer);
        for (let stage = 0; stage < 4; stage++) {
          await pauseUntil(releases[stage]);
          if (monitor.elapsed() >= (stage + 1) * 900_000) throw fail('HOUR_STAGE_LATE');
          const receipt = await environment.runStage({ ...stages[stage], signal: combined });
          if (await verifyStage(receipt) !== true) throw fail('HOUR_BUSINESS_UNCONFIRMED');
          await health();
          if (monitor.elapsed() >= (stage + 1) * 900_000) throw fail('HOUR_STAGE_LATE');
          for (const input of receipt.inputs) {
            const task = receipt.deliveries.find(row => row.owner === input.botId);
            monitor.progress(input.botId, input, task ? { reference: `${task.delivery.commit}:${task.path}`, sha256: task.delivery.sha256 }
              : { reference: `board-direction:${receipt.direction.seq}`, sha256: hash(receipt.direction) });
          }
          receipts.push(receipt);
          if (stage === 3) {
            if (receipt.pinnedDeliveries?.length !== 12) throw fail('HOUR_HANDOFF_MISSING');
            monitor.handoff({ kind: 'lead-feedback-twelve-fixed-deliveries', reference: `board:${receipt.boardRevision}`, sha256: hash(receipt.pinnedDeliveries) });
          }
        }
        await pauseUntil(HOUR_MS); monitor.end();
        return { stages: receipts };
      },
    });
  } finally {
    clearTimeout(timer); life.abort();
    try { await quota.close(); } catch { quotaFailure = { code: 'HOUR_QUOTA_CLOSE_UNKNOWN' }; }
  }
  let result, businessFailure = report.businessFailure ?? report.cleanupFailure ?? report.reportSaveFailure ?? quotaFailure ?? null;
  if (!businessFailure) try { result = { ...monitor.finish(report.cleanup), lifetime, quota: checkQuota({ final: true }), stages: receipts }; }
  catch (error) { businessFailure = { code: error.code ?? 'HOUR_EVIDENCE_FAILED' }; }
  return { mode: 'lead-helper', runtimeId: environment?.id ?? report.runtimeId, accepted: false, result, businessFailure,
    cleanup: report.cleanup, reportSaveFailure: report.reportSaveFailure };
}

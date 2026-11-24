import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const object = (value: any) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nullableObject = (value: any) => value === null || object(value);
const validBots = (bots: any) => bots === undefined || (Array.isArray(bots) && bots.every((bot: any) => object(bot) && typeof bot.botId === 'string' &&
  ['stopped', 'unknown'].includes(bot.execution) && ['complete', 'pending'].includes(bot.cleanup) &&
  (bot.artifacts === undefined || (Array.isArray(bot.artifacts) && bot.artifacts.every((path: any) => typeof path === 'string')))));
const validPending = (pending: any) => pending === undefined || (Array.isArray(pending) && pending.every(object));
const validReceipt = (value: any) => object(value) && ['complete', 'pending'].includes(value.cleanup) && validBots(value.bots) &&
  validPending(value.pending) &&
  (value.cleanup !== 'complete' || ((value.bots ?? []).every((bot: any) => bot.execution === 'stopped' && bot.cleanup === 'complete') && !value.pending?.length));
const validEnvironment = (value: any) => ['result', 'businessFailure', 'cleanup', 'cleanupFailure', 'reportSaveFailure'].every((key: any) => Object.hasOwn(value, key)) &&
  ['businessFailure', 'cleanupFailure', 'reportSaveFailure'].every((key: any) => nullableObject(value[key])) &&
  (value.cleanup === null || validReceipt(value.cleanup));
const validCore = (value: any) => ['starting', 'open', 'closing', 'closed', 'initialization-failed'].includes(value.status) &&
  (value.cleanup === undefined ? validBots(value.bots) && validPending(value.pending) : validReceipt(value));
const code = (failure: any) => typeof failure?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(failure.code) ? failure.code : 'UNSPECIFIED_FAILURE';

async function reportAt(path: any, runtimeId: any, validate: any) {
  let value: any;
  try { value = JSON.parse(await readFile(path, 'utf8')); }
  catch (error: any) { return { path, state: error.code === 'ENOENT' ? 'missing' : error instanceof SyntaxError ? 'invalid' : 'unreadable' }; }
  if (!object(value) || !validate(value)) return { path, state: 'invalid' };
  if (value.runtimeId !== runtimeId) return { path, state: 'identity-mismatch' };
  return { path, state: 'read', value };
}

/** Project only the cleanup state and identifiers needed at the terminal. */
export function summarizeCleanupReceipt(receipt: any) {
  const pending = Array.isArray(receipt?.pending) ? receipt.pending.map((item: any) => ({
    ...Object.fromEntries(['kind', 'id', 'botId', 'action'].filter((key: any) => typeof item?.[key] === 'string').map((key: any) => [key, item[key]])),
    ...(object(item?.error) ? { errorCode: code(item.error) } : {}),
  })) : null;
  return { cleanup: ['complete', 'pending'].includes(receipt?.cleanup) ? receipt.cleanup : 'unknown',
    bots: Array.isArray(receipt?.bots) ? receipt.bots.map((bot: any) => ({ botId: bot.botId, execution: bot.execution, cleanup: bot.cleanup })) : null,
    pendingCount: pending?.length ?? null,
    pending,
  };
}

/** Read saved receipts only. This does not connect to a Runtime or decide business acceptance. */
export async function readEnvironmentResult({ runDirectory, runtimeId }: any = {}) {
  if (typeof runDirectory !== 'string' || !runDirectory.trim() || typeof runtimeId !== 'string' ||
      !/^[A-Za-z0-9_:-][A-Za-z0-9_.:-]{0,127}$/.test(runtimeId)) {
    throw Object.assign(new TypeError('Supply a run directory and expected Runtime ID'), { code: 'INVALID_RESULT_ARGUMENTS' });
  }
  const directory = resolve(runDirectory);
  const [environmentFile, coreFile] = await Promise.all([
    reportAt(join(directory, 'environment-report.json'), runtimeId, validEnvironment),
    reportAt(join(directory, 'runtime.json'), runtimeId, validCore),
  ]);
  const environment: any = { path: environmentFile.path, state: environmentFile.state, business: 'unknown', acceptance: 'not-interpreted', cleanup: 'unknown' };
  const core: any = { path: coreFile.path, state: coreFile.state, cleanup: 'unknown' };
  if (environmentFile.value) {
    const value = environmentFile.value;
    Object.assign(environment, {
      business: value.businessFailure ? 'failed' : 'returned', acceptance: 'not-interpreted',
      resultLocation: { path: environmentFile.path, field: 'result' },
      ...summarizeCleanupReceipt(value.cleanup),
      ...(value.businessFailure ? { businessFailureCode: code(value.businessFailure) } : {}),
      ...(value.cleanupFailure ? { cleanupFailureCode: code(value.cleanupFailure) } : {}),
      ...(value.reportSaveFailure ? { reportSaveFailureCode: code(value.reportSaveFailure) } : {}),
    });
  }
  if (coreFile.value) {
    const value = coreFile.value;
    Object.assign(core, { recordedStatus: value.status, ...summarizeCleanupReceipt(value) });
  }
  const artifacts: any[] = [];
  for (const source of [environmentFile.value?.cleanup, coreFile.value]) {
    for (const bot of Array.isArray(source?.bots) ? source.bots : []) {
      for (const path of Array.isArray(bot.artifacts) ? bot.artifacts : []) {
        if (typeof path !== 'string' || !path || artifacts.some((row: any) => row.path === path)) continue;
        let availability: any;
        try { const info = await stat(path); availability = info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other'; }
        catch (error: any) { availability = error.code === 'ENOENT' ? 'missing' : 'unreadable'; }
        artifacts.push({ botId: bot.botId, path, availability });
      }
    }
  }
  return { runtimeId, runDirectory: directory, liveStatus: 'not-observed', environment, core, artifacts };
}

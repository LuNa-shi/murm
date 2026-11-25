import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

function describe(error: any) {
  const result: any = { message: typeof error?.message === 'string' ? error.message : typeof error === 'string' ? error : 'Harness operation failed' };
  for (const key of ['code', 'operation', 'runtimeId', 'botId', 'requestId', 'inputId', 'cleanup', 'reportPath', 'details', 'event', 'receipt']) {
    if (error?.[key] !== undefined) result[key] = error[key];
  }
  return result;
}

/** Harness owns input ordering, business deadlines and external Services.
 * This helper preserves independent failures and bounds only its close wait.
 * redact must scrub any configured secrets from intentional report content. */
export async function runWithReport({ createRuntime, run, afterClose, outputDir, closeTimeoutMs = 60_000, redact = (value: any) => value }: any) {
  if (typeof createRuntime !== 'function' || typeof run !== 'function' || typeof redact !== 'function' ||
      (afterClose !== undefined && typeof afterClose !== 'function') ||
      typeof outputDir !== 'string' || !outputDir || !Number.isSafeInteger(closeTimeoutMs) || closeTimeoutMs < 1 || closeTimeoutMs > 2147483647) {
    throw new TypeError('Host reporting requires factory, business function, output directory and a finite close wait');
  }
  let runtime: any;
  const report: any = { closeTimeoutMs, result: null, businessFailure: null, cleanup: null, cleanupFailure: null, reportSaveFailure: null };
  try {
    runtime = await createRuntime();
    report.result = (await run(runtime)) ?? null;
  } catch (error: any) {
    report.businessFailure = describe(error);
    if (!runtime && error?.cleanup === 'pending') report.cleanupFailure = {
      code: 'FACTORY_CLEANUP_PENDING', message: 'Runtime factory cleanup remains pending',
      ...(error?.reportPath ? { reportPath: error.reportPath } : {}),
    };
  } finally {
    if (runtime) {
      let timer: any;
      try {
        const expired = new Promise<any>((_: any, reject: any) => {
          timer = setTimeout(() => reject(Object.assign(new Error(report.cleanup
            ? 'Host close wait ended during domain reconciliation'
            : 'Host close wait ended. Runtime cleanup is still unknown'), { code: 'CLOSE_WAIT_TIMEOUT' })), closeTimeoutMs);
        });
        report.cleanup = await Promise.race([
          Promise.resolve().then(() => runtime.close({ timeoutMs: closeTimeoutMs })), expired,
        ]);
        if (afterClose) await Promise.race([Promise.resolve().then(() => afterClose(report.cleanup)), expired]);
        if (report.cleanup?.cleanup !== 'complete' || report.cleanup.bots?.some((bot: any) => bot.execution !== 'stopped' || bot.cleanup !== 'complete')) {
          report.cleanupFailure = { code: 'CLEANUP_PENDING', message: 'Runtime cleanup remains pending',
            ...(report.cleanup?.reportPath ? { reportPath: report.cleanup.reportPath } : {}) };
        }
      } catch (error: any) { report.cleanupFailure = describe(error); }
      finally { clearTimeout(timer); }
    }
  }
  const candidateId = runtime?.id ?? report.businessFailure?.runtimeId;
  report.runtimeId = typeof candidateId === 'string' && /^[A-Za-z0-9_:-][A-Za-z0-9_.:-]{0,127}$/.test(candidateId) ? candidateId : randomUUID();
  const directory = join(resolve(outputDir), report.runtimeId);
  const reportPath = join(directory, 'environment-report.json');
  const temporary = join(directory, `.environment-report-${randomUUID()}.tmp`);
  let projected: any;
  try {
    const bytes = `${JSON.stringify(redact(report), null, 2)}\n`;
    projected = JSON.parse(bytes);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporary, reportPath);
    return { ...projected, reportPath };
  } catch (error: any) {
    const reportSaveFailure: any = { code: 'REPORT_SAVE_FAILED', message: 'Harness report could not be saved', details: [describe(error)] };
    const fallback = structuredClone(redact({ ...(projected ?? report), reportSaveFailure }));
    await rm(temporary, { force: true }).catch(() => {});
    return fallback;
  }
}

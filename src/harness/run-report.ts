import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
export function describe(error: any) {
  const result: any = { message: typeof error?.message === 'string' ? error.message : typeof error === 'string' ? error : 'Harness operation failed' };
  for (const key of ['code', 'operation', 'runtimeId', 'agentId', 'requestId', 'inputId', 'cleanup', 'reportPath', 'details', 'event', 'receipt']) {
    if (error?.[key] !== undefined) result[key] = error[key];
  }
  return result;
}

/** Harness owns input ordering, business deadlines and external Services.
 * This helper preserves independent failures and bounds only its close wait.
 * redact must scrub any configured secrets from intentional report content. */
export async function runWithReport({ outputDir, redact = (value: any) => value, ...options }: any) {
  if (typeof outputDir !== 'string' || !outputDir || typeof redact !== 'function') {
    throw new TypeError('Host reporting requires an output directory and a report projector');
  }
  return saveReport(outputDir, 'harness-report.json', await collectRuntimeEvidence(options), redact);
}

export interface CloseableRuntime {
  id: string;
  close(options: { timeoutMs: number }): Promise<unknown>;
}

export interface HarnessRuntimeRunOptions<R extends CloseableRuntime> {
  createRuntime(): R | Promise<R>;
  run(runtime: R): unknown;
  afterClose?(receipt: Awaited<ReturnType<R['close']>>): unknown;
  closeTimeoutMs?: number;
  /** Optional projection of the evidence before it becomes part of the Run report. */
  redact?(evidence: object): unknown;
  /** Business detail evaluated after close and domain reconciliation. */
  detail?: () => unknown;
}

export async function collectRuntimeEvidence({ createRuntime, run, afterClose, closeTimeoutMs = 60_000 }: any) {
  if (typeof createRuntime !== 'function' || typeof run !== 'function' ||
      (afterClose !== undefined && typeof afterClose !== 'function') ||
      !Number.isSafeInteger(closeTimeoutMs) || closeTimeoutMs < 1 || closeTimeoutMs > 2147483647) {
    throw new TypeError('Host reporting requires a factory, business function and finite close wait');
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
        if (report.cleanup?.cleanup !== 'complete' || report.cleanup.agents?.some((agent: any) => agent.execution !== 'stopped' || agent.cleanup !== 'complete')) {
          report.cleanupFailure = { code: 'CLEANUP_PENDING', message: 'Runtime cleanup remains pending',
            ...(report.cleanup?.reportPath ? { reportPath: report.cleanup.reportPath } : {}) };
        }
      } catch (error: any) { report.cleanupFailure = describe(error); }
      finally { clearTimeout(timer); }
    }
  }
  const candidateId = runtime?.id ?? report.businessFailure?.runtimeId;
  report.runtimeId = typeof candidateId === 'string' && /^[A-Za-z0-9_:-][A-Za-z0-9_.:-]{0,127}$/.test(candidateId) ? candidateId : randomUUID();
  return report;
}

export async function saveReport<R extends ({ runtimeId: string } | { runId: string }) & { reportSaveFailure: { code: string; message: string; details?: readonly unknown[] } | null }>(
  outputDir: string, filename: string, report: R, redact: (report: R) => R = value => value,
): Promise<R & { reportPath?: string }> {
  const directory = join(resolve(outputDir), 'runtimeId' in report ? report.runtimeId : report.runId);
  const reportPath = join(directory, filename);
  const temporary = join(directory, `.${filename}-${randomUUID()}.tmp`);
  let projected: R | undefined;
  try {
    const bytes = `${JSON.stringify(redact(report), null, 2)}\n`;
    projected = JSON.parse(bytes) as R;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporary, reportPath);
    return { ...projected, reportPath };
  } catch (error) {
    const reportSaveFailure = {
      code: 'REPORT_SAVE_FAILED', message: 'Harness report could not be saved', details: [describe(error)],
    };
    const fallback = structuredClone(redact({ ...(projected ?? report), reportSaveFailure }));
    await rm(temporary, { force: true }).catch(() => {});
    return fallback;
  }
}

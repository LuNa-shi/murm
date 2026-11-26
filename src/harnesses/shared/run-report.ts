import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { JsonValue } from '../../core/service-types.js';
import type { RunArtifactVerification, RunCoreClose, RunFacilityCleanup, RunFinalization, RunFinalizationError, RunFinalizationOptions, Runtime } from '../../core/types.js';

function describe(error: any) {
  const result: any = { message: typeof error?.message === 'string' ? error.message : typeof error === 'string' ? error : 'Harness operation failed' };
  for (const key of ['code', 'operation', 'runtimeId', 'agentId', 'requestId', 'inputId', 'cleanup', 'reportPath', 'details', 'event', 'receipt']) {
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
  return saveReport(outputDir, 'harness-report.json', report, redact);
}

async function saveReport<R extends { runtimeId: string; reportSaveFailure: RunFinalizationError | null }>(
  outputDir: string, filename: string, report: R, redact: (report: R) => R = value => value,
): Promise<R & { reportPath?: string }> {
  const directory = join(resolve(outputDir), report.runtimeId);
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

const finalized = new WeakSet<Pick<Runtime, 'id' | 'close'>>();

/** Close an existing Runtime and report application outcomes and owned facilities independently. */
export async function finalizeRun<Result extends JsonValue>({
  runtime, outputDir, business, verifyArtifacts, ownedFacilities = [], cleanupTimeoutMs = 60_000,
}: RunFinalizationOptions<Result>): Promise<RunFinalization<Result>> {
  const runtimeId = runtime?.id;
  const facilityIds = new Set<string>();
  if (typeof runtimeId !== 'string' || !/^[A-Za-z0-9_:-][A-Za-z0-9_.:-]{0,127}$/.test(runtimeId) || typeof runtime.close !== 'function' ||
      typeof outputDir !== 'string' || !outputDir || !Number.isSafeInteger(cleanupTimeoutMs) ||
      cleanupTimeoutMs < 1 || cleanupTimeoutMs > 2147483647 ||
      (verifyArtifacts !== undefined && typeof verifyArtifacts !== 'function') ||
      !Array.isArray(ownedFacilities) || ownedFacilities.some((facility) => {
        if (!facility || typeof facility.id !== 'string' || !facility.id || typeof facility.close !== 'function' ||
            facilityIds.has(facility.id)) return true;
        facilityIds.add(facility.id);
        return false;
      })) {
    throw Object.assign(new TypeError('Invalid run finalization options'), { code: 'INVALID_CONTRACT' });
  }

  if (finalized.has(runtime)) {
    throw Object.assign(new Error('This Runtime already has an application finalization'), { code: 'CONFLICT', runtimeId });
  }
  const outcome = structuredClone(business);
  const owned = ownedFacilities.map(facility => ({ id: facility.id, close: facility.close.bind(facility) }));
  finalized.add(runtime);

  const timeout = { code: 'CLEANUP_WAIT_TIMEOUT', message: 'The application cleanup wait expired' };
  const controller = new AbortController();
  const { signal } = controller;
  const closeWork = (async () => runtime.close({ timeoutMs: cleanupTimeoutMs }))();
  const expired = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    expired.reject(timeout);
    controller.abort(timeout);
  }, cleanupTimeoutMs);
  function withinBudget<T>(action: () => T | Promise<T>) {
    return Promise.race([expired.promise, Promise.resolve().then(() => {
      signal.throwIfAborted();
      return action();
    })]);
  }
  function failure(code: string, message: string, error: unknown): RunFinalizationError {
    return error === timeout ? timeout : { code, message, details: [describe(error)] };
  }

  let coreClose: RunCoreClose;
  let artifactVerification: RunArtifactVerification = { status: 'not-requested' };
  const facilities: RunFacilityCleanup[] = [];
  try {
    try {
      const receipt = structuredClone(await Promise.race([closeWork, expired.promise]));
      coreClose = { status: receipt.cleanup, receipt };
    } catch (error) {
      coreClose = { status: 'unknown', error: failure('CORE_CLOSE_FAILED', 'Runtime close could not be confirmed', error) };
    }

    if (verifyArtifacts) {
      if (coreClose.status === 'unknown') {
        artifactVerification = { status: 'pending', error: coreClose.error };
      } else {
        const receipt = structuredClone(coreClose.receipt);
        try {
          await withinBudget(() => verifyArtifacts(receipt, signal));
          artifactVerification = { status: 'passed' };
        } catch (error) {
          artifactVerification = { status: error === timeout ? 'pending' : 'failed',
            error: failure('ARTIFACT_VERIFICATION_FAILED', 'The application artifact check failed', error) };
        }
      }
    }

    for (const facility of owned) {
      if (coreClose.status !== 'complete') {
        facilities.push({ id: facility.id, status: 'pending',
          error: { code: 'CORE_CLOSE_PENDING', message: 'The facility was retained for Runtime cleanup' } });
        continue;
      }
      try {
        await withinBudget(() => facility.close(signal));
        facilities.push({ id: facility.id, status: 'complete' });
      } catch (error) {
        facilities.push({ id: facility.id, status: 'pending',
          error: failure('FACILITY_CLEANUP_FAILED', 'Facility cleanup could not be confirmed', error) });
      }
    }
  } finally {
    clearTimeout(timer);
  }

  return saveReport(outputDir, 'run-finalization.json', {
    runtimeId, business: outcome, coreClose, artifactVerification, facilities, reportSaveFailure: null,
  });
}

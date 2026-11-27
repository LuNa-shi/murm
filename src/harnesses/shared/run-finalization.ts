import { join, resolve } from 'node:path';
import { describe, saveReport } from './run-report.js';
import { isJson } from '../../core/services.js';
import type { JsonValue } from '../../core/service-types.js';
import type { CloseReceipt, Runtime } from '../../core/types.js';

export type RunBusinessOutcome<Result extends JsonValue = JsonValue> =
  | { status: 'completed'; value: Result }
  | { status: 'failed' | 'cancelled'; error: { code: string; message: string } };

export interface RunFinalizationError {
  code: string;
  message: string;
  details?: readonly unknown[];
}

export type RunCoreClose =
  | { status: 'complete' | 'pending'; receipt: CloseReceipt }
  | { status: 'unknown'; error: RunFinalizationError };

export type RunArtifactVerification =
  | { status: 'not-requested' | 'passed' }
  | { status: 'pending' | 'failed'; error: RunFinalizationError };

export type RunFacilityCleanup = { id: string } & (
  | { status: 'complete' }
  | { status: 'pending'; error: RunFinalizationError }
);

export interface RunFinalizationOptions<Result extends JsonValue = JsonValue> {
  runtime: Pick<Runtime, 'id' | 'close'>;
  outputDir: string;
  business: RunBusinessOutcome<Result>;
  cleanupTimeoutMs?: number;
  verifyArtifacts?(receipt: CloseReceipt, signal: AbortSignal): void | Promise<void>;
  ownedFacilities?: readonly { id: string; close(signal: AbortSignal): void | Promise<void> }[];
}

export interface RunLateFacilityCleanup {
  runtimeId: string;
  facility: RunFacilityCleanup;
  reportSaveFailure: RunFinalizationError | null;
  reportPath?: string;
}

export interface RunFinalization<Result extends JsonValue = JsonValue> {
  runtimeId: string;
  business: RunBusinessOutcome<Result>;
  coreClose: RunCoreClose;
  artifactVerification: RunArtifactVerification;
  facilities: readonly RunFacilityCleanup[];
  reportSaveFailure: RunFinalizationError | null;
  reportPath?: string;
  lateFacilityReportPath?: string;
  lateFacilityCleanup?: {
    current(): RunLateFacilityCleanup | undefined;
    readonly result: Promise<RunLateFacilityCleanup>;
  };
}

const lateFacilityFile = 'run-finalization-late-facility.json';

function invalid(message: string): never {
  throw Object.assign(new TypeError(message), { code: 'INVALID_CONTRACT' });
}

function captureBusiness<Result extends JsonValue>(business: RunBusinessOutcome<Result>): RunBusinessOutcome<Result> {
  let outcome: RunBusinessOutcome<Result>;
  try { outcome = structuredClone(business); }
  catch { return invalid('Run business outcome must contain JSON data'); }
  if (!isJson(outcome) || !outcome || (
    outcome.status === 'completed' ? !Object.hasOwn(outcome, 'value') :
      !['failed', 'cancelled'].includes(outcome.status) ||
      typeof outcome.error?.code !== 'string' || !outcome.error.code || typeof outcome.error?.message !== 'string'
  )) return invalid('Invalid run business outcome');
  return outcome;
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
    invalid('Invalid run finalization options');
  }

  if (finalized.has(runtime)) {
    throw Object.assign(new Error('This Runtime already has an application finalization'), { code: 'CONFLICT', runtimeId });
  }
  const outcome = captureBusiness(business);
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
  let lateFacilityCleanup: RunFinalization<Result>['lateFacilityCleanup'];
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
      let work: Promise<void> | undefined;
      const facilityFailure = (error: unknown): RunFacilityCleanup => ({ id: facility.id, status: 'pending',
        error: failure('FACILITY_CLEANUP_FAILED', 'Facility cleanup could not be confirmed', error) });
      try {
        await withinBudget(() => {
          work = Promise.resolve().then(() => facility.close(signal));
          return work;
        });
        facilities.push({ id: facility.id, status: 'complete' });
      } catch (error) {
        facilities.push(facilityFailure(error));
        if (error === timeout && work) {
          let receipt: RunLateFacilityCleanup | undefined;
          const result = work.then<RunFacilityCleanup, RunFacilityCleanup>(
            () => ({ id: facility.id, status: 'complete' }), facilityFailure,
          ).then(async (facilityReceipt) => {
            const saved = await saveReport(outputDir, lateFacilityFile,
              { runtimeId, facility: facilityReceipt, reportSaveFailure: null });
            receipt = structuredClone(saved);
            return saved;
          });
          lateFacilityCleanup = { result, current: () => structuredClone(receipt) };
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }

  const report = await saveReport(outputDir, 'run-finalization.json', {
    runtimeId, business: outcome, coreClose, artifactVerification, facilities, reportSaveFailure: null,
    ...(lateFacilityCleanup ? { lateFacilityReportPath: join(resolve(outputDir), runtimeId, lateFacilityFile) } : {}),
  });
  return lateFacilityCleanup ? { ...report, lateFacilityCleanup } : report;
}

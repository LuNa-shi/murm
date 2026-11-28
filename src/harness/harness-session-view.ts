import type { HarnessResult, HarnessState } from './harness-session-types.js';

export const defaultSnapshotBytes = 256 * 1024;

export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function fitField<T extends object, K extends keyof T>(view: T, field: K, value: T[K], fits: () => boolean): boolean {
  const previous = view[field];
  view[field] = value;
  if (fits()) return true;
  view[field] = previous;
  return false;
}

function brief(value: string) {
  return value.slice(0, 256).toWellFormed();
}

function briefFailure(failure: HarnessResult['failure']) {
  return failure && { code: failure.code, message: brief(failure.message) };
}

function resultSummary(result: HarnessResult): HarnessResult {
  return {
    runId: result.runId, harness: result.harness, outcome: result.outcome, reason: brief(result.reason),
    stopReason: result.stopReason === null ? null : brief(result.stopReason),
    failure: briefFailure(result.failure), reportSaveFailure: briefFailure(result.reportSaveFailure),
    ...(result.reportPath ? { reportPath: result.reportPath } : {}),
    artifacts: [],
    ...(result.export ? { export: { status: result.export.status } } : {}),
    cleanup: { status: result.cleanup.status },
    snapshotTruncated: true,
  };
}

function fitReceipts(view: HarnessResult, result: HarnessResult, fits: () => boolean) {
  fitField(view, 'reason', result.reason, fits);
  fitField(view, 'stopReason', result.stopReason, fits);
  for (const field of ['pending', 'retained', 'receipt'] as const) {
    const value = result.cleanup[field];
    if (!fitField(view.cleanup, field, value, fits) && Array.isArray(value)) {
      fitField(view.cleanup, field, value.slice(0, 16), fits);
    }
  }
  fitField(view, 'export', result.export, fits);
  if (!fitField(view, 'artifacts', result.artifacts, fits)) {
    fitField(view, 'artifacts', result.artifacts.slice(0, 16), fits);
  }
  if (!fitField(view, 'operations', result.operations, fits)) {
    fitField(view, 'operations', result.operations?.slice(0, 16), fits);
  }
}

/** Public terminal payload shared by SDK, RPC and foreground. The saved report retains the full value. */
export function publicHarnessResult(result: HarnessResult): HarnessResult {
  if (jsonBytes(result) <= defaultSnapshotBytes) return result;
  const view = resultSummary(result);
  const fits = () => jsonBytes(view) <= defaultSnapshotBytes;
  fitReceipts(view, result, fits);
  fitField(view, 'questions', result.questions, fits);
  fitField(view, 'acceptance', result.acceptance, fits);
  fitField(view, 'result', result.result, fits);
  return view;
}

/** Keep the live question channel and terminal evidence ahead of optional display content. */
export function boundHarnessState(state: HarnessState, bytes: number): HarnessState {
  const { capabilities, questions, result, output, business, agents, ...identity } = state;
  const view: HarnessState = {
    ...identity,
    stopReason: identity.stopReason === null ? null : brief(identity.stopReason),
    capabilities: {
      id: capabilities.id, apiVersion: capabilities.apiVersion, lifetimes: capabilities.lifetimes,
      questions: capabilities.questions, agents: {},
      input: { supported: capabilities.input.supported, available: capabilities.input.available },
    },
    questions: questions.filter(question => question.status === 'pending'),
    output: [], business: null, agents: [], snapshotTruncated: true,
  };
  const fits = () => jsonBytes(view) <= bytes;
  if (result && fitField(view, 'result', resultSummary(result), fits)) {
    // Questions appear once in this view. Their complete history lives in the report.
    fitReceipts(view.result!, result, fits);
  }
  const fullQuestions = fitField(view, 'questions', questions, fits);
  const fullCapabilities = fitField(view, 'capabilities', capabilities, fits);
  const fullAgents = fitField(view, 'agents', agents, fits);
  const fullBusiness = fitField(view, 'business', business, fits);
  const fullOutput = fitField(view, 'output', output, fits);
  const fullReason = fitField(view, 'stopReason', identity.stopReason, fits);
  if (fullQuestions && fullCapabilities && fullAgents && fullBusiness && fullOutput && fullReason && !result) {
    delete view.snapshotTruncated;
  }
  return view;
}

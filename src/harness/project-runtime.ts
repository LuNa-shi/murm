import type { Runtime } from '@luna-shi/murm';
import { ProjectPreflightError } from './project-input.js';
import type { HarnessJson, ProjectHarnessContext, ProjectHarnessResult } from './project-harness.js';

const json = (value: unknown): HarnessJson => JSON.parse(JSON.stringify(value));

/** Subscribe before spawn and serialize reads prompted by state changes. */
export function observeProjectRuntime(runtime: Runtime, context: ProjectHarnessContext, business?: () => unknown) {
  let pending = false;
  let refreshing = false;
  let closed = false;

  async function refresh() {
    pending = true;
    if (refreshing || closed) return;
    refreshing = true;
    try {
      while (pending && !closed) {
        pending = false;
        try {
          const agents = await runtime.list();
          if (!closed) context.updateStatus({
            agents: json(agents), business: json({ runtimeId: runtime.id, runtimeState: runtime.state, detail: business?.() ?? null }),
          });
        } catch {
          if (!closed) context.emit({ kind: 'observation-error', code: 'RUNTIME_STATE_UNAVAILABLE' });
        }
      }
    } finally {
      refreshing = false;
    }
  }

  const unsubscribe = runtime.onEvent(event => {
    if (event.type === 'agentChanged' || event.type === 'runtimeChanged' || event.type === 'management') {
      void refresh();
    } else if (!closed) {
      context.emit({ kind: 'agent', event: json(event) });
    }
  });
  void refresh();
  return { refresh, close() { closed = true; unsubscribe(); } };
}

export async function projectConfiguration<C>(context: ProjectHarnessContext, defaults: () => Promise<{ default: unknown }>) {
  let value: unknown;
  try {
    value = context.configuration ?? (await defaults()).default;
    if (!value || typeof value !== 'object' || !('sandbox' in value) || !('models' in value) || !('image' in value)) {
      throw new Error('Missing sandbox, models or image');
    }
  } catch {
    throw new ProjectPreflightError('INVALID_RUN_CONFIGURATION', 'Configure sandbox, models and image for this Harness');
  }
  context.signal.throwIfAborted();
  return value as C;
}

/** Translate established Harness reports while retaining the original close evidence. */
export function projectResult(report: any, context: ProjectHarnessContext, detail?: unknown): ProjectHarnessResult {
  const receipt = report.cleanup ?? (report.businessFailure?.receipt?.agents ? report.businessFailure.receipt : null);
  const pending = receipt?.pending ?? null;
  const cleanupConfirmed = !report.cleanupFailure && (!receipt ||
    (receipt.cleanup === 'complete' && (receipt.agents ?? []).every((agent: any) => agent.execution === 'stopped' && agent.cleanup === 'complete')));
  const exportPending = pending?.some((entry: any) => entry.action === 'collect-artifacts');
  const outcome = context.signal.aborted ? 'cancelled' :
    report.businessFailure || report.reportSaveFailure ? 'failed' : 'completed';
  return {
    outcome,
    reason: report.businessFailure?.code ?? (report.businessFailure ? 'HARNESS_BUSINESS_FAILED' :
      report.reportSaveFailure ? 'HARNESS_REPORT_SAVE_FAILED' : context.signal.aborted ? 'cancelled' : 'completed'),
    result: json({
      runtimeId: report.runtimeId ?? null, reportPath: report.reportPath ?? null,
      business: report.result ?? null, businessFailure: report.businessFailure ?? null,
      cleanupFailure: report.cleanupFailure ?? null, reportSaveFailure: report.reportSaveFailure ?? null,
      detail: detail ?? null,
    }),
    artifacts: (receipt?.agents ?? []).flatMap((agent: any) => (agent.artifacts ?? []).map((path: string) => ({ agentId: agent.agentId, path }))),
    ...(exportPending ? { export: { status: 'pending' } } : {}),
    cleanup: {
      status: cleanupConfirmed ? 'complete' : 'pending',
      receipt: json(receipt),
      pending: json(pending),
    },
  };
}

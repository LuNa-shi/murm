import type { Runtime, RuntimeEvent, InputReceipt } from '../core/index.js';

type SettledEvent = Extract<RuntimeEvent, { type: 'settled' }>;
type AcceptedInput = Extract<InputReceipt, { status: 'accepted' }>;
interface InputGuard { active: boolean; unresolved: boolean; used: Set<string> }
interface RunInputOptions {
  requestId: string; timeoutMs: number; signal?: AbortSignal;
  beforeSend?: () => void;
  onStarted?: () => void;
}
export interface RunInputResult { inputId: string; receipt: AcceptedInput; settled: SettledEvent }

const runtimeGuards: any = new WeakMap<Runtime, Map<string, InputGuard>>();

/** Wait for one explicitly owned input on an idle Agent. The caller must exclude all other input sources. */
export async function runInput(runtime: Runtime, agentId: string, input: string, { requestId, timeoutMs, signal, beforeSend, onStarted }: RunInputOptions = {} as RunInputOptions): Promise<RunInputResult> {
  const failure = (code: string, details?: Record<string, unknown>) => Object.assign(new Error(code), { code, runtimeId: runtime.id, agentId, requestId, ...details });
  if (typeof requestId !== 'string' || !requestId || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) {
    throw failure('invalid_wait_options');
  }
  let agents = runtimeGuards.get(runtime);
  if (!agents) runtimeGuards.set(runtime, agents = new Map());
  let guard = agents.get(agentId);
  if (!guard) agents.set(agentId, guard = { active: false, unresolved: false, used: new Set() });
  if (guard.active) throw failure('concurrent_wait_for_agent');
  if (guard.used.has(requestId)) throw failure('wait_request_id_reused');
  if (guard.unresolved) throw failure('previous_submission_unresolved');
  guard.active = true;
  guard.used.add(requestId);

  return new Promise<RunInputResult>((resolve, reject) => {
    let done = false;
    let submitted = false;
    let receipt: InputReceipt | undefined;
    let settled: SettledEvent | undefined;
    let unsubscribe: (() => void) | undefined;
    const diagnostic = () => ({ inputId: receipt?.inputId, receipt, event: settled });
    function finish(error?: unknown, uncertain = false) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      unsubscribe?.();
      guard!.active = false;
      guard!.unresolved ||= uncertain && submitted;
      if (error) reject(error);
      else resolve({ inputId: (receipt as AcceptedInput).inputId, receipt: receipt as AcceptedInput, settled: settled! });
    }
    function onAbort() {
      finish(failure('wait_aborted', diagnostic()), true);
    }
    function complete() {
      if (!settled || receipt?.status !== 'accepted' || receipt.disposition !== 'started') return;
      finish(settled.outcome === 'completed' ? undefined : failure(`input_${settled.outcome}`, diagnostic()));
    }
    const timer = setTimeout(() => finish(failure('input_timeout', diagnostic()), true), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();

    void (async () => {
      try {
        if (done) return;
        unsubscribe = runtime.onEvent((event) => {
          if (done || !submitted || !('agentId' in event) || event.agentId !== agentId) return;
          if (event.type === 'exit' || (event.type === 'error' && event.fatal)) {
            finish(failure(event.type === 'exit' ? 'agent_exited' : 'agent_failed', { ...diagnostic(), event }), true);
          } else if (event.type === 'settled' && !settled) {
            settled = event;
            complete();
          }
        });
        if (done) { unsubscribe(); return; }
        const before = await runtime.get(agentId);
        if (done) return;
        if (before.status !== 'idle') throw failure('wait_requires_idle_agent');
        beforeSend?.();
        if (done) return;
        submitted = true;
        receipt = await runtime.send(agentId, input, { requestId, mode: 'followUp' });
        if (done) return;
        if (receipt.status === 'unknown') finish(failure('input_unknown', diagnostic()), true);
        else if (receipt.disposition === 'queued') finish(failure('exclusive_input_was_queued', diagnostic()), true);
        else if (receipt.disposition === 'handled') finish(failure('input_handled_without_model_run', diagnostic()));
        else {
          if (!settled) onStarted?.();
          complete();
        }
      } catch (error: any) { finish(error || failure('send_failed', diagnostic()), submitted); }
    })();
  });
}

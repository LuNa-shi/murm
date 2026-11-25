import type { Runtime, BotEvent, InputReceipt } from '../../core/index.js';

type SettledEvent = Extract<BotEvent, { type: 'settled' }>;
type AcceptedInput = Extract<InputReceipt, { status: 'accepted' }>;
interface InputGuard { active: boolean; unresolved: boolean; used: Set<string> }
interface RunInputOptions { requestId: string; timeoutMs: number; signal?: AbortSignal }
export interface RunInputResult { inputId: string; receipt: AcceptedInput; settled: SettledEvent }

const runtimeGuards: any = new WeakMap<Runtime, Map<string, InputGuard>>();

/** Wait for one explicitly owned input on an idle Bot. The caller must exclude all other input sources. */
export async function runInput(runtime: Runtime, botId: string, input: string, { requestId, timeoutMs, signal }: RunInputOptions = {} as RunInputOptions): Promise<RunInputResult> {
  const failure = (code: string, details?: Record<string, unknown>) => Object.assign(new Error(code), { code, runtimeId: runtime.id, botId, requestId, ...details });
  if (typeof requestId !== 'string' || !requestId || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) {
    throw failure('invalid_wait_options');
  }
  let bots = runtimeGuards.get(runtime);
  if (!bots) runtimeGuards.set(runtime, bots = new Map());
  let guard = bots.get(botId);
  if (!guard) bots.set(botId, guard = { active: false, unresolved: false, used: new Set() });
  if (guard.active) throw failure('concurrent_wait_for_bot');
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
        const before = await runtime.get(botId);
        if (done) return;
        if (before.status !== 'idle') throw failure('wait_requires_idle_bot');
        unsubscribe = runtime.onEvent((event) => {
          if (done || !submitted || event.botId !== botId || event.seq <= before.cursor) return;
          if (event.type === 'exit' || (event.type === 'error' && event.fatal)) {
            finish(failure(event.type === 'exit' ? 'bot_exited' : 'bot_failed', { ...diagnostic(), event }), true);
          } else if (event.type === 'settled' && !settled) {
            settled = event;
            complete();
          }
        });
        if (done) { unsubscribe(); return; }
        submitted = true;
        receipt = await runtime.send(botId, input, { requestId, mode: 'followUp' });
        if (done) return;
        if (receipt.status === 'unknown') finish(failure('input_unknown', diagnostic()), true);
        else if (receipt.disposition === 'queued') finish(failure('exclusive_input_was_queued', diagnostic()), true);
        else if (receipt.disposition === 'handled') finish(failure('input_handled_without_model_run', diagnostic()));
        else complete();
      } catch (error: any) { finish(error || failure('send_failed', diagnostic()), submitted); }
    })();
  });
}

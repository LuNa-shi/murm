import type { ConditionalInputReceipt, Runtime, RuntimeEvent } from '@luna-shi/murm';

type TurnRuntime = Pick<Runtime, 'state' | 'get' | 'send' | 'onEvent'>;
type TurnOptions = { requestId: string; timeoutMs?: number; signal?: AbortSignal };
type Settled = Extract<RuntimeEvent, { type: 'settled' }>;

export class TurnError extends Error {
  constructor(
    readonly code: string,
    readonly stage: 'preflight' | 'admission' | 'settlement',
    readonly agentId: string,
    readonly requestId: string,
  ) {
    super(`${code} at ${stage} for Agent ${agentId} (request ${requestId})`);
  }
}

export function createTurnRunner(runtime: TurnRuntime) {
  const active = new Set<string>();
  const uncertain = new Set<string>();

  return async function runTurn(agentId: string, input: string, { requestId, timeoutMs = 120_000, signal }: TurnOptions) {
    const failure = (code: string, stage: TurnError['stage']) => new TurnError(code, stage, agentId, requestId);
    if (active.has(agentId)) throw failure('TURN_IN_FLIGHT', 'preflight');
    if (uncertain.has(agentId)) throw failure('TURN_UNCERTAIN', 'preflight');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw failure('TURN_INVALID_TIMEOUT', 'preflight');
    if (signal?.aborted) throw failure('TURN_CANCELLED', 'preflight');
    active.add(agentId);

    let stage: TurnError['stage'] = 'preflight';
    let sent = false;
    let terminal = false;
    let unsubscribe: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(failure('TURN_TIMEOUT', stage)), timeoutMs);
        abort = () => reject(failure('TURN_CANCELLED', stage));
        signal?.addEventListener('abort', abort, { once: true });
      });
      const current = await Promise.race([runtime.get(agentId), deadline]);
      if (runtime.state !== 'open' || current.status !== 'idle') throw failure('AGENT_NOT_IDLE', 'preflight');

      const settlement = new Promise<Settled>((resolve, reject) => {
        unsubscribe = runtime.onEvent(event => {
          if (!sent || !('agentId' in event) || event.agentId !== agentId) return;
          if (event.type === 'settled') {
            terminal = true;
            if (event.outcome === 'completed') resolve(event);
            else reject(failure(event.error?.code ?? (event.outcome === 'failed' ? 'TURN_FAILED' : 'TURN_ABORTED'), 'settlement'));
          } else if (event.type === 'error' && event.fatal) {
            reject(failure(event.error.code, 'settlement'));
          } else if (event.type === 'exit') {
            reject(failure(event.expected ? 'AGENT_STOPPED' : 'AGENT_EXITED', 'settlement'));
          }
        });
      });

      stage = 'admission';
      sent = true;
      const admission = Promise.resolve().then(async (): Promise<ConditionalInputReceipt> => {
        if (signal?.aborted) throw failure('TURN_CANCELLED', 'admission');
        const receipt = await runtime.send(agentId, input, { requestId, mode: 'followUp' });
        if (receipt.status === 'unknown') throw failure('INPUT_UNKNOWN', 'admission');
        if (receipt.status !== 'accepted') {
          sent = false;
          throw failure('INPUT_NOT_ACCEPTED', 'admission');
        }
        stage = 'settlement';
        return receipt;
      });
      const [receipt, event] = await Promise.race([Promise.all([admission, settlement]), deadline]);
      return { receipt, output: event.output };
    } catch (error) {
      if (sent && !terminal) uncertain.add(agentId);
      if (error instanceof TurnError) throw error;
      const code = (error as { code?: unknown } | undefined)?.code;
      throw failure(typeof code === 'string' ? code : 'TURN_ERROR', stage);
    } finally {
      unsubscribe?.();
      clearTimeout(timer);
      if (abort) signal?.removeEventListener('abort', abort);
      active.delete(agentId);
    }
  };
}

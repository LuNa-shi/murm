import { resolve } from 'node:path';
import { runAgenshTeam } from '../agensh/team.js';
import { runFlatEnvironment } from '../flat/environment.js';

const fail = (code: any) => Object.assign(new Error(code), { code });
const finite = (value: any) => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const receipt = (row: any) => Object.fromEntries(['batchId', 'requestId', 'inputId', 'state', 'status', 'code', 'taskId', 'taskState', 'reason'].filter((key: any) => row[key] !== undefined).map((key: any) => [key, row[key]]));
function botState({ status, cursor, lastError, lastStop }: any) {
  return { status, cursor,
    ...(lastError ? { lastErrorCode: typeof lastError.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(lastError.code) ? lastError.code : 'BOT_ERROR' } : {}),
    ...(lastStop ? { lastStop: { execution: lastStop.execution, cleanup: lastStop.cleanup } } : {}),
  };
}

/** One foreground host. Mode controllers retain all input and resource authority. */
export async function runForegroundEnvironment({ mode, options, timeoutMs = 120_000, signal }: any = {}, interact: any) {
  if (!['flat', 'agensh'].includes(mode) || !options || typeof options !== 'object' || typeof interact !== 'function' ||
      !finite(timeoutMs) || (options.signal !== undefined && !(options.signal instanceof AbortSignal)) || (signal !== undefined && !(signal instanceof AbortSignal))) throw new TypeError('Foreground host requires a mode, options, interaction and finite timeout');
  const lifetime: any = new AbortController();
  const deadline = AbortSignal.timeout(timeoutMs);
  const workSignal = AbortSignal.any([lifetime.signal, deadline, ...(signal ? [signal] : []), ...(options.signal ? [options.signal] : [])]);
  let closing = false;
  const stop = () => { closing = true; lifetime.abort(); return { status: 'stopping' }; };
  const check = () => { if (closing || workSignal.aborted) throw fail('HOST_STOPPING'); };
  async function drive(handle: any) {
    let abort: any;
    const stopped = new Promise<any>((resolve: any, reject: any) => {
      abort = () => {
        closing = true;
        if (['AGENSH_TEAM_FENCED', 'HOST_INPUT_FAILED', 'HOST_OUTPUT_FAILED'].includes(workSignal.reason?.code)) reject(workSignal.reason);
        else if (workSignal.reason === deadline.reason && deadline.aborted) reject(fail('HOST_WORK_TIMEOUT'));
        else resolve({ reason: 'host-stop' });
      };
      workSignal.addEventListener('abort', abort, { once: true });
      if (workSignal.aborted) abort();
    });
    try { return await Promise.race([Promise.resolve().then(() => { check(); return interact(Object.freeze({ ...handle, signal: workSignal, stop })); }), stopped]); }
    finally { workSignal.removeEventListener('abort', abort); stop(); }
  }
  try {
    if (mode === 'agensh') return await runAgenshTeam({ ...options, signal: workSignal }, async (team: any) => {
      const status = async () => {
        const view = team.currentPeers();
        const peers = await Promise.all(view.peers.map(async (peer: any) => ({ key: peer.key, botId: peer.botId,
            ...botState(await team.getBot(peer.botId)),
            ready: peer.router.ready, accepting: peer.router.accepting, fenced: peer.router.fenced,
            batches: peer.router.batches.map(receipt) })));
        return team.redact({ mode, runtimeId: team.id, runDirectory: resolve(options.outputDir, team.id), closing: closing || view.closing, peers });
      };
      const recipient = (key: any) => {
        check();
        const peer = team.currentPeers().peers.find((row: any) => row.key === key);
        if (!peer) throw fail('UNKNOWN_RECIPIENT');
        return peer;
      };
      const teamStopped = () => { closing = true; lifetime.abort(team.signal.reason); };
      team.signal.addEventListener('abort', teamStopped, { once: true });
      if (team.signal.aborted) teamStopped();
      try { return await drive({ status,
        async kickoff({ recipient: key, input }: any) { recipient(key); return team.redact(receipt(team.kickoff(key, input))); },
        async input({ recipient: key, input, requestId }: any) {
          const peer = recipient(key);
          return team.redact(receipt(team.ingest(key, { source: 'user', kind: 'user', eventId: requestId, targetWorker: peer.router.mapping.workerId, text: input })));
        },
        async wait({ recipient: key, batchId, timeoutMs: waitMs = 30_000 }: any) {
          recipient(key);
          if (!finite(waitMs)) throw fail('HOST_WAIT_INVALID');
          return team.redact(receipt(await team.wait(key, batchId, { timeoutMs: Math.min(timeoutMs, waitMs), signal: workSignal })));
        },
      }); } finally { team.signal.removeEventListener('abort', teamStopped); }
    });
    return await runFlatEnvironment({ ...options, signal: workSignal, async drive(controller: any, runtime: any) {
      const ended = controller.wait().then(() => stop());
      try {
        await drive({ status: async () => {
          const view = controller.snapshot();
          const bots = await Promise.all(view.bots.map(async (bot: any) => ({ botId: bot.botId,
            ...botState(await runtime.get(bot.botId)), released: bot.released, stopReason: bot.stopReason })));
          return { mode, runtimeId: runtime.id, runDirectory: resolve(options.outputDir, runtime.id),
            closing: closing || view.closing, completion: view.completion, bots, inputs: view.inputs.map(receipt) };
        }, async input(input: any) { check(); return receipt(await controller.feedback(input)); } });
      } finally { controller.halt(); await ended; }
    } });
  } finally { stop(); }
}

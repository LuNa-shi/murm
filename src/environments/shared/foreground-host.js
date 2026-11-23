import { runAgenshTeam } from '../agensh/team.js';
import { runFlatEnvironment } from '../flat/environment.js';

const fail = code => Object.assign(new Error(code), { code });
const finite = value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const receipt = row => Object.fromEntries(['batchId', 'requestId', 'inputId', 'state', 'status', 'code', 'taskId', 'taskState', 'reason'].filter(key => row[key] !== undefined).map(key => [key, row[key]]));

/** One foreground host. Mode controllers retain all input and resource authority. */
export async function runForegroundEnvironment({ mode, options, timeoutMs = 120_000, signal } = {}, interact) {
  if (!['flat', 'agensh'].includes(mode) || !options || typeof options !== 'object' || typeof interact !== 'function' ||
      !finite(timeoutMs) || (options.signal !== undefined && !(options.signal instanceof AbortSignal)) || (signal !== undefined && !(signal instanceof AbortSignal))) throw new TypeError('Foreground host requires a mode, options, interaction and finite timeout');
  const lifetime = new AbortController();
  const deadline = AbortSignal.timeout(timeoutMs);
  const workSignal = AbortSignal.any([lifetime.signal, deadline, ...(signal ? [signal] : []), ...(options.signal ? [options.signal] : [])]);
  let closing = false;
  const stop = () => { closing = true; lifetime.abort(); return { status: 'stopping' }; };
  const check = () => { if (closing || workSignal.aborted) throw fail('HOST_STOPPING'); };
  async function drive(handle) {
    let abort;
    const stopped = new Promise((resolve, reject) => {
      abort = () => {
        closing = true;
        if (workSignal.reason?.code === 'AGENSH_TEAM_FENCED') reject(workSignal.reason);
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
    if (mode === 'agensh') return await runAgenshTeam({ ...options, signal: workSignal }, async team => {
      const status = () => {
        const view = team.snapshot();
        return { mode, runtimeId: team.id, closing: closing || view.closing,
          peers: view.peers.map(peer => ({ key: peer.key, botId: peer.botId,
            ready: peer.router.ready, accepting: peer.router.accepting, fenced: peer.router.fenced,
            batches: peer.router.batches.map(receipt) })) };
      };
      const recipient = key => {
        check();
        const peer = team.snapshot().peers.find(row => row.key === key);
        if (!peer) throw fail('UNKNOWN_RECIPIENT');
        return peer;
      };
      const teamStopped = () => { closing = true; lifetime.abort(team.signal.reason); };
      team.signal.addEventListener('abort', teamStopped, { once: true });
      if (team.signal.aborted) teamStopped();
      try { return await drive({ status,
        async kickoff({ recipient: key, input }) { recipient(key); return team.redact(receipt(team.kickoff(key, input))); },
        async input({ recipient: key, input, requestId }) {
          const peer = recipient(key);
          return team.redact(receipt(team.ingest(key, { source: 'user', kind: 'user', eventId: requestId, targetWorker: peer.router.mapping.workerId, text: input })));
        },
        async wait({ recipient: key, batchId, timeoutMs: waitMs = 30_000 }) {
          recipient(key);
          if (!finite(waitMs)) throw fail('HOST_WAIT_INVALID');
          return team.redact(receipt(await team.wait(key, batchId, { timeoutMs: Math.min(timeoutMs, waitMs), signal: workSignal })));
        },
      }); } finally { team.signal.removeEventListener('abort', teamStopped); }
    });
    return await runFlatEnvironment({ ...options, signal: workSignal, async drive(controller) {
      const ended = controller.wait().then(() => stop());
      try {
        await drive({ status: () => {
          const view = controller.snapshot();
          return { mode, runtimeId: view.runtimeId, closing: closing || view.closing, completion: view.completion,
            bots: view.bots.map(bot => ({ botId: bot.botId, released: bot.released, stopReason: bot.stopReason })), inputs: view.inputs.map(receipt) };
        }, async input(input) { check(); return receipt(await controller.feedback(input)); } });
      } finally { controller.halt(); await ended; }
    } });
  } finally { stop(); }
}

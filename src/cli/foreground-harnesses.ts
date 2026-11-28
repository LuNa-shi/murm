import { resolve } from 'node:path';
import { peerBatchReceipt, runPeerMeshTeam } from '../../examples/peermesh/harness/team.js';
import { runTaskPoolHarness } from '../../examples/taskpool/harness/harness.js';

const fail = (code: any) => Object.assign(new Error(code), { code });
const finite = (value: any) => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const definedFields = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined));
function taskFeedbackReceipt(row: Record<string, unknown>) {
  const { batchId, requestId, inputId, state, status, code, taskId, taskState, reason } = row;
  return definedFields({ batchId, requestId, inputId, state, status, code, taskId, taskState, reason });
}
function agentState({ status, lastError, lastStop }: any) {
  return { status,
    ...(lastError ? { lastErrorCode: typeof lastError.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(lastError.code) ? lastError.code : 'AGENT_ERROR' } : {}),
    ...(lastStop ? { lastStop: { execution: lastStop.execution, cleanup: lastStop.cleanup } } : {}),
  };
}

export function isPeerMeshMode(mode: unknown) {
  return mode === 'peermesh';
}

export function keepsForegroundCommandsOpen(mode: unknown, options: { project?: unknown } | undefined) {
  return isPeerMeshMode(mode) && Boolean(options?.project);
}

/** Adapt the installed JSONL commands to the same business drivers as the public Harnesses. */
export async function runForegroundHarness({ mode, options, timeoutMs = 120_000, signal }: any = {}, interact: any) {
  if (!(mode === 'taskpool' || isPeerMeshMode(mode)) || !options || typeof options !== 'object' || typeof interact !== 'function' ||
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
        if (['PEERMESH_TEAM_FENCED', 'HOST_INPUT_FAILED', 'HOST_OUTPUT_FAILED'].includes(workSignal.reason?.code)) reject(workSignal.reason);
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
    if (isPeerMeshMode(mode)) return await runPeerMeshTeam({ ...options, signal: workSignal }, async (team: any) => {
      const receipt = (row: Record<string, unknown>) => definedFields(peerBatchReceipt(row));
      const status = async () => {
        const view = team.currentPeers();
        const peers = await Promise.all(view.peers.map(async (peer: any) => ({ key: peer.key, agentId: peer.agentId,
            ...agentState(await team.getAgent(peer.agentId)),
            ready: peer.router.ready, accepting: peer.router.accepting, fenced: peer.router.fenced,
            batches: peer.router.batches.map(receipt) })));
        return team.redact({ mode, runtimeId: team.id, runDirectory: resolve(options.outputDir, team.id), closing: closing || view.closing, peers, ...(options.project ? { project: team.snapshot().project } : {}) });
      };
      const recipient = (key: any) => {
        check();
        if (!team.hasPeer(key)) throw fail('UNKNOWN_RECIPIENT');
      };
      const teamStopped = () => { closing = true; lifetime.abort(team.signal.reason); };
      team.signal.addEventListener('abort', teamStopped, { once: true });
      if (team.signal.aborted) teamStopped();
      try { return await drive({ status,
        async kickoff({ recipient: key, input }: any) { recipient(key); return team.redact(receipt(team.kickoff(key, input))); },
        async input({ recipient: key, input, requestId }: any) {
          recipient(key);
          return team.redact(receipt(team.input({ recipient: key, input, requestId })));
        },
        async wait({ recipient: key, batchId, timeoutMs: waitMs = 30_000 }: any) {
          recipient(key);
          if (!finite(waitMs)) throw fail('HOST_WAIT_INVALID');
          return team.redact(receipt(await team.wait(key, batchId, { timeoutMs: Math.min(timeoutMs, waitMs), signal: workSignal })));
        },
      }); } finally { team.signal.removeEventListener('abort', teamStopped); }
    });
    return await runTaskPoolHarness({ ...options, signal: workSignal, async drive(controller: any, runtime: any, completion: Promise<unknown>) {
      const ended = completion.then(stop);
      try {
        await drive({ status: async () => {
          const view = controller.snapshot();
          const agents = await Promise.all(view.agents.map(async (agent: any) => ({ agentId: agent.agentId,
            ...agentState(await runtime.get(agent.agentId)), released: agent.released, stopReason: agent.stopReason })));
          return { mode, runtimeId: runtime.id, runDirectory: resolve(options.outputDir, runtime.id),
            closing: closing || view.closing, completion: view.completion, agents, inputs: view.inputs.map(taskFeedbackReceipt) };
        }, async input(input: any) { check(); return taskFeedbackReceipt(await controller.feedback(input)); } });
      } finally { controller.halt(); await ended; }
    } });
  } finally { stop(); }
}

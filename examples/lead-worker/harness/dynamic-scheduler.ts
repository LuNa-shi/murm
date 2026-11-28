import type { createBoard } from './board.js';

type Notice = {
  kind: 'task' | 'member-ready' | 'feedback' | 'delivery' | 'incomplete';
  id: string | number;
  taskId?: string;
  revision?: number;
  agentId?: string;
};

export async function runDynamicSchedule({ board, team, goal, signal, dispatch }: {
  board: ReturnType<typeof createBoard>;
  team: Record<string, string>;
  goal: string;
  signal: AbortSignal;
  dispatch(role: string, requestId: string, message: unknown, signal: AbortSignal): Promise<unknown>;
}) {
  const pending = new Map<string, Map<string, Notice>>();
  const active = new Set<string>();
  let nextRequest = 0;
  let at = board.snapshot().history.at(-1)?.seq ?? 0;
  let waiting = Promise.withResolvers<void>();
  let failure: unknown;
  const pulse = () => { waiting.resolve(); waiting = Promise.withResolvers<void>(); };
  const unsubscribe = board.subscribe(pulse);
  signal.addEventListener('abort', pulse, { once: true });
  const lead = team.lead;

  function queue(agentId: string, notice: Notice) {
    if (signal.aborted) return;
    let notices = pending.get(agentId);
    if (!notices) pending.set(agentId, notices = new Map());
    notices.set(JSON.stringify([notice.kind, notice.id]), notice);
  }

  function send(agentId: string, message: unknown) {
    const role = Object.keys(team).find(role => team[role] === agentId)!;
    active.add(agentId);
    const requestId = `dynamic-input-${++nextRequest}`;
    void dispatch(role, requestId, message, signal).then(() => {
      if (agentId !== lead && board.snapshot().subtasks.some((row: any) => row.owner === agentId && row.state !== 'complete')) {
        queue(lead, { kind: 'incomplete', id: requestId, agentId });
      }
    }).catch(error => { failure ??= error; }).finally(() => { active.delete(agentId); pulse(); });
  }

  try {
    signal.throwIfAborted();
    send(lead, { type: 'dynamic-goal', goal });
    while (true) {
      const changed = waiting.promise;
      if (failure) throw failure;
      signal.throwIfAborted();
      const state = board.snapshot();
      if (state.submitted) {
        if (!active.size) return state.submitted;
      } else {
        for (const event of state.history) {
          if (event.seq <= at) continue;
          at = event.seq;
          if (event.type === 'create_subtask') {
            const row = state.subtasks.find((task: any) => task.id === event.subtaskId);
            if (row?.state === 'ready') for (const id of row.assignee_ids) {
              queue(id, { kind: 'task', id: row.id, revision: row.revision });
            }
          } else if (event.type === 'member_ready') {
            queue(lead, { kind: 'member-ready', id: event.seq, agentId: event.actor });
          } else if (event.actor !== lead && ['note', 'landed', 'complete'].includes(event.type)) {
            queue(lead, { kind: event.type === 'note' ? 'feedback' : 'delivery', id: event.seq,
              taskId: event.subtaskId ?? event.subtask_id, agentId: event.actor });
          }
        }
        for (const [agentId, notices] of pending) {
          if (!state.members[agentId]?.ready || active.has(agentId)) continue;
          pending.delete(agentId);
          const updates = [...notices.values()].filter(notice => notice.kind !== 'task' ||
            state.subtasks.some((row: any) => row.id === notice.id && row.state === 'ready'));
          if (updates.length) send(agentId, { type: 'board-updates', revision: at, updates });
        }
      }
      await changed;
    }
  } finally {
    unsubscribe();
    signal.removeEventListener('abort', pulse);
  }
}

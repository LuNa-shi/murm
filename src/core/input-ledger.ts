// Callers are trusted identities supplied by Core, never send options. The
// public Runtime uses "host"; Agent Service supplies "agent:<authenticated id>".
// Compare the same parameter fingerprint used by the durable input journal.
// Recovery can reserve the original identity without retaining prompt content.
export function createInputLedger<Request>(runtimeId: string) {
  const entries = new Map<string, { fingerprint: string; request: Request }>();
  const key = (caller: string, target: string, requestId: string) => JSON.stringify([runtimeId, caller, 'send', target, requestId]);
  function get(caller: string, target: string, requestId: string, fingerprint: string) {
    const entry = entries.get(key(caller, target, requestId));
    if (entry && entry.fingerprint !== fingerprint) {
      throw Object.assign(new Error('send requestId already has different parameters'), { code: 'CONFLICT' });
    }
    return entry?.request;
  }
  return {
    get,
    peek(caller: string, target: string, requestId: string) { return entries.get(key(caller, target, requestId))?.request; },
    reserve(caller: string, target: string, requestId: string, fingerprint: string, create: () => Request) {
      const existing = get(caller, target, requestId, fingerprint);
      if (existing) return existing;
      const request = create();
      entries.set(key(caller, target, requestId), { fingerprint, request });
      return request;
    },
  };
}

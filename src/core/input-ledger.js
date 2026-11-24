// Callers are trusted identities supplied by Core, never send options. The
// public Runtime uses "host"; Bot Service will supply "bot:<authenticated id>".
export function createInputLedger(runtimeId) {
  const entries = new Map();
  const key = (caller, target, requestId) => JSON.stringify([runtimeId, caller, 'send', target, requestId]);
  function get(caller, target, requestId, parameters) {
    const entry = entries.get(key(caller, target, requestId));
    if (entry && (entry.input !== parameters.input || entry.mode !== parameters.mode ||
        entry.source !== parameters.source || entry.steeringMode !== parameters.steeringMode)) {
      throw Object.assign(new Error('send requestId already has different parameters'), { code: 'CONFLICT' });
    }
    return entry?.request;
  }
  return {
    get,
    reserve(caller, target, requestId, parameters, create) {
      const existing = get(caller, target, requestId, parameters);
      if (existing) return existing;
      const request = create();
      entries.set(key(caller, target, requestId), { ...parameters, request });
      return request;
    },
  };
}

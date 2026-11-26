import type { InputMode } from './types.js';

interface InputParameters {
  input: string;
  mode: InputMode;
  wakeIfIdle: boolean;
  source?: string;
  steeringMode?: 'all' | 'one-at-a-time';
}

// Callers are trusted identities supplied by Core, never send options. The
// public Runtime uses "host"; Agent Service will supply "agent:<authenticated id>".
export function createInputLedger<Request>(runtimeId: string) {
  const entries = new Map<string, InputParameters & { request: Request }>();
  const key = (caller: string, target: string, requestId: string) => JSON.stringify([runtimeId, caller, 'send', target, requestId]);
  function get(caller: string, target: string, requestId: string, parameters: InputParameters) {
    const entry = entries.get(key(caller, target, requestId));
    if (entry && (entry.input !== parameters.input || entry.mode !== parameters.mode || entry.wakeIfIdle !== parameters.wakeIfIdle ||
        entry.source !== parameters.source || entry.steeringMode !== parameters.steeringMode)) {
      throw Object.assign(new Error('send requestId already has different parameters'), { code: 'CONFLICT' });
    }
    return entry?.request;
  }
  return {
    get,
    reserve(caller: string, target: string, requestId: string, parameters: InputParameters, create: () => Request) {
      const existing = get(caller, target, requestId, parameters);
      if (existing) return existing;
      const request = create();
      entries.set(key(caller, target, requestId), { ...parameters, request });
      return request;
    },
  };
}

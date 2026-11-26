import { createHash } from 'node:crypto';

function canonical(value: any): any  {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key: any) => [key, canonical(value[key])]));
  return value;
}

// One Worker owns one executor process. Keep submission identities for that entire
// lifetime: evicting a completed or uncertain prompt would permit redelivery.
export function createRpcSubmissions({ write }: any) {
  const submissions = new Map<any, any>();
  const snapshot = (entry: any) => entry.response
    ? { state: 'complete', response: structuredClone(entry.response) } : { state: 'pending' };
  return {
    observe(record: any) {
      if (record.type !== 'response') return;
      const entry = submissions.get(record.id);
      if (!entry || entry.response) return;
      entry.response = structuredClone(record);
      entry.resolve();
    },
    query(id: any) {
      const entry = submissions.get(id);
      return entry ? snapshot(entry) : { state: 'not_found' };
    },
    completion(id: string) {
      return submissions.get(id)?.done;
    },
    async submit(message: any, timeoutMs: number) {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
        throw Object.assign(new Error('Invalid Worker RPC wait limit'), { code: 'INVALID_CONTRACT' });
      }
      if (typeof message.id !== 'string' || !message.id) {
        write(message);
        return { state: 'untracked' };
      }
      const fingerprint = createHash('sha256').update(JSON.stringify(canonical(message))).digest('hex');
      let entry = submissions.get(message.id);
      if (entry && entry.fingerprint !== fingerprint) {
        throw Object.assign(new Error('Worker RPC identity has different parameters'), { code: 'CONFLICT' });
      }
      if (!entry) {
        entry = { fingerprint };
        entry.done = new Promise<any>((resolve: any) => { entry.resolve = resolve; });
        submissions.set(message.id, entry);
        // Register before writing: even a synchronous/very fast response sees
        // the same submission, and a transport failure never unlocks its ID.
        write(message);
      }
      let timer;
      try {
        await Promise.race([entry.done, new Promise<any>((resolve: any) => { timer = setTimeout(resolve, timeoutMs); })]);
        return snapshot(entry);
      } finally { clearTimeout(timer); }
    },
  };
}

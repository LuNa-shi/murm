import { createHash } from 'node:crypto';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

// One Worker owns one Pi process. Keep submission identities for that entire
// lifetime: evicting a completed or uncertain prompt would permit redelivery.
export function createPiRpcSubmissions({ write }) {
  const submissions = new Map();
  const snapshot = entry => entry.response
    ? { state: 'complete', response: structuredClone(entry.response) } : { state: 'pending' };
  return {
    observe(record) {
      if (record.type !== 'response') return;
      const entry = submissions.get(record.id);
      if (!entry || entry.response) return;
      entry.response = structuredClone(record);
      entry.resolve();
    },
    query(id) {
      const entry = submissions.get(id);
      return entry ? snapshot(entry) : { state: 'not_found' };
    },
    async submit(message, timeoutMs) {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
        throw Object.assign(new Error('Invalid Pi RPC wait limit'), { code: 'INVALID_CONTRACT' });
      }
      if (typeof message.id !== 'string' || !message.id) {
        write(message);
        return { state: 'untracked' };
      }
      const fingerprint = createHash('sha256').update(JSON.stringify(canonical(message))).digest('hex');
      let entry = submissions.get(message.id);
      if (entry && entry.fingerprint !== fingerprint) {
        throw Object.assign(new Error('Pi RPC identity has different parameters'), { code: 'CONFLICT' });
      }
      if (!entry) {
        entry = { fingerprint };
        entry.done = new Promise(resolve => { entry.resolve = resolve; });
        submissions.set(message.id, entry);
        // Register before writing: even a synchronous/very fast response sees
        // the same submission, and a transport failure never unlocks its ID.
        write(message);
      }
      let timer;
      try {
        await Promise.race([entry.done, new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]);
        return snapshot(entry);
      } finally { clearTimeout(timer); }
    },
  };
}

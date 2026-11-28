import { createHash, randomUUID } from 'node:crypto';
import { isSessionQuery, maxSessionQueryBytes } from '../src/protocol/session-queries.js';

function canonical(value: any): any  {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key: any) => [key, canonical(value[key])]));
  return value;
}

type ReadResponse = { type: 'response'; id: string; command: string; success: boolean; [field: string]: unknown };
type ReadResult = { state: 'pending' } | { state: 'complete'; response: ReadResponse };
interface ReadFlight {
  fingerprint: string;
  command: string;
  result: Promise<ReadResult>;
  finish(result: ReadResult): void;
}

// One Worker owns one executor process. Keep submission identities for that entire
// lifetime: evicting a completed or uncertain prompt would permit redelivery.
export function createRpcSubmissions({ write }: any) {
  const submissions = new Map<any, any>();
  const reads = new Map<string, ReadFlight>();
  const nativeReads = new Map<string, ReadFlight>();
  let readsClosed = false;
  const snapshot = (entry: any) => entry.response
    ? { state: 'complete', response: structuredClone(entry.response) } : { state: 'pending' };
  return {
    observe(record: any) {
      if (record.type !== 'response') return;
      if (isSessionQuery(record.command)) {
        const read = nativeReads.get(record.id);
        if (read && read.command === record.command) read.finish({ state: 'complete', response: record });
        return;
      }
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
    closeReads() {
      readsClosed = true;
      for (const read of reads.values()) read.finish({ state: 'pending' });
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
      if (isSessionQuery(message.type)) {
        const id: string = message.id;
        const previous = reads.get(id);
        if (submissions.has(id) || (previous && previous.fingerprint !== fingerprint)) {
          throw Object.assign(new Error('Worker RPC identity has different parameters'), { code: 'CONFLICT' });
        }
        if (previous) return previous.result;
        if (readsClosed) return { state: 'pending' };
        if (reads.size >= 64) throw Object.assign(new Error('Worker Session read capacity reached'), { code: 'CAPACITY_EXCEEDED' });
        const nativeId = randomUUID();
        const result = Promise.withResolvers<ReadResult>();
        const release = () => { clearTimeout(timer); reads.delete(id); nativeReads.delete(nativeId); };
        const flight: ReadFlight = { fingerprint, command: message.type, result: result.promise, finish(reply) {
          release();
          if (reply.state === 'complete') {
            const response = { ...reply.response, id };
            result.resolve({ state: 'complete', response: Buffer.byteLength(JSON.stringify(response)) <= maxSessionQueryBytes
              ? response : { type: 'response', id, command: message.type, success: false, code: 'CAPACITY_EXCEEDED', error: 'Worker Session reply exceeds its byte limit' } });
          } else result.resolve(reply);
        } };
        const timer = setTimeout(() => flight.finish({ state: 'pending' }), Math.min(timeoutMs, 30_000));
        reads.set(id, flight);
        nativeReads.set(nativeId, flight);
        try { write({ ...message, id: nativeId }); }
        catch (error) { release(); throw error; }
        return result.promise;
      }
      let entry = submissions.get(message.id);
      if (reads.has(message.id) || (entry && entry.fingerprint !== fingerprint)) {
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

import { randomUUID } from 'node:crypto';

interface SessionEntry extends Record<string, unknown> {
  id: string;
  parentId?: string | null;
  message?: { role: string; toolCallId?: string; content?: string | { type: string; id?: string }[] };
}

export interface SessionFork {
  entries: SessionEntry[];
}

function invalid(message: string) {
  return Object.assign(new Error(message), { code: 'INVALID_CONTRACT' });
}

// Pi returns one synchronous observation of its native entry tree. Preserve the
// history needed by compaction, with the active leaf ending at a paired tool
// boundary. A running tool group is inherited only after every result exists.
export function snapshotSessionFork({ entries, leafId }: SessionFork & { leafId?: string | null }, privateValues: readonly unknown[] = []) {
  if (!Array.isArray(entries)) throw invalid('Pi Session entries are unavailable');
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const active: SessionEntry[] = [];
  const visited = new Set();
  for (let id = leafId; id; id = byId.get(id)?.parentId) {
    if (!byId.has(id) || visited.has(id)) throw invalid('Pi Session ancestry is invalid');
    visited.add(id);
    active.unshift(byId.get(id)!);
  }
  let safeLeaf = null;
  const pending = new Set<string | undefined>();
  for (const entry of active) {
    const message = entry.message;
    if (message?.role === 'assistant') {
      for (const part of (message.content ?? []) as { type: string; id?: string }[]) {
        if (part.type === 'toolCall') pending.add(part.id);
      }
    }
    if (message?.role === 'toolResult' && !pending.delete(message.toolCallId)) {
      throw invalid('Pi Session has an unmatched tool result');
    }
    if (!pending.size) safeLeaf = entry.id;
  }
  const end = safeLeaf === null ? -1 : entries.findIndex(entry => entry.id === safeLeaf);
  const secrets = [...new Set(privateValues.filter((value): value is string => typeof value === 'string' && value.length > 0))].sort((a, b) => b.length - a.length);
  const redact = (value: any): any => {
    if (typeof value === 'string') {
      for (const secret of secrets) value = value.split(secret).join('[REDACTED]');
      return value;
    }
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
    return value;
  };
  const restore = (target: Record<string, unknown>, source: Record<string, unknown>, keys: readonly string[]) => {
    for (const key of keys) if (Object.hasOwn(source, key)) target[key] = source[key];
  };
  const scrubbed = entries.slice(0, end + 1).map(entry => {
    const copy = redact(entry);
    restore(copy, entry, ['type', 'id', 'parentId', 'timestamp']);
    if (entry.message) {
      restore(copy.message, entry.message, ['role', 'api', 'provider', 'model', 'stopReason', 'toolCallId', 'toolName', 'timestamp']);
      if (Array.isArray(entry.message.content)) {
        entry.message.content.forEach((part, index) => restore(copy.message.content[index], part, ['type', 'id', 'name']));
      }
    }
    return copy;
  });
  const serialized = JSON.stringify(scrubbed);
  if (secrets.some(secret => serialized.includes(secret))) {
    throw Object.assign(new Error('Parent credentials cannot be safely removed from Session metadata'), { code: 'NOT_ALLOWED' });
  }
  return { entries: scrubbed };
}

export function sessionForkText(snapshot: SessionFork, cwd: string) {
  if (!Array.isArray(snapshot?.entries)) throw invalid('Invalid Context Fork Session');
  const header = { type: 'session', version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd };
  return [header, ...snapshot.entries].map(entry => JSON.stringify(entry)).join('\n') + '\n';
}

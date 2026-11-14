import { appendFileSync, closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

const SENSITIVE_KEY = /^(?:content|formal_source|task_instructions|agent_prompt|candidate|proof|stdout|stderr|raw_transcript|authorization|token|secret|password|api[_-]?key|credential|private[_-]?key)$/i;

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function sanitize(value, key = '') {
  if (SENSITIVE_KEY.test(key)) {
    return { redacted: true, sha256: digest(typeof value === 'string' ? value : JSON.stringify(value)) };
  }
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, sanitize(child, childKey)]));
}

export function redactEvent(value) {
  return sanitize(value);
}

/**
 * Append-only NDJSON evidence for one experiment component.
 * Service logs are redacted by default. Agent and checker adapters may opt into
 * raw records, but those files must stay under the private experiment folder.
 */
export class DurableEventLog {
  constructor(filePath, { raw = false, scope = null } = {}) {
    if (typeof filePath !== 'string' || filePath.length === 0) throw new TypeError('filePath is required');
    this.filePath = filePath;
    this.raw = raw;
    this.scope = scope;
    mkdirSync(dirname(filePath), { recursive: true, mode: raw ? 0o700 : 0o755 });
  }

  append(event = {}) {
    const record = {
      timestamp: new Date().toISOString(),
      ...(this.scope ? { scope: this.scope } : {}),
      ...(this.raw ? event : redactEvent(event)),
    };
    const line = `${JSON.stringify(record)}\n`;
    if (!this.raw) {
      appendFileSync(this.filePath, line, 'utf8');
      return;
    }
    const fd = openSync(this.filePath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const state = fstatSync(fd);
      if (!state.isFile() || state.uid !== process.getuid() || state.nlink !== 1) throw new Error('Unsafe private audit log');
      if ((state.mode & 0o777) !== 0o600) fchmodSync(fd, 0o600);
      appendFileSync(fd, line, 'utf8');
    } finally { closeSync(fd); }
  }
}

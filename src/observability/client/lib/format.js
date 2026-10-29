export function shortId(value, length = 12) {
  const text = String(value || '');
  return text.length > length ? `${text.slice(0, length)}…` : text || '—';
}

export function formatNumber(value) {
  return Number(value || 0).toLocaleString();
}

export function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatTime(value, withDate = false) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString([], withDate
    ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }
    : { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '0s';
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export function formatRelative(value, now = Date.now()) {
  if (!value) return '—';
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return '—';
  return formatDuration(Math.max(0, now - time));
}

export function normalizeState(value) {
  return String(value || 'UNKNOWN').toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

export function eventLabel(event) {
  return String(event?.kind || 'observation').replaceAll('_', ' ').replaceAll('.', ' · ');
}

export function conditionLabel(value) {
  return typeof value === 'string' ? value : value && typeof value === 'object'
    ? value.type || value.reason || value.code || 'condition'
    : null;
}

export function compactText(value, maxLength = 240) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

export function readNested(value, keys, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 5) return null;
  for (const key of keys) if (value[key] !== undefined && value[key] !== null) return value[key];
  for (const child of Object.values(value)) {
    const found = readNested(child, keys, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

export function redact(value, key = '', depth = 0) {
  if (/(authorization|api[_-]?key|access[_-]?token|password|private[_-]?key|credential|bearer|cookie|secret|proof|formal[_-]?source|raw[_-]?transcript|task[_-]?instructions|(?:^|[_-])token(?:$|[_-]))/i.test(key)) return '[redacted]';
  if (typeof value === 'string') return value.length <= 4_000 ? value : `${value.slice(0, 4_000)}\n… [display truncated]`;
  if (depth > 6) return '[nested value truncated]';
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redact(item, '', depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redact(child, childKey, depth + 1)]));
}

export function safeJson(value, maxLength = 16_000) {
  let text;
  try { text = JSON.stringify(redact(value), null, 2); } catch { text = String(value); }
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n… [display truncated]` : text;
}

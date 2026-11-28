import { ERROR_CODES, MurmError } from '../../errors.js';

const SECRET_ENVIRONMENT = /(token|secret|passwd|password|api_?key|credential|private_?key)/i;

export function required(value: any, name: any) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} is required`);
  return value;
}


export function envs(value: any, { allowSecrets = false }: any = {}) {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'sandbox env must be an object');
  const result: Record<string, any> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, `sandbox env key is invalid: ${key}`);
    if (!allowSecrets && SECRET_ENVIRONMENT.test(key)) throw new MurmError(ERROR_CODES.NOT_ALLOWED, `sandbox env key is not allowed: ${key}`);
    if (typeof item !== 'string' || item.length > 4096) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, `sandbox env value is invalid: ${key}`);
    result[key] = item;
  }
  return result;
}


const SENSITIVE_FIELD = /(authorization|api[-_]?key|token|secret|password|passwd|credential|private[-_]?key)/i;

export function safeDiagnostic(value: any, depth: any = 0): any {
  if (depth > 3) return '[truncated]';
  if (typeof value === 'string') return value.replace(/(?:bearer\s+|api[-_]?key\s*[=:]\s*)[^\s,;]+/ig, '[redacted]').slice(0, 2_000);
  if (Array.isArray(value)) return value.slice(0, 20).map((item: any) => safeDiagnostic(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, item]: any) => [key, SENSITIVE_FIELD.test(key) ? '[redacted]' : safeDiagnostic(item, depth + 1)]));
  return value;
}


export function safeUrl(value: any) {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '[invalid provider URL]';
  }
}


export function responseValue(body: any) {
  if (!body || typeof body !== 'object') return body;
  return body.result ?? body.data ?? body;
}

import { createHash } from 'node:crypto';
import { ERROR_CODES, MurmError } from '../errors.js';

export const SERVICE_MANIFEST_VERSION = '1';
export const SERVICE_ROLES = Object.freeze(['bound', 'recovery']);
export const SERVICE_TRANSPORTS = Object.freeze(['http-json', 'in-process']);

const ID_PATTERN = /^[a-z][a-z0-9._-]*$/;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9._-]*$/;
const SIDE_EFFECTS = new Set(['read', 'write']);

function isRecord(value: any) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value: any, field: any, { pattern = null }: any = {}) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new MurmError(ERROR_CODES.SERVICE_MANIFEST_INVALID, `${field} is required`, { field, value });
  }
  if (pattern && !pattern.test(value)) {
    throw new MurmError(ERROR_CODES.SERVICE_MANIFEST_INVALID, `${field} has an invalid format`, { field, value });
  }
  return value;
}

function strictSchema(value: any, field: any, { allowOpenObjects = false }: any = {}) {
  const validObject = isRecord(value) && value.type === 'object' && isRecord(value.properties)
    && (value.additionalProperties === false || (allowOpenObjects && value.additionalProperties === true));
  const validArray = isRecord(value) && value.type === 'array' && isRecord(value.items);
  const validPrimitive = isRecord(value) && ['string', 'number', 'integer', 'boolean', 'null'].includes(value.type);
  const validUnion = isRecord(value) && Array.isArray(value.type) && value.type.length > 0
    && value.type.every((type: any) => ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(type));
  if (!validObject && !validArray && !validPrimitive && !validUnion) {
    throw new MurmError(
      ERROR_CODES.SERVICE_MANIFEST_INVALID,
      `${field} must be a strict object JSON Schema`,
      { field, requirement: "strict object, array with items, or primitive JSON Schema" },
    );
  }
  if (value.required !== undefined && (!Array.isArray(value.required) || value.required.some((item: any) => typeof item !== 'string'))) {
    throw new MurmError(ERROR_CODES.SERVICE_MANIFEST_INVALID, `${field}.required must be an array of strings`, { field });
  }
  return structuredClone(value);
}

function normalizeEndpoint(endpoint: any, field: any = 'endpoint') {
  if (!isRecord(endpoint)) throw new MurmError(ERROR_CODES.SERVICE_MANIFEST_INVALID, `${field} is required`, { field });
  const transport = requiredString(endpoint.transport, `${field}.transport`);
  if (!SERVICE_TRANSPORTS.includes(transport)) {
    throw new MurmError(ERROR_CODES.SERVICE_MANIFEST_INVALID, `${field}.transport is unsupported`, { transport, supported: SERVICE_TRANSPORTS });
  }
  if (transport === 'http-json') {
    const url = requiredString(endpoint.url, `${field}.url`);
    let parsed;
    try { parsed = new URL(url); } catch (error: any) {
      throw new MurmError(ERROR_CODES.SERVICE_MANIFEST_INVALID, `${field}.url must be an absolute URL`, { url }, { cause: error });
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new MurmError(ERROR_CODES.SERVICE_MANIFEST_INVALID, `${field}.url must use http or https`, { url });
    }
    return { transport, url: parsed.toString().replace(/\/$/, '') };
  }
  return { transport };
}

function normalizeHelp(help: any, index: any) {
  if (!isRecord(help)) throw new MurmError(ERROR_CODES.SERVICE_MANIFEST_INVALID, `capabilities[${index}].help is required`, { index });
  const text = help.text ?? help.content ?? help.body ?? null;
  if (text !== null && (typeof text !== 'string' || text.trim().length === 0 || text.length > 32 * 1024)) {
    throw new MurmError(ERROR_CODES.SERVICE_MANIFEST_INVALID, `capabilities[${index}].help.text must be a non-empty string no longer than 32 KiB`, { index });
  }
  return {
    when: requiredString(help.when, `capabilities[${index}].help.when`),
    ref: requiredString(help.ref, `capabilities[${index}].help.ref`),
    ...(text === null ? {} : { text }),
  };
}

function normalizeCapability(capability: any, index: any, { allowOpenObjects = false }: any = {}) {
  if (!isRecord(capability)) throw new MurmError(ERROR_CODES.SERVICE_MANIFEST_INVALID, `capabilities[${index}] must be an object`, { index });
  const name = requiredString(capability.name ?? capability.operation, `capabilities[${index}].name`, { pattern: CAPABILITY_PATTERN });
  const description = requiredString(capability.description, `capabilities[${index}].description`);
  const audience = capability.audience ?? capability.roles;
  if (!Array.isArray(audience) || audience.length === 0 || audience.some((role: any) => !SERVICE_ROLES.includes(role))) {
    throw new MurmError(ERROR_CODES.SERVICE_MANIFEST_INVALID, `capabilities[${index}].audience must contain valid roles`, { index, audience, roles: SERVICE_ROLES });
  }
  const sideEffect = capability.side_effect ?? capability.sideEffect;
  if (!SIDE_EFFECTS.has(sideEffect)) throw new MurmError(ERROR_CODES.SERVICE_MANIFEST_INVALID, `capabilities[${index}].side_effect must be read or write`, { index, side_effect: sideEffect });
  if (typeof capability.idempotent !== 'boolean') throw new MurmError(ERROR_CODES.SERVICE_MANIFEST_INVALID, `capabilities[${index}].idempotent must be boolean`, { index });
  const context = capability.context ?? capability.required_context ?? [];
  if (!Array.isArray(context) || context.some((value: any) => !['task', 'execution', 'fencing'].includes(value))) {
    throw new MurmError(ERROR_CODES.SERVICE_MANIFEST_INVALID, `capabilities[${index}].context must contain task, execution, or fencing`, { index, context });
  }
  const path = capability.path ?? `/v1/${name}`;
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('..')) {
    throw new MurmError(ERROR_CODES.SERVICE_MANIFEST_INVALID, `capabilities[${index}].path must be an absolute relative route`, { index, path });
  }
  const method = String(capability.method ?? 'POST').toUpperCase();
  if (!['POST', 'PUT', 'PATCH'].includes(method)) throw new MurmError(ERROR_CODES.SERVICE_MANIFEST_INVALID, `capabilities[${index}].method is unsupported`, { index, method });
  return Object.freeze({
    name,
    operation: requiredString(capability.operation ?? name, `capabilities[${index}].operation`, { pattern: CAPABILITY_PATTERN }),
    description,
    input_schema: strictSchema(capability.input_schema ?? capability.inputSchema, `capabilities[${index}].input_schema`, { allowOpenObjects }),
    output_schema: strictSchema(capability.output_schema ?? capability.outputSchema, `capabilities[${index}].output_schema`, { allowOpenObjects }),
    audience: [...new Set(audience)],
    side_effect: sideEffect,
    idempotent: capability.idempotent,
    context: [...new Set(context)],
    // Capabilities that perform costly or side-effecting domain work must
    // declare that they only run for an authenticated, bound Execution. The
    // declaration is enforced at both the Registry and the HTTP host, so a
    // direct adapter/HTTP call cannot bypass the Agent Bridge gate.
    requires_binding: capability.requires_binding === true,
    scope: capability.scope ?? null,
    help: normalizeHelp(capability.help, index),
    method,
    path,
    errors: Array.isArray(capability.errors) ? structuredClone(capability.errors) : [],
  });
}

function stableStringify(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)!;
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key: any) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function hashManifest(value: any) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function createServiceManifest(input: any, { allowOpenObjects = false }: any = {}) {
  if (!isRecord(input)) throw new MurmError(ERROR_CODES.SERVICE_MANIFEST_INVALID, 'service manifest must be an object');
  const id = requiredString(input.id ?? input.service_id, 'id', { pattern: ID_PATTERN });
  const title = requiredString(input.title ?? input.display_name, 'title');
  const purpose = requiredString(input.purpose, 'purpose');
  const providerVersion = requiredString(input.provider_version ?? input.version, 'provider_version');
  const contractVersion = requiredString(input.contract_version ?? SERVICE_MANIFEST_VERSION, 'contract_version');
  const endpoint = normalizeEndpoint(input.endpoint);
  if (!Array.isArray(input.capabilities) || input.capabilities.length === 0) {
    throw new MurmError(ERROR_CODES.SERVICE_MANIFEST_INVALID, 'capabilities must be a non-empty array');
  }
  const capabilities = input.capabilities.map((capability: any, index: any) => normalizeCapability(capability, index, { allowOpenObjects }));
  const names = new Set();
  const operations = new Set();
  const paths = new Set();
  for (const capability of capabilities) {
    if (names.has(capability.name)) throw new MurmError(ERROR_CODES.SERVICE_MANIFEST_INVALID, `duplicate capability: ${capability.name}`, { capability: capability.name });
    if (operations.has(capability.operation)) throw new MurmError(ERROR_CODES.SERVICE_MANIFEST_INVALID, `duplicate capability operation: ${capability.operation}`, { operation: capability.operation });
    if (paths.has(capability.path)) throw new MurmError(ERROR_CODES.SERVICE_MANIFEST_INVALID, `duplicate capability path: ${capability.path}`, { path: capability.path });
    names.add(capability.name);
    operations.add(capability.operation);
    paths.add(capability.path);
  }
  const manifest = {
    manifest_version: String(input.manifest_version ?? SERVICE_MANIFEST_VERSION),
    service_id: id,
    id,
    title,
    purpose,
    provider_version: providerVersion,
    contract_version: contractVersion,
    endpoint,
    metadata: isRecord(input.metadata) ? structuredClone(input.metadata) : {},
    capabilities,
    health: isRecord(input.health) ? structuredClone(input.health) : { path: '/healthz' },
    readiness: isRecord(input.readiness) ? structuredClone(input.readiness) : { path: '/readyz' },
  };
  (manifest as typeof manifest & { manifest_hash: string }).manifest_hash = hashManifest(manifest);
  return Object.freeze(manifest as typeof manifest & { manifest_hash: string });
}

export function manifestSnapshot(manifest: any) {
  // A registered trusted built-in may intentionally expose an open object
  // contract (for example, structured Task changes). Snapshotting must retain
  // that contract instead of silently narrowing it during HTTP discovery.
  const normalized = createServiceManifest(manifest, { allowOpenObjects: true });
  return structuredClone(normalized);
}

export function stableHash(value: any) {
  return hashManifest(value);
}

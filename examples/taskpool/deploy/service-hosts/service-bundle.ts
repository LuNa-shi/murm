import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ERROR_CODES, MurmError } from '../../errors.js';
import { createServiceManifest } from './service-manifest.js';

export const SERVICE_BUNDLE_MANIFEST = 'service.json';
export const SERVICE_BUNDLE_SKILL = 'SKILL.md';
export const SERVICE_BUNDLE_REFERENCES = 'references';
const MAX_DOCUMENT_BYTES = 256 * 1024;
const MAX_REFERENCE_COUNT = 32;

function invalid(message: any, details: any = undefined) {
  return new MurmError(ERROR_CODES.SERVICE_MANIFEST_INVALID, message, details);
}

function isRecord(value: any) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sha256(text: any) {
  return createHash('sha256').update(text).digest('hex');
}

function containedPath(root: any, candidate: any, field: any) {
  if (typeof candidate !== 'string' || candidate.length === 0) throw invalid(`${field} must be a non-empty relative path`, { field });
  if (candidate.includes('\0') || candidate.includes('\\') || isAbsolute(candidate) || /^[a-z][a-z0-9+.-]*:/i.test(candidate)) {
    throw invalid(`${field} must be a bundle-relative path`, { field, value: candidate });
  }
  const normalized = candidate.replaceAll('/', sep);
  if (normalized.split(sep).includes('..')) throw invalid(`${field} must not traverse outside the service bundle`, { field, value: candidate });
  const target = resolve(root, normalized);
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel)) throw invalid(`${field} escapes the service bundle`, { field, value: candidate });
  return { target, relative: rel.split(sep).join('/') };
}

async function readContainedDocument(root: any, candidate: any, field: any) {
  const { target, relative: resource } = containedPath(root, candidate, field);
  let info;
  try {
    info = await lstat(target);
  } catch (error: any) {
    throw invalid(`${field} does not exist`, { field, value: candidate }, );
  }
  if (info.isSymbolicLink()) {
    const resolved = await realpath(target);
    const rel = relative(root, resolved);
    if (rel.startsWith('..') || isAbsolute(rel)) throw invalid(`${field} must not resolve outside the service bundle`, { field, value: candidate });
    info = await lstat(resolved);
  }
  if (!info.isFile()) throw invalid(`${field} must be a regular file`, { field, value: candidate });
  if (info.size > MAX_DOCUMENT_BYTES) throw invalid(`${field} exceeds the ${MAX_DOCUMENT_BYTES} byte documentation limit`, { field, value: candidate, bytes: info.size });
  const text = await readFile(target, 'utf8');
  if (text.trim().length === 0) throw invalid(`${field} must not be empty`, { field, value: candidate });
  return { resource, path: target, text, sha256: sha256(text), bytes: Buffer.byteLength(text) };
}

async function referenceFiles(root: any, declared: any) {
  if (declared !== undefined && declared !== null) {
    if (!Array.isArray(declared)) throw invalid('documentation.references must be an array');
    if (declared.length > MAX_REFERENCE_COUNT) throw invalid(`documentation.references exceeds ${MAX_REFERENCE_COUNT} files`);
    return [...declared];
  }
  const directory = join(root, SERVICE_BUNDLE_REFERENCES);
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry: any) => entry.isFile() && entry.name.endsWith('.md'))
      .sort((a: any, b: any) => a.name.localeCompare(b.name))
      .slice(0, MAX_REFERENCE_COUNT)
      .map((entry: any) => `${SERVICE_BUNDLE_REFERENCES}/${entry.name}`);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function validateSecretReferences(secretRefs: any) {
  if (secretRefs === undefined || secretRefs === null) return {};
  if (!isRecord(secretRefs)) throw invalid('secret_refs must be an object');
  for (const [name, ref] of Object.entries(secretRefs)) {
    if (typeof ref !== 'string' || !/^env:[A-Z_][A-Z0-9_]*$/.test(ref)) {
      throw invalid('secret_refs values must be deployment references of the form env:NAME', { name, value: ref });
    }
  }
  return { ...secretRefs };
}

function rejectInlineSecrets(manifest: any) {
  const forbidden = /(^|_)(token|secret|passwd|password|api_?key|credential|private_?key|authorization|auth|cookie|access_?key|session_?key|client_?secret)($|_)/i;
  const credentialValue = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/;
  const walk = (value: any, path: any = '') => {
    if (typeof value === 'string' && credentialValue.test(value)) {
      throw invalid('service bundle must not embed a credential; use secret_refs instead', { field: path || 'value' });
    }
    if (!isRecord(value)) return;
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'secret_refs' || key === 'documentation') continue;
      if (forbidden.test(key) && entry !== null && entry !== undefined && entry !== '') {
        throw invalid(`service bundle must not embed a credential; use secret_refs instead`, { field: path ? `${path}.${key}` : key });
      }
      if (isRecord(entry)) walk(entry, path ? `${path}.${key}` : key);
      else if (Array.isArray(entry)) entry.forEach((item: any, index: any) => walk(item, `${path ? `${path}.` : ''}${key}[${index}]`));
      else walk(entry, path ? `${path}.${key}` : key);
    }
  };
  walk(manifest);
}

/**
 * Load and validate one service bundle.
 *
 * The bundle is the deployment unit: a manifest plus reviewed documentation.
 * Required documentation is read and hash-bound before registration, and all
 * paths stay inside the bundle directory. Credentials are rejected outright;
 * only `env:NAME` secret references are accepted.
 */
export async function loadServiceBundle(bundleDir: any, { rootDir = null, manifestOverrides = {} }: any = {}) {
  if (typeof bundleDir !== 'string' || bundleDir.length === 0) throw new TypeError('service bundle directory is required');
  const root = resolve(bundleDir);
  const expectedRoot = rootDir ? resolve(rootDir) : null;
  if (expectedRoot) {
    const rel = relative(expectedRoot, root);
    if (rel.startsWith('..') || isAbsolute(rel)) throw invalid('service bundle directory escapes the configured service root', { bundle: bundleDir });
  }
  let manifestInput;
  try {
    manifestInput = JSON.parse(await readFile(join(root, SERVICE_BUNDLE_MANIFEST), 'utf8'));
  } catch (error: any) {
    if (error?.code === 'ENOENT') throw invalid('service bundle is missing service.json', { bundle: root });
    if (error instanceof SyntaxError) throw invalid('service.json is not valid JSON', { bundle: root });
    throw error;
  }
  if (!isRecord(manifestInput)) throw invalid('service.json must contain an object');
  rejectInlineSecrets(manifestInput);
  const secretRefs = validateSecretReferences(manifestInput.secret_refs);
  const documentation = manifestInput.documentation ?? {};
  if (!isRecord(documentation)) throw invalid('documentation must be an object');
  const skillPath = documentation.skill ?? SERVICE_BUNDLE_SKILL;
  const skill = await readContainedDocument(root, skillPath, 'documentation.skill');
  if (skill.resource !== SERVICE_BUNDLE_SKILL) {
    throw invalid(`SKILL.md must be the bundle-root ${SERVICE_BUNDLE_SKILL}`, { resource: skill.resource });
  }
  const documents = [{ id: 'skill', ...skill }];
  for (const reference of await referenceFiles(root, documentation.references)) {
    const document = await readContainedDocument(root, reference, 'documentation.references');
    documents.push({ id: document.resource, ...document });
  }
  const ids = new Set();
  for (const document of documents) {
    if (ids.has(document.id)) throw invalid(`duplicate documentation resource: ${document.id}`, { resource: document.id });
    ids.add(document.id);
  }
  // Documentation hashes participate in the service manifest hash, binding
  // the reviewed guidance to the exact provider version that was registered.
  const documentationMetadata = documents.map((document: any) => ({
    resource: document.id,
    path: document.resource,
    sha256: document.sha256,
    bytes: document.bytes,
  }));
  const overrides = isRecord(manifestOverrides) ? manifestOverrides : {};
  const manifest = createServiceManifest({
    ...manifestInput,
    ...overrides,
    endpoint: overrides.endpoint ?? manifestInput.endpoint ?? { transport: 'in-process' },
    metadata: {
      ...(isRecord(manifestInput.metadata) ? manifestInput.metadata : {}),
      ...(isRecord(overrides.metadata) ? overrides.metadata : {}),
      documentation: documentationMetadata,
    },
  }, { allowOpenObjects: overrides.allowOpenObjects === true });
  const bundle = {
    service_id: manifest.service_id,
    bundle_dir: root,
    manifest,
    documents,
    secret_refs: secretRefs,
    adapter: isRecord(manifestInput.adapter) ? { ...manifestInput.adapter } : {},
  };
  validateBundleHelpRefs(bundle);
  return bundle;
}

/** Resolve only bundle-owned resources; never a host path or arbitrary URL. */
export function resolveBundleDocument(bundle: any, ref: any) {
  const value = String(ref ?? '');
  if (!value.startsWith('service://')) throw invalid('service documentation ref must be a service:// resource');
  const match = /^service:\/\/([a-z][a-z0-9._-]*)\/(.+)$/.exec(value);
  if (!match) throw invalid('service documentation ref has an invalid resource path', { ref: value });
  if (match[2].startsWith('/') || match[2].split('/').includes('..')) throw invalid('service documentation ref has an invalid resource path', { ref: value });
  if (match[1] !== bundle.service_id) throw invalid('service documentation ref belongs to a different service', { ref: value, service_id: bundle.service_id });
  const resource = match[2];
  const document = bundle.documents.find((candidate: any) => candidate.id === resource || candidate.resource === resource);
  if (!document) {
    const capability = bundle.manifest.capabilities.find((candidate: any) => candidate.name === resource || candidate.operation === resource);
    const text = capability?.help?.text ?? null;
    if (typeof text === 'string' && text.trim().length > 0) {
      return { service_id: bundle.service_id, resource, path: null, text, sha256: sha256(text), manifest_hash: bundle.manifest.manifest_hash };
    }
    throw new MurmError(ERROR_CODES.SERVICE_CAPABILITY_NOT_FOUND, `unknown service documentation resource: ${value}`, { service_id: bundle.service_id, resource });
  }
  return {
    service_id: bundle.service_id,
    resource: document.id,
    path: document.resource,
    text: document.text,
    sha256: document.sha256,
    manifest_hash: bundle.manifest.manifest_hash,
    provider_version: bundle.manifest.provider_version,
  };
}

function validateBundleHelpRefs(bundle: any) {
  for (const capability of bundle.manifest.capabilities) {
    const ref = capability.help?.ref;
    if (typeof ref !== 'string' || !ref.startsWith('service://')) {
      throw invalid('bundled capability help.ref must be a service:// resource', { capability: capability.name, ref: ref ?? null });
    }
    resolveBundleDocument(bundle, ref);
  }
}

export function bundleDocumentationHashes(bundle: any) {
  return bundle.documents.map((document: any) => ({
    resource: document.id,
    path: document.resource,
    sha256: document.sha256,
    bytes: document.bytes,
    provider_version: bundle.manifest.provider_version,
    manifest_hash: bundle.manifest.manifest_hash,
  }));
}

export { sha256 as documentHash };

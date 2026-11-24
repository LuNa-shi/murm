import { isAbsolute, resolve } from 'node:path';
import { SwarmEnvError } from '../errors.js';

/**
 * Errors that identify a Workspace contract failure and include a remediation
 * hint in `details.remediation`.  These are deliberately separate from the
 * generic Service errors: a caller can tell whether it should fix a Task
 * contract, choose a declared output, or retry a read after materialization.
 */
export const WORKSPACE_ERROR_CODES = Object.freeze({
  INPUT_MISSING: 'WORKSPACE_INPUT_MISSING',
  INPUT_READ_ONLY: 'WORKSPACE_INPUT_READ_ONLY',
  INPUT_HASH_MISMATCH: 'WORKSPACE_INPUT_HASH_MISMATCH',
  OUTPUT_NOT_DECLARED: 'WORKSPACE_OUTPUT_NOT_DECLARED',
  // Preserve the repository's existing public NOT_ALLOWED mapping for path
  // traversal while adding the typed path_class/remediation details below.
  PATH_FORBIDDEN: 'NOT_ALLOWED',
});

const META_DIR = '.swarm';
const INTERNAL_RUNTIME_OUTPUTS = Object.freeze(new Set(['.pi/settings.json']));

function requiredString(value: any, field: any) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SwarmEnvError('INVALID_CONTRACT', `${field} is required`);
  }
  return value;
}

/** Normalize a path for contract comparison without resolving it on the host. */
export function normalizeWorkspacePath(value: any, field: any = 'workspace path') {
  const path = requiredString(value, field);
  if (isAbsolute(path) || path.includes('\0')) {
    throw new SwarmEnvError('INVALID_CONTRACT', `${field} must be relative`, {
      path,
      remediation: 'Use a Workspace-relative path declared by the Task contract.',
    });
  }
  const portable = path.replaceAll('\\', '/');
  if (portable.split('/').includes('..')) {
    throw new SwarmEnvError(WORKSPACE_ERROR_CODES.PATH_FORBIDDEN, `${field} cannot address a parent directory`, {
      path,
      path_class: 'forbidden',
      remediation: 'Use a relative path below the current Task Workspace.',
    });
  }
  const normalized = resolve('/', portable).slice(1);
  if (!normalized || normalized === META_DIR || normalized.startsWith(`${META_DIR}/`)) {
    throw new SwarmEnvError(WORKSPACE_ERROR_CODES.PATH_FORBIDDEN, `${field} cannot address Runtime metadata`, {
      path,
      path_class: 'forbidden',
      remediation: 'Use a project input or declared output path; .swarm is Runtime-owned.',
    });
  }
  return normalized;
}

function pathEntries(value: any, field: any) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new SwarmEnvError('INVALID_CONTRACT', `${field} must be an array of paths`);
  }
  return value.map((entry: any, index: any) => {
    if (typeof entry === 'string') return { path: normalizeWorkspacePath(entry, `${field}[${index}]`) };
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new SwarmEnvError('INVALID_CONTRACT', `${field}[${index}] must be a path or path descriptor`);
    }
    const path = normalizeWorkspacePath(entry.path, `${field}[${index}].path`);
    const contentHash = entry.content_hash ?? null;
    if (contentHash !== null && (typeof contentHash !== 'string' || !/^[0-9a-f]{64}$/i.test(contentHash))) {
      throw new SwarmEnvError('INVALID_CONTRACT', `${field}[${index}].content_hash must be a SHA-256 hash`);
    }
    return {
      path,
      ...(contentHash === null ? {} : { content_hash: contentHash.toLowerCase() }),
    };
  });
}

function unique(entries: any, field: any) {
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.path)) throw new SwarmEnvError('INVALID_CONTRACT', `${field} contains duplicate path: ${entry.path}`);
    seen.add(entry.path);
  }
  return entries;
}

/**
 * Convert the Task's workspace description to the small contract consumed by
 * Runtime.  `problem_file` is a canonical required input because existing
 * Putnam tasks use it to identify the locked formalization.  Explicit
 * `required_inputs` and `allowed_outputs` are the extensible contract fields.
 */
export function normalizeWorkspaceContract(workspace: any = {}) {
  if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace)) {
    throw new SwarmEnvError('INVALID_CONTRACT', 'Task workspace contract must be an object');
  }
  const source = workspace;
  const required = pathEntries(source.required_inputs, 'required_inputs');
  if (source.problem_file !== undefined && source.problem_file !== null) {
    const problemPath = normalizeWorkspacePath(source.problem_file, 'workspace.problem_file');
    if (!required.some((entry: any) => entry.path === problemPath)) required.unshift({ path: problemPath });
  }
  const outputsValue = source.allowed_outputs;
  const allowedOutputs = outputsValue === undefined || outputsValue === null
    ? null
    : unique(pathEntries(outputsValue, 'allowed_outputs'), 'allowed_outputs');
  const forbidden = unique(pathEntries(source.forbidden_paths, 'forbidden_paths'), 'forbidden_paths');
  const requiredInputs = unique(required, 'required_inputs');
  const requiredPaths = new Set(requiredInputs.map((entry: any) => entry.path));
  for (const entry of allowedOutputs ?? []) {
    if (requiredPaths.has(entry.path)) {
      throw new SwarmEnvError('INVALID_CONTRACT', `Workspace path cannot be both required input and allowed output: ${entry.path}`);
    }
  }
  for (const entry of forbidden) {
    if (requiredPaths.has(entry.path) || allowedOutputs?.some((output: any) => output.path === entry.path)) {
      throw new SwarmEnvError('INVALID_CONTRACT', `Workspace path cannot be both forbidden and usable: ${entry.path}`);
    }
  }
  return {
    version: String(source.contract_version ?? '1'),
    required_inputs: requiredInputs,
    allowed_outputs: allowedOutputs,
    forbidden_paths: forbidden,
    internal_runtime_outputs: [...INTERNAL_RUNTIME_OUTPUTS],
  };
}

export function workspacePathClass(path: any, contract: any) {
  const normalized = normalizeWorkspacePath(path);
  if (contract?.forbidden_paths?.some((entry: any) => entry.path === normalized)) return 'forbidden';
  if (contract?.required_inputs?.some((entry: any) => entry.path === normalized)) return 'required_input';
  if (INTERNAL_RUNTIME_OUTPUTS.has(normalized)) return 'runtime_internal';
  if (contract?.allowed_outputs === null || contract?.allowed_outputs?.some((entry: any) => entry.path === normalized)) return 'allowed_output';
  return 'undeclared';
}

export function assertReadableWorkspacePath(path: any, contract: any, existingPaths: any = new Set()) {
  const normalized = normalizeWorkspacePath(path);
  const pathClass = workspacePathClass(normalized, contract);
  if (pathClass === 'forbidden') {
    throw new SwarmEnvError(WORKSPACE_ERROR_CODES.PATH_FORBIDDEN, `Workspace path is forbidden: ${normalized}`, {
      path: normalized,
      path_class: pathClass,
      remediation: 'Read a required input or a file listed by workspace_list_files.',
    });
  }
  const required = contract?.required_inputs?.find((entry: any) => entry.path === normalized);
  if (required && !existingPaths.has(normalized)) {
    throw new SwarmEnvError(WORKSPACE_ERROR_CODES.INPUT_MISSING, `Required Workspace input is missing: ${normalized}`, {
      path: normalized,
      path_class: pathClass,
      remediation: 'Fix the Task fixture or Workspace manifest before reading this required input.',
    });
  }
  return normalized;
}

export function validateRequiredWorkspaceInputs(fileManifest: any, contract: any) {
  const files = fileManifest && typeof fileManifest === 'object' ? fileManifest : {};
  for (const input of contract?.required_inputs ?? []) {
    const observed = files[input.path];
    if (!observed) {
      throw new SwarmEnvError(WORKSPACE_ERROR_CODES.INPUT_MISSING, `Required Workspace input is missing: ${input.path}`, {
        path: input.path,
        path_class: 'required_input',
        remediation: 'Fix the Task fixture or Workspace manifest before starting the Execution.',
      });
    }
    if (input.content_hash && observed.content_hash !== input.content_hash) {
      throw new SwarmEnvError(WORKSPACE_ERROR_CODES.INPUT_HASH_MISMATCH, `Required Workspace input hash does not match: ${input.path}`, {
        path: input.path,
        expected_content_hash: input.content_hash,
        observed_content_hash: observed.content_hash,
        remediation: 'Refresh the locked input or update the Task contract to the intended fixture hash.',
      });
    }
  }
  return true;
}

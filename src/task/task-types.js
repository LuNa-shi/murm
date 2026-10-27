import { ERROR_CODES, SwarmEnvError } from '../errors.js';

export const REGISTERED_TASK_TYPES = Object.freeze(['default', 'research', 'proof', 'implementation']);
export const TASK_TYPE_VERSION = '1.0';
// DONE/CLOSED/CANCELED are the simplified lifecycle states. The older
// SATISFIED/CANCELLED spellings and WAITING/FAILED/REJECTED remain readable
// for migrated evidence and compatibility adapters.
export const TASK_STATES = Object.freeze(['OPEN', 'BLOCKED', 'RUNNING', 'DONE', 'CLOSED', 'CANCELED', 'WAITING', 'SATISFIED', 'FAILED', 'CANCELLED', 'REJECTED']);
export const EXECUTION_STATES = Object.freeze(['CREATED', 'RUNNING', 'WAITING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED', 'FENCED', 'SUPERSEDED']);
export const ACTIVE_EXECUTION_STATES = Object.freeze(['CREATED', 'RUNNING', 'WAITING']);
export const TERMINAL_TASK_STATES = Object.freeze(['DONE', 'CLOSED', 'CANCELED', 'SATISFIED', 'FAILED', 'CANCELLED', 'REJECTED']);
export const TERMINAL_EXECUTION_STATES = Object.freeze(['SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED', 'FENCED', 'SUPERSEDED']);

const CONTRACT_KEYS = new Set([
  'required_children', 'required_materials', 'required_candidate', 'required_check', 'parent_review', 'normal_flow',
  'required_branch_groups', 'required_subtask_groups',
]);
const CHECK_KEYS = new Set(['checker_ref', 'checker_version', 'environment_ref', 'input_snapshot_hash']);
const MATERIAL_KEYS = new Set(['kind', 'kinds', 'scope', 'min_count', 'requires_consumption', 'action', 'consumption_action']);
const MATERIAL_CONSUMPTION_ACTIONS = new Set(['route', 'task', 'candidate', 'integration']);
const CANDIDATE_KEYS = new Set(['kind', 'scope']);

function assertPlainObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `${field} must be an object`);
  }
}

function assertNoUnknownKeys(value, allowed, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `${field}.${key} is not supported`);
  }
}

function normalizeMaterials(value) {
  if (!Array.isArray(value)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'required_materials must be an array');
  return value.map((item, index) => {
    assertPlainObject(item, `required_materials[${index}]`);
    assertNoUnknownKeys(item, MATERIAL_KEYS, `required_materials[${index}]`);
    const kinds = item.kinds ?? (item.kind ? [item.kind] : []);
    if (!Array.isArray(kinds) || kinds.length === 0 || kinds.some((kind) => typeof kind !== 'string' || !kind)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `required_materials[${index}] needs kind or kinds`);
    }
    const minCount = item.min_count ?? 1;
    if (!Number.isInteger(minCount) || minCount < 1) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `required_materials[${index}].min_count must be positive`);
    }
    if (item.requires_consumption !== undefined && typeof item.requires_consumption !== 'boolean') {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `required_materials[${index}].requires_consumption must be boolean`);
    }
    if (item.action !== undefined && !MATERIAL_CONSUMPTION_ACTIONS.has(item.action)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `required_materials[${index}].action must be route, task, candidate, or integration`);
    }
    if (item.consumption_action !== undefined && !MATERIAL_CONSUMPTION_ACTIONS.has(item.consumption_action)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `required_materials[${index}].consumption_action must be route, task, candidate, or integration`);
    }
    if (item.action !== undefined && item.consumption_action !== undefined && item.action !== item.consumption_action) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `required_materials[${index}].action and consumption_action must match`);
    }
    const consumptionAction = item.action ?? item.consumption_action;
    if (item.requires_consumption === true && consumptionAction === undefined) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `required_materials[${index}].action is required when requires_consumption is true`);
    }
    return {
      kinds: [...kinds],
      ...(item.scope ? { scope: item.scope } : {}),
      min_count: minCount,
      ...(item.requires_consumption !== undefined ? { requires_consumption: item.requires_consumption } : {}),
      ...(consumptionAction !== undefined ? { action: consumptionAction } : {}),
    };
  });
}

function normalizeCheck(value) {
  assertPlainObject(value, 'required_check');
  assertNoUnknownKeys(value, CHECK_KEYS, 'required_check');
  for (const field of ['checker_ref', 'checker_version']) {
    if (typeof value[field] !== 'string' || !value[field]) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `required_check.${field} is required`);
    }
  }
  return { ...value };
}

function normalizeCandidate(value) {
  if (value === true) return { kind: 'artifact' };
  assertPlainObject(value, 'required_candidate');
  assertNoUnknownKeys(value, CANDIDATE_KEYS, 'required_candidate');
  if (typeof value.kind !== 'string' || !value.kind) {
    throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'required_candidate.kind is required');
  }
  return { ...value };
}

export function validateCompletionContract(contract, { taskType, parentId = null } = {}) {
  assertPlainObject(contract, 'completion_contract');
  assertNoUnknownKeys(contract, CONTRACT_KEYS, 'completion_contract');
  const normalized = {};
  if (contract.required_children !== undefined) {
    if (!Array.isArray(contract.required_children) || contract.required_children.some((id) => typeof id !== 'string' || !id)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'required_children must contain task IDs');
    }
    normalized.required_children = [...new Set(contract.required_children)];
  }
  for (const key of ['required_branch_groups', 'required_subtask_groups']) {
    if (contract[key] === undefined) continue;
    if (!Array.isArray(contract[key]) || contract[key].some((id) => typeof id !== 'string' || !id)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `${key} must contain structure group IDs`);
    }
    normalized[key] = [...new Set(contract[key])];
  }
  if (contract.required_materials !== undefined) normalized.required_materials = normalizeMaterials(contract.required_materials);
  if (contract.required_candidate !== undefined) normalized.required_candidate = normalizeCandidate(contract.required_candidate);
  if (contract.required_check !== undefined) normalized.required_check = normalizeCheck(contract.required_check);
  if (contract.parent_review !== undefined) {
    if (typeof contract.parent_review !== 'boolean') {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'parent_review must be boolean');
    }
    if (contract.parent_review && !parentId) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'parent_review requires a parent task');
    }
    normalized.parent_review = contract.parent_review;
  }
  if (contract.normal_flow !== undefined) {
    if (typeof contract.normal_flow !== 'boolean') {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'normal_flow must be boolean');
    }
    normalized.normal_flow = contract.normal_flow;
  }
  if (normalized.normal_flow === true && normalized.parent_review === true) {
    throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'normal_flow Tasks cannot require parent_review');
  }
  if (taskType === 'proof' && !normalized.required_check) {
    throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'proof tasks require required_check');
  }
  if (normalized.required_check && !normalized.required_candidate) {
    throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'required_check requires required_candidate');
  }
  return normalized;
}

export function defaultCompletionContract(taskType, { parentId = null, requiredCheck = undefined, normalFlow = false } = {}) {
  const parentReview = parentId && !normalFlow ? { parent_review: true } : {};
  const normal = normalFlow ? { normal_flow: true } : {};
  switch (taskType) {
    case 'default':
      return { ...normal, ...parentReview };
    case 'research':
      return {
        ...normal,
        required_materials: [{ kinds: ['fact', 'experience', 'conjecture', 'artifact'], min_count: 1 }],
        ...parentReview,
      };
    case 'proof':
      return {
        ...normal,
        required_candidate: { kind: 'artifact' },
        required_check: requiredCheck ?? { checker_ref: 'lean', checker_version: 'mvp-1' },
      };
    case 'implementation':
      return requiredCheck
        ? { ...normal, required_candidate: { kind: 'artifact' }, required_check: requiredCheck }
        : { ...normal, ...parentReview };
    default:
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown task_type: ${taskType}`);
  }
}

export function prepareTaskContract({ taskType, taskTypeVersion = TASK_TYPE_VERSION, completionContract, parentId = null, requiredCheck, normalFlow = false } = {}) {
  if (!REGISTERED_TASK_TYPES.includes(taskType)) {
    throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `task_type must be one of ${REGISTERED_TASK_TYPES.join(', ')}`);
  }
  if (taskTypeVersion !== TASK_TYPE_VERSION) {
    throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unsupported task_type_version: ${taskTypeVersion}`);
  }
  const defaults = defaultCompletionContract(taskType, { parentId, requiredCheck, normalFlow });
  const selected = completionContract === undefined
    ? defaults
    : (normalFlow && completionContract.normal_flow === undefined ? { ...completionContract, normal_flow: true } : completionContract);
  return validateCompletionContract(selected, { taskType, parentId });
}

export function validateTaskProposal(input, { parentId = null } = {}) {
  if (!input || typeof input !== 'object') throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'task proposal is required');
  for (const field of ['task_type', 'goal', 'expected_output', 'acceptance_conditions']) {
    if (input[field] === undefined || input[field] === null || input[field] === '') {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `${field} is required`);
    }
  }
  if (typeof input.goal !== 'string' || typeof input.expected_output !== 'string') {
    throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'goal and expected_output must be strings');
  }
  if (!input.owner_ref || typeof input.owner_ref !== 'string') {
    throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'owner_ref is required');
  }
  const taskType = input.task_type;
  const taskTypeVersion = input.task_type_version ?? TASK_TYPE_VERSION;
  const completionContract = prepareTaskContract({
    taskType,
    taskTypeVersion,
    completionContract: input.completion_contract,
    parentId,
    requiredCheck: input.required_check,
    normalFlow: input.normal_flow === true || input.completion_contract?.normal_flow === true,
  });
  if (input.parallel_quota !== undefined && (!Number.isInteger(input.parallel_quota) || input.parallel_quota < 1 || input.parallel_quota > 64)) {
    throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'parallel_quota must be an integer between 1 and 64');
  }
  if (input.priority !== undefined && (!Number.isInteger(input.priority) || input.priority < 0)) {
    throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'priority must be a non-negative integer');
  }
  return {
    task_type: taskType,
    task_type_version: taskTypeVersion,
    goal: input.goal,
    expected_output: input.expected_output,
    task_instructions: input.task_instructions ?? input.task_description ?? input.initial_prompt ?? '',
    workspace: input.workspace ?? {},
    acceptance_conditions: input.acceptance_conditions,
    owner_ref: input.owner_ref,
    input_material_refs: input.input_material_refs ?? [],
    completion_contract: completionContract,
    parallel_quota: input.parallel_quota ?? 1,
    priority: input.priority ?? 0,
    max_depth: input.max_depth ?? 8,
    max_children: input.max_children ?? 32,
    max_attempts: input.max_attempts ?? 8,
    retry_policy: input.retry_policy ?? {},
    root_deadline: input.root_deadline ?? null,
  };
}

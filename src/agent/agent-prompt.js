import { createHash } from 'node:crypto';
import { stableStringify } from '../protocol/envelope.js';
import { AGENT_ROLES, capabilityDirectory, profileSnapshot } from './capability-profile.js';

const PROMPT_VERSION = '2';

const SELECTION_SOP = [
  'You are the SwarmEnv Selection Agent for one reusable Core.',
  'Your role is to inspect the bounded claimable Task set and claim exactly one listed Task.',
  'The shortlist attached to this turn is the complete candidate set. Never invent a Task ID or choose outside it.',
  'Read only the Task facts needed to make a justified choice, then call the registered swarmenv_task_claim tool (logical operation task.claim) exactly once.',
  'When claim succeeds, stop this Session immediately. Runtime starts the bound Task Session for the new Execution.',
  'If the list is empty, end as IDLE. Do not create a dependency or keep retrying inside this Session.',
  'If the claim conflicts or a boundary error occurs, end this Session so the Core supervisor can make a fresh bounded attempt.',
].join('\n');

const BOUND_SOP = [
  'You are the SwarmEnv Bound Task Agent for the Task and Execution in this Session.',
  'Runtime has already assigned this Session. Work only on the current Task and its task-scoped Workspace.',
  'This role cannot claim or select another Task. Lease extension, heartbeat, fencing, process control, and raw Execution lifecycle belong to Runtime.',
  'Read the Task contract, current Execution, and Workspace contract before editing. Use only registered capabilities shown below.',
  'When the Mathlib Search capability is present, use mathlib_search before proposing a proof or API research route; verify every returned declaration in the locked project before relying on it.',
  'Create a child only for a genuinely independent, bounded responsibility with a verifiable result; the Task contract decides whether it is required.',
  'Use the registered swarmenv_task_complete tool (logical operation task.complete) when the current completion contract is satisfied. Use swarmenv_task_block (logical operation task.block) with a non-empty typed dependency and checkpoint when external work prevents progress.',
  'Treat structured tool errors as feedback. Do not infer completion from prose or an unverified file.',
].join('\n');

const RECOVERY_SOP = [
  'You are the SwarmEnv Recovery Agent for an already assigned Task and Execution.',
  'Continue from the checkpoint and recovery facts supplied below. Re-read the current Task, Workspace revision, and dependency status before changing work.',
  'This role cannot claim or select another Task and cannot operate Runtime lifecycle controls.',
  'When the Mathlib Search capability is present, use mathlib_search to re-check declarations before revising the proof or API route.',
  'Preserve useful evidence, repair the declared contract, and use swarmenv_task_complete or swarmenv_task_block with the current typed dependency when appropriate.',
].join('\n');

function digest(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function compact(value, fallback = 'none') {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function taskSection(task) {
  if (!task) return 'Task context: supplied by the bound Task capability.';
  return [
    `Task ID: ${task.task_id ?? task.id ?? 'unknown'}`,
    `Goal: ${task.goal ?? 'not supplied'}`,
    `Expected output: ${task.expected_output ?? 'not supplied'}`,
    `Completion contract: ${compact(task.completion_contract ?? task.acceptance_conditions)}`,
    `Allowed inputs: ${compact(task.input_material_refs ?? task.allowed_inputs)}`,
  ].join('\n');
}

function executionSection(execution) {
  if (!execution) return 'Execution context: supplied by Runtime.';
  return [
    `Execution ID: ${execution.execution_id ?? execution.id ?? 'unknown'}`,
    `Workspace revision: ${execution.workspace_revision ?? execution.workspace_snapshot_hash ?? 'current'}`,
  ].join('\n');
}

function workspaceSection(workspace) {
  if (!workspace) return 'Workspace: task-scoped Runtime capability; inspect its declared contract before reading or writing.';
  return [
    `Workspace contract: ${compact(workspace.contract ?? workspace.manifest ?? workspace)}`,
    'Only paths returned by the Workspace index or explicitly declared as allowed outputs may be used.',
  ].join('\n');
}

function recoverySection(recovery) {
  if (!recovery) return 'Recovery: none.';
  return [
    `Recovery reason: ${recovery.reason ?? recovery.rearm_reason ?? 'rearm'}`,
    `Checkpoint: ${compact(recovery.checkpoint)}`,
    `Dependency: ${compact(recovery.dependency)}`,
  ].join('\n');
}

function roleSop(role) {
  if (role === AGENT_ROLES.SELECTION) return SELECTION_SOP;
  if (role === AGENT_ROLES.RECOVERY) return RECOVERY_SOP;
  return BOUND_SOP;
}

/**
 * Compose the deterministic initial prompt from static SOP, Registry profile,
 * Task contract, and Runtime context. The caller can persist the returned
 * hashes alongside Session lifecycle evidence.
 */
export function composeAgentPrompt({ role = AGENT_ROLES.BOUND, profile, task = null, execution = null, workspace = null, recovery = null, staticSop = null } = {}) {
  if (!profile || profile.role !== role) throw new TypeError('composeAgentPrompt requires a profile matching role');
  const sections = [
    staticSop ?? roleSop(role),
    `\nCurrent role: ${role}`,
    `Profile: ${profile.profile_version ?? '1'} / ${profile.profile_hash ?? 'unhashed'}`,
    'Callable capability directory:',
    capabilityDirectory(profile),
  ];
  if (role !== AGENT_ROLES.SELECTION) {
    sections.push(taskSection(task), executionSection(execution), workspaceSection(workspace), recoverySection(recovery));
  } else if (task) {
    sections.push(taskSection(task));
  }
  const prompt = sections.join('\n\n');
  return prompt;
}

export function buildPromptSnapshot(options = {}) {
  const prompt = composeAgentPrompt(options);
  const profile = profileSnapshot(options.profile);
  return {
    prompt,
    prompt_version: PROMPT_VERSION,
    prompt_hash: digest({ prompt_version: PROMPT_VERSION, prompt }),
    profile_hash: profile.profile_hash,
    profile_version: profile.profile_version,
    role: profile.role,
    capabilities: profile.capabilities,
  };
}

export const GENERIC_AGENT_PROMPT = SELECTION_SOP;
export const IDLE_AGENT_PROMPT = SELECTION_SOP;
export const BOUND_AGENT_PROMPT = BOUND_SOP;
export const RECOVERY_AGENT_PROMPT = RECOVERY_SOP;
export { PROMPT_VERSION };

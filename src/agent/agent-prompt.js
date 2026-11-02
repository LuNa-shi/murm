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
  'You are the SwarmEnv Bound Task Agent for the reusable Core identity in this Session.',
  'When no current Execution is present, inspect task_status and call task_take yourself for one claimable Task; never delegate selection to another Agent/session. Once task_take succeeds, continue in the same Session on that Task and Workspace.',
  'When an Execution is already assigned, work only on the current Task and its task-scoped Workspace.',
  'This role cannot claim or select another Task while an Execution is active. Lease extension, heartbeat, fencing, process control, and raw Execution lifecycle belong to Runtime.',
  'Read the Task contract, current Execution, and Workspace contract before editing. Use only registered capabilities shown below.',
  'When the Mathlib Search capability is present, use mathlib_search before proposing a proof or API research route; verify every returned declaration in the locked project before relying on it.',
  'All executable work uses the same ordinary Task model. Search Mission Task summaries and shared Materials before proposing substantial new work; create a Task only for a genuinely independent responsibility with a useful output and acceptance condition, then continue the current Task while progress remains useful.',
  'Publish durable Response, Handoff, or Experience Material as findings become useful. Before unfinished work leaves this Execution, publish Handoff Material with evidence, open questions, and a practical next step.',
  'Use task.create for bounded additional work, task.complete when the current completion contract is satisfied, task.handoff to return unfinished work to the queue, task.block with a non-empty typed dependency and checkpoint when external work prevents progress, and task.close only when accepting a linked Response Material from another Task.',
  'Treat structured tool errors as feedback. Do not infer completion from prose or an unverified file.',
].join('\n');

const RECOVERY_SOP = [
  'You are the SwarmEnv Recovery Agent for an already assigned Task and Execution.',
  'Continue from the checkpoint and recovery facts supplied below. Re-read the current Task, Workspace revision, and dependency status before changing work.',
  'This role cannot claim or select another Task and cannot operate Runtime lifecycle controls.',
  'When the Mathlib Search capability is present, use mathlib_search to re-check declarations before revising the proof or API route.',
  'Preserve useful evidence, publish a Handoff Material when unfinished work must move, and use task.complete, task.handoff, or task.block with the current typed dependency when appropriate.',
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
  const sections = [
    `Task ID: ${task.task_id ?? task.id ?? 'unknown'}`,
    `Goal: ${task.goal ?? 'not supplied'}`,
    `Expected output: ${task.expected_output ?? 'not supplied'}`,
    `Completion contract: ${compact(task.completion_contract ?? task.acceptance_conditions)}`,
    `Allowed inputs: ${compact(task.input_material_refs ?? task.allowed_inputs)}`,
  ];
  if (typeof task.task_instructions === 'string' && task.task_instructions.trim().length > 0) {
    sections.push(`Task instructions: ${task.task_instructions}`);
  }
  return sections.join('\n');
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

function contextSection(title, value) {
  if (value === undefined || value === null || value === '') return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return `\n\n## ${title}\n${text}`;
}

/**
 * Compose the deterministic initial prompt from static SOP, Registry profile,
 * Task contract, and Runtime context. The caller can persist the returned
 * hashes alongside Session lifecycle evidence.
 */
export function composeAgentPrompt({ role = AGENT_ROLES.BOUND, profile = null, task = null, tasks = [], mission = null, materials = [], notifications = [], deadline = null, services = [], execution = null, workspace = null, recovery = null, staticSop = null, staticPrompt = null } = {}) {
  if (profile && profile.role !== role) throw new TypeError('composeAgentPrompt profile must match role');
  const sections = [
    staticSop ?? staticPrompt ?? roleSop(role),
    `\nCurrent role: ${role}`,
    profile ? `Profile: ${profile.profile_version ?? '1'} / ${profile.profile_hash ?? 'unhashed'}` : null,
    profile ? 'Callable capability directory:' : null,
    profile ? capabilityDirectory(profile) : null,
  ];
  if (role !== AGENT_ROLES.SELECTION) {
    sections.push(taskSection(task), executionSection(execution), workspaceSection(workspace), recoverySection(recovery));
  } else if (task) {
    sections.push(taskSection(task));
  }
  sections.push(
    contextSection('Mission', mission),
    contextSection('Mission Task summaries', tasks),
    contextSection('Linked Materials', materials),
    contextSection('Pending notifications', notifications),
    contextSection('Execution deadline', deadline),
    contextSection('Available Services', services),
  );
  const prompt = sections.filter(Boolean).join('\n\n');
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

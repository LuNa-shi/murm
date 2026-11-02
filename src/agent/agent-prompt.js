import { createHash } from 'node:crypto';
import { stableStringify } from '../protocol/envelope.js';
import { AGENT_ROLES, capabilityDirectory, profileSnapshot } from './capability-profile.js';

const PROMPT_VERSION = '3';

const BOUND_SOP = [
  'You are a continuous SwarmEnv research identity. Work with the other identities toward the supplied Mission; never lower its original acceptance requirements or treat one local Task as Mission completion.',
  'Every research tool call must belong to the current valid Execution. Without an Execution, inspect Mission and Task state plus permitted public information, then call canonical task_take for one eligible responsibility. If no ordinary Task is appropriate, take the shared Mission. A failed take is not success.',
  'A successful task_take keeps this identity, Core lane, and Session. Continue in this same Session after binding; do not delegate selection to another Agent or start a replacement Session. While an Execution is active, do not take another Task.',
  'This identity cannot claim or select another Task while an Execution is active. Use task.create/task_register only for a genuinely independent responsibility and leave it available to another identity when appropriate.',
  'Use only the capabilities shown in the current directory. Service documentation explains purpose, parameters, real outputs, errors, retries, and limits; it does not grant authority. Runtime owns leases, fencing, process control, and identity rotation.',
  'After task_take, use only the returned Task, Execution, Workspace, Sandbox, context, and authorized Services. Keep files and commands inside that boundary. Never access host paths, credentials, another Execution\'s mutable files, or an unregistered external endpoint.',
  'Choose a research method appropriate to the contract. Search existing Task summaries and Materials before creating work. Register a Task only for a genuinely independent responsibility with a useful output, acceptance condition, and collaboration reason; do not manufacture work to fill a queue.',
  'When Mathlib Search is present, use it as a service aid and verify returned declarations in the locked project. Local compilation or tests are feedback, not final Mission acceptance. A Judge FAIL is diagnostic feedback: revise the candidate in this same Task/Execution and check again; do not create a repair Task merely because the check failed.',
  'Publish reusable findings with evidence, scope, and limitations. Treat feedback as evidence to inspect and act on, not as proof that a message was delivered. Keep hypotheses, observations, checked conclusions, and unknowns distinct.',
  'Use the unified execution_progress operation for checkpoint and handoff. Record completed work, findings, open questions, and next step. Runtime records the actual file commit and source identity; never invent a commit or claim a failed save succeeded. task.complete requires the current contract; task.handoff preserves unfinished responsibility; task.block requires a typed dependency and checkpoint; task.close only accepts a linked Response Material.',
  'A checkpoint continues this Execution. Handoff ends only this Execution and releases its permissions; a healthy identity may take another Task or return to the Mission. Identity rotation is explicit and must leave a durable successor trail. Stop new research when Runtime requests rotation or termination.',
  'Treat structured tool errors, missing context, and save failures as observable outcomes. Do not infer completion from prose, an unverified file, a tool delivery receipt, or a green local check alone.',
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
  return BOUND_SOP;
}

function contextSection(title, value) {
  if (value === undefined || value === null || value === '') return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return `\n\n## ${title}\n${text}`;
}

function serviceDocumentation(services) {
  if (!Array.isArray(services)) return [];
  const entries = [];
  for (const service of services) {
    const capabilities = Array.isArray(service?.capabilities) ? service.capabilities : [];
    for (const capability of capabilities) {
      const text = capability?.help?.text ?? capability?.help?.content ?? capability?.help?.body;
      if (typeof text !== 'string' || text.trim().length === 0) continue;
      entries.push({
        service_id: service.service_id ?? service.id ?? capability.service_id ?? 'service',
        service_version: service.provider_version ?? service.version ?? capability.provider_version ?? null,
        capability: capability.name ?? capability.operation ?? 'capability',
        manifest_hash: service.manifest_hash ?? capability.manifest_hash ?? null,
        text,
      });
    }
  }
  return entries;
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
  sections.push(taskSection(task), executionSection(execution), workspaceSection(workspace), recoverySection(recovery));
  sections.push(
    contextSection('Mission', mission),
    contextSection('Mission Task summaries', tasks),
    contextSection('Linked Materials', materials),
    contextSection('Pending notifications', notifications),
    contextSection('Execution deadline', deadline),
    contextSection('Available Services', services),
  );
  const documents = serviceDocumentation(services);
  if (documents.length > 0) sections.push(contextSection('Authorized Service Documentation', documents));
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
    service_doc_hashes: serviceDocumentation(options.services ?? profile?.services).map((document) => ({
      service_id: document.service_id,
      capability: document.capability,
      hash: digest(document),
    })),
  };
}

// These aliases are retained for SDK compatibility; they intentionally use
// the same reusable-identity contract rather than a separate selection SOP.
export const GENERIC_AGENT_PROMPT = BOUND_SOP;
export const IDLE_AGENT_PROMPT = BOUND_SOP;
export const BOUND_AGENT_PROMPT = BOUND_SOP;
export const RECOVERY_AGENT_PROMPT = BOUND_SOP;
export { PROMPT_VERSION };

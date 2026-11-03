import { createHash } from 'node:crypto';
import { stableStringify } from '../protocol/envelope.js';
import { AGENT_ROLES, capabilityDirectory, profileSnapshot } from './capability-profile.js';

const PROMPT_VERSION = '3';
// The stable identity contract is delivered through the model's system role
// (Pi 1.3.0 `--append-system-prompt`). Dynamic Mission/Task/Execution context
// stays in the user turn. Keep these versions independent so evidence can
// distinguish a changed runtime contract from a changed task binding.
const SYSTEM_PROMPT_VERSION = '1';

const BOUND_SOP = [
  'You are a continuous SwarmEnv research identity. Work with the other identities toward the supplied Mission; never lower its original acceptance requirements or treat one local Task as Mission completion.',
  'Every research tool call must belong to the current valid Execution. Without an Execution, inspect Mission and Task state plus permitted public information, then call canonical task_take for one eligible responsibility. If no ordinary Task is appropriate, take the shared Mission. A failed take is not success.',
  'A successful task_take keeps this identity, Core lane, and Session. Continue in this same Session after binding; do not delegate selection to another Agent or start a replacement Session. While an Execution is active, do not take another Task.',
  'This identity cannot claim or select another Task while an Execution is active. Use task.create/task_register only for a genuinely independent responsibility and leave it available to another identity when appropriate.',
  'Use only the capabilities shown in the current directory. Service documentation explains purpose, parameters, real outputs, errors, retries, and limits; it does not grant authority. Runtime owns leases, fencing, process control, and identity rotation.',
  'After task_take, use only the returned Task, Execution, Workspace, Sandbox, context, and authorized Services. Keep files and commands inside that boundary. Never access host paths, credentials, another Execution\'s mutable files, or an unregistered external endpoint.',
  'Choose a research method appropriate to the contract. Search existing Task summaries and Materials before creating work. Register a Task only for a genuinely independent responsibility with a useful output, acceptance condition, and collaboration reason; do not manufacture work to fill a queue.',
  'When you claim a shared Mission Task for the first time and identify multiple independent proof approaches or separable subproblems, create bounded child Tasks before deep exploration. When block_task_semantic reports a missing capability or prerequisite that represents separable work, consider whether it should become a child Task rather than repeated claims of the same blocked responsibility. Before a long proof or implementation route, make one explicit decomposition decision: continue the current responsibility, or create bounded direct child Tasks for separable routes. Each child must have a distinct responsibility_key, required capability/workspace boundary, expected output, acceptance condition, and result delivery path. Never create a child or repair Task merely to repeat the same diagnostic or to escape a failed handoff.',
  'When Mathlib Search is present, use it as a service aid and verify returned declarations in the locked project. Local compilation or tests are feedback, not final Mission acceptance. A Judge FAIL is diagnostic feedback: revise the candidate in this same Task/Execution and check again; do not create a repair Task merely because the check failed.',
  'Publish reusable findings with evidence, scope, and limitations. Treat feedback as evidence to inspect and act on, not as proof that a message was delivered. Keep hypotheses, observations, checked conclusions, and unknowns distinct. When a targeted Material notification arrives, inspect the referenced Material and call task_feedback with the decision and next action before changing course.',
  'Use the unified execution_progress operation for checkpoint and handoff. Record completed work, findings, open questions, and next step. Runtime records the actual file commit and source identity; never invent a commit or claim a failed save succeeded. task.complete requires the current contract; task.handoff preserves unfinished responsibility; task.block requires a typed dependency and checkpoint; task.close only accepts a linked Response Material.',
  'A voluntary handoff is a release boundary, not a progress event. Before handing off, leave a substantive increment that a successor can verify: a new candidate or CheckResult, a saved Workspace revision, a distinct checked route, or a reusable cross-Task Material. If the route is unchanged and no new evidence exists, continue the bounded attempt or report the exact capability/external condition; do not produce another equivalent handoff.',
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

function mergedServices(services, profile) {
  const merged = Array.isArray(services) ? [...services] : [];
  for (const service of Array.isArray(profile?.services) ? profile.services : []) {
    const id = service.service_id ?? service.id;
    if (!merged.some((candidate) => (candidate?.service_id ?? candidate?.id) === id)) merged.push(service);
  }
  return merged;
}

function serviceDocumentation(services, capabilities = null) {
  const entries = [];
  const seen = new Set();
  const add = (capability, service = null) => {
    const text = capability?.help?.text ?? capability?.help?.content ?? capability?.help?.body;
    if (typeof text !== 'string' || text.trim().length === 0) return;
    const serviceId = service?.service_id ?? service?.id ?? capability.service_id ?? 'service';
    const name = capability.name ?? capability.operation ?? 'capability';
    const key = `${serviceId}.${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({
      service_id: serviceId,
      service_version: service?.provider_version ?? service?.version ?? capability.provider_version ?? null,
      capability: name,
      manifest_hash: service?.manifest_hash ?? capability.manifest_hash ?? null,
      text,
    });
  };
  // Canonical Registry profiles expose resolved capability objects here. A
  // service's `capabilities` array may instead contain tool-name strings, so
  // never try to read help from those entries.
  if (Array.isArray(capabilities)) for (const capability of capabilities) add(capability);
  if (Array.isArray(services)) {
    for (const service of services) {
      const normalizedService = service?.service_id
        ? service
        : { ...service, service_id: service?.id ?? null };
      for (const capability of Array.isArray(service?.capabilities) ? service.capabilities : []) {
        if (capability && typeof capability === 'object') add(capability, normalizedService);
      }
      // Bundle documentation (SKILL.md and declared references) is mandatory
      // context, not a URL hint. Inject it with the same version binding.
      for (const document of Array.isArray(service?.documentation) ? service.documentation : []) {
        const text = document?.text;
        if (typeof text !== 'string' || text.trim().length === 0) continue;
        const resource = document.resource ?? document.id ?? 'document';
        const key = `${normalizedService.service_id}.${resource}`;
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({
          service_id: normalizedService.service_id,
          service_version: normalizedService.provider_version ?? null,
          capability: resource,
          manifest_hash: normalizedService.manifest_hash ?? null,
          document_sha256: document.sha256 ?? null,
          text,
        });
      }
    }
  }
  return entries;
}

/**
 * Compose the deterministic initial prompt from static SOP, Registry profile,
 * Task contract, and Runtime context. The caller can persist the returned
 * hashes alongside Session lifecycle evidence.
 */
export function composeDynamicAgentPrompt(options = {}) {
  return composeAgentPrompt({ ...options, staticSop: '' });
}

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
  const documents = serviceDocumentation(mergedServices(services, profile), profile?.capabilities);
  if (documents.length > 0) sections.push(contextSection('Authorized Service Documentation', documents));
  const prompt = sections.filter(Boolean).join('\n\n');
  return prompt;
}

export function buildPromptSnapshot(options = {}) {
  const prompt = composeAgentPrompt(options);
  const dynamicPrompt = composeDynamicAgentPrompt(options);
  const profile = profileSnapshot(options.profile);
  const documents = serviceDocumentation(mergedServices(options.services, options.profile), options.profile?.capabilities);
  return {
    prompt,
    prompt_version: PROMPT_VERSION,
    prompt_hash: digest({ prompt_version: PROMPT_VERSION, prompt }),
    system_prompt: SYSTEM_IDENTITY_PROMPT,
    system_prompt_version: SYSTEM_PROMPT_VERSION,
    system_prompt_hash: digest({ system_prompt_version: SYSTEM_PROMPT_VERSION, system_prompt: SYSTEM_IDENTITY_PROMPT }),
    dynamic_prompt_hash: digest({ prompt_version: PROMPT_VERSION, dynamic_prompt: dynamicPrompt }),
    profile_hash: profile.profile_hash,
    profile_version: profile.profile_version,
    role: profile.role,
    capabilities: profile.capabilities,
    service_doc_hashes: documents.map((document) => ({
      service_id: document.service_id,
      service_version: document.service_version,
      capability: document.capability,
      manifest_hash: document.manifest_hash,
      hash: digest(document),
    })),
  };
}

/**
 * Build the exact model inputs for a fresh identity: a stable system-role
 * contract plus the first dynamic user turn. Callers must pass the system
 * prompt to the deployment's system-role mechanism, not send it through the
 * ordinary prompt RPC.
 */
export function buildInitialPromptBundle(options = {}) {
  const snapshot = buildPromptSnapshot(options);
  return {
    system_prompt: snapshot.system_prompt,
    system_prompt_version: snapshot.system_prompt_version,
    system_prompt_hash: snapshot.system_prompt_hash,
    prompt: composeDynamicAgentPrompt(options),
    prompt_version: snapshot.prompt_version,
    prompt_hash: snapshot.dynamic_prompt_hash,
    dynamic_prompt_hash: snapshot.dynamic_prompt_hash,
    profile_hash: snapshot.profile_hash,
    profile_version: snapshot.profile_version,
    role: snapshot.role,
    capabilities: snapshot.capabilities,
    service_doc_hashes: snapshot.service_doc_hashes,
    initial_context: initialContextInventory(options),
  };
}

function initialContextInventory(options = {}) {
  const inventory = [];
  if (options.mission) inventory.push('mission');
  if (Array.isArray(options.tasks) && options.tasks.length > 0) inventory.push('mission_task_summaries');
  if (options.task) inventory.push('task_contract');
  if (options.execution) inventory.push('execution');
  if (options.workspace) inventory.push('workspace');
  if (options.recovery) inventory.push('recovery');
  if (Array.isArray(options.materials) && options.materials.length > 0) inventory.push('linked_materials');
  if (Array.isArray(options.notifications) && options.notifications.length > 0) inventory.push('pending_notifications');
  if (options.deadline) inventory.push('execution_deadline');
  if (Array.isArray(options.services) && options.services.length > 0) inventory.push('available_services');
  if (serviceDocumentation(mergedServices(options.services, options.profile), options.profile?.capabilities).length > 0) inventory.push('authorized_service_documentation');
  return inventory;
}

// These aliases are retained for SDK compatibility; they intentionally use
// the same reusable-identity contract rather than a separate selection SOP.
export const GENERIC_AGENT_PROMPT = BOUND_SOP;
export const IDLE_AGENT_PROMPT = BOUND_SOP;
export const BOUND_AGENT_PROMPT = BOUND_SOP;
export const RECOVERY_AGENT_PROMPT = BOUND_SOP;
export const SYSTEM_IDENTITY_PROMPT = BOUND_SOP;
export { PROMPT_VERSION, SYSTEM_PROMPT_VERSION };

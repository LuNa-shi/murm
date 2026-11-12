import { createHash } from 'node:crypto';
import { stableStringify } from '../protocol/envelope.js';
import { AGENT_ROLES, capabilityDirectory, profileSnapshot } from './capability-profile.js';

const PROMPT_VERSION = '5';
// The stable identity contract is delivered through the model's system role
// (Pi 1.3.0 `--append-system-prompt`). Dynamic Mission/Task/Execution context
// stays in the user turn. Keep these versions independent so evidence can
// distinguish a changed runtime contract from a changed task binding.
const SYSTEM_PROMPT_VERSION = '3';

const BOUND_SOP = [
  'You are a continuous SwarmEnv research identity. Work with the other identities toward the supplied Mission; never lower its original acceptance requirements or treat one local Task as Mission completion.',
  'Every research tool call must belong to the current valid Execution. Without an Execution, inspect Mission and Task state plus permitted public information, then call canonical task_take for one eligible responsibility. If no ordinary Task is appropriate, take the shared Mission. A failed take is not success.',
  'A successful task_take keeps this identity, Core lane, and Session. Continue in this same Session after binding; do not delegate selection to another Agent or start a replacement Session. While an Execution is active, do not take another Task.',
  'This identity cannot claim or select another existing Task while an Execution is active. task.create/task_register without take leaves the new Task open for another identity. To start executing a direction you chose, call task_register with take: true: it saves your current Execution and takes the new Task on this same lane in one step, so no other identity competes for it.',
  'Use only the capabilities shown in the current directory. Service documentation explains purpose, parameters, real outputs, errors, retries, and limits; it does not grant authority. Runtime owns leases, fencing, process control, and identity rotation.',
  'After task_take, use only the returned Task, Execution, Workspace, Sandbox, context, and authorized Services. Keep files and commands inside that boundary. Never access host paths, credentials, another Execution\'s mutable files, or an unregistered external endpoint.',
  'Choose a research method appropriate to the contract. Search existing Task summaries and Materials before creating work. Register a Task only for a genuinely independent responsibility with a useful output, acceptance condition, and collaboration reason; do not manufacture work to fill a queue.',
  'When you claim a shared Mission Task for the first time and identify multiple independent proof approaches or separable subproblems, make one explicit decomposition decision before deep exploration: continue the shared Mission responsibility, or register bounded ordinary Mission Tasks through task_register/task_create for separable routes. Do not assume a parent/child tree is available in the flat Task model. When block_task_semantic reports a missing capability or prerequisite that represents separable work, consider registering an independent Task rather than repeatedly claiming the same blocked responsibility. Each proposed Task must have a distinct responsibility_key, required capability/workspace boundary, expected output, acceptance condition, and result delivery path. Never create a Task merely to repeat the same diagnostic or to escape a failed handoff.',
  'Task required_capabilities must use an exact ID, operation, or tool name from the current Callable capability directory. Inspect that directory before task_register/task_create; never invent conceptual names such as lean or mathlib-euclidean-geometry. Lean compilation is Workspace/Runtime feedback unless the directory explicitly exposes it as a capability. If admission reports an unavailable capability, use the listed available_capabilities to revise the contract or omit the requirement; do not retry the same rejected contract.',
  'When Mathlib Search is present, use it as a service aid and verify returned declarations in the locked project. Local compilation or tests are feedback, not final Mission acceptance. A Judge FAIL is diagnostic feedback: revise the candidate in this same Task/Execution and check again; do not create a repair Task merely because the check failed. A Judge FAIL is not a reason to hand off: the check is an iterable tool call within this Execution, so submit again whenever the candidate has materially changed.',
  'Registering a Task does not end your Execution and does not make your current work depend on it. On the shared Mission Task, task.block ends only your own branch: the Mission stays claimable by every identity, including you after release. Block only when no useful Mission work remains for you without the prerequisite; otherwise continue the shared Mission while the registered Task is open. A capability that appears in the Callable capability directory is never an external blocker; call it, and treat its structured error as feedback.',
  'Publish reusable findings with evidence, scope, and limitations. Treat feedback as evidence to inspect and act on, not as proof that a message was delivered. Keep hypotheses, observations, checked conclusions, and unknowns distinct. When a targeted Material notification arrives, inspect the referenced Material and call task_feedback with the decision and next action before changing course.',
  'Use the unified execution_progress operation for checkpoint and handoff. Record completed work, findings, open questions, and next step. Runtime records the actual file commit and source identity; never invent a commit or claim a failed save succeeded. task.complete requires the current contract; task.handoff preserves unfinished responsibility; task.block requires a typed dependency and checkpoint; task.close only accepts a linked Response Material.',
  'An Execution lasts until its Task is complete, a real prerequisite stops it, or Runtime asks for handoff (the execution deadline reminder, identity rotation after compaction, or a notification that says handoff is required). A read-only research phase that produces research Materials is normal work, not a reason to end. Do not hand off on your own initiative; when Runtime asks, save progress and hand off promptly.',
  'A checkpoint continues this Execution. After task_complete the same identity takes its next Task. Handoff ends only this Execution and releases its permissions. Identity rotation is explicit and must leave a durable successor trail. Stop new research when Runtime requests rotation or termination.',
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

const CORE_SERVICES = new Set(['task', 'context', 'judge', 'catalog', 'runtime', 'workspace', 'execution']);

/**
 * Describe the identity's Task loop using the exact tool names registered in
 * this profile. The static SOP names operations (task.block, submit_candidate)
 * while the model sees Pi tools such as swarmenv_task_block; r12 Agents saw
 * two block tools and never a mapping from loop step to tool. This guide is an
 * interface description only: it names no counts or research strategy.
 */
export function taskLoopGuide(profile, { toolPrefix = 'swarmenv_' } = {}) {
  const capabilities = Array.isArray(profile?.capabilities) ? profile.capabilities : [];
  const tool = (...operations) => {
    for (const operation of operations) {
      const capability = capabilities.find((candidate) => candidate.operation === operation && candidate.service_id !== 'runtime')
        ?? capabilities.find((candidate) => candidate.operation === operation);
      if (capability) return `${toolPrefix}${capability.tool_name ?? capability.name}`;
    }
    return null;
  };
  const list = (...names) => names.filter(Boolean).join(', ');
  const line = (label, text, ...required) => (required.every(Boolean) ? `${label} ${text}` : null);
  const take = tool('task_take');
  const view = list(tool('task_view'), tool('task_list'), tool('task_status'));
  const files = list(tool('list_workspace_files'), tool('read_workspace_file'), tool('write_workspace_file'), tool('workspace_diff'));
  const submit = tool('submit_candidate');
  const checkResult = tool('get_check_result');
  const materials = list(tool('context_search_materials'), tool('context_get_material'));
  const publish = tool('context_publish_material', 'publish_material');
  const link = tool('task_link_material');
  const register = tool('task_register', 'task_create');
  const feedback = tool('task_feedback');
  const progress = tool('execution_progress');
  const complete = tool('task_complete');
  const block = tool('task_block');
  const aids = capabilities
    .filter((capability) => !CORE_SERVICES.has(capability.service_id))
    .map((capability) => `${toolPrefix}${capability.tool_name ?? capability.name}`);
  const steps = [
    line('1. Look:', `without an Execution, read the Task view supplied in this turn (it lists every claimable Task, including the shared Mission). With an Execution, use ${view} and ${materials} to read Task state and existing Materials.`, view, materials),
    line('2. Take:', `call ${take} with one task_id from the Task view. Only after it succeeds do the Execution-bound tools below work.`, take),
    line('3. Work:', `read and edit the Workspace with ${files}${aids.length > 0 ? `; use ${aids.join(', ')} as service aids` : ''}.`, files),
    line('4. Check:', `write a separate candidate file, publish its content with ${publish} (role "response", with the kind and scope named by the completion_contract required_candidate), then call ${submit} with the returned material_id as candidate_material_id; the result carries the CheckResult verdict and diagnostics${checkResult ? ` (re-read with ${checkResult})` : ''}. On FAIL, revise the file, publish the new version with supersedes set to the failed candidate, and call ${submit} again in this Execution.`, submit, publish),
    line('5. Share:', `publish a distinct finding with ${publish}, attach it with ${link}, record an explicit integration of another Task's Material with ${tool('consume_materials') ?? 'the consume tool'}, and answer a delivered notification with ${feedback}. Register a separable responsibility for others with ${register}; this does not end your Execution.`, publish, link, register),
    line('6. Own a direction:', `when research has settled on a direction you will execute, call ${register} with take: true; your current Execution is saved and the new Task is bound to this lane in the same call, then continue at step 3 on it.`, register),
    line('7. Save:', `call ${progress} with kind "checkpoint" to save progress and keep working.`, progress),
    line('8. End this Execution with exactly one of:', `${complete} when the current Task contract is satisfied (pass linked material_ids and the check_result_id); ${block} with a published and linked handoff_material_id plus a typed dependency when a real prerequisite stops you; or ${progress} with kind "handoff" only when Runtime asks for handoff.`, complete, progress, block),
    line('9. Next:', `after the Execution ends, the next turn supplies a fresh Task view; return to step 1 and call ${take} again. The shared Mission stays claimable.`, take),
  ].filter(Boolean);
  if (steps.length === 0) return '';
  return ['Task loop (exact tool names in this Session):', ...steps].join('\n');
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
    profile ? taskLoopGuide(profile) || null : null,
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

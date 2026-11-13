import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENT_ROLES, buildCapabilityProfile } from '../src/agent/capability-profile.js';
import {
  BOUND_AGENT_PROMPT,
  GENERIC_AGENT_PROMPT,
  IDLE_AGENT_PROMPT,
  RECOVERY_AGENT_PROMPT,
  SYSTEM_IDENTITY_PROMPT,
  buildInitialPromptBundle,
  buildPromptSnapshot,
  composeAgentPrompt,
  composeDynamicAgentPrompt,
} from '../src/agent/agent-prompt.js';

const profile = (role) => buildCapabilityProfile({
  role,
  registry: { getCapabilityProfile(currentRole) {
    return { role: currentRole, profileVersion: '1', profileHash: `hash-${currentRole}`, capabilities: [] };
  } },
});

test('static prompts describe bounded decomposition without fixed fanout', () => {
  const prompt = `${GENERIC_AGENT_PROMPT}\n${BOUND_AGENT_PROMPT}\n${IDLE_AGENT_PROMPT}\n${RECOVERY_AGENT_PROMPT}`;
  assert.match(prompt, /genuinely independent|bounded/i);
  assert.match(prompt, /task_finish/);
  assert.match(prompt, /wait_for|task_finish/);
  assert.match(prompt, /task_create/);
  assert.match(prompt, /incomplete/);
  assert.match(prompt, /task_finish/);
  assert.match(prompt, /exact ID.*operation.*tool name/i);
  assert.match(prompt, /available_capabilities/);
  assert.match(prompt, /never invent conceptual names/i);
  assert.doesNotMatch(prompt, /four reusable|two child|three child|select_task|swarmenv_call|request_wait|execution_wait/i);
});

test('prompt states Mission-is-not-taken, Bot boundaries, Judge iteration, and capability semantics', () => {
  const prompt = BOUND_AGENT_PROMPT;
  assert.match(prompt, /Mission itself is never taken/);
  assert.match(prompt, /fresh Bot/);
  assert.match(prompt, /Registering a Task does not end your Execution/);
  assert.match(prompt, /Judge FAIL is not a reason to hand off/);
  assert.match(prompt, /Callable capability directory is never an external blocker/);
  // Phase-one rule: production prompts carry no acceptance-quantity instruction.
  assert.doesNotMatch(prompt, /at least \d|minimum of \d|\d+ (Tasks|checks|Judge calls)/i);
});

test('all prompt aliases describe one reusable identity contract', () => {
  for (const prompt of [GENERIC_AGENT_PROMPT, IDLE_AGENT_PROMPT, BOUND_AGENT_PROMPT, RECOVERY_AGENT_PROMPT]) {
    assert.match(prompt, /task_take/);
    assert.match(prompt, /Session/);
  assert.match(prompt, /cannot take or select/);
    assert.doesNotMatch(prompt, /Selection Agent|Selection Session|task\.claim/i);
  }
});

test('prompt snapshot records the profile hash before the first turn', () => {
  const snapshot = buildPromptSnapshot({ role: AGENT_ROLES.BOUND, profile: profile(AGENT_ROLES.BOUND) });
  assert.equal(snapshot.profile_hash, 'hash-bound');
  assert.equal(snapshot.prompt_hash.length, 64);
  assert.match(snapshot.prompt, /Profile: 1 \/ hash-bound/);
});

test('initial bundle separates the system identity contract from dynamic context', () => {
  const snapshot = buildInitialPromptBundle({
    role: AGENT_ROLES.BOUND,
    profile: profile(AGENT_ROLES.BOUND),
    task: { task_id: 'task-system-1', goal: 'prove the locked theorem' },
  });
  assert.equal(snapshot.system_prompt, SYSTEM_IDENTITY_PROMPT);
  assert.match(snapshot.system_prompt, /SwarmEnv Bot lifecycle/);
  assert.match(snapshot.system_prompt, /task_take/);
  assert.ok(snapshot.system_prompt_hash.length === 64);
  assert.ok(snapshot.prompt_hash.length === 64);
  assert.notEqual(snapshot.prompt_hash, snapshot.system_prompt_hash);
  assert.doesNotMatch(snapshot.prompt, /continuous SwarmEnv research identity/);
  assert.match(snapshot.prompt, /task-system-1/);
  assert.deepEqual(snapshot.initial_context, ['task_contract']);
});

test('profile capability documents are injected even when services expose only names', () => {
  const bound = buildCapabilityProfile({
    role: AGENT_ROLES.BOUND,
    registry: {
      getCapabilityProfile(role) {
        return {
          role,
          profileVersion: '1',
          profileHash: 'hash-docs',
          capabilities: [{
            id: 'research.search', name: 'research_search', operation: 'search',
            service_id: 'research', service_title: 'Research Provider', provider_version: '1.2.3',
            manifest_hash: 'manifest-1', description: 'Search a locked index.',
            audience: ['bound'], side_effect: 'read',
            help: { when: 'Before proposing a route', ref: 'service://research/search', text: 'Search the locked index and verify each hit.' },
            input_schema: { type: 'object', additionalProperties: false },
          }],
        };
      },
    },
  });
  const prompt = composeAgentPrompt({ role: AGENT_ROLES.BOUND, profile: bound });
  assert.match(prompt, /Authorized Service Documentation/);
  assert.match(prompt, /verify each hit/);
  const snapshot = buildPromptSnapshot({ role: AGENT_ROLES.BOUND, profile: bound });
  assert.equal(snapshot.service_doc_hashes.length, 1);
  assert.equal(snapshot.service_doc_hashes[0].manifest_hash, 'manifest-1');
  assert.equal(snapshot.service_doc_hashes[0].service_version, '1.2.3');
});

test('normal Agent prompts do not expose retired structural or lease vocabulary', () => {
  const prompt = [GENERIC_AGENT_PROMPT, BOUND_AGENT_PROMPT, IDLE_AGENT_PROMPT, RECOVERY_AGENT_PROMPT].join('\n');
  for (const term of [
    'create_branch_group', 'add_required_subtask', 'parent_review', 'create_rework_task',
    'execution.heartbeat', 'execution.release', 'execution.fence', 'request_wait',
  ]) {
    assert.doesNotMatch(prompt, new RegExp(term.replace('.', '\\.'), 'i'), `prompt should hide ${term}`);
  }
});

test('dynamic prompt includes only the bounded execution context supplied by Runtime', () => {
  const prompt = composeAgentPrompt({
    mission: { mission_id: 'mission-1', goal: 'solve one problem' },
    task: { task_id: 'task-1', summary: 'derive a useful lemma', state: 'RUNNING' },
    tasks: [{ task_id: 'task-2', summary: 'check a different route', state: 'OPEN' }],
    materials: [{ material_id: 'material-1', role: 'experience' }],
    notifications: [{ type: 'material_available', material_id: 'material-2' }],
    deadline: '2030-01-01T00:30:00.000Z',
    services: [{ name: 'task', tools: ['task_list', 'task_create'] }],
    workspace: { workspace_ref: 'workspace-1', revision: 2 },
  });
  assert.match(prompt, /mission-1/);
  assert.match(prompt, /task-1/);
  assert.match(prompt, /task-2/);
  assert.match(prompt, /material-2/);
  assert.match(prompt, /2030-01-01T00:30:00.000Z/);
  assert.match(prompt, /task_create/);
  assert.match(prompt, /workspace-1/);
});

test('authorized service documentation is injected and hashed with the profile snapshot', () => {
  const services = [{
    service_id: 'mathlib-search', provider_version: '2.1.0', manifest_hash: 'manifest-hash',
    capabilities: [{
      name: 'mathlib_search',
      help: { text: 'Search the locked Mathlib index; verify every declaration in the fixture.' },
    }],
  }];
  const prompt = composeAgentPrompt({ role: AGENT_ROLES.BOUND, services });
  assert.match(prompt, /Authorized Service Documentation/);
  assert.match(prompt, /locked Mathlib index/);
  const snapshot = buildPromptSnapshot({ role: AGENT_ROLES.BOUND, services });
  assert.equal(snapshot.service_doc_hashes.length, 1);
  assert.equal(snapshot.service_doc_hashes[0].service_id, 'mathlib-search');
});

test('task loop guide names one exact registered tool per identity step (r12)', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { ContextService, TaskService } = await import('../src/index.js');
  const { createBuiltinServiceRegistry } = await import('../src/sdk/builtin-registry.js');
  const { runtimeCapabilityList } = await import('../src/runtime/runtime-capabilities.js');
  const { taskLoopGuide } = await import('../src/agent/agent-prompt.js');
  const database = new DatabaseSync(':memory:');
  const contextService = new ContextService(database);
  const taskService = new TaskService(database, { contextService });
  try {
    const registry = createBuiltinServiceRegistry({ taskService, contextService, judgeService: {} });
    // Flat Mission deployments omit the Runtime lifecycle aliases (putnam-runner).
    const flatRuntime = runtimeCapabilityList().filter((capability) => !['runtime.task_finish'].includes(capability.id));
    const bound = buildCapabilityProfile({ role: AGENT_ROLES.BOUND, registry, runtimeCapabilities: flatRuntime });
    const toolNames = bound.capabilities.map((capability) => `swarmenv_${capability.tool_name ?? capability.name}`);
    // One action, one tool: the Runtime alias must not shadow the registered Task capability.
    assert.deepEqual(toolNames.filter((name) => /task_finish$/.test(name)), ['swarmenv_task_finish']);
    assert.deepEqual(toolNames.filter((name) => /task_finish$/.test(name)), ['swarmenv_task_finish']);

    const guide = taskLoopGuide(bound);
    for (const step of ['Look:', 'Take:', 'Work:', 'Check:', 'Share:', 'Save:', 'End this Execution', 'Next:']) assert.match(guide, new RegExp(step));
    const mentioned = guide.match(/swarmenv_[a-z_]+/g);
    for (const name of mentioned) assert.ok(toolNames.includes(name), `${name} must be a registered tool`);
    assert.match(guide, /swarmenv_task_take/);
    assert.match(guide, /swarmenv_judge_workspace_check with its relative path/);
    assert.match(guide, /swarmenv_task_finish with outcome done, incomplete, blocked, or cancelled/);
    assert.match(guide, /fresh Bot reads public/);
    assert.doesNotMatch(guide, /at least \d|minimum of \d|\d+ (Tasks|checks|Judge calls)/i);
    // The guide is part of the profile-bound prompt.
    assert.match(composeAgentPrompt({ role: AGENT_ROLES.BOUND, profile: bound }), /Task loop \(exact tool names in this Session\)/);
  } finally {
    taskService.close();
  }
});

test('prompt keeps one Bot Execution until a lifecycle boundary', () => {
  const prompt = BOUND_AGENT_PROMPT;
  assert.match(prompt, /read-only research phase .* is normal work/);
  assert.match(prompt, /Do not hand off on your own initiative/);
  assert.match(prompt, /task_register with take is not a second-work escape path/);
  assert.match(prompt, /fresh Bot may continue/);
  assert.doesNotMatch(prompt, /voluntary handoff|bounded attempt|substantive increment/i);
  assert.doesNotMatch(prompt, /at least \d|minimum of \d|\d+ (Tasks|checks|Judge calls)/i);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENT_ROLES, buildCapabilityProfile, capabilityDirectory, profileToolNames } from '../src/agent/capability-profile.js';
import { buildPromptSnapshot, composeAgentPrompt } from '../src/agent/agent-prompt.js';
import swarmenvExtension from '../src/agent/swarmenv-extension.mjs';

const capabilities = [
  {
    id: 'task.list_claimable', name: 'task_list_claimable', operation: 'list_claimable_tasks',
    service_id: 'task', service_title: 'Task Service', service_purpose: 'Task selection',
    description: 'List the bounded claimable Task set.', audience: ['selection'], side_effect: false,
    input_schema: { type: 'object', additionalProperties: false }, help: { when: 'Choose only from this bounded list.' },
  },
  {
    id: 'task.claim', name: 'task_claim', operation: 'claim',
    service_id: 'task', service_title: 'Task Service', service_purpose: 'Task selection',
    description: 'Claim one listed Task.', audience: ['selection'], side_effect: true, idempotent: true,
    input_schema: { type: 'object', required: ['task_id'] },
  },
  {
    id: 'geometry.search', name: 'geometry_search_lemmas', operation: 'search_lemmas',
    service_id: 'geometry', service_title: 'Geometry Research', service_purpose: 'Independent research',
    description: 'Find relevant lemmas.', audience: ['bound', 'recovery'], side_effect: false,
    input_schema: { type: 'object', additionalProperties: false }, help: { when: 'Use before proposing a proof route.', ref: 'geometry.help' },
  },
  {
    id: 'runtime.workspace_read', name: 'workspace_read_file', operation: 'read_workspace_file',
    service_id: 'runtime', service_title: 'Task Workspace', service_purpose: 'Current task files',
    description: 'Read an allowed Workspace file.', audience: ['bound', 'recovery'], runtime_owned: true,
    side_effect: false, input_schema: { type: 'object', required: ['path'] },
  },
  {
    id: 'runtime.heartbeat', name: 'runtime_heartbeat', operation: 'heartbeat',
    service_id: 'runtime', service_title: 'Runtime', audience: ['runtime'], runtime_owned: true,
    side_effect: true, input_schema: { type: 'object' },
  },
];

function registry() {
  return {
    getCapabilityProfile(role) {
      const allowed = capabilities.filter((capability) => capability.audience.includes(role));
      return { role, profileVersion: '7', profileHash: `registry-${role}`, capabilities: allowed };
    },
  };
}

test('capability profiles are role-scoped, deterministic, and hashable', () => {
  const selection = buildCapabilityProfile({ role: AGENT_ROLES.SELECTION, registry: registry() });
  const bound = buildCapabilityProfile({ role: AGENT_ROLES.BOUND, registry: registry() });
  const recovery = buildCapabilityProfile({ role: AGENT_ROLES.RECOVERY, registry: registry() });
  assert.deepEqual(profileToolNames(selection), ['task_claim', 'task_list_claimable']);
  assert.deepEqual(profileToolNames(bound), ['geometry_search_lemmas', 'workspace_read_file']);
  assert.deepEqual(profileToolNames(recovery), profileToolNames(bound));
  assert.equal(selection.profile_hash, 'registry-selection');
  assert.equal(buildCapabilityProfile({ role: AGENT_ROLES.BOUND, registry: registry() }).profile_hash, bound.profile_hash);
  assert.doesNotMatch(capabilityDirectory(selection), /Geometry|Workspace|heartbeat/);
  assert.match(capabilityDirectory(bound), /Geometry Research/);
});

test('initial prompt snapshot composes profile, contract, workspace, and recovery context', () => {
  const profile = buildCapabilityProfile({ role: AGENT_ROLES.RECOVERY, registry: registry() });
  const snapshot = buildPromptSnapshot({
    role: AGENT_ROLES.RECOVERY,
    profile,
    task: { task_id: 'task-1', goal: 'prove the theorem', expected_output: 'candidate', completion_contract: { required_check: true } },
    execution: { execution_id: 'exec-1', workspace_revision: 3 },
    workspace: { contract: { required_inputs: ['Problem.lean'], allowed_outputs: ['Candidate.lean'] } },
    recovery: { reason: 'dependency_ready', checkpoint: { phase: 'revise' }, dependency: { kind: 'CHECK_RESULT' } },
  });
  assert.match(snapshot.prompt, /Current role: recovery/);
  assert.match(snapshot.prompt, /prove the theorem/);
  assert.match(snapshot.prompt, /Problem\.lean/);
  assert.match(snapshot.prompt, /dependency_ready/);
  assert.equal(snapshot.profile_hash, profile.profile_hash);
  assert.equal(snapshot.prompt_hash.length, 64);
  assert.doesNotMatch(snapshot.prompt, /swarmenv_call|select_task|request_wait|execution_wait|four reusable|two child/i);
});

test('Pi extension registers only the supplied role profile and no generic transport tool', async () => {
  const profile = buildCapabilityProfile({ role: AGENT_ROLES.BOUND, registry: registry() });
  const tools = [];
  const result = await swarmenvExtension({ registerTool(tool) { tools.push(tool); } }, { profile });
  assert.deepEqual(tools.map((tool) => tool.name), ['swarmenv_geometry_search_lemmas', 'swarmenv_workspace_read_file']);
  assert.ok(!tools.some((tool) => tool.name === 'swarmenv_call'));
  assert.equal(result.profile_hash, profile.profile_hash);
  assert.equal(result.tool_names.length, 2);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENT_ROLES, buildCapabilityProfile, capabilityDirectory, profileToolNames } from '../src/agent/capability-profile.js';
import { buildPromptSnapshot, composeAgentPrompt } from '../src/agent/agent-prompt.js';
import swarmenvExtension from '../src/agent/swarmenv-extension.mjs';

const capabilities = [
  {
    id: 'task.take', name: 'task_take', operation: 'task_take',
    service_id: 'task', service_title: 'Task Service', service_purpose: 'Canonical identity task acquisition',
    description: 'Take one eligible Task on this reusable identity.', audience: ['bound', 'recovery'], side_effect: true, idempotent: true,
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
  const bound = buildCapabilityProfile({ role: AGENT_ROLES.BOUND, registry: registry() });
  const recovery = buildCapabilityProfile({ role: AGENT_ROLES.RECOVERY, registry: registry() });
  assert.deepEqual(profileToolNames(bound), ['geometry_search_lemmas', 'task_take', 'workspace_read_file']);
  assert.deepEqual(profileToolNames(recovery), profileToolNames(bound));
  assert.equal(buildCapabilityProfile({ role: AGENT_ROLES.BOUND, registry: registry() }).profile_hash, bound.profile_hash);
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
  assert.deepEqual(tools.map((tool) => tool.name), ['swarmenv_geometry_search_lemmas', 'swarmenv_workspace_read_file', 'swarmenv_task_take']);
  assert.ok(!tools.some((tool) => tool.name === 'swarmenv_call'));
  assert.equal(result.profile_hash, profile.profile_hash);
  assert.equal(result.tool_names.length, 3);
});

test('every role profile and generated named directory excludes legacy Agent surfaces', () => {
  const legacy = /execution_wait|request_wait|wake(?:_execution)?|parent_review|request_rework|create_rework_task|swarmenv_call/i;
  for (const role of Object.values(AGENT_ROLES)) {
    const profile = buildCapabilityProfile({ role });
    assert.ok(profile.capabilities.length > 0, `${role} profile should have capabilities`);
    assert.ok(profile.capabilities.every((capability) => !legacy.test(JSON.stringify(capability))), role);
    assert.ok(profile.services.every((service) => service.capabilities.every((name) => !legacy.test(name))), role);
    assert.ok(!legacy.test(capabilityDirectory(profile)), role);
  }
});

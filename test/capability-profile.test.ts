import assert from 'node:assert/strict';
import test from 'node:test';
import { createBuiltinServiceRegistry } from '../examples/taskpool/services/builtin-registry.js';
import { AGENT_ROLES, buildCapabilityProfile } from '../test-support/taskpool-legacy/capability-profile.js';

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
  assert.deepEqual(bound.capabilities.map(cap => cap.name).sort(), ['geometry_search_lemmas', 'task_take', 'workspace_read_file']);
  assert.deepEqual(recovery.capabilities.map(cap => cap.name).sort(), bound.capabilities.map(cap => cap.name).sort());
  assert.equal(buildCapabilityProfile({ role: AGENT_ROLES.BOUND, registry: registry() }).profile_hash, bound.profile_hash);
});

test('every role profile excludes legacy Agent surfaces', () => {
  const legacy = /execution_wait|request_wait|wake(?:_execution)?|parent_review|request_rework|create_rework_task|murm_call/i;
  for (const role of Object.values(AGENT_ROLES)) {
    const profile = buildCapabilityProfile({ role, registry: createBuiltinServiceRegistry() });
    assert.ok(profile.capabilities.length > 0, `${role} profile should have capabilities`);
    assert.ok(profile.capabilities.every((capability) => !legacy.test(JSON.stringify(capability))), role);
    assert.ok(profile.services.every((service) => service.capabilities.every((name) => !legacy.test(name))), role);
  }
});

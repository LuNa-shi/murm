import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENT_ROLES, buildCapabilityProfile } from '../src/agent/capability-profile.js';
import {
  BOUND_AGENT_PROMPT,
  GENERIC_AGENT_PROMPT,
  IDLE_AGENT_PROMPT,
  RECOVERY_AGENT_PROMPT,
  buildPromptSnapshot,
  composeAgentPrompt,
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
  assert.match(prompt, /task\.complete/);
  assert.match(prompt, /task\.block/);
  assert.match(prompt, /task\.create/);
  assert.match(prompt, /task\.handoff/);
  assert.match(prompt, /task\.close/);
  assert.doesNotMatch(prompt, /four reusable|two child|three child|select_task|swarmenv_call|request_wait|execution_wait/i);
});

test('all prompt aliases describe one reusable identity contract', () => {
  for (const prompt of [GENERIC_AGENT_PROMPT, IDLE_AGENT_PROMPT, BOUND_AGENT_PROMPT, RECOVERY_AGENT_PROMPT]) {
    assert.match(prompt, /task_take/);
    assert.match(prompt, /same Session/i);
    assert.match(prompt, /cannot claim or select/);
    assert.doesNotMatch(prompt, /Selection Agent|Selection Session|task\.claim/i);
  }
});

test('prompt snapshot records the profile hash before the first turn', () => {
  const snapshot = buildPromptSnapshot({ role: AGENT_ROLES.BOUND, profile: profile(AGENT_ROLES.BOUND) });
  assert.equal(snapshot.profile_hash, 'hash-bound');
  assert.equal(snapshot.prompt_hash.length, 64);
  assert.match(snapshot.prompt, /Profile: 1 \/ hash-bound/);
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

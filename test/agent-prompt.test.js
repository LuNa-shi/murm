import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_ROLES, buildCapabilityProfile } from '../src/agent/capability-profile.js';
import { BOUND_AGENT_PROMPT, GENERIC_AGENT_PROMPT, IDLE_AGENT_PROMPT, RECOVERY_AGENT_PROMPT, buildPromptSnapshot } from '../src/agent/agent-prompt.js';

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
  assert.doesNotMatch(prompt, /four reusable|two child|three child|select_task|swarmenv_call|request_wait|execution_wait/i);
});

test('selection and execution static prompts express opposite ownership boundaries', () => {
  assert.match(GENERIC_AGENT_PROMPT, /claim exactly one/);
  assert.match(GENERIC_AGENT_PROMPT, /task\.claim/);
  assert.match(BOUND_AGENT_PROMPT, /cannot claim or select/);
  assert.match(RECOVERY_AGENT_PROMPT, /cannot claim or select/);
});

test('prompt snapshot records the profile hash before the first turn', () => {
  const snapshot = buildPromptSnapshot({ role: AGENT_ROLES.BOUND, profile: profile(AGENT_ROLES.BOUND) });
  assert.equal(snapshot.profile_hash, 'hash-bound');
  assert.equal(snapshot.prompt_hash.length, 64);
  assert.match(snapshot.prompt, /Profile: 1 \/ hash-bound/);
});

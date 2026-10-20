import test from 'node:test';
import assert from 'node:assert/strict';
import { BOUND_AGENT_PROMPT, GENERIC_AGENT_PROMPT, IDLE_AGENT_PROMPT } from '../src/agent/agent-prompt.js';

test('agent prompts make decomposition a queue and capacity decision without a child quota', () => {
  const prompt = `${GENERIC_AGENT_PROMPT}\n${BOUND_AGENT_PROMPT}\n${IDLE_AGENT_PROMPT}`;
  assert.match(prompt, /four reusable Core slots/);
  assert.match(prompt, /scheduler_status/);
  assert.match(prompt, /task_list with available_only=true/);
  assert.match(prompt, /genuinely independent/);
  assert.match(prompt, /multiple bounded direct child/);
  assert.match(prompt, /Do not create children.*quota|without filling a quota/);
  assert.match(prompt, /If the list is empty, this Core is IDLE/);
  assert.doesNotMatch(prompt, /always create (?:two|three|four|N) children/i);
});

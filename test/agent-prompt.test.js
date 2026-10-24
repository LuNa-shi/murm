import test from 'node:test';
import assert from 'node:assert/strict';
import { BOUND_AGENT_PROMPT, GENERIC_AGENT_PROMPT, IDLE_AGENT_PROMPT } from '../src/agent/agent-prompt.js';

test('agent prompts make decomposition a queue and capacity decision without a child quota', () => {
  const prompt = `${GENERIC_AGENT_PROMPT}\n${BOUND_AGENT_PROMPT}\n${IDLE_AGENT_PROMPT}`;
  assert.match(prompt, /four reusable Core slots/);
  assert.match(prompt, /scheduler_status/);
  assert.match(prompt, /task_list with available_only=true/);
  assert.match(prompt, /genuinely independent/);
  assert.match(prompt, /(?:one or more|multiple) bounded direct child/);
  assert.match(prompt, /Do not create children.*quota|without filling a quota/);
  assert.match(prompt, /(?:If the list contains only waiting responsibilities or is empty, this Core is IDLE|If no Task is claimable, this is IDLE)/);
  assert.doesNotMatch(prompt, /always create (?:two|three|four|N) children/i);
});

test('each Agent prompt teaches the Task structure semantics and rework path', () => {
  for (const [name, prompt] of [['generic', GENERIC_AGENT_PROMPT], ['idle', IDLE_AGENT_PROMPT], ['bound', BOUND_AGENT_PROMPT]]) {
    assert.match(prompt, /create_branch_group/, `${name} prompt should name branch creation`);
    assert.match(prompt, /add_required_subtask/, `${name} prompt should name required subtasks`);
    assert.match(prompt, /get_task_structure|explain_task_readiness/, `${name} prompt should name structure discovery`);
    assert.match(prompt, /create_rework_task/, `${name} prompt should name explicit rework`);
    assert.match(prompt, /alternative|jointly|required|dependency/i, `${name} prompt should explain relationship semantics`);
  }
});

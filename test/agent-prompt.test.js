import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BOUND_AGENT_PROMPT,
  GENERIC_AGENT_PROMPT,
  IDLE_AGENT_PROMPT,
  composeAgentPrompt,
} from '../src/agent/agent-prompt.js';

const prompts = [GENERIC_AGENT_PROMPT, BOUND_AGENT_PROMPT, IDLE_AGENT_PROMPT];

test('Agent prompts describe one flexible Task workflow and progressive Material publication', () => {
  const prompt = prompts.join('\n');
  for (const operation of ['task.create', 'task.complete', 'task.handoff', 'task.block', 'task.close']) {
    assert.match(prompt, new RegExp(operation.replace('.', '\\.'), 'i'), `prompt should explain ${operation}`);
  }
  assert.match(prompt, /search Task summaries/i);
  assert.match(prompt, /publish.*Material.*progressively/i);
  assert.match(prompt, /Response Material/i);
  assert.match(prompt, /Handoff Material/i);
  assert.match(prompt, /Experience Material/i);
  assert.match(prompt, /same Task model/i);
});

test('normal Agent prompts do not expose retired structural or lease vocabulary', () => {
  const prompt = prompts.join('\n');
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
    materials: [{ material_id: 'material-1', role: 'experience' }],
    notifications: [{ type: 'material_available', material_id: 'material-2' }],
    deadline: '2030-01-01T00:30:00.000Z',
    services: [{ name: 'task', tools: ['task_list', 'task_create'] }],
    workspace: { workspace_ref: 'workspace-1', revision: 2 },
  });
  assert.match(prompt, /mission-1/);
  assert.match(prompt, /task-1/);
  assert.match(prompt, /material-2/);
  assert.match(prompt, /2030-01-01T00:30:00.000Z/);
  assert.match(prompt, /task_create/);
  assert.match(prompt, /workspace-1/);
});

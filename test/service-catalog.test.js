import assert from 'node:assert/strict';
import test from 'node:test';
import { listLegacyTools, listServices, listTools, getServiceMetadata } from '../src/sdk/service-catalog.js';
import swarmenvExtension from '../src/agent/swarmenv-extension.mjs';
import { AGENT_ROLES, buildCapabilityProfile } from '../src/agent/capability-profile.js';

test('Service catalog exposes named tools grouped by Service', () => {
  const services = listServices();
  assert.deepEqual(services.map((service) => service.name), ['task', 'execution', 'workspace', 'context', 'judge', 'catalog']);
  const task = getServiceMetadata('task');
  const internalTask = getServiceMetadata('task', { includeInternal: true });
  assert.ok(task.tools.some((tool) => tool.name === 'task_list'));
  assert.ok(task.tools.some((tool) => tool.name === 'task_claim'));
  const structureOperations = [
    'create_branch_group',
    'add_required_subtask',
    'get_task_structure',
    'propose_structure_change',
    'explain_task_readiness',
    'create_rework_task',
  ];
  for (const operation of structureOperations) {
    const tool = internalTask.tools.find((candidate) => candidate.operation === operation);
    assert.ok(tool, `missing catalog tool for ${operation}`);
    assert.match(tool.description, /alternative|jointly|required|dependency|provenance|rework/i);
  }
  assert.match(task.description, /alternative|subtask|dependency|provenance|rework/i);
  assert.ok(listTools('workspace').some((tool) => tool.name === 'workspace_read_file'));
  assert.ok(listTools('workspace').some((tool) => tool.name === 'workspace_write_file'));
  assert.ok(listTools('workspace').every((tool) => tool.service === 'workspace'));
  assert.ok(getServiceMetadata('judge').tools.some((tool) => tool.name === 'judge_get_check_result'));
  assert.ok(getServiceMetadata('catalog').tools.some((tool) => tool.operation === 'get_service_metadata'));
  assert.equal(getServiceMetadata('missing'), null);
});

test('public catalog metadata omits legacy lifecycle and parent-review tools while internal callers retain them', () => {
  const legacy = /execution_wait|request_wait|wake(?:_execution)?|parent_review|request_rework|create_rework_task|swarmenv_call/i;
  const publicTools = listTools();
  assert.ok(publicTools.length > 0);
  assert.ok(publicTools.every((tool) => !legacy.test(`${tool.name} ${tool.operation} ${tool.description}`)));
  assert.ok(!legacy.test(JSON.stringify(listServices())));
  assert.ok(!legacy.test(JSON.stringify(getServiceMetadata('task'))));
  assert.ok(!legacy.test(JSON.stringify(getServiceMetadata('execution'))));

  const internalExecutionTools = listLegacyTools('execution');
  assert.ok(internalExecutionTools.some((tool) => tool.operation === 'request_wait'));
  const internalTaskTools = listLegacyTools('task');
  assert.ok(internalTaskTools.some((tool) => tool.operation === 'request_rework'));
});

test('Pi extension registers only the deterministic role profile', async () => {
  const profile = buildCapabilityProfile({ role: AGENT_ROLES.BOUND });
  const names = [];
  await swarmenvExtension({ registerTool(tool) { names.push(tool.name); } }, { profile });
  assert.deepEqual(names, profile.capabilities.map((tool) => `swarmenv_${tool.name}`));
  assert.ok(names.length > 0);
  assert.ok(!names.includes('swarmenv_call'));
  assert.ok(!names.includes('swarmenv_task_claim'));
});

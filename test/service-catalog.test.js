import assert from 'node:assert/strict';
import test from 'node:test';
import { listServices, listTools, getServiceMetadata } from '../src/sdk/service-catalog.js';
import swarmenvExtension from '../src/agent/swarmenv-extension.mjs';

test('Service catalog exposes named tools grouped by Service', () => {
  const services = listServices();
  assert.deepEqual(services.map((service) => service.name), ['task', 'execution', 'workspace', 'context', 'judge', 'catalog']);
  const task = getServiceMetadata('task');
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
    const tool = task.tools.find((candidate) => candidate.operation === operation);
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

test('Pi extension registers one discoverable tool for every Service operation', () => {
  const names = [];
  swarmenvExtension({ registerTool(tool) { names.push(tool.name); } });
  for (const tool of listTools()) assert.ok(names.includes(`swarmenv_${tool.name}`), tool.name);
  assert.ok(names.includes('swarmenv_catalog_list_services'));
  assert.ok(names.includes('swarmenv_catalog_get_service_metadata'));
  assert.ok(names.includes('swarmenv_catalog_list_tools'));
  assert.ok(names.includes('swarmenv_call'));
});

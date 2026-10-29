import assert from 'node:assert/strict';
import test from 'node:test';
import { listServices, listTools, getServiceMetadata, listLegacyTools } from '../src/sdk/service-catalog.js';
import swarmenvExtension from '../src/agent/swarmenv-extension.mjs';

test('Service catalog exposes the minimal Issue #100 Agent surface', () => {
  const services = listServices();
  assert.deepEqual(services.map((service) => service.name), ['task', 'context', 'judge', 'catalog']);
  const task = getServiceMetadata('task');
  for (const name of ['task_list', 'task_view', 'task_create', 'task_link_material', 'task_complete', 'task_handoff', 'task_block', 'task_close']) {
    assert.ok(task.tools.some((tool) => tool.name === name), `missing catalog tool for ${name}`);
  }
  const context = getServiceMetadata('context');
  for (const name of ['context_search_materials', 'context_get_material', 'context_publish_material']) {
    assert.ok(context.tools.some((tool) => tool.name === name), `missing catalog tool for ${name}`);
  }
  assert.equal(getServiceMetadata('workspace'), null, 'Workspace is attached to Task/Runtime, not a standalone Service');
  assert.ok(listTools('task').some((tool) => tool.name === 'workspace_read_file' && tool.capability === 'workspace'));
  assert.ok(listTools('task').some((tool) => tool.name === 'workspace_write_file' && tool.capability === 'workspace'));
  assert.ok(getServiceMetadata('judge').tools.some((tool) => tool.name === 'judge_get_check_result'));
  assert.equal(getServiceMetadata('execution'), null);
  assert.equal(getServiceMetadata('missing'), null);
  assert.ok(listLegacyTools('task').some((tool) => tool.name === 'task_create_branch_group'));
});

test('Pi extension registers one discoverable tool for every public Service operation', () => {
  const names = [];
  swarmenvExtension({ registerTool(tool) { names.push(tool.name); } });
  for (const tool of listTools()) assert.ok(names.includes(`swarmenv_${tool.name}`), tool.name);
  assert.ok(names.includes('swarmenv_catalog_list_services'));
  assert.ok(names.includes('swarmenv_catalog_get_service_metadata'));
  assert.ok(names.includes('swarmenv_catalog_list_tools'));
  assert.ok(names.includes('swarmenv_call'));
  assert.equal(names.includes('swarmenv_task_create_branch_group'), false);
  assert.equal(names.includes('swarmenv_execution_heartbeat'), false);
});

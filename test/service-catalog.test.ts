import assert from 'node:assert/strict';
import test from 'node:test';
import { listServices, listTools, getServiceMetadata } from '../examples/taskpool/services/service-catalog.js';

test('Service catalog keeps internal ownership metadata and exposes the Task surface', () => {
  const services = listServices();
  assert.deepEqual(services.map((service) => service.name), ['task', 'execution', 'workspace', 'context', 'judge', 'catalog']);
  const task = getServiceMetadata('task');
  assert.equal(new Set(task.tools.map((tool) => tool.name)).size, task.tools.length);
  for (const name of ['task_list', 'task_view', 'task_create', 'task_link_material', 'task_finish']) {
    assert.ok(task.tools.some((tool) => tool.name === name), `missing public semantic tool ${name}`);
  }
  assert.ok(task.tools.some((tool) => tool.name === 'task_list'));
  const taskCreate = task.tools.find((tool) => tool.name === 'task_create');
  assert.ok(taskCreate.parameters.properties.responsibility_key);
  assert.ok(taskCreate.parameters.properties.completion_contract);
  assert.ok(taskCreate.parameters.properties.input_material_refs);
  const context = getServiceMetadata('context');
  for (const name of ['context_search_materials', 'context_get_material', 'context_publish_material']) {
    assert.ok(context.tools.some((tool) => tool.name === name), `missing context tool ${name}`);
  }
  assert.deepEqual(listTools('workspace'), []);
  assert.deepEqual(listTools('execution'), []);
  assert.ok(getServiceMetadata('judge').tools.some((tool) => tool.name === 'judge_get_check_result'));
  assert.ok(getServiceMetadata('catalog').tools.some((tool) => tool.operation === 'get_service_metadata'));
  assert.equal(getServiceMetadata('missing'), null);
  const removed = new Set(['create_child_task', 'create_branch_group', 'request_rework', 'request_wait']);
  assert.ok(listTools(null, { includeInternal: true }).every((tool) => !removed.has(tool.operation)));
});

test('public and internal catalog metadata both omit retired lifecycle and parent-review tools', () => {
  const legacy = /execution_wait|request_wait|wake(?:_execution)?|parent_review|request_rework|create_rework_task|murm_call/i;
  const publicTools = listTools();
  assert.ok(publicTools.length > 0);
  assert.ok(publicTools.every((tool) => !legacy.test(`${tool.name} ${tool.operation} ${tool.description}`)));
  assert.ok(!legacy.test(JSON.stringify(listServices())));
  assert.ok(!legacy.test(JSON.stringify(getServiceMetadata('task'))));
  assert.ok(!legacy.test(JSON.stringify(getServiceMetadata('execution'))));
  assert.ok(!legacy.test(JSON.stringify(listTools(null, { includeInternal: true }))));
});

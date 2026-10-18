import assert from 'node:assert/strict';
import test from 'node:test';
import { listServices, listTools, getServiceMetadata } from '../src/sdk/service-catalog.js';
import swarmenvExtension from '../src/agent/swarmenv-extension.mjs';

test('Service catalog exposes named tools grouped by Service', () => {
  const services = listServices();
  assert.deepEqual(services.map((service) => service.name), ['task', 'execution', 'workspace', 'context', 'judge']);
  const task = getServiceMetadata('task');
  assert.ok(task.tools.some((tool) => tool.name === 'task_list'));
  assert.ok(task.tools.some((tool) => tool.name === 'task_claim'));
  assert.ok(listTools('workspace').every((tool) => tool.service === 'workspace'));
  assert.equal(getServiceMetadata('missing'), null);
});

test('Pi extension registers one discoverable tool for every Service operation', () => {
  const names = [];
  swarmenvExtension({ registerTool(tool) { names.push(tool.name); } });
  for (const tool of listTools()) assert.ok(names.includes(`swarmenv_${tool.name}`), tool.name);
  assert.ok(names.includes('swarmenv_list_services'));
  assert.ok(names.includes('swarmenv_list_tools'));
  assert.ok(names.includes('swarmenv_call'));
});

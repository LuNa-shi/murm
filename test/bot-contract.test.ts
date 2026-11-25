import test from 'node:test';
import assert from 'node:assert/strict';
import { botServiceDirectory } from '../src/agent/bot-contract.js';

test('startup service directory names real CLI namespaces and excludes internal Runtime metadata', () => {
  const directory = botServiceDirectory({ services: ['task', 'context', 'catalog', 'runtime', 'judge', 'mathlib-search'].map(service_id => ({ service_id, provider_version: '1' })) });
  assert.deepEqual(directory.map(item => item.name), ['mission', 'task', 'workspace', 'bot', 'material', 'service', 'judge', 'mathlib-search']);
  assert.ok(directory.every(item => !item.help.includes('view runtime')));
  assert.equal(directory.find(item => item.name === 'material').manifest_help, 'swarm service view context --json');
});

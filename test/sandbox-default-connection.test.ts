import assert from 'node:assert/strict';
import test from 'node:test';
import { createSandbox, resolveSandboxConnection } from '../src/core/index.js';

test('Sandbox accepts the default settings and a single endpoint alias', () => {
  assert.doesNotThrow(() => createSandbox());
  assert.equal(resolveSandboxConnection({ endpoint: 'https://sandbox.example.test/team/' }).lifecycleBaseUrl,
    'https://sandbox.example.test/team/v1');
  assert.doesNotThrow(() => createSandbox({
    endpoint: 'https://sandbox.example.test/team/', lifecycleBaseUrl: 'https://sandbox.example.test/team/v1',
  }));
  assert.throws(() => createSandbox({
    endpoint: 'https://sandbox.example.test/team/', lifecycleBaseUrl: 'https://sandbox.example.test/other/v1',
  }), /endpoint.*lifecycleBaseUrl/i);
});

test('Sandbox rejects removed exact Workspace quota and endpoint rewriting before allocation', () => {
  assert.throws(() => createSandbox({
    endpoint: 'https://example.test', isolation: { network: 'local-docker', disk: { bytes: 1024, inodes: 10 } },
  }), /inode/i);
  assert.throws(() => createSandbox({
    endpoint: 'https://example.test', endpointHost: 'localhost',
  }), /publish.*endpoint/i);
});

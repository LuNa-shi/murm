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

test('an explicit endpoint can replace a malformed saved connection', async t => {
  const [{ mkdtemp, mkdir, writeFile, rm }, { tmpdir }, { join }, { spawnSync }] = await Promise.all([
    import('node:fs/promises'), import('node:os'), import('node:path'), import('node:child_process'),
  ]);
  const home = await mkdtemp(join(tmpdir(), 'murm-connection-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const config = join(home, '.config', 'murm');
  await mkdir(config, { recursive: true });
  await writeFile(join(config, 'opensandbox.json'), '{invalid', { mode: 0o600 });
  const resolver = new URL('../src/core/sandbox/sandbox-connection.js', import.meta.url);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { resolveSandboxConnection } from ${JSON.stringify(resolver.href)};
    assert.throws(() => resolveSandboxConnection(), /Saved OpenSandbox connection is invalid/);
    assert.equal(resolveSandboxConnection({ endpoint: 'https://replace.example.test' }).lifecycleBaseUrl,
      'https://replace.example.test/v1');
  `], { env: { HOME: home }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

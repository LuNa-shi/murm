import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { renderStartupPrompt } from '../src/core/startup-prompt.js';
import { notesManifest, setup } from './fixtures/core-notes-service.js';
const execute = promisify(execFile);

test('public Bash CLI discovers permitted operations, renders manifest help and invokes with a stable request ID', async t => {
  let saved;
  const { bridge, credentials, bot } = await setup(t, { invoke({ input, caller, capability, envelope }) {
    assert.equal(envelope.operation_id, 'cli-write');
    if (capability.operation === 'put') saved = { ...input, author: caller.botId };
    return saved ?? null;
  } });
  const env = { ...process.env, ...credentials.environment, ...credentials.secretEnvironment };
  const cli = (...args) => execute(process.execPath, ['dist/scripts/swarm.js', ...args], { env, timeout: 5000 });
  const discovery = JSON.parse((await cli('service', 'view', 'notes')).stdout);
  assert.deepEqual(discovery.capabilities.map(item => item.operation), ['put', 'get']);
  const help = (await cli('notes', 'put', '--help')).stdout;
  assert.match(help, /Usage: swarm notes put \[--input <json-file> \| --stdin\]/);
  assert.match(help, /Use an actual input schema property name as a flag/);
  assert.doesNotMatch(help, /--field/);
  assert.match(help, /Publish a fixed note/);
  assert.match(help, /maxLength/);
  assert.match(help, /idempotent/);
  const written = JSON.parse((await cli('notes', 'put', '--key', 'one', '--text', 'fixed', '--request-id', 'cli-write')).stdout);
  assert.deepEqual(written, { key: 'one', text: 'fixed', author: 'bot-one' });
  bot.services.notes = ['get'];
  const manifests = JSON.parse((await cli('service', 'list')).stdout).services;
  assert.deepEqual(manifests, bridge.visibleServices(bot.services));
  const system = renderStartupPrompt(manifests, '  ');
  assert.equal(system.match(/<services>/g)?.length, 1);
  assert.match(system, /swarm notes get/);
  assert.doesNotMatch(system, /swarm notes put|<added_system_prompt>/);
  assert.deepEqual(JSON.parse((await cli('service', 'view', 'notes')).stdout).capabilities.map(item => item.operation), ['get']);
  await assert.rejects(cli('notes', 'put', '--key', 'one', '--text', 'changed', '--request-id', 'forbidden'));
  assert.equal(saved.text, 'fixed');
});

test('registered operations in a known command group can run exactly as advertised at startup', async t => {
  const manifest = notesManifest('task');
  manifest.capabilities = [
    { ...manifest.capabilities[1], operation: 'other_read', name: 'custom_read', description: 'A different operation.' },
    { ...manifest.capabilities[1], operation: 'custom_read', name: 'read_extra' },
  ];
  const { bridge, credentials, bot } = await setup(t, { invoke({ input, caller, capability }) {
    assert.equal(capability.operation, 'custom_read');
    return { key: input.key, text: 'fixed', author: caller.botId };
  } }, { manifest });
  bot.services = { task: ['other_read', 'custom_read'] };
  const system = renderStartupPrompt(bridge.visibleServices(bot.services));
  const advertised = system.match(/`swarm (task custom_read)`/)?.[1].split(' ');
  assert.deepEqual(advertised, ['task', 'custom_read']);
  const env = { ...process.env, ...credentials.environment, ...credentials.secretEnvironment };
  const cli = (...args) => execute(process.execPath, ['dist/scripts/swarm.js', ...args], { env, timeout: 5000 });
  const operationHelp = (await cli(...advertised, '--help')).stdout;
  assert.match(operationHelp, /Input schema/);
  assert.doesNotMatch(operationHelp, /A different operation/);
  assert.deepEqual(JSON.parse((await cli(...advertised, '--key', 'one')).stdout), { key: 'one', text: 'fixed', author: 'bot-one' });
  const offline = { ...env, SWARMENV_BRIDGE_TOKEN: '', SWARMENV_BRIDGE_URL: 'http://127.0.0.1:1' };
  const { stdout } = await execute(process.execPath, ['dist/scripts/swarm.js', 'task', '--help'], { env: offline, timeout: 1000 });
  assert.match(stdout, /Usage: swarm task/);
});

for (const [id, operation] of [['service', 'get'], ['material', 'get'], ['mission', 'submission']]) {
  test(`startup command can address registered ${id}/${operation} without CLI aliasing`, async t => {
    const manifest = notesManifest(id);
    manifest.capabilities = [{ ...manifest.capabilities[1], operation }];
    const { bridge, credentials, bot } = await setup(t, { invoke({ input }) {
      return { key: input.key, text: 'fixed', author: 'bot-one' };
    } }, { manifest });
    bot.services = { [id]: [operation] };
    const system = renderStartupPrompt(bridge.visibleServices(bot.services));
    const advertised = system.match(/`swarm (service invoke [^`]+)`/)?.[1].split(' ');
    assert.deepEqual(advertised, ['service', 'invoke', id, operation]);
    const env = { ...process.env, ...credentials.environment, ...credentials.secretEnvironment };
    const cli = (...args) => execute(process.execPath, ['dist/scripts/swarm.js', ...args], { env, timeout: 5000 });
    assert.match((await cli(...advertised, '--help')).stdout, /Input schema/);
    assert.deepEqual(JSON.parse((await cli(...advertised, '--key', 'one')).stdout), { key: 'one', text: 'fixed', author: 'bot-one' });
  });
}

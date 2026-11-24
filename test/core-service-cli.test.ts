import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { setup } from './fixtures/core-notes-service.js';
const execute = promisify(execFile);

test('public Bash CLI discovers permitted operations, renders manifest help and invokes with a stable request ID', async t => {
  let saved;
  const { credentials, bot } = await setup(t, { invoke({ input, caller, capability, envelope }) {
    assert.equal(envelope.operation_id, 'cli-write');
    if (capability.operation === 'put') saved = { ...input, author: caller.botId };
    return saved ?? null;
  } });
  const env = { ...process.env, ...credentials.environment, ...credentials.secretEnvironment };
  const cli = (...args) => execute(process.execPath, ['dist/scripts/swarm.js', ...args], { env, timeout: 5000 });
  const discovery = JSON.parse((await cli('service', 'view', 'notes')).stdout);
  assert.deepEqual(discovery.capabilities.map(item => item.operation), ['put', 'get']);
  const help = (await cli('notes', 'put', '--help')).stdout;
  assert.match(help, /Publish a fixed note/);
  assert.match(help, /maxLength/);
  assert.match(help, /idempotent/);
  const written = JSON.parse((await cli('notes', 'put', '--key', 'one', '--text', 'fixed', '--request-id', 'cli-write')).stdout);
  assert.deepEqual(written, { key: 'one', text: 'fixed', author: 'bot-one' });
  bot.services.notes = ['get'];
  assert.deepEqual(JSON.parse((await cli('service', 'view', 'notes')).stdout).capabilities.map(item => item.operation), ['get']);
  await assert.rejects(cli('notes', 'put', '--key', 'one', '--text', 'changed', '--request-id', 'forbidden'));
  assert.equal(saved.text, 'fixed');
});

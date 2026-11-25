import assert from 'node:assert/strict';
import test from 'node:test';
import { DockerBotDisk } from '../src/runtime/docker-bot-disk.js';
import { openSandboxBotKey, openSandboxMissionKey } from '../src/runtime/opensandbox-metadata.js';

const bot = { bot_id: 'bot:test', mission_id: 'mission:test', resource_key: 'bot:resource' };
const sandboxId = 'test-sandbox';
const containerId = 'a'.repeat(64);

function fixture({ foreign = false, replaced = false } = {}) {
  const calls = [];
  const disk = new DockerBotDisk({ execute: async (command, args) => {
    calls.push([command, ...args]);
    if (command === 'sudo') return { stdout: '' };
    const identity = {
      id: containerId,
      pid: 3412,
      started: replaced && calls.length === 3 ? 'new' : 'old',
      running: true,
      labels: {
        'opensandbox.io/id': sandboxId,
        mission_key: openSandboxMissionKey(foreign ? 'mission:foreign' : bot.mission_id),
        bot_key: openSandboxBotKey(bot.bot_id),
        resource_key: openSandboxBotKey(bot.resource_key),
      },
    };
    return { stdout: JSON.stringify(identity) };
  } });
  return { disk, calls };
}

test('Bot disk quota matches the exact provider identity before and after mounting', async () => {
  const { disk, calls } = fixture();
  assert.deepEqual(await disk.isolate({ sandboxId, bot }), { bytes: 268435456, inodes: 16384 });
  assert.equal(calls[0].at(-1), 'sandbox-test-sandbox');
  assert.deepEqual(calls[1].slice(-4), ['3412', containerId, '268435456', '16384']);
  assert.equal(calls[2].at(-1), containerId);
});

test('Bot disk quota refuses a foreign or replaced container', async () => {
  const foreign = fixture({ foreign: true });
  await assert.rejects(foreign.disk.isolate({ sandboxId, bot }), /identity does not match/);
  assert.equal(foreign.calls.length, 1);
  const changed = fixture({ replaced: true });
  await assert.rejects(changed.disk.isolate({ sandboxId, bot }), /changed during disk isolation/);
  assert.throws(() => new DockerBotDisk({ bytes: 0 }), /quota/);
  assert.throws(() => new DockerBotDisk({ inodes: Infinity }), /quota/);
});

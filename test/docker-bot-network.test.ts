import assert from 'node:assert/strict';
import test from 'node:test';
import { BOT_UID } from '../scripts/sandbox-project.js';
import { DockerBotNetwork } from '../src/runtime/docker-bot-network.js';
import { openSandboxBotKey, openSandboxMissionKey } from '../src/runtime/opensandbox-metadata.js';

const bot = { bot_id: 'bot:1', mission_id: 'mission:1', resource_key: 'bot:1' };
const sandboxId = 'sandbox-identity';
const containerId = 'a'.repeat(64);
const folder = '/tmp/swarmenv-netns.ABCDEFG123';
const pin = `${folder}/net`;
const input = { sandboxId, bot, bridgeUrl: 'http://192.0.2.3:34120', modelUrl: 'http://192.0.2.4:34121/v1' };

function fixture({ pinnedInode = '4:111', alterReadback = false, changed = false, uidMap = '0 1196608 65536', uidMapChanges = false, correctCgroup = true } = {}) {
  const calls = [];
  const tables = new Map();
  let inspections = 0;
  let uidReads = 0;
  const network = new DockerBotNetwork({ execute: async (command, args) => {
    calls.push([command, ...args]);
    if (command === 'docker') {
      const labels = { 'opensandbox.io/id': sandboxId, mission_key: openSandboxMissionKey(bot.mission_id),
        bot_key: openSandboxBotKey(bot.bot_id), resource_key: openSandboxBotKey(bot.resource_key) };
      const pid = changed && inspections++ === 1 ? 55 : 54;
      return { stdout: [containerId, pid, true, '2026-11-14T12:00:00.000Z', 'bridge', false, labels].map(JSON.stringify).join(' ') };
    }
    assert.equal(command, 'sudo');
    const [, program, ...rest] = args;
    if (program.endsWith('/stat')) {
      const target = rest.at(-1);
      return { stdout: target === '/proc/1/ns/net' ? '4:22' : target === pin ? pinnedInode : '4:111' };
    }
    if (program.endsWith('/cat')) {
      if (rest[0].endsWith('/cgroup')) return { stdout: correctCgroup ? `0::/system.slice/docker-${containerId}.scope` : '0::/system.slice/another.scope' };
      return { stdout: uidMapChanges && uidReads++ > 0 ? '0 100000 65536' : uidMap };
    }
    if (program.endsWith('/mktemp')) return { stdout: folder };
    if (program.endsWith('/nsenter')) {
      const [net, separator, binary, ...command] = rest;
      assert.equal(net, `--net=${pin}`);
      assert.equal(separator, '--');
      assert.equal(binary, '/usr/sbin/nft');
      const emit = records => ({ stdout: JSON.stringify({ nftables: [{ metainfo: {} }, ...records] }) });
      if (command[0] === '-j' && command[2] === 'tables') return emit([...tables.values()].map(items => items[0]));
      if (command[0] === '-j' && command[2] === 'table') {
        const records = tables.get(command.at(-1));
        return emit(alterReadback ? [...records, { chain: { name: 'unexpected bypass' } }] : records);
      }
      const declarations = command[0].split('\n');
      const [, table] = /^add table inet (swarmbot_[a-f0-9]+)$/.exec(declarations.shift());
      assert.equal(declarations.shift(), `add chain inet ${table} output { type filter hook output priority -150; policy accept; }`);
      const owner = { match: { op: '==', left: { meta: { key: 'skuid' } }, right: BOT_UID } };
      const payload = (protocol, field, right) => ({ match: { op: '==', left: { payload: { protocol, field } }, right } });
      tables.set(table, [
        { table: { family: 'inet', name: table, handle: 1 } },
        { chain: { family: 'inet', table, name: 'output', type: 'filter', hook: 'output', prio: -150, policy: 'accept' } },
        ...declarations.map((line, index) => {
          const rulePrefix = `add rule inet ${table} output meta skuid ${BOT_UID} `;
          assert.ok(line.startsWith(rulePrefix));
          const rule = line.slice(rulePrefix.length);
          const[, address, port] = /^ip daddr ([\d.]+) tcp dport (\d+) accept$/.exec(rule) ?? [];
          assert.ok(address || rule === 'reject');
          const expr = address ? [owner, payload('ip', 'daddr', address), payload('tcp', 'dport', Number(port)), { accept: null }] :
            [owner, { reject: { type: 'icmpx', expr: 'port-unreachable' } }];
          return { rule: { family: 'inet', table, chain: 'output', handle: 2 + index, expr } };
        }),
      ]);
    }
    return { stdout: '' };
  } });
  return { network, calls, tables };
}

test('Bot network installs and verifies a dual-family policy atomically in the pinned namespace', async () => {
  const { network, calls, tables } = fixture();
  const evidence = await network.isolate(input);
  assert.equal(evidence.bot_uid, BOT_UID);
  assert.equal(evidence.host_owner_uid, 1196608 + BOT_UID);
  assert.equal(evidence.allowed_endpoint_count, 2);
  const [table] = tables.values();
  assert.equal(table[1].chain.hook, 'output');
  assert.equal(table[2].rule.expr[0].match.right, BOT_UID);
  assert.deepEqual(table.at(-1).rule.expr.at(-1), { reject: { type: 'icmpx', expr: 'port-unreachable' } });
  assert.deepEqual(calls.at(-3).slice(2), ['/usr/bin/umount', '--', pin]);
  assert.deepEqual(calls.at(-1).slice(2), ['/usr/bin/rmdir', '--', folder]);
  assert.deepEqual(await network.isolate(input), evidence);
  assert.equal(calls.filter(args => args.at(-1).startsWith('add table')).length, 1);
});

test('Bot network never opens a firewall on a mismatched pin, replaced PID, or missing/changing UID mapping', async () => {
  for (const options of [{ pinnedInode: '4:22' }, { changed: true }, { uidMap: '0 100000 500' }, { uidMapChanges: true }, { correctCgroup: false }]) {
    const { network, calls } = fixture(options);
    await assert.rejects(network.isolate(input), /isolation|UID mapping|does not belong/);
    assert.equal(calls.some(args => args.includes('/usr/bin/nsenter')), false);
  }
});

test('Bot network refuses failed rule readback and arbitrary additional destinations', async () => {
  const { network } = fixture({ alterReadback: true });
  await assert.rejects(network.isolate(input), /table does not match/);
  assert.throws(() => new DockerBotNetwork({ additionalEndpoints: ['http://192.0.2.5/'] }), /only the trusted Bridge/);
  await assert.rejects(network.isolate({ ...input, bridgeUrl: 'http://192.0.2.3:0' }), /explicit non-loopback/);
});

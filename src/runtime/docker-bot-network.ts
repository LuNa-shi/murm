import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { isIP } from 'node:net';
import { promisify } from 'node:util';
import { BOT_UID } from '../../scripts/sandbox-project.mjs';
import { openSandboxBotKey, openSandboxMissionKey, openSandboxRuntimeKey } from './opensandbox-metadata.js';

const exec = promisify(execFile);
const firewallPath = '/usr/sbin/nft';
const outputPriority = -150;

function endpoint(value: any) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || isIP(url.hostname) !== 4 ||
      url.hostname.startsWith('127.') || url.hostname === '0.0.0.0' || url.username || url.password ||
      Number(url.port) === 0 && url.port !== '') {
    throw new TypeError('Bot egress requires explicit non-loopback IPv4 HTTP endpoints');
  }
  return { address: url.hostname, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) };
}

// Privileged changes are confined to an attested, pinned sandbox namespace.
export class DockerBotNetwork {
  declare execute: any;

  constructor({ additionalEndpoints = [], execute = exec }: any = {}) {
    if (!Array.isArray(additionalEndpoints) || additionalEndpoints.length !== 0) {
      throw new TypeError('Bot egress supports only the trusted Bridge and model gateway');
    }
    this.execute = execute;
  }

  async #run(command: any, args: any) {
    const result = await this.execute(command, args, { encoding: 'utf8', timeout: 12_000, maxBuffer: 1024 * 1024 });
    return result.stdout.trim();
  }

  #sudo(command: any, ...args: any[]) { return this.#run('sudo', ['-n', command, ...args]); }

  async #inspect(id: any) {
    const values = await this.#run('docker', ['inspect', '--type', 'container', '--format',
      '{{json .Id}} {{json .State.Pid}} {{json .State.Running}} {{json .State.StartedAt}} {{json .HostConfig.NetworkMode}} {{json .HostConfig.Privileged}} {{json .Config.Labels}}', id]);
    const fields = /^("[a-f0-9]{64}") (\d+) (true|false) ("[^"]+") ("[^"]+") (true|false) (\{.*\}|null)$/.exec(values);
    if (!fields) throw new Error('Invalid Docker identity response');
    const [containerId, pid, running, startedAt, mode, privileged, labels] = fields.slice(1).map((value: any) => JSON.parse(value));
    return { containerId, pid, running, startedAt, mode, privileged, labels };
  }

  #netIdentity(path: any) { return this.#sudo('/usr/bin/stat', '-Lc', '%d:%i', path); }

  async isolate({ sandboxId, bot, bridgeUrl, modelUrl, additionalEndpoints = [] }: any) {
    if (!/^[a-zA-Z0-9_-]+$/.test(sandboxId ?? '') || !bot?.bot_id || (!bot.runtime_id && !bot.mission_id) || !bot.resource_key) throw new TypeError('Trusted Sandbox and Bot identity required');
    if (!Array.isArray(additionalEndpoints)) throw new TypeError('Additional endpoints must be an array');
    const permitted = [endpoint(bridgeUrl), endpoint(modelUrl), ...additionalEndpoints.map(endpoint)];
    const rules = [...new Map<any, any>(permitted.map((row: any) => [`${row.address}:${row.port}`, row])).values()].sort((a: any, b: any) => `${a.address}:${a.port}`.localeCompare(`${b.address}:${b.port}`));
    const before = await this.#inspect(`sandbox-${sandboxId}`);
    const { pid, containerId } = before;
    if (!before.running || !Number.isSafeInteger(pid) || pid <= 1 || before.mode !== 'bridge' || before.privileged ||
        before.labels?.['opensandbox.io/id'] !== sandboxId || before.labels?.bot_key !== openSandboxBotKey(bot.bot_id) ||
        before.labels?.resource_key !== openSandboxBotKey(bot.resource_key) ||
        (bot.runtime_id ? before.labels?.runtime_key !== openSandboxRuntimeKey(bot.runtime_id) : before.labels?.mission_key !== openSandboxMissionKey(bot.mission_id))) {
      throw new Error('Sandbox network identity or local bridge deployment does not match');
    }

    const source = `/proc/${pid}/ns/net`;
    const [host, initial] = await Promise.all([this.#netIdentity('/proc/1/ns/net'), this.#netIdentity(source)]);
    if (!/^\d+:\d+$/.test(initial) || !/^\d+:\d+$/.test(host) || host === initial) {
      throw new Error('Refusing host or unknown network namespace');
    }
    const ownsProcess = async () => {
      const cgroups = await this.#sudo('/usr/bin/cat', `/proc/${pid}/cgroup`);
      return cgroups.split(/[\n/]/).some((part: any) => part === containerId || part === `docker-${containerId}.scope`);
    };
    if (!await ownsProcess()) throw new Error('Sandbox process does not belong to the inspected Docker container');
    const readUidMap = () => this.#sudo('/usr/bin/cat', `/proc/${pid}/uid_map`);
    const uidMap = await readUidMap();
    const mappings = uidMap.split('\n').map((line: any) => {
      const ints = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
      return ints?.slice(1).map(Number);
    });
    if (mappings.some((row: any) => !row || row.some((value: any) => !Number.isSafeInteger(value) || value > 0xffffffff) ||
        row[2] === 0 || row[0] + row[2] > 0xffffffff || row[1] + row[2] > 0xffffffff)) {
      throw new Error('Invalid Sandbox UID mapping');
    }
    const coverage = mappings.filter(([inside, , count]: any) => inside <= BOT_UID && BOT_UID < inside + count);
    if (coverage.length !== 1) throw new Error('Sandbox UID mapping does not uniquely cover the trusted Bot UID');
    const [[inside, outside]] = coverage;
    const hostOwnerUid = outside + (BOT_UID - inside);
    if (!hostOwnerUid) throw new Error('Sandbox UID mapping would match host root');
    const digest = createHash('sha256').update(JSON.stringify({ bot_uid: BOT_UID, host_owner_uid: hostOwnerUid, rules })).digest('hex');
    const chain = `swarmbot_${digest.slice(0, 12)}`;

    const directory = await this.#sudo('/usr/bin/mktemp', '-d', '/tmp/swarmenv-netns.XXXXXXXXXX');
    if (!/^\/tmp\/swarmenv-netns\.[A-Za-z0-9]{10}$/.test(directory)) throw new Error('Invalid private namespace pin directory');
    const pin = `${directory}/net`;
    let mounted = false;
    try {
      await this.#sudo('/usr/bin/touch', '--', pin);
      await this.#sudo('/usr/bin/mount', '--bind', source, pin);
      mounted = true;
      const verify = async () => {
        const [pinned, current, live, belongs, liveUidMap] = await Promise.all([this.#netIdentity(pin), this.#netIdentity(source), this.#inspect(containerId), ownsProcess(), readUidMap()]);
        if (!belongs || liveUidMap !== uidMap || pinned !== initial || current !== initial || pinned === host || !live.running ||
            live.containerId !== containerId || live.pid !== pid || live.startedAt !== before.startedAt) {
          throw new Error('Sandbox changed during network isolation');
        }
      };
      await verify();
      const firewall = (...args: any[]) => this.#sudo('/usr/bin/nsenter', `--net=${pin}`, '--', firewallPath, ...args);
      const declarations = [
        `add table inet ${chain}`,
        `add chain inet ${chain} output { type filter hook output priority ${outputPriority}; policy accept; }`,
        ...rules.map((row: any) => `add rule inet ${chain} output meta skuid ${BOT_UID} ip daddr ${row.address} tcp dport ${row.port} accept`),
        `add rule inet ${chain} output meta skuid ${BOT_UID} reject`,
      ];
      const listed = (value: any) => JSON.parse(value).nftables.filter((item: any) => !Object.hasOwn(item, 'metainfo'));
      const tables = listed(await firewall('-j', 'list', 'tables'));
      if (!tables.some((item: any) => item.table?.family === 'inet' && item.table?.name === chain)) {
        // nft applies all declarations in a single netlink transaction.
        await firewall(declarations.join('\n'));
      }
      const table = { family: 'inet', name: chain };
      const output = { family: 'inet', table: chain, name: 'output', type: 'filter', hook: 'output', prio: outputPriority, policy: 'accept' };
      const match = (left: any, right: any) => ({ match: { op: '==', left, right } });
      const owner = match({ meta: { key: 'skuid' } }, BOT_UID);
      const expression = (expr: any) => ({ rule: { family: 'inet', table: chain, chain: 'output', expr } });
      const expected = [{ table }, { chain: output },
        ...rules.map((row: any) => expression([owner, match({ payload: { protocol: 'ip', field: 'daddr' } }, row.address),
          match({ payload: { protocol: 'tcp', field: 'dport' } }, row.port), { accept: null }])),
        expression([owner, { reject: { type: 'icmpx', expr: 'port-unreachable' } }])];
      const observed = listed(await firewall('-j', 'list', 'table', 'inet', chain)).map((item: any) => {
        const [[kind, { handle: _handle, ...data }]] = Object.entries(item) as [string, any][];
        return { [kind]: data };
      });
      if (JSON.stringify(observed) !== JSON.stringify(expected)) throw new Error('Bot network table does not match the pinned configuration');
      await verify();
      return { mode: 'local-docker-uid-egress', policy_sha256: digest, bot_uid: BOT_UID, host_owner_uid: hostOwnerUid, firewall: 'nftables-inet', allowed_endpoint_count: rules.length, ipv6: 'denied' };
    } finally {
      if (mounted) await this.#sudo('/usr/bin/umount', '--', pin);
      await this.#sudo('/usr/bin/rm', '-f', '--', pin);
      await this.#sudo('/usr/bin/rmdir', '--', directory);
    }
  }
}

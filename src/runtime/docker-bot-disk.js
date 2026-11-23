import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { openSandboxBotKey, openSandboxMissionKey, openSandboxRuntimeKey } from './opensandbox-metadata.js';

const exec = promisify(execFile);
const helper = fileURLToPath(new URL('../../scripts/mount-bot-workspace.py', import.meta.url));

export class DockerBotDisk {
  constructor({ bytes = 256 * 1024 ** 2, inodes = 16_384, execute = exec } = {}) {
    if (!Number.isSafeInteger(bytes) || bytes < 16 * 1024 ** 2 || bytes > 4 * 1024 ** 3 || bytes % 4096 ||
        !Number.isSafeInteger(inodes) || inodes < 1024 || inodes > 262_144) throw new TypeError('Invalid Docker Bot workspace quota');
    this.bytes = bytes;
    this.inodes = inodes;
    this.execute = execute;
  }

  async isolate({ sandboxId, bot }) {
    if (!/^[a-zA-Z0-9_-]+$/.test(sandboxId ?? '') || !bot?.bot_id || (!bot.runtime_id && !bot.mission_id) || !bot.resource_key) throw new TypeError('Trusted Sandbox and Bot identity required');
    const run = async (command, args) => (await this.execute(command, args, { encoding: 'utf8', timeout: 12_000, maxBuffer: 1024 * 1024 })).stdout.trim();
    const inspect = async id => JSON.parse(await run('docker', ['inspect', '--type', 'container', '--format',
      '{"id":{{json .Id}},"pid":{{json .State.Pid}},"started":{{json .State.StartedAt}},"running":{{json .State.Running}},"labels":{{json .Config.Labels}}}', id]));
    const first = await inspect(`sandbox-${sandboxId}`);
    const { id, pid, started, labels } = first;
    if (!first.running || !/^[a-f0-9]{64}$/.test(id) || !Number.isSafeInteger(pid) || pid <= 1 ||
        labels?.['opensandbox.io/id'] !== sandboxId || labels?.bot_key !== openSandboxBotKey(bot.bot_id) ||
        labels?.resource_key !== openSandboxBotKey(bot.resource_key) || (bot.runtime_id ? labels?.runtime_key !== openSandboxRuntimeKey(bot.runtime_id) : labels?.mission_key !== openSandboxMissionKey(bot.mission_id))) {
      throw new Error('Sandbox disk identity does not match');
    }
    await run('sudo', ['-n', '/usr/bin/python3', '-I', helper, String(pid), id, String(this.bytes), String(this.inodes)]);
    const current = await inspect(id);
    if (!current.running || current.id !== id || current.pid !== pid || current.started !== started) throw new Error('Sandbox changed during disk isolation');
    return { bytes: this.bytes, inodes: this.inodes };
  }
}

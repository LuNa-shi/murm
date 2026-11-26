import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { openSandboxAgentKey, openSandboxMissionKey, openSandboxRuntimeKey } from './opensandbox-metadata.js';

const exec = promisify(execFile);
const helper = fileURLToPath(new URL('../../scripts/mount-agent-workspace.py', import.meta.url));

interface SharedMountOptions {
  runtimeId: string;
  workspaceId: string;
  sandboxId?: string;
  agent?: { agent_id: string; runtime_id: string; resource_key: string };
  mode?: 'read-only' | 'read-write';
}

export class DockerAgentDisk {
  declare bytes: any;
  declare inodes: any;
  declare execute: any;

  constructor({ bytes = 256 * 1024 ** 2, inodes = 16_384, execute = exec }: any = {}) {
    if (!Number.isSafeInteger(bytes) || bytes < 16 * 1024 ** 2 || bytes > 4 * 1024 ** 3 || bytes % 4096 ||
        !Number.isSafeInteger(inodes) || inodes < 1024 || inodes > 262_144) throw new TypeError('Invalid Docker Agent workspace quota');
    this.bytes = bytes;
    this.inodes = inodes;
    this.execute = execute;
  }

  async sharedWorkspace(action: 'create' | 'attach' | 'delete', { runtimeId, workspaceId, sandboxId, agent, mode }: SharedMountOptions) {
    const key = (value: string) => createHash('sha256').update(value).digest('hex');
    const program = fileURLToPath(new URL('../../scripts/mount-shared-workspace.py', import.meta.url));
    const args = ['-n', '/usr/bin/python3', '-I', program, action, key(runtimeId), key(workspaceId)];
    if (action === 'create') args.push(String(this.bytes), String(this.inodes));
    if (action === 'attach') {
      if (!/^[a-zA-Z0-9_-]+$/.test(sandboxId ?? '') || !agent?.agent_id || agent.runtime_id !== runtimeId) throw new TypeError('Trusted shared mount identity required');
      const result = await this.execute('docker', ['inspect', '--type', 'container', '--format',
        '{"id":{{json .Id}},"pid":{{json .State.Pid}},"running":{{json .State.Running}},"labels":{{json .Config.Labels}}}', `sandbox-${sandboxId}`],
        { encoding: 'utf8', timeout: 12_000, maxBuffer: 1024 * 1024 });
      const info = JSON.parse(result.stdout);
      if (!info.running || !/^[a-f0-9]{64}$/.test(info.id) || !Number.isSafeInteger(info.pid) || info.pid <= 1 ||
          info.labels?.['opensandbox.io/id'] !== sandboxId || info.labels?.agent_key !== openSandboxAgentKey(agent.agent_id) ||
          info.labels?.runtime_key !== openSandboxRuntimeKey(runtimeId) || info.labels?.resource_key !== openSandboxAgentKey(agent.resource_key)) throw new Error('Sandbox shared mount identity does not match');
      args.push(String(info.pid), info.id, mode!);
    }
    await this.execute('sudo', args, { encoding: 'utf8', timeout: 12_000, maxBuffer: 1024 * 1024 });
  }

  async isolate({ sandboxId, agent }: any) {
    if (!/^[a-zA-Z0-9_-]+$/.test(sandboxId ?? '') || !agent?.agent_id || (!agent.runtime_id && !agent.mission_id) || !agent.resource_key) throw new TypeError('Trusted Sandbox and Agent identity required');
    const run = async (command: any, args: any) => (await this.execute(command, args, { encoding: 'utf8', timeout: 12_000, maxBuffer: 1024 * 1024 })).stdout.trim();
    const inspect = async (id: any) => JSON.parse(await run('docker', ['inspect', '--type', 'container', '--format',
      '{"id":{{json .Id}},"pid":{{json .State.Pid}},"started":{{json .State.StartedAt}},"running":{{json .State.Running}},"labels":{{json .Config.Labels}}}', id]));
    const first = await inspect(`sandbox-${sandboxId}`);
    const { id, pid, started, labels } = first;
    if (!first.running || !/^[a-f0-9]{64}$/.test(id) || !Number.isSafeInteger(pid) || pid <= 1 ||
        labels?.['opensandbox.io/id'] !== sandboxId || labels?.agent_key !== openSandboxAgentKey(agent.agent_id) ||
        labels?.resource_key !== openSandboxAgentKey(agent.resource_key) || (agent.runtime_id ? labels?.runtime_key !== openSandboxRuntimeKey(agent.runtime_id) : labels?.mission_key !== openSandboxMissionKey(agent.mission_id))) {
      throw new Error('Sandbox disk identity does not match');
    }
    await run('sudo', ['-n', '/usr/bin/python3', '-I', helper, String(pid), id, String(this.bytes), String(this.inodes)]);
    const current = await inspect(id);
    if (!current.running || current.id !== id || current.pid !== pid || current.started !== started) throw new Error('Sandbox changed during disk isolation');
    return { bytes: this.bytes, inodes: this.inodes };
  }
}

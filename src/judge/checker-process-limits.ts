import { recordCheckerOwnership, checkerDispatchPaths } from './checker-owner.js';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const launch = '/usr/bin/systemd-run';
const control = '/usr/bin/systemctl';
const cleanupMs = 5_000;

export const CHECKER_RESOURCE_PROFILE = Object.freeze({
  profile: 'systemd-user-v1',
  memory_bytes: 4 * 1024 ** 3,
  swap_bytes: 0,
  max_tasks: 64,
  cpu_percent: 200,
  stop_grace_ms: 1_000,
});

/** Operator configuration only; cleanup and swap policy remain fixed. */
export function checkerResourceProfile(resources: any) {
  if (resources === undefined) return CHECKER_RESOURCE_PROFILE;
  const fields = ['memory_bytes', 'cpu_percent', 'max_tasks'];
  if (!resources || typeof resources !== 'object' || Array.isArray(resources) ||
      Object.entries(resources).some(([key, value]: any) => !fields.includes(key) || !Number.isSafeInteger(value) || value <= 0)) {
    throw new TypeError('Checker resources require positive integer memory_bytes, cpu_percent and max_tasks overrides');
  }
  return Object.freeze({ ...CHECKER_RESOURCE_PROFILE, ...resources, profile: 'systemd-user-config-v1' });
}

/** The client process is a transport only. The unit owns all checker processes. */
export function createCheckerProcessLimits({ runtimeMs, resources, ownerFile = process.env.SWARMENV_CHECKER_OWNER_FILE }: any) {
  if (!Number.isFinite(runtimeMs) || runtimeMs <= 0 || runtimeMs > 2_147_483_647) throw new TypeError('Invalid checker resource deadline');
  const limit = checkerResourceProfile(resources);
  const unit = `swarmenv-check-${randomUUID()}.service`;
  recordCheckerOwnership(ownerFile, unit, 'allocated');
  const environment = Object.freeze({ XDG_RUNTIME_DIR: `/run/user/${process.getuid!()}` });
  const argsFor = (command: any, args: any) => {
    if (!isAbsolute(command)) throw new TypeError('Checker process must use an absolute executable path');
    const launchArgs = [
      '--user', '--wait', '--pipe', '--collect', '--quiet', '--expand-environment=no', `--unit=${unit}`,
      '--property=Type=exec', '--property=KillMode=control-group', '--property=SendSIGKILL=yes',
      `--property=MemoryMax=${limit.memory_bytes}`, `--property=MemorySwapMax=${limit.swap_bytes}`,
      `--property=TasksMax=${limit.max_tasks}`, `--property=CPUQuota=${limit.cpu_percent}%`,
      `--property=TimeoutStopSec=${limit.stop_grace_ms}ms`, `--property=RuntimeMaxSec=${Math.ceil(runtimeMs) + limit.stop_grace_ms}ms`,
      '--', command, ...args,
    ];
    if (!ownerFile) return launchArgs;
    const paths = checkerDispatchPaths(ownerFile, unit);
    // flock's descriptor survives the shell exec and remains held by the real
    // systemd client until it exits. No child PID handoff can lose this fence.
    return ['--no-fork', paths.lock, '/bin/sh', '-c',
      'if test -e "$1"; then exit 125; fi; shift; exec "$@"', 'checker-dispatch', paths.cancelled, launch, ...launchArgs];
  };
  let controlGroup: any = null;
  const inspect = async (timeout: any) => {
    const { stdout } = await exec(control, ['--user', 'show', unit, '-p', 'LoadState', '-p', 'ActiveState', '-p', 'ControlGroup'],
      { env: environment, timeout, maxBuffer: 16_384 });
    const properties = Object.fromEntries(stdout.trim().split('\n').map((line: any) => line.split('=', 2)));
    if (!properties.LoadState || !properties.ActiveState) throw new Error('Incomplete checker unit state');
    if (properties.ControlGroup) controlGroup = properties.ControlGroup;
    return properties;
  };
  const empty = async () => {
    if (!controlGroup) return true;
    try {
      return /^populated 0$/m.test(await readFile(`/sys/fs/cgroup${controlGroup}/cgroup.events`, 'utf8'));
    } catch (error: any) {
      if (error.code === 'ENOENT') return true;
      throw error;
    }
  };
  let stopping: any;
  const stop = ({ clientSettled }: any) => {
    if (stopping) return stopping;
    stopping = stopUnit(clientSettled).finally(() => { stopping = null; });
    return stopping;
  };
  async function stopUnit(clientSettled: any) {
    const deadline = Date.now() + cleanupMs;
    let cause;
    while (Date.now() < deadline) {
      const remaining = () => Math.max(1, deadline - Date.now());
      try {
        const state = await inspect(remaining());
        if (!['inactive', 'failed'].includes(state.ActiveState) || !await empty()) {
          await exec(control, ['--user', 'stop', unit], { env: environment, timeout: remaining(), maxBuffer: 16_384 });
        } else if (clientSettled()) {
          recordCheckerOwnership(ownerFile, unit, 'settled');
          return;
        }
      } catch (error: any) {
        cause = error;
      }
      if (Date.now() < deadline) await delay(Math.min(50, remaining()));
    }
    throw Object.assign(new Error('Checker unit cleanup could not be confirmed', { cause }), {
      code: 'CHECKER_CLEANUP_PENDING', unit,
    });
  }
  async function waitForEmpty({ clientSettled, onPending }: any) {
    while (true) {
      try {
        await stop({ clientSettled });
        return;
      } catch (error: any) {
        if (error.code !== 'CHECKER_CLEANUP_PENDING') throw error;
        try { onPending?.(error); } catch { /* An observer cannot release checker ownership. */ }
        await delay(1_000);
      }
    }
  }
  return { command: ownerFile ? '/usr/bin/flock' : launch, argsFor, environment, unit, stop, waitForEmpty };
}

/** Fail closed before dispatch if the host cannot enforce the selected profile. */
export async function verifyCheckerProcessLimits(resources: any) {
  const profile = checkerResourceProfile(resources);
  const limits = createCheckerProcessLimits({ runtimeMs: 2_000, resources });
  const probe = [
    'read -r group </proc/self/cgroup',
    'cd "/sys/fs/cgroup${group#0::}" || exit 1',
    'for file in memory.max memory.swap.max pids.max cpu.max; do',
    '  [ -r "$file" ] || exit 1',
    '  read -r value <"$file"; printf "%s\\n" "$value"',
    'done',
  ].join('\n');
  const child = execFile(limits.command, limits.argsFor('/bin/sh', ['-eu', '-c', probe]), {
    env: limits.environment, timeout: 3_500, maxBuffer: 16_384,
  });
  const stdout: any[] = [];
  child.stdout!.on('data', (chunk: any) => stdout.push(chunk));
  let clientSettled = false;
  const settled = Promise.race([
    once(child, 'close').then(([code]: any) => code),
    delay(4_000, null, { ref: false }),
  ]);
  child.once('close', () => { clientSettled = true; });
  let code;
  try { code = await settled; }
  finally { await limits.stop({ clientSettled: () => clientSettled }); }
  const [memory, swap, tasks, cpu] = stdout.join('').trim().split('\n');
  const [quota, period] = (cpu ?? '').split(' ').map(Number);
  if (code !== 0 || Number(memory) !== profile.memory_bytes || Number(swap) !== profile.swap_bytes ||
      Number(tasks) !== profile.max_tasks || quota / period !== profile.cpu_percent / 100) {
    throw new Error('Checker host does not enforce the configured cgroup limits');
  }
  return profile;
}

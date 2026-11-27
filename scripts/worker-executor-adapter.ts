import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, posix } from 'node:path';
import { EXECUTOR_ADAPTER_PROTOCOL, executorVersion, snapshotExecutorCapabilities } from '../src/core/executor-adapter.js';

function invalid(message: string): never {
  throw Object.assign(new Error(message), { code: 'AGENT_STARTUP_CONTRACT' });
}

export async function loadWorkerExecutor(command: string, selection: any, expectedVersion: string) {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(command) || selection?.kind !== command ||
      selection.protocol !== EXECUTOR_ADAPTER_PROTOCOL || !executorVersion(expectedVersion)) {
    invalid('Worker requires a registered executor adapter and compatible protocol');
  }
  const directory = '/opt/murm/executors';
  const filename = posix.join(directory, `${command}.json`);
  let descriptor;
  try {
    const parent = await lstat(directory);
    const file = await lstat(filename);
    if (!parent.isDirectory() || parent.uid !== 0 || parent.mode & 0o022 ||
        !file.isFile() || file.uid !== 0 || file.mode & 0o022 || file.size > 32_768) throw new Error();
    descriptor = JSON.parse(await readFile(filename, 'utf8'));
  } catch {
    invalid('Worker image does not contain the selected trusted executor descriptor');
  }
  const args = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 128 &&
    value.every(item => typeof item === 'string' && item.length <= 4096 && !item.includes('\0'));
  if (descriptor?.kind !== command || descriptor.protocol !== selection.protocol ||
      descriptor.version !== expectedVersion || typeof descriptor.command !== 'string' ||
      !isAbsolute(descriptor.command) || !args(descriptor.args) || !args(descriptor.versionArgs)) {
    invalid('Worker executor descriptor does not match the selected protocol and version');
  }
  let capabilities;
  try { capabilities = snapshotExecutorCapabilities(descriptor.capabilities); }
  catch { invalid('Worker executor descriptor declares invalid capabilities'); }
  if (JSON.stringify(capabilities) !== JSON.stringify(selection.capabilities)) {
    invalid('Worker executor capabilities differ from the Runtime declaration');
  }
  return { command: descriptor.command as string, args: descriptor.args, versionArgs: descriptor.versionArgs,
    contract: { kind: command, protocol: EXECUTOR_ADAPTER_PROTOCOL, version: expectedVersion, capabilities } };
}

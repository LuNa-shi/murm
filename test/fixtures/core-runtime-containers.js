import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

export async function ownedContainers(runtimeId, { timeoutMs = 5000, signal } = {}) {
  const hash = createHash('sha256').update(runtimeId).digest('hex').slice(0, 48);
  const result = await promisify(execFile)('docker', ['ps', '--all', '--quiet', '--no-trunc',
    '--filter', `label=runtime_key=r-${hash}`], { timeout: timeoutMs, ...(signal ? { signal } : {}) });
  return result.stdout.trim().split('\n').filter(Boolean);
}

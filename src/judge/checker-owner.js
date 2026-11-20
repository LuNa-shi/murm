import { openSync, writeSync, fsyncSync, closeSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
const exec = promisify(execFile);
export const checkerDispatchPaths = (path, unit) => ({ directory: `${path}.dispatch`, lock: `${path}.dispatch/${unit}.lock`, cancelled: `${path}.dispatch/${unit}.cancelled` });
const unitPattern = /^swarmenv-check-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.service$/;

export function recordCheckerOwnership(path, unit, state) {
  if (!path) return;
  if (!unitPattern.test(unit) || !['allocated', 'settled'].includes(state)) throw new TypeError('Invalid owned checker resource');
  mkdirSync(checkerDispatchPaths(path, unit).directory, { recursive: true, mode: 0o700 });
  const descriptor = openSync(path, 'a', 0o600);
  try {
    const bytes = Buffer.from(JSON.stringify({ unit, state, dispatch_guard: true }) + '\n');
    let written = 0;
    while (written < bytes.length) written += writeSync(descriptor, bytes, written, bytes.length - written);
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
}

/** Called under the Judge store's exclusive process lock. Unit identities are
 * durable before dispatch, so a peer crash cannot lose its cleanup handles. */
export async function cleanupOwnedCheckers(path, { timeoutMs = 30_000 } = {}) {
  if (!path) return { settled: 0 };
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { settled: 0 }; throw error; }
  const units = new Map();
  for (const line of text.split('\n').filter(Boolean)) {
    const row = JSON.parse(line);
    if (!unitPattern.test(row.unit) || !['allocated', 'settled'].includes(row.state)) throw new Error('Invalid checker ownership record');
    units.set(row.unit, row);
  }
  const pending = [...units].filter(([, row]) => row.state === 'allocated');
  const deadline = Date.now() + timeoutMs;
  const environment = { XDG_RUNTIME_DIR: `/run/user/${process.getuid()}` };
  let settled = 0;
  for (const [unit, row] of pending) {
    if (!row.dispatch_guard) throw Object.assign(new Error('Unfenced checker dispatch requires operator reconciliation'), { code: 'CHECKER_CLEANUP_PENDING', unit });
    // Cancel before observing an absent unit: a client that has not acquired its
    // dispatch lock must refuse to submit after this durable marker appears.
    const paths = checkerDispatchPaths(path, unit);
    const cancelled = openSync(paths.cancelled, 'a', 0o600);
    try { fsyncSync(cancelled); } finally { closeSync(cancelled); }
    const directory = openSync(paths.directory, 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
    // Fence even a StartTransientUnit request already queued on the manager
    // when its client was killed. UUID names are never reused; keep the mask
    // until the user runtime is rebuilt rather than reopening late dispatch.
    await exec('/usr/bin/systemctl', ['--user', 'mask', '--runtime', unit],
      { env: environment, timeout: Math.max(1, deadline - Date.now()), maxBuffer: 16_384 });
    let complete = false;
    let dispatcherSettled = false;
    let cause;
    while (Date.now() < deadline) {
      const remaining = () => Math.max(1, deadline - Date.now());
      try {
        const { stdout } = await exec('/usr/bin/systemctl', ['--user', 'show', unit, '-p', 'LoadState', '-p', 'ActiveState', '-p', 'ControlGroup'],
          { env: environment, timeout: remaining(), maxBuffer: 16_384 });
        const properties = Object.fromEntries(stdout.trim().split('\n').map(line => line.split('=', 2)));
        if (!properties.LoadState || !properties.ActiveState) throw new Error('Incomplete checker unit state');
        let empty = !properties.ControlGroup;
        if (properties.ControlGroup) {
          const events = await readFile(`/sys/fs/cgroup${properties.ControlGroup}/cgroup.events`, 'utf8')
            .catch(error => { if (error.code === 'ENOENT') return 'populated 0'; throw error; });
          empty = /^populated 0$/m.test(events);
        }
        if (['inactive', 'failed'].includes(properties.ActiveState) && empty) {
          // A live dispatcher keeps this lock through exec(systemd-run). Even
          // an already-queued start cannot race a settled receipt. Future
          // dispatchers acquire the lock but observe cancellation above.
          if (!dispatcherSettled) {
            await exec('/usr/bin/flock', ['--nonblock', '--no-fork', paths.lock, '/usr/bin/true'],
              { env: environment, timeout: remaining(), maxBuffer: 16_384 });
            dispatcherSettled = true;
            continue; // Re-observe unit/cgroup after the last dispatcher exited.
          }
          recordCheckerOwnership(path, unit, 'settled'); settled++; complete = true; break;
        }
        await exec('/usr/bin/systemctl', ['--user', 'stop', unit], { env: environment, timeout: remaining(), maxBuffer: 16_384 });
      } catch (error) { cause = error; }
      await delay(Math.min(50, remaining()));
    }
    if (!complete) throw Object.assign(new Error('Owned checker cleanup could not be confirmed', { cause }), { code: 'CHECKER_CLEANUP_PENDING', unit });
  }
  return { settled };
}

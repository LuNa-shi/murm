import { openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
const exec = promisify(execFile);
const unitPattern = /^swarmenv-check-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.service$/;

export function recordCheckerOwnership(path, unit, state) {
  if (!path) return;
  if (!unitPattern.test(unit) || !['allocated', 'settled'].includes(state)) throw new TypeError('Invalid owned checker resource');
  const descriptor = openSync(path, 'a', 0o600);
  try {
    const bytes = Buffer.from(JSON.stringify({ unit, state }) + '\n');
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
    units.set(row.unit, row.state);
  }
  const pending = [...units].filter(([, state]) => state === 'allocated').map(([unit]) => unit);
  const deadline = Date.now() + timeoutMs;
  const environment = { XDG_RUNTIME_DIR: `/run/user/${process.getuid()}` };
  let settled = 0;
  for (const unit of pending) {
    let complete = false;
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

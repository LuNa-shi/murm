import { rm } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';

export async function drainLeadWorkerFixture({ stopWork, guests, work }) {
  stopWork();
  const exits = [...guests].map(guest => {
    // Every simulated guest is spawned detached, owning its process group.
    // Killing only Node abandons its execFile Bash tree and its vanished timer.
    if (!Number.isSafeInteger(guest.pid) || guest.pid <= 1) throw new Error('Simulated guest has no safe owned process group');
    const closed = guest.exitCode !== null || guest.signalCode !== null ? Promise.resolve() : new Promise(resolve => guest.once('close', resolve));
    try { process.kill(-guest.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    return closed;
  });
  let timer;
  try {
    await Promise.race([
      (async () => {
        await Promise.all([...exits, ...[...work].map(promise => Promise.resolve(promise).catch(() => {}))]);
        // The transport callback is awaited by backend.send and then Core.send.
        // Let those resumed owners enqueue their evidence before Core.close's
        // final flush; waiting for the callback alone is not that boundary.
        await setImmediate();
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Lead-Worker fixture work did not drain within 18 seconds')), 18_000); }),
    ]);
  } finally { clearTimeout(timer); }
}

// Test-only ownership: a failed domain assertion must never strand the HTTP
// listener or leave simulated CLI work racing the next scenario's transport.
export async function closeLeadWorkerFixture({ reconcile, stopWork, server, guests, work, directory, drain = () => drainLeadWorkerFixture({ stopWork, guests, work }) }) {
  const errors = [];
  let reconciled = false;
  try {
    await drain();
    await reconcile();
    reconciled = true;
  } catch (error) { errors.push(error); }
  finally {
    try { if (server) await new Promise((resolve, reject) => {
      server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve());
      server.closeAllConnections();
    }); } catch (error) { errors.push(error); }
    // Retain the owned directory on uncertain work instead of deleting beneath
    // a still-running callback. The error makes this an explicit failed test.
    if (reconciled) try { await rm(directory, { recursive: true, force: true }); } catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, 'Lead-Worker fixture cleanup failed');
}

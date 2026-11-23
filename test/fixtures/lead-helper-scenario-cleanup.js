import { rm } from 'node:fs/promises';

// Test-only ownership: a failed domain assertion must never strand the HTTP
// listener or leave simulated CLI work racing the next scenario's transport.
export async function closeLeadHelperFixture({ reconcile, stopWork, server, guests, work, directory }) {
  const errors = [];
  try { await reconcile(); } catch (error) { errors.push(error); }
  stopWork();
  const exits = [...guests].map(guest => {
    if (guest.exitCode !== null || guest.signalCode !== null) return Promise.resolve();
    return new Promise(resolve => { guest.once('close', resolve); guest.kill(); });
  });
  let timer; let drained = false;
  try {
    await Promise.race([
      Promise.all([...exits, ...work].map(promise => Promise.resolve(promise).catch(() => {}))),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Lead-helper fixture work did not drain within 18 seconds')), 18_000); }),
    ]);
    drained = true;
  } catch (error) { errors.push(error); }
  finally {
    clearTimeout(timer);
    try { if (server) await new Promise((resolve, reject) => {
      server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve());
      server.closeAllConnections();
    }); } catch (error) { errors.push(error); }
    // Retain the owned directory on uncertain work instead of deleting beneath
    // a still-running callback. The error makes this an explicit failed test.
    if (drained) try { await rm(directory, { recursive: true, force: true }); } catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, 'Lead-helper fixture cleanup failed');
}

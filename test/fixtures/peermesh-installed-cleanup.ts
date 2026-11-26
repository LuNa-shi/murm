// Test-host lifecycle only. A pre-Core setup failure needs no terminal Runtime receipt.
export async function closeInstalledForeground({ child, rows, messages, cleanup, terminal, isExited }) {
  const setupFailed = () => messages.some(row => row.type === 'setup-failed');

  const until = predicate => cleanup.step(async ({ signal }) => {
    while (!predicate()) {
      if (isExited()) throw Object.assign(new Error('CLI ended before fixture cleanup'), {
        code: 'INSTALLED_CLI_ENDED'
      });

      await new Promise(resolve => setTimeout(resolve, 10));
      signal.throwIfAborted();
    }
  });

  if (!terminal && !isExited() && !setupFailed()) {
    child.kill('SIGTERM');

    // A configuration can still reject before Runtime creation while this wait is active.
    await until(() => (terminal = rows.find(row => row.type === 'result')) || setupFailed());
  }

  let facilityCleanup = { cleanup: 'pending', dependenciesRetained: true };
  let facilities;

  if (child.connected && (terminal?.cleanup === 'complete' || setupFailed())) {
    child.send({
      type: 'close-facilities',
      deadlineAt: Date.now() + cleanup.remaining()
    });

    await until(() => messages.some(row => row.type === 'facilities-closed'));
    const closed = messages.find(row => row.type === 'facilities-closed');
    facilityCleanup = closed.receipt;
    facilities = closed.resources;
  }

  if (!isExited()) await cleanup.step(async ({ signal }) => {
    while (!isExited()) {
      await new Promise(resolve => setTimeout(resolve, 10));
      signal.throwIfAborted();
    }
  });

  return {
    terminal,
    facilityCleanup,
    facilities
  };
}

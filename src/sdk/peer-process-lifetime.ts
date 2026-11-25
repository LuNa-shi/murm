import { readFile } from 'node:fs/promises';

/** Runtime-owned peers drain when their owning coordinator disappears. A
 * standalone operator service omits parentPid and keeps its own lifetime. */
export function installPeerLifetime(peer: { stop(): Promise<unknown> }, { parentPid = process.env.SWARMENV_COORDINATOR_PID }: any = {}) {
  let stopping: Promise<void> | undefined;
  let watcher: ReturnType<typeof setInterval> | undefined;
  const stop = () => stopping ??= (async () => {
    clearInterval(watcher);
    const limit = setTimeout(() => process.exit(1), 30_000);
    try { await peer.stop(); clearTimeout(limit); process.exit(0); }
    catch { clearTimeout(limit); process.exit(1); }
  })();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
  if (parentPid !== undefined) {
    if (!Number.isSafeInteger(Number(parentPid)) || Number(parentPid) < 1) throw new TypeError('Invalid coordinator parent PID');
    watcher = setInterval(async () => {
      try {
        const stat = await readFile('/proc/self/stat', 'utf8');
        const actual = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
        if (actual !== Number(parentPid)) void stop();
      } catch { void stop(); }
    }, 1000);
  }
}

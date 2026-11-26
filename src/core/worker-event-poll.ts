import timers from 'node:timers/promises';

const activeIntervalMs = 100;
const maxIdleIntervalMs = 1000;

export function createWorkerEventPoll() {
  const controller = new AbortController();
  let revision = 0;
  let intervalMs = activeIntervalMs;
  let sleep: AbortController | undefined;

  return {
    wake() {
      revision++;
      intervalMs = activeIntervalMs;
      sleep?.abort();
    },
    stop() { controller.abort(); },
    async run(read: (signal: AbortSignal) => Promise<boolean>) {
      const { signal } = controller;
      while (!signal.aborted) {
        const before = revision;
        const quiet = await read(signal);
        if (signal.aborted) return;
        if (before !== revision) continue;
        intervalMs = quiet ? Math.min(maxIdleIntervalMs, intervalMs * 2) : activeIntervalMs;
        sleep = new AbortController();
        await timers.setTimeout(intervalMs, undefined, { signal: AbortSignal.any([signal, sleep.signal]) }).catch(() => {});
        sleep = undefined;
      }
    },
  };
}

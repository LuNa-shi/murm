import timers from 'node:timers/promises';

const activeIntervalMs = 100;
const maxIdleIntervalMs = 1000;

export function createWorkerEventPoll({ longPoll = false }: { longPoll?: boolean } = {}) {
  const controller = new AbortController();
  let revision = 0;
  let intervalMs = activeIntervalMs;
  let sleep: AbortController | undefined;

  return {
    useLongPoll() { longPoll = true; sleep?.abort(); },
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
        let quiet: boolean;
        let failed = false;
        try { quiet = await read(signal); }
        catch {
          if (signal.aborted) return;
          quiet = true;
          failed = true;
        }
        if (signal.aborted) return;
        if (before !== revision) continue;
        if (longPoll && !failed) { intervalMs = activeIntervalMs; continue; }
        intervalMs = quiet ? Math.min(maxIdleIntervalMs, intervalMs * 2) : activeIntervalMs;
        sleep = new AbortController();
        const delayMs = intervalMs + (longPoll && failed ? Math.floor(Math.random() * 250) : 0);
        await timers.setTimeout(delayMs, undefined, { signal: AbortSignal.any([signal, sleep.signal]) }).catch(() => {});
        sleep = undefined;
      }
    },
  };
}

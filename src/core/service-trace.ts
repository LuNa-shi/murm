import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ServiceRegistration } from './services.js';
import { isJson } from './services.js';

/** Private full Service trace, independent of the bounded public evidence index. */
export function createServiceTrace(outputDir: string, redact: (value: unknown) => unknown) {
  const path = join(outputDir, 'service-calls.jsonl');
  let sequence = 0;
  let writer = Promise.resolve();
  let failure: unknown;
  return {
    initialize() { return writeFile(path, '', { flag: 'wx', mode: 0o600 }); },
    record(entry: Record<string, unknown>) {
      let line;
      try { line = JSON.stringify(redact({ ...entry, seq: ++sequence })) + '\n'; }
      catch (error) { failure ??= error; return; }
      writer = writer.then(() => appendFile(path, line, { mode: 0o600 })).catch(error => { failure ??= error; });
    },
    async flush() {
      await writer;
      if (failure) throw failure;
    },
  };
}

/** Optional host-owned snapshots. Export failure remains observable and bounded. */
export async function exportServiceStates(registrations: ReadonlyMap<string, ServiceRegistration>, outputDir: string, redact: (value: unknown) => unknown, timeoutMs = 30_000) {
  const results = [];
  for (const [serviceId, { adapter }] of registrations) {
    const exportState = adapter.exportState?.bind(adapter);
    if (typeof exportState !== 'function') continue;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const state = await Promise.race([
        Promise.resolve().then(() => exportState({ signal: controller.signal })),
        new Promise((_, reject) => { timer = setTimeout(() => {
          controller.abort();
          reject(Object.assign(new Error('Service state export timed out'), { code: 'SERVICE_TIMEOUT' }));
        }, timeoutMs); }),
      ]);
      if (!isJson(state)) throw Object.assign(new Error('Service state export must return JSON'), { code: 'SERVICE_OUTPUT_INVALID' });
      const path = join(outputDir, `service-state.${serviceId}.json`);
      await writeFile(path, JSON.stringify(redact({ serviceId, at: new Date().toISOString(), state })) + '\n', { mode: 0o600, flag: 'wx' });
      results.push({ serviceId, path });
    } catch (caught) {
      const error = caught as Error & { code?: string };
      results.push({ serviceId, error: redact({ code: error.code ?? 'SERVICE_UNAVAILABLE', message: error.message }) });
    } finally { clearTimeout(timer); }
  }
  return results;
}

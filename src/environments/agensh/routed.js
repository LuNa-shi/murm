import { createAgenshEnvironment } from './index.js';
import { prepareAgenshFacilities } from './provision.js';
import { httpClient } from './http.js';
import { createAgenshRouter } from './router.js';
import { createAgenshEventSubscription } from './event-source.js';
import { runWithReport } from '../shared/run-report.js';

const failure = code => Object.assign(new Error(code), { code });
async function bounded(operation, timeoutMs, code) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => { timer = setTimeout(() => reject(failure(code)), Math.max(1, timeoutMs)); })]); }
  finally { clearTimeout(timer); }
}

/** T13 identity/facility ownership, with one T14 router as the only input path. */
export async function createAgenshRouterEnvironment(options) {
  const readinessTimeoutMs = options.router?.readinessTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(readinessTimeoutMs) || readinessTimeoutMs < 1 || readinessTimeoutMs > 2147483647) throw new TypeError('Router readiness needs a finite timeout');
  let facilities; let environment; let router; let subscription; let unsubscribe; let closing = false; let closeWork; let sourceStop; let sourceStopFailed = false;
  const stopSource = () => {
    if (sourceStopFailed) { sourceStop = undefined; sourceStopFailed = false; }
    sourceStop ??= Promise.resolve().then(() => subscription?.stop());
    sourceStop.catch(() => { sourceStopFailed = true; }); return sourceStop;
  };
  const startup = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, startup.signal]) : startup.signal;
  try {
    environment = await createAgenshEnvironment({ ...options, signal, prepare: async input => {
      facilities = await (options.prepare ?? prepareAgenshFacilities)(input); return facilities;
    } });
    const mapping = Object.freeze({ botId: environment.peer.id, workerId: facilities.peer.board.workerId });
    const board = httpClient(facilities.endpoints.board);
    router = createAgenshRouter({ ...options.router, mapping, runInput: environment.runInput,
      onFence: () => { startup.abort(); void stopSource().catch(() => {}); },
      readContext: options.router?.readContext ?? (async ({ signal }) => {
        const value = await board('GET', `/board/${encodeURIComponent(facilities.boardId)}/read?viewer=${encodeURIComponent(mapping.workerId)}`, undefined, { signal });
        return value.rendered;
      }) });
    unsubscribe = environment.onEvent(router.observe);
    const subscribe = options.router?.subscribe ?? (input => createAgenshEventSubscription({ ...options.router?.events, ...input, facilities, onFailure: () => router.stop('ROUTER_SOURCE_FAILED') }));
    subscription = await bounded(() => subscribe({ mapping, ingest: router.ingest, signal }), readinessTimeoutMs, 'ROUTER_SUBSCRIPTION_TIMEOUT');
    if (subscription?.ready !== true || typeof subscription.stop !== 'function') throw Object.assign(new Error('Router subscriptions are not ready'), { code: 'ROUTER_SUBSCRIPTION_NOT_READY' });
    signal.throwIfAborted(); router.markReady();
    async function close({ timeoutMs = 60_000 } = {}) {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new TypeError('Router close needs a finite timeout');
      closing = true; router.stop(); startup.abort();
      if (!closeWork) closeWork = (async () => {
        const end = Date.now() + timeoutMs;
        let sourceFailure;
        try { await bounded(stopSource, Math.max(1, Math.floor(timeoutMs / 2)), 'ROUTER_SOURCE_CLOSE_FAILED'); }
        catch { sourceFailure = { code: 'ROUTER_SOURCE_CLOSE_FAILED' }; }
        let receipt;
        try { receipt = await bounded(() => environment.close({ timeoutMs: Math.max(1, end - Date.now()) }), Math.max(1, end - Date.now()), 'ROUTER_CORE_CLOSE_PENDING'); }
        catch { receipt = { cleanup: 'pending', bots: [{ botId: environment.peer.id, execution: 'unknown', cleanup: 'pending' }], pending: [{ kind: 'runtime-close', id: environment.id }] }; }
        if (sourceFailure) receipt = { ...receipt, cleanup: 'pending', sourceFailure };
        await router.finishClose(receipt);
        if (receipt.cleanup === 'complete') unsubscribe?.();
        return { ...receipt, router: router.snapshot() };
      })().finally(() => { closeWork = undefined; });
      return closeWork;
    }
    return Object.freeze({ id: environment.id, peer: environment.peer,
      kickoff: text => router.kickoff(text), ingest: event => router.ingest(event), wait: (...args) => router.wait(...args), close,
      poll: () => subscription.poll?.(), snapshot: () => environment.redact({ ...environment.snapshot(), closing, router: router.snapshot(), subscription: subscription.snapshot?.() }), redact: environment.redact });
  } catch (error) {
    router?.stop(); startup.abort();
    let cleanup = { cleanup: error.cleanup === 'pending' ? 'pending' : 'complete' };
    try { await bounded(stopSource, 1000, 'ROUTER_SOURCE_CLOSE_FAILED'); } catch { cleanup = { cleanup: 'pending' }; }
    if (environment) {
      try { const receipt = await bounded(() => environment.close({ timeoutMs: options.closeTimeoutMs ?? 60_000 }), options.closeTimeoutMs ?? 60_000, 'ROUTER_CORE_CLOSE_PENDING');
        if (receipt.cleanup !== 'complete') cleanup = receipt; await router?.finishClose(receipt);
      } catch { cleanup = { cleanup: 'pending' }; }
    }
    await router?.finishClose(cleanup);
    throw Object.assign(new Error('Agensh router initialization failed'), { code: ['ROUTER_SUBSCRIPTION_TIMEOUT', 'ROUTER_SUBSCRIPTION_NOT_READY', 'ROUTER_SOURCE_NOT_READY', 'ROUTER_SOURCE_DM_SCOPE', 'ROUTER_READINESS_INVALID', 'ENVIRONMENT_START_ABORTED'].includes(error.code) ? error.code : 'ROUTER_START_FAILED',
      runtimeId: environment?.id ?? error.runtimeId, cleanup: cleanup.cleanup, ...(error.reportPath ? { reportPath: error.reportPath } : {}), details: environment ? [environment.redact({ cleanup, environment: environment.snapshot(), router: router?.snapshot() })] : error.details });
  }
}

/** Host report keeps final batches even when business or cleanup fails. */
export function runAgenshRouter(options, business) {
  let owned;
  return runWithReport({ outputDir: options.outputDir, closeTimeoutMs: options.closeTimeoutMs ?? 60_000,
    createRuntime: async () => { owned = await createAgenshRouterEnvironment(options); return owned; },
    run: environment => business(environment),
    redact: report => {
      const value = { ...report, environment: owned?.snapshot() };
      const safe = owned ? owned.redact(value) : value;
      return options.redact ? options.redact(safe) : safe;
    },
  });
}

import { createPeerMeshHarness } from './index.js';
import { preparePeerMeshFacilities } from './provision.js';
import { httpClient } from './http.js';
import { createPeerMeshRouter } from './router.js';
import { createPeerMeshEventSubscription } from './event-source.js';
import { runWithReport } from '../shared/run-report.js';

const failure = (code: any) => Object.assign(new Error(code), { code });
async function bounded(operation: any, timeoutMs: any, code: any) {
  let timer: any;
  try { return await Promise.race([Promise.resolve().then(operation), new Promise<any>((_: any, reject: any) => { timer = setTimeout(() => reject(failure(code)), Math.max(1, timeoutMs)); })]); }
  finally { clearTimeout(timer); }
}

/** T13 identity/facility ownership, with one T14 router as the only input path. */
export async function createPeerMeshRouterHarness(options: any) {
  const readinessTimeoutMs = options.router?.readinessTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(readinessTimeoutMs) || readinessTimeoutMs < 1 || readinessTimeoutMs > 2147483647) throw new TypeError('Router readiness needs a finite timeout');
  let facilities: any; let environment: any; let router: any; let subscription: any; let unsubscribe: any; let closing = false; let closeWork: any; let sourceStop: any; let sourceStopFailed = false;
  const stopSource = () => {
    if (sourceStopFailed) { sourceStop = undefined; sourceStopFailed = false; }
    sourceStop ??= Promise.resolve().then(() => subscription?.stop());
    sourceStop.catch(() => { sourceStopFailed = true; }); return sourceStop;
  };
  const startup: any = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, startup.signal]) : startup.signal;
  try {
    environment = await createPeerMeshHarness({ ...options, signal, prepare: async (input: any) => {
      facilities = await (options.prepare ?? preparePeerMeshFacilities)(input); return facilities;
    } });
    const mapping = Object.freeze({ botId: environment.peer.id, workerId: facilities.peer.board.workerId });
    const board = httpClient(facilities.endpoints.board);
    router = createPeerMeshRouter({ ...options.router, mapping, runInput: environment.runInput,
      onFence: () => { startup.abort(); void stopSource().catch(() => {}); },
      readContext: options.router?.readContext ?? (async ({ signal }: any) => {
        const value = await board('GET', `/board/${encodeURIComponent(facilities.boardId)}/read?viewer=${encodeURIComponent(mapping.workerId)}`, undefined, { signal });
        return value.rendered;
      }) });
    unsubscribe = environment.onEvent(router.observe);
    const subscribe = options.router?.subscribe ?? ((input: any) => createPeerMeshEventSubscription({ ...options.router?.events, ...input, facilities, onFailure: () => router.stop('ROUTER_SOURCE_FAILED') }));
    subscription = await bounded(() => subscribe({ mapping, ingest: router.ingest, signal }), readinessTimeoutMs, 'ROUTER_SUBSCRIPTION_TIMEOUT');
    if (subscription?.ready !== true || typeof subscription.stop !== 'function') throw Object.assign(new Error('Router subscriptions are not ready'), { code: 'ROUTER_SUBSCRIPTION_NOT_READY' });
    signal.throwIfAborted(); router.markReady();
    async function close({ timeoutMs = 60_000 }: any = {}) {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new TypeError('Router close needs a finite timeout');
      closing = true; router.stop(); startup.abort();
      if (!closeWork) closeWork = (async () => {
        const end = Date.now() + timeoutMs;
        let sourceFailure: any;
        try { await bounded(stopSource, Math.max(1, Math.floor(timeoutMs / 2)), 'ROUTER_SOURCE_CLOSE_FAILED'); }
        catch { sourceFailure = { code: 'ROUTER_SOURCE_CLOSE_FAILED' }; }
        let receipt: any;
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
      kickoff: (text: any) => router.kickoff(text), ingest: (event: any) => router.ingest(event), wait: (...args: any) => router.wait(...args), close,
      poll: () => subscription.poll?.(), snapshot: () => environment.redact({ ...environment.snapshot(), closing, router: router.snapshot(), subscription: subscription.snapshot?.() }), redact: environment.redact });
  } catch (error: any) {
    router?.stop(); startup.abort();
    let cleanup: any = { cleanup: error.cleanup === 'pending' ? 'pending' : 'complete' };
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
export function runPeerMeshRouter(options: any, business: any) {
  let owned: any;
  return runWithReport({ outputDir: options.outputDir, closeTimeoutMs: options.closeTimeoutMs ?? 60_000,
    createRuntime: async () => { owned = await createPeerMeshRouterHarness(options); return owned; },
    run: (environment: any) => business(environment),
    redact: (report: any) => {
      const value: any = { ...report, environment: owned?.snapshot() };
      const safe = owned ? owned.redact(value) : value;
      return options.redact ? options.redact(safe) : safe;
    },
  });
}

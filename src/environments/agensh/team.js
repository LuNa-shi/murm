import { createRuntime } from '../../core/index.js';
import { createPeerProfile } from './index.js';
import { prepareAgenshFacilities } from './provision.js';
import { createAgenshServices } from './services.js';
import { createOwnedResources } from './resources.js';
import { createAgenshRouter } from './router.js';
import { createAgenshEventSubscription } from './event-source.js';
import { httpClient } from './http.js';
import { runInput } from '../shared/run-input.js';
import { runWithReport } from '../shared/run-report.js';

const fail = code => Object.assign(new Error(code), { code });
const finite = value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
async function bounded(work, timeoutMs, code) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => { timer = setTimeout(() => reject(fail(code)), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}

/** One public Core Runtime with a fixed independently authenticated peer pool. */
export async function createAgenshTeam(options) {
  const { runId, image, outputDir, backend, model = 'default', exportLimit = 8 * 1024 ** 2, peerKeys = ['a', 'b'] } = options;
  const readinessTimeoutMs = options.router?.readinessTimeoutMs ?? 10_000;
  if (typeof runId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(runId ?? '') || typeof image !== 'string' || !image || typeof outputDir !== 'string' || !outputDir ||
      !finite(exportLimit) || exportLimit > 64 * 1024 ** 2 || !finite(readinessTimeoutMs) ||
      !Array.isArray(peerKeys) || peerKeys.length < 2 || peerKeys.length > 8 || new Set(peerKeys).size !== peerKeys.length || peerKeys.some(key => typeof key !== 'string' || !/^[a-z][a-z0-9-]{0,15}$/.test(key))) throw new TypeError('Agensh team needs bounded distinct peers, image, output directory and export');
  const resources = createOwnedResources(); const lifetime = new AbortController();
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw new TypeError('Team signal must be an AbortSignal');
  const signal = options.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal;
  const secrets = [options.gitea?.adminToken, options.mattermost?.adminToken, ...(options.secretValues ?? [])].filter(value => typeof value === 'string' && value);
  const redact = value => { let bytes = JSON.stringify(value); for (const secret of [...secrets].sort((a, b) => b.length - a.length)) bytes = bytes.split(JSON.stringify(secret).slice(1, -1)).join('[redacted]'); return JSON.parse(bytes); };
  const peers = new Map(); const routers = new Map(); const subscriptions = new Map(); const unsubscriptions = []; const pendingSources = new Set();
  let runtime, facilities, services, closing = false, closeWork, completed, fencedFailure;
  const check = () => { if (signal.aborted) throw fencedFailure ?? fail('ENVIRONMENT_START_ABORTED'); };
  const snapshot = () => redact({ runId, runtimeId: runtime?.id, closing, identities: services?.identities(), resources: resources.snapshot(),
    peers: [...peers].map(([key, bot]) => ({ key, botId: bot.id, profile: bot.profile, router: routers.get(key)?.snapshot(), subscription: subscriptions.get(key)?.snapshot?.() })) });
  function stop(reason) { closing = true; for (const router of routers.values()) router.stop(); lifetime.abort(reason); }
  function fence(reason) {
    if (closing || signal.aborted) return;
    const code = typeof reason === 'string' ? reason : reason?.code;
    const detail = typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'AGENSH_SOURCE_FAILED';
    fencedFailure = Object.assign(fail('AGENSH_TEAM_FENCED'), { details: [{ code: detail }] });
    stop(fencedFailure);
  }
  async function close({ timeoutMs = 60_000 } = {}) {
    if (!finite(timeoutMs)) throw new TypeError('Agensh close requires a finite wait');
    stop(); if (completed) return structuredClone(completed);
    if (!closeWork) closeWork = (async () => {
      const end = Date.now() + timeoutMs;
      const sourceCreation = await Promise.allSettled([...pendingSources].map(work => bounded(() => work, Math.max(1, Math.floor(timeoutMs / 3)), 'SOURCE_CREATE_PENDING')));
      const sourceResults = await Promise.allSettled([...subscriptions.values()].map(source => bounded(() => source.stop(), Math.max(1, Math.floor(timeoutMs / 3)), 'SOURCE_STOP_PENDING')));
      let core;
      try { core = runtime ? await bounded(() => runtime.close({ timeoutMs: Math.max(1, end - Date.now()) }), Math.max(1, end - Date.now()), 'CORE_CLOSE_PENDING') : { cleanup: 'complete', bots: [], pending: [] }; }
      catch { core = { cleanup: 'pending', bots: [...peers.values()].map(bot => ({ botId: bot.id, execution: 'unknown', cleanup: 'pending' })), pending: [{ kind: 'runtime-close', id: runtime?.id }] }; }
      for (const router of routers.values()) await router.finishClose(core);
      const sourcesPending = pendingSources.size > 0 || [...sourceResults, ...sourceCreation].some(row => row.status === 'rejected');
      if (core.cleanup !== 'complete' || core.bots?.some(bot => bot.execution !== 'stopped' || bot.cleanup !== 'complete') || sourcesPending) return { ...core, cleanup: 'pending', sourceCleanup: sourcesPending ? 'pending' : 'complete', environment: { cleanup: 'pending', resources: resources.snapshot() } };
      const environment = await bounded(() => resources.close(), Math.max(1, end - Date.now()), 'FACILITY_CLOSE_PENDING').catch(() => ({ cleanup: 'pending', resources: resources.snapshot() }));
      const receipt = { ...core, cleanup: environment.cleanup, environment };
      if (receipt.cleanup === 'complete') { completed = receipt; for (const unsubscribe of unsubscriptions) unsubscribe(); }
      return structuredClone(receipt);
    })().finally(() => { closeWork = undefined; });
    return closeWork;
  }
  const abortStartup = () => { if (runtime) void runtime.close({ timeoutMs: 1 }).catch(() => {}); };
  signal.addEventListener('abort', abortStartup, { once: true });
  try {
    check(); facilities = await (options.prepare ?? prepareAgenshFacilities)({ ...options, peerKeys, resources, signal }); check();
    if (facilities.runId !== runId || facilities.peers?.length !== peerKeys.length || facilities.peers.some((peer, index) => peer.key !== peerKeys[index])) throw fail('TEAM_IDENTITY_INVALID');
    for (const peer of facilities.peers) secrets.push(peer.gitea.token, peer.message.token);
    const repository = new URL(facilities.repositoryUrl);
    if (repository.origin !== new URL(facilities.endpoints.gitea).origin || repository.username || repository.password || repository.search || repository.hash) throw fail('TEAM_IDENTITY_INVALID');
    services = createAgenshServices(facilities);
    const profiles = Object.fromEntries(facilities.peers.map(peer => [`peer-${peer.key}`, createPeerProfile({ image, model, facilities: { ...facilities, peer } })]));
    runtime = await createRuntime({ backend, services: services.services, profiles, maxBots: peerKeys.length, outputDir }); check();
    for (const peer of facilities.peers) {
      const profile = `peer-${peer.key}`;
      const bot = await runtime.spawn({ requestId: `spawn-${peer.key}`, profile, bindings: services.bindingsFor(peer.key), secretEnv: { GITEA_TOKEN: peer.gitea.token }, collect: { paths: ['.'], includeGit: true, maxBytes: exportLimit, required: true } });
      peers.set(peer.key, bot); check(); services.bindBot({ runtimeId: runtime.id, botId: bot.id, peerKey: peer.key, profile });
    }
    for (const peer of facilities.peers) {
      const bot = peers.get(peer.key); const mapping = { botId: bot.id, workerId: peer.board.workerId };
      const board = httpClient(facilities.endpoints.board);
      const router = createAgenshRouter({ ...options.router, mapping, onFence: fence,
        runInput: (text, wait) => runInput(runtime, bot.id, text, { ...wait, signal: AbortSignal.any([signal, wait.signal]) }),
        readContext: options.router?.readContext ?? (async ({ signal }) => (await board('GET', `/board/${encodeURIComponent(facilities.boardId)}/read?viewer=${encodeURIComponent(peer.board.workerId)}`, undefined, { signal })).rendered) });
      routers.set(peer.key, router); unsubscriptions.push(runtime.onEvent(router.observe));
      const subscribe = options.router?.subscribe ?? createAgenshEventSubscription;
      const creation = Promise.resolve().then(() => subscribe({ ...options.router?.events, facilities: { ...facilities, peer }, mapping, ingest: router.ingest, signal, onFailure: fence })).then(async source => {
        if (typeof source?.stop !== 'function') throw fail('TEAM_SOURCE_NOT_READY');
        subscriptions.set(peer.key, source);
        if (closing) await source.stop();
        return source;
      });
      pendingSources.add(creation);
      void creation.finally(() => pendingSources.delete(creation)).catch(() => {});
      const source = await bounded(() => creation, readinessTimeoutMs, 'TEAM_SOURCE_NOT_READY');
      if (source.ready !== true) throw fail('TEAM_SOURCE_NOT_READY');
      check();
    }
    for (const router of routers.values()) router.markReady();
    return Object.freeze({ id: runtime.id, snapshot, redact, close, signal,
      kickoff(key, text) { if (closing || !routers.has(key)) throw fail('UNKNOWN_RECIPIENT'); return routers.get(key).kickoff(text); },
      ingest(key, event) { if (closing || !routers.has(key)) throw fail('UNKNOWN_RECIPIENT'); return routers.get(key).ingest(event); },
      wait(key, batchId, wait) { if (!routers.has(key)) throw fail('UNKNOWN_RECIPIENT'); return routers.get(key).wait(batchId, wait); },
      poll: () => Promise.all([...subscriptions.values()].map(source => source.poll?.())),
    });
  } catch (error) {
    const receipt = !runtime && error.cleanup === 'pending' ? { cleanup: 'pending' } : await close({ timeoutMs: options.closeTimeoutMs ?? 60_000 }).catch(() => ({ cleanup: 'pending' }));
    throw Object.assign(new Error('Agensh team initialization failed'), { code: fencedFailure?.code ?? error.code ?? 'TEAM_START_FAILED', runtimeId: runtime?.id ?? error.runtimeId, cleanup: receipt.cleanup, details: [...(fencedFailure?.details ?? []), snapshot(), redact(receipt)] });
  } finally { signal.removeEventListener('abort', abortStartup); }
}

export function runAgenshTeam(options, business) {
  let owned;
  return runWithReport({ outputDir: options.outputDir, closeTimeoutMs: options.closeTimeoutMs ?? 60_000,
    createRuntime: async () => { owned = await createAgenshTeam(options); return owned; }, run: environment => business(environment),
    redact: report => owned ? owned.redact({ ...report, environment: owned.snapshot() }) : report });
}

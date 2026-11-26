import { resolve } from 'node:path';
import { createRuntime } from '../../core/index.js';
import { createPeerProfile } from './index.js';
import { preparePeerMeshFacilities } from './provision.js';
import { createPeerMeshDelivery } from './delivery.js';
import { createPeerMeshServices } from './services.js';
import { createOwnedResources } from './resources.js';
import { createPeerMeshRouter } from './router.js';
import { createPeerMeshEventSubscription } from './event-source.js';
import { httpClient } from './http.js';
import { runInput } from '../shared/run-input.js';
import { createInputAdmission } from '../shared/input-admission.js';
import { runWithReport } from '../shared/run-report.js';

const fail = (code: any) => Object.assign(new Error(code), { code });
const finite = (value: any) => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
async function bounded(work: any, timeoutMs: any, code: any) {
  let timer: any;
  try { return await Promise.race([Promise.resolve().then(work), new Promise<any>((_: any, reject: any) => { timer = setTimeout(() => reject(fail(code)), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}

/** One public Core Runtime with a fixed independently authenticated peer pool. */
export async function createPeerMeshTeam(options: any) {
  const { runId, image, outputDir, sandbox, executor, models, connection, model = 'default', exportLimit = 8 * 1024 ** 2, peerKeys = ['a', 'b'] } = options;
  const durationMs = options.project?.durationMs ?? 3_600_000;
  if (options.project !== undefined && (!finite(durationMs) || durationMs > 86_400_000 ||
      typeof options.project?.title !== 'string' || typeof options.project?.body !== 'string' ||
      !options.project.body.trim() || Buffer.byteLength(options.project.body) > 16_000)) throw new TypeError('PeerMesh project requires a goal and bounded duration');
  const readinessTimeoutMs = options.router?.readinessTimeoutMs ?? 10_000;
  if (typeof runId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(runId ?? '') || typeof image !== 'string' || !image || typeof outputDir !== 'string' || !outputDir ||
      (options.maxConcurrentInputs !== undefined && (!Number.isSafeInteger(options.maxConcurrentInputs) || options.maxConcurrentInputs < 1 || options.maxConcurrentInputs > peerKeys.length)) ||
      !finite(exportLimit) || exportLimit > 64 * 1024 ** 2 || !finite(readinessTimeoutMs) ||
      !Array.isArray(peerKeys) || peerKeys.length < 2 || peerKeys.length > 8 || new Set(peerKeys).size !== peerKeys.length || peerKeys.some((key: any) => typeof key !== 'string' || !/^[a-z][a-z0-9-]{0,15}$/.test(key))) throw new TypeError('PeerMesh team needs bounded distinct peers, image, output directory and export');
  const resources = createOwnedResources(); const lifetime: any = new AbortController();
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw new TypeError('Team signal must be an AbortSignal');
  const signal = options.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal;
  const inputAdmission = options.maxConcurrentInputs === undefined ? undefined : createInputAdmission({ maxConcurrent: options.maxConcurrentInputs, maxPending: peerKeys.length, signal });
  const secrets = [options.gitea?.adminToken, options.mattermost?.adminToken, ...(options.secretValues ?? [])].filter((value: any) => typeof value === 'string' && value);
  const redact = (value: any) => { let bytes = JSON.stringify(value); for (const secret of [...secrets].sort((a: any, b: any) => b.length - a.length)) bytes = bytes.split(JSON.stringify(secret).slice(1, -1)).join('[redacted]'); return JSON.parse(bytes); };
  const peers: any = new Map(); const routers: any = new Map(); const subscriptions: any = new Map(); const unsubscriptions: any[] = []; const pendingSources: any = new Set();
  const stoppedPeers: any = new Set(), unavailablePeers: any = new Map();
  let delivery: ReturnType<typeof createPeerMeshDelivery> | undefined;
  let deliveryReceipt: { state: string; code?: string; commit?: string; stable?: boolean; archive?: string; sha256?: string; bytes?: number } | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let startedAt: string | undefined;
  let runtime: any, facilities: any, services: any, closing = false, closeWork: any, completed: any, fencedFailure: any;
  const hostStreamFailure = () => ['HOST_INPUT_FAILED', 'HOST_OUTPUT_FAILED'].includes(signal.reason?.code) ? signal.reason.code : undefined;
  const check = () => {
    if (signal.aborted) throw fencedFailure ?? fail(hostStreamFailure() ?? 'HARNESS_START_ABORTED');
  };
  const peerStates = () => [...peers].map(([key, agent]: any) => ({ key, agentId: agent.id, profile: agent.profile,
    ...(unavailablePeers.has(agent.id) ? { unavailable: unavailablePeers.get(agent.id) } : {}),
    router: routers.get(key)?.snapshot(), subscription: subscriptions.get(key)?.snapshot?.() }));
  const snapshot = () => redact({ runId, runtimeId: runtime?.id, closing, identities: services?.identities(), ...(delivery ? { project: { repository: facilities.repository, issue: facilities.issueNumber,
    startedAt, durationMs, initialCommit: facilities.initialCommit, initialDigest: options.initialDigest, delivery: deliveryReceipt, merges: delivery.snapshot() } } : {}), resources: resources.snapshot(), peers: peerStates() });
  function stop(reason?: unknown) { clearTimeout(deadlineTimer); delivery?.stop(); inputAdmission?.close(); closing = true; for (const router of routers.values()) router.stop(); lifetime.abort(reason); }
  function fence(reason: any) {
    if (closing || signal.aborted) return;
    const code = typeof reason === 'string' ? reason : reason?.code;
    const detail = typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'PEERMESH_SOURCE_FAILED';
    fencedFailure = Object.assign(fail('PEERMESH_TEAM_FENCED'), { details: [{ code: detail }] });
    stop(fencedFailure);
  }
  async function close({ timeoutMs = 60_000 }: any = {}) {
    if (!finite(timeoutMs)) throw new TypeError('PeerMesh close requires a finite wait');
    stop(); if (completed) return structuredClone(completed);
    if (!closeWork) closeWork = (async () => {
      const end = Date.now() + timeoutMs;
      const sourceCreation = await Promise.allSettled([...pendingSources].map((work: any) => bounded(() => work, Math.max(1, Math.floor(timeoutMs / 3)), 'SOURCE_CREATE_PENDING')));
      const sourceResults = await Promise.allSettled([...subscriptions.values()].map((source: any) => bounded(() => source.stop(), Math.max(1, Math.floor(timeoutMs / 3)), 'SOURCE_STOP_PENDING')));
      const deliveryWork = delivery && startedAt && (!deliveryReceipt || deliveryReceipt.state === 'pending')
        ? delivery.finalize(resolve(outputDir, runtime.id), AbortSignal.timeout(Math.max(1, end - Date.now())))
          .then(value => { deliveryReceipt = { ...value, state: value.stable ? 'complete' : 'pending', ...(!value.stable ? { code: 'DELIVERY_MERGE_UNKNOWN' } : {}) }; },
            error => { deliveryReceipt = { ...error.pin, state: 'pending', code: error.code ?? 'DELIVERY_EXPORT_FAILED' }; })
        : undefined;
      let core: any;
      try { core = runtime ? await bounded(() => runtime.close({ timeoutMs: Math.max(1, end - Date.now()) }), Math.max(1, end - Date.now()), 'CORE_CLOSE_PENDING') : { cleanup: 'complete', agents: [], pending: [] }; }
      catch { core = { cleanup: 'pending', agents: [...peers.values()].map((agent: any) => ({ agentId: agent.id, execution: 'unknown', cleanup: 'pending' })), pending: [{ kind: 'runtime-close', id: runtime?.id }] }; }
      const routersDrained = await bounded(() => Promise.all([...routers.values()].map(router => router.finishClose(core))),
        Math.max(1, end - Date.now()), 'ROUTER_CLOSE_PENDING').then(() => true, () => false);
      if (deliveryWork) {
        await bounded(() => deliveryWork, Math.max(1, end - Date.now()), 'DELIVERY_EXPORT_PENDING')
          .catch(() => { deliveryReceipt ??= { state: 'pending', code: 'DELIVERY_EXPORT_PENDING' }; });
      }
      const sourcesPending = pendingSources.size > 0 || [...sourceResults, ...sourceCreation].some((row: any) => row.status === 'rejected');
      if (core.cleanup !== 'complete' || core.agents?.some((agent: any) => agent.execution !== 'stopped' || agent.cleanup !== 'complete') || sourcesPending || !routersDrained || deliveryReceipt?.state === 'pending') return { ...core, cleanup: 'pending', ...(deliveryReceipt ? { delivery: deliveryReceipt } : {}), sourceCleanup: sourcesPending ? 'pending' : 'complete', ...(!routersDrained ? { routerCleanup: 'pending' } : {}), harness: { cleanup: 'pending', resources: resources.snapshot() } };
      const harness = await bounded(() => resources.close(), Math.max(1, end - Date.now()), 'FACILITY_CLOSE_PENDING').catch(() => ({ cleanup: 'pending', resources: resources.snapshot() }));
      const receipt: any = { ...core, cleanup: harness.cleanup, harness, ...(deliveryReceipt ? { delivery: deliveryReceipt } : {}) };
      if (receipt.cleanup === 'complete') { completed = receipt; for (const unsubscribe of unsubscriptions) unsubscribe(); }
      return structuredClone(receipt);
    })().finally(() => { closeWork = undefined; });
    return closeWork;
  }
  const abortStartup = () => { if (runtime) void runtime.close({ timeoutMs: 1 }).catch(() => {}); };
  signal.addEventListener('abort', abortStartup, { once: true });
  try {
    check(); facilities = await (options.prepare ?? preparePeerMeshFacilities)({ ...options, peerKeys, resources, signal }); check();
    if (facilities.runId !== runId || facilities.peers?.length !== peerKeys.length || facilities.peers.some((peer: any, index: any) => peer.key !== peerKeys[index])) throw fail('TEAM_IDENTITY_INVALID');
    for (const peer of facilities.peers) secrets.push(peer.gitea.token, peer.message.token);
    const repository: any = new URL(facilities.repositoryUrl);
    if (repository.origin !== new URL(facilities.endpoints.gitea).origin || repository.username || repository.password || repository.search || repository.hash) throw fail('TEAM_IDENTITY_INVALID');
    if (options.project) {
      if (facilities.project !== true || (options.projectFiles !== undefined && !/^[a-f0-9]{40}$/.test(facilities.initialCommit ?? ''))) throw fail('TEAM_PROJECT_NOT_READY');
      delivery = createPeerMeshDelivery({ facilities, adminToken: options.gitea?.adminToken });
      signal.addEventListener('abort', () => delivery?.stop(), { once: true });
    }
    function projectFailure(agentId: string, key: string, error: any) {
      if (closing || signal.aborted) return;
      unavailablePeers.set(agentId, { type: 'routing', code: error?.code ?? error });
      routers.get(key)?.stop();
    }
    services = createPeerMeshServices(facilities, delivery, options.project ? entry => {
      if (closing || signal.aborted) return;
      const label = `G${entry.gistId}`;
      const content = Buffer.from([`${entry.type} ${label}`, entry.content, entry.detail].filter(Boolean).join('\n'));
      const text = content.length <= 16 * 1024 ? content.toString('utf8')
        : new TextDecoder().decode(content.subarray(0, 16 * 1024 - 3), { stream: true }) + '…';
      for (const peer of facilities.peers) {
        if (peer.board.workerId === entry.workerId || stoppedPeers.has(peer.key)) continue;
        const router = routers.get(peer.key);
        if (!router) continue;
        try {
          router.ingest({ source: 'board', kind: 'board-entry', eventId: label, targetWorker: peer.board.workerId, text,
            origin: { senderId: entry.workerId, object: facilities.boardId } });
        } catch (error: any) { projectFailure(peers.get(peer.key).id, peer.key, error); }
      }
    } : undefined);
    const profiles = Object.fromEntries(facilities.peers.map((peer: any) => [`peer-${peer.key}`, createPeerProfile({ image, model, facilities: { ...facilities, peer } })]));
    runtime = await createRuntime({ sandbox, executor, models, connection, services: services.services, profiles, maxAgents: peerKeys.length, outputDir }); check();
    options.onRuntime?.(runtime, snapshot);
    unsubscriptions.push(runtime.onEvent((event: any) => {
      const planned = closing || [...stoppedPeers].some((key: any) => peers.get(key)?.id === event.agentId);
      if (!planned && (event.type === 'exit' || (event.type === 'error' && event.fatal))) {
        unavailablePeers.set(event.agentId, { type: event.type });
      }
    }));
    for (const peer of facilities.peers) {
      const profile = `peer-${peer.key}`;
      const agent = await runtime.spawn({ requestId: `spawn-${peer.key}`, profile, ...(options.projectFiles === undefined ? {} : { files: options.projectFiles }), bindings: services.bindingsFor(peer.key), secretEnv: { GITEA_TOKEN: peer.gitea.token }, collect: { paths: ['.'], includeGit: true, ...(options.project ? { allowMissingGit: true } : {}), maxBytes: exportLimit, required: true } });
      peers.set(peer.key, agent); check(); services.bindAgent({ runtimeId: runtime.id, agentId: agent.id, peerKey: peer.key, profile });
    }
    for (const peer of facilities.peers) {
      const agent = peers.get(peer.key); const mapping: any = { agentId: agent.id, workerId: peer.board.workerId };
      const board = httpClient(facilities.endpoints.board);
      const failRouting = options.project ? (error: any) => projectFailure(agent.id, peer.key, error) : fence;
      const router = createPeerMeshRouter({ ...(options.project ? {
        workTimeoutMs: durationMs + 120_000, turnTimeoutMs: durationMs, maxBatches: 256, idleNudgeMs: 120_000, maxNudges: 8,
      } : {}), ...options.router, mapping, onFence: failRouting,
        steerInput: options.project ? (text: string, requestId: string) => runtime.send(agent.id, text, { requestId, mode: 'steer', source: 'peermesh-peer-notice', steeringMode: 'all' }) : undefined,
        runInput: (text: any, wait: any) => {
          const send = () => runInput(runtime, agent.id, text, { ...wait, signal: AbortSignal.any([signal, wait.signal]) });
          return inputAdmission ? inputAdmission.run(send) : send();
        },
        readContext: options.router?.readContext ?? (async ({ signal }: any) => (await board('GET', `/board/${encodeURIComponent(facilities.boardId)}/read?viewer=${encodeURIComponent(peer.board.workerId)}`, undefined, { signal })).rendered) });
      routers.set(peer.key, router); unsubscriptions.push(runtime.onEvent(router.observe));
      const subscribe = options.router?.subscribe ?? createPeerMeshEventSubscription;
      const creation = Promise.resolve().then(() => subscribe({ ...(options.project ? { pollIntervalMs: 2500, dmChannelIds: Object.values(facilities.directChannels?.[peer.key] ?? {}) } : {}),
        ...options.router?.events, facilities: { ...facilities, peer }, mapping, ingest: router.ingest, signal,
        onFailure: failRouting })).then(async (source: any) => {
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
    if (options.project) {
      startedAt = new Date().toISOString();
      deadlineTimer = setTimeout(() => stop(fail('PEERMESH_PROJECT_DEADLINE')), durationMs);
      check();
      options.beforeInitialDispatch?.();
      for (const router of routers.values()) router.kickoff(options.project.body);
    }
    return Object.freeze({ id: runtime.id, snapshot, redact, close, signal, getAgent: runtime.get,
      currentPeers: () => ({ closing, peers: peerStates() }),
      async stopPeer(key: any, { timeoutMs = 60_000 }: any = {}) {
        if (closing || !peers.has(key)) throw fail('UNKNOWN_RECIPIENT');
        if (!finite(timeoutMs)) throw new TypeError('Peer stop requires a finite wait');
        // Fence this peer's event/input owners before stopping its Core Agent.
        // Facility credentials and all cleanup ownership remain with team.close.
        const end = performance.now() + timeoutMs;
        stoppedPeers.add(key); routers.get(key).stop();
        await bounded(() => subscriptions.get(key).stop(), timeoutMs, 'SOURCE_STOP_PENDING');
        return runtime.stop(peers.get(key).id, { timeoutMs: Math.max(1, Math.floor(end - performance.now())) });
      },
      kickoff(key: any, text: any) { if (closing || !routers.has(key)) throw fail('UNKNOWN_RECIPIENT'); return routers.get(key).kickoff(text); },
      ingest(key: any, event: any) { if (closing || !routers.has(key)) throw fail('UNKNOWN_RECIPIENT'); return routers.get(key).ingest(event); },
      wait(key: any, batchId: any, wait: any) { if (!routers.has(key)) throw fail('UNKNOWN_RECIPIENT'); return routers.get(key).wait(batchId, wait); },
      poll: () => Promise.all([...subscriptions].filter(([key]: any) => !stoppedPeers.has(key)).map(([, source]: any) => source.poll?.())),
    });
  } catch (error: any) {
    const code = fencedFailure?.code ?? hostStreamFailure() ?? error.code ?? 'TEAM_START_FAILED';
    const receipt = !runtime && error.cleanup === 'pending' ? { cleanup: 'pending' } : await close({ timeoutMs: options.closeTimeoutMs ?? 60_000 }).catch(() => ({ cleanup: 'pending' }));
    throw Object.assign(new Error('PeerMesh team initialization failed'), { code, runtimeId: runtime?.id ?? error.runtimeId, cleanup: receipt.cleanup, details: [...(fencedFailure?.details ?? []), snapshot(), redact(receipt)] });
  } finally { signal.removeEventListener('abort', abortStartup); }
}

export function runPeerMeshTeam(options: any, business: any) {
  let owned: any;
  return runWithReport({ outputDir: options.outputDir, closeTimeoutMs: options.closeTimeoutMs ?? 60_000,
    createRuntime: async () => { owned = await createPeerMeshTeam(options); return owned; }, run: (harness: any) => business(harness),
    redact: (report: any) => owned ? owned.redact({ ...report, harness: owned.snapshot() }) : report });
}

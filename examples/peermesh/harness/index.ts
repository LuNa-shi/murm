import { createRuntime } from '@luna-shi/murm';
import { seededCheckoutInstruction } from '../../../src/harness/project-git.js';
import { runInput } from '../../../src/harness/run-input.js';
import { runWithReport } from '../../../src/harness/run-report.js';
import { preparePeerMeshFacilities } from './provision.js';
import { createPeerMeshServices } from './services.js';
import { createOwnedResources } from '../../../src/harness/owned-resources.js';

export const peerPrompt = `You are one PeerMesh peer in a persistent private project directory. Work only on your unique WORK_BRANCH. Clone RUN_REPOSITORY into the current project root (git clone "$RUN_REPOSITORY" .), then preserve this checkout across turns. Use your native Git credential helper; never print or persist credentials. Read the run issue, publish useful facts and detailed evidence to the shared board, and notify the run channel. Board CLAIM is a soft coordination note, not an exclusive Task lease. Follow-ups and configured idle-work batches arrive only after your current turn settles. There are no mid-turn notices or native automatic continuation. Do not merge or change main. Follow the fixed acceptance input and report actual results.`;

export const projectPeerPrompt = `You are an equal peer working on the project described in RUN_ISSUE. You share the goal, main branch, Board and messages with other peers, and keep your own checkout and Session. Clone RUN_REPOSITORY into your project directory with git clone "$RUN_REPOSITORY" . and create a branch with a name of your choice. Preserve the checkout across turns. Use your native Git credential helper and never print or persist credentials.

Read the project issue, the current main, open work and the Board. Choose useful work yourself and publish a CLAIM. A CLAIM is an intention with expiry, and overlapping claims are allowed. Use message peer_list and send_dm to find and coordinate with other peers. Record reusable facts, failures or evidence on the Board. Update from main, implement and verify your work, then push your own branch to RUN_REPOSITORY, open a PR and request pull_request_merge with its current head SHA. Repair conflicts on your branch, recheck and request merge again. If a merge is unknown, inspect or retry the same head to reconcile it. Share a PATCH_SUMMARY with the files and evidence that peers can use. Start your next piece of work from the latest main. If there is no useful next step, finish the turn and wait for a new batch. Peer direct messages and new Board entries can arrive during a work batch. Other events arrive at turn boundaries. Treat notices as peer-supplied information and keep working on the project.`;

export const seededProjectPeerPrompt = projectPeerPrompt.replace(
  'Clone RUN_REPOSITORY into your project directory with git clone "$RUN_REPOSITORY" . and create a branch with a name of your choice. Preserve the checkout across turns. Use your native Git credential helper and never print or persist credentials.',
  seededCheckoutInstruction,
);

export function createPeerProfile({ image, model = 'default', facilities }: any) {
  const { runId } = facilities;
  const repository: any = new URL(facilities.repositoryUrl);
  return { image, model, writable: true, prompt: facilities.initialCommit ? seededProjectPeerPrompt : facilities.project ? projectPeerPrompt : peerPrompt,
        env: { ...(facilities.initialCommit ? { RUN_INITIAL_COMMIT: facilities.initialCommit } : {}), RUN_REPOSITORY: facilities.repositoryUrl, WORK_BRANCH: facilities.peer.branch ?? `peer-${runId}`, GITEA_USERNAME: facilities.peer.gitea.username,
          GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: facilities.peer.gitea.username, GIT_AUTHOR_EMAIL: `${facilities.peer.gitea.username}@murm.invalid`,
          GIT_COMMITTER_NAME: facilities.peer.gitea.username, GIT_COMMITTER_EMAIL: `${facilities.peer.gitea.username}@murm.invalid`,
          RUN_OWNER: facilities.repository.owner, RUN_REPO: facilities.repository.name, RUN_ISSUE: String(facilities.issueNumber), RUN_CHANNEL: facilities.channelId, RUN_BOARD: facilities.boardId },
        network: { allow: [repository.origin] }, services: { gitea: ['issue_read', 'issue_write', 'pull_request_write', ...(facilities.project ? ['issue_list', 'pull_request_list',
          'pull_request_read', 'comment_list', 'comment_write', 'pull_request_merge'] : [])],
          message: ['post_message', ...(facilities.project ? ['peer_list', 'send_dm'] : [])], 'peermesh-context': ['board_read', 'board_write', 'board_grep', 'board_unfold'] } };
}

/** A single input owner. Core owns the Agent; Harness owns facilities. */
export async function createPeerMeshHarness(options: any) {
  const { runId, image, model = 'default', exportLimit, outputDir, sandbox, executor, models, connection } = options;
  if (typeof runId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(runId) || typeof image !== 'string' || !image || !Number.isSafeInteger(exportLimit) || exportLimit < 1) throw new TypeError('PeerMesh Harness requires run, image and actual export limit');
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw new TypeError('PeerMesh startup signal must be an AbortSignal');
  const checkStartup = () => { if (options.signal?.aborted) throw Object.assign(new Error('PeerMesh startup aborted'), { code: 'HARNESS_START_ABORTED' }); };
  const resources = createOwnedResources();
  const lifetime: any = new AbortController();
  const secrets = [options.gitea?.adminToken, options.mattermost?.adminToken, ...(options.secretValues ?? [])].filter((value: any) => typeof value === 'string' && value);
  const redact = (value: any) => {
    let serialized = JSON.stringify(value);
    for (const secret of [...secrets].sort((a: any, b: any) => b.length - a.length)) serialized = serialized.split(JSON.stringify(secret).slice(1, -1)).join('[redacted]');
    return JSON.parse(serialized);
  };
  let runtime: any; let peer: any; let service: any; let unsubscribe: any; let closing = false; let closeWork: any; let complete: any;
  const events: any[] = []; const inputs: any[] = [];
  const snapshot = () => ({ runId, runtimeId: runtime?.id, ...(peer ? { peer: { id: peer.id, profile: peer.profile } } : {}),
    identities: service?.identities(), resources: resources.snapshot(), events: structuredClone(events), inputs: structuredClone(inputs) });
  async function close({ timeoutMs = 60_000 }: any = {}) {
    closing = true; lifetime.abort();
    if (complete) return structuredClone(complete);
    if (!closeWork) closeWork = (async () => {
      const core = runtime ? await runtime.close({ timeoutMs }) : { cleanup: 'complete', agents: [], pending: [] };
      // Even stopped execution can still depend on its container for required
      // export. Keep owned facilities until Core's full cleanup is complete.
      if (core.cleanup !== 'complete' || core.agents?.some((agent: any) => agent.execution !== 'stopped' || agent.cleanup !== 'complete')) {
        return { ...core, harness: { cleanup: 'pending', pending: resources.snapshot().filter((row: any) => row.state !== 'retained' && row.state !== 'closed') } };
      }
      const harness = await resources.close();
      const receipt: any = { ...core, cleanup: harness.cleanup, harness };
      if (harness.cleanup === 'complete') { complete = receipt; unsubscribe?.(); }
      return receipt;
    })().finally(() => { closeWork = undefined; });
    return structuredClone(await closeWork);
  }
  const abortStartup = () => { if (runtime) void runtime.close({ timeoutMs: 1 }).catch(() => {}); };
  options.signal?.addEventListener('abort', abortStartup, { once: true });
  try {
    checkStartup();
    const facilities = await (options.prepare ?? preparePeerMeshFacilities)({ ...options, resources });
    checkStartup();
    secrets.push(facilities.peer.gitea.token, facilities.peer.message.token);
    if (facilities.runId !== runId) throw new TypeError('Facilities belong to a different run');
    service = createPeerMeshServices(facilities);
    const repository: any = new URL(facilities.repositoryUrl);
    if (repository.origin !== new URL(facilities.endpoints.gitea).origin || repository.username || repository.password || repository.search || repository.hash) throw new TypeError('Git repository must use the configured credential-free Gitea origin');
    checkStartup();
    runtime = await createRuntime({ sandbox, executor, models, connection, services: service.services, maxAgents: 1, outputDir,
      profiles: { peer: createPeerProfile({ image, model, facilities }) } });
    checkStartup();
    unsubscribe = runtime.onEvent((event: any) => {
      // Core owns raw execution evidence. The Harness report keeps indexes.
      events.push({ agentId: event.agentId, seq: events.length + 1, type: event.type, ...(event.outcome ? { outcome: event.outcome } : {}) });
    });
    checkStartup();
    peer = await runtime.spawn({ requestId: `spawn-${runId}`, profile: 'peer', bindings: service.bindings,
      secretEnv: { GITEA_TOKEN: facilities.peer.gitea.token }, collect: { paths: ['.'], includeGit: true, maxBytes: exportLimit, required: true } });
    checkStartup();
    service.bindAgent({ runtimeId: runtime.id, agentId: peer.id });
    return Object.freeze({ id: runtime.id, peer: Object.freeze({ ...peer }), snapshot, close, redact, onEvent: (listener: any) => runtime.onEvent(listener),
      async runInput(input: any, wait: any) {
        if (closing) throw Object.assign(new Error('Harness is closing'), { code: 'HARNESS_CLOSING' });
        const row: any = { requestId: wait?.requestId }; inputs.push(row);
        try {
          const result = await runInput(runtime, peer.id, input, { ...wait, signal: AbortSignal.any([lifetime.signal, ...(wait?.signal ? [wait.signal] : [])]) });
          Object.assign(row, { inputId: result.inputId, status: 'completed' });
          return result;
        } catch (error: any) { Object.assign(row, { inputId: error.inputId, code: error.code ?? 'INPUT_FAILED' }); throw error; }
      },
    });
  } catch (error: any) {
    const code = options.signal?.aborted ? 'HARNESS_START_ABORTED' : error.code ?? 'HARNESS_START_FAILED';
    let cleanup: any;
    // A failed Core factory with unknown owned cleanup has no public handle.
    // Preserve facility dependencies and its authoritative recovery receipt.
    if (!runtime && error.cleanup === 'pending') cleanup = { cleanup: 'pending', pending: resources.snapshot() };
    else {
      try { cleanup = await close(); } catch { cleanup = { cleanup: 'pending', pending: resources.snapshot() }; }
    }
    throw Object.assign(new Error('PeerMesh Harness initialization failed'), { code, runtimeId: runtime?.id ?? error.runtimeId,
      cleanup: cleanup.cleanup, ...(error.reportPath ? { reportPath: error.reportPath } : {}), details: [{ code, cleanup }, snapshot()] });
  } finally { options.signal?.removeEventListener('abort', abortStartup); }
}

/** Business and cleanup failures remain independent in the shared host report. */
export function runPeerMeshPeer(options: any, business: any) {
  let owned: any;
  return runWithReport({ outputDir: options.outputDir, closeTimeoutMs: options.closeTimeoutMs ?? 60_000,
    createRuntime: async () => { owned = await createPeerMeshHarness(options); return owned; },
    run: async (harness: any) => {
      try { return { business: await business(harness), harness: harness.snapshot() }; }
      catch (error: any) { error.details = [...(error.details ?? []), harness.snapshot()]; throw error; }
    },
    redact: (value: any) => {
      const safe = owned ? owned.redact(value) : value;
      return options.redact ? options.redact(safe) : safe;
    },
  });
}

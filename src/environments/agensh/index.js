import { createRuntime } from '../../core/index.js';
import { runInput } from '../shared/run-input.js';
import { runWithReport } from '../shared/run-report.js';
import { prepareAgenshFacilities } from './provision.js';
import { createAgenshServices } from './services.js';
import { createOwnedResources } from './resources.js';

export const peerPrompt = `You are one Agensh peer in a persistent private project directory. Work only on your unique WORK_BRANCH. Use Bash and swarm Service commands; discover each operation with swarm <service> <operation> --help. Clone RUN_REPOSITORY into the current project root (git clone "$RUN_REPOSITORY" .), then preserve this checkout across turns. Use your native Git credential helper; never print or persist credentials. Read the run issue, publish useful facts and detailed evidence to the shared board, and notify the run channel. Board CLAIM is a soft coordination note, not an exclusive Task lease. A follow-up arrives only after your current turn settles. No mid-turn notices or automatic continuation are provided. Do not merge or change main. Follow the fixed acceptance input and report actual results.`;

/** A single input owner. Core owns the Bot; Environment owns facilities. */
export async function createAgenshEnvironment(options) {
  const { runId, image, model = 'default', exportLimit, outputDir, backend } = options;
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(runId) || typeof image !== 'string' || !image || !Number.isSafeInteger(exportLimit) || exportLimit < 1) throw new TypeError('Agensh Environment requires run, image and actual export limit');
  const resources = createOwnedResources();
  const lifetime = new AbortController();
  const secrets = [options.gitea?.adminToken, options.mattermost?.adminToken, ...(options.secretValues ?? [])].filter(value => typeof value === 'string' && value);
  const redact = value => {
    let serialized = JSON.stringify(value);
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) serialized = serialized.split(JSON.stringify(secret).slice(1, -1)).join('[redacted]');
    return JSON.parse(serialized);
  };
  let runtime; let peer; let service; let unsubscribe; let closing = false; let closeWork; let complete;
  const events = []; const inputs = [];
  const snapshot = () => ({ runId, runtimeId: runtime?.id, ...(peer ? { peer: { id: peer.id, profile: peer.profile } } : {}),
    identities: service?.identities(), resources: resources.snapshot(), events: structuredClone(events), inputs: structuredClone(inputs) });
  async function close({ timeoutMs = 60_000 } = {}) {
    closing = true; lifetime.abort();
    if (complete) return structuredClone(complete);
    if (!closeWork) closeWork = (async () => {
      const core = runtime ? await runtime.close({ timeoutMs }) : { cleanup: 'complete', bots: [], pending: [] };
      // Even stopped execution can still depend on its container for required
      // export. Keep owned facilities until Core's full cleanup is complete.
      if (core.cleanup !== 'complete' || core.bots?.some(bot => bot.execution !== 'stopped' || bot.cleanup !== 'complete')) {
        return { ...core, environment: { cleanup: 'pending', pending: resources.snapshot().filter(row => row.state !== 'retained' && row.state !== 'closed') } };
      }
      const environment = await resources.close();
      const receipt = { ...core, cleanup: environment.cleanup, environment };
      if (environment.cleanup === 'complete') { complete = receipt; unsubscribe?.(); }
      return receipt;
    })().finally(() => { closeWork = undefined; });
    return structuredClone(await closeWork);
  }
  try {
    const facilities = await (options.prepare ?? prepareAgenshFacilities)({ ...options, resources });
    secrets.push(facilities.peer.gitea.token, facilities.peer.message.token);
    if (facilities.runId !== runId) throw new TypeError('Facilities belong to a different run');
    service = createAgenshServices(facilities);
    const repository = new URL(facilities.repositoryUrl);
    if (repository.origin !== new URL(facilities.endpoints.gitea).origin || repository.username || repository.password || repository.search || repository.hash) throw new TypeError('Git repository must use the configured credential-free Gitea origin');
    runtime = await createRuntime({ backend, services: service.services, maxBots: 1, outputDir,
      profiles: { peer: { image, model, writable: true, prompt: peerPrompt,
        env: { RUN_REPOSITORY: facilities.repositoryUrl, WORK_BRANCH: `peer-${runId}`, GITEA_USERNAME: facilities.peer.gitea.username,
          GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: facilities.peer.gitea.username, GIT_AUTHOR_EMAIL: `${facilities.peer.gitea.username}@swarmenv.invalid`,
          GIT_COMMITTER_NAME: facilities.peer.gitea.username, GIT_COMMITTER_EMAIL: `${facilities.peer.gitea.username}@swarmenv.invalid`,
          RUN_OWNER: facilities.repository.owner, RUN_REPO: facilities.repository.name, RUN_ISSUE: String(facilities.issueNumber), RUN_CHANNEL: facilities.channelId, RUN_BOARD: facilities.boardId },
        network: { allow: [repository.origin] }, services: { gitea: ['issue_read', 'issue_write', 'pull_request_write'], message: ['post_message'], 'agensh-context': ['board_read', 'board_write', 'board_grep', 'board_unfold'] } } } });
    unsubscribe = runtime.onEvent(event => {
      // Core owns raw execution evidence. The Environment report keeps indexes.
      events.push({ botId: event.botId, seq: event.seq, type: event.type, ...(event.outcome ? { outcome: event.outcome } : {}) });
    });
    peer = await runtime.spawn({ requestId: `spawn-${runId}`, profile: 'peer', bindings: service.bindings,
      secretEnv: { GITEA_TOKEN: facilities.peer.gitea.token }, collect: { paths: ['.'], includeGit: true, maxBytes: exportLimit, required: true } });
    service.bindBot({ runtimeId: runtime.id, botId: peer.id });
    return Object.freeze({ id: runtime.id, peer: Object.freeze({ ...peer }), snapshot, close, redact,
      async runInput(input, wait) {
        if (closing) throw Object.assign(new Error('Environment is closing'), { code: 'ENVIRONMENT_CLOSING' });
        const row = { requestId: wait?.requestId }; inputs.push(row);
        try {
          const result = await runInput(runtime, peer.id, input, { ...wait, signal: AbortSignal.any([lifetime.signal, ...(wait?.signal ? [wait.signal] : [])]) });
          Object.assign(row, { inputId: result.inputId, status: 'completed', settledSeq: result.settled.seq });
          return result;
        } catch (error) { Object.assign(row, { inputId: error.inputId, code: error.code ?? 'INPUT_FAILED' }); throw error; }
      },
    });
  } catch (error) {
    let cleanup;
    // A failed Core factory with unknown owned cleanup has no public handle.
    // Preserve facility dependencies and its authoritative recovery receipt.
    if (!runtime && error.cleanup === 'pending') cleanup = { cleanup: 'pending', pending: resources.snapshot() };
    else {
      try { cleanup = await close(); } catch { cleanup = { cleanup: 'pending', pending: resources.snapshot() }; }
    }
    throw Object.assign(new Error('Agensh Environment initialization failed'), { code: error.code ?? 'ENVIRONMENT_START_FAILED', runtimeId: runtime?.id ?? error.runtimeId,
      cleanup: cleanup.cleanup, ...(error.reportPath ? { reportPath: error.reportPath } : {}), details: [{ code: error.code ?? 'FACILITY_START_FAILED', cleanup }, snapshot()] });
  }
}

/** Business and cleanup failures remain independent in the shared host report. */
export function runAgenshPeer(options, business) {
  let owned;
  return runWithReport({ outputDir: options.outputDir, closeTimeoutMs: options.closeTimeoutMs ?? 60_000,
    createRuntime: async () => { owned = await createAgenshEnvironment(options); return owned; },
    run: async environment => {
      try { return { business: await business(environment), environment: environment.snapshot() }; }
      catch (error) { error.details = [...(error.details ?? []), environment.snapshot()]; throw error; }
    },
    redact: value => {
      const safe = owned ? owned.redact(value) : value;
      return options.redact ? options.redact(safe) : safe;
    },
  });
}

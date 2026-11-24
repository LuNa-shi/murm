import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenSandboxManager } from '../runtime/opensandbox-manager.js';
import { DockerBotNetwork } from '../runtime/docker-bot-network.js';
import { DockerBotDisk } from '../runtime/docker-bot-disk.js';

const handles = new WeakMap();

function invalid(message) {
  return Object.assign(new Error(message), { code: 'INVALID_CONTRACT' });
}

function freeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  return Object.freeze(value);
}

function httpUrl(value, label) {
  let url;
  try { url = new URL(value); } catch { throw invalid(`${label} must be an HTTP(S) URL`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw invalid(`${label} must be an HTTP(S) URL without embedded credentials`);
  return url;
}

function sandboxExpiry(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const instant = Date.parse(value);
  const day = value.slice(0, 10);
  const calendar = Date.parse(day);
  if (!Number.isFinite(instant) || !Number.isFinite(calendar) || new Date(calendar).toISOString().slice(0, 10) !== day) return null;
  return new Date(instant).toISOString();
}

export function createPiOpenSandboxBackend(config) {
  if (config?.isolation?.network !== 'local-docker') throw invalid('Pi/OpenSandbox requires local-docker isolation');
  httpUrl(config.sandbox?.lifecycleBaseUrl, 'sandbox.lifecycleBaseUrl');
  const timeoutSeconds = config.sandbox.timeoutSeconds === undefined ? 3600 : config.sandbox.timeoutSeconds;
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 60) throw invalid('sandbox.timeoutSeconds must be a safe integer of at least 60');
  if (typeof config.bridge?.host !== 'string' || !config.bridge.publicUrl?.includes('{port}')) throw invalid('Bridge host and publicUrl with {port} are required');
  httpUrl(config.bridge.publicUrl.replaceAll('{port}', '12345'), 'bridge.publicUrl');
  if (typeof config.modelGateway?.host !== 'string' || typeof config.modelGateway.advertiseHost !== 'string') throw invalid('Model gateway host and advertiseHost are required');
  const outputPolicy = config.modelGateway.maxOutputTokens;
  if (outputPolicy !== undefined && outputPolicy !== null && (!Number.isSafeInteger(outputPolicy) || outputPolicy < 16)) {
    throw invalid('modelGateway.maxOutputTokens must be null or a safe integer of at least 16');
  }
  if (!Number.isSafeInteger(config.isolation.disk?.bytes) || !Number.isSafeInteger(config.isolation.disk?.inodes)) throw invalid('Explicit disk byte and inode limits are required');
  try { new DockerBotDisk(config.isolation.disk); } catch (error) { throw invalid(error.message); }
  const bridgeOrigin = httpUrl(config.bridge.publicUrl.replaceAll('{port}', '12345'), 'Bridge origin');
  for (const host of [bridgeOrigin.hostname, config.modelGateway.advertiseHost]) {
    if (isIP(host) !== 4 || host.startsWith('127.') || host === '0.0.0.0') throw invalid('Sandbox destinations require concrete non-loopback IPv4 addresses');
  }
  if (!config.models || !Object.keys(config.models).length) throw invalid('At least one model alias is required');
  for (const model of Object.values(config.models)) {
    if (typeof model.provider !== 'string' || typeof model.model !== 'string') throw invalid('Each model needs provider and model');
    const url = httpUrl(model.upstream?.url, 'model upstream');
    if (!url.pathname.endsWith('/v1/responses')) throw invalid('Model upstream must use /v1/responses');
    if (!model.upstream.headers || typeof model.upstream.headers !== 'object') throw invalid('Model upstream headers are required');
  }
  const handle = Object.freeze({});
  handles.set(handle, { config: freeze(structuredClone(config)), claimed: false });
  return handle;
}

export function claimPiOpenSandboxBackend(handle) {
  const entry = handles.get(handle);
  if (!entry || entry.claimed) throw invalid('A fresh Pi/OpenSandbox backend handle is required');
  entry.claimed = true;
  return entry.config;
}

export async function openPiOpenSandboxBackend(config, { runtimeId, bridge, modelAccess, registerPrivateValues = () => {} }) {
  const bots = new Map();
  let closing = false;
  const network = new DockerBotNetwork();
  const disk = new DockerBotDisk(config.isolation.disk);

  function consume(bot, records) {
    if (bot.historyLost) return;
    for (const record of records) {
      const sequence = record.worker_sequence;
      if (Number.isSafeInteger(sequence) && sequence <= bot.cursor) continue;
      if (!Number.isSafeInteger(sequence) || sequence !== bot.cursor + 1) {
        bot.historyLost = true;
        bot.onEvent({ type: 'error', error: { code: 'SERVICE_UNAVAILABLE', message: 'Worker event history has a gap', retryable: false }, fatal: true });
        return;
      }
      bot.cursor = sequence;
      if (record.type === 'agent_start') {
        bot.onExecutionStart?.();
        bot.output = '';
        bot.error = null;
        bot.outcome = 'completed';
      }
      if (record.type === 'message_end' && record.message?.role === 'assistant') {
        const message = record.message;
        bot.output = (message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('');
        bot.error = message.stopReason === 'error' || message.stopReason === 'aborted'
          ? { code: 'MODEL_ERROR', message: message.errorMessage ?? message.stopReason, retryable: false } : null;
        bot.outcome = message.stopReason === 'aborted' ? 'aborted' : bot.error ? 'failed' : 'completed';
        if (bot.output) bot.onEvent({ type: 'output', text: bot.output });
      }
      if (record.type === 'agent_settled') {
        const outcome = record.aborted ? 'aborted' : bot.outcome ?? 'completed';
        bot.onEvent({ type: 'settled', outcome, output: bot.output, ...(bot.error ? { error: bot.error } : {}) });
      }
      if (record.type === 'worker_exit') {
        bot.exited = true;
        bot.onEvent({ type: 'exit', reason: `Pi exited (${record.code ?? record.signal ?? 'unknown'})`, expected: bot.stopping });
      }
      if (record.type === 'worker_error') bot.onEvent({ type: 'error', error: { code: 'PROCESS_EXITED', message: record.message, retryable: false }, fatal: true });
    }
  }

  async function poll(bot) {
    while (!bot.pollController.signal.aborted && !bot.exited && !bot.historyLost) {
      try {
        const result = await bot.manager.agentRpc(bot.id, { type: 'get_state', since: bot.cursor }, { timeoutMs: 5000 });
        consume(bot, result.records ?? []);
      } catch (error) {
        if (!bot.stopping) bot.onEvent({ type: 'error', error: { code: error.code ?? 'SERVICE_UNAVAILABLE', message: 'Worker event polling failed', retryable: true }, fatal: false });
      }
      await delay(100, undefined, { signal: bot.pollController.signal }).catch(() => undefined);
    }
  }

  function fileOperation(botId, action, input) {
    const bot = bots.get(botId);
    if (!bot || bot.stopping || bot.exited || bot.historyLost || closing) {
      throw Object.assign(new Error('Core Bot is unavailable for file control'), { code: 'NOT_ALLOWED' });
    }
    return bot.manager.coreFileOperation(botId, action, input);
  }

  return {
    async spawn({ botId, profile, options = {}, signal, onEvent, onExecutionStart, recordAllocation }) {
      if (closing || signal?.aborted) throw Object.assign(new Error('Backend is closing'), { code: 'NOT_ALLOWED' });
      const manager = new OpenSandboxManager({ ...config.sandbox, image: profile.image });
      const bot = { id: botId, manager, onEvent, onExecutionStart, cursor: 0, output: '', error: null, stopping: false, exited: false, pollController: new AbortController() };
      bots.set(botId, bot);
      const assertOpen = () => {
        if (closing || bot.stopping || signal?.aborted) throw Object.assign(new Error('Bot startup is closing'), { code: 'NOT_ALLOWED' });
      };
      assertOpen();
      const sandbox = await manager.ensureExecution({ executionId: botId, botId, timeoutSeconds: config.sandbox.timeoutSeconds ?? 3600, projectQuotaRequired: true, cleanupOnFailure: false,
        metadata: { runtime_id: runtimeId }, onWorkerToken: token => registerPrivateValues([token]),
        onCreateDispatch: entry => recordAllocation({ state: 'allocation-dispatched', timeoutSeconds: entry.timeout_seconds }),
        onCreated: entry => recordAllocation({ state: 'allocation-observed', sandboxId: entry.sandbox_id,
          observation: Object.hasOwn(entry, 'expires_at') ? 'create-response' : 'cleanup-lookup', expiresAt: sandboxExpiry(entry.expires_at) }),
      });
      assertOpen();
      const identity = { bot_id: botId, runtime_id: runtimeId, resource_key: botId };
      const credentials = modelAccess.credentialsForBot(botId, profile.model);
      const bridgeCredentials = bridge.credentialsForBot(botId);
      registerPrivateValues([...Object.values(credentials.secretEnvironment), ...Object.values(bridgeCredentials.secretEnvironment)]);
      await network.isolate({ sandboxId: sandbox.sandbox_id, bot: identity, bridgeUrl: bridge.publicUrl, modelUrl: credentials.baseUrl, additionalEndpoints: profile.network?.allow ?? [] });
      assertOpen();
      const quota = await disk.isolate({ sandboxId: sandbox.sandbox_id, bot: identity });
      const versions = await manager.agentVersions({ executionId: botId });
      if (versions.piVersion !== '1.3.0') throw invalid('Backend requires Pi 1.3.0');
      assertOpen();
      const model = config.models[profile.model];
      await manager.startAgent({ executionId: botId, command: 'pi',
        args: ['--mode', 'rpc', '--session-dir', '/workspace/runtime/pi-session', '--session-id', randomUUID(),
          '--tools', 'read,write,edit,bash', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files',
          '--append-system-prompt', '/workspace/runtime/profile-prompt.txt', '--provider', model.provider, '--model', model.model],
        systemPrompt: profile.prompt, systemPromptPath: '/workspace/runtime/profile-prompt.txt', resources: [],
        writable: options.writable ?? profile.writable,
        files: options.files,
        env: { ...(profile.env ?? {}), ...bridgeCredentials.environment, ...credentials.environment },
        secretEnvironment: { ...(options.secretEnv ?? {}), ...bridgeCredentials.secretEnvironment, ...credentials.secretEnvironment },
        projectQuota: quota, modelCatalogResource: credentials.catalogResource, beforeAgentStart: assertOpen });
      bot.started = true;
      const ready = await manager.agentRpc(botId, { type: 'get_state', id: `ready-${randomUUID()}` }, { timeoutMs: 10000 });
      if (ready.response?.success !== true || ready.response.command !== 'get_state') throw invalid('Pi readiness response was not confirmed');
      consume(bot, ready.records ?? []);
      assertOpen();
      bot.polling = poll(bot);
      return { sandboxId: sandbox.sandbox_id, versions };
    },
    prepareFiles(botId, input) { return fileOperation(botId, 'prepare', input); },
    grantFiles(botId, input) { return fileOperation(botId, 'grant', input); },
    async send(botId, input, { mode, inputId, steeringMode, executionEpoch }) {
      const bot = bots.get(botId);
      if (!bot) throw Object.assign(new Error('Bot is unavailable'), { code: 'NOT_ALLOWED' });
      bot.submissions ??= new Map();
      let submission = bot.submissions.get(inputId);
      if (submission && (submission.input !== input || submission.mode !== mode)) {
        throw Object.assign(new Error('Input identity has different parameters'), { code: 'CONFLICT' });
      }
      if (!submission) {
        if (bot.stopping || bot.exited || bot.historyLost || closing) throw Object.assign(new Error('Bot is unavailable'), { code: 'NOT_ALLOWED' });
        submission = { input, mode, first: true };
        bot.submissions.set(inputId, submission);
      }
      if (submission.receipt) return submission.receipt;
      if (!submission.work) {
        const dispatch = submission.first;
        submission.first = false;
        submission.work = (async () => {
          let result;
          try {
            // A prior attempt, including a failed socket, can only be queried.
            // Never transparently resubmit an uncertain prompt to Pi.
            result = await bot.manager.agentRpc(botId, dispatch
              ? { type: 'prompt', id: inputId, message: input, streamingBehavior: mode,
                ...(executionEpoch ? { executionEpoch } : {}),
                ...(steeringMode === undefined ? {} : { steeringMode }) }
              : { type: 'get_rpc_result', id: inputId, since: bot.cursor }, { timeoutMs: 30000, since: bot.cursor });
          } catch {
            // Transport status codes also cover Worker-side failures after
            // writing stdin. Only a correlated Pi response proves rejection.
            return { status: 'unknown', reason: 'worker-transport' };
          }
          consume(bot, result.records ?? []);
          if (result.response?.id !== inputId || result.response?.command !== 'prompt') return {
            status: 'unknown', reason: result.status === 'pending' ? 'worker-pending' : 'worker-uncorrelated-reply',
          };
          if (result.response?.success !== true) {
            if (result.response?.success === false) throw Object.assign(new Error(result.response.error ?? 'Pi rejected input'), {
              code: result.response.code === 'NOT_ALLOWED' ? 'NOT_ALLOWED' : 'INVALID_CONTRACT', inputRejected: true,
            });
            return { status: 'unknown', reason: 'worker-prompt-status-missing' };
          }
          const disposition = result.response.data?.disposition;
          if (!['started', 'queued', 'handled'].includes(disposition)) return { status: 'unknown', reason: 'worker-disposition-missing' };
          submission.receipt = { status: 'accepted', disposition };
          return submission.receipt;
        })().finally(() => { submission.work = undefined; });
      }
      return submission.work;
    },
    async interrupt(botId, { interruptId, executionEpoch }) {
      const bot = bots.get(botId);
      if (!bot || bot.stopping || bot.exited || bot.historyLost || closing) return { status: 'unknown' };
      const result = await bot.manager.agentRpc(botId, { type: 'core_interrupt', id: interruptId, executionEpoch },
        { timeoutMs: 30_000, since: bot.cursor });
      consume(bot, result.records ?? []);
      const confirmed = !bot.historyLost && !bot.exited && !bot.stopping && result.response?.id === interruptId &&
        result.response.command === 'core_interrupt' && result.response.success === true;
      return { status: confirmed ? 'interrupted' : 'unknown' };
    },
    async stopExecution(botId) {
      const bot = bots.get(botId);
      if (!bot) return { collectable: false };
      bot.stopping = true;
      const stopped = await bot.manager.stopAgent(botId, 'SIGTERM', { preserveWorker: true });
      bot.executionStopped = true;
      bot.pollController.abort();
      await bot.polling;
      if (stopped && bot.started && !bot.exited) {
        bot.exited = true;
        bot.onEvent({ type: 'exit', reason: 'Worker confirmed Pi stopped', expected: true });
      }
      return { collectable: stopped };
    },
    async *collect(botId, specification) {
      const bot = bots.get(botId);
      if (!bot?.executionStopped) throw Object.assign(new Error('Artifact collection requires confirmed execution stop'), { code: 'NOT_ALLOWED' });
      try { yield* bot.manager.collectCoreFiles(botId, specification); }
      catch (error) {
        const rejected = ['INVALID_CONTRACT', 'NOT_ALLOWED', 'CONFLICT'].includes(error.code);
        throw Object.assign(new Error(rejected ? error.message : 'Worker artifact export could not be confirmed'), {
          code: 'ARTIFACT_EXPORT_FAILED', retryable: !rejected,
        });
      }
    },
    resource(botId) {
      const bot = bots.get(botId);
      return bot?.manager.coreResource(botId);
    },
    async destroy(botId) {
      const bot = bots.get(botId);
      if (!bot) return;
      if (!bot.executionStopped) throw Object.assign(new Error('Sandbox deletion requires confirmed execution stop'), { code: 'NOT_ALLOWED' });
      bot.pollController.abort();
      await bot.manager.stopExecution(botId);
      await bot.polling;
      bots.delete(botId);
    },
    async close() {
      closing = true;
      if (bots.size) throw Object.assign(new Error('Backend still owns Bot resources'), { code: 'CONFLICT' });
    },
  };
}

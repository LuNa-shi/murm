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

export function createPiOpenSandboxBackend(config) {
  if (config?.isolation?.network !== 'local-docker') throw invalid('Pi/OpenSandbox requires local-docker isolation');
  httpUrl(config.sandbox?.lifecycleBaseUrl, 'sandbox.lifecycleBaseUrl');
  if (typeof config.bridge?.host !== 'string' || !config.bridge.publicUrl?.includes('{port}')) throw invalid('Bridge host and publicUrl with {port} are required');
  httpUrl(config.bridge.publicUrl.replaceAll('{port}', '12345'), 'bridge.publicUrl');
  if (typeof config.modelGateway?.host !== 'string' || typeof config.modelGateway.advertiseHost !== 'string') throw invalid('Model gateway host and advertiseHost are required');
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

export async function openPiOpenSandboxBackend(config, { runtimeId, bridge, modelAccess }) {
  const bots = new Map();
  let closing = false;
  const network = new DockerBotNetwork();
  const disk = new DockerBotDisk(config.isolation.disk);

  function consume(bot, records) {
    for (const record of records) {
      const sequence = record.worker_sequence;
      if (!Number.isSafeInteger(sequence) || sequence <= bot.cursor) continue;
      if (sequence !== bot.cursor + 1) {
        bot.onEvent({ type: 'error', error: { code: 'SERVICE_UNAVAILABLE', message: 'Worker event history has a gap', retryable: false }, fatal: true });
      }
      bot.cursor = sequence;
      if (record.type === 'message_end' && record.message?.role === 'assistant') {
        const message = record.message;
        bot.output = (message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('');
        bot.error = message.stopReason === 'error' || message.stopReason === 'aborted'
          ? { code: 'MODEL_ERROR', message: message.errorMessage ?? message.stopReason, retryable: false } : null;
        if (bot.output) bot.onEvent({ type: 'output', text: bot.output });
      }
      if (record.type === 'agent_settled') {
        bot.onEvent({ type: 'settled', outcome: bot.error ? 'failed' : 'completed', output: bot.output, ...(bot.error ? { error: bot.error } : {}) });
      }
      if (record.type === 'worker_exit') {
        bot.exited = true;
        bot.onEvent({ type: 'exit', reason: `Pi exited (${record.code ?? record.signal ?? 'unknown'})`, expected: bot.stopping });
      }
      if (record.type === 'worker_error') bot.onEvent({ type: 'error', error: { code: 'PROCESS_EXITED', message: record.message, retryable: false }, fatal: true });
    }
  }

  async function poll(bot) {
    while (!bot.pollController.signal.aborted && !bot.exited) {
      try {
        const result = await bot.manager.agentRpc(bot.id, { type: 'get_state', since: bot.cursor }, { timeoutMs: 5000 });
        consume(bot, result.records ?? []);
      } catch (error) {
        if (!bot.stopping) bot.onEvent({ type: 'error', error: { code: error.code ?? 'SERVICE_UNAVAILABLE', message: 'Worker event polling failed', retryable: true }, fatal: false });
      }
      await delay(100, undefined, { signal: bot.pollController.signal }).catch(() => undefined);
    }
  }

  return {
    async spawn({ botId, profile, options = {}, signal, onEvent }) {
      if (closing || signal?.aborted) throw Object.assign(new Error('Backend is closing'), { code: 'NOT_ALLOWED' });
      if (options.files || options.collect || profile.collect) throw invalid('File seeding and collection require the file lifecycle implementation');
      const manager = new OpenSandboxManager({ ...config.sandbox, image: profile.image });
      const bot = { id: botId, manager, onEvent, cursor: 0, output: '', error: null, stopping: false, exited: false, pollController: new AbortController() };
      bots.set(botId, bot);
      const assertOpen = () => {
        if (closing || bot.stopping || signal?.aborted) throw Object.assign(new Error('Bot startup is closing'), { code: 'NOT_ALLOWED' });
      };
      assertOpen();
      const sandbox = await manager.ensureExecution({ executionId: botId, botId, projectQuotaRequired: true, cleanupOnFailure: false, metadata: { runtime_id: runtimeId } });
      assertOpen();
      const identity = { bot_id: botId, runtime_id: runtimeId, resource_key: botId };
      const credentials = modelAccess.credentialsForBot(botId, profile.model);
      const bridgeCredentials = bridge.credentialsForBot(botId);
      await network.isolate({ sandboxId: sandbox.sandbox_id, bot: identity, bridgeUrl: bridge.publicUrl, modelUrl: credentials.baseUrl, additionalEndpoints: profile.network?.allow ?? [] });
      assertOpen();
      const quota = await disk.isolate({ sandboxId: sandbox.sandbox_id, bot: identity });
      const versions = await manager.agentVersions({ executionId: botId });
      if (versions.piVersion !== '1.3.0') throw invalid('Backend requires Pi 1.3.0');
      assertOpen();
      const model = config.models[profile.model];
      await manager.startAgent({ agentMode: 'core', executionId: botId, command: 'pi',
        args: ['--mode', 'rpc', '--session-dir', '/workspace/runtime/pi-session', '--session-id', randomUUID(),
          '--tools', 'read,write,edit,bash', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files',
          '--append-system-prompt', '/workspace/runtime/profile-prompt.txt', '--provider', model.provider, '--model', model.model],
        systemPrompt: profile.prompt, systemPromptPath: '/workspace/runtime/profile-prompt.txt', resources: [],
        writable: options.writable ?? profile.writable,
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
    async send(botId, input, { mode, inputId }) {
      const bot = bots.get(botId);
      if (!bot || bot.stopping || bot.exited || closing) throw Object.assign(new Error('Bot is unavailable'), { code: 'NOT_ALLOWED' });
      bot.output = '';
      bot.error = null;
      let result;
      try {
        result = await bot.manager.agentRpc(botId, { type: 'prompt', id: inputId, message: input, streamingBehavior: mode }, { timeoutMs: 30000 });
      } catch (error) {
        if (['SERVICE_TIMEOUT', 'SERVICE_UNAVAILABLE'].includes(error.code)) return { status: 'unknown' };
        throw error;
      }
      consume(bot, result.records ?? []);
      if (result.response?.success !== true) {
        if (result.response?.success === false) throw Object.assign(new Error(result.response.error ?? 'Pi rejected input'), { code: 'INVALID_CONTRACT' });
        return { status: 'unknown' };
      }
      const disposition = result.response.data?.disposition;
      if (!['started', 'queued', 'handled'].includes(disposition)) return { status: 'unknown' };
      return { status: 'accepted', disposition };
    },
    async stopExecution(botId) {
      const bot = bots.get(botId);
      if (!bot) return;
      bot.stopping = true;
      const stopped = await bot.manager.stopAgent(botId);
      bot.pollController.abort();
      await bot.polling;
      if (stopped && bot.started && !bot.exited) {
        bot.exited = true;
        bot.onEvent({ type: 'exit', reason: 'Worker confirmed Pi stopped', expected: true });
      }
    },
    async destroy(botId) {
      const bot = bots.get(botId);
      if (!bot) return;
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

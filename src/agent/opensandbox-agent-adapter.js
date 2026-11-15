import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { AgentCoreSession, resolveAgentCoreRoute } from './pi-adapter.js';
import { BOT_SYSTEM_PROMPT, BOT_SYSTEM_RESOURCE, BOT_SYSTEM_HASH, BOT_SKILLS, BOT_TOOL_NAMES, BOT_PROTOCOL_VERSION } from './bot-contract.js';
import { createVersionManifest } from './version-manifest.js';
import { ERROR_CODES, SwarmEnvError } from '../errors.js';

function required(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `${name} is required`);
  return value;
}

// Only deployment configuration that is meaningful to a sandbox Agent is
// copied from the controller environment.  In particular, do not forward the
// provider lifecycle URL, host paths, or arbitrary host credentials.  Secret
// values are supplied separately through `secretEnv` so callers can audit the
// exact allow-list at the deployment boundary.
const PUBLIC_AGENT_ENV = /^(?:NUROUTER_PI_(?:PROVIDER|MODEL|ACCOUNT|GROUP)|PI_(?:PROVIDER|MODEL|[A-Z0-9_]+_BASE_URL)|SWARMENV_(?:AGENT_ROLE|BRIDGE_URL|PI_VERSION|NUROUTER_VERSION|SERVICE_ENDPOINTS|[A-Z0-9_]+_SERVICE_URL))$/;

function publicAgentEnvironment(value, explicit = {}) {
  const source = { ...(value ?? {}), ...(explicit ?? {}) };
  return Object.fromEntries(Object.entries(source).filter(([key, item]) => PUBLIC_AGENT_ENV.test(key) && typeof item === 'string'));
}

function secretAgentEnvironment(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => (
    /^(?:SWARMENV_(?:BRIDGE_TOKEN|[A-Z0-9_]+_SERVICE_TOKEN)|OPENAI_API_KEY|OPENAI_ORG_ID|ANTHROPIC_API_KEY|GOOGLE_API_KEY|MOONSHOT_API_KEY|OPENROUTER_API_KEY)$/.test(key)
    || key.startsWith('NUROUTER_')
    || key.startsWith('PI_') && /(?:API_KEY|TOKEN)$/i.test(key)
  ) && typeof item === 'string'));
}

class RemoteAgentChild extends EventEmitter {
  constructor(manager, executionId, logger = null, observationIdentity = () => ({ execution_id: executionId })) {
    super();
    this.manager = manager;
    this.executionId = executionId;
    this.logger = logger;
    this.observationIdentity = observationIdentity;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = { writable: true, write: (line) => { void this.#rpc(line); return true; } };
    this.closed = false;
    this.records = new Set();
    this.lastSequence = 0;
    this.eventStreamFailures = 0;
    this.lastEventStreamLogAt = 0;
    this.eventStreamUnavailable = false;
    this.#listen();
  }

  async #listen() {
    while (!this.closed) {
      if (this.eventStreamUnavailable) {
        try {
          const result = await this.manager.agentRpc(this.executionId, {
            type: 'get_state',
            id: `event-poll-${randomUUID()}`,
            since: this.lastSequence,
          }, { timeoutMs: 15_000 });
          for (const record of result?.records ?? []) this.#emitRecord(record);
          this.eventStreamFailures = 0;
        } catch (error) {
          this.logger?.append({
            event: 'agent_event_poll_error',
            ...this.observationIdentity(),
            error_code: error?.code ?? error?.name ?? 'event_poll_error',
            error_message: String(error?.message ?? error).slice(0, 256),
          });
        }
        if (!this.closed) await new Promise((resolve) => setTimeout(resolve, 1_000));
        continue;
      }
      try {
        for await (const event of this.manager.agentEvents(this.executionId, { since: this.lastSequence })) {
          if (event?.kind === 'stderr') { this.stderr.write(event.text ?? ''); continue; }
          if (event?.worker_sequence) this.lastSequence = Math.max(this.lastSequence, event.worker_sequence);
          if (event?.type === 'worker_exit') { this.#close(event.code, event.signal); break; }
          this.eventStreamFailures = 0;
          this.#emitRecord(event);
        }
      } catch (error) {
        // The provider event stream is a reconnectable transport. OpenSandbox
        // may close an idle SSE connection while the Agent process continues
        // running. Retry from the last worker sequence instead of fencing the
        // durable Execution on a transient transport error. A non-retryable
        // binding or contract error still reaches Runtime through the error
        // event.
        if (!this.closed) {
          const retryable = error?.retryable === true
            || ![ERROR_CODES.NOT_ALLOWED, ERROR_CODES.INVALID_CONTRACT].includes(error?.code);
          if (!retryable) this.emit('error', error);
          else {
            // OpenSandbox release-1.2.0 can return 502 for the long-lived
            // SSE endpoint while its authenticated RPC endpoint remains
            // usable. Switch to bounded get_state polling so worker records
            // are still recovered by sequence without fencing the Execution.
            const providerStreamFailure = error?.code === ERROR_CODES.SERVICE_UNAVAILABLE
              || Number(error?.details?.status) >= 500;
            if (providerStreamFailure) this.eventStreamUnavailable = true;
            this.eventStreamFailures += 1;
            // A provider gateway can return a burst of 502s while the worker
            // remains healthy. Log the first failure, powers of two, and a
            // ten-second heartbeat instead of turning the diagnostic stream
            // into a second source of load.
            const now = Date.now();
            const failures = this.eventStreamFailures;
            if (failures === 1 || (failures & (failures - 1)) === 0 || now - this.lastEventStreamLogAt >= 10_000) {
              this.logger?.append({
                event: 'agent_event_stream_error',
                ...this.observationIdentity(),
                retryable: true,
                failure_count: failures,
                error_code: error?.code ?? error?.name ?? 'event_stream_error',
                error_message: String(error?.message ?? error).slice(0, 256),
              });
              this.lastEventStreamLogAt = now;
            }
          }
        }
      }
      if (!this.closed) {
        const delay = this.eventStreamFailures > 0
          ? Math.min(5_000, 100 * (2 ** Math.min(this.eventStreamFailures - 1, 6)))
          : 100;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  async #rpc(line) {
    let message;
    try { message = JSON.parse(String(line)); } catch (error) { this.emit('error', error); return; }
    try {
      let result;
      try {
        result = await this.manager.agentRpc(this.executionId, message);
      } catch (firstError) {
        if (!firstError?.retryable && !['SERVICE_TIMEOUT', 'SERVICE_UNAVAILABLE'].includes(firstError?.code)) throw firstError;
        // The worker caches command IDs, so retrying after a lost response
        // does not write the same Pi command twice.
        result = await this.manager.agentRpc(this.executionId, message);
      }
      for (const record of result?.records ?? []) this.#emitRecord(record);
    } catch (error) {
      this.logger?.append({
        event: 'agent_rpc_error',
        ...this.observationIdentity(),
        error_code: error?.code ?? error?.name ?? 'agent_rpc_error',
        error_message: String(error?.message ?? error).slice(0, 256),
      });
      this.emit('error', error);
    }
  }

  #emitRecord(record) {
    const key = record?.worker_sequence ?? `${record?.type}:${record?.id ?? randomUUID()}`;
    if (this.records.has(key)) return;
    this.records.add(key);
    if (record?.worker_sequence) this.lastSequence = Math.max(this.lastSequence, record.worker_sequence);
    this.stdout.write(`${JSON.stringify(record)}\n`);
  }

  kill(signal = 'SIGTERM') {
    if (this.closed) return;
    void this.manager.stopAgent(this.executionId, signal)
      .catch(() => undefined)
      .then(() => this.manager.stopExecution?.(this.executionId))
      .catch(() => undefined)
      .finally(() => this.#close(null, signal));
  }

  #close(code, signal) {
    if (this.closed) return;
    this.closed = true;
    this.stdin.writable = false;
    this.stdout.end();
    this.stderr.end();
    this.emit('close', code, signal);
  }
}

/**
 * Agent adapter that starts Pi/NuRouter through an OpenSandbox worker. The
 * worker is part of the pinned sandbox image; the host only carries JSON-RPC
 * messages over the provider endpoint and never spawns the Agent command.
 */
export class OpenSandboxAgentAdapter {
  constructor({ sandboxManager, modelAccess = null, networkIsolation = null, diskIsolation = null, modelCatalogResource = null, command = 'nurouter', provider, model, account, group, env = {}, agentEnvironment = {}, secretEnv = {}, systemPrompt = null, extensionPath = null, sessionDir = '/workspace/runtime/pi-session', manifestVersions = {} } = {}) {
    if (!sandboxManager) throw new TypeError('OpenSandboxAgentAdapter requires sandboxManager');
    if (systemPrompt && systemPrompt !== BOT_SYSTEM_PROMPT) throw new TypeError('registered Bots require the versioned Bot system contract');
    if (extensionPath) throw new TypeError('registered Bots use four native Pi tools and the swarm CLI; Service tool extensions are retired');
    systemPrompt = BOT_SYSTEM_PROMPT;
    this.sandboxManager = sandboxManager;
    this.modelAccess = modelAccess;
    this.networkIsolation = networkIsolation;
    this.diskIsolation = diskIsolation;
    this.modelCatalogResource = modelCatalogResource;
    if (modelAccess && command !== 'pi' && !command.endsWith('/pi')) throw new TypeError('Budgeted model access requires direct Pi');
    this.command = command;
    this.config = { provider, model, account, group, env, agentEnvironment, secretEnv, systemPrompt, extensionPath, sessionDir };
    this.manifestVersions = manifestVersions;
  }

  buildLaunchArgs({ executionId, sessionId = executionId, sessionDir = this.config.sessionDir } = {}) {
    required(executionId, 'execution_id');
    required(sessionId, 'session_id');
    required(this.config.provider, 'provider');
    required(this.config.model, 'model');
    const placement = resolveAgentCoreRoute(this.config);
    const directPi = this.command === 'pi' || this.command.endsWith('/pi');
    const args = directPi ? [] : ['pi', ...(placement === 'nurouter' ? ['--provider', this.config.provider, '--model', this.config.model] : [])];
    if (!directPi && this.config.account) args.push('--account', this.config.account);
    if (!directPi && this.config.group) args.push('--group', this.config.group);
    if (!directPi) args.push('--');
    args.push('--mode', 'rpc', '--session-dir', sessionDir, '--session-id', sessionId,
      '--tools', BOT_TOOL_NAMES.join(','), '--no-extensions',
      '--no-skills', '--no-prompt-templates', '--no-context-files',
      ...BOT_SKILLS.flatMap(skill => ['--skill', skill.path]),
      '--append-system-prompt', BOT_SYSTEM_RESOURCE.path,
      ...(placement === 'pi' ? ['--provider', this.config.provider, '--model', this.config.model] : []));
    return args;
  }

  async start(options = {}) {
    if (this.stopping) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Agent adapter is stopping');
    if (!options.bot?.bot_id || options.executionId !== (options.bot.resource_key ?? options.bot.bot_id)) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'OpenSandbox Agent startup requires a registered Bot resource identity');
    if (this.startPromise) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Agent startup is already in progress');
    const starting = this.#startTracked(options).finally(() => { this.startPromise = null; });
    this.startPromise = starting;
    return starting;
  }

  async #startTracked({ executionId, bot = null, signal = null, assertStartupAllowed = null, onSandboxCreateDispatch = null, onSandboxCreateRejected = null, onSandboxCreated = null, sessionDir = this.config.sessionDir, cwd = null, agentPrompt = null, logger = null, observation = null, observationContext = {}, sessionId = randomUUID() } = {}) {
    await this.#cleanupFailedStarts();
    if (this.stopping) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Agent adapter is stopping');
    this.pendingStartupCleanup ??= new Set();
    required(executionId, 'execution_id');
    try {
      if (signal?.aborted) throw signal.reason;
      const session = await this.#startSession({ executionId, bot, signal, assertStartupAllowed, onSandboxCreateDispatch, onSandboxCreateRejected, onSandboxCreated, sessionDir, cwd, agentPrompt, logger, observation, observationContext, sessionId });
      if (this.stopping || signal?.aborted) {
        await session.stop();
        throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Agent startup was stopped');
      }
      return session;
    } catch (error) {
      this.modelAccess?.revokeBot(bot?.bot_id);
      // Before a Session exists, the adapter still owns the sandbox. Keep
      // that responsibility if deletion fails and refuse another startup.
      this.pendingStartupCleanup.add(executionId);
      await this.sandboxManager.stopExecution(executionId);
      this.pendingStartupCleanup.delete(executionId);
      throw error;
    }
  }

  async cleanupPendingStarts({ shutdown = false } = {}) {
    if (shutdown) this.stopping = true;
    await this.startPromise?.catch(() => undefined);
    await this.#cleanupFailedStarts();
  }

  async #cleanupFailedStarts() {
    for (const pending of this.pendingStartupCleanup ?? []) {
      await this.sandboxManager.stopExecution(pending);
      this.pendingStartupCleanup.delete(pending);
    }
  }

  async #startSession({ executionId, bot, signal, assertStartupAllowed, onSandboxCreateDispatch, onSandboxCreateRejected, onSandboxCreated, sessionDir, cwd, agentPrompt, logger, observation, observationContext, sessionId }) {
    // Runtime passes its host-side session directory to every adapter. The
    // remote worker has one fixed guest work surface and must never receive a
    // host path as an argv or filesystem target.
    const guestSessionDir = '/workspace/runtime/pi-session';
    const launchArgs = this.buildLaunchArgs({ executionId, sessionId, sessionDir: guestSessionDir });
    const sandbox = await this.sandboxManager.ensureExecution({ executionId, botId: bot?.bot_id ?? null,
      ...(this.diskIsolation ? { projectQuotaRequired: true } : {}),
      onCreateDispatch: onSandboxCreateDispatch, onCreateRejected: onSandboxCreateRejected,
      timeoutSeconds: Number.isFinite(Date.parse(bot?.hard_deadline)) ? Math.max(60, Math.ceil((Date.parse(bot.hard_deadline) - Date.now() + 30_000) / 1000)) : 3600,
      onCreated: onSandboxCreated, bindingVersion: observationContext.fencingVersion ?? null,
      ...(bot?.mission_id ? { metadata: { mission_id: bot.mission_id } } : {}) });
    if (this.stopping || signal?.aborted) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Agent startup was stopped');
    if (cwd && !bot) await this.sandboxManager.syncWorkspace({ executionId, workspaceRef: cwd });
    const workerEnvironment = publicAgentEnvironment(this.config.env, this.config.agentEnvironment);
    // Runtime creates the bridge token when each Core's bridge starts. The
    // bridge URL is public worker configuration, but its bearer token must
    // cross the authenticated worker start request as a secret. `env` is the
    // live Core environment object, so this also observes the token added
    // after the adapter was constructed.
    const workerSecretEnvironment = secretAgentEnvironment({
      ...this.config.secretEnv,
      SWARMENV_BRIDGE_TOKEN: this.config.env.SWARMENV_BRIDGE_TOKEN ?? this.config.secretEnv.SWARMENV_BRIDGE_TOKEN,
    });
    if (bot) {
      delete workerEnvironment.SWARMENV_SERVICE_ENDPOINTS;
      for (const key of Object.keys(workerEnvironment)) if (/^SWARMENV_.*_SERVICE_URL$/.test(key)) delete workerEnvironment[key];
      for (const key of Object.keys(workerSecretEnvironment)) if (/^SWARMENV_.*_SERVICE_TOKEN$/.test(key)) delete workerSecretEnvironment[key];
    }
    if (this.modelAccess) {
      // All upstream and alternate router credentials stay on the host. The
      // Bridge credential is independently scoped to this Bot by Runtime.
      for (const key of Object.keys(workerSecretEnvironment)) if (key !== 'SWARMENV_BRIDGE_TOKEN') delete workerSecretEnvironment[key];
      for (const key of Object.keys(workerEnvironment)) if (/^(?:NUROUTER_|PI_.*_BASE_URL)/.test(key)) delete workerEnvironment[key];
      const credentials = this.modelAccess.credentialsForBot(bot);
      Object.assign(workerEnvironment, credentials.environment);
      Object.assign(workerSecretEnvironment, credentials.secretEnvironment);
    }
    const networkEvidence = this.networkIsolation ? await this.networkIsolation.isolate({ sandboxId: sandbox?.sandbox_id, bot,
      bridgeUrl: workerEnvironment.SWARMENV_BRIDGE_URL, modelUrl: this.modelAccess?.baseUrl }) : null;
    if (this.stopping || signal?.aborted) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Agent startup was stopped');
    const projectQuota = this.diskIsolation ? await this.diskIsolation.isolate({ sandboxId: sandbox?.sandbox_id, bot }) : null;
    if (this.stopping || signal?.aborted) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Agent startup was stopped');
    let guestVersions = null;
    const directPi = this.command === 'pi' || this.command.endsWith('/pi');
    const explicitVersions = {
      piVersion: this.manifestVersions.piVersion ?? this.config.env.SWARMENV_PI_VERSION,
      nurouterVersion: directPi ? null : (this.manifestVersions.nurouterVersion ?? this.config.env.SWARMENV_NUROUTER_VERSION),
      nodeVersion: this.manifestVersions.nodeVersion ?? null,
    };
    if (typeof this.sandboxManager.agentVersions === 'function' && Object.values(explicitVersions).some((value) => !value)) {
      guestVersions = await this.sandboxManager.agentVersions({ executionId, includeNurouter: !directPi });
    }
    assertStartupAllowed?.();
    await this.sandboxManager.startAgent({
      executionId,
      beforeAgentStart: assertStartupAllowed,
      command: this.command,
      args: launchArgs,
      cwd: '/workspace/project',
      env: workerEnvironment,
      sessionDir: guestSessionDir,
      resources: [BOT_SYSTEM_RESOURCE, ...BOT_SKILLS.map(({ path, sha256 }) => ({ path, sha256 }))],
      secretEnvironment: workerSecretEnvironment,
      ...(projectQuota ? { projectQuota } : {}),
      ...(this.modelCatalogResource ? { modelCatalogResource: this.modelCatalogResource } : {}),
    });
    let session;
    const child = new RemoteAgentChild(this.sandboxManager, executionId, logger, () => ({ execution_id: bot ? session?.executionId ?? null : executionId, ...(bot ? { bot_id: bot.bot_id, resource_key: executionId } : {}) }));
    const manifest = { ...await createVersionManifest({
      ...this.manifestVersions,
      launchArgs,
      piVersion: explicitVersions.piVersion ?? guestVersions?.piVersion,
      nurouterVersion: explicitVersions.nurouterVersion === null ? null : (explicitVersions.nurouterVersion ?? guestVersions?.nurouterVersion),
      nodeVersion: explicitVersions.nodeVersion ?? guestVersions?.nodeVersion,
    }), bot_contract: { protocol_version: BOT_PROTOCOL_VERSION, system_prompt_sha256: BOT_SYSTEM_HASH, system_resource: BOT_SYSTEM_RESOURCE, skills: BOT_SKILLS, tools: BOT_TOOL_NAMES } };
    const observedExecutionId = bot ? null : (observationContext.executionId ?? executionId);
    session = new AgentCoreSession(child, { executionId: observedExecutionId, sessionId, launchArgs, manifest, logger, observation, coreId: observationContext.coreId ?? null, taskId: observationContext.taskId ?? null });
    session.on('close', () => this.modelAccess?.revokeBot(bot?.bot_id));
    session.botId = bot?.bot_id ?? null;
    session.networkEvidence = networkEvidence;
    session.diskEvidence = projectQuota;
    session.resourceKey = executionId;
    session.sandboxId = sandbox?.sandbox_id ?? null;
    const stopProcess = session.stop.bind(session);
    session.stop = async (...args) => {
      this.modelAccess?.revokeBot(bot?.bot_id);
      const result = await stopProcess(...args);
      // A worker exit (or a failed best-effort kill) only closes the RPC
      // transport. Retain and retry cleanup of the original worker sandbox,
      // whose key may differ from the subsequently bound Task Execution.
      await this.sandboxManager.stopExecution(executionId);
      return result;
    };
    observation?.({ source: 'agent', kind: 'session_started', visibility: 'operator', payload: { launch_args: launchArgs, manifest, network_isolation: networkEvidence, disk_isolation: projectQuota, model_catalog_resource: this.modelCatalogResource, transport: 'opensandbox-worker', bot_id: bot?.bot_id ?? null }, sessionId, executionId: observedExecutionId, taskId: observationContext.taskId ?? null, coreId: observationContext.coreId ?? null });
    if (agentPrompt) {
      await session.waitForReady({ timeoutMs: 30_000 });
      await session.setAutoCompaction(true);
      await session.setAutoRetry(true);
      await session.prompt(agentPrompt, { timeoutMs: 30_000 });
    }
    return session;
  }
}

export function createOpenSandboxAgentAdapter(options = {}) { return new OpenSandboxAgentAdapter(options); }

import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { ERROR_CODES, SwarmEnvError } from '../errors.js';
import { openSandboxBotKey, openSandboxMissionKey, openSandboxRuntimeKey } from './opensandbox-metadata.js';
import { decodeFileSeed } from '../../scripts/core-file-seed.mjs';
import { snapshotCollectionSpec, MAX_COLLECTION_LINE_BYTES } from '../../scripts/core-collection.mjs';

const DEFAULT_EXECd_PORT = 44772;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 60 * 60_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const SECRET_ENVIRONMENT = /(token|secret|passwd|password|api_?key|credential|private_?key)/i;

function required(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} is required`);
  return value;
}

function baseUrl(value) {
  const url = new URL(required(value, 'lifecycleBaseUrl'));
  url.pathname = url.pathname.replace(/\/$/, '');
  return url.toString().replace(/\/$/, '');
}

function timeout(value) {
  if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `sandbox timeout must be between 1 and ${MAX_TIMEOUT_MS} ms`, { timeout_ms: value });
  }
  return value;
}

function envs(value, { allowSecrets = false } = {}) {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'sandbox env must be an object');
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `sandbox env key is invalid: ${key}`);
    if (!allowSecrets && SECRET_ENVIRONMENT.test(key)) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `sandbox env key is not allowed: ${key}`);
    if (typeof item !== 'string' || item.length > 4096) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `sandbox env value is invalid: ${key}`);
    result[key] = item;
  }
  return result;
}

const SENSITIVE_FIELD = /(authorization|api[-_]?key|token|secret|password|passwd|credential|private[-_]?key)/i;

function safeDiagnostic(value, depth = 0) {
  if (depth > 3) return '[truncated]';
  if (typeof value === 'string') return value.replace(/(?:bearer\s+|api[-_]?key\s*[=:]\s*)[^\s,;]+/ig, '[redacted]').slice(0, 2_000);
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeDiagnostic(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, item]) => [key, SENSITIVE_FIELD.test(key) ? '[redacted]' : safeDiagnostic(item, depth + 1)]));
  return value;
}

function normalizeVolumes(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'sandbox volumes must be an array');
  return value.map((volume, index) => {
    if (!volume || typeof volume !== 'object' || Array.isArray(volume)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `sandbox volume ${index} must be an object`);
    if (typeof volume.name !== 'string' || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(volume.name)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `sandbox volume ${index} has an invalid name`);
    if (typeof volume.mountPath !== 'string' || !volume.mountPath.startsWith('/') || volume.mountPath.split('/').includes('..')) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `sandbox volume ${index} has an invalid mountPath`);
    if (Object.hasOwn(volume, 'host')) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'OpenSandbox host-path volumes are not allowed for Agent Executions');
    if (Object.hasOwn(volume, 'readOnly') && typeof volume.readOnly !== 'boolean') throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `sandbox volume ${index}.readOnly must be boolean`);
    return structuredClone(volume);
  });
}

function command(value) {
  if (typeof value === 'string' && value.trim()) return { command: value };
  if (Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === 'string')) return { argv: value };
  throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'sandbox command must be a non-empty shell string or argv array');
}

function underWorkspace(value) {
  const cwd = value ?? '/workspace';
  if (typeof cwd !== 'string' || !(cwd === '/workspace' || cwd.startsWith('/workspace/')) || cwd.split('/').includes('..')) {
    throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'sandbox cwd must stay inside /workspace', { cwd });
  }
  return cwd;
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '[invalid provider URL]';
  }
}

function appendOutput(current, text, maxBytes) {
  const next = current + String(text ?? '');
  if (Buffer.byteLength(next) <= maxBytes) return [next, false];
  return [next.slice(0, maxBytes), true];
}

function jsonData(data) {
  if (typeof data !== 'string') return data;
  try { return JSON.parse(data); } catch { return data; }
}

function parseSse(text) {
  const events = [];
  for (const block of String(text ?? '').split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;
    let event = 'message';
    const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length === 0) {
      // Execd v1.1 emits newline-delimited JSON despite advertising the SSE
      // media type. Treat each JSON record as an SSE-equivalent event.
      const record = jsonData(block.trim());
      if (record && typeof record === 'object' && !Array.isArray(record)) {
        events.push({ event: record.type ?? record.event ?? 'message', data: record });
        continue;
      }
    }
    events.push({ event, data: jsonData(data.join('\n')) });
  }
  return events;
}

function responseValue(body) {
  if (!body || typeof body !== 'object') return body;
  return body.result ?? body.data ?? body;
}

function endpointUrl(value) {
  const normalize = (candidate) => {
    if (typeof candidate !== 'string' || candidate.length === 0) return null;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) return candidate;
    // OpenSandbox 1.2 Docker returns host:port/path for proxied endpoints;
    // the SDK examples also allow a URL-shaped value. Execd is HTTP here.
    return `http://${candidate.replace(/^\/\//, '')}`;
  };
  if (typeof value === 'string') return normalize(value);
  if (value?.url) return normalize(value.url);
  if (value?.endpoint?.url) return normalize(value.endpoint.url);
  if (value?.endpoint) return normalize(value.endpoint);
  if (Array.isArray(value) && value.length === 1) return endpointUrl(value[0]);
  return null;
}

function endpointForHost(value, host) {
  const endpoint = endpointUrl(value);
  if (!endpoint || !host) return endpoint;
  const url = new URL(endpoint);
  url.hostname = host;
  return url.toString().replace(/\/$/, '');
}

function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

function exactCommandVersion(value, commandName) {
  const match = String(value ?? '').match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
  if (!match) throw new SwarmEnvError(ERROR_CODES.START_FAILED, `could not determine ${commandName} version inside OpenSandbox`, { command: commandName });
  return match[0];
}

/**
 * OpenSandbox lifecycle + Execd provider for one Execution.
 *
 * The lifecycle API owns the sandbox and its external storage. Runtime passes
 * its host Workspace reference only as audit metadata; it is never mounted in
 * the provider sandbox. A new manager record is created for each Execution,
 * and deleting an Execution deletes only that sandbox.
 */
export class OpenSandboxManager {
  constructor({
    lifecycleBaseUrl,
    apiKey = globalThis.process?.env?.OPEN_SANDBOX_API_KEY ?? null,
    execdToken = globalThis.process?.env?.SWARMENV_EXECD_ACCESS_TOKEN ?? null,
    image,
    resourceLimits = { cpu: '2', memory: '2Gi' },
    entrypoint = ['tail', '-f', '/dev/null'],
    metadata = {},
    environment = {},
    volumes = [],
    execdPort = DEFAULT_EXECd_PORT,
    endpointHost = null,
    workerPort = 44100,
    workerCommand = ['node', '/opt/swarmenv/agent-worker.mjs'],
    foregroundSession = false,
    waitForExecdReady = null,
    execdReadyTimeoutMs = 30_000,
    fetchImpl = globalThis.fetch,
    commandTimeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputBytes = MAX_OUTPUT_BYTES,
    logger = null,
    now = () => Date.now(),
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('OpenSandboxManager requires fetch');
    this.lifecycleBaseUrl = baseUrl(lifecycleBaseUrl);
    this.apiKey = apiKey;
    this.execdToken = execdToken;
    this.image = required(image, 'image');
    this.resourceLimits = structuredClone(resourceLimits);
    if (!Array.isArray(entrypoint) || entrypoint.length === 0 || !entrypoint.every((part) => typeof part === 'string')) throw new TypeError('entrypoint must be a non-empty string array');
    this.entrypoint = [...entrypoint];
    if (this.entrypoint.length !== 3 || this.entrypoint[0] !== 'tail' || this.entrypoint[1] !== '-f' || this.entrypoint[2] !== '/dev/null') {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'OpenSandbox uses the fixed Agent worker entrypoint; custom entrypoints are not supported');
    }
    this.metadata = { ...metadata };
    this.environment = envs(environment);
    this.volumes = normalizeVolumes(volumes);
    this.execdPort = execdPort;
    if (endpointHost !== null && (typeof endpointHost !== 'string' || endpointHost.length === 0 || endpointHost.includes('/') || endpointHost.includes(':'))) throw new TypeError('endpointHost must be a hostname or IP address');
    this.endpointHost = endpointHost;
    if (!Number.isInteger(workerPort) || workerPort < 1 || workerPort > 65_535) throw new TypeError('workerPort must be an integer from 1 to 65535');
    if (!Array.isArray(workerCommand) || workerCommand.length === 0 || !workerCommand.every((part) => typeof part === 'string')) throw new TypeError('workerCommand must be a non-empty string array');
    this.workerPort = workerPort;
    this.workerCommand = [...workerCommand];
    this.foregroundSession = foregroundSession === true;
    // A custom fetch is normally a deterministic provider double; production
    // uses the global fetch and must wait for Execd's /ready gate.
    this.waitForExecdReady = waitForExecdReady === null ? fetchImpl === globalThis.fetch : waitForExecdReady !== false;
    if (!Number.isFinite(execdReadyTimeoutMs) || execdReadyTimeoutMs < 1_000 || execdReadyTimeoutMs > MAX_TIMEOUT_MS) throw new TypeError('execdReadyTimeoutMs must be between 1000 and 3600000');
    this.execdReadyTimeoutMs = execdReadyTimeoutMs;
    this.fetch = fetchImpl;
    this.commandTimeoutMs = timeout(commandTimeoutMs);
    if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1_024) throw new TypeError('maxOutputBytes must be at least 1024');
    this.maxOutputBytes = maxOutputBytes;
    this.logger = logger;
    this.now = now;
    this.executions = new Map();
    this.pendingCreations = new Map();
    this.reconciliationIds = new Map();
    this.projectInstallReceipts = new Map();
    this.verified = null;
  }

  async preflight({ timeoutMs = 20_000 } = {}) {
    const response = await this.#request('/sandboxes?pageSize=1', { method: 'GET', timeoutMs });
    this.verified = { lifecycle_url: this.lifecycleBaseUrl, provider: 'opensandbox', verified_at: this.now(), status: response.status };
    this.logger?.({ event: 'sandbox.provider_preflight', provider: 'opensandbox', lifecycle_url: this.lifecycleBaseUrl });
    return { ...this.verified, ok: true };
  }

  ownsBotResource(resourceKey) { return this.executions.has(resourceKey) || this.pendingCreations.has(resourceKey); }

  async reconcileExecutions(options = {}) { return this.#reconcileExecutions(options); }

  async #reconcileExecutions({ missionId, runtimeId, bots = [], timeoutMs = 30_000, onSandboxDiscovered = null } = {}, recoveringCreation = null) {
    if (!runtimeId) required(missionId, 'mission_id');
    const owned = (key) => this.executions.has(key) ||
      (this.pendingCreations.has(key) && this.pendingCreations.get(key) !== recoveringCreation);
    const liveSandboxIds = new Set([...this.executions.values()].map((record) => record.sandboxId));
    const targets = bots.filter((bot) => (runtimeId ? bot.runtime_id === runtimeId : bot.mission_id === missionId) && bot.bot_id && bot.resource_key &&
      (!bot.provider || bot.provider === 'opensandbox'));
    const deadline = Date.now() + timeout(timeoutMs);
    const remaining = () => {
      const ms = deadline - Date.now();
      if (ms <= 0) throw new SwarmEnvError(ERROR_CODES.SERVICE_TIMEOUT, 'OpenSandbox reconciliation timed out', {}, { retryable: true });
      return ms;
    };
    const sandboxes = await this.#listSandboxes(remaining);
    const result = { provider: 'opensandbox', quarantined: [], pending: [], confirmed_bot_ids: [], owned_bot_ids: [] };
    const dispositions = new Map();
    const quarantine = async (target) => {
      if (owned(target.resource_key)) return false;
      let deletion = dispositions.get(target.sandbox_id);
      if (!deletion) {
        deletion = this.#confirmSandboxDeletion(target.sandbox_id, remaining);
        dispositions.set(target.sandbox_id, deletion);
      }
      try {
        await deletion;
        result.quarantined.push(target);
        this.logger?.({ event: 'sandbox.quarantined', provider: 'opensandbox', ...target });
        return true;
      } catch (error) {
        result.pending.push({ ...target, reason: 'deletion_unconfirmed', error_class: error?.code ?? error?.name });
        return false;
      }
    };
    const knownIds = new Set(targets.map((bot) => bot.sandbox_id).filter(Boolean));
    const ownerKey = runtimeId ? openSandboxRuntimeKey(runtimeId) : openSandboxMissionKey(missionId);
    const missionMismatch = metadata => runtimeId
      ? metadata.runtime_key !== ownerKey
      : metadata.mission_key && metadata.mission_key !== ownerKey;
    for (const bot of targets) {
      if (owned(bot.resource_key)) {
        result.owned_bot_ids.push(bot.bot_id);
        continue;
      }
      const target = { bot_id: bot.bot_id, mission_id: missionId, execution_id: bot.execution_id ?? null, resource_key: bot.resource_key };
      const botKey = openSandboxBotKey(bot.bot_id);
      const resourceKey = openSandboxBotKey(bot.resource_key);
      const matches = new Set(this.reconciliationIds.get(bot.resource_key));
      if (bot.sandbox_id) matches.add(bot.sandbox_id);
      let conflict = false;
      for (const [sandboxId, metadata] of sandboxes) {
        if (!matches.has(sandboxId) && metadata.bot_key !== botKey && metadata.resource_key !== resourceKey) continue;
        const incompatible = missionMismatch(metadata) || (metadata.bot_key && metadata.bot_key !== botKey) ||
          (metadata.resource_key && metadata.resource_key !== resourceKey) ||
          (sandboxId !== bot.sandbox_id && knownIds.has(sandboxId)) || liveSandboxIds.has(sandboxId);
        if (incompatible) {
          conflict = true;
          matches.delete(sandboxId);
          result.pending.push({ ...target, sandbox_id: sandboxId, reason: 'provider_identity_mismatch' });
        } else matches.add(sandboxId);
      }
      for (const sandboxId of matches) {
        if (!liveSandboxIds.has(sandboxId)) continue;
        conflict = true;
        matches.delete(sandboxId);
        result.pending.push({ ...target, sandbox_id: sandboxId, reason: 'provider_identity_mismatch' });
      }
      if (matches.size === 0 && !conflict) {
        result.pending.push({ ...target, sandbox_id: null, reason: 'creation_unconfirmed' });
      }
      if (matches.size > 1) {
        for (const sandboxId of matches) result.pending.push({ ...target, sandbox_id: sandboxId, reason: 'provider_identity_mismatch' });
        continue;
      }
      if (matches.size > 0) this.reconciliationIds.set(bot.resource_key, matches);
      else this.reconciliationIds.delete(bot.resource_key);
      if (conflict || matches.size === 0) continue;
      const [sandboxId] = matches;
      if (!bot.sandbox_id && onSandboxDiscovered) {
        try {
          await onSandboxDiscovered(bot, sandboxId);
        } catch (error) {
          result.pending.push({ ...target, sandbox_id: sandboxId, reason: 'resource_record_unconfirmed', error_class: error?.code ?? error?.name });
          continue;
        }
      }
      if (await quarantine({ ...target, sandbox_id: sandboxId })) {
        this.reconciliationIds.delete(bot.resource_key);
        result.confirmed_bot_ids.push(bot.bot_id);
      }
    }
    this.logger?.({ event: 'sandbox.reconciled', provider: 'opensandbox', quarantined: result.quarantined.length, pending: result.pending.length });
    return result;
  }

  async #listSandboxes(remaining) {
    const sandboxes = new Map();
    for (let page = 1; ; page += 1) {
      const response = await this.#request(`/sandboxes?pageSize=100${page === 1 ? '' : `&page=${page}`}`, { timeoutMs: remaining() });
      const value = responseValue(response.body);
      const items = Array.isArray(value) ? value : (value?.items ?? value?.sandboxes);
      const pagination = value?.pagination;
      if (!Array.isArray(items) || (pagination && pagination.page !== page)) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Invalid OpenSandbox list page', { page });
      }
      for (const sandbox of items) {
        const id = sandbox?.id ?? sandbox?.sandbox_id;
        if (typeof id !== 'string' || id.length === 0 || sandboxes.has(id)) {
          throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'OpenSandbox listing changed or contained invalid IDs', { page }, { retryable: true });
        }
        sandboxes.set(id, sandbox.metadata ?? {});
      }
      if (!pagination) {
        if (items.length < 100) return sandboxes;
      } else if (pagination.hasNextPage === false) {
        return sandboxes;
      } else if (pagination.hasNextPage !== true || items.length === 0) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Invalid OpenSandbox list continuation', { page });
      }
    }
  }

  async #confirmSandboxDeletion(sandboxId, remaining) {
    const path = `/sandboxes/${encodeURIComponent(sandboxId)}`;
    try {
      const deletion = await this.#request(path, { method: 'DELETE', timeoutMs: remaining(), allowStatuses: [404] });
      if (deletion.status === 404) return;
    } catch (error) {
      if (!error?.retryable && error?.details?.status !== 409) throw error;
    }
    const observed = await this.#request(path, { timeoutMs: remaining(), allowStatuses: [404] });
    if (observed.status !== 404) {
      throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Sandbox deletion is still pending', { sandbox_id: sandboxId }, { retryable: true });
    }
  }

  async ensureExecution({ executionId, botId = null, onCreateDispatch = null, onCreateRejected = null, onCreated = null, onWorkerToken,
    timeoutSeconds = 3600, projectQuotaRequired = false, cleanupOnFailure = true, workspaceRef = null, bindingVersion = null, environment = {}, metadata = {} } = {}) {
    const id = required(executionId, 'execution_id');
    required(botId, 'bot_id');
    const existing = this.executions.get(id);
    if (existing) {
      if (existing.preparing || existing.stopPromise) throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Sandbox preparation or cleanup is pending', { execution_id: id }, { retryable: true });
      return this.#snapshot(existing);
    }
    if (this.pendingCreations.has(id)) throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE,
      'Sandbox creation or cleanup is pending', { execution_id: id }, { retryable: true });
    if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 60) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Sandbox timeout must be at least 60 seconds');
    }
    const launchBody = { ...this.environment, ...envs(environment) };
    const { mission_id: configuredMission = null, mission_key: _missionKey, bot_id: _botId, bot_key: _botKey,
      resource_key: _resourceKey, runtime_id: configuredRuntime = null, runtime_key: _runtimeKey, ...labels } = { ...this.metadata, ...metadata };
    const creation = { bot_id: botId, resource_key: id, mission_id: configuredMission, runtime_id: configuredRuntime, inFlight: true, onCreated };
    if (creation) this.pendingCreations.set(id, creation);
    const workerToken = randomUUID();
    const workerEntrypoint = [...this.workerCommand, '--port', String(this.workerPort), ...(projectQuotaRequired ? ['--require-project-quota'] : [])];
    try {
      onWorkerToken?.(workerToken);
      const admission = onCreateDispatch?.({ provider: 'opensandbox', timeout_seconds: timeoutSeconds });
      if (typeof admission?.then === 'function') await admission;
    } catch (error) {
      if (creation) this.pendingCreations.delete(id);
      throw error;
    }
    const response = await this.#request('/sandboxes', {
      method: 'POST',
      body: {
        timeout: timeoutSeconds,
        image: { uri: this.image },
        entrypoint: workerEntrypoint,
        resourceLimits: this.resourceLimits,
        env: { ...launchBody, SWARMENV_WORKER_TOKEN: workerToken },
        ...(this.volumes.length > 0 ? { volumes: this.volumes } : {}),
        metadata: {
          ...labels,
          ...(configuredRuntime ? { runtime_key: openSandboxRuntimeKey(configuredRuntime) } : {}),
          ...(configuredMission ? { mission_key: openSandboxMissionKey(configuredMission) } : {}),
          bot_key: openSandboxBotKey(botId), resource_key: openSandboxBotKey(id),
          ...(bindingVersion === null || bindingVersion === undefined ? {} : { binding_version: String(bindingVersion) }),
        },
      },
      timeoutMs: 60_000,
    }).catch(async (error) => {
      if (creation) {
        try {
          if ([400, 401, 403, 422].includes(error?.details?.status)) {
            await onCreateRejected?.();
            this.pendingCreations.delete(id);
          }
        } finally {
          creation.inFlight = false;
        }
      }
      throw error;
    });
    if (creation) creation.inFlight = false;
    const created = responseValue(response.body);
    const sandboxId = created?.id ?? created?.sandbox_id;
    if (typeof sandboxId !== 'string' || sandboxId.length === 0) {
      throw new SwarmEnvError(ERROR_CODES.START_FAILED, 'OpenSandbox did not return a sandbox id', { response: created });
    }
    const suppliedExecdEndpoint = created?.execd_endpoint ?? created?.endpoint;
    let execdUrl = endpointForHost(suppliedExecdEndpoint, this.endpointHost);
    let execdHeaders = suppliedExecdEndpoint?.headers ?? {};
    // Retain the resource as soon as its provider ID exists. Endpoint/health
    // preparation failures must not erase responsibility for deletion.
    const record = { executionId: id, botId, projectQuotaRequired, boundExecutionId: null, sandboxId, execdUrl: null, execdHeaders, bindingVersion, hostWorkspaceRef: workspaceRef, createdAt: this.now(), workerToken, preparing: true };
    this.executions.set(id, record);
    this.pendingCreations.delete(id);
    try {
      await onCreated?.({ ...this.#snapshot(record), expires_at: created.expiresAt ?? null });
      if (!execdUrl) {
        const endpointResponse = await this.#request(`/sandboxes/${encodeURIComponent(sandboxId)}/endpoints/${this.execdPort}`, { method: 'GET', timeoutMs: 30_000 });
        const endpoint = responseValue(endpointResponse.body);
        execdUrl = endpointForHost(endpoint, this.endpointHost);
        execdHeaders = endpoint?.headers ?? {};
      }
      if (!execdUrl) throw new SwarmEnvError(ERROR_CODES.START_FAILED, 'OpenSandbox did not return an Execd endpoint', { sandbox_id: sandboxId, port: this.execdPort });
    } catch (error) {
      if (cleanupOnFailure) await this.stopExecution(id).catch((cleanupError) => {
        this.logger?.({ event: 'sandbox.prepare_cleanup_error', provider: 'opensandbox', execution_id: id, sandbox_id: sandboxId, error_class: cleanupError?.code ?? cleanupError?.name });
      });
      throw error;
    }
    record.execdUrl = execdUrl.replace(/\/$/, '');
    record.execdHeaders = execdHeaders;
    try {
      if (this.waitForExecdReady) await this.#waitExecd(record);
    } catch (error) {
      if (cleanupOnFailure) await this.stopExecution(id).catch(() => undefined);
      throw error;
    }
    record.preparing = false;
    if (this.executions.get(id) !== record || record.stopPromise) throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Sandbox was stopped during preparation', { execution_id: id }, { retryable: true });
    this.logger?.({ event: 'sandbox.started', provider: 'opensandbox', execution_id: id, sandbox_id: sandboxId, binding_version: bindingVersion });
    return this.#snapshot(record);
  }

  bindBotExecution({ botId, executionId, bindingVersion = null, workspaceRef = null }) {
    const record = this.#record(botId);
    if (record.botId !== botId || record.preparing || record.stopPromise) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bot Sandbox is not ready for binding');
    }
    required(executionId, 'execution_id');
    if ((record.boundExecutionId && record.boundExecutionId !== executionId) ||
        (this.executions.has(executionId) && this.executions.get(executionId) !== record)) {
      throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Bot Sandbox is already bound');
    }
    record.boundExecutionId = executionId;
    record.bindingVersion = bindingVersion;
    record.hostWorkspaceRef = workspaceRef;
    this.executions.set(executionId, record);
    return this.#snapshot(record);
  }

  async exec({ executionId, command: value, cwd = '/workspace', timeoutMs = this.commandTimeoutMs, env = {}, internalEnvironment = {} } = {}) {
    const record = this.#record(executionId);
    const normalizedTimeout = timeout(timeoutMs);
    if (this.foregroundSession) {
      const sessionResult = await this.#execInSession(record, executionId, value, cwd, normalizedTimeout, env, internalEnvironment);
      if (sessionResult) return sessionResult;
    }
    const payload = { ...command(value), cwd: underWorkspace(cwd), timeout: normalizedTimeout, background: false, envs: { ...envs(env), ...envs(internalEnvironment, { allowSecrets: true }) } };
    const startedAt = this.now();
    let response;
    try {
      response = await this.#execd(record, '/command', { method: 'POST', body: payload, timeoutMs: normalizedTimeout + 10_000 });
    } catch (error) {
      // OpenSandbox's current API documents native `argv`, while older
      // Execd images shipped by the 1.2 server accepted only shell text. A
      // quoted fallback keeps literal argument boundaries on those images
      // without masking unrelated request validation failures.
      const diagnostic = typeof error?.details?.diagnostic === 'string' ? error.details.diagnostic : JSON.stringify(error?.details?.diagnostic ?? '');
      if (Array.isArray(value) && error?.code === ERROR_CODES.INVALID_CONTRACT && error?.details?.status === 400 && /command.*(required|missing)|invalid request body/i.test(diagnostic)) {
        response = await this.#execd(record, '/command', {
          method: 'POST',
          body: { command: value.map(shellQuote).join(' '), cwd: underWorkspace(cwd), timeout: normalizedTimeout, background: false, envs: { ...envs(env), ...envs(internalEnvironment, { allowSecrets: true }) } },
          timeoutMs: normalizedTimeout + 10_000,
        });
      } else {
        if (error?.code === ERROR_CODES.SERVICE_TIMEOUT) {
          // Execd's foreground contract binds the process lifetime to the SSE
          // stream. Aborting this request closes that stream; a command ID is
          // not available until Execd emits an accepted event, so a follow-up
          // DELETE cannot be issued for this particular foreground request.
          this.logger?.({ event: 'sandbox.exec_timeout_disconnect', provider: 'opensandbox', execution_id: executionId, timeout_ms: normalizedTimeout });
        }
        throw error;
      }
    }
    const events = parseSse(response.text);
    const result = this.#commandResult(events, response.body, { startedAt });
    const job = { jobId: result.job_id, executionId, sandboxId: record.sandboxId, state: result.state, command: value, started_at: startedAt, finished_at: this.now(), exit_code: result.exit_code, timed_out: result.timed_out, truncated: result.truncated };
    this.logger?.({ event: 'sandbox.exec', provider: 'opensandbox', execution_id: executionId, job_id: job.jobId, exit_code: job.exit_code, timed_out: job.timed_out, duration_ms: job.finished_at - startedAt });
    return { execution_id: executionId, job_id: job.jobId, binding_version: record.bindingVersion, exit_code: job.exit_code, timed_out: job.timed_out, truncated: job.truncated, duration_ms: job.finished_at - startedAt, stdout: result.stdout, stderr: result.stderr };
  }

  async #execInSession(record, executionId, value, cwd, timeoutMs, environment, internalEnvironment = {}) {
    const normalized = command(value);
    const workdir = underWorkspace(cwd);
    let sessionId;
    try {
      const created = responseValue((await this.#execd(record, '/session', { method: 'POST', body: { cwd: workdir }, timeoutMs: 15_000 })).body);
      sessionId = created?.session_id ?? created?.sessionId ?? created?.id ?? null;
    } catch (error) {
      // Older Execd deployments expose only /command. Preserve that path
      // when the session endpoint is explicitly unavailable.
      if (error?.details?.status === 404 || error?.code === ERROR_CODES.SERVICE_CAPABILITY_NOT_FOUND) return null;
      throw error;
    }
    if (!sessionId) return null;
    const startedAt = this.now();
    const commandText = normalized.command ?? normalized.argv.map(shellQuote).join(' ');
    try {
      const response = await this.#execd(record, `/session/${encodeURIComponent(sessionId)}/run`, {
        method: 'POST',
        body: { command: commandText, cwd: workdir, timeout: timeoutMs, envs: { ...envs(environment), ...envs(internalEnvironment, { allowSecrets: true }) } },
        timeoutMs: timeoutMs + 10_000,
      });
      const events = parseSse(response.text);
      const result = this.#commandResult(events, response.body, { startedAt });
      const job = { jobId: result.job_id ?? sessionId, executionId, sandboxId: record.sandboxId, state: result.state, command: value, started_at: startedAt, finished_at: this.now(), exit_code: result.exit_code, timed_out: result.timed_out, truncated: result.truncated };
      return { execution_id: executionId, job_id: job.jobId, binding_version: record.bindingVersion, exit_code: job.exit_code, timed_out: job.timed_out, truncated: job.truncated, duration_ms: job.finished_at - startedAt, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      if (error?.code === ERROR_CODES.SERVICE_TIMEOUT) {
        await this.#execd(record, `/command?id=${encodeURIComponent(sessionId)}`, { method: 'DELETE', timeoutMs: 15_000 }).catch(() => undefined);
        this.logger?.({ event: 'sandbox.exec_session_cancelled', provider: 'opensandbox', execution_id: executionId, session_id: sessionId, timeout_ms: timeoutMs });
      }
      throw error;
    } finally {
      await this.#execd(record, `/session/${encodeURIComponent(sessionId)}`, { method: 'DELETE', timeoutMs: 15_000 }).catch(() => undefined);
    }
  }

  async startAgent({ agentMode = 'swarm', writable = false, files, executionId, command: agentCommand, args = [], cwd = '/workspace/project', env = {}, secretEnvironment = {}, sessionDir = '/workspace/runtime/pi-session', systemPrompt = null, systemPromptPath = null, resources, projectQuota = null, modelCatalogResource = null, beforeAgentStart = null } = {}) {
    let contract = { protocolVersion: 'swarmenv-core-v1', resources: [] };
    if (agentMode !== 'core') {
      const { agentContract } = await import('../agent/bot-contract.js');
      contract = agentContract(agentMode);
      if (resources === undefined) resources = contract.resources;
    }
    const record = this.#record(executionId);
    const signature = values => Array.isArray(values) && values.every(item => item && typeof item.path === 'string' && /^[a-f0-9]{64}$/.test(item.sha256))
      ? JSON.stringify(values.map(({ path, sha256 }) => ({ path, sha256 })).sort((a, b) => a.path.localeCompare(b.path))) : null;
    const expectedVersion = files !== undefined || writable ? 1 : 0;
    const expectedDigest = agentMode === 'core' && expectedVersion === 1 ? decodeFileSeed(files ?? {}).digest : undefined;
    if (signature(resources) !== signature(contract.resources)) throw new SwarmEnvError(ERROR_CODES.BOT_STARTUP_CONTRACT, 'Agent startup requires the complete pinned Bot contract');
    if (!record.botId) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Agent worker startup requires a registered Bot Sandbox');
    if (record.projectQuotaRequired !== Boolean(projectQuota)) throw new SwarmEnvError(ERROR_CODES.BOT_STARTUP_CONTRACT, 'Worker startup quota does not match the Sandbox launch mode');
    if (record.agent) return { ...record.agent };
    record.executionStopped = false;
    const workerToken = record.workerToken;
    if (typeof workerToken !== 'string' || workerToken.length === 0) throw new SwarmEnvError(ERROR_CODES.START_FAILED, 'OpenSandbox worker token is unavailable for this Execution');
    let endpoint = endpointForHost((await this.#request(`/sandboxes/${encodeURIComponent(record.sandboxId)}/endpoints/${this.workerPort}`, { method: 'GET', timeoutMs: 30_000 })).body, this.endpointHost);
    if (!endpoint) throw new SwarmEnvError(ERROR_CODES.START_FAILED, 'OpenSandbox did not return the Agent worker endpoint', { sandbox_id: record.sandboxId, port: this.workerPort });
    endpoint = endpoint.replace(/\/$/, '');
    const workerHeaders = { authorization: `Bearer ${workerToken}` };
    await this.#waitWorker(endpoint, workerHeaders);
    beforeAgentStart?.();
    if (agentMode === 'core') record.coreAgent = true;
    if (agentMode === 'core') record.agent = { endpoint, token: workerToken, worker_port: this.workerPort, started_at: this.now(), starting: true };
    const startup = await this.#request(`${endpoint}/start`, {
      absolute: true,
      workerStart: true,
      method: 'POST',
      extraHeaders: workerHeaders,
      body: {
        command: required(agentCommand, 'agent_command'),
        args,
        cwd,
        env: envs(env, { allowSecrets: agentMode === 'core' }),
        // Explicitly supplied secret values travel only over the authenticated
        // worker channel and are never included in a manager snapshot/log.
        secret_env: envs(secretEnvironment, { allowSecrets: true }),
        session_dir: sessionDir,
        system_prompt: systemPrompt,
        system_prompt_path: systemPromptPath,
        resources,
        contract_version: contract.protocolVersion,
        writable,
        ...(files === undefined ? {} : { files }),
        ...(projectQuota ? { project_quota: projectQuota } : {}),
        ...(modelCatalogResource ? { model_catalog_resource: modelCatalogResource } : {}),
      },
      timeoutMs: 30_000,
    });
    const receipt = startup.body?.result?.contract;
    if (receipt?.version !== contract.protocolVersion || !Array.isArray(receipt.resources) || signature(receipt.resources) !== signature(resources)) {
      throw new SwarmEnvError(ERROR_CODES.BOT_STARTUP_CONTRACT, 'worker did not attest the pinned Bot contract resources');
    }
    const quotaReceipt = startup.body?.result?.project_quota;
    const catalogReceipt = startup.body?.result?.model_catalog_resource;
    if (projectQuota && (quotaReceipt?.bytes !== projectQuota.bytes || quotaReceipt?.inodes !== projectQuota.inodes)) {
      throw new SwarmEnvError(ERROR_CODES.BOT_STARTUP_CONTRACT, 'worker did not attest Bot workspace quota');
    }
    if (modelCatalogResource && signature([catalogReceipt]) !== signature([modelCatalogResource])) {
      throw new SwarmEnvError(ERROR_CODES.BOT_STARTUP_CONTRACT, 'worker did not attest the pinned Pi model catalog');
    }
    const fileReceipt = startup.body?.result?.project_files;
    if (agentMode === 'core' && (fileReceipt?.version !== expectedVersion || fileReceipt.writable !== writable || fileReceipt.digest !== expectedDigest)) {
      throw new SwarmEnvError(ERROR_CODES.BOT_STARTUP_CONTRACT, 'worker did not attest initial Core files and workDir permissions');
    }
    record.agent = { endpoint, token: workerToken, worker_port: this.workerPort, started_at: this.now(), contract: receipt };
    this.logger?.({ event: 'sandbox.agent_started', provider: 'opensandbox', execution_id: executionId, sandbox_id: record.sandboxId, worker_port: this.workerPort });
    return { ...record.agent };
  }

  /**
   * Resolve executable versions in the provider guest. The controller may not
   * have Pi or the image's Node installation, so manifest evidence
   * must never silently describe the host process.
   */
  async agentVersions({ executionId, piCommand = 'pi', nodeCommand = 'node', timeoutMs = 15_000 } = {}) {
    this.#record(executionId);
    const versions = {};
    const commands = [
      ['piVersion', 'pi', piCommand],
      ['nodeVersion', 'node', nodeCommand],
    ];
    for (const [field, commandName, command] of commands) {
      if (typeof command !== 'string' || command.length === 0) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `${commandName} command is required`);
      const result = await this.exec({ executionId, command: [command, '--version'], cwd: '/workspace', timeoutMs });
      if (result.exit_code !== 0) throw new SwarmEnvError(ERROR_CODES.START_FAILED, `${commandName} --version failed inside OpenSandbox`, { command: commandName, exit_code: result.exit_code, diagnostic: safeDiagnostic(result.stderr) });
      versions[field] = exactCommandVersion(`${result.stdout}\n${result.stderr}`, commandName);
    }
    return versions;
  }

  async syncWorkspace({ executionId, workspaceRef, manifest = null, maxFileBytes = 2 * 1024 * 1024, maxTotalBytes = 16 * 1024 * 1024 } = {}) {
    const record = this.#record(executionId);
    if (typeof workspaceRef !== 'string' || workspaceRef.length === 0) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'workspaceRef is required to initialize the provider Workspace');
    const root = workspaceRef;
    const files = [];
    if (!manifest) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Bot input requires a pinned manifest');
    if (manifest) {
      const rootInfo = await lstat(root);
      if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Public Workspace input root must be a regular directory');
      for (const path of Object.keys(manifest)) {
        const segments = path.split('/');
        if (segments.some(segment => !segment || ['.', '..', '.git', '.swarm', '.pi', '.env'].includes(segment) || segment.startsWith('.swarm-') || segment.startsWith('.env.')) || path.includes('\\') || path.includes('\0')) {
          throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Public Workspace manifest contains a forbidden path');
        }
        let current = root;
        for (const [index, segment] of segments.entries()) {
          current = join(current, segment);
          const info = await lstat(current);
          if (info.isSymbolicLink() || (index < segments.length - 1 ? !info.isDirectory() : !info.isFile())) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Public Workspace input must contain regular files without symlinks');
        }
        files.push(join(root, path));
      }
    }
    let total = 0;
    const inputFiles = Object.create(null);
    for (const source of files) {
      const content = await readFile(source);
      if (content.length > maxFileBytes || total + content.length > maxTotalBytes) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'initial Workspace exceeds provider sync bounds', { max_file_bytes: maxFileBytes, max_total_bytes: maxTotalBytes });
      total += content.length;
      const path = relative(root, source).split('\\').join('/');
      const digest = createHash('sha256').update(content).digest('hex');
      if (manifest && (manifest[path]?.content_hash !== digest || manifest[path]?.bytes !== content.length)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Public Workspace input bytes differ from the pinned manifest', { path });
      inputFiles[path] = content.toString('base64');
    }
    await this.#projectCall(executionId, 'prepare', manifest, { files: inputFiles });
    this.logger?.({ event: 'sandbox.workspace_initialized', provider: 'opensandbox', execution_id: executionId, file_count: files.length, bytes: total });
    return { execution_id: executionId, file_count: files.length, bytes: total, workspace: '/workspace/project' };
  }

  async #projectCall(executionId, action, manifest = undefined, input = {}) {
    const record = this.#record(executionId);
    if (!record.botId || record.boundExecutionId !== executionId || !record.agent || record.stopPromise) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Project control requires the live bound Bot worker');
    const body = { ...input, execution_id: executionId, binding_version: record.bindingVersion, ...(manifest ? { manifest } : {}) };
    const response = await this.#request(`${record.agent.endpoint}/project/${action}`, { absolute: true, method: 'POST',
      extraHeaders: { authorization: `Bearer ${record.agent.token}` }, body, timeoutMs: action.startsWith('install') ? 5000 : 30_000 });
    const result = responseValue(response.body);
    const expected = action === 'prepare' ? 'PREPARED' : 'ACTIVE';
    if ((!action.startsWith('install') && result?.state !== expected) || result?.execution_id !== executionId || result?.binding_version !== record.bindingVersion) throw new SwarmEnvError(ERROR_CODES.START_FAILED, 'Worker did not confirm the expected project permission state');
    if (record.stopPromise || this.executions.get(executionId) !== record) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bot stopped during project control');
    this.logger?.({ event: `sandbox.project_${action === 'prepare' ? 'prepared' : action === 'grant' ? 'granted' : action}`, bot_id: record.botId, execution_id: executionId, binding_version: record.bindingVersion });
    return result;
  }

  prepareBotProject({ executionId, manifest }) { return this.#projectCall(executionId, 'prepare', manifest); }
  grantBotProject({ executionId }) { return this.#projectCall(executionId, 'grant'); }

  async coreFileOperation(executionId, action, input) {
    const record = this.#record(executionId);
    if (record.agent?.contract?.version !== 'swarmenv-core-v1' || record.stopPromise) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Core files require the live Bot Worker');
    }
    const response = await this.#request(`${record.agent.endpoint}/core/files/${action}`, {
      absolute: true, method: 'POST', extraHeaders: { authorization: `Bearer ${record.agent.token}` },
      body: input, timeoutMs: 30_000, allowStatuses: [400],
    });
    if (response.status === 400) {
      const { code, error } = response.body ?? {};
      const recognized = ['CONFLICT', 'INVALID_CONTRACT', 'NOT_ALLOWED', 'WORKSPACE_BUSY', 'OPERATION_UNKNOWN'];
      throw new SwarmEnvError(recognized.includes(code) ? code : 'OPERATION_UNKNOWN',
        typeof error === 'string' ? error : 'Worker could not confirm the Core file operation');
    }
    return responseValue(response.body);
  }

  snapshotBotProject({ executionId }) { return this.#projectCall(executionId, 'snapshot'); }
  installBotProject({ executionId, ...input }) { return this.#projectCall(executionId, 'install', undefined, input); }
  queryBotProjectInstall({ executionId, request_id }) {
    const closed = this.projectInstallReceipts.get(executionId);
    if (closed) return structuredClone(closed.receipts.find(receipt => receipt.request_id === request_id) ?? { execution_id: executionId, binding_version: closed.bindingVersion, request_id, phase: 'not_found' });
    return this.#projectCall(executionId, 'install-result', undefined, { request_id });
  }
  forgetBotProjectInstalls({ executionId }) { this.projectInstallReceipts.delete(executionId); }
  confirmBotProjectInstall({ executionId, request_id, content_hash }) { return this.#projectCall(executionId, 'install-confirm', undefined, { request_id, content_hash }); }

  /** Pull guest files back before Runtime checkpoints or deletes the sandbox. */
  async agentRpc(executionId, message, { timeoutMs = 600_000, since } = {}) {
    const record = this.#record(executionId);
    if (!record.agent) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Agent worker is not started', { execution_id: executionId });
    const response = await this.#request(`${record.agent.endpoint}/rpc`, { absolute: true, method: 'POST', extraHeaders: { authorization: `Bearer ${record.agent.token}` }, body: { message, timeout_ms: timeoutMs, ...(since === undefined ? {} : { since }) }, timeoutMs: timeoutMs + 10_000 });
    return responseValue(response.body);
  }

  async *agentEvents(executionId, { since = 0 } = {}) {
    const record = this.#record(executionId);
    if (!record.agent) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Agent worker is not started', { execution_id: executionId });
    const response = await this.fetch(`${record.agent.endpoint}/events?since=${encodeURIComponent(Math.max(0, Number(since) || 0))}`, { method: 'GET', headers: { accept: 'text/event-stream', authorization: `Bearer ${record.agent.token}` } });
    if (!response.ok || !response.body) throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, `Agent worker event stream failed with HTTP ${response.status}`, { status: response.status }, { retryable: true });
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += Buffer.from(chunk).toString('utf8');
      for (const block of buffer.split(/\r?\n\r?\n/).slice(0, -1)) {
        const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
        if (data) yield jsonData(data);
      }
      buffer = buffer.includes('\n\n') ? buffer.slice(buffer.lastIndexOf('\n\n') + 2) : buffer;
    }
  }

  async stopAgent(executionId, signal = 'SIGTERM', { preserveWorker = false } = {}) {
    const record = this.executions.get(executionId);
    if (!record?.agent) return record?.executionStopped === true;
    if (record.executionStopped) {
      if (!preserveWorker) record.agent = null;
      return true;
    }
    const response = await this.#request(`${record.agent.endpoint}/stop`, { absolute: true, method: 'POST', extraHeaders: { authorization: `Bearer ${record.agent.token}` }, body: { signal }, timeoutMs: 15_000 });
    const stopped = responseValue(response.body);
    if (stopped?.stopped === true && Array.isArray(stopped.project_installs) && record.boundExecutionId) {
      this.projectInstallReceipts.set(record.boundExecutionId, { bindingVersion: record.bindingVersion,
        receipts: stopped.project_installs.filter(receipt => receipt.execution_id === record.boundExecutionId && receipt.binding_version === record.bindingVersion) });
    }
    if (stopped?.stopped !== true) throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Worker did not confirm execution stopped');
    record.executionStopped = true;
    if (!preserveWorker) record.agent = null;
    return true;
  }

  coreResource(executionId) {
    const record = this.executions.get(executionId);
    const creation = this.pendingCreations.get(executionId);
    return { resourceKey: record?.executionId ?? creation?.resource_key ?? executionId,
      ...(record?.sandboxId || creation?.sandbox_id ? { sandboxId: record?.sandboxId ?? creation.sandbox_id } : {}),
      creation: record ? 'created' : creation ? 'pending' : 'absent',
      executionStopped: record?.executionStopped === true };
  }

  async *collectCoreFiles(executionId, input) {
    const spec = snapshotCollectionSpec(input);
    const record = this.#record(executionId);
    if (!record.executionStopped || !record.coreAgent || !record.agent || record.stopPromise) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Core collection requires a confirmed stopped Bot and retained Worker');
    }
    const fingerprint = JSON.stringify(spec);
    if (record.collectionSpec && record.collectionSpec !== fingerprint) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Bot collection policy is immutable');
    record.collectionSpec = fingerprint;
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(new Error('Core collection transport deadline')), 30_000);
    let response;
    try {
      response = await this.fetch(`${record.agent.endpoint}/core/files/collect`, { method: 'POST',
        headers: { authorization: `Bearer ${record.agent.token}`, 'content-type': 'application/json', accept: 'application/x-ndjson' },
        body: JSON.stringify(spec), signal: controller.signal, redirect: 'error' });
      if (!response.ok || !response.body || response.headers.get('content-type')?.split(';')[0] !== 'application/x-ndjson') {
        throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Worker did not return the bounded Core collection stream');
      }
      let pending = Buffer.alloc(0);
      let ended = false;
      for await (const chunk of response.body) {
        let offset = 0;
        const bytes = Buffer.from(chunk);
        while (offset < bytes.length) {
          controller.signal.throwIfAborted();
          const newline = bytes.indexOf(10, offset);
          const end = newline === -1 ? bytes.length : newline;
          if (pending.length + end - offset > MAX_COLLECTION_LINE_BYTES) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Core collection record exceeds its line limit');
          pending = Buffer.concat([pending, bytes.subarray(offset, end)]);
          offset = end + (newline === -1 ? 0 : 1);
          if (newline === -1) break;
          if (ended) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Core collection contains records after its final receipt');
          let value;
          try { value = JSON.parse(pending.toString('utf8')); } catch { throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Core collection record is not valid JSON'); }
          pending = Buffer.alloc(0);
          if (value?.type === 'error') throw new SwarmEnvError(
            ['INVALID_CONTRACT', 'NOT_ALLOWED', 'CONFLICT', 'SERVICE_UNAVAILABLE'].includes(value.code) ? value.code : ERROR_CODES.SERVICE_UNAVAILABLE,
            typeof value.message === 'string' ? value.message : 'Worker collection failed');
          if (!['directory', 'file', 'chunk', 'fileEnd', 'end'].includes(value?.type)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Core collection record type is invalid');
          ended = value.type === 'end';
          yield value;
        }
      }
      if (!ended || pending.length) throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Worker collection stream ended without a complete receipt');
    } finally {
      clearTimeout(deadline);
      controller.abort();
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    }
  }

  async stopExecution(executionId) {
    const record = this.executions.get(executionId);
    if (!record) {
      const creation = this.pendingCreations.get(executionId);
      if (!creation) return false;
      if (creation.inFlight) throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE,
        'Sandbox creation is still pending', { execution_id: executionId }, { retryable: true });
      if (!creation.stopPromise) creation.stopPromise = this.#releaseUnknownCreation(creation).finally(() => { creation.stopPromise = null; });
      return creation.stopPromise;
    }
    if (record.stopPromise) return record.stopPromise;
    const stopping = this.#deleteExecution(executionId, record).finally(() => { record.stopPromise = null; });
    record.stopPromise = stopping;
    return stopping;
  }

  async #deleteExecution(executionId, record) {
    if (record.coreAgent) {
      if (!await this.stopAgent(executionId, 'SIGTERM', { preserveWorker: true })) {
        throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Core deletion requires confirmed execution stop');
      }
    }
    else await this.stopAgent(executionId).catch(() => undefined);
    const deadline = Date.now() + 30_000;
    await this.#confirmSandboxDeletion(record.sandboxId, () => Math.max(1, deadline - Date.now()));
    for (const [key, resource] of this.executions) if (resource === record) this.executions.delete(key);
    this.logger?.({ event: 'sandbox.stopped', provider: 'opensandbox', execution_id: executionId, sandbox_id: record.sandboxId });
    return true;
  }

  async #releaseUnknownCreation(creation) {
    const result = await this.#reconcileExecutions({ missionId: creation.mission_id, runtimeId: creation.runtime_id, bots: [creation],
      onSandboxDiscovered: async (bot, sandboxId) => {
        await bot.onCreated?.({ provider: 'opensandbox', bot_id: bot.bot_id, resource_key: bot.resource_key, sandbox_id: sandboxId });
        bot.sandbox_id = sandboxId;
      } }, creation);
    if (!result.confirmed_bot_ids.includes(creation.bot_id)) {
      throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Sandbox creation or deletion cannot be confirmed',
        { bot_id: creation.bot_id, resource_key: creation.resource_key }, { retryable: true });
    }
    this.pendingCreations.delete(creation.resource_key);
    return true;
  }

  async stopAll() { for (const id of new Set([...this.executions.keys(), ...this.pendingCreations.keys()])) await this.stopExecution(id); }

  snapshot() { return { provider: 'opensandbox', lifecycle_url: this.lifecycleBaseUrl, image: this.image, verified: this.verified, executions: [...new Set(this.executions.values())].map((record) => this.#snapshot(record)) }; }

  #snapshot(record) { return { execution_id: record.boundExecutionId, bot_id: record.botId, resource_key: record.executionId, sandbox_id: record.sandboxId, binding_version: record.bindingVersion, workspace: '/workspace/project', host_workspace_ref: null, agent_worker: record.agent ? { worker_port: record.agent.worker_port, started_at: record.agent.started_at } : null }; }
  #record(executionId) { const record = this.executions.get(executionId); if (!record) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'sandbox is not bound to this Execution', { execution_id: executionId }); return record; }

  async #waitWorker(endpoint, headers) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const response = await this.fetch(`${endpoint}/health`, { method: 'GET', headers });
        if (response.ok) return;
      } catch { /* worker is still starting */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new SwarmEnvError(ERROR_CODES.START_FAILED, 'Agent worker did not become ready', { endpoint: safeUrl(endpoint) }, { retryable: true });
  }

  async #waitExecd(record) {
    const deadline = Date.now() + this.execdReadyTimeoutMs;
    while (Date.now() < deadline) {
      for (const path of ['/ready', '/ping']) {
        try {
          await this.#request(`${record.execdUrl}${path}`, { method: 'GET', timeoutMs: 3_000, absolute: true, extraHeaders: record.execdHeaders });
          return;
        } catch (error) {
          // Execd v1.1 exposes /ping but not /ready; a 404 is a capability
          // difference, while transport/503 errors should keep polling.
          if (path === '/ready' && error?.details?.status === 404) continue;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new SwarmEnvError(ERROR_CODES.START_FAILED, 'OpenSandbox Execd did not become ready', { endpoint: safeUrl(record.execdUrl), timeout_ms: this.execdReadyTimeoutMs }, { retryable: true });
  }

  #commandResult(events, body, { startedAt }) {
    let stdout = ''; let stderr = ''; let truncated = false; let jobId = null; let exitCode = null; let timedOut = false; let state = 'completed';
    for (const item of events) {
      const data = item.data && typeof item.data === 'object' ? item.data : {};
      jobId = jobId ?? data.command_id ?? data.id ?? data.execution_id ?? null;
      if (item.event === 'stdout' || item.event === 'output') [stdout, truncated] = appendOutput(stdout, data.text ?? data.data ?? (typeof item.data === 'string' ? item.data : ''), this.maxOutputBytes);
      if (item.event === 'stderr') [stderr, truncated] = appendOutput(stderr, data.text ?? data.data ?? '', this.maxOutputBytes);
      if (item.event === 'execution_complete' || item.event === 'complete') { state = 'completed'; exitCode = data.exit_code ?? data.exitCode ?? 0; }
      if (item.event === 'error') { state = 'completed'; exitCode = data.exit_code ?? data.exitCode ?? 1; timedOut = /timeout/i.test(String(data.message ?? data.error ?? '')); }
    }
    const fallback = responseValue(body);
    if (fallback && typeof fallback === 'object') {
      jobId = jobId ?? fallback.command_id ?? fallback.id ?? null;
      exitCode = exitCode ?? fallback.exit_code ?? null;
      stdout ||= fallback.stdout ?? '';
      stderr ||= fallback.stderr ?? '';
      if (fallback.running === true) state = 'running';
    }
    if (events.length === 0 && !fallback) throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'OpenSandbox Execd returned no command result', { started_at: startedAt }, { retryable: true });
    return { job_id: jobId ?? randomUUID(), state, exit_code: exitCode, timed_out: timedOut, truncated, stdout, stderr };
  }

  async #execd(record, path, options) { return this.#request(`${record.execdUrl}${path}`, { ...options, absolute: true, extraHeaders: record.execdHeaders }); }

  async #request(path, { method = 'GET', body = undefined, timeoutMs = this.commandTimeoutMs, absolute = false, extraHeaders = {}, allowStatuses = [], workerStart = false } = {}) {
    const url = absolute ? path : `${this.lifecycleBaseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('sandbox provider request timed out')), timeoutMs);
    const headers = { accept: 'application/json', ...extraHeaders };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (absolute) {
      if (this.execdToken && !Object.keys(headers).some((name) => name.toLowerCase() === 'x-execd-access-token')) headers['X-EXECD-ACCESS-TOKEN'] = this.execdToken;
    } else if (this.apiKey) headers['OPEN-SANDBOX-API-KEY'] = this.apiKey;
    try {
      const response = await this.fetch(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal });
      const text = await response.text();
      const parsed = response.headers?.get?.('content-type')?.includes('text/event-stream') ? null : (text ? jsonData(text) : {});
      if (workerStart && response.status === 400 && parsed?.ok === false && parsed.code === ERROR_CODES.BOT_STARTUP_CONTRACT) {
        throw new SwarmEnvError(ERROR_CODES.BOT_STARTUP_CONTRACT, 'Worker rejected the pinned Bot startup contract');
      }
      if (!response.ok && !allowStatuses.includes(response.status)) throw new SwarmEnvError(absolute && /\/project\/(snapshot|install|install-result|install-confirm)$/.test(new URL(url).pathname) && [ERROR_CODES.WORKSPACE_BUSY, ERROR_CODES.WORKSPACE_RESULT_UNKNOWN, ERROR_CODES.WORKSPACE_RECONCILIATION_REQUIRED].includes(parsed?.code)
        ? parsed.code : response.status >= 500 ? ERROR_CODES.SERVICE_UNAVAILABLE : ERROR_CODES.INVALID_CONTRACT,
      `OpenSandbox request failed with HTTP ${response.status}`, { status: response.status, diagnostic: safeDiagnostic(parsed ?? text),
        ...(absolute && parsed?.code === ERROR_CODES.WORKSPACE_BUSY && ['dirty', 'active_writer'].includes(parsed.apply_blocker) ? { apply_blocker: parsed.apply_blocker } : {}) },
      { retryable: response.status >= 500 || response.status === 429 || parsed?.code === ERROR_CODES.WORKSPACE_BUSY });
      return { status: response.status, body: parsed, text };
    } catch (error) {
      if (error instanceof SwarmEnvError) throw error;
      if (controller.signal.aborted) throw new SwarmEnvError(ERROR_CODES.SERVICE_TIMEOUT, 'OpenSandbox request timed out', { url: safeUrl(url) }, { cause: error, retryable: true });
      throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, error?.message ?? 'OpenSandbox request failed', { url: safeUrl(url) }, { cause: error, retryable: true });
    } finally { clearTimeout(timer); }
  }
}

export function createOpenSandboxManager(options = {}) { return new OpenSandboxManager(options); }

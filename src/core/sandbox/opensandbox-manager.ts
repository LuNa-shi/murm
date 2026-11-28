import { WorkerClient } from './worker-client.js';
import { required, envs, safeDiagnostic, safeUrl } from './sandbox-validation.js';
import { OpenSandboxSdk, sdkOperation, sdkExpiry } from './opensandbox-sdk.js';
import { randomUUID } from 'node:crypto';
import { DEFAULT_EGRESS_PORT } from '@alibaba-group/opensandbox';
import { ERROR_CODES, MurmError } from '../../errors.js';
import { openSandboxAgentKey, openSandboxMissionKey, openSandboxRuntimeKey } from './opensandbox-metadata.js';

const DEFAULT_EXECd_PORT = 44772;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 60 * 60_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

function baseUrl(value: any) {
  const url = new URL(required(value, 'lifecycleBaseUrl'));
  url.pathname = url.pathname.replace(/\/$/, '');
  return url.toString().replace(/\/$/, '');
}

function timeout(value: any) {
  if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    throw new MurmError(ERROR_CODES.INVALID_CONTRACT, `sandbox timeout must be between 1 and ${MAX_TIMEOUT_MS} ms`, { timeout_ms: value });
  }
  return value;
}

function normalizeVolumes(value: any) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'sandbox volumes must be an array');
  return value.map((volume: any, index: any) => {
    if (!volume || typeof volume !== 'object' || Array.isArray(volume)) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, `sandbox volume ${index} must be an object`);
    if (typeof volume.name !== 'string' || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(volume.name)) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, `sandbox volume ${index} has an invalid name`);
    if (typeof volume.mountPath !== 'string' || !volume.mountPath.startsWith('/') || volume.mountPath.split('/').includes('..')) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, `sandbox volume ${index} has an invalid mountPath`);
    if (Object.hasOwn(volume, 'host')) throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'OpenSandbox host-path volumes are not allowed for Agent Executions');
    if (Object.hasOwn(volume, 'readOnly') && typeof volume.readOnly !== 'boolean') throw new MurmError(ERROR_CODES.INVALID_CONTRACT, `sandbox volume ${index}.readOnly must be boolean`);
    return structuredClone(volume);
  });
}

function command(value: any) {
  if (typeof value === 'string' && value.trim()) return { command: value };
  if (Array.isArray(value) && value.length > 0 && value.every((part: any) => typeof part === 'string')) return { argv: value };
  throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'sandbox command must be a non-empty shell string or argv array');
}

function underWorkspace(value: any) {
  const cwd = value ?? '/workspace';
  if (typeof cwd !== 'string' || !(cwd === '/workspace' || cwd.startsWith('/workspace/')) || cwd.split('/').includes('..')) {
    throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'sandbox cwd must stay inside /workspace', { cwd });
  }
  return cwd;
}

function appendOutput(current: any, text: any, maxBytes: any): [string, boolean] {
  const next = current + String(text ?? '');
  if (Buffer.byteLength(next) <= maxBytes) return [next, false];
  return [new TextDecoder().decode(Buffer.from(next).subarray(0, maxBytes), { stream: true }), true];
}

function jsonData(data: any) {
  if (typeof data !== 'string') return data;
  try { return JSON.parse(data); } catch { return data; }
}
function endpointUrl(value: { endpoint: string }, proxyBase?: string) {
  if (typeof value?.endpoint !== 'string' || !value.endpoint) return null;
  const endpoint = /^[a-z][a-z0-9+.-]*:\/\//i.test(value.endpoint) ? value.endpoint : `http://${value.endpoint}`;
  const url = new URL(endpoint);
  if (proxyBase) {
    const base = new URL(proxyBase);
    if (url.host === base.host || (url.hostname === base.hostname && !url.port)) url.protocol = base.protocol;
    if (url.origin !== base.origin || !url.pathname.startsWith(`${base.pathname.replace(/\/$/, '')}/sandboxes/`)) return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
  return url.toString().replace(/\/$/, '');
}

function shellQuote(value: any) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

function exactCommandVersion(value: any, commandName: any) {
  const match = String(value ?? '').match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
  if (!match) throw new MurmError(ERROR_CODES.START_FAILED, `could not determine ${commandName} version inside OpenSandbox`, { command: commandName });
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
  declare lifecycleBaseUrl: any;
  declare apiKey: any;
  declare execdToken: any;
  declare image: any;
  declare resourceLimits: any;
  declare entrypoint: any;
  declare metadata: any;
  declare environment: any;
  declare volumes: any;
  declare execdPort: any;
  declare requireManagementAuth: boolean;
  declare useServerProxy: boolean;
  declare egressMode?: 'dns+nft';
  declare workerPort: any;
  declare workerCommand: any;
  declare foregroundSession: any;
  declare waitForExecdReady: any;
  declare execdReadyTimeoutMs: any;
  declare fetch: any;
  declare commandTimeoutMs: any;
  declare maxOutputBytes: any;
  declare logger: any;
  declare now: any;
  declare executions: any;
  declare pendingCreations: any;
  declare reconciliationIds: any;
  declare projectInstallReceipts: any;
  declare verified: any;
  readonly sdk: OpenSandboxSdk;
  readonly worker: WorkerClient;

  constructor({
    lifecycleBaseUrl,
    apiKey = globalThis.process?.env?.OPEN_SANDBOX_API_KEY ?? null,
    execdToken = globalThis.process?.env?.MURM_EXECD_ACCESS_TOKEN ?? null,
    image,
    resourceLimits = { cpu: '2', memory: '2Gi' },
    entrypoint = ['tail', '-f', '/dev/null'],
    metadata = {},
    environment = {},
    volumes = [],
    execdPort = DEFAULT_EXECd_PORT,
    endpointHost = null,
    requireManagementAuth = false,
    useServerProxy = false,
    egressMode,
    workerPort = 44100,
    workerCommand = ['node', '/opt/murm/agent-worker.mjs'],
    foregroundSession = false,
    waitForExecdReady = null,
    execdReadyTimeoutMs = 30_000,
    fetchImpl = globalThis.fetch,
    adapterFactory,
    commandTimeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputBytes = MAX_OUTPUT_BYTES,
    logger = null,
    now = () => Date.now(),
  }: any = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('OpenSandboxManager requires fetch');
    this.lifecycleBaseUrl = baseUrl(lifecycleBaseUrl);
    this.apiKey = apiKey;
    this.execdToken = execdToken;
    this.image = required(image, 'image');
    this.resourceLimits = structuredClone(resourceLimits);
    if (!Array.isArray(entrypoint) || entrypoint.length === 0 || !entrypoint.every((part: any) => typeof part === 'string')) throw new TypeError('entrypoint must be a non-empty string array');
    this.entrypoint = [...entrypoint];
    if (this.entrypoint.length !== 3 || this.entrypoint[0] !== 'tail' || this.entrypoint[1] !== '-f' || this.entrypoint[2] !== '/dev/null') {
      throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'OpenSandbox uses the fixed Agent worker entrypoint; custom entrypoints are not supported');
    }
    this.metadata = { ...metadata };
    this.environment = envs(environment);
    this.volumes = normalizeVolumes(volumes);
    this.execdPort = execdPort;
    if (endpointHost !== null) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'endpointHost has been removed. Publish reachable endpoints in the OpenSandbox deployment or configure its Ingress.');
    this.requireManagementAuth = requireManagementAuth === true;
    this.useServerProxy = useServerProxy === true;
    this.egressMode = egressMode;
    if (!Number.isInteger(workerPort) || workerPort < 1 || workerPort > 65_535) throw new TypeError('workerPort must be an integer from 1 to 65535');
    if (!Array.isArray(workerCommand) || workerCommand.length === 0 || !workerCommand.every((part: any) => typeof part === 'string')) throw new TypeError('workerCommand must be a non-empty string array');
    this.workerPort = workerPort;
    this.workerCommand = [...workerCommand];
    this.foregroundSession = foregroundSession === true;
    // A custom fetch is normally a deterministic provider double; production
    // uses the global fetch and must pass the SDK Execd health gate.
    this.waitForExecdReady = waitForExecdReady === null ? fetchImpl === globalThis.fetch : waitForExecdReady !== false;
    if (!Number.isFinite(execdReadyTimeoutMs) || execdReadyTimeoutMs < 1_000 || execdReadyTimeoutMs > MAX_TIMEOUT_MS) throw new TypeError('execdReadyTimeoutMs must be between 1000 and 3600000');
    this.execdReadyTimeoutMs = execdReadyTimeoutMs;
    this.fetch = fetchImpl;
    this.commandTimeoutMs = timeout(commandTimeoutMs);
    if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1_024) throw new TypeError('maxOutputBytes must be at least 1024');
    this.maxOutputBytes = maxOutputBytes;
    this.logger = logger;
    this.now = now;
    this.executions = new Map<any, any>();
    this.pendingCreations = new Map<any, any>();
    this.reconciliationIds = new Map<any, any>();
    this.projectInstallReceipts = new Map<any, any>();
    this.verified = null;
    this.sdk = new OpenSandboxSdk({ lifecycleBaseUrl: this.lifecycleBaseUrl, apiKey: this.apiKey,
      useServerProxy: this.useServerProxy, fetchImpl, adapterFactory });
    this.worker = new WorkerClient({ executions: this.executions, projectInstallReceipts: this.projectInstallReceipts,
      resolveEndpoint: record => this.#workerEndpoint(record), checkAgentBoundary: id => this.#checkAgentBoundary(id),
      fetch: this.fetch, requireManagementAuth: this.requireManagementAuth, useServerProxy: this.useServerProxy,
      workerPort: this.workerPort, commandTimeoutMs: this.commandTimeoutMs, logger: this.logger, now: this.now });
  }

  async preflight({ timeoutMs = 20_000 }: any = {}) {
    const path = '/sandboxes?pageSize=1';
    if (this.requireManagementAuth && !this.apiKey) {
      throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'OpenSandbox API requires a trusted Lifecycle API key');
    }
    await sdkOperation('preflight', () => this.sdk.sandboxes.listSandboxes({ pageSize: 1 }));
    const response = { status: 200 };
    if (this.requireManagementAuth) {
      const unauthenticated = await this.#probeManagementAuthentication(path, { timeoutMs, allowStatuses: [401, 403], omitLifecycleKey: true });
      if (![401, 403].includes(unauthenticated.status)) {
        throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'OpenSandbox Lifecycle authentication could not be confirmed');
      }
    }
    this.verified = { lifecycle_url: this.lifecycleBaseUrl, provider: 'opensandbox', verified_at: this.now(), status: response.status };
    this.logger?.({ event: 'sandbox.provider_preflight', provider: 'opensandbox', lifecycle_url: this.lifecycleBaseUrl });
    return { ...this.verified, ok: true };
  }

  ownsAgentResource(resourceKey: any) { return this.executions.has(resourceKey) || this.pendingCreations.has(resourceKey); }

  async reconcileExecutions(options: any = {}) { return this.#reconcileExecutions(options); }

  async #reconcileExecutions({ missionId, runtimeId, agents = [], timeoutMs = 30_000, onSandboxDiscovered = null }: any = {}, recoveringCreation: any = null) {
    if (!runtimeId) required(missionId, 'mission_id');
    const owned = (key: any) => this.executions.has(key) ||
      (this.pendingCreations.has(key) && this.pendingCreations.get(key) !== recoveringCreation);
    const liveSandboxIds = new Set([...this.executions.values()].map((record: any) => record.sandboxId));
    const targets = agents.filter((agent: any) => (runtimeId ? agent.runtime_id === runtimeId : agent.mission_id === missionId) && agent.agent_id && agent.resource_key &&
      (!agent.provider || agent.provider === 'opensandbox'));
    const deadline = Date.now() + timeout(timeoutMs);
    const remaining = () => {
      const ms = deadline - Date.now();
      if (ms <= 0) throw new MurmError(ERROR_CODES.SERVICE_TIMEOUT, 'OpenSandbox reconciliation timed out', {}, { retryable: true });
      return ms;
    };
    const filter: Record<string, string> = runtimeId ? { runtime_key: openSandboxRuntimeKey(runtimeId) } : { mission_key: openSandboxMissionKey(missionId) };
    const sandboxes = await this.#listSandboxes(remaining, filter);
    const result: any = { provider: 'opensandbox', quarantined: [], pending: [], confirmed_agent_ids: [], owned_agent_ids: [] };
    const dispositions = new Map<any, any>();
    const quarantine = async (target: any) => {
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
      } catch (error: any) {
        result.pending.push({ ...target, reason: 'deletion_unconfirmed', error_class: error?.code ?? error?.name });
        return false;
      }
    };
    const knownIds = new Set(targets.map((agent: any) => agent.sandbox_id).filter(Boolean));
    const ownerKey = runtimeId ? openSandboxRuntimeKey(runtimeId) : openSandboxMissionKey(missionId);
    const missionMismatch = (metadata: any) => runtimeId
      ? metadata.runtime_key !== ownerKey
      : metadata.mission_key && metadata.mission_key !== ownerKey;
    for (const agent of targets) {
      if (owned(agent.resource_key)) {
        result.owned_agent_ids.push(agent.agent_id);
        continue;
      }
      const target = { agent_id: agent.agent_id, mission_id: missionId, execution_id: agent.execution_id ?? null, resource_key: agent.resource_key };
      const agentKey = openSandboxAgentKey(agent.agent_id);
      const resourceKey = openSandboxAgentKey(agent.resource_key);
      const matches = new Set<string>(this.reconciliationIds.get(agent.resource_key));
      if (agent.sandbox_id) matches.add(agent.sandbox_id);
      let conflict = false;
      for (const [sandboxId, metadata] of sandboxes) {
        if (!matches.has(sandboxId) && metadata.agent_key !== agentKey && metadata.resource_key !== resourceKey) continue;
        const incompatible = missionMismatch(metadata) || (metadata.agent_key && metadata.agent_key !== agentKey) ||
          (metadata.resource_key && metadata.resource_key !== resourceKey) ||
          (sandboxId !== agent.sandbox_id && knownIds.has(sandboxId)) || liveSandboxIds.has(sandboxId);
        if (incompatible) {
          conflict = true;
          matches.delete(sandboxId);
          result.pending.push({ ...target, sandbox_id: sandboxId, reason: 'provider_identity_mismatch' });
        } else matches.add(sandboxId);
      }
      for (const sandboxId of matches) {
        if (sandboxes.has(sandboxId) || liveSandboxIds.has(sandboxId)) continue;
        try {
          const found = await sdkOperation('verify resource ownership', () => this.sdk.sandboxes.getSandbox(sandboxId));
          const identity = found.metadata ?? {};
          if (missionMismatch(identity) || identity.agent_key !== agentKey || identity.resource_key !== resourceKey) {
            conflict = true;
            matches.delete(sandboxId);
            result.pending.push({ ...target, sandbox_id: sandboxId, reason: 'provider_identity_mismatch' });
          }
        } catch (error: any) {
          if (error?.details?.status === 404) continue;
          conflict = true;
          result.pending.push({ ...target, sandbox_id: sandboxId, reason: 'provider_identity_unconfirmed' });
        }
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
      if (matches.size > 0) this.reconciliationIds.set(agent.resource_key, matches);
      else this.reconciliationIds.delete(agent.resource_key);
      if (conflict || matches.size === 0) continue;
      let registrationFailed = false;
      for (const sandboxId of matches) {
        if (sandboxId === agent.sandbox_id || !onSandboxDiscovered) continue;
        try { await onSandboxDiscovered(agent, sandboxId); }
        catch (error: any) {
          registrationFailed = true;
          result.pending.push({ ...target, sandbox_id: sandboxId, reason: 'resource_record_unconfirmed', error_class: error?.code ?? error?.name });
        }
      }
      if (registrationFailed) continue;
      if (matches.size > 1) {
        this.logger?.({ event: 'sandbox.duplicate_create', provider: 'opensandbox', agent_id: agent.agent_id, resource_count: matches.size });
      }
      let allDeleted = true;
      for (const sandboxId of matches) {
        if (!await quarantine({ ...target, sandbox_id: sandboxId })) allDeleted = false;
      }
      if (allDeleted) {
        this.reconciliationIds.delete(agent.resource_key);
        result.confirmed_agent_ids.push(agent.agent_id);
      }
    }
    this.logger?.({ event: 'sandbox.reconciled', provider: 'opensandbox', quarantined: result.quarantined.length, pending: result.pending.length });
    return result;
  }

  async #listSandboxes(remaining: any, metadata: Record<string, string>) {
    const sandboxes = new Map<any, any>();
    for (let page = 1; ; page += 1) {
      remaining();
      const value = await sdkOperation('list', () => this.sdk.sandboxes.listSandboxes({ page, pageSize: 100, metadata }));
      const items = Array.isArray(value) ? value : (value?.items ?? value?.sandboxes);
      const pagination = value?.pagination;
      if (!Array.isArray(items) || (pagination && pagination.page !== page)) {
        throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Invalid OpenSandbox list page', { page });
      }
      for (const sandbox of items) {
        const id = sandbox?.id ?? sandbox?.sandbox_id;
        if (typeof id !== 'string' || id.length === 0 || sandboxes.has(id)) {
          throw new MurmError(ERROR_CODES.SERVICE_UNAVAILABLE, 'OpenSandbox listing changed or contained invalid IDs', { page }, { retryable: true });
        }
        sandboxes.set(id, sandbox.metadata ?? {});
      }
      if (!pagination) {
        if (items.length < 100) return sandboxes;
      } else if (pagination.hasNextPage === false) {
        return sandboxes;
      } else if (pagination.hasNextPage !== true || items.length === 0) {
        throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Invalid OpenSandbox list continuation', { page });
      }
    }
  }

  async #confirmSandboxDeletion(sandboxId: any, remaining: any) {
    try {
      await sdkOperation('delete', () => this.sdk.sandboxes.deleteSandbox(sandboxId, AbortSignal.timeout(remaining())));
    } catch (error: any) {
      if (error?.details?.status === 404) return;
      if (!error?.retryable && error?.details?.status !== 409) throw error;
    }
    remaining();
    try {
      await sdkOperation('confirm deletion', () => this.sdk.sandboxes.getSandbox(sandboxId));
    } catch (error: any) {
      if (error?.details?.status === 404) return;
      throw error;
    }
    throw new MurmError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Sandbox deletion is still pending', { sandbox_id: sandboxId }, { retryable: true });
  }

  async ensureExecution({ executionId, agentId = null, onCreateDispatch = null, onCreateRejected = null, onCreated = null, onWorkerToken,
    timeoutSeconds = 3600, projectQuotaRequired = false, cleanupOnFailure = true, workspaceRef = null, bindingVersion = null, environment = {}, metadata = {}, networkPolicy }: any = {}) {
    const id = required(executionId, 'execution_id');
    required(agentId, 'agent_id');
    const existing = this.executions.get(id);
    if (existing) {
      if (existing.preparing || existing.stopPromise) throw new MurmError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Sandbox preparation or cleanup is pending', { execution_id: id }, { retryable: true });
      return this.#snapshot(existing);
    }
    if (this.pendingCreations.has(id)) throw new MurmError(ERROR_CODES.SERVICE_UNAVAILABLE,
      'Sandbox creation or cleanup is pending', { execution_id: id }, { retryable: true });
    if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 60) {
      throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Sandbox timeout must be at least 60 seconds');
    }
    const launchBody = { ...this.environment, ...envs(environment) };
    const { mission_id: configuredMission = null, mission_key: _missionKey, agent_id: _agentId, agent_key: _agentKey,
      resource_key: _resourceKey, runtime_id: configuredRuntime = null, runtime_key: _runtimeKey, ...labels } = { ...this.metadata, ...metadata };
    const creation = { agent_id: agentId, resource_key: id, mission_id: configuredMission, runtime_id: configuredRuntime, inFlight: true, onCreated };
    const workerToken = randomUUID();
    const execdAccessToken = this.requireManagementAuth ? randomUUID() : null;
    if (projectQuotaRequired) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Exact workspace quotas require a custom Provider or supported OpenSandbox storage capability');
    const workerEntrypoint = [...this.workerCommand, '--port', String(this.workerPort)];
    this.pendingCreations.set(id, creation);
    try {
      onWorkerToken?.(workerToken);
      if (execdAccessToken) onWorkerToken?.(execdAccessToken);
      const admission = onCreateDispatch?.({ provider: 'opensandbox', timeout_seconds: timeoutSeconds });
      if (typeof admission?.then === 'function') await admission;
    } catch (error: any) {
      this.pendingCreations.delete(id);
      throw error;
    }
    const created = await sdkOperation('create', () => this.sdk.sandboxes.createSandbox({
        timeout: timeoutSeconds,
        image: { uri: this.image },
        entrypoint: workerEntrypoint,
        resourceLimits: this.resourceLimits,
        env: { ...launchBody, MURM_WORKER_TOKEN: workerToken, ...(execdAccessToken ? { EXECD_ACCESS_TOKEN: execdAccessToken } : {}) },
        ...(this.volumes.length > 0 ? { volumes: this.volumes } : {}),
        ...(networkPolicy ? { networkPolicy } : {}),
        metadata: {
          ...labels,
          ...(configuredRuntime ? { runtime_key: openSandboxRuntimeKey(configuredRuntime) } : {}),
          ...(configuredMission ? { mission_key: openSandboxMissionKey(configuredMission) } : {}),
          agent_key: openSandboxAgentKey(agentId), resource_key: openSandboxAgentKey(id),
          ...(bindingVersion === null || bindingVersion === undefined ? {} : { binding_version: String(bindingVersion) }),
        },
      }, AbortSignal.timeout(60_000))).catch(async (error: any) => {
      try {
        if ([400, 401, 403, 422].includes(error?.details?.status)) {
          await onCreateRejected?.();
          this.pendingCreations.delete(id);
        }
      } finally {
        creation.inFlight = false;
      }
      throw error;
    });
    creation.inFlight = false;
    const sandboxId = created.id;
    if (typeof sandboxId !== 'string' || sandboxId.length === 0) {
      throw new MurmError(ERROR_CODES.START_FAILED, 'OpenSandbox did not return a sandbox id', { stage: 'create' });
    }
    let execdUrl: string | null = null;
    let execdHeaders: Record<string, string> = {};
    // Retain the resource as soon as its provider ID exists. Endpoint/health
    // preparation failures must not erase responsibility for deletion.
    const record: any = { executionId: id, agentId, projectQuotaRequired, boundExecutionId: null, sandboxId, execdUrl: null, execdHeaders, bindingVersion, hostWorkspaceRef: workspaceRef, createdAt: this.now(), expiresAt: sdkExpiry(created.expiresAt), workerToken, onWorkerToken, preparing: true };
    this.executions.set(id, record);
    this.pendingCreations.delete(id);
    let registered = false;
    try {
      await onCreated?.({ ...this.#snapshot(record), expires_at: sdkExpiry(created.expiresAt) });
      registered = true;
      const endpoint = await sdkOperation('resolve Execd endpoint', () => this.sdk.sandboxes.getSandboxEndpoint(sandboxId, this.execdPort, this.useServerProxy));
      execdUrl = endpointUrl(endpoint, this.useServerProxy ? this.lifecycleBaseUrl : undefined);
      execdHeaders = endpoint.headers ?? {};
      if (!execdUrl) throw new MurmError(ERROR_CODES.START_FAILED, 'OpenSandbox did not return an Execd endpoint', { sandbox_id: sandboxId, port: this.execdPort });
      record.execdUrl = execdUrl.replace(/\/$/, '');
      record.execdHeaders = this.#dataPlaneHeaders(execdUrl, execdHeaders);
      const activeToken = record.execdHeaders['x-execd-access-token'] ?? execdAccessToken ?? this.execdToken;
      delete record.execdHeaders['x-execd-access-token'];
      if (activeToken) record.execdHeaders['X-EXECD-ACCESS-TOKEN'] = activeToken;
      for (const value of Object.values(record.execdHeaders) as string[]) onWorkerToken?.(value);
      record.execd = this.sdk.execd({ url: record.execdUrl, headers: record.execdHeaders });
      if (this.waitForExecdReady) await this.#waitExecd(record);
      if (this.requireManagementAuth) await this.#checkExecdAuthentication(record);
      if (networkPolicy && this.egressMode === 'dns+nft') await this.#verifyEgressPolicy(record, networkPolicy);
    } catch (error: any) {
      if (registered && cleanupOnFailure) await this.stopExecution(id).catch((cleanupError: any) => {
        this.logger?.({ event: 'sandbox.prepare_cleanup_error', provider: 'opensandbox', execution_id: id, sandbox_id: sandboxId, error_class: cleanupError?.code ?? cleanupError?.name });
      });
      throw error;
    }
    record.preparing = false;
    if (this.executions.get(id) !== record || record.stopPromise) throw new MurmError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Sandbox was stopped during preparation', { execution_id: id }, { retryable: true });
    this.logger?.({ event: 'sandbox.started', provider: 'opensandbox', execution_id: id, sandbox_id: sandboxId, binding_version: bindingVersion });
    return this.#snapshot(record);
  }

  async renewExecution(executionId: string, minimumExpiresAtMs: number) {
    if (!Number.isFinite(minimumExpiresAtMs) || minimumExpiresAtMs <= this.now()) {
      throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Lease minimum expiry must be a future timestamp');
    }
    const record = this.#record(executionId);
    if (record.stopPromise) throw new MurmError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Sandbox deletion is pending', {}, { retryable: true });
    const previous = record.renewPromise ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      const current = await sdkOperation('observe lease', () => this.sdk.sandboxes.getSandbox(record.sandboxId));
      record.expiresAt = sdkExpiry(current.expiresAt);
      const observed = record.expiresAt ? Date.parse(record.expiresAt) : Number.NaN;
      if (!Number.isFinite(observed)) throw new MurmError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Sandbox did not report a finite expiry', {}, { retryable: true });
      if (observed < minimumExpiresAtMs) {
        let renewalError: unknown;
        try {
          await sdkOperation('renew lease', () => this.sdk.sandboxes.renewSandboxExpiration(record.sandboxId, { expiresAt: new Date(minimumExpiresAtMs).toISOString() }));
        } catch (error) { renewalError = error; }
        const confirmed = await sdkOperation('confirm lease', () => this.sdk.sandboxes.getSandbox(record.sandboxId));
        record.expiresAt = sdkExpiry(confirmed.expiresAt);
        if (!record.expiresAt || Date.parse(record.expiresAt) < minimumExpiresAtMs) {
          if (renewalError) throw renewalError;
          throw new MurmError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Sandbox lease extension could not be confirmed', { expires_at: record.expiresAt }, { retryable: true });
        }
      }
      return { sandboxId: record.sandboxId, expiresAt: record.expiresAt };
    });
    record.renewPromise = operation;
    try { return await operation; }
    finally { if (record.renewPromise === operation) record.renewPromise = null; }
  }

  bindAgentExecution({ agentId, executionId, bindingVersion = null, workspaceRef = null }: any) {
    const record: any = this.#record(agentId);
    if (record.agentId !== agentId || record.preparing || record.stopPromise) {
      throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Agent Sandbox is not ready for binding');
    }
    required(executionId, 'execution_id');
    if ((record.boundExecutionId && record.boundExecutionId !== executionId) ||
        (this.executions.has(executionId) && this.executions.get(executionId) !== record)) {
      throw new MurmError(ERROR_CODES.CONFLICT, 'Agent Sandbox is already bound');
    }
    record.boundExecutionId = executionId;
    record.bindingVersion = bindingVersion;
    record.hostWorkspaceRef = workspaceRef;
    this.executions.set(executionId, record);
    return this.#snapshot(record);
  }

  async exec({ executionId, command: value, cwd = '/workspace', timeoutMs = this.commandTimeoutMs, env = {}, internalEnvironment = {} }: any = {}) {
    const record = this.#record(executionId);
    const normalizedTimeout = timeout(timeoutMs);
    const normalized = command(value);
    const commandText = normalized.command ?? normalized.argv.map(shellQuote).join(' ');
    const environment = { ...envs(env), ...envs(internalEnvironment, { allowSecrets: true }) };
    const workingDirectory = underWorkspace(cwd);
    const startedAt = this.now();
    const deadline = AbortSignal.timeout(normalizedTimeout + 10_000);
    const commands = record.execd.commands;
    let stdout = '';
    let stderr = '';
    let truncated = false;
    const append = (current: string, text: string) => {
      const [next, overflow] = appendOutput(current, text, this.maxOutputBytes);
      truncated ||= overflow;
      return next;
    };
    const handlers = {
      skipAccumulation: true,
      onStdout: (message: { text: string }) => { stdout = append(stdout, message.text); },
      onStderr: (message: { text: string }) => { stderr = append(stderr, message.text); },
    };
    let sessionId: string | undefined;
    try {
      if (this.foregroundSession) {
        try { sessionId = await sdkOperation('create command session', () => commands.createSession({ workingDirectory })); }
        catch (error: any) { if (error?.details?.status !== 404) throw error; }
      }
      const result: any = await sdkOperation('execute command', () => sessionId
        ? commands.runInSession(sessionId, Object.keys(environment).length
          ? ['env', ...Object.entries(environment).map(([key, value]) => shellQuote(`${key}=${value}`)), 'sh', '-c', shellQuote(commandText)].join(' ')
          : commandText, { workingDirectory, timeoutSeconds: normalizedTimeout / 1000 }, handlers, deadline)
        : commands.run(commandText, { workingDirectory, timeoutSeconds: normalizedTimeout / 1000, envs: environment }, handlers, deadline));
      const timedOut = /timeout/i.test(result.error?.value ?? '');
      const receipt = { execution_id: executionId, job_id: result.id ?? sessionId ?? randomUUID(),
        binding_version: record.bindingVersion, exit_code: result.exitCode ?? (result.complete && !result.error ? 0 : null),
        timed_out: timedOut, truncated, duration_ms: this.now() - startedAt, stdout, stderr };
      this.logger?.({ event: 'sandbox.exec', provider: 'opensandbox', execution_id: executionId,
        job_id: receipt.job_id, exit_code: receipt.exit_code, timed_out: timedOut, duration_ms: receipt.duration_ms });
      return receipt;
    } catch (error) {
      if (sessionId && deadline.aborted) await commands.interrupt(sessionId).catch(() => undefined);
      throw error;
    } finally {
      if (sessionId) await commands.deleteSession(sessionId).catch(() => undefined);
    }
  }

  startAgent(...args: Parameters<WorkerClient['startAgent']>) { return this.worker.startAgent(...args); }
  syncWorkspace(...args: Parameters<WorkerClient['syncWorkspace']>) { return this.worker.syncWorkspace(...args); }
  prepareAgentProject(...args: Parameters<WorkerClient['prepareAgentProject']>) { return this.worker.prepareAgentProject(...args); }
  grantAgentProject(...args: Parameters<WorkerClient['grantAgentProject']>) { return this.worker.grantAgentProject(...args); }
  coreSessionSnapshot(...args: Parameters<WorkerClient['coreSessionSnapshot']>) { return this.worker.coreSessionSnapshot(...args); }
  coreFileOperation(...args: Parameters<WorkerClient['coreFileOperation']>) { return this.worker.coreFileOperation(...args); }
  snapshotAgentProject(...args: Parameters<WorkerClient['snapshotAgentProject']>) { return this.worker.snapshotAgentProject(...args); }
  installAgentProject(...args: Parameters<WorkerClient['installAgentProject']>) { return this.worker.installAgentProject(...args); }
  queryAgentProjectInstall(...args: Parameters<WorkerClient['queryAgentProjectInstall']>) { return this.worker.queryAgentProjectInstall(...args); }
  forgetAgentProjectInstalls(...args: Parameters<WorkerClient['forgetAgentProjectInstalls']>) { return this.worker.forgetAgentProjectInstalls(...args); }
  confirmAgentProjectInstall(...args: Parameters<WorkerClient['confirmAgentProjectInstall']>) { return this.worker.confirmAgentProjectInstall(...args); }
  agentRpc(...args: Parameters<WorkerClient['agentRpc']>) { return this.worker.agentRpc(...args); }
  stopAgent(...args: Parameters<WorkerClient['stopAgent']>) { return this.worker.stopAgent(...args); }
  collectCoreFiles(...args: Parameters<WorkerClient['collectCoreFiles']>) { return this.worker.collectCoreFiles(...args); }
  collectCoreSession(...args: Parameters<WorkerClient['collectCoreSession']>) { return this.worker.collectCoreSession(...args); }

  /**
   * Resolve executable versions in the provider guest. The controller may not
   * have the selected executor or the image's Node installation, so manifest evidence
   * must never silently describe the host process.
   */
  async agentVersions({ executionId, executor = 'pi', piCommand = 'pi', nodeCommand = 'node', externalExecutor = false, timeoutMs = 15_000 }: any = {}) {
    this.#record(executionId);
    const versions: Record<string, any> = {};
    if (!externalExecutor && executor !== 'pi' && executor !== 'codex') {
      throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'unknown Agent executor');
    }
    const commands = [
      ...(externalExecutor ? [] : [executor === 'codex' ? ['codexVersion', 'codex', 'codex'] : ['piVersion', 'pi', piCommand]]),
      ['nodeVersion', 'node', nodeCommand],
    ];
    for (const [field, commandName, command] of commands) {
      if (typeof command !== 'string' || command.length === 0) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, `${commandName} command is required`);
      const result: any = await this.exec({ executionId, command: [command, '--version'], cwd: '/workspace', timeoutMs });
      if (result.exit_code !== 0) throw new MurmError(ERROR_CODES.START_FAILED, `${commandName} --version failed inside OpenSandbox`, { command: commandName, exit_code: result.exit_code, diagnostic: safeDiagnostic(result.stderr) });
      versions[field] = exactCommandVersion(`${result.stdout}\n${result.stderr}`, commandName);
    }
    return versions;
  }

  coreResource(executionId: any) {
    const record: any = this.executions.get(executionId);
    const creation = this.pendingCreations.get(executionId);
    return { resourceKey: record?.executionId ?? creation?.resource_key ?? executionId,
      ...(record?.sandboxId || creation?.sandbox_id ? { sandboxId: record?.sandboxId ?? creation.sandbox_id } : {}),
      expiresAt: record?.expiresAt ?? null,
      creation: record ? 'created' : creation ? 'pending' : 'absent',
      executionStopped: record?.executionStopped === true };
  }

  async stopExecution(executionId: any) {
    const record: any = this.executions.get(executionId);
    if (!record) {
      const creation = this.pendingCreations.get(executionId);
      if (!creation) return false;
      if (creation.inFlight) throw new MurmError(ERROR_CODES.SERVICE_UNAVAILABLE,
        'Sandbox creation is still pending', { execution_id: executionId }, { retryable: true });
      if (!creation.stopPromise) creation.stopPromise = this.#releaseUnknownCreation(creation).finally(() => { creation.stopPromise = null; });
      return creation.stopPromise;
    }
    if (record.stopPromise) return record.stopPromise;
    const stopping = this.#deleteExecution(executionId, record).finally(() => { record.stopPromise = null; });
    record.stopPromise = stopping;
    return stopping;
  }

  async #deleteExecution(executionId: any, record: any) {
    if (record.coreAgent) {
      if (!await this.stopAgent(executionId, 'SIGTERM', { preserveWorker: true })) {
        throw new MurmError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Core deletion requires confirmed execution stop');
      }
    }
    else await this.stopAgent(executionId).catch(() => undefined);
    const deadline = Date.now() + 30_000;
    await this.#confirmSandboxDeletion(record.sandboxId, () => Math.max(1, deadline - Date.now()));
    for (const [key, resource] of this.executions) if (resource === record) this.executions.delete(key);
    this.logger?.({ event: 'sandbox.stopped', provider: 'opensandbox', execution_id: executionId, sandbox_id: record.sandboxId });
    return true;
  }

  async #releaseUnknownCreation(creation: any) {
    const result: any = await this.#reconcileExecutions({ missionId: creation.mission_id, runtimeId: creation.runtime_id, agents: [creation],
      onSandboxDiscovered: async (agent: any, sandboxId: any) => {
        await agent.onCreated?.({ provider: 'opensandbox', agent_id: agent.agent_id, resource_key: agent.resource_key, sandbox_id: sandboxId });
        agent.sandbox_id = sandboxId;
      } }, creation);
    if (!result.confirmed_agent_ids.includes(creation.agent_id)) {
      throw new MurmError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Sandbox creation or deletion cannot be confirmed',
        { agent_id: creation.agent_id, resource_key: creation.resource_key }, { retryable: true });
    }
    this.pendingCreations.delete(creation.resource_key);
    return true;
  }

  async stopAll() {
    for (const id of new Set([...this.executions.keys(), ...this.pendingCreations.keys()])) await this.stopExecution(id);
    await this.sdk.close();
  }

  close() { return this.sdk.close(); }

  snapshot() { return { provider: 'opensandbox', lifecycle_url: this.lifecycleBaseUrl, image: this.image, verified: this.verified, executions: [...new Set(this.executions.values())].map((record: any) => this.#snapshot(record)) }; }

  #snapshot(record: any) { return { execution_id: record.boundExecutionId, agent_id: record.agentId, resource_key: record.executionId, sandbox_id: record.sandboxId, expires_at: record.expiresAt ?? null, binding_version: record.bindingVersion, workspace: '/workspace/project', host_workspace_ref: null, agent_worker: record.agent ? { worker_port: record.agent.worker_port, started_at: record.agent.started_at } : null }; }
  #record(executionId: any) { const record: any = this.executions.get(executionId); if (!record) throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'sandbox is not bound to this Execution', { execution_id: executionId }); return record; }

  async #waitExecd(record: any) {
    const deadline = Date.now() + this.execdReadyTimeoutMs;
    while (Date.now() < deadline) {
      try {
        if (await record.execd.health.ping(AbortSignal.timeout(Math.min(3000, deadline - Date.now())))) return;
      } catch { /* Execd is still starting. */ }
      await new Promise<void>(resolve => setTimeout(resolve, 100));
    }
    throw new MurmError(ERROR_CODES.START_FAILED, 'OpenSandbox Execd did not become ready',
      { endpoint: safeUrl(record.execdUrl), timeout_ms: this.execdReadyTimeoutMs }, { retryable: true });
  }

  async #verifyEgressPolicy(record: any, expected: { egress?: { target: string; ports?: number[] }[] }) {
    const endpoint = await sdkOperation('resolve egress endpoint',
      () => this.sdk.sandboxes.getSandboxEndpoint(record.sandboxId, DEFAULT_EGRESS_PORT, this.useServerProxy));
    const url = endpointUrl(endpoint, this.useServerProxy ? this.lifecycleBaseUrl : undefined);
    if (!url) throw new MurmError(ERROR_CODES.START_FAILED, 'OpenSandbox did not return an egress endpoint');
    const headers = this.#associatedEndpointHeaders(record, url, endpoint.headers, DEFAULT_EGRESS_PORT);
    for (const value of Object.values(headers)) record.onWorkerToken?.(value);
    const state = await sdkOperation('observe egress policy', () => this.sdk.readEgressPolicy({ url, headers }));
    const targets = (rules: readonly { target?: string; ports?: number[] }[]) =>
      new Set(rules.flatMap(rule => rule.ports?.length ? rule.ports.map(port => `${rule.target}:${port}`) : [rule.target]));
    const requested = targets(expected.egress ?? []);
    const observed = targets((state?.policy?.egress ?? []).filter(rule => rule.action === 'allow'));
    if (state?.status !== 'ok' || state.enforcementMode !== 'dns+nft' || state.policy?.defaultAction !== 'deny' ||
        requested.size !== observed.size || [...requested].some(target => !observed.has(target))) {
      throw new MurmError(ERROR_CODES.START_FAILED, 'OpenSandbox did not confirm the requested dns+nft allowlist',
        { stage: 'egress_policy', enforcement_mode: state?.enforcementMode === 'dns' ? 'dns' : 'unconfirmed' });
    }
  }

  async #workerEndpoint(record: any) {
    const info = await sdkOperation('resolve Worker endpoint', () => this.sdk.sandboxes.getSandboxEndpoint(record.sandboxId, this.workerPort, this.useServerProxy));
    const url = endpointUrl(info, this.useServerProxy ? this.lifecycleBaseUrl : undefined);
    if (!url) throw new MurmError(ERROR_CODES.START_FAILED, 'OpenSandbox did not return the Agent Worker endpoint', { sandbox_id: record.sandboxId });
    return { url, headers: this.#associatedEndpointHeaders(record, url, info.headers, this.workerPort) };
  }

  #associatedEndpointHeaders(record: any, url: string, upstreamHeaders: Record<string, string> | undefined, port: number) {
    const headers = this.#dataPlaneHeaders(url, upstreamHeaders);
    const execdProxy = record.execdUrl.endsWith(`/proxy/${this.execdPort}`) &&
      url === record.execdUrl.slice(0, -String(this.execdPort).length) + port;
    if (execdProxy && record.execdHeaders['X-EXECD-ACCESS-TOKEN']) headers['x-execd-access-token'] = record.execdHeaders['X-EXECD-ACCESS-TOKEN'];
    return headers;
  }

  /** Deliberately unauthenticated probes are outside the authenticated SDK service interfaces. */
  #probeManagementAuthentication(path: string, options: any = {}) {
    return this.worker.request(options.absolute ? path : `${this.lifecycleBaseUrl}${path}`, options);
  }

  #dataPlaneHeaders(endpoint: string, headers?: Record<string, string>) {
    const result = Object.fromEntries(new Headers(headers).entries());
    const lifecycle = new URL(this.lifecycleBaseUrl);
    const destination = new URL(endpoint);
    if (this.useServerProxy && destination.origin === lifecycle.origin &&
        destination.pathname.startsWith(`${lifecycle.pathname.replace(/\/$/, '')}/sandboxes/`) && this.apiKey) {
      result['open-sandbox-api-key'] = this.apiKey;
    }
    return result;
  }

  async #checkAgentBoundary(executionId: string) {
    // Run before any task code or model interaction, without passing credentials
    // to the UID that will run the executor. Only a fixed verdict leaves the guest.
    const guestProbe = `
      const fs = require('node:fs');
      const assert = require('node:assert/strict');
      const status = fs.readFileSync('/proc/self/status', 'utf8');
      assert.equal(process.getuid(), 10001);
      assert.match(status, /^NoNewPrivs:\\s+1$/m);
      for (const name of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) {
        assert.match(status, new RegExp('^' + name + ':\\\\s+0+$', 'm'));
      }
      const secretName = /(?:EXECD_ACCESS_TOKEN|MURM_WORKER_TOKEN|OPEN_SANDBOX_API_KEY|OPENSANDBOX_SERVER_API_KEY)=/;
      for (const key of Object.keys(process.env)) assert.ok(!secretName.test(key + '='));
      for (const entry of fs.readdirSync('/proc').filter(entry => /^\\d+$/.test(entry))) {
        for (const file of ['environ', 'cmdline']) {
          try {
            assert.ok(!secretName.test(fs.readFileSync('/proc/' + entry + '/' + file, 'utf8')));
          } catch (error) {
            if (!['EACCES', 'EPERM', 'ENOENT', 'ESRCH'].includes(error.code)) throw error;
          }
        }
      }
      assert.ok(!fs.existsSync('/var/run/docker.sock') && !fs.existsSync('/run/docker.sock'));
      const read = path => {
        try { return fs.readFileSync('/sys/fs/cgroup/' + path, 'utf8').trim(); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      };
      const cpuMax = read('cpu.max')?.split(' ') ?? [
        read('cpu/cpu.cfs_quota_us') ?? read('cpu,cpuacct/cpu.cfs_quota_us'),
        read('cpu/cpu.cfs_period_us') ?? read('cpu,cpuacct/cpu.cfs_period_us'),
      ];
      const cpu = Number(cpuMax[0]) / Number(cpuMax[1]);
      const memory = Number(read('memory.max') ?? read('memory/memory.limit_in_bytes'));
      const urls = [
        ['http://127.0.0.1:${this.execdPort}/command', 'POST'],
        ['http://127.0.0.1:${this.execdPort}/files/info', 'GET'],
        ['http://127.0.0.1:${this.execdPort}/session', 'POST'],
        ['http://127.0.0.1:${this.execdPort}/proxy/${this.workerPort}/core/contract', 'GET'],
        ['http://127.0.0.1:${this.workerPort}/core/contract', 'GET'],
      ];
      Promise.all(urls.map(async ([url, method]) => {
        const response = await fetch(url, { method, signal: AbortSignal.timeout(3000), redirect: 'error',
          ...(method === 'POST' ? { body: '{}', headers: { 'content-type': 'application/json' } } : {}) });
        await response.body?.cancel();
        assert.ok([401, 403].includes(response.status));
      })).then(() => console.log(JSON.stringify({ cpu, memory })), () => { process.exitCode = 1; });
    `;
    const result = await this.exec({ executionId, timeoutMs: 8000, command: [
      'setpriv', '--reuid', '10001', '--regid', '10001', '--clear-groups', '--no-new-privs',
      '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all', '--', 'env', '-i',
      'PATH=/usr/local/bin:/usr/bin:/bin', 'node', '-e', guestProbe,
    ] }).catch(() => undefined);
    if (result?.exit_code !== 0) {
      throw new MurmError(ERROR_CODES.AGENT_STARTUP_CONTRACT, 'Sandbox did not confirm management isolation from the Linux Agent UID');
    }
    const effective = jsonData(result.stdout.trim());
    const cpu = Number.parseFloat(this.resourceLimits.cpu) / (this.resourceLimits.cpu.endsWith('m') ? 1000 : 1);
    const [, amount, suffix = ''] = /^(\d+)([kmgt](?:i|b)?|b)?$/i.exec(this.resourceLimits.memory) ?? [];
    const exponent = ['', 'k', 'm', 'g', 't'].indexOf(suffix.toLowerCase().replace(/[ib]$/, ''));
    const memory = Number(amount) * (suffix.toLowerCase().endsWith('i') ? 1024 : 1000) ** exponent;
    if (!(effective?.cpu > 0 && effective.cpu <= cpu) || !(effective?.memory > 0 && effective.memory <= memory)) {
      throw new MurmError(ERROR_CODES.AGENT_STARTUP_CONTRACT, 'Sandbox did not enforce the requested CPU and memory cgroup limits');
    }
    return { cpu: effective.cpu as number, memoryBytes: effective.memory as number, managementAuthentication: true };
  }

  async #checkExecdAuthentication(record: any) {
    const headers = new Headers(record.execdHeaders);
    headers.delete('x-execd-access-token');
    await Promise.all([
      ['/command', 'POST'], ['/files/info', 'GET'], ['/session', 'POST'],
    ].map(async ([path, method]) => {
      const response = await this.#probeManagementAuthentication(`${record.execdUrl}${path}`, {
        absolute: true, method, extraHeaders: Object.fromEntries(headers), timeoutMs: 5000,
        ...(method === 'POST' ? { body: {} } : {}), allowStatuses: [401, 403],
      }).catch(() => undefined);
      if (!response || ![401, 403].includes(response.status)) {
        throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'OpenSandbox Execd management authentication could not be confirmed');
      }
    }));
  }


}

export function createOpenSandboxManager(options: any = {}) { return new OpenSandboxManager(options); }

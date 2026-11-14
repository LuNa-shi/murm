import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { ERROR_CODES, SwarmEnvError } from '../errors.js';

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
    this.verified = null;
  }

  async preflight({ timeoutMs = 20_000 } = {}) {
    const response = await this.#request('/sandboxes?pageSize=1', { method: 'GET', timeoutMs });
    this.verified = { lifecycle_url: this.lifecycleBaseUrl, provider: 'opensandbox', verified_at: this.now(), status: response.status };
    this.logger?.({ event: 'sandbox.provider_preflight', provider: 'opensandbox', lifecycle_url: this.lifecycleBaseUrl });
    return { ...this.verified, ok: true };
  }

  async reconcileExecutions({ executionIds = [], timeoutMs = 30_000 } = {}) {
    const allowed = new Set(executionIds.filter((id) => typeof id === 'string' && id.length > 0));
    const response = await this.#request('/sandboxes?pageSize=100', { method: 'GET', timeoutMs });
    const value = responseValue(response.body);
    const sandboxes = Array.isArray(value) ? value : (value?.items ?? value?.sandboxes ?? []);
    const adopted = [];
    const quarantined = [];
    for (const sandbox of sandboxes) {
      const metadata = sandbox?.metadata ?? {};
      const executionId = metadata.execution_id ?? metadata.executionId;
      if (!allowed.has(executionId) || this.executions.has(executionId)) continue;
      const sandboxId = sandbox.id ?? sandbox.sandbox_id;
      if (!sandboxId) continue;
      const endpointResponse = await this.#request(`/sandboxes/${encodeURIComponent(sandboxId)}/endpoints/${this.execdPort}`, { method: 'GET', timeoutMs });
      const execdUrl = endpointForHost(responseValue(endpointResponse.body), this.endpointHost);
      if (!execdUrl) continue;
      // A controller restart cannot recover the per-Execution worker token
      // from provider state. Do not present an adopted Execd record as a
      // usable Agent: quarantine the orphaned sandbox and let the next clean
      // Execution resume from public Workspace/Material state.
      quarantined.push({ execution_id: executionId, sandbox_id: sandboxId, execd_url: execdUrl.replace(/\/$/, '') });
      this.logger?.({ event: 'sandbox.worker_unrecoverable', provider: 'opensandbox', execution_id: executionId, sandbox_id: sandboxId });
      await this.#request(`/sandboxes/${encodeURIComponent(sandboxId)}`, { method: 'DELETE', timeoutMs, allowStatuses: [404] }).then(() => {
        this.logger?.({ event: 'sandbox.quarantined', provider: 'opensandbox', execution_id: executionId, sandbox_id: sandboxId });
      }).catch((error) => {
        this.logger?.({ event: 'sandbox.quarantine_error', provider: 'opensandbox', execution_id: executionId, sandbox_id: sandboxId, error_class: error?.code ?? error?.name });
      });
    }
    this.logger?.({ event: 'sandbox.reconciled', provider: 'opensandbox', requested: allowed.size, adopted: adopted.length, quarantined: quarantined.length });
    return { provider: 'opensandbox', adopted, quarantined };
  }

  async ensureExecution({ executionId, botId = null, onCreated = null, workspaceRef = null, bindingVersion = null, environment = {}, metadata = {} } = {}) {
    const id = required(executionId, 'execution_id');
    const existing = this.executions.get(id);
    if (existing) {
      if (existing.preparing || existing.stopPromise) throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Sandbox preparation or cleanup is pending', { execution_id: id }, { retryable: true });
      return this.#snapshot(existing);
    }
    const workerToken = randomUUID();
    const workerEntrypoint = [...this.workerCommand, '--port', String(this.workerPort)];
    const response = await this.#request('/sandboxes', {
      method: 'POST',
      body: {
        image: { uri: this.image },
        entrypoint: workerEntrypoint,
        resourceLimits: this.resourceLimits,
        env: { ...this.environment, ...envs(environment), SWARMENV_WORKER_TOKEN: workerToken },
        ...(this.volumes.length > 0 ? { volumes: this.volumes } : {}),
        metadata: {
          ...this.metadata,
          ...metadata,
          ...(botId ? { bot_id: botId, resource_key: id } : { execution_id: id }),
          ...(bindingVersion === null || bindingVersion === undefined ? {} : { binding_version: String(bindingVersion) }),
        },
      },
      timeoutMs: 60_000,
    });
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
    const record = { executionId: id, botId, boundExecutionId: null, sandboxId, execdUrl: null, execdHeaders, bindingVersion, hostWorkspaceRef: workspaceRef, createdAt: this.now(), jobs: new Map(), workerToken, preparing: true };
    this.executions.set(id, record);
    try {
      await onCreated?.(this.#snapshot(record));
      if (!execdUrl) {
        const endpointResponse = await this.#request(`/sandboxes/${encodeURIComponent(sandboxId)}/endpoints/${this.execdPort}`, { method: 'GET', timeoutMs: 30_000 });
        const endpoint = responseValue(endpointResponse.body);
        execdUrl = endpointForHost(endpoint, this.endpointHost);
        execdHeaders = endpoint?.headers ?? {};
      }
      if (!execdUrl) throw new SwarmEnvError(ERROR_CODES.START_FAILED, 'OpenSandbox did not return an Execd endpoint', { sandbox_id: sandboxId, port: this.execdPort });
    } catch (error) {
      await this.stopExecution(id).catch((cleanupError) => {
        this.logger?.({ event: 'sandbox.prepare_cleanup_error', provider: 'opensandbox', execution_id: id, sandbox_id: sandboxId, error_class: cleanupError?.code ?? cleanupError?.name });
      });
      throw error;
    }
    record.execdUrl = execdUrl.replace(/\/$/, '');
    record.execdHeaders = execdHeaders;
    try {
      if (this.waitForExecdReady) await this.#waitExecd(record);
    } catch (error) {
      await this.stopExecution(id).catch(() => undefined);
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

  async exec({ executionId, command: value, cwd = '/workspace', timeoutMs = this.commandTimeoutMs, env = {}, internalEnvironment = {}, background = false } = {}) {
    const record = this.#record(executionId);
    const normalizedTimeout = timeout(timeoutMs);
    if (!background && this.foregroundSession) {
      const sessionResult = await this.#execInSession(record, executionId, value, cwd, normalizedTimeout, env, internalEnvironment);
      if (sessionResult) return sessionResult;
    }
    const payload = { ...command(value), cwd: underWorkspace(cwd), timeout: normalizedTimeout, background, envs: { ...envs(env), ...envs(internalEnvironment, { allowSecrets: true }) } };
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
          body: { command: value.map(shellQuote).join(' '), cwd: underWorkspace(cwd), timeout: normalizedTimeout, background, envs: { ...envs(env), ...envs(internalEnvironment, { allowSecrets: true }) } },
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
    const result = this.#commandResult(events, response.body, { background, startedAt });
    const job = { jobId: result.job_id, executionId, sandboxId: record.sandboxId, state: result.state, command: value, started_at: startedAt, finished_at: this.now(), exit_code: result.exit_code, timed_out: result.timed_out, truncated: result.truncated };
    if (job.jobId) record.jobs.set(job.jobId, job);
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
      const result = this.#commandResult(events, response.body, { background: false, startedAt });
      const job = { jobId: result.job_id ?? sessionId, executionId, sandboxId: record.sandboxId, state: result.state, command: value, started_at: startedAt, finished_at: this.now(), exit_code: result.exit_code, timed_out: result.timed_out, truncated: result.truncated };
      record.jobs.set(job.jobId, job);
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

  async startAgent({ executionId, command: agentCommand, args = [], cwd = '/workspace', env = {}, secretEnvironment = {}, sessionDir = '/workspace/.swarm/pi-session', systemPrompt = null, systemPromptPath = null } = {}) {
    const record = this.#record(executionId);
    if (record.agent) return { ...record.agent };
    const workerToken = record.workerToken;
    if (typeof workerToken !== 'string' || workerToken.length === 0) throw new SwarmEnvError(ERROR_CODES.START_FAILED, 'OpenSandbox worker token is unavailable for this Execution');
    let endpoint = endpointForHost((await this.#request(`/sandboxes/${encodeURIComponent(record.sandboxId)}/endpoints/${this.workerPort}`, { method: 'GET', timeoutMs: 30_000 })).body, this.endpointHost);
    if (!endpoint) throw new SwarmEnvError(ERROR_CODES.START_FAILED, 'OpenSandbox did not return the Agent worker endpoint', { sandbox_id: record.sandboxId, port: this.workerPort });
    endpoint = endpoint.replace(/\/$/, '');
    const workerHeaders = { authorization: `Bearer ${workerToken}` };
    await this.#waitWorker(endpoint, workerHeaders);
    await this.#request(`${endpoint}/start`, {
      absolute: true,
      method: 'POST',
      extraHeaders: workerHeaders,
      body: {
        command: required(agentCommand, 'agent_command'),
        args,
        cwd,
        env: envs(env),
        // Explicitly supplied secret values travel only over the authenticated
        // worker channel and are never included in a manager snapshot/log.
        secret_env: envs(secretEnvironment, { allowSecrets: true }),
        session_dir: sessionDir,
        system_prompt: systemPrompt,
        system_prompt_path: systemPromptPath,
      },
      timeoutMs: 30_000,
    });
    record.agent = { endpoint, token: workerToken, worker_port: this.workerPort, started_at: this.now() };
    this.logger?.({ event: 'sandbox.agent_started', provider: 'opensandbox', execution_id: executionId, sandbox_id: record.sandboxId, worker_port: this.workerPort });
    return { ...record.agent };
  }

  /**
   * Resolve executable versions in the provider guest. The controller may not
   * have Pi, NuRouter or the image's Node installation, so manifest evidence
   * must never silently describe the host process.
   */
  async agentVersions({ executionId, piCommand = 'pi', nurouterCommand = 'nurouter', nodeCommand = 'node', includeNurouter = true, timeoutMs = 15_000 } = {}) {
    this.#record(executionId);
    const versions = {};
    const commands = [
      ['piVersion', 'pi', piCommand],
      ...(includeNurouter ? [['nurouterVersion', 'nurouter', nurouterCommand]] : []),
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

  async syncWorkspace({ executionId, workspaceRef, maxFileBytes = 2 * 1024 * 1024, maxTotalBytes = 16 * 1024 * 1024 } = {}) {
    const record = this.#record(executionId);
    if (typeof workspaceRef !== 'string' || workspaceRef.length === 0) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'workspaceRef is required to initialize the provider Workspace');
    const root = workspaceRef;
    const files = [];
    async function walk(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name === '.git' || entry.name === '.swarm' || entry.name === 'node_modules' || entry.name.startsWith('.env')) continue;
        const source = join(directory, entry.name);
        if (entry.isDirectory()) await walk(source);
        else if (entry.isFile()) files.push(source);
      }
    }
    await walk(root).catch((error) => { throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, `could not read initial Workspace: ${error.message}`, undefined, { cause: error }); });
    let total = 0;
    for (const source of files) {
      const content = await readFile(source);
      if (content.length > maxFileBytes || total + content.length > maxTotalBytes) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'initial Workspace exceeds provider sync bounds', { max_file_bytes: maxFileBytes, max_total_bytes: maxTotalBytes });
      total += content.length;
      const target = `/workspace/${relative(root, source).split('\\').join('/')}`;
      const encoded = content.toString('base64');
      const copied = await this.exec({ executionId, command: ['sh', '-lc', `mkdir -p ${shellQuote(join(target, '..'))} && printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(target)}`], timeoutMs: this.commandTimeoutMs });
      if (copied.exit_code !== 0 || copied.timed_out) throw new SwarmEnvError(ERROR_CODES.START_FAILED, 'Bot Workspace input copy failed', { execution_id: executionId, path: relative(root, source), exit_code: copied.exit_code });
    }
    this.logger?.({ event: 'sandbox.workspace_initialized', provider: 'opensandbox', execution_id: executionId, file_count: files.length, bytes: total });
    return { execution_id: executionId, file_count: files.length, bytes: total, workspace: '/workspace' };
  }

  /** Pull guest files back before Runtime checkpoints or deletes the sandbox. */
  async syncWorkspaceBack({ executionId, workspaceRef, maxFileBytes = 2 * 1024 * 1024, maxTotalBytes = 16 * 1024 * 1024 } = {}) {
    if (typeof workspaceRef !== 'string' || workspaceRef.length === 0) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'workspaceRef is required to persist provider Workspace');
    // Cleanup paths can race when Runtime handles both a provider transport
    // failure and the corresponding Session close. Once stopExecution removed
    // the manager record there is no guest Workspace left to pull, so make the
    // persistence operation idempotent instead of reporting a second failure.
    const record = this.executions.get(executionId);
    if (!record) return { execution_id: executionId, file_count: 0, bytes: 0, workspace: resolve(workspaceRef), skipped: true };
    const listing = await this.exec({ executionId, command: ['sh', '-lc', "find /workspace -type f -not -path '/workspace/.swarm/*' -not -path '/workspace/.git/*' -not -name '.env' -not -name '.env.*' -print0"], timeoutMs: this.commandTimeoutMs });
    if (listing.exit_code !== 0) throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'could not list provider Workspace files', { exit_code: listing.exit_code, diagnostic: safeDiagnostic(listing.stderr) }, { retryable: true });
    // NUL delimiters survive Execd's line-oriented JSON stream; newline-only
    // output can be coalesced by older images and would merge adjacent paths.
    const paths = listing.stdout.split(/\0|\r?\n/).map((value) => value.trim()).filter(Boolean);
    let total = 0;
    let count = 0;
    const root = resolve(workspaceRef);
    for (const guestPath of paths) {
      if (!guestPath.startsWith('/workspace/') || guestPath.split('/').includes('..')) continue;
      const relativePath = guestPath.slice('/workspace/'.length);
      const target = resolve(root, relativePath);
      const relation = relative(root, target);
      if (relation.startsWith('..') || relation.includes('/') && relation.split('/').includes('..')) continue;
      const existing = await lstat(target).catch(() => null);
      if (existing?.isSymbolicLink()) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'provider Workspace cannot overwrite a host symlink', { path: relativePath });
      let ancestor = root;
      for (const segment of relativePath.split('/').slice(0, -1)) {
        ancestor = join(ancestor, segment);
        const ancestorStat = await lstat(ancestor).catch(() => null);
        if (ancestorStat?.isSymbolicLink()) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'provider Workspace cannot traverse a host symlink', { path: relativePath });
      }
      const result = await this.exec({ executionId, command: ['sh', '-lc', `base64 ${shellQuote(guestPath)}`], timeoutMs: this.commandTimeoutMs });
      if (result.exit_code !== 0) throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'could not read provider Workspace file', { path: relativePath, exit_code: result.exit_code }, { retryable: true });
      const content = Buffer.from(result.stdout.replace(/\s+/g, ''), 'base64');
      if (content.length > maxFileBytes || total + content.length > maxTotalBytes) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'provider Workspace exceeds pull bounds', { max_file_bytes: maxFileBytes, max_total_bytes: maxTotalBytes });
      await mkdir(resolve(root, relativePath, '..'), { recursive: true });
      await writeFile(target, content, { mode: 0o600 });
      total += content.length;
      count += 1;
    }
    this.logger?.({ event: 'sandbox.workspace_pulled', provider: 'opensandbox', execution_id: executionId, file_count: count, bytes: total });
    return { execution_id: executionId, file_count: count, bytes: total, workspace: root };
  }

  async agentRpc(executionId, message, { timeoutMs = 600_000 } = {}) {
    const record = this.#record(executionId);
    if (!record.agent) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Agent worker is not started', { execution_id: executionId });
    const response = await this.#request(`${record.agent.endpoint}/rpc`, { absolute: true, method: 'POST', extraHeaders: { authorization: `Bearer ${record.agent.token}` }, body: { message, timeout_ms: timeoutMs }, timeoutMs: timeoutMs + 10_000 });
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

  async stopAgent(executionId, signal = 'SIGTERM') {
    const record = this.executions.get(executionId);
    if (!record?.agent) return false;
    await this.#request(`${record.agent.endpoint}/stop`, { absolute: true, method: 'POST', extraHeaders: { authorization: `Bearer ${record.agent.token}` }, body: { signal }, timeoutMs: 15_000 }).catch(() => undefined);
    record.agent = null;
    return true;
  }

  async jobStatus(executionId, jobId) {
    const record = this.#record(executionId);
    const job = record.jobs.get(jobId) ?? { jobId, executionId, state: 'running', command: null };
    const response = await this.#execd(record, `/command/status/${encodeURIComponent(jobId)}`, { method: 'GET', timeoutMs: 15_000 });
    const status = responseValue(response.body) ?? {};
    job.state = status.running === true ? 'running' : (status.exit_code === undefined ? job.state : 'completed');
    if (status.exit_code !== undefined) job.exit_code = status.exit_code;
    job.finished_at = job.state === 'running' ? null : (job.finished_at ?? this.now());
    record.jobs.set(jobId, job);
    return this.#jobView(job);
  }

  async cancelJob(executionId, jobId, { reason = 'cancelled' } = {}) {
    const record = this.#record(executionId);
    await this.#execd(record, `/command?id=${encodeURIComponent(jobId)}`, { method: 'DELETE', timeoutMs: 15_000 });
    const job = record.jobs.get(jobId) ?? { jobId, executionId, command: null, started_at: this.now() };
    job.state = 'cancelled'; job.cancel_reason = reason; job.finished_at = this.now();
    record.jobs.set(jobId, job);
    return this.#jobView(job);
  }

  async stopExecution(executionId) {
    const record = this.executions.get(executionId);
    if (!record) return false;
    if (record.stopPromise) return record.stopPromise;
    const stopping = this.#deleteExecution(executionId, record).finally(() => { record.stopPromise = null; });
    record.stopPromise = stopping;
    return stopping;
  }

  async #deleteExecution(executionId, record) {
    await this.stopAgent(executionId).catch(() => undefined);
    for (const job of record.jobs.values()) if (job.state === 'running') await this.cancelJob(executionId, job.jobId, { reason: 'execution_released' }).catch(() => undefined);
    const deletion = await this.#request(`/sandboxes/${encodeURIComponent(record.sandboxId)}`, { method: 'DELETE', timeoutMs: 30_000, allowStatuses: [404] }).catch((error) => {
      this.logger?.({ event: 'sandbox.stop_error', provider: 'opensandbox', execution_id: executionId, error_class: error?.code ?? error?.name });
      throw error;
    });
    if (deletion.status === 202) {
      const observed = await this.#request(`/sandboxes/${encodeURIComponent(record.sandboxId)}`, { timeoutMs: 15_000, allowStatuses: [404] });
      if (observed.status !== 404) throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Sandbox deletion is still pending', { execution_id: executionId, sandbox_id: record.sandboxId }, { retryable: true });
    }
    for (const [key, resource] of this.executions) if (resource === record) this.executions.delete(key);
    this.logger?.({ event: 'sandbox.stopped', provider: 'opensandbox', execution_id: executionId, sandbox_id: record.sandboxId });
    return true;
  }

  async stopAll() { for (const id of [...this.executions.keys()]) await this.stopExecution(id); }

  snapshot() { return { provider: 'opensandbox', lifecycle_url: this.lifecycleBaseUrl, image: this.image, verified: this.verified, executions: [...new Set(this.executions.values())].map((record) => this.#snapshot(record)) }; }

  #snapshot(record) { return { execution_id: record.botId ? record.boundExecutionId : record.executionId, ...(record.botId ? { bot_id: record.botId, resource_key: record.executionId } : {}), sandbox_id: record.sandboxId, binding_version: record.bindingVersion, workspace: '/workspace', host_workspace_ref: null, agent_worker: record.agent ? { worker_port: record.agent.worker_port, started_at: record.agent.started_at } : null, jobs: [...record.jobs.values()].map((job) => this.#jobView(job)) }; }
  #jobView(job) { return { job_id: job.jobId, execution_id: job.executionId, state: job.state, exit_code: job.exit_code ?? null, timed_out: job.timed_out ?? false, cancel_reason: job.cancel_reason ?? null, started_at: job.started_at ?? null, finished_at: job.finished_at ?? null, command: job.command ?? null }; }
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

  #commandResult(events, body, { background, startedAt }) {
    let stdout = ''; let stderr = ''; let truncated = false; let jobId = null; let exitCode = null; let timedOut = false; let state = background ? 'running' : 'completed';
    for (const item of events) {
      const data = item.data && typeof item.data === 'object' ? item.data : {};
      jobId = jobId ?? data.command_id ?? data.id ?? data.execution_id ?? null;
      if (item.event === 'stdout' || item.event === 'output') [stdout, truncated] = appendOutput(stdout, data.text ?? data.data ?? (typeof item.data === 'string' ? item.data : ''), this.maxOutputBytes);
      if (item.event === 'stderr') [stderr, truncated] = appendOutput(stderr, data.text ?? data.data ?? '', this.maxOutputBytes);
      if (item.event === 'execution_complete' || item.event === 'complete') { state = 'completed'; exitCode = data.exit_code ?? data.exitCode ?? 0; }
      if (item.event === 'error') { state = 'completed'; exitCode = data.exit_code ?? data.exitCode ?? 1; timedOut = /timeout/i.test(String(data.message ?? data.error ?? '')); }
      if (item.event === 'execution_accepted') { state = background ? 'running' : state; }
    }
    const fallback = responseValue(body);
    if (fallback && typeof fallback === 'object') {
      jobId = jobId ?? fallback.command_id ?? fallback.id ?? null;
      exitCode = exitCode ?? fallback.exit_code ?? null;
      stdout ||= fallback.stdout ?? '';
      stderr ||= fallback.stderr ?? '';
      if (fallback.running === true) state = 'running';
    }
    if (!background && events.length === 0 && !fallback) throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'OpenSandbox Execd returned no command result', { started_at: startedAt }, { retryable: true });
    return { job_id: jobId ?? randomUUID(), state, exit_code: exitCode, timed_out: timedOut, truncated, stdout, stderr };
  }

  async #execd(record, path, options) { return this.#request(`${record.execdUrl}${path}`, { ...options, absolute: true, extraHeaders: record.execdHeaders }); }

  async #request(path, { method = 'GET', body = undefined, timeoutMs = this.commandTimeoutMs, absolute = false, extraHeaders = {}, allowStatuses = [] } = {}) {
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
      if (!response.ok && !allowStatuses.includes(response.status)) throw new SwarmEnvError(response.status >= 500 ? ERROR_CODES.SERVICE_UNAVAILABLE : ERROR_CODES.INVALID_CONTRACT, `OpenSandbox request failed with HTTP ${response.status}`, { status: response.status, diagnostic: safeDiagnostic(parsed ?? text) }, { retryable: response.status >= 500 || response.status === 429 });
      return { status: response.status, body: parsed, text };
    } catch (error) {
      if (error instanceof SwarmEnvError) throw error;
      if (controller.signal.aborted) throw new SwarmEnvError(ERROR_CODES.SERVICE_TIMEOUT, 'OpenSandbox request timed out', { url: safeUrl(url) }, { cause: error, retryable: true });
      throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, error?.message ?? 'OpenSandbox request failed', { url: safeUrl(url) }, { cause: error, retryable: true });
    } finally { clearTimeout(timer); }
  }
}

export function createOpenSandboxManager(options = {}) { return new OpenSandboxManager(options); }

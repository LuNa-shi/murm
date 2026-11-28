import { WORKER_PROTOCOL } from '../worker-image.js';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ERROR_CODES, MurmError } from '../../errors.js';
import { required, envs, safeDiagnostic, safeUrl, responseValue } from './sandbox-validation.js';
import { fileProtocol, fileTransferProtocol, snapshotFileSeed } from '../files/core-file-seed.js';
import { fileTreeFrames, receiveFileTree } from '../files/file-tree-stream.js';
import { DEFAULT_FILE_POLICY } from '../file-policy.js';
import type { FileTree } from '../types.js';
import { snapshotCollectionSpec, MAX_COLLECTION_LINE_BYTES } from '../files/core-collection.js';

const MAX_TIMEOUT_MS = 60 * 60_000;
function jsonData(data: unknown) {
  if (typeof data !== 'string') return data;
  try { return JSON.parse(data); } catch { return data; }
}

/** murm's authenticated Worker protocol, independent of Sandbox lifecycle transport. */
export class WorkerClient {
  readonly executions: Map<string, any>;
  readonly projectInstallReceipts: Map<string, any>;
  readonly resolveEndpoint: (record: any) => Promise<{ url: string; headers: Record<string, string> }>;
  readonly checkAgentBoundary: (executionId: string) => Promise<unknown>;
  readonly fetch: typeof fetch;
  readonly requireManagementAuth: boolean;
  readonly useServerProxy: boolean;
  readonly workerPort: number;
  readonly commandTimeoutMs: number;
  readonly logger: any;
  readonly now: () => number;

  constructor(options: {
    executions: Map<string, any>; projectInstallReceipts: Map<string, any>;
    resolveEndpoint: WorkerClient['resolveEndpoint']; checkAgentBoundary: WorkerClient['checkAgentBoundary'];
    fetch: typeof fetch; requireManagementAuth: boolean; useServerProxy: boolean;
    workerPort: number; commandTimeoutMs: number; logger: any; now: () => number;
  }) {
    this.executions = options.executions;
    this.projectInstallReceipts = options.projectInstallReceipts;
    this.resolveEndpoint = options.resolveEndpoint;
    this.checkAgentBoundary = options.checkAgentBoundary;
    this.fetch = options.fetch;
    this.requireManagementAuth = options.requireManagementAuth;
    this.useServerProxy = options.useServerProxy;
    this.workerPort = options.workerPort;
    this.commandTimeoutMs = options.commandTimeoutMs;
    this.logger = options.logger;
    this.now = options.now;
  }

  #record(executionId: string) {
    const record = this.executions.get(executionId);
    if (!record) throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Sandbox is not bound to this Execution', { execution_id: executionId });
    return record;
  }
  async startAgent({ writable = false, files, forkSession, workspace, executionId, command: agentCommand, args = [], cwd = '/workspace/project', env = {}, secretEnvironment = {}, systemPrompt = null, systemPromptPath = null, resources, projectQuota = null, modelCatalogResource = null, modelCatalogContent = null, codex, executorVersion, externalExecutor, filePolicy = DEFAULT_FILE_POLICY, controllerSpoolDirectory, signal, requireCoreFileProtocol = false, beforeAgentStart = null }: any = {}) {
    const contract = { protocolVersion: WORKER_PROTOCOL, resources: [] };
    const record: any = this.#record(executionId);
    const signature = (values: any) => Array.isArray(values) && values.every((item: any) => item && typeof item.path === 'string' && /^[a-f0-9]{64}$/.test(item.sha256))
      ? JSON.stringify(values.map(({ path, sha256 }: any) => ({ path, sha256 })).sort((a: any, b: any) => a.path.localeCompare(b.path))) : null;
    const expectedVersion = files !== undefined || writable ? 1 : 0;
    const expectedDigest = expectedVersion === 1 ? snapshotFileSeed(files ?? {}, filePolicy.initial).digest : undefined;
    if (signature(resources) !== signature(contract.resources)) throw new MurmError(ERROR_CODES.AGENT_STARTUP_CONTRACT, 'Agent startup requires the complete pinned Agent contract');
    if (!record.agentId) throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Agent worker startup requires a registered Agent Sandbox');
    if (projectQuota) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Exact workspace quotas require a custom Provider or supported OpenSandbox storage capability');
    if (record.agent) return { ...record.agent };
    record.executionStopped = false;
    const workerToken = record.workerToken;
    if (typeof workerToken !== 'string' || workerToken.length === 0) throw new MurmError(ERROR_CODES.START_FAILED, 'OpenSandbox worker token is unavailable for this Execution');
    const { url: endpoint, headers: routingHeaders } = await this.resolveEndpoint(record);
    for (const value of Object.values(routingHeaders)) record.onWorkerToken?.(value);
    const workerHeaders = {
      ...routingHeaders, ...(this.useServerProxy || new Headers(routingHeaders).has('authorization')
        ? { 'X-Murm-Worker-Token': workerToken } : { authorization: `Bearer ${workerToken}` }),
    };
    await this.#waitWorker(endpoint, workerHeaders);
    if (this.requireManagementAuth) {
      const denied = await this.request(`${endpoint}/core/contract`, {
        absolute: true, extraHeaders: routingHeaders, timeoutMs: 5000, allowStatuses: [401, 403],
      });
      if (![401, 403].includes(denied.status)) {
        throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Worker management authentication could not be confirmed');
      }
    }
    let transfer = false;
    if (requireCoreFileProtocol) {
      const probe = await this.request(`${endpoint}/core/contract`, {
        absolute: true, method: 'GET', extraHeaders: workerHeaders, timeoutMs: 15_000, allowStatuses: [400, 404],
      });
      const detected = probe.body?.result?.worker_protocol;
      if (detected !== WORKER_PROTOCOL) throw new MurmError(ERROR_CODES.AGENT_STARTUP_CONTRACT,
        `Core requires Worker protocol ${WORKER_PROTOCOL}; detected ${detected ?? 'none'}. Prepare a matching Worker image with murm setup.`);
      const supported = probe.body?.result?.file_protocol;
      transfer = probe.body?.result?.file_transfer === fileTransferProtocol;
      if (supported !== fileProtocol) {
        throw new MurmError(ERROR_CODES.INVALID_CONTRACT,
          `Core requires Worker file protocol ${fileProtocol}; detected ${supported ?? 'none'}`);
      }
    }
    if (!transfer) {
      if (JSON.stringify(filePolicy) !== JSON.stringify(DEFAULT_FILE_POLICY)) {
        throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Configured file budgets require a Worker with the streamed file protocol');
      }
      if (files !== undefined) snapshotFileSeed(files, DEFAULT_FILE_POLICY.initial);
    }
    const isolation = this.requireManagementAuth ? await this.checkAgentBoundary(executionId) : undefined;
    beforeAgentStart?.();
    record.coreAgent = true;
    record.filePolicy = filePolicy;
    record.controllerSpoolDirectory = controllerSpoolDirectory;
    record.fileTransfer = transfer;
    record.agent = { endpoint, token: workerToken, headers: workerHeaders, worker_port: this.workerPort, started_at: this.now(), starting: true };
    const stream = transfer && files !== undefined;
    const startup = await this.request(`${endpoint}/start`, {
      absolute: true,
      workerStart: true,
      method: 'POST',
      extraHeaders: workerHeaders,
      ...(stream ? { tree: files, fileBudget: filePolicy.initial } : {}),
      signal,
      body: {
        command: codex ? 'codex' : required(agentCommand, 'agent_command'),
        ...(codex ? { codex: { model: codex.model, baseUrl: codex.baseUrl } } : {}),
        ...(executorVersion ? { executor_version: executorVersion } : {}),
        ...(externalExecutor ? { executor_adapter: {
          kind: externalExecutor.kind, protocol: externalExecutor.protocol, capabilities: externalExecutor.capabilities,
        } } : {}),
        ...(forkSession === undefined ? {} : { fork_session: forkSession }),
        args: codex ? [] : args,
        cwd,
        env: envs(env, { allowSecrets: true }),
        // Explicitly supplied secret values travel only over the authenticated
        // worker channel and are never included in a manager snapshot/log.
        secret_env: envs(secretEnvironment, { allowSecrets: true }),
        system_prompt: systemPrompt,
        system_prompt_path: systemPromptPath,
        resources,
        contract_version: contract.protocolVersion,
        writable,
        ...(transfer ? { file_policy: filePolicy } : {}),
        ...(workspace ? { shared_workspace: workspace } : {}),
        ...(files === undefined || stream ? {} : { files }),
        ...(modelCatalogResource ? { model_catalog_resource: modelCatalogResource } : {}),
        ...(modelCatalogContent ? { model_catalog_content: modelCatalogContent } : {}),
      },
      timeoutMs: stream ? Math.max(30_000, filePolicy.initial.timeoutMs) : 30_000,
    });
    const receipt = startup.body?.result?.contract;
    if (receipt?.version !== contract.protocolVersion || (requireCoreFileProtocol && receipt.file_protocol !== fileProtocol) || !Array.isArray(receipt.resources) || signature(receipt.resources) !== signature(resources)) {
      throw new MurmError(ERROR_CODES.AGENT_STARTUP_CONTRACT, 'worker did not attest the pinned Agent contract resources');
    }
    const backend = startup.body?.result?.backend;
    if (codex && (backend?.kind !== 'codex' || backend.version !== codex.version ||
      backend.authMode !== 'api-key' || typeof backend.threadId !== 'string' || !backend.threadId)) {
      throw new MurmError(ERROR_CODES.AGENT_STARTUP_CONTRACT, 'worker did not attest the pinned Codex executor, authentication and Session');
    }
    if (externalExecutor && (backend?.kind !== externalExecutor.kind ||
      backend.version !== executorVersion || backend.protocol !== externalExecutor.protocol ||
      !isDeepStrictEqual(backend.capabilities, externalExecutor.capabilities))) {
      throw new MurmError(ERROR_CODES.AGENT_STARTUP_CONTRACT, 'Worker did not attest the selected adapter protocol, version and capabilities');
    }
    const catalogReceipt = startup.body?.result?.model_catalog_resource;
    if (modelCatalogResource && signature([catalogReceipt]) !== signature([modelCatalogResource])) {
      throw new MurmError(ERROR_CODES.AGENT_STARTUP_CONTRACT, 'worker did not attest the pinned Pi model catalog');
    }
    const fileReceipt = startup.body?.result?.project_files;
    if (workspace && JSON.stringify(startup.body?.result?.shared_workspace) !== JSON.stringify(workspace)) throw new MurmError(ERROR_CODES.AGENT_STARTUP_CONTRACT, 'Worker did not attest shared workspace');
    if (!workspace && (fileReceipt?.version !== expectedVersion || fileReceipt.writable !== writable || fileReceipt.digest !== expectedDigest)) {
      throw new MurmError(ERROR_CODES.AGENT_STARTUP_CONTRACT, 'worker did not attest initial Core files and workDir permissions');
    }
    record.agent = { endpoint, token: workerToken, headers: workerHeaders, worker_port: this.workerPort, started_at: this.now(), contract: receipt,
      ...(codex || externalExecutor ? { backend } : {}),
    };
    this.logger?.({ event: 'sandbox.agent_started', provider: 'opensandbox', execution_id: executionId, sandbox_id: record.sandboxId, worker_port: this.workerPort });
    return { ...record.agent, isolation };
  }


  async syncWorkspace({ executionId, workspaceRef, manifest = null, maxFileBytes = 2 * 1024 * 1024, maxTotalBytes = 16 * 1024 * 1024 }: any = {}) {
    const record: any = this.#record(executionId);
    if (typeof workspaceRef !== 'string' || workspaceRef.length === 0) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'workspaceRef is required to initialize the provider Workspace');
    const root = workspaceRef;
    const files: any[] = [];
    if (!manifest) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Agent input requires a pinned manifest');
    if (manifest) {
      const rootInfo = await lstat(root);
      if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Public Workspace input root must be a regular directory');
      for (const path of Object.keys(manifest)) {
        const segments = path.split('/');
        if (segments.some((segment: any) => !segment || ['.', '..', '.git', '.swarm', '.pi', '.env'].includes(segment) || segment.startsWith('.swarm-') || segment.startsWith('.env.')) || path.includes('\\') || path.includes('\0')) {
          throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Public Workspace manifest contains a forbidden path');
        }
        let current = root;
        for (const [index, segment] of segments.entries()) {
          current = join(current, segment);
          const info = await lstat(current);
          if (info.isSymbolicLink() || (index < segments.length - 1 ? !info.isDirectory() : !info.isFile())) throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Public Workspace input must contain regular files without symlinks');
        }
        files.push(join(root, path));
      }
    }
    let total = 0;
    const inputFiles = Object.create(null);
    for (const source of files) {
      const content = await readFile(source);
      if (content.length > maxFileBytes || total + content.length > maxTotalBytes) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'initial Workspace exceeds provider sync bounds', { max_file_bytes: maxFileBytes, max_total_bytes: maxTotalBytes });
      total += content.length;
      const path = relative(root, source).split('\\').join('/');
      const digest = createHash('sha256').update(content).digest('hex');
      if (manifest && (manifest[path]?.content_hash !== digest || manifest[path]?.bytes !== content.length)) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Public Workspace input bytes differ from the pinned manifest', { path });
      inputFiles[path] = content.toString('base64');
    }
    await this.#projectCall(executionId, 'prepare', manifest, { files: inputFiles });
    this.logger?.({ event: 'sandbox.workspace_initialized', provider: 'opensandbox', execution_id: executionId, file_count: files.length, bytes: total });
    return { execution_id: executionId, file_count: files.length, bytes: total, workspace: '/workspace/project' };
  }

  async #projectCall(executionId: any, action: any, manifest: any = undefined, input: any = {}) {
    const record: any = this.#record(executionId);
    if (!record.agentId || record.boundExecutionId !== executionId || !record.agent || record.stopPromise) throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Project control requires the live bound Agent worker');
    const body = { ...input, execution_id: executionId, binding_version: record.bindingVersion, ...(manifest ? { manifest } : {}) };
    const response = await this.request(`${record.agent.endpoint}/project/${action}`, { absolute: true, method: 'POST',
      extraHeaders: this.#workerHeaders(record), body, timeoutMs: action.startsWith('install') ? 5000 : 30_000 });
    const result: any = responseValue(response.body);
    const expected = action === 'prepare' ? 'PREPARED' : 'ACTIVE';
    if ((!action.startsWith('install') && result?.state !== expected) || result?.execution_id !== executionId || result?.binding_version !== record.bindingVersion) throw new MurmError(ERROR_CODES.START_FAILED, 'Worker did not confirm the expected project permission state');
    if (record.stopPromise || this.executions.get(executionId) !== record) throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Agent stopped during project control');
    this.logger?.({ event: `sandbox.project_${action === 'prepare' ? 'prepared' : action === 'grant' ? 'granted' : action}`, agent_id: record.agentId, execution_id: executionId, binding_version: record.bindingVersion });
    return result;
  }

  prepareAgentProject({ executionId, manifest }: any) { return this.#projectCall(executionId, 'prepare', manifest); }
  grantAgentProject({ executionId }: any) { return this.#projectCall(executionId, 'grant'); }

  async coreSessionSnapshot(executionId: string) {
    const record = this.#record(executionId);
    if (record.agent?.contract?.version !== WORKER_PROTOCOL || record.stopPromise || record.executionStopped) {
      throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Context Fork requires a live Agent Worker');
    }
    const response = await this.request(`${record.agent.endpoint}/core/session/snapshot`, {
      absolute: true, method: 'POST', extraHeaders: this.#workerHeaders(record),
      body: {}, timeoutMs: 15_000,
    });
    return responseValue(response.body);
  }

  async coreFileOperation(executionId: string, action: string, input: unknown) {
    const record = this.#record(executionId);
    if (record.agent?.contract?.version !== WORKER_PROTOCOL || record.stopPromise) {
      throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Core files require the live Agent Worker');
    }
    if (record.fileTransfer && action === 'snapshot') return this.#streamSnapshot(record, input);
    const replace = record.fileTransfer && action === 'replace';
    const { files, ...parameters } = replace ? input as { files: FileTree } : { files: undefined };
    const response = await this.request(`${record.agent.endpoint}/core/files/${action}`, {
      absolute: true, method: 'POST', extraHeaders: this.#workerHeaders(record),
      ...(replace ? { body: parameters, tree: files, fileBudget: record.filePolicy.replace } : { body: input }),
      timeoutMs: replace ? record.filePolicy.replace.timeoutMs : 30_000, allowStatuses: [400],
    });
    return this.#fileReply(response);
  }

  #fileReply(response: { status: number; body: any }) {
    if (response.status === 400) {
      const { code, error } = response.body ?? {};
      const recognized = ['CONFLICT', 'INVALID_CONTRACT', 'NOT_ALLOWED', 'WORKSPACE_BUSY', 'OPERATION_UNKNOWN', 'FILE_SPACE_INSUFFICIENT'];
      throw new MurmError(recognized.includes(code) ? code : 'OPERATION_UNKNOWN',
        typeof error === 'string' ? error : 'Worker could not confirm the Core file operation');
    }
    return responseValue(response.body);
  }

  async #streamSnapshot(record: any, input: unknown) {
    const limit = record.filePolicy.snapshot;
    const requestedBytes = (input as { maxBytes?: number }).maxBytes;
    const budget = { ...limit, maxBytes: Math.min(requestedBytes ?? limit.maxBytes, limit.maxBytes) };
    const signal = AbortSignal.timeout(budget.timeoutMs);
    const response = await this.fetch(`${record.agent.endpoint}/core/files/snapshot`, {
      method: 'POST', headers: { ...this.#workerHeaders(record), 'content-type': 'application/json', accept: 'application/x-ndjson' },
      body: JSON.stringify(input), redirect: 'error', signal,
    });
    if (response.status === 400) return this.#fileReply({ status: 400, body: await response.json() });
    if (!response.ok || !response.body || response.headers.get('content-type') !== 'application/x-ndjson') {
      await response.body?.cancel();
      throw new MurmError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Worker did not return a bound file snapshot stream');
    }
    const staged = await receiveFileTree(response.body as AsyncIterable<Uint8Array>, {
      parent: record.controllerSpoolDirectory, budget, label: 'Controller snapshot staging',
      maxSpoolBytes: record.filePolicy.controllerSpoolBytes, signal,
    });
    try { return { ...staged.meta, files: Object.fromEntries(Object.entries(staged.files)) }; }
    finally { await staged.dispose(); }
  }

  snapshotAgentProject({ executionId }: any) { return this.#projectCall(executionId, 'snapshot'); }
  installAgentProject({ executionId, ...input }: any) { return this.#projectCall(executionId, 'install', undefined, input); }
  queryAgentProjectInstall({ executionId, request_id }: any) {
    const closed = this.projectInstallReceipts.get(executionId);
    if (closed) return structuredClone(closed.receipts.find((receipt: any) => receipt.request_id === request_id) ?? { execution_id: executionId, binding_version: closed.bindingVersion, request_id, phase: 'not_found' });
    return this.#projectCall(executionId, 'install-result', undefined, { request_id });
  }
  forgetAgentProjectInstalls({ executionId }: any) { this.projectInstallReceipts.delete(executionId); }
  confirmAgentProjectInstall({ executionId, request_id, content_hash }: any) { return this.#projectCall(executionId, 'install-confirm', undefined, { request_id, content_hash }); }

  /** Pull guest files back before Runtime checkpoints or deletes the sandbox. */
  async agentRpc(executionId: any, message: any, { timeoutMs = 600_000, since, transportTimeoutMs = timeoutMs + 10_000, signal }: any = {}) {
    const record: any = this.#record(executionId);
    if (!record.agent) throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Agent worker is not started', { execution_id: executionId });
    const response = await this.request(`${record.agent.endpoint}/rpc`, { absolute: true, method: 'POST', extraHeaders: this.#workerHeaders(record), body: { message, timeout_ms: timeoutMs, ...(since === undefined ? {} : { since }) }, timeoutMs: transportTimeoutMs, signal });
    return responseValue(response.body);
  }

  async stopAgent(executionId: any, signal: any = 'SIGTERM', { preserveWorker = false }: any = {}) {
    const record: any = this.executions.get(executionId);
    if (!record?.agent) return record?.executionStopped === true;
    if (record.executionStopped) {
      if (!preserveWorker) record.agent = null;
      return true;
    }
    const response = await this.request(`${record.agent.endpoint}/stop`, { absolute: true, method: 'POST', extraHeaders: this.#workerHeaders(record), body: { signal }, timeoutMs: 15_000 });
    const stopped = responseValue(response.body);
    if (stopped?.stopped === true && Array.isArray(stopped.project_installs) && record.boundExecutionId) {
      this.projectInstallReceipts.set(record.boundExecutionId, { bindingVersion: record.bindingVersion,
        receipts: stopped.project_installs.filter((receipt: any) => receipt.execution_id === record.boundExecutionId && receipt.binding_version === record.bindingVersion) });
    }
    if (stopped?.stopped !== true) throw new MurmError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Worker did not confirm execution stopped');
    record.executionStopped = true;
    if (!preserveWorker) record.agent = null;
    return true;
  }


  async *collectCoreSession(executionId: string) {
    const { filePolicy = DEFAULT_FILE_POLICY } = this.#record(executionId);
    yield* this.collectCoreFiles(executionId, { paths: ['.'], includeGit: false, required: true, maxBytes: filePolicy.session.maxBytes }, { session: true });
  }

  async *collectCoreFiles(executionId: string, input: unknown, { session = false } = {}) {
    const record: any = this.#record(executionId);
    const budget = (record.filePolicy ?? DEFAULT_FILE_POLICY)[session ? 'session' : 'export'];
    const requested = snapshotCollectionSpec(input);
    const spec = { ...requested, maxBytes: Math.min(requested.maxBytes, budget.maxBytes) };
    if (!record.executionStopped || !record.coreAgent || !record.agent || record.stopPromise) {
      throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Core collection requires a confirmed stopped Agent and retained Worker');
    }
    const fingerprint = JSON.stringify(spec);
    const policyKey = session ? 'sessionCollectionSpec' : 'collectionSpec';
    if (record[policyKey] && record[policyKey] !== fingerprint) throw new MurmError(ERROR_CODES.CONFLICT, 'Agent collection policy is immutable');
    record[policyKey] = fingerprint;
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(new Error('Core collection transport deadline')), budget.timeoutMs);
    let response;
    try {
      response = await this.fetch(`${record.agent.endpoint}${session ? '/core/session/archive' : '/core/files/collect'}`, { method: 'POST',
        headers: { ...this.#workerHeaders(record), 'content-type': 'application/json', accept: 'application/x-ndjson' },
        body: JSON.stringify(spec), signal: controller.signal, redirect: 'error' });
      if (!response.ok || !response.body || response.headers.get('content-type')?.split(';')[0] !== 'application/x-ndjson') {
        throw new MurmError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Worker did not return the bounded Core collection stream');
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
          if (pending.length + end - offset > MAX_COLLECTION_LINE_BYTES) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Core collection record exceeds its line limit');
          pending = Buffer.concat([pending, bytes.subarray(offset, end)]);
          offset = end + (newline === -1 ? 0 : 1);
          if (newline === -1) break;
          if (ended) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Core collection contains records after its final receipt');
          let value;
          try { value = JSON.parse(pending.toString('utf8')); } catch { throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Core collection record is not valid JSON'); }
          pending = Buffer.alloc(0);
          if (value?.type === 'error') throw new MurmError(
            ['INVALID_CONTRACT', 'NOT_ALLOWED', 'CONFLICT', 'SERVICE_UNAVAILABLE'].includes(value.code) ? value.code : ERROR_CODES.SERVICE_UNAVAILABLE,
            typeof value.message === 'string' ? value.message : 'Worker collection failed');
          if (!['directory', 'file', 'chunk', 'fileEnd', 'end'].includes(value?.type)) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Core collection record type is invalid');
          ended = value.type === 'end';
          yield value;
        }
      }
      if (!ended || pending.length) throw new MurmError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Worker collection stream ended without a complete receipt');
    } finally {
      clearTimeout(deadline);
      controller.abort();
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    }
  }


  async #waitWorker(endpoint: any, headers: any) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const response = await this.fetch(`${endpoint}/health`, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(3000) });
        if (response.ok) return;
      } catch { /* worker is still starting */ }
      await new Promise<any>((resolve: any) => setTimeout(resolve, 100));
    }
    throw new MurmError(ERROR_CODES.START_FAILED, 'Agent worker did not become ready', { endpoint: safeUrl(endpoint) }, { retryable: true });
  }


  #workerHeaders(record: any) { return record.agent.headers ?? { authorization: `Bearer ${record.agent.token}` }; }


  async request(path: any, { method = 'GET', body = undefined, tree, fileBudget, timeoutMs = this.commandTimeoutMs, absolute = false, extraHeaders = {}, allowStatuses = [], workerStart = false, signal, omitLifecycleKey = false }: any = {}) {
    const url = path;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('sandbox provider request timed out')), timeoutMs);
    const requestSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    const headers = { accept: 'application/json', ...extraHeaders };
    if (body !== undefined) headers['content-type'] = tree ? 'application/x-ndjson' : 'application/json';
    if (tree && body?.file_policy) headers['x-murm-file-policy'] = JSON.stringify(body.file_policy);
    try {
      const payload = tree ? { body: fileTreeFrames(tree, fileBudget, body, requestSignal) as unknown as BodyInit, duplex: 'half' } :
        body === undefined ? {} : { body: JSON.stringify(body) };
      const response = await this.fetch(url, { method, headers, ...payload, signal: requestSignal, redirect: 'error' });
      const text = await response.text();
      const parsed = response.headers?.get?.('content-type')?.includes('text/event-stream') ? null : (text ? jsonData(text) : {});
      if (workerStart && response.status === 400 && parsed?.ok === false) {
        if (parsed.code === 'FILE_SPACE_INSUFFICIENT') {
          throw new MurmError('FILE_SPACE_INSUFFICIENT', 'Sandbox staging or workDir could not hold the initial project');
        }
        if (parsed.code === ERROR_CODES.AGENT_STARTUP_CONTRACT) {
          throw new MurmError(ERROR_CODES.AGENT_STARTUP_CONTRACT, 'Worker rejected the pinned Agent startup contract');
        }
      }
      if (!response.ok && !allowStatuses.includes(response.status)) throw new MurmError(absolute && /\/project\/(snapshot|install|install-result|install-confirm)$/.test(new URL(url).pathname) && [ERROR_CODES.WORKSPACE_BUSY, ERROR_CODES.WORKSPACE_RESULT_UNKNOWN, ERROR_CODES.WORKSPACE_RECONCILIATION_REQUIRED].includes(parsed?.code)
        ? parsed.code : response.status >= 500 ? ERROR_CODES.SERVICE_UNAVAILABLE : ERROR_CODES.INVALID_CONTRACT,
      `Worker request failed with HTTP ${response.status}`, { status: response.status, diagnostic: safeDiagnostic(parsed ?? text),
        ...(absolute && parsed?.code === ERROR_CODES.WORKSPACE_BUSY && ['dirty', 'active_writer'].includes(parsed.apply_blocker) ? { apply_blocker: parsed.apply_blocker } : {}) },
      { retryable: response.status >= 500 || response.status === 429 || parsed?.code === ERROR_CODES.WORKSPACE_BUSY });
      return { status: response.status, body: parsed, text };
    } catch (error: any) {
      if (error instanceof MurmError) throw error;
      if (controller.signal.aborted) throw new MurmError(ERROR_CODES.SERVICE_TIMEOUT, 'Worker request timed out', { url: safeUrl(url) }, { cause: error, retryable: true });
      throw new MurmError(ERROR_CODES.SERVICE_UNAVAILABLE, error?.message ?? 'Worker request failed', { url: safeUrl(url) }, { cause: error, retryable: true });
    } finally { clearTimeout(timer); }
  }
}

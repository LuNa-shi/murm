#!/usr/bin/env node

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, chown, readdir, statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { SandboxProject, AGENT_UID, PROJECT_DIR, RUNTIME_DIR } from './sandbox-project.js';
import { CoreWorkDir } from './core-work-dir.js';
import { collectCoreWorkDir, MAX_COLLECTION_ENTRIES } from './core-collection.js';
import { once } from 'node:events';
import { createRpcSubmissions } from './rpc-submissions.js';
import { createCodexAppServerDriver } from './codex-app-server-driver.js';
import { snapshotSessionFork, sessionForkText } from './core-session-fork.js';

const argv = process.argv.slice(2);
function option(name: string, fallback: string | number | null = null) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] ?? fallback : fallback;
}
const port = Number(option('--port', process.env.MURM_WORKER_PORT ?? 44100));
const token = option('--token', process.env.MURM_WORKER_TOKEN) ?? randomUUID();
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('worker port must be an integer from 1 to 65535');

const project = new SandboxProject();
let coreWorkDir: any;
let executionStopped = false;
let collectionMaxEntries = MAX_COLLECTION_ENTRIES;
const quotaRequired = argv.includes('--require-project-quota');
const catalogPath = '/opt/murm/pi-agent/models.json';
const filesystemPolicy = '/opt/murm/agent-filesystem-policy';
const unprivileged = ['--reuid', String(AGENT_UID), '--regid', String(AGENT_UID), '--clear-groups', '--no-new-privs',
  '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all', '--'];
let initialized = !quotaRequired;
if (initialized) await project.initialize();
let everStarted = false;
let stopping: Promise<unknown> | null = null;
let executorLaunched = false;
let executorKind: 'pi' | 'codex' = 'pi';
let codexDriver: ReturnType<typeof createCodexAppServerDriver> | undefined;
let writerGate: Promise<unknown> = Promise.resolve();
let child: any = null;
let sessionPrivateValues: unknown[] = [];
let stdoutBuffer = '';
let sequence = 0;
const records: any[] = [];
const MAX_RECORDS = 2_048;
let executionEpoch = 0;
let nativeExecuting = false;
const preflights = new Set<Promise<void>>();
interface InterruptOperation {
  epoch: number;
  done?: Promise<void>;
  response?: { id: string; command: string; success: boolean; data?: { discardedInputHashes: string[] } };
}
const interruptions = new Map<string, InterruptOperation>();
let interrupting = false;
const rpcSubmissions = createRpcSubmissions({ write({ steeringMode, executionEpoch: _executionEpoch, onlyWhileActive, ...message }: Record<string, unknown>) {
  if (!child?.stdin?.writable) throw Object.assign(new Error('worker Agent is not running'), { code: 'NOT_ALLOWED' });
  if (onlyWhileActive && !nativeExecuting) {
    publish({ type: 'response', id: message.id, command: message.type, success: false, code: 'NO_ACTIVE_EXECUTION' });
    return;
  }
  if (codexDriver) {
    codexDriver.write({ ...message, steeringMode, onlyWhileActive } as Parameters<typeof codexDriver.write>[0]);
    return;
  }
  if (steeringMode !== undefined) {
    child.stdin.write(`${JSON.stringify({ type: 'set_steering_mode', mode: steeringMode })}\n`);
  }
  child.stdin.write(`${JSON.stringify(message)}\n`);
} });

function authorized(request: IncomingMessage) {
  return request.headers.authorization === `Bearer ${token}`;
}

function send(response: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body ?? null);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
  response.end(text);
}

async function body(request: IncomingMessage, maxBytes = 2 * 1024 * 1024) {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('worker request body is too large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function publish(record: any) {
  if (record.type === 'agent_start') nativeExecuting = true;
  if (['agent_settled', 'worker_exit'].includes(record.type)) nativeExecuting = false;
  const value = { ...record, worker_sequence: ++sequence, worker_at: new Date().toISOString() };
  records.push(value);
  if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
  rpcSubmissions.observe(value);
  return value;
}

async function expandPiModelCatalog(environment: any) {
  const agentDir = environment.PI_CODING_AGENT_DIR;
  if (typeof agentDir !== 'string' || !agentDir.startsWith('/')) return;
  const catalogPath = `${agentDir}/models.json`;
  let source;
  try { source = JSON.parse(await readFile(catalogPath, 'utf8')); } catch { return; }
  const expand = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(expand);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]: any) => [key, expand(item)]));
    if (typeof value !== 'string') return value;
    const match = value.match(/^\$([A-Z_][A-Z0-9_]*)$/);
    return match && typeof environment[match[1]] === 'string' ? environment[match[1]] : value;
  };
  await writeFile(catalogPath, `${JSON.stringify(expand(source), null, 2)}\n`, { mode: 0o600 });
}

function processStdout(chunk: any) {
  stdoutBuffer += chunk.toString();
  while (true) {
    const newline = stdoutBuffer.indexOf('\n');
    if (newline < 0) return;
    const line = stdoutBuffer.slice(0, newline).replace(/\r$/, '');
    stdoutBuffer = stdoutBuffer.slice(newline + 1);
    if (!line) continue;
    try {
      const record = JSON.parse(line);
      if (codexDriver) codexDriver.observe(record);
      else publish(record);
    } catch { publish({ type: 'worker_stdout', text: line }); }
  }
}

function startupContractError(message: any) {
  return Object.assign(new Error(message), { code: 'AGENT_STARTUP_CONTRACT' });
}

function requireOpenWorkDir() {
  if (project.closing) throw Object.assign(new Error('Agent workDir is closing'), { code: 'NOT_ALLOWED' });
}

async function readPinnedStartupPath(operation: any, path: any) {
  try {
    return await operation(path);
  } catch (error: any) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      throw startupContractError('Pinned Agent startup resource is missing from the image');
    }
    throw error;
  }
}

async function startAgent(input: any) {
  if (everStarted || project.closing) throw new Error('worker Agent cannot start another Agent');
  if (!Array.isArray(input.args) || !input.args.every((value: any) => typeof value === 'string')) throw new Error('worker args must be a string array');
  if (typeof input.command !== 'string' || !input.command) throw new Error('worker command is required');
  const cwd = input.cwd ?? PROJECT_DIR;
  if (cwd !== PROJECT_DIR) throw new Error('worker project cwd must be /workspace/project');
  if (!['pi', 'codex'].includes(input.command)) throw startupContractError('Core startup requires a supported executor');
  if (input.command === 'codex') {
    if (input.args.length || input.fork_session !== undefined || input.model_catalog_resource !== undefined ||
        typeof input.codex?.model !== 'string' || !input.codex.model || typeof input.codex?.baseUrl !== 'string' ||
        typeof input.secret_env?.OPENAI_API_KEY !== 'string' || !input.secret_env.OPENAI_API_KEY) {
      throw startupContractError('Codex requires its model gateway, credential, and a fresh native thread');
    }
    const gateway = new URL(input.codex.baseUrl);
    if (gateway.protocol !== 'http:' || gateway.username || gateway.password || gateway.search || gateway.hash || gateway.pathname !== '/v1') {
      throw startupContractError('Codex requires an explicit host Responses gateway');
    }
  }
  executorKind = input.command;
  everStarted = true;
  let projectQuota: { bytes: number; inodes: number } | null = null;
  const sharedWorkspace = input.shared_workspace;
  if (sharedWorkspace && (typeof sharedWorkspace.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(sharedWorkspace.id) ||
      !['read-only', 'read-write'].includes(sharedWorkspace.mode) || input.files !== undefined ||
      input.writable !== (sharedWorkspace.mode === 'read-write'))) throw startupContractError('Invalid shared workspace startup');
  if (quotaRequired) {
    const { bytes, inodes } = input.project_quota ?? {};
    if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(inodes) || bytes <= 0 || inodes <= 0) throw startupContractError('Agent workspace quota is required');
    const filesystem = await statfs('/workspace', { bigint: true });
    const mounts = (await readFile('/proc/self/mountinfo', 'utf8')).trim().split('\n');
    const mount = mounts.findLast(row => row.split(' ')[4] === '/workspace')?.split(' ');
    const childMounts = mounts.filter(row => row.split(' ')[4]?.startsWith('/workspace/'));
    const contents = await readdir('/workspace');
    if ((sharedWorkspace ? childMounts.length !== 1 || childMounts[0].split(' ')[4] !== PROJECT_DIR || contents.length !== 1 || contents[0] !== 'project' : childMounts.length || contents.length) || filesystem.type !== 0x01021994n || filesystem.blocks * filesystem.bsize !== BigInt(bytes) ||
        filesystem.files !== BigInt(inodes) || !mount?.[5]?.split(',').includes('nodev') ||
        !mount[5].split(',').includes('nosuid')) throw startupContractError('Agent workspace quota is absent or mismatched');
    const probe = spawnSync('setpriv', [...unprivileged, filesystemPolicy, '/usr/bin/true'], { cwd: '/', timeout: 2_000 });
    if ((probe.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' || (Number.isInteger(probe.status) && probe.status !== 0)) {
      throw startupContractError('Agent filesystem policy could not be enforced');
    }
    if (probe.status !== 0) throw new Error('Agent filesystem policy probe did not complete');
    if (project.closing) throw new Error('Agent stopped during filesystem validation');
    if (sharedWorkspace) {
      const projectFilesystem = await statfs(PROJECT_DIR, { bigint: true });
      const options = childMounts[0].split(' ')[5].split(',');
      if (projectFilesystem.type !== 0x01021994n || projectFilesystem.blocks * projectFilesystem.bsize !== BigInt(bytes) ||
          projectFilesystem.files !== BigInt(inodes) || !options.includes('nodev') || !options.includes('nosuid') ||
          options.includes('ro') !== (sharedWorkspace.mode === 'read-only')) throw startupContractError('Shared project mount is absent or mismatched');
    }
    await project.initialize({ shared: Boolean(sharedWorkspace) });
    initialized = true;
    projectQuota = { bytes, inodes };
    collectionMaxEntries = Math.min(inodes, MAX_COLLECTION_ENTRIES);
  } else if (input.project_quota) throw startupContractError('Worker must start in quota enforcement mode');
  if (input.contract_version !== 'murm-core-v1' || !['pi', 'codex'].includes(input.command) || typeof input.system_prompt !== 'string' || input.system_prompt_path !== `${RUNTIME_DIR}/profile-prompt.txt` || !Array.isArray(input.resources) || input.resources.length !== 0) {
    throw startupContractError('Core startup requires a supported executor, an explicit role prompt and an empty resource set');
  }
  if (project.closing) throw new Error('Agent stopped during resource validation');
  for (const path of ['home', 'tmp', ...(executorKind === 'pi' ? ['pi-agent', 'pi-session'] : ['codex-home', 'codex-home/sessions'])]) {
    await mkdir(join(RUNTIME_DIR, path), { recursive: true });
    await chown(join(RUNTIME_DIR, path), AGENT_UID, AGENT_UID);
  }
  if (input.system_prompt_path && (typeof input.system_prompt_path !== 'string' || !input.system_prompt_path.startsWith(`${RUNTIME_DIR}/`) || input.system_prompt_path.split('/').includes('..'))) throw new Error('worker system prompt path must stay inside /workspace');
  if (input.system_prompt_path && typeof input.system_prompt === 'string') {
    await mkdir(dirname(input.system_prompt_path), { recursive: true });
    await writeFile(input.system_prompt_path, input.system_prompt, { mode: 0o600 });
    await chown(input.system_prompt_path, AGENT_UID, AGENT_UID);
  }
  coreWorkDir = new CoreWorkDir({ path: PROJECT_DIR, uid: AGENT_UID, gid: AGENT_UID, assertOpen: requireOpenWorkDir });
  const projectFiles = await coreWorkDir.initialize({ files: input.files, writable: input.writable === true, shared: Boolean(sharedWorkspace) });
  const suppliedEnv = { ...(input.env ?? {}), ...(input.secret_env ?? {}) };
  sessionPrivateValues = Object.values(input.secret_env ?? {});
  if (input.fork_session !== undefined) {
    const sessionPath = join(RUNTIME_DIR, 'pi-session', 'fork.jsonl');
    await writeFile(sessionPath, sessionForkText(input.fork_session, cwd), { mode: 0o600, flag: 'wx' });
    await chown(sessionPath, AGENT_UID, AGENT_UID);
  }
  delete suppliedEnv.MURM_WORKER_TOKEN;
  const agentEnvironment = { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', ...suppliedEnv,
    HOME: join(RUNTIME_DIR, 'home'), TMPDIR: join(RUNTIME_DIR, 'tmp'), PI_CODING_AGENT_DIR: join(RUNTIME_DIR, 'pi-agent'),
    ...(executorKind === 'codex' ? { CODEX_HOME: join(RUNTIME_DIR, 'codex-home') } : {}) };
  let modelCatalogResource: any = null;
  let executorVersion: string | undefined;
  if (executorKind === 'pi') {
    const catalog = await readPinnedStartupPath(readFile, catalogPath);
    if (input.model_catalog_resource) {
      const sha256 = createHash('sha256').update(catalog).digest('hex');
      if (input.model_catalog_resource.path !== catalogPath || input.model_catalog_resource.sha256 !== sha256) throw startupContractError('Pi model catalog does not match the host selection gate');
      modelCatalogResource = { path: catalogPath, sha256 };
    }
    await writeFile(join(agentEnvironment.PI_CODING_AGENT_DIR, 'models.json'), catalog, { mode: 0o600 });
    await expandPiModelCatalog(agentEnvironment);
    await chown(join(agentEnvironment.PI_CODING_AGENT_DIR, 'models.json'), AGENT_UID, AGENT_UID);
  } else {
    const version = spawnSync('setpriv', [...unprivileged, ...(quotaRequired ? [filesystemPolicy] : []), 'codex', '--version'],
      { cwd, env: agentEnvironment, timeout: 5_000, encoding: 'utf8' });
    if (version.status !== 0 || version.stdout.trim() !== 'codex-cli 0.172.0') throw startupContractError('Codex CLI version must be 0.172.0');
    executorVersion = '0.172.0';
    const configuration = [
      `model = ${JSON.stringify(input.codex.model)}`, 'model_provider = "murm"', 'approval_policy = "never"',
      'sandbox_mode = "danger-full-access"', 'web_search = "disabled"', 'check_for_update_on_startup = false',
      '[agents]', 'enabled = false', '[features]', 'multi_agent = false', 'multi_agent_v2 = false',
      'apps = false', 'plugins = false', 'remote_plugin = false', 'goals = false',
      'enable_request_compression = false', 'api_key_model_discovery = false',
      '[model_providers.murm]', 'name = "murm"', `base_url = ${JSON.stringify(input.codex.baseUrl)}`,
      'wire_api = "responses"', 'env_key = "OPENAI_API_KEY"', 'requires_openai_auth = false', 'supports_websockets = false',
    ].join('\n');
    await writeFile(join(agentEnvironment.CODEX_HOME!, 'config.toml'), `${configuration}\n`, { mode: 0o600 });
    await chown(join(agentEnvironment.CODEX_HOME!, 'config.toml'), AGENT_UID, AGENT_UID);
  }
  if (project.closing) throw new Error('Agent stopped during startup');
  child = spawn('setpriv', [...unprivileged, ...(quotaRequired ? [filesystemPolicy] : []), input.command, ...(executorKind === 'codex' ? ['app-server'] : input.args)],
    { cwd, env: agentEnvironment, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  executorLaunched = child.pid !== undefined;
  if (executorKind === 'codex') codexDriver = createCodexAppServerDriver({ model: input.codex.model, cwd,
    systemPrompt: input.system_prompt, isInputFenced: () => interrupting, write: message => child.stdin.write(`${JSON.stringify(message)}\n`), publish });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', processStdout);
  // Drain the private stderr pipe so a noisy process cannot block on it.
  child.stderr.resume();
  child.on('error', (error: any) => { codexDriver?.close(error); publish({ type: 'worker_error', message: error.message }); });
  child.on('close', (code: any, signal: any) => {
    codexDriver?.close();
    publish({ type: 'worker_exit', code, signal });
    child = null;
  });
  const nativeSession = await codexDriver?.ready;
  return { pid: child?.pid, ...(nativeSession ? { backend: { kind: 'codex', version: executorVersion, authMode: 'api-key', threadId: nativeSession.threadId } } : {}), contract: { version: input.contract_version, resources: input.resources },
    ...(projectQuota ? { project_quota: projectQuota } : {}),
    ...(projectFiles ? { project_files: projectFiles } : {}),
    ...(sharedWorkspace ? { shared_workspace: sharedWorkspace } : {}),
    ...(modelCatalogResource ? { model_catalog_resource: modelCatalogResource } : {}) };
}

async function interruptExecutor({ id, executionEpoch: nextEpoch }: { id: string; executionEpoch: number }, timeoutMs: number) {
  if (typeof id !== 'string' || !id || !Number.isSafeInteger(nextEpoch)) {
    throw Object.assign(new Error('Invalid interrupt identity'), { code: 'INVALID_CONTRACT' });
  }
  let entry = interruptions.get(id);
  if (entry && entry.epoch !== nextEpoch) throw Object.assign(new Error('Interrupt identity conflict'), { code: 'CONFLICT' });
  if (!entry) {
    if (interrupting || nextEpoch !== executionEpoch + 1 || project.closing) {
      throw Object.assign(new Error('Executor cannot interrupt this execution generation'), { code: 'NOT_ALLOWED' });
    }
    interrupting = true;
    executionEpoch = nextEpoch;
    const awaiting = [...preflights];
    const operation: InterruptOperation = { epoch: nextEpoch };
    entry = operation;
    interruptions.set(id, operation);
    const command = async (type: string) => {
      const commandId = randomUUID();
      await rpcSubmissions.submit({ type, id: commandId }, 10_000);
      await rpcSubmissions.completion(commandId);
      const { response } = rpcSubmissions.query(commandId);
      if (response.command !== type || !response.success) throw new Error('Executor did not confirm execution control');
      return response.data;
    };
    const discardedInputHashes: string[] = [];
    async function clearAndAbort() {
      const [queue] = await Promise.all([command('clear_queue'), command('abort')]);
      if (!queue || !Array.isArray(queue.steering) || !Array.isArray(queue.followUp)) return;
      for (const text of [...queue.steering, ...queue.followUp]) {
        if (typeof text === 'string') discardedInputHashes.push(createHash('sha256').update(text).digest('hex'));
      }
    }
    operation.done = (async () => {
      await clearAndAbort();
      // Prompt RPC preflight is asynchronous in Pi. If a previously written
      // prompt passes preflight after the first abort, drain it before opening
      // the fence to new input.
      if (awaiting.length) {
        await Promise.all(awaiting);
        await clearAndAbort();
      }
      interrupting = false;
      operation.response = { id, command: 'core_interrupt', success: true,
        ...(discardedInputHashes.length ? { data: { discardedInputHashes } } : {}) };
    })().catch(() => {
      operation.response = { id, command: 'core_interrupt', success: false };
    });
  }
  let timer;
  try {
    await Promise.race([entry.done, new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]);
    return entry.response ? { state: 'complete', response: entry.response } : { state: 'pending' };
  } finally { clearTimeout(timer); }
}

async function rpc(input: any): Promise<{ records: any[]; response?: any; state?: string }> {
  const message = input?.message ?? input;
  if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('worker RPC message must be an object');
  const queueOnly = message.type === 'steer' || message.type === 'follow_up';
  const isInput = message.type === 'prompt' || queueOnly;
  if (message.onlyWhileActive !== undefined && (!queueOnly || message.onlyWhileActive !== true || typeof message.id !== 'string' || !message.id)) {
    throw Object.assign(new Error('Invalid conditional input command'), { code: 'INVALID_CONTRACT' });
  }
  if (message.steeringMode !== undefined &&
      ((!['prompt', 'steer'].includes(message.type)) || !['all', 'one-at-a-time'].includes(message.steeringMode))) {
    throw Object.assign(new Error('Invalid prompt steering mode'), { code: 'INVALID_CONTRACT' });
  }
  // Core polls bounded Worker history from an explicit sequence without
  // sending a synthetic command to Pi.
  if (message.type === 'get_state' && Number.isFinite(Number(message.since))) {
    const since = Math.max(0, Number(message.since));
    return { records: records.filter((record: any) => record.worker_sequence > since) };
  }
  if (message.type === 'get_rpc_result') {
    return { ...rpcSubmissions.query(message.id), records: records.filter((record: any) => record.worker_sequence > Number(message.since ?? 0)) };
  }
  const beforeSequence = sequence;
  if (input.since !== undefined && (!Number.isSafeInteger(input.since) || input.since < 0)) {
    throw Object.assign(new Error('Worker replay cursor must be a nonnegative integer'), { code: 'INVALID_CONTRACT' });
  }
  const timeoutMs = Number(input.timeout_ms ?? 600_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
    throw Object.assign(new Error('Invalid Worker RPC wait limit'), { code: 'INVALID_CONTRACT' });
  }
  let result;
  if (message.type === 'core_interrupt') result = await interruptExecutor(message, timeoutMs);
  else if (isInput && (interrupting || (message.executionEpoch ?? 0) !== executionEpoch)) {
    result = { state: 'complete', response: { id: message.id, command: message.type, success: false,
      code: 'NOT_ALLOWED', error: 'Prompt is fenced by the current executor generation' } };
  } else {
    const pending = rpcSubmissions.submit(message, timeoutMs);
    if (isInput) {
      const completion = rpcSubmissions.completion(message.id);
      if (completion && !preflights.has(completion)) {
        preflights.add(completion);
        void completion.then(() => preflights.delete(completion));
      }
    }
    result = await pending;
  }
  return { ...result, records: records.filter(record => record.worker_sequence > (input.since ?? beforeSequence)) };
}

async function agentProcesses() {
  const pids: any[] = [];
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    let status;
    try { status = await readFile(`/proc/${name}/status`, 'utf8'); } catch (error: any) { if (['ENOENT', 'ESRCH'].includes(error.code)) continue; throw error; }
    const uid = Number(status.match(/^Uid:\s+(\d+)/m)?.[1]);
    if (uid === AGENT_UID && !/^State:\s+Z/m.test(status)) pids.push(Number(name));
  }
  return pids;
}

const heldWriters = new Set<number>();
let installHoldTimer: ReturnType<typeof setTimeout> | null = null;
const snapshotHolds = new Map<string, ReturnType<typeof setTimeout>>();
const releasedSnapshotHolds = new Set<string>();
function releaseSnapshotHold(id: string) {
  clearTimeout(snapshotHolds.get(id));
  snapshotHolds.delete(id);
}
function withAgentPaused<T>(operation: (paused: number[]) => T | Promise<T>) {
  const pending = writerGate.then(async () => {
    if (project.closing) throw new Error('Agent is closing');
    const paused = new Set<number>();
    let stable = 0;
    const deadline = Date.now() + 2000;
    try {
      while (stable < 2) {
        if (project.closing) throw new Error('Agent closed while pausing project writers');
        const pids = await agentProcesses();
        if (child?.pid && !pids.includes(child.pid)) pids.push(child.pid);
        let changed = false;
        for (const pid of pids) {
          if (!paused.has(pid)) {
            try { process.kill(pid, 'SIGSTOP'); paused.add(pid); changed = true; }
            catch (error: any) { if (error.code !== 'ESRCH') throw error; }
          }
        }
        let allStopped = true;
        for (const pid of pids) {
          try {
            const status = await readFile(`/proc/${pid}/status`, 'utf8');
            if (!/^State:\s+[TtZ]/m.test(status)) allStopped = false;
          } catch (error: any) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
        }
        stable = !changed && allStopped ? stable + 1 : 0;
        if (Date.now() >= deadline) throw Object.assign(new Error('Agent project writers could not be paused'), { code: 'WORKSPACE_BUSY' });
        await new Promise<any>((resolve: any) => setTimeout(resolve, 5));
      }
      const result = await operation([...paused]);
      if (project.closing) throw new Error('Agent closed during project operation');
      return { ...result, paused_process_count: paused.size };
    } finally {
      if (project.closing) await stopAgent();
      else if ((project.installPending || coreWorkDir?.installPending) || snapshotHolds.size) {
        for (const pid of paused) heldWriters.add(pid);
        if (project.installPending || coreWorkDir?.installPending) installHoldTimer ??= setTimeout(() => { void stopAgent().catch(() => undefined); }, 30_000);
      } else {
        clearTimeout(installHoldTimer ?? undefined); installHoldTimer = null;
        for (const pid of new Set([...paused, ...heldWriters])) {
          try { process.kill(pid, 'SIGCONT'); } catch (error: any) { if (error.code !== 'ESRCH') throw error; }
        }
        heldWriters.clear();
      }
    }
  });
  writerGate = pending.catch(() => undefined);
  return pending;
}

function stopAgent() {
  project.beginClose();
  clearTimeout(installHoldTimer ?? undefined); installHoldTimer = null;
  heldWriters.clear();
  for (const id of snapshotHolds.keys()) releaseSnapshotHold(id);
  if (stopping) return stopping;
  stopping = (async () => {
    if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch (error: any) { if (error.code !== 'ESRCH') throw error; } }
    const deadline = Date.now() + 5_000;
    while (true) {
      const pids = await agentProcesses();
      if (!pids.length) break;
      for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch (error: any) { if (error.code !== 'ESRCH') throw error; } }
      if (Date.now() >= deadline) throw new Error('Agent descendant stop was not confirmed');
      await new Promise<any>((resolve: any) => setTimeout(resolve, 10));
    }
    if (!initialized) { executionStopped = true; return { stopped: true, project_installs: [] }; }
    await coreWorkDir?.drain();
    await project.close();
    executionStopped = true;
    return { stopped: true, project_installs: await project.installReceipts() };
  })().catch((error: any) => { stopping = null; throw error; });
  return stopping;
}

function controlCoreFiles(action: any, input: any) {
  requireOpenWorkDir();
  if (!coreWorkDir || !child?.pid) throw Object.assign(new Error('Core file control requires a live Core Agent'), { code: 'NOT_ALLOWED' });
  return withAgentPaused(async (pids: number[]) => {
    try { return await coreWorkDir[action](input, pids); }
    catch (error: any) {
      if (action !== 'snapshot' && ['OPERATION_UNKNOWN', 'WORKSPACE_RECONCILIATION_REQUIRED'].includes(error.code)) project.beginClose();
      throw error;
    }
  });
}

const server = createServer(async (request: any, response: any) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  try {
    if (request.method === 'GET' && url.pathname === '/health') { send(response, 200, { ok: true, pid: child?.pid ?? null }); return; }
    if (!authorized(request)) { send(response, 401, { ok: false, error: 'worker authorization required' }); return; }
    if (request.method === 'POST' && url.pathname === '/start') { send(response, 200, { ok: true, result: await startAgent(await body(request, 32 * 1024 ** 2)) }); return; }
    if (request.method === 'POST' && ['/core/files/collect', '/core/session/archive'].includes(url.pathname)) {
      const sessionArchive = url.pathname === '/core/session/archive';
      if (!executionStopped || (!sessionArchive && !coreWorkDir)) throw Object.assign(new Error('Core collection requires confirmed stopped execution'), { code: 'NOT_ALLOWED' });
      const requested = await body(request);
      const input = sessionArchive ? { paths: ['.'], includeGit: false, required: true, maxBytes: Number.MAX_SAFE_INTEGER } : requested;
      const controller = new AbortController();
      const deadline = setTimeout(() => { controller.abort(); response.destroy(); }, sessionArchive ? 605_000 : 25_000);
      const disconnected = () => controller.abort();
      response.on('close', disconnected);
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      try {
        if (sessionArchive && !executorLaunched) {
          response.write(`${JSON.stringify({ type: 'end', totalBytes: 0, fileCount: 0, directoryCount: 0 })}\n`);
          return;
        }
        for await (const record of collectCoreWorkDir(sessionArchive ? join(RUNTIME_DIR, ...(executorKind === 'pi' ? ['pi-session'] : ['codex-home', 'sessions'])) : PROJECT_DIR, input, { signal: controller.signal, maxEntries: collectionMaxEntries, timeoutMs: sessionArchive ? 600_000 : 20_000 })) {
          if (!response.write(`${JSON.stringify(record)}\n`)) await once(response, 'drain', { signal: controller.signal });
        }
      } catch (error: any) {
        if (!response.destroyed) response.write(`${JSON.stringify({ type: 'error', code: error.code ?? 'SERVICE_UNAVAILABLE', message: error.message })}\n`);
      } finally {
        clearTimeout(deadline);
        response.off('close', disconnected);
        response.end();
      }
      return;
    }
    if (request.method === 'POST' && ['/core/files/install', '/core/files/confirm'].includes(url.pathname)) {
      send(response, 200, { ok: true, result: await controlCoreFiles(url.pathname.split('/').at(-1), await body(request, 32 * 1024 ** 2)) });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/core/files/prepare') {
      send(response, 200, { ok: true, result: await controlCoreFiles('prepare', await body(request, 32 * 1024 ** 2)) });
      return;
    }
    if (request.method === 'POST' && ['/core/files/pause', '/core/files/resume'].includes(url.pathname)) {
      const { requestId } = await body(request);
      if (typeof requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(requestId)) throw Object.assign(new Error('Capture fence requires requestId'), { code: 'INVALID_CONTRACT' });
      requireOpenWorkDir();
      if (!child?.pid) throw Object.assign(new Error('Capture fence requires a live Agent'), { code: 'NOT_ALLOWED' });
      const pause = url.pathname.endsWith('/pause');
      send(response, 200, { ok: true, result: await withAgentPaused(() => {
        if (pause) {
          if (releasedSnapshotHolds.has(requestId)) throw Object.assign(new Error('Snapshot fence was already released'), { code: 'CONFLICT' });
          if (!snapshotHolds.has(requestId)) snapshotHolds.set(requestId, setTimeout(() => {
            releaseSnapshotHold(requestId);
            releasedSnapshotHolds.add(requestId);
            void withAgentPaused(() => ({})).catch(() => undefined);
          }, 90_000));
        } else {
          releaseSnapshotHold(requestId);
          releasedSnapshotHolds.add(requestId);
        }
        return { requestId, paused: pause };
      }) });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/core/files/snapshot') {
      send(response, 200, { ok: true, result: await controlCoreFiles('snapshot', await body(request)) });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/core/files/grant') {
      send(response, 200, { ok: true, result: await controlCoreFiles('grant', await body(request)) });
      return;
    }
    if (url.pathname.startsWith('/project/') && !initialized) throw new Error('Agent workspace is not initialized');
    if (request.method === 'POST' && url.pathname === '/project/prepare') { send(response, 200, { ok: true, result: await project.prepare(await body(request, 32 * 1024 * 1024)) }); return; }
    if (request.method === 'POST' && url.pathname === '/project/grant') { const input = await body(request); send(response, 200, { ok: true, result: await withAgentPaused(() => project.grant(input)) }); return; }
    if (request.method === 'POST' && url.pathname === '/project/snapshot') { const input = await body(request); send(response, 200, { ok: true, result: await withAgentPaused(() => project.snapshot(input)) }); return; }
    if (request.method === 'POST' && url.pathname === '/project/install') { const input = await body(request, 32 * 1024 * 1024); send(response, 200, { ok: true, result: await withAgentPaused((pids: any) => project.install(input, pids)) }); return; }
    if (request.method === 'POST' && url.pathname === '/project/install-result') { const input = await body(request); send(response, 200, { ok: true, result: project.queryInstall(input) }); return; }
    if (request.method === 'POST' && url.pathname === '/project/install-confirm') { const input = await body(request); send(response, 200, { ok: true, result: await withAgentPaused(() => project.confirmInstall(input)) }); return; }
    if (request.method === 'POST' && url.pathname === '/core/session/snapshot') {
      requireOpenWorkDir();
      if (executorKind !== 'pi') throw Object.assign(new Error('Executor does not support cross-Sandbox Context Fork'), { code: 'NOT_ALLOWED' });
      if (!child || executionStopped) throw Object.assign(new Error('Context Fork source is unavailable'), { code: 'NOT_ALLOWED' });
      const result = await rpc({ message: { type: 'get_entries', id: `fork-${randomUUID()}` }, timeout_ms: 10_000 });
      requireOpenWorkDir();
      if (!child || executionStopped || result.response?.success !== true) throw Object.assign(new Error('Context Fork observation failed'), { code: 'NOT_ALLOWED' });
      send(response, 200, { ok: true, result: snapshotSessionFork(result.response.data, sessionPrivateValues) });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/rpc') { send(response, 200, { ok: true, result: await rpc(await body(request)) }); return; }
    if (request.method === 'POST' && url.pathname === '/stop') {
      await body(request);
      send(response, 200, { ok: true, result: await stopAgent() });
      return;
    }
    send(response, 404, { ok: false, error: 'unknown worker route' });
  } catch (error: any) {
    if (!response.writableEnded) send(response, 400, { ok: false, error: error.message, ...(['WORKSPACE_BUSY', 'WORKSPACE_RESULT_UNKNOWN', 'WORKSPACE_RECONCILIATION_REQUIRED', 'INVALID_CONTRACT', 'AGENT_STARTUP_CONTRACT', 'CONFLICT', 'NOT_ALLOWED', 'OPERATION_UNKNOWN'].includes(error.code) ? { code: error.code } : {}),
      ...(['dirty', 'active_writer'].includes(error.applyBlocker) ? { apply_blocker: error.applyBlocker } : {}) });
  }
});

server.listen(port, '0.0.0.0');
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  void stopAgent().finally(() => server.close(() => process.exit(0)));
});

#!/usr/bin/env node

import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, chown, chmod, readdir, lstat, realpath, statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { SandboxProject, BOT_UID, PROJECT_DIR, RUNTIME_DIR } from './sandbox-project.mjs';
import { createPiRpcSubmissions } from './pi-rpc-submissions.mjs';

const argv = process.argv.slice(2);
function option(name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] ?? fallback : fallback;
}
const port = Number(option('--port', process.env.SWARMENV_WORKER_PORT ?? 44100));
const token = option('--token', process.env.SWARMENV_WORKER_TOKEN) ?? randomUUID();
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('worker port must be an integer from 1 to 65535');

const project = new SandboxProject();
const quotaRequired = argv.includes('--require-project-quota');
const catalogPath = '/opt/swarmenv/pi-agent/models.json';
const filesystemPolicy = '/opt/swarmenv/bot-filesystem-policy';
const unprivileged = ['--reuid', String(BOT_UID), '--regid', String(BOT_UID), '--clear-groups', '--no-new-privs',
  '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all', '--'];
let initialized = !quotaRequired;
if (initialized) await project.initialize();
let everStarted = false;
let stopping = null;
let writerGate = Promise.resolve();
let child = null;
let stdoutBuffer = '';
let sequence = 0;
const records = [];
const MAX_RECORDS = 2_048;
const subscribers = new Set();
const rpcSubmissions = createPiRpcSubmissions({ write(message) {
  if (!child?.stdin?.writable) throw Object.assign(new Error('worker Agent is not running'), { code: 'NOT_ALLOWED' });
  child.stdin.write(`${JSON.stringify(message)}\n`);
} });

function authorized(request) {
  return request.headers.authorization === `Bearer ${token}`;
}

function send(response, status, body) {
  const text = JSON.stringify(body ?? null);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
  response.end(text);
}

async function body(request, maxBytes = 2 * 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('worker request body is too large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function publish(record) {
  const value = { ...record, worker_sequence: ++sequence };
  records.push(value);
  if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
  for (const response of subscribers) response.write(`data: ${JSON.stringify(value)}\n\n`);
  rpcSubmissions.observe(value);
  return value;
}

async function expandPiModelCatalog(environment) {
  const agentDir = environment.PI_CODING_AGENT_DIR;
  if (typeof agentDir !== 'string' || !agentDir.startsWith('/')) return;
  const catalogPath = `${agentDir}/models.json`;
  let source;
  try { source = JSON.parse(await readFile(catalogPath, 'utf8')); } catch { return; }
  const expand = (value) => {
    if (Array.isArray(value)) return value.map(expand);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)]));
    if (typeof value !== 'string') return value;
    const match = value.match(/^\$([A-Z_][A-Z0-9_]*)$/);
    return match && typeof environment[match[1]] === 'string' ? environment[match[1]] : value;
  };
  await writeFile(catalogPath, `${JSON.stringify(expand(source), null, 2)}\n`, { mode: 0o600 });
}

function processStdout(chunk) {
  stdoutBuffer += chunk.toString();
  while (true) {
    const newline = stdoutBuffer.indexOf('\n');
    if (newline < 0) return;
    const line = stdoutBuffer.slice(0, newline).replace(/\r$/, '');
    stdoutBuffer = stdoutBuffer.slice(newline + 1);
    if (!line) continue;
    try { publish(JSON.parse(line)); } catch { publish({ type: 'worker_stdout', text: line }); }
  }
}

function startupContractError(message) {
  return Object.assign(new Error(message), { code: 'BOT_STARTUP_CONTRACT' });
}

async function readPinnedStartupPath(operation, path) {
  try {
    return await operation(path);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      throw startupContractError('Pinned Bot startup resource is missing from the image');
    }
    throw error;
  }
}

async function startAgent(input) {
  if (everStarted || project.closing) throw new Error('worker Bot cannot start another Agent');
  if (!Array.isArray(input.args) || !input.args.every((value) => typeof value === 'string')) throw new Error('worker args must be a string array');
  if (typeof input.command !== 'string' || !input.command) throw new Error('worker command is required');
  const cwd = input.cwd ?? PROJECT_DIR;
  if (cwd !== PROJECT_DIR) throw new Error('worker project cwd must be /workspace/project');
  everStarted = true;
  let projectQuota = null;
  if (quotaRequired) {
    const { bytes, inodes } = input.project_quota ?? {};
    if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(inodes) || bytes <= 0 || inodes <= 0) throw startupContractError('Bot workspace quota is required');
    const filesystem = await statfs('/workspace', { bigint: true });
    const mounts = (await readFile('/proc/self/mountinfo', 'utf8')).trim().split('\n');
    const mount = mounts.findLast(row => row.split(' ')[4] === '/workspace')?.split(' ');
    if (mounts.some(row => row.split(' ')[4]?.startsWith('/workspace/')) || filesystem.type !== 0x01021994n || filesystem.blocks * filesystem.bsize !== BigInt(bytes) ||
        filesystem.files !== BigInt(inodes) || !mount?.[5]?.split(',').includes('nodev') ||
        !mount[5].split(',').includes('nosuid') || (await readdir('/workspace')).length) throw startupContractError('Bot workspace quota is absent or mismatched');
    const probe = spawnSync('setpriv', [...unprivileged, filesystemPolicy, '/usr/bin/true'], { cwd: '/', timeout: 2_000 });
    if (probe.error?.code === 'ENOENT' || (Number.isInteger(probe.status) && probe.status !== 0)) {
      throw startupContractError('Bot filesystem policy could not be enforced');
    }
    if (probe.status !== 0) throw new Error('Bot filesystem policy probe did not complete');
    if (project.closing) throw new Error('Bot stopped during filesystem validation');
    await project.initialize();
    initialized = true;
    projectQuota = { bytes, inodes };
  } else if (input.project_quota) throw startupContractError('Worker must start in quota enforcement mode');
  const core = input.contract_version === 'swarmenv-core-v1';
  if (core && (input.command !== 'pi' || typeof input.system_prompt !== 'string' || input.system_prompt_path !== `${RUNTIME_DIR}/profile-prompt.txt`)) throw startupContractError('Core startup requires direct Pi and an explicit role prompt');
  const solver = input.contract_version === 'swarm-solver-v1';
  const expectedNames = core ? [] : solver ? ['solver-system.txt'] : ['system.txt', 'plan-task.md', 'use-material.md', 'use-workspace.md', 'finish-task.md'];
  if ((!core && !solver && input.contract_version !== 'swarm-bot-v1-draft.3') || !Array.isArray(input.resources) || input.resources.length !== expectedNames.length ||
      new Set(input.resources.map(resource => resource?.path)).size !== expectedNames.length ||
      !expectedNames.every(name => input.resources.some(resource => resource?.path === `/opt/swarmenv/src/agent/bot-contract/${name}`))) throw startupContractError('complete versioned Bot contract resources are required');
  for (const resource of input.resources) {
    if (!/^\/opt\/swarmenv\/src\/agent\/bot-contract\/(solver-system\.txt|system\.txt|(?:plan-task|use-material|use-workspace|finish-task)\.md)$/.test(resource.path ?? '')) throw startupContractError('unsupported Bot contract resource');
    const info = await readPinnedStartupPath(lstat, resource.path);
    if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) || !(info.mode & 0o004) || await readPinnedStartupPath(realpath, resource.path) !== resource.path) throw startupContractError('Bot contract resource must be immutable to the Bot');
    for (let parent = dirname(resource.path); parent !== '/'; parent = dirname(parent)) {
      const directory = await readPinnedStartupPath(lstat, parent);
      if (!directory.isDirectory() || directory.uid !== 0 || (directory.mode & 0o022) || !(directory.mode & 0o001)) throw startupContractError('Bot contract parent must be protected and traversable');
    }
    const sha256 = createHash('sha256').update(await readPinnedStartupPath(readFile, resource.path)).digest('hex');
    if (sha256 !== resource.sha256) throw startupContractError('Bot contract resource does not match the pinned version');
  }
  if (project.closing) throw new Error('Bot stopped during resource validation');
  for (const path of ['home', 'tmp', 'pi-agent', 'pi-session']) {
    await mkdir(join(RUNTIME_DIR, path), { recursive: true });
    await chown(join(RUNTIME_DIR, path), BOT_UID, BOT_UID);
  }
  if (input.system_prompt_path && (typeof input.system_prompt_path !== 'string' || !input.system_prompt_path.startsWith(`${RUNTIME_DIR}/`) || input.system_prompt_path.split('/').includes('..'))) throw new Error('worker system prompt path must stay inside /workspace');
  if (input.system_prompt_path && typeof input.system_prompt === 'string') {
    await mkdir(dirname(input.system_prompt_path), { recursive: true });
    await writeFile(input.system_prompt_path, input.system_prompt, { mode: 0o600 });
    await chown(input.system_prompt_path, BOT_UID, BOT_UID);
  }
  if (core && input.writable === true) {
    await chown(PROJECT_DIR, BOT_UID, BOT_UID);
    await chmod(PROJECT_DIR, 0o755);
  }
  const suppliedEnv = { ...(input.env ?? {}), ...(input.secret_env ?? {}) };
  delete suppliedEnv.SWARMENV_WORKER_TOKEN;
  const agentEnvironment = { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', ...suppliedEnv,
    HOME: join(RUNTIME_DIR, 'home'), TMPDIR: join(RUNTIME_DIR, 'tmp'), PI_CODING_AGENT_DIR: join(RUNTIME_DIR, 'pi-agent') };
  const catalog = await readPinnedStartupPath(readFile, catalogPath);
  let modelCatalogResource = null;
  if (input.model_catalog_resource) {
    const sha256 = createHash('sha256').update(catalog).digest('hex');
    if (input.model_catalog_resource.path !== catalogPath || input.model_catalog_resource.sha256 !== sha256) throw startupContractError('Pi model catalog does not match the host selection gate');
    modelCatalogResource = { path: catalogPath, sha256 };
  }
  await writeFile(join(agentEnvironment.PI_CODING_AGENT_DIR, 'models.json'), catalog, { mode: 0o600 });
  await expandPiModelCatalog(agentEnvironment);
  await chown(join(agentEnvironment.PI_CODING_AGENT_DIR, 'models.json'), BOT_UID, BOT_UID);
  if (project.closing) throw new Error('Bot stopped during startup');
  child = spawn('setpriv', [...unprivileged, ...(quotaRequired ? [filesystemPolicy] : []), input.command, ...input.args],
    { cwd, env: agentEnvironment, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.on('data', processStdout);
  child.stderr.on('data', (chunk) => { for (const response of subscribers) response.write(`event: stderr\ndata: ${JSON.stringify({ text: chunk.toString() })}\n\n`); });
  child.on('error', (error) => publish({ type: 'worker_error', message: error.message }));
  child.on('close', (code, signal) => {
    publish({ type: 'worker_exit', code, signal });
    for (const response of subscribers) response.end();
    subscribers.clear();
    child = null;
  });
  return { pid: child.pid, contract: { version: input.contract_version, resources: input.resources },
    ...(projectQuota ? { project_quota: projectQuota } : {}),
    ...(modelCatalogResource ? { model_catalog_resource: modelCatalogResource } : {}) };
}

async function rpc(input) {
  const message = input?.message ?? input;
  if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('worker RPC message must be an object');
  // Transport recovery asks for the bounded record history that accumulated
  // while the SSE endpoint was unavailable.  Keep this read local to the
  // worker so the caller can replay from an explicit sequence without
  // sending a synthetic command to Pi.
  if (message.type === 'get_state' && Number.isFinite(Number(message.since))) {
    const since = Math.max(0, Number(message.since));
    return { records: records.filter((record) => record.worker_sequence > since) };
  }
  if (message.type === 'get_rpc_result') {
    return { ...rpcSubmissions.query(message.id), records: records.filter(record => record.worker_sequence > Number(message.since ?? 0)) };
  }
  const beforeSequence = sequence;
  if (input.since !== undefined && (!Number.isSafeInteger(input.since) || input.since < 0)) {
    throw Object.assign(new Error('Worker replay cursor must be a nonnegative integer'), { code: 'INVALID_CONTRACT' });
  }
  const result = await rpcSubmissions.submit(message, Number(input.timeout_ms ?? 600_000));
  return { ...result, records: records.filter(record => record.worker_sequence > (input.since ?? beforeSequence)) };
}

async function botProcesses() {
  const pids = [];
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    let status;
    try { status = await readFile(`/proc/${name}/status`, 'utf8'); } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) continue; throw error; }
    const uid = Number(status.match(/^Uid:\s+(\d+)/m)?.[1]);
    if (uid === BOT_UID && !/^State:\s+Z/m.test(status)) pids.push(Number(name));
  }
  return pids;
}

const heldWriters = new Set();
let installHoldTimer = null;
function withBotPaused(operation) {
  const pending = writerGate.then(async () => {
    if (project.closing) throw new Error('Bot is closing');
    const paused = new Set();
    let stable = 0;
    const deadline = Date.now() + 2000;
    try {
      while (stable < 2) {
        if (project.closing) throw new Error('Bot closed while pausing project writers');
        const pids = await botProcesses();
        if (child?.pid && !pids.includes(child.pid)) pids.push(child.pid);
        let changed = false;
        for (const pid of pids) {
          if (!paused.has(pid)) {
            try { process.kill(pid, 'SIGSTOP'); paused.add(pid); changed = true; }
            catch (error) { if (error.code !== 'ESRCH') throw error; }
          }
        }
        let allStopped = true;
        for (const pid of pids) {
          try {
            const status = await readFile(`/proc/${pid}/status`, 'utf8');
            if (!/^State:\s+[TtZ]/m.test(status)) allStopped = false;
          } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
        }
        stable = !changed && allStopped ? stable + 1 : 0;
        if (Date.now() >= deadline) throw Object.assign(new Error('Bot project writers could not be paused'), { code: 'WORKSPACE_BUSY' });
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      const result = await operation([...paused]);
      if (project.closing) throw new Error('Bot closed during project operation');
      return { ...result, paused_process_count: paused.size };
    } finally {
      if (project.closing) await stopBot();
      else if (project.installPending) {
        for (const pid of paused) heldWriters.add(pid);
        installHoldTimer ??= setTimeout(() => { void stopBot().catch(() => undefined); }, 30_000);
      } else {
        clearTimeout(installHoldTimer); installHoldTimer = null;
        for (const pid of new Set([...paused, ...heldWriters])) {
          try { process.kill(pid, 'SIGCONT'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
        heldWriters.clear();
      }
    }
  });
  writerGate = pending.catch(() => undefined);
  return pending;
}

function stopBot() {
  project.beginClose();
  clearTimeout(installHoldTimer); installHoldTimer = null;
  heldWriters.clear();
  if (stopping) return stopping;
  stopping = (async () => {
    if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    const deadline = Date.now() + 5_000;
    while (true) {
      const pids = await botProcesses();
      if (!pids.length) break;
      for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
      if (Date.now() >= deadline) throw new Error('Bot descendant stop was not confirmed');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (!initialized) return { stopped: true, project_installs: [] };
    await project.close();
    return { stopped: true, project_installs: await project.installReceipts() };
  })().catch(error => { stopping = null; throw error; });
  return stopping;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  try {
    if (request.method === 'GET' && url.pathname === '/health') { send(response, 200, { ok: true, pid: child?.pid ?? null }); return; }
    if (!authorized(request)) { send(response, 401, { ok: false, error: 'worker authorization required' }); return; }
    if (request.method === 'POST' && url.pathname === '/start') { send(response, 200, { ok: true, result: await startAgent(await body(request)) }); return; }
    if (url.pathname.startsWith('/project/') && !initialized) throw new Error('Bot workspace is not initialized');
    if (request.method === 'POST' && url.pathname === '/project/prepare') { send(response, 200, { ok: true, result: await project.prepare(await body(request, 32 * 1024 * 1024)) }); return; }
    if (request.method === 'POST' && url.pathname === '/project/grant') { const input = await body(request); send(response, 200, { ok: true, result: await withBotPaused(() => project.grant(input)) }); return; }
    if (request.method === 'POST' && url.pathname === '/project/snapshot') { const input = await body(request); send(response, 200, { ok: true, result: await withBotPaused(() => project.snapshot(input)) }); return; }
    if (request.method === 'POST' && url.pathname === '/project/install') { const input = await body(request, 32 * 1024 * 1024); send(response, 200, { ok: true, result: await withBotPaused(pids => project.install(input, pids)) }); return; }
    if (request.method === 'POST' && url.pathname === '/project/install-result') { const input = await body(request); send(response, 200, { ok: true, result: project.queryInstall(input) }); return; }
    if (request.method === 'POST' && url.pathname === '/project/install-confirm') { const input = await body(request); send(response, 200, { ok: true, result: await withBotPaused(() => project.confirmInstall(input)) }); return; }
    if (request.method === 'POST' && url.pathname === '/rpc') { send(response, 200, { ok: true, result: await rpc(await body(request)) }); return; }
    if (request.method === 'POST' && url.pathname === '/stop') {
      await body(request);
      send(response, 200, { ok: true, result: await stopBot() });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
      subscribers.add(response);
      const since = Number.parseInt(url.searchParams.get('since') ?? '0', 10) || 0;
      for (const record of records) if (record.worker_sequence > since) response.write(`data: ${JSON.stringify(record)}\n\n`);
      request.on('close', () => subscribers.delete(response));
      return;
    }
    send(response, 404, { ok: false, error: 'unknown worker route' });
  } catch (error) {
    if (!response.writableEnded) send(response, 400, { ok: false, error: error.message, ...(['WORKSPACE_BUSY', 'WORKSPACE_RESULT_UNKNOWN', 'WORKSPACE_RECONCILIATION_REQUIRED', 'INVALID_CONTRACT', 'BOT_STARTUP_CONTRACT', 'CONFLICT', 'NOT_ALLOWED'].includes(error.code) ? { code: error.code } : {}),
      ...(['dirty', 'active_writer'].includes(error.applyBlocker) ? { apply_blocker: error.applyBlocker } : {}) });
  }
});

server.listen(port, '0.0.0.0');
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  void stopBot().finally(() => server.close(() => process.exit(0)));
});

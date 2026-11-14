#!/usr/bin/env node

import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, chown, readdir, lstat, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { SandboxProject, BOT_UID, PROJECT_DIR, RUNTIME_DIR } from './sandbox-project.mjs';

const argv = process.argv.slice(2);
function option(name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] ?? fallback : fallback;
}
const port = Number(option('--port', process.env.SWARMENV_WORKER_PORT ?? 44100));
const token = option('--token', process.env.SWARMENV_WORKER_TOKEN) ?? randomUUID();
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('worker port must be an integer from 1 to 65535');

const project = new SandboxProject();
await project.initialize();
let everStarted = false;
let stopping = null;
let writerGate = Promise.resolve();
let child = null;
let stdoutBuffer = '';
let sequence = 0;
const records = [];
const MAX_RECORDS = 2_048;
const subscribers = new Set();
const pending = new Map();
const rpcResults = new Map();
const MAX_RPC_RESULTS = 256;

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
  if (value.type === 'response' && value.id && pending.has(value.id)) {
    const waiters = pending.get(value.id);
    pending.delete(value.id);
    for (const waiter of waiters) waiter(value);
  }
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

async function startAgent(input) {
  if (everStarted || project.closing) throw new Error('worker Bot cannot start another Agent');
  if (!Array.isArray(input.args) || !input.args.every((value) => typeof value === 'string')) throw new Error('worker args must be a string array');
  if (typeof input.command !== 'string' || !input.command) throw new Error('worker command is required');
  const cwd = input.cwd ?? PROJECT_DIR;
  if (cwd !== PROJECT_DIR) throw new Error('worker project cwd must be /workspace/project');
  everStarted = true;
  const expectedNames = ['system.txt', 'plan-task.md', 'use-material.md', 'use-workspace.md', 'finish-task.md'];
  if (input.contract_version !== 'swarm-bot-v1-draft.2' || !Array.isArray(input.resources) || input.resources.length !== 5 ||
      new Set(input.resources.map(resource => resource.path)).size !== 5 ||
      !expectedNames.every(name => input.resources.some(resource => resource.path === `/opt/swarmenv/src/agent/bot-contract/${name}`))) throw new Error('complete versioned Bot contract resources are required');
  for (const resource of input.resources) {
    if (!/^\/opt\/swarmenv\/src\/agent\/bot-contract\/(system\.txt|(?:plan-task|use-material|use-workspace|finish-task)\.md)$/.test(resource.path ?? '')) throw new Error('unsupported Bot contract resource');
    const info = await lstat(resource.path);
    if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) || !(info.mode & 0o004) || await realpath(resource.path) !== resource.path) throw new Error('Bot contract resource must be immutable to the Bot');
    for (let parent = dirname(resource.path); parent !== '/'; parent = dirname(parent)) {
      const directory = await lstat(parent);
      if (!directory.isDirectory() || directory.uid !== 0 || (directory.mode & 0o022) || !(directory.mode & 0o001)) throw new Error('Bot contract parent must be protected and traversable');
    }
    const sha256 = createHash('sha256').update(await readFile(resource.path)).digest('hex');
    if (sha256 !== resource.sha256) throw new Error('Bot contract resource does not match the pinned version');
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
  const suppliedEnv = { ...(input.env ?? {}), ...(input.secret_env ?? {}) };
  delete suppliedEnv.SWARMENV_WORKER_TOKEN;
  const agentEnvironment = { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', ...suppliedEnv,
    HOME: join(RUNTIME_DIR, 'home'), TMPDIR: join(RUNTIME_DIR, 'tmp'), PI_CODING_AGENT_DIR: join(RUNTIME_DIR, 'pi-agent') };
  const catalog = await readFile('/opt/swarmenv/pi-agent/models.json');
  await writeFile(join(agentEnvironment.PI_CODING_AGENT_DIR, 'models.json'), catalog, { mode: 0o600 });
  await expandPiModelCatalog(agentEnvironment);
  await chown(join(agentEnvironment.PI_CODING_AGENT_DIR, 'models.json'), BOT_UID, BOT_UID);
  if (project.closing) throw new Error('Bot stopped during startup');
  child = spawn('setpriv', ['--reuid', String(BOT_UID), '--regid', String(BOT_UID), '--clear-groups', '--no-new-privs',
    '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all', '--', input.command, ...input.args],
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
  return { pid: child.pid, contract: { version: input.contract_version, resources: input.resources } };
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
  if (!child?.stdin?.writable) throw new Error('worker Agent is not running');
  const id = message.id ?? null;
  if (id && rpcResults.has(id)) return rpcResults.get(id);
  const beforeSequence = sequence;
  child.stdin.write(`${JSON.stringify(message)}\n`);
  if (!id) return { records: records.filter((record) => record.worker_sequence > beforeSequence) };
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const waiters = pending.get(id) ?? [];
      pending.set(id, waiters.filter((waiter) => waiter !== resolve));
      reject(new Error(`timed out waiting for Pi RPC response: ${message.type ?? 'command'}`));
    }, Number(input.timeout_ms ?? 600_000));
    const waiter = (record) => { clearTimeout(timer); resolve(record); };
    pending.set(id, [...(pending.get(id) ?? []), waiter]);
  });
  const result = { records: records.filter((record) => record.worker_sequence > beforeSequence), response };
  rpcResults.set(id, result);
  if (rpcResults.size > MAX_RPC_RESULTS) rpcResults.delete(rpcResults.keys().next().value);
  return result;
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
      const result = await operation();
      if (project.closing) throw new Error('Bot closed during project operation');
      return { ...result, paused_process_count: paused.size };
    } finally {
      if (project.closing) await stopBot();
      else for (const pid of paused) {
        try { process.kill(pid, 'SIGCONT'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    }
  });
  writerGate = pending.catch(() => undefined);
  return pending;
}

function stopBot() {
  project.beginClose();
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
    await project.close();
    return { stopped: true };
  })().catch(error => { stopping = null; throw error; });
  return stopping;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  try {
    if (request.method === 'GET' && url.pathname === '/health') { send(response, 200, { ok: true, pid: child?.pid ?? null }); return; }
    if (!authorized(request)) { send(response, 401, { ok: false, error: 'worker authorization required' }); return; }
    if (request.method === 'POST' && url.pathname === '/start') { send(response, 200, { ok: true, result: await startAgent(await body(request)) }); return; }
    if (request.method === 'POST' && url.pathname === '/project/prepare') { send(response, 200, { ok: true, result: await project.prepare(await body(request)) }); return; }
    if (request.method === 'POST' && url.pathname === '/project/grant') { const input = await body(request); send(response, 200, { ok: true, result: await withBotPaused(() => project.grant(input)) }); return; }
    if (request.method === 'POST' && url.pathname === '/project/snapshot') { const input = await body(request); send(response, 200, { ok: true, result: await withBotPaused(() => project.snapshot(input)) }); return; }
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
    if (!response.writableEnded) send(response, 400, { ok: false, error: error.message, ...(error.code === 'WORKSPACE_BUSY' ? { code: error.code } : {}) });
  }
});

server.listen(port, '0.0.0.0');
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  void stopBot().finally(() => server.close(() => process.exit(0)));
});

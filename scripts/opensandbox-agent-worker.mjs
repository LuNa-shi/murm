#!/usr/bin/env node

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const argv = process.argv.slice(2);
function option(name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] ?? fallback : fallback;
}
const port = Number(option('--port', process.env.SWARMENV_WORKER_PORT ?? 44100));
const token = option('--token', process.env.SWARMENV_WORKER_TOKEN) ?? randomUUID();
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('worker port must be an integer from 1 to 65535');

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
  if (child) throw new Error('worker Agent is already started');
  if (!Array.isArray(input.args) || !input.args.every((value) => typeof value === 'string')) throw new Error('worker args must be a string array');
  if (typeof input.command !== 'string' || !input.command) throw new Error('worker command is required');
  const cwd = input.cwd ?? '/workspace';
  if (typeof cwd !== 'string' || !(cwd === '/workspace' || cwd.startsWith('/workspace/')) || cwd.split('/').includes('..')) throw new Error('worker cwd must stay inside /workspace');
  if (input.system_prompt_path && (typeof input.system_prompt_path !== 'string' || !(input.system_prompt_path === '/workspace' || input.system_prompt_path.startsWith('/workspace/')) || input.system_prompt_path.split('/').includes('..'))) throw new Error('worker system prompt path must stay inside /workspace');
  if (input.system_prompt_path && typeof input.system_prompt === 'string') {
    await mkdir(dirname(input.system_prompt_path), { recursive: true });
    await writeFile(input.system_prompt_path, input.system_prompt, { mode: 0o600 });
  }
  const childEnv = { ...process.env };
  delete childEnv.SWARMENV_WORKER_TOKEN;
  const suppliedEnv = { ...(input.env ?? {}), ...(input.secret_env ?? {}) };
  delete suppliedEnv.SWARMENV_WORKER_TOKEN;
  const agentEnvironment = { ...childEnv, ...suppliedEnv };
  await expandPiModelCatalog(agentEnvironment);
  child = spawn(input.command, input.args, { cwd, env: agentEnvironment, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.on('data', processStdout);
  child.stderr.on('data', (chunk) => { for (const response of subscribers) response.write(`event: stderr\ndata: ${JSON.stringify({ text: chunk.toString() })}\n\n`); });
  child.on('error', (error) => publish({ type: 'worker_error', message: error.message }));
  child.on('close', (code, signal) => {
    publish({ type: 'worker_exit', code, signal });
    for (const response of subscribers) response.end();
    subscribers.clear();
    child = null;
  });
  return { pid: child.pid };
}

async function rpc(input) {
  if (!child?.stdin?.writable) throw new Error('worker Agent is not running');
  const message = input?.message ?? input;
  if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('worker RPC message must be an object');
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

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  try {
    if (request.method === 'GET' && url.pathname === '/health') { send(response, 200, { ok: true, pid: child?.pid ?? null }); return; }
    if (!authorized(request)) { send(response, 401, { ok: false, error: 'worker authorization required' }); return; }
    if (request.method === 'POST' && url.pathname === '/start') { send(response, 200, { ok: true, result: await startAgent(await body(request)) }); return; }
    if (request.method === 'POST' && url.pathname === '/rpc') { send(response, 200, { ok: true, result: await rpc(await body(request)) }); return; }
    if (request.method === 'POST' && url.pathname === '/stop') {
      if (child) child.kill((await body(request)).signal ?? 'SIGTERM');
      send(response, 200, { ok: true });
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
    if (!response.writableEnded) send(response, 400, { ok: false, error: error.message });
  }
});

server.listen(port, '0.0.0.0');
process.on('SIGTERM', () => { child?.kill('SIGTERM'); server.close(() => process.exit(0)); });
process.on('SIGINT', () => { child?.kill('SIGINT'); server.close(() => process.exit(0)); });

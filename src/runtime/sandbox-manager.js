import { createHash, randomUUID } from 'node:crypto';
import { spawn as defaultSpawn } from 'node:child_process';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { ERROR_CODES, SwarmEnvError } from '../errors.js';

const JOB_DIR = '/tmp/swarmenv-jobs';
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const MAX_COMMAND_TIMEOUT_MS = 60 * 60_000;
const MAX_COMMAND_CHARS = 32 * 1024;
const SAFE_ENVIRONMENT = new Set(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR']);
const SECRET_ENVIRONMENT = /(token|secret|passwd|password|api_?key|credential|private_?key)/i;

function required(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} is required`);
  return value;
}

function within(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function safeName(executionId) {
  const digest = createHash('sha256').update(executionId).digest('hex').slice(0, 10);
  return `swarmenv-${String(executionId).replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 48)}-${digest}`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function containerCwd(value) {
  const cwd = value ?? '/workspace';
  if (typeof cwd !== 'string' || !cwd.startsWith('/workspace') || cwd.split('/').includes('..')) {
    throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'sandbox cwd must stay inside /workspace', { cwd });
  }
  return cwd;
}

function normalizeEnvironment(env) {
  if (env === undefined || env === null) return {};
  if (typeof env !== 'object' || Array.isArray(env)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'sandbox env must be an object');
  const entries = {};
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `sandbox env key is invalid: ${key}`);
    // Never copy deployment credentials into a task command. A research
    // Execution has no business holding model/service secrets.
    if (SECRET_ENVIRONMENT.test(key) && !SAFE_ENVIRONMENT.has(key)) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `sandbox env key is not allowed: ${key}`);
    }
    if (typeof value !== 'string' || value.length > 4096) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `sandbox env value is invalid: ${key}`);
    entries[key] = value;
  }
  return entries;
}

function normalizeCommand(command) {
  if (typeof command === 'string') {
    if (command.trim().length === 0 || command.length > MAX_COMMAND_CHARS) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'sandbox command must be non-empty and bounded');
    return { kind: 'shell', command };
  }
  if (Array.isArray(command) && command.length > 0 && command.every((part) => typeof part === 'string')) {
    const joined = command.join(' ');
    if (joined.length > MAX_COMMAND_CHARS) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'sandbox command is too long');
    return { kind: 'argv', command };
  }
  throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'sandbox command must be a shell string or a non-empty string array');
}

/**
 * Local container Sandbox for one Execution at a time.
 *
 * The private Workspace is mounted at /workspace. The container runs as a
 * non-root user with a read-only root filesystem, no host sensitive mounts,
 * no Docker socket, and an explicit network mode. Every command is bounded by
 * timeout, output size, CPU, memory, and process limits. Jobs are owned by the
 * Execution and are killed when the Execution is released.
 */
export class ContainerSandboxManager {
  constructor({
    dockerCommand = 'docker',
    image,
    imageDigest = null,
    workspaceRoot,
    allowedReadOnlyRoots = [],
    network = 'none',
    user = '1000:1000',
    memory = '2g',
    cpus = 2,
    pidsLimit = 256,
    tmpfsSize = '256m',
    commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    spawnProcess = defaultSpawn,
    logger = null,
    now = () => Date.now(),
  } = {}) {
    required(image, 'image');
    required(workspaceRoot, 'workspaceRoot');
    if (!Array.isArray(allowedReadOnlyRoots)) throw new TypeError('allowedReadOnlyRoots must be an array');
    if (!['none', 'bridge', 'host'].includes(network) && !/^[A-Za-z0-9_.-]+$/.test(network)) throw new TypeError('network must be none, bridge, host, or a named network');
    if (!Number.isFinite(commandTimeoutMs) || commandTimeoutMs <= 0) throw new TypeError('commandTimeoutMs must be positive');
    if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1024) throw new TypeError('maxOutputBytes must be at least 1024');
    this.dockerCommand = dockerCommand;
    this.image = image;
    this.imageDigest = imageDigest;
    this.workspaceRoot = resolve(workspaceRoot);
    this.allowedReadOnlyRoots = allowedReadOnlyRoots.map((root) => resolve(root));
    this.network = network;
    this.user = user;
    this.memory = memory;
    this.cpus = cpus;
    this.pidsLimit = pidsLimit;
    this.tmpfsSize = tmpfsSize;
    this.commandTimeoutMs = commandTimeoutMs;
    this.maxOutputBytes = maxOutputBytes;
    this.spawnProcess = spawnProcess;
    this.logger = logger;
    this.now = now;
    this.executions = new Map();
    this.verified = null;
  }

  async preflight({ timeoutMs = 20_000 } = {}) {
    const result = await this.#docker(['image', 'inspect', '--format', '{{.Id}}', this.image], { timeoutMs });
    if (result.timed_out || result.exit_code !== 0) {
      throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, `sandbox image is not available: ${this.image}`, { image: this.image, exit_code: result.exit_code, diagnostic: result.stderr.slice(0, 500) });
    }
    const imageId = result.stdout.trim();
    if (this.imageDigest && !imageId.includes(this.imageDigest.replace(/^sha256:/, '')) && imageId !== this.imageDigest) {
      throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'sandbox image digest does not match the pinned digest', { image: this.image, expected: this.imageDigest, observed: imageId });
    }
    this.verified = { image: this.image, image_id: imageId, verified_at: this.now() };
    this.logger?.({ event: 'sandbox.preflight', image: this.image, image_id: imageId });
    return { ...this.verified, ok: true };
  }

  async ensureExecution({ executionId, workspaceRef, bindingVersion = null, readOnlyMounts = [] } = {}) {
    const id = required(executionId, 'execution_id');
    const workspace = resolve(required(workspaceRef, 'workspace_ref'));
    if (!within(this.workspaceRoot, workspace)) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'sandbox Workspace is outside the configured root', { execution_id: id });
    const info = await stat(workspace).catch(() => null);
    if (!info?.isDirectory()) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'sandbox Workspace does not exist', { execution_id: id });
    const existing = this.executions.get(id);
    if (existing) return this.#snapshot(existing);
    const mounts = [];
    for (const mount of Array.isArray(readOnlyMounts) ? readOnlyMounts : []) {
      const source = resolve(required(mount?.source, 'readOnlyMounts.source'));
      const destination = mount?.destination ?? `/inputs/${mounts.length}`;
      if (!this.allowedReadOnlyRoots.some((root) => within(root, source))) {
        throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'sandbox read-only mount is outside the approved roots', { source });
      }
      if (!destination.startsWith('/inputs/') || destination.split('/').includes('..')) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'sandbox read-only destination must be under /inputs', { destination });
      }
      mounts.push(`type=bind,src=${source},dst=${destination},readonly`);
    }
    const name = safeName(id);
    await this.#docker(['rm', '-f', name], { timeoutMs: 20_000 }).catch(() => undefined);
    const args = [
      'run', '--detach', '--name', name,
      '--label', `swarmenv.execution_id=${id}`,
      '--label', `swarmenv.binding_version=${bindingVersion ?? ''}`,
      '--user', this.user,
      '--workdir', '/workspace',
      '--mount', `type=bind,src=${workspace},dst=/workspace`,
      ...mounts.flatMap((mount) => ['--mount', mount]),
      '--network', this.network,
      '--memory', this.memory,
      '--cpus', String(this.cpus),
      '--pids-limit', String(this.pidsLimit),
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--read-only',
      '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=${this.tmpfsSize}`,
      this.image,
      '/bin/sh', '-c', 'while :; do sleep 3600; done',
    ];
    const result = await this.#docker(args, { timeoutMs: 60_000 });
    if (result.timed_out || result.exit_code !== 0) {
      throw new SwarmEnvError(ERROR_CODES.START_FAILED, 'could not start the sandbox container', { execution_id: id, exit_code: result.exit_code, diagnostic: result.stderr.slice(0, 500) });
    }
    const record = {
      executionId: id,
      containerId: result.stdout.trim(),
      containerName: name,
      workspaceRef: workspace,
      bindingVersion,
      createdAt: this.now(),
      jobs: new Map(),
    };
    this.executions.set(id, record);
    this.logger?.({ event: 'sandbox.started', execution_id: id, container_id: record.containerId, binding_version: bindingVersion });
    return this.#snapshot(record);
  }

  async exec({ executionId, command, cwd = '/workspace', timeoutMs = this.commandTimeoutMs, env = {}, background = false } = {}) {
    const record = this.#record(executionId);
    const normalized = normalizeCommand(command);
    const workdir = containerCwd(cwd);
    const timeout = this.#timeout(timeoutMs);
    const environment = { HOME: '/tmp', PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', ...normalizeEnvironment(env) };
    const jobId = randomUUID();
    const script = this.#jobScript(jobId, normalized);
    const args = ['exec', '--workdir', workdir, ...Object.entries(environment).flatMap(([key, value]) => ['--env', `${key}=${value}`])];
    if (background) args.push('--detach');
    args.push(record.containerName, '/bin/sh', '-lc', script);
    const startedAt = this.now();
    const job = { jobId, executionId: record.executionId, command: normalized.kind === 'shell' ? normalized.command : normalized.command.join(' '), started_at: startedAt, background, state: background ? 'running' : 'running', cancelled: false };
    record.jobs.set(jobId, job);
    const result = await this.#docker(args, { timeoutMs: background ? Math.min(timeout, 30_000) : timeout });
    if (background) {
      if (result.exit_code !== 0 || result.timed_out) {
        record.jobs.delete(jobId);
        throw new SwarmEnvError(ERROR_CODES.START_FAILED, 'could not start sandbox job', { execution_id: record.executionId, job_id: jobId, exit_code: result.exit_code });
      }
      job.state = 'running';
      return this.#jobView(job);
    }
    if (result.timed_out) {
      await this.cancelJob(record.executionId, jobId, { reason: 'timeout' }).catch(() => undefined);
      job.state = 'timed_out';
    } else {
      job.state = 'completed';
      job.exit_code = result.exit_code;
    }
    job.finished_at = this.now();
    job.stdout = result.stdout;
    job.stderr = result.stderr;
    this.logger?.({ event: 'sandbox.exec', execution_id: record.executionId, job_id: jobId, exit_code: result.exit_code, timed_out: result.timed_out, duration_ms: job.finished_at - startedAt });
    return {
      execution_id: record.executionId,
      job_id: jobId,
      binding_version: record.bindingVersion,
      exit_code: result.exit_code,
      timed_out: result.timed_out,
      truncated: result.truncated,
      duration_ms: job.finished_at - startedAt,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  async jobStatus(executionId, jobId) {
    const record = this.#record(executionId);
    const job = record.jobs.get(jobId);
    if (!job) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown sandbox job: ${jobId}`, { execution_id: executionId, job_id: jobId });
    if (job.state !== 'running' && job.state !== 'cancelled') return this.#jobView(job);
    const result = await this.#docker(['exec', record.containerName, '/bin/sh', '-lc', `cat ${JOB_DIR}/${jobId}.exit 2>/dev/null || true`], { timeoutMs: 10_000 });
    const exit = Number.parseInt(result.stdout.trim(), 10);
    if (Number.isInteger(exit)) {
      job.state = 'completed';
      job.exit_code = exit;
      job.finished_at = this.now();
    }
    return this.#jobView(job);
  }

  async cancelJob(executionId, jobId, { reason = 'cancelled' } = {}) {
    const record = this.#record(executionId);
    const job = record.jobs.get(jobId);
    if (!job) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown sandbox job: ${jobId}`, { execution_id: executionId, job_id: jobId });
    if (job.state !== 'running') return this.#jobView(job);
    await this.#docker(['exec', record.containerName, '/bin/sh', '-lc', `if [ -f ${JOB_DIR}/${jobId}.pgid ]; then kill -TERM -$(cat ${JOB_DIR}/${jobId}.pgid) 2>/dev/null || true; fi`], { timeoutMs: 10_000 }).catch(() => undefined);
    job.state = 'cancelled';
    job.cancel_reason = reason;
    job.finished_at = this.now();
    return this.#jobView(job);
  }

  async stopExecution(executionId) {
    const record = this.executions.get(executionId);
    if (!record) return false;
    for (const job of record.jobs.values()) {
      if (job.state === 'running') await this.cancelJob(executionId, job.jobId, { reason: 'execution_released' }).catch(() => undefined);
    }
    await this.#docker(['rm', '-f', record.containerName], { timeoutMs: 20_000 }).catch(() => undefined);
    this.executions.delete(executionId);
    this.logger?.({ event: 'sandbox.stopped', execution_id: executionId, container_id: record.containerId });
    return true;
  }

  async stopAll() {
    for (const executionId of [...this.executions.keys()]) await this.stopExecution(executionId);
  }

  snapshot() {
    return {
      image: this.image,
      image_digest: this.imageDigest,
      verified: this.verified,
      network: this.network,
      executions: [...this.executions.values()].map((record) => this.#snapshot(record)),
    };
  }

  #snapshot(record) {
    return {
      execution_id: record.executionId,
      container_id: record.containerId,
      binding_version: record.bindingVersion,
      workspace: '/workspace',
      jobs: [...record.jobs.values()].map((job) => this.#jobView(job)),
    };
  }

  #jobView(job) {
    return {
      job_id: job.jobId,
      execution_id: job.executionId,
      state: job.state,
      exit_code: job.exit_code ?? null,
      timed_out: job.state === 'timed_out',
      cancel_reason: job.cancel_reason ?? null,
      started_at: job.started_at,
      finished_at: job.finished_at ?? null,
      command: job.command,
    };
  }

  #record(executionId) {
    const record = this.executions.get(executionId);
    if (!record) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'sandbox is not bound to this Execution', { execution_id: executionId });
    return record;
  }

  #timeout(value) {
    if (value === undefined || value === null) return this.commandTimeoutMs;
    if (!Number.isFinite(value) || value <= 0 || value > MAX_COMMAND_TIMEOUT_MS) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `sandbox timeout must be between 1 and ${MAX_COMMAND_TIMEOUT_MS} ms`, { timeout_ms: value });
    }
    return value;
  }

  #jobScript(jobId, normalized) {
    const inner = normalized.kind === 'shell'
      ? `sh -lc ${shellQuote(normalized.command)}`
      : normalized.command.map(shellQuote).join(' ');
    return [
      `mkdir -p ${JOB_DIR}`,
      `setsid /bin/sh -c 'echo $$ > ${JOB_DIR}/${jobId}.pgid; exec ${inner.replaceAll("'", "'\\''")}'`,
      `code=$?`,
      `echo $code > ${JOB_DIR}/${jobId}.exit`,
    ].join('; ');
  }

  async #docker(args, { timeoutMs = 30_000 } = {}) {
    return new Promise((resolvePromise) => {
      let child;
      try {
        child = this.spawnProcess(this.dockerCommand, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        resolvePromise({ exit_code: null, stdout: '', stderr: error.message, timed_out: false, truncated: false });
        return;
      }
      let stdout = '';
      let stderr = '';
      let truncated = false;
      let timedOut = false;
      const collect = (current, chunk) => {
        if (current.length >= this.maxOutputBytes) { truncated = true; return current; }
        const next = current + chunk.toString();
        if (next.length > this.maxOutputBytes) { truncated = true; return next.slice(0, this.maxOutputBytes); }
        return next;
      };
      child.stdout?.on('data', (chunk) => { stdout = collect(stdout, chunk); });
      child.stderr?.on('data', (chunk) => { stderr = collect(stderr, chunk); });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill?.('SIGKILL');
      }, timeoutMs);
      child.on('error', (error) => {
        clearTimeout(timer);
        resolvePromise({ exit_code: null, stdout, stderr: `${stderr}${error.message}`, timed_out: timedOut, truncated });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolvePromise({ exit_code: code, stdout, stderr, timed_out: timedOut, truncated });
      });
    });
  }
}

export function createContainerSandboxManager(options = {}) {
  return new ContainerSandboxManager(options);
}

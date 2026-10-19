import { mkdir } from 'node:fs/promises';
import { spawn as defaultSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { ERROR_CODES, SwarmEnvError } from '../errors.js';
import { createVersionManifest } from './version-manifest.js';

function required(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `${name} is required`);
  }
  return value;
}

const PROVIDER_ARG_PLACEMENT = Object.freeze({ openai: 'pi', kimi: 'nurouter' });

export function resolveAgentCoreRoute({ provider, account, group } = {}) {
  if (!Object.hasOwn(PROVIDER_ARG_PLACEMENT, provider)) {
    throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unsupported NuRouter/Pi provider: ${provider}`);
  }
  const placement = PROVIDER_ARG_PLACEMENT[provider];
  if (provider === 'openai' && account && group) {
    throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'OpenAI NuRouter routing cannot set both account and group');
  }
  return placement;
}

export class AgentCoreSession extends EventEmitter {
  constructor(child, { executionId, launchArgs, manifest, logger = null }) {
    super();
    this.child = child;
    this.executionId = executionId;
    this.launchArgs = launchArgs;
    this.manifest = manifest;
    this.logger = logger;
    this.stdout = '';
    this.stderr = '';
    this.closed = false;
    this.expectedStop = false;
    this.processError = null;
    this.exitResult = null;
    this.rpcBuffer = '';
    this.rpcRecords = [];
    this.pendingRpc = new Map();
    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      this.stdout += text;
      this.logger?.append({ type: 'stdout', text });
      this.emit('stdout', text);
      this.#consumeRpc(text);
    });
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      this.stderr += text;
      this.logger?.append({ type: 'stderr', text });
      this.emit('stderr', text);
    });
    child.on('error', (error) => {
      this.processError = new SwarmEnvError(ERROR_CODES.PROCESS_EXITED, `Pi process error: ${error.message}`, undefined, { cause: error });
      this.emit('processError', this.processError);
    });
    child.on('close', (code, signal) => {
      this.closed = true;
      this.exitResult = { code, signal, stdout: this.stdout, stderr: this.stderr };
      for (const pending of this.pendingRpc.values()) {
        clearTimeout(pending.timer);
        pending.reject(new SwarmEnvError(ERROR_CODES.PROCESS_EXITED, 'Pi RPC session closed before responding'));
      }
      this.pendingRpc.clear();
      this.emit('close', this.exitResult);
    });
  }

  sendRpc(message) {
    if (this.closed || !this.child.stdin?.writable) {
      throw new SwarmEnvError(ERROR_CODES.RPC_ERROR, 'Pi RPC session is not writable');
    }
    try {
      this.logger?.append({ type: 'rpc_request', message });
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      throw new SwarmEnvError(ERROR_CODES.RPC_ERROR, `could not write Pi RPC request: ${error.message}`, undefined, { cause: error });
    }
  }

  sendCommand(command, { timeoutMs = 30_000 } = {}) {
    const id = command.id ?? `rpc-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRpc.delete(id);
        reject(new SwarmEnvError(ERROR_CODES.RPC_ERROR, `timed out waiting for Pi RPC response: ${command.type}`));
      }, timeoutMs);
      this.pendingRpc.set(id, { resolve, reject, timer });
      try {
        this.sendRpc({ ...command, id });
      } catch (error) {
        clearTimeout(timer);
        this.pendingRpc.delete(id);
        reject(error);
      }
    });
  }

  prompt(message, { timeoutMs = 30_000, images, streamingBehavior } = {}) {
    const command = { type: 'prompt', message };
    if (images !== undefined) command.images = images;
    if (streamingBehavior !== undefined) command.streamingBehavior = streamingBehavior;
    return this.sendCommand(command, { timeoutMs });
  }

  async waitForSettled({ timeoutMs = 120_000, afterSequence = this.rpcRecords.length } = {}) {
    const existing = this.rpcRecords.slice(afterSequence).find((record) => record.type === 'agent_settled');
    if (existing) return existing;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('rpc', onRecord);
        this.off('close', onClose);
        reject(new SwarmEnvError(ERROR_CODES.RPC_ERROR, 'timed out waiting for Pi agent_settled event'));
      }, timeoutMs);
      const finish = (error = null, value = null) => {
        clearTimeout(timer);
        this.off('rpc', onRecord);
        this.off('close', onClose);
        if (error) reject(error);
        else resolve(value);
      };
      const onRecord = (record) => {
        if (record.type !== 'agent_settled') return;
        finish(null, record);
      };
      const onClose = () => finish(new SwarmEnvError(ERROR_CODES.PROCESS_EXITED, 'Pi RPC session closed before agent_settled event'));
      this.on('rpc', onRecord);
      this.once('close', onClose);
    });
  }

  async wait() {
    const [result] = this.closed ? [this.exitResult] : await once(this, 'close');
    if (this.processError) throw this.processError;
    if (!this.expectedStop && (result.code !== 0 || result.signal !== null)) {
      throw new SwarmEnvError(ERROR_CODES.PROCESS_EXITED, 'Pi process exited unexpectedly', result);
    }
    return result;
  }

  async waitForReady({ timeoutMs = 10_000 } = {}) {
    if (this.rpcRecords.some((record) => record.type === 'ready') || this.stdout.split('\n').some((line) => line.includes('"type":"ready"'))) return;
    // Pi 1.3.0 does not emit a standalone ready record. A successful state
    // response is the protocol-level readiness signal for this adapter.
    const id = `ready-${randomUUID()}`;
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error = null) => {
        if (settled) return;
        settled = true;
        this.off('rpc', onRecord);
        const pending = this.pendingRpc.get(id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRpc.delete(id);
        }
        if (error) reject(error);
        else resolve();
      };
      const onRecord = (record) => {
        if (record.type === 'ready' || (record.type === 'response' && record.id === id)) finish();
      };
      this.on('rpc', onRecord);
      this.sendCommand({ id, type: 'get_state' }, { timeoutMs }).catch((error) => finish(error));
    });
  }

  stop(signal = 'SIGTERM') {
    if (!this.closed) {
      this.expectedStop = true;
      this.child.kill(signal);
    }
  }

  #consumeRpc(text) {
    this.rpcBuffer += text;
    while (true) {
      const newline = this.rpcBuffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.rpcBuffer.slice(0, newline).replace(/\r$/, '');
      this.rpcBuffer = this.rpcBuffer.slice(newline + 1);
      if (!line) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      this.rpcRecords.push(record);
      this.logger?.append({ type: 'rpc_record', record });
      if (record.type === 'response' && record.id && this.pendingRpc.has(record.id)) {
        const pending = this.pendingRpc.get(record.id);
        this.pendingRpc.delete(record.id);
        clearTimeout(pending.timer);
        if (record.success === false) {
          pending.reject(new SwarmEnvError(ERROR_CODES.RPC_ERROR, record.error ?? 'Pi RPC command failed', record));
        } else {
          pending.resolve(record);
        }
      }
      this.emit('rpc', record);
    }
  }
}

export class AgentCoreAdapter {
  constructor({
    command = 'nurouter',
    provider,
    model,
    account,
    group,
    sessionDir,
    extensionPath,
    cwd,
    env = process.env,
    spawnProcess = defaultSpawn,
    manifestVersions = {},
  } = {}) {
    this.command = command;
    this.config = { provider, model, account, group, sessionDir, extensionPath, cwd, env };
    this.spawnProcess = spawnProcess;
    this.manifestVersions = manifestVersions;
  }

  buildLaunchArgs({ executionId, sessionDir = this.config.sessionDir } = {}) {
    required(executionId, 'execution_id');
    for (const [name, value] of Object.entries({
      provider: this.config.provider,
      model: this.config.model,
      sessionDir,
    })) required(value, name);
    const placement = resolveAgentCoreRoute(this.config);
    const modelArgs = ['--provider', this.config.provider, '--model', this.config.model];
    const nuRouterModelArgs = placement === 'nurouter' ? modelArgs : [];
    const piModelArgs = placement === 'pi' ? modelArgs : [];
    const args = ['pi', ...nuRouterModelArgs];
    if (this.config.account) args.push('--account', this.config.account);
    if (this.config.group) args.push('--group', this.config.group);
    args.push(
      '--',
      '--mode', 'rpc',
      '--session-dir', sessionDir,
      '--session-id', executionId,
      ...(this.config.extensionPath ? ['--extension', this.config.extensionPath] : []),
      ...piModelArgs,
    );
    return args;
  }

  async start({ executionId, sessionDir = this.config.sessionDir, cwd = this.config.cwd, agentPrompt = null, logger = null } = {}) {
    const launchArgs = this.buildLaunchArgs({ executionId, sessionDir });
    await mkdir(sessionDir, { recursive: true });
    const manifest = await createVersionManifest({ ...this.manifestVersions, launchArgs });
    let child;
    try {
      child = this.spawnProcess(this.command, launchArgs, {
        cwd,
        env: { ...this.config.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new SwarmEnvError(ERROR_CODES.START_FAILED, `could not start NuRouter: ${error.message}`, undefined, { cause: error });
    }
    await new Promise((resolve, reject) => {
      const onSpawn = () => {
        child.off('error', onError);
        resolve();
      };
      const onError = (error) => {
        child.off('spawn', onSpawn);
        reject(new SwarmEnvError(ERROR_CODES.START_FAILED, `NuRouter/Pi failed to start: ${error.message}`, undefined, { cause: error }));
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    });
    const session = new AgentCoreSession(child, { executionId, launchArgs, manifest, logger });
    if (agentPrompt) {
      await session.waitForReady({ timeoutMs: 30_000 });
      await session.prompt(agentPrompt, { timeoutMs: 30_000 });
    }
    return session;
  }
}

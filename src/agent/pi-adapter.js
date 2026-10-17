import { mkdir } from 'node:fs/promises';
import { spawn as defaultSpawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { ERROR_CODES, SwarmEnvError } from '../errors.js';
import { createVersionManifest } from './version-manifest.js';

function required(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `${name} is required`);
  }
  return value;
}

export class AgentCoreSession extends EventEmitter {
  constructor(child, { executionId, launchArgs, manifest }) {
    super();
    this.child = child;
    this.executionId = executionId;
    this.launchArgs = launchArgs;
    this.manifest = manifest;
    this.stdout = '';
    this.stderr = '';
    this.closed = false;
    child.stdout?.on('data', (chunk) => {
      this.stdout += chunk.toString();
      this.emit('stdout', chunk.toString());
    });
    child.stderr?.on('data', (chunk) => {
      this.stderr += chunk.toString();
      this.emit('stderr', chunk.toString());
    });
    child.on('error', (error) => this.emit('error', new SwarmEnvError(ERROR_CODES.PROCESS_EXITED, `Pi process error: ${error.message}`, undefined, { cause: error })));
    child.on('close', (code, signal) => {
      this.closed = true;
      this.emit('close', { code, signal, stdout: this.stdout, stderr: this.stderr });
    });
  }

  sendRpc(message) {
    if (this.closed || !this.child.stdin?.writable) {
      throw new SwarmEnvError(ERROR_CODES.RPC_ERROR, 'Pi RPC session is not writable');
    }
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      throw new SwarmEnvError(ERROR_CODES.RPC_ERROR, `could not write Pi RPC request: ${error.message}`, undefined, { cause: error });
    }
  }

  async wait() {
    if (this.closed) return { stdout: this.stdout, stderr: this.stderr };
    const [result] = await once(this, 'close');
    return result;
  }

  async waitForReady({ timeoutMs = 10_000 } = {}) {
    if (this.stdout.split('\n').some((line) => line.includes('"type":"ready"'))) return;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('stdout', onOutput);
        reject(new SwarmEnvError(ERROR_CODES.RPC_ERROR, 'timed out waiting for Pi RPC ready signal'));
      }, timeoutMs);
      const onOutput = (chunk) => {
        if (chunk.split('\n').some((line) => line.includes('"type":"ready"'))) {
          clearTimeout(timer);
          this.off('stdout', onOutput);
          resolve();
        }
      };
      this.on('stdout', onOutput);
    });
  }

  stop(signal = 'SIGTERM') {
    if (!this.closed) this.child.kill(signal);
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
    cwd,
    env = process.env,
    spawnProcess = defaultSpawn,
    manifestVersions = {},
  } = {}) {
    this.command = command;
    this.config = { provider, model, account, group, sessionDir, cwd, env };
    this.spawnProcess = spawnProcess;
    this.manifestVersions = manifestVersions;
  }

  buildLaunchArgs({ executionId, sessionDir = this.config.sessionDir } = {}) {
    required(executionId, 'execution_id');
    for (const [name, value] of Object.entries({
      provider: this.config.provider,
      model: this.config.model,
      account: this.config.account,
      group: this.config.group,
      sessionDir,
    })) required(value, name);
    return [
      'pi',
      '--provider', this.config.provider,
      '--model', this.config.model,
      '--account', this.config.account,
      '--group', this.config.group,
      '--',
      '--mode', 'rpc',
      '--session-dir', sessionDir,
      '--session-id', executionId,
    ];
  }

  async start({ executionId, sessionDir = this.config.sessionDir } = {}) {
    const launchArgs = this.buildLaunchArgs({ executionId, sessionDir });
    await mkdir(sessionDir, { recursive: true });
    const manifest = await createVersionManifest({ ...this.manifestVersions, launchArgs });
    let child;
    try {
      child = this.spawnProcess(this.command, launchArgs, {
        cwd: this.config.cwd,
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
    return new AgentCoreSession(child, { executionId, launchArgs, manifest });
  }
}

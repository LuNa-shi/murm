import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { projectError } from './project-input.js';
import { readRpcLines } from './project-rpc-lines.js';
import { MAX_COMMAND_BYTES } from './foreground-commands.js';
import type {
  HarnessDescriptor, HarnessEvent, HarnessResult, HarnessSession, HarnessState,
} from './harness-session-types.js';

export interface HarnessRpcTransport extends Pick<EventEmitter, 'on' | 'off'> {
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly exitCode?: number | null;
  readonly signalCode?: NodeJS.Signals | null;
}

export interface HarnessRpcReady {
  readonly type: 'ready';
  readonly version: 'v1';
  readonly harness: { readonly id: string; readonly apiVersion: 1 };
  readonly status: HarnessState;
  readonly descriptor: HarnessDescriptor;
}

export interface HarnessRpcClientOptions {
  timeoutMs?: number;
}

type Pending = {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: NodeJS.Timeout;
};

type Subscription = { handler: (event: HarnessEvent) => void; initializing: boolean };

export class HarnessRpcClient implements HarnessSession {
  readonly ready: Promise<HarnessRpcReady>;
  readonly agents: HarnessSession['agents'];
  readonly #ready = Promise.withResolvers<HarnessRpcReady>();
  readonly #result = Promise.withResolvers<HarnessResult>();
  readonly #pending = new Map<string, Pending>();
  readonly #listeners = new Set<Subscription>();
  readonly #stdin: Writable;
  readonly #timeout: number;
  readonly #prefix = randomUUID();
  #next = 0;
  #started = false;
  #failure?: Error;

  constructor(transport: HarnessRpcTransport, options: HarnessRpcClientOptions = {}) {
    const { stdin, stdout } = transport;
    if (!stdin || !stdout) throw projectError('INVALID_REQUEST', 'RPC requires piped input and output');
    this.#stdin = stdin;
    this.#timeout = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.#timeout) || this.#timeout < 1 || this.#timeout > 2_147_483_647) {
      throw projectError('INVALID_REQUEST', 'RPC timeout must be a finite positive integer');
    }
    this.ready = this.#ready.promise;
    // Transport failure may happen while no caller is awaiting readiness or completion.
    void this.ready.catch(() => {});
    void this.#result.promise.catch(() => {});
    const disconnected = () => this.#disconnect(projectError('RPC_DISCONNECTED', 'RPC transport closed'));
    const malformed = () => this.#disconnect(projectError('RPC_PROTOCOL_ERROR', 'Invalid RPC record'));
    const detach = readRpcLines(stdout, 8 * 1024 * 1024, {
      line: line => {
        try { this.#record(JSON.parse(line)); }
        catch { malformed(); }
      },
      invalid: malformed,
      end: disconnected,
      error: disconnected,
    });
    const closed = () => {
      detached();
      disconnected();
    };
    const detached = () => {
      detach();
      transport.off('close', closed);
      transport.off('error', disconnected);
      stdin.off('error', disconnected);
    };
    transport.on('close', closed);
    transport.on('error', disconnected);
    stdin.on('error', disconnected);
    const timer = setTimeout(() => this.#disconnect(projectError('RPC_TIMEOUT', 'RPC readiness was not confirmed')), this.#timeout);
    void this.ready.then(() => clearTimeout(timer), () => clearTimeout(timer));
    if (transport.exitCode != null || transport.signalCode != null || stdout.readableEnded || stdin.destroyed) closed();

    this.agents = Object.freeze<HarnessSession['agents']>({
      getState: agentId => this.#call('agent.getState', { agentId }),
      getStats: agentId => this.#call('agent.getStats', { agentId }),
      getMessages: (agentId, options) => this.#call('agent.getMessages', { agentId, options }),
      configure: (agentId, patch, request) => this.#call('agent.configure', { agentId, patch }, request.requestId),
      compact: (agentId, { requestId, ...options }) => this.#call('agent.compact', { agentId, options }, requestId),
      abortRetry: (agentId, { requestId, ...options }) => this.#call('agent.abortRetry', { agentId, options }, requestId),
      clearQueue: (agentId, { requestId, ...options }) => this.#call('agent.clearQueue', { agentId, options }, requestId),
      send: (agentId, input, { requestId, ...options }) => this.#call('agent.send', { agentId, input, options }, requestId),
      interrupt: (agentId, { requestId, ...options }) => this.#call('agent.interrupt', { agentId, options }, requestId),
      stop: (agentId, { requestId, ...options }) => this.#call('agent.stop', { agentId, options }, requestId),
    });
  }

  describe(): ReturnType<HarnessSession['describe']> {
    return this.#call('describe');
  }

  async start(...[input, request]: Parameters<HarnessSession['start']>) {
    const receipt = await this.#call<Awaited<ReturnType<HarnessSession['start']>>>('run', input, request.requestId);
    this.#started = true;
    return receipt;
  }

  input(...[input, request]: Parameters<HarnessSession['input']>): ReturnType<HarnessSession['input']> {
    return this.#call('input', input, request.requestId);
  }

  respond(...[questionId, answer, request]: Parameters<HarnessSession['respond']>): ReturnType<HarnessSession['respond']> {
    return this.#call('answer', { questionId, answer }, request.requestId);
  }

  getState(): ReturnType<HarnessSession['getState']> {
    return this.#call('status');
  }

  stop(...[{ requestId, reason }]: Parameters<HarnessSession['stop']>): ReturnType<HarnessSession['stop']> {
    return this.#call('stop', reason === undefined ? undefined : { reason }, requestId);
  }

  get completion() {
    return this.#started ? this.#result.promise : undefined;
  }

  onEvent(handler: (event: HarnessEvent) => void, options?: { initialSnapshot?: boolean }) {
    if (typeof handler !== 'function') throw projectError('INVALID_REQUEST', 'Expected an event handler');
    if (this.#listeners.size >= 64) throw projectError('REQUEST_LIMIT', 'RPC listener limit reached');
    if (this.#failure) throw this.#failure;
    const subscription = { handler, initializing: options?.initialSnapshot === true };
    this.#listeners.add(subscription);
    if (subscription.initializing) {
      // Deliver at the status reply in the frame parser, before the next event
      // in the same chunk. Frames ahead of that reply are covered by its state.
      void this.#call<HarnessState>('status', undefined, undefined, state => {
        if (!this.#listeners.has(subscription)) return;
        subscription.initializing = false;
        this.#deliver(subscription, { type: 'snapshot', state });
      }).catch(() => this.#listeners.delete(subscription));
    }
    return () => { this.#listeners.delete(subscription); };
  }

  #deliver(subscription: Subscription, event: HarnessEvent) {
    try {
      // Async consumers cannot block incoming frames or reject the transport.
      void Promise.resolve(subscription.handler(structuredClone(event))).catch(() => {});
    } catch { /* One consumer cannot affect other subscriptions. */ }
  }

  #disconnect(error: Error) {
    if (this.#failure) return;
    this.#failure = error;
    this.#ready.reject(error);
    this.#result.reject(projectError('RPC_RESULT_UNKNOWN', 'RPC closed before a final result was confirmed'));
    for (const { reject, timer } of this.#pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.#pending.clear();
    this.#listeners.clear();
  }

  #record(record: any) {
    if (this.#failure) return;
    if (!record || typeof record !== 'object') throw new Error('Invalid RPC record');
    switch (record.type) {
      case 'ready':
        if (record.version !== 'v1' || !record.harness || !record.status || !record.descriptor) throw new Error('Invalid RPC handshake');
        this.#started ||= typeof record.status.runId === 'string';
        this.#ready.resolve(record);
        break;
      case 'reply':
      case 'error': {
        const pending = this.#pending.get(record.id);
        if (!pending) break;
        this.#pending.delete(record.id);
        clearTimeout(pending.timer);
        if (record.type === 'reply') pending.resolve(record.result);
        else pending.reject(projectError(record.code, 'Harness RPC request failed'));
        break;
      }
      case 'event': {
        if (!record.event || typeof record.event !== 'object') throw new Error('Invalid RPC event');
        for (const subscription of [...this.#listeners]) {
          if (!subscription.initializing && this.#listeners.has(subscription)) this.#deliver(subscription, record.sessionEvent ?? record);
        }
        break;
      }
      case 'result':
        if (!record.result || typeof record.result !== 'object') throw new Error('Invalid RPC result');
        this.#started = true;
        this.#result.resolve(record.result);
        for (const subscription of [...this.#listeners]) {
          if (!subscription.initializing && this.#listeners.has(subscription)) {
            this.#deliver(subscription, { type: 'result', result: record.result });
          }
        }
        break;
      default:
        throw new Error('Invalid RPC record type');
    }
  }

  async #call<T>(operation: string, input?: unknown, requestId?: string, atReply?: (value: T) => void): Promise<T> {
    await this.ready;
    if (this.#failure) throw this.#failure;
    if (this.#pending.size >= 256 || this.#stdin.writableLength >= 262_144) {
      throw projectError('REQUEST_LIMIT', 'RPC client request limit reached');
    }
    const id = this.#prefix + ':' + (++this.#next);
    const line = JSON.stringify({ id, operation, input, requestId }) + '\n';
    if (Buffer.byteLength(line) > MAX_COMMAND_BYTES + 1) throw projectError('INVALID_REQUEST', 'RPC request line is too large');
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(projectError(requestId === undefined ? 'RPC_TIMEOUT' : 'OPERATION_UNKNOWN', 'RPC reply deadline expired'));
      }, this.#timeout);
      this.#pending.set(id, {
        timer, reject,
        resolve(value) {
          atReply?.(value as T);
          resolve(value as T);
        },
      });
      this.#stdin.write(line, error => {
        if (error) this.#disconnect(projectError('RPC_DISCONNECTED', 'RPC request transport failed'));
      });
    });
  }
}

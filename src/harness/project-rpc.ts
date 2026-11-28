import type { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { stableStringify } from '../protocol/stable-json.js';
import { MAX_COMMAND_BYTES } from './foreground-commands.js';
import {
  captureHarnessSnapshot, failureCode, getHarnessExitCode, harnessSessionSignal, stopHarnessTransport,
  type HarnessInput, type HarnessJson,
} from './project-harness.js';
import { projectError, resolveHarnessInput } from './project-input.js';
import { readRpcLines } from './project-rpc-lines.js';
import type { HarnessEvent, HarnessSession } from './harness-session-types.js';

type Writer = (record: unknown) => Promise<void>;
type ParametersObject = Record<string, unknown>;
type RpcRequest = { id: string; operation: string; input?: HarnessJson; requestId?: string };
type QueryReceipt = { fingerprint: string; reply: Promise<unknown> };

const queryOperations = new Set(['status', 'describe', 'agent.getState', 'agent.getStats', 'agent.getMessages']);
const mutationOperations = new Set([
  'run', 'input', 'answer', 'stop', 'agent.configure', 'agent.compact',
  'agent.abortRetry', 'agent.clearQueue', 'agent.send', 'agent.interrupt', 'agent.stop',
]);

const validId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 128 && id.isWellFormed();

function named(value: unknown, keys: readonly string[]): ParametersObject {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) {
    throw projectError('INVALID_REQUEST', 'Invalid fields for this RPC operation');
  }
  return value as ParametersObject;
}

function optional(value: unknown, keys: readonly string[]): ParametersObject {
  return value === undefined ? {} : named(value, keys);
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw projectError('INVALID_REQUEST', 'Expected a nonempty string');
  return value;
}

function validateRequest(value: unknown): RpcRequest {
  const request = named(value, ['id', 'operation', 'input', 'requestId']);
  const { id, operation, input, requestId } = request;
  if (!validId(id) || typeof operation !== 'string' ||
      (!queryOperations.has(operation) && !mutationOperations.has(operation)) ||
      (requestId !== undefined && (!validId(requestId) || queryOperations.has(operation)))) {
    throw projectError('INVALID_REQUEST', 'Expected a request id and supported operation');
  }
  return { id, operation, input: input as HarnessJson | undefined, requestId };
}

function dispatch(session: HarnessSession, request: RpcRequest, launchDirectory: string) {
  const { operation, input } = request;
  const identity = { requestId: request.requestId ?? request.id };
  switch (operation) {
    case 'run':
      return session.start(resolveHarnessInput(input, launchDirectory), identity);
    case 'input':
      return session.input(input ?? null, identity).then(receipt => {
        if (request.requestId !== undefined) return receipt;
        if (receipt.status === 'not_submitted' && receipt.reason === 'RUN_STOPPING') {
          throw projectError('RUN_STOPPING', 'Input admission is closed');
        }
        return receipt.status === 'accepted' ? receipt.result : receipt;
      });
    case 'stop': {
      const { reason } = optional(input, ['reason']);
      if (request.requestId === undefined && input !== undefined) {
        throw projectError('INVALID_REQUEST', 'The legacy stop operation takes no input');
      }
      return session.stop({ ...identity, reason: reason === undefined ? undefined : requiredString(reason) });
    }
    case 'describe':
      optional(input, []);
      if (input !== undefined) throw projectError('INVALID_REQUEST', 'Describe takes no input');
      return session.describe();
    case 'answer': {
      const { questionId, answer } = named(input, ['questionId', 'answer']);
      if (typeof answer !== 'string' && typeof answer !== 'boolean') throw projectError('INVALID_REQUEST', 'Invalid answer');
      return session.respond(requiredString(questionId), answer, identity);
    }
    case 'agent.getState':
    case 'agent.getStats': {
      const agentId = requiredString(named(input, ['agentId']).agentId);
      return operation === 'agent.getState' ? session.agents.getState(agentId) : session.agents.getStats(agentId);
    }
    case 'agent.getMessages': {
      const { agentId, options } = named(input, ['agentId', 'options']);
      return session.agents.getMessages(requiredString(agentId), optional(options, ['limit', 'maxBytes']));
    }
    case 'agent.configure': {
      const { agentId, patch } = named(input, ['agentId', 'patch']);
      return session.agents.configure(requiredString(agentId), patch, identity);
    }
    case 'agent.send': {
      const { agentId, input: payload, options } = named(input, ['agentId', 'input', 'options']);
      return session.agents.send(requiredString(agentId), payload, {
        ...optional(options, ['mode', 'delivery', 'wakeIfIdle', 'source']), ...identity,
      });
    }
    case 'agent.compact': {
      const { agentId, options } = named(input, ['agentId', 'options']);
      return session.agents.compact(requiredString(agentId), { ...optional(options, ['customInstructions']), ...identity });
    }
    case 'agent.abortRetry':
    case 'agent.clearQueue':
    case 'agent.interrupt': {
      const { agentId, options } = named(input, ['agentId', 'options']);
      optional(options, []);
      const target = requiredString(agentId);
      if (operation === 'agent.abortRetry') return session.agents.abortRetry(target, identity);
      if (operation === 'agent.clearQueue') return session.agents.clearQueue(target, identity);
      return session.agents.interrupt(target, identity);
    }
    case 'agent.stop': {
      const { agentId, options } = named(input, ['agentId', 'options']);
      return session.agents.stop(requiredString(agentId), { ...optional(options, ['reason']), ...identity });
    }
    default:
      throw projectError('INVALID_REQUEST', 'Unsupported RPC operation');
  }
}

function eventRecord(event: HarnessEvent) {
  switch (event.type) {
    case 'snapshot':
    case 'result':
      return undefined;
    case 'state':
      // Preserve the original state event fields for v1 clients.
      if (event.state.phase === 'starting') return undefined;
      return { type: 'event', runId: event.state.runId, event: { kind: 'status', ...event.state }, sessionEvent: event };
    case 'event':
      return { ...event, sessionEvent: event };
    default:
      return { type: 'event', runId: event.runId, event: { kind: event.type, ...event }, sessionEvent: event };
  }
}

export async function runProjectRpc(
  session: HarnessSession, input: Readable, write: Writer, launchDirectory: string, initialInput?: HarnessInput,
) {
  const done = Promise.withResolvers<number>();
  const queryReceipts = new Map<string, QueryReceipt>();
  const signal = harnessSessionSignal(session);
  let closed = false;
  let watchingCompletion = false;
  const location = () => {
    const { runId } = captureHarnessSnapshot(session);
    return runId === null ? {} : { runId };
  };
  const errorRecord = (code: string, id?: string) => ({ type: 'error', ...(id ? { id } : {}), ...location(), code });
  const reply = (id: string, result: unknown) => ({ type: 'reply', id, ...location(), result });
  const send = (record: unknown) => {
    if (!closed) void write(record).catch(() => stopHarnessTransport(session, 'output-failed'));
  };

  function watchCompletion() {
    const completion = session.completion;
    if (!completion || watchingCompletion) return;
    watchingCompletion = true;
    void completion.then(async result => {
      closed = true;
      await write({ type: 'result', runId: result.runId, result });
      done.resolve(getHarnessExitCode(session));
    }).catch(done.reject);
  }

  function onLine(line: string) {
    if (closed) return;
    let id: string | undefined;
    try {
      const parsed = JSON.parse(line, (_key, value) => {
        if (typeof value === 'number' && !Number.isFinite(value)) throw projectError('INVALID_REQUEST', 'Non-finite JSON number');
        return value;
      });
      if (validId(parsed?.id)) id = parsed.id;
      const request = validateRequest(parsed);
      const { operation } = request;
      if (queryOperations.has(operation)) {
        const fingerprint = createHash('sha256').update(stableStringify([operation, request.input !== undefined, request.input ?? null])).digest('hex');
        const previous = queryReceipts.get(request.id);
        if (previous) {
          if (previous.fingerprint !== fingerprint) send(errorRecord('REQUEST_ID_CONFLICT', request.id));
          else void previous.reply.then(send);
          return;
        }
        if (queryReceipts.size >= 4096) throw projectError('REQUEST_LIMIT', 'RPC query identity limit reached');
        if (operation === 'status') {
          if (request.input !== undefined) throw projectError('INVALID_REQUEST', 'Status takes no input');
          // Snapshot and writer invocation are synchronous with live event publication.
          const record = reply(request.id, captureHarnessSnapshot(session));
          queryReceipts.set(request.id, { fingerprint, reply: Promise.resolve(record) });
          send(record);
          return;
        }
        const record = Promise.resolve(dispatch(session, request, launchDirectory)).then(
          value => reply(request.id, value), error => errorRecord(failureCode(error, 'INVALID_REQUEST'), request.id),
        );
        queryReceipts.set(request.id, { fingerprint, reply: record });
        void record.then(send);
        return;
      }
      if (queryReceipts.has(request.id)) throw projectError('REQUEST_ID_CONFLICT', 'RPC query identity is already in use');
      const work = dispatch(session, request, launchDirectory);
      watchCompletion();
      void Promise.resolve(work).then(
        value => send(reply(request.id, value)),
        error => send(errorRecord(failureCode(error, 'INVALID_REQUEST'), request.id)),
      );
    } catch (error) {
      send(errorRecord(failureCode(error, 'INVALID_REQUEST'), id));
    }
  }

  function stopTransport() {
    if (!session.completion) setImmediate(() => done.resolve(0));
  }
  signal.addEventListener('abort', stopTransport, { once: true });
  const unsubscribe = session.onEvent(event => {
    const record = eventRecord(event);
    if (record) send(record);
  });
  let detach: (() => void) | undefined;
  try {
    const descriptor = await session.describe();
    const status = captureHarnessSnapshot(session);
    send({ type: 'ready', version: 'v1', harness: status.harness, status, descriptor });
    if (signal.aborted) stopTransport();
    else if (initialInput) onLine(JSON.stringify({ id: 'foreground-start', operation: 'run', input: initialInput }));
    detach = readRpcLines(input, MAX_COMMAND_BYTES, {
      line: onLine,
      invalid: () => send(errorRecord('INVALID_REQUEST')),
      end: () => stopHarnessTransport(session, 'input-ended'),
      error: () => stopHarnessTransport(session, 'input-failed'),
    });
    if (input.readableEnded) stopHarnessTransport(session, 'input-ended');
    return await done.promise;
  } finally {
    closed = true;
    signal.removeEventListener('abort', stopTransport);
    unsubscribe();
    detach?.();
    input.pause();
  }
}

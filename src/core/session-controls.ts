import { createHash, randomUUID } from 'node:crypto';
import { stableStringify } from '../protocol/stable-json.js';
import { snapshotContext, snapshotSessionConfig } from './session-config.js';
import { validId } from './config.js';
import type { AllocationLedger } from './allocation-ledger.js';
import type { AgentSessionPatch, ContextInput, ContextInputReceipt, ContextSendOptions, RuntimeSession, SessionControlReceipt } from './session-types.js';

interface Agent {
  executionEpoch: number;
  info: { id: string; status: string };
  interruption?: unknown;
  activityClaims: Set<unknown>;
  nativeExecuting: boolean;
}
type SessionMutation = 'configure' | 'compact' | 'abortRetry' | 'clearQueue' | 'context';
interface ControlEntry {
  id: string;
  name: SessionMutation;
  payload: Record<string, unknown>;
  fingerprint: string;
  dispatched: boolean;
  executionEpoch: number;
  work?: Promise<unknown>;
  result?: unknown;
}
export function createSessionControls(options: {
  capabilities: import('./backend-config.js').ExecutorCapabilities;
  findAgent(id: string, operation: string, requestId?: string): Agent;
  available(agent: Agent): boolean;
  canSend(agent: Agent): boolean;
  problem(code: string, message: string, operation: string, agentId?: string, requestId?: string): Error;
  backend: {
    sessionCommand(agentId: string, command: string, payload: Record<string, unknown>, query: boolean): Promise<unknown>;
  };
  record(type: string, value: Record<string, unknown>): void;
  sanitize(value: unknown): unknown;
  activity(agent: Agent): void;
  durable?<T>(action: (owner: AllocationLedger) => T): T | undefined;
}) {
  const requests = new Map<string, ControlEntry>();
  const serial = new Map<string, Promise<unknown>>();
  const reservations = new Set<string>();
  const caller = (name: SessionMutation) => name === 'context' ? 'host' : 'host-session';
  const command = (name: SessionMutation) => name === 'context' ? 'core_context' :
    `core_session_${({ abortRetry: 'abort_retry', clearQueue: 'clear_queue' } as Record<string, string>)[name] ?? name}`;
  const durableParams = (parameters: unknown) => parameters as { sessionCommand?: SessionMutation; executionEpoch?: number };
  const capability = (name: keyof NonNullable<typeof options.capabilities.session>, operation: string, agentId: string) => {
    if (!options.capabilities.session?.[name]) throw options.problem('OPERATION_UNSUPPORTED', 'Executor does not support this session operation', operation, agentId);
  };
  function live(agentId: string, operation: string, requestId?: string) {
    const agent = options.findAgent(agentId, operation, requestId);
    if (!options.available(agent)) throw options.problem('SESSION_UNAVAILABLE', 'Agent Session is unavailable', operation, agentId, requestId);
    return agent;
  }
  async function query(agentId: string, name: 'state' | 'stats' | 'messages', payload: Record<string, unknown> = {}) {
    const operation = `session.get${name[0].toUpperCase()}${name.slice(1)}`;
    capability(name, operation, agentId);
    live(agentId, operation);
    const result = await options.backend.sessionCommand(agentId, `core_session_get_${name}`, { id: randomUUID(), ...payload }, false);
    if (!result || (result as any).status === 'unknown') throw options.problem('SESSION_UNAVAILABLE', 'Native Session query was not confirmed', operation, agentId);
    return options.sanitize(result);
  }
  async function mutation(agentId: string, name: SessionMutation, payload: Record<string, unknown>, requestId: string): Promise<any> {
    const operation = name === 'context' ? 'send' : `session.${name}`;
    if (!validId(requestId)) throw options.problem('INVALID_CONTRACT', 'A session operation requires requestId', operation, agentId, requestId);
    const agent = options.findAgent(agentId, operation, requestId);
    const key = JSON.stringify([agentId, requestId]);
    const fingerprint = stableStringify({ name, payload });
    let entry = requests.get(key);
    const parameterFingerprint = createHash('sha256').update(fingerprint).digest('hex');
    const saved = entry ? undefined : options.durable?.(owner => owner.input(agentId, caller(name), requestId));
    if (saved && (saved.parameterFingerprint !== parameterFingerprint || durableParams(saved.parameters)?.sessionCommand !== name)) {
      throw options.problem('CONFLICT', 'requestId already identifies another input or Session operation', operation, agentId, requestId);
    }
    if (saved?.state === 'accepted') return structuredClone(saved.receipt);
    if (entry && entry.fingerprint !== fingerprint) throw options.problem('CONFLICT', 'requestId already identifies another session operation', operation, agentId, requestId);
    if (!entry) {
      capability(name, operation, agentId);
      const dispatched = saved !== undefined && saved.state !== 'reserved';
      if (!dispatched) live(agentId, operation, requestId);
      if (requests.size >= 8192) throw options.problem('CAPACITY_EXCEEDED', 'Session request identity capacity reached', operation, agentId, requestId);
      if (!dispatched && (agent.interruption || !options.canSend(agent) || reservations.has(agentId))) {
        throw options.problem('BUSY', 'Agent has a pending exclusive operation', operation, agentId, requestId);
      }
      const id = saved?.inputId ?? randomUUID();
      const executionEpoch = durableParams(saved?.parameters)?.executionEpoch ?? agent.executionEpoch;
      if (!saved) options.durable?.(owner => owner.reserveInput({
        resourceKey: agentId, caller: caller(name), requestId, inputId: id, parameterFingerprint,
        parameters: { sessionCommand: name, executionEpoch },
      }));
      entry = { id, name, payload, fingerprint, dispatched, executionEpoch };
      requests.set(key, entry);
    }
    if (entry.result !== undefined) return structuredClone(entry.result);
    const operationEntry = entry;
    if (!entry.work) {
      const work = async () => {
        if (!operationEntry.dispatched && (!options.available(agent) || !options.canSend(agent) ||
            operationEntry.executionEpoch !== agent.executionEpoch)) {
          throw options.problem('SESSION_UNAVAILABLE', 'Agent stopped or changed epoch before Session dispatch', operation, agentId, requestId);
        }
        if (name === 'compact' && !operationEntry.dispatched && (agent.info.status !== 'idle' || agent.nativeExecuting || agent.activityClaims.size || reservations.has(agentId))) {
          return { operationId: operationEntry.id, agentId, requestId, status: 'busy', reason: 'Agent has active or starting work' };
        }
        const exclusive = name === 'compact';
        if (exclusive) reservations.add(agentId);
        const queryOnly = operationEntry.dispatched;
        const inputClaim = name === 'context' && ['steer', 'followUp'].includes(payload.delivery as string) && payload.wakeIfIdle !== false;
        try {
          if (!queryOnly) {
            const allocation = options.durable?.(owner => owner.get(agentId));
            if (allocation) {
              const expiry = Date.parse(allocation.expiresAt ?? '');
              if (!Number.isFinite(expiry) || expiry - Date.now() < 5000) {
                throw options.problem('SERVICE_UNAVAILABLE', 'Sandbox lease has insufficient confirmed time for Session dispatch', operation, agentId, requestId);
              }
              options.durable?.(owner => owner.recordInput(agentId, caller(name), requestId, 'dispatched'));
            }
          }
          operationEntry.dispatched = true;
          if (inputClaim && !queryOnly) { agent.activityClaims.add(operationEntry); options.activity(agent); }
          const data = await options.backend.sessionCommand(agentId, command(name), { id: operationEntry.id, executionEpoch: operationEntry.executionEpoch, ...payload }, queryOnly) as Record<string, unknown>;
          const identity = name === 'context' ? { inputId: operationEntry.id } : { operationId: operationEntry.id, agentId, requestId };
          const result = { ...options.sanitize(data) as object, ...identity };
          const confirmed = (result as { status?: string }).status !== 'unknown';
          options.durable?.(owner => owner.recordInput(agentId, caller(name), requestId, confirmed ? 'accepted' : 'unknown', confirmed ? result : undefined));
          if (confirmed) {
            operationEntry.result = result;
            if (inputClaim && ['not-accepted', 'failed'].includes((result as any).status)) { agent.activityClaims.delete(operationEntry); options.activity(agent); }
          }
          options.record('session-control', { agentId, requestId, operation, receipt: result });
          return result;
        } finally { if (exclusive) reservations.delete(agentId); }
      };
      // Configuration and manual compaction share an Agent-local order. Control
      // cancellation and context admission cannot wait behind model execution.
      const predecessor = ['configure', 'compact'].includes(name) ? serial.get(agentId) : undefined;
      entry.work = (predecessor ?? Promise.resolve()).catch(() => undefined).then(work).finally(() => { operationEntry.work = undefined; });
      if (['configure', 'compact'].includes(name)) serial.set(agentId, entry.work);
    }
    const current = entry.work;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([current, new Promise(resolve => { timer = setTimeout(() => resolve(name === 'context' ? { inputId: entry!.id, status: 'unknown' } : { operationId: entry!.id, agentId, requestId, status: 'unknown' }), 60_000); })]);
    } finally { clearTimeout(timer); }
  }
  const api: RuntimeSession = {
    configure(agentId, patch, request) {
      try { if (!patch || !Object.keys(patch).length) throw new TypeError('configure requires a nonempty patch'); snapshotSessionConfig(patch, true); } catch (error) { return Promise.reject(options.problem('INVALID_CONTRACT', (error as Error).message, 'session.configure', agentId, request?.requestId)); }
      return mutation(agentId, 'configure', { patch: structuredClone(patch) }, request?.requestId);
    },
    compact(agentId, request) {
      if (request?.customInstructions !== undefined && (typeof request.customInstructions !== 'string' || Buffer.byteLength(request.customInstructions) > 65536)) return Promise.reject(options.problem('INVALID_CONTRACT', 'Invalid compact customInstructions', 'session.compact', agentId));
      return mutation(agentId, 'compact', { ...(request?.customInstructions !== undefined ? { customInstructions: request.customInstructions } : {}) }, request?.requestId);
    },
    abortRetry: (agentId, request) => mutation(agentId, 'abortRetry', {}, request?.requestId),
    clearQueue: (agentId, request) => mutation(agentId, 'clearQueue', {}, request?.requestId),
    getState: agentId => query(agentId, 'state') as ReturnType<RuntimeSession['getState']>,
    getStats: agentId => query(agentId, 'stats') as ReturnType<RuntimeSession['getStats']>,
    getMessages(agentId, request = {}) {
      if (Object.keys(request).some(key => !['limit', 'maxBytes'].includes(key)) ||
          (request.limit !== undefined && (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 1000)) ||
          (request.maxBytes !== undefined && (!Number.isSafeInteger(request.maxBytes) || request.maxBytes < 1 || request.maxBytes > 256 * 1024))) return Promise.reject(options.problem('INVALID_CONTRACT', 'Messages limit must be 1–1000 and maxBytes 1–262144', 'session.getMessages', agentId));
      return query(agentId, 'messages', { limit: 100, maxBytes: 65536, ...request }) as ReturnType<RuntimeSession['getMessages']>;
    },
  };
  return {
    api: Object.freeze(api),
    hasContext(agentId: string, requestId: string) {
      if (requests.get(JSON.stringify([agentId, requestId]))?.name === 'context') return true;
      const saved = options.durable?.(owner => owner.input(agentId, 'host', requestId));
      return durableParams(saved?.parameters)?.sessionCommand === 'context';
    },
    async reconcile(agentId: string, operation: string, requestId: string) {
      const entry = requests.get(JSON.stringify([agentId, requestId]));
      const name = operation === 'send' ? 'context' : operation as SessionMutation;
      if (entry?.dispatched && entry.name === name) return mutation(agentId, entry.name, entry.payload, requestId);
      const saved = options.durable?.(owner => owner.input(agentId, caller(name), requestId));
      const parameters = durableParams(saved?.parameters);
      if (!saved || saved.state === 'reserved' || parameters?.sessionCommand !== name) return { status: 'unknown', requestId };
      if (saved.state === 'accepted') return structuredClone(saved.receipt);
      const data = await options.backend.sessionCommand(agentId, command(name), { id: saved.inputId, executionEpoch: parameters.executionEpoch }, true);
      const identity = name === 'context' ? { inputId: saved.inputId } : { operationId: saved.inputId, agentId, requestId };
      const result = { ...options.sanitize(data) as object, ...identity };
      if ((result as { status?: string }).status !== 'unknown') {
        options.durable?.(owner => owner.recordInput(agentId, caller(name), requestId, 'accepted', result));
      }
      return result;
    },
    reserved: (agentId: string) => reservations.has(agentId),
    async context(agentId: string, input: ContextInput, request: ContextSendOptions): Promise<ContextInputReceipt> {
      let snapshot;
      try { snapshot = snapshotContext(input, request); } catch (error) { throw options.problem('INVALID_CONTRACT', (error as Error).message, 'send', agentId, request?.requestId); }
      const { requestId, delivery, source } = request;
      return mutation(agentId, 'context', { input: snapshot, delivery, ...(source ? { source } : {}), ...(['steer', 'followUp'].includes(delivery) ? { wakeIfIdle: request.wakeIfIdle ?? true } : {}) }, requestId);
    },
  };
}

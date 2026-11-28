import { createHash, randomUUID } from 'node:crypto';
import { createProjectHost, type HarnessInput, type HarnessJson, type HarnessInputHandler, type HarnessInputPreparation, type ProjectHarness } from './project-harness.js';
import { projectError, resolveHarnessInput } from './project-input.js';
import { fenceRuntimeAdmissions, reconcileRuntimeReceipt } from '../core/runtime-admissions.js';
import { createRedactor } from '../core/run-records.js';
import type { RuntimeSession } from '../core/session-types.js';
import { stableStringify } from '../protocol/stable-json.js';
import type { HarnessAgentRegistration, HarnessAgents, HarnessAnswer, HarnessAnswerReceipt, HarnessDescriptor, HarnessEvent,
  HarnessInputDescriptor, HarnessInputReceipt, HarnessOperation, HarnessQuestion, HarnessQuestionRequest, HarnessQuestionSource,
  HarnessRequest, HarnessResult, HarnessSession, HarnessSessionOptions, HarnessStartReceipt, HarnessState, HarnessStopReceipt } from './harness-session-types.js';

interface OperationRecord {
  operation: string;
  failed?: boolean;
  fingerprint: string;
  promise: Promise<unknown>;
  result?: unknown;
  settled: boolean;
  reconcile?: () => Promise<unknown>;
}
interface QuestionRecord {
  value: HarnessQuestion;
  fingerprint: string;
  promise: Promise<HarnessAnswer>;
  resolve: (answer: HarnessAnswer) => void;
  reject: (error: Error) => void;
  source: HarnessQuestionSource;
  release: () => void;
}
interface SessionInternals {
  snapshot: () => HarnessState;
  signal: AbortSignal;
  stop: (reason: string) => void;
  exitCode: () => number | undefined;
}
const internals = new WeakMap<HarnessSession, SessionInternals>();
export function captureHarnessSnapshot(session: HarnessSession) {
  const value = internals.get(session);
  if (!value) throw projectError('INVALID_HARNESS_SESSION', 'Expected a local HarnessSession');
  return value.snapshot();
}
export function harnessSessionSignal(session: HarnessSession) {
  const value = internals.get(session);
  if (!value) throw projectError('INVALID_HARNESS_SESSION', 'Expected a local HarnessSession');
  return value.signal;
}
export function stopHarnessTransport(session: HarnessSession, reason: string) { internals.get(session)?.stop(reason); }
export function getHarnessExitCode(session: HarnessSession) { return internals.get(session)?.exitCode(); }

function requestIdentity(request: HarnessRequest) {
  if (!request || typeof request.requestId !== 'string' || !request.requestId || request.requestId.length > 128) {
    throw projectError('INVALID_REQUEST', 'A requestId of 1 to 128 characters is required');
  }
  return request.requestId;
}
function jsonCopy<T>(value: T, maxBytes = 262_144): T {
  let encoded: string;
  try {
    encoded = JSON.stringify(value, (_key, item) => {
      if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('Non-finite number');
      if (typeof item === 'bigint' || typeof item === 'function' || typeof item === 'symbol') throw new Error('Non-JSON value');
      return item;
    });
  } catch { throw projectError('INVALID_REQUEST', 'Expected bounded JSON data'); }
  if (encoded === undefined || Buffer.byteLength(encoded) > maxBytes) throw projectError('REQUEST_LIMIT', 'JSON data exceeds its byte limit');
  return JSON.parse(encoded) as T;
}
function fingerprint(value: unknown) { return createHash('sha256').update(stableStringify(value)).digest('hex'); }

/** One live Run. The Harness retains ownership of collaboration and resource cleanup. */
export function createHarnessSession(definition: ProjectHarness, options: HarnessSessionOptions = {}): HarnessSession {
  if (!definition || definition.apiVersion !== 1 || typeof definition.id !== 'string' || !/^[a-z0-9][a-z0-9_.:-]{0,127}$/.test(definition.id) || typeof definition.run !== 'function') {
    throw projectError('INVALID_HARNESS_MODULE', 'Harness requires apiVersion 1, a stable id and run(context)');
  }
  if (options.configuration !== undefined && options.configPath !== undefined) {
    throw projectError('INVALID_RUN_CONFIGURATION', 'configuration and configPath are mutually exclusive');
  }
  const lifetime = options.lifetime ?? 'task';
  const lifetimes = definition.lifetimes ?? ['task'];
  if (!lifetimes.includes(lifetime)) throw projectError('OPERATION_UNSUPPORTED', 'This Harness does not support the requested lifetime');
  const limits = { inputQueue: 64, inputBytes: 262_144, mutations: 4096, questions: 64, questionBytes: 262_144,
    handlerTimeoutMs: 10_000, snapshotBytes: 262_144, ...options.limits };
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1) {
    throw projectError('INVALID_RUN_CONFIGURATION', 'Session limits must be positive safe integers');
  }
  const redactor = createRedactor([process.env.OPEN_SANDBOX_API_KEY, process.env.MURM_EXECD_ACCESS_TOKEN]);
  const clientCapabilities = Object.freeze({ questions: options.clientCapabilities?.questions === true });
  const records = new Map<string, OperationRecord>();
  const registrations = new Set<HarnessAgentRegistration>();
  const targets = new Map<string, HarnessAgentRegistration>();
  const nativeCapabilities = new Map<string, import('../core/session-types.js').AgentSessionCapabilities>();
  const targetStates = new Map<string, string>();
  const questions = new Map<string, QuestionRecord>();
  const questionRequests = new Map<string, QuestionRecord>();
  const listeners = new Set<(event: HarnessEvent) => void>();
  const output = new Map<string, HarnessJson>();
  let inputDescription: HarnessInputDescriptor = definition.inputDescriptor ?? definition.inputDescription ?? {};
  let prepareInput: HarnessInputPreparation | undefined;
  let inputHandler: HarnessInputHandler | undefined;
  let completion: Promise<HarnessResult> | undefined;
  let result: HarnessResult | undefined;
  let exitCode: number | undefined;
  let stopping = false;
  let fenceFailed = false;
  let queuedCount = 0;
  let queuedBytes = 0;
  let questionBytes = 0;
  let inputTail = Promise.resolve();
  let observedAt = new Date().toISOString();
  let stopReceipt: HarnessStopReceipt | undefined;

  function descriptor(): HarnessDescriptor {
    const agents: Record<string, NonNullable<HarnessDescriptor['agents'][string]>> = {};
    for (const [id, registration] of targets) {
      const declared = declaredCapabilities(registration, id);
      agents[id] = Object.fromEntries(Object.entries(declared).map(([name, capability]) => {
        const operation = name as HarnessOperation;
        const handlerRequired = ['send', 'interrupt', 'clearQueue', 'stop', 'compact', 'abortRetry'].includes(name);
        const supported = capability.supported && executorSupports(id, operation) && (!handlerRequired || !!registration.handlers?.[operation]);
        const state = targetStates.get(id);
        const unavailable = stopping || !!result ? 'RUN_STOPPING' : ['exited', 'closing', 'closed'].includes(state ?? '') ? 'SESSION_UNAVAILABLE'
          : state === 'starting' ? 'AGENT_NOT_READY' : name === 'compact' && state !== 'idle' ? 'OPERATION_BUSY' : undefined;
        return [name, { ...capability, supported, available: supported && capability.available !== false && !unavailable,
          ...(unavailable ? { reason: unavailable } : {}),
          ...(name === 'send' ? { context: capability.context === true && nativeCapabilities.get(id)?.context !== false } : {}),
        }];
      }));
    }
    return { id: definition.id, apiVersion: 1, lifetimes,
      input: { supported: definition.input === true, available: !!inputHandler && host.status().phase === 'running' && !stopping && !result, ...inputDescription },
      questions: { supported: definition.questions === true, available: definition.questions === true && clientCapabilities.questions && !stopping && !result,
        ...(!clientCapabilities.questions ? { reason: 'QUESTION_CHANNEL_UNAVAILABLE' } : {}) }, agents };
  }
  function boundedView(value: HarnessJson, bytes: number): HarnessJson {
    const encoded = JSON.stringify(redactor.value(value));
    return Buffer.byteLength(encoded) <= bytes ? JSON.parse(encoded) : { truncated: true, preview: encoded.slice(0, Math.floor(bytes / 4)) };
  }
  function snapshot(): HarnessState {
    const current = host.status();
    return jsonCopy(redactor.value({ ...current,
      agents: boundedView(current.agents, Math.floor(limits.snapshotBytes / 8)),
      business: boundedView(current.business, Math.floor(limits.snapshotBytes / 8)), lifetime, capabilities: descriptor(), clientCapabilities,
      questions: [...questions.values()].map(record => record.value), output: [...output.values()], observedAt,
      ...(result ? { result: { ...result, result: undefined, acceptance: undefined, operations: result.operations?.slice(0, 16), artifacts: result.artifacts.slice(0, 16), snapshotTruncated: true } } : {}) }), limits.snapshotBytes) as HarnessState;
  }
  function publish(event: HarnessEvent) {
    observedAt = new Date().toISOString();
    for (const listener of [...listeners]) {
      try { listener(structuredClone(redactor.value(event)) as HarnessEvent); } catch { /* One subscriber cannot fail the Run. */ }
    }
  }
  function changed() { publish({ type: 'state', state: snapshot() }); }
  function recordOutput(raw: HarnessJson) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const rawObject = raw as { readonly [key: string]: HarnessJson };
    const runtime = rawObject.kind === 'agent' ? rawObject.event : raw;
    if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime) || !('type' in runtime) || runtime.type !== 'session') return;
    const runtimeObject = runtime as { readonly [key: string]: HarnessJson };
    const event = runtimeObject.event;
    if (!event || typeof event !== 'object' || Array.isArray(event) || !('messageId' in event) || typeof event.messageId !== 'string') return;
    const eventObject = event as { readonly [key: string]: HarnessJson };
    const key = String(runtimeObject.agentId ?? '') + ':' + eventObject.messageId;
    const previous = output.get(key) as { text?: string } | undefined;
    if (eventObject.type === 'textDelta' && typeof eventObject.delta === 'string') {
      output.set(key, { agentId: runtimeObject.agentId ?? null, messageId: eventObject.messageId, text: ((previous?.text ?? '') + eventObject.delta).slice(-16_384), truncated: (previous?.text?.length ?? 0) + eventObject.delta.length > 16_384, complete: false });
    } else if (eventObject.type === 'messageEnd') {
      output.set(key, { agentId: runtimeObject.agentId ?? null, messageId: eventObject.messageId, message: boundedView(eventObject.message ?? null, 16_384), complete: true });
    }
    while (output.size > 8 || Buffer.byteLength(JSON.stringify([...output.values()])) > Math.floor(limits.snapshotBytes / 4)) output.delete(output.keys().next().value!);
  }
  function settleQuestion(record: QuestionRecord, status: 'cancelled' | 'expired', reason: string) {
    if (record.value.status !== 'pending') return;
    record.value.status = status;
    record.value.reason = reason;
    record.release();
    record.reject(projectError(status === 'expired' ? 'QUESTION_EXPIRED' : 'QUESTION_CANCELLED', reason));
    publish({ type: 'question', runId: host.status().runId, question: structuredClone(record.value) });
  }
  function closeQuestions(reason: string) { for (const record of questions.values()) settleQuestion(record, 'cancelled', reason); }
  function stop(reason: string) {
    if (!stopping && !result) {
      stopping = true;
      for (const registration of registrations) {
        try { fenceRuntimeAdmissions(registration.runtime); } catch { fenceFailed = true; }
        try { registration.fence?.(); } catch { fenceFailed = true; }
      }
      closeQuestions(reason);
      host.stop(reason);
      changed();
    }
  }
  const wrapped: ProjectHarness = { ...definition, async run(context) {
    const returned = await definition.run({ ...context, lifetime, clientCapabilities, agentEventsManaged: true,
      registerInput(handler, description, prepare) {
        context.signal.throwIfAborted();
        if (!definition.input || inputHandler || typeof handler !== 'function') throw projectError('INVALID_HARNESS_INPUT_HANDLER', 'Declare and register one input handler');
        inputHandler = handler;
        prepareInput = prepare;
        inputDescription = jsonCopy(description ?? inputDescription);
        context.registerInput(handler);
        changed();
      },
      registerAgentControls(registration) {
        context.signal.throwIfAborted();
        if (!registration?.runtime || [...registrations].some(existing => existing.runtime === registration.runtime)) throw projectError('INVALID_AGENT_REGISTRATION', 'Register one owned Runtime once');
        registrations.add(registration);
        void refreshTargets(registration);
        const unsubscribe = registration.runtime.onEvent(event => {
          void refreshTargets(registration);
          if (event.type !== 'agentChanged' && event.type !== 'runtimeChanged') {
            const eventJson = jsonCopy({ kind: 'agent', event }) as HarnessJson;
            recordOutput(eventJson);
            publish({ type: 'event', runId: context.runId, event: eventJson });
          }
        });
        return () => { unsubscribe(); registrations.delete(registration); for (const [id, owner] of targets) if (owner === registration) targets.delete(id); changed(); };
      },
      askUser: ask,
    });
    closeQuestions('run-finished');
    return { ...returned, questions: [...questions.values()].map(record => structuredClone(record.value)), operations: operationSummaries() };
  } };
  const host = createProjectHost(wrapped, { launchDirectory: options.launchDirectory ?? process.cwd(), ...options,
    finalizeResult(business) {
      return { ...business,
        ...(fenceFailed ? { cleanup: { ...business.cleanup, status: 'pending' as const, pending: ['runtime-dispatch-fence-unconfirmed'] } } : {}),
        questions: [...questions.values()].map(record => structuredClone(record.value)), operations: operationSummaries(),
      };
    },
  }, raw => {
    const record = raw as { event?: HarnessJson };
    if (record.event && typeof record.event === 'object' && !Array.isArray(record.event) && 'kind' in record.event && record.event.kind === 'status') changed();
    else if (record.event !== undefined) { recordOutput(record.event); publish({ type: 'event', runId: host.status().runId, event: jsonCopy(record.event) }); }
  });

  async function refreshTargets(registration: HarnessAgentRegistration) {
    try {
      const listed = await registration.runtime.list();
      let updated = false;
      for (const agent of listed) { if (targetStates.get(agent.id) !== agent.status) updated = true; targetStates.set(agent.id, agent.status); }
      const ids = registration.targets ? await registration.targets() : listed.map(agent => agent.id);
      if (!registrations.has(registration)) return;
      if (ids.some(id => !listed.some(agent => agent.id === id))) throw projectError('AGENT_NOT_FOUND', 'Registered target is outside its Runtime');
      for (const [id, owner] of targets) if (owner === registration && !ids.includes(id)) { targets.delete(id); updated = true; }
      for (const id of ids) {
        if (targets.has(id) && targets.get(id) !== registration) throw projectError('AGENT_ID_CONFLICT', 'Agent belongs to another registered Runtime');
        if (!targets.has(id)) updated = true;
        targets.set(id, registration);
      }
      if (updated) changed();
    } catch (error) { publish({ type: 'event', runId: host.status().runId, event: { kind: 'observation-error', code: 'RUNTIME_STATE_UNAVAILABLE' } }); }
  }
  function mutate<T>(operation: string, payload: unknown, request: HarnessRequest, run: () => Promise<T> | T, reserved = false, validate?: () => void): Promise<T> {
    let id: string;
    let hash: string;
    try { id = requestIdentity(request); hash = fingerprint([operation, jsonCopy(payload)]); } catch (error) { return Promise.reject(error); }
    const existing = records.get(id);
    if (existing) {
      if (existing.fingerprint !== hash) return Promise.reject(projectError('REQUEST_ID_CONFLICT', 'requestId already identifies different parameters or operation'));
      if (existing.settled && existing.reconcile && isUnknown(existing.result)) {
        return existing.reconcile().then(value => {
          existing.result = jsonCopy(value);
          publish({ type: 'operation', runId: host.status().runId, requestId: id, operation, result: existing.result });
          return existing.result as T;
        });
      }
      return existing.settled ? Promise.resolve(existing.result as T) : existing.promise as Promise<T>;
    }
    try { validate?.(); } catch (error) { return Promise.reject(error); }
    if ((!reserved && records.size >= limits.mutations) || records.size >= limits.mutations + limits.questions + 1) return Promise.reject(projectError('REQUEST_LIMIT', 'Session mutation identities are full'));
    const deferred = Promise.withResolvers<T>();
    const record: OperationRecord = { operation, fingerprint: hash, promise: deferred.promise, settled: false };
    records.set(id, record);
    try {
      Promise.resolve(run()).then(value => {
        record.result = jsonCopy(value);
        record.settled = true;
        deferred.resolve(record.result as T);
        publish({ type: 'operation', runId: host.status().runId, requestId: id, operation, result: record.result });
      }, error => { record.failed = true; deferred.reject(error); }).catch(error => { record.failed = true; deferred.reject(error); });
    } catch (error) { record.failed = true; deferred.reject(error); }
    void deferred.promise.catch(() => {});
    return deferred.promise;
  }
  function observeHandler<T>(work: Promise<T>, requestId: string, unknown: T): Promise<T> {
    const deferred = Promise.withResolvers<T>();
    const expired = () => deferred.resolve(unknown);
    const timer = setTimeout(expired, limits.handlerTimeoutMs);
    void deferred.promise.finally(() => { clearTimeout(timer); host.signal.removeEventListener('abort', expired); }).catch(() => {});
    host.signal.addEventListener('abort', expired, { once: true });
    if (host.signal.aborted) expired();
    void work.then(value => {
      const record = records.get(requestId);
      if (record) { record.result = jsonCopy(value); record.settled = true; }
      deferred.resolve(value);
    }, deferred.reject).finally(() => {
      clearTimeout(timer);
      host.signal.removeEventListener('abort', expired);
    }).catch(() => {});
    return deferred.promise;
  }
  function operationSummaries(): NonNullable<HarnessResult['operations']> {
    return [...records].map(([requestId, record]) => ({ requestId, operation: record.operation,
      status: record.failed ? 'failed' : isUnknown(record.result) ? 'unknown' : record.settled ? 'confirmed' : 'pending' }));
  }
  function isUnknown(value: unknown) {
    return !!value && typeof value === 'object' && ((value as { status?: string }).status === 'unknown' ||
      ((value as { core?: { status?: string } }).core?.status === 'unknown') ||
      ((value as { core?: { cleanup?: string } }).core?.cleanup === 'pending') ||
      ((value as { harnessEffects?: { status?: string } }).harnessEffects?.status === 'pending'));
  }
  function admit() {
    if (stopping || result || host.signal.aborted) throw projectError('RUN_STOPPING', 'Run admission is closed');
  }
  async function ask(request: HarnessQuestionRequest, source: HarnessQuestionSource): Promise<HarnessAnswer> {
    try {
      admit();
      if (definition.questions !== true || !clientCapabilities.questions) throw projectError('OPERATION_UNSUPPORTED', 'This Run has no question answering channel');
      requestIdentity(request);
      const raw = jsonCopy(request, limits.questionBytes);
      if (!source || typeof source.id !== 'string' || !source.id || !(source.signal instanceof AbortSignal) || source.signal.aborted) throw projectError('QUESTION_SOURCE_UNAVAILABLE', 'A live trusted question source is required');
      source.assertAuthorized?.();
      if (source.agentId) await registrationFor(source.agentId);
      admit();
      if (request.agentId !== source.agentId || (source.agentId && !targets.has(source.agentId))) throw projectError('QUESTION_SOURCE_MISMATCH', 'Question source does not own the target Agent');
      if (!['text', 'choice', 'confirm'].includes(request.kind) || typeof request.text !== 'string' || !request.text.trim()) throw projectError('INVALID_QUESTION', 'A question kind and text are required');
      if (request.kind === 'choice' && (!request.options?.length || request.options.some(option => typeof option.id !== 'string' || !option.id || typeof option.label !== 'string') || new Set(request.options.map(option => option.id)).size !== request.options.length)) throw projectError('INVALID_QUESTION', 'Choice questions require unique option IDs');
      if (request.kind !== 'choice' && request.options !== undefined) throw projectError('INVALID_QUESTION', 'Only choice questions accept options');
      const timeoutMs = request.timeoutMs ?? 60_000;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) throw projectError('INVALID_QUESTION', 'Question timeout must be 1 to 3600000 ms');
      const hash = fingerprint([raw, source.id, source.agentId ?? null]);
      const previous = questionRequests.get(request.requestId);
      if (previous) {
        if (previous.fingerprint !== hash) throw projectError('REQUEST_ID_CONFLICT', 'Question requestId identifies different parameters');
        return previous.promise;
      }
      const bytes = Buffer.byteLength(JSON.stringify(raw));
      if (questions.size >= limits.questions || questionBytes + bytes > Math.min(limits.questionBytes, Math.floor(limits.snapshotBytes / 3))) throw projectError('QUESTION_LIMIT', 'Question capacity is full');
      const questionId = request.questionId ?? randomUUID();
      if (typeof questionId !== 'string' || !questionId || questionId.length > 128 || questions.has(questionId)) throw projectError('QUESTION_ID_CONFLICT', 'Question identity is already used or invalid');
      const deferred = Promise.withResolvers<HarnessAnswer>();
      const value: HarnessQuestion = { ...raw, questionId, sourceId: source.id, createdAt: new Date().toISOString(), deadline: new Date(Date.now() + timeoutMs).toISOString(), status: 'pending' };
      let timer: NodeJS.Timeout;
      let authorizationTimer: NodeJS.Timeout | undefined;
      const cancelled = () => settleQuestion(record, 'cancelled', 'source-cancelled');
      const record: QuestionRecord = { value, fingerprint: hash, promise: deferred.promise, resolve: deferred.resolve, reject: deferred.reject, source,
        release() { clearTimeout(timer); clearInterval(authorizationTimer); source.signal.removeEventListener('abort', cancelled); } };
      questions.set(questionId, record);
      questionRequests.set(request.requestId, record);
      questionBytes += bytes;
      timer = setTimeout(() => settleQuestion(record, 'expired', 'deadline'), timeoutMs);
      source.signal.addEventListener('abort', cancelled, { once: true });
      if (source.assertAuthorized) authorizationTimer = setInterval(() => {
        try { source.assertAuthorized!(); } catch { settleQuestion(record, 'cancelled', 'source-unauthorized'); }
      }, 100);
      record.promise = deferred.promise.then(answer => { admit(); source.signal.throwIfAborted(); source.assertAuthorized?.(); return answer; });
      void record.promise.catch(() => {});
      publish({ type: 'question', runId: host.status().runId, question: structuredClone(value) });
      return record.promise;
    } catch (error) { return Promise.reject(error); }
  }
  function declaredCapabilities(registration: HarnessAgentRegistration, id: string) {
    const declared = typeof registration.capabilities === 'function' ? registration.capabilities(id) : registration.capabilities;
    return { getState: { supported: true }, getStats: { supported: true }, getMessages: { supported: true },
      configure: { supported: false }, compact: { supported: false }, abortRetry: { supported: false }, clearQueue: { supported: false },
      send: { supported: false }, interrupt: { supported: false }, stop: { supported: false }, ...declared };
  }
  function executorSupports(agentId: string, operation: HarnessOperation) {
    const capability = nativeCapabilities.get(agentId);
    if (!capability) return true;
    const names = { getState: 'state', getStats: 'stats', getMessages: 'messages', send: null, interrupt: null, stop: null,
      configure: 'configure', compact: 'compact', clearQueue: 'clearQueue', abortRetry: 'abortRetry' } as const;
    const name = names[operation];
    return name === null || capability[name];
  }
  async function registrationFor(agentId: string) {
    if (typeof agentId !== 'string' || !agentId || agentId.length > 128) throw projectError('INVALID_AGENT', 'Expected an Agent identity');
    for (const registration of registrations) await refreshTargets(registration);
    const registration = targets.get(agentId);
    if (!registration) throw projectError('AGENT_NOT_FOUND', 'Target does not belong to this Run');
    return registration;
  }
  async function query(operation: 'getState' | 'getStats' | 'getMessages', agentId: string, options?: unknown) {
    const registration = await registrationFor(agentId);
    const capability = declaredCapabilities(registration, agentId)[operation];
    if (!capability?.supported || !executorSupports(agentId, operation)) throw projectError('OPERATION_UNSUPPORTED', 'Agent query is unsupported');
    const native = (registration.runtime as typeof registration.runtime & { session: RuntimeSession }).session;
    if (!native) throw projectError('OPERATION_UNSUPPORTED', 'Executor has no session queries');
    const response = registration.handlers?.[operation]
      ? await registration.handlers[operation]!(agentId, options ?? null, { requestId: '', signal: host.signal })
      : operation === 'getMessages' ? await native.getMessages(agentId, options as Parameters<RuntimeSession['getMessages']>[1])
      : await native[operation](agentId);
    if (operation === 'getState') nativeCapabilities.set(agentId, (response as Awaited<ReturnType<RuntimeSession['getState']>>).capabilities);
    return jsonCopy(response);
  }
  async function control(operation: HarnessOperation, agentId: string, payload: unknown, request: HarnessRequest) {
    return mutate('agent.' + operation, { agentId, payload }, request, async () => {
      admit();
      const registration = await registrationFor(agentId);
      admit();
      const capability = declaredCapabilities(registration, agentId)[operation];
      if (!capability?.supported || !executorSupports(agentId, operation)) throw projectError('OPERATION_UNSUPPORTED', 'Harness or executor does not support this Agent operation');
      if (capability.available === false) throw projectError('OPERATION_BUSY', capability.reason ?? 'Agent operation is temporarily unavailable');
      if (['exited', 'closing', 'closed'].includes(targetStates.get(agentId) ?? '')) throw projectError('SESSION_UNAVAILABLE', 'Agent Session is closed');
      if (operation === 'send') {
        const send = payload as { input: unknown; options: { mode?: string; delivery?: string } };
        if (typeof send.input === 'string') {
          if (capability.text !== true || (capability.modes && !capability.modes.includes(send.options.mode ?? 'steer'))) throw projectError('OPERATION_UNSUPPORTED', 'Harness does not support this text delivery');
        } else if (nativeCapabilities.get(agentId)?.context === false || capability.context !== true || !send.options.delivery || !capability.deliveries?.includes(send.options.delivery)) throw projectError('OPERATION_UNSUPPORTED', 'Harness does not support this context delivery');
      }
      if (operation === 'configure' && capability.fields) {
        const paths = Object.entries(payload as Record<string, unknown>).flatMap(([key, value]) => value && typeof value === 'object' && !Array.isArray(value)
          ? Object.keys(value).map(child => key + '.' + child) : [key]);
        if (paths.some(path => !capability.fields!.includes(path))) throw projectError('OPERATION_UNSUPPORTED', 'Harness does not allow this configuration field');
      }
      const handler = registration.handlers?.[operation];
      if (!handler && operation !== 'configure') throw projectError('OPERATION_UNSUPPORTED', 'Harness has no scheduling handler for this operation');
      const native = (registration.runtime as typeof registration.runtime & { session: RuntimeSession }).session;
      const operationRecord = records.get(request.requestId)!;
      if (registration.reconcile) operationRecord.reconcile = () => registration.reconcile!(operation, agentId, request, payload);
      else if (!handler && operation === 'configure') operationRecord.reconcile = () => reconcileRuntimeReceipt(registration.runtime, agentId, operation, request.requestId);
      const dispatched = Promise.resolve(handler ? handler(agentId, payload, { ...request, signal: host.signal })
        : native.configure(agentId, payload as Parameters<RuntimeSession['configure']>[1], request));
      return observeHandler(dispatched, request.requestId, { status: 'unknown', requestId: request.requestId });
    });
  }
  function answerRecord(questionId: string, answer: HarnessAnswer) {
    const record = questions.get(questionId);
    if (!record) throw projectError('QUESTION_UNKNOWN', 'Question does not exist');
    const value = record.value;
    if (value.status !== 'pending') throw projectError('QUESTION_CLOSED', 'Question is already terminal');
    if (Date.now() >= Date.parse(value.deadline)) { settleQuestion(record, 'expired', 'deadline'); throw projectError('QUESTION_EXPIRED', 'Question deadline passed'); }
    if (record.source.signal.aborted) { settleQuestion(record, 'cancelled', 'source-cancelled'); throw projectError('QUESTION_CANCELLED', 'Question source was cancelled'); }
    try { record.source.assertAuthorized?.(); } catch (error) { settleQuestion(record, 'cancelled', 'source-unauthorized'); throw error; }
    if ((value.kind === 'confirm' && typeof answer !== 'boolean') || (value.kind !== 'confirm' && typeof answer !== 'string') || (value.kind === 'choice' && !value.options!.some(option => option.id === answer))) throw projectError('INVALID_ANSWER', 'Answer does not match the question kind or options');
    jsonCopy(answer, 65_536);
    if (questionBytes + Buffer.byteLength(JSON.stringify(answer)) > Math.min(limits.questionBytes, Math.floor(limits.snapshotBytes / 3))) throw projectError('QUESTION_LIMIT', 'Answer exceeds the retained question budget');
    return record;
  }
  const agents: HarnessAgents = {
    getState: agentId => query('getState', agentId) as ReturnType<HarnessAgents['getState']>,
    getStats: agentId => query('getStats', agentId) as ReturnType<HarnessAgents['getStats']>,
    getMessages: (agentId, options) => query('getMessages', agentId, options) as ReturnType<HarnessAgents['getMessages']>,
    configure: (agentId, patch, request) => control('configure', agentId, patch, request) as ReturnType<HarnessAgents['configure']>,
    compact: (agentId, options) => control('compact', agentId, { customInstructions: options.customInstructions }, options) as ReturnType<HarnessAgents['compact']>,
    abortRetry: (agentId, request) => control('abortRetry', agentId, null, request) as ReturnType<HarnessAgents['abortRetry']>,
    clearQueue: (agentId, request) => control('clearQueue', agentId, null, request) as ReturnType<HarnessAgents['clearQueue']>,
    send: ((agentId: string, input: unknown, options: HarnessRequest) => {
      const { requestId, ...delivery } = options;
      return control('send', agentId, { input, options: delivery }, { requestId });
    }) as HarnessAgents['send'],
    interrupt: (agentId, request) => control('interrupt', agentId, null, request) as ReturnType<HarnessAgents['interrupt']>,
    stop: (agentId, options) => control('stop', agentId, { reason: options.reason }, options) as ReturnType<HarnessAgents['stop']>,
  };
  const session: HarnessSession = {
    agents,
    async describe() { for (const registration of registrations) await refreshTargets(registration); return structuredClone(descriptor()); },
    async getState() { return snapshot(); },
    onEvent(handler, subscribeOptions) {
      if (typeof handler !== 'function') throw projectError('INVALID_SUBSCRIBER', 'An event handler is required');
      let initializing = true;
      const buffered: HarnessEvent[] = [];
      const listener = (event: HarnessEvent) => { if (initializing) buffered.push(event); else handler(event); };
      listeners.add(listener);
      try { if (subscribeOptions?.initialSnapshot) handler({ type: 'snapshot', state: snapshot() }); }
      catch { listeners.delete(listener); }
      initializing = false;
      for (const event of buffered) { try { handler(event); } catch {} }
      return () => { listeners.delete(listener); };
    },
    start(raw, request) {
      return mutate('start', raw, request, () => {
        admit();
        const input = resolveHarnessInput(raw, options.launchDirectory ?? process.cwd());
        const started = host.start(input);
        completion = started.completion.then(finished => {
          exitCode = finished.code;
          closeQuestions('run-finished');
          result = { ...finished.result, operations: operationSummaries(), ...(fenceFailed ? { cleanup: { ...finished.result.cleanup, status: 'pending' as const, pending: ['runtime-dispatch-fence-unconfirmed'] } } : {}), questions: [...questions.values()].map(record => structuredClone(record.value)) };
          changed();
          publish({ type: 'result', result });
          return result;
        });
        setImmediate(changed);
        return { ...started.accepted, phase: 'starting', status: 'accepted' } as HarnessStartReceipt;
      });
    },
    input(payload, request) {
      return mutate('input', payload, request, () => {
        admit();
        if (!definition.input) throw projectError('OPERATION_UNSUPPORTED', 'This Harness does not accept input');
        if (!inputHandler || host.status().phase !== 'running') throw projectError('RUN_NOT_READY', 'Harness input route is not ready');
        const copy = jsonCopy(payload, limits.inputBytes);
        const bytes = Buffer.byteLength(JSON.stringify(copy));
        if (queuedCount >= limits.inputQueue || queuedBytes + bytes > limits.inputBytes) throw projectError('REQUEST_LIMIT', 'Harness input queue is full');
        const binding = prepareInput?.(copy, { requestId: request.requestId, signal: host.signal });
        queuedCount++; queuedBytes += bytes;
        const work = inputTail.then(async () => {
          queuedCount--; queuedBytes -= bytes;
          admit();
          const handled = Promise.resolve(inputHandler!(copy, { requestId: request.requestId, signal: host.signal, binding }))
            .then(value => {
              const state = value && typeof value === 'object' && !Array.isArray(value) && 'status' in value ? value.status : null;
              return { status: state === 'unknown' || state === 'not_submitted' ? state : 'accepted', requestId: request.requestId, result: jsonCopy(value) } as HarnessInputReceipt;
            });
          return observeHandler(handled, request.requestId, { status: 'unknown', requestId: request.requestId });
        });
        inputTail = work.then(() => {}, () => {});
        return work;
      });
    },
    respond(questionId, answer, request) {
      return mutate('answer', { questionId, answer }, request, () => {
        const record = answerRecord(questionId, answer);
        const value = record.value;
        questionBytes += Buffer.byteLength(JSON.stringify(answer));
        value.status = 'answered'; value.answer = answer;
        record.release(); record.resolve(answer);
        publish({ type: 'question', runId: host.status().runId, question: structuredClone(value) });
        return { status: 'answered', questionId, answer } as HarnessAnswerReceipt;
      }, true, () => { answerRecord(questionId, answer); });
    },
    stop(request) {
      return mutate('stop', { reason: request.reason ?? 'requested' }, request, () => {
        if (!stopReceipt) { stop(request.reason ?? 'requested'); const state = host.status(); stopReceipt = { status: 'accepted', runId: state.runId, phase: state.phase, reason: request.reason ?? 'requested' }; }
        return stopReceipt;
      }, true);
    },
    get completion() { return completion; },
  };
  internals.set(session, { snapshot, signal: host.signal, stop, exitCode: () => exitCode });
  return session;
}

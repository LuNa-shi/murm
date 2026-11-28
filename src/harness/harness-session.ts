import { createHash, randomUUID } from 'node:crypto';
import { createProjectHost, type HarnessInput, type HarnessJson, type HarnessInputHandler, type HarnessInputPreparation, type Harness } from './project-harness.js';
import { projectError, resolveHarnessInput } from './project-input.js';
import { fenceRuntimeAdmissions, readRuntimeSessionCapabilities, reconcileRuntimeReceipt } from '../core/runtime-admissions.js';
import { createRedactor } from '../core/run-records.js';
import type { RuntimeSession } from '../core/session-types.js';
import type { AgentInfo } from '../core/types.js';
import { maxSessionQueryBytes } from '../protocol/session-queries.js';
import { stableStringify } from '../protocol/stable-json.js';
import { boundHarnessState, defaultSnapshotBytes, jsonBytes, publicHarnessResult } from './harness-session-view.js';
import { collectRuntimeEvidence } from './run-report.js';
import { projectRuntimeEvidence } from './project-runtime.js';
import { HarnessEventStream } from './harness-event-stream.js';
import type { HarnessAgentRegistration, HarnessAgents, HarnessAnswer, HarnessAnswerReceipt, HarnessDescriptor, HarnessDispatchRequest, HarnessEvent,
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
interface RuntimeObservation {
  unsubscribe: () => void;
  agents: readonly AgentInfo[];
  requested: number;
  applied: number;
}
interface SessionInternals {
  snapshot: () => HarnessState;
  runId: () => string | null;
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
export function getHarnessRunId(session: HarnessSession) { return internals.get(session)?.runId() ?? null; }

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
export function createHarnessSession(definition: Harness, options: HarnessSessionOptions = {}): HarnessSession {
  if (!definition || definition.apiVersion !== 1 || typeof definition.id !== 'string' || !/^[a-z0-9][a-z0-9_.:-]{0,127}$/.test(definition.id) || typeof definition.run !== 'function') {
    throw projectError('INVALID_HARNESS_MODULE', 'Harness requires apiVersion 1, a stable id and run(context)');
  }
  if (options.configuration !== undefined && options.configPath !== undefined) {
    throw projectError('INVALID_RUN_CONFIGURATION', 'configuration and configPath are mutually exclusive');
  }
  const lifetime = options.lifetime ?? 'task';
  const lifetimes = [...new Set(definition.lifetimes ?? ['task' as const])];
  if (!lifetimes.includes(lifetime)) throw projectError('OPERATION_UNSUPPORTED', 'This Harness does not support the requested lifetime');
  const limits = { inputQueue: 64, inputBytes: 262_144, mutations: 4096, questions: 64, questionBytes: 262_144,
    handlerTimeoutMs: 10_000, snapshotBytes: defaultSnapshotBytes, ...options.limits };
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1) {
    throw projectError('INVALID_RUN_CONFIGURATION', 'Session limits must be positive safe integers');
  }
  if (limits.snapshotBytes < 16 * 1024) throw projectError('INVALID_RUN_CONFIGURATION', 'Snapshot budget must be at least 16 KiB');
  const questionBudget = Math.min(limits.questionBytes, Math.floor(limits.snapshotBytes / 3));
  const redactor = createRedactor([process.env.OPEN_SANDBOX_API_KEY, process.env.MURM_LIFECYCLE_TOKEN,
    process.env.MURM_MODEL_TOKEN, process.env.MURM_EXECD_ACCESS_TOKEN]);
  const clientCapabilities = Object.freeze({ questions: options.clientCapabilities?.questions === true });
  const records = new Map<string, OperationRecord>();
  const registrations = new Map<HarnessAgentRegistration, RuntimeObservation>();
  const targets = new Map<string, HarnessAgentRegistration>();
  const targetStates = new Map<string, string>();
  let lastAgents: readonly AgentInfo[] = [];
  const questions = new Map<string, QuestionRecord>();
  const questionRequests = new Map<string, QuestionRecord>();
  const events = new HarnessEventStream();
  const output = new Map<string, HarnessJson>();
  let inputDescription: HarnessInputDescriptor = definition.inputDescriptor ?? definition.inputDescription ?? {};
  let prepareInput: HarnessInputPreparation | undefined;
  let inputHandler: HarnessInputHandler | undefined;
  let reconcileInput: HarnessInputHandler | undefined;
  let completion: Promise<HarnessResult> | undefined;
  let result: HarnessResult | undefined;
  let exitCode: number | undefined;
  let stopping = false;
  let finalizing = false;
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
      const native = readRuntimeSessionCapabilities(registration.runtime, id);
      agents[id] = Object.fromEntries(Object.entries(declared).map(([name, capability]) => {
        const operation = name as HarnessOperation;
        const handlerRequired = ['send', 'interrupt', 'clearQueue', 'stop', 'compact'].includes(name);
        const context = capability.context === true && native?.context === true;
        const supported = capability.supported && executorSupports(native, operation) && (!handlerRequired || !!registration.handlers?.[operation]) &&
          (name !== 'send' || context || capability.text === true);
        const state = targetStates.get(id);
        const unavailable = stopping || finalizing ? 'RUN_STOPPING' : ['exited', 'closing', 'closed'].includes(state ?? '') ? 'SESSION_UNAVAILABLE'
          : state === 'starting' ? 'AGENT_NOT_READY' : !supported ? 'OPERATION_UNSUPPORTED'
          : (capability.available === false || (name === 'compact' && state !== 'idle')) ? capability.reason ?? 'OPERATION_BUSY' : undefined;
        return [name, { ...capability, supported, available: supported && capability.available !== false && !unavailable,
          ...(unavailable ? { reason: unavailable } : {}),
          ...(name === 'send' ? { context } : {}),
        }];
      }));
    }
    return { id: definition.id, apiVersion: 1, lifetimes,
      input: { supported: definition.input === true, available: !!inputHandler && host.status().phase === 'running' && !stopping && !finalizing,
        ...redactor.value(inputDescription) as HarnessInputDescriptor },
      questions: { supported: definition.questions === true, available: definition.questions === true && clientCapabilities.questions && !stopping && !finalizing,
        ...(!clientCapabilities.questions ? { reason: 'QUESTION_CHANNEL_UNAVAILABLE' } : {}) }, agents };
  }
  function boundedView(value: unknown, bytes: number): HarnessJson {
    const encoded = JSON.stringify(redactor.value(value));
    return Buffer.byteLength(encoded) <= bytes ? JSON.parse(encoded) : { truncated: true, preview: encoded.slice(0, Math.floor(bytes / 4)) };
  }
  function snapshot(): HarnessState {
    const current = host.status();
    const view = boundHarnessState({ ...current,
      agents: boundedView(registrations.size ? [...registrations.values()].flatMap(observation => observation.agents)
        : lastAgents.length ? lastAgents : current.agents,
        Math.floor(limits.snapshotBytes / 8)),
      business: boundedView(current.business, Math.floor(limits.snapshotBytes / 8)), lifetime, capabilities: descriptor(), clientCapabilities,
      questions: result ? result.questions ?? [] : [...questions.values()].map(record => record.value),
      output: redactor.value([...output.values()]) as HarnessJson[], observedAt, result,
      stopReason: current.stopReason === null ? null : redactor.text(current.stopReason),
    }, limits.snapshotBytes);
    return structuredClone(view);
  }
  function publish(event: HarnessEvent) {
    observedAt = new Date().toISOString();
    if (event.type === 'event') events.publish({ ...event, event: redactor.value(event.event) as HarnessJson });
    else if (event.type === 'operation') events.publish({ ...event, result: redactor.value(event.result) });
    else events.publish(event);
  }
  function changed() {
    try { publish({ type: 'state', state: snapshot() }); }
    catch { publish({ type: 'event', runId: host.status().runId, event: { kind: 'observation-error', code: 'OBSERVATION_UNAVAILABLE' } }); }
  }
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
    if (!stopping && !finalizing) {
      stopping = true;
      for (const registration of registrations.keys()) {
        try { fenceRuntimeAdmissions(registration.runtime); } catch { fenceFailed = true; }
        try { registration.fence?.(); } catch { fenceFailed = true; }
      }
      closeQuestions('run-stopping');
      host.stop(redactor.text(reason));
      changed();
    }
  }
  const wrapped: Harness = { ...definition, async run(context) {
    const configuration = context.configuration as {
      sandbox?: { apiKey?: string; execdToken?: string };
      models?: Record<string, { upstream?: { headers?: Record<string, string> } }>;
    } | undefined;
    redactor.add([configuration?.sandbox?.apiKey, configuration?.sandbox?.execdToken,
      ...Object.values(configuration?.models ?? {}).flatMap(model => Object.values(model?.upstream?.headers ?? {}))]);
    return definition.run({ ...context, lifetime, clientCapabilities, agentEventsManaged: true,
      registerInput(handler, description, prepare, reconcile) {
        admit();
        if (!definition.input || inputHandler || typeof handler !== 'function') throw projectError('INVALID_HARNESS_INPUT_HANDLER', 'Declare and register one input handler');
        inputDescription = jsonCopy(description ?? inputDescription);
        inputHandler = handler;
        prepareInput = prepare;
        reconcileInput = reconcile;
        changed();
      },
      registerAgentControls(registration) {
        admit();
        if (!registration?.runtime || [...registrations.keys()].some(existing => existing.runtime === registration.runtime)) throw projectError('INVALID_AGENT_REGISTRATION', 'Register one owned Runtime once');
        const unsubscribe = registration.runtime.onEvent(event => {
          if (event.type === 'agentChanged' || event.type === 'runtimeChanged' || event.type === 'management') {
            void refreshTargets(registration, true);
          }
          if (event.type !== 'agentChanged' && event.type !== 'runtimeChanged') {
            const eventJson = jsonCopy({ kind: 'agent', event }) as HarnessJson;
            recordOutput(eventJson);
            publish({ type: 'event', runId: context.runId, event: eventJson });
          }
        });
        registrations.set(registration, { unsubscribe, agents: [], requested: 0, applied: 0 });
        void refreshTargets(registration, true);
        return () => {
          unsubscribe();
          const previousAgents = observationAgents();
          if (!registrations.delete(registration)) return;
          lastAgents = previousAgents;
          for (const [id, owner] of targets) if (owner === registration) { targets.delete(id); targetStates.delete(id); }
          if (!finalizing) changed();
        };
      },
      async runWithRuntime(options) {
        const evidence = await collectRuntimeEvidence(options);
        const report = { ...evidence, detail: options.detail?.() };
        const projected = (options.redact ? options.redact(report) : report) as typeof report;
        return projectRuntimeEvidence(projected, context.signal, projected.detail);
      },
      askUser: ask,
    });
  } };
  const host = createProjectHost(wrapped, { launchDirectory: options.launchDirectory ?? process.cwd(), ...options,
    finalizeResult(business, failure) {
      finalizing = true;
      closeQuestions('run-finished');
      for (const { unsubscribe } of registrations.values()) unsubscribe();
      return { ...redactor.value(business) as typeof business,
        ...(fenceFailed ? { cleanup: { ...business.cleanup, status: 'pending' as const, pending: ['runtime-dispatch-fence-unconfirmed'] } } : {}),
        failure: failure && { code: failure.code, message: redactor.text(failure.message) },
        questions: [...questions.values()].map(record => structuredClone(record.value)), operations: operationSummaries(),
      };
    },
  }, raw => {
    const record = raw as { event?: HarnessJson };
    if (record.event && typeof record.event === 'object' && !Array.isArray(record.event) && 'kind' in record.event && record.event.kind === 'status') changed();
    else if (record.event !== undefined) { recordOutput(record.event); publish({ type: 'event', runId: host.status().runId, event: jsonCopy(record.event) }); }
  });

  function observationAgents() { return [...registrations.values()].flatMap(observation => observation.agents); }
  async function refreshTargets(registration: HarnessAgentRegistration, notify = false): Promise<boolean> {
    const observation = registrations.get(registration);
    if (!observation) return false;
    if (finalizing) return true;
    const revision = ++observation.requested;
    try {
      const listed = await registration.runtime.list();
      const ids = registration.targets ? await registration.targets() : listed.map(agent => agent.id);
      if (registrations.get(registration) !== observation || finalizing) return false;
      if (revision < observation.applied) {
        if (notify) registration.onChange?.();
        return true;
      }
      const visible = new Set(ids);
      const agents = listed.filter(agent => visible.has(agent.id));
      if (visible.size !== agents.length) throw projectError('AGENT_NOT_FOUND', 'Registered target is outside its Runtime');
      if (ids.some(id => targets.has(id) && targets.get(id) !== registration)) throw projectError('AGENT_ID_CONFLICT', 'Agent belongs to another registered Runtime');
      observation.applied = revision;
      observation.agents = agents;
      let updated = false;
      for (const [id, owner] of targets) if (owner === registration && !visible.has(id)) { targets.delete(id); targetStates.delete(id); updated = true; }
      for (const agent of agents) {
        const { id, status } = agent;
        if (!targets.has(id)) updated = true;
        if (targetStates.get(id) !== status) updated = true;
        targets.set(id, registration);
        targetStates.set(id, status);
      }
      if (updated || notify) changed();
      if (notify) registration.onChange?.();
      return true;
    } catch {
      publish({ type: 'event', runId: host.status().runId, event: { kind: 'observation-error', code: 'RUNTIME_STATE_UNAVAILABLE' } });
      return false;
    }
  }
  function dispatchRequest(operation: string, requestId: string): HarnessDispatchRequest {
    const operationId = 'session:' + fingerprint([host.status().runId, operation, requestId]);
    return { requestId, operationId, signal: host.signal };
  }
  function mutate<T>(operation: string, payload: unknown, request: HarnessRequest, run: () => Promise<T> | T, reserved = false, validate?: () => void): Promise<T> {
    let id: string;
    let hash: string;
    try { id = requestIdentity(request); hash = fingerprint([operation, jsonCopy(payload)]); } catch (error) { return Promise.reject(error); }
    const existing = records.get(id);
    if (existing) {
      if (existing.fingerprint !== hash) return Promise.reject(projectError('REQUEST_ID_CONFLICT', 'requestId already identifies different parameters or operation'));
      if (existing.settled && existing.reconcile && isUnknown(existing.result)) {
        return observeHandler(existing.reconcile(), id, existing.result).then(value => structuredClone(updateReceipt(id, value)) as T);
      }
      return existing.settled ? Promise.resolve(structuredClone(existing.result) as T) : existing.promise as Promise<T>;
    }
    try {
      validate?.();
      if (operation !== 'stop') admit();
    } catch (error) { return Promise.reject(error); }
    if ((!reserved && records.size >= limits.mutations) || records.size >= limits.mutations + limits.questions + 1) return Promise.reject(projectError('REQUEST_LIMIT', 'Session mutation identities are full'));
    const deferred = Promise.withResolvers<T>();
    const record: OperationRecord = { operation, fingerprint: hash, promise: deferred.promise, settled: false };
    records.set(id, record);
    try {
      Promise.resolve(run()).then(value => {
        deferred.resolve(structuredClone(updateReceipt(id, value)) as T);
      }, error => { record.failed = true; deferred.reject(error); }).catch(error => { record.failed = true; deferred.reject(error); });
    } catch (error) { record.failed = true; deferred.reject(error); }
    void deferred.promise.catch(() => {});
    return deferred.promise;
  }
  function updateReceipt(requestId: string, value: unknown) {
    const record = records.get(requestId);
    if (!record) return jsonCopy(value);
    const copy = jsonCopy(value);
    // Preserve the first confirmed outcome if an older timeout or query arrives later.
    if (record.settled && !isUnknown(record.result)) return record.result;
    if (record.settled && stableStringify(record.result) === stableStringify(copy)) return record.result;
    record.result = copy;
    record.settled = true;
    publish({ type: 'operation', runId: host.status().runId, requestId, operation: record.operation, result: copy });
    return copy;
  }
  function inputReceipt(value: unknown, requestId: string): HarnessInputReceipt {
    const state = value && typeof value === 'object' && !Array.isArray(value) && 'status' in value ? value.status : null;
    return { status: state === 'unknown' || state === 'not_submitted' ? state : 'accepted', requestId, result: jsonCopy(value) as HarnessJson };
  }
  function observeHandler<T>(work: Promise<T>, requestId: string, unknown: T): Promise<T> {
    const deferred = Promise.withResolvers<T>();
    const expired = () => deferred.resolve(unknown);
    const timer = setTimeout(expired, limits.handlerTimeoutMs);
    void deferred.promise.finally(() => { clearTimeout(timer); host.signal.removeEventListener('abort', expired); }).catch(() => {});
    host.signal.addEventListener('abort', expired, { once: true });
    if (host.signal.aborted) expired();
    void work.then(value => {
      deferred.resolve(updateReceipt(requestId, value) as T);
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
    if (stopping || finalizing || host.signal.aborted) throw projectError('RUN_STOPPING', 'Run admission is closed');
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
      if (source.signal.aborted) throw projectError('QUESTION_CANCELLED', 'source-cancelled');
      if (source.agentId) source.assertAuthorized?.();
      if (raw.agentId !== source.agentId || (source.agentId && !targets.has(source.agentId))) throw projectError('QUESTION_SOURCE_MISMATCH', 'Question source does not own the target Agent');
      if (!['text', 'choice', 'confirm'].includes(raw.kind) || typeof raw.text !== 'string' || !raw.text.trim()) throw projectError('INVALID_QUESTION', 'A question kind and text are required');
      if (raw.kind === 'choice' && (!Array.isArray(raw.options) || !raw.options.length || raw.options.some(option => typeof option?.id !== 'string' || !option.id || typeof option.label !== 'string' || jsonBytes(option.id) > 60 * 1024) || new Set(raw.options.map(option => option.id)).size !== raw.options.length)) throw projectError('INVALID_QUESTION', 'Choice questions require unique option IDs that fit an answer frame');
      if (raw.kind !== 'choice' && raw.options !== undefined) throw projectError('INVALID_QUESTION', 'Only choice questions accept options');
      const timeoutMs = raw.timeoutMs ?? 60_000;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) throw projectError('INVALID_QUESTION', 'Question timeout must be 1 to 3600000 ms');
      const hash = fingerprint([raw, source.id, source.agentId ?? null]);
      const previous = questionRequests.get(raw.requestId);
      if (previous) {
        if (previous.fingerprint !== hash) throw projectError('REQUEST_ID_CONFLICT', 'Question requestId identifies different parameters');
        return previous.promise;
      }
      const questionId = raw.questionId ?? randomUUID();
      if (typeof questionId !== 'string' || !questionId || questionId.length > 128 || questions.has(questionId)) throw projectError('QUESTION_ID_CONFLICT', 'Question identity is already used or invalid');
      const deferred = Promise.withResolvers<HarnessAnswer>();
      const value: HarnessQuestion = {
        requestId: raw.requestId, questionId, kind: raw.kind, text: redactor.text(raw.text),
        ...(raw.options ? { options: raw.options.map(({ id, label }) => ({ id, label: redactor.text(label) })) } : {}),
        agentId: raw.agentId, businessRef: redactor.value(raw.businessRef) as HarnessJson | undefined, sourceId: source.id,
        createdAt: new Date().toISOString(), deadline: new Date(Date.now() + timeoutMs).toISOString(), status: 'pending',
        ...(raw.kind === 'text' ? { maxAnswerBytes: 16 * 1024 } : {}),
      };
      const answerBytes = value.maxAnswerBytes ?? (value.kind === 'confirm' ? jsonBytes(false)
        : value.options!.reduce((largest, option) => Math.max(largest, jsonBytes(option.id)), 0));
      const bytes = jsonBytes({ ...value, status: 'cancelled', reason: 'source-unauthorized', answer: null })
        - jsonBytes(null) + answerBytes + 1;
      if (questions.size >= limits.questions || questionBytes + bytes > questionBudget) throw projectError('QUESTION_LIMIT', 'Question capacity is full');
      let timer: NodeJS.Timeout;
      let authorizationTimer: NodeJS.Timeout | undefined;
      const cancelled = () => settleQuestion(record, 'cancelled', 'source-cancelled');
      const record: QuestionRecord = { value, fingerprint: hash, promise: deferred.promise, resolve: deferred.resolve, reject: deferred.reject, source,
        release() { clearTimeout(timer); clearInterval(authorizationTimer); source.signal.removeEventListener('abort', cancelled); } };
      questions.set(questionId, record);
      questionRequests.set(raw.requestId, record);
      questionBytes += bytes;
      timer = setTimeout(() => settleQuestion(record, 'expired', 'deadline'), timeoutMs);
      source.signal.addEventListener('abort', cancelled, { once: true });
      if (source.assertAuthorized) authorizationTimer = setInterval(() => {
        try { source.assertAuthorized!(); } catch { settleQuestion(record, 'cancelled', 'source-unauthorized'); }
      }, 100);
      record.promise = deferred.promise.then(answer => { admit(); source.signal.throwIfAborted(); source.assertAuthorized?.(); return answer; });
      void record.promise.catch(() => {});
      if (source.signal.aborted) cancelled();
      else publish({ type: 'question', runId: host.status().runId, question: structuredClone(value) });
      return record.promise;
    } catch (error) { return Promise.reject(error); }
  }
  function declaredCapabilities(registration: HarnessAgentRegistration, id: string) {
    const declared = typeof registration.capabilities === 'function' ? registration.capabilities(id) : registration.capabilities;
    return { getState: { supported: true }, getStats: { supported: true }, getMessages: { supported: true },
      configure: { supported: false }, compact: { supported: false }, abortRetry: { supported: false }, clearQueue: { supported: false },
      send: { supported: false }, interrupt: { supported: false }, stop: { supported: false }, ...declared };
  }
  function executorSupports(capability: ReturnType<typeof readRuntimeSessionCapabilities>, operation: HarnessOperation) {
    const names = { getState: 'state', getStats: 'stats', getMessages: 'messages', send: null, interrupt: null, stop: null,
      configure: 'configure', compact: 'compact', clearQueue: 'clearQueue', abortRetry: 'abortRetry' } as const;
    const name = names[operation];
    return name === null || capability?.[name] === true;
  }
  async function registrationFor(agentId: string) {
    if (typeof agentId !== 'string' || !agentId || agentId.length > 128) throw projectError('INVALID_AGENT', 'Expected an Agent identity');
    const refreshed = new Set<HarnessAgentRegistration>();
    for (const registration of registrations.keys()) if (await refreshTargets(registration)) refreshed.add(registration);
    const registration = targets.get(agentId);
    if (!registration) throw projectError('AGENT_NOT_FOUND', 'Target does not belong to this Run');
    if (!refreshed.has(registration)) throw projectError('RUNTIME_STATE_UNAVAILABLE', 'Could not refresh the target scope');
    return registration;
  }
  async function query(operation: 'getState' | 'getStats' | 'getMessages', agentId: string, options?: unknown) {
    const registration = await registrationFor(agentId);
    assertTargetReady(agentId);
    const capability = declaredCapabilities(registration, agentId)[operation];
    if (!capability?.supported || !executorSupports(readRuntimeSessionCapabilities(registration.runtime, agentId), operation)) throw projectError('OPERATION_UNSUPPORTED', 'Agent query is unsupported');
    if (capability.available === false) throw projectError('OPERATION_BUSY', capability.reason ?? 'Agent query is temporarily unavailable');
    const native = (registration.runtime as typeof registration.runtime & { session: RuntimeSession }).session;
    if (!native) throw projectError('OPERATION_UNSUPPORTED', 'Executor has no session queries');
    const response = registration.handlers?.[operation]
      ? await registration.handlers[operation]!(agentId, options ?? null, { requestId: '', operationId: randomUUID(), signal: host.signal })
      : operation === 'getMessages' ? await native.getMessages(agentId, options as Parameters<RuntimeSession['getMessages']>[1])
      : await native[operation](agentId);
    return jsonCopy(response, maxSessionQueryBytes);
  }
  function assertTargetReady(agentId: string) {
    const state = targetStates.get(agentId);
    if (state === 'starting') throw projectError('AGENT_NOT_READY', 'Agent Session is starting');
    if (['exited', 'closing', 'closed'].includes(state ?? '')) throw projectError('SESSION_UNAVAILABLE', 'Agent Session is closed');
  }
  async function control(operation: HarnessOperation, agentId: string, payload: unknown, request: HarnessRequest) {
    return mutate('agent.' + operation, { agentId, payload }, request, async () => {
      admit();
      const registration = await registrationFor(agentId);
      admit();
      assertTargetReady(agentId);
      const capability = declaredCapabilities(registration, agentId)[operation];
      const nativeCapabilities = readRuntimeSessionCapabilities(registration.runtime, agentId);
      if (!capability?.supported || !executorSupports(nativeCapabilities, operation)) throw projectError('OPERATION_UNSUPPORTED', 'Harness or executor does not support this Agent operation');
      if (capability.available === false) throw projectError('OPERATION_BUSY', capability.reason ?? 'Agent operation is temporarily unavailable');
      if (operation === 'send') {
        const send = payload as { input: unknown; options: { mode?: string; delivery?: string } };
        if (typeof send.input === 'string') {
          if (capability.text !== true || (capability.modes && !capability.modes.includes(send.options.mode ?? 'steer'))) throw projectError('OPERATION_UNSUPPORTED', 'Harness does not support this text delivery');
        } else if (nativeCapabilities?.context !== true || capability.context !== true || !send.options.delivery || !capability.deliveries?.includes(send.options.delivery)) throw projectError('OPERATION_UNSUPPORTED', 'Harness does not support this context delivery');
      }
      if (operation === 'configure' && capability.fields) {
        const paths = Object.entries(payload as Record<string, unknown>).flatMap(([key, value]) => value && typeof value === 'object' && !Array.isArray(value)
          ? Object.keys(value).map(child => key + '.' + child) : [key]);
        if (paths.some(path => !capability.fields!.includes(path))) throw projectError('OPERATION_UNSUPPORTED', 'Harness does not allow this configuration field');
      }
      const handler = registration.handlers?.[operation];
      if (!handler && operation !== 'configure' && operation !== 'abortRetry') throw projectError('OPERATION_UNSUPPORTED', 'Harness has no scheduling handler for this operation');
      const native = (registration.runtime as typeof registration.runtime & { session: RuntimeSession }).session;
      const operationRecord = records.get(request.requestId)!;
      const dispatch = dispatchRequest('agent.' + operation, request.requestId);
      const nativeRequest = { requestId: dispatch.operationId };
      if (!handler) operationRecord.reconcile = () => reconcileRuntimeReceipt(registration.runtime, agentId, operation, nativeRequest.requestId);
      else if (registration.reconcile) operationRecord.reconcile = () => registration.reconcile!(operation, agentId, dispatch, payload);
      const dispatched = Promise.resolve(handler ? handler(agentId, payload, dispatch)
        : operation === 'abortRetry' ? native.abortRetry(agentId, nativeRequest)
        : native.configure(agentId, payload as Parameters<RuntimeSession['configure']>[1], nativeRequest));
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
    if (value.maxAnswerBytes !== undefined && jsonBytes(answer) > value.maxAnswerBytes) throw projectError('INVALID_ANSWER', 'Answer exceeds the declared text byte limit');
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
    async describe() { for (const registration of registrations.keys()) await refreshTargets(registration); return structuredClone(descriptor()); },
    async getState() { return snapshot(); },
    onEvent(handler, subscribeOptions) {
      const subscription = events.subscribe(handler, subscribeOptions);
      if (subscribeOptions?.initialSnapshot) {
        try { subscription.start({ type: 'snapshot', state: snapshot() }); }
        catch { subscription.close(projectError('OBSERVATION_UNAVAILABLE', 'Snapshot could not be created')); }
      }
      return () => subscription.close();
    },
    start(raw, request) {
      return mutate('start', raw, request, () => {
        const input = resolveHarnessInput(raw, options.launchDirectory ?? process.cwd());
        const started = host.start(input);
        completion = started.completion.then(finished => {
          exitCode = finished.code;
          result = publicHarnessResult(finished.result);
          publish({ type: 'result', result });
          changed();
          return structuredClone(result);
        });
        setImmediate(changed);
        return { ...started.accepted, phase: 'starting', status: 'accepted' } as HarnessStartReceipt;
      });
    },
    input(payload, request) {
      return mutate('input', payload, request, () => {
        if (!definition.input) throw projectError('OPERATION_UNSUPPORTED', 'This Harness does not accept input');
        if (!inputHandler || host.status().phase !== 'running') throw projectError('RUN_NOT_READY', 'Harness input route is not ready');
        const copy = jsonCopy(payload, limits.inputBytes);
        const bytes = Buffer.byteLength(JSON.stringify(copy));
        if (queuedCount >= limits.inputQueue || queuedBytes + bytes > limits.inputBytes) throw projectError('REQUEST_LIMIT', 'Harness input queue is full');
        const dispatch = dispatchRequest('input', request.requestId);
        const binding = prepareInput?.(copy, dispatch);
        queuedCount++; queuedBytes += bytes;
        const work = inputTail.then(async () => {
          queuedCount--; queuedBytes -= bytes;
          admit();
          const originalRequest = { ...dispatch, binding };
          if (reconcileInput) records.get(request.requestId)!.reconcile = () =>
            Promise.resolve(reconcileInput!(copy, originalRequest)).then(value => inputReceipt(value, request.requestId));
          const handled = Promise.resolve(inputHandler!(copy, originalRequest)).then(value => inputReceipt(value, request.requestId));
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
        const redacted = value.kind === 'text' ? redactor.text(answer) as HarnessAnswer : answer;
        value.status = 'answered';
        value.answer = value.maxAnswerBytes !== undefined && jsonBytes(redacted) > value.maxAnswerBytes ? '[redacted]' : redacted;
        record.release(); record.resolve(answer);
        publish({ type: 'question', runId: host.status().runId, question: structuredClone(value) });
        return { status: 'answered', questionId, answer } as HarnessAnswerReceipt;
      }, true, () => { answerRecord(questionId, answer); });
    },
    stop(request) {
      return mutate('stop', { reason: request.reason ?? 'requested' }, request, () => {
        if (!stopReceipt) { stop(request.reason ?? 'requested'); const state = host.status(); stopReceipt = { status: 'accepted', runId: state.runId, phase: state.phase, reason: state.stopReason ?? 'requested' }; }
        return stopReceipt;
      }, true);
    },
    get completion() { return completion; },
  };
  internals.set(session, { snapshot, runId: () => host.status().runId, signal: host.signal, stop, exitCode: () => exitCode });
  return session;
}

import type {
  AgentEvent, AgentInfo, AgentListFilter, AgentObservation, CollectionSpec, ConditionalInputReceipt,
  CreateRuntimeOptions, ErrorInfo, InputReceipt, InterruptReceipt, PendingCleanup, Profile, Runtime,
  RuntimeManagementChange, RuntimeObservationChange, RuntimeObservationOptions, SendOptions,
} from './types.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createCoreBridge } from './bridge.js';
import { snapshotProfiles, snapshotSpawn, validId } from './config.js';
import { createCoreModelAccess } from './model-access.js';
import { createModelTrace } from './model-trace.js';
import { createInputLedger } from './input-ledger.js';
import { createFileControls } from './file-controls.js';
import { saveAgentArtifacts } from './artifact-collection.js';
import { createRedactor, createRunRecords, runtimeConfiguration } from './run-records.js';
import type { RunEvidenceRecord } from './run-records.js';
import { createRuntimeObservation } from './runtime-observation.js';
import { createRuntimeManagement } from './runtime-management.js';
import { claimOpenSandboxBackend, openOpenSandboxBackend } from './opensandbox-backend.js';
import { createAgentService } from './agent-service.js';
import { createServiceTrace, exportServiceStates } from './service-trace.js';
import { registerServicePrivateValues, snapshotServiceRegistry, type ServiceRegistration } from './services.js';

export { finalizeRun } from './run-finalization.js';
export type * from './types.js';

interface InterruptRequest {
  interruptId: string;
  executionEpoch: number;
  confirmed?: boolean;
  discardedInputHashes?: readonly string[];
  work?: Promise<void>;
}

interface InputRequest {
  inputId: string;
  dispatched?: boolean;
  run(): Promise<ConditionalInputReceipt>;
  result?: Promise<ConditionalInputReceipt>;
}

interface RuntimeAgent {
  executionEpoch: number;
  interruptRequests: Map<string, InterruptRequest>;
  interruption?: InterruptRequest;
  info: AgentInfo;
  profile: Profile;
  controller: AbortController;
  activityClaims: Set<unknown>;
  nativeExecuting: boolean;
  executionStopped: boolean;
  cleanupAction?: PendingCleanup['action'];
  nativeSettlement?: { recordSeq: number; workerSequence?: number };
  fatal?: boolean;
  collect?: CollectionSpec;
  start?: Promise<AgentInfo>;
}

const defaultTimeoutMs = 60_000;
const timedOut = Symbol('timed out');
const liveStates = new Set(['idle', 'running']);
const agentStates = new Set(['starting', ...liveStates, 'exited', 'closing', 'closed']);
const knownInputRejections = new Set(['INVALID_CONTRACT', 'NOT_ALLOWED', 'CONFLICT', 'NOT_FOUND']);

function resourceError(code: any, message: any, context: any, { cleanup = 'complete', details = [] }: any = {}) {
  return Object.assign(new Error(message), { name: 'ResourceError', code, ...context, cleanup, details });
}

async function observe(work: any, timeoutMs: any = defaultTimeoutMs) {
  let timer;
  try {
    return await Promise.race([work, new Promise<any>((resolve: any) => {
      timer = setTimeout(() => resolve(timedOut), timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function writeRecord(path: any, value: any) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } catch (error: any) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function createRuntime(options: CreateRuntimeOptions): Promise<Runtime> {
  const runtimeId = randomUUID();
  const context = { operation: 'createRuntime', runtimeId };
  const redactor = createRedactor([process.env.OPEN_SANDBOX_API_KEY, process.env.MURM_EXECD_ACCESS_TOKEN]);
  const errorInfo = redactor.error;
  let config: ReturnType<typeof claimOpenSandboxBackend>;
  function validateProfileExecution(profile: Profile) {
    config.driver.assertEnvironment?.(profile.env);
    if (profile.allowContextFork && !config.driver.capabilities.contextFork) throw new TypeError('Backend does not support Profile Context Fork authority');
  }
  let registrations: Map<string, ServiceRegistration>, profiles: Map<string, Profile>, modelAccessPolicy, outputDir: string;
  try {
    if (!Number.isSafeInteger(options?.maxAgents) || options.maxAgents < 1 ||
        typeof options.outputDir !== 'string' || !options.outputDir.trim()) {
      throw new TypeError('A positive maxAgents and outputDir are required');
    }
    if (options.modelAccessPolicy !== undefined && (typeof options.modelAccessPolicy?.authorize !== 'function' ||
        typeof options.modelAccessPolicy?.withCommit !== 'function')) {
      throw new TypeError('modelAccessPolicy must provide synchronous authorize and withCommit');
    }
    if (options.agentAccessPolicy !== undefined && typeof options.agentAccessPolicy !== 'function') {
      throw new TypeError('agentAccessPolicy must be a synchronous function');
    }
    config = claimOpenSandboxBackend(options.backend);
    redactor.add([config.sandbox.apiKey, config.sandbox.execdToken,
      ...Object.values(config.models).flatMap((model) => Object.values(model.upstream.headers))]);
    registrations = snapshotServiceRegistry(options.services);
    registerServicePrivateValues(registrations, redactor.add);
    registrations.set('agent', createAgentService({ runtimeId, getAgent: id => getAgent(id),
      spawn: (input, caller) => spawn(input, caller), get, send, stop,
      accessPolicy: options.agentAccessPolicy, getAccess: id => management.access.get(id),
      mutateAccess: (kind, input, caller) => management.mutateAccess(kind, input, caller) }));
    profiles = snapshotProfiles(options.profiles, config.models, registrations);
    for (const profile of profiles.values()) validateProfileExecution(profile);
    modelAccessPolicy = options.modelAccessPolicy;
    outputDir = join(resolve(options.outputDir), runtimeId);
  } catch (error: any) {
    throw resourceError('INVALID_CONTRACT', redactor.text(error.message), context, { details: [errorInfo(error, 'INVALID_CONTRACT')] });
  }

  const maxAgents = options.maxAgents;
  const assemblyDeadline = performance.now() + defaultTimeoutMs;
  const agents = new Map<any, any>();
  const reportPath = join(outputDir, 'runtime.json');
  const liveObservation = createRuntimeObservation(runtimeId);
  const records = createRunRecords(outputDir, runtimeId, {
    record: observeRunRecord,
    loss: evidence => liveObservation.publish({ type: 'persistence', evidence }),
  });
  const modelTrace = createModelTrace(outputDir, redactor);
  const serviceTrace = createServiceTrace(outputDir, redactor.value);
  const effectiveConfig = runtimeConfiguration({ config, profiles, registrations, maxAgents, modelAccessPolicy, defaultTimeoutMs }, redactor.text);
  const saveSummary = (status: any, data: any = {}) => writeRecord(reportPath, {
    runtimeId, status, maxAgents, config: effectiveConfig, evidence: records.snapshot(),
    modelLedgers: modelAccess?.ledgerPaths?.() ?? [], modelTrace: modelTrace.snapshot(), ...data,
  });
  const getAgent = (agentId: any) => {
    const agent = agents.get(agentId);
    return agent && {
      profile: agent.info.profile, model: agent.profile.model, status: agent.info.status,
      unavailable: agent.fatal === true,
      ...management.bridgeAccess(agentId), parentId: agent.info.parentId, spawnProfiles: agent.profile.spawnProfiles, allowContextFork: agent.profile.allowContextFork,
    };
  };
  let bridge: any, modelAccess: any, backend: any;
  let closing = false;
  const management = createRuntimeManagement({
    profiles, registrations,
    validateProfile(id, profile) {
      const snapshot = snapshotProfiles({ [id]: profile }, config.models, registrations, profiles).get(id)!;
      validateProfileExecution(snapshot);
      return snapshot;
    },
    isClosing: () => closing,
    isAgentLive: id => agents.has(id) && isLive(agents.get(id)),
    cancelAccess: (agentId, serviceId, operations) => bridge.cancelAccess(agentId, serviceId, operations),
    redact: redactor.value,
    addSecrets: redactor.add,
    drainService: id => bridge.drainService(id),
    hasUncertainWrites: id => bridge.hasUncertainWrites(id),
    async exportService(registration) {
      const [result] = await exportServiceStates(new Map([[registration.manifest.id, registration]]), outputDir, redactor.value);
      return result as { path?: string; error?: ErrorInfo } | undefined;
    },
    changed: change => records.record('management', redactor.value(change) as Record<string, unknown>),
  });
  let recordsReady = false;
  let reportSaved = false;
  const assertAssembling = () => {
    if (closing) throw Object.assign(new Error('Runtime initialization was closed'), { code: 'OPERATION_UNKNOWN' });
  };
  const endpointCleanup: Record<'bridge' | 'model' | 'backend', { kind: string; id: string; action: string; done: boolean; error?: ErrorInfo }> = {
    bridge: { kind: 'bridge', id: runtimeId, action: 'close', done: false },
    model: { kind: 'model', id: runtimeId, action: 'close', done: false },
    backend: { kind: 'backend', id: runtimeId, action: 'close', done: false },
  };
  function pendingEndpoint(subject: any) {
    const { kind, id, action, error } = subject;
    return { kind, id, action, ...(error ? { error } : {}) };
  }
  async function closeEndpoint(kind: keyof typeof endpointCleanup, endpoint: any) {
    const subject = endpointCleanup[kind];
    if (subject.done) return;
    try {
      await endpoint?.close();
      subject.done = true;
      subject.error = undefined;
    } catch (error: any) {
      subject.error = errorInfo(error);
    }
  }
  function pendingEndpoints() {
    return Object.values(endpointCleanup).filter((subject: any) => !subject.done).flatMap((subject: any) => {
      const details = subject.kind === 'model' ? modelAccess?.pendingCleanup() : undefined;
      return details?.length ? details : [pendingEndpoint(subject)];
    });
  }
  const assembly = (async () => {
    await mkdir(outputDir, { recursive: true, mode: 0o700 });
    recordsReady = true;
    await records.initialize();
    await Promise.all([modelTrace.initialize(), serviceTrace.initialize()]);
    await saveSummary('starting');
    reportSaved = true;
    assertAssembling();
    modelAccess = await createCoreModelAccess({ runtimeId, outputDir, config, getAgent, modelAccessPolicy, modelTrace,
      onOwned: owner => { modelAccess = owner; } });
    assertAssembling();
    bridge = await createCoreBridge({ runtimeId, configuration: config.bridge, getAgent, registrations,
      traceService: entry => serviceTrace.record(entry),
      recordService: entry => records.record('service', { ...entry,
        serviceId: redactor.text(entry.serviceId), operation: redactor.text(entry.operation),
        operationId: redactor.text(entry.operationId),
        ...(entry.error ? { error: { ...entry.error, code: redactor.text(entry.error.code) } } : {}),
      }),
      onOwned: (owner: any) => { bridge = owner; } });
    assertAssembling();
    backend = await openOpenSandboxBackend(config, { runtimeId, outputDir, bridge, modelAccess,
      registerPrivateValues: redactor.add });
    await saveSummary('open');
  })();
  const closeEndpoints = () => Promise.all([closeEndpoint('bridge', bridge), closeEndpoint('model', modelAccess)]);
  const rollbackAssembly = async () => {
    const failure = await assembly.then(() => undefined, (error: any) => errorInfo(error));
    await Promise.all([closeEndpoints(), closeEndpoint('backend', backend)]);
    const pending = pendingEndpoints();
    const errors = pending.flatMap((item: any) => item.error ? [item.error] : []);
    if (recordsReady) {
      try {
        if (failure) records.record('runtime', { state: 'initialization-failed', error: failure });
        await records.flush();
        await serviceTrace.flush();
        await saveSummary('initialization-failed', { cleanup: pending.length ? 'pending' : 'complete', errors, pending, failure });
        reportSaved = true;
      } catch (error: any) {
        const failure = { ...errorInfo(error), code: 'REPORT_WRITE_FAILED' };
        errors.push(failure);
        pending.push({ kind: 'report', id: runtimeId, action: 'save', error: failure });
      }
    }
    return { errors, pending };
  };
  try {
    if (await observe(assembly) === timedOut) {
      closing = true;
      void rollbackAssembly();
      throw resourceError('OPERATION_UNKNOWN', 'Runtime initialization timed out', {
        ...context, ...(reportSaved ? { reportPath } : {}),
      }, { cleanup: 'pending', details: [{ code: 'OPERATION_UNKNOWN', message: 'Runtime assembly is still being reconciled', retryable: true }] });
    }
  } catch (error: any) {
    if (error.name === 'ResourceError') throw error;
    const rollback = await observe(rollbackAssembly(), Math.max(1, assemblyDeadline - performance.now()));
    const code = error.code === 'INVALID_CONFIG' ? 'INVALID_CONTRACT' : error.code ?? 'SERVICE_UNAVAILABLE';
    throw resourceError(code, redactor.text(error.message), {
      ...context, ...(reportSaved ? { reportPath } : {}),
    }, {
      cleanup: rollback === timedOut || rollback.pending.length ? 'pending' : 'complete',
      details: rollback === timedOut ? [errorInfo(error)] : [errorInfo(error), ...rollback.errors],
    });
  }

  const handlers = new Set<(event: AgentEvent) => void>();
  const spawnRequests = new Map<any, any>();
  const inputRequests = createInputLedger<InputRequest>(runtimeId);
  const fileControls = createFileControls({ backend, findAgent, problem, observe, timedOut,
    isLive: (agent: any) => !closing && isLive(agent) });
  const handlerErrors: any[] = [];
  let handlerErrorCount = 0;
  let closeWork: any;
  let finalClose: any;

  function problem(code: any, message: any, operation: string, agentId?: string, requestId?: string, cleanup: any = 'complete', details: any = []) {
    const error = resourceError(redactor.text(code), redactor.text(message), {
      operation, runtimeId, ...(agentId === undefined ? {} : { agentId }),
      ...(typeof requestId === 'string' ? { requestId: redactor.text(requestId) } : {}), ...(reportSaved ? { reportPath } : {}),
    }, { cleanup, details });
    records.record('resource-error', { operation, agentId: redactor.text(agentId), requestId: error.requestId,
      error: errorInfo(error), cleanup, details });
    return error;
  }

  function findAgent(agentId: string, operation: string, requestId?: string) {
    const agent = agents.get(agentId);
    if (!agent) throw problem('NOT_FOUND', 'Agent does not belong to this Runtime', operation, agentId, requestId);
    return agent;
  }

  function bound(options: { timeoutMs?: number } | undefined, operation: string, agentId?: string) {
    const timeoutMs = options?.timeoutMs ?? defaultTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) {
      throw problem('INVALID_CONTRACT', 'timeoutMs must be a positive supported timer duration', operation, agentId);
    }
    return timeoutMs;
  }

  function revoke(agentId: any, { abortServices = false }: any = {}) {
    bridge.revokeAgent(agentId, { abortActive: abortServices });
    modelAccess.revokeAgent(agentId);
  }

  function isLive(agent: any) {
    return !agent.fatal && liveStates.has(agent.info.status);
  }

  function observationAgent(agent: RuntimeAgent): AgentObservation {
    const { id, profile, parentId, status, cursor: agentSeq } = agent.info;
    const execution = agent.executionStopped || status === 'exited' ? 'inactive'
      : agent.fatal ? 'unknown'
      : agent.nativeExecuting ? 'active'
      : agent.activityClaims.size ? 'unknown' : 'inactive';
    const pending = agent.info.lastStop?.pending;
    const evidenceId = (value: string | undefined) => value && value.length <= 256 ? redactor.text(value) : undefined;
    return { id, profile, parentId, status, agentSeq, execution,
      ...(status === 'closing' || status === 'closed' ? { cleanup: {
        status: status === 'closed' ? 'complete' : 'pending',
        execution: agent.executionStopped ? 'stopped' : 'unknown',
        ...(status === 'closing' ? { action: agent.cleanupAction, resourceKey: evidenceId(pending?.resourceKey),
          sandboxId: evidenceId(pending?.sandboxId) } : {}),
      } } : {}) };
  }

  function observeRunRecord(row: RunEvidenceRecord) {
    if (row.type === 'runtime' && row.state === 'closing') {
      liveObservation.publish({ type: 'runtime', runtimeState: 'closing', cleanup: 'pending' }, row.seq);
      return;
    }
    if (row.type === 'management') {
      const { type, runtimeId, at, seq, ...change } = row;
      liveObservation.publish({ type: 'management', change: change as unknown as RuntimeManagementChange }, seq);
      return;
    }
    if (row.type === 'service' && typeof row.attemptId === 'string') {
      const entry = row as RunEvidenceRecord & Extract<RuntimeObservationChange, { type: 'service' }> & { error?: { code: string } };
      liveObservation.publish({ type: 'service', agentId: entry.agentId, serviceId: entry.serviceId,
        operation: entry.operation, operationId: entry.operationId, attemptId: entry.attemptId,
        state: entry.state, outcome: entry.outcome, ...(entry.error ? { errorCode: entry.error.code } : {}) }, row.seq);
      return;
    }
    if (!['spawn', 'stop', 'interrupt', 'event', 'input', 'native', 'trace-gap'].includes(row.type)) return;
    const agent: RuntimeAgent | undefined = agents.get(row.agentId);
    if (!agent) return;
    if (row.type === 'native') {
      const workerSequence = typeof row.workerSequence === 'number' ? row.workerSequence : undefined;
      if (row.eventType === 'agent_start') liveObservation.publish({
        type: 'execution', phase: 'started', association: 'unknown', agent: observationAgent(agent), workerSequence,
      }, row.seq);
      if (row.eventType === 'agent_settled') agent.nativeSettlement = { recordSeq: row.seq, workerSequence };
      return;
    }
    const subject = observationAgent(agent);
    if (row.type === 'input') {
      const input = row as RunEvidenceRecord & Extract<RuntimeObservationChange, { type: 'input' }>;
      liveObservation.publish({ type: 'input', agent: subject, inputId: input.inputId, requestId: input.requestId,
        state: input.state, disposition: input.disposition, reason: input.reason }, row.seq);
    } else if (row.type === 'event') {
      const event = row.event as AgentEvent;
      if (event.type === 'settled') {
        const native = agent.nativeSettlement;
        agent.nativeSettlement = undefined;
        liveObservation.publish({ type: 'execution', phase: 'settled', association: 'unknown', agent: subject,
          outcome: event.outcome, ...(native ? { workerSequence: native.workerSequence } : {}) }, native?.recordSeq ?? row.seq);
      } else {
        liveObservation.publish({ type: 'agent', agent: subject, cause: event.type }, row.seq);
      }
    } else if (row.type === 'trace-gap') {
      liveObservation.publish({ type: 'trace-gap', agent: { ...subject, execution: 'unknown' },
        ...(typeof row.expectedWorkerSequence === 'number' ? { expectedWorkerSequence: row.expectedWorkerSequence } : {}),
        ...(typeof row.observedWorkerSequence === 'number' ? { observedWorkerSequence: row.observedWorkerSequence } : {}),
      }, row.seq);
    } else {
      liveObservation.publish({ type: 'agent', agent: subject, cause: row.type as 'spawn' | 'stop' | 'interrupt' }, row.seq);
    }
  }

  function observeRuntime(options: RuntimeObservationOptions = {}) {
    return liveObservation.subscribe(options, () => {
      const { recorded, lost, pending } = records.snapshot();
      return {
        runtimeState: finalClose ? 'closed' : closing ? 'closing' : 'open',
        ...(closing ? { cleanup: finalClose ? 'complete' as const : 'pending' as const } : {}),
        agents: [...agents.values()].map(observationAgent),
        management: management.snapshot(),
        evidence: { recorded, lost, pending },
      };
    });
  }

  function refreshActivity(agent: any) {
    if (liveStates.has(agent.info.status)) {
      agent.info.status = agent.nativeExecuting || agent.activityClaims.size ? 'running' : 'idle';
    }
  }

  function emit(agent: any, payload: any) {
    const { info } = agent;
    const { type, ...values } = payload;
    const event = structuredClone({ ...values, type, agentId: info.id, seq: ++info.cursor });
    if (event.text !== undefined) event.text = redactor.text(event.text);
    if (event.output !== undefined) event.output = redactor.text(event.output);
    if (event.reason !== undefined) event.reason = redactor.text(event.reason);
    if (event.error !== undefined) event.error = errorInfo(event.error);
    if (event.type === 'output') info.latestOutput = event.text;
    if (event.type === 'settled') {
      agent.nativeExecuting = false;
      // This execution no longer owns running. Input receipts remain intact:
      // a settled event does not establish which queued inputs were consumed.
      agent.activityClaims.clear();
      refreshActivity(agent);
      info.latestOutput = event.output;
      info.lastError = event.error;
    }
    if (event.type === 'error') {
      info.lastError = event.error;
      if (event.fatal) {
        // A fatal failure fences authority, but does not prove physical exit or
        // release any owned resource. Keep original receipt lookups available.
        agent.fatal = true;
        agent.controller.abort();
        revoke(info.id, { abortServices: true });
      }
    }
    if (event.type === 'exit') {
      agent.nativeExecuting = false;
      agent.activityClaims.clear();
      if (info.status !== 'closing' && info.status !== 'closed') {
        info.status = 'exited';
        revoke(info.id);
      }
    }
    records.record('event', { agentId: info.id, event });
    for (const handler of [...handlers]) {
      const recordFailure = (error: any) => {
        let name = 'Error';
        try {
          const candidate = error?.name;
          if (typeof candidate === 'string') name = redactor.text(candidate);
        } catch { /* Uninspectable subscriber rejection */ }
        const entry = { agentId: info.id, eventSeq: event.seq, name };
        handlerErrorCount++;
        if (handlerErrors.length < 32) handlerErrors.push(entry);
        records.record('subscriber-error', entry);
      };
      try { Promise.resolve(handler(structuredClone(event))).catch(recordFailure); }
      catch (error: any) { recordFailure(error); }
    }
  }

  function stopReceipt(agent: any, pendingError?: ErrorInfo) {
    const agentId = agent.info.id;
    const error = pendingError ?? agent.cleanupError;
    return { agentId, execution: agent.executionStopped ? 'stopped' : 'unknown',
      cleanup: agent.info.status === 'closed' ? 'complete' : 'pending',
      ...(agent.sessionArchive ? { sessionArchive: agent.sessionArchive } : {}),
      artifacts: agent.artifacts ?? [], errors: [agent.optionalCollectionError, agent.cleanupError, pendingError].filter(Boolean),
      ...(agent.info.status === 'closed' ? {} : { pending: {
        kind: 'agent', id: agentId, action: agent.cleanupAction ?? 'stop-execution',
        ...backend.resource(agentId), ...(error ? { error } : {}),
      } }),
    };
  }

  function currentStop(agent: any) {
    return agent.stopWork ? stopReceipt(agent, {
      code: 'OPERATION_UNKNOWN', message: `Waiting for ${agent.cleanupAction} confirmation`, retryable: true,
    }) : agent.info.lastStop ?? stopReceipt(agent);
  }

  function stopPhase(agent: RuntimeAgent, action: PendingCleanup['action']) {
    agent.cleanupAction = action;
    records.record('stop', { agentId: agent.info.id, state: 'phase', action });
  }

  function beginStop(agent: any) {
    if (agent.info.status === 'closed') return Promise.resolve(agent.info.lastStop);
    if (agent.stopWork) return agent.stopWork;
    const { info } = agent;
    info.status = 'closing';
    agent.controller.abort();
    revoke(info.id);
    agent.cleanupAction = 'await-startup';
    records.record('stop', { agentId: info.id, state: 'started', collect: agent.collect });
    agent.stopWork = (async () => {
      await agent.start?.catch(() => {});
      try {
        if (!agent.executionStopped) {
          stopPhase(agent, 'stop-execution');
          const { collectable } = await backend.stopExecution(info.id);
          agent.executionStopped = true;
          agent.collectable = collectable;
        }
        if (agent.collectable && !agent.sessionArchive && backend.collectSession) {
          stopPhase(agent, 'archive-session');
          const collect = { paths: ['.'], includeGit: false, maxBytes: config.isolation.disk.bytes, required: true };
          [agent.sessionArchive] = await saveAgentArtifacts({ outputDir, agentId: info.id, collect,
            bounds: config.isolation.disk, records: () => backend.collectSession(info.id),
            destination: 'session', redactStream: redactor.jsonl, privateFiles: true });
          records.record('session-archive', { agentId: info.id, manifestPath: agent.sessionArchive });
        }
        if (agent.collect && agent.collectable && !agent.artifacts && !agent.optionalCollectionError) {
          stopPhase(agent, 'collect-artifacts');
          try {
            agent.artifacts = await saveAgentArtifacts({ outputDir, agentId: info.id, collect: agent.collect,
              bounds: config.isolation.disk, records: () => backend.collect(info.id, agent.collect) });
          } catch (error: any) {
            if (agent.collect.required) throw error;
            agent.optionalCollectionError = errorInfo(error);
          }
        }
        stopPhase(agent, 'delete-sandbox');
        await backend.destroy(info.id);
        agent.cleanupError = undefined;
        info.status = 'closed';
      } catch (error: any) {
        agent.cleanupError = errorInfo(error);
      }
      info.lastStop = stopReceipt(agent);
      records.record('stop', { agentId: info.id, state: 'observed', receipt: info.lastStop });
      return info.lastStop;
    })().finally(() => { agent.stopWork = undefined; });
    return agent.stopWork;
  }

  async function spawn(input: any, caller: any = 'host') {
    const requestId = input?.requestId;
    let parameters;
    try {
      parameters = snapshotSpawn(input, profiles, management.knowsService);
      config.driver.assertEnvironment?.(parameters.secretEnv);
    }
    catch (error) { throw problem('INVALID_CONTRACT', (error as Error).message, 'spawn', undefined, requestId); }
    if (parameters.forkFrom !== undefined && !config.driver.capabilities.contextFork) throw problem('NOT_ALLOWED', 'Backend does not support Context Fork', 'spawn', undefined, requestId);
    if (caller !== 'host' && parameters.workspace) throw problem('NOT_ALLOWED', 'Only the host can select workspace mounts', 'spawn', undefined, requestId);
    const fingerprint = createHash('sha256').update(JSON.stringify(Object.entries(parameters).sort())).digest('hex');
    const requestKey = JSON.stringify([caller, requestId]);
    let request: any = spawnRequests.get(requestKey);
    if (request) {
      if (request.fingerprint !== fingerprint) {
        throw problem('CONFLICT', 'spawn requestId already has different parameters', 'spawn', request.agent.info.id, requestId);
      }
    } else {
      if (closing) throw problem('NOT_ALLOWED', 'Runtime is closing', 'spawn', undefined, requestId);
      if (parameters.parentId && !isLive(findAgent(parameters.parentId, 'spawn', requestId))) {
        throw problem('NOT_ALLOWED', 'Parent Agent is unavailable', 'spawn', parameters.parentId, requestId);
      }
      if (parameters.forkFrom && !isLive(findAgent(parameters.forkFrom, 'spawn', requestId))) {
        throw problem('NOT_ALLOWED', 'Context fork source Agent is unavailable', 'spawn', parameters.forkFrom, requestId);
      }
      if ([...agents.values()].filter(agent => agent.info.status !== 'closed').length >= maxAgents) {
        throw problem('CONFLICT', 'Runtime has no free Agent Slot', 'spawn', undefined, requestId);
      }
      const profile = profiles.get(parameters.profile)!;
      if ([...Object.keys(profile.services), ...Object.keys(parameters.bindings ?? {})].some(id => !registrations.has(id))) {
        throw problem('NOT_ALLOWED', 'Profile requires an unavailable Service', 'spawn', undefined, requestId);
      }
      const info: AgentInfo = { id: randomUUID(), profile: parameters.profile, status: 'starting', cursor: 0,
        ...(parameters.parentId ? { parentId: parameters.parentId } : {}) };
      redactor.add(Object.values(parameters.secretEnv ?? {}));
      const agent: RuntimeAgent = {
        info, profile, controller: new AbortController(),
        activityClaims: new Set(), nativeExecuting: false, executionStopped: false, collect: parameters.collect,
        executionEpoch: 0, interruptRequests: new Map(),
      };
      fileControls.register(agent, { writable: parameters.writable ?? agent.profile.writable,
        seeded: parameters.files !== undefined });
      request = { fingerprint, agent };
      management.initAccess(info.id, profile.services, parameters.bindings);
      agents.set(info.id, agent);
      spawnRequests.set(requestKey, request);
      records.record('spawn', { state: 'registered', agentId: info.id, parentId: info.parentId, profile: info.profile, profileDigest: management.profileDigest(info.profile),
        ...(parameters.forkFrom ? { forkFrom: parameters.forkFrom } : {}),
        requestId: redactor.text(requestId), source: caller, collect: parameters.collect, writable: parameters.writable ?? agent.profile.writable });
      agent.start = Promise.resolve().then(async () => {
        agent.controller.signal.throwIfAborted();
        const resource = await backend.spawn({ agentId: info.id, profile: agent.profile, options: parameters,
          signal: agent.controller.signal, onEvent: (event: any) => emit(agent, event),
          onTrace: ({ type, ...record }: Readonly<Record<string, unknown>>) => records.record(String(type),
            redactor.value({ ...record, agentId: info.id }) as Record<string, unknown>),
          recordAllocation: (allocation: any) => records.record('spawn', { ...allocation, agentId: info.id,
            requestId: redactor.text(requestId), sandboxId: redactor.text(allocation.sandboxId) }),
          onExecutionStart: () => {
            agent.nativeExecuting = true;
            refreshActivity(agent);
          } });
        if (agent.fatal || info.status !== 'starting') throw new Error('Agent stopped before becoming idle');
        info.status = 'idle';
        records.record('spawn', { state: 'ready', agentId: info.id, requestId: redactor.text(requestId),
          providerId: resource.providerId, resourceKey: resource.resourceKey, sandboxId: redactor.text(resource.sandboxId),
          versions: resource.versions, ...(resource.backend ? { backend: resource.backend } : {}) });
        return structuredClone(info);
      });
      request.result = agent.start.catch((error: any) => {
        info.lastError = errorInfo(error, 'START_FAILED');
        void beginStop(agent);
        throw problem(error.code ?? 'START_FAILED', 'Agent startup failed', 'spawn', info.id, requestId,
          'pending', [info.lastError]);
      });
    }
    const result = await observe(request.result);
    if (result === timedOut) {
      throw problem('OPERATION_UNKNOWN', 'Agent startup receipt timed out', 'spawn', request.agent.info.id, requestId, 'pending');
    }
    return structuredClone(result);
  }

  function agentSnapshot(agent: RuntimeAgent & { stopWork?: Promise<unknown> }) {
    return structuredClone({ ...agent.info, ...(agent.stopWork ? { lastStop: currentStop(agent) } : {}) });
  }

  async function get(agentId: string) {
    return agentSnapshot(findAgent(agentId, 'get'));
  }

  async function list(filter: AgentListFilter = {}) {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
      throw problem('INVALID_CONTRACT', 'list expects a Agent filter', 'list');
    }
    const { parentId, status } = filter;
    const statuses: readonly unknown[] = Array.isArray(status) ? status : status === undefined ? [] : [status];
    if ((parentId != null && !validId(parentId)) ||
        [...statuses].some(value => typeof value !== 'string' || !agentStates.has(value))) {
      throw problem('INVALID_CONTRACT', 'list expects a valid parentId and Agent status', 'list');
    }
    return [...agents.values()].filter(({ info }) =>
      (parentId === undefined || parentId === (info.parentId ?? null)) &&
      (status === undefined || statuses.includes(info.status))).map(agentSnapshot);
  }

  function send(agentId: string, input: string, options: SendOptions & { wakeIfIdle?: true }, caller?: string, operation?: string): Promise<InputReceipt>;
  function send(agentId: string, input: string, options: SendOptions, caller?: string, operation?: string): Promise<ConditionalInputReceipt>;
  async function send(agentId: string, input: string, options: SendOptions, caller = 'host', operation = 'send'): Promise<ConditionalInputReceipt> {
    const requestId = options?.requestId;
    const mode = options?.mode === undefined ? 'steer' : options.mode;
    const { source, steeringMode, wakeIfIdle = true } = options ?? {};
    if (!validId(requestId) || typeof input !== 'string' || !['steer', 'followUp'].includes(mode) || typeof wakeIfIdle !== 'boolean' ||
        (source !== undefined && (typeof source !== 'string' || !source.trim() || source.length > 256)) ||
        (steeringMode !== undefined && (mode !== 'steer' || !['all', 'one-at-a-time'].includes(steeringMode)))) {
      throw problem('INVALID_CONTRACT', 'Input needs text, a requestId and valid delivery options', operation, agentId, requestId);
    }
    if (steeringMode !== undefined && !config.driver.capabilities.steeringModes.includes(steeringMode)) throw problem('NOT_ALLOWED', 'Backend does not support the requested steeringMode', operation, agentId, requestId);
    const agent = findAgent(agentId, operation, requestId);
    const parameters = { input, mode, source, steeringMode, wakeIfIdle };
    let request: InputRequest | undefined;
    try { request = inputRequests.get(caller, agentId, requestId, parameters); }
    catch (caught) {
      const error = caught as Error & { code: string };
      throw problem(error.code, error.message, operation, agentId, requestId);
    }
    if (!request) {
      if (closing || !isLive(agent) || agent.interruption || !fileControls.canSend(agent)) {
        throw problem('NOT_ALLOWED', 'Agent is not accepting input', operation, agentId, requestId);
      }
      const inputId = randomUUID();
      const executionEpoch = agent.executionEpoch;
      const identity = { agentId, requestId: redactor.text(requestId), inputId, caller,
        source: redactor.text(source) ?? caller, mode, steeringMode, wakeIfIdle };
      records.record('input', { ...identity, state: 'registered' });
      const releaseActivity = () => {
        agent.activityClaims.delete(request);
        refreshActivity(agent);
      };
      const entry: InputRequest = { inputId, run: async () => {
        if (entry.dispatched && agent.info.status === 'closed') return { inputId, status: 'unknown' };
        if (!entry.dispatched && (closing || !isLive(agent) || executionEpoch !== agent.executionEpoch || !fileControls.canSend(agent))) {
          releaseActivity();
          throw problem('NOT_ALLOWED', 'Agent stopped before input dispatch', operation, agentId, requestId);
        }
        const querying = entry.dispatched === true;
        try {
          entry.dispatched = true;
          records.record('input', { ...identity, state: querying ? 'receipt-query' : 'dispatched' });
          const receipt = await backend.send(agentId, input, { mode, inputId, steeringMode, executionEpoch, wakeIfIdle });
          if (wakeIfIdle && receipt.status === 'not-accepted') throw new Error('Backend declined an input with waking enabled');
          if (receipt.status === 'not-accepted' || (receipt.status === 'accepted' && receipt.disposition === 'handled')) releaseActivity();
          records.record('input', { ...identity, state: receipt.status,
            ...(receipt.status === 'accepted' ? { disposition: receipt.disposition } : { reason: receipt.reason }), cursor: agent.info.cursor });
          return receipt.status === 'unknown' ? { inputId, status: 'unknown' } : { inputId, ...receipt };
        } catch (error: any) {
          if (knownInputRejections.has(error.code) && (!querying || error.inputRejected)) {
            releaseActivity();
            records.record('input', { ...identity, state: 'rejected', error: errorInfo(error) });
            throw problem(error.code, error.message, operation, agentId, requestId);
          }
          records.record('input', { ...identity, state: 'unknown', error: errorInfo(error) });
          return { inputId, status: 'unknown' };
        }
      } };
      request = entry;
      if (wakeIfIdle) agent.activityClaims.add(request);
      refreshActivity(agent);
      inputRequests.reserve(caller, agentId, requestId, parameters, () => entry);
    }
    const entry = request;
    if (!entry.result) {
      entry.result = Promise.resolve().then(entry.run).then(result => {
        if (result.status === 'unknown') entry.result = undefined;
        return result;
      });
    }
    const result = await observe(request.result);
    if (result === timedOut) records.record('input', { agentId, requestId: redactor.text(requestId), inputId: request.inputId,
      caller, source: redactor.text(source) ?? caller, mode, steeringMode, wakeIfIdle, state: 'unknown', reason: 'host-wait-expired' });
    return result === timedOut ? { inputId: request.inputId, status: 'unknown' } : structuredClone(result);
  }

  async function interrupt(agentId: string, options: Parameters<Runtime['interrupt']>[1]): Promise<InterruptReceipt> {
    const requestId = options?.requestId;
    const timeoutMs = bound(options, 'interrupt', agentId);
    if (!validId(requestId)) throw problem('INVALID_CONTRACT', 'interrupt requires a requestId', 'interrupt', agentId, requestId);
    const agent = findAgent(agentId, 'interrupt', requestId);
    let request = agent.interruptRequests.get(requestId);
    if (!request) {
      if (closing || !isLive(agent)) throw problem('NOT_ALLOWED', 'Agent is not available to interrupt', 'interrupt', agentId, requestId);
      if (agent.interruption) throw problem('CONFLICT', 'A previous interrupt is unconfirmed', 'interrupt', agentId, requestId);
      request = { interruptId: randomUUID(), executionEpoch: ++agent.executionEpoch };
      agent.interruptRequests.set(requestId, request);
      agent.interruption = request;
      bridge.cancelAgentCalls(agentId);
    }
    const identity = { agentId, requestId: redactor.text(requestId), interruptId: request.interruptId, executionEpoch: request.executionEpoch };
    const receipt = (): InterruptReceipt => ({
      interruptId: request.interruptId, status: request.confirmed ? 'interrupted' : 'unknown',
      ...(request.discardedInputHashes ? { discardedInputHashes: [...request.discardedInputHashes] } : {}),
    });
    if (request.confirmed) return receipt();
    if (!request.work && !closing && isLive(agent)) {
      records.record('interrupt', { ...identity, state: 'dispatched' });
      request.work = Promise.resolve().then(async () => {
        if (closing || !isLive(agent)) return;
        const result = await backend.interrupt(agentId, request);
        if (result.status === 'interrupted' && isLive(agent)) {
          request.confirmed = true;
          request.discardedInputHashes = result.discardedInputHashes;
          agent.interruption = undefined;
          agent.nativeExecuting = false;
          agent.activityClaims.clear();
          refreshActivity(agent);
        }
        records.record('interrupt', { ...identity, state: request.confirmed ? 'interrupted' : 'unknown' });
      }).catch(error => {
        records.record('interrupt', { ...identity, state: 'unknown', error: errorInfo(error) });
      }).finally(() => { request.work = undefined; });
    }
    if (request.work && await observe(request.work, timeoutMs) === timedOut) {
      records.record('interrupt', { ...identity, state: 'unknown', reason: 'host-wait-expired' });
    }
    return receipt();
  }

  function onEvent(handler: (event: AgentEvent) => void) {
    if (typeof handler !== 'function') throw problem('INVALID_CONTRACT', 'Event handler must be a function', 'onEvent');
    handlers.add(handler);
    return () => { handlers.delete(handler); };
  }

  async function stop(agentId: string, options?: { timeoutMs?: number }) {
    const timeoutMs = bound(options, 'stop', agentId);
    const agent = findAgent(agentId, 'stop');
    const result = await observe(beginStop(agent), timeoutMs);
    if (result === timedOut) records.record('stop', { agentId, state: 'host-wait-expired', receipt: currentStop(agent) });
    return structuredClone(result === timedOut ? currentStop(agent) : result);
  }

  let savingClose = false;
  let serviceStates: Awaited<ReturnType<typeof exportServiceStates>> | undefined;
  function closeReceipt(agentReceipts: any[], errors: ErrorInfo[], reportError?: ErrorInfo) {
    const pending = [...agentReceipts.flatMap(agent => agent.pending ? [agent.pending] : []), ...pendingEndpoints(), ...management.pendingServices()];
    if (reportError || savingClose) pending.push({ kind: 'report', id: runtimeId, action: 'save', ...(reportError ? { error: reportError } : {}) });
    const evidence = records.snapshot();
    if (evidence.lost) pending.push({ kind: 'report', id: runtimeId, action: 'save',
      error: { code: 'EVIDENCE_INCOMPLETE', message: 'Some Runtime evidence could not be saved', retryable: false } });
    const model = modelTrace.snapshot();
    if (model.lost || model.pending) pending.push({ kind: 'report', id: runtimeId, action: 'save',
      error: { code: 'MODEL_TRACE_INCOMPLETE', message: 'Some model traces have not been saved', retryable: !model.lost } });
    return { agents: agentReceipts, cleanup: errors.length || pending.length ? 'pending' : 'complete',
      errors, pending, outputDir, evidence, ...(reportSaved ? { reportPath } : {}) };
  }

  async function close(options?: { timeoutMs?: number }) {
    const timeoutMs = bound(options, 'close');
    if (finalClose) return structuredClone(finalClose);
    closing = true;
    if (!closeWork) {
      closeWork = (async () => {
        records.record('runtime', { state: 'closing', timeoutMs });
        const stopping = Promise.all([...agents.values()].map(beginStop));
        await closeEndpoints();
        if (endpointCleanup.bridge.done) {
          await management.retireAll(timeoutMs);
          serviceStates ??= await exportServiceStates(registrations, outputDir, redactor.value);
        }
        const agentReceipts = await stopping;
        if (agentReceipts.every((agent: any) => agent.cleanup === 'complete')) {
          await closeEndpoint('backend', backend);
        }
        const errors = pendingEndpoints().flatMap((subject: any) => subject.error ? [subject.error] : []);
        savingClose = true;
        await records.flush();
        let serviceTraceError;
        try { await serviceTrace.flush(); }
        catch {
          serviceTraceError = { code: 'SERVICE_TRACE_INCOMPLETE', message: 'Some Service traces could not be saved', retryable: false };
          errors.push(serviceTraceError);
        }
        savingClose = false;
        let receipt = closeReceipt(agentReceipts, errors, serviceTraceError);
        savingClose = true;
        try {
          receipt.reportPath = reportPath;
          await saveSummary(receipt.cleanup === 'complete' ? 'closed' : 'closing', {
            ...receipt, serviceStates: [...(serviceStates ?? []), ...management.retiredExports()], handlerErrors, handlerErrorCount,
          });
          reportSaved = true;
        } catch (error: any) {
          const failure = { ...errorInfo(error), code: 'REPORT_WRITE_FAILED' };
          errors.push(failure);
          reportSaved = false;
          receipt = closeReceipt(agentReceipts, errors, failure);
        } finally { savingClose = false; }
        if (receipt.cleanup === 'complete') finalClose = receipt;
        liveObservation.publish({ type: 'runtime', runtimeState: finalClose ? 'closed' : 'closing', cleanup: finalClose ? 'complete' : 'pending' });
        return receipt;
      })().finally(() => { closeWork = undefined; });
    }
    const result = await observe(closeWork, timeoutMs);
    if (result !== timedOut) return structuredClone(result);
    liveObservation.publish({ type: 'runtime', runtimeState: 'closing', cleanup: 'pending' });
    return closeReceipt([...agents.values()].map(currentStop), [{
      code: 'OPERATION_UNKNOWN', message: 'Runtime close is still pending', retryable: true,
    }]);
  }

  function hostSend(id: string, input: string, options: SendOptions & { wakeIfIdle?: true }): Promise<InputReceipt>;
  function hostSend(id: string, input: string, options: SendOptions): Promise<ConditionalInputReceipt>;
  function hostSend(id: string, input: string, options: SendOptions) {
    return send(id, input, options);
  }

  return Object.freeze<Runtime>({
    id: runtimeId, profiles: management.profiles, services: management.services, access: management.access, spawn: input => spawn(input), get, list,
    start: (id, input, options) => send(id, input, { requestId: options?.requestId, mode: 'followUp' }, 'host', 'start'),
    steer: (id, input, options) => send(id, input, {
      requestId: options?.requestId, source: options?.source, steeringMode: options?.steeringMode, mode: 'steer',
    }, 'host', 'steer'),
    send: hostSend,
    interrupt, onEvent, observe: observeRuntime, stop, close, files: fileControls.api,
  });
}

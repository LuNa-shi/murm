import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createCoreBridge } from './bridge.js';
import { snapshotProfiles, snapshotSpawn, validId } from './config.js';
import { createCoreModelAccess } from './model-access.js';
import { createModelTrace } from './model-trace.js';
import { createInputLedger } from './input-ledger.js';
import { createFileControls } from './file-controls.js';
import { saveBotArtifacts } from './artifact-collection.js';
import { createRedactor, createRunRecords, runtimeConfiguration } from './run-records.js';
import { claimPiOpenSandboxBackend, openPiOpenSandboxBackend } from './pi-opensandbox-backend.js';
import { createBotService } from './bot-service.js';
import { createServiceTrace, exportServiceStates } from './service-trace.js';
import { registerServicePrivateValues, snapshotServiceRegistry } from './services.js';

const defaultTimeoutMs = 60_000;
const timedOut = Symbol('timed out');
const liveStates = new Set(['idle', 'running']);
const botStates = new Set(['starting', ...liveStates, 'exited', 'closing', 'closed']);
const knownInputRejections = new Set(['INVALID_CONTRACT', 'NOT_ALLOWED', 'CONFLICT', 'NOT_FOUND']);

function resourceError(code, message, context, { cleanup = 'complete', details = [] } = {}) {
  return Object.assign(new Error(message), { name: 'ResourceError', code, ...context, cleanup, details });
}

async function observe(work, timeoutMs = defaultTimeoutMs) {
  let timer;
  try {
    return await Promise.race([work, new Promise(resolve => {
      timer = setTimeout(() => resolve(timedOut), timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function writeRecord(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function createRuntime(options) {
  const runtimeId = randomUUID();
  const context = { operation: 'createRuntime', runtimeId };
  const redactor = createRedactor([process.env.OPEN_SANDBOX_API_KEY, process.env.SWARMENV_EXECD_ACCESS_TOKEN]);
  const errorInfo = redactor.error;
  let config, registrations, profiles, modelAccessPolicy, outputDir;
  try {
    if (!Number.isSafeInteger(options?.maxBots) || options.maxBots < 1 ||
        typeof options.outputDir !== 'string' || !options.outputDir.trim()) {
      throw new TypeError('A positive maxBots and outputDir are required');
    }
    if (options.modelAccessPolicy !== undefined && (typeof options.modelAccessPolicy?.authorize !== 'function' ||
        typeof options.modelAccessPolicy?.withCommit !== 'function')) {
      throw new TypeError('modelAccessPolicy must provide synchronous authorize and withCommit');
    }
    config = claimPiOpenSandboxBackend(options.backend);
    redactor.add([config.sandbox.apiKey, config.sandbox.execdToken,
      ...Object.values(config.models).flatMap(model => Object.values(model.upstream.headers))]);
    registrations = snapshotServiceRegistry(options.services);
    registerServicePrivateValues(registrations, redactor.add);
    registrations.set('bot', createBotService({ runtimeId, getBot: id => getBot(id),
      spawn: (input, caller) => spawn(input, caller), get, send: (id, input, options, caller) => send(id, input, options, caller), stop }));
    profiles = snapshotProfiles(options.profiles, config.models, registrations);
    modelAccessPolicy = options.modelAccessPolicy;
    outputDir = join(resolve(options.outputDir), runtimeId);
  } catch (error) {
    throw resourceError('INVALID_CONTRACT', redactor.text(error.message), context, { details: [errorInfo(error, 'INVALID_CONTRACT')] });
  }

  const maxBots = options.maxBots;
  const assemblyDeadline = performance.now() + defaultTimeoutMs;
  const bots = new Map();
  const reportPath = join(outputDir, 'runtime.json');
  const records = createRunRecords(outputDir, runtimeId);
  const modelTrace = createModelTrace(outputDir, redactor);
  const serviceTrace = createServiceTrace(outputDir, redactor.value);
  const effectiveConfig = runtimeConfiguration({ config, profiles, registrations, maxBots, modelAccessPolicy, defaultTimeoutMs }, redactor.text);
  const saveSummary = (status, data = {}) => writeRecord(reportPath, {
    runtimeId, status, maxBots, config: effectiveConfig, evidence: records.snapshot(),
    modelLedgers: modelAccess?.ledgerPaths?.() ?? [], modelTrace: modelTrace.snapshot(), ...data,
  });
  const getBot = botId => {
    const bot = bots.get(botId);
    return bot && {
      profile: bot.info.profile, model: bot.profile.model, status: bot.info.status,
      unavailable: bot.fatal === true,
      services: bot.profile.services, bindings: bot.bindings, parentId: bot.info.parentId, spawnProfiles: bot.profile.spawnProfiles, allowContextFork: bot.profile.allowContextFork,
    };
  };
  let bridge, modelAccess, backend;
  let closing = false;
  let recordsReady = false;
  let reportSaved = false;
  const assertAssembling = () => {
    if (closing) throw Object.assign(new Error('Runtime initialization was closed'), { code: 'OPERATION_UNKNOWN' });
  };
  const endpointCleanup = {
    bridge: { kind: 'bridge', id: runtimeId, action: 'close', done: false },
    model: { kind: 'model', id: runtimeId, action: 'close', done: false },
    backend: { kind: 'backend', id: runtimeId, action: 'close', done: false },
  };
  function pendingEndpoint(subject) {
    const { kind, id, action, error } = subject;
    return { kind, id, action, ...(error ? { error } : {}) };
  }
  async function closeEndpoint(kind, endpoint) {
    const subject = endpointCleanup[kind];
    if (subject.done) return;
    try {
      await endpoint?.close();
      subject.done = true;
      subject.error = undefined;
    } catch (error) {
      subject.error = errorInfo(error);
    }
  }
  function pendingEndpoints() {
    return Object.values(endpointCleanup).filter(subject => !subject.done).flatMap(subject => {
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
    modelAccess = await createCoreModelAccess({ runtimeId, outputDir, config, getBot, modelAccessPolicy, modelTrace,
      onOwned: owner => { modelAccess = owner; } });
    assertAssembling();
    bridge = await createCoreBridge({ runtimeId, configuration: config.bridge, getBot, registrations,
      traceService: entry => serviceTrace.record(entry),
      recordService: entry => records.record('service', { ...entry,
        serviceId: redactor.text(entry.serviceId), operation: redactor.text(entry.operation),
        operationId: redactor.text(entry.operationId),
        ...(entry.error ? { error: { ...entry.error, code: redactor.text(entry.error.code) } } : {}),
      }),
      onOwned: owner => { bridge = owner; } });
    assertAssembling();
    backend = await openPiOpenSandboxBackend(config, { runtimeId, outputDir, bridge, modelAccess,
      registerPrivateValues: redactor.add });
    await saveSummary('open');
  })();
  const closeEndpoints = () => Promise.all([closeEndpoint('bridge', bridge), closeEndpoint('model', modelAccess)]);
  const rollbackAssembly = async () => {
    const failure = await assembly.then(() => undefined, error => errorInfo(error));
    await Promise.all([closeEndpoints(), closeEndpoint('backend', backend)]);
    const pending = pendingEndpoints();
    const errors = pending.flatMap(item => item.error ? [item.error] : []);
    if (recordsReady) {
      try {
        if (failure) records.record('runtime', { state: 'initialization-failed', error: failure });
        await records.flush();
        await serviceTrace.flush();
        await saveSummary('initialization-failed', { cleanup: pending.length ? 'pending' : 'complete', errors, pending, failure });
        reportSaved = true;
      } catch (error) {
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
  } catch (error) {
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

  const handlers = new Set();
  const spawnRequests = new Map();
  const inputRequests = createInputLedger(runtimeId);
  const fileControls = createFileControls({ backend, findBot, problem, observe, timedOut,
    isLive: bot => !closing && isLive(bot) });
  const handlerErrors = [];
  let handlerErrorCount = 0;
  let closeWork;
  let finalClose;

  function problem(code, message, operation, botId, requestId, cleanup = 'complete', details = []) {
    const error = resourceError(redactor.text(code), redactor.text(message), {
      operation, runtimeId, ...(botId === undefined ? {} : { botId }),
      ...(typeof requestId === 'string' ? { requestId: redactor.text(requestId) } : {}), ...(reportSaved ? { reportPath } : {}),
    }, { cleanup, details });
    records.record('resource-error', { operation, botId: redactor.text(botId), requestId: error.requestId,
      error: errorInfo(error), cleanup, details });
    return error;
  }

  function findBot(botId, operation, requestId) {
    const bot = bots.get(botId);
    if (!bot) throw problem('NOT_FOUND', 'Bot does not belong to this Runtime', operation, botId, requestId);
    return bot;
  }

  function bound(options, operation, botId) {
    const timeoutMs = options?.timeoutMs ?? defaultTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) {
      throw problem('INVALID_CONTRACT', 'timeoutMs must be a positive supported timer duration', operation, botId);
    }
    return timeoutMs;
  }

  function revoke(botId, { abortServices = false } = {}) {
    bridge.revokeBot(botId, { abortActive: abortServices });
    modelAccess.revokeBot(botId);
  }

  function isLive(bot) {
    return !bot.fatal && liveStates.has(bot.info.status);
  }

  function refreshActivity(bot) {
    if (liveStates.has(bot.info.status)) {
      bot.info.status = bot.nativeExecuting || bot.activityClaims.size ? 'running' : 'idle';
    }
  }

  function emit(bot, payload) {
    const { info } = bot;
    const { type, ...values } = payload;
    const event = structuredClone({ ...values, type, botId: info.id, seq: ++info.cursor });
    if (event.text !== undefined) event.text = redactor.text(event.text);
    if (event.output !== undefined) event.output = redactor.text(event.output);
    if (event.reason !== undefined) event.reason = redactor.text(event.reason);
    if (event.error !== undefined) event.error = errorInfo(event.error);
    if (event.type === 'output') info.latestOutput = event.text;
    if (event.type === 'settled') {
      bot.nativeExecuting = false;
      // This execution no longer owns running. Input receipts remain intact:
      // a settled event does not establish which queued inputs were consumed.
      bot.activityClaims.clear();
      refreshActivity(bot);
      info.latestOutput = event.output;
      info.lastError = event.error;
    }
    if (event.type === 'error') {
      info.lastError = event.error;
      if (event.fatal) {
        // A fatal failure fences authority, but does not prove physical exit or
        // release any owned resource. Keep original receipt lookups available.
        bot.fatal = true;
        bot.controller.abort();
        revoke(info.id, { abortServices: true });
      }
    }
    if (event.type === 'exit' && info.status !== 'closing' && info.status !== 'closed') {
      info.status = 'exited';
      revoke(info.id);
    }
    records.record('event', { botId: info.id, event });
    for (const handler of [...handlers]) {
      const recordFailure = error => {
        let name = 'Error';
        try {
          const candidate = error?.name;
          if (typeof candidate === 'string') name = redactor.text(candidate);
        } catch { /* Uninspectable subscriber rejection */ }
        const entry = { botId: info.id, eventSeq: event.seq, name };
        handlerErrorCount++;
        if (handlerErrors.length < 32) handlerErrors.push(entry);
        records.record('subscriber-error', entry);
      };
      try { Promise.resolve(handler(structuredClone(event))).catch(recordFailure); }
      catch (error) { recordFailure(error); }
    }
  }

  function stopReceipt(bot, pendingError) {
    const botId = bot.info.id;
    const error = pendingError ?? bot.cleanupError;
    return { botId, execution: bot.executionStopped ? 'stopped' : 'unknown',
      cleanup: bot.info.status === 'closed' ? 'complete' : 'pending',
      ...(bot.sessionArchive ? { sessionArchive: bot.sessionArchive } : {}),
      artifacts: bot.artifacts ?? [], errors: [bot.optionalCollectionError, bot.cleanupError, pendingError].filter(Boolean),
      ...(bot.info.status === 'closed' ? {} : { pending: {
        kind: 'bot', id: botId, action: bot.cleanupAction ?? 'stop-execution',
        ...backend.resource(botId), ...(error ? { error } : {}),
      } }),
    };
  }

  function currentStop(bot) {
    return bot.stopWork ? stopReceipt(bot, {
      code: 'OPERATION_UNKNOWN', message: `Waiting for ${bot.cleanupAction} confirmation`, retryable: true,
    }) : bot.info.lastStop ?? stopReceipt(bot);
  }

  function beginStop(bot) {
    if (bot.info.status === 'closed') return Promise.resolve(bot.info.lastStop);
    if (bot.stopWork) return bot.stopWork;
    const { info } = bot;
    info.status = 'closing';
    bot.controller.abort();
    revoke(info.id);
    bot.cleanupAction = 'await-startup';
    records.record('stop', { botId: info.id, state: 'started', collect: bot.collect });
    bot.stopWork = (async () => {
      await bot.start?.catch(() => {});
      try {
        if (!bot.executionStopped) {
          bot.cleanupAction = 'stop-execution';
          const { collectable } = await backend.stopExecution(info.id);
          bot.executionStopped = true;
          bot.collectable = collectable;
        }
        if (bot.collectable && !bot.sessionArchive && backend.collectSession) {
          bot.cleanupAction = 'archive-session';
          const collect = { paths: ['.'], includeGit: false, maxBytes: config.isolation.disk.bytes, required: true };
          [bot.sessionArchive] = await saveBotArtifacts({ outputDir, botId: info.id, collect,
            bounds: config.isolation.disk, records: () => backend.collectSession(info.id),
            destination: 'session', redactStream: redactor.jsonl, privateFiles: true });
          records.record('session-archive', { botId: info.id, manifestPath: bot.sessionArchive });
        }
        if (bot.collect && bot.collectable && !bot.artifacts && !bot.optionalCollectionError) {
          bot.cleanupAction = 'collect-artifacts';
          try {
            bot.artifacts = await saveBotArtifacts({ outputDir, botId: info.id, collect: bot.collect,
              bounds: config.isolation.disk, records: () => backend.collect(info.id, bot.collect) });
          } catch (error) {
            if (bot.collect.required) throw error;
            bot.optionalCollectionError = errorInfo(error);
          }
        }
        bot.cleanupAction = 'delete-sandbox';
        await backend.destroy(info.id);
        bot.cleanupError = undefined;
        info.status = 'closed';
      } catch (error) {
        bot.cleanupError = errorInfo(error);
      }
      info.lastStop = stopReceipt(bot);
      records.record('stop', { botId: info.id, state: 'observed', receipt: info.lastStop });
      return info.lastStop;
    })().finally(() => { bot.stopWork = undefined; });
    return bot.stopWork;
  }

  async function spawn(input, caller = 'host') {
    const requestId = input?.requestId;
    let parameters;
    try { parameters = snapshotSpawn(input, profiles, registrations); }
    catch (error) { throw problem('INVALID_CONTRACT', error.message, 'spawn', undefined, requestId); }
    if (caller !== 'host' && parameters.workspace) throw problem('NOT_ALLOWED', 'Only the host can select workspace mounts', 'spawn', undefined, requestId);
    const fingerprint = createHash('sha256').update(JSON.stringify(Object.entries(parameters).sort())).digest('hex');
    const requestKey = JSON.stringify([caller, requestId]);
    let request = spawnRequests.get(requestKey);
    if (request) {
      if (request.fingerprint !== fingerprint) {
        throw problem('CONFLICT', 'spawn requestId already has different parameters', 'spawn', request.bot.info.id, requestId);
      }
    } else {
      if (closing) throw problem('NOT_ALLOWED', 'Runtime is closing', 'spawn', undefined, requestId);
      if (parameters.parentId && !isLive(findBot(parameters.parentId, 'spawn', requestId))) {
        throw problem('NOT_ALLOWED', 'Parent Bot is unavailable', 'spawn', parameters.parentId, requestId);
      }
      if (parameters.forkFrom && !isLive(findBot(parameters.forkFrom, 'spawn', requestId))) {
        throw problem('NOT_ALLOWED', 'Context fork source Bot is unavailable', 'spawn', parameters.forkFrom, requestId);
      }
      if ([...bots.values()].filter(bot => bot.info.status !== 'closed').length >= maxBots) {
        throw problem('CONFLICT', 'Runtime has no free Bot Slot', 'spawn', undefined, requestId);
      }
      const info = { id: randomUUID(), profile: parameters.profile, status: 'starting', cursor: 0,
        ...(parameters.parentId ? { parentId: parameters.parentId } : {}) };
      redactor.add(Object.values(parameters.secretEnv ?? {}));
      const bot = {
        info, profile: profiles.get(parameters.profile), controller: new AbortController(),
        activityClaims: new Set(), nativeExecuting: false, executionStopped: false, bindings: parameters.bindings, collect: parameters.collect,
        executionEpoch: 0, interruptRequests: new Map(),
      };
      fileControls.register(bot, { writable: parameters.writable ?? bot.profile.writable,
        seeded: parameters.files !== undefined });
      request = { fingerprint, bot };
      bots.set(info.id, bot);
      spawnRequests.set(requestKey, request);
      records.record('spawn', { state: 'registered', botId: info.id, parentId: info.parentId, profile: info.profile,
        ...(parameters.forkFrom ? { forkFrom: parameters.forkFrom } : {}),
        requestId: redactor.text(requestId), source: caller, collect: parameters.collect, writable: parameters.writable ?? bot.profile.writable });
      bot.start = Promise.resolve().then(async () => {
        bot.controller.signal.throwIfAborted();
        const resource = await backend.spawn({ botId: info.id, profile: bot.profile, options: parameters,
          signal: bot.controller.signal, onEvent: event => emit(bot, event),
          recordAllocation: allocation => records.record('spawn', { ...allocation, botId: info.id,
            requestId: redactor.text(requestId), sandboxId: redactor.text(allocation.sandboxId) }),
          onExecutionStart: () => {
            bot.nativeExecuting = true;
            refreshActivity(bot);
          } });
        if (bot.fatal || info.status !== 'starting') throw new Error('Bot stopped before becoming idle');
        info.status = 'idle';
        records.record('spawn', { state: 'ready', botId: info.id, requestId: redactor.text(requestId),
          sandboxId: resource.sandboxId, versions: resource.versions });
        return structuredClone(info);
      });
      request.result = bot.start.catch(error => {
        info.lastError = errorInfo(error, 'START_FAILED');
        void beginStop(bot);
        throw problem(error.code ?? 'START_FAILED', 'Bot startup failed', 'spawn', info.id, requestId,
          'pending', [info.lastError]);
      });
    }
    const result = await observe(request.result);
    if (result === timedOut) {
      throw problem('OPERATION_UNKNOWN', 'Bot startup receipt timed out', 'spawn', request.bot.info.id, requestId, 'pending');
    }
    return structuredClone(result);
  }

  function botSnapshot(bot) {
    return structuredClone({ ...bot.info, ...(bot.stopWork ? { lastStop: currentStop(bot) } : {}) });
  }

  async function get(botId) {
    return botSnapshot(findBot(botId, 'get'));
  }

  async function list(filter = {}) {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
      throw problem('INVALID_CONTRACT', 'list expects a Bot filter', 'list');
    }
    const { parentId, status } = filter;
    const statuses = Array.isArray(status) ? status : status === undefined ? [] : [status];
    if ((parentId != null && !validId(parentId)) || [...statuses].some(value => !botStates.has(value))) {
      throw problem('INVALID_CONTRACT', 'list expects a valid parentId and Bot status', 'list');
    }
    return [...bots.values()].filter(({ info }) =>
      (parentId === undefined || parentId === (info.parentId ?? null)) &&
      (status === undefined || statuses.includes(info.status))).map(botSnapshot);
  }

  async function send(botId, input, options, caller = 'host', operation = 'send') {
    const requestId = options?.requestId;
    const mode = options?.mode === undefined ? 'steer' : options.mode;
    const { source, steeringMode } = operation === 'steer' ? options : {};
    if (!validId(requestId) || typeof input !== 'string' || !['steer', 'followUp'].includes(mode) ||
        (source !== undefined && (typeof source !== 'string' || !source.trim() || source.length > 256)) ||
        (steeringMode !== undefined && !['all', 'one-at-a-time'].includes(steeringMode))) {
      throw problem('INVALID_CONTRACT', 'Input needs text, a requestId and valid delivery options', operation, botId, requestId);
    }
    const bot = findBot(botId, operation, requestId);
    const parameters = { input, mode, source, steeringMode };
    let request;
    try { request = inputRequests.get(caller, botId, requestId, parameters); }
    catch (error) { throw problem(error.code, error.message, operation, botId, requestId); }
    if (!request) {
      if (closing || !isLive(bot) || bot.interruption || !fileControls.canSend(bot)) {
        throw problem('NOT_ALLOWED', 'Bot is not accepting input', operation, botId, requestId);
      }
      const inputId = randomUUID();
      const executionEpoch = bot.executionEpoch;
      const identity = { botId, requestId: redactor.text(requestId), inputId, caller,
        source: redactor.text(source) ?? caller, mode, steeringMode };
      records.record('input', { ...identity, state: 'registered' });
      const releaseActivity = () => {
        bot.activityClaims.delete(request);
        refreshActivity(bot);
      };
      request = { inputId, input, mode, run: async () => {
        if (request.dispatched && bot.info.status === 'closed') return { inputId, status: 'unknown' };
        if (!request.dispatched && (closing || !isLive(bot) || executionEpoch !== bot.executionEpoch || !fileControls.canSend(bot))) {
          releaseActivity();
          throw problem('NOT_ALLOWED', 'Bot stopped before input dispatch', operation, botId, requestId);
        }
        const querying = request.dispatched === true;
        try {
          request.dispatched = true;
          records.record('input', { ...identity, state: querying ? 'receipt-query' : 'dispatched' });
          const receipt = await backend.send(botId, input, { mode, inputId, steeringMode, executionEpoch });
          if (receipt.status === 'accepted' && receipt.disposition === 'handled') releaseActivity();
          records.record('input', { ...identity, state: receipt.status, disposition: receipt.disposition,
            reason: receipt.reason, cursor: bot.info.cursor });
          return receipt.status === 'accepted' ? { inputId, status: 'accepted', disposition: receipt.disposition } : { inputId, status: 'unknown' };
        } catch (error) {
          if (knownInputRejections.has(error.code) && (!querying || error.inputRejected)) {
            releaseActivity();
            records.record('input', { ...identity, state: 'rejected', error: errorInfo(error) });
            throw problem(error.code, error.message, operation, botId, requestId);
          }
          records.record('input', { ...identity, state: 'unknown', error: errorInfo(error) });
          return { inputId, status: 'unknown' };
        }
      } };
      bot.activityClaims.add(request);
      refreshActivity(bot);
      inputRequests.reserve(caller, botId, requestId, parameters, () => request);
    }
    if (!request.result) {
      request.result = Promise.resolve().then(request.run).then(result => {
        if (result.status === 'unknown') request.result = undefined;
        return result;
      });
    }
    const result = await observe(request.result);
    if (result === timedOut) records.record('input', { botId, requestId: redactor.text(requestId), inputId: request.inputId,
      caller, source: redactor.text(source) ?? caller, mode, steeringMode, state: 'unknown', reason: 'host-wait-expired' });
    return result === timedOut ? { inputId: request.inputId, status: 'unknown' } : structuredClone(result);
  }

  async function interrupt(botId, options) {
    const requestId = options?.requestId;
    const timeoutMs = bound(options, 'interrupt', botId);
    if (!validId(requestId)) throw problem('INVALID_CONTRACT', 'interrupt requires a requestId', 'interrupt', botId, requestId);
    const bot = findBot(botId, 'interrupt', requestId);
    let request = bot.interruptRequests.get(requestId);
    if (!request) {
      if (closing || !isLive(bot)) throw problem('NOT_ALLOWED', 'Bot is not available to interrupt', 'interrupt', botId, requestId);
      if (bot.interruption) throw problem('CONFLICT', 'A previous interrupt is unconfirmed', 'interrupt', botId, requestId);
      request = { interruptId: randomUUID(), executionEpoch: ++bot.executionEpoch };
      bot.interruptRequests.set(requestId, request);
      bot.interruption = request;
      bridge.cancelBotCalls(botId);
    }
    const identity = { botId, requestId: redactor.text(requestId), interruptId: request.interruptId, executionEpoch: request.executionEpoch };
    if (request.confirmed) return { interruptId: request.interruptId, status: 'interrupted' };
    if (!request.work && !closing && isLive(bot)) {
      records.record('interrupt', { ...identity, state: 'dispatched' });
      request.work = Promise.resolve().then(async () => {
        if (closing || !isLive(bot)) return;
        const result = await backend.interrupt(botId, request);
        if (result.status === 'interrupted' && isLive(bot)) {
          request.confirmed = true;
          bot.interruption = undefined;
          bot.nativeExecuting = false;
          bot.activityClaims.clear();
          refreshActivity(bot);
        }
        records.record('interrupt', { ...identity, state: request.confirmed ? 'interrupted' : 'unknown' });
      }).catch(error => {
        records.record('interrupt', { ...identity, state: 'unknown', error: errorInfo(error) });
      }).finally(() => { request.work = undefined; });
    }
    if (request.work && await observe(request.work, timeoutMs) === timedOut) {
      records.record('interrupt', { ...identity, state: 'unknown', reason: 'host-wait-expired' });
    }
    return { interruptId: request.interruptId, status: request.confirmed ? 'interrupted' : 'unknown' };
  }

  function onEvent(handler) {
    if (typeof handler !== 'function') throw problem('INVALID_CONTRACT', 'Event handler must be a function', 'onEvent');
    handlers.add(handler);
    return () => { handlers.delete(handler); };
  }

  async function stop(botId, options) {
    const timeoutMs = bound(options, 'stop', botId);
    const bot = findBot(botId, 'stop');
    const result = await observe(beginStop(bot), timeoutMs);
    if (result === timedOut) records.record('stop', { botId, state: 'host-wait-expired', receipt: currentStop(bot) });
    return structuredClone(result === timedOut ? currentStop(bot) : result);
  }

  let savingClose = false;
  let serviceStates;
  function closeReceipt(botReceipts, errors, reportError) {
    const pending = [...botReceipts.flatMap(bot => bot.pending ? [bot.pending] : []), ...pendingEndpoints()];
    if (reportError || savingClose) pending.push({ kind: 'report', id: runtimeId, action: 'save', ...(reportError ? { error: reportError } : {}) });
    const evidence = records.snapshot();
    if (evidence.lost) pending.push({ kind: 'report', id: runtimeId, action: 'save',
      error: { code: 'EVIDENCE_INCOMPLETE', message: 'Some Runtime evidence could not be saved', retryable: false } });
    const model = modelTrace.snapshot();
    if (model.lost || model.pending) pending.push({ kind: 'report', id: runtimeId, action: 'save',
      error: { code: 'MODEL_TRACE_INCOMPLETE', message: 'Some model traces have not been saved', retryable: !model.lost } });
    return { bots: botReceipts, cleanup: errors.length || pending.length ? 'pending' : 'complete',
      errors, pending, outputDir, evidence, ...(reportSaved ? { reportPath } : {}) };
  }

  async function close(options) {
    const timeoutMs = bound(options, 'close');
    if (finalClose) return structuredClone(finalClose);
    closing = true;
    if (!closeWork) {
      closeWork = (async () => {
        records.record('runtime', { state: 'closing', timeoutMs });
        const stopping = Promise.all([...bots.values()].map(beginStop));
        await closeEndpoints();
        if (endpointCleanup.bridge.done) serviceStates ??= await exportServiceStates(registrations, outputDir, redactor.value);
        const botReceipts = await stopping;
        if (botReceipts.every(bot => bot.cleanup === 'complete')) {
          await closeEndpoint('backend', backend);
        }
        const errors = pendingEndpoints().flatMap(subject => subject.error ? [subject.error] : []);
        savingClose = true;
        await records.flush();
        let serviceTraceError;
        try { await serviceTrace.flush(); }
        catch {
          serviceTraceError = { code: 'SERVICE_TRACE_INCOMPLETE', message: 'Some Service traces could not be saved', retryable: false };
          errors.push(serviceTraceError);
        }
        savingClose = false;
        let receipt = closeReceipt(botReceipts, errors, serviceTraceError);
        savingClose = true;
        try {
          receipt.reportPath = reportPath;
          await saveSummary(receipt.cleanup === 'complete' ? 'closed' : 'closing', {
            ...receipt, serviceStates, handlerErrors, handlerErrorCount,
          });
          reportSaved = true;
        } catch (error) {
          const failure = { ...errorInfo(error), code: 'REPORT_WRITE_FAILED' };
          errors.push(failure);
          reportSaved = false;
          receipt = closeReceipt(botReceipts, errors, failure);
        } finally { savingClose = false; }
        if (receipt.cleanup === 'complete') finalClose = receipt;
        return receipt;
      })().finally(() => { closeWork = undefined; });
    }
    const result = await observe(closeWork, timeoutMs);
    return result === timedOut ? closeReceipt([...bots.values()].map(currentStop), [{
      code: 'OPERATION_UNKNOWN', message: 'Runtime close is still pending', retryable: true,
    }]) : structuredClone(result);
  }

  return Object.freeze({
    id: runtimeId, spawn: input => spawn(input), get, list,
    start: (id, input, options) => send(id, input, { requestId: options?.requestId, mode: 'followUp' }, 'host', 'start'),
    steer: (id, input, options) => send(id, input, { ...options, mode: 'steer' }, 'host', 'steer'),
    send: (id, input, options) => send(id, input, options),
    interrupt, onEvent, stop, close, files: fileControls.api,
  });
}

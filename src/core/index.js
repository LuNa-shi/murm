import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createCoreBridge } from './bridge.js';
import { snapshotProfiles, snapshotSpawn, validId } from './config.js';
import { createCoreModelAccess } from './model-access.js';
import { createInputLedger } from './input-ledger.js';
import { createFileControls } from './file-controls.js';
import { saveBotArtifacts } from './artifact-collection.js';
import { createRedactor, createRunRecords, runtimeConfiguration } from './run-records.js';
import { claimPiOpenSandboxBackend, openPiOpenSandboxBackend } from './pi-opensandbox-backend.js';
import { createBotService } from './bot-service.js';
import { snapshotServiceRegistry } from './services.js';

const defaultTimeoutMs = 60_000;
const timedOut = Symbol('timed out');
const liveStates = new Set(['idle', 'running']);
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
  const effectiveConfig = runtimeConfiguration({ config, profiles, registrations, maxBots, modelAccessPolicy, defaultTimeoutMs }, redactor.text);
  const saveSummary = (status, data = {}) => writeRecord(reportPath, {
    runtimeId, status, maxBots, config: effectiveConfig, evidence: records.snapshot(),
    modelLedgers: modelAccess?.ledgerPaths?.() ?? [], ...data,
  });
  const getBot = botId => {
    const bot = bots.get(botId);
    return bot && {
      profile: bot.info.profile, model: bot.profile.model, status: bot.info.status,
      services: bot.profile.services, bindings: bot.bindings, parentId: bot.info.parentId, spawnProfiles: bot.profile.spawnProfiles,
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
    await saveSummary('starting');
    reportSaved = true;
    assertAssembling();
    modelAccess = await createCoreModelAccess({ runtimeId, outputDir, config, getBot, modelAccessPolicy,
      onOwned: owner => { modelAccess = owner; } });
    assertAssembling();
    bridge = await createCoreBridge({ runtimeId, configuration: config.bridge, getBot, registrations,
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
    isLive: bot => !closing && liveStates.has(bot.info.status) });
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

  function revoke(botId) {
    bridge.revokeBot(botId);
    modelAccess.revokeBot(botId);
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
    if (event.type === 'error') info.lastError = event.error;
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
    const fingerprint = createHash('sha256').update(JSON.stringify(Object.entries(parameters).sort())).digest('hex');
    const requestKey = JSON.stringify([caller, requestId]);
    let request = spawnRequests.get(requestKey);
    if (request) {
      if (request.fingerprint !== fingerprint) {
        throw problem('CONFLICT', 'spawn requestId already has different parameters', 'spawn', request.bot.info.id, requestId);
      }
    } else {
      if (closing) throw problem('NOT_ALLOWED', 'Runtime is closing', 'spawn', undefined, requestId);
      if (parameters.parentId && !liveStates.has(findBot(parameters.parentId, 'spawn', requestId).info.status)) {
        throw problem('NOT_ALLOWED', 'Parent Bot is unavailable', 'spawn', parameters.parentId, requestId);
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
      };
      fileControls.register(bot, { writable: parameters.writable ?? bot.profile.writable,
        seeded: parameters.files !== undefined });
      request = { fingerprint, bot };
      bots.set(info.id, bot);
      spawnRequests.set(requestKey, request);
      records.record('spawn', { state: 'registered', botId: info.id, parentId: info.parentId, profile: info.profile,
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
        if (info.status !== 'starting') throw new Error('Bot stopped before becoming idle');
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

  async function get(botId) {
    const bot = findBot(botId, 'get');
    return structuredClone({ ...bot.info, ...(bot.stopWork ? { lastStop: currentStop(bot) } : {}) });
  }

  async function send(botId, input, options, caller = 'host') {
    const requestId = options?.requestId;
    const mode = options?.mode === undefined ? 'steer' : options.mode;
    if (!validId(requestId) || typeof input !== 'string' || !['steer', 'followUp'].includes(mode)) {
      throw problem('INVALID_CONTRACT', 'send needs text, a requestId and a supported mode', 'send', botId, requestId);
    }
    const bot = findBot(botId, 'send', requestId);
    let request;
    try { request = inputRequests.get(caller, botId, requestId, { input, mode }); }
    catch (error) { throw problem(error.code, error.message, 'send', botId, requestId); }
    if (!request) {
      if (closing || !liveStates.has(bot.info.status) || !fileControls.canSend(bot)) {
        throw problem('NOT_ALLOWED', 'Bot is not accepting input', 'send', botId, requestId);
      }
      const inputId = randomUUID();
      const identity = { botId, requestId: redactor.text(requestId), inputId, source: caller, mode };
      records.record('input', { ...identity, state: 'registered' });
      const releaseActivity = () => {
        bot.activityClaims.delete(request);
        refreshActivity(bot);
      };
      request = { inputId, input, mode, run: async () => {
        if (request.dispatched && bot.info.status === 'closed') return { inputId, status: 'unknown' };
        if (!request.dispatched && (closing || !liveStates.has(bot.info.status) || !fileControls.canSend(bot))) {
          releaseActivity();
          throw problem('NOT_ALLOWED', 'Bot stopped before input dispatch', 'send', botId, requestId);
        }
        const querying = request.dispatched === true;
        try {
          request.dispatched = true;
          records.record('input', { ...identity, state: querying ? 'receipt-query' : 'dispatched' });
          const receipt = await backend.send(botId, input, { mode, inputId });
          if (receipt.status === 'accepted' && receipt.disposition === 'handled') releaseActivity();
          records.record('input', { ...identity, state: receipt.status, disposition: receipt.disposition,
            reason: receipt.reason, cursor: bot.info.cursor });
          return receipt.status === 'accepted' ? { inputId, status: 'accepted', disposition: receipt.disposition } : { inputId, status: 'unknown' };
        } catch (error) {
          if (knownInputRejections.has(error.code) && (!querying || error.inputRejected)) {
            releaseActivity();
            records.record('input', { ...identity, state: 'rejected', error: errorInfo(error) });
            throw problem(error.code, error.message, 'send', botId, requestId);
          }
          records.record('input', { ...identity, state: 'unknown', error: errorInfo(error) });
          return { inputId, status: 'unknown' };
        }
      } };
      bot.activityClaims.add(request);
      refreshActivity(bot);
      inputRequests.reserve(caller, botId, requestId, { input, mode }, () => request);
    }
    if (!request.result) {
      request.result = Promise.resolve().then(request.run).then(result => {
        if (result.status === 'unknown') request.result = undefined;
        return result;
      });
    }
    const result = await observe(request.result);
    if (result === timedOut) records.record('input', { botId, requestId: redactor.text(requestId), inputId: request.inputId,
      source: caller, mode, state: 'unknown', reason: 'host-wait-expired' });
    return result === timedOut ? { inputId: request.inputId, status: 'unknown' } : structuredClone(result);
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
  function closeReceipt(botReceipts, errors, reportError) {
    const pending = [...botReceipts.flatMap(bot => bot.pending ? [bot.pending] : []), ...pendingEndpoints()];
    if (reportError || savingClose) pending.push({ kind: 'report', id: runtimeId, action: 'save', ...(reportError ? { error: reportError } : {}) });
    const evidence = records.snapshot();
    if (evidence.lost) pending.push({ kind: 'report', id: runtimeId, action: 'save',
      error: { code: 'EVIDENCE_INCOMPLETE', message: 'Some Runtime evidence could not be saved', retryable: false } });
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
        const botReceipts = await stopping;
        if (botReceipts.every(bot => bot.cleanup === 'complete')) {
          await closeEndpoint('backend', backend);
        }
        const errors = pendingEndpoints().flatMap(subject => subject.error ? [subject.error] : []);
        savingClose = true;
        await records.flush();
        savingClose = false;
        let receipt = closeReceipt(botReceipts, errors);
        savingClose = true;
        try {
          receipt.reportPath = reportPath;
          await saveSummary(receipt.cleanup === 'complete' ? 'closed' : 'closing', {
            ...receipt, handlerErrors, handlerErrorCount,
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

  return Object.freeze({ id: runtimeId, spawn: input => spawn(input), get, send: (id, input, options) => send(id, input, options), onEvent, stop, close, files: fileControls.api });
}

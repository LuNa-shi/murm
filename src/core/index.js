import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createCoreBridge } from './bridge.js';
import { snapshotProfiles, snapshotSpawn, validId } from './config.js';
import { createCoreModelAccess } from './model-access.js';
import { claimPiOpenSandboxBackend, openPiOpenSandboxBackend } from './pi-opensandbox-backend.js';
import { snapshotServiceRegistry } from './services.js';

const defaultTimeoutMs = 60_000;
const timedOut = Symbol('timed out');
const liveStates = new Set(['idle', 'running']);
const knownInputRejections = new Set(['INVALID_CONTRACT', 'NOT_ALLOWED', 'CONFLICT', 'NOT_FOUND']);

function errorInfo(error, fallback = 'SERVICE_UNAVAILABLE') {
  return {
    code: error?.code ?? fallback,
    message: error?.message ?? 'Operation failed',
    retryable: error?.retryable ?? false,
  };
}

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
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

export async function createRuntime(options) {
  const runtimeId = randomUUID();
  const context = { operation: 'createRuntime', runtimeId };
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
    registrations = snapshotServiceRegistry(options.services);
    profiles = snapshotProfiles(options.profiles, config.models, registrations);
    modelAccessPolicy = options.modelAccessPolicy;
    outputDir = join(resolve(options.outputDir), runtimeId);
  } catch (error) {
    throw resourceError('INVALID_CONTRACT', error.message, context);
  }

  const maxBots = options.maxBots;
  const assemblyDeadline = performance.now() + defaultTimeoutMs;
  const bots = new Map();
  const reportPath = join(outputDir, 'runtime.json');
  const getBot = botId => {
    const bot = bots.get(botId);
    return bot && {
      profile: bot.info.profile, model: bot.profile.model, status: bot.info.status,
    };
  };
  let bridge, modelAccess, backend;
  let closing = false;
  let recordsReady = false;
  const assembly = (async () => {
    await mkdir(outputDir, { recursive: true, mode: 0o700 });
    recordsReady = true;
    await writeRecord(reportPath, { runtimeId, status: 'starting', maxBots });
    modelAccess = await createCoreModelAccess({ runtimeId, outputDir, config, getBot, modelAccessPolicy });
    bridge = await createCoreBridge({ runtimeId, configuration: config.bridge, getBot, registrations });
    backend = await openPiOpenSandboxBackend(config, { runtimeId, outputDir, bridge, modelAccess });
    await writeRecord(reportPath, { runtimeId, status: 'open', maxBots });
  })();
  const closeEndpoints = async () => {
    const results = await Promise.allSettled([
      Promise.resolve().then(() => bridge?.close()),
      Promise.resolve().then(() => modelAccess?.close()),
    ]);
    return results.flatMap(result => result.status === 'rejected' ? [errorInfo(result.reason)] : []);
  };
  const rollbackAssembly = async () => {
    await assembly.catch(() => {});
    const errors = await closeEndpoints();
    try { await backend?.close(); } catch (error) { errors.push(errorInfo(error)); }
    if (recordsReady) {
      try {
        await writeRecord(reportPath, { runtimeId, status: 'initialization-failed',
          cleanup: errors.length ? 'pending' : 'complete', errors });
      } catch (error) { errors.push(errorInfo(error)); }
    }
    return errors;
  };
  try {
    if (await observe(assembly) === timedOut) {
      void rollbackAssembly();
      throw resourceError('OPERATION_UNKNOWN', 'Runtime initialization timed out', {
        ...context, ...(recordsReady ? { reportPath } : {}),
      }, { cleanup: 'pending' });
    }
  } catch (error) {
    if (error.name === 'ResourceError') throw error;
    const errors = await observe(rollbackAssembly(), Math.max(1, assemblyDeadline - performance.now()));
    const code = error.code === 'INVALID_CONFIG' ? 'INVALID_CONTRACT' : error.code ?? 'SERVICE_UNAVAILABLE';
    throw resourceError(code, error.message, {
      ...context, ...(recordsReady ? { reportPath } : {}),
    }, {
      cleanup: errors === timedOut || errors.length ? 'pending' : 'complete',
      details: errors === timedOut ? [errorInfo(error)] : [errorInfo(error), ...errors],
    });
  }

  const handlers = new Set();
  const spawnRequests = new Map();
  const handlerErrors = [];
  let closeWork;
  let finalClose;

  function problem(code, message, operation, botId, requestId, cleanup = 'complete', details = []) {
    return resourceError(code, message, {
      operation, runtimeId, ...(botId === undefined ? {} : { botId }),
      ...(requestId === undefined ? {} : { requestId }), reportPath,
    }, { cleanup, details });
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

  function emit(bot, payload) {
    const { info } = bot;
    const event = structuredClone({ ...payload, botId: info.id, seq: ++info.cursor });
    if (event.type === 'output') info.latestOutput = event.text;
    if (event.type === 'settled') {
      if (info.status === 'running') info.status = 'idle';
      info.latestOutput = event.output;
      info.lastError = event.error;
    }
    if (event.type === 'error') info.lastError = event.error;
    if (event.type === 'exit' && info.status !== 'closing' && info.status !== 'closed') {
      info.status = 'exited';
      revoke(info.id);
    }
    for (const handler of [...handlers]) {
      const recordFailure = error => {
        if (handlerErrors.length < 32) handlerErrors.push({
          botId: info.id, seq: event.seq, name: error?.name ?? 'Error',
        });
      };
      try { Promise.resolve(handler(structuredClone(event))).catch(recordFailure); }
      catch (error) { recordFailure(error); }
    }
  }

  function pendingStop(bot, execution = bot.executionStopped ? 'stopped' : 'unknown') {
    return { botId: bot.info.id, execution, cleanup: 'pending', artifacts: [], errors: [{
      code: 'OPERATION_UNKNOWN', message: 'Waiting for stop and resource cleanup confirmation', retryable: true,
    }] };
  }

  function beginStop(bot) {
    if (bot.info.status === 'closed') return Promise.resolve(bot.info.lastStop);
    if (bot.stopWork) return bot.stopWork;
    const { info } = bot;
    info.status = 'closing';
    bot.controller.abort();
    revoke(info.id);
    bot.stopWork = (async () => {
      await bot.start?.catch(() => {});
      const errors = [];
      try {
        if (!bot.executionStopped) await backend.stopExecution(info.id);
        bot.executionStopped = true;
        await backend.destroy(info.id);
      } catch (error) {
        errors.push(errorInfo(error));
      }
      const receipt = {
        botId: info.id, execution: bot.executionStopped ? 'stopped' : 'unknown',
        cleanup: errors.length ? 'pending' : 'complete', artifacts: [], errors,
      };
      info.lastStop = receipt;
      if (receipt.cleanup === 'complete') info.status = 'closed';
      return receipt;
    })().finally(() => { bot.stopWork = undefined; });
    return bot.stopWork;
  }

  async function spawn(input) {
    const requestId = input?.requestId;
    let parameters;
    try { parameters = snapshotSpawn(input, profiles, registrations); }
    catch (error) { throw problem('INVALID_CONTRACT', error.message, 'spawn', undefined, requestId); }
    const fingerprint = JSON.stringify(Object.entries(parameters).sort());
    let request = spawnRequests.get(requestId);
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
      const bot = {
        info, profile: profiles.get(parameters.profile), controller: new AbortController(),
        inputs: new Map(), inputVersion: 0, executionStopped: false,
      };
      request = { fingerprint, bot };
      bots.set(info.id, bot);
      spawnRequests.set(requestId, request);
      bot.start = Promise.resolve().then(async () => {
        bot.controller.signal.throwIfAborted();
        await backend.spawn({ botId: info.id, profile: bot.profile, options: parameters,
          signal: bot.controller.signal, onEvent: event => emit(bot, event) });
        if (info.status !== 'starting') throw new Error('Bot stopped before becoming idle');
        info.status = 'idle';
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
    return structuredClone(findBot(botId, 'get').info);
  }

  async function send(botId, input, options) {
    const requestId = options?.requestId;
    const mode = options?.mode === undefined ? 'steer' : options.mode;
    if (!validId(requestId) || typeof input !== 'string' || !['steer', 'followUp'].includes(mode)) {
      throw problem('INVALID_CONTRACT', 'send needs text, a requestId and a supported mode', 'send', botId, requestId);
    }
    const bot = findBot(botId, 'send', requestId);
    let request = bot.inputs.get(requestId);
    if (request) {
      if (request.input !== input || request.mode !== mode) {
        throw problem('CONFLICT', 'send requestId already has different parameters', 'send', botId, requestId);
      }
    } else {
      if (closing || !liveStates.has(bot.info.status)) {
        throw problem('NOT_ALLOWED', 'Bot is not accepting input', 'send', botId, requestId);
      }
      const inputId = randomUUID();
      const wasIdle = bot.info.status === 'idle';
      const cursor = bot.info.cursor;
      const version = ++bot.inputVersion;
      bot.info.status = 'running';
      const restoreIdle = () => {
        if (wasIdle && bot.inputVersion === version && bot.info.status === 'running' && bot.info.cursor === cursor) {
          bot.info.status = 'idle';
        }
      };
      request = { inputId, input, mode, result: Promise.resolve().then(async () => {
        if (closing || !liveStates.has(bot.info.status)) {
          throw problem('NOT_ALLOWED', 'Bot stopped before input dispatch', 'send', botId, requestId);
        }
        try {
          const receipt = await backend.send(botId, input, { mode, inputId });
          if (receipt.disposition === 'handled') restoreIdle();
          return { ...receipt, inputId };
        } catch (error) {
          if (knownInputRejections.has(error.code)) {
            restoreIdle();
            throw problem(error.code, error.message, 'send', botId, requestId);
          }
          return { inputId, status: 'unknown' };
        }
      }) };
      bot.inputs.set(requestId, request);
    }
    const result = await observe(request.result);
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
    return result === timedOut ? pendingStop(bot) : structuredClone(result);
  }

  function closeReceipt(botReceipts, errors) {
    return { bots: botReceipts, cleanup: errors.length || botReceipts.some(bot => bot.cleanup === 'pending')
      ? 'pending' : 'complete', errors, outputDir, reportPath };
  }

  async function close(options) {
    const timeoutMs = bound(options, 'close');
    if (finalClose) return structuredClone(finalClose);
    closing = true;
    if (!closeWork) {
      closeWork = (async () => {
        const stopping = Promise.all([...bots.values()].map(beginStop));
        const errors = await closeEndpoints();
        const botReceipts = await stopping;
        if (botReceipts.every(bot => bot.cleanup === 'complete')) {
          try { await backend.close(); } catch (error) { errors.push(errorInfo(error)); }
        }
        let receipt = closeReceipt(botReceipts, errors);
        try {
          await writeRecord(reportPath, { runtimeId, status: receipt.cleanup === 'complete' ? 'closed' : 'closing',
            ...receipt, handlerErrors });
        } catch (error) {
          errors.push(errorInfo(error, 'REPORT_WRITE_FAILED'));
          receipt = closeReceipt(botReceipts, errors);
        }
        if (receipt.cleanup === 'complete') finalClose = receipt;
        return receipt;
      })().finally(() => { closeWork = undefined; });
    }
    const result = await observe(closeWork, timeoutMs);
    return result === timedOut ? closeReceipt([...bots.values()].map(bot =>
      bot.info.status === 'closed' ? structuredClone(bot.info.lastStop) : pendingStop(bot)), [{
      code: 'OPERATION_UNKNOWN', message: 'Runtime close is still pending', retryable: true,
    }]) : structuredClone(result);
  }

  return Object.freeze({ id: runtimeId, spawn, get, send, onEvent, stop, close });
}

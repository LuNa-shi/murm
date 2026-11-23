import { snapshotFileSeed } from '../../scripts/core-file-seed.mjs';
import { validId } from './config.js';

const knownRejections = new Set(['CONFLICT', 'INVALID_CONTRACT', 'NOT_ALLOWED', 'WORKSPACE_BUSY']);

export function createFileControls({ backend, findBot, isLive, problem, observe, timedOut }) {
  const states = new WeakMap();

  function register(bot, { writable, seeded }) {
    states.set(bot, { writable, version: writable || seeded ? 1 : 0, prepares: new Map(), grants: new Map() });
  }

  function admit(bot, state, request) {
    if (!isLive(bot)) throw problem('NOT_ALLOWED', 'Bot is unavailable for file control', request.type, bot.info.id, request.id);
    if (state.operation) throw problem('CONFLICT', 'The Bot has another pending file operation', request.type, bot.info.id, request.id);
    if (state.writable) throw problem('CONFLICT', 'The Bot workDir is already writable', request.type, bot.info.id, request.id);
    state.operation = request;
  }

  async function run(bot, state, request, invoke, accept) {
    const { id: botId } = bot.info;
    const { type, id } = request;
    const unknown = () => problem('OPERATION_UNKNOWN', 'Worker has not confirmed the file operation', type, botId, id, 'pending');
    if (request.receipt) return request.receipt;
    if (request.rejection) throw request.rejection;
    if (!request.work) {
      request.work = Promise.resolve().then(async () => {
        try {
          if (!isLive(bot)) throw problem('NOT_ALLOWED', 'Bot closed before file control', type, botId, id);
          const result = await invoke();
          if (!isLive(bot)) throw unknown();
          request.receipt = accept(result, unknown);
          state.operation = undefined;
          return request.receipt;
        } catch (error) {
          if (!request.uncertain && knownRejections.has(error.code)) {
            request.rejection = problem(error.code, error.message, type, botId, id);
            state.operation = undefined;
            throw request.rejection;
          }
          request.uncertain = true;
          throw unknown();
        }
      }).finally(() => { request.work = undefined; });
    }
    const result = await observe(request.work);
    if (result === timedOut) {
      request.uncertain = true;
      throw unknown();
    }
    return result;
  }

  async function prepare(botId, options) {
    const type = 'files.prepare';
    const id = options?.requestId;
    if (!validId(id)) throw problem('INVALID_CONTRACT', 'File preparation requires a requestId', type, botId, id);
    const bot = findBot(botId, type, id);
    let seed;
    try { seed = snapshotFileSeed(options.files); }
    catch (error) { throw problem('INVALID_CONTRACT', error.message, type, botId, id); }
    const state = states.get(bot);
    let request = state.prepares.get(id);
    if (request && request.digest !== seed.digest) {
      throw problem('CONFLICT', 'File preparation requestId already has different bytes, paths or modes', type, botId, id);
    }
    if (!request) {
      request = { type, id, digest: seed.digest };
      admit(bot, state, request);
      request.version = ++state.version;
      state.prepares.set(id, request);
    }
    return run(bot, state, request, () => backend.prepareFiles(botId, { version: request.version, files: seed.files }),
      (reply, unknown) => {
        if (reply?.version !== request.version || reply.digest !== request.digest) throw unknown();
        state.prepared = Object.freeze({ botId, version: reply.version, digest: reply.digest });
        return state.prepared;
      });
  }

  async function grant(options) {
    const type = 'files.grant';
    const { requestId: id, prepared } = options ?? {};
    const botId = prepared?.botId;
    if (!validId(id) || !validId(botId)) throw problem('INVALID_CONTRACT', 'Write grant requires a requestId and PreparedFiles', type, botId, id);
    const bot = findBot(botId, type, id);
    const state = states.get(bot);
    let request = state.grants.get(id);
    if (request && request.prepared !== prepared) {
      throw problem('CONFLICT', 'Write grant requestId already has a different PreparedFiles receipt', type, botId, id);
    }
    if (!request) {
      if (state.prepared !== prepared) throw problem('CONFLICT', 'Write grant requires the current Runtime-issued PreparedFiles receipt', type, botId, id);
      request = { type, id, prepared };
      admit(bot, state, request);
      state.grants.set(id, request);
    }
    return run(bot, state, request, () => backend.grantFiles(botId, { version: prepared.version, digest: prepared.digest }),
      (reply, unknown) => {
        if (reply?.writable !== true || reply.version !== prepared.version || reply.digest !== prepared.digest) throw unknown();
        state.writable = true;
        return Object.freeze({ botId, version: reply.version, writable: true });
      });
  }

  return {
    register,
    canSend(bot) { return states.get(bot).operation?.type !== 'files.grant'; },
    api: Object.freeze({ prepare, grant }),
  };
}

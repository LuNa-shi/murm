import type { FileSeed, GrantReceipt, PreparedFiles, Runtime } from './types.js';

interface FileBot {
  info: { id: string };
}

interface WorkerFileReply {
  version: number;
  digest: string;
  writable?: boolean;
}

interface FileRequest<Receipt> {
  type: string;
  id: string;
  receipt?: Receipt;
  rejection?: Error;
  work?: Promise<Receipt>;
  uncertain?: boolean;
}

interface PrepareRequest extends FileRequest<PreparedFiles> {
  digest: string;
  version?: number;
}

interface GrantRequest extends FileRequest<GrantReceipt> {
  prepared: PreparedFiles;
}

interface FileState {
  writable: boolean;
  version: number;
  prepares: Map<string, PrepareRequest>;
  grants: Map<string, GrantRequest>;
  operation?: FileRequest<unknown>;
  prepared?: PreparedFiles;
}

interface FileControlsOptions<Bot extends FileBot, Timeout extends symbol> {
  backend: {
    prepareFiles(botId: string, input: { version: number; files: FileSeed }): Promise<WorkerFileReply>;
    grantFiles(botId: string, input: { version: number; digest: string }): Promise<WorkerFileReply>;
  };
  findBot(botId: string, operation: string, requestId: string): Bot;
  isLive(bot: Bot): boolean;
  problem(code: string, message: string, operation: string, botId: string, requestId: string | undefined, cleanup?: string): Error;
  observe<Result>(work: Promise<Result>): Promise<Result | Timeout>;
  timedOut: Timeout;
}

import { snapshotFileSeed } from '../../scripts/core-file-seed.mjs';
import { validId } from './config.js';

const knownRejections = new Set(['CONFLICT', 'INVALID_CONTRACT', 'NOT_ALLOWED', 'WORKSPACE_BUSY']);

export function createFileControls<Bot extends FileBot, Timeout extends symbol>({ backend, findBot, isLive, problem, observe, timedOut }: FileControlsOptions<Bot, Timeout>) {
  const states = new WeakMap<Bot, FileState>();

  function register(bot: Bot, { writable, seeded }: { writable: boolean; seeded: boolean }) {
    states.set(bot, { writable, version: writable || seeded ? 1 : 0, prepares: new Map(), grants: new Map() });
  }

  function admit(bot: Bot, state: FileState, request: FileRequest<unknown>) {
    if (!isLive(bot)) throw problem('NOT_ALLOWED', 'Bot is unavailable for file control', request.type, bot.info.id, request.id);
    if (state.operation) throw problem('CONFLICT', 'The Bot has another pending file operation', request.type, bot.info.id, request.id);
    if (state.writable) throw problem('CONFLICT', 'The Bot workDir is already writable', request.type, bot.info.id, request.id);
    state.operation = request;
  }

  async function run<Receipt>(bot: Bot, state: FileState, request: FileRequest<Receipt>, invoke: () => Promise<WorkerFileReply>, accept: (reply: WorkerFileReply, unknown: () => Error) => Receipt): Promise<Receipt> {
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
        } catch (caught) {
          const error = caught as Error & { code: string };
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
    return result as Receipt;
  }

  async function prepare(botId: string, options: Parameters<Runtime['files']['prepare']>[1]): Promise<PreparedFiles> {
    const type = 'files.prepare';
    const id = options?.requestId;
    if (!validId(id)) throw problem('INVALID_CONTRACT', 'File preparation requires a requestId', type, botId, id);
    const bot = findBot(botId, type, id);
    let seed;
    try { seed = snapshotFileSeed(options.files); }
    catch (caught) {
          const error = caught as Error & { code: string }; throw problem('INVALID_CONTRACT', error.message, type, botId, id); }
    const state = states.get(bot)!;
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
    return run(bot, state, request, () => backend.prepareFiles(botId, { version: request!.version!, files: seed.files as FileSeed }),
      (reply, unknown) => {
        if (reply?.version !== request!.version || reply.digest !== request!.digest) throw unknown();
        state.prepared = Object.freeze({ botId, version: reply.version, digest: reply.digest });
        return state.prepared;
      });
  }

  async function grant(options: Parameters<Runtime['files']['grant']>[0]): Promise<GrantReceipt> {
    const type = 'files.grant';
    const { requestId: id, prepared } = options ?? {};
    const botId = prepared?.botId;
    if (!validId(id) || !validId(botId)) throw problem('INVALID_CONTRACT', 'Write grant requires a requestId and PreparedFiles', type, botId, id);
    const bot = findBot(botId, type, id);
    const state = states.get(bot)!;
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
    canSend(bot: Bot) { return states.get(bot)!.operation?.type !== 'files.grant'; },
    api: Object.freeze({ prepare, grant }),
  };
}

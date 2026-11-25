import type { FileInstall, FileSeed, FileSnapshot, GrantReceipt, PreparedFiles, Runtime } from './types.js';

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

type SnapshotOptions = Parameters<Runtime['files']['snapshot']>[1];
type SnapshotReply = Omit<FileSnapshot, 'botId'>;
interface SnapshotRequest extends FileRequest<FileSnapshot> {
  identity: string;
}

interface InstallRequest extends FileRequest<FileInstall> {
  expected: FileSnapshot;
  files: FileSeed;
  digest: string;
  version: number;
  confirmation?: FileRequest<FileInstall>;
}

interface FileState {
  writable: boolean;
  version: number;
  prepares: Map<string, PrepareRequest>;
  grants: Map<string, GrantRequest>;
  snapshots: Map<string, SnapshotRequest>;
  installs: Map<string, InstallRequest>;
  operation?: FileRequest<unknown>;
  prepared?: PreparedFiles;
}

interface FileControlsOptions<Bot extends FileBot, Timeout extends symbol> {
  backend: {
    prepareFiles(botId: string, input: { version: number; files: FileSeed }): Promise<WorkerFileReply>;
    snapshotFiles(botId: string, input: SnapshotOptions): Promise<SnapshotReply>;
    installFiles(botId: string, input: { requestId: string; expectedDigest: string; files: FileSeed; version: number }): Promise<Omit<FileInstall, 'botId'>>;
    confirmFiles(botId: string, input: { requestId: string; digest: string; version: number }): Promise<Omit<FileInstall, 'botId'>>;
    grantFiles(botId: string, input: { version: number; digest: string }): Promise<WorkerFileReply>;
  };
  findBot(botId: string, operation: string, requestId: string): Bot;
  isLive(bot: Bot): boolean;
  problem(code: string, message: string, operation: string, botId: string, requestId: string | undefined, cleanup?: string): Error;
  observe<Result>(work: Promise<Result>): Promise<Result | Timeout>;
  timedOut: Timeout;
}

import { snapshotFileSeed } from '../../scripts/core-file-seed.js';
import { snapshotCollectionSpec } from '../../scripts/core-collection.js';
import { validId } from './config.js';

const knownRejections = new Set(['CONFLICT', 'INVALID_CONTRACT', 'NOT_ALLOWED', 'WORKSPACE_BUSY']);

export function createFileControls<Bot extends FileBot, Timeout extends symbol>({ backend, findBot, isLive, problem, observe, timedOut }: FileControlsOptions<Bot, Timeout>) {
  const states = new WeakMap<Bot, FileState>();

  function register(bot: Bot, { writable, seeded }: { writable: boolean; seeded: boolean }) {
    states.set(bot, { writable, version: writable || seeded ? 1 : 0, prepares: new Map(), grants: new Map(), snapshots: new Map(), installs: new Map() });
  }

  function admit(bot: Bot, state: FileState, request: FileRequest<unknown>) {
    if (!isLive(bot)) throw problem('NOT_ALLOWED', 'Bot is unavailable for file control', request.type, bot.info.id, request.id);
    if (state.operation) throw problem('CONFLICT', 'The Bot has another pending file operation', request.type, bot.info.id, request.id);
    if (state.writable) throw problem('CONFLICT', 'The Bot workDir is already writable', request.type, bot.info.id, request.id);
    state.operation = request;
  }

  async function run<Receipt, Reply extends WorkerFileReply>(bot: Bot, state: FileState, request: FileRequest<Receipt>, invoke: () => Promise<Reply>, accept: (reply: Reply, unknown: () => Error) => Receipt): Promise<Receipt> {
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
          if (request.type !== 'files.install') state.operation = undefined;
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

  async function snapshot(botId: string, options: SnapshotOptions): Promise<FileSnapshot> {
    const type = 'files.snapshot';
    const id = options?.requestId;
    if (!validId(id)) throw problem('INVALID_CONTRACT', 'File snapshot requires a requestId', type, botId, id);
    let selection;
    try {
      if (Object.keys(options).some(key => !['requestId', 'paths', 'includeGit', 'maxBytes'].includes(key))) throw new TypeError('Unsupported snapshot options');
      selection = snapshotCollectionSpec({ paths: options.paths, includeGit: options.includeGit ?? false,
        maxBytes: options.maxBytes ?? 16 * 1024 ** 2, required: true });
      if (selection.maxBytes > 16 * 1024 ** 2) throw new TypeError('Snapshot maxBytes exceeds 16 MiB');
    } catch (error) { throw problem('INVALID_CONTRACT', (error as Error).message, type, botId, id); }
    const bot = findBot(botId, type, id);
    const state = states.get(bot)!;
    const identity = JSON.stringify(selection);
    let request = state.snapshots.get(id);
    if (request && request.identity !== identity) throw problem('CONFLICT', 'Snapshot requestId has a different selection', type, botId, id);
    if (!request) {
      if (!isLive(bot)) throw problem('NOT_ALLOWED', 'Bot is unavailable for file snapshot', type, botId, id);
      if (state.operation) throw problem('CONFLICT', 'The Bot has another pending file operation', type, botId, id);
      request = { type, id, identity };
      state.operation = request;
      state.snapshots.set(id, request);
    }
    return run(bot, state, request, () => backend.snapshotFiles(botId, { requestId: id, ...selection }),
      (reply, unknown) => {
        if (reply?.requestId !== id || !Number.isSafeInteger(reply.version) || reply.version < 1) throw unknown();
        const seed = snapshotFileSeed(reply.files);
        if (seed.digest !== reply.digest) throw unknown();
        for (const file of Object.values(seed.files)) Object.freeze(file);
        return Object.freeze({ botId, requestId: id, version: reply.version, digest: seed.digest, files: Object.freeze(seed.files) });
      });
  }

  async function install(botId: string, options: Parameters<Runtime['files']['install']>[1]): Promise<FileInstall> {
    const type = 'files.install';
    const id = options?.requestId;
    if (!validId(id)) throw problem('INVALID_CONTRACT', 'File installation requires a requestId', type, botId, id);
    const bot = findBot(botId, type, id);
    const state = states.get(bot)!;
    let seed;
    try { seed = snapshotFileSeed(options.files); }
    catch (error) { throw problem('INVALID_CONTRACT', (error as Error).message, type, botId, id); }
    let request = state.installs.get(id);
    if (request && (request.expected !== options.expected || request.digest !== seed.digest)) {
      throw problem('CONFLICT', 'File install requestId has different input or expected snapshot', type, botId, id);
    }
    if (!request) {
      if (![...state.snapshots.values()].some(snapshot => snapshot.receipt === options.expected) ||
          options.expected.botId !== botId) throw problem('CONFLICT', 'Installation requires a Runtime-issued snapshot of this Bot', type, botId, id);
      if (!isLive(bot) || !state.writable) throw problem('NOT_ALLOWED', 'Installation requires a live writable private workDir', type, botId, id);
      if (state.operation) throw problem('CONFLICT', 'The Bot has another pending file operation', type, botId, id);
      request = { type, id, expected: options.expected, files: seed.files, digest: seed.digest, version: ++state.version };
      state.installs.set(id, request);
      state.operation = request;
    }
    return run(bot, state, request, () => backend.installFiles(botId, {
      requestId: id, version: request!.version, expectedDigest: request!.expected.digest, files: request!.files,
    }), (reply, unknown) => {
      if (reply?.requestId !== id || reply.version !== request!.version || reply.digest !== request!.digest ||
          !['installed', 'committed'].includes(reply.phase)) throw unknown();
      return Object.freeze({ botId, requestId: id, version: reply.version, digest: reply.digest, phase: reply.phase });
    });
  }

  async function confirm(botId: string, options: Parameters<Runtime['files']['confirm']>[1]): Promise<FileInstall> {
    const type = 'files.confirm';
    const id = options?.requestId;
    if (!validId(id)) throw problem('INVALID_CONTRACT', 'Installation confirmation requires a requestId', type, botId, id);
    const bot = findBot(botId, type, id);
    const state = states.get(bot)!;
    const installed = state.installs.get(id);
    if (!installed?.receipt) throw problem('CONFLICT', 'Installation has no issued receipt to confirm', type, botId, id);
    installed.confirmation ??= { type, id };
    return run(bot, state, installed.confirmation, () => backend.confirmFiles(botId, {
      requestId: id, version: installed.version, digest: installed.digest,
    }), (reply, unknown) => {
      if (reply?.requestId !== id || reply.version !== installed.version || reply.digest !== installed.digest || reply.phase !== 'committed') throw unknown();
      return Object.freeze({ botId, requestId: id, version: reply.version, digest: reply.digest, phase: 'committed' });
    });
  }

  return {
    register,
    canSend(bot: Bot) { return !['files.grant', 'files.install', 'files.confirm'].includes(states.get(bot)!.operation?.type ?? ''); },
    api: Object.freeze({ prepare, grant, snapshot, install, confirm }),
  };
}

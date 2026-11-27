import type {
  CompleteFileSnapshot, CompleteFileSnapshotOptions, FileReplaceOptions, FileReplaceReceipt, FileSnapshot,
  FileSnapshotOptions, Runtime,
} from './types.js';
import { completeDigest, fileSnapshotSelection, partialDigest, snapshotFileSeed } from '../../scripts/core-file-seed.js';
import { validId } from './config.js';
import { DEFAULT_FILE_POLICY, type ResolvedFilePolicy } from './file-policy.js';

type WorkerReply<T> = T extends { agentId: string } ? Omit<T, 'agentId'> : never;
export type WorkerFileSnapshot = WorkerReply<FileSnapshot>;
export type WorkerFileReplace = WorkerReply<FileReplaceReceipt>;

interface FileAgent { info: { id: string } }

interface Operation<T> {
  identity: string;
  work?: Promise<T>;
  receipt?: T;
  rejection?: Error;
  uncertain?: boolean;
}

interface AgentFileState {
  writable: boolean;
  shared: boolean;
  snapshots: Map<string, Operation<FileSnapshot>>;
  active?: Operation<unknown>;
  replacing: boolean;
}

interface Options<Agent extends FileAgent, Timeout extends symbol> {
  backend: {
    snapshotFiles(agentId: string, input: FileSnapshotOptions): Promise<WorkerFileSnapshot>;
    replaceFiles(agentId: string, input: FileReplaceOptions): Promise<WorkerFileReplace>;
  };
  findAgent(agentId: string, operation: string, requestId: string): Agent;
  isLive(agent: Agent): boolean;
  problem(code: string, message: string, operation: string, agentId: string, requestId: string | undefined, cleanup?: string): Error;
  observe<T>(work: Promise<T>): Promise<T | Timeout>;
  timedOut: Timeout;
  filePolicy?: ResolvedFilePolicy;
}

const knownRejections = new Set(['CONFLICT', 'INVALID_CONTRACT', 'NOT_ALLOWED', 'WORKSPACE_BUSY', 'FILE_SPACE_INSUFFICIENT']);

export function createFileControls<Agent extends FileAgent, Timeout extends symbol>({
  backend, findAgent, isLive, problem, observe, timedOut, filePolicy = DEFAULT_FILE_POLICY,
}: Options<Agent, Timeout>) {
  const states = new WeakMap<Agent, AgentFileState>();
  const replacements = new Map<string, Operation<FileReplaceReceipt>>();

  function register(agent: Agent, { writable, shared }: { writable: boolean; shared: boolean }) {
    states.set(agent, { writable, shared, snapshots: new Map(), replacing: false });
  }

  function binding(agentId: string, operation: string, requestId: string) {
    const agent = findAgent(agentId, operation, requestId);
    return { agent, state: states.get(agent)! };
  }

  async function run<T>(agent: Agent, state: AgentFileState, request: Operation<T>, operation: string, requestId: string, invoke: () => Promise<T>) {
    const agentId = agent.info.id;
    const reject = (code: string, message: string, cleanup?: string) =>
      problem(code, message, operation, agentId, requestId, cleanup);
    const unknown = () => reject('OPERATION_UNKNOWN', 'Worker has not confirmed the file operation', 'pending');
    if (request.receipt) return request.receipt;
    if (request.rejection) throw request.rejection;
    if (!request.work) {
      request.work = Promise.resolve().then(async () => {
        try {
          if (!isLive(agent)) throw reject('NOT_ALLOWED', 'Agent is unavailable for file control');
          const receipt = await invoke();
          if (!isLive(agent)) throw unknown();
          request.receipt = receipt;
          state.active = undefined;
          state.replacing = false;
          return receipt;
        } catch (caught) {
          const error = caught as Error & { code: string };
          if (!request.uncertain && knownRejections.has(error.code)) {
            request.rejection = reject(error.code, error.message);
            state.active = undefined;
            state.replacing = false;
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
    return result as T;
  }

  function snapshot(agentId: string, options: CompleteFileSnapshotOptions): Promise<CompleteFileSnapshot>;
  function snapshot(agentId: string, options: FileSnapshotOptions): Promise<FileSnapshot>;
  async function snapshot(agentId: string, options: FileSnapshotOptions): Promise<FileSnapshot> {
    const operation = 'files.snapshot';
    const requestId = options?.requestId;
    const reject = (code: string, message: string) => problem(code, message, operation, agentId, requestId);
    if (!validId(requestId)) throw reject('INVALID_CONTRACT', 'File snapshot requires a requestId');
    let spec;
    try {
      if (Object.keys(options).some(key => !['requestId', 'paths', 'maxBytes'].includes(key))) {
        throw new TypeError('Unsupported snapshot options');
      }
      spec = fileSnapshotSelection(options, filePolicy.snapshot);
    } catch (error) { throw reject('INVALID_CONTRACT', (error as Error).message); }

    const { agent, state } = binding(agentId, operation, requestId);
    const identity = JSON.stringify(spec);
    let request = state.snapshots.get(requestId);
    if (request && request.identity !== identity) throw reject('CONFLICT', 'Snapshot requestId has a different selection');
    if (!request) {
      if (!isLive(agent)) throw reject('NOT_ALLOWED', 'Agent is unavailable for file control');
      if (state.active) throw reject('CONFLICT', 'The Agent has another pending file operation');
      request = { identity };
      state.active = request;
      state.snapshots.set(requestId, request);
    }
    return run(agent, state, request, operation, requestId, async () => {
      const reply = await backend.snapshotFiles(agentId, { requestId, paths: spec.paths, maxBytes: spec.maxBytes });
      const scope = spec.paths[0] === '.' ? 'complete' : 'partial';
      const { files, digest } = snapshotFileSeed(reply.files, { ...filePolicy.snapshot, maxBytes: spec.maxBytes });
      if (reply.requestId !== requestId || !Number.isSafeInteger(reply.version) || reply.version < 1 ||
          reply.scope !== scope || reply.digest !== (scope === 'complete' ? completeDigest(digest) : partialDigest(digest))) {
        throw new Error('Worker snapshot receipt did not match the request and file digest');
      }
      Object.values(files).forEach(Object.freeze);
      return Object.freeze({ ...reply, agentId, files: Object.freeze(files) });
    });
  }

  async function replace(agentId: string, options: FileReplaceOptions): Promise<FileReplaceReceipt> {
    const operation = 'files.replace';
    const requestId = options?.requestId;
    const reject = (code: string, message: string) => problem(code, message, operation, agentId, requestId);
    if (!validId(requestId) || !/^complete:sha256:[a-f0-9]{64}$/.test(options.expectedDigest) ||
        (options.writable !== undefined && options.writable !== true) ||
        Object.keys(options).some(key => !['requestId', 'expectedDigest', 'files', 'writable'].includes(key))) {
      throw reject('INVALID_CONTRACT', 'File replacement requires requestId, a complete digest and optional writable: true');
    }
    let target;
    try { target = snapshotFileSeed(options.files, filePolicy.replace); }
    catch (error) { throw reject('INVALID_CONTRACT', (error as Error).message); }

    const { expectedDigest, writable } = options;
    const digest = completeDigest(target.digest);
    const identity = JSON.stringify([agentId, expectedDigest, digest, writable ?? null]);
    let request = replacements.get(requestId);
    if (request && request.identity !== identity) throw reject('CONFLICT', 'Replacement requestId already has different input');
    if (request?.receipt) return request.receipt;
    if (request?.rejection) throw request.rejection;
    const { agent, state } = binding(agentId, operation, requestId);
    if (!request) {
      if (!isLive(agent)) throw reject('NOT_ALLOWED', 'Agent is unavailable for file control');
      if (state.shared) throw reject('NOT_ALLOWED', 'File replacement requires a private workDir');
      if (state.active) throw reject('CONFLICT', 'The Agent has another pending file operation');
      request = { identity };
      state.active = request;
      state.replacing = true;
      replacements.set(requestId, request);
    }
    try {
      return await run(agent, state, request, operation, requestId, async () => {
        const reply = await backend.replaceFiles(agentId, { requestId, expectedDigest, files: target.files, writable });
        if (reply.requestId !== requestId) throw new Error('Worker replacement receipt did not match the request');
        if (reply.status === 'completed' && reply.digest === digest && reply.writable === (state.writable || writable === true)) {
          state.writable = reply.writable;
          return Object.freeze({ agentId, requestId, status: 'completed', digest, writable: reply.writable });
        }
        if (reply.status === 'failed' && typeof reply.error?.code === 'string' &&
            typeof reply.error.message === 'string' && typeof reply.error.retryable === 'boolean') {
          const error = reject(reply.error.code, reply.error.message);
          return Object.freeze({ agentId, requestId, status: 'failed', error: Object.freeze({
            code: reply.error.code, message: error.message, retryable: reply.error.retryable,
          }) });
        }
        throw new Error('Worker did not confirm the file replacement');
      });
    } catch (error) {
      if ((error as { code?: string }).code !== 'OPERATION_UNKNOWN') throw error;
      return { agentId, requestId, status: 'unknown' };
    }
  }

  const api: Runtime['files'] = Object.freeze({ snapshot, replace });
  return { register, canSend: (agent: Agent) => !states.get(agent)!.replacing, api };
}

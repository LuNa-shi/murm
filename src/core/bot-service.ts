import type { BotInfo, BotInitialInputResult, BotSpawnReceipt, InputMode, InputReceipt, SpawnOptions, StopReceipt } from './types.js';
import type { JsonValue } from './service-types.js';

interface BotAuthority {
  status: BotInfo['status'];
  unavailable: boolean;
  services: Readonly<Record<string, readonly string[]>>;
  spawnProfiles?: readonly string[];
  allowContextFork?: boolean;
  parentId?: string;
}

interface BotServiceOptions {
  runtimeId: string;
  getBot: (id: string) => BotAuthority | undefined;
  spawn: (options: SpawnOptions, caller: string) => Promise<BotInfo>;
  get: (id: string) => Promise<BotInfo>;
  send: (id: string, input: string, options: { requestId: string; mode?: InputMode }, caller: string) => Promise<InputReceipt>;
  stop: (id: string) => Promise<StopReceipt>;
}

interface SpawnRequest {
  fingerprint: string;
  bot?: BotInfo;
  initialInput?: BotInitialInputResult;
  work?: Promise<BotSpawnReceipt>;
}

interface BotInput {
  profile: string;
  input?: string;
  mode?: InputMode;
  bot_id: string;
  fork?: boolean;
}

interface BotServiceFailure extends Error {
  code?: string;
  botId?: string;
  cleanup?: string;
  retryable?: boolean;
}

import { validId } from './config.js';
import { SwarmEnvError } from '../errors.js';
import { builtinBotRegistration } from './services.js';

const id = { type: 'string', pattern: '^[A-Za-z0-9_.:-]{1,128}$' };
const mode = { type: 'string', enum: ['steer', 'followUp'] };
const object = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
const errors = [
  'INVALID_CONTRACT', 'NOT_ALLOWED', 'NOT_FOUND', 'CONFLICT',
  'START_FAILED', 'OPERATION_UNKNOWN', 'SERVICE_UNAVAILABLE',
].map(code => ({ code, retryable: ['OPERATION_UNKNOWN', 'SERVICE_UNAVAILABLE'].includes(code) }));
const errorInfo = {
  type: 'object',
  properties: { code: { type: 'string' }, message: { type: 'string' }, retryable: { type: 'boolean' } },
  required: ['code', 'message', 'retryable'],
};
const stopReceipt = object({
  botId: id,
  execution: { enum: ['stopped', 'unknown'] },
  cleanup: { enum: ['complete', 'pending'] },
  artifacts: { type: 'array', items: { type: 'string' } },
  errors: { type: 'array', items: errorInfo },
  pending: { type: 'object' },
}, ['botId', 'execution', 'cleanup', 'artifacts', 'errors']);
const botInfo = object({
  id, profile: id, parentId: id,
  status: { enum: ['starting', 'idle', 'running', 'exited', 'closing', 'closed'] },
  cursor: { type: 'integer', minimum: 0 },
  latestOutput: { type: 'string' }, lastError: errorInfo, lastStop: stopReceipt,
}, ['id', 'profile', 'status', 'cursor']);
const inputReceipt = { oneOf: [
  object({ inputId: id, status: { const: 'unknown' } }, ['inputId', 'status']),
  object({ inputId: id, status: { const: 'accepted' }, disposition: { enum: ['started', 'queued', 'handled'] } }, ['inputId', 'status', 'disposition']),
] };
const outputs: Record<string, Record<string, unknown>> = {
  get: botInfo, send: inputReceipt, stop: stopReceipt,
  spawn: object({ bot: botInfo, initialInput: { anyOf: [
    inputReceipt, { type: 'null' }, object({ status: { const: 'rejected' }, error: errorInfo }, ['status', 'error']),
  ] } }, ['bot', 'initialInput']),
};
const jsonSnapshot = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value));
const botStopView = ({ sessionArchive: _sessionArchive, ...receipt }: StopReceipt) => receipt;
const definitions: readonly [string, string, Record<string, unknown>][] = [
  ['spawn', 'Create a direct child using its Profile defaults; initialInput reports admission, not completion.', object({ profile: id, input: { type: 'string' }, mode, fork: { type: 'boolean' } }, ['profile'])],
  ['get', 'Inspect yourself or one direct child in this Runtime.', object({ bot_id: id }, ['bot_id'])],
  ['send', 'Continue yourself or one direct child; omitted mode is steer. Reuse request-id after unknown.', object({ bot_id: id, input: { type: 'string' }, mode }, ['bot_id', 'input'])],
  ['stop', 'Stop and collect one direct child; pending cleanup can be retried. Self-stop is unavailable.', object({ bot_id: id }, ['bot_id'])],
];

export function createBotService({ runtimeId, getBot, spawn, get, send, stop }: BotServiceOptions) {
  const requests = new Map<string, SpawnRequest>();
  function deny(message: string): never { throw Object.assign(new Error(message), { code: 'NOT_ALLOWED' }); }
  return builtinBotRegistration({ id: 'bot', title: 'Bot control', purpose: 'Control direct children within host Profile policy.', provider_version: '1', contract_version: '2', endpoint: { transport: 'in-process' },
    capabilities: definitions.map(([operation, description, input_schema]) => ({ name: operation, operation, description, help: { when: description }, side_effect: operation === 'get' ? 'read' : 'write', idempotent: true, input_schema, output_schema: outputs[operation], errors })),
  }, { async invoke({ caller, capability, input: serviceInput, envelope }) {
    const input = serviceInput as unknown as BotInput;
    const operation = capability.operation;
    const parent = getBot(caller.botId);
    if (caller.runtimeId !== runtimeId || !parent || parent.unavailable || !['idle', 'running'].includes(parent.status) ||
        !Object.hasOwn(parent.services, 'bot') || !parent.services.bot.includes(operation)) deny('Bot control caller is unavailable or unauthorized');
    const source = `bot:${caller.botId}`;
    const requestId = envelope.operation_id;
    if (!validId(requestId)) throw Object.assign(new Error('Bot request-id must contain 1-128 identifier characters'), { code: 'INVALID_CONTRACT' });
    if (operation === 'spawn') {
      if (!parent.spawnProfiles?.includes(input.profile)) deny('Profile is not allowed for child spawn');
      if (input.fork && parent.allowContextFork !== true) deny('Profile does not permit Context Fork');
      const parameters = { profile: input.profile, fork: input.fork === true, ...(input.input === undefined ? {} : { input: input.input }), mode: input.mode ?? 'steer' };
      const key = JSON.stringify([source, 'spawn', requestId]);
      const fingerprint = JSON.stringify(parameters);
      let request = requests.get(key);
      if (request && request.fingerprint !== fingerprint) throw Object.assign(new Error('spawn requestId already has different parameters'), { code: 'CONFLICT' });
      if (!request) {
        request = { fingerprint };
        requests.set(key, request);
      }
      if (!request.work) request.work = (async () => {
        // Core registers parentId and binds events before spawn returns. Even a
        // fast first input therefore has a publicly queryable relationship.
        try { request!.bot ??= await spawn({ profile: input.profile, parentId: caller.botId, requestId, ...(parameters.fork ? { forkFrom: caller.botId } : {}) }, source); }
        catch (caught) {
          const error = caught as BotServiceFailure;
          // Startup may already own a child even when its receipt is unknown.
          // Preserve that identity and cleanup state through Service errors.
          throw new SwarmEnvError(error.code ?? 'SERVICE_UNAVAILABLE', error.message, {
            runtimeId, ...(error.botId ? { botId: error.botId } : {}), requestId,
            ...(error.cleanup ? { cleanup: error.cleanup } : {}),
          }, { retryable: error.code === 'OPERATION_UNKNOWN' });
        }
        if (input.input === undefined) request!.initialInput = null;
        else if (!request!.initialInput || request!.initialInput.status === 'unknown') {
          try {
            const currentParent = getBot(caller.botId);
            if (!currentParent || currentParent.unavailable || !['idle', 'running'].includes(currentParent.status)) deny('Parent stopped before initial input admission');
            request!.initialInput = await send(request!.bot!.id, input.input, { requestId, mode: parameters.mode }, source + ':initial');
          }
          catch (caught) {
          const error = caught as BotServiceFailure; request!.initialInput = { status: 'rejected', error: { code: error.code ?? 'SERVICE_UNAVAILABLE', message: error.message, retryable: error.retryable ?? false } }; }
        }
        return { bot: request!.bot!, initialInput: request!.initialInput };
      })().finally(() => { request!.work = undefined; });
      return jsonSnapshot(await request.work);
    }
    const target = getBot(input.bot_id);
    if (!target || !(target.parentId === caller.botId || (operation !== 'stop' && input.bot_id === caller.botId))) deny('Target must be yourself or a direct child; stop requires a child');
    if (operation === 'get') {
      const snapshot = await get(input.bot_id);
      if (snapshot.lastStop) snapshot.lastStop = botStopView(snapshot.lastStop);
      return jsonSnapshot(snapshot);
    }
    if (operation === 'send') return jsonSnapshot(await send(input.bot_id, input.input!, { requestId, mode: input.mode }, source));
    return jsonSnapshot(botStopView(await stop(input.bot_id)));
  } });
}

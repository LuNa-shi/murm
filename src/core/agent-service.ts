import type { AgentAccess, AgentAccessPolicy, AgentAccessMutation, AgentAccessRequest, AgentInfo, AgentInitialInputResult, AgentSpawnReceipt, ConditionalInputReceipt, InputMode, InputReceipt, SendOptions, SpawnOptions, StopReceipt } from './types.js';
import type { JsonValue } from './service-types.js';

interface AgentAuthority {
  status: AgentInfo['status'];
  unavailable: boolean;
  services: Readonly<Record<string, readonly string[]>>;
  spawnProfiles?: readonly string[];
  allowContextFork?: boolean;
  parentId?: string;
}

interface AgentServiceOptions {
  runtimeId: string;
  getAgent: (id: string) => AgentAuthority | undefined;
  spawn: (options: SpawnOptions, caller: string) => Promise<AgentInfo>;
  get: (id: string) => Promise<AgentInfo>;
  send(id: string, input: string, options: SendOptions & { wakeIfIdle?: true }, caller: string): Promise<InputReceipt>;
  send(id: string, input: string, options: SendOptions, caller: string): Promise<ConditionalInputReceipt>;
  stop: (id: string) => Promise<StopReceipt>;
  accessPolicy?: AgentAccessPolicy;
  getAccess(id: string): AgentAccess | null;
  mutateAccess(operation: 'grant' | 'revoke', input: AgentAccessMutation, caller: string): Promise<AgentAccess>;
}

interface SpawnRequest {
  fingerprint: string;
  agent?: AgentInfo;
  initialInput?: AgentInitialInputResult;
  work?: Promise<AgentSpawnReceipt>;
}

interface AgentInput {
  profile: string;
  input?: string;
  mode?: InputMode;
  agent_id: string;
  fork?: boolean;
  wake_if_idle?: boolean;
  service_id: string;
  operations: string[];
}

interface AgentServiceFailure extends Error {
  code?: string;
  agentId?: string;
  cleanup?: string;
  retryable?: boolean;
}

import { validId } from './config.js';
import { MurmError } from '../errors.js';
import { builtinAgentRegistration } from './services.js';

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
  agentId: id,
  execution: { enum: ['stopped', 'unknown'] },
  cleanup: { enum: ['complete', 'pending'] },
  artifacts: { type: 'array', items: { type: 'string' } },
  errors: { type: 'array', items: errorInfo },
  pending: { type: 'object' },
}, ['agentId', 'execution', 'cleanup', 'artifacts', 'errors']);
const agentInfo = object({
  id, profile: id, parentId: id,
  status: { enum: ['starting', 'idle', 'running', 'exited', 'closing', 'closed'] },
  latestOutput: { type: 'string' }, lastError: errorInfo, lastStop: stopReceipt,
}, ['id', 'profile', 'status']);
const inputReceipt = { oneOf: [
  object({ inputId: id, status: { const: 'unknown' } }, ['inputId', 'status']),
  object({ inputId: id, status: { const: 'not-accepted' }, reason: { const: 'idle' } }, ['inputId', 'status', 'reason']),
  object({ inputId: id, status: { const: 'accepted' }, disposition: { enum: ['started', 'queued', 'handled'] } }, ['inputId', 'status', 'disposition']),
] };
const operations = { type: 'array', minItems: 1, uniqueItems: true, items: id };
const accessOutput = object({ agentId: id, version: { type: 'integer', minimum: 0 },
  services: { type: 'object', additionalProperties: { type: 'array', items: id } },
}, ['agentId', 'version', 'services']);
const accessInput = object({ agent_id: id, service_id: id, operations }, ['agent_id', 'service_id', 'operations']);
const outputs: Record<string, Record<string, unknown>> = {
  get: agentInfo, send: inputReceipt, stop: stopReceipt, access_get: accessOutput, grant: accessOutput, revoke: accessOutput,
  spawn: object({ agent: agentInfo, initialInput: { anyOf: [
    inputReceipt, { type: 'null' }, object({ status: { const: 'rejected' }, error: errorInfo }, ['status', 'error']),
  ] } }, ['agent', 'initialInput']),
};
const jsonSnapshot = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value));
const agentStopView = ({ sessionArchive: _sessionArchive, ...receipt }: StopReceipt) => receipt;
const definitions: readonly [string, string, Record<string, unknown>][] = [
  ['spawn', 'Create a direct child using its Profile defaults; initialInput reports admission, not completion.', object({ profile: id, input: { type: 'string' }, mode, fork: { type: 'boolean' } }, ['profile'])],
  ['get', 'Inspect yourself or one direct child in this Runtime.', object({ agent_id: id }, ['agent_id'])],
  ['send', 'Continue yourself or one direct child; omitted mode is steer and wake_if_idle defaults to true. Reuse request-id after unknown.', object({ agent_id: id, input: { type: 'string' }, mode, wake_if_idle: { type: 'boolean' } }, ['agent_id', 'input'])],
  ['stop', 'Stop and collect one direct child; pending cleanup can be retried. Self-stop is unavailable.', object({ agent_id: id }, ['agent_id'])],
  ['access_get', 'Inspect the current Service operations of an Agent within your management scope.', object({ agent_id: id }, ['agent_id'])],
  ['grant', 'Grant Service operations to a managed Agent within the host delegation policy.', accessInput],
  ['revoke', 'Revoke Service operations from a managed Agent within the host delegation policy.', accessInput],
];

export function createAgentService({ runtimeId, getAgent, spawn, get, send, stop, accessPolicy, getAccess, mutateAccess }: AgentServiceOptions) {
  const requests = new Map<string, SpawnRequest>();
  function deny(message: string): never { throw Object.assign(new Error(message), { code: 'NOT_ALLOWED' }); }
  return builtinAgentRegistration({ id: 'agent', title: 'Agent control', purpose: 'Control direct children within host Profile policy.', provider_version: '1', contract_version: '2', endpoint: { transport: 'in-process' },
    capabilities: definitions.map(([operation, description, input_schema]) => ({ name: operation, operation, description, help: { when: description }, side_effect: operation === 'get' || operation === 'access_get' ? 'read' : 'write', idempotent: true, input_schema, output_schema: outputs[operation], errors })),
  }, { async invoke({ caller, capability, input: serviceInput, envelope }) {
    const input = serviceInput as unknown as AgentInput;
    const operation = capability.operation;
    const parent = getAgent(caller.agentId);
    if (caller.runtimeId !== runtimeId || !parent || parent.unavailable || !['idle', 'running'].includes(parent.status) ||
        !Object.hasOwn(parent.services, 'agent') || !parent.services.agent.includes(operation)) deny('Agent control caller is unavailable or unauthorized');
    const source = `agent:${caller.agentId}`;
    const requestId = envelope.operation_id;
    if (!validId(requestId)) throw Object.assign(new Error('Agent request-id must contain 1-128 identifier characters'), { code: 'INVALID_CONTRACT' });
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
        try { request!.agent ??= await spawn({ profile: input.profile, parentId: caller.agentId, requestId, ...(parameters.fork ? { forkFrom: caller.agentId } : {}) }, source); }
        catch (caught) {
          const error = caught as AgentServiceFailure;
          // Startup may already own a child even when its receipt is unknown.
          // Preserve that identity and cleanup state through Service errors.
          throw new MurmError(error.code ?? 'SERVICE_UNAVAILABLE', error.message, {
            runtimeId, ...(error.agentId ? { agentId: error.agentId } : {}), requestId,
            ...(error.cleanup ? { cleanup: error.cleanup } : {}),
          }, { retryable: error.code === 'OPERATION_UNKNOWN' });
        }
        if (input.input === undefined) request!.initialInput = null;
        else if (!request!.initialInput || request!.initialInput.status === 'unknown') {
          try {
            const currentParent = getAgent(caller.agentId);
            if (!currentParent || currentParent.unavailable || !['idle', 'running'].includes(currentParent.status)) deny('Parent stopped before initial input admission');
            request!.initialInput = await send(request!.agent!.id, input.input, { requestId, mode: parameters.mode }, source + ':initial');
          }
          catch (caught) {
          const error = caught as AgentServiceFailure; request!.initialInput = { status: 'rejected', error: { code: error.code ?? 'SERVICE_UNAVAILABLE', message: error.message, retryable: error.retryable ?? false } }; }
        }
        return { agent: request!.agent!, initialInput: request!.initialInput };
      })().finally(() => { request!.work = undefined; });
      return jsonSnapshot(await request.work);
    }
    const target = getAgent(input.agent_id);
    if (operation === 'access_get' || operation === 'grant' || operation === 'revoke') {
      if (!target || (operation !== 'access_get' && input.agent_id === caller.agentId)) deny('Target is outside your management scope');
      const subject = { runtimeId, callerId: caller.agentId, agentId: input.agent_id };
      const request: AgentAccessRequest = operation === 'access_get' ? { ...subject, operation } :
        { ...subject, operation, serviceId: input.service_id, operations: [...input.operations] };
      if (accessPolicy?.(request) !== true) deny('Access operation is outside the configured management scope');
      if (operation === 'access_get') return jsonSnapshot(getAccess(input.agent_id));
      return jsonSnapshot(await mutateAccess(operation, {
        agentId: input.agent_id, serviceId: input.service_id, operations: input.operations, requestId,
      }, source));
    }
    if (!target || !(target.parentId === caller.agentId || (operation !== 'stop' && input.agent_id === caller.agentId))) deny('Target must be yourself or a direct child; stop requires a child');
    if (operation === 'get') {
      const snapshot = await get(input.agent_id);
      if (snapshot.lastStop) snapshot.lastStop = agentStopView(snapshot.lastStop);
      return jsonSnapshot(snapshot);
    }
    if (operation === 'send') return jsonSnapshot(await send(input.agent_id, input.input!, { requestId, mode: input.mode, wakeIfIdle: input.wake_if_idle }, source));
    return jsonSnapshot(agentStopView(await stop(input.agent_id)));
  } });
}

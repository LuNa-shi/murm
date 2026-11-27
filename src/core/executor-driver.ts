import { randomUUID } from 'node:crypto';
import { assertShippedModelPair } from '../agent/model-catalog.js';
import type { ExecutorCapabilities, ExecutorKind, ModelConfig } from './backend-config.js';

type Model = ModelConfig;

export interface ExecutorDriver {
  readonly kind: ExecutorKind;
  readonly name: string;
  readonly version: string;
  readonly capabilities: ExecutorCapabilities;
  readonly defaultMaxOutputTokens?: null;
  assertEnvironment?(environment: Readonly<Record<string, string>> | undefined): void;
  modelCatalogResource?(model: Model): ReturnType<typeof assertShippedModelPair>;
  credentials(model: Model, baseUrl: string, token: string): {
    environment: Record<string, string>;
    secretEnvironment: Record<string, string>;
  };
  start(options: { model: Model; baseUrl: string; forkSession: boolean }):
    | { command: 'pi'; args: string[] }
    | { command: 'codex'; args: string[]; codex: { model: string; baseUrl: string; version: string } };
}

const sharedCapabilities = {
  activeSteer: true,
  followUp: true,
  conditionalInput: true,
  queuedInputCancellation: true,
};

const pi: ExecutorDriver = {
  kind: 'pi',
  name: 'Pi',
  version: '1.3.0',
  capabilities: Object.freeze({ ...sharedCapabilities, contextFork: true,
    steeringModes: Object.freeze(['all', 'one-at-a-time'] as const) }),
  modelCatalogResource: assertShippedModelPair,
  credentials(model, baseUrl, token) {
    const prefix = `PI_${model.provider.toUpperCase().replaceAll('-', '_')}`;
    return { environment: { [`${prefix}_BASE_URL`]: baseUrl }, secretEnvironment: { [`${prefix}_API_KEY`]: token } };
  },
  start({ model, forkSession }) {
    return { command: 'pi', args: ['--mode', 'rpc', '--session-dir', '/workspace/runtime/pi-session',
      ...(forkSession ? ['--session', '/workspace/runtime/pi-session/fork.jsonl'] : ['--session-id', randomUUID()]),
      '--tools', 'read,write,edit,bash', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files',
      '--system-prompt', '/workspace/runtime/profile-prompt.txt', '--provider', model.provider, '--model', model.model] };
  },
};

const codexVersion = '0.172.0';
const codex: ExecutorDriver = {
  kind: 'codex',
  name: 'Codex',
  version: codexVersion,
  defaultMaxOutputTokens: null,
  capabilities: Object.freeze({ ...sharedCapabilities, contextFork: false, steeringModes: Object.freeze(['all'] as const) }),
  assertEnvironment(environment) {
    if (Object.keys(environment ?? {}).some(key => /^(?:CODEX_|OPENAI_)/.test(key))) {
      throw Object.assign(new Error('Codex configuration and model credentials must be supplied through the backend'), { code: 'INVALID_CONTRACT' });
    }
  },
  credentials(_model, _baseUrl, token) {
    return { environment: {}, secretEnvironment: { OPENAI_API_KEY: token } };
  },
  start({ model, baseUrl }) {
    return { command: 'codex', args: [], codex: { model: model.model, baseUrl, version: codexVersion } };
  },
};

const drivers = { pi: Object.freeze(pi), codex: Object.freeze(codex) } satisfies Record<ExecutorKind, ExecutorDriver>;

export function selectExecutorDriver(executor: unknown = 'pi'): Readonly<ExecutorDriver> {
  if (typeof executor !== 'string' || !Object.hasOwn(drivers, executor)) {
    throw Object.assign(new Error(`executor must be one of ${Object.keys(drivers).join(', ')}`), { code: 'INVALID_CONTRACT' });
  }
  return drivers[executor as ExecutorKind];
}

export function getExecutorCapabilities(executor: ExecutorKind): ExecutorCapabilities {
  if (executor === undefined) throw Object.assign(new TypeError('executor is required'), { code: 'INVALID_CONTRACT' });
  return selectExecutorDriver(executor).capabilities;
}

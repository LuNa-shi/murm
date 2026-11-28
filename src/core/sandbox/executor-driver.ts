import { randomUUID } from 'node:crypto';
import { resolvePiModelCatalog } from '../model/model-catalog.js';
import type { ExecutorCapabilities, ExecutorKind, ModelConfig } from '../backend-config.js';
import { EXECUTOR_ADAPTER_PROTOCOL, executorVersion, snapshotExecutorCapabilities,
  type BuiltinExecutorSelection, type ExecutorAdapter, type ExecutorSelection } from '../executor-adapter.js';

type Model = ModelConfig;

export interface ExecutorDriver {
  readonly kind: string;
  readonly name: string;
  readonly version: string;
  readonly capabilities: ExecutorCapabilities;
  readonly compatibleVersions: readonly string[];
  readonly adapter?: ExecutorAdapter;
  readonly defaultMaxOutputTokens?: null;
  assertEnvironment?(environment: Readonly<Record<string, string>> | undefined): void;
  modelCatalogResource?(model: Model): ReturnType<typeof resolvePiModelCatalog>;
  credentials(model: Model, baseUrl: string, token: string): {
    environment: Record<string, string>;
    secretEnvironment: Record<string, string>;
  };
  start(options: { model: Model; baseUrl: string; forkSession: boolean }):
    | { command: 'pi'; args: string[] }
    | { command: 'codex'; args: string[]; codex: { model: string; baseUrl: string; version: string } }
    | { command: string; args: []; externalExecutor: ExecutorAdapter };
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
  compatibleVersions: Object.freeze(['1.3.0', '1.4.0']),
  capabilities: Object.freeze({ ...sharedCapabilities, contextFork: true,
    session: Object.freeze({ configure: true, compact: true, abortRetry: true, clearQueue: true,
      state: true, stats: true, messages: true, context: true, beforeCompact: true }),
    steeringModes: Object.freeze(['all', 'one-at-a-time'] as const) }),
  modelCatalogResource: resolvePiModelCatalog,
  credentials(model, baseUrl, token) {
    const prefix = `PI_${model.provider.toUpperCase().replaceAll('-', '_')}`;
    return { environment: { [`${prefix}_BASE_URL`]: baseUrl }, secretEnvironment: { [`${prefix}_API_KEY`]: token } };
  },
  start({ model, forkSession }) {
    return { command: 'pi', args: ['--mode', 'rpc', '--session-dir', '/workspace/runtime/pi-session',
      ...(forkSession ? ['--session', '/workspace/runtime/pi-session/fork.jsonl'] : ['--session-id', randomUUID()]),
      ...(model.capabilities?.tools === false ? ['--no-tools'] : ['--tools', 'read,write,edit,bash']),
      '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files',
      '--system-prompt', '/workspace/runtime/profile-prompt.txt', '--provider', model.provider, '--model', model.model] };
  },
};

const codexVersion = '0.172.0';
const codex: ExecutorDriver = {
  kind: 'codex',
  name: 'Codex',
  version: codexVersion,
  compatibleVersions: Object.freeze([codexVersion]),
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

function invalid(message: string): never {
  throw Object.assign(new Error(message), { code: 'INVALID_CONTRACT' });
}

export function createPiExecutor({ version = pi.version }: { version?: string } = {}): BuiltinExecutorSelection {
  return builtinSelection('pi', version);
}

export function createCodexExecutor({ version = codex.version }: { version?: string } = {}): BuiltinExecutorSelection {
  return builtinSelection('codex', version);
}

function builtinSelection(kind: ExecutorKind, version: string) {
  if (!drivers[kind].compatibleVersions.includes(version)) {
    invalid(`${kind} version ${JSON.stringify(version)} is incompatible; supported versions are ${drivers[kind].compatibleVersions.join(', ')}`);
  }
  return Object.freeze({ kind, version });
}

export function createExecutorAdapter(input: ExecutorAdapter): ExecutorAdapter {
  if (!input || typeof input.kind !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(input.kind) || Object.hasOwn(drivers, input.kind) ||
      typeof input.name !== 'string' || !input.name.trim() || input.protocol !== EXECUTOR_ADAPTER_PROTOCOL ||
      !executorVersion(input.version) || !Array.isArray(input.compatibleVersions) ||
      !input.compatibleVersions.every(executorVersion) || !input.compatibleVersions.includes(input.version) ||
      typeof input.image !== 'string' || !input.image.trim() || !Array.isArray(input.modelProtocols) || !input.modelProtocols.length ||
      !input.modelProtocols.every(id => typeof id === 'string' && /^[a-zA-Z0-9_.-]{1,64}$/.test(id))) invalid('Invalid external executor adapter declaration');
  const capabilities = snapshotExecutorCapabilities(input.capabilities);
  if (capabilities.contextFork) invalid('Context Fork requires the built-in Pi executor session format');
  return Object.freeze({ kind: input.kind, name: input.name, protocol: input.protocol, version: input.version,
    compatibleVersions: Object.freeze([...new Set(input.compatibleVersions)]),
    capabilities, image: input.image,
    modelProtocols: Object.freeze([...new Set(input.modelProtocols)]) });
}

export function selectExecutorDriver(executor: unknown = 'pi'): Readonly<ExecutorDriver> {
  if (executor && typeof executor === 'object') {
    const input = executor as BuiltinExecutorSelection | ExecutorAdapter;
    if (typeof input.kind === 'string' && Object.hasOwn(drivers, input.kind)) {
      const driver = drivers[input.kind as ExecutorKind];
      return Object.freeze({ ...driver, ...builtinSelection(input.kind as ExecutorKind, input.version ?? driver.version) });
    }
    const adapter = createExecutorAdapter(input as ExecutorAdapter);
    return Object.freeze<ExecutorDriver>({
      ...adapter, adapter,
      credentials(model, baseUrl, token) {
        return { environment: { MURM_MODEL_BASE_URL: baseUrl, MURM_MODEL_ID: model.model,
          MURM_MODEL_PROTOCOL: typeof model.protocol === 'object' ? model.protocol.id : model.protocol ?? 'responses' },
        secretEnvironment: { MURM_MODEL_API_KEY: token } };
      },
      start() { return { command: adapter.kind, args: [], externalExecutor: adapter }; },
    });
  }
  if (typeof executor !== 'string' || !Object.hasOwn(drivers, executor)) invalid('Select pi, codex or an explicit executor adapter');
  return drivers[executor as ExecutorKind];
}

export function getExecutorCapabilities(executor: ExecutorSelection): ExecutorCapabilities {
  if (executor === undefined) throw Object.assign(new TypeError('executor is required'), { code: 'INVALID_CONTRACT' });
  return selectExecutorDriver(executor).capabilities;
}

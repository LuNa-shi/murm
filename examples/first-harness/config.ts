import * as sdk from '@luna-shi/murm';
import type { ModelConfig, RuntimeConnectionOptions, SandboxConfig } from '@luna-shi/murm';

const env = process.env;
const legacy = env.MURM_LEGACY_020 === '1';
const resolveConnection = Reflect.get(sdk, 'resolveSandboxConnection') as undefined | (() => {
  lifecycleBaseUrl: string; apiKey?: string; endpointHost?: string; advertiseHost?: string; image?: string;
});
if (!legacy && !resolveConnection) throw new Error('This archive needs the v0.2.0 instructions (MURM_LEGACY_020=1).');

const resolved = legacy ? {
  lifecycleBaseUrl: env.MURM_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
  apiKey: env.MURM_LIFECYCLE_TOKEN,
  endpointHost: env.MURM_ENDPOINT_HOST,
  advertiseHost: env.MURM_ADVERTISE_HOST,
  image: env.MURM_WORKER_IMAGE,
} : resolveConnection!();

if (legacy && !resolved.advertiseHost) throw new Error('Set MURM_ADVERTISE_HOST to the actual Docker bridge address.');
const sandbox = {
  lifecycleBaseUrl: resolved.lifecycleBaseUrl, apiKey: resolved.apiKey, endpointHost: resolved.endpointHost,
  ...(legacy ? { isolation: { network: 'local-docker' as const, disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } } } : {}),
} as SandboxConfig;

const protocol = env.MURM_MODEL_PROTOCOL ?? 'responses';
if (!['responses', 'chat-completions'].includes(protocol) || (legacy && protocol !== 'responses')) {
  throw new Error('Select responses, or use chat-completions with the SDK that supports it.');
}
const contextWindow = env.MURM_CONTEXT_WINDOW === undefined ? undefined : Number(env.MURM_CONTEXT_WINDOW);
if (contextWindow !== undefined && (!Number.isSafeInteger(contextWindow) || contextWindow < 2048)) {
  throw new Error('MURM_CONTEXT_WINDOW must be the configured model context limit, at least 2048 tokens.');
}
const model: ModelConfig = {
  provider: env.MURM_MODEL_PROVIDER ?? 'openai',
  model: env.MURM_MODEL_ID ?? 'gpt-5-mini',
  upstream: { url: env.MURM_MODEL_URL ?? '', headers: env.MURM_MODEL_TOKEN ? { authorization: `Bearer ${env.MURM_MODEL_TOKEN}` } : {} },
  ...(!legacy && protocol === 'chat-completions' ? { protocol } : {}),
  ...(!legacy && contextWindow ? { capabilities: { contextWindow, maxOutputTokens: 1024, tools: true, reasoning: false } } : {}),
};
const connection: RuntimeConnectionOptions = {
  advertiseHost: resolved.advertiseHost,
  modelGateway: { requestTimeoutMs: 90_000, maxOutputTokens: 1024, maxRequests: 32 },
};
const image = resolved.image ?? (legacy ? sdk.DEFAULT_WORKER_IMAGE : `${sdk.DEFAULT_WORKER_IMAGE}-pi`);

export { contextWindow, legacy };
export default { sandbox, connection, executor: 'pi' as const, image, model: 'default', models: { default: model } };

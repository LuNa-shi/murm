import { DEFAULT_WORKER_IMAGE, type CreateRuntimeOptions, type SandboxConfig } from '@luna-shi/murm';

export interface HandoffConfig extends Pick<CreateRuntimeOptions, 'executor' | 'models' | 'connection'> {
  sandbox: SandboxConfig;
  image: string;
  outputDir: string;
  workTimeoutMs: number;
  cleanupTimeoutMs: number;
  externalMessages?: { url: string; token: string };
}

function required(...names: string[]) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  throw new Error(`Set ${names.join(' or ')} before running the handoff example`);
}

export function handoffConfig(): HandoffConfig {
  const executor = process.env.MURM_SDK_EXECUTOR ?? process.env.MURM_EXECUTOR ?? 'pi';
  if (executor !== 'pi' && executor !== 'codex') throw new Error('Use pi or codex for MURM_SDK_EXECUTOR');
  const host = process.env.MURM_SDK_ADVERTISE_HOST ?? process.env.MURM_ADVERTISE_HOST ?? '172.17.0.1';
  const token = process.env.MURM_SDK_MODEL_TOKEN ?? process.env.MURM_MODEL_TOKEN;
  const externalUrl = process.env.MURM_SDK_MESSAGE_URL;
  return {
    image: process.env.MURM_SDK_IMAGE ?? process.env.MURM_WORKER_IMAGE ?? DEFAULT_WORKER_IMAGE,
    outputDir: process.env.MURM_SDK_OUTPUT ?? './handoff-runs',
    workTimeoutMs: 60_000,
    cleanupTimeoutMs: 30_000,
    ...(externalUrl ? { externalMessages: { url: externalUrl, token: required('MURM_SDK_MESSAGE_TOKEN') } } : {}),
    executor,
    sandbox: {
      lifecycleBaseUrl: process.env.MURM_SDK_LIFECYCLE_URL ?? process.env.MURM_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
      endpointHost: process.env.MURM_SDK_ENDPOINT_HOST ?? process.env.MURM_ENDPOINT_HOST ?? '127.0.0.1',
      apiKey: process.env.MURM_SDK_LIFECYCLE_TOKEN ?? process.env.MURM_LIFECYCLE_TOKEN,
      resourceLimits: { cpu: '1', memory: '1Gi' },
      isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } },
    },
    connection: { advertiseHost: host,
      modelGateway: { requestTimeoutMs: 25_000,
      maxOutputTokens: executor === 'codex' ? null : 4096 },
    },
    models: { default: {
      provider: process.env.MURM_SDK_MODEL_PROVIDER ?? process.env.MURM_MODEL_PROVIDER ?? 'openai',
      model: process.env.MURM_SDK_MODEL_ID ?? process.env.MURM_MODEL_ID ?? (executor === 'codex' ? required('MURM_SDK_MODEL_ID', 'MURM_MODEL_ID') : 'gpt-5.4'),
      upstream: { url: required('MURM_SDK_MODEL_URL', 'MURM_MODEL_URL'), headers: token ? { authorization: `Bearer ${token}` } : {} },
    } },
  };
}

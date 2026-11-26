import type { OpenSandboxBackendConfig } from '@murm/core/backends/opensandbox';

export interface HandoffConfig {
  backend: OpenSandboxBackendConfig;
  image: string;
  outputDir: string;
  workTimeoutMs: number;
  cleanupTimeoutMs: number;
  externalMessages?: { url: string; token: string };
}

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} before running the handoff example`);
  return value;
}

export function handoffConfig(): HandoffConfig {
  const executor = process.env.MURM_SDK_EXECUTOR ?? 'pi';
  if (executor !== 'pi' && executor !== 'codex') throw new Error('Use pi or codex for MURM_SDK_EXECUTOR');
  const host = process.env.MURM_SDK_ADVERTISE_HOST ?? '172.17.0.1';
  const token = process.env.MURM_SDK_MODEL_TOKEN;
  const externalUrl = process.env.MURM_SDK_MESSAGE_URL;
  return {
    image: required('MURM_SDK_IMAGE'),
    outputDir: process.env.MURM_SDK_OUTPUT ?? './handoff-runs',
    workTimeoutMs: 60_000,
    cleanupTimeoutMs: 30_000,
    ...(externalUrl ? { externalMessages: { url: externalUrl, token: required('MURM_SDK_MESSAGE_TOKEN') } } : {}),
    backend: {
      executor,
      sandbox: {
        lifecycleBaseUrl: process.env.MURM_SDK_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
        endpointHost: process.env.MURM_SDK_ENDPOINT_HOST ?? '127.0.0.1',
        apiKey: process.env.MURM_SDK_LIFECYCLE_TOKEN,
        resourceLimits: { cpu: '1', memory: '1Gi' },
      },
      bridge: { host: '0.0.0.0', publicUrl: `http://${host}:{port}` },
      modelGateway: { host: '0.0.0.0', advertiseHost: host, requestTimeoutMs: 25_000,
        maxOutputTokens: executor === 'codex' ? null : 4096 },
      models: { default: {
        provider: process.env.MURM_SDK_MODEL_PROVIDER ?? (executor === 'codex' ? 'openai' : 'kimi_proxy'),
        model: process.env.MURM_SDK_MODEL_ID ?? (executor === 'codex' ? required('MURM_SDK_MODEL_ID') : 'k3'),
        upstream: { url: required('MURM_SDK_MODEL_URL'), headers: token ? { authorization: `Bearer ${token}` } : {} },
      } },
      isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } },
    },
  };
}

import { resolveSandboxConnection } from '../../src/core/index.js';
const required = (name: any) => { const value = process.env[name]; if (!value) throw new Error(`Set ${name}`); return value; };
const { lifecycleBaseUrl, endpointHost, apiKey, advertiseHost, image } = resolveSandboxConnection({}, 'SUBSTRATE');
const host = process.env.MURM_ADVERTISE_HOST ?? process.env.MURM_SUBSTRATE_HOST ?? advertiseHost ?? '172.17.0.1';
const token = process.env.MURM_SUBSTRATE_MODEL_TOKEN;
export function substrateConfiguration() {
  return {
    image: image ?? required('MURM_SUBSTRATE_IMAGE'),
    model: 'default',
    poolSize: 3, maxRounds: 2, workTimeoutMs: 120_000, turnTimeoutMs: 30_000, closeTimeoutMs: 30_000,
    sandbox: { lifecycleBaseUrl, endpointHost, apiKey,
      resourceLimits: { cpu: '1', memory: '1Gi' }, commandTimeoutMs: 20_000,
      isolation: { network: 'local-docker' as const, disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } },
    },
    connection: { advertiseHost: host,
      modelGateway: { requestTimeoutMs: 25_000, maxOutputTokens: 2048 },
    },
    models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: {
      url: required('MURM_SUBSTRATE_MODEL_URL'), headers: token ? { authorization: `Bearer ${token}` } : {},
    } } },
  };
}

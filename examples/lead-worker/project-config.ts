import { resolveSandboxConnection } from '../../src/core/index.js';
const required = (name: any) => { const value = process.env[name]; if (!value) throw new Error(`Set ${name}`); return value; };
const { lifecycleBaseUrl, endpointHost, apiKey, advertiseHost, image } = resolveSandboxConnection({}, 'LEAD_WORKER');
const host = process.env.MURM_ADVERTISE_HOST ?? process.env.MURM_LEAD_WORKER_HOST ?? advertiseHost ?? '172.17.0.1';
const modelToken = process.env.MURM_LEAD_WORKER_MODEL_TOKEN;
export function leadWorkerConfig() {
  return {
    image: image ?? required('MURM_LEAD_WORKER_IMAGE'), model: 'default',
  helperCount: 2,
  turnTimeoutMs: 30_000, workTimeoutMs: 120_000, closeTimeoutMs: 30_000, exportLimit: 64 * 1024 ** 2,
  gitea: { origin: required('MURM_LEAD_WORKER_GITEA_ORIGIN'), owner: required('MURM_LEAD_WORKER_GITEA_OWNER'), adminToken: required('MURM_LEAD_WORKER_GITEA_ADMIN_TOKEN') },
  sandbox: {
    lifecycleBaseUrl, endpointHost, apiKey, resourceLimits: { cpu: '1', memory: '1Gi' }, commandTimeoutMs: 20_000,
    isolation: { network: 'local-docker' as const, disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } },
  },
  connection: { advertiseHost: host,
    modelGateway: { requestTimeoutMs: 25_000, maxOutputTokens: 2048 },
  },
  models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: required('MURM_LEAD_WORKER_MODEL_URL'), headers: modelToken ? { authorization: `Bearer ${modelToken}` } : {} } } },
  };
}

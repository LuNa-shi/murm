const required = (name: any) => { const value = process.env[name]; if (!value) throw new Error(`Set ${name}`); return value; };
const host = process.env.MURM_LEAD_WORKER_HOST ?? '172.17.0.1';
const modelToken = process.env.MURM_LEAD_WORKER_MODEL_TOKEN;
export function leadWorkerConfig() {
  return {
    image: required('MURM_LEAD_WORKER_IMAGE'), model: 'default',
  helperCount: 2,
  turnTimeoutMs: 30_000, workTimeoutMs: 120_000, closeTimeoutMs: 30_000, exportLimit: 64 * 1024 ** 2,
  gitea: { origin: required('MURM_LEAD_WORKER_GITEA_ORIGIN'), owner: required('MURM_LEAD_WORKER_GITEA_OWNER'), adminToken: required('MURM_LEAD_WORKER_GITEA_ADMIN_TOKEN') },
  sandbox: {
    lifecycleBaseUrl: process.env.MURM_LEAD_WORKER_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1', endpointHost: process.env.MURM_LEAD_WORKER_ENDPOINT_HOST ?? '127.0.0.1', apiKey: process.env.MURM_LEAD_WORKER_LIFECYCLE_TOKEN, resourceLimits: { cpu: '1', memory: '1Gi' }, commandTimeoutMs: 20_000,
    isolation: { network: 'local-docker' as const, disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } },
  },
  connection: { advertiseHost: host,
    modelGateway: { requestTimeoutMs: 25_000, maxOutputTokens: 2048 },
  },
  models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: required('MURM_LEAD_WORKER_MODEL_URL'), headers: modelToken ? { authorization: `Bearer ${modelToken}` } : {} } } },
  };
}

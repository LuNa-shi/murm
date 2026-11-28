import { resolveSandboxConnection, workerImageFor } from '@luna-shi/murm';

function required(...names: string[]) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  throw new Error(`Set ${names.join(' or ')} before running Lead-Worker`);
}

export function leadWorkerConfig() {
  const { lifecycleBaseUrl, endpointHost, apiKey, advertiseHost, image } = resolveSandboxConnection({}, 'LEAD_WORKER');
  // A scoped endpoint alone historically selected Kimi K3. Keep that route's
  // model identity unless the caller explicitly selects labels or a common URL.
  const legacyModelDefaults = !process.env.MURM_MODEL_URL;
  const executor = process.env.MURM_EXECUTOR ?? process.env.MURM_LEAD_WORKER_EXECUTOR ?? 'pi';
  const token = process.env.MURM_MODEL_TOKEN ?? process.env.MURM_LEAD_WORKER_MODEL_TOKEN;
  const provider = process.env.MURM_MODEL_PROVIDER ?? process.env.MURM_LEAD_WORKER_MODEL_PROVIDER ?? (legacyModelDefaults ? 'kimi_proxy' : 'openai');
  const model = process.env.MURM_MODEL_ID ?? process.env.MURM_LEAD_WORKER_MODEL_ID ??
    (executor === 'codex' ? required('MURM_MODEL_ID', 'MURM_LEAD_WORKER_MODEL_ID') : legacyModelDefaults ? 'k3' : 'gpt-5.4');
  return {
    image: image ?? workerImageFor(executor), model: 'default', executor,
    helperCount: 2,
    turnTimeoutMs: 30_000, workTimeoutMs: 120_000, closeTimeoutMs: 30_000, exportLimit: 64 * 1024 ** 2,
    gitea: {
      origin: required('MURM_LEAD_WORKER_GITEA_ORIGIN'),
      owner: required('MURM_LEAD_WORKER_GITEA_OWNER'),
      adminToken: required('MURM_LEAD_WORKER_GITEA_ADMIN_TOKEN'),
    },
    sandbox: {
      lifecycleBaseUrl, endpointHost, apiKey,
      resourceLimits: { cpu: '1', memory: '1Gi' }, commandTimeoutMs: 20_000,
      // Git Profiles require an enforced endpoint allowlist. The default API
      // Provider does not advertise that capability; keep strict local isolation.
      isolation: { network: 'local-docker' as const, disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } },
    },
    connection: {
      advertiseHost: process.env.MURM_ADVERTISE_HOST ?? process.env.MURM_LEAD_WORKER_HOST ?? advertiseHost ?? '172.17.0.1',
      modelGateway: { requestTimeoutMs: 25_000, maxOutputTokens: executor === 'codex' ? null : 2048 },
    },
    models: { default: { provider, model, upstream: {
      url: required('MURM_MODEL_URL', 'MURM_LEAD_WORKER_MODEL_URL'),
      headers: token ? { authorization: `Bearer ${token}` } : {},
    } } },
  };
}

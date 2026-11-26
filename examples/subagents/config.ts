function required(name: any) {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} before running the Subagents Harness`);
  return value;
}

const host = process.env.MURM_SUBAGENTS_ADVERTISE_HOST ?? '172.17.0.1';
const upstream = required('MURM_SUBAGENTS_MODEL_URL');
const token = process.env.MURM_SUBAGENTS_MODEL_TOKEN;
const executor = process.env.MURM_SUBAGENTS_EXECUTOR ?? 'pi';
const provider = process.env.MURM_SUBAGENTS_MODEL_PROVIDER ?? (executor === 'codex' ? 'openai' : 'kimi_proxy');
const model = executor === 'codex' ? required('MURM_SUBAGENTS_MODEL_ID') : process.env.MURM_SUBAGENTS_MODEL_ID ?? 'k3';

export default {
  model: 'default',
  maxAgents: Number(process.env.MURM_SUBAGENTS_MAX_AGENTS ?? 4),
  maxDepth: Number(process.env.MURM_SUBAGENTS_MAX_DEPTH ?? 3),
  image: required('MURM_SUBAGENTS_IMAGE'),
  outputDir: './subagents-runs',
  workTimeoutMs: 120_000,
  closeTimeoutMs: 30_000,
  executor,
  sandbox: {
    lifecycleBaseUrl: process.env.MURM_SUBAGENTS_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
    endpointHost: process.env.MURM_SUBAGENTS_ENDPOINT_HOST ?? '127.0.0.1',
    apiKey: process.env.MURM_SUBAGENTS_LIFECYCLE_TOKEN,
    resourceLimits: { cpu: '1', memory: '1Gi' },
    commandTimeoutMs: 20_000,
    isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } },
  },
  connection: { advertiseHost: host,
    modelGateway: { requestTimeoutMs: 25_000, maxOutputTokens: executor === 'codex' ? null : 2048 },
  },
  models: { default: { provider, model, upstream: {
    url: upstream, headers: token ? { authorization: `Bearer ${token}` } : {},
  } } },
};

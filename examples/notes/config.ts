function required(name: any) {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} before running the Notes Harness`);
  return value;
}

const host = process.env.MURM_NOTES_ADVERTISE_HOST ?? '172.17.0.1';
const upstream = required('MURM_NOTES_MODEL_URL');
const token = process.env.MURM_NOTES_MODEL_TOKEN;
const executor = process.env.MURM_NOTES_EXECUTOR ?? 'pi';
const provider = process.env.MURM_NOTES_MODEL_PROVIDER ?? (executor === 'codex' ? 'openai' : 'kimi_proxy');
const model = executor === 'codex' ? required('MURM_NOTES_MODEL_ID') : process.env.MURM_NOTES_MODEL_ID ?? 'k3';

export default {
  model: 'default',
  image: required('MURM_NOTES_IMAGE'),
  outputDir: './notes-runs',
  turnTimeoutMs: 30_000,
  closeTimeoutMs: 30_000,
  executor,
  sandbox: {
    lifecycleBaseUrl: process.env.MURM_NOTES_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
    endpointHost: process.env.MURM_NOTES_ENDPOINT_HOST ?? '127.0.0.1',
    apiKey: process.env.MURM_NOTES_LIFECYCLE_TOKEN,
    resourceLimits: { cpu: '1', memory: '1Gi' },
    commandTimeoutMs: 20_000,
    isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } },
  },
  connection: { advertiseHost: host,
    modelGateway: { requestTimeoutMs: 25_000, maxOutputTokens: executor === 'codex' ? null : 4096 },
  },
  models: { default: { provider, model, upstream: {
    url: upstream, headers: token ? { authorization: `Bearer ${token}` } : {},
  } } },
};

function required(name: any) {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} before running the Notes Harness`);
  return value;
}

const host = process.env.MURM_NOTES_ADVERTISE_HOST ?? '172.17.0.1';
const upstream = required('MURM_NOTES_MODEL_URL');
const token = process.env.MURM_NOTES_MODEL_TOKEN;

export default {
  model: 'default',
  image: required('MURM_NOTES_IMAGE'),
  outputDir: './notes-runs',
  turnTimeoutMs: 30_000,
  closeTimeoutMs: 30_000,
  backend: {
    sandbox: {
      lifecycleBaseUrl: process.env.MURM_NOTES_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
      endpointHost: process.env.MURM_NOTES_ENDPOINT_HOST ?? '127.0.0.1',
      apiKey: process.env.MURM_NOTES_LIFECYCLE_TOKEN,
      resourceLimits: { cpu: '1', memory: '1Gi' },
      commandTimeoutMs: 20_000,
    },
    bridge: { host: '0.0.0.0', publicUrl: `http://${host}:{port}` },
    modelGateway: { host: '0.0.0.0', advertiseHost: host, requestTimeoutMs: 25_000, maxOutputTokens: 4096 },
    models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: {
      url: upstream, headers: token ? { authorization: `Bearer ${token}` } : {},
    } } },
    isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } },
  },
};

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} before running the subagents Environment`);
  return value;
}

const host = process.env.SWARMENV_SUBAGENTS_ADVERTISE_HOST ?? '172.17.0.1';
const upstream = required('SWARMENV_SUBAGENTS_MODEL_URL');
const token = process.env.SWARMENV_SUBAGENTS_MODEL_TOKEN;

export default {
  model: 'default',
  childCount: Number(process.env.SWARMENV_SUBAGENTS_CHILD_COUNT ?? 2),
  image: required('SWARMENV_SUBAGENTS_IMAGE'),
  outputDir: './subagents-runs',
  workTimeoutMs: 120_000,
  closeTimeoutMs: 30_000,
  backend: {
    sandbox: {
      lifecycleBaseUrl: process.env.SWARMENV_SUBAGENTS_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
      endpointHost: process.env.SWARMENV_SUBAGENTS_ENDPOINT_HOST ?? '127.0.0.1',
      apiKey: process.env.SWARMENV_SUBAGENTS_LIFECYCLE_TOKEN,
      resourceLimits: { cpu: '1', memory: '1Gi' },
      commandTimeoutMs: 20_000,
    },
    bridge: { host: '0.0.0.0', publicUrl: `http://${host}:{port}` },
    modelGateway: { host: '0.0.0.0', advertiseHost: host, requestTimeoutMs: 25_000, maxOutputTokens: 2048 },
    models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: {
      url: upstream, headers: token ? { authorization: `Bearer ${token}` } : {},
    } } },
    isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } },
  },
};

const required = name => { const value = process.env[name]; if (!value) throw new Error(`Set ${name}`); return value; };
const host = process.env.SWARMENV_SCALEMAS_HOST ?? '172.17.0.1';
const token = process.env.SWARMENV_SCALEMAS_MODEL_TOKEN;
export default {
  runId: required('SWARMENV_SCALEMAS_RUN'), image: required('SWARMENV_SCALEMAS_IMAGE'),
  outputDir: './scalemas-runs', model: 'default',
  question: 'Compare concrete input-validation approaches. Search and visit peer contributions, then publish a self-contained comparison citing the contributions actually used.',
  poolSize: 3, maxRounds: 2, workTimeoutMs: 120_000, turnTimeoutMs: 30_000, closeTimeoutMs: 30_000,
  backend: {
    sandbox: { lifecycleBaseUrl: process.env.SWARMENV_SCALEMAS_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
      endpointHost: process.env.SWARMENV_SCALEMAS_ENDPOINT_HOST ?? '127.0.0.1', apiKey: process.env.SWARMENV_SCALEMAS_LIFECYCLE_TOKEN,
      resourceLimits: { cpu: '1', memory: '1Gi' }, commandTimeoutMs: 20_000 },
    bridge: { host: '0.0.0.0', publicUrl: `http://${host}:{port}` },
    modelGateway: { host: '0.0.0.0', advertiseHost: host, requestTimeoutMs: 25_000, maxOutputTokens: 2048 },
    models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: {
      url: required('SWARMENV_SCALEMAS_MODEL_URL'), headers: token ? { authorization: `Bearer ${token}` } : {},
    } } },
    isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } },
  },
};

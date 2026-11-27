function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}`);
  return value;
}
const host = process.env.MURM_SUBSTRATE_HOST ?? '172.17.0.1';
const token = process.env.MURM_SUBSTRATE_MODEL_TOKEN;
const benchmark = process.env.MURM_FATE_BENCHMARK ?? 'FATE-M';
const hard = benchmark === 'FATE-H';
const workTimeoutMs = hard ? 2_700_000 : 1_800_000;

export default {
  runId: required('MURM_SUBSTRATE_RUN'),
  image: required('MURM_SUBSTRATE_IMAGE'),
  outputDir: process.env.MURM_SUBSTRATE_OUTPUT ?? './experiments/substrate-fate',
  model: 'default',
  poolSize: 4,
  workTimeoutMs,
  checkpointAfterMs: hard ? 1_800_000 : undefined,
  fate: {
    benchmark,
    projectRoot: required('MURM_FATE_PROJECT'),
    leanRoot: required('MURM_FATE_LEAN'),
    mode: process.env.MURM_FATE_MODE ?? 'shared',
  },
  sandbox: {
    lifecycleBaseUrl: process.env.MURM_SUBSTRATE_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
    endpointHost: process.env.MURM_SUBSTRATE_ENDPOINT_HOST ?? '127.0.0.1',
    apiKey: process.env.MURM_SUBSTRATE_LIFECYCLE_TOKEN,
    resourceLimits: { cpu: '1', memory: '1Gi' }, commandTimeoutMs: 20_000, timeoutSeconds: 3600,
    isolation: { network: 'local-docker', disk: { bytes: 128 * 1024 ** 2, inodes: 8192 } },
  },
  connection: { advertiseHost: host,
    modelGateway: { requestTimeoutMs: workTimeoutMs, maxOutputTokens: null },
  },
  models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: {
    url: required('MURM_SUBSTRATE_MODEL_URL'), headers: token ? { authorization: `Bearer ${token}` } : {},
  } } },
};

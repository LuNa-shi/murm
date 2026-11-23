const required = name => { const value = process.env[name]; if (!value) throw new Error(`Set ${name}`); return value; };
const host = process.env.SWARMENV_LEAD_HELPER_HOST ?? '172.17.0.1';
const modelToken = process.env.SWARMENV_LEAD_HELPER_MODEL_TOKEN;
export default {
  runId: required('SWARMENV_LEAD_HELPER_RUN'), image: required('SWARMENV_LEAD_HELPER_IMAGE'), outputDir: './lead-helper-runs', model: 'default',
  goal: 'Build two complementary text reports about input validation and caller authentication. Each initial artifact must give a concrete check and a public feedback suggestion.',
  supplement: 'Require explicit evidence and explain authorization as a separate check. Preserve earlier reports and deliver a new text report containing the full updated public direction.',
  turnTimeoutMs: 30_000, workTimeoutMs: 120_000, closeTimeoutMs: 30_000, exportLimit: 64 * 1024 ** 2,
  gitea: { origin: required('SWARMENV_LEAD_HELPER_GITEA_ORIGIN'), owner: required('SWARMENV_LEAD_HELPER_GITEA_OWNER'), adminToken: required('SWARMENV_LEAD_HELPER_GITEA_ADMIN_TOKEN') },
  backend: {
    sandbox: { lifecycleBaseUrl: process.env.SWARMENV_LEAD_HELPER_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1', endpointHost: process.env.SWARMENV_LEAD_HELPER_ENDPOINT_HOST ?? '127.0.0.1', apiKey: process.env.SWARMENV_LEAD_HELPER_LIFECYCLE_TOKEN, resourceLimits: { cpu: '1', memory: '1Gi' }, commandTimeoutMs: 20_000 },
    bridge: { host: '0.0.0.0', publicUrl: `http://${host}:{port}` }, modelGateway: { host: '0.0.0.0', advertiseHost: host, requestTimeoutMs: 25_000, maxOutputTokens: 2048 },
    models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: required('SWARMENV_LEAD_HELPER_MODEL_URL'), headers: modelToken ? { authorization: `Bearer ${modelToken}` } : {} } } },
    isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } },
  },
};

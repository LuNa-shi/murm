import { DEFAULT_WORKER_IMAGE } from '@luna-shi/murm';

function required(...names: string[]) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  throw new Error(`Set ${names.join(' or ')} before running the Subagents Harness`);
}

const host = process.env.MURM_SUBAGENTS_ADVERTISE_HOST ?? process.env.MURM_ADVERTISE_HOST ?? '172.17.0.1';
const upstream = required('MURM_SUBAGENTS_MODEL_URL', 'MURM_MODEL_URL');
const token = process.env.MURM_SUBAGENTS_MODEL_TOKEN ?? process.env.MURM_MODEL_TOKEN;
const executor = process.env.MURM_SUBAGENTS_EXECUTOR ?? process.env.MURM_EXECUTOR ?? 'pi';
const provider = process.env.MURM_SUBAGENTS_MODEL_PROVIDER ?? process.env.MURM_MODEL_PROVIDER ?? 'openai';
const model = process.env.MURM_SUBAGENTS_MODEL_ID ?? process.env.MURM_MODEL_ID ?? (executor === 'codex' ? required('MURM_SUBAGENTS_MODEL_ID', 'MURM_MODEL_ID') : 'gpt-5.4');

export default {
  model: 'default',
  maxAgents: Number(process.env.MURM_SUBAGENTS_MAX_AGENTS ?? 4),
  maxDepth: Number(process.env.MURM_SUBAGENTS_MAX_DEPTH ?? 3),
  image: process.env.MURM_SUBAGENTS_IMAGE ?? process.env.MURM_WORKER_IMAGE ?? DEFAULT_WORKER_IMAGE,
  outputDir: './subagents-runs',
  workTimeoutMs: 120_000,
  closeTimeoutMs: 30_000,
  executor,
  sandbox: {
    lifecycleBaseUrl: process.env.MURM_SUBAGENTS_LIFECYCLE_URL ?? process.env.MURM_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
    endpointHost: process.env.MURM_SUBAGENTS_ENDPOINT_HOST ?? process.env.MURM_ENDPOINT_HOST ?? '127.0.0.1',
    apiKey: process.env.MURM_SUBAGENTS_LIFECYCLE_TOKEN ?? process.env.MURM_LIFECYCLE_TOKEN,
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

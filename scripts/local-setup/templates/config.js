import './environment.js';
import { fileURLToPath } from 'node:url';

const host = process.env.MURM_SUBAGENTS_ADVERTISE_HOST;
const token = process.env.MURM_SUBAGENTS_MODEL_TOKEN;

export default {
  model: 'default',
  maxAgents: Number(process.env.MURM_SUBAGENTS_MAX_AGENTS ?? 4),
  maxDepth: Number(process.env.MURM_SUBAGENTS_MAX_DEPTH ?? 3),
  image: process.env.MURM_SUBAGENTS_IMAGE,
  outputDir: fileURLToPath(new URL('./subagents-runs/', import.meta.url)),
  workTimeoutMs: 120_000,
  closeTimeoutMs: 30_000,
  sandbox: {
    lifecycleBaseUrl: process.env.MURM_SUBAGENTS_LIFECYCLE_URL,
    endpointHost: process.env.MURM_SUBAGENTS_ENDPOINT_HOST,
    apiKey: process.env.MURM_SUBAGENTS_LIFECYCLE_TOKEN,
    resourceLimits: { cpu: '1', memory: '1Gi' },
    commandTimeoutMs: 20_000,
    isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } },
  },
  connection: { advertiseHost: host,
    modelGateway: { requestTimeoutMs: 25_000, maxOutputTokens: 2048 },
  },
  models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: {
    url: process.env.MURM_SUBAGENTS_MODEL_URL ?? '',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  } } },
};

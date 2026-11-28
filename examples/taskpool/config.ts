import { workerImageFor, resolveSandboxConnection } from '@luna-shi/murm';

function required(...names: string[]) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  throw new Error(`Set ${names.join(' or ')} before running the TaskPool Harness`);
}

const { image, advertiseHost, publicUrl, endpointSource: _endpointSource, ...sandbox } = resolveSandboxConnection({}, 'TASKPOOL');
const upstream = required('MURM_MODEL_URL', 'MURM_TASKPOOL_MODEL_URL');
const token = process.env.MURM_MODEL_TOKEN ?? process.env.MURM_TASKPOOL_MODEL_TOKEN;
const executor = process.env.MURM_EXECUTOR ?? process.env.MURM_TASKPOOL_EXECUTOR ?? 'pi';
const provider = process.env.MURM_MODEL_PROVIDER ?? process.env.MURM_TASKPOOL_MODEL_PROVIDER ?? 'openai';
const model = process.env.MURM_MODEL_ID ?? process.env.MURM_TASKPOOL_MODEL_ID ?? (executor === 'codex' ? required('MURM_TASKPOOL_MODEL_ID', 'MURM_MODEL_ID') : 'gpt-5.4');

export default {
  model: 'default',
  capacity: Number(process.env.MURM_TASKPOOL_CAPACITY ?? 2),
  image: image ?? workerImageFor(executor),
  workTimeoutMs: 120_000,
  closeTimeoutMs: 30_000,
  executor,
  sandbox: {
    ...sandbox,
    resourceLimits: { cpu: '1', memory: '1Gi' },
    commandTimeoutMs: 20_000,
  },
  connection: { publicUrl, advertiseHost,
    modelGateway: { requestTimeoutMs: 25_000, maxOutputTokens: executor === 'codex' ? null : 2048 },
  },
  models: { default: { provider, model, upstream: {
    url: upstream, headers: token ? { authorization: `Bearer ${token}` } : {},
  } } },
};

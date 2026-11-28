import { resolveSandboxConnection, workerImageFor } from '@luna-shi/murm';

function required(...names: string[]) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  throw new Error(`Set ${names.join(' or ')} before running Substrate`);
}

export function substrateConfiguration() {
  const { image, advertiseHost, publicUrl, endpointSource: _endpointSource, ...sandbox } = resolveSandboxConnection({}, 'SUBSTRATE');
  // A scoped endpoint alone historically selected Kimi K3. Keep that route's
  // model identity unless the caller explicitly selects labels or a common URL.
  const legacyModelDefaults = !process.env.MURM_MODEL_URL;
  const executor = process.env.MURM_EXECUTOR ?? process.env.MURM_SUBSTRATE_EXECUTOR ?? 'pi';
  const token = process.env.MURM_MODEL_TOKEN ?? process.env.MURM_SUBSTRATE_MODEL_TOKEN;
  const provider = process.env.MURM_MODEL_PROVIDER ?? process.env.MURM_SUBSTRATE_MODEL_PROVIDER ?? (legacyModelDefaults ? 'kimi_proxy' : 'openai');
  const model = process.env.MURM_MODEL_ID ?? process.env.MURM_SUBSTRATE_MODEL_ID ??
    (executor === 'codex' ? required('MURM_MODEL_ID', 'MURM_SUBSTRATE_MODEL_ID') : legacyModelDefaults ? 'k3' : 'gpt-5.4');
  return {
    image: image ?? workerImageFor(executor), model: 'default', executor,
    poolSize: 3, maxRounds: 2, workTimeoutMs: 120_000, turnTimeoutMs: 30_000, closeTimeoutMs: 30_000,
    sandbox: {
      ...sandbox,
      resourceLimits: { cpu: '1', memory: '1Gi' }, commandTimeoutMs: 20_000,
    },
    connection: {
      publicUrl,
      advertiseHost: process.env.MURM_ADVERTISE_HOST ?? process.env.MURM_SUBSTRATE_HOST ?? advertiseHost,
      modelGateway: { requestTimeoutMs: 25_000, maxOutputTokens: executor === 'codex' ? null : 2048 },
    },
    models: { default: { provider, model, upstream: {
      url: required('MURM_MODEL_URL', 'MURM_SUBSTRATE_MODEL_URL'),
      headers: token ? { authorization: `Bearer ${token}` } : {},
    } } },
  };
}

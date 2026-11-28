import { resolveSandboxConnection, workerImageFor } from '@luna-shi/murm';
import { resolve } from 'node:path';
import { createBoardLauncher } from './services/board-process.js';

const setting = (name: string) => process.env[`MURM_PEERMESH_${name}`];
function required(name: string) {
  const value = setting(name);
  if (!value) throw Object.assign(new Error(`Set MURM_PEERMESH_${name}`), { code: `PEERMESH_CONFIG_${name}_REQUIRED` });
  return value;
}

export function peerMeshConfig(durationMs = Number(setting('DURATION_MS') ?? 120_000)) {
  const { advertiseHost, publicUrl, image, endpointSource: _source, ...sandbox } = resolveSandboxConnection({}, 'PEERMESH');
  // A scoped endpoint alone historically selected Kimi K3. Keep that route's
  // model identity unless the caller explicitly selects labels or a common URL.
  const legacyModelDefaults = !process.env.MURM_MODEL_URL;
  const executor = process.env.MURM_EXECUTOR ?? setting('EXECUTOR') ?? 'pi';
  const provider = process.env.MURM_MODEL_PROVIDER ?? setting('MODEL_PROVIDER') ?? (legacyModelDefaults ? 'kimi_proxy' : 'openai');
  const model = process.env.MURM_MODEL_ID ?? setting('MODEL_ID') ?? (executor === 'codex' ? required('MODEL_ID') : legacyModelDefaults ? 'k3' : 'gpt-5.4');
  const peerCount = Number(setting('PEERS') ?? '2');
  if (!Number.isSafeInteger(peerCount) || peerCount < 2 || peerCount > 8 || !Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 86_400_000) {
    throw Object.assign(new Error('Invalid peer count or project duration'), { code: 'PEERMESH_CONFIG_PROJECT_INVALID' });
  }
  const timeoutMs = durationMs + 120_000;
  const closeTimeoutMs = 30_000;
  const modelUrl = process.env.MURM_MODEL_URL || required('MODEL_URL');
  const modelToken = process.env.MURM_MODEL_TOKEN ?? setting('MODEL_TOKEN');
  const gitea = { origin: required('GITEA_ORIGIN'), owner: required('GITEA_OWNER'), adminToken: required('GITEA_TOKEN') };
  const mattermost = { origin: required('MATTERMOST_ORIGIN'), teamId: required('MATTERMOST_TEAM_ID'), adminToken: required('MATTERMOST_TOKEN') };
  const mysqlDsn = required('BOARD_MYSQL_DSN');
  const startBoard = createBoardLauncher({
    sourceDirectory: resolve(required('BOARD_SOURCE')),
    mysqlDsn,
    origin: setting('BOARD_ORIGIN') ?? 'http://127.0.0.1:8660',
    python: setting('BOARD_PYTHON') ?? 'python3',
  });
  return {
    image: image ?? workerImageFor(executor), executor,
    sandbox: {
      ...sandbox,
      timeoutSeconds: Math.ceil((timeoutMs + closeTimeoutMs) / 1_000),
      resourceLimits: { cpu: '1', memory: '1Gi' }, commandTimeoutMs: 20_000,
    },
    gitea, mattermost, startBoard, durationMs, timeoutMs,
    connection: {
      publicUrl,
      advertiseHost: process.env.MURM_ADVERTISE_HOST ?? setting('HOST') ?? advertiseHost ?? '172.17.0.1',
      modelGateway: { maxOutputTokens: executor === 'codex' ? null : 2048, requestTimeoutMs: 25_000 },
    },
    models: { default: { provider, model, upstream: {
      url: modelUrl, headers: modelToken ? { authorization: `Bearer ${modelToken}` } : {},
    } } },
    peerKeys: Array.from({ length: peerCount }, (_, index) => String.fromCharCode(97 + index)),
    outputDir: setting('OUTPUT_DIR') ?? './peermesh-runs', closeTimeoutMs,
    secretValues: [modelToken, mysqlDsn],
  };
}

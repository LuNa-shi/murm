import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createBoardLauncher } from '../../src/harnesses/peermesh/board-process.js';

const setting = (name: any) => process.env[`MURM_PEERMESH_${name}`];
function required(name: any) {
  const value = setting(name);
  if (!value) throw Object.assign(new Error(`Set MURM_PEERMESH_${name}`), { code: `PEERMESH_CONFIG_${name}_REQUIRED` });
  return value;
}

const runId = required('RUN_ID');
const image = required('IMAGE');
const project = JSON.parse(await readFile(resolve(required('PROJECT_FILE')), 'utf8'));
const peerCount = Number(setting('PEERS') ?? '2');
const durationMs = project?.durationMs ?? 3_600_000;
if (!Number.isSafeInteger(peerCount) || peerCount < 2 || peerCount > 8 || !Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 86_400_000) {
  throw Object.assign(new Error('Invalid peer count or project duration'), { code: 'PEERMESH_CONFIG_PROJECT_INVALID' });
}
const timeoutMs = durationMs + 120_000;
const closeTimeoutMs = 30_000;
const modelUrl = required('MODEL_URL');
const modelToken = setting('MODEL_TOKEN');
const gitea: any = { origin: required('GITEA_ORIGIN'), owner: required('GITEA_OWNER'), adminToken: required('GITEA_TOKEN') };
const mattermost: any = { origin: required('MATTERMOST_ORIGIN'), teamId: required('MATTERMOST_TEAM_ID'), adminToken: required('MATTERMOST_TOKEN') };
const mysqlDsn = required('BOARD_MYSQL_DSN');
const startBoard = createBoardLauncher({
  sourceDirectory: resolve(required('BOARD_SOURCE')),
  mysqlDsn,
  origin: setting('BOARD_ORIGIN') ?? 'http://127.0.0.1:8660',
  python: setting('BOARD_PYTHON') ?? 'python3',
});

const { createSandbox } = await import('@murm/core');
const host = setting('HOST') ?? '172.17.0.1';
const sandbox = createSandbox({
  lifecycleBaseUrl: setting('LIFECYCLE_URL') ?? 'http://127.0.0.1:8080/v1',
  endpointHost: setting('ENDPOINT_HOST') ?? '127.0.0.1',
  apiKey: setting('LIFECYCLE_TOKEN'),
  timeoutSeconds: Math.ceil((timeoutMs + closeTimeoutMs) / 1_000),
  resourceLimits: { cpu: '1', memory: '1Gi' },
  commandTimeoutMs: 20_000,
  isolation: { network: 'local-docker', disk: { bytes: 128 * 1024 ** 2, inodes: 8192 } },
});

export default {
  mode: 'peermesh',
  timeoutMs,
  options: {
    runId, image, sandbox, gitea, mattermost, startBoard,
    connection: { advertiseHost: host, modelGateway: { maxOutputTokens: 2048, requestTimeoutMs: 25_000 } },
    models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: {
      url: modelUrl, headers: modelToken ? { authorization: `Bearer ${modelToken}` } : {},
    } } },
    project, peerKeys: Array.from({ length: peerCount }, (_, index) => String.fromCharCode(97 + index)),
    outputDir: setting('OUTPUT_DIR') ?? './peermesh-runs', closeTimeoutMs,
    secretValues: [modelToken, mysqlDsn],
  },
};

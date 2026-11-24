import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPiOpenSandboxBackend } from '@swarmenv/core/backends/pi-opensandbox';
import { createCappedUpstream } from '../../test/fixtures/core-capped-upstream.js';
import { createBoardLauncher } from '../../src/environments/agensh/board-process.js';
import { prepareAgenshFacilities } from '../../src/environments/agensh/provision.js';
import { createAgenshArithmeticWorkload } from '../../src/environments/endurance/agensh-workload.js';
import { createScaleMASArithmeticWorkload } from '../../src/environments/endurance/scalemas-workload.js';

const setting = name => process.env[`SWARMENV_HOUR_${name}`];
const required = name => {
  const value = setting(name);
  if (!value) throw Object.assign(new Error('Hour configuration is incomplete'), { code: `HOUR_${name}_REQUIRED` });
  return value;
};

/** No allocation or listener on import. Source/archive/Worker and this exact
 * configuration require independent review before the operator launches it. */
async function create({ mode, budgets, quotas, signal }) {
  let admitLifetime;
  try { ({ admitLifetime } = await import('../../test/fixtures/lifetime-host-observation.js')); }
  catch { throw Object.assign(new Error('Reviewed lifetime gate not installed'), { code: 'HOUR_INDEPENDENT_GATES_NOT_INSTALLED' }); }
  const programming = (await import(pathToFileURL(resolve(required('WORKLOAD'))).href)).default;
  const image = required('IMAGE');
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw Object.assign(new Error('Immutable Worker required'), { code: 'HOUR_IMAGE_INVALID' });
  const upstreamUrl = required('UPSTREAM_URL');
  let upstreamHeaders;
  try { upstreamHeaders = JSON.parse(required('UPSTREAM_HEADERS_JSON')); } catch { throw Object.assign(new Error('Private headers invalid'), { code: 'HOUR_HEADERS_INVALID' }); }
  const host = setting('HOST') ?? '172.17.0.1';
  const lifecycle = setting('LIFECYCLE_URL') ?? 'http://127.0.0.1:8080/v1';
  const apiKey = setting('LIFECYCLE_TOKEN');
  const phases = { ...budgets }; delete phases.turnMs;
  const controller = new AbortController();
  const life = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const quota = await createCappedUpstream({ profile: 'endurance', phases, upstreamUrl, upstreamHeaders,
    ...quotas, deadlineAt: Date.now() + budgets.setupMs + budgets.workMs,
    filename: 'unused-hour', marker: 'unused-hour', failFast: true, onFailure: () => controller.abort() });
  try {
    const runId = `hour-${mode.toLowerCase()}-${randomUUID().slice(0, 8)}`;
    const options = { runId, image, outputDir: resolve('experiments', runId),
      backend: createPiOpenSandboxBackend({
        sandbox: { lifecycleBaseUrl: lifecycle, endpointHost: setting('ENDPOINT_HOST') ?? '127.0.0.1', apiKey,
          timeoutSeconds: Math.ceil(Object.values(phases).reduce((a, b) => a + b, 0) / 1000) + 60,
          resourceLimits: { cpu: '1', memory: '1Gi' }, commandTimeoutMs: 30_000 },
        bridge: { host: '0.0.0.0', publicUrl: `http://${host}:{port}` },
        modelGateway: { host: '0.0.0.0', advertiseHost: host, maxOutputTokens: quotas.generationOutputTokens, requestTimeoutMs: 90_000 },
        models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: quota.url, headers: {} } } },
        isolation: { network: 'local-docker', disk: { bytes: 128 * 1024 ** 2, inodes: 8192 } },
      }) };
    let workload;
    if (mode === 'agensh') {
      const gitea = { origin: required('GITEA_ORIGIN'), owner: required('GITEA_OWNER'), adminToken: required('GITEA_TOKEN') };
      const mattermost = { origin: required('MATTERMOST_ORIGIN'), teamId: required('MATTERMOST_TEAM_ID'), adminToken: required('MATTERMOST_TOKEN') };
      const mysqlDsn = required('BOARD_MYSQL_DSN');
      let facilities;
      Object.assign(options, { gitea, mattermost, exportLimit: 8 * 1024 ** 2,
        startBoard: createBoardLauncher({ sourceDirectory: resolve(required('BOARD_SOURCE')), mysqlDsn,
          origin: setting('BOARD_ORIGIN') ?? 'http://127.0.0.1:8660', python: setting('BOARD_PYTHON') ?? 'python3' }),
        secretValues: [gitea.adminToken, mattermost.adminToken, mysqlDsn, ...Object.values(upstreamHeaders)],
        prepare: async parameters => { facilities = await prepareAgenshFacilities(parameters); return facilities; },
        router: { events: { pollIntervalMs: 10_000, maxPolls: 600 } },
      });
      workload = createAgenshArithmeticWorkload({ getFacilities: () => facilities, adminToken: gitea.adminToken, programming });
    } else workload = createScaleMASArithmeticWorkload({ programming });
    return { options, workload, quota, signal: life,
      admit: parameters => admitLifetime({ ...parameters, provider: { baseUrl: lifecycle,
        headers: apiKey ? { 'OPEN-SANDBOX-API-KEY': apiKey } : {}, uncertaintyMs: 1000 } }) };
  } catch (error) { await quota.close(); throw error; }
}

export default { configurations: { agensh: create, scaleMAS: create } };

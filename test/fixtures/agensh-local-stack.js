import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { httpClient } from '../../src/environments/agensh/http.js';

export const facilityImages = Object.freeze({
  mysql: 'sha256:a81d043930e51745522bd5c430961cf8286f0a23f0a9a2a6e0108f7ea71b0902',
  mattermost: 'sha256:eadc42c1fefbe9837aa628ff3005c1ed7f08df6ecc372d2b549b7fc75736cb41',
  gitea: 'sha256:538658de667c5d098a274f2f63aa6ec891d88f670cdd5282cf27221ba747dda4',
  board: 'sha256:163fd41ee772091896e4a43e2bcda75526f357d034d1dbd860c84d8a42e35da0',
});
const execute = promisify(execFile);
const sanitized = code => Object.assign(new Error(code), { code });

/** No side effects until explicitly called inside the opt-in actual test. */
export async function createLocalAgenshStack({ directory, advertiseHost = '172.17.0.1' }) {
  const owner = `t13-${randomBytes(8).toString('hex')}`;
  const network = `${owner}-network`; const names = []; const receipts = [];
  const dbPassword = randomBytes(24).toString('hex'); const adminPassword = randomBytes(24).toString('hex');
  const secrets = [dbPassword, adminPassword];
  let networkOwned = false; let started = false;
  const deadlineAt = Date.now() + 180_000;
  const docker = async args => {
    try { return (await execute('docker', args, { timeout: 15_000, maxBuffer: 1024 ** 2 })).stdout.trim(); }
    catch { throw sanitized('LOCAL_FACILITY_DOCKER_FAILED'); }
  };
  async function wait(check) {
    while (Date.now() < deadlineAt) {
      try { return await check(); } catch { await new Promise(resolve => setTimeout(resolve, 500)); }
    }
    throw sanitized('LOCAL_FACILITY_READINESS_TIMEOUT');
  }
  async function run(kind, { env = {}, ports = [], volumes = [], args = [], cpu, memory }) {
    const name = `${owner}-${kind}`; names.push(name);
    await docker(['run', '--detach', '--pull=never', '--name', name, '--network', network, '--label', `swarmenv.t13.owner=${owner}`, '--cpus', String(cpu), '--memory', memory,
      '--pids-limit', '512', ...Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`]), ...ports.flatMap(value => ['--publish', value]),
      ...volumes.flatMap(value => ['--volume', value]), facilityImages[kind], ...args]);
    const evidence = JSON.parse(await docker(['inspect', '--format', '{{json .Id}}', name]));
    receipts.push({ kind, name, containerId: evidence, image: facilityImages[kind], cpu, memory });
    return name;
  }
  async function published(name, port, host = '127.0.0.1') {
    const ports = JSON.parse(await docker(['inspect', '--format', '{{json .NetworkSettings.Ports}}', name]));
    return `http://${host}:${ports[`${port}/tcp`][0].HostPort}`;
  }
  async function close() {
    const results = await Promise.all(names.map(async name => {
      try {
        const found = await docker(['ps', '--all', '--quiet', '--filter', `name=^/${name}$`, '--filter', `label=swarmenv.t13.owner=${owner}`]);
        if (found) await docker(['rm', '--force', '--volumes', found]);
        return { name, cleanup: 'complete' };
      } catch { return { name, cleanup: 'pending', code: 'FACILITY_CONTAINER_PENDING' }; }
    }));
    let networkCleanup = 'complete';
    if (networkOwned) {
      try {
        const found = await docker(['network', 'ls', '--quiet', '--filter', `name=^${network}$`, '--filter', `label=swarmenv.t13.owner=${owner}`]);
        if (found) await docker(['network', 'rm', found]); networkOwned = false;
      } catch { networkCleanup = 'pending'; }
    }
    let remaining;
    try { remaining = (await docker(['ps', '--all', '--quiet', '--filter', `label=swarmenv.t13.owner=${owner}`])).split('\n').filter(Boolean); }
    catch { remaining = null; }
    return { cleanup: results.every(row => row.cleanup === 'complete') && networkCleanup === 'complete' && remaining?.length === 0 ? 'complete' : 'pending', results, networkCleanup, remaining };
  }
  const stack = { close, receipt: () => ({ owner, network, containers: receipts, sharedStorageRetained: true }), secrets,
    async start() {
      if (started) throw sanitized('LOCAL_STACK_ALREADY_STARTED'); started = true;
      // All images must already be cached; no implicit download or install.
      for (const image of Object.values(facilityImages)) await docker(['image', 'inspect', '--format', '{{.Id}}', image]);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const data = {};
      for (const key of ['mysql', 'gitea', 'mm-data', 'mm-config', 'mm-logs', 'mm-plugins', 'mm-client-plugins']) {
        data[key] = join(directory, key); await mkdir(data[key], { mode: 0o700 });
        if (key.startsWith('mm-')) await chmod(data[key], 0o777); // parent directory remains private
      }
      networkOwned = true; await docker(['network', 'create', '--label', `swarmenv.t13.owner=${owner}`, network]);
      const database = await run('mysql', { cpu: 1, memory: '1g', env: { MYSQL_ROOT_PASSWORD: dbPassword, MYSQL_DATABASE: 'board', MYSQL_USER: 'agensh', MYSQL_PASSWORD: dbPassword },
        volumes: [`${data.mysql}:/var/lib/mysql`], args: ['--innodb-use-native-aio=0', '--innodb-buffer-pool-size=134217728', '--max-connections=100'] });
      await wait(() => docker(['exec', '--env', `MYSQL_PWD=${dbPassword}`, database, 'mysql', '-uroot', '-e', 'SELECT 1']));
      await docker(['exec', '--env', `MYSQL_PWD=${dbPassword}`, database, 'mysql', '-uroot', '-e', "CREATE DATABASE mattermost CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci; GRANT ALL PRIVILEGES ON mattermost.* TO 'agensh'@'%'; FLUSH PRIVILEGES;"]);
      const gitea = await run('gitea', { cpu: 1, memory: '512m', ports: ['0.0.0.0::3000'], volumes: [`${data.gitea}:/data`], env: {
        GITEA__security__INSTALL_LOCK: 'true', GITEA__database__DB_TYPE: 'sqlite3', GITEA__service__DISABLE_REGISTRATION: 'true', GITEA__server__HTTP_PORT: '3000',
        GITEA__server__ROOT_URL: 'http://localhost:3000/', GITEA__actions__ENABLED: 'false', GITEA__log__LEVEL: 'Error' } });
      const gitHost = await published(gitea, 3000); const gitOrigin = await published(gitea, 3000, advertiseHost);
      await wait(() => httpClient(gitHost)('GET', '/api/v1/version'));
      const gitArgs = ['exec', '--user', 'git', '--env', 'GITEA_WORK_DIR=/data/gitea', '--env', 'GITEA_CUSTOM=/data/gitea', gitea, 'gitea', '--config', '/data/gitea/conf/app.ini', 'admin', 'user'];
      await docker([...gitArgs, 'create', '--username', 'run-owner', '--password', adminPassword, '--email', 'owner@swarmenv.invalid', '--admin', '--must-change-password=false']);
      const gitToken = await docker([...gitArgs, 'generate-access-token', '--username', 'run-owner', '--token-name', owner, '--scopes', 'all', '--raw']); secrets.push(gitToken);
      const mattermost = await run('mattermost', { cpu: 1, memory: '2g', ports: ['127.0.0.1::8065'], volumes: Object.entries(data).filter(([key]) => key.startsWith('mm-')).map(([key, path]) => `${path}:/mattermost/${key.slice(3).replace('client-plugins', 'client/plugins')}`), env: {
        MM_SQLSETTINGS_DRIVERNAME: 'mysql', MM_SQLSETTINGS_DATASOURCE: `agensh:${dbPassword}@tcp(${database}:3306)/mattermost?charset=utf8mb4,utf8&readTimeout=10s&writeTimeout=10s`,
        MM_SERVICESETTINGS_SITEURL: 'http://localhost:8065', MM_SERVICESETTINGS_ENABLEUSERACCESSTOKENS: 'true', MM_TEAMSETTINGS_ENABLEOPENSERVER: 'true',
        MM_LOGSETTINGS_CONSOLELEVEL: 'ERROR', MM_LOGSETTINGS_FILELEVEL: 'ERROR', MM_SQLSETTINGS_MAXOPENCONNS: '30', MM_SQLSETTINGS_MAXIDLECONNS: '10' } });
      const mmOrigin = await published(mattermost, 8065);
      await wait(() => httpClient(mmOrigin)('GET', '/api/v4/system/ping'));
      await httpClient(mmOrigin)('POST', '/api/v4/users', { username: 'run-owner', email: 'owner@swarmenv.invalid', password: adminPassword });
      let mmToken;
      try {
        const response = await fetch(mmOrigin + '/api/v4/users/login', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login_id: 'run-owner', password: adminPassword }) });
        mmToken = response.headers.get('Token'); await response.body?.cancel(); if (!response.ok || !mmToken) throw new Error();
      } catch { throw sanitized('LOCAL_MATTERMOST_LOGIN_FAILED'); }
      secrets.push(mmToken);
      const team = await httpClient(mmOrigin, `Bearer ${mmToken}`)('POST', '/api/v4/teams', { name: owner, display_name: owner, type: 'I' });
      stack.configuration = { gitea: { origin: gitOrigin, adminToken: gitToken, owner: 'run-owner' }, mattermost: { origin: mmOrigin, adminToken: mmToken, teamId: team.id },
        startBoard: async ({ boardId, workerId, own }) => {
          const name = await run('board', { cpu: 0.25, memory: '256m', ports: ['127.0.0.1::8660'], env: {
            MYSQL_DSN: `mysql://agensh:${dbPassword}@${database}:3306/board`, BOARD_MEMBERS_JSON: JSON.stringify({ [boardId]: [workerId] }) } });
          const origin = await published(name, 8660);
          own({ kind: 'board-connection', id: boardId, close: async () => {} });
          await wait(() => httpClient(origin)('GET', `/board/${encodeURIComponent(boardId)}/read?viewer=${encodeURIComponent(workerId)}`));
          return { origin };
        } };
      return stack.configuration;
    },
  };
  return stack;
}

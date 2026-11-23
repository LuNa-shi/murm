import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, chmod, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDeadline, createCleanupBudget } from './agensh-deadline.js';
import { httpClient } from '../../src/environments/agensh/http.js';

export const facilityImages = Object.freeze({
  mysql: 'sha256:a81d043930e51745522bd5c430961cf8286f0a23f0a9a2a6e0108f7ea71b0902',
  mattermost: 'sha256:eadc42c1fefbe9837aa628ff3005c1ed7f08df6ecc372d2b549b7fc75736cb41',
  gitea: 'sha256:538658de667c5d098a274f2f63aa6ec891d88f670cdd5282cf27221ba747dda4',
  board: 'sha256:163fd41ee772091896e4a43e2bcda75526f357d034d1dbd860c84d8a42e35da0',
});
const execute = promisify(execFile);
const sanitized = code => Object.assign(new Error(code), { code });
export const boardSchema = Object.freeze({
  revision: '2dae4e14a653da48549fd9aa093f834841475d6c',
  sha256: 'baa0ce607371751d6e7a526179512f2ff3a59ede88749059bed1a2522b3f3bb2',
});

/** No side effects until explicitly called inside the opt-in actual test. */
export async function createLocalAgenshStack({ directory, advertiseHost = '172.17.0.1', setupMs = 180_000, giteaOnly = false, executeCommand = execute }) {
  const owner = `t13-${randomBytes(8).toString('hex')}`;
  const network = `${owner}-network`; const names = []; const receipts = []; const commands = []; const readiness = {};
  const dbPassword = randomBytes(24).toString('hex'); const adminPassword = randomBytes(24).toString('hex');
  const secrets = [dbPassword, adminPassword];
  let networkOwned = false; let networkCreationUnknown = false; let started = false;
  const unknownContainers = new Set();
  let setup;
  const setupStep = operation => setup.step(operation);
  const request = (origin, authorization) => (method, path, body) => setupStep(({ signal }) => httpClient(origin, authorization)(method, path, body, { signal }));
  const invokeDocker = async (stage, args, options) => {
    const row = { stage, state: 'pending' }; commands.push(row);
    try {
      const result = await executeCommand('docker', args, { ...options, maxBuffer: 1024 ** 2 });
      row.state = 'succeeded'; return result.stdout.trim();
    } catch (error) {
      row.state = 'failed';
      row.errorClass = options.signal?.aborted ? 'aborted' : error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'output_limit' :
        error?.killed ? 'timeout' : Number.isInteger(error?.code) ? 'nonzero_exit' : error?.code === 'ENOENT' ? 'unavailable' : 'unknown';
      throw sanitized('LOCAL_FACILITY_DOCKER_FAILED');
    }
  };
  const docker = async (args, signal, stage) => {
    try { signal?.throwIfAborted();
      return await setup.step(({ timeoutMs, signal: setupSignal }) => invokeDocker(stage, args, { timeout: timeoutMs, signal: AbortSignal.any([setupSignal, ...(signal ? [signal] : [])]) }), 15_000); }
    catch { setup.remaining(); throw sanitized('LOCAL_FACILITY_DOCKER_FAILED'); }
  };
  async function wait(check, signal) {
    while (true) {
      signal?.throwIfAborted(); setup.remaining();
      try { return await check(); } catch (error) {
        if (['LOCAL_BOARD_EXITED', 'LOCAL_BOARD_STATE_INVALID'].includes(error?.code)) throw error;
        signal?.throwIfAborted(); await new Promise(resolve => setTimeout(resolve, setup.remaining(500)));
      }
    }
  }
  async function run(kind, { env = {}, ports = [], volumes = [], args = [], cpu, memory, signal }) {
    signal?.throwIfAborted(); setup.remaining();
    const name = `${owner}-${kind}`; names.push(name); unknownContainers.add(name);
    await docker(['run', '--detach', '--pull=never', '--name', name, '--network', network, '--label', `swarmenv.t13.owner=${owner}`, '--cpus', String(cpu), '--memory', memory,
      '--pids-limit', '512', ...Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`]), ...ports.flatMap(value => ['--publish', value]),
      ...volumes.flatMap(value => ['--volume', value]), facilityImages[kind], ...args], signal, `${kind}.start`);
    unknownContainers.delete(name);
    const evidence = JSON.parse(await docker(['inspect', '--format', '{{json .Id}}', name], signal, `${kind}.inspect`));
    signal?.throwIfAborted();
    receipts.push({ kind, name, containerId: evidence, image: facilityImages[kind], cpu, memory });
    return name;
  }
  async function published(name, port, host = '127.0.0.1', signal) {
    const ports = JSON.parse(await docker(['inspect', '--format', '{{json .NetworkSettings.Ports}}', name], signal, 'container.ports'));
    return `http://${host}:${ports[`${port}/tcp`][0].HostPort}`;
  }
  async function close(budget) {
    const ownsBudget = !budget; budget ??= createCleanupBudget(45_000).start();
    setup?.dispose();
    const cleanupDocker = (stage, args) => budget.step(({ timeoutMs, signal }) => invokeDocker(stage, args, { timeout: timeoutMs, signal }), 15_000);
    const results = await Promise.all(names.map(async name => {
      try {
        const found = await cleanupDocker('cleanup.containers.inspect', ['ps', '--all', '--quiet', '--filter', `name=^/${name}$`, '--filter', `label=swarmenv.t13.owner=${owner}`]);
        if (found) { await cleanupDocker('cleanup.container.remove', ['rm', '--force', '--volumes', found]); unknownContainers.delete(name); }
        else if (unknownContainers.has(name)) throw sanitized('FACILITY_CREATE_UNKNOWN');
        return { name, cleanup: 'complete' };
      } catch { return { name, cleanup: 'pending', code: 'FACILITY_CONTAINER_PENDING' }; }
    }));
    let networkCleanup = 'complete';
    if (networkOwned) {
      try {
        const found = await cleanupDocker('cleanup.network.inspect', ['network', 'ls', '--quiet', '--filter', `name=^${network}$`, '--filter', `label=swarmenv.t13.owner=${owner}`]);
        if (found) { await cleanupDocker('cleanup.network.remove', ['network', 'rm', found]); networkCreationUnknown = false; }
        else if (networkCreationUnknown) throw sanitized('FACILITY_CREATE_UNKNOWN');
        networkOwned = false;
      } catch { networkCleanup = 'pending'; }
    }
    let remaining;
    try { remaining = (await cleanupDocker('cleanup.containers.inspect', ['ps', '--all', '--quiet', '--filter', `label=swarmenv.t13.owner=${owner}`])).split('\n').filter(Boolean); }
    catch { remaining = null; }
    const receipt = { cleanup: results.every(row => row.cleanup === 'complete') && networkCleanup === 'complete' && remaining?.length === 0 ? 'complete' : 'pending', results, networkCleanup, remaining };
    if (ownsBudget) budget.dispose();
    return receipt;
  }
  const stack = { close, receipt: () => ({ owner, network, readiness: { ...readiness }, commands: commands.map(row => ({ ...row })), containers: receipts, allocationIntents: names.map(name => ({ name, unknown: unknownContainers.has(name) })), networkCreationUnknown, sharedStorageRetained: true }), secrets,
    async start() {
      if (started) throw sanitized('LOCAL_STACK_ALREADY_STARTED'); started = true;
      setup = createDeadline(setupMs, 'LOCAL_FACILITY_SETUP_EXPIRED');
      // All images must already be cached; no implicit download or install.
      for (const image of giteaOnly ? [facilityImages.gitea] : Object.values(facilityImages)) await docker(['image', 'inspect', '--format', '{{.Id}}', image], undefined, 'image.cached');
      await setupStep(() => mkdir(directory, { recursive: true, mode: 0o700 }));
      const data = {};
      for (const key of giteaOnly ? ['gitea'] : ['mysql', 'gitea', 'mm-data', 'mm-config', 'mm-logs', 'mm-plugins', 'mm-client-plugins']) {
        data[key] = join(directory, key); await setupStep(() => mkdir(data[key], { mode: 0o700 }));
        if (key.startsWith('mm-')) await setupStep(() => chmod(data[key], 0o777)); // parent directory remains private
      }
      setup.remaining(); networkOwned = true; networkCreationUnknown = true; await docker(['network', 'create', '--label', `swarmenv.t13.owner=${owner}`, network], undefined, 'network.create'); networkCreationUnknown = false;
      let database;
      if (!giteaOnly) {
      database = await run('mysql', { cpu: 1, memory: '1g', env: { MYSQL_ROOT_PASSWORD: dbPassword, MYSQL_DATABASE: 'board', MYSQL_USER: 'agensh', MYSQL_PASSWORD: dbPassword },
        volumes: [`${data.mysql}:/var/lib/mysql`], args: ['--innodb-use-native-aio=0', '--innodb-buffer-pool-size=134217728', '--max-connections=100'] });
      const sql = (stage, user, statement, extra = []) => docker(['exec', '--env', `MYSQL_PWD=${dbPassword}`, database, 'mysql',
        '--protocol=TCP', '--host=127.0.0.1', '--port=3306', '--connect-timeout=2', '--batch', '--skip-column-names', `--user=${user}`, ...extra, '-e', statement], undefined, stage);
      // The image's temporary initialization server accepts socket queries
      // before its user/database setup, then shuts down. Only final TCP with
      // authenticated root AND the initialized application account is ready.
      await wait(async () => {
        const root = await sql('mysql.root-ready', 'root', "SELECT IF(@@skip_networking=0 AND @@port=3306 AND SUBSTRING_INDEX(CURRENT_USER(),'@',1)='root' AND EXISTS(SELECT 1 FROM mysql.user WHERE User='agensh' AND Host='%') AND EXISTS(SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='board'),1,0)");
        if (root !== '1') throw sanitized('LOCAL_MYSQL_NOT_READY');
        const application = await sql('mysql.application-ready', 'agensh', "SELECT IF(SUBSTRING_INDEX(CURRENT_USER(),'@',1)='agensh' AND DATABASE()='board',1,0)", ['--database=board']);
        if (application !== '1') throw sanitized('LOCAL_MYSQL_NOT_READY');
      });
      readiness.mysql = { protocol: 'TCP', rootAuthenticated: true, applicationAuthenticated: true, applicationSchema: 'board', skipNetworking: false };
      await sql('mysql.schema-initialize', 'root', "CREATE DATABASE IF NOT EXISTS mattermost CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci; GRANT ALL PRIVILEGES ON mattermost.* TO 'agensh'@'%'; FLUSH PRIVILEGES;");
      // The upstream compose seeds this table; board startup only migrates
      // existing tables and cannot hydrate without it. Keep an attributed,
      // byte-validated fixture independent of linked-worktree submodule state.
      const schema = await setupStep(() => readFile(new URL('./agensh-board-schema.sql', import.meta.url)));
      if (createHash('sha256').update(schema).digest('hex') !== boardSchema.sha256) throw sanitized('LOCAL_BOARD_SCHEMA_INVALID');
      await sql('mysql.board-schema-install', 'agensh', schema.toString('utf8'), ['--database=board']);
      const schemaReady = await sql('mysql.board-schema-ready', 'agensh',
        "SELECT id,board_id,thread_id,type,content,ts_epoch,expires_at,delegation_id,detail FROM board_gists LIMIT 0; SELECT IF(SUBSTRING_INDEX(CURRENT_USER(),'@',1)='agensh' AND DATABASE()='board',1,0)", ['--database=board']);
      if (schemaReady !== '1') throw sanitized('LOCAL_BOARD_SCHEMA_NOT_READY');
      readiness.boardSchema = { ...boardSchema, table: 'board_gists', applicationAuthenticated: true, columnsVerified: true };
      }
      const gitea = await run('gitea', { cpu: 1, memory: '512m', ports: ['0.0.0.0::3000'], volumes: [`${data.gitea}:/data`], env: {
        GITEA__security__INSTALL_LOCK: 'true', GITEA__database__DB_TYPE: 'sqlite3', GITEA__service__DISABLE_REGISTRATION: 'true', GITEA__server__HTTP_PORT: '3000',
        GITEA__server__ROOT_URL: 'http://localhost:3000/', GITEA__actions__ENABLED: 'false', GITEA__log__LEVEL: 'Error' } });
      const gitHost = await published(gitea, 3000); const gitOrigin = await published(gitea, 3000, advertiseHost);
      await wait(() => request(gitHost)('GET', '/api/v1/version'));
      const gitArgs = ['exec', '--user', 'git', '--env', 'GITEA_WORK_DIR=/data/gitea', '--env', 'GITEA_CUSTOM=/data/gitea', gitea, 'gitea', '--config', '/data/gitea/conf/app.ini', 'admin', 'user'];
      await docker([...gitArgs, 'create', '--username', 'run-owner', '--password', adminPassword, '--email', 'owner@swarmenv.invalid', '--admin', '--must-change-password=false'], undefined, 'gitea.admin-create');
      const gitToken = await docker([...gitArgs, 'generate-access-token', '--username', 'run-owner', '--token-name', owner, '--scopes', 'all', '--raw'], undefined, 'gitea.admin-token'); secrets.push(gitToken);
      if (giteaOnly) {
        stack.configuration = { gitea: { origin: gitOrigin, adminToken: gitToken, owner: 'run-owner' } };
        readiness.gitea = { state: 'ready', onlyFacility: true };
        setup.dispose(); setup.remaining();
        return stack.configuration;
      }
      const mattermost = await run('mattermost', { cpu: 1, memory: '2g', ports: ['127.0.0.1::8065'], volumes: Object.entries(data).filter(([key]) => key.startsWith('mm-')).map(([key, path]) => `${path}:/mattermost/${key.slice(3).replace('client-plugins', 'client/plugins')}`), env: {
        MM_SQLSETTINGS_DRIVERNAME: 'mysql', MM_SQLSETTINGS_DATASOURCE: `agensh:${dbPassword}@tcp(${database}:3306)/mattermost?charset=utf8mb4,utf8&readTimeout=10s&writeTimeout=10s`,
        MM_SERVICESETTINGS_SITEURL: 'http://localhost:8065', MM_SERVICESETTINGS_ENABLEUSERACCESSTOKENS: 'true', MM_TEAMSETTINGS_ENABLEOPENSERVER: 'true',
        MM_LOGSETTINGS_CONSOLELEVEL: 'ERROR', MM_LOGSETTINGS_FILELEVEL: 'ERROR', MM_SQLSETTINGS_MAXOPENCONNS: '30', MM_SQLSETTINGS_MAXIDLECONNS: '10' } });
      const mmOrigin = await published(mattermost, 8065);
      await wait(() => request(mmOrigin)('GET', '/api/v4/system/ping'));
      await request(mmOrigin)('POST', '/api/v4/users', { username: 'run-owner', email: 'owner@swarmenv.invalid', password: adminPassword });
      let mmToken;
      try {
        const response = await setupStep(({ signal }) => fetch(mmOrigin + '/api/v4/users/login', { method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login_id: 'run-owner', password: adminPassword }) }));
        mmToken = response.headers.get('Token'); await response.body?.cancel(); if (!response.ok || !mmToken) throw new Error();
      } catch { setup.remaining(); throw sanitized('LOCAL_MATTERMOST_LOGIN_FAILED'); }
      secrets.push(mmToken);
      const team = await request(mmOrigin, `Bearer ${mmToken}`)('POST', '/api/v4/teams', { name: owner, display_name: owner, type: 'I' });
      stack.configuration = { gitea: { origin: gitOrigin, adminToken: gitToken, owner: 'run-owner' }, mattermost: { origin: mmOrigin, adminToken: mmToken, teamId: team.id },
        startBoard: async ({ boardId, workerId, own, signal }) => {
          signal?.throwIfAborted();
          const name = await run('board', { signal, cpu: 0.25, memory: '256m', ports: ['127.0.0.1::8660'], env: {
            MYSQL_DSN: `mysql://agensh:${dbPassword}@${database}:3306/board`, BOARD_MEMBERS_JSON: JSON.stringify({ [boardId]: [workerId] }) } });
          signal?.throwIfAborted();
          const origin = await published(name, 8660, '127.0.0.1', signal);
          stack.boardOrigin = origin;
          own({ kind: 'board-connection', id: boardId, close: async () => {} });
          await wait(async () => {
            signal?.throwIfAborted();
            const state = JSON.parse(await docker(['inspect', '--format', '{{json .State}}', name], signal, 'board.state'));
            if (['exited', 'dead', 'removing'].includes(state.Status)) {
              readiness.board = { state: 'exited', exitClass: Number.isInteger(state.ExitCode) ? state.ExitCode === 0 ? 'zero' : 'nonzero' : 'unknown' };
              throw sanitized('LOCAL_BOARD_EXITED');
            }
            if (!['created', 'running', 'restarting', 'paused'].includes(state.Status)) throw sanitized('LOCAL_BOARD_STATE_INVALID');
            if (!state.Running) throw sanitized('LOCAL_BOARD_NOT_READY');
            await setupStep(({ signal: setupSignal }) => httpClient(origin)('GET', `/board/${encodeURIComponent(boardId)}/read?viewer=${encodeURIComponent(workerId)}`, undefined, { signal: AbortSignal.any([setupSignal, ...(signal ? [signal] : [])]) }));
            readiness.board = { state: 'ready' };
          }, signal);
          signal?.throwIfAborted();
          setup.dispose(); setup.remaining();
          return { origin };
        } };
      return stack.configuration;
    },
  };
  return stack;
}

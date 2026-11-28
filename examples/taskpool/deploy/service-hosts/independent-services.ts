import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RemoteContextService } from './remote-context-service.js';
import { RemoteJudgeService } from './remote-judge-service.js';
import { normalizeJudgeMissionBudget } from '../../services/judge/judge-service.js';

const exec = promisify(execFile);
const contextEntrypoint = fileURLToPath(new URL('./start-context-service-peer.js', import.meta.url));
const judgeEntrypoint = fileURLToPath(new URL('./start-judge-service-peer.js', import.meta.url));

async function stopPeerGroup(pid: any) {
  try { process.kill(-pid, 'SIGKILL'); } catch (error: any) { if (error.code === 'ESRCH') return; throw error; }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { process.kill(-pid, 0); } catch (error: any) { if (error.code === 'ESRCH') return; throw error; }
    const entries = await readdir('/proc');
    const live = await Promise.all(entries.filter((name: any) => /^\d+$/.test(name)).map(async (name: any) => {
      try {
        const stat = await readFile(`/proc/${name}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        return Number(fields[2]) === pid && !['Z', 'X'].includes(fields[0]);
      } catch (error: any) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return false; throw error; }
    }));
    if (!live.some(Boolean)) return;
    await delay(20);
  }
  throw Object.assign(new Error('Service process group cleanup could not be confirmed'), { code: 'SERVICE_CLEANUP_PENDING' });
}

async function startPeer(command: any, args: any, env: any, logPath: any, projectDir: string) {
  const log = createWriteStream(logPath, { flags: 'a', mode: 0o600 });
  const inherited = Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TMPDIR', 'XDG_RUNTIME_DIR']
    .filter((key: any) => process.env[key] !== undefined).map((key: any) => [key, process.env[key]]));
  const child = spawn(command, args, { cwd: projectDir, env: { ...inherited, MURM_COORDINATOR_PID: String(process.pid), ...env },
    detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.pipe(log, { end: false });
  let stopped;
  const stop = () => stopped ??= (async () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      await stopPeerGroup(child.pid);
      log.end(); return;
    }
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const timer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} }, 30_000);
    try { await exited; } finally {
      clearTimeout(timer);
      await stopPeerGroup(child.pid);
      log.end();
    }
  })().catch((error: any) => { stopped = null; throw error; });
  try {
    const endpoint = await new Promise<{ url: string }> ((resolve: any, reject: any) => {
      let output = '';
      const timeout = setTimeout(() => reject(new Error('Independent service startup exceeded its 180 second allowance')), 180_000);
      child.once('error', (error: any) => { clearTimeout(timeout); reject(error); });
      child.once('exit', (code: any) => { clearTimeout(timeout); reject(new Error(`Independent service exited during startup (${code}); inspect its private log`)); });
      child.stdout.on('data', (chunk: any) => {
        output += chunk;
        if (output.length > 16_384) { clearTimeout(timeout); reject(new Error('Invalid independent service startup output')); }
        if (output.includes('\n')) {
          clearTimeout(timeout);
          try { const value = JSON.parse(output.split('\n')[0]); if (!value.url) throw new Error('Missing peer endpoint'); resolve(value); }
          catch (error: any) { reject(error); }
        }
      });
    });
    return { endpoint, stop, pid: child.pid };
  } catch (error: any) { await stop(); throw error; }
}

/** Pinned repository peers, each owning its own store and process. Runtime's
 * Task/Mission/Workspace coordinator never opens a peer database. */
export async function startIndependentServices({ taskService, projectDir, logRoot, fixtureManifest,
  finalTreeConfiguration, problem, missionBudget, maxInfrastructureRetries, checkerTimeoutMs,
  readProjectRevision, leanCommand = 'lake', contextLogger = null, judgeLogger = null }: any) {
  const judgeBudget = normalizeJudgeMissionBudget(missionBudget);
  const judgeTimeoutMs = Math.max((checkerTimeoutMs ?? 120_000) * 4,
    judgeBudget.queueWaitMs + 2 * (checkerTimeoutMs ?? 120_000)) + 30_000;
  if (!Number.isSafeInteger(judgeTimeoutMs) || judgeTimeoutMs < 1 || judgeTimeoutMs > 2_147_483_647) {
    throw new TypeError('Judge HTTP deadline must fit the timer range including queue, checker and transport allowances');
  }
  const token = randomBytes(32).toString('hex');
  const peers: Awaited<ReturnType<typeof startPeer>>[] = [];
  let judge: RemoteJudgeService | undefined;
  const ownerFile = join(projectDir, 'judge-checker-resources.ndjson');
  const cleanupJudge = () => exec('flock', ['--nonblock', '--no-fork', join(projectDir, 'judge.sqlite.instance-lock'),
    process.execPath, judgeEntrypoint, '--cleanup'], { cwd: projectDir, timeout: 35_000,
    env: { PATH: process.env.PATH, MURM_JUDGE_PEER_LOCKED: 'true', MURM_CHECKER_OWNER_FILE: ownerFile } });
  const stopOwned = async () => {
    const results = await Promise.allSettled(peers.map((peer: any) => peer.stop()));
    try { await cleanupJudge(); } catch (error: any) { results.push({ status: 'rejected', reason: error }); }
    const failures = results.filter((result: any) => result.status === 'rejected').map((result: any) => result.reason);
    if (failures.length) throw new AggregateError(failures, 'Independent service cleanup remains incomplete');
  };
  await mkdir(join(logRoot, 'services'), { recursive: true });
  try {
    const contextPeer = await startPeer('flock', ['--nonblock', '--no-fork', join(projectDir, 'context.sqlite.instance-lock'), process.execPath, contextEntrypoint], {
      MURM_SERVICE_DATABASE: join(projectDir, 'context.sqlite'), MURM_COORDINATOR_TOKEN: token,
      MURM_SERVICE_HOST: '127.0.0.1', MURM_SERVICE_PORT: '0', MURM_SERVICE_PUBLIC_URL: '',
    }, join(logRoot, 'services/context-peer.stderr.log'), projectDir);
    peers.push(contextPeer);
    const context = new RemoteContextService({ taskService, token, url: contextPeer.endpoint.url, logger: contextLogger });
    taskService.contextService = context;
    if (context.gate.pending()?.command.service !== 'judge') context.reconcile();
    judge = new RemoteJudgeService({ taskService, token, readProjectRevision, logger: judgeLogger,
      timeoutMs: judgeTimeoutMs });
    const coordinator = await judge.startCoordinator();
    const configPath = join(projectDir, 'judge-peer-config.json');
    await writeFile(configPath, JSON.stringify({ fixtureManifest, finalTreeConfiguration, problem, missionBudget: judgeBudget, maxInfrastructureRetries,
      coordinator: { url: coordinator.url, token }, checker: { command: leanCommand, timeoutMs: checkerTimeoutMs,
        workRoot: join(projectDir, 'judge-work') } }), { mode: 0o600 });
    const judgePeer = await startPeer('flock', ['--nonblock', '--no-fork', join(projectDir, 'judge.sqlite.instance-lock'),
      process.execPath, judgeEntrypoint], {
      MURM_SERVICE_DATABASE: join(projectDir, 'judge.sqlite'), MURM_COORDINATOR_TOKEN: token,
      MURM_JUDGE_PEER_CONFIG: configPath, MURM_CHECKER_OWNER_FILE: ownerFile, MURM_JUDGE_PEER_LOCKED: 'true', MURM_SERVICE_PORT: '0',
    }, join(logRoot, 'services/judge-peer.stderr.log'), projectDir);
    peers.push(judgePeer);
    judge.connect(judgePeer.endpoint.url);
    return { context, judge,
      evidence: { deployment: 'independent', transport: 'http-json', context_pid: contextPeer.pid, judge_pid: judgePeer.pid },
      async close() { try { await judge!.close(); } finally { await stopOwned(); } } };
  } catch (error: any) {
    const failures = [error];
    try { await judge?.close(); } catch (closeError: any) { failures.push(closeError); }
    try { await stopOwned(); } catch (closeError: any) { failures.push(closeError); }
    if (failures.length > 1) throw new AggregateError(failures, 'Independent service startup and cleanup failed');
    throw error;
  }
}

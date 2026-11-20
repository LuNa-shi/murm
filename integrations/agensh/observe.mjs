// Read the operator's independent Git mirror and timestamp checker results. No research-facing writes.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fixture, readTree } from './domain.mjs';
import { createLockedFinalTreeVerifier } from '../../src/judge/final-tree-deployment.js';

const exec = promisify(execFile);
const run = resolve(process.argv[2]);
const launch = JSON.parse(await readFile(join(run, 'launch.json'), 'utf8'));
Object.assign(process.env, launch, { AGENSH_TASK: launch.TASK });
const { config, problem } = await fixture();
const profile = Object.fromEntries((await readFile(join(run, 'upstream', '.env.' + launch.PROFILE), 'utf8'))
  .split('\n').filter(line => /^[A-Z_0-9]+=/.test(line)).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const remote = 'http://localhost:' + Number(profile.EDGE_HTTP_PORT) + '/' + profile.ORG_NAME + '/main.git';
const auth = Buffer.from(profile.GITEA_ADMIN_USER + ':' + profile.GITEA_ADMIN_PASSWORD).toString('base64');
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: 'Authorization: Basic ' + auth };
const mirror = join(run, 'observation.git');
await mkdir(mirror);
await exec('git', ['init', '--bare', '--quiet', mirror]);
const git = async (...args) => (await exec('git', ['--git-dir', mirror, ...args], { env, encoding: 'buffer', timeout: 60000, maxBuffer: 16 * 1024 ** 2 })).stdout;
const journal = join(run, 'observations.ndjson');
const record = event => appendFile(journal, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n', { mode: 0o600 });
const deployment = createLockedFinalTreeVerifier({ configuration: config.final_tree_checker, problem });
await deployment; // Establish a usable checker before announcing observer readiness.
await record({ kind: 'observer_ready' });
const pending = [];
const known = new Set();
let checking;
async function checkPending() {
  const { adapter, evidence } = await deployment;
  while (pending.length) {
    const { commit, tree, path, final } = pending.shift();
    try {
      const files = await readTree(git, tree);
      const result = final ? await adapter.check({ files, tree }) :
        await adapter.checkProject({ files, tree, path, checkMode: 'lean-module', missionId: launch.PROFILE });
      await record({ kind: final ? 'fixed_goal' : 'module', commit, tree, path, lock: evidence.artifact_lock_sha256, result });
    } catch (err) {
      await record({ kind: 'observer_check_error', commit, tree, path, message: err.message });
    }
  }
}

const lastTips = new Map();
let closing = false;
process.on('SIGTERM', () => { closing = true; });
while (!closing) {
  try {
    await git('fetch', '--quiet', '--prune', '--no-tags', remote, '+refs/heads/*:refs/sample/*');
    const tips = (await git('for-each-ref', '--format=%(refname:strip=2) %(objectname)', 'refs/sample')).toString().trim();
    const currentRefs = new Set();
    for (const line of tips ? tips.split('\n') : []) {
      const [ref, tip] = line.split(' ');
      currentRefs.add(ref);
      const previous = lastTips.get(ref);
      if (previous === tip) continue;
      const commits = (await git('rev-list', '--reverse', tip, ...(previous ? ['^' + previous] : []))).toString().trim().split('\n').filter(Boolean);
      await record({ kind: 'ref_observed', ref, tip, previous, commits });
      for (const commit of commits) {
        const tree = (await git('rev-parse', commit + '^{tree}')).toString().trim();
        const changed = (await git('diff-tree', '--first-parent', '-m', '--root', '--no-commit-id', '--name-only', '-rz',
          '--diff-filter=AM', commit)).toString().split('\0').filter(path => path.endsWith('.lean'));
        if (ref === 'main' && !changed.includes(problem.problem_file)) {
          const source = await git('show', commit + ':' + problem.problem_file).catch(() => null);
          if (source && !source.equals(Buffer.from(problem.source))) changed.push(problem.problem_file);
        }
        for (const path of changed) {
          const final = path === problem.problem_file && ref === 'main';
          const key = tree + (final ? '/fixed/' : '/module/') + path;
          if (known.has(key)) continue;
          known.add(key);
          const job = { commit, tree, path, final };
          // A changed main target goes ahead of older local diagnostics.
          if (final) pending.unshift(job);
          else pending.push(job);
        }
      }
      lastTips.set(ref, tip);
    }
    for (const ref of lastTips.keys()) if (!currentRefs.has(ref)) {
      await record({ kind: 'ref_deleted', ref, previous: lastTips.get(ref) });
      lastTips.delete(ref);
    }
    if (pending.length && !checking) checking = checkPending().finally(() => { checking = undefined; });
  } catch {
    // Startup, brief transport loss or services shutting down. Do not log Git credential-bearing commands.
    await record({ kind: 'sample_unavailable' });
  }
  if (await stat(join(launch.OUT_DIR, launch.TASK, 'export.json')).catch(() => null)) break;
  await sleep(15000);
}
await record({ kind: 'sampling_ended', queued: pending.length });
await checking;

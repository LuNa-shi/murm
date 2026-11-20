import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadBenchmarkConfig } from '../../src/benchmark/putnam-runner.js';
import { readBenchmarkContext } from '../../src/benchmark/benchmark-context.js';
import { createLockedFinalTreeVerifier } from '../../src/judge/final-tree-deployment.js';

const exec = promisify(execFile);
const output = process.env.AGENSH_TASK_OUT && resolve(process.env.AGENSH_TASK_OUT);
const mode = process.argv[2];
const bare = output && join(output, 'submission.git');
const save = (name, value) => writeFile(join(output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });

export async function fixture() {
  const config = await loadBenchmarkConfig(process.env.AGENSH_DEPLOYMENT, {
    putnamBenchRoot: process.env.AGENSH_FIXTURE_ROOT, verifyPinnedCheckout: true,
  });
  const problem = config.problems.find(item => item.id === process.env.AGENSH_TASK);
  if (!problem) throw new Error('Requested problem missing from pinned deployment');
  return { config, problem };
}

async function git(...args) {
  return (await exec('git', ['--git-dir', bare, ...args], { encoding: 'buffer', maxBuffer: 16 * 1024 ** 2 })).stdout;
}

async function prepare() {
  const { problem, config } = await fixture();
  const root = join(output, '_seed');
  await mkdir(root);
  const context = await readBenchmarkContext(problem, config);
  for (const [path, bytes] of Object.entries({ ...context, [problem.problem_file]: problem.source })) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), bytes, { flag: 'wx' });
  }
  await save('brief_vars.json', { TARGET_FILE: problem.problem_file });
  await save('seed.json', { task: problem.id, target: problem.problem_file, sha256: problem.source_hash,
    fixture_commit: config.fixture_commit ?? config.putnambench_commit, public_context_files: Object.keys(context) });
  await writeFile(join(output, '.seed_path'), root + '\n', { flag: 'wx' });
}

async function exportMain() {
  const url = new URL(process.env.AGENSH_GITEA_URL);
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (url.username || url.password) {
    const auth = Buffer.from(decodeURIComponent(url.username) + ':' + decodeURIComponent(url.password)).toString('base64');
    Object.assign(env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: 'Authorization: Basic ' + auth });
    url.username = url.password = '';
  }
  await mkdir(bare);
  await git('init', '--bare', '--quiet');
  await exec('git', ['--git-dir', bare, 'fetch', '--quiet', '--no-tags', '--depth=1', url.href,
    'refs/heads/main:refs/heads/main'], { env });
  const commit = (await git('rev-parse', 'refs/heads/main')).toString().trim();
  const tree = (await git('rev-parse', commit + '^{tree}')).toString().trim();
  await save('export.json', { commit, tree });
}

export async function readTree(readGit, tree) {
  const entries = (await readGit('ls-tree', '-lrz', tree)).toString('utf8').split('\0').filter(Boolean);
  if (entries.length > 10000) throw new Error('Submission exceeds the file count limit');
  const files = Object.create(null);
  let total = 0;
  for (const entry of entries) {
    const match = /^(100644|100755) blob ([0-9a-f]{40}) +([0-9]+)\t([^\x00-\x1f\x7f]+)$/u.exec(entry);
    if (!match) throw new Error('Unsupported Git entry in submitted main');
    const [, , oid, size, path] = match;
    total += Number(size);
    if (Number(size) > 2 * 1024 ** 2 || total > 16 * 1024 ** 2) throw new Error('Submission exceeds Workspace byte limits');
    files[path] = await readGit('cat-file', 'blob', oid);
  }
  return files;
}

async function evaluate() {
  const { config, problem } = await fixture();
  const { commit, tree } = JSON.parse(await readFile(join(output, 'export.json'), 'utf8'));
  if (![commit, tree].every(id => /^[0-9a-f]{40}$/.test(id)) ||
      (await git('rev-parse', commit + '^{tree}')).toString().trim() !== tree) throw new Error('Export identity mismatch');
  const files = await readTree(git, tree);
  const { adapter, evidence } = await createLockedFinalTreeVerifier({ configuration: config.final_tree_checker, problem });
  const result = await adapter.check({ files, tree });
  await save('acceptance.json', { commit, tree, task: problem.id, target_sha256: problem.source_hash,
    checker_lock: evidence.artifact_lock_sha256, result });
  if (result.checked_tree !== tree || !['PASS', 'FAIL'].includes(result.verdict)) throw new Error('Final checker did not assess the fixed tree');
  console.log(JSON.stringify({ task: problem.id, commit, tree, verdict: result.verdict, check_result_id: result.check_result_id }));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) switch (mode) {
  case 'prepare': await prepare(); break;
  case 'export': await exportMain(); break;
  case 'evaluate': await evaluate(); break;
  default: throw new Error('Expected prepare, export or evaluate');
}

import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadPutnamB1, putnamB1, putnamSelectionMs, putnamWindowMs } from './case.ts';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const git = (args: string[]) => execute('git', args, { cwd: root, timeout: 10_000 });
const [operation, checkerConfig, datasetRoot, experimentId, image, windowSeconds, selectionSeconds, selectionReasoningEffort, ...extra] = process.argv.slice(2);
if (!['preflight', 'run'].includes(operation) || !checkerConfig || !datasetRoot || extra.length ||
    (operation === 'preflight' && experimentId !== undefined) ||
    (operation === 'run' && (!/^EXP-\d{8}-\d{2}$/.test(experimentId ?? '') || !/^sha256:[a-f0-9]{64}$/.test(image ?? '')))) {
  throw new Error('Usage: main.ts preflight CHECKER_CONFIG PUTNAMBENCH_ROOT | main.ts run CHECKER_CONFIG PUTNAMBENCH_ROOT EXP_ID WORKER_IMAGE_ID [WINDOW_SECONDS [SELECTION_SECONDS [low]]]');
}
const durationMs = putnamWindowMs(windowSeconds);
const selectionMs = putnamSelectionMs(durationMs, selectionSeconds);
if (selectionReasoningEffort !== undefined && selectionReasoningEffort !== 'low') {
  throw new Error('Putnam selection reasoning effort must be low when configured');
}
const problem = await loadPutnamB1(datasetRoot);
let code: string | undefined;
let directory: string | undefined;
if (operation === 'run') {
  const index = await readFile(join(root, 'docs/experiments/INDEX.md'), 'utf8');
  const rows = index.split('\n').filter(line => line.startsWith(`| \`${experimentId}\` |`));
  if (rows.length !== 1) throw new Error('The formal run ID must have one entry in the experiment index');
  const [, , issue, status, pinnedCode] = rows[0].split('|').map(value => value.trim());
  if (!issue.includes('/issues/200)') || !status.startsWith('**REGISTERED') || !pinnedCode.match(/^`[a-f0-9]{7,40}`$/)) {
    throw new Error('Register the Putnam run under #200 and pin its code before launch');
  }
  code = (await git(['rev-parse', `${pinnedCode.slice(1, -1)}^{commit}`])).stdout.trim();
  await git(['merge-base', '--is-ancestor', code, 'HEAD']);
  const { stdout: changed } = await git(['diff', '--name-only', code, 'HEAD']);
  if (changed.split('\n').filter(Boolean).some(path => !path.startsWith('docs/experiments/')) ||
      (await git(['status', '--porcelain'])).stdout) {
    throw new Error('The checkout differs from the registered implementation');
  }
  const { stdout } = await execute('docker', ['image', 'inspect', image, '--format', '{{json .}}'], { timeout: 10_000 });
  const worker = JSON.parse(stdout);
  if (worker.Id !== image || worker.Config?.Labels?.['org.opencontainers.image.revision'] !== code) {
    throw new Error('The worker image must identify the registered implementation commit');
  }
  const parent = join(root, 'experiments', experimentId);
  await mkdir(join(root, 'experiments'), { recursive: true, mode: 0o700 });
  await mkdir(parent, { mode: 0o700 });
  directory = join(parent, 'run');
  await writeFile(join(parent, 'identity.json'), JSON.stringify({
    experimentId, code, image, dataset: problem.putnambench_commit, instance: problem.id,
    provider: problem.provider, model: problem.model, capacity: problem.capacity, durationMs, selectionMs,
    selectionReasoningEffort: selectionReasoningEffort ?? null,
  }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}

await execute(process.execPath, ['scripts/build.ts'], { cwd: root, timeout: 120_000, maxBuffer: 4 * 1024 ** 2 });
const { preparePutnamChecks, checkPutnamSeed } = await import('./lean.ts');
const checks = await preparePutnamChecks(checkerConfig, problem);
const seed = await checkPutnamSeed(problem, checks.verifier);
if (operation === 'preflight') {
  process.stdout.write(JSON.stringify({ instance: problem.id, checker: checks.evidence.identity,
    artifactLock: checks.evidence.artifact_lock_sha256, project: seed.project.verdict, final: seed.final.verdict }) + '\n');
} else {
  const { runPutnamFlat } = await import('./run.ts');
  const { createPiOpenSandboxBackend } = await import('../../dist/src/core/backends/pi-opensandbox.js');
  const { assertShippedModelPair } = await import('../../dist/src/agent/model-catalog.js');
  await assertShippedModelPair({ provider: putnamB1.provider, model: putnamB1.model });
  let base = process.env.PI_KIMI_PROXY_BASE_URL;
  let key = process.env.PI_KIMI_PROXY_API_KEY;
  if (!base && !key) {
    const catalogPath = process.env.SWARMENV_PI_MODELS_FILE ?? join(homedir(), '.pi/agent/models.json');
    const { providers } = JSON.parse(await readFile(catalogPath, 'utf8'));
    const configured = providers?.[problem.provider];
    if (configured?.api === 'openai-responses' && configured.authHeader === true &&
        configured.models?.some((model: { id: string }) => model.id === problem.model)) {
      const value = (entry: unknown) => typeof entry !== 'string' ? undefined :
        entry.startsWith('$') ? process.env[entry.slice(1)] : entry;
      base = value(configured.baseUrl);
      key = value(configured.apiKey);
    }
  }
  if (!base || !key) throw new Error('The configured Kimi proxy endpoint and credential are required');
  if (/[\r\n]/.test(key)) throw new Error('Invalid Kimi proxy credential');
  const upstream = URL.parse(base);
  if (!upstream || !['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password ||
      upstream.search || upstream.hash) throw new Error('Invalid Kimi proxy endpoint');
  upstream.pathname = upstream.pathname.replace(/\/$/, '').replace(/(?:\/v1)?$/, '/v1/responses');
  const host = process.env.SWARMENV_SANDBOX_ADVERTISE_HOST ?? '172.17.0.1';
  const abort = new AbortController();
  const stop = () => abort.abort(new Error('Operator stopped the run'));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const receipt = await runPutnamFlat({ problem, checks, directory: directory!, image: image!, durationMs, selectionMs, selectionReasoningEffort,
      upstream: { url: upstream.href, headers: { authorization: 'Bearer ' + key } }, signal: abort.signal,
      backend: endpoint => createPiOpenSandboxBackend({
        sandbox: {
          lifecycleBaseUrl: process.env.SWARMENV_SANDBOX_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
          endpointHost: process.env.SWARMENV_SANDBOX_ENDPOINT_HOST ?? '127.0.0.1', apiKey: process.env.SWARMENV_SANDBOX_API_KEY,
          timeoutSeconds: 4_080, commandTimeoutMs: 20_000,
        },
        bridge: { host: '0.0.0.0', publicUrl: `http://${host}:{port}` },
        modelGateway: { host: '0.0.0.0', advertiseHost: host, requestTimeoutMs: durationMs, maxOutputTokens: null, selectionReasoningEffort },
        models: { default: { provider: problem.provider, model: problem.model, upstream: endpoint } },
        isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 8192 } },
      }),
    });
    process.stdout.write(JSON.stringify({ experimentId, directory, completion: receipt.completion,
      assessment: receipt.assessment?.verdict ?? null, cleanup: receipt.cleanup?.cleanup ?? null }) + '\n');
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

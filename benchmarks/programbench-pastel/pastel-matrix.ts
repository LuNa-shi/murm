import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { instance, privateDirectory, runDirectory, sha256, task } from './case.ts';

const directory = dirname(fileURLToPath(import.meta.url));
const repository = resolve(directory, '../..');
const upstreamTree = resolve(process.env.PROGRAMBENCH_EVALUATOR_DIR ?? join(privateDirectory, 'upstream'));
const runnerNames = ['case.ts', 'local-integration.ts', 'run-window.ts', 'source-checkpoint.ts', 'pack-submission.py',
  'pastel-open.ts', 'pastel-open-subagents.ts', 'pastel-open-taskpool.ts', 'pastel-open-peermesh.ts',
  'pastel-matrix.ts', 'Dockerfile'];
const modes = ['subagents', 'taskpool', 'peermesh'];
const provider = 'kimi_proxy';
const model = 'k3';
const approvedWindowMs = 1_800_000;
const evaluatorImage = 'programbench/sharkdp_1776_pastel.b60e899';
const evaluatorTag = 'task_cleanroom_v6';
const evaluatorDigest = 'sha256:e75597f4307bf02746598d2b7eb8ae136b9978f0c2551e04b065b14e9e5f9c4e';
const evaluatorRevision = '895f65916bc5ba34a915d36da321fde0301125ad';
const testsRevision = '5954a1957b5e0d770ec2c5523506abd212806315';
const testsRepository = 'programbench/ProgramBench-Tests';
const exec = promisify(execFile);
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const requireThat = (value, code) => { if (!value) throw Object.assign(new Error(code), { code }); };

function evaluatorEnvironment() {
  const keys = ['PATH', 'HOME', 'HF_HOME', 'HF_HUB_CACHE', 'XDG_CACHE_HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT'];
  return { ...Object.fromEntries(keys.filter(key => process.env[key]).map(key => [key, process.env[key]])),
    HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', PROGRAMBENCH_HF_REPO: testsRepository,
    PROGRAMBENCH_HF_REVISION: testsRevision };
}

const archiveInventory = `
import hashlib, json, sys, tarfile
from pathlib import PurePosixPath
files = {}
size = 0
with tarfile.open(sys.argv[1], 'r:gz') as archive:
    for member in archive:
        path = PurePosixPath(member.name)
        if not member.isfile() or path.is_absolute() or '..' in path.parts or member.name in files:
            raise ValueError('invalid source archive member')
        size += member.size
        if size > 8 * 1024 * 1024 or len(files) >= 4096:
            raise ValueError('source archive exceeds limits')
        with archive.extractfile(member) as content:
            files[member.name] = hashlib.file_digest(content, 'sha256').hexdigest()
if 'compile.sh' not in files:
    raise ValueError('source archive is missing compile.sh')
print(json.dumps(files))
`;

const officialScore = `
import json, sys
from pathlib import Path
from programbench.eval.eval import EvaluationResult
from programbench.eval.eval_batch import InstanceEvalSummary
from programbench.utils.load_data import get_active_branches, get_expected_tests, get_ignored_tests, load_all_instances
instance = next(row for row in load_all_instances(include_tests=True) if row['instance_id'] == sys.argv[1])
result = EvaluationResult.model_validate_json(Path(sys.argv[2]).read_text())
result = result.for_branches(get_active_branches(instance)).only_expected(get_expected_tests(instance)).without_ignored(get_ignored_tests(instance))
summary = InstanceEvalSummary.from_eval_result(sys.argv[1], result)
print(json.dumps({'score': summary.score, 'resolved': summary.n_resolved, 'testsScored': summary.n_tests}))
`;

async function evaluateScore(path) {
  const summary = await exec(join(upstreamTree, '.venv/bin/python'), ['-c', officialScore, instance, path],
    { cwd: upstreamTree, env: evaluatorEnvironment(), timeout: 12_000 });
  return JSON.parse(summary.stdout);
}

function configValue(value) {
  return typeof value === 'string' && value.startsWith('$') ? process.env[value.slice(1)] : value;
}

async function providerConfig(catalogPath) {
  const entry = (await json(catalogPath)).providers?.[provider];
  requireThat(entry?.api === 'openai-responses' && entry.authHeader === true &&
    entry.models?.some(row => row.id === model), 'KIMI_CATALOG_MODEL_MISSING');
  const credential = configValue(entry.apiKey);
  const baseUrl = configValue(entry.baseUrl);
  requireThat(typeof credential === 'string' && credential.length > 0 && !/[\r\n]/.test(credential) &&
    typeof baseUrl === 'string', 'KIMI_PROXY_CONFIGURATION_MISSING');
  const url = new URL(baseUrl);
  requireThat(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password &&
    !url.search && !url.hash, 'KIMI_PROXY_ENDPOINT_INVALID');
  url.pathname = url.pathname.replace(/\/$/, '') + '/responses';
  requireThat(url.pathname.endsWith('/v1/responses'), 'KIMI_PROXY_ENDPOINT_INVALID');
  return { url: url.toString(), headers: { authorization: `Bearer ${credential}` } };
}

async function git(cwd, ...args) {
  return (await exec('git', args, { cwd, timeout: 12_000 })).stdout.trim();
}

async function inspectEvaluatorInputs() {
  const [revision, status, image, testBlobs] = await Promise.all([
    git(upstreamTree, 'rev-parse', 'HEAD'), git(upstreamTree, 'status', '--porcelain'),
    exec('docker', ['image', 'inspect', `${evaluatorImage}:${evaluatorTag}`, '--format', '{{json .RepoDigests}}'], { timeout: 10_000 }),
    exec(join(upstreamTree, '.venv/bin/python'), ['-c',
      'from programbench.utils.blob_store import get_blob_dir; import sys; print(get_blob_dir(sys.argv[1]))', instance],
    { cwd: upstreamTree, timeout: 12_000, env: evaluatorEnvironment() }),
  ]);
  requireThat(!status && revision === evaluatorRevision, 'PINNED_EVALUATOR_MISMATCH');
  requireThat(JSON.parse(image.stdout).includes(`${evaluatorImage}@${evaluatorDigest}`), 'PINNED_CLEANROOM_MISMATCH');
  requireThat(testBlobs.stdout.trim().endsWith(`/snapshots/${testsRevision}/${instance}`), 'PINNED_TEST_BLOBS_UNAVAILABLE');
  return { evaluatorRevision, testsRevision, evaluatorDigest };
}

async function hostDistributionDigest() {
  const dist = join(repository, 'dist');
  const roots = ['src', 'examples/subagents', 'test-support/subagents', 'test/fixtures'];
  const trees = await Promise.all(roots.map(root => readdir(join(dist, root), { recursive: true, withFileTypes: true })));
  const files = trees.flat().filter(entry => entry.isFile()).map(entry =>
    relative(dist, join(entry.parentPath, entry.name))).sort();
  const digests = await Promise.all(files.map(async file => [file, sha256(await readFile(join(dist, file)))]));
  return sha256(JSON.stringify(digests));
}

export async function inspectFrozenInputs(worker) {
  requireThat(/^sha256:[a-f0-9]{64}$/.test(worker), 'IMAGE_ID_REQUIRED');
  const [code, treeStatus] = await Promise.all([
    git(repository, 'rev-parse', 'HEAD'), git(repository, 'status', '--porcelain'),
  ]);
  requireThat(!treeStatus, 'PINNED_CHECKOUT_DIRTY');
  // Load distribution modules only after a clean build. dist is ignored by Git.
  await exec(process.execPath, ['scripts/build.ts'], { cwd: repository, timeout: 120_000, maxBuffer: 4 * 1024 ** 2 });
  const [{ assertShippedModelPair }, { resolvePeerMeshImages }] = await Promise.all([
    import('../../dist/src/agent/model-catalog.js'), import('./pastel-open-peermesh.ts'),
  ]);
  const [localWorker, runnerFiles, catalog, evaluatorPins, agenshImages, hostDistributionSha256] = await Promise.all([
    exec('docker', ['image', 'inspect', worker, '--format', '{{json .}}'], { timeout: 10_000 }),
    Promise.all(runnerNames.map(async name => [name, sha256(await readFile(join(directory, name === 'run-window.ts' ? '../shared/run-window.ts' : name)))])),
    assertShippedModelPair({ provider, model }),
    inspectEvaluatorInputs(),
    resolvePeerMeshImages(),
    hostDistributionDigest(),
  ]);
  requireThat(await git(repository, 'rev-parse', 'HEAD') === code &&
    !await git(repository, 'status', '--porcelain'), 'PINNED_CHECKOUT_CHANGED');
  const workerImage = JSON.parse(localWorker.stdout);
  const labels = workerImage.Config?.Labels;
  requireThat(workerImage.Id === worker && labels?.['org.opencontainers.image.revision'] === code &&
    labels['org.murm.benchmark.instance'] === instance &&
    labels['org.murm.benchmark.cleanroom'] === evaluatorDigest, 'PINNED_WORKER_MISMATCH');
  return { code, worker, instance, ...evaluatorPins, provider, model, agenshImages, hostDistributionSha256,
    modelCatalogSha256: catalog.sha256, taskSha256: sha256(task), runnerFiles: Object.fromEntries(runnerFiles) };
}

export async function auditPastelReceipt(receipt, { kind, durationMs, maxRequests, maxConcurrent, maxOutputTokens }) {
  const failures = [];
  const check = (condition, label) => { if (!condition) failures.push(label); };
  const window = receipt.window ?? {};
  const checkpoints = window.checkpoints ?? [];
  const attempts = window.attempts ?? [];
  check(receipt.upstreamKind === kind && receipt.instance === instance, 'MODEL_OR_TASK_MISMATCH');
  check(window.durationMs === durationMs && window.closedElapsedMs === durationMs &&
    window.stopReason === 'deadline' && Number.isFinite(Date.parse(window.startedAt)), 'WINDOW_INCOMPLETE');
  check(!receipt.fault && (!receipt.routingErrors || receipt.routingErrors.length === 0), 'RUNTIME_FAULT');
  check(window.maxRequests === maxRequests && window.maxConcurrent === maxConcurrent &&
    window.maxOutputTokens === maxOutputTokens && attempts.length >= 1 && (maxRequests === null || attempts.length <= maxRequests) &&
    attempts.every((row, index) => row.number === index + 1 && row.elapsedMs >= 0 &&
      row.elapsedMs < durationMs && (maxOutputTokens === null ||
        (row.requestedOutputTokens >= 16 && row.requestedOutputTokens <= maxOutputTokens))),
  'MODEL_ADMISSION_OUT_OF_BOUNDS');
  const agents = (receipt.modelUsage ?? []).flatMap(row => row.agents);
  check(agents.length >= (kind === 'hosted_k3' ? 3 : 2) && agents.every(row => row.pending === 0 &&
    (maxOutputTokens === null || (row.maxObservedOutputTokens ?? 0) <= maxOutputTokens)),
    'MODEL_LEDGER_INCOMPLETE');
  check(receipt.cleanup === 'complete' && Array.isArray(receipt.remainingContainers) && !receipt.remainingContainers.length &&
    (receipt.mode !== 'peermesh' || (receipt.facilityCleanup === 'complete' && receipt.remainingFacilities?.length === 0)), 'CLEANUP_UNCONFIRMED');

  const final = window.latestCheckpoint;
  const timely = final && final.observedElapsedMs >= 0 && final.persistedElapsedMs >= final.observedElapsedMs &&
    final.persistedElapsedMs < (window.closedElapsedMs ?? -1) && checkpoints.some(row =>
      row.sha256 === final.sha256 && row.sourceRevision === final.sourceRevision && row.persistedElapsedMs === final.persistedElapsedMs);
  let files;
  if (receipt.candidate && timely) {
    try {
      const bytes = await readFile(receipt.candidate);
      if (sha256(bytes) === final.sha256) {
        const inventory = await exec('python3', ['-c', archiveInventory, receipt.candidate], {
          timeout: 10_000, maxBuffer: 4 * 1024 ** 2,
        });
        files = JSON.parse(inventory.stdout);
      }
    } catch {
      files = undefined;
    }
  }
  const frozen = Boolean(files);
  check(frozen, 'CANDIDATE_UNVERIFIED');
  const matching = (receipt.evidence ?? []).filter(row => row.candidateSha256 === final?.sha256);
  const meteredAgents = new Set(agents.filter(row => row.metered > 0).map(row => row.agentId));
  const adopted = matching.flatMap(row => meteredAgents.has(row.by) ? row.adopted.filter(item =>
    item.agentId !== row.by && meteredAgents.has(item.agentId) && Object.hasOwn(files ?? {}, item.file) &&
    files[item.file] === item.sha256) : []);
  check(adopted.length > 0, 'CROSS_AGENT_ADOPTION_UNVERIFIED');
  return { failures, frozen, checkpointMs: final?.persistedElapsedMs, forwardedRequests: attempts.length,
    meteredAgents: meteredAgents.size, unknownUsageRequests: agents.reduce((sum, row) => sum + row.unknown, 0),
    verifiedContributors: [...new Set(adopted.map(row => row.agentId))].length };
}

async function evaluate(outputDir) {
  const source = join(outputDir, 'source-only');
  const log = createWriteStream(join(outputDir, 'programbench.log'), { mode: 0o600, flags: 'wx' });
  const processExit = new Promise((resolve, reject) => {
    log.once('error', reject);
    log.once('open', () => {
      const child = spawn(join(upstreamTree, '.venv/bin/programbench'),
        ['eval', source, '--workers', '1', '--branch-workers', '1', '--docker-cpus', '1', '--image-tag', evaluatorTag],
        { cwd: upstreamTree, env: evaluatorEnvironment(),
          stdio: ['ignore', log, log] });
      child.once('error', reject);
      child.once('close', (status, signal) => resolve({ status, signal }));
    });
  });
  let exit;
  try { exit = await processExit; } finally { log.end(); }
  if (exit.status !== 0) return { exit };
  const path = join(source, instance, `${instance}.eval.json`);
  const [result, score] = await Promise.all([json(path), evaluateScore(path)]);
  return { exit, ...summarizeEvaluation(result), officialScore: score };
}

function summarizeEvaluation(result) {
  return { executableSha256: result.executable_hash, errorCode: result.error_code,
    tests: (result.test_results ?? []).reduce((counts, test) => {
      counts[test.status] = (counts[test.status] ?? 0) + 1;
      return counts;
    }, Object.create(null)), branches: (result.test_branches ?? []).length,
    branchErrors: Object.keys(result.test_branch_errors ?? {}).length, warnings: (result.warnings ?? []).length };
}

/** Call only after checking the human decision linked in the experiment registry. */
async function runHostedMatrix({ pins, issue, experiments, catalogPath, registryPath }) {
  requireThat(/^https:\/\/github\.com\/LuNa-shi\/murm\/issues\/[1-9][0-9]*$/.test(issue ?? ''), 'ISSUE_LINK_REQUIRED');
  requireThat(modes.every(mode => /^EXP-[0-9]{8}-[0-9]{2}$/.test(experiments?.[mode] ?? '')) &&
    new Set(modes.map(mode => experiments[mode])).size === modes.length, 'THREE_EXPERIMENT_IDS_REQUIRED');
  const registry = await readFile(registryPath, 'utf8');
  for (const mode of modes) {
    const rows = registry.split('\n').filter(row => row.startsWith(`| \`${experiments[mode]}\` |`));
    requireThat(rows.length === 1 && rows[0].split('|')[2]?.includes(issue) &&
      /\bREGISTERED\b/.test(rows[0].split('|')[3] ?? '') &&
      rows[0].split('|')[4]?.includes(pins.code.slice(0, 7)), 'EXPERIMENT_REGISTRATION_REQUIRED');
  }
  const upstream = await providerConfig(catalogPath);
  const { runPastel } = await import('./pastel-open.ts');
  const matrixDir = await runDirectory('k3-matrix');
  const lockDir = join(privateDirectory, 'hosted-run-starts');
  await mkdir(lockDir, { recursive: true, mode: 0o700 });
  const policy = { kind: 'hosted_k3' as const, durationMs: approvedWindowMs, maxRequests: null, maxConcurrent: 3, maxOutputTokens: null };
  const rows = [];
  let writes = Promise.resolve();
  const persist = () => {
    writes = writes.then(async () => {
      const path = join(matrixDir, 'receipt.json');
      await writeFile(path + '.tmp', JSON.stringify({ issue, pins, policy, rows }, null, 2) + '\n', { mode: 0o600 });
      await rename(path + '.tmp', path);
    });
    return writes;
  };
  await persist();
  // Claim every ID before any model call. A partial launch never replays an ID.
  for (const mode of modes) {
    const experiment = experiments[mode];
    await writeFile(join(lockDir, experiment), `${matrixDir}\n`, { flag: 'wx', mode: 0o600 });
    rows.push({ mode, experiment, status: 'registered' });
  }
  await persist();
  await Promise.all(rows.map(async row => {
    const { mode, experiment } = row;
    Object.assign(row, { status: 'launching', submittedAt: new Date().toISOString() });
    console.log(JSON.stringify({ mode, experiment, stage: row.status, matrixDir }));
    try {
      const { outputDir, receipt } = await runPastel({ ...policy, mode, image: pins.worker, upstream, upstreamKind: policy.kind, agenshImages: pins.agenshImages,
        async onStart({ startedAt, runtimeId }) {
          Object.assign(row, { status: 'running', startedAt, runtimeId });
          console.log(JSON.stringify({ mode, experiment, stage: row.status, startedAt, runtimeId, matrixDir }));
          await persist();
        },
      });
      Object.assign(row, { status: 'runtime_closed', runtimeReceipt: join(outputDir, 'receipt.json'),
        audit: await auditPastelReceipt(receipt, policy) });
      await persist();
      if (row.audit.frozen) {
        try { row.evaluation = await evaluate(outputDir); }
        catch { row.evaluation = { errorCode: 'EVALUATOR_RECEIPT_UNAVAILABLE' }; }
      }
      row.status = 'settled';
    } catch (error) {
      Object.assign(row, { status: 'failed', errorCode: error.code ?? 'MATRIX_RUN_FAILED' });
    }
    await persist();
    console.log(JSON.stringify({ mode, experiment, stage: row.status, matrixDir }));
  }));
  const accepted = rows.every(row => row.status === 'settled' && row.audit?.failures.length === 0);
  return { matrixDir, accepted };
}

async function evaluateRecordedCandidate(receiptPath) {
  const receipt = await json(receiptPath);
  const { durationMs, maxRequests, maxConcurrent, maxOutputTokens } = receipt.window;
  const audit = await auditPastelReceipt(receipt, { kind: receipt.upstreamKind, durationMs, maxRequests,
    maxConcurrent, maxOutputTokens });
  requireThat(audit.frozen, 'CANDIDATE_UNVERIFIED');
  await inspectEvaluatorInputs();
  const outputDir = await runDirectory('evaluate');
  const submission = join(outputDir, 'source-only', instance);
  await mkdir(submission, { recursive: true, mode: 0o700 });
  const archive = join(submission, 'submission.tar.gz');
  await copyFile(receipt.candidate, archive);
  requireThat(sha256(await readFile(archive)) === receipt.window.latestCheckpoint.sha256, 'CANDIDATE_CHANGED');
  const result = await evaluate(outputDir);
  const report = { audit, result };
  await writeFile(join(outputDir, 'receipt.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  requireThat(result.exit.status === 0, 'EVALUATOR_FAILED');
  return { ...report, outputDir };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, argument, extra] = process.argv.slice(2);
  try {
    if (!argument || extra) throw Object.assign(new Error('Invalid argument count'), { code: 'USAGE' });
    if (command === 'pins') console.log(JSON.stringify(await inspectFrozenInputs(argument), null, 2));
    else if (command === 'evaluate') console.log(JSON.stringify(await evaluateRecordedCandidate(resolve(argument)), null, 2));
    else if (command === 'hosted') {
      const manifest = await json(resolve(argument));
      const pins = await inspectFrozenInputs(manifest.pins?.worker);
      requireThat(isDeepStrictEqual(manifest.pins, pins), 'MATRIX_PINS_CHANGED');
      const result = await runHostedMatrix({ ...manifest, pins });
      console.log(JSON.stringify(result));
      if (!result.accepted) process.exitCode = 1;
    } else throw Object.assign(new Error('Invalid command'), { code: 'USAGE' });
  } catch (error) {
    if (error.code === 'USAGE') {
      process.stderr.write('Usage: node pastel-matrix.ts pins <worker-image-id> | evaluate <receipt.json> | hosted <registered-manifest.json>\n');
    } else {
      process.stderr.write(`${error.code ?? 'PASTEL_MATRIX_FAILED'}\n`);
    }
    process.exitCode = 1;
  }
}

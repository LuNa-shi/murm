import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { beginPrivateAudit } from '../src/observability/private-audit-retention.js';
import { loadBenchmarkConfig, runBenchmarkBatch } from '../src/benchmark/putnam-runner.js';
import { selectOpenAiMathContext } from '../src/benchmark/benchmark-context.js';
import { readBenchmarkFixture } from '../src/benchmark/benchmark-fixture.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(repositoryRoot, 'config/openai-math-12.json');
const artifactLockPath = resolve(process.env.OPENAI_MATH_ARTIFACT_LOCK ?? '/tmp/openai-math-coloring-run/artifact-lock.json');
const experimentDir = resolve(process.env.OPENAI_MATH_EXPERIMENT_DIR ?? join(repositoryRoot, 'experiments', `openai-math-round-${Date.now()}`));
const reportDir = join(experimentDir, 'reports');
const timeboxMs = Number(process.env.OPENAI_MATH_TIMEBOX_MS ?? 2 * 60 * 60_000);
const botMaxMs = Number(process.env.OPENAI_MATH_BOT_MAX_MS ?? timeboxMs);
const checkerTimeoutOverride = process.env.OPENAI_MATH_CHECKER_TIMEOUT_MS !== undefined;
const checkerTimeoutMs = Number(process.env.OPENAI_MATH_CHECKER_TIMEOUT_MS ?? 120_000);
const checkerHttpTimeoutMs = Math.max(4 * checkerTimeoutMs, 120_000 + 2 * checkerTimeoutMs) + 30_000;
const projectParallelism = Number(process.env.OPENAI_MATH_PROJECT_PARALLELISM ?? 1);
const provider = process.env.PI_PROVIDER ?? 'gpt_proxy';
const model = process.env.PI_MODEL ?? 'gpt-6.2-sol';
const sandboxImage = process.env.SWARMENV_SANDBOX_IMAGE ?? 'swarmenv-agent:openai-math-gpt62-b4a02f5';
const sandboxUrl = process.env.SWARMENV_OPENSANDBOX_URL ?? 'http://127.0.0.1:8080';
const bridgeHost = process.env.SWARMENV_BRIDGE_HOST ?? '0.0.0.0';
const bridgeUrl = process.env.SWARMENV_BRIDGE_PUBLIC_URL ?? 'http://172.17.0.1:{port}';
const stopController = new AbortController();
let stopRequested = false;
let stopSignal = null;
const requestStop = signal => {
  if (stopRequested) return;
  stopRequested = true;
  stopSignal = signal;
  stopController.abort(signal);
};
const onSigint = () => requestStop('SIGINT');
const onSigterm = () => requestStop('SIGTERM');
process.on('SIGINT', onSigint);
process.on('SIGTERM', onSigterm);

if (!Number.isSafeInteger(timeboxMs) || timeboxMs < 2_000) throw new TypeError('OPENAI_MATH_TIMEBOX_MS must be at least 2000');
if (!Number.isSafeInteger(botMaxMs) || botMaxMs < 2_000) throw new TypeError('OPENAI_MATH_BOT_MAX_MS must be at least 2000');
if (!Number.isSafeInteger(checkerTimeoutMs) || checkerTimeoutMs < 1 || !Number.isSafeInteger(checkerHttpTimeoutMs) || checkerHttpTimeoutMs + 30_000 > 2_147_483_647) {
  throw new TypeError('OPENAI_MATH_CHECKER_TIMEOUT_MS must be positive and fit checker plus transport timer bounds');
}
if (!Number.isSafeInteger(projectParallelism) || projectParallelism < 1 || projectParallelism > 2) {
  throw new TypeError('OPENAI_MATH_PROJECT_PARALLELISM must be 1 or 2');
}

const sourceConfig = await loadBenchmarkConfig(configPath, {
  putnamBenchRoot: repositoryRoot,
  verifyPinnedCheckout: true,
});
const requestedIds = (process.env.OPENAI_MATH_PROBLEM_IDS ?? sourceConfig.problems.slice(0, 2).map(problem => problem.id).join(','))
  .split(',').map(value => value.trim()).filter(Boolean);
if (requestedIds.length < 1 || requestedIds.length > 2 || new Set(requestedIds).size !== requestedIds.length) {
  throw new TypeError('OPENAI_MATH_PROBLEM_IDS must contain one or two distinct problem IDs');
}
if (projectParallelism > requestedIds.length) throw new TypeError('OPENAI_MATH_PROJECT_PARALLELISM cannot exceed the problem count');
const selected = requestedIds.map(id => sourceConfig.problems.find(problem => problem.id === id));
if (selected.some(problem => !problem)) throw new TypeError(`Unknown OpenAI Math problem ID in ${requestedIds.join(',')}`);
const paperMode = process.env.OPENAI_MATH_PAPER_MODE ?? 'none';
const { config, problems } = await selectOpenAiMathContext(sourceConfig, selected, paperMode);
const paperInputs = Object.fromEntries(problems.map(problem => [problem.id, {
  mode: paperMode, manifest: problem.context_manifest ?? null, sha256: problem.context_sha256 ?? null,
}]));
for (const problem of problems) {
  const verified = await readBenchmarkFixture({ root: repositoryRoot, path: problem.problem_file, commit: config.fixture_commit });
  if (verified.sourceHash !== problem.source_hash) throw new TypeError(`embedded source digest mismatch for ${problem.id}`);
}

const lock = JSON.parse(await readFile(artifactLockPath, 'utf8'));
const finalTreeCheckerConfig = { ...lock.configuration, artifactLock: artifactLockPath };
if (finalTreeCheckerConfig.timeoutMs !== checkerTimeoutMs) {
  throw new TypeError('Locked final checker timeout must equal OPENAI_MATH_CHECKER_TIMEOUT_MS; renew the artifact lock for this policy');
}
const checkerPolicy = { source_timeout_ms: checkerTimeoutMs, final_timeout_ms: finalTreeCheckerConfig.timeoutMs,
  merge_timeout_ms: checkerTimeoutMs, cli_http_timeout_ms: checkerTimeoutOverride ? checkerHttpTimeoutMs : 30_000,
  ready_timeout_ms: Math.min(120_000, botMaxMs),
  turn_timeout_ms: Math.min(checkerTimeoutOverride ? Math.max(120_000, checkerHttpTimeoutMs + 30_000) : 120_000, botMaxMs), queue_wait_ms: 120_000 };
const modelCatalog = JSON.parse(await readFile(process.env.PI_MODELS_PATH ?? '/home/ubuntu/.pi/agent/models.json', 'utf8'));
const providerSettings = modelCatalog.providers?.[provider];
if (!providerSettings?.baseUrl || !providerSettings?.apiKey) throw new Error(`Missing model settings for ${provider}`);
const modelUpstream = {
  url: `${providerSettings.baseUrl.replace(/\/$/, '')}/responses`,
  headers: { authorization: `Bearer ${providerSettings.apiKey}`, ...(providerSettings.headers ?? {}) },
};

const privateAudit = await beginPrivateAudit({ root: repositoryRoot, directory: experimentDir });
try {
  await writeFile(join(experimentDir, 'launch-inputs.json'), JSON.stringify({
    repository_root: repositoryRoot,
    repository_commit: process.env.GIT_COMMIT ?? null,
    stop_signal: stopSignal,
    config_path: configPath,
    paper_inputs: paperInputs,
    fixture_commit: config.fixture_commit,
    problem_ids: requestedIds,
    checker_lock: artifactLockPath,
    checker_policy: checkerPolicy,
    provider,
    model,
    core_count_per_project: 4,
    project_parallelism: projectParallelism,
    timebox_ms: timeboxMs,
    bot_max_ms: botMaxMs,
    sandbox_image: sandboxImage,
    sandbox_url: sandboxUrl,
    bridge_url: bridgeUrl,
  }, null, 2) + '\n', { mode: 0o600 });
  const reports = await runBenchmarkBatch(problems, config, {
    experimentDir,
    reportDir,
    timeboxMs,
    botMaxMs,
    projectParallelism,
    initialBotStaggerMs: 0,
    selectionTimeoutMs: Math.min(120_000, botMaxMs),
    executionTimeoutMs: botMaxMs,
    readyTimeoutMs: checkerPolicy.ready_timeout_ms,
    turnTimeoutMs: checkerPolicy.turn_timeout_ms,
    checkerTimeoutMs,
    cores: 4,
    signal: stopController.signal,
    provider,
    model,
    command: 'pi',
    modelUpstream,
    coordinationPermissions: ['mission_submit'],
    finalTreeCheckerConfig,
    privateAudit,
    sandbox: {
      enabled: true,
      provider: 'opensandbox',
      lifecycleBaseUrl: sandboxUrl,
      image: sandboxImage,
      bridgeHost,
      bridgeUrl,
      networkIsolation: { mode: 'local-docker', additionalEndpoints: [] },
      diskIsolation: { mode: 'local-docker-tmpfs-landlock', bytes: 256 * 1024 ** 2, inodes: 16_384 },
      agentEnvironment: checkerTimeoutOverride ? { SWARMENV_CLI_CHECK_REQUEST_TIMEOUT_MS: String(checkerHttpTimeoutMs) } : {},
      secretEnvironment: {},
    },
  });
  for (const report of reports) {
    const problemId = report.project?.problem_id;
    if (!problemId) continue;
    report.run = { ...report.run, paper_input: paperInputs[problemId], stop_signal: stopSignal, checker_policy: checkerPolicy };
    await writeFile(join(reportDir, problemId, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  }
  const summary = {
    paper_inputs: paperInputs,
    checker_policy: checkerPolicy,
    repository_commit: process.env.GIT_COMMIT ?? null,
    stop_signal: stopSignal,
    problem_ids: requestedIds,
    project_parallelism: projectParallelism,
    timebox_ms: timeboxMs,
    bot_max_ms: botMaxMs,
    reports: reports.map(report => ({
      problem_id: report.project?.problem_id ?? null,
      solved: report.run?.solved ?? false,
      protocol_valid: report.run?.protocol_valid ?? false,
      made_progress: report.run?.made_progress ?? false,
      elapsed_ms: report.run?.elapsed_ms ?? null,
      stop_reason: report.run?.stop_reason ?? null,
      core_count: report.cores?.length ?? 0,
      core_states: report.cores?.map(core => ({
        core: core.core,
        turns: core.turns,
        task_id: core.task_id,
        checks: core.checks?.length ?? 0,
        workspace_writes: core.workspace_writes?.length ?? 0,
      })) ?? [],
      checker_requests: report.run?.check_count ?? 0,
      material_count: report.run?.material_count ?? 0,
      invalid_reasons: report.audit?.invalid_reasons ?? [],
    })),
  };
  await writeFile(join(experimentDir, 'round-summary.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(JSON.stringify({ experiment_dir: experimentDir, report_dir: reportDir, summary }, null, 2) + '\n');
} finally {
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);
  if (stopSignal) process.exitCode = stopSignal === 'SIGINT' ? 130 : 143;
  await privateAudit.close();
}

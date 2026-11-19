import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { beginPrivateAudit } from '../src/observability/private-audit-retention.js';
import { loadBenchmarkConfig, readBenchmarkFixture, runBenchmarkBatch } from '../src/benchmark/putnam-runner.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(repositoryRoot, 'config/openai-math-12.json');
const artifactLockPath = resolve(process.env.OPENAI_MATH_ARTIFACT_LOCK ?? '/tmp/openai-math-coloring-run/artifact-lock.json');
const experimentDir = resolve(process.env.OPENAI_MATH_EXPERIMENT_DIR ?? join(repositoryRoot, 'experiments', `openai-math-round-${Date.now()}`));
const reportDir = join(experimentDir, 'reports');
const timeboxMs = Number(process.env.OPENAI_MATH_TIMEBOX_MS ?? 2 * 60 * 60_000);
const botMaxMs = Number(process.env.OPENAI_MATH_BOT_MAX_MS ?? timeboxMs);
const projectParallelism = Number(process.env.OPENAI_MATH_PROJECT_PARALLELISM ?? 2);
const provider = process.env.PI_PROVIDER ?? 'gpt_proxy';
const model = process.env.PI_MODEL ?? 'gpt-6.1-sol';
const sandboxImage = process.env.SWARMENV_SANDBOX_IMAGE ?? 'swarmenv-agent:issue137-ccdd5c7';
const sandboxUrl = process.env.SWARMENV_OPENSANDBOX_URL ?? 'http://127.0.0.1:8080';
const bridgeHost = process.env.SWARMENV_BRIDGE_HOST ?? '0.0.0.0';
const bridgeUrl = process.env.SWARMENV_BRIDGE_PUBLIC_URL ?? 'http://172.17.0.1:{port}';

if (!Number.isSafeInteger(timeboxMs) || timeboxMs < 2_000) throw new TypeError('OPENAI_MATH_TIMEBOX_MS must be at least 2000');
if (!Number.isSafeInteger(botMaxMs) || botMaxMs < 2_000) throw new TypeError('OPENAI_MATH_BOT_MAX_MS must be at least 2000');
if (projectParallelism !== 2) throw new TypeError('OPENAI_MATH_PROJECT_PARALLELISM must be 2 for a two-problem round');

const config = await loadBenchmarkConfig(configPath, {
  putnamBenchRoot: repositoryRoot,
  verifyPinnedCheckout: true,
});
const requestedIds = (process.env.OPENAI_MATH_PROBLEM_IDS ?? config.problems.slice(0, 2).map(problem => problem.id).join(','))
  .split(',').map(value => value.trim()).filter(Boolean);
if (requestedIds.length !== 2 || new Set(requestedIds).size !== 2) throw new TypeError('OPENAI_MATH_PROBLEM_IDS must contain exactly two distinct problem IDs');
const problems = requestedIds.map(id => config.problems.find(problem => problem.id === id));
if (problems.some(problem => !problem)) throw new TypeError(`Unknown OpenAI Math problem ID in ${requestedIds.join(',')}`);
for (const problem of problems) {
  const verified = await readBenchmarkFixture({ root: repositoryRoot, path: problem.problem_file, commit: config.fixture_commit });
  if (verified.sourceHash !== problem.source_hash) throw new TypeError(`embedded source digest mismatch for ${problem.id}`);
}

const lock = JSON.parse(await readFile(artifactLockPath, 'utf8'));
const finalTreeCheckerConfig = { ...lock.configuration, artifactLock: artifactLockPath };
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
    config_path: configPath,
    fixture_commit: config.fixture_commit,
    problem_ids: requestedIds,
    checker_lock: artifactLockPath,
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
    turnTimeoutMs: Math.min(120_000, botMaxMs),
    checkerTimeoutMs: 120_000,
    cores: 4,
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
      agentEnvironment: {},
      secretEnvironment: {},
    },
  });
  const summary = {
    repository_commit: process.env.GIT_COMMIT ?? null,
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
  await privateAudit.close();
}

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { beginPrivateAudit } from '../src/observability/private-audit-retention.js';
import { loadBenchmarkConfig } from '../src/benchmark/putnam-runner.js';
import { readBenchmarkFixture } from '../src/benchmark/benchmark-fixture.js';
import { runBenchmarkProject } from '../src/benchmark/putnam-runner.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(repositoryRoot, 'config/openai-math-12.json');
const artifactLockPath = resolve(process.env.OPENAI_MATH_ARTIFACT_LOCK ?? '/tmp/openai-math-coloring-run/artifact-lock.json');
const experimentDir = resolve(process.env.OPENAI_MATH_EXPERIMENT_DIR ?? join(repositoryRoot, 'experiments', `openai-math-coloring-4core-${Date.now()}`));
const reportDir = join(experimentDir, 'reports');
// Initialization includes independent service and checker deployment. Keep the
// default long enough that the four Core lanes receive a real work window after
// that setup rather than being closed at the first deadline boundary.
const timeboxMs = Number(process.env.OPENAI_MATH_TIMEBOX_MS ?? 600_000);
const botMaxMs = Number(process.env.OPENAI_MATH_BOT_MAX_MS ?? timeboxMs);
const provider = process.env.PI_PROVIDER ?? 'gpt_proxy';
const model = process.env.PI_MODEL ?? 'gpt-6.2-sol';
const sandboxImage = process.env.SWARMENV_SANDBOX_IMAGE ?? 'swarmenv-agent:issue137-ccdd5c7';
const sandboxUrl = process.env.SWARMENV_OPENSANDBOX_URL ?? 'http://127.0.0.1:8080';
const bridgeHost = process.env.SWARMENV_BRIDGE_HOST ?? '0.0.0.0';
const bridgeUrl = process.env.SWARMENV_BRIDGE_PUBLIC_URL ?? 'http://172.17.0.1:{port}';

if (!Number.isSafeInteger(timeboxMs) || timeboxMs < 2_000) throw new TypeError('OPENAI_MATH_TIMEBOX_MS must be at least 2000');
if (!Number.isSafeInteger(botMaxMs) || botMaxMs < 2_000) throw new TypeError('OPENAI_MATH_BOT_MAX_MS must be at least 2000');

const config = await loadBenchmarkConfig(configPath, {
  putnamBenchRoot: repositoryRoot,
  verifyPinnedCheckout: true,
});
const smoke = config.smoke_problem;
const verified = await readBenchmarkFixture({ root: repositoryRoot, path: smoke.problem_file, commit: config.fixture_commit });
if (verified.sourceHash !== smoke.source_sha256) throw new TypeError('embedded Coloring source digest mismatch');
const problem = {
  ...smoke,
  source: verified.source,
  source_hash: verified.sourceHash,
  source_path: verified.sourcePath,
  fixture_verified: true,
};

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
    problem_id: problem.id,
    problem_file: problem.problem_file,
    problem_sha256: problem.source_hash,
    checker_lock: artifactLockPath,
    provider,
    model,
    core_count: 4,
    timebox_ms: timeboxMs,
    bot_max_ms: botMaxMs,
    sandbox_image: sandboxImage,
    sandbox_url: sandboxUrl,
    bridge_url: bridgeUrl,
  }, null, 2) + '\n', { mode: 0o600 });
  const report = await runBenchmarkProject(problem, config, {
    experimentDir,
    reportDir,
    timeboxMs,
    botMaxMs,
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
  await writeFile(join(experimentDir, 'result-summary.json'), JSON.stringify({
    solved: report.run.solved,
    protocol_valid: report.run.protocol_valid,
    stop_reason: report.run.stop_reason ?? null,
    core_count: report.cores.length,
    core_states: report.cores.map(core => ({ core: core.core, state: core.state, turns: core.turns, checks: core.checks.length })),
    invalid_reasons: report.audit.invalid_reasons,
    report_dir: reportDir,
  }, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(JSON.stringify({ experiment_dir: experimentDir, report_dir: reportDir, solved: report.run.solved, protocol_valid: report.run.protocol_valid, invalid_reasons: report.audit.invalid_reasons }, null, 2) + '\n');
} finally {
  await privateAudit.close();
}

import { mkdir, copyFile, readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRunWindow } from './run-window.mjs';
import { instance, runDirectory, sha256, task } from './case.mjs';
import { localBackend, saveReceipt } from './local-integration.mjs';
import { ownedContainers } from '../../dist/test/fixtures/core-runtime-containers.js';
import { runOpenSubagents } from './pastel-open-subagents.mjs';
import { runOpenFlat } from './pastel-open-flat.mjs';
import { runOpenAgensh } from './pastel-open-agensh.mjs';

const drivers = { subagents: runOpenSubagents, flat: runOpenFlat, agensh: runOpenAgensh };

async function modelUsage(directory, runtimeId) {
  if (!runtimeId) return [];
  const report = JSON.parse(await readFile(join(directory, runtimeId, 'runtime.json'), 'utf8'));
  return report.modelLedgers.map(({ alias, path }) => {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return { alias, bots: db.prepare(`SELECT bot_id AS botId, COUNT(*) AS attempts,
        COUNT(output_tokens) AS metered, COUNT(*) FILTER (WHERE state='unknown') AS unknown,
        COUNT(*) FILTER (WHERE state='pending') AS pending, SUM(input_tokens) AS inputTokens,
        SUM(output_tokens) AS outputTokens, MAX(output_tokens) AS maxObservedOutputTokens
        FROM runtime_model_attempts WHERE runtime_id=? GROUP BY bot_id`).all(runtimeId) };
    } finally {
      db.close();
    }
  });
}

/** Private orchestration. Its caller owns upstream selection and formal authorization. */
export async function runPastel({ mode, image, upstream, durationMs = 1_800_000,
  maxRequests = 240, maxConcurrent = 3, maxOutputTokens = 4096, upstreamKind, agenshImages, onStart }) {
  if (!Object.hasOwn(drivers, mode) || !/^sha256:[a-f0-9]{64}$/.test(image ?? '') ||
      !['scripted_loopback', 'hosted_k3'].includes(upstreamKind)) throw new Error('Invalid Pastel run input');
  const target = new URL(upstream.url);
  if (upstreamKind === 'scripted_loopback' && (target.protocol !== 'http:' || target.hostname !== '127.0.0.1')) {
    throw new Error('Scripted responses must use host loopback');
  }
  const outputDir = await runDirectory(`open-${mode}`);
  const setupStartedAt = performance.now();
  const window = await createRunWindow({ directory: join(outputDir, 'frozen'), upstreamUrl: upstream.url,
    upstreamHeaders: upstream.headers, durationMs, maxRequests, maxConcurrent, maxOutputTokens });
  const deadline = once(window.signal, 'abort').then(() => window.signal.reason.code);
  let setupElapsedMs;
  const state = { evidence: [] };
  let startObservation;
  const start = () => {
    const startedAt = window.start();
    setupElapsedMs = performance.now() - setupStartedAt;
    startObservation = Promise.resolve(onStart?.({ startedAt, runtimeId: state.runtimeId })).catch(() => {
      state.startObservationFailed = true;
    });
    return startedAt;
  };
  let fault;
  try {
    const backend = localBackend(window.upstream, 128, { timeoutSeconds: Math.ceil(durationMs / 1000) + 180,
      maxOutputTokens, requestTimeoutMs: durationMs, ...(upstreamKind === 'hosted_k3' ? { resourceLimits: null } : {}) });
    await drivers[mode]({ state, task, window, start, deadline, image, backend, outputDir, durationMs,
      capacity: Math.min(3, maxConcurrent), agenshImages });
  } catch (error) {
    const expectedDeadline = window.signal.reason?.code === 'deadline' &&
      ['deadline', 'ROUTER_WAIT_ABORTED', 'ROUTER_WAIT_TIMEOUT'].includes(error.code);
    if (!expectedDeadline) fault = { code: error.code ?? 'PASTEL_RUN_FAILED', stage: state.stage };
  } finally {
    await window.close();
    await startObservation;
  }
  const afterWindow = window.receipt();
  let candidate;
  if (afterWindow.latestCheckpoint) {
    const submission = join(outputDir, 'source-only', instance);
    await mkdir(submission, { recursive: true, mode: 0o700 });
    candidate = join(submission, 'submission.tar.gz');
    await copyFile(afterWindow.latestCheckpoint.path, candidate);
    if (sha256(await readFile(candidate)) !== afterWindow.latestCheckpoint.sha256) throw new Error('Final archive digest mismatch');
  }
  const [usage, containerCheck] = await Promise.allSettled([
    modelUsage(outputDir, state.runtimeId),
    state.runtimeId ? ownedContainers(state.runtimeId) : Promise.resolve(null),
  ]);
  const receipt = { mode, instance, image, upstreamKind, setupElapsedMs, ...state, fault, candidate,
    window: afterWindow, modelUsage: usage.status === 'fulfilled' ? usage.value : null,
    remainingContainers: containerCheck.status === 'fulfilled' ? containerCheck.value : null };
  await saveReceipt(outputDir, receipt);
  return { outputDir, receipt };
}

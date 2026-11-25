import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ContextService } from '../../dist/src/context/context-service.js';
import { runFlatEnvironment } from '../../dist/src/environments/flat/environment.js';
import { createMissionCoordination } from '../../dist/src/environments/flat/mission-coordination.js';
import { JudgeService } from '../../dist/src/judge/judge-service.js';
import { makeEnvelope } from '../../dist/src/protocol/envelope.js';
import { MissionWorkspace } from '../../dist/src/runtime/mission-workspace.js';
import { WorkspaceManager } from '../../dist/src/runtime/workspace-manager.js';
import { TaskService } from '../../dist/src/task/task-service.js';
import { createRunWindow } from '../shared/run-window.ts';
import { putnamSelectionMs, type loadPutnamB1 } from './case.ts';
import type { preparePutnamChecks } from './lean.ts';

const missionId = 'mission:putnam_2025_b1';
const workspaceId = 'putnam-2025-b1';
const setupAllowanceMs = 180_000;
const closeTimeoutMs = 60_000;

const prompt = `Work with other Bot researchers on the shared PutnamBench 2025 B1 theorem.
Read the exact benchmark statement with swarm workspace read lean4/src/putnam_2025_b1.lean --at 0.1. The JSON includes the Lean source in content. Read the current acceptance and submission status with swarm mission submission view.
During discovery, take suitable ready work or propose a bounded first deliverable as soon as you identify a useful gap. Propose a checkable investigation even when the proof route is still uncertain. Do the detailed proof search and editing after take. Use the command help for Task creation, Workspace save, apply, Judge check, Mathlib search, merge and Mission submission.
Check relevant running Tasks as well as ready ones before proposing or taking work. Read the closest Task contracts and look for existing Materials. Prefer a distinct contribution when someone is already working on the whole theorem. For a reusable lemma, deliver a separately importable Lean module so peers can adopt it while they keep editing the target. If you are integrating the target proof, ask another Task to supply a useful missing lemma and check peer revisions for usable results before writing replacements.
Work in the current Session until your Task is finished. If you need an independent result, propose a Task others can take. To notify another Task about your published Material, run swarm task link --task-id RECEIVING_TASK_ID --material-id MATERIAL_ID --role response with the receiving Task's ID and the actual Material ID. See swarm task link --help. Preserve useful partial work before finishing.
Return a brief progress checkpoint after saving and checking a change, delivering a useful finding, or roughly six tool calls. End that model turn with the current result and next action so queued peer notifications can reach you. The next input continues the same Task, Execution and Session. Call task finish only to end the Task responsibility with its actual outcome.
Place new Lean modules under lean4/src/. The checker supplies Lean and Mathlib. Avoid running a local compiler or fetching dependencies. Use the Mathlib search Service for the pinned library.
Save actual files before checking. Use a project or module check to diagnose and iterate. Save your own work before applying another fixed public revision. If a public lemma helps, apply its revision, use the actual declaration in your proof, and record what you used. Resolve explicit conflicts. Merge checked work that helps advance public main.
When a complete original proof is on main, invoke mission submit with the relevant Material IDs (an empty list is allowed) and follow the fixed result. Task completion and project diagnostics cannot accept the original theorem.`;

type Problem = Awaited<ReturnType<typeof loadPutnamB1>>;
type Checks = Awaited<ReturnType<typeof preparePutnamChecks>>;
type Window = Awaited<ReturnType<typeof createRunWindow>>;
type BackendFactory = (upstream: Window['upstream']) => Parameters<typeof runFlatEnvironment>[0]['backend'];

async function usage(directory: string, runtimeId: string) {
  const path = join(directory, runtimeId, 'runtime.json');
  const report = JSON.parse(await readFile(path, 'utf8'));
  return report.modelLedgers.map(({ alias, path: ledger }: { alias: string; path: string }) => {
    const db = new DatabaseSync(ledger, { readOnly: true });
    try {
      const bots = db.prepare(`SELECT bot_id AS botId, state, COUNT(*) AS requests, COUNT(output_tokens) AS metered,
        SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens
        FROM runtime_model_attempts WHERE runtime_id=? GROUP BY bot_id,state`).all(runtimeId);
      return { alias, bots };
    } finally { db.close(); }
  });
}

export async function runPutnamFlat({ problem, checks, directory, backend, image, upstream, signal,
  durationMs = problem.durationMs, selectionMs = putnamSelectionMs(durationMs), selectionReasoningEffort }: {
  problem: Problem;
  checks: Checks;
  directory: string;
  backend: BackendFactory;
  image: string;
  upstream: { url: string; headers: Record<string, string> };
  signal: AbortSignal;
  durationMs?: number;
  selectionMs?: number;
  selectionReasoningEffort?: 'low';
}) {
  const setupStarted = performance.now();
  await mkdir(directory, { mode: 0o700 });
  const { judgeChecker, fixture, mathlibSearch, verifier, mergeChecker } = checks;
  const taskService = new TaskService(join(directory, 'tasks.sqlite'));
  const contextService = new ContextService(join(directory, 'context.sqlite'), { taskService });
  const missionWorkspace = new MissionWorkspace({ rootDir: join(directory, 'public') });
  const workspaceManager = new WorkspaceManager({ rootDir: join(directory, 'private') });
  const judgeService = new JudgeService(join(directory, 'judge.sqlite'), {
    checker: judgeChecker, fixtureManifest: fixture, taskService,
    readProjectRevision: (reference: object) => missionWorkspace.exportRevision(reference),
    dependencyEventSink: (event: object) => taskService.notifyDependencyEvent(event),
  });
  const initialDeadline = Date.now() + setupAllowanceMs + durationMs;
  let window: Window | undefined;
  let startedAt: string | undefined;
  let setupElapsedMs: number | undefined;
  let researchDeadline: number | undefined;
  const deadline = () => window?.signal.aborted || signal.aborted ? 0 : researchDeadline ?? initialDeadline;
  const ownDeadline = new AbortController();
  const setupTimer = setTimeout(() => ownDeadline.abort(new Error('Putnam setup deadline elapsed')), setupAllowanceMs);

  const missionCoordination = createMissionCoordination({
    taskService, contextService, workspace: missionWorkspace, missionId, workspaceId, checker: verifier,
    deadline, isStopping: () => Boolean(window?.signal.aborted || signal.aborted), maxFinalChecks: null,
  });
  try {
    taskService.setCheckResultReader((id: string) => judgeService.getCheckResult(id));
    taskService.createMission({
      mission_id: missionId, goal: 'Prove the original PutnamBench 2025 B1 Lean theorem.',
      acceptance_conditions: { required_check: verifier.identity }, merge_required_check: mergeChecker.identity,
    }, makeEnvelope({ actorRef: 'host' }));
    await missionWorkspace.create({ missionId, workspaceId, initialFiles: { [problem.problem_file]: problem.source } });
    const preflight = await judgeChecker.preflight({ fixtureManifest: fixture });
    if (preflight.status !== 'healthy') throw new Error('Putnam Judge preflight did not verify the locked fixture');
    window = await createRunWindow({
      directory: join(directory, 'window'), upstreamUrl: upstream.url, upstreamHeaders: upstream.headers,
      durationMs, maxConcurrent: problem.capacity, maxRequests: null, maxOutputTokens: null,
    });
    const runSignal = AbortSignal.any([signal, ownDeadline.signal, window.signal]);
    const report = await runFlatEnvironment({
      backend: backend(window.upstream), model: 'default', image, outputDir: directory, signal: runSignal,
      prompt, taskService, contextService, missionWorkspace, workspaceManager, missionId, workspaceId,
      deadlineAt: initialDeadline, activeDeadline: deadline, capacity: problem.capacity,
      autonomousTasks: true, completionPolicy: 'mission', workspaceCapture: 'core', mathlibSearch,
      judgeService, workspaceProjectCheck: true, workspaceMergeChecker: mergeChecker, missionCoordination,
      coordinationPermissions: ['mission_submit'], closeTimeoutMs,
      handoff: { executionTimeoutMs: durationMs, handoffLeadMs: Math.min(60_000, Math.floor(durationMs / 4)) },
      controller: {
        selectionMs, hardBudgetMs: durationMs + setupAllowanceMs, stallMs: durationMs,
        continuationLimit: Number.MAX_SAFE_INTEGER, discoveryLimit: Number.MAX_SAFE_INTEGER, heartbeatMs: 1000,
        beforeInitialDispatch({ signal }: { signal: AbortSignal }) {
          signal.throwIfAborted();
          if (startedAt) return;
          clearTimeout(setupTimer);
          startedAt = window!.start();
          researchDeadline = Date.parse(startedAt) + durationMs;
          setupElapsedMs = performance.now() - setupStarted;
        },
      },
    });
    await window.close();
    await missionCoordination.shutdown();
    const mission = await missionCoordination.get({ missionId });
    const accepted = mission?.submissions?.find((row: { state: string }) => row.state === 'accepted');
    const candidate = await missionWorkspace.exportRevision({ workspaceId, revision: accepted?.main_revision ?? 'main' });
    const { files, ...candidateBinding } = candidate;
    const revisions = await missionWorkspace.listRevisions({ workspaceId });
    const atDeadline = window.receipt().stopReason === 'deadline';
    const late = revisions.find((row: { revision: string; created_at: string }) =>
      row.revision === candidate.revision && atDeadline && Date.parse(row.created_at) >= researchDeadline!);
    if (late) throw new Error('Flat main advanced at or after the research deadline');
    const assessment = accepted?.result ?? (startedAt
      ? await verifier.check({ files, tree: candidate.git_tree, signal, deadline: Date.now() + verifier.timeoutMs })
      : null);
    const modelUsage = report.runtimeId ? await usage(directory, report.runtimeId).catch(() => null) : null;
    const receipt = {
      startedAt, setupElapsedMs, researchDeadline, selectionMs, problem: problem.id, sourceSha256: problem.source_hash,
      selectionReasoningEffort: selectionReasoningEffort ?? null,
      image, provider: problem.provider, model: problem.model, checker: checks.evidence,
      window: window.receipt(), modelUsage, runtimeId: report.runtimeId, environmentReport: report.reportPath,
      completion: report.result?.completion ?? report.businessFailure?.details?.[0]?.completion ?? null,
      cleanup: report.cleanup, cleanupFailure: report.cleanupFailure, reportSaveFailure: report.reportSaveFailure,
      businessFailure: report.businessFailure, mission, assessment, candidate: candidateBinding, revisions,
    };
    await writeFile(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return receipt;
  } finally {
    clearTimeout(setupTimer);
    await window?.close();
    await missionCoordination.shutdown();
    await judgeService.waitForIdle();
    judgeService.close();
    contextService.close();
    taskService.close();
  }
}

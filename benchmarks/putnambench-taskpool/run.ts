import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ContextService } from '../../dist/src/context/context-service.js';
import { runTaskPoolHarness } from '../../dist/examples/taskpool/harness.js';
import { createMissionCoordination } from '../../dist/examples/taskpool/mission-coordination.js';
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

const goal = `Work together to prove the original PutnamBench 2025 B1 theorem in Lean.`;

const collaboration = `Put reusable Lean code in a separate importable module under lean4/src/. Save your actual files with swarm workspace save and check the saved revision with swarm judge check. For a result a peer can use, publish a Material with structured content giving the declaration, file path, saved revision, and check outcome. See swarm material publish --help. Link it as a response to the Task that can use it.

When a peer's result could help, inspect the Material and its fixed files. If you decide to use it, save your own changes, apply the peer's fixed revision with swarm workspace apply, and resolve any reported conflicts. Use the actual declaration in your proof. Record the use with swarm material consume --action workspace before including its ID in swarm workspace save --material-ids. Check the combined work before merging. Public main can advance while your private project stays on its current revision.

When the complete proof is on main, submit it with swarm mission submit and check the submission result. When your own responsibility ends, save and share useful work, report the actual outcome with swarm task finish, and end this Agent. Stop work when the Mission is accepted or stopped.`;

const putnamDiscoveryContext = (path: string, source: string) => `Submit a fixed main revision that passes the independent Lean check of the original theorem. Keep the theorem statement unchanged. The final proof may not depend on sorry or any axiom outside the checker's allowed set.
Original file: ${path} at public revision 0.1.

Original problem:
\`\`\`lean
${source.trimEnd()}
\`\`\``;

type Problem = Awaited<ReturnType<typeof loadPutnamB1>>;
type Checks = Awaited<ReturnType<typeof preparePutnamChecks>>;
type Window = Awaited<ReturnType<typeof createRunWindow>>;
type BackendFactory = (upstream: Window['upstream']) => Parameters<typeof runTaskPoolHarness>[0]['backend'];

async function usage(directory: string, runtimeId: string) {
  const path = join(directory, runtimeId, 'runtime.json');
  const report = JSON.parse(await readFile(path, 'utf8'));
  return report.modelLedgers.map(({ alias, path: ledger }: { alias: string; path: string }) => {
    const db = new DatabaseSync(ledger, { readOnly: true });
    try {
      const agents = db.prepare(`SELECT agent_id AS agentId, state, COUNT(*) AS requests, COUNT(output_tokens) AS metered,
        SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens
        FROM runtime_model_attempts WHERE runtime_id=? GROUP BY agent_id,state`).all(runtimeId);
      return { alias, agents };
    } finally { db.close(); }
  });
}

export async function runPutnamTaskPool({ problem, checks, directory, backend, image, upstream, signal,
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
    const originalSource = new TextDecoder('utf-8', { fatal: true }).decode(problem.source);
    taskService.setCheckResultReader((id: string) => judgeService.getCheckResult(id));
    taskService.createMission({
      mission_id: missionId, goal,
      acceptance_conditions: { required_check: verifier.identity }, merge_required_check: mergeChecker.identity,
    }, makeEnvelope({ actorRef: 'host' }));
    await missionWorkspace.create({ missionId, workspaceId, initialFiles: { [problem.problem_file]: problem.source } });
    const preflight = await judgeChecker.preflight({ fixtureManifest: fixture });
    if (preflight.status !== 'healthy') throw new Error('Putnam Judge preflight did not verify the locked fixture');
    window = await createRunWindow({
      directory: join(directory, 'window'), upstreamUrl: upstream.url, upstreamHeaders: upstream.headers, model: problem.model,
      durationMs, maxConcurrent: problem.capacity, maxRequests: null, maxOutputTokens: null,
    });
    const runSignal = AbortSignal.any([signal, ownDeadline.signal, window.signal]);
    const report = await runTaskPoolHarness({
      backend: backend(window.upstream), model: 'default', image, outputDir: directory, signal: runSignal,
      prompt: '', taskService, contextService, missionWorkspace, workspaceManager, missionId, workspaceId,
      deadlineAt: initialDeadline, activeDeadline: deadline, capacity: problem.capacity,
      autonomousTasks: true, completionPolicy: 'mission', workspaceCapture: 'core', mathlibSearch,
      judgeService, workspaceProjectCheck: true, workspaceMergeChecker: mergeChecker, missionCoordination,
      coordinationPermissions: ['mission_submit'], closeTimeoutMs,
      handoff: { executionTimeoutMs: durationMs, handoffLeadMs: Math.min(60_000, Math.floor(durationMs / 4)) },
      controller: {
        selectionMs, hardBudgetMs: durationMs + setupAllowanceMs, stallMs: durationMs,
        continuationLimit: Number.MAX_SAFE_INTEGER, discoveryLimit: Number.MAX_SAFE_INTEGER, heartbeatMs: 1000,
        materialNotificationMode: 'steer',
        discoveryContext: putnamDiscoveryContext(problem.problem_file, originalSource), discoveryWorkflow: collaboration,
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
    if (late) throw new Error('TaskPool main advanced at or after the research deadline');
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

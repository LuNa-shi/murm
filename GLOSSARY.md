# SwarmEnv domain glossary

> Type: Vocabulary · Status: Runtime vocabulary with approved target migration note · Updated: 2026-11-13
>
> This document defines domain terms only; it does **not** define state transitions, experiment thresholds, human approval policy or implementation plans. See [Architecture](docs/architecture/INDEX.md) for runtime behavior and [AGENTS.md](AGENTS.md) for human/Coding Agent boundaries.

## Current implementation and target terminology

The table below describes runtime terms retained at main [`e6f97bc`](https://github.com/LuNa-shi/SwarmEnv/commit/e6f97bc0d56709f94374a5f824c8e2cd9c312cb2), including the later flat-only, OpenSandbox and direct Judge changes to the original PR #116 manual. It is **not** an endorsement of retaining every term. [Issue #122](https://github.com/LuNa-shi/SwarmEnv/issues/122) and the [Phase 02 model](docs/phases/0002-task-material-workspace/01-model-and-runtime.md) specify the approved target vocabulary: Mission is the shared objective; every Task has at most one current executor; Bot replaces the narrative identity term; Core is a slot; Execution runs from take through finish and cleanup; a Bot has zero or one Execution. Workspace is the project Git repository containing main and immutable public revisions, including unmerged saves; each Execution has an isolated working directory. A target-design candidate is an ordinary file addressed by Workspace/revision/path, without a separate Candidate entity or API. Mission Task, Core lane and Workspace lineage are retired in that target. Progress, handoff and service results need no additional core object types.

Until runtime migration lands, the existing terms remain labeled here so the current manual can be read correctly. Each implementation PR must reconcile this glossary with actual behavior; a wording change alone does not remove a code path.

## Runtime baseline vocabulary

| Term | Meaning |
|---|---|
| Mission | A shared user research objective and its final acceptance scope, without a permanent manager Agent |
| Mission Task | A shared responsibility in which multiple Executions may participate independently |
| Ordinary / independent Task | A responsibility with its own goal, deliverable and acceptance boundary, normally one effective Execution at a time |
| Task contract | The objective, expected output and acceptance conditions for a responsibility |
| Agent identity | An Agent identity that may sequentially undertake multiple Task Executions |
| Session | A model conversation session; a Session does not itself define a research responsibility |
| Core / Core lane | Reusable model/tool execution capacity and the corresponding runtime timeline |
| Execution | A specific authorization and record of an identity working on a Task |
| Claim / `task_take` | Acquiring a valid Task Execution on the identity's own Core lane |
| Material | A shareable result or evidence object with origin, content version and purpose |
| Progress Material | Material describing completed work, findings, open questions, next steps and optionally a Workspace snapshot |
| Workspace (current implementation) | A private writable working area for an Execution; the target expands this into the project object that also owns main |
| Workspace lineage | The source and continuation relationship between input revisions, saved revisions and successor Executions |
| Checkpoint | Saving progress while continuing the current Execution |
| Handoff | Ending an Execution's authorization while leaving the responsibility available for continuation |
| Session rotation | Replacing an Agent identity/Session without creating a new research responsibility |
| Feedback | Information, correction or redirection addressed to a Task or a specific Execution |
| Candidate | A specific content version submitted for checking; the direct Judge path reads an Execution Workspace file, and does not require Candidate Material |
| Judge / CheckResult | The checking service and its result bound to a candidate and environment |
| Fencing | Revoking the stale authorization and write capability of a terminated Execution |
| `spawned_from` / `depends_on` | Proposal provenance and a genuine prerequisite, respectively; provenance is not managerial authority |

GitHub development Issues and ticket graphs are **project-management objects**, not runtime Missions or Tasks. Their engineering workflow is documented in [AGENTS.md](AGENTS.md).

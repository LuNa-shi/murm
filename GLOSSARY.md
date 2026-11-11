# SwarmEnv domain glossary

> Type: Vocabulary · Status: Active · Updated: 2026-11-11
>
> This document defines domain terms only; it does **not** define state transitions, experiment thresholds, human approval policy or implementation plans. See [Architecture](docs/architecture/INDEX.md) for runtime behavior and [AGENTS.md](AGENTS.md) for human/Coding Agent boundaries.

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
| Workspace | A private writable working area for an Execution |
| Workspace lineage | The source and continuation relationship between input revisions, saved revisions and successor Executions |
| Checkpoint | Saving progress while continuing the current Execution |
| Handoff | Ending an Execution's authorization while leaving the responsibility available for continuation |
| Session rotation | Replacing an Agent identity/Session without creating a new research responsibility |
| Feedback | Information, correction or redirection addressed to a Task or a specific Execution |
| Candidate | A specific content version submitted for checking |
| Judge / CheckResult | The checking service and its result bound to a candidate and environment |
| Fencing | Revoking the stale authorization and write capability of a terminated Execution |
| `spawned_from` / `depends_on` | Proposal provenance and a genuine prerequisite, respectively; provenance is not managerial authority |

The GitHub development Issue, its optional implementation spec, and any human-controlled research phase are **project-management objects**, not runtime Missions or Tasks. They are documented in [the development workflow](docs/workflows/development.md), not given competing meanings here.

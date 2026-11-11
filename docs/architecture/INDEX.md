# Accepted architecture

> Type: Accepted system baseline · Implementation reference: `02adbb43` (PR #115 tree), reviewed 2026-11-11.
>
> This directory describes the reviewed **Mission-scoped flat Task architecture** as implemented at the pinned baseline. It is **not** an unreviewed future proposal or a claim of real-Agent acceptance. The code and CLI at this commit still support a **legacy Root/Child model** (and the benchmark CLI defaults to `legacy`); that is a distinct compatibility/test path, not the flat architecture described here. A follow-up removal PR will retire this split.

## Read as needed

| Document | Scope |
|---|---|
| [00 Overview](00-overview.md) | Module relationships and three important domain boundaries |
| [01 Agent Core](01-agent-core.md) | Pi prompts, capability profiles, Bridge and identity loop |
| [02 Execution](02-execution.md) | Execution authorization, Session distinction, lifecycle and fencing |
| [03 Mission and Task](03-mission-task.md) | Shared Mission Task, independent Task, claiming and feedback |
| [04 Services](04-services.md) | Registry, Task, Context, Judge and Workspace tools |
| [05 Workspace and continuity](05-workspace-continuity.md) | Progress, local Git, handoff and compaction |
| [06 Observability and evidence](06-observability-experiments.md) | Evidence projection and limitations |

## Change lifecycle

The human-approved **GitHub Issue** specifies what must change, why and how success will be observed. It may authorize a deliberate change to this accepted baseline within the scope explicitly recorded in that Issue. Optional [Issue implementation notes](../phases/INDEX.md) can link code-level decisions and experiments but cannot override this architecture or enlarge the Issue.

Coding Agents implement and test against the Issue, while [STATUS](../STATUS.md) records what is implemented and verified. **Synchronize the affected architecture with any design-changing PR when it is accepted for merge, and verify consistency at Issue closeout.** Do not rewrite accepted Architecture to match a failing test or unreviewed idea.

Source code and tests, including `src/sdk/service-catalog.js`, `src/agent/`, `src/task/` and `src/runtime/`, are needed to verify current behavior. This directory does not duplicate full API schemas. Persistent decisions are explained in [ADR](../adr/INDEX.md). Documentation baselines describe the reviewed implementation, not an automatically up-to-date assertion about every later main commit.

Known as-built boundary: `judge.submit_candidate` is currently relayed through Task Service and the Benchmark Runner before reaching Judge Service; this is not the intended final Judge Service integration. [Issue #117](https://github.com/LuNa-shi/SwarmEnv/issues/117) tracks the separate, human-reviewed redesign. Document the current code here without silently treating that redesign as complete.

The GitHub development Issue is a *management unit for improving SwarmEnv*; it is not a runtime Mission, Task or Execution within SwarmEnv.

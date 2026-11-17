# ADR 0017: Shared Mission and Task-centric division of work

- Status: Historical decision; shared-Mission-Task ownership and private continuity were superseded by [Issue #122](https://github.com/LuNa-shi/SwarmEnv/issues/122) and its [Phase 02 model](../phases/0002-task-material-workspace/01-model-and-runtime.md). The current Mission is never taken, each Task has at most one current executor, and fresh Bots continue through public Material/revisions. The original phase-one proposal remains available in Git history; actual implementation and evidence should be checked against source, the [architecture manual](../architecture/INDEX.md) and the relevant GitHub Issue/PR evidence.
- Origin: 2026-11-01 to 2026-11-05; PR #110 and related task-centric revisions.

## Context

Earlier parent-child approval trees, flat Tasks, and Judge retry gates coexisted. Predefined research routes and Task-count quotas also constrained self-directed work. Shared objectives, independent responsibilities, Execution authorization, and Session capacity were not consistently separated.

## Decision

- A Mission expresses the shared research objective. Its shared Mission Task permits multiple independent Executions. An ordinary Task represents separable work with its own delivery boundary and normally only one active Execution.
- Agents decide whether to create independent work; Runtime manages physical resources. When no ordinary Task is suitable, an Agent may continue the shared Mission.
- No Task-count quota applies. Overall budgets, model/Core capacity, and timeouts still constrain execution. Judge is an iterative checking tool, and a local PASS is not completion of the original Mission.
- Progress Material references actual versions. File work uses a per-Execution local Git Workspace. Handoff and identity rotation must preserve prior valid work; saving failure must clearly disclose potential unsaved loss.
- Exact register/switch, checking, authorization and continuation behavior is documented by [current Architecture](../architecture/INDEX.md) and corresponding source.

## Consequences

This reduces centralized approval and task-supply bottlenecks while leaving open the risks of redundant exploration, ineffective delegation and poor convergence. Research evidence must distinguish concurrent shared-Mission Executions, independent Task decomposition, and actual downstream reuse. This ADR does not maintain the old S1–S3 Issue list, fixed two-hour acceptance criteria, or earlier implementation-state assertions.

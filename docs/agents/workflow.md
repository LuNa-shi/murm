# Agent workflow

## Issue and PR lifecycle

Every implementation starts from a GitHub Issue that states the problem, scope, dependencies, and executable acceptance criteria. The implementation uses a worktree named for that Issue and a branch named `codex/issue-<number>-<slug>`.

The worktree must be clean before the acceptance run. Record the exact commit, repository dirty state, model/provider route, timebox, fixture, and output report path. After tests and the experiment are complete, commit the work and open a separate PR. The PR describes the behavior, evidence, and merge risk; it is reviewed against `main` before merge.

## Document ownership

`docs/` contains Agent-generated architecture decisions, research, benchmark reports, and operational guidance. `documents/` contains documents supplied by humans. An Agent may read human documents as inputs but does not rewrite them as part of routine implementation.

## Runtime lifecycle vocabulary

- `RUNNING`: the Runtime owns an active Agent process for the Execution.
- `WAITING`: the Execution has a checkpoint and a concrete condition. Runtime stops the process and releases physical capacity. Only a matching wake or explicit resumable claim can restore it.
- `IDLE`: a Core has no assignment. An empty task queue produces IDLE/backoff, not WAITING.
- `yield`: a future cooperative scheduling operation may release a Core with no dependency condition. It must not create a second owner for the same responsibility and must not be reported as semantic WAITING. It is not an Agent tool until its ownership and resume contract is implemented.

## Progress evidence

Hard utilization metrics come from Runtime state intervals and Service events. They do not call an LLM to summarize work. Each work unit records task and Execution provenance, input and goal fingerprints, output fingerprint, and a progress kind. Duplicate fingerprints are a review signal; they are not silently counted as independent progress.

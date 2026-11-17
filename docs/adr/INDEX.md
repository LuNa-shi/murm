# Architecture decision records

ADRs explain the context, decision and tradeoffs behind durable choices. They do not replace a human-approved GitHub Issue, the accepted [Architecture](../architecture/INDEX.md), source code, or verification evidence.

| ADR | Role |
|---|---|
| [0017: Task-centric shared Mission](0017-task-centric-phase1-contract.md) | Historical first-phase rationale; shared-Mission-Task/private-continuity details superseded by Issue #122 |
| [0018: Issue-led development and documentation](0018-issue-led-engineering-workflow.md) | Why Issue intent, implementation documentation and experimental evidence have different responsibilities |
| [0019: Direct Workspace submission to Judge](0019-direct-judge-workspace-submission.md) | Direct Judge ownership retained; registered inputs now use immutable public revisions and optional whole-project checking (Issues #122/#127) |

Original ADR 0001–0016 versions are available in [pinned Git history](https://github.com/LuNa-shi/SwarmEnv/tree/02adbb43d39e0b23befb7f2ffc4b19ffb386a36d/docs/archive/2026-11-01/docs/adr). Their old validity does not automatically extend to the latest accepted design. A new ADR should include status, context, alternatives, decision and consequences, and link the approving GitHub Issue.

Create an ADR only when a lasting decision has meaningful alternatives or tradeoffs that would otherwise be lost. An ordinary Issue, implementation PR or stage completion does not require another ADR. Runtime mechanics and exact prompts belong in Architecture; planned work and acceptance belong in the approved Issue; measured outcomes belong in Experiments. Amend or supersede a decision explicitly when a later approved Issue changes it.

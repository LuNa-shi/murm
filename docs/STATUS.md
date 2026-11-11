# Implementation status and evidence

> Type: Continuously maintained implementation/evidence index · Last consolidated: 2026-11-11
>
> This file records implementation progress and the evidence available at specific commits. It is **not** the authority for new requirements. Each active work item should link to its human-approved GitHub Issue, relevant PR, code commit and observed verification.

## How to maintain this file

For meaningful milestones, maintain an Issue-linked row or section with:

| Field | Meaning |
|---|---|
| GitHub Issue | Human-approved problem and acceptance criteria |
| PR / implementation commit | Exact code being tested |
| Requirements / status | Implemented, in progress, blocked, or not implemented |
| Evidence | Linked deterministic tests, controlled probes, or real-Agent runs |
| Gaps / next action | Unverified behavior, failed checks and proposed fixes |

Coding Agents may iterate tests and fixes autonomously without editing STATUS for every attempt. Update it when a functional milestone, meaningful failure or verification conclusion changes. Do not report `implemented` as `verified` without evidence. Keep old claims pinned to the run or commit that supports them.

## Consolidated runtime snapshot

The current reviewed runtime code tree used for this snapshot is `02adbb43d39e0b23befb7f2ffc4b19ffb386a36d` (PR #115). The table is not a complete acceptance audit of all later commits. Architecture documents describe the flat Mission Task model, **while the benchmark CLI still defaults to `legacy` at this commit**. The planned Legacy removal is a separate stacked PR; [Issue #117](https://github.com/LuNa-shi/SwarmEnv/issues/117) separately tracks Judge submission routing. Neither change is implemented in PR #116.

| Area | Implemented surface / known evidence | Open verification questions |
|---|---|---|
| Agent Core and reusable identity | Pi adapter, prompts, capability profiles, Services Bridge and identity loop are present; source version constants include `PROMPT_VERSION=5` and `SYSTEM_PROMPT_VERSION=3` | Concrete per-run prompt/profile snapshots must be checked separately |
| Mission, Task and Execution | Shared Mission Task supports multiple Executions; independent Tasks have distinct responsibilities; `task_register(take: true)` supports same-lane register-and-switch | Self-directed decomposition does not automatically establish useful coordination |
| Context and Judge | Material and consumption records, Candidate checks and tool feedback are available; registered Judge submission is currently relayed by Task Service and Benchmark Runner | Judge directly owning its Agent-facing submission path requires a separate design-changing PR (Issue #117); read/consume/check counts do not prove mathematical progress |
| Workspace and Runtime | Per-Execution private workspaces, progress/Git, fencing and identity continuity paths are present | Complete lineage, notifications and real compaction/rotation require case-specific evidence |
| Observability | Event/state projections support inspection and diagnostics | Observation does not replace authoritative state or causal analysis |

### R16 baseline evidence

- Code commit: `93176b746492ecbe4c64ec18643a8356b7f5255e`, same file tree as `02adbb43`.
- The 2026-11-06 four-Core, one-hour run recorded 4 Tasks, 15 durable Executions, 106 Materials, 44 consumptions and 6 completed Judge checks. All six were `source_failure`; `solved=false` and `protocol_valid=true`.
- The run does not establish a matched root-only improvement, every Material's useful downstream effect, or complete continuation lineage.
- See the [retrospective R16 report](experiments/EXP-20261111-01-r16-example.md). Its reporting format was applied after the run; it was not preregistered.

## Issue and closeout updates

The active GitHub Issue/PR is the primary discussion and approval surface; do not copy the Issue's full plan into STATUS. Link the Issue's approved requirements and add the implementation/evidence delta. When a design-changing PR is accepted for merge, synchronize [Architecture](architecture/INDEX.md); at Issue closeout, record the final evidence and any unresolved limitations here. A documentation-only PR cannot establish new runtime capability or performance.

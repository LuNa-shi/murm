# Implementation status and evidence

> Type: Continuously maintained implementation/evidence index · Last consolidated: 2026-11-11
>
> **Maintained continuously by Coding Agents.** This is a concise, current view of implemented behavior, verification evidence, and remaining gaps. Human-approved GitHub Issues own requirements and acceptance; STATUS does not approve scope, record the full engineering plan, or replace the PR and experiment reports.

## Update policy

The [Coding Agent rules in AGENTS.md](../AGENTS.md) govern when STATUS must be synchronized:

- Update **with the relevant PR** when a meaningful capability is implemented, a significant blocker/regression is confirmed or resolved, or substantive test/real-Agent evidence changes the conclusion.
- Refresh the accepted-baseline summary when a design-changing PR is accepted for merge; check alignment with [Architecture](architecture/INDEX.md). At Issue closeout, record the supported outcome and outstanding gaps.
- Do **not** edit this file for every test, commit, debugging attempt, or raw experiment event. Keep detailed chronological evidence in the Issue/PR and [experiment records](experiments/INDEX.md).
- Preserve exact tested commit, evidence type, result, and remaining uncertainty. **Implemented is not verified**. Pending/unmerged work must not be presented as accepted on `main`.
- Consolidate superseded or completed entries instead of turning STATUS into an ever-growing history. Earlier versions remain in Git.

## Current Issue checkpoints

Only add a row when the current Issue's implementation or verification status has an evidenced change. Use links rather than duplicating the Issue's approved requirements.

| Approved Issue | Implementation (PR and commit) | Verification (level and evidence) | Remaining gap / next action |
|---|---|---|---|
| _Add a current Issue when evidence becomes available_ | _Pending / implemented at exact commit_ | _Not run / deterministic / controlled probe / real Agent, with link_ | _Unknown or next verification step_ |

An Issue being opened, assigned, labelled `ready-for-agent`, or discussed does **not** by itself create an implemented or verified claim. Where no current checkpoint has been independently confirmed, retain the template instead of guessing.

## Pinned runtime baseline (historical snapshot)

The snapshot below is verified against a specific code tree; it does **not** automatically describe later commits. Refresh affected rows and the baseline reference when corresponding changes are accepted, preserving earlier evidence links rather than silently carrying claims forward.

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

## Closeout boundary

Keep the approved Issue and its PR as the durable discussion, specification, and detailed review record. STATUS only summarizes the final implementation/evidence delta and remaining gaps at an exact code version. On acceptance, synchronize relevant [Architecture](architecture/INDEX.md) and fold completed work into the maintained baseline; do not leave stale work-in-progress rows indefinitely. This documentation-only PR establishes maintenance rules, **not** new runtime evidence.

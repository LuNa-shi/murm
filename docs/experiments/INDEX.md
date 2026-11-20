# Experiment registry

> Type: Formal run registry · Status: Active

Formal experiments performed under a **human-approved GitHub Issue** use `EXP-YYYYMMDD-NN`, allocated before execution using the UTC date and a non-reused daily sequence. Every formal entry links the parent Issue, tested commit and report. Repeated experiments receive new IDs linked via `repeat_of` or `comparison_to`; IDs do not encode Issue, model or outcome.

Implementation unit tests, bounded debugging probes and failure reproductions are different: they may run and repeat within an approved Issue and resource allowance **without a formal EXP ID**. Keep reproducible evidence and summarize at meaningful milestones. See [experiment workflow](../workflows/experiment.md).

| ID | Parent Issue / context | Type and status | Code | Report |
|---|---|---|---|---|
| `EXP-20261120-10` | [Issue #157](https://github.com/LuNa-shi/SwarmEnv/issues/157) | Final unavailable · native four-worker Seymour challenge only | `490a215` | [No-paper run](EXP-20261120-10-agensh-seymour-challenge-only.md) |
| `EXP-20261120-09` | [Issue #157](https://github.com/LuNa-shi/SwarmEnv/issues/157) | Final PASS · 35m35s from launch, four archives verified; local access repaired in-run | `eeb45c4` | [Paper run](EXP-20261120-09-agensh-seymour-paper.md) |
| `EXP-20261120-07` | [Issue #157](https://github.com/LuNa-shi/SwarmEnv/issues/157) | Stopped by owner at 46m34s · final FAIL, four archives verified | `8fb4d5f` | [Seymour comparison](EXP-20261120-07-agensh-seymour.md) |
| `EXP-20261120-06` | [Issue #157](https://github.com/LuNa-shi/SwarmEnv/issues/157) | Stopped by owner at 7m34s · four archives verified, plateau unassessable | `51bb3c4` | [Q20 observation](EXP-20261120-06-agensh-pi-q20.md) |
| `EXP-20261120-05` | [Issue #157](https://github.com/LuNa-shi/SwarmEnv/issues/157) | Final PASS · 2 Pi workers, actual cross-worker handoff, trusted B1 at 8m26s | `87b6a9b` | [Putnam pilot](EXP-20261120-05-agensh-pi-putnam.md) |
| `EXP-20261120-04` | [Issue #157](https://github.com/LuNa-shi/SwarmEnv/issues/157) | Provider rejected all requests · 138 s · protocol invalid | `e257540` | [Putnam pilot](EXP-20261120-04-agensh-pi-putnam.md) |
| `EXP-20261120-03` | [Issue #157](https://github.com/LuNa-shi/SwarmEnv/issues/157) | Setup failed before first wake · 0 model requests | `e257540` | [Putnam pilot](EXP-20261120-03-agensh-pi-putnam.md) |
| `EXP-20261120-02` | [Issue #153](https://github.com/LuNa-shi/SwarmEnv/issues/153) | Completed · Seymour, 4h, protocol valid, general theorem unsolved | `4c2f193` | [Single Seymour run](EXP-20261120-02-seymour-single-4h.md) |
| `EXP-20261120-01` | [Issue #153](https://github.com/LuNa-shi/SwarmEnv/issues/153) | Stopped after 25m48s wall · Core 3 discovery failure, operator stop | `b56d030` | [First pair](EXP-20261120-01-openai-math-first-pair.md) |
| `EXP-20261117-07` | [Issue #137](https://github.com/LuNa-shi/SwarmEnv/issues/137) / [#135](https://github.com/LuNa-shi/SwarmEnv/issues/135) | **REGISTERED · Q20 fresh12h /4Cores; matched-time comparison** | `9f62722` | [Q20 twelve-hour comparison](EXP-20261117-07-q20-subtree-12h.md) |
| `EXP-20261117-06` | [Issue #137](https://github.com/LuNa-shi/SwarmEnv/issues/137) | **B1 accepted; protocol/cleanup PASS; natural resource-error recovery** | `ccdd5c7` | [Nested-resource acceptance](EXP-20261117-06-nested-resource-acceptance.md) |
| `EXP-20261117-05` | [Issue #137](https://github.com/LuNa-shi/SwarmEnv/issues/137) | **B1 accepted, protocol/cleanup PASS; diagnostic repair incomplete** | `30908fc` | [Issue137 Putnam acceptance](EXP-20261117-05-issue137-putnam-acceptance.md) |
| `EXP-20261117-04` | [Issue #138](https://github.com/LuNa-shi/SwarmEnv/issues/138) | **PASS · legacy cleanup; accepted in 18m28s, protocol valid** | `e8fd842` | [Legacy cleanup Putnam acceptance](EXP-20261117-04-legacy-cleanup-putnam.md) |
| `EXP-20261117-03` | [Issue #135](https://github.com/LuNa-shi/SwarmEnv/issues/135) | **Q20 root-only, 4 Core · 8h UNSOLVED; protocol INVALID, analyzer failed** | `d60b6b0` | [Q20 eight-hour retry](EXP-20261117-03-q20-subtree-8h.md) |
| `EXP-20261117-02` | [Issue #135](https://github.com/LuNa-shi/SwarmEnv/issues/135) | **Q20 root-only, 4 Core · STOPPED; align settlement wait** | `d60b6b0` | [Q20 eight-hour retry](EXP-20261117-02-q20-subtree-8h.md) |
| `EXP-20261117-01` | [Issue #135](https://github.com/LuNa-shi/SwarmEnv/issues/135) | **Q20 root-only, 4 Core · STARTUP_BLOCKED; zero model calls** | `2dc4a16` | [Q20 eight-hour](EXP-20261117-01-q20-subtree-8h.md) |
| `EXP-20261116-14` | [Issue #135](https://github.com/LuNa-shi/SwarmEnv/issues/135) | **Q20 root-only, 4 Core · COMPLETED; unsolved, audit misclassification diagnosed** | `d79ace7` | [Q20 root-only one-hour](EXP-20261116-14-q20-subtree-1h.md) |
| `EXP-20261116-13` | [Issue #135](https://github.com/LuNa-shi/SwarmEnv/issues/135) | **Q20 root-only, 4 Core · COMPLETED; unsolved, protocol valid** | `d79ace7` | [Q20 root-only health](EXP-20261116-13-q20-subtree-health-15m.md) |
| `EXP-20261116-12` | [Issue #133](https://github.com/LuNa-shi/SwarmEnv/issues/133) | **FLT10 Q20 · HELD BEFORE LAUNCH; actual-target positive control pending** | `7f1f089` | [Q20 observation](EXP-20261116-12-flt-q20-after-q10-1h.md) |
| `EXP-20261116-11` | [Issue #133](https://github.com/LuNa-shi/SwarmEnv/issues/133) | **FLT10 Q10 repair, 4 Core · PASS; accepted in 9m18s including deployment** | `7f1f089` | [Q10 repair observation](EXP-20261116-11-flt-q10-repair-1h.md) |
| `EXP-20261116-10` | [Issue #133](https://github.com/LuNa-shi/SwarmEnv/issues/133) | **FLT10 Q20, 4 Core · INTERRUPTED; Q10-first correction** | `361a964` | [FLT Q20 observation](EXP-20261116-10-flt-q20-1h.md) |
| `EXP-20261116-09` | [Issue #133](https://github.com/LuNa-shi/SwarmEnv/issues/133) | **FLT10 Q10, 4 Core · BLOCKED after 14m15s including deployment** | `361a964` | [FLT Q10 observation](EXP-20261116-09-flt-q10-1h.md) |
| `EXP-20261116-08` | [Issue #130](https://github.com/LuNa-shi/SwarmEnv/issues/130) | **PASS · accepted in 20m28s from startup, within 1h maximum** | `1c2d5d5` | [Judge queue repeat](EXP-20261116-08-judge-queue-1h.md) |
| `EXP-20261116-07` | [Issue #130](https://github.com/LuNa-shi/SwarmEnv/issues/130) | **PASS with recorded limits/interruption · accepted in 19m10s of 1h maximum** | `e18c7ae` | [Centralized Judge repeat](EXP-20261116-07-centralized-judge-1h.md) |
| `EXP-20261116-05` | [Issue #129](https://github.com/LuNa-shi/SwarmEnv/issues/129) | **Trusted proof accepted; protocol INVALID; owner ended observation** | `2edb9b0` | [Independent Pass@1](EXP-20261116-05-pass-k-1-1h.md) |
| `EXP-20261116-06` | [Issue #129](https://github.com/LuNa-shi/SwarmEnv/issues/129) | **Pass@4 · CANCELED before launch by owner** | `2edb9b0` | [Independent Pass@4](EXP-20261116-06-pass-k-4-1h.md) |
| `EXP-20261116-04` | [Issue #127](https://github.com/LuNa-shi/SwarmEnv/issues/127#issuecomment-6906617716) | **Four criteria PASS; trusted acceptance in 9m24s of 1h limit** | `e00e246` | [Whole-Workspace 1h repeat](EXP-20261116-04-workspace-project-1h.md) |
| `EXP-20261116-03` | [Issue #127](https://github.com/LuNa-shi/SwarmEnv/issues/127#issuecomment-6907134029) | **Startup succeeded; verbose source failure misclassified · BLOCKED** | `df9240c` | [Workspace project follow-up](EXP-20261116-03-workspace-project-1h.md) |
| `EXP-20261116-02` | [Issue #127](https://github.com/LuNa-shi/SwarmEnv/issues/127#issuecomment-6906617716) | **Image ownership gate rejected all Bot startups · BLOCKED** | `dfc0c87` | [Project-check acceptance repeat](EXP-20261116-02-workspace-project-1h.md) |
| `EXP-20261116-01` | [Issue #127](https://github.com/LuNa-shi/SwarmEnv/issues/127#issuecomment-6906617716) | **Pre-existing evidence directory rejected before Bot startup · BLOCKED** | `dfc0c87` | [Project-check acceptance](EXP-20261116-01-workspace-project-1h.md) |
| `EXP-20261115-08` | [Issue #122](https://github.com/LuNa-shi/SwarmEnv/issues/122#issuecomment-6896946332) | **Four criteria passed; accepted in 11m06s of 1h limit · PASS** | `77f716c` | [Single-project 1h acceptance](EXP-20261115-08-single-problem-1h.md) |
| `EXP-20261115-07` | [Issue #122](https://github.com/LuNa-shi/SwarmEnv/issues/122#issuecomment-6895020563) | **Stopped on gap-discovery clarification at 16m33s · BLOCKED** | `6a256d6` | [Single-project 2h validation](EXP-20261115-07-single-problem-2h.md) |
| `EXP-20261115-06` | [Issue #122](https://github.com/LuNa-shi/SwarmEnv/issues/122#issuecomment-6895020563) | **Mission accepted in 7m42s of 30m limit · PASS** | `6a256d6` | [Single-project 30m validation](EXP-20261115-06-single-problem-30m.md) |
| `EXP-20261115-05` | [Issue #122](https://github.com/LuNa-shi/SwarmEnv/issues/122#issuecomment-6895020563) | **30m renewal/checker repair validation · BLOCKED** | `6a256d6` | [Single-project 30m completion run](EXP-20261115-05-single-problem-30m.md) |
| `EXP-20261115-04` | [Issue #122](https://github.com/LuNa-shi/SwarmEnv/issues/122#issuecomment-6895020563) | **Four self-proposed parallel Tasks; runtime defects · BLOCKED** | `cb6c982` | [Repaired single-project 30m](EXP-20261115-04-single-problem-30m.md) |
| `EXP-20261115-03` | [Issue #122](https://github.com/LuNa-shi/SwarmEnv/issues/122#issuecomment-6895020563) | **Real-model attempt interrupted by schema errors · BLOCKED** | `e601e81` | [Single-project 30m validation](EXP-20261115-03-single-problem-30m.md) |
| `EXP-20261115-02` | [Issue #122](https://github.com/LuNa-shi/SwarmEnv/issues/122#issuecomment-6895020563) | **Startup rejected malformed lock reference · BLOCKED** | `e601e81` | [Single-project 30m repeat](EXP-20261115-02-single-problem-30m.md) |
| `EXP-20261115-01` | [Issue #122](https://github.com/LuNa-shi/SwarmEnv/issues/122#issuecomment-6895020563) | **Startup aborted before project creation · BLOCKED** | `e601e81` | [Single-project 30m](EXP-20261115-01-single-problem-30m.md) |
| `EXP-20261111-01` | Historical R16; no newly approved Issue | **Retrospective example, not preregistered** | `93176b7` | [R16 example](EXP-20261111-01-r16-example.md) |
| `EXP-20261112-01` | [Issue #122](https://github.com/LuNa-shi/SwarmEnv/issues/122) | **Aborted compatibility-path preflight · BLOCKED** | `f43a722` | [Issue #122 partial report](EXP-20261112-01-issue122-1h.md) |
| `EXP-20261112-02` | [Issue #122](https://github.com/LuNa-shi/SwarmEnv/issues/122) | **Aborted multi-project setup diagnostic · BLOCKED** | `148e37f` | [Issue #122 batch diagnostic](EXP-20261112-02-issue122-1h.md) |
| `EXP-20261112-03` | [Issue #122](https://github.com/LuNa-shi/SwarmEnv/issues/122) | **1h single-problem public Workspace/Mission acceptance run · REGISTERED** | `8bfc101` | [Issue #122 single-problem report](EXP-20261112-03-single-problem-1h.md) |
| `EXP-20261112-04` | [Issue #122](https://github.com/LuNa-shi/SwarmEnv/issues/122) | **1h single-problem acceptance rerun with fixed provider/image · REGISTERED** | `d3e2a9e` | [Issue #122 acceptance rerun](EXP-20261112-04-single-problem-1h.md) |
| `EXP-20261112-05` | [Issue #122](https://github.com/LuNa-shi/SwarmEnv/issues/122) | **1h single-problem acceptance rerun with clean Execution Workspace · REGISTERED** | `be3d1d5` | [Issue #122 clean-workspace rerun](EXP-20261112-05-single-problem-1h.md) |
| `EXP-20261112-06` | [Issue #122](https://github.com/LuNa-shi/SwarmEnv/issues/122) | **1h single-problem acceptance rerun with normalized modern claim boundary · REGISTERED** | `9ac4012` | [Issue #122 normalized-claim rerun](EXP-20261112-06-single-problem-1h.md) |
| `EXP-20261112-07` | [Issue #122](https://github.com/LuNa-shi/SwarmEnv/issues/122) | **Single-problem run stopped early · BLOCKED** | `7ceda2f` | [Issue #122 blocked run](EXP-20261112-07-single-problem-1h.md) |

Use [TEMPLATE.md](TEMPLATE.md) for each new formal study. An approved Issue may delegate a bounded matrix and repeated runs, so a separate human approval is not needed for every execution. The human decides the value/importance of research hypotheses and any material scope change.

## Retrospective diagnostics

- [OpenAI Math PartialPermutation one-hour diagnostic](openai-math-partial-permutation-1h-diagnostic.md) records the first natural-deadline single-project validation on PR #147. It is an engineering diagnostic and has no formal EXP ID.

- [Issue #122 formal24 gap analysis](issue122-formal24-gap-analysis.md) records the one-hour run at `7c5836f`, reconstructs each Bot lifecycle, and compares observed behavior with Phase 02.

## Metric proposals

- [Q20 progress score and curve](q20-score-curve.md) defines five cumulative proof milestones and records the retrospective 1-hour and 8-hour curve.

## Retention and interpretation

This directory is retained because a current implementation manual cannot reconstruct a historical observation. Keep the registry, reusable report template and reports still cited by current Issues, PRs, ADRs or accepted design decisions. When a report leaves the active tree, replace its maintained references with an immutable Git link; do not silently discard the evidence behind a current claim. The existing R16 example remains explicitly retrospective and is not proof of a later implementation's behavior.

Architecture describes runtime mechanisms, including the evidence pipeline. These reports record the actual inputs, tested version, observations and limitations of particular runs. Neither creates a second stage plan.

Historical experimental reports can be found in [the fixed pre-cleanup Git tree](https://github.com/LuNa-shi/SwarmEnv/tree/02adbb43d39e0b23befb7f2ffc4b19ffb386a36d/docs/experiments). Git does not necessarily include raw records from ignored local experiment directories.

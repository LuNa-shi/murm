# Issue #50 experiment evidence

This is the sanitized, reviewable publication bundle for the latest Issue #50
experiment. It preserves the complete analyzer output and the independent
semantic review while keeping raw Agent and proof-bearing state local.

## Run identity

| Field | Value |
|---|---|
| Publication ID | `exp-20261024-issue50-b1-1h-2fc0c87` |
| Source experiment ID | `issue-50-b1-1h-2fc0c87` |
| Experiment commit | `2fc0c8770327cd277dd88119fff1a986a72be137` |
| Analysis commit | `c49e6a080077dbb59d45c37f53311ef37a528a81` |
| PutnamBench commit | `a635813f5edf297d928f9bd5ef8324a26bdde09c` |
| Started | `2026-10-24T04:29:29.171Z` |
| Ended | `2026-10-24T05:29:31.717Z` |
| Configuration | 4 Cores, 1 problem, 1 hour, 9 minute turn timeout |

The run completed with `protocol_valid=true`, `solved=false`, and
`report_made_progress=true`. It produced 4 Tasks, 4 durable Executions, 42
Materials, 13 Candidate checks, and 3 child Tasks. The semantic review scores
the available evidence 10/12: coordination and lifecycle evidence are strong;
Candidate route semantics and retry causality remain evidence-limited.

## Published files

- [Run summary](run-summary.json) — sanitized configuration, outcome, and
  derived metrics.
- [Full experiment analysis](experiment-analysis.md) — the current
  evidence-first analyzer output, including bounded Execution windows,
  coordination, Candidate/Judge, efficiency, and evidence-boundary sections.
- [Independent semantic review](semantic-review.md) — the manually reviewed
  Execution narratives, collaboration loop, route conclusions, layer diagnosis,
  and prioritized validation recommendations.

## Evidence boundary

The local run contained metadata, Agent, Bridge, Runtime, Service, Judge,
SQLite, Observation, Workspace, and summary evidence. This publication contains
the complete sanitized semantic projections of those records and the metrics
needed to reproduce the conclusions at the review level. The raw Agent
transcripts, Candidate/proof source, SQLite and observability databases,
Workspace files, credentials, stdout/stderr, and unredacted experiment state
are deliberately not committed. Repository rules prohibit publishing those
artifacts; the reports call out where a conclusion is evidence-limited instead
of presenting hidden source as proof.

Stable record IDs and evidence-class references in the reports identify the
local source records used for analysis. They are included for auditability, but
the raw records remain in the local experiment directory.

## Experiment storage convention

Future runs use one checkout-level `experiments/` directory and sortable IDs of
the form `exp-YYYYMMDD-<short-id>`, using the UTC start date. The source run
predates this convention, so its legacy ID is preserved in the summary while
this publication uses the date-prefixed ID above.

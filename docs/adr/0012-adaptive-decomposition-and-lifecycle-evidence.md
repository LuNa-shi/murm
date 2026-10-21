# ADR 0012: Record adaptive decomposition and Task wait lifecycle evidence

Status: accepted. Benchmark reports must distinguish observed independent child
work from queue supply and must make Task wait ownership auditable.

## Decision

`parallelism.decomposition_available` is `true` when the run actually records
an independently contracted child Task. It is `false` when no child work was
observed; this is an operational observation, not an LLM summary of whether a
mathematical problem could theoretically be decomposed. The accompanying
`decomposition_evidence` records child count, scheduler status observations,
`ready_work_ms`, and `ready_unassigned_ms` so a later analysis can distinguish
missing work from unused capacity.

The sanitized report records Task lifecycle facts from Task Service operations:

- execution history contains the wait condition type and dependency IDs;
- `run.lifecycle_events` records request, wake, and resume operations with
  Task and Execution IDs;
- `run.invalid_wait_attempt_count` counts rejected Task wait requests,
  including attempts to wait for a synchronous candidate check.

These fields are derived from Runtime and Task Service lifecycle events plus
Task, Execution, and Core provenance. No LLM progress summary or semantic
duplicate detector contributes to the hard utilization metric.

## Consequences

An experiment that solves a root directly can report
`decomposition_available: false` while still exposing whether ready work was
available and whether any capacity went unused. A run that creates children
must be evaluated using its child lifecycle and Core intervals, rather than
assuming that prompt instructions alone produced parallel work.

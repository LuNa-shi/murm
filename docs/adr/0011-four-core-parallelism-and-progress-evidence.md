# ADR 0011: Measure reusable Core utilization from audited state intervals

Status: accepted. A PutnamBench project has four reusable Core slots, and its
parallelism report must distinguish active Agent work from transport, polling,
waiting, and Judge time.

## Decision

The benchmark runner records one non-overlapping state interval per Core using
`IDLE`, `ASSIGNED`, `RUNNING`, `WAITING`, and `STOPPING`. `RUNNING` intervals
are the only input to `agent_time_ms` and
`agent_time_utilization_v0`; the denominator is four times the measured
experiment elapsed time. Judge and raw turn occupancy are reported separately.

Unbound discovery turns use a shared admission gate so a group of reusable
slots cannot claim the same stale Task snapshot at once. A successful claim
releases the gate as soon as Task Service ownership is durable, allowing the
bound Agent sessions to run concurrently. Empty slots remain available for a
later ready-work dispatch.

The sanitized report records work units with Task, Execution, Core, and
progress-kind provenance. Existing input snapshot hashes remain part of the
Execution and CheckResult consistency contract; the report does not infer
semantic duplicates or link work units through `duplicate_of`.

## Consequences

- A Core that is waiting or only discovering Tasks does not inflate effective
  Agent Time.
- Four simultaneous `RUNNING` intervals produce utilization `1.0`; two produce
  `0.5`; one Core handing work to itself produces `0.25`.
- Reports can be independently checked from `core_state_intervals` without
  exporting candidate source, proof text, or raw transcripts.
- The scheduler may still use bounded polling for readiness, but polling,
  claim conflicts, and Judge time remain separate diagnostics.

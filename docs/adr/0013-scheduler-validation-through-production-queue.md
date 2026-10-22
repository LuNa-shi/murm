# ADR 0013: Validate reusable Core scheduling through production queue scenarios

Status: accepted.

## Context

Issue #30 concerns reusable Core capacity after an Agent creates Child Tasks.
The existing real-Agent evidence shows that low utilization can come from
late work supply, parent review waiting, Core release, or delayed queue
consumption. A benchmark can also create an artificial result by assigning a
permanent role and Child ID to each Core, or by judging a Child result's
semantic usefulness after the fact.

The system needs deterministic evidence that exercises the same Task Service,
Runtime, queue claim, release, wake, and parent-review paths used by a real
Experiment. It also needs to preserve the distinction between a Task result
being delivered to the Root and the Root deciding how useful that result is.

## Decision

Issue #30 uses three deterministic test scenarios:

- Gate A starts with only a Root Task. The Root Agent creates direct Child
  Tasks during its Execution. Workers claim the Tasks that actually appear in
  the production queue.
- Gate B starts with a known set of independent Tasks. It tests queue
  consumption, Core release, and reuse without requiring a Root synthesis.
- Gate C exercises two waves of Tasks and verifies that released Cores can
  claim later work while another Task is in parent review.

All three scenarios use the production Task Service, Runtime, Core capacity,
claim, release, wake, and parent-review behavior. A scenario supplies known
Tasks and scripted Agent behavior only; it does not implement a second
Scheduler or bind a permanent Task role to a Core. A Worker chooses behavior
from the Task it actually claims.

The Root must read each Child result that the scenario expects it to receive.
The test records publication and Root consumption. It does not judge whether
the result is semantically useful, whether it appears in a final theorem, or
whether a different research route would have been better.

Parallelism reports may include eligible windows and the existing full-run
metrics. Eligible metrics are recomputable diagnostics. No fixed average Core
count, including 3.0, is a hard gate. Dispatch timing remains a simple
diagnostic based on existing lifecycle evidence; Issue #30 does not introduce
a new dispatch-latency domain concept or gate.

Task and Execution identity remains grounded in Task IDs, Execution IDs,
Workspace lineage, leases, fencing, and parallel quota. Issue #30 does not
add or expand generic fingerprint or semantic deduplication behavior. Existing
identity or consistency values required by current Execution and CheckResult
contracts remain governed by those contracts and are not used as a new
semantic duplicate detector.

Valid parent rework follows the existing Task Service contract: a waiting
parent-review Execution resumes with the same Execution ID and updated
instruction version; expired or fenced work follows the existing recovery
policy. Ordinary wait/resume preserves the Root and Execution lineage.

## Consequences

- A Core can execute different Tasks across one Experiment, so Core reuse is
  observable rather than implied by fixed test roles.
- Gate B isolates queue and capacity behavior from Root proof synthesis.
- Child delivery is testable through publication and Root reads without
  making the Runtime an evaluator of scientific relevance.
- A run can report that it had little or no eligible work without treating
  that observation as a Scheduler failure.
- Existing lifecycle and identity contracts remain the source of truth; the
  benchmark does not create a parallel deduplication policy.

## Alternatives considered

- **Fixed Core-to-Child roles.** This makes a short test predictable but cannot
  prove that a released Core can claim a different Task.
- **A separate idealized test Scheduler.** This can pass while production
  claim and release paths remain broken.
- **Semantic Child usefulness checks.** These would impose a benchmark
  interpretation on research and exploration results that belongs to the
  Agent and the Task contract.
- **A numeric eligible utilization hard gate.** A fixed threshold hides the
  difference between available work, task shape, and Scheduler behavior.

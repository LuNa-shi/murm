# Issue #30 Scheduler and reusable Core spec

## Problem Statement

After a Root Agent creates Child Tasks, SwarmEnv does not reliably keep its
reusable Core slots supplied with work. A valid real-Agent Experiment can
therefore spend long periods with idle capacity while Child Tasks wait for
dispatch, parent review, notification, or follow-up work.

The current reports show useful lifecycle facts, but the existing collaboration
scenario can preassign a permanent role and Child ID to each Core. That makes
it difficult to distinguish production queue behavior from a test adapter's
fixed choreography. The acceptance contract also needs to distinguish a lack
of available independent work from a Scheduler or lifecycle failure.

## Solution

Repair and verify the production scheduling lifecycle through three
deterministic test scenarios:

1. Root decomposition creates Child Tasks at runtime and the production queue
   supplies them to Workers.
2. A pre-existing queue of independent Tasks is consumed and reused by idle
   Cores without requiring Root synthesis.
3. Two waves of Tasks exercise Core reuse, parent review, notification, wait,
   rework, and Root result consumption.

The scenarios use the production Task Service, Runtime, queue claim, release,
wake, parent-review, and observation paths. The test Agent behavior is chosen
from the Task actually claimed, so a Core can perform different work during
one Experiment.

The report keeps the existing full-run parallelism metrics and may add
recomputable eligible-window intervals. Eligible metrics explain parallel
supply and actual overlap; they do not become a numeric hard gate. Dispatch
timing remains a simple diagnostic based on existing lifecycle facts and does
not receive a new domain metric or hard gate.

Each expected Child publishes a result and the Root reads that result. The
Runtime records this collaboration protocol. It does not decide whether a
research result is semantically useful or whether it must appear in a final
Lean theorem.

## User Stories

1. As a Root Agent, I want to create direct Child Tasks during my Execution,
   so that decomposition is produced by the actual Agent workflow.
2. As a Worker Agent, I want to claim whichever ready Task is available, so
   that my Core slot remains reusable across different responsibilities.
3. As a Scheduler, I want a newly created Child Task to become visible through
   the normal Task list, so that idle Cores can consume it.
4. As a Scheduler, I want to release physical Core capacity when an Execution
   waits, succeeds, fails, or is fenced, so that another ready Task can use the
   slot.
5. As a Scheduler, I want parent-review waiting to preserve the Child's
   responsibility while releasing its Core, so that unrelated ready work is
   not blocked.
6. As a Worker Agent, I want to receive the Task and Execution I actually
   claimed, so that the behavior for the work follows the durable contract.
7. As a Root Agent, I want to receive a durable Child result notification, so
   that I can decide when and how to review it.
8. As a Root Agent, I want to read every expected Child result, so that my
   context includes all work delivered by the scenario.
9. As a research Child Agent, I want to publish a result that may be useful as
   context without being forced into the final proof, so that exploration can
   remain open-ended.
10. As a proof Child Agent, I want to submit an artifact according to my Task
    contract, so that the configured Judge can provide ordinary feedback.
11. As a Parent Agent, I want to accept a Child result after parent review, so
    that a satisfied Child can reach its terminal state.
12. As a Parent Agent, I want to request focused rework from a Child waiting
    for parent review, so that the Child can continue from its checkpoint.
13. As a Parent Agent, I want valid parent rework to preserve the existing
    Execution and Workspace lineage, so that rework remains a continuation of
    the same responsibility.
14. As a Runtime, I want expired or fenced work to follow the existing recovery
    policy, so that stale ownership cannot write through a new owner.
15. As a Scheduler operator, I want to distinguish ready work, waiting work,
    idle capacity, Agent turns, Judge time, and parent review, so that a low
    utilization report has an explainable cause.
16. As a benchmark operator, I want eligible intervals to be recomputable from
    recorded Task and Core events, so that parallelism reports can be audited.
17. As a benchmark operator, I want a run with insufficient independent work
    to report a supply condition, so that it is not misclassified as a
    Scheduler failure.
18. As a benchmark operator, I want the full-run parallelism metrics retained,
    so that the new supply-aware report remains comparable with earlier runs.
19. As a benchmark operator, I want dispatch timing summarized with existing
    lifecycle evidence, so that a simple delay report can reveal an actual
    polling or wake bug without creating a new metric contract.
20. As a benchmark operator, I want Gate B to test queue consumption without
    Root synthesis, so that Scheduler failures are isolated from proof failures.
21. As a benchmark operator, I want Gate A to start with only a Root Task, so
    that pre-created Child Tasks cannot hide decomposition failures.
22. As a benchmark operator, I want Gate C to run two waves of work, so that
    Core reuse after the first wave is observable.
23. As a benchmark operator, I want a Core that completed one Task to be able
    to claim a different later Task, so that reuse is tested by actual claims.
24. As a benchmark operator, I want parent review and unrelated ready work to
    coexist, so that review does not serialize the whole queue.
25. As a benchmark operator, I want notification creation, delivery, and Root
    consumption to be observable, so that a missing handoff can be diagnosed.
26. As a benchmark operator, I want the scenario's substantive work to be
    more than a trivial calculation, so that the test exercises meaningful
    multi-step Task behavior.
27. As a benchmark operator, I want no fixed edit count or wall-clock quota,
    so that the scenario does not reward cosmetic Workspace changes or sleep.
28. As a benchmark operator, I want semantic usefulness of a Child result left
    to the Agent and Task contract, so that scientific exploration is not
    judged by a narrow automated notion of contribution.
29. As a benchmark operator, I want Task ID, Execution ID, Workspace lineage,
    lease, fencing, and quota facts retained, so that ownership remains
    auditable.
30. As a benchmark operator, I want no new generic fingerprint or semantic
    deduplication policy, so that similar research outputs are not treated as
    protocol failures.
31. As a benchmark operator, I want a `parallel_quota = 1` scenario to reject
    excess active ownership, so that double execution of one responsibility is
    still visible.
32. As a maintainer, I want deterministic lifecycle tests to use the same
    public Service and Runtime seams as production, so that passing tests are
    meaningful evidence of the deployed path.
33. As a maintainer, I want existing wait/resume and rework contracts preserved,
    so that the scheduler repair does not change established Task semantics.
34. As a maintainer, I want real-Agent observations kept separate from the
    deterministic Scheduler gates, so that model decomposition ability is not
    confused with queue correctness.

## Implementation Decisions

- The primary implementation seam is the benchmark Runner boundary that
  starts an Experiment and returns its sanitized report. It uses the real
  Task Service, Runtime, Core slots, production queue claim path, release path,
  wake path, parent-review path, and observation path.
- The three deterministic test scenarios are setup and Agent-behavior
  descriptions. They do not implement an alternative Scheduler.
- Workers choose their behavior from the Task they actually claim. Core ID is
  not a permanent work assignment and a Worker can claim multiple Tasks over
  one Experiment.
- Gate A begins with one Root Task. The Root Agent creates the expected Child
  Tasks during its Execution. The Runner does not pre-create those Children.
- Gate B begins with a known queue of independent Tasks. It verifies queue
  consumption, capacity release, and reuse without requiring a Root synthesis.
- Gate C has two waves of Tasks. It verifies that a Core released by terminal
  work or parent-review waiting can claim later unrelated work.
- Parent-review waiting releases physical Core capacity while preserving the
  Child Task, checkpoint, Workspace lineage, and responsibility. A matching
  parent accept or rework action wakes the Child through the existing contract.
- Valid `request_rework` on a waiting `parent_review` Execution preserves the
  same `execution_id`, Workspace lineage, and checkpoint lineage, increments
  the instruction version, and records the steer Material. Expired or fenced
  Executions use the existing recovery behavior.
- Child results are delivered through the existing Context Service and
  notification/lifecycle evidence. The scenario verifies that the Root reads
  each expected result. It does not verify semantic usefulness, direct use in
  a theorem, or outcome quality.
- Child scenarios contain substantive multi-step work and are not trivial
  arithmetic placeholders. No fixed Workspace edit count, minimum duration,
  sleep, or empty turn is an acceptance requirement.
- Existing full-run `mean_active_core_count`, `agent_time_utilization_v0`,
  Core state intervals, Agent turn intervals, ready-work observations, waiting
  time, Judge time, and lifecycle events remain available.
- The report may record eligible windows. An interval is eligible when the
  scenario records enough independent, unfinished work for the configured
  Core capacity to execute concurrently; READY, assigned-before-first-turn,
  and RUNNING work can supply the interval. Parent-review waiting, blocked
  dependencies, final aggregation, and absent work do not supply it.
- Eligible intervals are interpreted from Task and scheduler facts rather than
  from the observed RUNNING count. This prevents Scheduler underuse from
  defining away its own evidence.
- Eligible metrics are reportable and recomputable. A fixed value such as 3.0
  is not a hard gate. A real problem with no eligible interval reports the
  supply condition rather than a numeric Scheduler failure.
- Dispatch timing is summarized with existing ready, claim, Core state, and
  Agent turn events. The Issue does not introduce a new dispatch-latency term,
  P95 hard gate, or separate Scheduler implementation.
- Task ID, Execution ID, Workspace lineage, lease, fencing, and
  `parallel_quota` remain the identity and ownership contract. The Issue does
  not add or expand generic fingerprint, `duplicate_of`, or semantic
  deduplication behavior.
- The deterministic scenarios may use a scripted Agent adapter and configured
  checker to make lifecycle outcomes stable. This adapter controls Agent
  behavior at the public boundary while the production Runtime and Services
  execute the lifecycle.
- Real-Agent B4/B1 observations remain follow-up evidence. They are not
  required to establish the deterministic Scheduler behavior and do not become
  a solve-rate or speedup gate in this Issue.

## Testing Decisions

- Tests observe behavior through the benchmark Runner and existing public
  Service/Runtime boundaries. They do not assert private scheduler helper
  calls or reconstruct behavior from an internal database when a public report
  or event is available.
- Gate A integration coverage verifies that the initial project contains only
  the Root, the Root creates Children, Workers claim actual Children, and the
  Root reads every expected Child result.
- Gate B integration coverage verifies that pre-existing Tasks are consumed by
  the production queue, released capacity is reused, and no Root synthesis is
  required for the scenario to complete.
- Gate C integration coverage verifies two waves, Core reuse across different
  Task IDs, mixed parent-review and unrelated ready work, notification and
  Root consumption, accept, rework, wait/resume, and final scenario cleanup.
- Existing Task Service integration coverage remains the prior art for valid
  parent rework preserving an Execution, fenced recovery creating a new
  Execution, wait/resume lineage, and quota/ownership errors.
- Existing parallelism coverage remains the prior art for non-overlapping Core
  state intervals, explicit Agent turn intervals, full-run metrics, and
  recomputation from report evidence. New eligible-window reporting is tested
  with worked deterministic intervals rather than a numeric production
  success threshold.
- The report must include enough identifiers and event facts to verify Child
  publication, Root reads, claim ownership, Core reuse, wait/wake operations,
  and parent-review outcomes without exporting raw transcripts or proof
  contents.
- No test evaluates whether a Child result was semantically useful, appears in
  the final Lean theorem, or duplicates another research route.
- No test requires a fixed number of Workspace writes, a minimum duration, or
  an artificial delay.
- Validation includes the focused lifecycle tests, the complete `npm test`
  suite, and `git diff --check`.

## Out of Scope

- A numeric hard gate for eligible average Core count, including `3.0`.
- A new dispatch-latency domain term, P95 hard gate, or polling performance
  score.
- A semantic judge for whether a Child result was useful to the Root.
- A requirement that every Child result appear in the final theorem or proof
  source.
- Fixed Core-to-Task roles, a separate test Scheduler, or pre-created Gate A
  Children.
- Fixed Workspace edit counts, minimum wall-clock durations, sleep-based
  workload padding, or cosmetic Agent turns.
- Generic semantic fingerprinting, `duplicate_of` hard gates, or a new
  deduplication service.
- Real-Agent solve rate, four-Core speedup, or B4/B1 mathematical quality as
  Issue #30 acceptance gates.
- A redesign of Task, Execution, Workspace, Material, Judge, or Service
  boundaries already established by the accepted ADRs.

## Further Notes

The existing full-run parallelism report remains useful for comparing
Experiments. Eligible windows add context about whether parallel supply was
present; they do not replace the existing report or turn one numeric value into
a claim about Scheduler correctness.

The deterministic scenarios should make failures explainable in terms of
Task creation, queue visibility, claim, Core release, notification, parent
review, wake, Root read, and ownership. A failed real-Agent decomposition is
reported as an observation about that Agent and problem, while the production
Scheduler gates continue to be evaluated through the deterministic scenarios.

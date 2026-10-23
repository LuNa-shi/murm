# Issue #33 analysis framework

This document defines the analysis contract for the long-run PutnamBench
experiments. It turns the question “is this swarm collaborating well?” into
claims that can be recomputed from the existing Task Service, Runtime,
Context Service, Judge, Workspace, and Observation records.

## Research question

Under the same formalized problem, model route, toolchain, timebox, and total
resource budget, does the swarm produce more verified Root Task progress than a
paired root-only Agent, and can the event trace explain which collaboration
mechanism caused the difference?

The object being evaluated is the decision policy over durable state. The
number of Agents, the communication graph, and the queue are mechanisms that
may explain an outcome; they are not outcomes by themselves.

## Operational definition of good collaboration

A swarm has good collaboration when it satisfies all four conditions below:

1. **It preserves correctness and ownership.** Every claimed Execution,
   Workspace revision, Material, and CheckResult has valid provenance and
   lifecycle state. No stale owner can write, no wait condition is invented,
   and no process failure silently loses a responsibility.
2. **It creates verified global progress.** Work changes the Root Task's
   completion evidence through a trusted CheckResult, a parent-accepted child
   result, a durable parent review/rework transition, or a new failure fact
   that causes a subsequent route change. Local activity without a later
   parent or Judge consequence is recorded as activity, not progress.
3. **It converts information across boundaries.** A child result is delivered
   with provenance, read by the parent, and followed by an observable parent
   action. Delivery without consumption is a storage result; consumption
   without a later action is a read; only the full sequence is Handoff
   Conversion.
4. **It earns those gains at an acceptable cost.** The swarm is compared on a
   quality/time/resource Pareto surface. Coordination, waiting, dispatch, and
   Judge costs are visible so a higher success rate cannot be mistaken for an
   unbounded coordination win.

The first condition is a validity gate. The other three are measured as a
vector. We do not publish a weighted “swarm score.”

## Metric layers

### A. Outcome metrics

These are the primary endpoints for the 12-problem batch and any paired
baseline:

| Metric | Definition | Interpretation |
| --- | --- | --- |
| `root_pass_rate` | Root Tasks with an applied trusted `PASS` divided by valid runs | Direct solution quality |
| `time_to_root_pass_ms` | Start to first applied root `PASS` | Wall-clock efficiency; censored at the timebox when unsolved |
| `root_completion_rate` | Root Tasks whose completion contract is satisfied | Checks that a candidate was actually integrated and accepted |
| `valid_run_rate` | Runs with no audit or lifecycle integrity violation | Separates system failure from hard mathematics |

Report each question and the aggregate. For the aggregate, include the
per-problem values rather than only a mean because Putnam difficulty is highly
uneven.

### B. Verified progress metrics

These metrics describe progress before a root pass. They must be monotonic in
the event reconstruction and must not count a raw turn or file write twice.

| Metric | Count one unit when | Do not count |
| --- | --- | --- |
| `accepted_child_results` | Parent accepts a child result under the Task contract | Child creation or child termination alone |
| `converted_handoffs` | Parent consumes a specific child Material/revision/result and then performs a root-relevant action | Material publication without a consumer |
| `new_judge_evidence` | A new candidate snapshot receives a persisted CheckResult | Replaying the same request or snapshot |
| `route_change_after_failure` | A failed check or typed blocker is followed by a new child route, focused rework, or materially new candidate path | Repeating the same failed request |
| `root_path_revisions` | Root Workspace revision is later used by a candidate or parent acceptance/rework action | Exploratory writes never consumed by the root |

The report keeps these units separate. A `PASS` may be caused by a candidate,
workspace revision, and child result at once; it is counted once as an outcome
and the contributing facts remain linked as evidence.

### C. Information-flow metrics

These metrics answer whether Agents actually helped one another:

- `handoff_delivery_count`: child outputs with valid source Task and Execution
  provenance.
- `handoff_consumption_count`: delivered outputs explicitly read by a parent
  through Context or Workspace APIs.
- `handoff_conversion_rate`: conversions divided by deliveries, with an
  explicit zero-denominator value.
- `parent_review_rate`: child results ending in parent `accept_task` or
  `request_rework`, divided by reviewable child results.
- `useful_child_rate`: child results that are either accepted or converted into
  a later root candidate/revision, divided by child results delivered.
- `handoff_latency_ms`: child delivery to parent consumption, and separately
  parent consumption to parent action.

The two latency intervals are kept separate. A long first interval points to
retrieval or wake problems; a long second interval points to parent reasoning,
review, or route-selection problems.

### D. Scheduling and resource metrics

Existing metrics remain useful as diagnostics with precise interpretation:

- `agent_time_ms` and `agent_time_utilization_v0`: Runtime-recorded Agent turn
  occupancy, excluding `WAITING`, polling, and Judge-only intervals.
- `ready_to_assigned_ms`: measured only during a dispatch opportunity where a
  Core is available. Queueing while all Cores are occupied is capacity demand,
  not automatically scheduler delay.
- `wait_condition_to_wake_ms`: typed condition becoming true to the matching
  wake/resume event.
- `eligible_window_ms` and `eligible_mean_active_core_count`: supply-aware
  parallelism diagnostics. Zero means insufficient observed independent work,
  not a scheduler failure.
- `judge_time_ms`, `scheduler_poll_ms`, and explicit Service call counts:
  component costs that explain wall-clock behavior.

The runner persists each ready queue sample with `ready_count`,
`idle_core_count`, `eligible_work_count`, and a reason for any unassigned
interval. The current reason vocabulary is `discovery_latency`,
`long_agent_turn`, `available_core_dispatch`, `missing_wake_resume`,
`stale_list_or_claim_conflict`, `insufficient_decomposition`, and
`unclassified`. These are runtime classifications backed by state at the
sample time; they are diagnostic evidence and do not claim that a mathematical
route was useful.

Raw utilization is never called useful utilization unless it is paired with
verified progress or a valid baseline comparison. Overlapping duplicate work
is retained as occupancy but cannot be counted twice as progress.

### E. Reliability and failure metrics

These are hard gates or failure explanations:

- provenance, workspace-boundary, fencing, and input-snapshot violations;
- process exits, turn timeouts, protocol errors, and unrecoverable tool errors;
- claim conflicts, stale-list races, duplicate ownership, and lost wakeups;
- active Tasks without a live or resumable Execution;
- satisfied wait conditions that remain unclaimed;
- child results waiting for parent review beyond the configured review window;
- repeated failed checks without a route change or explicit bounded retry.

Claim conflict is a diagnostic event, not automatically an invalid run when the
losing worker receives recoverable feedback and the Task is subsequently
claimed exactly once. A repeated conflict storm or lost responsibility is a
reliability failure.

## Trace reconstruction order

Analysis must use event order and facts available at the decision time:

1. Pin run identity, repository commit, dirty state, model/provider, checker,
   problem hash, timebox, and resource configuration.
2. Reconstruct Core lanes and Execution segments from Runtime observations.
3. Reconstruct Task and Execution state transitions from Task Service facts.
4. Link Materials, Workspace revisions, and CheckResults by source Task,
   source Execution, snapshot hash, and operation order.
5. Identify deliveries, reads, parent actions, and Judge transitions.
6. Classify every ready-work interval as dispatch opportunity, occupied
   capacity, discovery/turn occupancy, wait/wake delay, stale conflict, or
   insufficient supply.
7. Produce per-problem metrics, time-sliced progress curves, and a paired
   baseline comparison.

Later events cannot be used to justify an earlier decision. A final successful
   Material may explain why a route was good, but it cannot retroactively make
   an earlier task selection appear informed.

## Long-run checkpoints

The 8-hour run is sampled at 15 minutes, 1 hour, 4 hours, and 8 hours. Each
checkpoint records the same vector:

- root status and first trusted check;
- Task tree and Execution states;
- deliveries, consumptions, conversions, reviews, and reworks;
- candidate/check verdict sequence and route changes;
- Agent, waiting, dispatch, wake, Judge, and coordination costs;
- integrity and recoverability findings.

The final report includes the complete run plus these checkpoints. This makes
it possible to distinguish early progress followed by stagnation from a slow
but healthy long-run search.

## Iteration rules

An iteration must name the failure mechanism it targets and its expected
metric movement before changing code:

- discovery or dispatch change → lower opportunity-conditioned
  `ready_to_assigned_ms` without increasing claim conflicts;
- handoff or retrieval change → higher consumption and conversion rates;
- parent review change → lower consumption-to-action and child-review latency;
- route-change policy → shorter failure-to-route-change latency and fewer
  repeated failed snapshots;
- resource policy → improved outcome or verified-progress rate at equal total
  resource cost.

If a change improves utilization but leaves root outcome, converted handoffs,
and verified progress unchanged, it is a capacity observation, not evidence of
better collaboration. If a change improves a metric only by increasing total
budget, report it as a cost-quality trade-off rather than a universal gain.

## Required comparison

At least one representative problem receives a root-only baseline with the
same model, formalization, checker, timebox, and resource budget. The baseline
is compared on root pass, time-to-first-check, new Judge evidence, root-path
revisions, and total Agent/Judge/coordination cost. The full 12-problem swarm
run alone can characterize behavior, but it cannot establish a swarm advantage.

The benchmark CLI exposes this control as `--collaboration-mode root-only`.
It keeps the four-Core resource boundary and the same registered Service
surface, while removing `task_create_child` from the Agent tool allowlist and
rejecting direct child creation at the bridge. The default `swarm` mode keeps
the normal bounded decomposition path. The offline analyzer is
`scripts/analyze-putnambench-run.mjs`; it writes a sanitized JSON and Markdown
vector from reports, project SQLite facts, and local service logs.

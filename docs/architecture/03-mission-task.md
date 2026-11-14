# 03. Mission and Task

## Mission

Issue #122 introduces a Mission-level public Workspace alongside the Mission
record. The IDs are distinct and one-to-one; the Workspace owns the persistent
Git repository and `main`, while Mission submission owns the final acceptance
freeze. `MissionSubmissionStore` snapshots `main_revision`, selected immutable
Material IDs, checker/environment and acceptance configuration. Only one
submission can be pending. A failed or timed-out result releases its own
freeze; a late result is tied to its original submission and cannot alter a
newer one. A passing result records the exact accepted submission and moves the
Mission to its terminal accepted state.
[MissionSubmissionStore](../../src/runtime/mission-submission.js)

The persisted Mission record contains its `goal`, `acceptance_conditions`, `created_by` and timestamps (`src/storage/schema.js` and `TaskService.#createMission`). Initial Materials are separate Context/Task facts; model, timebox, checker and budget parameters are supplied by the benchmark/runtime configuration and/or Task contracts, not persisted as `missions.initial_material` or `missions.resource_scope` columns. Mission is not a permanent manager Agent.

The current flat implementation has no shared Mission Task special case. A Mission may start with zero Tasks while Bots read public state and propose independent Tasks. Mission itself is never taken; each ordinary Task is exclusively owned through `task_take` and ends through `task_finish`.

## Ordinary Task

An ordinary Task is a bounded, separable responsibility with a goal, expected
output, acceptance conditions, optional capability requirements, provenance and
an evidence delivery path. It normally has one effective Execution at a time.
The `spawned_from` field explains origin; it does not create parent approval or
management authority.

The current Agent-facing operations are principally:

- `task_list`, `task_view`, `task_status` for authoritative work state;
- `task_create` for a genuinely independent responsibility, followed by `task_take` in a fresh Execution;
- `task_take` for active identity/Core acquisition;
- `task_feedback` for one Execution's decision on a notification;
- `execution_progress` for checkpoint or handoff;
- `task_finish`, `task_finish(outcome=blocked)`, `task_finish(outcome=cancelled)` at the appropriate contract
  boundary.

A Task proposal does not switch the current Execution. The proposing Bot remains on its current Task boundary, and a fresh Bot later calls `task_take` for the new eligible Task. See `src/agent/services-bridge.js` and `src/task/task-service.js`.

In the **flat Mission Task registration path** no fixed numerical Task-count admission quota is enforced; distinct responsibility and key/idempotency checks still apply. Task counts, takes, handoffs and readiness intervals are observation metrics, not proof of useful work. Core/model capacity, total budget, tool timeouts and the single Execution timebox remain runtime limits.

## Material and completion

Task Service and Context Service keep the responsibility and evidence layers
separate. A child/ordinary Task can publish a Response or Experience Material;
the receiving Task may read it, consume it, link it, accept it, reject it, or
defer a decision. Publication or consumption alone does not prove downstream
usefulness.

Task completion, consumer acceptance, Workspace artifact PASS and Mission completion are
four different facts. A report must state which one was observed.

## Accepted finish and safe release

`task_finish` validates the current owner, Execution/spec/state/fence and one of
`done`, `incomplete`, `blocked`, or `cancelled`. In one SQLite transaction it
stores an `execution_finish_intents` row keyed by Execution and unique request
ID, any new `depends_on` edge, and the replacement pointer when supplied. The
Execution becomes `CLOSING`; the Task remains `RUNNING`, and the Execution still
occupies its Bot, Core and Task for take eligibility. A new Task contribution or
Context publication/consumption/correction using that Execution is rejected,
even if its caller refreshes the state versions. Existing committed Materials
are retained.

- `done` checks explicit completion-contract requirements and supplied
  Material/CheckResult references. An empty machine-readable contract does not
  invent a compulsory linked Material. This trusts the Bot's completion claim
  against its textual contract; it does not establish scientific correctness.
- `incomplete` may include a handoff Material but does not require one.
- `blocked` requires a reason/blocker and a same-Mission, non-cancelled Task.
  `wait_for` accepts a Task ID or the existing typed Task reference. A new edge
  joins the same modern dependency graph as creation-time `depends_on`; it is
  added without removing existing edges, with cycle checks spanning current and retained historical edges and rollback
  on any validation failure. Only `DONE` satisfies this graph's prerequisites.
- `cancelled` requires a reason. Its optional replacement may already be done,
  but must be a different, non-cancelled Task in the same Mission and must not
  create a replacement-chain cycle. This pointer does not redirect dependents
  or satisfy their prerequisites.

After commit Task Service emits `execution_finish_accepted`. The Runtime that
owns the Bot independently starts physical cleanup, so disappearance of the
finish CLI does not cancel the accepted request. It stops the whole Session
(including compatibility reusable Sessions for this finish path) and confirms
Sandbox deletion. Failure retains its Core/process binding and the durable
`CLOSING` owner. Runtime performs bounded delayed retries independently of its caller. After retry exhaustion, an explicit Runtime `sweepExpired()` call and the benchmark cleanup sweep can retry closing as well as terminal Executions; exhaustion never releases ownership. See [02 Execution](02-execution.md).

Only the trusted, non-Agent `finalizeExecutionFinish` seam completes the
transition after Runtime confirms isolation. Its transaction requires the same
Execution/fence, a still-running Task and no other active owner. It records the
close time, advances the fence, closes the Execution and projects Task state:
`DONE`, `CANCELLED`, or `OPEN`/`BLOCKED` recomputed from all effective dependencies.
A prerequisite that finishes during cleanup can therefore make a blocked result
immediately eligible. Finalization also reconciles direct dependents and emits a committed public change that wakes no-work discovery loops. Repeating a completed finalization makes no further Task
changes and cannot clear a successor's ownership.

The original finish receipt remains an accepted `closing` receipt. Replaying
its request ID with the same actor, Task, Execution, spec and payload returns
that receipt, even with refreshed state/fence versions; changed content or
identity conflicts. Exact old-format receipts also replay with their original envelope fingerprint. `getExecution` includes its persisted finish, and
`task_view.finishes` returns finish history with accepted/closed timestamps.
These records distinguish accepted cleanup from completed cleanup. A new
Runtime without a known resource binding refuses to finalize merely because
its in-memory process map is empty. Provider/Bot identity reconstruction across
process loss remains a separate migration; persistent intent currently prevents
premature retake rather than guaranteeing automatic recovery.

The lifecycle tests exercise real Task/Context services, reopening and migrating
SQLite stores, dependency rollback, request replay and trusted finalization.
Runtime cleanup tests add actual Runtime/Workspace/Bridge/benchmark composition
with controlled model/provider boundaries. They do not establish deployed
Sandbox isolation or autonomous research behavior.

## Feedback

Feedback belongs to a Task and may target a concrete Execution. Every affected
recipient keeps its own delivery and handling state. A persisted notification
is not a receipt; a receipt is not proof of a changed research route.

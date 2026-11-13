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

The current flat implementation still identifies a shared Mission Task as the
first Task registered in a Mission. That is a compatibility path and does not
meet the Issue #122 target: Mission itself is never taken, and a Mission may
start with zero Tasks while Bots read public state, propose independent Tasks,
or exit normally. The target implementation must remove the first-Task
special case and keep Task ownership exclusive.

## Ordinary Task

An ordinary Task is a bounded, separable responsibility with a goal, expected
output, acceptance conditions, optional capability requirements, provenance and
an evidence delivery path. It normally has one effective Execution at a time.
The `spawned_from` field explains origin; it does not create parent approval or
management authority.

The current Agent-facing operations are principally:

- `task_list`, `task_view`, `task_status` for authoritative work state;
- `task_register` / `task_create` for a genuinely independent responsibility;
- `task_take` for active identity/Core acquisition;
- `task_feedback` for one Execution's decision on a notification;
- `execution_progress` for checkpoint or handoff;
- `task_complete`, `task_block`, `task_close` at the appropriate contract
  boundary.

`task_register` with `take: true` **attempts** a Runtime checkpoint of the current Execution before a same-lane switch. The old Execution is fenced and the new Task claimed atomically within a **Task Service database transaction**; the preceding Workspace/Progress save is separate and may return `save_failed`, which does not by itself abort the switch. Do not claim an all-or-nothing disk + database save. Registration without `take` leaves the Task for others; a direct `task_take` acquires an existing eligible Task. See `src/agent/services-bridge.js` and `src/task/task-service.js`.

In the **flat Mission Task registration path** no fixed numerical Task-count admission quota is enforced; distinct responsibility and key/idempotency checks still apply. Task counts, claims, handoffs and readiness intervals are observation metrics, not proof of useful work. Core/model capacity, total budget, tool timeouts and the single Execution timebox remain runtime limits.

## Material and completion

Task Service and Context Service keep the responsibility and evidence layers
separate. A child/ordinary Task can publish a Response or Experience Material;
the receiving Task may read it, consume it, link it, accept it, reject it, or
defer a decision. Publication or consumption alone does not prove downstream
usefulness.

Task completion, consumer acceptance, Candidate PASS and Mission completion are
four different facts. A report must state which one was observed.

## Feedback

Feedback belongs to a Task and may target a concrete Execution. Every affected
recipient keeps its own delivery and handling state. A persisted notification
is not a receipt; a receipt is not proof of a changed research route.

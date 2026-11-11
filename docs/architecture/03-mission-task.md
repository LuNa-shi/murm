# 03. Mission and Task

## Mission

A Mission stores the user's shared objective, original acceptance conditions,
initial material and resource scope. It is not a permanent manager Agent.

The shared Mission Task is the common research responsibility. Multiple
Executions may work on it. When no ordinary Task is suitable, an identity
continues the Mission instead of treating an empty ordinary-Task queue as
retirement or completion.

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

`task_register` with `take: true` checkpoints the current Execution and registers/switches to the new independent Task on the same Core lane. Registration without `take` leaves it for others; a direct `task_take` acquires an existing eligible Task. Verify the authorization and conflict behavior against `src/task/task-service.js` and `src/agent/services-bridge.js`.

There is no current task-count quota. Task counts, claims, handoffs and
readiness intervals are observation fields, not admission limits.

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

# 03. Mission and Task

## Mission

The normal runner initializes a Mission and its public Workspace, whose Git repository owns immutable revisions and `main`. Registered Bot final submission is still rejected with `SERVICE_NOT_READY`. The optional internal `MissionSubmissionStore` is a legacy JSON helper: it freezes a caller-selected revision and stores caller-supplied Material IDs, checker metadata and a verdict. It does not yet establish the approved trusted checker, exact immutable inputs, deadline/restart or cancellation guards. Its passing record is not sufficient evidence of Mission acceptance. The runner's final-result integration remains pending; it only reads existing submission state and does not synthesize a submission or verdict during report construction; [Workspace](05-workspace-continuity.md) describes the implemented merge boundary.

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
- `task_finish`, `task_finish(outcome=blocked)`, `task_finish(outcome=cancelled)` at the appropriate contract
  boundary.

An UNBOUND Bot can propose a distinct responsibility and take that Task itself. An ACTIVE Bot can propose another responsibility without switching its current E; it cannot take a second Task, and a later fresh Bot may take that proposal. Task proposal admission checks durable Bot state, Mission and current E within the mutation transaction after replay. A closing Bot cannot bypass that guard by omitting E, and an active Bot must supply its actual E; unbound proposals require a live selection deadline. Registered Bots use explicit save/publish/finish; the old `execution_progress` compound action is rejected. See `src/agent/services-bridge.js` and `src/task/task-service.js`.

In the **flat Mission Task registration path** no fixed numerical Task-count admission quota is enforced; distinct responsibility and key/idempotency checks still apply. Task counts, takes, handoffs and readiness intervals are observation metrics, not proof of useful work. Core/model capacity, total budget, tool timeouts and the single Execution timebox remain runtime limits.

## Task discovery pages

`swarm task list` dispatches the paged Task API. It accepts Mission, query, one state or a state array, availability, limit and cursor; a registered Bot's Mission is fixed by durable identity even on direct dispatch. The default page is 20 summaries and the public maximum is 100. Default states include ready, running, blocked and historical terminal states; lowercase semantic state names are accepted. Summary and expected output are capped at 1,000 characters each, with `truncated_fields`; results include spec/state versions, priority, readiness, current E ownership, dependency presence/satisfaction, block/cancellation reason and last update time. Full acceptance, relationships and Material content require Task view. Internal Controller/report `TaskService.listMissionTasks` remains a bounded full-record helper, distinct from public paged dispatch.

The first read fixes a creation high-water mark in `modern_task_records`. Pages scan its immutable insertion order, not mutable priority. An opaque continuation binds that window, normalized Mission/query/state/availability filters, last scanned position and start time. Changing filters or using another Mission's cursor rejects; changing page size is allowed. New Tasks created after the initial window require a new query. Task rows are not deleted by the service. Priority updates cannot reorder an in-progress scan. State and readiness are explicitly evaluated at each page read, so this is not a frozen historical Task-state snapshot; `started_at`, `read_at` and `membership` report that boundary. Read detail and take with current versions before acting.

A Mission-only index supports rowid-ordered reads. A materialized SQL window selects at most 501 raw Mission records; only the first 500 may be inspected, with the last row serving as continuation lookahead. State, text and availability filtering occurs after this bound, including when every record fails the filters. Dependency satisfaction uses indexed EXISTS queries rather than loading the full dependency graph. An empty page with `next_cursor` means the scan is incomplete. `truncated` describes remaining unvisited rows in this creation window, not all future work. The bounded scan never turns an unvisited later page into a claim that no related responsibility exists. No Task-count admission quota is introduced. Registered Bots cannot call the retired `list_tasks`, `list_eligible_tasks` or `list_executions` dispatch paths; the built-in catalog exposes only the current list/detail API. Trusted internal helpers remain for Controller/report compatibility.

Tests use 505 matching Tasks, including a low-priority responsibility on the sixth page. The real CLI follows continuation, reads that Task and takes it without creating a replacement. Another regression crosses 501 blocked matches, preserving continuation from an empty availability page.

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

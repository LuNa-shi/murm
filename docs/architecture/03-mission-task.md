# 03. Mission and Task

## Mission

The normal runner initializes a zero-Task Mission and its public Workspace. Final acceptance uses `createMissionCoordination` and the durable SQLite `MissionSubmissionStore`; the old caller-verdict JSON helper is no longer executable. A registered Bot calls `swarm mission submit --materials M1,M2` (or explicit `[]` for a files-only submission). Bridge supplies its durable Mission, Workspace, Bot, optional current Task/E and fence, and stable transport request ID. It rejects caller-supplied checker, acceptance, revision and identity. The Task-owned `mission_submit` grant must have been explicitly configured at trusted Bot registration. A bound submitter must also be before soft closeout. The service, rather than the Bot, selects current main and the configured checker.

The persisted Mission record contains its `goal`, `acceptance_conditions`, `created_by` and timestamps (`src/storage/schema.js` and `TaskService.#createMission`). Initial Materials are separate Context/Task facts; model, timebox, checker and budget parameters are supplied by the benchmark/runtime configuration and/or Task contracts, not persisted as `missions.initial_material` or `missions.resource_scope` columns. Mission is not a permanent manager Agent.

The current flat implementation has no shared Mission Task special case. A Mission may start with zero Tasks while Bots read public state and propose independent Tasks. Mission itself is never taken; each ordinary Task is exclusively owned through `task_take` and ends through `task_finish`.

## Ordinary Task

An ordinary Task is a bounded, separable responsibility with a goal, expected
output, acceptance conditions, optional capability requirements, provenance and
an evidence delivery path. It normally has one effective Execution at a time.
New proposals reject `spawned_from` and `spawnedFrom`, including explicit null. Stored historical relations and exact accepted request receipts remain readable; they neither create new hierarchy nor gate a take.

The current Agent-facing operations are principally:

- `task_list`, `task_view`, `task_status` for authoritative work state;
- `task_create` for a genuinely independent responsibility, followed by `task_take` in a fresh Execution;
- `task_take` for active identity/Core acquisition;
- `task_feedback` for one Execution's decision on a notification;
- `task_finish`, `task_finish(outcome=blocked)`, `task_finish(outcome=cancelled)` at the appropriate contract
  boundary.

An UNBOUND Bot can propose a distinct responsibility and take that Task itself. An ACTIVE Bot can propose another responsibility without switching its current E; it cannot take a second Task, and a later fresh Bot may take that proposal. Task proposal admission checks durable Bot state, Mission and current E within the mutation transaction after replay. A closing Bot cannot bypass that guard by omitting E, and an active Bot must supply its actual E; unbound proposals require a live selection deadline. Registered Bots use explicit save/publish/finish; the old `execution_progress` compound action is rejected. See `src/agent/services-bridge.js` and `src/task/task-service.js`.

`swarm task propose --base-revision R` and JSON `base_revision` select a fixed public Workspace revision. Task Service accepts the previous `workspace.revision` input and requires both fields to agree when supplied together. It stores the selector under `workspace.revision` and returns it as `base_revision` in the public Task. If omitted, Runtime resolves main during take. A fresh proposal using the same Mission and `responsibility_key` returns the existing Task only for matching contract content, including Workspace, Material input IDs, instructions, and prerequisites. Task Service compares fields retained in historical rows when their registration fingerprint predates this check. Changed inputs return `CONFLICT` before Task insertion. Exact request-ID replay still returns the original receipt.

In the **flat Mission Task registration path** no fixed numerical Task-count admission quota is enforced; distinct responsibility and key/idempotency checks still apply. Task counts, takes, handoffs and readiness intervals are observation metrics, not proof of useful work. Core/model capacity, total budget, tool timeouts and the single Execution timebox remain runtime limits.

## Task discovery pages

`swarm task list` dispatches the paged Task API. It accepts Mission, query, one state or a state array, availability, limit and cursor; a registered Bot's Mission is fixed by durable identity even on direct dispatch. The default page is 20 summaries and the public maximum is 100. Default states include ready, running, blocked and historical terminal states; lowercase semantic state names are accepted. Summary and expected output are capped at 1,000 characters each, with `truncated_fields`; results include spec/state versions, priority, readiness, current E ownership, dependency presence/satisfaction, block/cancellation reason and last update time. Full acceptance, relationships and Material content require Task view. Internal Controller/report `TaskService.listMissionTasks` remains a bounded full-record helper, distinct from public paged dispatch.

The first read fixes a creation high-water mark in `modern_task_records`. Pages scan its immutable insertion order, not mutable priority. An opaque continuation binds that window, normalized Mission/query/state/availability filters, last scanned position and start time. Changing filters or using another Mission's cursor rejects; changing page size is allowed. New Tasks created after the initial window require a new query. Task rows are not deleted by the service. Priority updates cannot reorder an in-progress scan. State and readiness are explicitly evaluated at each page read, so this is not a frozen historical Task-state snapshot; `started_at`, `read_at` and `membership` report that boundary. Read detail and take with current versions before acting.

A Mission-only index supports rowid-ordered reads. A materialized SQL window selects at most 501 raw Mission records; only the first 500 may be inspected, with the last row serving as continuation lookahead. State, text and availability filtering occurs after this bound, including when every record fails the filters. Dependency satisfaction uses indexed EXISTS queries rather than loading the full dependency graph. An empty page with `next_cursor` means the scan is incomplete. `truncated` describes remaining unvisited rows in this creation window, not all future work. The bounded scan never turns an unvisited later page into a claim that no related responsibility exists. No Task-count admission quota is introduced. Registered Bots cannot call the retired `list_tasks`, `list_eligible_tasks` or `list_executions` dispatch paths; the built-in catalog exposes only the current list/detail API. Trusted internal helpers remain for Controller/report compatibility.

Tests use 505 matching Tasks, including a low-priority responsibility on the sixth page. The real CLI follows continuation, reads that Task and takes it without creating a replacement. Another regression crosses 501 blocked matches, preserving continuation from an empty availability page.

A registered Bot's `task status` shows exact aggregate state counts and two bounded previews, one for the requested states and one for ready Tasks. If the ready preview is incomplete, `counts.eligible` is null and `eligible_page` gives the returned count and completeness. The preview limit is 100 and further discovery uses `task list`. Trusted in-process reporting retains its own status counts and bounded detail list.

For a registered Bot, Task detail and Task mutation receipts use an explicit public Task projection. It includes the stable contract, state and versions, public input and Workspace selection, dependencies, Material links, and proposal actor, optional originating Task/Execution, and recorded time. The legacy parent/root columns and retired provenance relation remain readable through internal history interfaces. Task detail includes every Execution attempt, with the public input, timestamps, terminal reason, and accepted finish record when one exists. A failed startup without a finish is represented by that attempt and a null finish. At the final authenticated HTTP response boundary the Bridge also projects take/finish Execution receipts and Bot exit receipts. The successful take supplies the pinned public Workspace identity and manifest when Runtime has recorded them. Raw launch/resume tokens, prompt, controller Workspace descriptor and checkpoint references stay in trusted state. Internal Runtime callbacks and saved request receipts continue to use their full records.

The take receipt records the actual immutable Workspace input and exact Material inputs.
Runtime records the last Workspace revision sent to the same unbound Bot as its
discovery preview. Take resolves the Task's explicit revision or current main,
then compares the two fixed revisions. An input change returns a bounded page of
changed paths and a cursor, with `reread_required` so the Bot reads the pinned input
before continuing. The underlying file identity, exact Material IDs, versions and
content hashes, and preview comparison remain in the original take receipt.
The initial input hash used by Judge and reports commits to the immutable Task specification, the actual Workspace commit/tree/content and exact Material identities. Preview guidance is excluded from that identity.
The trusted Context Service validates actual Material content and same-Mission
provenance before Runtime activates the E. The take combines Task-declared IDs with caller-selected IDs, retaining the Task inputs even if the caller passes an empty list. Neither input path can supply a receipt's preview or content hashes.
Historical attempts without a recorded preview retain an unknown comparison.

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
Runtime uses the durable Bot/resource identity and Mission-scoped provider
reconciliation after process loss. It persists a uniquely recovered sandbox
identity before deletion and finalizes only after provider absence is confirmed.
An ambiguous create or deletion retains cleanup ownership. An empty in-memory
process map is insufficient to release the Task. See [Execution](02-execution.md)
for the restart procedure and its evidence.

The lifecycle tests exercise real Task/Context services, reopening and migrating
SQLite stores, dependency rollback, request replay and trusted finalization.
Runtime cleanup tests add actual Runtime/Workspace/Bridge/benchmark composition
with controlled model/provider boundaries. They do not establish deployed
Sandbox isolation or autonomous research behavior.

## Feedback

Feedback belongs to a Task and may target a concrete Execution. Every affected
recipient keeps its own delivery and handling state. A persisted notification
is not a receipt; a receipt is not proof of a changed research route.

## Proposal replay during closeout

For a registered Bot's Task proposal, the operation fingerprint excludes the volatile E state version while preserving Bot, Task/E identity, spec/fence and payload. This permits replay when a heartbeat or closeout reminder advanced the E version. Historical exact fingerprints remain accepted with their original envelope. A new request still passes durable Bot/Mission/binding, lease, hard deadline and soft-closeout checks; changing the payload under an accepted ID conflicts. An unbound Bot remains governed by its selection/hard budgets and does not acquire an E merely by proposing.


## Narrow coordination and repair

Task Service stores a frozen `coordination_permissions` list on each Bot. The trusted `registerBot` interface accepts only `unsupersede`, `task_cancel`, `task_dependency_replace` and `mission_submit`; the default is empty. Runtime forwards a trusted configuration list. The benchmark reads `mission_coordination_permissions` from its host configuration (or an explicit programmatic option), and startup context reports the actual grant. A CLI field, actor-name prefix or role label cannot grant permission. The synchronous authority check verifies the Bot's Mission, live UNBOUND/ACTIVE state, selection/hard deadline and, for ACTIVE, the exact current E, lease and fence. Closing or stopped Missions reject new coordination.

`swarm task cancel ID --expected-spec-version N --expected-state-version V --reason ... [--replacement ID]` requires its explicit grant and an unowned ready/blocked Task. It refuses any current CREATED/RUNNING/WAITING/CLOSING owner and preserves done history. A replacement must exist in the same Mission, be non-cancelled, and create neither a self link nor a replacement cycle. The state update and cancellation audit commit with the operation receipt. Identical requests replay, while fresh requests with stale observed versions conflict.

`swarm task dependency-replace ID --from-task-id OLD --to-task-id NEW --expected-spec-version N --expected-state-version V --reason ...` requires its own grant, an unowned blocked target, and an actually cancelled current prerequisite. The same-Mission replacement cannot be cancelled or create a dependency cycle. Only the specified logical edge changes; state_version advances even if other blockers remain, making it the repair CAS token. The original relation, author and reason remain in `task_dependency_replacements`. Historical TASK edges in `task_structure_dependencies` remain effective until explicitly repaired; if the same logical edge exists in both tables, both representations are retired and audited together, then one modern edge records the replacement. MATERIAL and CHECK_RESULT historical dependencies retain their own semantics. Task detail/list/take agree about these blockers and show invalid-prerequisite and replacement hints. A completed replacement can make the target ready; otherwise remaining blockers remain.

## Fixed Mission submissions and results

The submission store persists an authorized `preparing` receipt before asynchronous Workspace/Material reads. Same request ID returns that record; a different payload conflicts. One preparing, pending or accepted owner is permitted per Mission. Input preparation has a finite absolute deadline, capped by the run and configured checker timebox. Missing input, failure, timeout or main movement yields a durable error/timed_out receipt without starting the checker.

Mission creation stores the optional trusted `merge_required_check` separately from the final `acceptance_conditions.required_check`. An existing Mission row without a separate merge configuration is read as null. The final checker only evaluates a submitted Workspace snapshot; the [Workspace merge path](05-workspace-continuity.md) applies its own explicitly configured requirements. The normal Putnam Runner uses sparse research contributions to advance main through integrity, conflict, authorization and main-CAS checks while the final theorem may remain unresolved. Both the Runner's local controller registry and its default Bot capability registry use the same Mission submission store for authenticated status queries.

The registered Bot submit receipt and `swarm mission submission view` read the durable attempt and current Workspace under the Workspace freeze lock. Each receipt preserves the attempt's fixed main, Material selection, checker and result. `freeze_release_result` describes only that attempt's freeze. `current` reports when the service observed the Mission state, the live main revision, the actual freeze owner and whether the Mission-level merge gate is open. An old failed attempt can report `released` while a newer attempt holds the freeze. An open gate leaves the caller's own authorization, deadline and merge checks in force. Status reads leave the attempt and freeze undisturbed.

Preparation exports current main's entire immutable file tree and records each selected Material's immutable ID/version/hash plus its observed correction state. Freeze admission shares Workspace's repository lock with merge, then a SQLite writer transaction rechecks Bot authority, current Mission/checker policy and Material observations. It fixes main revision/commit/tree, the immutable manifest, checker/environment, submission identity, deadline and freeze epoch together. A durable intent precedes filesystem freeze publication. Every preparing-to-pending transition compares the still-current database state, so cancellation from another connection cannot be overwritten. Startup reconciliation converts interrupted preparation to an error and releases only its own freeze.

The trusted checker runs outside both locks. No caller can invoke `finish` with a verdict. PASS completion again checks current freeze owner/epoch/main, unchanged acceptance/checker identity, run deadline and Mission lifecycle within the commit boundary; a missing/throwing completion validator cannot accept. The persisted accepted row is the immediate new-work gate. A retryable `onAccepted` notification reports the accepted ID and requests ordinary shutdown; callback failure never thaws an accepted main. Existing E save/publish/finish permissions remain bounded by their original authorization, while new proposal/take/register/apply/merge/Judge work is denied. The runner derives scientific `solved` from persisted acceptance independently of `protocol_valid`; it never manufactures verdicts from its progress metrics.

A definite checker FAIL releases only this submission's freeze and is reused for the same full input/checker snapshot under a fresh request ID. Error/timeout is distinct from scientific failure; infrastructure retries require an explicit finite `maxInfrastructureRetries` (default zero) and persist attempt number/origin. Changed input can be checked separately. Late results retain bounded verdict/check identity/diagnostic and observed freeze identity in audit but cannot accept or alter a newer generation. Explicit cancellation is persisted before abort is signalled, preventing an abort handler's late PASS from winning.

Machine final checks additionally reserve a separate persistent Mission budget when the submission freeze is admitted. Defaults are four total attempts and one active checker adapter, including cancellation or timeout tails. Cached scientific outcomes do not reserve capacity. A changed submission snapshot and a reattempt after retryable infrastructure failure both use fresh capacity. A busy slot does not consume a scientific retry. The sole effective submission freeze is still enforced even when configuration permits more than one checker adapter for settling tails. Restart retains unresolved machine reservations. Manual review does not reserve machine process capacity.


`stop` fences new submission admission and cancels pending work, then waits for actual input reads, checker processes, cleanup and audit writes. Reporting deadlines do not settle these underlying promises. The benchmark joins this work under its one cleanup grace; if still pending it reports invalid cleanup and defers database close. Store-owned databases close only after real idle; injected connections remain owned by the runner. Reconciliation retries pending thaw/stop callbacks and expires orphaned checks without rerunning or charging them. The production coordinator shares the Task database while Context owns a separate database. Context mutations and the coordinator's snapshot revalidation serialize through the Task-owned writer window and synchronous service APIs. Independently hosted HTTP Services do not implement this atomic lifecycle boundary and reject affected writes.

### Manual Mission acceptance

A trusted in-process coordinator can explicitly configure `manualReview` when the Mission has no executable checker. The Mission's fixed `required_check` must match `manual-operator`, its policy version and review environment. Configuring a machine checker and manual review together fails. The same preparing, freeze, admission, deadline and acceptance guards apply. After admission, the adapter polls the owner-private SQLite decision ledger every 100 ms at most until the original cutoff or cancellation. Reconciliation can resume this read-only wait at the original cutoff. It never reruns a machine checker.

The operator's local command displays the fixed acceptance conditions and accepted input manifest, including revision/commit/tree/content hash, selected immutable Material versions and observed correction states, checker identity and freeze epoch. The operator supplies that exact snapshot fingerprint, PASS or FAIL, a reason, and an idempotency request ID. The command records the local OS identity and a copy of the manifest. One timely decision can be recorded per submission. A retry with identical input returns the original receipt. A changed decision under the same request ID conflicts. The command writes only the review ledger. Mission acceptance still requires the store's completion and freeze checks. A verdict recorded after cancellation or expiry remains in the audit ledger and cannot release or accept any freeze. Private reviewer metadata stays in that ledger. [Operator configuration](07-run-configuration.md)


### Accepted Mission closeout

A persisted PASS keeps the accepted main frozen and immediately blocks new Task proposals, takes, merge/apply and Judge work. The Runner fixes one closeout deadline at `min(run deadline, acceptance time + missionCloseoutMs)` (default 30 seconds). It stops selection loops and Controller and retains the original stop promise for final cleanup. Only already RUNNING Executions receive durable handoff reminders; a take still preparing its Workspace rechecks Mission state before activation and after asynchronous grant, and cannot hand a new active binding to its Bot after PASS. Existing work may save, publish useful increments and finish within its own remaining hard deadline.

Acceptance callback retries keep the original deadline, skip committed reminders and complete the remaining notifications before acknowledgement. New background maintenance promises append to the existing stop list. No active Execution means immediate transition to cleanup; cleanup still joins unbound or preparing resources and never marks unfinished Tasks done. Model requests admitted during closeout spend the reserved closeout allowance and stop at the earlier Bot, Execution, lease, Mission or closeout deadline.

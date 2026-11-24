# 03. Mission and Task

## Mission

A host can initialize a Mission and its public Workspace with zero Tasks. Final acceptance uses `createMissionCoordination` and the durable SQLite `MissionSubmissionStore`; the old caller-verdict JSON helper is no longer executable. A registered Bot calls `swarm mission submit --materials M1,M2` (or explicit `[]` for a files-only submission). Bridge supplies its durable Mission, Workspace, Bot, optional current Task/E and fence, and stable transport request ID. It rejects caller-supplied checker, acceptance, revision and identity. The Task-owned `mission_submit` grant must have been explicitly configured at trusted Bot registration. A bound submitter must also be before soft closeout. The service, rather than the Bot, selects current main and the configured checker.

The persisted Mission contains `goal`, `acceptance_conditions`, `merge_required_check`, creator and timestamps. Initial Materials remain separate Context/Task facts. Model, timebox, final-checker and budget configuration come from runtime composition; Mission is not a complete deployment snapshot. Public main and final-submission state have separate Workspace/submission records. Mission is not a permanent manager Agent.

The current implementation has no shared Mission Task special case. A Mission may start with zero Tasks while Bots read public state and propose independent Tasks. Mission itself is never taken; each ordinary Task is exclusively owned through `task_take` and ends through `task_finish`.

## Ordinary Task

Registered Bot proposals use `mission-gap-v1`; summary, gap and expected output are trimmed before validation and storage. `summary` is a nonblank short title (maximum 240 characters), `gap` describes the concrete local problem and Mission contribution (maximum 4000), `expected_output` describes the deliverable (maximum 4000), and nonempty `acceptance_conditions` retains its array/object form. These conditions are evidence requirements, not automatically executable checks. `priority` explicitly selects high/medium/low (integer aliases 2/1/0); the public `priority_level` names the level. Priority remains advice, with no mandatory highest-priority take. The durable Bot supplies Mission when omitted; a supplied different Mission is rejected. Creator, Execution provenance and timestamps are system records.

A live UNBOUND Bot can make several proposals and take an existing responsibility, and taking its own proposal is optional. An ACTIVE Bot can propose separately using its actual Execution authority. Every Task uses the `mission-gap-v1` contract with an explicit gap and priority.

### Contract revision and cancellation

`task_revise` takes `task_id`, `expected_spec_version`, `expected_state_version`, a nonblank `reason` (maximum 4000), and nonempty `changes`. Supported changes are summary, gap, expected output, acceptance conditions, priority, instructions, input Material IDs, Workspace selector (`workspace`/`base_revision`), and prerequisites (`depends_on`). A priority-only change uses the same operation.

After exact request replay, the transaction verifies live UNBOUND authority, no caller Execution binding, the same open Mission, and both observed Task versions. No extra coordination grant is required. The target must be OPEN or BLOCKED with no CREATED/RUNNING/CLOSING Execution; an ACTIVE/CLOSING Bot or unclosed finish intent also blocks changes. This protects take, preparation and physical cleanup. Historical completed attempts do not prevent revision once cleanup finalizes and the Task reopens. DONE/cancelled Tasks stay closed. ACTIVE callers finish through their existing Execution lifecycle rather than editing contracts.

The service trims summary, gap and expected output before checking bounds, hashing and storing their normalized text. It validates the complete resulting contract and same-Mission prerequisites, rejecting cycles before writes. New prerequisites cannot be cancelled; an already cancelled prerequisite may remain during an unrelated revision and continues blocking the Task. It snapshots the old contract, writes changed fields and edges, advances spec/state versions, computes the new spec hash and registration fingerprint, reconciles readiness and appends the immutable new snapshot with actor/reason/time. Existing Execution spec/hash, CheckResults and Material production provenance are never rewritten. Stale update/take/cancel fails with `STALE_VERSION`. Exact request/payload replay returns the original receipt; changed payload under the same ID conflicts. Contract changes and replay receipt commit together, without process restart or lease extension.

Task view returns `contract_history` ordered by spec version. `contract_history_after_version` defaults to zero; `contract_history_limit` defaults to 50 and is bounded to 1..100. `contract_history_page` exposes `complete` and `next_after_version`. Execution history exposes its original spec version/hash. Cancellation preserves its original contract plus reason and optional replacement; a cancelled prerequisite remains unsatisfied.

Task Service accepts the canonical snake_case payload fields and exposes one `takeTask` host helper for the `task_take` operation. It does not translate camelCase payloads, private Workspace modes or predecessor selectors. Execution storage records immutable public inputs, ownership and lifecycle state; it has no wait/resume token, private checkpoint, instruction/session-generation or Workspace-selection compatibility fields. The current proposal validator and explicit `workspace_delivery` check remain authoritative.

An ordinary Task is a bounded, separable responsibility with a goal, expected
output, acceptance conditions, optional capability requirements, provenance and
an evidence delivery path. It permits exactly one active Execution at a time, including preparation and cleanup.
Task proposals contain no hierarchy fields. Stored contract revisions and accepted request receipts remain readable and do not create a Task hierarchy or gate a take.

The current Agent-facing operations are principally:

- `task_list`, `task_view`, `task_status` for authoritative work state;
- `task_create` for a genuinely independent responsibility, followed by `task_take` in a fresh Execution;
- `task_take` for active identity/Core acquisition;
- `task_revise` and `task_cancel` for UNBOUND adjustments of open, unowned responsibilities;
- `task_feedback` for one Execution's decision on a notification;
- `task_finish`, `task_finish(outcome=blocked)`, `task_finish(outcome=cancelled)` at the appropriate contract
  boundary.

An UNBOUND Bot can propose a distinct responsibility and take that Task itself. An ACTIVE Bot can propose another responsibility without switching its current E; it cannot take a second Task, and a later fresh Bot may take that proposal. Task proposal admission checks durable Bot state, Mission and current E within the mutation transaction after replay. A closing Bot cannot bypass that guard by omitting E, and an active Bot must supply its actual E; unbound proposals require a live selection deadline. Registered Bots use explicit Workspace save, Material publish/link and Task finish. See `src/agent/services-bridge.js` and `src/task/task-service.js`.

`swarm task propose --base-revision R` and JSON `base_revision` select a fixed public Workspace revision. Task Service accepts the previous `workspace.revision` input and requires both fields to agree when supplied together. It stores the selector under `workspace.revision` and returns it as `base_revision` in the public Task. If omitted, Runtime resolves main during take. A fresh proposal using the same Mission and `responsibility_key` returns the existing Task only for matching contract content, including Workspace, Material input IDs, instructions, and prerequisites. Task Service compares the complete current contract. Changed inputs return `CONFLICT` before Task insertion. Exact request-ID replay still returns the original receipt.

In the **Mission Task registration path** no fixed numerical Task-count admission quota is enforced; distinct responsibility and key/idempotency checks still apply. Task counts, takes, handoffs and readiness intervals are observation metrics, not proof of useful work. Core/model capacity, total budget, tool timeouts and the single Execution timebox remain runtime limits.

## Task discovery pages

`swarm task list` dispatches the paged Task API. It accepts Mission, query, one state or a state array, availability, limit and cursor; a registered Bot's Mission is fixed by durable identity even on direct dispatch. The default page is 20 summaries and the public maximum is 100. Default states include ready, running, blocked and historical terminal states; lowercase semantic state names are accepted. Gap and expected output are capped at 1,000 characters each (titles are at most 240), with `truncated_fields`; results include spec/state versions, priority, readiness, current E ownership, dependency presence/satisfaction, block/cancellation reason and last update time. Full acceptance, relationships and Material content require Task view. Internal Controller/report `TaskService.listMissionTasks` remains a bounded full-record helper, distinct from public paged dispatch.

The first read fixes a creation high-water mark in `task_records`. Pages scan its immutable insertion order, not mutable priority. An opaque continuation binds that window, normalized Mission/query/state/availability filters, last scanned position and start time. Changing filters or using another Mission's cursor rejects; changing page size is allowed. New Tasks created after the initial window require a new query. Task rows are not deleted by the service. Priority updates cannot reorder an in-progress scan. State and readiness are explicitly evaluated at each page read, so this is not a frozen historical Task-state snapshot; `started_at`, `read_at` and `membership` report that boundary. Read detail and take with current versions before acting.

A Mission-only index supports rowid-ordered reads. A materialized SQL window selects at most 501 raw Mission records; only the first 500 may be inspected, with the last row serving as continuation lookahead. State, text and availability filtering occurs after this bound, including when every record fails the filters. Dependency satisfaction uses indexed EXISTS queries rather than loading the full dependency graph. An empty page with `next_cursor` means the scan is incomplete. `truncated` describes remaining unvisited rows in this creation window, not all future work. The bounded scan never turns an unvisited later page into a claim that no related responsibility exists. No Task-count admission quota is introduced. The built-in catalog exposes only the current list/detail API.

Tests use 505 matching Tasks, including a low-priority responsibility on the sixth page. The real CLI follows continuation, reads that Task and takes it without creating a replacement. Another regression crosses 501 blocked matches, preserving continuation from an empty availability page.

A registered Bot's `task status` shows exact aggregate state counts and two bounded previews, one for the requested states and one for ready Tasks. If the ready preview is incomplete, `counts.eligible` is null and `eligible_page` gives the returned count and completeness. The preview limit is 100 and further discovery uses `task list`. Trusted in-process reporting retains its own status counts and bounded detail list.

For a registered Bot, Task detail and Task mutation receipts use an explicit public Task projection. It includes the stable contract, state and versions, public input and Workspace selection, dependencies, Material links, and proposal actor, optional originating Task/Execution, and recorded time. The projection contains only the current Task contract and its recorded provenance. Task detail includes every Execution attempt, with the public input, timestamps, terminal reason, and accepted finish record when one exists. A failed startup without a finish is represented by that attempt and a null finish. At the final authenticated HTTP response boundary the Bridge also projects take/finish Execution receipts and Bot exit receipts. The successful take supplies the pinned public Workspace identity and manifest when Runtime has recorded them. Launch tokens, prompt and controller Workspace descriptors stay in trusted state. Internal Runtime callbacks and saved request receipts continue to use their full records.

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

Task and Context keep responsibility and evidence separate. A Bot can publish immutable Material with producer provenance, link it to a Task, record consumption, or use dispute/supersede operations to correct public evidence. The current contract requires neither historical Response/Experience categories nor parent/child Tasks. Publication, linking and consumption record activity and provenance, not downstream usefulness.

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
  `wait_for` is the prerequisite Task ID. A new edge
  joins the same flat dependency graph as creation-time `depends_on`; it is
  added without removing existing edges, with cycle checks spanning current and retained historical edges and rollback
  on any validation failure. Only `DONE` satisfies this graph's prerequisites.
- `cancelled` requires a reason. Its optional replacement may already be done,
  but must be a different, non-cancelled Task in the same Mission and must not
  create a replacement-chain cycle. This pointer does not redirect dependents
  or satisfy their prerequisites.

After commit Task Service emits `execution_finish_accepted`. The Runtime that
owns the Bot independently starts physical cleanup, so disappearance of the
finish CLI does not cancel the accepted request. It stops the whole Session
(including the reusable Session for this finish path) and confirms
Sandbox deletion. Failure retains its Core/process binding and the durable
`CLOSING` owner. Runtime performs bounded delayed retries independently of its caller. After retry exhaustion, an explicit Runtime `sweepExpired()` call can retry closing as well as terminal Executions. Exhaustion retains ownership. See [02 Execution](02-execution.md).

Only the trusted, non-Agent `finalizeExecutionFinish` seam completes the
transition after Runtime confirms isolation. Its transaction requires the same
Execution/fence, a still-running Task and no other active owner. It records the
close time, advances the fence, closes the Execution and projects Task state:
`DONE`, `CANCELLED`, or `OPEN`/`BLOCKED` recomputed from all effective dependencies.
A prerequisite that finishes during cleanup can therefore make a blocked result
immediately eligible. Finalization also reconciles direct dependents and emits a committed public change that can wake discovery before the retry timer. Repeating a completed finalization makes no further Task
changes and cannot clear a successor's ownership.

The original finish receipt remains an accepted `closing` receipt. Replaying
its request ID with the same actor, Task, Execution, spec and payload returns
that receipt, even with refreshed state/fence versions; changed content or
identity conflicts. `getExecution` includes its persisted finish, and
`task_view.finishes` returns finish history with accepted/closed timestamps.
These records distinguish accepted cleanup from completed cleanup. The live
Runtime retains its Bot/resource binding through uncertain creation or deletion
and finalizes only after isolation is confirmed. A different Runtime without
that binding cannot stop or release the original owner; an empty in-memory
process map is insufficient to release the Task. The unused cross-process
Mission recovery entry has been removed. Durable receipts remain inspectable,
without an automatic process-recovery guarantee. See [Execution](02-execution.md)
for owned cleanup and its verification boundaries.

The lifecycle tests exercise real Task/Context services, reopening current
SQLite stores, dependency rollback, request replay and trusted finalization.
Runtime cleanup tests add actual Runtime/Workspace/Bridge composition
with controlled model/provider boundaries. They do not establish deployed
Sandbox isolation or autonomous research behavior.

## Feedback

Feedback belongs to a Task and may target a concrete Execution. Every affected
recipient keeps its own delivery and handling state. A persisted notification
is not a receipt; a receipt is not proof of a changed research route.

## Proposal replay during closeout

For a registered Bot's Task proposal, the operation fingerprint excludes the volatile E state version while preserving Bot, Task/E identity, spec/fence and payload. This permits replay when a heartbeat or closeout reminder advanced the E version. A new request still passes durable Bot/Mission/binding, lease, hard deadline and soft-closeout checks; changing the payload under an accepted ID conflicts. An unbound Bot remains governed by its selection/hard budgets and does not acquire an E merely by proposing.


## Narrow coordination and repair

Task Service stores a frozen `coordination_permissions` list on each Bot. The trusted `registerBot` interface accepts `unsupersede`, `task_dependency_replace` and `mission_submit`; the default is empty. Runtime forwards a trusted configuration list. A CLI field, actor-name prefix or role label cannot grant permission. The synchronous authority check verifies the Bot's Mission, live UNBOUND/ACTIVE state, selection/hard deadline and, for ACTIVE, the exact current E, lease and fence. Closing or stopped Missions reject new coordination.

`swarm task cancel ID --expected-spec-version N --expected-state-version V --reason ... [--replacement ID]` requires a live UNBOUND Bot in the same Mission and an unowned ready/blocked Task, with no extra grant. It refuses any current CREATED/RUNNING/CLOSING owner and preserves done history. A replacement must exist in the same Mission, be non-cancelled, and create neither a self link nor a replacement cycle. The state update and cancellation audit commit with the operation receipt. Identical requests replay, while fresh requests with stale observed versions conflict.

`swarm task dependency-replace ID --from-task-id OLD --to-task-id NEW --expected-spec-version N --expected-state-version V --reason ...` requires its own grant, an unowned blocked target, and an actually cancelled current prerequisite. The same-Mission replacement cannot be cancelled or create a dependency cycle. Only the specified logical edge changes; state_version advances even if other blockers remain, making it the repair CAS token. The original relation, author and reason remain in `task_dependency_replacements`. The current `depends_on` edge is replaced atomically and the replacement audit records the author and reason. Task detail/list/take agree about these blockers and show invalid-prerequisite and replacement hints. A completed replacement can make the target ready; otherwise remaining blockers remain.

## Fixed Mission submissions and results

The submission store persists an authorized `preparing` receipt before asynchronous Workspace/Material reads. Same request ID returns that record; a different payload conflicts. One preparing, pending or accepted owner is permitted per Mission. Input preparation has a finite absolute deadline, capped by the run and configured checker timebox. Missing input, failure, timeout or main movement yields a durable error/timed_out receipt without starting the checker.

Mission creation stores the optional trusted `merge_required_check` separately from the final `acceptance_conditions.required_check`. An existing Mission row without a separate merge configuration is read as null. The final checker only evaluates a submitted Workspace snapshot; the [Workspace merge path](05-workspace-continuity.md) applies its own explicitly configured requirements.

The registered Bot submit receipt and `swarm mission submission view` read the durable attempt and current Workspace under the Workspace freeze lock. Each receipt preserves the attempt's fixed main, Material selection, checker and result. `freeze_release_result` describes only that attempt's freeze. `current` reports when the service observed the Mission state, the live main revision, the actual freeze owner and whether the Mission-level merge gate is open. An old failed attempt can report `released` while a newer attempt holds the freeze. An open gate leaves the caller's own authorization, deadline and merge checks in force. Status reads leave the attempt and freeze undisturbed.

Preparation exports current main's entire immutable file tree and records each selected Material's immutable ID/version/hash plus its observed correction state. Freeze admission shares Workspace's repository lock with merge, then a SQLite writer transaction rechecks Bot authority, current Mission/checker policy and Material observations. It fixes main revision/commit/tree, the immutable manifest, checker/environment, submission identity, deadline and freeze epoch together. A durable intent precedes filesystem freeze publication. Every preparing-to-pending transition compares the still-current database state, so cancellation from another connection cannot be overwritten. Startup reconciliation converts interrupted preparation to an error and releases only its own freeze.

The trusted checker runs outside both locks. No caller can invoke `finish` with a verdict. PASS completion again checks current freeze owner/epoch/main, unchanged acceptance/checker identity, run deadline and Mission lifecycle within the commit boundary; a missing/throwing completion validator cannot accept. The persisted accepted row is the immediate new-work gate. A retryable `onAccepted` notification reports the accepted ID and may request host shutdown; callback failure never thaws an accepted main. Existing E save/publish/finish permissions remain bounded by their original authorization, while new proposal/take/register/apply/merge/Judge work is denied.

A definite checker FAIL releases only this submission's freeze and is reused for the same full input/checker snapshot under a fresh request ID. Error/timeout is distinct from scientific failure; infrastructure retries require an explicit finite `maxInfrastructureRetries` (default zero) and persist attempt number/origin. Changed input can be checked separately. Late results retain bounded verdict/check identity/diagnostic and observed freeze identity in audit but cannot accept or alter a newer generation. Explicit cancellation is persisted before abort is signalled, preventing an abort handler's late PASS from winning.

Machine final checks additionally reserve a separate persistent Mission budget when the submission freeze is admitted. Defaults are four total attempts and one active checker adapter, including cancellation or timeout tails. Cached scientific outcomes do not reserve capacity. A changed submission snapshot and a reattempt after retryable infrastructure failure both use fresh capacity. A busy slot does not consume a scientific retry. The sole effective submission freeze is still enforced even when configuration permits more than one checker adapter for settling tails. Restart retains unresolved machine reservations. Manual review does not reserve machine process capacity.


`stop` fences new submission admission and cancels pending work, then waits for actual input reads, checker processes, cleanup and audit writes. Reporting deadlines do not settle these underlying promises. Store-owned databases close after real idle. Injected connections remain owned by their caller. Reconciliation retries pending thaw/stop callbacks and expires orphaned checks without rerunning or charging them. The production coordinator shares the Task database while Context owns a separate database. Context mutations and the coordinator's snapshot revalidation serialize through the Task-owned writer boundary. The independent peer composition additionally persists a gate before issuing an HTTP write and releases it only after an exact terminal receipt; unresolved transport outcomes block competing coordinator writes. Standalone HTTP mutations without this protocol reject affected writes.

Mission coordination regressions exercise `createMissionCoordination` directly with real persistent Task and Context stores and a real Git-backed MissionWorkspace. They verify that independent contributions can merge before a final check, a failed check releases only its own freeze, and an old receipt reports a newer active freeze without releasing it. A separate case binds the trusted checker to current main and an explicit empty Material list, then verifies the accepted Mission's new-work gate through two SQLite connections. These domain checks do not require the legacy Runtime's Session factory or provider fixture. Thin CLI and ServicesBridge tests separately retain explicit Material parsing, trusted caller/scope injection, rejection of caller-selected checker fields and the observed submission projection. This coverage does not establish a native Core run or add Mission commands to flat.

### Manual Mission acceptance

A trusted in-process coordinator can explicitly configure `manualReview` when the Mission has no executable checker. The Mission's fixed `required_check` must match `manual-operator`, its policy version and review environment. Configuring a machine checker and manual review together fails. The same preparing, freeze, admission, deadline and acceptance guards apply. After admission, the adapter polls the owner-private SQLite decision ledger every 100 ms at most until the original cutoff or cancellation. If a competing owner-local writer temporarily prevents the read with SQLite BUSY or LOCKED, the next poll retries the same read within that original cutoff and cancellation signal; it does not reset either limit or turn contention into a checker verdict. Other database faults and invalid decision data still fail the checker. Reconciliation can resume this read-only wait at the original cutoff. It never reruns a machine checker.

The operator's local command displays the fixed acceptance conditions and accepted input manifest, including revision/commit/tree/content hash, selected immutable Material versions and observed correction states, checker identity and freeze epoch. The operator supplies that exact snapshot fingerprint, PASS or FAIL, a reason, and an idempotency request ID. The command records the local OS identity and a copy of the manifest. One timely decision can be recorded per submission. A retry with identical input returns the original receipt. A changed decision under the same request ID conflicts. The command writes only the review ledger. Mission acceptance still requires the store's completion and freeze checks. A verdict recorded after cancellation or expiry remains in the audit ledger and cannot release or accept any freeze. Private reviewer metadata stays in that ledger. [Operator configuration](07-run-configuration.md)


### Accepted Mission closeout

A persisted PASS keeps the accepted main frozen and blocks new Task proposals, takes, merge/apply and Judge work. A take preparing its Workspace rechecks Mission state before activation and after asynchronous grant. Existing work may save, publish and finish under its remaining authority. Task Service persists an explicit handoff reminder or deadline on an Execution and the shared soft-closeout guard controls new work after that point.

The submission store persists the accepted result before notifying the optional host callback. A failed acknowledgement leaves its notification pending for reconciliation. The caller owns any additional scheduling or close policy. The accepted result neither transfers a Bot to new work nor marks unfinished Tasks done.

Each Task permits exactly one active Execution, including CREATED preparation, RUNNING work and CLOSING cleanup. A second take fails with CONFLICT, `condition: task_occupied`, and the occupying Execution ID and state; the caller can choose another responsibility or wait for confirmed cleanup. There is no configurable parallel quota, Task type/version, retry policy or attempt limit. The only terminal Task states are DONE and CANCELED; Bot CLOSED is a separate lifecycle state. Capability requirements use only `required_capabilities`.

Material completion requirements count distinct Materials and may constrain the Task link role, minimum count, cross-Task producer and recorded consumption/action. Material type, scope and publication role are not predicates. A handoff reference must have current Task/Execution producer provenance and a durable `handoff` Task link; finish creates that link transactionally when needed.

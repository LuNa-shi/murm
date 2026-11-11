# 03. Mission, Tasks, Materials and completion

> As built: runtime code at `02adbb43d39e0b23befb7f2ffc4b19ffb386a36d`, reviewed against PR #116 head `086946893222c91f7844538d7f7af234faac361b`. This chapter describes the current flat Mission path and explicitly identifies compatibility behavior.

A Mission supplies a common research objective. Tasks describe responsibilities within it. An Execution is an authorized attempt to work on one responsibility. Materials hold results and evidence; links say where those results were delivered. Keeping these distinctions is necessary to understand why a busy Mission, a completed local Task and a checked final answer can have different outcomes.

## 1. Persisted Mission and Task records

### Mission

A Mission record contains exactly the following domain fields:

| Field | Source/default |
|---|---|
| `mission_id` | Caller value or generated UUID |
| `goal` | Required nonempty string |
| `acceptance_conditions` | Object/array, default `{}` |
| `created_by` | Authenticated operation actor |
| `created_at`, `updated_at` | Creation timestamps |

Mission creation cannot target a bound Task/Execution. A duplicate Mission ID conflicts. There is no persisted Mission state column, initial-Material column, resource-scope column, manager Agent or built-in Mission budget row. Materials are separate Context/Task facts. Model/checker/budget/runtime choices come from composition and Task contracts.

### Modern Task

Modern Tasks use the shared `tasks` table plus `modern_task_records` and relationship tables. The returned Task includes legacy storage fields; its flat meaning does not come from the presence of `root_id` or `parent_id`.

| Field | Current rule |
|---|---|
| `task_id` | Caller value or UUID; must be unique |
| `mission_id` | Required existing Mission; bound creation must stay in the caller's Mission |
| `summary` | Required; at least 20 trimmed characters and at most 4,000 characters |
| `goal` | Defaults to summary |
| `expected_output` | Required nonempty string |
| `acceptance_conditions` | Required nonempty object/array; descriptive conditions are not automatically evaluated as natural language |
| `task_type`, `task_type_version` | Defaults `task`, `1.0`; flat creation does not apply the legacy four-type registry validator |
| `timebox_ms` | Positive integer; default 3,600,000 ms |
| `priority` | Nonnegative integer; default 0 |
| `owner_ref` | Direct internal create can supply it; canonical registration forces the current actor |
| `task_instructions`, `workspace`, `input_material_refs` | Defaults empty string, `{}`, `[]` |
| `completion_contract` | Object used by the completion evaluator; defaults `{}` |
| `required_capabilities` | Optional deduplicated nonempty string IDs copied into completion contract |
| `responsibility_key` | Optional nonempty string of at most 256 characters; scoped to Mission |
| `spawned_from` | Optional same-Mission Task ID; provenance only |
| `depends_on` | Deduplicated same-Mission Task IDs; cycles/self-dependency rejected |
| `collaboration_reason` | Canonical registration records supplied nonempty string or `unspecified` |
| `spec_version`, `spec_hash` | Initial version 1 and hash of the stored specification projection |
| `state`, `state_version` | Initially `OPEN`, 0 |
| `created_by`, timestamps | Current actor and timestamps |

Modern storage sets `root_id=task_id`, `parent_id=null`, `parallel_quota=1`, `max_depth=0`, `max_children=0`, `max_attempts=1`, empty retry policy and no root deadline. Those legacy columns do not turn each modern Task into a manager of a parent/child tree.

Returned modern records also contain relations, linked Materials and blockers. Complete table definitions are reproduced in [11 Storage](11-storage-reference.md); tool input/output declarations are in [10 Service API](10-service-api-reference.md).

## 2. Shared Mission responsibility versus ordinary Task

The **first** `modern_task_records` row in a Mission, ordered by `created_at, rowid`, is the shared Mission Task. There is no `is_shared_mission_task` field. The row-order tie-break matters because timestamps have millisecond precision and random UUID order would be nondeterministic.

| Behavior | Shared Mission Task | Later ordinary Task |
|---|---|---|
| Concurrent Executions | Several Core-bound Executions may participate; its stored quota of 1 is bypassed | One effective active owner under the modern quota |
| Claimable while another Execution runs | Yes, while Task is `OPEN` or `RUNNING` | No |
| Dependency record | Visible as branch/context evidence, but excluded from aggregate claim gating | Gates claiming and reconciliation |
| One Execution hands off | Release that attempt; siblings remain valid | Return responsibility to `OPEN` |
| One Execution blocks | End only that branch; shared Task remains live/claimable | End current attempt and block whole responsibility |
| Last Execution releases | Shared Task projects `OPEN` | Usually `OPEN`, or `BLOCKED` for typed block |
| Completion | Semantic complete additionally checks declared Mission acceptance | Complete against local contract; a receiver can later close delivered output |

An ordinary Task with no `spawned_from` is still ordinary if it was not first. Conversely, creation order alone identifies the shared entry even if its summary does not describe a Mission. Startup must create the intended shared Task first.

Shared participation does not mean a shared mutable directory: each Execution has its own Workspace. No automatic global “latest branch” integration is implied.

## 3. Registration, deduplication and same-lane switch

### Register without taking

`task_register` records a bounded responsibility and provenance; `task_create` reaches the underlying creation seam. A bound creator needs a current `CREATED`/`RUNNING` Execution in the same Mission. Registration without `take` leaves the creator running and publishes the new Task for others.

There is no fixed Task-count admission quota in this flat creation path. Structural limits such as `max_unfinished_tasks` and `max_children_per_execution` belong to the legacy path. This does not mean duplicate identity or malformed Task input is accepted.

A responsibility key finds the earliest same-key Task in the Mission, including terminal Tasks. When its stored registration hash matches, creation returns the existing Task with `created:false`, `deduplicated:true`, key and current creator Execution information. Different hashed specification content conflicts rather than silently creating a second responsibility.

The modern registration hash covers Task/Mission identity projection, summary/type/goal/output, acceptance/completion contract, timebox, owner, priority, key and collaboration reason. It does not cover every creation input: dependency relations, Workspace/instructions and input Material arrays are not all part of that projection. Key equality is therefore not proof of byte-for-byte equality of all requested runtime setup.

### Register and take

`task_register({take:true,...})` is a same-Core switch:

1. Bridge attempts `executionProgress(kind:"checkpoint")` on the current Execution. This can return `save_failed`; that alone does not abort registration.
2. In one Task Service transaction, validate the caller owns a `RUNNING` Execution, create/deduplicate the new Task, set the old Execution to `FENCED` with reason `task_switch`, increment its fence, refresh its Task projection and claim the selected Task on the same Core.
3. The internal switch claim uses a clean Workspace and bypasses the fairness check for this transaction. It does not carry an implicit mutable copy of the old Workspace.
4. Return `task`, new `execution`, creation/provenance information and `switched_from:{task,execution}`.
5. Bridge performs Runtime detach, bookkeeping callbacks, release of old binding and bind of the new claim. These are outside the transaction.

If the new claim fails in the transaction, its database changes roll back together. The prior file/Progress save does not roll back. If later binding/callbacks fail, the old fence and new claim may already be durable; cleanup is compensating work. This is not an atomic filesystem + Context + database + Session switch.

## 4. Discovery and claim semantics

### Read views

| Operation | Result and limits |
|---|---|
| `task_list` | Modern Task list, optional Mission/state/search/availability filters. Default states are OPEN/BLOCKED/RUNNING/DONE/CLOSED/CANCELED; default limit 100, maximum 500. Search matches summary, goal or expected output. |
| `task_view` | `{task, mission, relations, blockers, materials}` for one modern Task |
| `task_status` | `{mission,tasks,claimable_tasks,lanes,counts,page,observed_at}`; page says limit/returned/total/complete |
| `listClaimableTasks` | Internal/general bounded selection view (default 10, max 100), including age, fairness flag and selection rank |
| `task_materials` | `{links}`, optionally filtered by role/Material ID |

Available filtering precedes pagination so occupied/blocked early rows do not hide later candidates. A bounded empty page alone is not proof that the Mission is finished; `task_status.page.complete` and aggregate counts distinguish scope.

The `task_status` Task counts are Mission-scoped, but its lane query reads all active Core-bound Executions in the store without a Mission WHERE clause. Consumers must not assume every returned lane belongs to that Mission.

Claimable ordering protects work older than the configured aging threshold (default five minutes), then orders protected work oldest first; within relevant ties it uses priority, claimable time and Task ID. Younger work uses priority before age. However, claim-time `#enforceFairness` scopes its check to `task.root_id`; modern Tasks each have their own root ID. Thus a Mission-wide sorted discovery view is not a Mission-wide enforced oldest-task constraint.

### Taking an existing Task

Canonical `task_take` overwrites owner with the current actor, removes a caller-supplied fairness bypass, and makes a claim using supplied claim/request key or the operation ID. Service admission checks:

- Task exists and is nonterminal.
- Aggregate gating dependencies are satisfied.
- Same claim key either replays the same request or conflicts on changed content.
- Task specification/state versions are current.
- The requested Core has no other active Execution.
- Ordinary active/legacy waiting quota and any resumable/rework exception permit the claim.
- Workspace selection is valid.

A new claim returns `{task,execution}`, writes a `CREATED` Execution, and projects the Task `RUNNING`. Runtime binding then prepares files and starts it; see [02](02-execution.md).

The Bridge returns that original claim object after its binding callback. It does not replace it with Runtime's activated record: a successful take/register-and-take tool response can still show Execution CREATED and null start/deadline/Workspace fields while the current database record is already RUNNING. Read current Task/Execution or Workspace state for the activated projection; do not infer binding failure from that stale return object alone.

Workspace selection defaults to `resume`. Explicit source Execution must be an Execution of this Task with a Workspace. A selected revision must be positive. Clean selection rejects any source or revision. For a successor without explicit source, the service can select the latest eligible HANDED_OFF/FENCED/EXPIRED/FAILED predecessor with a Workspace and its recorded revision. It does not select a currently running sibling as an implicit shared Workspace.

Compatibility exceptions can reuse expired queued rework or a resumable WAITING Execution on its original Core; explicit clean/fork choice can supersede the latter. New normal claims do not use these exceptions as a generic permission to steal active work.

## 5. Relationships and dependency blocking

`spawned_from` explains proposal origin. It confers no parent-review authority and does not block selection. `depends_on` records genuine same-Mission prerequisites. A modern relation is satisfied by prerequisite Task `DONE` or `CLOSED`.

The store also retains `task_structure_dependencies` for TASK/MATERIAL/CHECK_RESULT facts. A semantic TASK block currently writes both a structural dependency and a modern `depends_on` relation. Their satisfaction predicates are not identical: structural TASK satisfaction recognizes DONE/SATISFIED, while modern relations recognize DONE/CLOSED. A prerequisite closed before reconciliation can therefore still be reported by the structural blocker. This implementation detail must not be hidden by a generic “all dependencies are satisfied when terminal” description.

Semantic `task_block` requires Handoff Material plus a blocker and one typed dependency:

| Dependency | Required data | Recovery |
|---|---|---|
| `TASK` (default kind) | Same-Mission prerequisite Task ID; self/cycle checks | Reconciliation after dependency satisfaction |
| `CAPABILITY`, `EXTERNAL_CAPABILITY`, `EXTERNAL` | Capability ID; optional scope, retryable flag, recovery condition | Normalized to CAPABILITY; default recovery condition `explicit_reopen` |
| Other kinds | Rejected by this semantic seam | Actionable error asks for TASK or CAPABILITY |

The Bridge additionally checks a capability blocker against the advertised capability profile; an Agent should not mark an available capability missing to evade work.

For an ordinary Task, blocking terminates/fences current authorization, fences any other active sibling records on that responsibility and writes `BLOCKED`. Structural dependency reasons are stored as `dependency:<id>`; capability reasons as `external:<capabilityId>`. TaskController may reopen only the former automatically. Explicit reopen refuses terminal Tasks, unresolved dependencies and active owners.

For the shared Mission, only the requesting Execution ends. Its dependency stays observable, but aggregate claimability ignores it. With a running sibling the Task remains RUNNING; with none it projects OPEN. A branch's external limitation cannot park every Core working on the common Mission.

## 6. Material delivery, consumption and acceptance

Materials live in Context Service. A Task Material link is a delivery/knowledge edge with role `input`, `response`, `handoff` or `experience`. It is not a scheduling edge.

A link records target Task, Material ID, role, optional receiving Task, immutable producer Task/Execution, creating Task/Execution and, later, acceptance fields. The Material must exist and its declared role must agree. Producer provenance must match the current producing Execution for directed Response/Handoff publication.

| Role | Link meaning and restrictions |
|---|---|
| `input` | Attach existing input to the current Task; must target the caller's Task |
| `experience` | Attach shared knowledge to the current Task, or explicitly address a receiving Task |
| `response` | Producer delivers a result to a distinct receiving Task in the same Mission; stored on the receiver |
| `handoff` | Current Execution leaves continuation information for its own responsibility |

Any bound receiving Task may attach already published input/experience while preserving original provenance. Only the producing Execution can create a Response/Handoff link. Exact duplicate links return the existing link rather than another delivery edge.

Directed Response/Experience links create a keyed `material_available` notification when the target has a Mission record. The current implementation selects the latest active recipient Execution if one exists; otherwise it addresses the Task for a later Execution. This is not an unconditional broadcast to all shared-Mission participants.

There are four distinct facts:

1. Material was published or linked.
2. Another Execution read it.
3. A recorded consumption says it affected route, Task, candidate or integration.
4. A receiving Task accepted a delivered Response and closed its producer.

No earlier item proves a later one, and the consumption record still needs evidence of actual downstream change when evaluating collaboration.

## 7. Local completion, receiver close and Mission acceptance

### 7.1 `task_complete`

Only the current owner of a CREATED/RUNNING Execution can complete. Optional `material_ids` must reference Materials linked to this Task or Response links produced by it; arbitrary unlinked IDs are rejected.

The completion evaluator implements the following machine-readable checks:

| Contract field | Evaluated behavior |
|---|---|
| Empty contract on a modern Task | At least one Material produced by this Task must appear in a Task Material link |
| `required_materials` | Match kinds, optional scope/role, minimum count (default 1) |
| `cross_task:true` on a Material requirement | Exclude Materials produced by the receiving Task itself, including earlier Executions of that Task |
| `requires_consumption:true` | Require recorded reader-Task consumption with requested action; provenance `consumed_material_ids` can require all source IDs consumed |
| `required_response` | Count Response links by producer Task, optionally restricted to named receiver |
| `required_candidate` | Current Execution must point to a candidate of matching kind and optional scope |
| `required_check` | Require an APPLIED PASS result through the selected/check-query path |
| Legacy required children/groups | Apply the compatibility predicates described below |

For Material requirements, linked Materials are used if any links exist; otherwise it falls back to Materials sourced from this Task. “Has a link” and “was published” are not interchangeable across all contracts.

The empty-contract fallback is triggered only by a literally empty contract. A nonempty contract containing only descriptive or capability fields is not the same fallback. Natural-language acceptance text is not automatically judged, and flat creation rejects retired hierarchy fields but does not run the legacy comprehensive completion-contract validator. The documented evaluator fields are the actual machine-enforced surface.

After passing the local evaluator, semantic completion of the first/shared Mission Task additionally evaluates Mission acceptance:

- Declaring `final_candidate:true`, `required_candidate`, `required_check` or `required_task_id` requires Task contract `final_candidate:true`.
- A required Task ID must match the completing Task.
- Required candidate kind/scope must match the current candidate.
- Required check must satisfy the APPLIED PASS gate.
- Older Missions with none of these machine-readable final gates retain their local Material-based completion behavior.

Success writes Execution SUCCEEDED and Task DONE, clears wait fields and claimable timestamp, and returns `{task,execution,materials}`. Bridge releases physical Runtime ownership after this service transition. Completing the shared Mission Task does not, within this operation, fence every other live participant Execution; whole-run termination and remaining process cleanup belong to the runner/Runtime paths in [07](07-run-configuration.md).

### 7.2 `task_close`

A receiver can close a **different** producer Task only if the producer is DONE and delivered a linked Response to this receiving Task. The current receiving Execution owner supplies producer Task ID and Material ID. A self-close, missing directed link or not-yet-DONE producer is rejected.

Acceptance timestamps and accepting Task/Execution are stored on that Response link; producer Task becomes CLOSED. The return includes producer/Material/accepting identities and the accepted link. Repeating close on an already CLOSED producer returns the existing result. This is receiver acceptance of delivered work, not a generic delete or Mission-completion API.

### 7.3 Judge application is a different path

`submit_candidate` updates this Execution's candidate pointer after provenance/kind/scope validation. In this baseline, Agent-facing Judge submission is relayed through Task Service and the runner before Judge Service; [04 Services](04-services.md) documents the complete chain.

`apply_check_result` validates Task/specification, Execution, input snapshot, current candidate and configured checker/environment bindings before applying a received result. Terminal Task results become IGNORED. A diagnostic check on a Task with no required-check contract does not automatically finish it.

For APPLIED PASS with `required_check`, however, that path can automatically mark Execution SUCCEEDED and Task DONE/SATISFIED once the **Task** completion evaluator passes. It does not call `#missionCompletion`. The stronger Mission gate described above belongs to semantic `task_complete`; it is not a universal guard on every current completion route.

The completion helper's explicit `check_result_id` branch itself checks APPLIED/PASS, rather than repeating every binding test from `apply_check_result`. Callers must not infer candidate/environment equality solely from the fact that a completion helper returned satisfied. Document the actual result binding and route when reviewing Mission success.

Source failures retain diagnostic feedback for continued iteration. Infrastructure failures are treated separately: diagnostic-only Tasks can keep running; required-check Tasks can block or defer to runner policy, and compatible WAITING attempts may wait on checker health. PASS, local Task completion, receiver CLOSED and whole-run success remain separate observations.

## 8. Handoff and progress

| Operation | Preconditions | Durable effect | Returned evidence |
|---|---|---|---|
| `task_handoff` | Current active owner; valid Handoff Material from this Execution | Execution HANDED_OFF, fence +1; responsibility remains unfinished | Task/Execution, Handoff Material/link, `disposition:handed_off` |
| `task_block` | Same Handoff boundary plus typed dependency | Execution HANDED_OFF, fence +1; ordinary Task BLOCKED or shared aggregate refresh | Task/Execution, dependency, Handoff evidence, blocked disposition |
| `execution_progress(kind:"checkpoint")` | Active Execution and required progress fields | Save/record attempt; continue current authorization | Material/link, Workspace/checkpoint, save status, last-valid snapshot/loss |
| `execution_progress(kind:"handoff")` | Same progress boundary | Progress path ends authorization as FENCED by default | Same evidence plus terminal handoff result |

Semantic handoff auto-links valid Handoff Material in its transaction if the Agent omitted an explicit prior link. It does not itself write a fresh research summary or guarantee a new filesystem checkpoint. The Material's provenance and saved revision must identify what was actually left.

Progress requires `completed_work`, `findings`, `open_questions` and `next_step`. Runtime attempts file/checkpoint save once, records linked experience with scope `execution_progress`, and reports `saved`, `save_failed` or `not_applicable`. Checkpoint failure keeps execution alive; progress handoff still releases from the last durable state and explicitly records possible loss. Detailed filesystem ordering and its limits are in [05](05-workspace-continuity.md).

## 9. Feedback delivery and handling

Notifications are bounded lifecycle facts, not general Agent chat. Types are `handoff_warning`, `material_available`, `task_reopened`. A unique delivery key deduplicates insertion; subscribers are signaled after the calling stack unwinds so a follow-up can read the committed Material/link.

A notification has optional target Execution and per-Execution receipts. Row-level delivery, receipt delivery and handling are separate facts:

- `listPendingNotifications` is the older undelivered view.
- `listUnprocessedNotifications(task,execution)` includes feedback not yet handled by this recipient, including eligible successor delivery after the original recipient terminates.
- Deadline warnings stay tied to their original Execution and are not inherited as a successor's deadline.
- `task_feedback` records notification ID, nonempty decision/action and object details; its result contains notification, receipt, current Task and Execution. Recording it does not mechanically prove a research strategy changed.

Runtime serializes follow-ups with its prompt chain and a per-notification in-flight map. It waits up to five seconds for a settled boundary. If a provider path omitted settled but a new turn-end boundary is known, delivery can continue; otherwise it defers. Prompt failure is logged and can retry at later completed-turn/successful-retry boundaries. Already delivered receipts are not re-prompted every turn, although their unhandled status remains durable.

Task-wide feedback can have independent receipts for multiple Executions. Explicitly addressed feedback rejects another recipient while the addressed Execution is active; successor handling is eligible after that attempt ends. A receipt is not inferred from a log containing the notification text.

## 10. Legacy structural path still present

This baseline also has Root/Child APIs, separate structural versions/events, branch groups, required-subtask groups, rework links, WAITING and parent-review behavior. They remain real executable compatibility code; a planned removal is not yet implemented in this PR.

Legacy proposal types are default/research/proof/implementation, version 1.0. Their defaults differ:

| Type | Default completion requirement |
|---|---|
| default | No special requirement; parent review for a child unless normal-flow |
| research | At least one fact/experience/conjecture/artifact Material; optional parent review as above |
| proof | Artifact candidate plus required check (default Lean/mvp-1) |
| implementation | Candidate/check if configured; otherwise the default parent-review behavior |

Legacy contracts validate supported keys, candidate/check consistency and optional Material consumption conditions. Normal-flow and parent-review cannot both be true. Proof requires a checker. Proposal defaults include quota 1 (accepted max 64), max depth 8, max children 32, max attempts 8 and priority 0.

Legacy branch groups satisfy ANY completed member; required-subtask groups satisfy ALL nonempty members. Their explicit structure version is compared-and-swapped before mutation. Provenance/parentage, groups and execution dependencies are different relations. Rework can append steer to a released waiting Execution or create a new recovery Execution after fencing; a separate create-rework-Task API records prior Task, feedback, Material and Workspace lineage.

Configurable admission covers unfinished/open root counts, children per Execution and mutations per turn, plus responsibility-key checks. Defaults for those numerical limits are Number.MAX_SAFE_INTEGER unless deployment overrides them. Those checks must not be described as the flat Mission queue's policy.


### 10.1 Root/child creation and admission

A root proposal must use an unbound envelope. It validates the registered
Task type/version and completion contract, sets `root_id=task_id`, stores
its admission policy, creates structural version/provenance rows and returns
`{task}`. Root proposal does not implicitly claim the new Task.

Child creation must target the current parent Task and its active
`CREATED/RUNNING/WAITING` owner. `child_creation_key` (or `request_key`)
replays identical creation; reuse with another parent/payload conflicts.
Specification and Task-or-Execution state versions must match. The child
inherits Workspace and, unless explicitly set otherwise, the parent's
`normal_flow` mode. Creation updates child/turn counters, provenance,
the parent's structural version/event and parent state version.

Admission counts unfinished root Tasks in OPEN/RUNNING/BLOCKED/WAITING,
open Tasks, and the larger of recorded/provenance child counts for the current
Execution. A missing explicit turn ID falls back to
`execution:<execution_id>`, so a configured per-turn mutation limit can
effectively span that Execution until callers supply distinct turn IDs.
Backpressure errors carry dimension, observed count, limit and a
`task_terminal_or_open_slot` retry condition. Reopening also checks the
root's open-count capacity; automatic reconciliation preserves its dependency
marker when transient open-capacity admission fails.

Responsibility deduplication differs from the modern registration hash.
A simple legacy child duplicate returns the existing Task plus
`admission:{ok:false,code:DUPLICATE_RESPONSIBILITY,...}` before consuming
capacity. Branch/subtask/rework creation raises a duplicate error instead.
Their duplicate predicates also differ: simple child creation still treats a
DONE Task with that root/key as a duplicate; the newer branch/subtask/rework
queries exclude DONE. None of these paths should be described as the flat
Mission's exact deduplication protocol.

### 10.2 Structural groups and changes

Structural writes require the current owner of the target Task, a writable
Execution envelope and, when supplied, matching
`expected_structural_version`. This structural counter is distinct from
Task state, specification and Execution state versions.

| Operation | Validation, writes and result |
| --- | --- |
| `create_branch_group` | Nonempty new Task proposals; owner cannot itself be an active Branch-group member. Check responsibility keys, root/child/turn limits for the whole set. Create group/members/Tasks, update counts/version/event; return group, Tasks, parent and authority Execution. |
| `add_required_subtask` | Use an owned active REQUIRED_SUBTASK group, latest such group or create one. Attach an existing distinct same-root Task, or create a new admitted child. Add membership and version/event; return group, Task/subtask, owner and Execution. |
| `propose_structure_change` | Dispatch supported branch/subtask/dependency actions under structural authority; return updated structure, change metadata and relevant Tasks/Execution. Unsupported change kinds fail. |
| Add dependency | Accept TASK, MATERIAL or CHECK_RESULT, validate identity/shape, reject duplicate active target and TASK cycles/self-reference. Persist requirement JSON and origin, update structural event/version. |
| Retire dependency | Require an active dependency owned by the current Task; set `retired_at`, update structural event/version. History remains readable. |
| `get_task_structure` | Return Task, structural version, creation provenance, groups/alternatives, memberships, dependencies, rework links, ordered events and satisfaction projection. |
| `explain_task_readiness` | Return readiness/status/ready, reasons, missing obligations and full structure; completion gaps are explanatory and are not all claim blockers. |

A Branch group is satisfied when any active member is DONE or SATISFIED. A
required-subtask group needs at least one member and every active member
completed. A group contributes to the completion contract only when its ID is
listed in `required_branch_groups` or `required_subtask_groups`.
Parentage alone does not imply that every child is required for completion.

TASK dependencies use the completed-state predicate already discussed.
MATERIAL dependencies require existence and any supplied kind/scope/evidence/
hash/source Task/source Execution constraints. CHECK_RESULT dependencies
normally require APPLIED PASS and any supplied status/verdict/Task/candidate
constraints. A checker-health requirement instead consults the injected health
reader and becomes satisfied on healthy status or changed health fingerprint.
These are durable readiness facts, not requests that Runtime invent a
successful research result.

The generic structural add-dependency path chooses its dependency target from
`change.task_id`, then `change.dependency.task_id`, then the authority
Task. Its owner check is on the structural authority Task; it does not apply
the modern same-Mission validation to every target. This is another reason
to keep compatibility semantics separate from `task_block`.

### 10.3 Parent acceptance and the two rework operations

`accept_task` selects acceptance authority from the contract: the current
parent Execution when a child requires parent review, otherwise the current
target Task owner. It can compare an optional target state version. Already
completed Tasks return their existing result; other terminal Tasks reject
acceptance. A parent-reviewed child must have its latest active Execution in
WAITING with `parent_review`. The same completion evaluator runs before
writing Execution SUCCEEDED and Task DONE for normal-flow or SATISFIED for
the older lifecycle. The result includes the authority Execution. This is
separate from modern receiver `task_close`.

`request_rework` requires a child Task, the acceptance authority, a
nonempty instruction and Context Service. A live target must be waiting for
parent review; arbitrary active work cannot be redirected through this seam.
The service publishes a `steer` Material (scope defaults to `strategy`)
with the instruction and parent/target provenance.

For a waiting target, the same Execution becomes CREATED, its candidate is
cleared, instruction version increases, steer refs append, waits clear and its
lease is set to the current time so it can be reclaimed under the special
queued-rework rule. Task state becomes RUNNING. For an EXPIRED/FENCED latest
attempt, a new recovery Execution is created with attempt/instruction
increments and a fresh fence/launch token, carrying the prior prompt, input
snapshot, Workspace and checkpoint pointers.

That latter route does not use normal resume cloning: it copies the old
`workspace_ref` to the new Execution ID. Reading the current Runtime and
WorkspaceManager together shows a limitation: if the predecessor already has
owner-bound Workspace metadata, startup's `restoreWorkspace` will reject
the new owner unless another integration step repairs that ownership.
The service's successful rework return alone therefore does not prove a
materialized replacement Session can start. This is a source-level inference,
not a newly executed acceptance test.

`create_rework_task` instead creates a new responsibility. It requires a
bound current consumer in the prior Task's root, feedback/instruction and
valid input Material IDs. An explicitly named Workspace-source Execution must
belong to the prior Task. It inherits prior type/output/acceptance/contract/
Workspace unless overridden, chooses the prior parent (or prior root itself)
as default parent, applies child/admission/deduplication checks, and writes a
new Task plus rework link, provenance, feedback, Material/Workspace lineage
and structural events. It returns the new Task, prior Task, provenance/link
and authority Execution; it neither claims nor runs the new Task automatically.

### 10.4 Legacy state projection and bounded promises

Legacy Task states include WAITING, SATISFIED, FAILED, CANCELLED and REJECTED
in addition to the modern vocabulary. The general refresh helper preserves
terminal Tasks. Otherwise a RUNNING Execution makes the Task RUNNING; any
WAITING Execution without a running sibling makes it WAITING; no active
Execution normally makes it OPEN (or cancellation state when requested).
Only CREATED attempts can project OPEN during refresh, even though the
initial claim writes Task RUNNING.

Root deadline, retry policy and max-attempt fields are stored contract data.
The ordinary claim path does not enforce a general max-attempt/root-deadline
budget from those fields; Runtime timeboxes and runner policies have their
own enforcement paths. A field's presence in storage must not be presented as
an independently enforced research budget.

All these operations share the Task Service transaction/replay boundary from
[02](02-execution.md). Context publication, physical Workspace changes and
Session lifecycle remain separate. Current public operation schemas, including
the compatibility commands still advertised by their profile, are in
[10](10-service-api-reference.md).

## 11. Code and existing verification map

| Source | Behavior | Existing tests |
|---|---|---|
| [task-service.js](../../src/task/task-service.js) | Mission/Task records, modern operations, claims, links, completion, notifications, dependency reconciliation | [task-oriented-flat.test.js](../../test/task-oriented-flat.test.js), [task-handoff-notifications.test.js](../../test/task-handoff-notifications.test.js) |
| [task-types.js](../../src/task/task-types.js) | Exact state vocabulary and legacy completion-contract normalization | [task-service.test.js](../../test/task-service.test.js), [task-flow.test.js](../../test/task-flow.test.js) |
| [schema.js](../../src/storage/schema.js) | Additive modern/legacy tables, receipt/link/version records and constraints | [task-admission-runtime.test.js](../../test/task-admission-runtime.test.js), [task-service-concurrency.test.js](../../test/task-service-concurrency.test.js) |
| [services-bridge.js](../../src/agent/services-bridge.js) | Bound actor, registration switch, runtime cleanup and tool mapping | [services-bridge.test.js](../../test/services-bridge.test.js) |
| [context-service.js](../../src/context/context-service.js) | Immutable Material provenance, reads and consumption | [task-material-completion.test.js](../../test/task-material-completion.test.js), [context-service.test.js](../../test/context-service.test.js) |
| Shared Mission behavior | Creation-order identity, parallel participation, branch-only blocking | [shared-mission-block.test.js](../../test/shared-mission-block.test.js), [task-oriented-flat.test.js](../../test/task-oriented-flat.test.js) |
| Progress and feedback | Save failure, per-recipient decision and continuation | [phase1-progress.test.js](../../test/phase1-progress.test.js), [phase1-s3.test.js](../../test/phase1-s3.test.js) |
| Compatibility structure | ANY/ALL groups, structural CAS, rework and dependency records | [task-structure.test.js](../../test/task-structure.test.js), [task-structure-service.test.js](../../test/task-structure-service.test.js) |

These are source/test pointers, not proof of a live run in this documentation session. In particular, the documented completion-route, dependency-predicate and hash-scope limits are implementation boundaries; a broad architecture sentence must not silently claim stronger enforcement.

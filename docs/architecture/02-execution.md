# 02. Execution, Core scheduling and failure recovery

> As built: runtime code at the source baseline named in [INDEX](INDEX.md), including the flat-only benchmark and OpenSandbox provider changes. This describes implementation, including compatibility paths and limits; it does not claim a new real-Agent acceptance run.

An Execution is a durable authorization for a Bot to work on a Task. Runtime binds that authorization to a Core, a Workspace and a model Session. The compatibility default still permits a reusable Session to take successive Tasks, but the Issue #122 migration seam `Runtime({ freshBotPerExecution: true })` removes the Session from Runtime's reusable set and stops it with the Sandbox when the Execution releases. A later Execution then requires a fresh Bot/Session. Neither a model reply nor the end of a turn automatically completes an Execution or Task.

Read [07 Run configuration](07-run-configuration.md) for deployment/runner composition and whole-run termination, [03 Mission and Task](03-mission-task.md) for responsibility transitions, [05 Workspace and continuity](05-workspace-continuity.md) for files and compaction, and [01 Agent Core](01-agent-core.md) for prompt and Bridge behavior.

## 1. Decision ownership

| Component | What it owns | What it does not decide |
|---|---|---|
| Task Service | Durable admission, claim, transition validation, dependency facts, version checks and replay | Research-value ranking |
| IdentityTaskLoop | One Core's bounded discover/select/claim/Runtime-handoff loop | It cannot bypass service-side admission |
| TaskController | Reconcile dependency state and signal eligible idle loops | It never chooses or claims a Task; its snapshot records `claim_count: 0` |
| Scheduler | Start unbound Sessions when ready supply and free capacity justify it | The start request has a generic prompt/ready count, not a selected Task |
| Runtime | Process binding, Workspace preparation, Session events, deadlines, recovery and release/fencing | Research decomposition and value ranking |
| Benchmark Runner | Compose these objects, supply callbacks, run sweeps and finalize the run | It does not replace Task Service ownership checks |

Scheduler and IdentityTaskLoop coexist as separate implementations at this baseline. The benchmark runner uses TaskController and IdentityTaskLoop for its sole Mission-scoped flat Task path; it rejects the removed Task-model selectors and does not instantiate Scheduler. Scheduler remains an independently callable and tested compatibility coordinator. Class defaults below must not be mistaken for the runner's overrides.

## 2. Three different state spaces

### 2.1 Durable Execution state

| Exact state | Meaning and entry paths |
|---|---|
| `CREATED` | Claim exists; process not yet durably started. Also the intermediate state after recovery and some legacy rework/wake paths. |
| `RUNNING` | `start_execution` / `resume_execution` committed; a Runtime process normally owns the binding. |
| `WAITING` | Legacy checkpointed wait with a typed condition; physical Session/Workspace can be released. |
| `SUCCEEDED` | This Execution satisfied its completion path. |
| `FAILED` | Startup, checker/infrastructure policy, explicit stop or another terminal failure. |
| `EXPIRED` | Lease or timebox expiry. |
| `CANCELLED` | Explicit cancellation/stop. |
| `FENCED` | Authorization revoked, including progress handoff, task switch, exhausted recovery and Runtime restart. |
| `HANDED_OFF` | Semantic Task handoff/block ended the attempt after Handoff Material validation. |
| `SUPERSEDED` | A resumable legacy waiting attempt was replaced by a new clean/forked Execution. |

The first three are the exported active states. Every other state is terminal and rejects ordinary further execution writes. An active state still has operation-specific restrictions: Workspace writes need a live `CREATED`/`RUNNING` Runtime binding, for example.

These are the exact database spellings. Semantic handoff and progress handoff do **not** record the same terminal state. Preserve `state`, `terminal_reason` and handoff metadata together in reports.

Task state is a separate projection. Every concrete Task has one effective
Execution in the Issue #122 path; Mission itself has no owner or Execution. A
Core becoming idle is a capacity fact, not Mission completion. The older
shared-Mission sibling wording below is retained only to explain historical
records and compatibility imports.

### 2.2 Runtime Core occupancy

Runtime's in-memory `coreStates` map holds `core_id`, `state` (`IDLE` or `RUNNING`), `execution_id`, `task_id`, `session_id` and `updated_at`. Its `activeProcesses` map holds live Session/Workspace and health bookkeeping by Execution ID.

Task Service independently persists `core_id`. A non-null binding is immutable for an Execution's lifetime. Claim/start reject another `CREATED`/`RUNNING` Execution on the Core. Legacy `WAITING` records do not occupy that database active-Core query; their resume still respects their original binding.

### 2.3 Identity-loop state

The normal loop is `IDLE → DISCOVERING → TAKING → RUNNING → IDLE`. `STOPPING` is explicit shutdown. `FAILED` is in the exported vocabulary and TaskController treats it as unhealthy. There is no semantic `BLOCKED` Core state: blocking research work releases capacity.

Snapshots include discovery/take/claim counts, conflicts/rescans, selector failures/retry deadline, idle generation, last error/timestamp and state history. These counters describe coordination activity, not useful research progress.

## 3. How work reaches a Core

### 3.1 IdentityTaskLoop

One `runOnce` is serialized; concurrent calls share its promise.

1. Re-arm an exhausted selector only after cooldown. Otherwise return `take_exhausted`.
2. Read claimable work, then bound it to `shortlistLimit` (default 8; accepted 1–100).
3. If empty, return `idle` without invoking selection or creating a claim.
4. Give `takeTask` the frozen bounded view, Core ID, take prompt, reason and rescan count. The callback may return a Task ID or a complete `{task, execution}` claim produced through the Bridge.
5. `take_deferred` denotes an in-flight binding/handoff race and returns idle without a failed selection attempt. `take_failed` denotes a lost claim race and follows bounded rescan.
6. Reject a selected ID outside the view. A thrown selector error or invalid choice consumes its attempt budget; claim conflicts do not.
7. If not already claimed, call Task Service with this Core, owner `identity:<coreId>`, and a fresh key `<coreId>:<taskId>:<sequence>`. The sequence is initialized from persisted claim keys so a later reclaim does not replay an old Execution.
8. Hand the claimed Execution to Runtime. If Runtime supplies `waitForExecutionRelease`, wait for both live process ownership and durable `CREATED`/`RUNNING` state to end.
9. Clear local pointers and return idle. A Runtime handoff error triggers an injected release or fence attempt (`runtime_handoff_failed` / `handoff_timeout`), records its result, then returns idle.

Defaults are one conflict rescan, three selector failures before a 30-second cooldown, a 5-second idle backoff, 25-ms release polling and an infinite handoff wait deadline. Callers can override these or inject a custom waiter.

Signals interrupt idle waits. A pending-wake bit covers a signal arriving before waiter installation; signals during cooldown cannot cause a busy loop. `idle_generation` advances after a completed retryable attempt even if the controller missed its intermediate state, but not for an untouched empty queue, deferred take or still-exhausted selector. Stop aborts handoff waits, requests a fence for the owned Execution and wakes sleepers.

### 3.2 TaskController

The controller defaults to a 5-second sweep and 16-Task shortlist. Event/timer reconciliations are serialized; an event during reconciliation requests a subsequent pass.

A pass reads up to 100 `OPEN`/`BLOCKED` Tasks through the default adapter, asks Task Service to reconcile them, then reads updated blocked/claimable views and identity-loop health. Healthy idle loops in selector cooldown are excluded. Unhealthy loops can invoke an optional recovery callback.

The controller signals at most one idle loop per distinct claimable Task in its
view. The sorted Task IDs, loop state and idle generation form a
duplicate-suppression key. Mission is not inserted into this view and no
shared-Mission parallel slot exists in the current implementation.

It publishes readiness/health snapshots, suppresses stable blocked/no-op noise,
and keeps observer errors from changing ownership. Normal reconciliation
preserves terminal Tasks and active owners. `dependency:` blocks can reopen
after prerequisites satisfy; external capability and operator blocks require
explicit reopen. Historical aggregate-`BLOCKED` repair remains readable only
for imported old records and is not used to create a Mission Task.

### 3.3 Scheduler compatibility coordinator

Scheduler observes ready-set signature/count and free Cores, orders Cores by fewer startup attempts, earlier dispatch and Core key, then starts at most the ready Task count. Each start request carries a generic prompt and count, not an assignment.

Defaults are three startup attempts, 1-second retry backoff and 1-second dispatch backoff. A ready-signature change resets attempts/backoff/exhaustion; a real observed Task ownership cycle clears successful-signature suppression. A closed generic Session without ownership can receive a bounded replacement. A successful unbound turn that never claims cannot cause infinite relaunches on an unchanged signature. Startup failures are classified as timeout, provider failure or other startup failure.

## 4. Durable Execution record

| Field group | Values and meaning |
|---|---|
| Identity | `execution_id`, `task_id`, `owner_ref`, nullable immutable `core_id`, unique `launch_token` |
| State/specification | `state`, `state_version`, `spec_version`, `spec_hash`, `attempt_no`, `instruction_version` |
| Incarnation | `session_generation` starts at 1; `fencing_version` starts at 1; `runtime_generation` defaults to 1 |
| Lease | `lease_expires_at`, `heartbeat_at`; default claim/heartbeat lease is 30 seconds without caller override |
| Input/prompt | `agent_prompt`, `workspace_manifest_ref`, `input_material_refs`, `input_snapshot_hash`; returned `workspace_snapshot_hash` aliases the last field |
| Workspace selection | `mode` (`resume` default or `clean`), selected revision, source Execution and source Workspace |
| Saved output | Workspace path/revision/content hash, checkpoint path/hash, current candidate Material ID; initially null |
| Timebox | Start time, reminder deadline, execution deadline, reminder-sent time; set on start, not claim |
| Continuation | Steer Material references, wait condition/deadline/token, handoff metadata, terminal reason |
| Audit | Creation/update timestamps |

The persisted `agent_prompt` is not a transcript or necessarily the final model input. Runtime adds context, capability/service documents, notifications and later prompts. See [01](01-agent-core.md) for the precise composition and recording boundary; [11 Storage](11-storage-reference.md) contains the complete DDL.

## 5. Claim → Workspace → Session

Task Service atomically validates the claim, writes a `CREATED` Execution and claim key, and moves the Task to `RUNNING`. Workspace/process preparation occurs later and outside that transaction.

| Start seam | Exact high-level order |
|---|---|
| `startExecution` / `startClaimedExecution` | Validate state/capacity/Core → prepare Workspace → persist reference → commit `start_execution` → launch adapter → save adapter runtime manifest → register binding → ensure sandbox → compose/send prompt |
| `bindAgentExecution` | Validate state/capacity/Core → prepare Workspace → compose optional snapshot → commit `start_execution` → use supplied Session or startSession callback → register binding → ensure sandbox → send prompt or queue notifications |

A Workspace exists before the model process starts. Restoring an already persisted revision does not re-save the same revision as a new one. When a heartbeat races filesystem work, saving the Workspace reference retries a stale state-version error up to three times with a fresh envelope; the exact filesystem revision has already been saved.

Reusable binding with `sendInitialPrompt:false` avoids a second initial prompt inside an active tool-call turn. Pending notifications are still queued at the next settled boundary; the caller/Bridge supplies current Task information to the continuing identity.

Before `start_execution` commits, a preparation error triggers a fence attempt with `startup_prepare_failed` or `bind_prepare_failed`. After the durable start, failure records `FAILED` with `startup_failed` / `bind_failed`. Runtime removes occupancy, stops sandbox/bound failed Session and preserves any already prepared Workspace evidence. These are compensating steps, not a rollback of every file.

Bridge binding adds another failure boundary. After recording new IDs it invokes `onClaimAccepted` and `onClaim`. On failure it attempts Runtime stop (`FAILED/task_take_bind_failed`), or a fresh Task Service stop/fence fallback, then clears Bridge IDs/cache and invokes `onRelease` best effort. Cleanup failure is swallowed to preserve the original exception: release is attempted, not guaranteed merely because the take call returned an error.

### 5.1 OpenSandbox provider boundary (Issue 119)

`OpenSandboxManager` is the external provider implementation at `src/runtime/opensandbox-manager.js`. The benchmark CLI requires an enabled OpenSandbox deployment before creating Tasks or Agents; a direct library caller without that production requirement can still select the local compatibility provider. OpenSandbox uses the 1.2 lifecycle API with `fetch`: `POST /v1/sandboxes` creates one sandbox for the Execution, `GET /v1/sandboxes/{id}/endpoints/44772` resolves the in-sandbox Execd endpoint, and `DELETE /v1/sandboxes/{id}` requests termination. The lifecycle request contains the pinned image URI, entrypoint, resource limits, nonsecret environment and Execution metadata. The API key is sent only in the request header and never appears in snapshots or errors.

The provider deliberately ignores the host `workspaceRef` as a mount source. It reports `/workspace` as the guest work path and keeps the host reference only as a private in-memory audit value. Configured volumes are schema-checked and host-path mounts are rejected; deployments must use provider-managed volume backends. After endpoint resolution, production calls Execd `/ready` and accepts `/ping` for Execd versions that do not expose `/ready`. With `foregroundSession=true`, commands use Execd `/session` and `/session/{id}/run`; a timeout interrupts the active session through `DELETE /command?id={sessionId}` before deleting the session. Deployments without that endpoint fall back to the older `POST /command` path, where array commands first use native `argv` and retry as shell-quoted `command` text for older Execd images that reject `argv`; a foreground timeout records `sandbox.exec_timeout_disconnect` and remains provider-dependent. The result parser accepts both conventional SSE `event`/`data` records and the JSON-lines records emitted by the released Execd image, reducing `stdout`, `stderr`, completion and error events to the Runtime sandbox result. Background IDs are retained for `GET /command/status/{id}` and `DELETE /command?id={id}`. `stopExecution` cancels tracked jobs before deleting the provider sandbox, and a failed endpoint lookup or readiness gate compensates by deleting the just-created sandbox. Provider diagnostics are bounded and redact credential-shaped fields before entering errors or snapshots. HTTP failures become typed retryable service errors where the status supports retry.

This provider boundary is usable by Runtime anywhere a `sandboxManager` is accepted and is exported from `src/index.js`. With the OpenSandbox provider enabled, `OpenSandboxAgentAdapter` starts `/opt/swarmenv/agent-worker.mjs` through Execd, resolves a provider endpoint, copies bounded initial Task files into guest `/workspace`, resolves executable versions in that guest, and starts the configured command inside that worker. The benchmark defaults to direct Pi; the shipped image contains Node, the pinned native Pi package/model catalog, extension source and worker, without NuRouter. A custom compatibility command requires a matching image. `RemoteAgentChild` maps the worker's JSON-RPC and event stream to the existing `AgentCoreSession`; before Runtime stops the provider, `syncWorkspaceBack` pulls bounded regular files into the host Workspace so the next WorkspaceManager checkpoint can commit them. On benchmark process setup, `reconcileExecutions` lists provider sandboxes by durable `execution_id` metadata and re-adopts matching Execd endpoints before new worker startup. Generic Runtime callers can invoke `reconcileProviderExecutions()` during controller startup/restart; it derives active Execution IDs from Task Service, delegates to the provider, records an operator reconciliation event and returns the adopted records. Deletions, session metadata and provider-volume restart reconciliation are not yet fully represented. Task/Context/Judge also remain benchmark-local SQLite services unless isolated service mode is configured, so this is not yet complete Issue 119 acceptance. The old `ContainerSandboxManager` remains a local compatibility provider and is not the Issue 119 target backend.

When `Runtime` receives `cleanExecutionWorkspaces: true`, preparation rejects an Execution that already has a durable Workspace reference, then ignores `workspace_selection.mode=resume` for a new Execution. It creates a path derived from the new Execution ID and fence (`<execution>-fresh-<fence>`), writes the normal task/input snapshot, and starts Pi against that path. The benchmark runner enables this switch automatically for the OpenSandbox provider. Recovery of the same durable Execution does not re-run preparation, so recovery can still use its recorded durable Workspace; a later claim receives a new Execution and therefore a new clean path.

## 6. Transactions, authority and fencing

Mutating Task Service dispatches use `BEGIN IMMEDIATE … COMMIT` and persist operation fingerprint/result. Same operation ID and fingerprint replays; a changed payload conflicts. Claim, wait and wake also have dedicated request keys.

Execution writes carry Task/Execution IDs plus specification, state and fence versions. Task Service rejects mismatched Task, stale specification/state version, stale fence and terminal Execution. Semantic handlers add owner checks where required. The low-level version checker is not an all-purpose actor authentication mechanism: Bridge binding and the operation-specific handler establish caller authority.

Runtime uses its daemon actor for physical lifecycle operations. Semantic handoff/block uses the Execution's authenticated `owner_ref`, for example `agent:core-2`; using `runtime:core-2` would fail the Task owner check.

Durable ownership ends before best-effort physical Workspace fencing on release. A failed physical fence is logged and does not roll back a terminal Execution. Later service writes still fail durable state/fence checks; this does not prove an arbitrary host process was physically isolated.

For semantic handoff/block, Runtime marks the binding closing, stops sandbox jobs, dispatches the Task transaction, then releases binding/Workspace. If Task validation rejects and that same Execution remains active, `#semanticRelease` restores `closing=false` so the Agent can correct its request. That repair is not universal across the older Runtime methods.

## 7. Time, health and recovery

### 7.1 Three independent clocks

| Clock | Class default | Result of the relevant sweep |
|---|---|---|
| Lease | 30 seconds in Task Service without caller override | Expire overdue `CREATED`/`RUNNING` Execution, increment fence, release process |
| Productive-progress watchdog | 120 seconds | Recover a `RUNNING` Session outside active turn/retry/compaction phases with no productive completion |
| Execution timebox | 60 minutes; reminder at 55 minutes | Persist one reminder, then hand off as `EXPIRED`, reason `timeout`, metadata `TIMEBOX_EXPIRED` |

Modern Task `timebox_ms` replaces generic duration; a global run deadline caps it. Runtime uses at least 1 ms. With a run deadline it keeps configured reminder lead time before the earlier end; without one it uses the lesser of configured reminder offset and just before Task timeout.

`start_execution` recalculates these times. A same-Execution Session restart therefore restarts attempt timing, still capped by the global run deadline. Sweeps are invoked by the runner/composition; Runtime does not install an automatic timer for each method.

Reminder-sent time is committed before delivery. Modern Tasks receive durable `handoff_warning`; compatibility Tasks receive a direct follow-up. Expiry records whether this Execution actually linked Handoff Material and does not invent research conclusions if missing.

### 7.2 Event-derived health

Runtime records phase, last event/heartbeat/completed turn/successful service call and last productive timestamp. Completed turns, successful tool completions, successful compaction and successful provider retry count as productive boundaries. A heartbeat renews a lease without proving research progress.

`turn_start`, `auto_retry_start` and `compaction_start` synchronously increment a phase epoch. A completion handler that awaited session stats may reset phase to idle only if no newer phase began. The watchdog skips an active turn, provider retry and compaction even if long-running.

### 7.3 Session recovery

Failure classes include exhausted provider retries, context overflow, compaction failure, process error/exit and watchdog stall. One promise suppresses duplicate recovery. Runtime removes live/sandbox binding, stops the failed Session and increments an in-memory recovery count keyed by **Task ID**. Default budget is one recovery; it is not a persisted per-Execution budget.

Within budget, Runtime fences the old Workspace incarnation and calls `recover_execution`: same Execution/Core, fence +1, Session generation +1, attempt +1, refreshed lease and `CREATED` state with recovery prompt. It resets identity compaction count and starts a fresh Session from durable Workspace/checkpoint. Beyond budget it fences with `recovery_exhausted`; a still-live responsibility can return to the queue.

`restartSession`, used by explicit identity rotation, also usually preserves Execution/Core and uses `recover_execution` for a running attempt. Session replacement is not a Task handoff. Recovery instructs the new model to inspect durable facts and not assume its interrupted turn completed.

This remains the current Runtime recovery path, including when the OpenSandbox adapter is selected; clean preparation of a new Execution does not disable same-Execution recovery. Runtime preserves an explicitly configured `SWARMENV_AGENT_ROLE`, and otherwise uses `bound`, so a recovered child does not silently switch away from the authenticated Bridge's profile. Phase 02's no-process-recovery contract is a separate target design.

## 8. Release, switch and shutdown

| Boundary | Durable effect | Physical effect |
|---|---|---|
| `releaseExecution` | None; a service already reached terminal state | Drain queued compaction saves; detach/stop binding; stop sandbox; release Workspace; Core idle |
| `stopExecution` | Requested terminal state/reason; cancellation can cancel an idle Task projection | Same physical release |
| `fenceExecution` | `FENCED`, fence increment, generation/reason | Stop sandbox, best-effort Workspace fence, release binding/Core |
| `detachSwitchedExecution` | None; old fence/new claim already committed | Use previous fence to revoke old Workspace, detach old binding for same-Session rebind |
| Runtime `restart` | Runtime generation +1; fence active `CREATED`/`RUNNING` attempts | Stop all owned Sessions, including released reusable Sessions; preserve legacy `WAITING` responsibilities |
| Runtime `shutdown` | Default `FAILED/runtime_shutdown`, configurable by caller | Set stopping, unsubscribe callbacks, release live bindings, stop all owned Sessions, await recovery/release work |

A Session with `identitySession=true` survives normal Task completion/handoff/block
only in compatibility mode. With `freshBotPerExecution=true`, Runtime clears
the binding, removes the Session from `identitySessions`, and stops it before
the next Bot starts. Shutdown owns both active and temporarily unbound
Sessions.

One listener set is attached per Session; event handlers read its current Execution binding, preventing handler multiplication on rebind. Closing/absent bindings ignore late events. Sibling fencing uses tracked pending-release promises and updates occupancy after cleanup reaches release.

For register-and-switch, the old fence and new claim share a Task Service transaction, but the earlier progress save and later detach/`onWorkUnit`/`onRelease`/new binding do not. A post-transaction callback error can occur after old authorization has ended and the new claim exists.

## 9. Legacy waits and current implementation limits

Legacy `request_wait` remains executable through the low-level Runtime/Task interfaces only when the Task contract does not set `normal_flow: true`. The scripted fixture still creates a Mission-scoped Task without that flag and exercises this compatibility wait/wake path. The benchmark always sets normal flow, and its live Agent profile does not expose the retired wait surface, so the following is not an alternative production benchmark mode. A wait requires a saved checkpoint and a condition type from `child_task_terminal`, `children_all_terminal`, `parent_review`, `check_result_arrived`, `checker_health`, `timer`. Empty child sets, nonexistent/non-child dependencies and already satisfied child conditions are invalid.

A waiting parent can resume when its child is terminal **or waiting for parent review**, avoiding review deadlock. CheckResult wakeups bind Task/Execution and can use candidate Material ID when the Agent lacks the runner's internal request key. Checker-health waits need a changed health fingerprint; unchanged unavailability is not retry permission.

A compatible same-Core resume can reuse a waiting Execution. Explicit clean/fork choice supersedes it and makes a new Execution. This differs from both same-Execution Session replacement and modern handoff.

### 9.1 Wait condition and transition details

| Condition | Required binding and readiness rule |
| --- | --- |
| `child_task_terminal` | A direct child ID; readiness when it becomes terminal or its latest active attempt waits for parent review. |
| `children_all_terminal` | Nonempty deduplicated direct-child IDs; every child must reach one of those readiness states. |
| `parent_review` | Only a child Task; never automatically resumable through the ordinary waiter. Parent acceptance/rework resolves it. |
| `check_result_arrived` | Request key, or the current candidate Material ID as a bound fallback; a matching Task/Execution result in RECEIVED/APPLIED/IGNORED can wake it. PASS is not required merely to inspect feedback. |
| `checker_health` | Preflight key and observed health fingerprint; only a newly observed different fingerprint makes the wait resumable. `retry_after` is not an independent timer that bypasses this condition. |
| `timer` | An ISO-parseable deadline; resumable when reached. Other conditions may also store a deadline, but their predicates do not all treat deadline expiry as satisfaction. |

Runtime `requestWait` requires its live RUNNING process. It marks closing,
stops the Sandbox, validates and checks the condition, saves a Workspace
revision and its reference, writes/saves a checkpoint, then commits the wait.
Task Service requires the same already-saved checkpoint reference/hash,
persists condition/deadline/resume token and updates the Task projection.
The wait key defaults to the checkpoint reference when not supplied; identical
key/fingerprint replay returns the current record, changed reuse conflicts.
Runtime then detaches/stops the Session, releases the Workspace and frees the
Core. These saves can fail before the durable wait, and the method does not
have the bounded save-failure continuation of progress handoff.

Runtime's explicit `wakeExecution` checks WAITING and capacity, commits
`wake_execution`, reopens/restores the same owner/fence Workspace and
launches a Session. Startup failure attempts `wake_failed` fencing.
Wake clears condition/deadline/token and increments state version, without
advancing the fence or recalculating the start/timebox fields as
`start_execution` does. A repeated call while already bound returns the
active process; a non-WAITING unbound attempt rejects.

The low-level `wake_execution` and Runtime wake method do not themselves
test that the stored condition has become true. Resumable discovery and its
caller are responsible for that decision. A successful direct wake therefore
proves authorization/state transition, not prerequisite satisfaction. Core
identity and occupancy checks still apply.

The older `blockExecution` path is also distinct from semantic
`task_block`: it freezes the Sandbox, attempts a fresh revision/checkpoint,
calls low-level `block_task` with a terminal state (default FENCED), then
fences/releases the Workspace and Session. A normal-flow Task requires a
typed dependency. Unlike semantic handoff, this method does not require a
Handoff Material; unlike bounded progress handoff, persistence errors are
thrown before completing the block. Details of sibling fencing and automatic
dependency reopen are in [03](03-mission-task.md).

### 9.2 Limits that must remain visible

- Task transactions, Context publication, Git/filesystem saves and process management are not one atomic transaction. Partial persistence is possible.
- Older `requestWait` and `blockExecution` set `closing=true` before validation, but do not consistently reset it on rejection as semantic release does. A test checking only durable state or Workspace writability does not prove subsequent Session event processing.
- Strong Mission acceptance is checked in semantic `task_complete`; Judge automatic completion has a different path. See [03](03-mission-task.md).
- Best-effort physical cleanup and terminal durable state do not prove every external process exited or every last byte was saved.

## 10. Code and existing verification map

| Source | Covered behavior | Existing tests |
|---|---|---|
| [identity-task-loop.js](../../src/runtime/identity-task-loop.js) | Discover/take/claim, cooldown, signal races and failed handoff | [orchestration-roles.test.js](../../test/orchestration-roles.test.js) |
| [task-controller.js](../../src/runtime/task-controller.js) | Reconciliation, wake budget/deduplication and health callbacks | [orchestration-roles.test.js](../../test/orchestration-roles.test.js) |
| [scheduler.js](../../src/runtime/scheduler.js) | Generic startup budget and signature suppression | [scheduler.test.js](../../test/scheduler.test.js) |
| [runtime.js](../../src/runtime/runtime.js) | Binding, events, deadlines, recovery and cleanup | [Workspace contract](../../test/workspace-contract.test.js),  |
| [task-service.js](../../src/task/task-service.js), [task-types.js](../../src/task/task-types.js), [schema.js](../../src/storage/schema.js) | Durable state/version/Core/lease transitions and replay | [flat Task behavior](../../test/task-oriented-flat.test.js),  |
| [services-bridge.js](../../src/agent/services-bridge.js) | Identity, same-lane bind/switch and compensation | [profile/Bridge](../../test/capability-profile-bridge.test.js), [direct Judge](../../test/judge-direct-submit.test.js) |

Test links identify existing regression scenarios, not a claim that they ran in this documentation session. Mock adapter tests do not establish live-provider, Docker or long-duration scientific behavior.

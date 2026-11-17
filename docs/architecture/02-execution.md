# 02. Execution, Core scheduling and failure recovery

> As built: runtime code at the source baseline named in [INDEX](INDEX.md), including the flat-only benchmark and OpenSandbox provider changes. This describes implementation, including compatibility paths and limits; it does not take a new real-Agent acceptance run.

An Execution is a durable authorization for a Bot to work on a Task. Runtime binds that authorization to a Core, a Workspace and a model Session. The default `Runtime({ freshBotPerExecution: true })` removes the Session from Runtime's reusable set and stops it with the Sandbox when the Execution releases. A later Execution then requires a fresh Bot/Session. Neither a model reply nor the end of a turn automatically completes an Execution or Task.

Read [07 Run configuration](07-run-configuration.md) for deployment/runner composition and whole-run termination, [03 Mission and Task](03-mission-task.md) for responsibility transitions, [05 Workspace and continuity](05-workspace-continuity.md) for files and compaction, and [01 Agent Core](01-agent-core.md) for prompt and Bridge behavior.

## 1. Decision ownership

| Component | What it owns | What it does not decide |
|---|---|---|
| Task Service | Durable admission, take, transition validation, dependency facts, version checks and replay | Research-value ranking |
| IdentityTaskLoop | One Core's bounded discover/select/take/Runtime-handoff loop | It cannot bypass service-side admission |
| TaskController | Reconcile dependency state and signal eligible idle loops | It never chooses or takes a Task; its snapshot records no take operation |
| Scheduler | Start unbound Sessions when ready supply and free capacity justify it | The start request has a generic prompt/ready count, not a selected Task |
| Runtime | Process binding, Workspace preparation, Session events, deadlines, recovery and release/fencing | Research decomposition and value ranking |
| Benchmark Runner | Compose these objects, supply callbacks, run sweeps and finalize the run | It does not replace Task Service ownership checks |

Scheduler and IdentityTaskLoop coexist as separate implementations at this baseline. The benchmark runner uses TaskController and IdentityTaskLoop for its sole Mission-scoped flat Task path; it rejects the removed Task-model selectors and does not instantiate Scheduler. Scheduler remains an independently callable and tested compatibility coordinator. Class defaults below must not be mistaken for the runner's overrides.

## 2. Three different state spaces

### 2.1 Durable Execution state

| Exact state | Meaning and entry paths |
|---|---|
| `CREATED` | Take exists; process not yet durably started. Also the intermediate state after recovery and some legacy rework/wake paths. |
| `RUNNING` | `start_execution` / `fresh task_take` committed; a Runtime process normally owns the binding. |
| `CLOSING` | An accepted `task_finish` is durable; Task/Core/owner remain occupied until Runtime confirms isolation and finalizes it. |
| `WAITING` | Legacy checkpointed wait with a typed condition; physical Session/Workspace can be released. |
| `SUCCEEDED` | This Execution satisfied its completion path. |
| `FAILED` | Startup, checker/infrastructure policy, explicit stop or another terminal failure. |
| `EXPIRED` | Lease or timebox expiry. |
| `CANCELLED` | Explicit cancellation/stop. |
| `FENCED` | Authorization revoked, including progress handoff, task switch, exhausted recovery and Runtime restart. |
| `HANDED_OFF` | A finish handoff/block ended this attempt. Registered blocked finish requires a valid Task prerequisite; a handoff Material is optional. |
| `SUPERSEDED` | A resumable legacy waiting attempt was replaced by a new clean/forked Execution. |

The exported `ACTIVE_EXECUTION_STATES` constant retains `CREATED`, `RUNNING`, `WAITING` for compatibility. The separate active-Core query includes `CREATED`, `RUNNING`, `CLOSING`, retaining physical cleanup occupancy. `WAITING` is resumable compatibility state; `CLOSING` is also nonterminal but rejects new contributions. Terminal states are `SUCCEEDED`, `FAILED`, `EXPIRED`, `CANCELLED`, `FENCED`, `HANDED_OFF`, `SUPERSEDED`. None of these classifications alone grants write authority: registered Bot contributions require the current active binding, lease, deadlines and fence. [State constants](../../src/task/task-types.js) · [Task Service](../../src/task/task-service.js).

These are the exact database spellings. Semantic handoff and progress handoff do **not** record the same terminal state. Preserve `state`, `terminal_reason` and handoff metadata together in reports.

Task state is a separate projection. Every concrete Task has one effective
Execution in the Issue #122 path; Mission itself has no owner or Execution. A
Core becoming idle is a capacity fact, not Mission completion. The older
shared-Mission sibling wording below is retained only to explain historical
records and compatibility imports.

### 2.2 Runtime Core occupancy

Runtime's in-memory `coreStates` map holds `core_id`, `state` (`IDLE`, `RUNNING` or `CLOSING`), `execution_id`, `task_id`, `session_id` and `updated_at`. Its `activeProcesses` map holds live Session/Workspace and health bookkeeping by Execution ID.

Task Service independently persists `core_id`. A non-null binding is immutable for an Execution's lifetime. Take/start reject another `CREATED`/`RUNNING` Execution on the Core. Legacy `WAITING` records do not occupy that database active-Core query; their resume still respects their original binding.

### 2.3 Identity-loop state

The normal loop is `IDLE → DISCOVERING → TAKING → RUNNING → IDLE`. `STOPPING` is explicit shutdown. `FAILED` is in the exported vocabulary and TaskController treats it as unhealthy. There is no semantic `BLOCKED` Core state: blocking research work releases capacity.

Snapshots include discovery/take-turn/accepted-take counts, conflicts/rescans, selector failures/retry deadline, `waiting_for_work`, `discovery_retry_at`, `first_discovery_at`, idle generation, last error/timestamp and state history. These counters describe coordination activity, not useful research progress.

## 3. How work reaches a Core

### 3.1 IdentityTaskLoop

One `runOnce` is serialized; concurrent calls share its promise.

1. Wait for the first discovery time, even if the Controller signals earlier. After a Bot exits without an Execution, wait for a public-state signal or the discovery retry time. Re-arm an exhausted selector only after its own cooldown, or return `take_exhausted`.
2. Read eligible work and bound the supplied page to `shortlistLimit` (default 8; accepted 1–100). An empty page still enters discovery on every Core. There is no one-time bootstrap privilege or Core-1 exception.
3. Give `takeTask` the frozen page, Core ID, prompt, reason and rescan count. The Bot can inspect other public work, prefer a suitable existing Task or propose a local responsibility. The page is context, not an admission allowlist.
4. The callback returns an already accepted `{task, execution}` from the Bot transport, `take_deferred`, a structured `take_failed`, or explicit `no_work`. A bare Task ID or selection object is invalid and consumes the bounded failure budget; the supervisor has no `takeSelectedTask`, default owner or generated take-key fallback. Task Service and the authenticated Bot Bridge own take identity and request idempotency.
5. Deferred binding does not consume a failed selection attempt. Conflict codes cause a bounded rescan; infrastructure/invalid results consume the retry budget. The Bridge preserves its actual take error code even when Pi handles the error as an ordinary tool result.
6. An accepted take is handed to Runtime even when its Task was proposed after the page was read. The supervisor does not issue a second take. If Runtime supplies `waitForExecutionRelease`, wait for process ownership and durable active state to end; cleanup ordering is described below.
7. Clear local pointers and return idle. A Runtime handoff error triggers an injected release or fence attempt and records its result; failed cleanup remains subject to Runtime's ownership retention rules.

Defaults remain one conflict rescan, three selector failures before a 30-second cooldown, a 5-second ordinary idle backoff, a 30-second discovery retry after an unbound Bot exits, 25-ms release polling and an infinite handoff wait deadline; the benchmark sets a finite run deadline. Signals interrupt waits, and a signal version prevents a public change during discovery from being lost when a callback returns no work. `notifyPublicChange` accepts public Task transitions and Material/Workspace mutations, while filtering private checkpoint, local Workspace revision and feedback bookkeeping. The library filter remains available, but the production runner routes event hints to Controller reconciliation; durable public-change tokens can rearm discovery earlier. A retry timer allows quiet, unfinished Missions to resume discovery without depending on new public records. Stop aborts handoff waits, requests a fence for an owned Execution and wakes sleepers. A custom `waitForSignal` receives a signal owned by that single wait. Timer, public notification, external completion, parent cancellation or loop stop all remove the parent abort listener and cancel the unfinished external wait; recurring discovery must not accumulate listeners or outstanding subscriptions.

The benchmark currently does **not** infer `no_work` from a settled turn without a take. That outcome is `DISCOVERY_INCOMPLETE` and follows bounded failure/cooldown handling; prompt acknowledgements, provider errors and failed tool calls are not evidence that no useful work exists. A durably closing/closed unbound Bot with a no-work, selection-budget or lifetime-budget reason supplies the callback’s `no_work` outcome. The retry calls discovery again only if Mission and run authority still allow it. Runtime can open a successor only after it has confirmed physical cleanup and released the previous Bot’s Core. Prompt acknowledgements alone do not establish no work. The normal runner uses co-located Services with independent databases and a Task-owned lifecycle write boundary; standalone remote writers are rejected where that boundary is unavailable. Final Mission acceptance uses the separately configured submission coordinator described in [03](03-mission-task.md).

### 3.2 TaskController

The controller defaults to a 5-second sweep and 16-Task shortlist. Event/timer reconciliations are serialized; an event during reconciliation requests a subsequent pass.

A pass reads up to 100 `OPEN`/`BLOCKED` Tasks through the default adapter, asks Task Service to reconcile them, then reads updated blocked/eligible views and identity-loop health. Healthy idle loops in selector cooldown are excluded. Unhealthy loops can invoke an optional recovery callback.

The controller signals every healthy idle loop outside retry cooldown, including
when the eligible view is empty. Task count does not cap discovery capacity: Bots
can inspect existing responsibilities and propose distinct local work. Task
Service still arbitrates exclusive takes. The sorted Task IDs, loop state, idle generation and durable public-change token form a duplicate-suppression key. Observing discovery/take in
flight preserves that receipt, so an unchanged view does not restart the same read through Controller polling. Execution completion, public change and the retry timer can each allow later discovery. The runner reads Task counts/spec-and-state versions/relations/links, Context publication and correction counts/active flags, and Workspace next/main revision through their owning components. These tokens change only with persisted public facts; private heartbeats, ordinary reads and exact request replays do not change them. The normal five-second benchmark repair poll therefore notices a public Workspace save/merge, a Material correction, or a newly blocked Task even when the eligible shortlist is unchanged and a notification was missed. Events request a sooner reconciliation rather than bypassing token deduplication. No broker or reliable-broadcast guarantee is assumed. Mission is not inserted into the Task view.

It publishes readiness/health snapshots, suppresses stable blocked/no-op noise,
and keeps observer errors from changing ownership. Normal reconciliation
preserves terminal Tasks and active owners. `dependency:` blocks can reopen
after prerequisites satisfy; external capability and operator blocks require
explicit reopen. Historical aggregate-`BLOCKED` repair remains readable only
for imported old records and is not used to create a Mission Task.

### 3.3 Scheduler compatibility coordinator

Scheduler observes ready-set signature/count and free Cores, orders Cores by fewer startup attempts, earlier dispatch and Core key, then starts at most the ready Task count. Each start request carries a generic prompt and count, not an assignment.

Defaults are three startup attempts, 1-second retry backoff and 1-second dispatch backoff. A ready-signature change resets attempts/backoff/exhaustion; a real observed Task ownership cycle clears successful-signature suppression. A closed generic Session without ownership can receive a bounded replacement. A successful unbound turn that never takes a Task cannot cause infinite relaunches on an unchanged signature. Startup failures are classified as timeout, provider failure or other startup failure.

## 4. Durable Execution record

| Field group | Values and meaning |
|---|---|
| Identity | `execution_id`, `task_id`, `owner_ref`, nullable immutable `core_id`, unique `launch_token` |
| State/specification | `state`, `state_version`, `spec_version`, `spec_hash`, `attempt_no`, `instruction_version` |
| Incarnation | `session_generation` starts at 1; `fencing_version` starts at 1; `runtime_generation` defaults to 1 |
| Lease | `lease_expires_at`, `heartbeat_at`; default take/heartbeat lease is 30 seconds without caller override |
| Input/prompt | `agent_prompt`, `workspace_manifest_ref`, `input_material_refs`, `input_snapshot_hash`; returned `workspace_snapshot_hash` aliases the last field |
| Workspace selection | `mode` (`resume` default or `clean`), selected revision, source Execution and source Workspace |
| Saved output | Workspace path/revision/content hash, checkpoint path/hash, current Material ID; initially null |
| Timebox | Start time, reminder deadline, execution deadline, reminder-sent time; set on start, not take |
| Continuation | Steer Material references, wait condition/deadline/token, handoff metadata, terminal reason |
| Audit | Creation/update timestamps |

The persisted `agent_prompt` is not a transcript or necessarily the final model input. Runtime adds context, capability/service documents, notifications and later prompts. See [01](01-agent-core.md) for the precise composition and recording boundary; [11 Storage](11-storage-reference.md) contains the complete DDL.

## 5. Take → Workspace → Session

Task Service atomically validates take, persists E and its replay receipt, and reserves Task/Bot/Core authority. Physical preparation is separate. A registered Bot already has its Sandbox and unbound Pi session before selection. Runtime resolves immutable public Workspace/Material inputs, prepares the protected guest, activates E and grants project access. Bridge keeps contributions closed until activation completes. Failed preparation follows cleanup; it never authorizes a partially prepared project.

The following start/bind table describes general Runtime APIs and host support-Workspace preparation, retained for compatibility. Their directory/checkpoint/Session-launch order does not replace the registered Bot sequence above.

| Start seam | Exact high-level order |
|---|---|
| `startExecution` / `startTakenExecution` | Validate state/capacity/Core → prepare Workspace → persist reference → commit `start_execution` → launch adapter → save adapter runtime manifest → register binding → ensure sandbox → compose/send prompt |
| `bindAgentExecution` | Validate state/capacity/Core → prepare Workspace → compose optional snapshot → commit `start_execution` → use supplied Session or startSession callback → register binding → ensure sandbox → send prompt or queue notifications |

In the compatibility WorkspaceManager path, a private support Workspace exists before the model process starts. Restoring an already persisted revision does not re-save the same revision as a new one. When a heartbeat races filesystem work, saving the Workspace reference retries a stale state-version error up to three times with a fresh envelope; the exact filesystem revision has already been saved.

Reusable binding with `sendInitialPrompt:false` avoids a second initial prompt inside an active tool-call turn. Pending notifications are still queued at the next settled boundary; the caller/Bridge supplies current Task information to the continuing identity.

Before `start_execution` commits, a preparation error triggers a fence attempt with `startup_prepare_failed` or `bind_prepare_failed`. After the durable start, failure records `FAILED` with `startup_failed` / `bind_failed`. Runtime removes occupancy, stops sandbox/bound failed Session and preserves any already prepared Workspace evidence. These are compensating steps, not a rollback of every file.

Bridge binding adds another failure boundary. After recording new IDs it invokes `onTakeAccepted` and `onTake`. On failure it attempts Runtime stop (`FAILED/task_take_bind_failed`), or a fresh Task Service stop/fence fallback, then clears Bridge IDs/cache and invokes `onRelease` best effort. Cleanup failure is swallowed to preserve the original exception: release is attempted, not guaranteed merely because the take call returned an error.

### 5.1 OpenSandbox provider boundary (Issue 119)

`OpenSandboxManager` implements the external provider in `src/runtime/opensandbox-manager.js`. Positive-duration production benchmarks require the configured OpenSandbox deployment; injected zero-duration fixtures and general library callers have separate validation paths. The 1.2 lifecycle API allocates a sandbox from the pinned image/fixed worker entrypoint, resolves endpoints and deletes resources. Registered sandboxes belong to Bots before selection and retain that identity after take. Resource limits, allowed nonsecret environment and scoped metadata accompany creation; API credentials stay out of public snapshots.

The provider deliberately ignores the host `workspaceRef` as a mount source. It reports `/workspace` as the guest work path and keeps the host reference only as a private in-memory audit value. Configured volumes are schema-checked and host-path mounts are rejected; deployments must use provider-managed volume backends. After endpoint resolution, production calls Execd `/ready` and accepts `/ping` for Execd versions that do not expose `/ready`. With `foregroundSession=true`, commands use Execd `/session` and `/session/{id}/run`; a timeout interrupts the active session through `DELETE /command?id={sessionId}` before deleting the session. Deployments without that endpoint fall back to the older `POST /command` path, where array commands first use native `argv` and retry as shell-quoted `command` text for older Execd images that reject `argv`; a foreground timeout records `sandbox.exec_timeout_disconnect` and remains provider-dependent. The result parser accepts both conventional SSE `event`/`data` records and the JSON-lines records emitted by the released Execd image, reducing `stdout`, `stderr`, completion and error events to the Runtime sandbox result. Background IDs are retained for `GET /command/status/{id}` and `DELETE /command?id={id}`. `stopExecution` cancels tracked jobs before deleting the provider sandbox, and a failed endpoint lookup or readiness gate compensates by deleting the just-created sandbox. Provider diagnostics are bounded and redact credential-shaped fields before entering errors or snapshots. HTTP failures become typed retryable service errors where the status supports retry.

Runtime accepts this provider boundary, exported from `src/index.js`. Registered startup requires a Bot identity and fixed worker, launching native Pi in `/workspace/project`; the project remains protected until take preparation/activation/grant. Home, temporary data, model catalog and Session state live below `/workspace/runtime`. Take associates the existing Bot sandbox with E. Explicit public save provides continuity; `syncWorkspaceBack` and host checkpoint APIs are compatibility transport. Unregistered trusted diagnostics can use Execd but cannot launch a research Agent through retired unregistered startup. `RemoteAgentChild` maps worker RPC/events to Session. Restart cannot recover the old credential/private Pi context: reconciliation quarantines/deletes the orphan and requires fresh Bot authority.

When `Runtime` receives `cleanExecutionWorkspaces: true`, preparation rejects an Execution that already has a durable Workspace reference, then ignores `workspace_selection.mode=resume` for a new Execution. It creates a path derived from the new Execution ID and fence (`<execution>-fresh-<fence>`), writes the normal task/input snapshot, and starts Pi against that path. The benchmark runner enables this switch automatically for the OpenSandbox provider. Recovery of the same durable Execution does not re-run preparation, so recovery can still use its recorded durable Workspace; a later take receives a new Execution and therefore a new clean path.

## 6. Transactions, authority and fencing

Mutating Task Service dispatches use `BEGIN IMMEDIATE … COMMIT` and persist operation fingerprint/result. Same operation ID and fingerprint replays; a changed payload conflicts. Take, wait and wake also have dedicated request keys.

Execution writes carry Task/Execution IDs plus specification, state and fence versions. Task Service rejects mismatched Task, stale specification/state version, stale fence and terminal Execution. Semantic handlers add owner checks where required. The low-level version checker is not an all-purpose actor authentication mechanism: Bridge binding and the operation-specific handler establish caller authority.

Runtime uses its daemon actor for physical lifecycle operations. In unregistered compatibility APIs, semantic handoff/block uses the Execution's authenticated `owner_ref`, for example `agent:core-2`; using `runtime:core-2` would fail the Task owner check.

In the legacy terminal-release path, durable ownership ends before best-effort physical Workspace fencing on release. A failed physical fence is logged and does not roll back a terminal Execution. Later service writes still fail durable state/fence checks; this does not prove an arbitrary host process was physically isolated.

For compatibility semantic handoff/block, Runtime marks the binding closing, stops sandbox jobs, dispatches the Task transaction, then releases binding/Workspace. If Task validation rejects and that same Execution remains active, `#semanticRelease` restores `closing=false` so the Agent can correct its request. That repair is not universal across the older Runtime methods.

Registered `task_finish` instead commits a finish intent and `CLOSING` while retaining Task/Core ownership. Runtime stops the Session and confirms provider cleanup before trusted `finalizeExecutionFinish` projects the outcome and releases ownership. Failed or ambiguous cleanup keeps the binding occupied and retries; a terminal database write is not a substitute for isolation. Registered hard-stop/expiry uses the same retained cleanup ownership. See [accepted finish](03-mission-task.md#accepted-finish-and-safe-release) and the [registered lifecycle](#registered-bot-lifecycle) below.

## 7. Time, health and recovery

### 7.1 Three independent clocks

| Clock | Class default | Result of the relevant sweep |
|---|---|---|
| Lease | 30 seconds in Task Service without caller override | Expire overdue `CREATED`/`RUNNING` Execution, increment fence, release process |
| Productive-progress watchdog | 120 seconds | Recover a `RUNNING` Session outside active turn/retry/compaction phases with no productive completion |
| Execution timebox | 60 minutes; reminder at 55 minutes | Persist one reminder, then hand off as `EXPIRED`, reason `timeout`, metadata `TIMEBOX_EXPIRED` |

Modern Task `timebox_ms` replaces generic duration; a global run deadline caps it. Runtime uses at least 1 ms. With a run deadline it keeps configured reminder lead time before the earlier end; without one it uses the lesser of configured reminder offset and just before Task timeout.

The generic `start_execution`/compatibility restart path recalculates attempt times, capped by its run deadline, and relies on composition-driven sweeps. Registered Bot startup additionally arms automatic selection and hard-lifetime timers. Take never resets the Bot lifetime: activation intersects Task, Execution, Bot and Mission limits and rearms the timer to the earliest deadline. Registered recovery closes the Bot instead of restarting its private Session under renewed authority. The registered timing/cleanup contract is detailed under [registered lifecycle](#registered-bot-lifecycle) below.

Reminder-sent time is committed before delivery. Modern Tasks receive durable `handoff_warning`; compatibility Tasks receive a direct follow-up. Registered expiry revokes the actual E and closes the Bot without inventing a handoff Material. Historical expiry paths may additionally record whether an existing Handoff Material was linked; that is an audit fact, not an automatic new research conclusion.

### 7.2 Event-derived health

Runtime records phase, last event/heartbeat/completed turn/successful service call and last productive timestamp. Completed turns, successful tool completions, successful compaction and successful provider retry count as productive boundaries. A heartbeat renews a lease without proving research progress. For a registered Bot's Execution, the Task Service checks the stored lease against the current time inside the heartbeat write transaction. After expiry a queued heartbeat is rejected even if expiry reconciliation has yet to change durable state. The row and its version stay unchanged. This check uses the Execution owner, including when the Runtime submits the heartbeat under its own actor reference.

`turn_start`, `auto_retry_start` and `compaction_start` synchronously increment a phase epoch. A completion handler that awaited session stats may reset phase to idle only if no newer phase began. The watchdog skips an active turn, provider retry and compaction even if long-running.

### 7.3 Historical Session recovery and registered Bot replacement

The following same-E recovery flow belongs to unregistered compatibility adapters. Registered Bots instead enter durable closeout and physical cleanup, and a fresh Bot must take a fresh E to continue from public state.

Failure classes include exhausted provider retries, context overflow, compaction failure, process error/exit and watchdog stall. One promise suppresses duplicate recovery. Runtime removes live/sandbox binding, stops the failed Session and increments an in-memory recovery count keyed by **Task ID**. Default budget is one recovery; it is not a persisted per-Execution budget.

Within budget, Runtime fences the old Workspace incarnation and calls `recover_execution`: same Execution/Core, fence +1, Session generation +1, attempt +1, refreshed lease and `CREATED` state with recovery prompt. It resets identity compaction count and starts a fresh Session from durable Workspace/checkpoint. Beyond budget it fences with `recovery_exhausted`; a still-live responsibility can return to the queue.

`restartSession`, used by explicit identity rotation, also usually preserves Execution/Core and uses `recover_execution` for a running attempt. Session replacement is not a Task handoff. Recovery instructs the new model to inspect durable facts and not assume its interrupted turn completed.

These recovery APIs remain executable for unregistered local compatibility Sessions. They do not apply to registered OpenSandbox Bots: `restartSession` rejects registered identity replacement, and registered Session failure enters stop/cleanup without private recovery. Runtime retains explicitly configured role information for compatibility callers; a role label does not grant a registered Bot a second Execution. Phase 02 public continuity is the implemented registered path.

## 8. Release, switch and shutdown

| Boundary | Durable effect | Physical effect |
|---|---|---|
| `releaseExecution` | None; a service already reached terminal state | Mark Core CLOSING; drain saves; confirm Session and sandbox stop; reconcile/release Workspace; only then mark Core IDLE |
| `stopExecution` | After confirmed process/sandbox stop, record terminal state/reason; retries preserve an existing terminal result | Same physical release |
| `fenceExecution` | `FENCED`, fence increment, generation/reason | Confirm worker and sandbox stop, commit fence, reconcile Workspace fence and release binding/Core |
| `detachSwitchedExecution` | None; old fence/new take already committed | Use previous fence to revoke old Workspace, detach old binding for same-Session rebind |
| Runtime `restart` | Runtime generation +1; fence active `CREATED`/`RUNNING` attempts | Stop all owned Sessions, including released reusable Sessions; preserve legacy `WAITING` responsibilities |
| Runtime `shutdown` | Default `FAILED/runtime_shutdown`, configurable by caller | Set stopping, unsubscribe callbacks, release live bindings, stop all owned Sessions, await recovery/release work |

A Session with `identitySession=true` survives normal Task completion/handoff/block
only in compatibility mode. With `freshBotPerExecution=true`, Runtime clears
the binding, removes the Session from `identitySessions`, and stops it before
the next Bot starts. Shutdown owns both active and temporarily unbound
Sessions.

`releaseExecution` serializes concurrent cleanup for one Execution. Stop failures propagate and retain the in-memory active binding and `CLOSING` Core; a later call retries cleanup. A closed Pi transport alone is insufficient: the OpenSandbox adapter's `session.stop` also confirms deletion of its original worker sandbox, which may have a different key from the Task Execution sandbox. HTTP 202 from deletion triggers a bounded GET; if the resource still exists, cleanup remains pending. A failed Workspace fence is reconciled from current owned metadata to the durable Execution fence before release. Release is idempotent for the same owner/fence, including a failure between primary and revision metadata writes.

Explicit stop, lease expiry and timebox handoff stop both resource bindings before ending durable ownership. Closing bindings reject Runtime heartbeats and skip productive watchdog/notification handling; health views report `phase: closing`, with nullable timestamps for failed prelaunch bindings. Lease expiry refreshes durable state after cleanup. For a legacy Execution without a registered Bot, a direct Service heartbeat can still change the lease during local closing. The now-stopped attempt then records `FAILED/lease_changed_during_cleanup`. Startup rollback, process exit, restart and sibling fencing retain cleanup ownership on failure. Runtime tracks in-flight start/bind promises; shutdown rejects new startup, joins existing preparation and stops a late Session before it can become available. Shutdown continues across failures and returns `cleanup_pending_execution_ids`, `cleanup_pending_session_count` and `active_process_count`; a successful function return is not itself proof of cleanup. The benchmark's terminal-release sweep preserves its Bridge/Core binding on failure so a later sweep can retry. Its shutdown records unresolved cleanup as errors and emits `benchmark_cleanup_complete` only when cleanup is confirmed. Tests in [runtime-cleanup.test.js](../../test/runtime-cleanup.test.js) exercise the real Task Service, Runtime, Workspace, Bridge and benchmark cleanup functions with model/provider boundaries controlled locally.

Bot-initiated `task_finish` now persists CLOSING and its finish intent before cleanup, keeping the Task unavailable until physical isolation and conditional finalization. Task Service events initiate this cleanup independently of the CLI. Runtime retries failed finish cleanup at most `maxFinishCleanupRetries` times (default 3), using `finishCleanupRetryMs` (default 1000 ms) with exponential delay capped at 30 seconds. Exhaustion records `retries_exhausted` and retains ownership; an explicit `sweepExpired()` call or release retry can try again, including terminal finishes with retained Workspace cleanup. This method is a callable maintenance hook, not an autonomous periodic timer. Shutdown cancels scheduled retries and cleans retained bindings. Concurrent release callers join the same promise. Release rechecks for a newly accepted finish after provider and Workspace I/O before freeing the Core. Session restart, unexpected-exit recovery and fencing also reread durable state before removing their original binding; an accepted finish wins over starting a replacement. Finish history and replay survive database reopening. A Runtime with no resource binding refuses to treat an empty process map as isolation evidence. Startup reconciles registered durable Bot/resource identities against the scoped Provider inventory before opening new Bots. It distinguishes never-dispatched, explicitly rejected and uncertain create attempts, persists recovered IDs before deletion, and requires confirmed absence before release. It does not adopt old Pi sessions. Historical unregistered Execution compatibility methods are not automatically reclaimed by this registered-Bot protocol. The runner no longer force-fences or releases ownership merely because its cleanup deadline elapsed.

One listener set is attached per Session; event handlers read its current Execution binding, preventing handler multiplication on rebind. Closing/absent bindings ignore late events. Sibling fencing uses tracked pending-release promises and updates occupancy after cleanup reaches release.

For compatibility register-and-switch, the old fence and new take share a Task Service transaction, but the earlier progress save and later detach/`onWorkUnit`/`onRelease`/new binding do not. A post-transaction callback error can occur after old authorization has ended and the new take exists.

## 9. Current lifecycle limits

The current Mission model has one canonical Task lifecycle: an identity inspects the bounded eligible view, calls `task_take`, works in its clean Workspace, records progress, and ends with `task_finish`. Typed dependencies are represented by the current Task completion contract and reconciliation state. The registered Bot surface does not expose wait, wake, resume or registration-and-switch. Exported Runtime/Task compatibility APIs retain some of those writers for trusted unregistered callers; their existence does not authorize Bots to bypass the canonical lifecycle. Historical rows and receipts remain readable.

Registered cleanup distinguishes acceptance from completion: finish first persists its intent and CLOSING, rejecting new contributions while retaining the owner. After Session/Sandbox isolation, finalization projects Task outcome, advances the fence and releases occupancy. Stop/expiry likewise retains cleanup ownership until isolation. A failure or timeout before confirmed cleanup is pending/failed cleanup, never a completed release. Legacy terminal-release APIs retain their separate ordering described above.

## 10. Code and existing verification map

| Source | Covered behavior | Existing tests |
|---|---|---|
| [identity-task-loop.js](../../src/runtime/identity-task-loop.js) | Discover/propose/take, cooldown, signal races and failed handoff | [orchestration-roles.test.js](../../test/orchestration-roles.test.js) |
| [task-controller.js](../../src/runtime/task-controller.js) | Reconciliation, discovery wake deduplication and health callbacks | [orchestration-roles.test.js](../../test/orchestration-roles.test.js) |
| [scheduler.js](../../src/runtime/scheduler.js) | Generic startup budget and signature suppression | [scheduler.test.js](../../test/scheduler.test.js) |
| [runtime.js](../../src/runtime/runtime.js) | Binding, events, deadlines, recovery and cleanup | [Workspace contract](../../test/workspace-contract.test.js), [cleanup integration](../../test/runtime-cleanup.test.js) |
| [task-service.js](../../src/task/task-service.js), [task-types.js](../../src/task/task-types.js), [schema.js](../../src/storage/schema.js) | Durable state/version/Core/lease transitions and replay | [flat Task behavior](../../test/task-oriented-flat.test.js),  |
| [services-bridge.js](../../src/agent/services-bridge.js) | Identity, same-lane bind/switch and compensation | [profile/Bridge](../../test/capability-profile-bridge.test.js), [direct Judge](../../test/judge-direct-submit.test.js) |

Test links identify existing regression scenarios, not a claim that they ran in this documentation session. Mock adapter tests do not establish live-provider, Docker or long-duration scientific behavior.

## Registered Bot lifecycle

The benchmark calls `Runtime.startBot` before discovery; no Task or Execution is manufactured to occupy a Core. Registration persists Bot/Mission/Core, a unique resource key and selection deadline. The `bots_occupied_core` index prevents a second non-CLOSED Bot in the same Mission/Core. Runtime also checks its live Core and existing Execution occupancy. Four configured free Cores may enter STARTING independently, including when the Mission has zero Tasks. When configured, the Runner sets the first discovery time for Core N to orchestration start plus `(N − 1) × initialBotStaggerMs`; the library default is zero. The delay occurs before Bot registration or sandbox creation and counts against the original run deadline. It does not consume selection or Bot lifetime, which start at registration. Later Bots on that Core use normal cleanup and backoff without repeating the initial offset. Stop wakes delayed loops and Mission/deadline guards are checked before startup and before sending discovery.

The durable Bot states are STARTING → UNBOUND → PREPARING → ACTIVE → CLOSING → CLOSED. `task_take` atomically stores the sole Execution ID and PREPARING; it rejects another owner, Mission/Core, an expired deadline, or a Bot that already took work. Runtime verifies that binding uses the retained original Session/Core, prepares the Workspace in that Bot's existing Sandbox, then activates the Execution and marks the Bot ACTIVE. The provider manager retains both Bot resource-key and Execution aliases to one record; snapshots count it once and confirmed deletion removes every alias. The immutable input tree is pinned before activation and worker-enforced project permissions are granted only after durable activation, as detailed below.

The default unbound budget is 300,000 ms and covers startup as well as discovery. It must be positive, finite and within the JavaScript timer limit. Expiry records `selection-budget`; a Session close/error records `process-exited`/`process-error`. A Bot that already took work is governed by Execution lifecycle instead. For an unbound Bot, `bot_exit` checks the stored selection/hard deadlines and current Mission state in the Task write transaction. Before those deadlines on an open Mission, it rejects both `no-work` and `selection-budget` with `NOT_ALLOWED`, phase `discovery_required`. The Bridge asks the Bot to check existing work and identify a concrete gap with a verifiable deliverable. When the Mission has stopped or a real budget deadline has elapsed, a valid exit records CLOSING and the reason. These routes create no Execution. Expiry or shutdown cancels the startup wait and stops already-visible Session/provider resources. Cleanup refuses to mark CLOSED while a non-cooperative startup factory is still running; its late result remains attached to that Bot and receives another cleanup attempt. Startup failure retains its Bot binding when physical cleanup fails.

For a taken Bot, accepted Task finish marks the Bot CLOSING. After Session/Sandbox isolation, finish finalization and Workspace release, Runtime marks it CLOSED and frees the Core. Failure and hard-stop paths likewise require a terminal Execution before Bot closure. Registered Bots cannot use `restartSession` to attach another Pi to the same Execution; unexpected active-process failure ends that Execution and Bot. The compaction-limit path also ends the registered Execution as HANDED_OFF and closes its Bot instead of replacing Pi. Historical unregistered Runtime callers retain the old recovery path, so its documentation elsewhere in this chapter applies only to those callers.

Unbound cleanup uses the same bounded retry settings as accepted finish cleanup (`finishCleanupRetryMs`, `maxFinishCleanupRetries`); exhausted retries retain ownership. `sweepExpired` explicitly retries retained CLOSING unbound Bot bindings. Shutdown joins startup, stops bound Executions, then closes unbound Bots; its result includes `cleanup_pending_bot_ids`. At restart, scoped provider reconciliation uses persisted Bot ownership and canonical resource metadata to locate and remove uncertain resources before releasing Core occupancy. It does not adopt an old Pi Session or token. Lost create/delete acknowledgements have been exercised against the actual provider; this is resource recovery, not restoration of private research context.

Preparation observes Session closure before activation. A close during PREPARING triggers failed cleanup against the retained Bot Session/resource key even when no Execution alias exists yet. A different supplied Session is rejected without replacing cleanup ownership. Provider input-copy commands must exit zero; a failed write rolls preparation back. Late preparation cleanup checks the current Core owner before changing its state, preventing a retired Bot from clearing its successor's occupancy. Task Service and Runtime both reject another owner entering a Core reserved by an unbound Bot.

For registered Bots, Runtime stop requests persist CLOSING, reason and the requested terminal Execution state before physical cleanup. A preparing Execution is registered as retained cleanup ownership even if it never reached active-process registration. Process exit starts bounded cleanup retries; explicit maintenance and shutdown also see this record before lease expiry. Concurrent stop requests join one stop promise and preserve the first accepted stop classification. Cleanup rechecks both Session identity and persisted provider identity after awaited deletion, so a resource arriving during that await cannot escape the final stop.

Registered-Bot preparation rollback joins the same stop promise and honors its persisted terminal reason. A new `task_finish` requires that Bot to remain ACTIVE and own the Execution; it cannot replace an accepted Runtime stop during provider deletion. An exact previously accepted finish receipt remains replayable after closure. Standalone `startExecution` rejects a registered Bot reservation because only `bindAgentExecution` can retain its original Pi.


### Bot lifetime bound

`startBot` accepts `maxLifetimeMs` in addition to selection and readiness limits. Its default is selection plus the configured Execution limit; the benchmark supplies its own finite Bot maximum. Before creating a provider resource, Runtime persists `hard_deadline = min(start + maxLifetimeMs, Mission run deadline)` and clamps selection to it. An already elapsed run deadline rejects startup. The hard timer remains armed across STARTING, UNBOUND, PREPARING and ACTIVE, including asynchronous input preparation; take never resets it. Expiry records `bot-lifetime-budget`, cancels startup or accepts an Execution stop, and invokes the same retained-resource cleanup as other lifecycle stops. Closing remains occupied until cleanup is confirmed; a timeout is not isolation evidence. Successful cleanup clears both timers. Historical Bot rows without a hard deadline are migrated conservatively to their recorded selection deadline; startup also repairs NULL values left by an interrupted earlier migration.

Activation intersects Task timebox, Runtime Execution maximum, remaining Bot lifetime and remaining Mission time. The active Bot timer is rearmed to this earlier persisted Execution deadline, so stopping does not require an external sweep. Task Service rechecks PREPARING state, exact Bot/Execution/Core binding and the current hard deadline inside the activation write transaction, including after SQLite lock acquisition. Its soft reminder preserves the configured lead interval before that earliest deadline (at activation when the remaining time is shorter than the lead interval). A longer Task timebox cannot extend a shorter configured Execution or Bot limit. This bounds runtime lifetime. The model gateway independently enforces request and lifecycle deadlines before dispatch. Its optional financial mode also reserves request/token/cost upper bounds; default time-bounded mode records observed usage with unknown cost. Local Docker enforces process, network and writable-filesystem limits; their required deployment contracts and unsupported configurations are documented in [07](07-run-configuration.md).

For a benchmark configured with a 6-minute selection limit and a 30-minute Bot and Execution maximum, the clock starts at Bot registration. For example, a Bot registered at 12:00 must reserve a Task by 12:06. If its Execution activates at 12:05, it has at most 25 minutes to execute. A shorter Task timebox or closer Mission deadline can end it earlier. With the benchmark’s default reminder calculation for a 30-minute Execution maximum, soft closeout starts three minutes before the effective deadline, or at activation if less than three minutes remain. The reminder can be delivered after an ongoing model request, so save useful work as it becomes available.

The lifetime cap is an upper bound. An accepted finish starts cleanup immediately, even if the Bot has substantial time left. Each Bot has at most one Execution. Once physical cleanup releases the Core, the benchmark can start a fresh Bot while the Mission is open and time remains. The initial Core stagger occurs before registration and consumes only Mission time. Later Bots use their own selection and lifetime clocks.

In the required third-party benchmark path, a typed `BOT_STARTUP_CONTRACT` while starting a Bot is a project startup failure. The runner records the Core and error code, closes discovery for all Cores, wakes the outer loop and performs the existing retained-resource cleanup. Its report uses `stop_reason=bot_startup_contract`, marks the run invalid and records actual cleanup rather than creating more identical failing Bots. The CLI exits nonzero with a startup diagnostic. Transient startup errors retain bounded recovery; normal Task finish, selection expiry and lifetime expiry still allow replacement while the Mission is open. Provider API health and a readable image do not establish that this actual worker/resource handshake has passed.

Deadline enforcement is synchronous at new Task mutations and Bridge contribution dispatch, and at Context writes when its trusted Task authority is connected. Original durable Task/Context receipts remain replayable after expiry. The timer is responsible for resource cleanup, not for extending authorization. Registered Bot Execution timeout sweeps use the same durable stop path as the Bot timer, with `execution-timebox` for an earlier Task/Execution bound; neither path invokes legacy handoff, private sync-back, revision save or checkpoint synthesis. Unregistered compatibility Executions retain the old handoff path and are not evidence of phase completion.

Registered public-Workspace take preparation now pins the entire initial revision and records `workspace_input` before activation. The configured Mission Workspace is authoritative over any conflicting Task hint. Main changes during copying do not alter this input; later save/apply bookkeeping must preserve it. The complete initial-tree flow and remaining provider boundary are documented in [05](05-workspace-continuity.md).


### Protected project take order

For a registered Bot with pinned public input, Runtime binds the existing Sandbox, transfers the manifest's files into `/workspace/project`, and calls worker prepare while the Bot is PREPARING and E is CREATED. The worker validates the exact guest file set and hashes and protects it as root-owned read-only input. Runtime then activates E in Task Service, rearms its effective hard timer, rechecks the durable deadline and asks the trusted worker to grant UID 10001 project write access. It rechecks Bot ACTIVE state, cleanup ownership, Session liveness and deadline after grant returns; only then registers the active binding and finishes take delivery. Bridge rejects concurrent calls while this callback is pending. Grant failure or late completion after stop enters the existing durable stop/cleanup path; it cannot return a successful take or replace the recorded stop reason. No new provider resource is created for take.

The project worker serializes prepare/grant/close and records a closing flag before waiting on its operation queue. A stop racing a grant prevents its final ACTIVE result and revokes after process termination. A Bot Sandbox take without pinned public Workspace input is rejected. Unregistered OpenSandbox Agent launch is explicitly retired; local compatibility adapters remain separate. Save and apply use the same worker ownership and quiescence boundary; their capture, installation and rollback order is described in [05](05-workspace-continuity.md).

Before grant changes ownership, the worker serializes its process operation, sends SIGSTOP to the child and every dedicated-UID process, and requires two stable scans confirming stopped state within two seconds. It closes project root traversal while recursively preparing ownership, then opens the root as the last permission change. Pi and detached writers remain paused until ACTIVE is recorded. This includes a writer retaining a pre-opened descriptor; directory permissions alone would not protect against it. A partial permission failure marks closing and stops the Bot instead of resuming a partially granted tree. Concurrent stop prevents resume and awaits revocation. Stable save capture and apply installation also pause the dedicated-UID process set and retain cleanup ownership on failure. Local tests cover open descriptors, background writers and rollback; controlled OpenSandbox diagnostics additionally exercise actual save and apply.

The OpenSandbox adapter generates a fresh UUID for the Pi Session when its caller supplies none. The same UUID appears in the worker launch arguments, Runtime Session and observations. The durable Bot ID and Provider resource key remain separate, including the colon in their internal identifiers. The real Pi contract probe exercises the default adapter launch with a colon-containing Bot ID and verifies RPC readiness.

The combined four-lane integration test in `test/bot-runtime.test.js` uses actual CLI subprocesses with controlled provider and Pi sessions. All four first query a zero-Task Mission, propose separate responsibilities and take through their own authenticated Bridges. Four distinct E/Sandbox identities overlap in RUNNING before any finish; Material production stays bound to each E. The test then requires all Sessions stopped, provider resources removed and Cores IDLE before starting a fresh successor. This establishes controlled integration, not autonomous model behavior or real provider filesystem isolation.

## Benchmark deadline and cleanup admission

The active run deadline bounds the initial Controller reconciliation, terminal-release maintenance and each subsequent reconciliation. A timed-out operation remains tracked; the caller stops productive orchestration rather than waiting forever before entering `finally`. The poll delay is capped by the remaining run window. A Controller stopped while reading public state will not later signal another Bot.

`stopBenchmarkRuntime` first disables new wake requests, unsubscribes Task hints, aborts/stops identity loops, and starts Controller and all Core cleanup concurrently. A single absolute deadline, by default 30 seconds after cleanup begins, covers Controller/identity joins, watchdog and timeout sweeps, previously timed-out maintenance, and every Core. Each Core concurrently drains startup, shuts down Runtime, stops Bridge transport and Sessions, and joins turns and Runtime handlers. A startup rejection settles the startup join. The adapter and Runtime confirm resource cleanup separately, and a failure or timeout of either owner remains a cleanup error. A rejected cleanup promise does not skip waiting for its independent siblings.

Runtime shutdown marks each known Bot closing before waiting for startup, starts physical cleanup of existing Executions and unbound Bots concurrently, then joins and cleans any late startup ownership. Bridge stop is one-way and coalesces concurrent callers. It refuses new direct calls and closes HTTP admission/connections, independently tracks admitted HTTP handlers and direct calls, then drains them before deferred lifecycle work, so a client waiting on Runtime cannot block Runtime from starting shutdown. Accepted operations still own their durable outcomes; a lost transport response is not a rollback.

An operator stop interrupts the orchestration wait, disables discovery and Core dispatch, and enters the same concurrent cleanup. If a Controller or terminal-release operation was awaiting external work, cleanup still holds its original promise. Initialization checks the signal after fixture and checker deployment verification, provider preflight, and before starting the model gateway and allocating Cores. An already-running initialization call, including artifact hashing, settles at its own boundary before the Runner handles the stop. A rejected setup call after a stop request yields an operator-stop report. The Runner fixes each project's stop decision before cleanup. A signal during normal cleanup or report output leaves that outcome intact. Runtime-owned processes that require termination because the operator interrupted the orchestration carry the operator-stop reason. [Benchmark CLI](07-run-configuration.md)

A grace timeout records the specific pending component and Core. Runtime retains Task ownership and Core occupancy until physical stop is confirmed; reporting does not manufacture a terminal fence. The shared authority database remains open for tracked late cleanup receipts and closes after those joins settle. Initialization, orchestration and report-writing exceptions use the same cleanup/close ownership; neither a thrown error nor a disconnected HTTP client skips admitted work. In-process joins retain actual promises; a fresh process instead uses the separately described durable Bot/provider reconciliation. A cleanup timeout alone proves neither path complete. The report records its cleanup snapshot as invalid if any component remains unresolved.

## Soft closeout admission

`src/task/execution-budget.js` is the shared interpretation of soft closeout: the persisted `handoff_deadline` has elapsed, or an earlier reminder has been recorded. Message delivery and periodic sweeps do not extend this boundary. E remains active until finish or the hard limit; existing file save, Material publication and finish remain available under their normal authority guards. These gates do not claim to classify arbitrary Bash computation semantically.

Task proposal checks this phase after durable receipt lookup inside Task's write transaction. New apply checks before guest capture and again under the SQLite writer lock before its immutable `captured` plan is admitted. A completed apply receipt returns before unrelated pending recovery; a plan already captured before closeout can finish its original installation and acknowledgement while E remains hard-active. New main merge uses the same phase predicate. New Judge work checks shared Task authority within Judge's admission transaction, and again after asynchronous preflight before invoking the source checker. If preflight crosses the boundary, the accepted request receives a durable `request_failure` with `soft_closeout`, not a mathematical FAIL or checker infrastructure failure. Same request IDs retain their original fingerprints/results.

Ordinary continuation is selected again after Session readiness immediately before the actual prompt call; a closed/replaced/expired binding is not sent another research prompt. During soft closeout, both continuation paths and registered compaction follow-up use the save/publish/finish-only message. The complete bodies and actual composition conditions are in [Prompts](08-prompts.md). Phase enforcement does not classify the mathematical intent of arbitrary native Bash commands. The separate implemented Mission acceptance/closeout protocol is described in [Mission and Task](03-mission-task.md#accepted-mission-closeout).


### Provider creation intent on restart

New Bot rows start with `sandbox_create_state=NOT_DISPATCHED`. Immediately before sending the OpenSandbox create POST, the Runtime callback checks runtime stop and time limits. Task Service checks the persisted Bot state, both Bot deadlines and the Mission stop gate in the same transaction that commits `UNKNOWN`, the provider name and requested TTL. If admission fails the row remains `NOT_DISPATCHED`. The worker start POST independently rechecks authority after endpoint and health preparation. Task Service checks it again in the transaction that changes `STARTING` to `UNBOUND` after Session readiness. A stop during startup keeps the Core occupied until cleanup is confirmed. The adapter sets the provider TTL to the remaining Bot hard lifetime plus 30 seconds of cleanup, rounded up and subject to the provider's 60-second minimum. The HTTP request timeout separately bounds the caller's wait. A definitive provider rejection from the create endpoint records `REJECTED`. A successful response records `CREATED`, the sandbox ID and a valid provider `expiresAt` if supplied, before endpoint or worker preparation. A crash after the intent and before POST can remain conservatively unknown. Migration treats old rows with no ID as unknown because their old dispatch ordering cannot be established.

Restart can close an unbound Bot whose durable state proves no POST or definitive rejection. Unknown creation keeps the Core occupied even if a fully paged provider list finds no resource. If a unique consistent provider resource is discovered, Runtime persists the sandbox ID before deletion and waits for confirmation before freeing Task and Core. The requested TTL and a reported expiry are evidence, without taking elapsed local time as confirmation of physical isolation or deletion.

Provider metadata uses canonical `mission_key`, `bot_key`, and `resource_key` labels instead of the local IDs. The keys have a kind prefix and 48 lowercase hexadecimal SHA-256 characters. The compatibility Execution-only route uses `execution_key`. Runtime retains the original identities in Task storage. Recovery accepts historical raw labels when they agree with those durable identities and keeps conflicting label evidence pending.

### Bot filesystem budget

For timed local-Docker runs, OpenSandbox starts the worker in quota-enforcement mode with an empty, uninitialized `/workspace`. The host checks the container's full identity and Mission/Bot/resource labels. A privileged host helper pins the container process, mount namespace and root through open descriptors, verifies that the container owns the process and the root mount is private, rejects an existing or populated Workspace, and mounts a byte- and inode-limited `tmpfs` at `/workspace`. The host then checks the container identity again. The worker checks the real filesystem, exact block and inode limits, mount flags and absence of nested mounts before preparing its directories. It probes Landlock under the Bot UID, then uses that restriction for Pi and its descendants. Writable project, scratch, home, cache and session files use the same quota. Outside that tree, the filesystem policy permits writes only to `/dev/null`. Container deletion discards the tmpfs. Invalid identity, mount or policy blocks startup and uses normal provider cleanup; quota exhaustion surfaces as an application filesystem error. The operator session-start event records the verified quota and pinned model-catalog identity.

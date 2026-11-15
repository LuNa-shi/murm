# 01. Agent Core: process, tools, binding and turns

This chapter describes the implementation at the source baseline named in [INDEX](INDEX.md). A Core is a reusable concurrency lane. It runs a Pi conversation, lets that identity choose a Task, and binds the same conversation to the resulting Execution. The model chooses research actions; the Bridge, Task Service and Runtime validate and apply those actions. The model cannot create a valid Execution merely by saying that it has taken work.

The complete prompt bodies, composition branches and delivery evidence are in [08 Prompts](08-prompts.md). State transitions are in [02 Execution](02-execution.md); exact tool schemas and deployment-dependent exposure are in [10 API reference](10-service-api-reference.md).

## 1. Objects that must be kept separate

| Object | Concrete implementation and lifetime | What changes it |
|---|---|---|
| Core | Benchmark `core-N` record and its Runtime/identity-loop slot | It persists across ordinary Task claims and releases within the run |
| Bot | Durable `bots` row registered before Sandbox/Pi creation; owns zero or one Execution | A closed Bot is never reused; the next run on the Core gets a fresh Bot ID |
| Session | `AgentCoreSession`, wrapping one Pi process, RPC stream and conversation storage | The registered Bot keeps this Session from discovery through its sole Task; compatibility callers without Bot registration retain historical restart paths |
| Task | Durable responsibility owned by Task Service | Take, semantic completion, block or close |
| Execution | Durable authority for an attempt: Task ID, owner, Core, lease, fencing version and Workspace | Ends at a lifecycle boundary; a Session restart can keep this ID |
| Capability profile | Normalized Registry/Runtime description for `bound` or `recovery` | Built from Registry revision and the deployment capability list; it is not a Task take |

An unbound reusable identity still uses role `bound`. There is no separate `idle` role in `AGENT_ROLES`; the exported idle/generic/recovery prompt aliases contain the same stable instructions. Role `bound` therefore does not prove that an Execution exists. The Bridge checks the binding separately. [Sources: capability-profile](../../src/agent/capability-profile.js), [Bridge](../../src/agent/services-bridge.js), [benchmark](../../src/benchmark/putnam-runner.js).

## 2. How the model process starts

### 2.1 Adapter configuration and routing

`AgentCoreAdapter` accepts command, provider, model, account/group routing, Session directory, extension path, working directory, environment, version overrides and a system-prompt string or file. `executionId`, `sessionId`, provider, model and Session directory must be nonempty strings when launch arguments are built. The benchmark registers a Bot first and uses its `resource_key` to start the worker. Its observation context has null Task/Execution IDs until binding; this resource key is not an Execution.

The generic compatibility adapter retains its historical `nurouter` default. The benchmark runner defaults to direct `pi`, including its Issue 119 OpenSandbox route; the shipped OpenSandbox image carries the native Pi provider catalog without NuRouter. A programmatic caller may override the command, but a compatibility command then needs a matching image. A command equal to `pi`, or ending in `/pi`, is treated as direct Pi.

| Provider | Provider/model flags are placed on | Additional constraint |
|---|---|---|
| `openai` | Pi arguments after the NuRouter separator, or direct Pi | Account and group cannot both be set |
| `openai-codex` | Pi arguments after the separator, or direct Pi | Account and group cannot both be set |
| `gpt_proxy` | Pi arguments after the separator, or direct Pi | Account and group cannot both be set; default provider of the benchmark CLI |
| `kimi_proxy` | Pi arguments after the separator, or direct Pi | Account and group cannot both be set |
| `kimi` | NuRouter arguments before the separator | The normal route uses NuRouter |
| Other value | Launch rejected with `INVALID_CONTRACT` | No automatic provider inference |

The direct-Pi command check and provider-placement table are separate mechanisms. Selecting direct Pi with a provider whose flags belong to NuRouter does not move those flags automatically. Use the recorded launch arguments to establish what a run invoked.

The Pi argument sequence includes:

```text
--mode rpc
--session-dir <SESSION_DIR>
--session-id <SESSION_ID>
[--extension <SWARMENV_EXTENSION_PATH>]
--no-builtin-tools
--no-skills
--no-prompt-templates
--no-context-files
[--append-system-prompt <SYSTEM_PROMPT_FILE>]
[--provider <PI_PROVIDER> --model <MODEL>]
```

Brackets denote conditional arguments. On the NuRouter path, `pi`, optional NuRouter provider/model/account/group flags and `--` precede these arguments. The process receives piped stdin/stdout/stderr, the selected working directory and a copied environment. Disabling built-in tools, skills, templates and context files prevents automatic loading of development-repository instructions into a research identity. Research capabilities are registered by the explicit SwarmEnv extension. This does not remove Pi's own base system prompt. [Source: pi-adapter](../../src/agent/pi-adapter.js).

Adapter selection matters. With an enabled OpenSandbox provider, the runner constructs `OpenSandboxAgentAdapter`; its launch arguments retain `--no-builtin-tools` and the explicit extension, without the subclass's `--no-tools`, exact-name allowlist or `--exclude-tools parallel` additions. On the compatibility route, when no custom adapter factory is supplied, `BenchmarkAgentCoreAdapter` replaces `--no-builtin-tools` with `--no-tools`, adds `--thinking high`, supplies `--tools <comma-separated exact SwarmEnv tool names>`, and adds `--exclude-tools parallel`. That allowlist is the union of the bound/recovery profiles. These are separate current launch paths; the four-tool contract in phase 02 is a target design, not evidence that either adapter has already enabled it. [Sources: benchmark adapter selection](../../src/benchmark/putnam-runner.js), [OpenSandbox adapter](../../src/agent/opensandbox-agent-adapter.js).

### 2.2 System instructions and version records

For a nonempty system-prompt string, the adapter writes `identity-system-prompt.md` in the Session directory with creation mode `0600` and passes its path through `--append-system-prompt`. An explicit `systemPromptPath` takes precedence for the path. This is a Pi system-role addendum, not an ordinary user RPC. Its [complete body](prompts/01-system-identity.md) is versioned separately from dynamic composition.

The runner supplies that addendum on its local compatibility adapter. Its OpenSandbox route defaults `sandbox.systemPrompt` to null because of the recorded native-provider append-system-prompt incompatibility; the identity instructions still appear in discovery/follow-up user messages. A deployment can explicitly set a supported `sandbox.systemPrompt`. Do not infer a system-role delivery merely from the presence of the template file or from another adapter's configuration.

Before spawning, `createVersionManifest` records exact installed Pi and Node versions (NuRouter is optional for compatibility adapters) and launch arguments. Explicit constructor values win; environment overrides `SWARMENV_PI_VERSION`/`SWARMENV_NUROUTER_VERSION` are next; otherwise the executable's `--version` is queried. The NuRouter field is null on direct-Pi runs and only resolved for compatibility adapters. It rejects non-exact semantic versions. Normal startup does not query npm; the exported latest-version lookup is a separate utility. `package.json` pins Pi package `1.3.0`, while the recorded executable version is the evidence for an actual run. [Source: version-manifest](../../src/agent/version-manifest.js).

### 2.3 RPC protocol and process lifetime

Each command is a JSON object followed by a newline on stdin. `sendCommand` creates an RPC ID, stores a pending promise and starts its timer before writing. Default command/prompt acknowledgement timeout is 30 seconds. A matching response with `success:false` rejects with `RPC_ERROR`; an acknowledgement timeout removes the pending command. A successful acknowledgement is not semantic Task completion.

Stdout is accumulated and split on newlines. Non-JSON lines are ignored by the parser but remain in raw stdout. Parsed records enter `rpcRecords`, resolve matching RPCs and emit the `rpc` event. Stderr is accumulated separately. `waitForReady` accepts a `ready` record when present; Pi 1.3.0 normally has no standalone ready record, so the adapter sends `get_state` and uses its response as readiness. The response also supplies the model context-window value.

`waitForSettled` waits for `agent_settled`, optionally after a record sequence. Its adapter default timeout is 120 seconds; benchmark callers can choose a longer bound. This is a turn boundary, distinct from Execution release. `set_auto_compaction`, `set_auto_retry`, `get_session_stats` and `prompt` are separate commands. Runtime-managed initial turns enable compaction and retry before sending; reusable benchmark startup has its own sequence in [08](08-prompts.md).

Closing the process rejects pending RPCs. `wait()` reports unexpected nonzero exit or signal as `PROCESS_EXITED`. `stop()` marks exit expected, sends `SIGTERM`, waits five seconds by default, then sends `SIGKILL` and waits at most a further second. Runtime decides whether an exit needs recovery. [Source: pi-adapter](../../src/agent/pi-adapter.js).

### 2.4 OpenSandbox worker transport (Issue 119 slice)

The external provider path uses `OpenSandboxAgentAdapter` and the image-resident `scripts/opensandbox-agent-worker.mjs`. Runtime creates the provider sandbox with the worker as its entrypoint (`node /opt/swarmenv/agent-worker.mjs --port 44100`) and supplies a per-Execution bearer token in the creation environment; this keeps the authenticated listener alive independently of Execd command timeouts. It then resolves Pi/Node versions by executing `--version` inside the guest when explicit manifest values are absent, resolves the configured worker port, and sends a one-time `/start` request containing the command, guest `/workspace` cwd, guest session directory and optional system-prompt content. The OpenSandbox image copies the repository extension and its source imports to `/opt/swarmenv/src`; the runner passes `/opt/swarmenv/src/agent/swarmenv-extension.mjs` so Pi registers the current named Service capabilities. The worker launches the configured command with pipes, normally direct Pi, exposes `/rpc`, `/events` and `/stop`, and requires the per-Execution bearer token generated by Runtime on every route except health. The adapter forwards only an explicit public allow-list (`SWARMENV_BRIDGE_URL`, `SWARMENV_*_SERVICE_URL`, `SWARMENV_SERVICE_ENDPOINTS`, routing/version fields) and an explicit secret allow-list (Bridge/service tokens and configured provider keys); it never copies the controller's arbitrary environment or provider lifecycle credentials. Secret values are sent as `secret_env` over the authenticated worker request and are not retained in provider snapshots.

`RemoteAgentChild` presents those routes as the same stdin/stdout/stderr/close shape consumed by `AgentCoreSession`. Each RPC response and event carries a worker sequence and is de-duplicated before entering the normal newline-delimited Pi parser. The event endpoint accepts a sequence cursor; a dropped stream reconnects and replays only later records. When OpenSandbox returns a retryable 5xx/`SERVICE_UNAVAILABLE` for SSE, the adapter switches to one-second authenticated `get_state` polling with the last worker sequence. The worker returns retained records strictly after that cursor; the adapter advances the cursor while deduplicating replayed records. Poll failures are logged as bounded transport observations and do not create a second Pi command. Generic transient stream errors continue with exponential reconnect backoff; non-retryable contract errors reach Runtime. The worker caches a bounded set of completed RPC IDs, so a retry after a lost response does not write a duplicate Pi command. A worker exit closes the remote RPC Session. The adapter wraps `session.stop()` to confirm deletion of the original worker sandbox even after RPC has closed; deletion failures propagate and a later stop retries the same resource. For registered Bots, Runtime aliases the Execution to the existing Bot Sandbox; deletion removes both aliases. The old unregistered path can still own a separate Execution Sandbox. A transport close alone does not free a Core. The adapter tests cover both reconnect and historical polling; a deployed run still has to prove that the pinned image and provider endpoint remain healthy.

The adapter also owns failed startup before a Session can be returned. It tracks the in-flight startup separately from `pendingStartupCleanup` (failed resources), rejects a concurrent start on the same adapter, retries failed deletion before another start, and exposes `cleanupPendingStarts({shutdown:true})` for benchmark shutdown. Shutdown joins the in-flight startup and blocks late worker publication; the runner also joins its Core startup promise before collecting Session cleanup obligations. OpenSandbox records a newly created provider ID before resolving its endpoint or health; preparation failure keeps that record if compensation fails, and `ensureExecution` rejects reuse while preparation/cleanup is pending. The provider ID is also persisted in `bots` through `onSandboxCreated` immediately after creation and before endpoint/health preparation. Live sessions and worker tokens remain in memory; process-loss reconciliation is still incomplete.

## 3. The registered Bot path

1. **Create the lane and Bridge.** The benchmark creates four Core records, each with a Runtime limited to one worker, a Bridge, Workspace access and an adapter. Service state is shared across the project; an Execution's Workspace is not a Core-private shared working directory.
2. **Start the Session while unbound.** Runtime first persists the Bot and rotates its Bridge identity/token. The child receives that Bridge URL/token and `SWARMENV_AGENT_ROLE=bound`. Runtime waits for readiness before the runner marks the Session as an `identitySession`. It supplies no `agentPrompt` to `adapter.start`.
3. **Send one discovery turn.** `IdentityTaskLoop` supplies eligible Tasks to `takeTaskWithAgent`. The runner sends the registered Bot startup message: current Mission, Bot/Core/Session identity, pinned public Workspace preview, budget deadlines, CLI service directory and an explicitly partial eligible Task page. The system text and four built-in skill bodies are fixed resources; the message records their hash and names. Every Core can enter discovery with an empty page; the Bot may prefer existing work or propose and take a distinct local Task. Every proposal remains an ordinary Mission Task, including the first. The runner neither promotes it to root nor removes it from ready-work accounting.
4. **Create the durable take.** The Bridge authenticates its own actor/Core, strips caller-provided owner and prompt claims, and invokes Task Service. A rejected take remains a failed take. The identity supervisor only accepts the actual transport receipt; it cannot turn a selected Task ID into an operator take.
5. **Bind the existing Session.** The Bridge stores returned IDs; the runner hook prepares Workspace in the existing Bot Sandbox, validates that the original Session is still live, activates Execution durably and registers the process. `sendInitialPrompt:false` avoids a second prompt inside the discovery turn. The tool result returns to that same turn with Runtime's activated Execution and prepared Workspace descriptor. Task Service's durable reservation receipt remains separate from the post-preparation response.
6. **Continue research on that lane.** After a turn settles, the runner can send another bound continuation if Execution is still `RUNNING`. Reading, checking or publishing a Material does not release the lane by itself.
7. **Release at a lifecycle boundary.** Completion, valid typed block or Runtime-requested handoff changes durable state and triggers cleanup. With the default `freshBotPerExecution:true`, cleanup stops the Session; the next Bot starts fresh. Registered Bots always close their sole Session. For unregistered callers, the explicitly configured false compatibility path can retain a reusable Session and recovery/rotation can replace a Session inside one Execution.

The runner suppresses discovery when the Core has a Task/Execution or an active turn. Before replacing a closed or failed unbound Session, it calls `stop()` even if the RPC transport is already closed; failed deletion retains the Session and prevents another startup. It records `take_deferred` for transient races rather than consuming another attempt. Selection, taking, process binding and settlement are separate steps, so failures must be attributed to the correct step. [Sources: benchmark](../../src/benchmark/putnam-runner.js), [identity loop](../../src/runtime/identity-task-loop.js), [Runtime](../../src/runtime/runtime.js).

In this manual, “candidate” refers only to a mathematical result file inside a Workspace revision. It is not a runtime entity, identifier, storage table or CLI operation; all checks use the Workspace source `(workspace_id, revision, path)` contract.

### A composed prompt is not necessarily a sent prompt

The normal take path can emit `runtime.initial_prompt_composed` while `sendInitialPrompt` is false. It therefore does **not** necessarily send the complete composer output, including full `Authorized Service Documentation`, to that Session. The extension's tool descriptions, schemas and short guidance are a different input surface. Runtime start/restart/recovery paths can send fuller composition. Some also compose a snapshot and then wrap the whole snapshot in a second Mission context. These distinctions are detailed in [08](08-prompts.md); the exported `buildInitialPromptBundle` helper is not proof of production delivery.

## 4. How a callable tool is built

### 4.1 Profile construction

`buildCapabilityProfile` prefers a Registry profile, then supported Registry profile/list interfaces, then the static catalog fallback. The fallback is filtered through `CURRENT_AGENT_OPERATIONS`. It appends supplied Runtime capabilities and normalizes ID, semantic/tool names, operation, Service identity/title/purpose, versions, manifest hash, schemas, side-effect/idempotency metadata, help, required context, path, audience and ownership.

Normalization rejects unsupported roles, excludes entries not allowed for the role, filters legacy/internal surfaces, removes writable Execution-service controls and hides internal/runtime/daemon audiences. Capabilities are deduplicated by ID and sorted. Conflicting names prefer the non-Runtime semantic provider and receive deterministic Service-qualified names; remaining tool-name collisions gain an ID-derived hash suffix. Services group those names and retain bundle documentation. The final profile is hash-bound to the normalized description, or reuses a Registry hash where no altered identity is needed. The same input produces the same profile.

The benchmark removes Runtime `task_finish`/`task_finish(outcome=blocked)` aliases and removes Sandbox tools when no Sandbox manager exists. Other callers can supply different lists. Historical catalog entries remain for bounded compatibility/observation uses, but legacy lease, wait and tree/rework surfaces are filtered out of live Agent profiles; the no-Registry fallback also uses an explicit current-operation allowlist. A historical declaration is not an advertised production tool. Registration does not replace current Task/Execution authorization. [Sources: capability-profile](../../src/agent/capability-profile.js), [runtime-capabilities](../../src/runtime/runtime-capabilities.js), [benchmark](../../src/benchmark/putnam-runner.js).

### 4.2 Pi extension registration

The asynchronous extension resolves an explicit test profile, supplied loader, authenticated Bridge `/profile`, or local fallback, in that order. After checking the role, it registers one Pi tool per capability:

| Pi field | Value supplied by SwarmEnv |
|---|---|
| Name | `swarmenv_` plus `tool_name` or normalized name |
| Label | `SwarmEnv ` plus that name |
| Description | Capability description; fallback names Service/capability |
| `promptSnippet` | Service title/ID plus description/name |
| `promptGuidelines` | `help.when`, else usage, else summary; then `Help: <help.ref>` if present |
| Parameters | Exact input schema; fallback open object |
| Output schema | Included when declared |
| Annotations | Derived read-only/destructive/idempotent flags; open-world false |
| Execution mode | `sequential` |

Exact instruction fields for built-ins and optional Mathlib are in [the generated catalog](prompts/02-task-loop-and-tools.md). Sequential execution serializes tools within a Session, not separate Cores. The extension fetches its profile once at startup. The Bridge can rebuild a profile after Registry revision/binding changes, but this does not automatically add Pi tools to an existing extension. A new Session is needed for refreshed registration unless another explicit integration supplies it. [Source: swarmenv-extension](../../src/agent/swarmenv-extension.mjs).

## 5. Bridge transport and authorization

### 5.1 HTTP contract

The Bridge defaults to `127.0.0.1` on an automatically allocated port with a random bearer token. It gives the child `SWARMENV_BRIDGE_URL` and `SWARMENV_BRIDGE_TOKEN`. Both `/profile` and `/call` require authentication. `GET /health` returns only Bridge health and does not require the token. Missing/wrong token on protected routes returns HTTP 401; unknown route returns 404. The request reader rejects bodies larger than 2 MiB and parses JSON. Call/parsing failures before the response is sent are returned as HTTP 400 with the structured error body.

The extension posts operation, Service ID, capability ID and payload to `/call`. It does not send an arbitrary endpoint or caller-selected actor/Core. The Bridge supplies current Task/Execution IDs, spec/state/fencing versions and its authenticated actor to the invocation envelope. An explicit operation ID is supported by the Bridge API; otherwise it creates a new random ID. The extension does not carry a stable operation ID across a model-issued retry, so an idempotent annotation is not exactly-once delivery. Domain operations have their own deduplication/contract checks.

The extension converts successful results to a text content block using `JSON.stringify(result)`, with the structured result also attached as `details`. Model-visible text is truncated after **64 × 1024 JavaScript string characters**, followed by `[bridge result truncated]`; tool results are not guaranteed to reach the model in full. A non-OK HTTP response or `ok:false` becomes an Error containing structured code, retryability and details. [Sources: Bridge](../../src/agent/services-bridge.js), [extension](../../src/agent/swarmenv-extension.mjs).

### 5.2 Call validation and dispatch

For every call, the Bridge obtains the current profile, resolves the capability, checks object-shaped payload and applies the bound Task's rules. Unknown/ambiguous capabilities are errors. Task inspection uses the canonical `task_view` and `task_status` operations; overlapping `task_finish(outcome=blocked)` capabilities are disambiguated by Mission presence.

| Call category | Required behavior |
|---|---|
| Catalog discovery | Only advertised public discovery operations |
| Task view/status | Explicit discovery branch and current binding defaults; unbound identity also has the prompt's candidate view |
| `task_take` | No active binding; actor, Core and stable prompt supplied by Bridge |
| Provider research call | Binding declared by capability and current envelope |
| Workspace/Sandbox call | Mission Task must use Workspace according to its contract |
| Retired operation | Legacy lease/wait/tree/rework operations are absent from the live profile; unavailable or unsupported calls are rejected rather than forwarded through a retired runner path |
| `execution_progress` | Retained internal compatibility operation; registered Bots use explicit save/publish/finish and cannot invoke it |
| Semantic `task_finish(outcome=blocked)` | Requires a genuine same-Mission non-cancelled Task prerequisite; it closes the current Bot/E and records the blocker |
| `task_finish` | Task Service commits a CLOSING finish intent; Runtime confirms process/Sandbox isolation and finalizes Task state before Bridge clears binding; cleanup failure returns the accepted receipt with `cleanup_pending: true` and retains binding |
| `judge.workspace_check` | Bridge reads the fixed public Workspace revision/path, attaches actual Git commit/tree/hash and invokes Judge; registered requests cannot substitute inline source, a private path or a Material alias. The returned CheckResult is diagnostic feedback; Task completion remains a separate explicit operation. See [04](04-services.md). |

Registered unbound discovery uses scoped `task_list`, `task_view` and `task_status`, public Workspace/Material reads and explicit granted coordination. Historical `list_tasks` and `list_executions` are rejected for registered Bots. A list page is not complete history; follow its cursor and inspect relevant Task details.

Task creation checks `required_capabilities` against exact current capability IDs, names, operations or tool names. Acceptance requirements for exact declarations/verified usage imply `mathlib_search`. Failure returns missing/available capabilities and an action/hint before a eligible Task is created. This checks availability, not scientific value. [Source: Bridge](../../src/agent/services-bridge.js).

### 5.3 Take failure and register-and-take

The take binding records the durable take locally, invalidates its profile cache and invokes activation hooks. On failure it attempts Runtime `stopExecution(..., FAILED, task_take_bind_failed)`, a Task Service stop fallback, or a fencing fallback. It clears the local binding, calls the release hook with original IDs and rethrows the original error. Cleanup exceptions are suppressed; rollback is attempted, not guaranteed to succeed in every external component.

A registered UNBOUND Bot can propose a missing responsibility and take it in the same Bot. An ACTIVE Bot may propose a distinct follow-up Task while retaining its current E, but cannot take a second Task or switch responsibility. It explicitly saves/publishes and finishes; only after cleanup can the Core create a fresh Bot. The retired checkpoint/register-and-retake compound flow is not part of this registered path.

### 5.4 Bridge callbacks actually installed by the benchmark

The Bridge is reusable infrastructure: defining an optional callback does not mean the benchmark supplies it. The installed callbacks are part of the actual control flow and explain which tool calls also change Runtime or report state.

| Callback | Benchmark behavior |
|---|---|
| `onTakeAccepted` | Supplied as an empty async callback; no additional admission rule or model message |
| `onTake` | Stores the take, assigns the Core, binds the existing Session with no initial prompt, starts same-Session continuation after settlement and records Workspace/take latency evidence |
| `onSchedulerStatus` | Returns current Core/WAITING counts, available project Task summaries and current binding; it does not select or take work |
| `onRelease` | Records release latency/state, clears the matching Core binding after Runtime cleanup, projects the released Core as IDLE and wakes identity loops. Missing lineage is only a capacity-release observation. |
| `onWorkspaceWrite` | Records revision/file/hash metadata and a Workspace work unit |
| `onWorkUnit` | Records read/consumption, creation, publication/link, lifecycle and direct Judge submission evidence; selected operations wake identity loops. A residual `wait_for` accounting branch is not an exposed benchmark wait path. These observations do not establish scientific usefulness. |
| `onError` | Records bounded tool-error classification. Contract errors are marked recoverable; the special `CONFLICT` accounting branch checks the legacy operation name `take`, not `task_take`. |
| `onTaskCreate` | Not supplied; Bridge still performs its own capability admission and Task Service still applies the Task contract |
| Judge submission | No runner relay callback is installed. The Bridge performs source resolution/attestation and Judge owns checking/persistence; `onWorkUnit` records the returned check, source path and verdict. Task completion remains an explicit separate operation. |

The generic Bridge calls `onWorkUnit` for `task_create` and `task_take`, but the runner callback has no specific accounting branch for either operation. Its `task_created`/dynamic-Task event branch checks only `task_create`. Durable Task state and Task-event wakeups therefore matter when reconstructing newly created work; the callback counters alone are not a complete event history. [Sources: callback installation](../../src/benchmark/putnam-runner.js), [Bridge invocation](../../src/agent/services-bridge.js); see [06](06-observability-experiments.md) for evidence and counting limits.

## 6. What is observable

The adapter records launch arguments/version manifest as operator events. Raw stdout/stderr, outgoing RPC requests and incoming RPC records are private observations. Derived tool-start/tool-finish events are private too. `session_started`, `session_closed` and `agent_settled` are lifecycle evidence. Observation failures are caught and do not terminate the research process.

| Record | Establishes | Does not establish |
|---|---|---|
| System-prompt file and launch flag | Exact SwarmEnv addendum supplied to Pi | Pi/provider's complete upstream system message |
| `runtime.initial_prompt_composed` | Composer result/profile constructed | Result sent, processed, or unchanged by another wrapper |
| Raw `rpc_request` with `type:prompt` | Exact user message written to Pi stdin, ID and order | Successful processing or useful action |
| Successful matching RPC response | Command acknowledged | Task/Mission completion |
| `agent_settled` | Model turn settled | Execution released or candidate passed Judge |
| Tool result/domain event | Validated operation's result | Scientific usefulness beyond that result |

The benchmark's `core.prompt` hash is a hash of a base SOP field, not the evolving transcript. Replay also depends on tool results, candidate/Material content, notifications, profile/configuration and Pi-owned state. [08](08-prompts.md) explains the current records without claiming they capture the full upstream model request.

## 7. Validation and known limits

Existing checks include [prompt tests](../../test/agent-prompt.test.js), [Pi adapter](../../test/pi-adapter.test.js), [capability profile](../../test/capability-profile.test.js), [profile/Bridge](../../test/capability-profile-bridge.test.js), [flat Task behavior](../../test/task-oriented-flat.test.js), [Judge boundary](../../test/judge-direct-submit.test.js) and [flat benchmark CLI](../../test/flat-only-cli.test.js). These identify tested seams; execution results belong in the linked GitHub Issue/PR and experiment reports.

Known baseline inconsistencies remain visible: benchmark Task instructions prohibit `shell` while a Sandbox-enabled deployment advertises bounded `sandbox_exec`; normal discovery does not automatically send the full Service-document block; Runtime can repeat composed context; and frozen Pi registrations can lag a later Bridge Registry revision. Resolve these through approved Issues. This documentation preserves the actual texts rather than silently improving their wording.

Accepted finish handling captures IDs from the durable receipt before observer callbacks. Observer or release-callback failure is logged without converting the accepted finish into a rejected tool call. The registered and fallback paths use the same handler; an asynchronous callback cannot make it release a different current binding.

## Registered Bot identity and Bridge credentials

`startAgentSession` enters `Runtime.startBot` with the Mission and Core, a five-minute default selection budget, and the configured turn timeout for readiness (30 seconds by default). Runtime persists STARTING before calling the adapter. The factory sets the Core actor to the new Bot ID, calls `Bridge.startBotIdentity`, and copies its newly generated bearer token into the live child environment before launching Pi. Rotation rejects a still-occupied previous Bot or a retained Execution binding. Old bearer tokens no longer authenticate to that Bridge.

After provider identity is recorded and Pi readiness/retry/compaction setup succeeds, Runtime marks the Bot UNBOUND. It can inspect shared work and create/take a Task. During STARTING, PREPARING, CLOSING or CLOSED, the Bridge refuses ordinary contributions; finish/exit requests still reach their durable replay validation. This Bridge check is not a complete authentication migration: standalone Service tokens and unregistered caller compatibility still exist and must be reconciled before phase acceptance.

`bot_exit` requires an unbound Bot without a pending take. The Task Service rejects early exit while the Mission is open and both selection and hard time remain. For an eligible budget exit, the service stores CLOSING before Runtime stops the Session/Sandbox. The historical `no-work` reason is subject to the same eligibility check as `selection-budget`. The discovery supervisor reads this durable result even when process shutdown interrupts the RPC response. Empty prose or a settled turn without a take/exit remains `DISCOVERY_INCOMPLETE`. A newly registered Bot starts with empty private state; the adapter does not copy the previous Core directory into its Sandbox.

Requests authenticated before a Bridge rotation revalidate the captured token after body parsing. Queued proposals revalidate before running their callback and after an asynchronous admission guard, so an old request cannot execute with the successor's identity. With `SWARMENV_BRIDGE_URL` configured, the `swarm` CLI sends commands to that authenticated Bridge; it does not construct a replacement Bot actor. This covers `swarm bot exit --reason selection-budget`. Without Bridge configuration, standalone Service manifest/endpoint mode remains available to existing callers.

Worker RPC addressing retains the stable Bot resource key after take. Observation metadata changes separately: before take it has Bot ID with null Execution; registration assigns the actual Task/Execution/Core IDs to the Session. Late transport diagnostics retain that last Execution attribution rather than treating the resource key as a synthetic Execution.


### Fixed project and worker privilege boundary

The image now copies `scripts/sandbox-project.mjs` next to the worker and includes `setpriv` from util-linux. Before listening, the root worker reserves an empty `/workspace/project` owned by root with mode 0555 beneath a root-owned 0755 `/workspace`. A nonempty or symlink project root prevents readiness. `/workspace/runtime` belongs to UID/GID 10001 and contains the Bot's home, temporary data, Pi catalog and Session directory. Pi always starts with cwd `/workspace/project`; the supplied cwd cannot choose another path. System-prompt files must be within runtime scratch.

`/start` is single-use for the worker lifetime, even if Pi exits. The worker builds a fresh child environment from PATH/locale and explicitly supplied application/model values, places HOME/TMPDIR/PI_CODING_AGENT_DIR in scratch, copies and expands the non-secret image catalog there, and starts the child through `setpriv` with UID/GID 10001, cleared groups, no-new-privileges and empty capability sets. It does not inherit daemon/provider environment. Registered Bot adapters additionally omit global service bearer tokens, individual Service URLs and the service-endpoint bundle; the scoped Bridge credential remains available. Registered Pi startup enables exactly the native `read`, `write`, `edit`, and `bash` tools and the four fixed Bot Skills. Bridge/CLI provide Service access; hidden default skills, extensions, context files and caller-selected extra resources are rejected. [Prompts](08-prompts.md) records the exact composition and send conditions.

The authenticated root worker exposes `/project/prepare` and `/project/grant` alongside its existing RPC routes. Their input is a reserved Execution/fence and, for prepare, the trusted complete manifest. They are controller operations, not Bot capabilities. The [Workspace chapter](05-workspace-continuity.md) explains validation and active-before-grant order. Bridge holds its provisional contribution binding closed throughout the asynchronous take callback and rejects another request until prepare/activate/grant succeeds. A pending binding also prevents identity rotation. Registered Bot calls to the legacy root `sandboxExec` capability are rejected; their actual shell path is non-root Pi Bash.

`/stop` marks project closing synchronously, kills the child process group and repeatedly enumerates `/proc` to kill every non-zombie process with the dedicated Bot UID, including detached descendants after Pi exits. It waits up to five seconds for absence, then revokes project directory ownership and permission. Failure is reported rather than counted as stopped. Late grant and second start are rejected. Provider deletion remains the final isolation/cleanup boundary; worker stop failure is retriable and the manager retains the endpoint until a successful stop or sandbox deletion. Local network-disabled Docker probes verify UID/permissions/environment and descendant stop; OpenSandbox management-plane/network isolation and external cost bounds still require separate acceptance evidence.

OpenSandbox Agent startup now requires a registered Bot resource identity and rejects the retired unregistered Execution entry before provider creation. The manager also rejects starting its Agent worker on a non-Bot sandbox. Trusted version/command diagnostics may still use an unregistered sandbox, but that is not a compatibility research-Agent launch path. Local compatibility adapters and their older host Workspace methods remain separately documented.


### Registered Bot CLI discovery and request replay

The installed `swarm` executable enters `runSwarmCli`. When `SWARMENV_BRIDGE_URL` is present, both commands and `service list/view` use the authenticated Bridge; they do not fall back to direct Service URLs. Service discovery invokes the catalog's `list_services`/`get_service_metadata`. A configured domain command is checked against that Service's advertised operations and sent with its Service identity. With no Bridge configured, the operator transport still resolves HTTP Service manifests and sends an explicit envelope. Help remains offline in both modes.

The Material CLI uses `swarm material` and routes to Context Service. The retired `swarm context` command group returns a migration error before accessing any service or command help.

`task propose` maps to `task_create`; `task view/take <id>`, `material view <id>`, Material/Workspace search queries, Workspace files/read paths and Judge result IDs have positional mappings. `workspace ... --at R` becomes `revision: R`; `workspace diff --from R1 --to R2` routes to the public Mission read, while no revision arguments select current-E diff; `mission submission view <id>` queries the existing submission interface. File/stdin inputs must be JSON objects. Boolean flags do not consume subsequent arguments, and inline values preserve embedded equals signs. `--request-id` and the compatibility `--operation-id` share the request envelope; specifying different values rejects locally. A retry uses the same ID and payload. The CLI rejects Bot identity overrides, while `task_id` remains a target selector, not proof of ownership. Results go to stdout as JSON; diagnostics go to stderr. Request timeout is 30 seconds by default, configurable up to ten minutes. Exit codes remain success 0, transport failure 1, contract failure 2 and checker FAIL 3. Timeout is an unknown response, not a confirmed rollback.

For registered Bots, the Bridge supplies the durable Mission to Mission view, Task proposal/list/status and Material search/list. Explicit foreign Mission IDs reject. Task view/take and exact Material reads check their target's Mission. Public Workspace reads use Runtime's configured Mission Workspace, verify its stored Mission and reject another Workspace ID. The identity/deadline is rechecked after the asynchronous Workspace lookup. These checks cover these Bot entry paths; they do not establish authorization of standalone Service HTTP deployments or complete the pending write/apply interfaces.

A successful `task_take` receipt is retained by the live Bridge only after the Runtime callback completes prepare/activate/grant. Repeating its request ID and identical payload returns the same receipt without rebinding or allocating another E; changed payload conflicts, and another request ID cannot take a second Task. During preparation, the same explicit request ID and payload join the original promise; changed payload conflicts and other contribution calls remain rejected. No second activation occurs. Receipt replay still checks Bot state/deadline first and emits a replayed `bridge.complete` event. Identity rotation clears the receipt. This is live-Bot response recovery: restoring a Bridge/Pi after a controller restart is not implemented by this cache. The durable Task take/Execution records remain the external source after Bot termination. Mission-scoped Task status also filters active Core lanes in SQL; foreign Mission lanes never appear in this projection.

`test/bot-bridge.test.js` exercises the real CLI subprocess against a real Bridge/Task Service and Git Workspace: catalog discovery, Mission read, pinned public input, proposal replay, take/activation/replay, identity rejection and cancellation with a persisted replacement Task. The Runtime activation is controlled in this test, so it does not validate Pi/provider behavior or Workspace save/apply. Mission view currently exposes the stored goal, acceptance conditions and creation metadata; complete scope/budget/main/stop/acceptance snapshots remain pending. Registered Bot `mission submit` returns `SERVICE_NOT_READY` until the trusted final-submission integration is implemented. Current-E status/diff/save now use the authenticated guest snapshot coordinator described in [Workspace](05-workspace-continuity.md#01-current-bot-project-snapshot-and-public-save). Public view/history expose saved revisions. Registered Bot apply now uses held worker installation and durable E acknowledgement; merge remains explicitly unavailable pending its Runtime integration; legacy private Workspace operations reject for registered Bots.


### Four-tool registered Bot input path

Registered OpenSandbox Bots now use the versioned `bot-contract` resources. Worker startup verifies their hashes and root ownership before native Pi starts with read/write/edit/bash; no per-Service extension tools are registered. Pi receives the system addendum from an immutable image file and exactly four explicit skills. Ambient context, extension, skill and prompt-template discovery stay disabled. Services are reached through Bash and `swarm`; the Bridge owns identity and lifecycle guards. [Prompts](08-prompts.md) explains exact first-turn fields, their sources, actual send paths, continuation/notification/compaction behavior and remaining compatibility paths.

The runner records only these four tool names as valid. It no longer sends the old per-Service guide, repeats the old SOP in bound turns, or constructs the unused whole-proof Task template. A registered Bot compaction records private context progress but does not automatically snapshot the controller's private Workspace; public file persistence requires the explicit Runtime save flow. The local network-disabled Pi probe and the four-Core actual send-path test establish this wiring; the configured remote provider remains to be verified before formal execution.

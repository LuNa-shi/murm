# 01. Agent Core: process, tools, binding and turns

This chapter describes the implementation at the source baseline named in [INDEX](INDEX.md). A Core is a reusable concurrency lane. It runs a Pi conversation, lets that identity choose a Task, and binds the same conversation to the resulting Execution. The model chooses research actions; the Bridge, Task Service and Runtime validate and apply those actions. The model cannot create a valid Execution merely by saying that it has taken work.

The complete prompt bodies, composition branches and delivery evidence are in [08 Prompts](08-prompts.md). State transitions are in [02 Execution](02-execution.md); exact tool schemas and deployment-dependent exposure are in [10 API reference](10-service-api-reference.md).

## 1. Objects that must be kept separate

| Object | Concrete implementation and lifetime | What changes it |
|---|---|---|
| Core | Benchmark `core-N` record and its Runtime/identity-loop slot | It persists across ordinary Task claims and releases within the run |
| Agent identity | Reasoning continuity attached to the reusable Session; Runtime tracks an identity ID and compaction count | Explicit identity rotation or recovery replaces the Session |
| Session | `AgentCoreSession`, wrapping one Pi process, JSON-line RPC stream, Session ID and conversation storage | Process start/restart; it can outlive an individual Execution |
| Task | Durable responsibility owned by Task Service | Take, semantic completion, block or close |
| Execution | Durable authority for an attempt: Task ID, owner, Core, lease, fencing version and Workspace | Ends at a lifecycle boundary; a Session restart can keep this ID |
| Capability profile | Normalized Registry/Runtime description for `bound` or `recovery` | Built from Registry revision and the deployment capability list; it is not a Task take |

An unbound reusable identity still uses role `bound`. There is no separate `idle` role in `AGENT_ROLES`; the exported idle/generic/recovery prompt aliases contain the same stable instructions. Role `bound` therefore does not prove that an Execution exists. The Bridge checks the binding separately. [Sources: capability-profile](../../src/agent/capability-profile.js), [Bridge](../../src/agent/services-bridge.js), [benchmark](../../src/benchmark/putnam-runner.js).

## 2. How the model process starts

### 2.1 Adapter configuration and routing

`AgentCoreAdapter` accepts command, provider, model, account/group routing, Session directory, extension path, working directory, environment, version overrides and a system-prompt string or file. `executionId`, `sessionId`, provider, model and Session directory must be nonempty strings when launch arguments are built. A reusable benchmark Session initially receives a synthetic worker process ID; its observation context has null Task/Execution IDs until binding.

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

The external provider path uses `OpenSandboxAgentAdapter` and the image-resident `scripts/opensandbox-agent-worker.mjs`. Runtime creates the provider sandbox, resolves Pi/Node versions by executing `--version` inside the guest when explicit manifest values are absent, starts the worker as a bounded background Execd command, resolves the configured worker port, and sends a one-time `/start` request containing the command, guest `/workspace` cwd, guest session directory and optional system-prompt content. The OpenSandbox image copies the repository extension and its source imports to `/opt/swarmenv/src`; the runner passes `/opt/swarmenv/src/agent/swarmenv-extension.mjs` so Pi registers the current named Service capabilities. The worker launches the configured command with pipes, normally direct Pi, exposes `/rpc`, `/events` and `/stop`, and requires the per-Execution bearer token generated by Runtime on every route except health. The adapter forwards only an explicit public allow-list (`SWARMENV_BRIDGE_URL`, `SWARMENV_*_SERVICE_URL`, `SWARMENV_SERVICE_ENDPOINTS`, routing/version fields) and an explicit secret allow-list (Bridge/service tokens and configured provider keys); it never copies the controller's arbitrary environment or provider lifecycle credentials. Secret values are sent as `secret_env` over the authenticated worker request and are not retained in provider snapshots.

`RemoteAgentChild` presents those routes as the same stdin/stdout/stderr/close shape consumed by `AgentCoreSession`. Each RPC response and event carries a worker sequence and is de-duplicated before entering the normal newline-delimited Pi parser. The event endpoint accepts a sequence cursor; a dropped stream reconnects and replays only later records. When OpenSandbox returns a retryable 5xx/`SERVICE_UNAVAILABLE` for SSE, the adapter switches to one-second authenticated `get_state` polling with the last worker sequence. The worker returns retained records strictly after that cursor; the adapter advances the cursor while deduplicating replayed records. Poll failures are logged as bounded transport observations and do not create a second Pi command. Generic transient stream errors continue with exponential reconnect backoff; non-retryable contract errors reach Runtime. The worker caches a bounded set of completed RPC IDs, so a retry after a lost response does not write a duplicate Pi command. A worker exit closes the remote Session; `AgentCoreSession.stop()` calls `/stop`, and Runtime cleanup also stops the worker before deleting the sandbox. The adapter tests cover both reconnect and historical polling; a deployed run still has to prove that the pinned image and provider endpoint remain healthy.

## 3. The normal reusable-identity path

1. **Create the lane and Bridge.** The benchmark creates four Core records, each with a Runtime limited to one worker, a Bridge, Workspace access and an adapter. Service state is shared across the project; an Execution's Workspace is not a Core-private shared working directory.
2. **Start the Session while unbound.** The child receives the Bridge URL/token and `SWARMENV_AGENT_ROLE=bound`. `startAgentSession` waits for readiness and marks the Session as an `identitySession`. It supplies no `agentPrompt` to `adapter.start`.
3. **Send one discovery turn.** `IdentityTaskLoop` supplies eligible Tasks to `takeTaskWithAgent`. The runner sends the SOP, the profile-derived Task-loop guide, same-Session instructions and the complete bounded Task list. The model chooses a listed Task and calls `task_take`.
4. **Create the durable take.** The Bridge authenticates its own actor/Core, strips caller-provided owner and prompt claims, and invokes Task Service. A rejected take remains a failed take.
5. **Bind the existing Session.** The Bridge stores returned IDs; the runner hook prepares Workspace, starts Execution durably, registers the process and starts Sandbox when configured. `sendInitialPrompt:false` avoids a second prompt inside the discovery turn. The tool result returns to that same turn, but it is the original Task Service take snapshot. The hook does not replace `take.execution` with Runtime's activated Execution or add the prepared Workspace descriptor. For a newly created take, the returned Execution still says `CREATED` and has null Workspace/start/deadline fields even though durable activation has succeeded. The Agent must use current Execution/Workspace tools for those values. A register-and-take switch has the same return-object boundary.
6. **Continue research on that lane.** After a turn settles, the runner can send another bound continuation if Execution is still `RUNNING`. Reading, checking or publishing a Material does not release the lane by itself.
7. **Release at a lifecycle boundary.** Completion, valid typed block or Runtime-requested handoff changes durable state and triggers cleanup. The Session normally remains available for another Task. Recovery/rotation replaces it; registration alone does not.

The runner suppresses discovery when the Core has a Task/Execution or an active turn. It records `take_deferred` for transient races rather than consuming another attempt. Selection, taking, process binding and settlement are separate steps, so failures must be attributed to the correct step. [Sources: benchmark](../../src/benchmark/putnam-runner.js), [identity loop](../../src/runtime/identity-task-loop.js), [Runtime](../../src/runtime/runtime.js).

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

For every call, the Bridge obtains the current profile, resolves the capability, checks object-shaped payload and applies the bound Task's rules. Unknown/ambiguous capabilities are errors. The compatibility `get_task` alias resolves to current Task view where appropriate; overlapping `task_finish(outcome=blocked)` capabilities are disambiguated by Mission presence.

| Call category | Required behavior |
|---|---|
| Catalog discovery | Only advertised public discovery operations |
| Task view/status | Explicit discovery branch and current binding defaults; unbound identity also has the prompt's candidate view |
| `task_take` | No active binding; actor, Core and stable prompt supplied by Bridge |
| Provider research call | Binding declared by capability and current envelope |
| Workspace/Sandbox call | Mission Task must use Workspace according to its contract |
| Retired operation | Legacy lease/wait/tree/rework operations are absent from the live profile; unavailable or unsupported calls are rejected rather than forwarded through a retired runner path |
| `execution_progress` | Runtime coordinates files, Progress and handoff |
| Semantic `task_finish(outcome=blocked)` | Runtime boundary; currently callable capability rejected as an alleged external blocker |
| `task_finish` | Task Service commits completion, then Runtime releases Execution and Bridge clears binding |
| `judge.workspace_check` | Bridge reads the relative Workspace path (or resolves a referenced Material), attaches the current revision/hash attestation and invokes Judge directly. The returned CheckResult is diagnostic feedback; Task completion remains a separate explicit operation. See [04](04-services.md). |

Do not generalize unbound discovery to every similarly named API: the explicit discovery list includes `list_tasks`, `get_task`, `list_executions`, `task_view` and `task_status`; registered `task_list` is not in that branch and normally requires provider binding. The supplied candidate view is therefore important when unbound.

Task creation checks `required_capabilities` against exact current capability IDs, names, operations or tool names. Acceptance requirements for exact declarations/verified usage imply `mathlib_search`. Failure returns missing/available capabilities and an action/hint before a eligible Task is created. This checks availability, not scientific value. [Source: Bridge](../../src/agent/services-bridge.js).

### 5.3 Take failure and register-and-take

The take binding records the durable take locally, invalidates its profile cache and invokes activation hooks. On failure it attempts Runtime `stopExecution(..., FAILED, task_take_bind_failed)`, a Task Service stop fallback, or a fencing fallback. It clears the local binding, calls the release hook with original IDs and rethrows the original error. Cleanup exceptions are suppressed; rollback is attempted, not guaranteed to succeed in every external component.

For `task_create followed by task_take`, Bridge first saves `execution_progress(kind=checkpoint)`, using supplied Progress or defaults that record registration as the next step. Task Service then registers the new Task, ends the old Execution and takes the new one transactionally. Afterwards Bridge asks Runtime to detach the old Execution, records work evidence, releases its old local take and binds the new take. The database transition and physical actions are separate failure boundaries; a later bind failure does not undo the earlier checkpoint/transaction. [Sources: Bridge](../../src/agent/services-bridge.js), [Task Service](../../src/task/task-service.js).

### 5.4 Bridge callbacks actually installed by the benchmark

The Bridge is reusable infrastructure: defining an optional callback does not mean the benchmark supplies it. The installed callbacks are part of the actual control flow and explain which tool calls also change Runtime or report state.

| Callback | Benchmark behavior |
|---|---|
| `onTakeAccepted` | Supplied as an empty async callback; no additional admission rule or model message |
| `onTake` | Stores the take, assigns the Core, binds the existing Session with no initial prompt, starts same-Session continuation after settlement and records Workspace/take latency evidence |
| `onSchedulerStatus` | Returns current Core/WAITING counts, available project Task summaries and current binding; it does not select or take work |
| `onRelease` | Records release latency/state, clears the matching Core binding while retaining the identity Session, projects the released Core as IDLE and wakes identity loops. Missing lineage is only a capacity-release observation. |
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

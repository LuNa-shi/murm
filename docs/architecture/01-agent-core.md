# 01. Agent Core: process, tools, binding and turns

This chapter describes the implementation at the source baseline named in [INDEX](INDEX.md). A Core is a reusable concurrency lane. It runs a Pi conversation, lets that identity choose a Task, and binds the same conversation to the resulting Execution. The model chooses research actions; the Bridge, Task Service and Runtime validate and apply those actions. The model cannot create a valid Execution merely by saying that it has taken work.

The complete prompt bodies, composition branches and delivery evidence are in [08 Prompts](08-prompts.md). State transitions are in [02 Execution](02-execution.md); exact tool schemas and deployment-dependent exposure are in [10 API reference](10-service-api-reference.md).

## 1. Objects that must be kept separate

| Object | Concrete implementation and lifetime | What changes it |
|---|---|---|
| Core | Benchmark `core-N` record and its Runtime/identity-loop slot | It persists across ordinary Task claims and releases within the run |
| Agent identity | Reasoning continuity attached to the reusable Session; Runtime tracks an identity ID and compaction count | Explicit identity rotation or recovery replaces the Session |
| Session | `AgentCoreSession`, wrapping one Pi process, JSON-line RPC stream, Session ID and conversation storage | Process start/restart; it can outlive an individual Execution |
| Task | Durable responsibility owned by Task Service | Claim, semantic completion, block or close |
| Execution | Durable authority for an attempt: Task ID, owner, Core, lease, fencing version and Workspace | Ends at a lifecycle boundary; a Session restart can keep this ID |
| Capability profile | Normalized Registry/Runtime description for `bound` or `recovery` | Built from Registry revision and the deployment capability list; it is not a Task claim |

An unbound reusable identity still uses role `bound`. There is no separate `idle` role in `AGENT_ROLES`; the exported idle/generic/recovery prompt aliases contain the same stable instructions. Role `bound` therefore does not prove that an Execution exists. The Bridge checks the binding separately. [Sources: capability-profile](../../src/agent/capability-profile.js), [Bridge](../../src/agent/services-bridge.js), [benchmark](../../src/benchmark/putnam-runner.js).

## 2. How the model process starts

### 2.1 Adapter configuration and routing

`AgentCoreAdapter` accepts command, provider, model, account/group routing, Session directory, extension path, working directory, environment, version overrides and a system-prompt string or file. `executionId`, `sessionId`, provider, model and Session directory must be nonempty strings when launch arguments are built. A reusable benchmark Session initially receives a synthetic worker process ID; its observation context has null Task/Execution IDs until binding.

The generic adapter defaults to command `nurouter`. The benchmark defaults to `pi` for `openai-codex` and `nurouter` otherwise, unless explicitly configured. A command equal to `pi`, or ending in `/pi`, is treated as direct Pi.

| Provider | Provider/model flags are placed on | Additional constraint |
|---|---|---|
| `openai` | Pi arguments after the NuRouter separator, or direct Pi | Account and group cannot both be set |
| `openai-codex` | Pi arguments after the separator, or direct Pi | Account and group cannot both be set |
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

The benchmark subclass adds a stricter tool boundary: `BenchmarkAgentCoreAdapter` replaces `--no-builtin-tools` with `--no-tools`, adds `--thinking high`, supplies `--tools <comma-separated exact SwarmEnv tool names>`, and adds `--exclude-tools parallel`. Its normal allowlist is the union of names from the deployment's bound/recovery profiles. Thus the generic adapter argument list above is not the complete benchmark command; Pi's coordinator `parallel` tool is explicitly denied in the benchmark as well. [Source: benchmark adapter](../../src/benchmark/putnam-runner.js).

### 2.2 System instructions and version records

For a nonempty system-prompt string, the adapter writes `identity-system-prompt.md` in the Session directory with creation mode `0600` and passes its path through `--append-system-prompt`. An explicit `systemPromptPath` takes precedence for the path. This is a Pi system-role addendum, not an ordinary user RPC. Its [complete body](prompts/01-system-identity.md) is versioned separately from dynamic composition.

Before spawning, `createVersionManifest` records exact installed Pi, NuRouter and Node versions and launch arguments. Explicit constructor values win; environment overrides `SWARMENV_PI_VERSION`/`SWARMENV_NUROUTER_VERSION` are next; otherwise the executable's `--version` is queried. Both Pi and NuRouter version fields are required by this helper, including on the direct-Pi path. It rejects non-exact semantic versions. Normal startup does not query npm; the exported latest-version lookup is a separate utility. `package.json` pins Pi package `1.3.0`, while the recorded executable version is the evidence for an actual run. [Source: version-manifest](../../src/agent/version-manifest.js).

### 2.3 RPC protocol and process lifetime

Each command is a JSON object followed by a newline on stdin. `sendCommand` creates an RPC ID, stores a pending promise and starts its timer before writing. Default command/prompt acknowledgement timeout is 30 seconds. A matching response with `success:false` rejects with `RPC_ERROR`; an acknowledgement timeout removes the pending command. A successful acknowledgement is not semantic Task completion.

Stdout is accumulated and split on newlines. Non-JSON lines are ignored by the parser but remain in raw stdout. Parsed records enter `rpcRecords`, resolve matching RPCs and emit the `rpc` event. Stderr is accumulated separately. `waitForReady` accepts a `ready` record when present; Pi 1.3.0 normally has no standalone ready record, so the adapter sends `get_state` and uses its response as readiness. The response also supplies the model context-window value.

`waitForSettled` waits for `agent_settled`, optionally after a record sequence. Its adapter default timeout is 120 seconds; benchmark callers can choose a longer bound. This is a turn boundary, distinct from Execution release. `set_auto_compaction`, `set_auto_retry`, `get_session_stats` and `prompt` are separate commands. Runtime-managed initial turns enable compaction and retry before sending; reusable benchmark startup has its own sequence in [08](08-prompts.md).

Closing the process rejects pending RPCs. `wait()` reports unexpected nonzero exit or signal as `PROCESS_EXITED`. `stop()` marks exit expected, sends `SIGTERM`, waits five seconds by default, then sends `SIGKILL` and waits at most a further second. Runtime decides whether an exit needs recovery. [Source: pi-adapter](../../src/agent/pi-adapter.js).

## 3. The normal reusable-identity path

1. **Create the lane and Bridge.** The benchmark creates four Core records, each with a Runtime limited to one worker, a Bridge, Workspace access and an adapter. Service state is shared across the project; an Execution's Workspace is not a Core-private shared working directory.
2. **Start the Session while unbound.** The child receives the Bridge URL/token and `SWARMENV_AGENT_ROLE=bound`. `startAgentSession` waits for readiness and marks the Session as an `identitySession`. It supplies no `agentPrompt` to `adapter.start`.
3. **Send one discovery turn.** `IdentityTaskLoop` supplies claimable candidates to `takeTaskWithAgent`. The runner sends the SOP, the profile-derived Task-loop guide, same-Session instructions and complete bounded candidate JSON. The model chooses a listed Task and calls `task_take`.
4. **Create the durable claim.** The Bridge authenticates its own actor/Core, strips caller-provided owner and prompt claims, and invokes Task Service. A rejected claim remains a failed take.
5. **Bind the existing Session.** The Bridge stores returned IDs; the runner hook prepares Workspace, starts Execution durably, registers the process and starts Sandbox when configured. `sendInitialPrompt:false` avoids a second prompt inside the discovery turn. The tool result returns to that same turn, but it is the original Task Service claim snapshot. The hook does not replace `claim.execution` with Runtime's activated Execution or add the prepared Workspace descriptor. For a newly created claim, the returned Execution still says `CREATED` and has null Workspace/start/deadline fields even though durable activation has succeeded. The Agent must use current Execution/Workspace tools for those values. A register-and-take switch has the same return-object boundary.
6. **Continue research on that lane.** After a turn settles, the runner can send another bound continuation if Execution is still `RUNNING`. Reading, checking or publishing a Material does not release the lane by itself.
7. **Release at a lifecycle boundary.** Completion, valid typed block or Runtime-requested handoff changes durable state and triggers cleanup. The Session normally remains available for another Task. Recovery/rotation replaces it; registration alone does not.

The runner suppresses discovery when the Core has a Task/Execution or an active turn. It records `take_deferred` for transient races rather than consuming another attempt. Selection, claiming, process binding and settlement are separate steps, so failures must be attributed to the correct step. [Sources: benchmark](../../src/benchmark/putnam-runner.js), [identity loop](../../src/runtime/identity-task-loop.js), [Runtime](../../src/runtime/runtime.js).

### A composed prompt is not necessarily a sent prompt

The normal take path can emit `runtime.initial_prompt_composed` while `sendInitialPrompt` is false. It therefore does **not** necessarily send the complete composer output, including full `Authorized Service Documentation`, to that Session. The extension's tool descriptions, schemas and short guidance are a different input surface. Runtime start/restart/recovery paths can send fuller composition. Some also compose a snapshot and then wrap the whole snapshot in a second Mission context. These distinctions are detailed in [08](08-prompts.md); the exported `buildInitialPromptBundle` helper is not proof of production delivery.

## 4. How a callable tool is built

### 4.1 Profile construction

`buildCapabilityProfile` prefers a Registry profile, then supported Registry profile/list interfaces, then the static catalog fallback. The fallback is filtered through `CURRENT_AGENT_OPERATIONS`. It appends supplied Runtime capabilities and normalizes ID, semantic/tool names, operation, Service identity/title/purpose, versions, manifest hash, schemas, side-effect/idempotency metadata, help, required context, path, audience and ownership.

Normalization rejects unsupported roles, excludes entries not allowed for the role, filters legacy/internal surfaces, removes writable Execution-service controls and hides internal/runtime/daemon audiences. Capabilities are deduplicated by ID and sorted. Conflicting names prefer the non-Runtime semantic provider and receive deterministic Service-qualified names; remaining tool-name collisions gain an ID-derived hash suffix. Services group those names and retain bundle documentation. The final profile is hash-bound to the normalized description, or reuses a Registry hash where no altered identity is needed. The same input produces the same profile.

The flat benchmark removes Runtime `task_complete`/`task_block` aliases and removes Sandbox tools when no Sandbox manager exists. Other callers can supply different lists. Some legacy declarations remain: a structural capability can be advertised but rejected by the Mission Bridge gate. Registration does not replace current Task/Execution authorization. [Sources: capability-profile](../../src/agent/capability-profile.js), [runtime-capabilities](../../src/runtime/runtime-capabilities.js), [benchmark](../../src/benchmark/putnam-runner.js).

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

For every call, the Bridge obtains the current profile, resolves the capability, checks object-shaped payload and applies the bound Task's rules. Unknown/ambiguous capabilities are errors. The compatibility `get_task` alias resolves to current Task view where appropriate; overlapping `task_block` capabilities are disambiguated by Mission presence.

| Call category | Required behavior |
|---|---|
| Catalog discovery | Only advertised public discovery operations |
| Task view/status | Explicit discovery branch and current binding defaults; unbound identity also has the prompt's candidate view |
| `task_take` | No active binding; actor, Core and stable prompt supplied by Bridge |
| Provider research call | Binding declared by capability and current envelope |
| Workspace/Sandbox call | Mission Task must use Workspace according to its contract |
| Modern retired operation | Mission Bridge rejects legacy lease/wait/tree/rework operations even if a declaration remains |
| `execution_progress` | Runtime coordinates files, Progress and handoff |
| Semantic `task_block` | Runtime boundary; currently callable capability rejected as an alleged external blocker |
| `task_complete` | Task Service commits completion, then Runtime releases Execution and Bridge clears binding |
| `judge.submit_candidate` | Optional `onBeforeSubmitCandidate` hook, registered route and optional `onSubmitCandidate` callback. The benchmark supplies only the latter; its candidate resolution/checking runs after Task Service records the submission. See [04](04-services.md). |

Do not generalize unbound discovery to every similarly named API: the explicit discovery list includes `list_tasks`, `get_task`, `list_executions`, `task_view` and `task_status`; registered `task_list` is not in that branch and normally requires provider binding. The supplied candidate view is therefore important when unbound.

Task creation checks `required_capabilities` against exact current capability IDs, names, operations or tool names. Acceptance requirements for exact declarations/verified usage imply `mathlib_search`. Failure returns missing/available capabilities and an action/hint before a claimable Task is created. This checks availability, not scientific value. [Source: Bridge](../../src/agent/services-bridge.js).

### 5.3 Claim failure and register-and-take

`bindClaim` records the durable claim locally, invalidates its profile cache and invokes activation hooks. On failure it attempts Runtime `stopExecution(..., FAILED, task_take_bind_failed)`, a Task Service stop fallback, or a fencing fallback. It clears the local binding, calls the release hook with original IDs and rethrows the original error. Cleanup exceptions are suppressed; rollback is attempted, not guaranteed to succeed in every external component.

For `task_register(take:true)`, Bridge first saves `execution_progress(kind=checkpoint)`, using supplied Progress or defaults that record registration as the next step. Task Service then registers the new Task, ends the old Execution and claims the new one transactionally. Afterwards Bridge asks Runtime to detach the old Execution, records work evidence, releases its old local claim and binds the new claim. The database transition and physical actions are separate failure boundaries; a later bind failure does not undo the earlier checkpoint/transaction. [Sources: Bridge](../../src/agent/services-bridge.js), [Task Service](../../src/task/task-service.js).

### 5.4 Bridge callbacks actually installed by the benchmark

The Bridge is reusable infrastructure: defining an optional callback does not mean the benchmark supplies it. The installed callbacks are part of the actual control flow and explain which tool calls also change Runtime or report state.

| Callback | Benchmark behavior |
|---|---|
| `onClaimAccepted` | Supplied as an empty async callback; no additional admission rule or model message |
| `onClaim` | Stores the claim, assigns the Core, binds the existing Session with no initial prompt, starts same-Session continuation after settlement and records Workspace/claim latency evidence |
| `onSubmitCandidate` | Resolves Candidate source, runs/applies Judge and returns feedback; retryable checker infrastructure failure can request deferred blocking after the response boundary |
| `onSchedulerStatus` | Returns current Core/WAITING counts, available project Task summaries and current binding; it does not select or claim work |
| `onRelease` | Records release latency/state, clears the matching Core binding while retaining the identity Session, applies legacy WAITING projection where applicable and wakes identity loops. Missing lineage is only a capacity-release observation. |
| `onWorkspaceWrite` | Records revision/file/hash metadata and a Workspace work unit |
| `onWorkUnit` | Records supported structure, read/consumption, creation, publication/link, review, lifecycle, candidate and wait evidence; selected operations wake identity loops. These observations do not establish scientific usefulness. |
| `onError` | Records bounded tool-error classification. Contract errors are marked recoverable; the special `CONFLICT` accounting branch checks the legacy operation name `claim`, not `task_take`. |
| `onTaskCreate` | Not supplied; Bridge still performs its own capability admission and Task Service still applies the Task contract |
| `onBeforeSubmitCandidate` | Not supplied; the benchmark's source/checker work occurs in `onSubmitCandidate`, after registered submission |

The generic Bridge calls `onWorkUnit` for `task_register` and `task_take`, but the runner callback has no specific accounting branch for either operation. Its `task_created`/dynamic-Task event branch checks only `task_create`. Durable Task state and Task-event wakeups therefore matter when reconstructing register-created work; the callback counters alone are not a complete event history. [Sources: callback installation](../../src/benchmark/putnam-runner.js), [Bridge invocation](../../src/agent/services-bridge.js); see [06](06-observability-experiments.md) for evidence and counting limits.

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

Existing checks include [prompt tests](../../test/agent-prompt.test.js), [Pi adapter](../../test/pi-adapter.test.js), [capability profile](../../test/capability-profile.test.js), [profile/Bridge](../../test/capability-profile-bridge.test.js), [Bridge](../../test/services-bridge.test.js), [Task admission](../../test/task-admission-runtime.test.js) and [runner](../../test/putnam-runner.test.js). These identify tested seams; execution results belong in [STATUS](../STATUS.md).

Known baseline inconsistencies remain visible: benchmark Task instructions prohibit `shell` while a Sandbox-enabled deployment advertises bounded `sandbox_exec`; normal discovery does not automatically send the full Service-document block; Runtime can repeat composed context; and frozen Pi registrations can lag a later Bridge Registry revision. Resolve these through approved Issues. This documentation preserves the actual texts rather than silently improving their wording.

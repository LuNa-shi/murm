# 01. Agent Core: process, tools, binding and turns

Task proposals and execution are separate: the same UNBOUND Bot can publish several bounded responsibilities, or directly take existing work. ACTIVE Bots may propose a separate responsibility but cannot revise existing contracts or priority. UNBOUND revision/cancellation is validated by Task Service against Mission, contract/state versions, live ownership and cleanup; it does not replace a Session or create another coordination role. New proposals explicitly supply a short title, Mission gap, output, completion conditions and high/medium/low priority. The exact fields, history and legacy-read rules are in [03 Mission and Task](03-mission-task.md#contract-revision-and-cancellation).

This chapter describes the implementation at the source baseline named in [INDEX](INDEX.md). A Core is a reusable concurrency lane. It runs a Pi conversation, lets that identity choose a Task, and binds the same conversation to the resulting Execution. The model chooses research actions; the Bridge, Task Service and Runtime validate and apply those actions. The model cannot create a valid Execution merely by saying that it has taken work.

The complete prompt bodies, composition branches and delivery evidence are in [08 Prompts](08-prompts.md). State transitions are in [02 Execution](02-execution.md); exact tool schemas and deployment-dependent exposure are in [10 API reference](10-service-api-reference.md).

## 1. Objects that must be kept separate

| Object | Concrete implementation and lifetime | What changes it |
|---|---|---|
| Core | Benchmark `core-N` record and its Runtime/identity-loop slot | It persists across ordinary Task claims and releases within the run |
| Bot | Durable `bots` row registered before Sandbox/Pi creation; owns zero or one Execution | A closed Bot is never reused; the next run on the Core gets a fresh Bot ID |
| Session | `AgentCoreSession`, wrapping one Pi process, RPC stream and conversation storage | The registered Bot keeps this Session from discovery through its sole Task; a successor gets a new Bot and Session |
| Task | Durable responsibility owned by Task Service | Take, semantic completion, block or close |
| Execution | Durable authority for an attempt: Task ID, owner, Core, lease, fencing version and Workspace | Ends at a lifecycle boundary; Runtime never replaces the Session under the same Execution |
| Capability profile | Normalized Registry/Runtime description for `bound` or `recovery` | Built from Registry revision and the deployment capability list; it is not a Task take |

An unbound registered Bot still uses role `bound`. There is no separate `idle` role in `AGENT_ROLES`; the exported idle/generic/recovery prompt aliases contain the same stable instructions. Role `bound` therefore does not prove that an Execution exists. The Bridge checks the binding separately. [Sources: capability-profile](../../src/agent/capability-profile.js), [Bridge](../../src/agent/services-bridge.js), [benchmark](../../src/benchmark/putnam-runner.js).

## 2. How the model process starts

### 2.1 Adapter configuration and routing

`OpenSandboxAgentAdapter` is the research-process adapter. Its configuration includes the sandbox manager, command/provider/model routing, worker environment, model access and pinned Bot or solver resources. Runtime registers a Bot first; its `resource_key` identifies the worker before any Task/Execution exists. `AgentCoreSession` supplies RPC/event/stop behavior over the remote child transport, and `validatePiProvider` validates the selected native Pi provider. These shared helpers remain in `pi-adapter.js`; there is no local-process launch adapter or direct Runtime launch alternative.

The Agent adapter starts direct `pi`. An explicit absolute path ending in `/pi` is accepted for deployments with a different executable location. Other launcher commands fail before worker creation. Provider and model flags are passed directly to Pi.

| Provider | Launch behavior |
|---|---|
| `openai` | Direct Pi with explicit provider and model |
| `openai-codex` | Direct Pi with explicit provider and model |
| `gpt_proxy` | Direct Pi with explicit provider and model |
| `kimi_proxy` | Direct Pi with explicit provider and model. The benchmark launchers default to this provider with model `k3`. |
| Other value | Launch rejected with `INVALID_CONTRACT` |

The registered OpenSandbox argument list, resource attestation and tool exposure are described in §2.4. Startup always uses that adapter; there is no custom local adapter factory or fallback that changes tool permissions. [Sources: benchmark composition](../../src/benchmark/putnam-runner.js), [OpenSandbox adapter](../../src/agent/opensandbox-agent-adapter.js).

### 2.2 System instructions and version records

Registered OpenSandbox startup selects the pinned Bot system resource and four skill resources, or the solver resource in explicit solver mode. It rejects an unrecognized custom system prompt or Service extension; null configuration does not disable attestation. The worker passes the selected immutable file through Pi’s system-role append mechanism. No host-local adapter writes a replacement identity file. The [complete bodies](prompts/01-system-identity.md) are distinct from ordinary user RPC messages.

Before spawning, `createVersionManifest` records the exact installed Pi and Node versions and launch arguments. Explicit constructor values win. `SWARMENV_PI_VERSION` can supply the pinned Pi version, otherwise startup queries the guest executable. Both versions require exact semantic versions. The exported latest-version lookup is an explicit utility. `package.json` pins Pi package `1.3.0`, while the recorded executable version provides evidence for an actual run. [Version manifest](../../src/agent/version-manifest.js).

### 2.3 RPC protocol and process lifetime

Each command is a JSON object followed by a newline on stdin. `sendCommand` creates an RPC ID, stores a pending promise and starts its timer before writing. Default command/prompt acknowledgement timeout is 30 seconds. A matching response with `success:false` rejects with `RPC_ERROR`; an acknowledgement timeout removes the pending command. A successful acknowledgement is not semantic Task completion.

Stdout is accumulated and split on newlines. Non-JSON lines are ignored by the parser but remain in raw stdout. Parsed records enter `rpcRecords`, resolve matching RPCs and emit the `rpc` event. Stderr is accumulated separately. `waitForReady` accepts a `ready` record when present; Pi 1.3.0 normally has no standalone ready record, so the adapter sends `get_state` and uses its response as readiness. The response also supplies the model context-window value.

`waitForSettled` waits for `agent_settled`, optionally after a record sequence. Its adapter default timeout is 120 seconds; benchmark callers can choose a longer bound. This is a turn boundary, distinct from Execution release. `set_auto_compaction`, `set_auto_retry`, `get_session_stats` and `prompt` are separate commands. Runtime-managed initial turns enable compaction and retry before sending; reusable benchmark startup has its own sequence in [08](08-prompts.md).

Closing the process rejects pending RPCs. `wait()` reports unexpected nonzero exit or signal as `PROCESS_EXITED`. `stop()` marks exit expected, sends `SIGTERM`, waits five seconds by default, then sends `SIGKILL` and waits at most a further second. Runtime decides whether an exit needs recovery. [Source: pi-adapter](../../src/agent/pi-adapter.js).

### 2.4 OpenSandbox worker transport (Issue 119 slice)

The external provider path uses `OpenSandboxAgentAdapter` and the image-resident `scripts/opensandbox-agent-worker.mjs`. Runtime registers the Bot before selection, creates its Sandbox with the fixed worker entrypoint and a private worker bearer, and resolves the worker endpoint. Startup rejects missing Bot registration. The authenticated `/start` carries the registered contract, expected resource hashes and Pi command; the guest cwd is `/workspace/project`, while Session and runtime state live under `/workspace/runtime`. Pi receives `--tools read,write,edit,bash`, `--no-extensions`, the fixed system addendum and four explicit skill paths. The project is initially empty and protected; take prepares and grants it. The worker exposes `/rpc`, `/events` and `/stop` and keeps its control credential out of Pi. Only allowlisted public routing fields and separately supplied secret fields enter startup. In timed runs the host gateway supplies bounded model credentials and deadlines; arbitrary controller environment and provider lifecycle keys are not inherited. See [configuration](07-run-configuration.md) for network and disk enforcement.

`RemoteAgentChild` presents those routes as the same stdin/stdout/stderr/close shape consumed by `AgentCoreSession`. Each RPC response and event carries a worker sequence and is de-duplicated before entering the normal newline-delimited Pi parser. The event endpoint accepts a sequence cursor; a dropped stream reconnects and replays only later records. When OpenSandbox returns a retryable 5xx/`SERVICE_UNAVAILABLE` for SSE, the adapter switches to one-second authenticated `get_state` polling with the last worker sequence. The worker returns retained records strictly after that cursor; the adapter advances the cursor while deduplicating replayed records. Poll failures are logged as bounded transport observations and do not create a second Pi command. Generic transient stream errors continue with exponential reconnect backoff; non-retryable contract errors reach Runtime. The worker caches a bounded set of completed RPC IDs, so a retry after a lost response does not write a duplicate Pi command. A worker exit closes the remote RPC Session. The adapter wraps `session.stop()` to confirm deletion of the original worker sandbox even after RPC has closed; deletion failures propagate and a later stop retries the same resource. For registered Bots, Runtime aliases the Execution to the existing Bot Sandbox; deletion removes both aliases. Lower-level provider diagnostics can own separate resources; the Agent adapter rejects unregistered research startup. A transport close alone does not free a Core. The adapter tests cover both reconnect and historical polling; a deployed run still has to prove that the pinned image and provider endpoint remain healthy.

The adapter also owns failed startup before a Session can be returned. It tracks the in-flight startup separately from `pendingStartupCleanup` (failed resources), rejects a concurrent start on the same adapter, retries failed deletion before another start, and exposes `cleanupPendingStarts({shutdown:true})` for benchmark shutdown. Shutdown joins the in-flight startup and blocks late worker publication; the runner also joins its Core startup promise before collecting Session cleanup obligations. OpenSandbox records a newly created provider ID before resolving its endpoint or health; preparation failure keeps that record if compensation fails, and `ensureExecution` rejects reuse while preparation/cleanup is pending. The provider ID is also persisted in `bots` through `onSandboxCreated` immediately after creation and before endpoint/health preparation. Live sessions and worker tokens remain in memory. Process-loss reconciliation uses durable Bot identity and provider labels to find and delete orphan resources; it does not restore the old Pi Session. Ambiguous creation or deletion retains cleanup ownership. [Execution](02-execution.md) describes recovery and its limits.

## 3. The registered Bot path

1. **Create the lane and Bridge.** The benchmark creates four Core records, each with a Runtime limited to one worker, a Bridge, Workspace access and an adapter. Service state is shared across the project; an Execution's Workspace is not a Core-private shared working directory.
2. **Start the Session while unbound.** A configured first-Bot stagger sets when each Core may begin its first discovery. Once eligible, a Core can start independently, including while other Cores are in discovery or execution. Runtime first persists the Bot and rotates its Bridge identity/token. The child receives that Bridge URL/token and `SWARMENV_AGENT_ROLE=bound`. Runtime waits for readiness before the runner marks the Session as an `identitySession`. It supplies no `agentPrompt` to `adapter.start`.
3. **Send one discovery turn.** `IdentityTaskLoop` supplies eligible Tasks to `takeTaskWithAgent`. The runner sends the registered Bot startup message: current Mission, Bot/Core/Session identity, pinned public Workspace preview, budget deadlines, CLI service directory and an explicitly partial eligible Task page. The system text and four built-in skill bodies are fixed resources; the message records their hash and names. Every Core can enter discovery with an empty page. While the Mission is open and selection time remains, the Bot prefers suitable existing work or identifies a gap from the public state and proposes and takes a distinct local Task. Every proposal remains an ordinary Mission Task, including the first. The runner neither promotes it to root nor removes it from ready-work accounting.
4. **Create the durable take.** The Bridge authenticates its own actor/Core, strips caller-provided owner and prompt claims, and invokes Task Service. A rejected take remains a failed take. The identity supervisor only accepts the actual transport receipt; it cannot turn a selected Task ID into an operator take.
5. **Bind the existing Session.** The Bridge stores returned IDs; the runner hook prepares Workspace in the existing Bot Sandbox, validates that the original Session is still live, activates Execution durably and registers the process. The tool result returns to that same turn with Runtime's activated Execution and prepared Workspace descriptor. Task Service's durable reservation receipt remains separate from the post-preparation response.
6. **Continue research on that lane.** After a turn settles, the runner can send another bound continuation if Execution is still `RUNNING`. Reading, checking or publishing a Material does not release the lane by itself.
7. **Release at a lifecycle boundary.** Accepted Finish or Runtime stop retains ownership while the Session, Sandbox and Workspace are cleaned. The registered Bot closes its sole Session; a later responsibility starts a fresh Bot/Execution from public state.

The runner suppresses discovery when the Core has a Task/Execution or an active turn. Before replacing a closed or failed unbound Session, it calls `stop()` even if the RPC transport is already closed; failed deletion retains the Session and prevents another startup. It records `take_deferred` for transient races rather than consuming another attempt. Selection, taking, process binding and settlement are separate steps, so failures must be attributed to the correct step. [Sources: benchmark](../../src/benchmark/putnam-runner.js), [identity loop](../../src/runtime/identity-task-loop.js), [Runtime](../../src/runtime/runtime.js).

In this manual, “candidate” refers only to a mathematical result file inside a Workspace revision. It is not a runtime entity, identifier, storage table or CLI operation; all checks use the Workspace source `(workspace_id, revision, path)` contract.

## 4. Native tools and the Service directory

Registered Bot and independent solver Sessions expose exactly Pi's native `read`, `write`, `edit` and `bash` tools. The worker passes their explicit allowlist and disables ambient extensions. The immutable Bot system addendum and four skill resources describe how to use the protected `swarm` CLI through Bash. Solver mode loads its own system addendum and no Swarm skills.

The Bridge builds a role-scoped capability profile from the configured Registry, removes internal audiences, and computes a deterministic version/hash. This profile is an authorization and discovery projection. `botServiceDirectory` maps its Services to CLI namespaces; Task supplies Mission, Task, Workspace and Bot namespaces, Context supplies Material, and Catalog supplies Service discovery. The startup message carries Service metadata and documentation references. `swarm service view` retrieves registered metadata and authorized documentation; complete optional provider documents are not automatically appended to each model turn. A Registry change can change later command admission without modifying Pi's native tool list.

Full system addenda, skills, directory fixtures, continuation messages and result guidance are recorded in [Prompts](08-prompts.md). There is no separate SDK prompt composer or named Service-tool extension.

## 5. Bridge transport and authorization

### 5.1 HTTP contract

The Bridge defaults to `127.0.0.1` on an automatically allocated port with a random bearer token. It gives the child `SWARMENV_BRIDGE_URL` and `SWARMENV_BRIDGE_TOKEN`. Both `/profile` and `/call` require authentication. `GET /health` returns only Bridge health and does not require the token. Missing/wrong token on protected routes returns HTTP 401; unknown route returns 404. The request reader rejects bodies larger than 2 MiB and parses JSON. Call/parsing failures before the response is sent are returned as HTTP 400 with the structured error body.

The protected CLI posts operation and payload to `/call` using worker-injected credentials. It creates a stable request ID before dispatch and includes it when a response is uncertain; a retry can replay that same ID. The Bridge supplies its authenticated actor/Core, durable Bot/Task/Execution identity and fencing versions rather than trusting caller ownership fields. Domain operations enforce their own receipt and replay contracts. The CLI prints the structured success or error response as the native Bash result; provider/Pi result rendering remains external to this repository.

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
| `onRelease` | Records release latency/state, clears the matching Core binding after Runtime cleanup, projects the released Core as IDLE and wakes identity loops. Missing lineage is only a capacity-release observation. |
| `onWorkUnit` | Records reads/consumption, Task creation, publication/link, lifecycle, Workspace mutations and Judge evidence; selected operations wake identity loops. Terminal project receipts are observed under the original Task/E before response fencing and deduplicated by CheckResult ID within the Core. Project checks do not create progress work units. |
| `onError` | Records bounded tool-error classification. Contract errors are recoverable; `CONFLICT` from `task_take` also records recoverable take-conflict evidence. |
| `onTaskCreate` | Not supplied; Bridge still performs its own capability admission and Task Service still applies the Task contract |
| Judge submission | Bridge resolves fixed inputs and Judge checks/persists them without a runner relay. File-mode accounting retains its compatibility work unit; project-mode accounting records diagnostic coverage without a progress work unit or automatic Mission completion. |

The generic Bridge calls `onWorkUnit` for `task_create` and `task_take`. The runner has a specific `task_create` branch recording creation/deduplication evidence and a coordination work unit; it has no corresponding take branch in this callback. Take activation is recorded through the dedicated take/Runtime path. Durable state, accepted receipts and Task events remain necessary; callback counters alone are not a complete history. [Runner](../../src/benchmark/putnam-runner.js) · [Bridge](../../src/agent/services-bridge.js) · [Observability](06-observability-experiments.md).

## 6. What is observable

The adapter records launch arguments/version manifest as operator events. Raw stdout/stderr, outgoing RPC requests and incoming RPC records are private observations. Derived tool-start/tool-finish events are private too. `session_started`, `session_closed` and `agent_settled` are lifecycle evidence. Observation failures are caught and do not terminate the research process.

| Record | Establishes | Does not establish |
|---|---|---|
| System-prompt file and launch flag | Exact SwarmEnv addendum supplied to Pi | Pi/provider's complete upstream system message |
| Raw `rpc_request` with `type:prompt` | Exact user message written to Pi stdin, ID and order | Successful processing or useful action |
| Successful matching RPC response | Command acknowledged | Task/Mission completion |
| `agent_settled` | Model turn settled | Execution released or candidate passed Judge |
| Tool result/domain event | Validated operation's result | Scientific usefulness beyond that result |

The benchmark's `core.prompt` hash is a hash of a base SOP field, not the evolving transcript. Replay also depends on tool results, candidate/Material content, notifications, profile/configuration and Pi-owned state. [08](08-prompts.md) explains the current records without claiming they capture the full upstream model request.

## 7. Validation and known limits

Existing checks include [Pi adapter](../../test/pi-adapter.test.js), [capability profile](../../test/capability-profile.test.js), [profile/Bridge](../../test/capability-profile-bridge.test.js), [Task behavior](../../test/task-contract.test.js), [Judge boundary](../../test/bot-runtime.test.js) and [benchmark CLI](../../test/benchmark-cli.test.js). These identify tested seams; execution results belong in the linked GitHub Issue/PR and experiment reports.

Registered Bots use native Bash and the protected CLI; the old whole-proof Task instructions prohibiting shell were removed. Startup sends the live service directory and skill manifest, while full skill text enters context when read. Actual send paths and complete repository-owned instructions are documented in [Prompts](08-prompts.md).

Accepted finish handling captures IDs from the durable receipt before observer callbacks. Observer or release-callback failure is logged without converting the accepted finish into a rejected tool call. The handler checks the captured binding before releasing it after an asynchronous callback.

## Registered Bot identity and Bridge credentials

`startAgentSession` enters `Runtime.startBot` with the Mission and Core, a five-minute default selection budget, and the configured turn timeout for readiness (30 seconds by default). Runtime persists STARTING before calling the adapter. The factory sets the Core actor to the new Bot ID, calls `Bridge.startBotIdentity`, and copies its newly generated bearer token into the live child environment before launching Pi. Rotation rejects a still-occupied previous Bot or a retained Execution binding. Old bearer tokens no longer authenticate to that Bridge.

After provider identity is recorded and Pi readiness/retry/compaction setup succeeds, Runtime marks the Bot UNBOUND. It can inspect shared work and create/take a Task. During STARTING, PREPARING, CLOSING or CLOSED, the Bridge refuses ordinary contributions; finish/exit requests still reach their durable replay validation. This check protects the Bot Bridge. Standalone built-in HTTP hosts require actor-bound principals but lack some coordinated lifecycle seams; internal local callers remain outside the registered Bot surface. [Services](04-services.md) records these current limits; independent deployment work is tracked in Issue #130.

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

The Material CLI uses `swarm material` and routes to Context Service.

`task propose` maps to `task_create`; `task view/take <id>`, `material view <id>`, Material/Workspace search queries, Workspace files/read paths and Judge result IDs have positional mappings. `workspace ... --at R` becomes `revision: R`; `workspace diff --from R1 --to R2` routes to the public Mission read, while no revision arguments select current-E diff; `mission submission view <id>` queries the existing submission interface. File/stdin inputs must be JSON objects. Boolean flags do not consume subsequent arguments, and inline values preserve embedded equals signs. The CLI puts `--request-id` in the request envelope. A retry uses the same ID and payload. The CLI rejects Bot identity overrides, while `task_id` remains a target selector, not proof of ownership. Results go to stdout as JSON; diagnostics go to stderr. Request timeout is 30 seconds by default, configurable up to 2147483647 ms. Exit codes remain success 0, transport failure 1, contract failure 2 and checker FAIL 3. Timeout is an unknown response, not a confirmed rollback.

For registered Bots, the Bridge supplies the durable Mission to Mission view, Task proposal/list/status and Material search/list. Explicit foreign Mission IDs reject. Task view/take and exact Material reads check their target's Mission. Public Workspace reads use Runtime's configured Mission Workspace, verify its stored Mission and reject another Workspace ID. The identity/deadline is rechecked after the asynchronous Workspace lookup. These checks cover Bot entry paths. Save/apply/merge additionally enforce the Runtime publication guards described in [Workspace](05-workspace-continuity.md). Independent Context/Judge peers use the separate Task-owned authorization protocol in [Services](04-services.md).

A successful `task_take` receipt is retained by the live Bridge only after the Runtime callback completes prepare/activate/grant. Repeating its request ID and identical payload returns the same receipt without rebinding or allocating another E; changed payload conflicts, and another request ID cannot take a second Task. During preparation, the same explicit request ID and payload join the original promise; changed payload conflicts and other contribution calls remain rejected. No second activation occurs. Receipt replay still checks Bot state/deadline first and emits a replayed `bridge.complete` event. Identity rotation clears the receipt. This is live-Bot response recovery: restoring a Bridge/Pi after a controller restart is not implemented by this cache. The durable Task take/Execution records remain the external source after Bot termination. Mission-scoped Task status also filters active Core lanes in SQL; foreign Mission lanes never appear in this projection.

`test/bot-bridge.test.js` exercises a real CLI subprocess, Bridge/Task Service and Git Workspace: discovery, Mission read, pinned input, proposal replay, take/activation/replay, identity rejection and cancellation with a replacement Task. Runtime activation is controlled, so this test alone does not validate Pi/provider behavior. Mission view exposes persisted goal, acceptance conditions, merge-check policy and creation metadata; it is not a combined runtime budget/main/submission snapshot. Registered Mission submission uses the trusted coordinator in [03](03-mission-task.md); current-E status/diff/save, public apply and guarded merge use [05](05-workspace-continuity.md). Legacy private Workspace operations reject for registered Bots.


### Four-tool registered Bot input path

Registered OpenSandbox Bots now use the versioned `bot-contract` resources. Worker startup verifies their hashes and root ownership before native Pi starts with read/write/edit/bash; no per-Service extension tools are registered. Pi receives the system addendum from an immutable image file and exactly four explicit skills. Ambient context, extension, skill and prompt-template discovery stay disabled. Services are reached through Bash and `swarm`; the Bridge owns identity and lifecycle guards. [Prompts](08-prompts.md) explains exact first-turn fields, their sources, actual send paths, continuation/notification/compaction behavior and remaining compatibility paths.

The runner records only these four tool names as valid. It no longer sends the old per-Service guide, repeats the old SOP in bound turns, or constructs the unused whole-proof Task template. A registered Bot compaction records private context progress but does not automatically snapshot the controller's private Workspace; public file persistence requires the explicit Runtime save flow. The local network-disabled Pi probe and the four-Core actual send-path test establish this wiring; EXP-20261116-04 additionally verified the pinned remote provider/image combination. That evidence is version-bound; changing the image or provider requires its corresponding preflight.

## Independent solver startup

Pass@K explicitly selects `agentMode: solver`. The same OpenSandbox adapter and worker load the immutable `solver-system.txt` resource under contract `swarm-solver-v1`, retain native `read,write,edit,bash`, disable automatic extensions/context/prompts, and load no collaboration skills. The default Swarm contract remains `swarm-bot-v1-draft.3` with its system and four skill resources. Host and worker both verify the selected complete resource set; worker permissions, ownership, hashes, model catalog and quota attestations still apply. An incorrect or mixed resource set fails startup. The manifest records the actual selected prompt/resource identity. The solver system text follows the lightweight image contract: no local Lean/Lake/Mathlib installation, and all compilation or execution checks go through Judge.

The worker receives `SWARMENV_AGENT_MODE=solver` to tailor CLI help. This variable controls presentation, not authorization: changing it cannot expand the host Bridge's capability allowlist. Existing per-Bot startup removes upstream service endpoints/tokens, and the budgeted model path retains only the Bot-scoped gateway credential and Bridge token. The first solver user message is sent after host-controlled take and activation, with the original problem ID, target path, `/workspace/project` and fixed run deadline. No discovery turn is sent. See [Launch](07-run-configuration.md) and [Prompts](08-prompts.md).

# 01. Agent Core: process, tools, binding and turns

Task proposals and execution are separate: the same UNBOUND Bot can publish several bounded responsibilities, or directly take existing work. ACTIVE Bots may propose a separate responsibility but cannot revise existing contracts or priority. UNBOUND revision/cancellation is validated by Task Service against Mission, contract/state versions, live ownership and cleanup; it does not replace a Session or create another coordination role. New proposals explicitly supply a short title, Mission gap, output, completion conditions and high/medium/low priority. The exact fields, history and legacy-read rules are in [03 Mission and Task](03-mission-task.md#contract-revision-and-cancellation).

The legacy domain Runtime uses reusable capacity lanes and binds a registered Bot conversation to its Execution. The programmable Phase 0005 Core gives each run its own Runtime identity and uses Slots to count Bot capacity. The model chooses research actions; the Bridge, Task Service and Runtime validate and apply those actions. The model cannot create a valid Execution merely by saying that it has taken work. [Core Runtime](15-core-runtime.md) · [Source coverage](12-code-coverage.md)

The complete prompt bodies, composition branches and delivery evidence are in [08 Prompts](08-prompts.md). State transitions are in [02 Execution](02-execution.md); exact tool schemas and deployment-dependent exposure are in [10 API reference](10-service-api-reference.md).

## 1. Objects that must be kept separate

| Object | Concrete implementation and lifetime | What changes it |
|---|---|---|
| Legacy Core lane | Caller-provided capacity identity used by the domain Runtime | The caller owns its scheduling and resource policy |
| Bot | Durable `bots` row registered before Sandbox/Pi creation; owns zero or one Execution | A closed Bot is never reused; the next run on the Core gets a fresh Bot ID |
| Session | A host-supplied Session wrapping one process, RPC stream and conversation storage | The registered Bot keeps this Session from discovery through its sole Task; a successor gets a new Bot and Session |
| Task | Durable responsibility owned by Task Service | Take, semantic completion, block or close |
| Execution | Durable authority for an attempt: Task ID, owner, Core, lease, fencing version and Workspace | Ends at a lifecycle boundary; Runtime never replaces the Session under the same Execution |
| Capability profile | Normalized Registry/Runtime description for `bound` or `recovery` | Built from Registry revision and the deployment capability list; it is not a Task take |

An unbound registered Bot still uses role `bound`. There is no separate `idle` role in `AGENT_ROLES`; the exported idle/generic/recovery prompt aliases contain the same stable instructions. Role `bound` therefore does not prove that an Execution exists. The Bridge checks the binding separately. [Sources: capability-profile](../../src/agent/capability-profile.js), [Bridge](../../src/agent/services-bridge.js).

## 2. How the model process starts

### 2.1 Current Core startup and retained domain seam

The supported programmable entry is `createRuntime` with `createPiOpenSandboxBackend`; [Core Runtime](15-core-runtime.md) explains its complete lifecycle. The Environment supplies frozen Profiles, model aliases, Services and capacity. The backend creates a Runtime-owned Bot Sandbox through `OpenSandboxManager`, applies network and disk isolation, resolves guest versions and requires Pi `1.3.0` before starting direct `pi`. The Profile selects its configured model alias; the backend passes that alias's provider/model to Pi and receives only per-Bot gateway credentials. There is no separate host provider-name allowlist from the retired adapter.

The old `OpenSandboxAgentAdapter`, `AgentCoreSession` and provider-validation helper have been removed. They had no production caller in the migrated Environment paths; the source barrel no longer exports them. The legacy domain Runtime still accepts a host-supplied `startSession` callback on `startBot`. It registers the durable Bot before calling that factory with the Bot identity, abort signal and startup/resource guards. That caller owns its Session construction and must support readiness and confirmed stop; the seam does not select or attest a bundled adapter. Removing the old adapter does not remove that domain lifecycle or change the public Core.

### 2.2 Current system instructions, versions and RPC

The Core backend supplies the host Profile prompt at `/workspace/runtime/profile-prompt.txt`, the four native tools `read,write,edit,bash`, and flags disabling ambient extensions, skills, prompt templates and context files. Its Session directory is `/workspace/runtime/pi-session` with a fresh Session ID. It passes `agentMode: core`, declared FileSeeds, write permission, quota and expanded model-catalog evidence to the Worker. The Worker attests the supplied inputs before launch; this path does not automatically append the legacy Bot system resource or four Swarm skills. Environment prompt composition is documented in [08 Prompts](08-prompts.md).

The backend checks a successful `get_state` response with a ten-second wait before reporting readiness. Input acknowledgements and semantic settlement remain different: Core owns the request ledger and the backend submits each prompt once, then queries the same Worker RPC result after a lost acknowledgement. It does not resend that prompt to recover a receipt. The backend consumes retained Worker records by contiguous sequence, ignores an already consumed prefix and reports a fatal history gap instead of fabricating output or a later settlement. It polls the authenticated RPC endpoint rather than using the retired adapter's SSE reconnect/fallback loop. Its actual output, failure, exit and stop handling are described in [Core Runtime](15-core-runtime.md); settlement does not release capacity.

Version evidence comes from the guest used for startup. `OpenSandboxManager.agentVersions` executes `pi --version` and `node --version` through the authenticated guest command endpoint, checks successful exit and parses exact semantic versions. The Core backend requires the observed Pi version to be `1.3.0` before launching the Bot and records both observed versions with the spawn receipt. It does not query the npm registry or use a separate host-generated version manifest. [Guest version resolution](../../src/runtime/opensandbox-manager.js) and [backend startup](../../src/core/pi-opensandbox-backend.js) own this path.

### 2.3 Retained Worker and provider contracts

The image-resident [Worker](../../scripts/opensandbox-agent-worker.mjs) still exposes authenticated `/start`, `/rpc`, `/events` and `/stop`; its control bearer remains outside Pi. `OpenSandboxManager` continues to own provider requests, fixed entrypoint enforcement, endpoint preparation and resource reconciliation. Current Core owns the sequence of execution stop, required private collection and sandbox deletion, and retains capacity and cleanup evidence until those stages are confirmed. A worker exit or closed transport alone does not prove resource deletion. Failed or ambiguous creation remains owned and discoverable for reconciliation; no old Session is recovered after process loss.

The Worker also retains its registered Bot contract mode for direct protected callers. Registered Bot mode requires the immutable system resource and four skill resources, starts with a protected project and admits preparation/grant through its authenticated control API. The network-disabled `test-support/bot-contract-probe.mjs` supplies explicit fixed registered-mode launch arguments and checks actual Worker resource attestation, native tool exposure and Bash/Bridge use. It no longer obtains arguments through the deleted adapter and does not establish that current Core stages those legacy prompts. Manager/Worker protection, Task workspace preparation and caller-owned legacy Runtime behavior remain in this tree; [Workspace](05-workspace-continuity.md) describes those boundaries.

Deterministic current-path coverage includes [Core input recovery](../../test/core-pi-input.test.js), [capacity lifecycle](../../test/core-capacity-lifecycle.test.js), [provider manager](../../test/opensandbox-manager.test.js) and [Worker image contract](../../test/opensandbox-image-contract.test.js). These replace the deleted adapter-specific transport tests as the applicable verification seams. Native probes remain opt-in; their presence is not evidence of a new execution.

## 3. The registered Bot path

The legacy domain Runtime exposes `startBot` to its host. It first persists STARTING and invokes the supplied Session factory, then waits for readiness and marks the Bot UNBOUND. The authenticated Bridge permits discovery and proposal operations subject to current Mission, selection and hard deadlines. The host supplies any discovery input and scheduling policy.

A successful `task_take` reserves one Execution. The Runtime prepares the pinned Workspace in that Bot's existing Sandbox, verifies that its original Session still owns the attempt, activates the Execution and grants writable access. The tool result returns to that same Session. Finish, handoff or budget stop retains the original Task/Execution identity until process and resource cleanup are confirmed.

The former benchmark wrapper, four-lane scheduler and repeated discovery/continuation sender have been removed. Phase 0005 flat assembly uses its own controller and the public Core. The [Execution chapter](02-execution.md), [Workspace chapter](05-workspace-continuity.md) and [foreground host](17-environment-reporting.md#foreground-environment-control) describe the applicable lifecycle and routing.

## 4. Native tools and the Service directory

Current Core builds Pi arguments selecting `read`, `write`, `edit` and `bash` and disabling ambient discovery. The direct registered-Worker probe supplies equivalent flags plus the immutable Bot system addendum and four skill paths itself. For the registered Bot contract, the Worker validates that arguments are strings and attests the exact declared resource set, ownership and hashes; it does not parse the argument list to enforce a tool allowlist or disable ambient discovery. Those launch choices belong to the authenticated trusted caller. Core contract mode additionally requires direct `pi` and its explicit Profile prompt; this does not make the legacy Worker modes a general command-policy enforcement boundary.

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

### 5.4 Caller-owned Bridge hooks

The legacy Bridge accepts optional hooks for take activation, release, work observation, errors and Task creation. Their presence and behavior depend on the host assembling that Bridge. The Bridge performs its own identity, capability and lifecycle checks before invoking them. Take activation must complete before a successful live receipt is cached. Accepted finish handling captures durable IDs before asynchronous observers and isolates observer failures from the accepted result.

The removed benchmark's counters and lane bookkeeping are preserved in the research revision. Current public-Core flat Services call their controller and publication adapters directly. See [Services](04-services.md) and [Environment reporting](17-environment-reporting.md).

## 6. What is observable

The deleted Session adapter no longer emits its former `session_started`, `session_closed`, raw RPC or tool observation records. Historical stores can still contain those version-bound events. Current Core records its actual Runtime/Bot identities, backend version evidence, input receipts, projected output/error/settled events and cleanup receipts through its own event and report paths; [Core Runtime](15-core-runtime.md) explains those records. A caller-owned legacy Session factory may supply additional observations, but the domain Runtime does not reconstruct the removed adapter’s raw transcript or launch manifest.

The following interpretation applies when the corresponding historical or caller-owned record is actually present; it does not promise that current Core emits raw RPC or system-addendum observations.

| Record | Establishes | Does not establish |
|---|---|---|
| System-prompt file and launch flag | Exact SwarmEnv addendum supplied to Pi | Pi/provider's complete upstream system message |
| Raw `rpc_request` with `type:prompt` | Exact user message written to Pi stdin, ID and order | Successful processing or useful action |
| Successful matching RPC response | Command acknowledged | Task/Mission completion |
| `agent_settled` | Model turn settled | Execution released or candidate passed Judge |
| Tool result/domain event | Validated operation's result | Scientific usefulness beyond that result |

A prompt resource hash identifies those bytes. Replay also depends on tool results, candidate/Material content, notifications, profile/configuration and Pi-owned state. [08](08-prompts.md) explains the current records without claiming they capture the full upstream model request.

## 7. Validation and known limits

Existing checks include [Core input](../../test/core-pi-input.test.js), [capability profile](../../test/capability-profile.test.js), [profile/Bridge](../../test/capability-profile-bridge.test.js), [Task behavior](../../test/task-contract.test.js), [Judge boundary](04-services.md). These identify tested seams; execution results belong in the linked GitHub Issue/PR and experiment reports.

Registered Bots use native Bash and the protected CLI; the old whole-proof Task instructions prohibiting shell were removed. Caller-owned legacy startup can send the live service directory and skill manifest through the retained composition helpers; the Runtime does not automatically send that message. In the direct registered-Worker probe, full skill text enters Pi context through actual scripted reads. Current Core receives only the Environment’s configured Profile and inputs. Actual send paths and complete repository-owned instructions are documented in [Prompts](08-prompts.md).

Accepted finish handling captures IDs from the durable receipt before observer callbacks. Observer or release-callback failure is logged without converting the accepted finish into a rejected tool call. The handler checks the captured binding before releasing it after an asynchronous callback.

## Registered Bot identity and Bridge credentials

A legacy host calls `Runtime.startBot` with the Mission/Core, a caller-owned Session factory, a five-minute default selection budget and `readyTimeoutMs` (30 seconds by default). Runtime persists STARTING before invoking that factory. The host owns connecting its Bridge identity with `Bridge.startBotIdentity`, provisioning its scoped credential and starting the process. Runtime does not supply the removed adapter or benchmark `startAgentSession` wrapper. Bridge identity rotation rejects a retained Execution binding and revokes the previous bearer. Current Core instead issues its own per-Bot Bridge credentials during backend startup.

After provider identity is recorded and Pi readiness/retry/compaction setup succeeds, Runtime marks the Bot UNBOUND. It can inspect shared work and create/take a Task. During STARTING, PREPARING, CLOSING or CLOSED, the Bridge refuses ordinary contributions; finish/exit requests still reach their durable replay validation. This check protects the Bot Bridge. Standalone built-in HTTP hosts require actor-bound principals but lack some coordinated lifecycle seams; internal local callers remain outside the registered Bot surface. [Services](04-services.md) records these current limits; independent deployment work is tracked in Issue #130.

`bot_exit` requires an unbound Bot without a pending take. The Task Service rejects early exit while the Mission is open and both selection and hard time remain. For an eligible budget exit, the service stores CLOSING before Runtime stops the Session/Sandbox. The historical `no-work` reason is subject to the same eligibility check as `selection-budget`. The discovery supervisor reads this durable result even when process shutdown interrupts the RPC response. A settled turn alone does not take work, finish the Task or authorize early exit; the removed identity supervisor no longer produces its `DISCOVERY_INCOMPLETE` outcome. A host-owned Session factory is responsible for private process initialization. Current Core creates a fresh private work directory with only the declared FileSeeds.

Requests authenticated before a Bridge rotation revalidate the captured token after body parsing. Queued proposals revalidate before running their callback and after an asynchronous admission guard, so an old request cannot execute with the successor's identity. With `SWARMENV_BRIDGE_URL` configured, the `swarm` CLI sends commands to that authenticated Bridge; it does not construct a replacement Bot actor. This covers `swarm bot exit --reason selection-budget`. Without Bridge configuration, standalone Service manifest/endpoint mode remains available to existing callers.

A retained manager/Worker connection is addressed by its registered Bot resource key; take associates that existing resource with the Execution. Domain Runtime binding records retain the actual Task/Execution/Core identities. The removed remote Session adapter no longer translates its late transport diagnostics into observations; any caller-owned Session diagnostics must preserve their own accurate attribution.


### Fixed project and worker privilege boundary

The image now copies `scripts/sandbox-project.mjs` next to the worker and includes `setpriv` from util-linux. Before listening, the root worker reserves an empty `/workspace/project` owned by root with mode 0555 beneath a root-owned 0755 `/workspace`. A nonempty or symlink project root prevents readiness. `/workspace/runtime` belongs to UID/GID 10001 and contains the Bot's home, temporary data, Pi catalog and Session directory. Pi always starts with cwd `/workspace/project`; the supplied cwd cannot choose another path. System-prompt files must be within runtime scratch.

`/start` is single-use for the worker lifetime, even if Pi exits. The worker builds a fresh child environment from PATH/locale and explicitly supplied application/model values, places HOME/TMPDIR/PI_CODING_AGENT_DIR in scratch, copies and expands the non-secret image catalog there, and starts the child through `setpriv` with UID/GID 10001, cleared groups, no-new-privileges and empty capability sets. It does not inherit daemon/provider environment. The authenticated caller owns which application values and secrets it supplies; the removed adapter’s extra filtering is no longer an available startup layer. Current Core supplies Profile values plus per-Bot Bridge/model credentials, keeping upstream credentials in the host gateway. The Worker rejects a missing or extra pinned resource in registered Bot mode, but accepts a caller-provided command and string argument list; it does not enforce the tool or ambient-discovery flags. Current Core and the direct registered-Worker probe explicitly construct their own flags. Bridge/CLI authorization remains separate from this command construction. [Prompts](08-prompts.md) records the exact composition and send conditions.

The authenticated root worker exposes `/project/prepare` and `/project/grant` alongside its existing RPC routes. Their input is a reserved Execution/fence and, for prepare, the trusted complete manifest. They are controller operations, not Bot capabilities. The [Workspace chapter](05-workspace-continuity.md) explains validation and active-before-grant order. Bridge holds its provisional contribution binding closed throughout the asynchronous take callback and rejects another request until prepare/activate/grant succeeds. A pending binding also prevents identity rotation. Registered Bot calls to the legacy root `sandboxExec` capability are rejected; their actual shell path is non-root Pi Bash.

`/stop` marks project closing synchronously, kills the child process group and repeatedly enumerates `/proc` to kill every non-zombie process with the dedicated Bot UID, including detached descendants after Pi exits. It waits up to five seconds for absence, then revokes project directory ownership and permission. Failure is reported rather than counted as stopped. Late grant and second start are rejected. Provider deletion remains the final isolation/cleanup boundary; worker stop failure is retriable and the manager retains the endpoint until a successful stop or sandbox deletion. Local network-disabled Docker probes verify UID/permissions/environment and descendant stop; OpenSandbox management-plane/network isolation and external cost bounds still require separate acceptance evidence.

The retained manager rejects starting its Agent worker on a non-Bot sandbox. Current Core registers and owns its Bot before provider creation; the legacy domain Runtime passes its durable Bot identity to its caller-owned Session factory. Trusted version/command diagnostics may still use an unregistered sandbox, but that is not a registered research-Agent startup. The removed host adapter is no longer a launch or filtering layer.


### Registered Bot CLI discovery and request replay

The installed `swarm` executable enters `runSwarmCli`. When `SWARMENV_BRIDGE_URL` is present, both commands and `service list/view` use the authenticated Bridge; they do not fall back to direct Service URLs. Service discovery invokes the catalog's `list_services`/`get_service_metadata`. A configured domain command is checked against that Service's advertised operations and sent with its Service identity. With no Bridge configured, the operator transport still resolves HTTP Service manifests and sends an explicit envelope. Help remains offline in both modes.

The Material CLI uses `swarm material` and routes to Context Service.

`task propose` maps to `task_create`; `task view/take <id>`, `material view <id>`, Material/Workspace search queries, Workspace files/read paths and Judge result IDs have positional mappings. `workspace ... --at R` becomes `revision: R`; `workspace diff --from R1 --to R2` routes to the public Mission read, while no revision arguments select current-E diff; `mission submission view <id>` queries the existing submission interface. File/stdin inputs must be JSON objects. Boolean flags do not consume subsequent arguments, and inline values preserve embedded equals signs. The CLI puts `--request-id` in the request envelope. A retry uses the same ID and payload. The CLI rejects Bot identity overrides, while `task_id` remains a target selector, not proof of ownership. Results go to stdout as JSON; diagnostics go to stderr. Request timeout is 30 seconds by default, configurable up to 2147483647 ms. Exit codes remain success 0, transport failure 1, contract failure 2 and checker FAIL 3. Timeout is an unknown response, not a confirmed rollback.

For registered Bots, the Bridge supplies the durable Mission to Mission view, Task proposal/list/status and Material search/list. Explicit foreign Mission IDs reject. Task view/take and exact Material reads check their target's Mission. Public Workspace reads use Runtime's configured Mission Workspace, verify its stored Mission and reject another Workspace ID. The identity/deadline is rechecked after the asynchronous Workspace lookup. These checks cover Bot entry paths. Save/apply/merge additionally enforce the Runtime publication guards described in [Workspace](05-workspace-continuity.md). Independent Context/Judge peers use the separate Task-owned authorization protocol in [Services](04-services.md).

A successful `task_take` receipt is retained by the live Bridge only after the Runtime callback completes prepare/activate/grant. Repeating its request ID and identical payload returns the same receipt without rebinding or allocating another E; changed payload conflicts, and another request ID cannot take a second Task. During preparation, the same explicit request ID and payload join the original promise; changed payload conflicts and other contribution calls remain rejected. No second activation occurs. Receipt replay still checks Bot state/deadline first and emits a replayed `bridge.complete` event. Identity rotation clears the receipt. This is live-Bot response recovery: restoring a Bridge/Pi after a controller restart is not implemented by this cache. The durable Task take/Execution records remain the external source after Bot termination. Mission-scoped Task status also filters active Core lanes in SQL; foreign Mission lanes never appear in this projection.

`test/bot-bridge.test.js` exercises a real CLI subprocess, Bridge/Task Service and Git Workspace: discovery, Mission read, pinned input, proposal replay, take/activation/replay, identity rejection and cancellation with a replacement Task. Runtime activation is controlled, so this test alone does not validate Pi/provider behavior. Mission view exposes persisted goal, acceptance conditions, merge-check policy and creation metadata; it is not a combined runtime budget/main/submission snapshot. Registered Mission submission uses the trusted coordinator in [03](03-mission-task.md); current-E status/diff/save, public apply and guarded merge use [05](05-workspace-continuity.md). Legacy private Workspace operations reject for registered Bots.


### Four-tool registered Bot input path

The direct registered-Worker contract probe supplies the versioned `bot-contract` resources and Pi arguments for four native tools, four skills and disabled ambient discovery. Worker startup verifies the resource set, hashes and root ownership before executing the trusted caller’s command; resource attestation alone does not prove that the command loads those texts or flags. The probe checks actual model/tool input when explicitly executed. Current Core instead stages its Environment Profile prompt and does not automatically load those legacy resources. Services are reached through Bash and `swarm`; the Bridge owns identity and lifecycle guards. [Prompts](08-prompts.md) distinguishes repository text, caller composition and actual send evidence.

A registered Bot compaction records private context progress but does not automatically snapshot the controller's private Workspace; public file persistence requires the explicit Runtime save flow. Existing local network-disabled Pi probes and historical EXP-20261116-04 record version-bound evidence for their tested paths. That evidence is version-bound; changing the image or provider requires its corresponding preflight.

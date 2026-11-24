# Core / Environment verification contract

This reference supports [Issue #165](https://github.com/LuNa-shi/SwarmEnv/issues/165) and the Phase 0005 implementation. Requirements and acceptance come from the [complete Phase 0005 design at `c790fe1`](https://github.com/LuNa-shi/SwarmEnv/tree/c790fe1f4e3e1f13f098910ea3190a98cd74ca2d/docs/phases/0005-core-environment). Ticket progress, reviews and execution receipts belong on the corresponding GitHub Issue/PR.

The inspected implementation is `c790fe1f4e3e1f13f098910ea3190a98cd74ca2d`, first archived on `research` before refactoring and retained in its history. After Kimi PR #193, `research` points to the pre-refactor `dc01100` revision. The design's earlier implementation reference is `fcbe0107d8b4b204db0bcfa2a1ad1b2339c6293e`. The intervening commits add the authoritative design and its authority routing. This reference records the newer inspected tree explicitly. The tables below describe that fixed baseline and the verification obligations for its replacement.

## Vocabulary and ownership

| Term | Phase 0005 meaning and owner |
| --- | --- |
| Core | Importable library exposing Runtime, Services and the supported backend factory |
| Runtime | One host run that owns Bot identity, capacity, execution resources, records and bounded closure |
| Environment | Ordinary host JS/TS that assembles Profiles/Services and decides collaboration, routing and business completion |
| Bot | Independent identity with one Session, sandbox and private workDir, accepting continuous input while alive |
| Worker | Trusted sandbox process controlling the lower-privilege Pi process, RPC, events and controlled file operations |
| Slot | One Runtime capacity unit, reserved before provider creation and retained until required collection and destruction are confirmed |
| Session | The Bot's model conversation, retained across idle intervals |
| settled | One execution has completed, failed or aborted, with an output/error snapshot. Environment decides whether the business goal has succeeded |
| workDir | The Bot's private working directory |
| Profile | Frozen role prompt, model alias, image, permissions and resource defaults |
| Service | Business operations and data accessed through a manifest and adapter |
| Task / Execution / Mission / Material / Workspace | flat domain objects. Workspace is flat's public Git project |

The old `coreId` identifies capacity in the existing Runtime and has Slot semantics during migration. New `Runtime.id` identifies the entire host run. Core establishes the authoritative botId used by flat and trusted Service callers.

Core owns generic identity, resource versions, execution control, model access entry, permission enforcement and resource cleanup. flat owns Task discovery/take, domain lease/fence, fixed input selection, business finish, continuation, replacement and feedback. Resource preparation versions and domain fencing versions are checked independently. Each sandbox has one lifecycle owner throughout migration.

## Confirmed decisions

| Decision | Required behavior | Verification boundary |
| --- | --- | --- |
| Q1 | Pi 1.3.0 and OpenSandbox, with an internal backend boundary | Real supported image and local Docker deployment, plus rejection of unsupported configuration |
| Q2 | Profile and ServiceRegistry snapshots freeze before runtime starts. Dynamic spawn uses a registered Profile | Mutate original configuration after createRuntime, verify effective permissions/resources remain frozen, reject invalid references before allocation |
| Q3 | Independent Session, sandbox and workDir per Bot. Git, Service and explicit artifact operations carry shared results | Two Bot identities and resources, private-file isolation, explicit verified transfer |
| Q4 | Omitted send mode means steer. Explicit followUp is supported. agensh router and runInput helper use followUp | Idle/running sends, omitted and explicit modes, queued/handled/unknown receipts, supported Pi execution boundaries |
| Q5 | idle retains Session, workDir and Slot until stop | Same Bot works twice, keeps earlier state/files, and retains capacity between rounds |
| Q6 | Failed required collection retains the stopped sandbox and Slot with cleanup pending | Inject export failure, verify retained identity/resource/capacity, retry collection and confirm deletion before releasing capacity |
| Q7 | agensh delivers Git/PR, peer messages, shared context and event continuation | Two peer contributions reach common main, one peer reads and adopts the other's recorded result |
| Q8 | flat, agensh and a repository-external developer example actually use the same Core | Fixed Core revision and package identity across all three real acceptance paths |

The later subagents, scaleMAS and lead-helper examples retain independent acceptance criteria. Their completion is additional to Q8.

## Public contracts and inspected implementation

The target signatures and fields are defined by Core design §3–8 and appendix A. “Existing” below means a corresponding behavior can be located in the inspected source. “Migration” identifies reusable implementation with a changed responsibility or contract. “Pending” identifies the new public interface. Test results remain a separate evidence category.

| Surface | Target contract | Baseline finding and implementation slice |
| --- | --- | --- |
| Package/module exports | Core, services, opaque Pi/OpenSandbox backend factory and public types importable outside the repository | Pending. `package.json` is private, with a swarm CLI and internal source imports. #166, #180, #184 |
| createRuntime | Freeze configuration, validate service/profile/model/backend references, reserve `bot`, create records/Bridge/model entry, allocate no Bot sandbox | Pending. Existing `Runtime` constructor in `src/runtime/runtime.ts` accepts Task/Workspace services and lane configuration. #166–#167 |
| backend configuration | Lifecycle URL, reachable Bridge URL, model gateway, model aliases and explicit local network/disk limits | Migration. OpenSandboxManager and runner composition provide components. Manager currently fixes its image in the constructor. #166–#167 |
| spawn | Register botId, request and Slot before provider call. Bind events and establish independent resources. Return idle without submitting input | Pending. `Runtime.startBot` registers with TaskService and starts a discovery Session under Mission/Core deadlines. #166–#167 |
| get | Current saved BotInfo, including closed records, cursor, output/error and last stop | Pending. Existing Bot/Core/Execution views are domain-specific. #167, #172 |
| send | Required requestId, default steer, explicit followUp, idle/running only, bounded acceptance wait | Pending. PiSession and OpenSandbox adapter provide lower-level prompt/RPC operations. #168 |
| InputReceipt | accepted with started/queued/handled, or unknown retaining inputId | Pending. Existing session result handling does not establish this public receipt. #168 |
| Request replay | runtime/caller/operation/target/requestId plus parameter fingerprint. Same request reuses in-flight submission, different parameters conflict | Migration. Domain operation replay exists. Worker RPC caches completed responses and needs in-flight deduplication across the full input path. #168 |
| onEvent | Per-Bot monotonic seq, update state/cursor/results before notification, isolated subscriber failure | Pending. Existing Session events feed lifecycle/watchdog/observation logic. #168, #172 |
| settled/exit/error | Per-execution output/error snapshot, fatal classification, expected exit, detectable unrecoverable event gaps | Migration. Existing session/provider failure paths require a public generic event projection. #168 |
| FileSeed | Relative regular files, utf8/base64, 0644/0755, digest over canonical paths/actual bytes/modes, hard size checks | Pending. Existing sandbox project manifests provide reusable file transport. #170 |
| files.prepare | Only an empty read-only workDir, trusted Worker operations, registered botId/version/digest receipt | Migration. Existing project preparation follows Task take and Workspace input materialization. #170, #175 |
| files.grant | Current authentic prepared receipt, request replay, Bot/version/digest/closing checks, shared grant/close guard | Migration. Existing Runtime performs domain checks around manager grant. New Core must own the resource guard. #170 |
| collect | Fixed before resource allocation, relative paths, includeGit, hard maxBytes and required policy | Pending. Existing Workspace snapshot requires active Execution and excludes `.git`. #171 |
| stop | Close input, stop execution, retain Worker file channel, collect, destroy, confirm, release Slot | Migration. Existing adapter kill/session.stop and manager stop/release split control and cleanup. #171 |
| close | Close new requests, cover all registered Bots and in-flight/late creates, aggregate failures, close Bridge/model/backend resources | Migration. Existing shutdown tracks Sessions and startup/release promises through domain Runtime. #171 |
| stop/close receipts | execution stopped/unknown independently from cleanup complete/pending, artifacts and errors retained, retry pending cleanup | Pending. Existing cleanup/fencing records provide regression cases. #171–#172 |
| Error contract | Stable code/operation/identity, ResourceError with request/runtime/Bot identity and cleanup/report details where available | Migration. `SwarmEnvError` exists, while generic resource receipts and initialization cleanup reports are pending. #166, #172 |
| Service registration | v2 manifest with help, operations, schemas, side effects, idempotency and declared errors. Existing v1 bound/recovery and domain context checks move through explicit flat adaptation | Migration. `src/sdk/service-registry.ts` and `service-manifest.js` currently implement v1 domain roles/context. #169 |
| Service trust and adapters | Bridge reconstructs caller, enforces Profile permission before effects, passes only this Service binding, both adapter transports preserve caller | Pending generic caller. Existing ServicesBridge and Registry enforce domain-bound authorization. HTTP adapter currently serializes envelope/input/role. #169 |
| Service schema/retry | Execute input validation before invoke and output validation after invoke. Preserve operation_id on output failure after effects | Migration. Manifest schema declaration and existing domain checks require end-to-end v2 enforcement. #169 |
| Model identity/policy | Core checks generic identity/liveness/closing/model/request deadlines. Without modelAccessPolicy, it uses work phase and requires no Task. Optional synchronous authorize/withCommit adds domain permission and lease/deadline checks | Migration. `BotModelAccess` directly reads Mission/Bot/Execution and TaskService lifecycle writes. #166, #174 |
| Streaming model authority | Reserve/start in exactly one synchronous commit window, then await IO. Abort on stop/revoke or expired/changed lease/fence | Migration. ResponsesBudgetGateway has authorization, ledger, time bounds and revocation components to preserve. #174 |
| Bot Service | Profile operation and spawnProfiles checks, direct-child control scope, trusted parentId, no host policy/credential injection | Pending. Existing flat `bot exit` is a domain compatibility operation. #173 |
| Bot Service spawn receipt | Same child for request replay, preserve child identity on rejected/unknown initial input, child gets target Profile defaults | Pending. #173 |
| Runtime records | Redacted configuration, identities, input/request/event identities, Service result index, artifacts and cleanup reports | Migration. Existing observation/experiment recording is coupled to research runs. #172, #181 |
| Host/headless/CLI | Common public API for start, status/log/result reading, directed input and stop | Pending. Existing CLI and benchmark runner must be replaced by the new Environment host. #181–#183 |

spawn parentId must identify an idle/running Bot in the same Runtime. Parent stop leaves child shutdown policy to the Environment. Runtime.close covers every child and in-flight creation. Child events are routed before any initial input can execute.

A successful send acknowledges submission, while settled reports the current Session execution. Pi may consume several inputs before one settled event. Input IDs identify submissions and deduplication. Event sequence/cursor establishes execution observation. The router must account for fast completion before send resolves and uncertain acceptance without producing a new submission ID.

Known rejection covers invalid configuration, absent/foreign objects, permission failure, capacity/state/version conflict and same-ID parameter conflict. Dispatched operations with uncertain outcomes retain identity and report unknown/pending. Initialization failure remains owned by the factory until late resources and cleanup are tracked, even if createRuntime cannot return a usable Runtime.

## Migration order and regression obligations

The user requested the latest source be preserved on research and the refactored product remove superseded implementation and experiment code. The sequence below preserves behavior as an engineering reference while callers move to the new Core.

1. Record the public contracts and local regression evidence at the pinned baseline. Introduce generic Core identity, supported backend and no-Task lifecycle. Establish one owner per sandbox before connecting new callers.
2. Complete freezing, isolation, capacity, input/event replay, Service v2 and file preparation. Adapt existing execution mechanisms behind the Core boundary. Ordinary domain authorization stays explicit while old callers still execute.
3. Split stop execution from Worker/file-channel disposal and sandbox destruction. Implement required collection, bounded close and late-create reconciliation through that same owner.
4. Move flat identity/model authority, take/preparation/lease/fence, publication, continuation and feedback to its Environment. Preserve the observable domain rules through the new public interfaces.
5. Route agensh and the external Notes example through this Core. Verify actual cross-Bot result consumption and same-Bot continuation.
6. Replace the old runner/CLI, remove experiment/benchmark code and superseded tests and runtime entry points, and reconcile package assets, narrative and generated Architecture against the final tree. New tests follow target behavior and its public seams.

No migration step introduces a mode-name dispatch in Core or a placeholder Task for a generic Bot. New and transitional wrappers route resource operations to the same owner. Removal of old tests is paired with verification of the design's retained behavioral invariants.

| flat invariant | Existing public seam and source | Regression case to carry into the new Environment |
| --- | --- | --- |
| Read-only discovery | Bash task list/view, ServicesBridge and TaskService, `test/task-discovery-pages.test.js`, `test/orchestration-roles.test.js` | Mission-scoped bounded pages/cursors, continuation past blocked candidates, controller cannot take, empty queue creates no fabricated take |
| Atomic take and replay | Bash task take → TaskService transaction, `test/task-contract.test.js` | One exclusive Execution across CREATED/RUNNING/CLOSING, fingerprinted idempotent replay and conflicting simultaneous take |
| Preparation lease | Runtime bind/preparation and TaskService, `test/bot-runtime.test.js`, `test/bot-lifecycle.test.js` | Slow prepare heartbeat, expired lease rejection, refreshed fence before start_execution |
| Execution and grant | Bash take → fixed input → prepare → start_execution → grant → post-grant domain check | Stale/foreign identity rejected, immutable full input tree, stop racing late grant, resource receipt and domain fence checked separately |
| Workspace publication | Bash workspace save/merge/apply, `test/workspace-consistency.test.js`, `test/bot-runtime.test.js` | Binary/add/delete publication, immutable revision/CAS, exact request replay, unknown write acknowledgement retains original operation |
| Material publication | Bash material publish/search/view/consume, `test/context-service.test.js`, `test/material-content.test.js` | Immutable readable content, verified provenance, deduplication and actual consumer access |
| Continuation/replacement | Controller and identity task loop, `test/orchestration-roles.test.js`, `test/bot-runtime.test.js` | Quiet Mission accepts new work, handoff rearms, take conflict allows reselect, directed feedback reaches the correct identity, stop suppresses new work |
| Stop and ownership release | Runtime stop/shutdown, `test/runtime-cleanup.test.js` | Unknown execution retains ownership, cleanup failure retains capacity, retries bounded, release only after confirmed stop/destruction |

At the inspected baseline, `test/bot-runtime.test.js` uses an injected OpenSandbox fetch implementation and an EventEmitter Session. The local CLI/Git/SQLite paths are useful executable evidence, with explicit injected boundaries. Several tests import the existing benchmark runner and must move to target Environment test fixtures as experiment code is removed. These tests cannot establish real Pi/OpenSandbox integration for the new Core.

## Dependency and acceptance map

The table is the requirements-to-ticket cross-reference for review. GitHub Issues own the current dependency state and completion evidence.

| Issue | Behavioral handoff and required predecessors |
| --- | --- |
| #165 | Pinned contract, migration and regression baseline, no predecessor |
| #166 | No-Task real model/lifecycle path with Bridge initialized, after #165. Real custom Service invocation is verified by #169 |
| #167 | Independent resources, capacity and frozen configuration, after #166 |
| #168 | Continuous input, events and in-flight deduplication, after #166 |
| #169 | v2 manifest, trusted Bash caller/schema/adapter path, after #167 |
| #170 | FileSeed/prepare/grant resource authority, after #167 |
| #171 | Stop → export → destruction and bounded closure, after #170 |
| #172 | Input/Service/error/artifact/cleanup records, after #168, #169, #171 |
| #173 | Profile-restricted parent/child Bot Service, after #168, #169, #171 |
| #174 | flat identity and synchronous/streaming model policy, after #169 |
| #175 | flat discovery/take/fixed input/lease/fence/grant handoff, after #171, #174 |
| #176 | flat publish/finish/continuation/replacement/feedback, after #172, #175 |
| #177 | agensh single peer external identity/network/Git/Service path, after #168, #169, #171 |
| #178 | agensh serial router with followUp and fresh settled boundary, after #177 |
| #179 | agensh two-peer result adoption/common main, after #172, #178 |
| #180 | External tarball consumption and Notes writer/reader adoption, after #172 |
| #181 | Unified headless and CLI host, after #176, #179, #180 |
| #182 | Minimal terminal surface and decoupled React build/test, after #181 |
| #183 | Single resource lifecycle, obsolete entry removal and complete Architecture reconciliation, after #173, #182 |
| #184 | Frozen package artifacts and external install/docs recheck, after #183 |
| #185 | Joint Q8 real acceptance and owner's own task/use acceptance, after #184 |
| #186 | Conditional external trial and blocker fixes, after #185 |
| #187 | Name/license/version/release identity and candidate review, after #185 |
| #188 | Authorized publication and evidence-backed closeout, after #186, #187 |
| #189 | Later subagents dynamic delegation and parent adoption, after #173, #180 |
| #190 | Later scaleMAS persistent publication/search/citation, after #180 |
| #191 | Later lead-helper Board assignment/direction adoption, after #177, #180 |

The Core handoffs admit parallel implementation once their technical predecessors are satisfied. flat, agensh and Notes each require their own real evidence using the shared Core. Owner usage and external trial are human acceptance activities. Publication requires the actual package/identity/scope authorization recorded for that operation. Later modes retain their own verification and do not add a Q8 prerequisite.

## Verification records and deployment preconditions

Each Issue/PR verification record identifies the exact implementation commit and design revision, command/input, Profile and manifest, request/event identities, observed artifact contents, business outcome, execution and cleanup receipts. Record the actual model/image/deployment/configuration, iteration and time/output limits and the source authorizing any external resource use. Preserve the executed test summary and skipped/blocked checks. Raw logs, private state and credentials stay in ignored local experiments storage.

The inspected `c790fe1` catalog and model defaults are historical baseline facts. The owner subsequently selected Kimi K3 as the default for future Agent runs, with catalog/configuration integration and validation tracked in [Issue #192](https://github.com/LuNa-shi/SwarmEnv/issues/192) and [PR #193](https://github.com/LuNa-shi/SwarmEnv/pull/193). That later deployment selection does not change this pinned baseline or establish Kimi support in its catalog. New real-run evidence must identify the actual integrated model/catalog revision.

The supported deployment is Pi 1.3.0, corresponding to reference source `71023aec1546d6d677a65669c5665c0927ce0dd0`, inside the repository's OpenSandbox Agent image. It requires a working OpenSandbox local Docker lifecycle/execd deployment, the Worker and low-privilege Pi execution path, host control of the local sandbox network and disk isolation, and reachable Bridge/model gateway origins. Model aliases must match the image's catalog and the HTTP(S) `/v1/responses` path. Upstream credentials and Worker management tokens remain on the trusted side. Role images/resources and supported non-loopback IPv4 HTTP(S) allowlist origins must be checked before allocation.

Configuration is evidence-bearing. The current gateway's `timedPolicy` defaults in `src/agent/responses-budget-gateway.ts` are 120,000 ms per request and 32,768 output tokens. The current Runtime defaults include 120,000 ms watchdog, one-hour execution and 55-minute handoff reminder, while startBot defaults to 300,000 ms selection and 30,000 ms ready waits. Existing HTTP Service adapter defaults to 30,000 ms. Preparation heartbeats run every 10,000 ms against a 30,000 ms initial/renewed lease. IdentityTaskLoop also has an unbounded default handoffTimeout (`Infinity`), which must be replaced by the target’s bounded host-wait contract. These are old-code facts to inspect when migrating. The target's suggested 60,000 ms host wait is a bounded observation default for create/spawn/prepare/grant/send/stop/close, with positive finite configured limits and shorter underlying deadlines respected. Waiting expiry leaves dispatched work under resource ownership. Limits and budgets for actual acceptance come from its recorded configuration and authorization.

The current baseline verification uses deterministic local tests and documentation checks. Real Pi/OpenSandbox model execution, shared-Core agensh cooperation, external Notes adoption, required-export fault paths on the real backend and owner/external usage acceptance require their own later evidence. The T01 report on #165 records executed commands/results and explicit missing real checks.

For every implementation slice, run affected public behavior tests, full `npm test` where applicable, `npm run docs:generate`, `npm run docs:check` and `git diff --check`. Read generated changes and update the affected Architecture chapters, complete prompt composition/send paths and source-map inventory. Reports state which checks actually ran and where failures remain. Tests pass only for the boundaries they exercise.

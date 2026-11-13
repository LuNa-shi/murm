# 04. Services, tools and the full request path

This chapter describes what happens after an Agent calls a SwarmEnv tool. Read [10 Complete API reference](10-service-api-reference.md) for every advertised input/output schema and help text, and [11 Storage reference](11-storage-reference.md) for every durable field. Task state transitions are explained in [03 Mission and Task](03-mission-task.md); physical Session/Core/Workspace transitions are in [02 Execution](02-execution.md) and [05 Workspace](05-workspace-continuity.md).

## 1. Ownership and actual exposure

| Component | What it owns | What it does not imply |
|---|---|---|
| Service Catalog | Discovery operations and the built-in operation declarations | The full compatibility catalog is not the current Agent's authorization list. |
| Service Registry | Registered provider manifest, adapter, documentation, role-specific profile, version/hash and readiness cache | Registration does not create Task/Execution authority. |
| Services Bridge | Per-Agent authenticated endpoint, current Task/Execution/Core binding, capability selection and Runtime interception | A payload cannot choose a different owner or Core to obtain authority. |
| Task Service | Mission/Task/Execution durable facts, take/admission, Material links, feedback and completion decisions | It does not launch or physically stop Pi/Sandbox processes by itself. |
| Context Service | Immutable Material content, provenance, revision lineage, search and explicit consumption edges | A Material's text or `accepted` label is not a mathematical proof. |
| Judge Service | Direct Workspace-file submissions, source attestation, checker requests, preflight/health, independent checker process and persisted CheckResult | It does not complete a Task or Mission from a PASS. |
| Runtime capabilities | Workspace, Sandbox, progress/lifecycle interception and compatibility Execution view | Workspace is not a separately registered provider in the normal benchmark. |
| Mathlib Search | Optional registered declaration search over a configured source tree or upstream | Search results do not certify a Lean proof; source-index fallback is lexical. |

The built-in Registry currently registers **25 capabilities** across Catalog (3), Task (14), Context (6) and Judge (2). The flat benchmark adds six Runtime capabilities when Sandbox is absent, or eight when it is present. It excludes the Runtime compatibility `task_finish` and `task_finish(outcome=blocked)` aliases so those operations use the semantic Task Service contracts. Optional Services add their own capabilities. Both built-in `bound` and `recovery` profiles currently expose the same role audience.

Some compatibility remains visible: the Registry advertises `task_create_child`, but the Bridge rejects `create_child_task` for a bound Mission Task. Conversely, `execution_progress` exists in the catalog/SDK and Runtime implementation but is not selected into the normal Registry; the current Agent uses `execution_progress(kind="handoff")`. Read the exact exposure matrix in the API reference rather than inferring availability from a source function name.

Sources: [service catalog](../../src/sdk/service-catalog.js), [built-in Registry](../../src/sdk/builtin-registry.js), [capability profile](../../src/agent/capability-profile.js), [Runtime declarations](../../src/runtime/runtime-capabilities.js), [benchmark selection](../../src/benchmark/putnam-runner.js).

## 2. One tool call, from Pi to durable state

1. The Pi extension fetches the Bridge profile and registers `swarmenv_<tool_name>` with its description and input schema. A tool call carries the declared operation and capability/service identity to `POST /call`.
2. The Bridge validates its bearer token and a JSON object body, finds the capability in the **current** profile, and rejects ambiguous or unavailable operations. It refreshes cached profile data when the Registry revision changes. A Mission-bound call to a retired structural/lease operation is rejected even if an older catalog advertised it.
3. The Bridge checks the current binding and Task contract. Workspace/Sandbox operations require a Workspace-enabled Task. Task creation checks required capability IDs, including the implicit `mathlib_search` requirement for exact-declaration/verified-usage acceptance conditions. A capability already callable by this Session cannot be declared missing in a capability blocker.
4. The Bridge constructs the authoritative envelope from its actor, Task/Execution/Core state and current durable versions. For `task_take`, supplied `owner_ref`, `agent_prompt` and `initial_prompt` are discarded; the authenticated actor, lane and configured prompt are inserted. For a register-and-take switch, Runtime checkpoints first, Task Service commits the switch, Runtime detaches the old Execution, then Bridge binds the new one.
5. Ordinary registered operations go through Registry to the provider adapter. Lifecycle/Workspace/Sandbox operations are intercepted where physical Runtime work is needed. `execution_progress` directly calls Runtime; semantic block/handoff go through Runtime; semantic completion commits Task Service state and then releases Runtime resources.
6. Domain handlers validate the actual request, check versions/fences, and perform a transaction where required. A successful mutating domain call persists its replay result alongside the mutation. The returned object may contain a refreshed Task/Execution, Material, CheckResult or capability-specific result.
7. Bridge writes the result to HTTP and records `bridge.response_sent`. Its retained deferred-lifecycle hook runs staged work after that boundary, but the direct Judge submission path does not stage an automatic infrastructure block. Sending the response does not acknowledge that the model received or processed the feedback.

The Bridge serves `GET /health` without its bearer token, and requires the token for `GET /profile` and `POST /call`. The token is generated per Bridge and passed through process environment; it is not part of the prompt catalog. Bodies are limited to 2 MiB. Invocation failures return `{ok:false,error:{code,message,details,retryable}}`; the Bridge HTTP invocation error status is 400, while invalid authentication is 401. Other routes return 404.

**Declared schemas versus enforced checks.** Manifest construction validates schema shape and passes schemas to the model/tool interface. Registry and ServiceHost do not run a general JSON Schema input/output validator for each call. The Bridge checks that the payload is an object and applies operation-specific gates; each domain handler checks its own fields. Consequently, the documentation records both advertised schemas and handler behavior, including places where they differ. A closed advertised schema does not establish that every direct provider invocation is rejected for every extra field.

Sources: [Pi extension](../../src/agent/swarmenv-extension.mjs), [Bridge](../../src/agent/services-bridge.js), [Registry invocation](../../src/sdk/service-registry.js), [ServiceHost](../../src/sdk/service-host.js). Regression seams: [profile/Bridge tests](../../test/capability-profile-bridge.test.js), [Registry tests](../../test/service-registry.test.js), [hosted service](../../test/service-host-isolated.test.js).

### The envelope and replay contract

| Field | Current meaning |
|---|---|
| `operation_id` | Nonempty replay key. SDK generates a UUID unless supplied; Bridge defaults to `bridge:<operation>:<UUID>`. |
| `actor_ref` | Nonempty authenticated/caller identity; not taken from an Agent's desired Task owner. |
| `task_id`, `execution_id` | Optional for discovery/controller operations; required for bound work as enforced by the operation. |
| `spec_version` | Version of the Task contract authorized by this Execution. |
| `state_version` | Optimistic state version; execution-bound writes use the current Execution version. |
| `fencing_version` | Nonnegative authorization generation; execution writes require it. An old fence cannot publish current work. |

`operationPayload` uses stable key ordering over **operation + payload + complete envelope**. The same operation ID and identical fingerprint replays the stored result. Reusing it with a different payload or envelope is `CONFLICT`. A changed state version therefore changes the fingerprint; “same intent” is not enough to obtain a replay. Reads do not generally create an operation replay row. HTTP adapters pass `idempotency-key` but do not automatically retry, and the header itself does not implement idempotency. The ServiceHost relies on the envelope/domain handler and does not reconcile that header with the envelope.

### Error meanings at the caller boundary

| Error family | What happened | What follows from the result |
|---|---|---|
| `INVALID_CONTRACT`, `INVALID_TASK_CONTRACT` | Payload/Task contract cannot be accepted | Correct the request; no automatic success can be inferred. |
| `NOT_ALLOWED`, `SERVICE_CAPABILITY_NOT_ALLOWED` | Binding, role, profile or operation boundary rejects the call | Read the current profile/Task contract; inventing another tool name does not add authority. |
| `STALE_VERSION`, `FENCED` | Durable state or authorization changed | Re-read the current facts; the old Execution must not continue writing. |
| `CONFLICT`, `DUPLICATE_RESPONSIBILITY` | Replay identity or active responsibility conflicts | Inspect the existing result/Task and use its identity or choose valid independent work. |
| `BACKPRESSURE_*`, `FAIRNESS_REQUIRED` | Admission policy rejects new work | Existing work/state remains meaningful; creation is not evidence of acceptance. |
| `SERVICE_NOT_FOUND`, `SERVICE_CAPABILITY_NOT_FOUND` | Registry identity cannot be resolved | Inspect current discovery metadata. |
| `SERVICE_UNAVAILABLE`, `SERVICE_NOT_READY`, `SERVICE_TIMEOUT`, `SERVICE_VERSION_MISMATCH` | Provider deployment/readiness/version/transport failure | Use the returned retryability; these are not mathematical failures. |

The API reference reproduces the complete error-code object. Each handler can attach more specific `details`; an empty manifest `errors` array does not mean a built-in capability cannot fail.

Sources: [envelope](../../src/protocol/envelope.js), [errors](../../src/errors.js), [SDK](../../src/sdk/services-sdk.js), [Task](../../src/task/task-service.js), [Context](../../src/context/context-service.js).

## 3. Registry, manifests and hosted providers

A manifest declares a provider identity/version, contract version, endpoint, capabilities, role audience, read/write classification, idempotency declaration, required context, help text/ref, schemas, route and error metadata. Registration rejects duplicate IDs, duplicate capability names/operations/paths, malformed endpoint/routes, unsupported roles, and missing adapters. Untrusted registrations cannot take reserved IDs `runtime`, `workspace`, `execution`, `task`, `context`, `judge`, `catalog`. Trusted built-ins can deliberately retain open object schemas. Manifest contents determine a stable SHA-256 hash; documentation bundle hashes participate in that identity.

A Registry profile filters capabilities by `bound` or `recovery`, combines provider and Runtime capabilities, and adds provider/documentation identity. Profile construction removes internal/retired Agent operations, de-duplicates capability identities and deterministically disambiguates duplicate tool names. The `context` and `requires_binding` fields are distinct: Bridge normally enforces a nonempty context against its current binding, while Registry/Host additionally enforce `requires_binding=true` even for direct calls. Registry checks recognized `agent:bound`/`agent:recovery` actor-role consistency. This is not an external account/tenant authentication system.

There are two provider transports:

| Transport | Call and result |
|---|---|
| In-process | Adapter invokes a local handler with manifest, capability, input, envelope and role. ServicesSDK/ServicesRouter use synchronous local calls for control-plane transactions. |
| HTTP JSON | Registry verifies the remote manifest and readiness before the first not-yet-ready invocation, then adapter sends `{envelope,input,role}` to the declared capability route. `body.result` is returned, or the body itself if no result property exists. Default timeout is 30 seconds. |

Registry readiness is cached per entry (`ready`), not continuously re-probed on every successful request. A manifest probe checks both service ID and normalized manifest hash. `/healthz`, `/readyz`, `/v1/manifest` are GET endpoints served before capability-token authentication. Capability invocation accepts declared POST/PUT/PATCH methods, validates envelope/role/binding, then calls the handler. If configured, bearer token is required; `token=null` means no token check. The host defaults to loopback, while `scripts/service-host.mjs` defaults to `0.0.0.0`, port 8787. A `:0` endpoint is rewritten after binding an ephemeral port. There is no built-in TLS termination.

Host error mapping is 403 for capability permission, 404 for missing service/capability, 409 for conflict/stale/fenced, 504 for timeout, 503 for unavailable/not-ready, and 400 for invalid contract/manifest. A rejected bearer token returns 401 before invocation. Other errors use 500. Request bodies default to a 2 MiB limit, configurable through the programmatic `maxBodyBytes` option. The adapter separately recognizes 408/425/429/5xx as potentially retryable unless the returned error says otherwise. Abort and transport failures preserve their own diagnostic class.

The built-in hosting script has two compositions. In the default `SWARMENV_SERVICE_ISOLATED=false` compatibility mode it constructs Task, Context and Judge on the selected database even when exposing only one provider. `SWARMENV_SERVICE_DATABASE` controls that file; separate default service files do not coordinate state automatically. Catalog can use configured endpoint overrides in either mode. The HTTP readiness callback currently returns true and does not run Lean preflight.

`SWARMENV_SERVICE_ISOLATED=true` selects the Issue 119 deployment path in `scripts/service-host.mjs`. The process constructs only the selected domain service against its own database; isolated Catalog opens no domain database. Task uses `HttpDomainProxy` for Context calls when `SWARMENV_CONTEXT_SERVICE_URL` is configured, and Context uses it for Task lookups/events. Judge is constructed directly with its configured fixture and Lean checker, without a Task proxy. In both compositions its `workspace_check` handler processes the Bridge-supplied Workspace source and attestation directly; Task Service and the benchmark runner are not submission relays. The Task/Context proxy uses bounded argv-based `curl`, preserves the caller's operation envelope for replay/fence checks, and returns typed service errors. Missing dependencies are not replaced with an in-process service. The synchronous proxy exists because the current Task/Context domain handlers expose synchronous transaction-facing methods; it is a deployment seam, not a new business scheduler or database-sharing shortcut.

`services/builtin/compose.yaml` is the checked-in four-process deployment entry point. It builds the same image once for Task, Context, Judge and Catalog, gives the stateful services separate named volumes, wires their HTTP endpoint variables by service name, and publishes host ports 8781–8784 by default. Judge's HTTP lifecycle is available before checker input is mounted; candidate checking remains unavailable until the deployment supplies a pinned fixture project and toolchain through `SWARMENV_JUDGE_FIXTURE_MANIFEST`.

The built-in image enters through `scripts/service-host-entrypoint.sh`. It only runs `lake build --directory <project>` when `SWARMENV_JUDGE_PREBUILD=true`; the successful `SWARMENV_JUDGE_PREBUILD_KEY` is written to the Judge volume marker. A later process start with the same key skips compilation, while a changed key forces an explicit rebuild. Normal Task, Context, Judge and Catalog starts never trigger an implicit checker build.

The complete built-in host environment is:

| Variable | Default / behavior |
|---|---|
| `SWARMENV_SERVICE_ID` | Required: `task`, `context`, `judge` or `catalog`. |
| `SWARMENV_SERVICE_HOST`, `SWARMENV_SERVICE_PORT` | `0.0.0.0`, `8787`; the script validates integer port 1–65535, so its entry point does not accept ephemeral port 0. |
| `SWARMENV_SERVICE_ADVERTISE_HOST` | Bind host, except wildcard hosts use `127.0.0.1`. |
| `SWARMENV_SERVICE_PUBLIC_URL` | `http://<advertise host>:<port>`; becomes the advertised manifest endpoint. |
| `SWARMENV_SERVICE_DATABASE` | Resolved `./data/<service id>.sqlite`; parent directory is created. |
| `SWARMENV_SERVICE_TOKEN` | Null; optional capability bearer token. |
| `SWARMENV_JUDGE_WORK_ROOT` | Resolved `./data/<service id>-judge-work`. |
| `SWARMENV_LEAN_COMMAND` | `lake`; constructing the checker does not run a check. |
| `SWARMENV_{TASK,CONTEXT,JUDGE,CATALOG}_SERVICE_URL` and matching `_TOKEN` | Optional endpoint/token overrides used by the host's Catalog Registry. |
| `SWARMENV_CATALOG_MANIFESTS` | Optional JSON array of extra manifests; registered with a placeholder adapter for metadata discovery, not an implementation of those remote operations. |

Both host scripts print their service identity, endpoint and manifest hash at startup; the built-in script also prints its database path. SIGINT/SIGTERM stops HTTP and closes owned database handles. The built-in Dockerfile uses Node 22, installs production dependencies with lifecycle scripts disabled, exposes 8787, selects `task` by default, and sets its database to `/var/lib/swarmenv/service.sqlite` on the declared volume. It does not install Lean or configure the full multi-provider deployment.

Sources: [manifest](../../src/sdk/service-manifest.js), [Registry](../../src/sdk/service-registry.js), [adapters](../../src/sdk/service-adapter.js), [host](../../src/sdk/service-host.js), [hosting script](../../scripts/service-host.mjs), [builtin container](../../services/builtin/Dockerfile).

### Documentation bundles

`loadServiceBundle` reads `service.json`, required root `SKILL.md`, and explicit references or up to 32 top-level Markdown reference files. Each document is nonempty, at most 256 KiB, and resolved within the bundle directory; traversal, arbitrary URLs and symlinks escaping the bundle are rejected. Explicit references exceeding 32 are rejected; implicit directory enumeration takes the first 32 sorted Markdown files. Inline manifest help text is capped at 32 KiB. Credentials belong to `secret_refs` values of the form `env:NAME`; the bundle loader rejects credential-bearing manifest fields.

The bundle records each document's content/hash/byte size and binds the metadata into the manifest. `service://<id>/<resource>` resolves only Registry-owned resources. This is reviewed documentation available for prompt composition, not a fetch-any-URL tool. The normal initial benchmark turn does not necessarily send the full composed documentation block; the exact send paths are in [08 Prompts](08-prompts.md).

Sources: [bundle loader](../../src/sdk/service-bundle.js), [bundle tests](../../test/service-bundle.test.js), [Mathlib bundle](../../services/mathlib-search/service.json).

### 3.1 Bash CLI boundary (Issue 119)

scripts/swarm.mjs is the non-interactive Bash entry point and delegates parsing/invocation to src/cli/swarm-cli.js. swarm --help, swarm service --help, and each domain's --help are offline and explain endpoint variables, JSON/file/stdin input, actor identity and command families. swarm service list reads the configured service manifests; service view reads one manifest. Task, Context and Judge commands resolve an advertised capability by operation (with documented short aliases), compose a typed operation envelope, send a JSON envelope/input/role request to the HTTP route and print one JSON result on stdout. Command-level help describes required flags and input/output shape. Requests have a bounded timeout (default 30 seconds, maximum 10 minutes). Diagnostics and structured failures go to stderr; invalid usage exits 2, HTTP/provider failures or timeouts exit 1, and a successful Judge request whose business verdict is FAIL/source_failure/mathematical_failure/incorrect exits 3 while still printing the authoritative result.

The CLI is a client of an already hosted service. It does not construct a domain service, open a service database, or keep long-running work in the Agent sandbox. SWARMENV_<SERVICE>_SERVICE_URL and the optional bearer token identify the endpoint; SWARMENV_SERVICE_ENDPOINTS can supply a JSON discovery list for service list. The CLI's request ID is an idempotency key only when the receiving Service honors the envelope operation identity; the CLI does not retry a write after a lost response.

## 4. Context: publishing, finding and using Materials

### Publication and identity

The public semantic operation `context_publish_material` accepts role `response`, `handoff` or `experience`, content, and optional kind/scope/evidence state/summary/receiver/supersedes. The handler normalizes omitted kind to `fact`, `failure` or `experience` respectively, scope to `mission`, and evidence state to `proposed`. The older `context_publish` contract requires kind and scope explicitly. Underlying storage also supports role `input`; the semantic publication schema deliberately advertises a smaller set.

Context validates the bound Execution's Task/spec/state/fence when attached to Task Service, rejects payload producer IDs different from the envelope, and derives Mission ID from the current Task. A supplied Mission ID cannot disagree. It recursively rejects object field names matching secret/password/token/API-key/credential/private-key patterns. That check is based on keys and is not a semantic detector for every possible secret embedded in arbitrary prose.

Content is hashed using stable JSON serialization. A new Material gets an ID, `content_ref` (by default `sqlite://material/<id>`), content hash, version 1, immutable source Task/Execution, provenance and timestamp. `supersedes` must name an existing Material and makes the new record's version one greater than its predecessor; the earlier content remains intact. Reusing a Material ID for different content/kind/role/Mission/scope/supersedes fails. Allowed evidence states are `proposed`, `observed`, `checked`, `accepted`, `rejected` and `stale`. `checked` and `accepted` from untrusted actors are downgraded to `proposed`; `judge:` and `system:` actors are trusted by default. This trust rule is local caller identity handling, not a cryptographic proof attestation.

The returned `{material}` contains stored columns plus parsed `content` and `provenance`, role fallback for older rows, and producer aliases. Exact columns are in the storage reference. After a successful non-replayed publication call, Context notifies Task Service of a dependency event. This also occurs if a different operation ID reuses an already-existing identical Material; replaying the stored operation does not re-notify. Task linking and receiver notification are additional Task/Bridge behavior, not automatic consequences of every arbitrary Context write.

### Search/read behavior and limitations

`context_get_material` returns `{material: <record or null>}`. Search/read returns an array of Material records, ordered by `created_at, material_id`. Filters include Material ID, kind, scope, producer Task/Execution, role, Mission and query. Query matches SQLite `LIKE` against `content_json` or `provenance_json`; there is no dedicated full-text/vector index or separate summary column. With Task Service attached, `task_id` includes both Materials produced by that Task and Materials linked to it; explicit `source_task` stays producer-only. A standalone Context Service uses `task_id` as producer lookup.

These read filters are optional. Context does not automatically add the caller's Mission filter or perform per-Material ownership checks; an unfiltered read scans all Materials in that provider's database. Judge result lookup similarly selects the supplied result ID. Bridge binding authorizes the capability call, not a separate row-level tenant boundary. The normal benchmark isolates projects in separate databases.

The public search schema advertises `limit` from 1 to 100, but the current `#readMaterials` implementation does not apply that limit. Callers therefore cannot rely on this parameter to bound a large result. Also, semantic `summary` is accepted by the catalog but is not stored as a top-level Material column; useful summary text should be present in content/provenance where the producing call actually records it. These are as-built boundaries, not guarantees of a richer search engine.

### Consumption is an explicit edge

`context_consume` requires 1–100 unique existing Material IDs and action `route`, `task`, `workspace_source` or `integration`; optional `action_ref` must be a nonempty string or null. It requires a bound Task/Execution and validates the fence. It persists reader Task/Execution, action, action reference and timestamp keyed by `(operation_id, material_id)`, returning `consumptions`, `material_ids`, `action`, `action_ref`.

Publishing `scope="root_integration"` requires 1–100 unique `provenance.consumed_material_ids` already recorded as `integration` consumption by that same Task/Execution. This supplies an explicit provenance check. It still does not establish that the mathematical argument correctly integrates the cited Materials. A search/read result alone never creates a consumption edge.

Sources: [Context](../../src/context/context-service.js), [Context schema](../../src/storage/context-schema.js), [Context tests](../../test/context-service.test.js).

## 5. Judge: current submission, preflight, checks and application

### The as-built submission route

The Agent-facing operation is `swarmenv_judge_submit_candidate`. The advertised input requires a relative Workspace path; Workspace revision and expected content hash are optional stale-input guards. The Services Bridge reads that file through the Runtime Workspace boundary, checks any supplied guards, constructs a source attestation bound to the authenticated Task/Execution and path/revision/hash, and sends the direct request through the Registry to **Judge Service**. Judge checks the attestation against the authenticated envelope and source, uses its provider-configured fixture for checker/input binding, performs preflight and checking, persists the CheckResult, and returns the bounded Agent projection. The Workspace read uses live file bytes, not a historical revision export; [05](05-workspace-continuity.md#direct-judge-reads-of-a-workspace-file) explains that boundary and its existing file-index limits.

The direct path is the same logical contract for in-process and hosted providers: `Bridge → Registry → Judge → Workspace source → checker → CheckResult`. The transport operation ID is the default request key. Replaying it with a changed path, revision, or content hash returns `CONFLICT`; an identical replay returns the persisted result without rerunning the checker. Workspace/path/revision failures and checker infrastructure failures remain distinct from source-level FAIL.

Task Service and Benchmark Runner are not submission handlers. A PASS does not automatically complete a Task or Mission. An Agent may explicitly call `task_finish` with the returned CheckResult when the Task completion contract is satisfied; that projection is a separate operation. Workspace artifact Material remains available for collaboration and provenance, but it is not required for a direct Workspace check. A source-level FAIL can lead to revision and resubmission within the same Task/Execution.

The Bridge exposes one canonical Workspace source route. It reads the declared relative path through the Runtime Workspace boundary, attaches the authenticated Task/Execution and revision/hash attestation, and sends that request to Judge. Inline source bodies and Material-based candidate aliases are not accepted.

### Request identity and duplicate checking

On the advertised Workspace path, a request binds the authenticated Task/Execution, Workspace-relative path, Workspace revision, content hash, target Task/spec version, input snapshot hash, checker ref/version, environment and fixture. Judge checks the supplied source attestation, validates content/hash consistency and derives Task/spec from the envelope; checker/environment identity comes from its configured fixture. The transport operation ID is the default request key; callers may supply an explicit request key when they need a stable retry identity.

The same request key with different request hash fails. An existing matching request returns the existing result without rerunning. Judge additionally queries for equivalent Workspace source **content hash + target Task/spec + input snapshot + checker version/environment** across request keys, preventing another Core from buying another check merely by inventing a key. Retryable, unexhausted infrastructure failures permit a new request to recheck; source results and exhausted failures normally reuse existing evidence. The current query selects the earliest matching row, which is a concrete implementation choice rather than a universal deduplication service.

The Bridge/Registry calls Judge's `submitCandidate` with the source descriptor, attestation and authenticated envelope. Judge derives fixture/checker settings from its own configuration and constructs the following internal `workspaceCheckRequest` request. Its legacy-named `workspace_source_id` is a synthetic `workspace:<execution>:<path-or-source>:<hash>` identity for direct submissions; it does not require a Context Material to exist.

| Field | Handler validation/default |
|---|---|
| `workspace_source_id`, `target_task_id`, `input_snapshot_hash` | Required nonempty strings. Direct submissions derive them from the source, authenticated envelope and configured input binding. |
| `target_spec_version` | Required nonnegative integer. |
| `checker_ref`, `checker_version`, `environment_ref` | Required nonempty strings equal to the corresponding locked fixture values. |
| `fixture_manifest` | Required validated fixture object; required fields and actual environment probing are described below. |
| `workspace_source` | Required object with string `content`; optional `material_id` must match `workspace_source_id`, and optional `content_hash` must match the SHA-256 recomputed from that content. |
| `target_task` | Optional object; when present its ID and spec version must match. Defaults to null. |
| `workspace` | Optional object; if it supplies `input_snapshot_hash`, that value must match. Defaults to null. |
| `request_key` | Optional nonempty string. `submitCandidate` defaults it to the transport operation ID; a direct internal `workspaceCheckRequest` call without a key derives one from workspace source/Task/checker/input identity. Reusing a key with a different normalized request is `CONFLICT`. |
| `execution_id`, `state_version` | Optional binding metadata, default null; result application performs the stronger current-Execution checks. |
| Method options | `operationId` defaults to a UUID; `actorRef` defaults to `judge:lean`. |

`preflightChecker` uses the same request validation with an empty candidate-content fallback, then persists checker health without compiling a candidate. `getCheckResult`/`getByRequestKey` return the full stored projection; `getAgentCheckResult` returns the restricted Agent projection; preflight lookup/list returns parsed evidence and boolean retryability.

Internally, `workspaceCheckRequest` finishes through `dispatch('submit_check_result', ...)`. This operation is absent from the model's Registry and the generic router fallback. It accepts the validated request plus `status:'RECEIVED'`, a verdict, normalized outcome/diagnostic/evidence fields and optional supplied CheckResult ID/request hash. It checks the envelope's Task/spec against the request and uses operation replay inside a transaction. A matching RUNNING/REQUESTED row becomes RECEIVED; an already finalized matching row is returned. A direct local caller can record a received result without launching Lean through this method, so this internal entry point assumes its caller is trusted; it is not an independent checker attestation mechanism.

### Locked checker preflight

A fixture requires `fixture_id`, full PutnamBench commit, problem file/hash, Lean toolchain, Mathlib version, checker ref/version and environment ref. For a healthy Lean preflight, `project_root` must exist, the problem file must match the locked hash, and `lake env lean --version` must run in that project. It extracts a numeric version and compares it to the declared toolchain; it also verifies this adapter's checker ref/version. The manifest's Mathlib version and repository commit are recorded provenance; this function does not independently checkout or hash the entire Mathlib tree.

Missing project/input, mismatched input hash, missing executable, failed toolchain probe, version mismatch or absent checker preflight support produces `infrastructure_failure`, not source FAIL. Preflight state is persisted by checker/environment/project identity and a health fingerprint. Repeated unchanged unavailability increments its attempt count; the default `maxInfrastructureRetries=2` makes a third repeated failure exhausted. A completed PASS/source failure marks checker health good and resets the accumulated failure count. Health-change events are advisory notifications; the persisted row remains authoritative.

### Workspace artifact execution and outcome

LeanChecker writes a separate `Workspace artifact.lean` under its work root and invokes `lake env lean <candidatePath>` with the locked project as cwd. Defaults are a 120-second timeout and a returned-output cap of 1,000,000 bytes per stdout/stderr. The helper collects process streams and truncates when forming the result; the cap is not a streaming memory limit. Timeout kills the child. With a raw logger, candidate work directories are retained for local diagnosis; without one, the temporary directory is removed in `finally`.

The checker rejects a word-boundary `sorry` before compiling when `rejectSorry=true`. The benchmark separately flags case-insensitive `sorry`, `admit` or `axiom` and invalidates the project report. These checks are not equivalent: a no-process request rejection is not a compiler source diagnostic.

| Result class | Typical process/verdict | Meaning |
|---|---|---|
| `PASS` | Completed compiler, exit 0, verdict PASS | This candidate source compiled in the selected checker environment. |
| `source_failure` | Completed compiler, nonzero exit, verdict FAIL | Source-level diagnostic is available for repair. |
| `infrastructure_failure` | Not started/timeout/crash or failed preflight, usually ERROR | No accepted mathematical result; retry/health/block handling applies. |
| `request_failure` | Forbidden placeholder, process not started | The request was rejected; not a successful proof or normal compiler failure. |
| `unassessed` | Inconclusive/otherwise insufficient evidence | No source-level conclusion. |

`status` (`REQUESTED`, `RUNNING`, `RECEIVED`, `APPLIED`, `IGNORED`, `SUPERSEDED`) is separate from verdict, checker process status and result class. The current request path inserts RUNNING before checking and later persists RECEIVED; Task Service handles application/fencing and related status. Do not infer a successful check merely from a successful service request or an APPLIED lifecycle status.

### Feedback, blocking and completion limits

The Agent projection includes IDs, status/verdict, checker identity, process/result class, mathematical outcome, retryability, diagnostic code, a redacted diagnostic excerpt capped at 4096 characters, extracted file/line/column, process evidence, preflight verification flags and retry counts. It omits arbitrary evidence keys, candidate hashes and raw stdout/stderr. Canonical local evidence keeps fuller bounded process diagnostics; reports use their own sanitized projection.

Its exact field names are:

| Group | Fields |
|---|---|
| Identity | `check_result_id`, `request_key`, `workspace_source_id`, `target_task_id`, `execution_id` |
| Lifecycle/outcome | `status`, `verdict`, `judge_operation_status`, `checker_process_status`, `checker_started`, `result_class`, `mathematical_outcome`, `retryable` |
| Checker | `checker_ref`, `checker_version`, `environment_ref` |
| Diagnostics | `diagnostic_code`, `diagnostic_excerpt`, `diagnostic_location` (parsed file/line/column or null), `process_evidence` (`exit_code`, `signal`, `timed_out`, `error_code`) |
| Preflight | `preflight_key`, `preflight_status`, `preflight_verified`, `input_binding_verified`, `toolchain_version_verified`, `checker_ref_verified`, `checker_version_verified`, `checker_identity_verified`, `health_fingerprint` |
| Retry accounting | `infrastructure_attempt_count`, `retry_exhausted` |

An absent CheckResult returns null. Missing optional identities/diagnostics/verification values generally project null; process booleans and retry exhaustion are normalized booleans. The projection derives missing legacy outcome/process fields from verdict/result evidence, so a historical row can display normalized fields that were not originally populated.

Direct Judge submission returns infrastructure/source diagnostics without applying the result to Task state or staging a Runtime block. The runner's submission observer records the check, source path, event and work unit. Retryable, unexhausted infrastructure results permit a later check; source FAIL is diagnostic feedback and the same Execution can continue. The retained Task Service `apply_check_result` path can still create a typed `CHECK_RESULT`/checker-health dependency or complete a `required_check` Task when explicitly invoked with the required stored result/candidate binding. Bridge also retains a deferred-block hook, but direct submission does not populate it. Shared-Mission release semantics and ordinary Task blocking are described in [03](03-mission-task.md).

There are two important limits to the acceptance meaning. First, LeanChecker compiles the candidate file and checks the locked input/environment binding, but this code does not compare the candidate's theorem statement or AST with the original Mission goal. Second, the retained `apply_check_result` completion path does not universally apply the additional `#missionCompletion` gate used by explicit `task_finish`. The direct submission observer no longer runs the old PASS-to-`solvedAt` completion callback; recording a direct CheckResult alone does not update the runner's solved state. These facts must remain visible when judging whether a run actually solved its original mathematical objective.

Sources: [Judge](../../src/judge/judge-service.js), [Lean adapter](../../src/judge/lean-adapter.js), [fixture](../../src/judge/fixture.js), [result normalization/projection](../../src/judge/check-result.js), [direct Bridge submission](../../src/agent/services-bridge.js), [Task result application](../../src/task/task-service.js). Tests: [Judge tests](../../test/judge.test.js), [direct submission](../../test/judge-direct-submit.test.js).

## 6. Optional Mathlib Search

The Service requires an upstream URL, source root, or both. Defaults are 8-second search timeout, 20 returned results, maximum 50, query length 2000, module length 200 and path length 1000. It normalizes the query, validates module/path against the configured source/project boundary, then tries a Loogle-compatible `/json?q=...` endpoint. Module/path filtering and result limits are applied locally after response normalization, because those limits are not assumed to be upstream query parameters.

If upstream fails and a source root exists, the Service builds a cached index by scanning Lean files and recognizing top-level declaration lines, token-scores name/type/module text, and returns the highest matches. This is a lexical fallback; it does not typecheck a Loogle expression or certify the theorem's usefulness. Results identify backend, source scope, revision/toolchain metadata if supplied, duration, truncation, and optional fallback/error code. The current implementation emits duration/fallback fields beyond the bundle's declared closed output schema; see the API reference.

Readiness probes upstream with a small query (up to 3 seconds), or accepts an available source directory as fallback. The capability has `requires_binding=true`, enforced by Registry and HTTP host, so unbound preclaim research is not authorized merely because search is classified read-only. Benchmark startup registers the source-backed Service only when the appropriate Mathlib source tree is available; missing capability makes dependent Task admission fail explicitly.

The standalone Mathlib host's complete environment is:

| Variable | Default / behavior |
|---|---|
| `MATHLIB_SEARCH_HOST`, `MATHLIB_SEARCH_PORT` | `0.0.0.0`, `8787`; integer port 1–65535. |
| `MATHLIB_SEARCH_ADVERTISE_HOST` | Bind host, or `127.0.0.1` for a wildcard bind. |
| `MATHLIB_SEARCH_PUBLIC_URL` | `http://<advertise host>:<port>`. |
| `MATHLIB_SEARCH_UPSTREAM_URL` | Null; optional Loogle-compatible upstream. |
| `MATHLIB_SEARCH_SOURCE_ROOT` | Null; optional mounted Lean-source tree. At least one upstream/source option is required. |
| `MATHLIB_SEARCH_PROJECT_ROOT` | Null; constructor-level fallback boundary for module/path validation when no source root is configured. |
| `MATHLIB_SEARCH_TIMEOUT_MS` | `8000`, must be positive and finite. |
| `MATHLIB_SEARCH_TOKEN` | Null; optional bearer token. |
| `MATHLIB_REVISION`, `LEAN_VERSION` | Null; provenance metadata passed to the provider. |

The Mathlib image similarly uses Node 22 and exposes port 8787. It copies the source implementation/launcher but does not ship a Mathlib checkout. A caller must supply the upstream or mounted tree. Programmatic provider options additionally include project/module-boundary settings, fetch injection and result limits; their input behavior remains subject to the validation described above.

Sources: [Mathlib Service](../../src/services/mathlib-search-service.js), [hosting entry](../../scripts/mathlib-search-service.mjs), [bundle](../../services/mathlib-search/service.json), [Mathlib tests](../../test/mathlib-search-service.test.js).

## 7. Internal SDK/router and compatibility boundary

ServicesSDK supplies typed convenience methods and authoritative envelopes for local owners/controllers and Agent-compatible calls. It includes discovery, Mission/Task creation/read/link/complete/close/handoff/block, Material publish/read/consume, Judge lookup/submission/application, take/take/progress/feedback, and retained structural/lease/lifecycle methods. Its class surface does not make every method a model tool. It has no Workspace manager implementation.

ServicesRouter first resolves a unique registered capability by name/operation; ambiguous routes fail. Registered `workspace_check` resolves to Judge. Its synchronous path refuses HTTP adapters and asynchronous return values rather than leaking a Promise into a local SQLite control-plane operation; the direct Agent check uses asynchronous Registry invocation. `dispatchAsync` also invokes the Registry asynchronously. If no registered capability matches, fallback retains legacy/internal Task/Execution operations, including the old Task `workspace_check` registration, and routes Material operations/aliases to Context and `get_check_result` to Judge. That Task fallback stores a candidate binding; it does not execute the direct checker. Task completion remains a separate Task Service operation.

`LocalServiceDouble` is a deterministic in-memory test seam with Maps and simplified accepted-operation responses. It has no full SQLite lifecycle, real checker, Workspace, Runtime or multi-process semantics, so success against it cannot establish real-Agent acceptance. Fixture/e2e scripts exercise different retained routes; their coverage is classified separately in the [source inventory](INDEX.md).

Sources: [SDK](../../src/sdk/services-sdk.js), [router](../../src/sdk/service-router.js), [local test double](../../src/sdk/local-service-double.js), [SDK tests](../../test/services-sdk.test.js), [service-catalog tests](../../test/service-catalog.test.js).

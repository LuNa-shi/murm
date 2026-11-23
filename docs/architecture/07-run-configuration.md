# 07. Launch, configuration, the outer loop and finalization

This chapter describes how the repository actually composes a run. It covers the benchmark CLI and exported runner, the smaller fixture paths, optional service deployments and the UI build. Domain state transitions remain in [02](02-execution.md) and [03](03-mission-task.md); full prompt and tool bodies are in [08](08-prompts.md) and [10](10-service-api-reference.md).

## 1. Entry points and execution modes

| Entry | What it executes |
|---|---|
| `scripts/run-putnambench-benchmark.mjs` | Real benchmark launcher: validates locked input, creates run metadata and an opt-in observer, invokes one project or a bounded batch, writes aggregate output |
| `runBenchmarkProject(problem, config, options)` | Four Core lanes for one problem; non-timed tests can inject controlled checkers and provider endpoints |
| `runBenchmarkBatch(problems, config, options)` | Worker pool across isolated projects; each project still has four lanes; a project error becomes a sanitized fallback report |
| `scripts/service-host.mjs` | Separately hosted built-in Task, Context, Judge or Catalog provider |
| `scripts/mathlib-search-service.mjs` | Optional HTTP Mathlib Search provider |
| `scripts/serve-observability.mjs` | Persistent observation/dashboard server, including report import and multi-root discovery |
| `src/index.js` | Public JavaScript exports, including generic Runtime/SDK and compatibility fixture APIs |

These entry points have different contracts. Deterministic in-process tests use injected adapters and checkers; they do not implement the benchmark's no-solution-input protocol or establish autonomous research ability.

A programmatic project call must supply at least one of `experimentDir` or `reportDir`: the implementation resolves `experimentDir ?? reportDir` as its experiment root, then uses `reportDir ?? <experiment root>/reports` for reports. Unlike the CLI, a bare library call does not invent a timestamped output directory. The caller must also pass the prepared problem/configuration expected by the runner; for a positive-duration run, `runBenchmarkProject` independently checks the selected fixture against the configured checkout root and full pinned commit before creating provider resources.

## 2. Benchmark CLI: every flag and its actual default

Value-taking arguments accept `--name value` or `--name=value`; `--help`/`-h` is the no-value help flag. The removed `--normal-flow` flag is rejected. The launcher first loads `.env` from the working directory, ignoring blank/comment lines and preserving existing environment values. Values are simple trimmed strings with surrounding quotes removed; this is not a general shell/dotenv interpreter.

| Flag | Default / behavior |
|---|---|
| `--problems` | Required JSON configuration path |
| `--putnambench-root` | Required locked PutnamBench checkout |
| `--problem` | Absent: run all configured problems; otherwise select one matching ID after validating the full configuration |
| `--cores` | `4`; CLI rejects any other value |
| `--project-parallelism` | `1`; positive integer; batch concurrency is capped at the problem count |
| `--timebox-ms` | `3600000`; positive research window per project, starting after preflight |
| `--bot-max-ms` | Defaults to run timebox; timer-safe integer of at least 2 ms; total Bot lifetime including startup/discovery/preparation |
| `--selection-timeout-ms` | Defaults to min(300000, Bot maximum); timer-safe integer of at least 2 ms, clamped to Bot/run deadline |
| `--execution-timeout-ms` | Defaults to Bot maximum; timer-safe integer of at least 2 ms; active Execution cap intersects Task/Bot/run limits |
| `--turn-timeout-ms` | `540000`; per-turn settling bound, separate from the overall project deadline |
| `--checker-timeout-ms` | `120000`; timer-safe positive integer for each Lean source diagnostic process, subject to the locked checker timeout |
| `--task-model` | Rejected; the benchmark has one Mission Task contract |
| `--normal-flow` | Rejected; the Mission Task contract is always used |
| `--parallel-mode` | Rejected; the former selector has been removed |
| `--initial-bot-stagger-ms` | `60000` for the CLI; delays first Bot starts by Core index, bounded by the Mission deadline. Replacement Bots start immediately. |
| `--provider` | `PI_PROVIDER`, otherwise `kimi_proxy`; empty values are rejected |
| `--model` | `PI_MODEL`, otherwise `k3`; empty values are rejected |
| `--observability` | Absent by default: no observer server startup or metadata health probe. Supply this flag to enable the existing persistent observer flow; host/port/metadata options alone do not enable it. Project-local evidence still records. |
| `--experiment-root` | `experiments` |
| `--experiment-dir` | `experiments/putnambench-runs/run-<startup timestamp>`; resolved path must be absent and strictly below experiment root |
| `--report-dir` | `reports/putnambench-runs/run-<startup timestamp>` |
| `--observability-host` | `127.0.0.1` when the benchmark launches its observer |
| `--observability-port` | `8787` |
| `--observability-advertise-host` | Null by default; only an explicit value overrides the advertised host |
| `--observability-metadata` | `SWARMENV_OBSERVABILITY_METADATA`, otherwise look under the experiment root |
| `--help`, `-h` | Print usage and exit before requiring benchmark arguments |

Unknown options throw. Numeric flags are converted with `Number`; only the explicit validations above and downstream constructors apply. The CLI has no Sandbox flags: it builds its required OpenSandbox configuration from `SWARMENV_SANDBOX_ENABLED` (the literal string `true` enables it), `SWARMENV_SANDBOX_PROVIDER` (default `opensandbox`), `SWARMENV_SANDBOX_IMAGE`, `SWARMENV_OPENSANDBOX_URL`, optional endpoint/Bridge host variables and the selected provider settings. A disabled or non-OpenSandbox deployment is rejected. General Runtime supports custom adapters; the current benchmark runner constructs its OpenSandbox adapter directly. Only explicitly forwarded Runtime timers are runner options. Normal trusted Mission acceptance initiates closeout; the retained `stopOnSolved` option does not disable this behavior.

The exported runner and CLI both construct the Mission Task contract with four independent Core loops per project. The old parallel-mode selector is retired and an explicit request for it fails. `projectParallelism` controls how many separate projects run at the same time. Reports record the actual settings and observed Core/Execution overlap.

The OpenAI Math fixture uses the same runner path. Its twelve configured challenge files, their Comparator metadata, and the selected reference proof modules are checked into `benchmarks/openai-math-12/`. The Lean project root is the configured `lean_project_subdir`, so the repository root remains the fixture identity while Lean resolves imports from `benchmarks/openai-math-12/lean`. The additional `PlaneColoring` entry is a smoke-only problem in the same embedded project.

## 3. Locked input and environment

`loadBenchmarkConfig` requires exactly twelve problem entries, checks duplicate IDs and safe ID spelling, reads each source file, rejects paths escaping the checkout and input filenames containing `solution` or `candidate`, and requires an unsolved `sorry` marker. The CLI requires HEAD to match the full `putnambench_commit` at the repository root. Each source must be a regular file at its configured path without symlink substitution, and its worktree bytes must equal the regular-file Git blob from that commit. Source SHA-256 covers the exact bytes, including BOM and trailing newlines. The timed runner repeats this verification for the selected problem and rejects source, hash, or path arguments that differ from the verified fixture. It chooses the configured `lean_project_subdir` when present, otherwise the checkout's `lean4/` project if its `lean-toolchain` exists, otherwise the checkout root. The embedded OpenAI Math configuration pins the fixture to a committed repository descendant so later code-only commits can update the runner without changing the benchmark source bytes. These checks apply before selecting a single pilot problem.

The retained library helper `selectOpenAiMathContext(config, selected, mode)` accepts `none` or `paper`. In `none` mode it returns the supplied configuration and selected problems. In `paper` mode each selected problem must have a pinned paper manifest. The helper resolves the package under the embedded fixture root, verifies the SHA-256 of the manifest and each file, and requires exactly `benchmark/paper.pdf` and `benchmark/paper.txt`. An unknown mode, unsupported problem, digest mismatch or invalid file rejects the call. The returned configuration and enriched problems supply the inputs for ordinary Workspace creation, which rechecks the pinned bytes and materializes the initial revision. The manifest identifies the upstream PDF and public text. The host-side paper-progress rubric remains evaluator material.

The OpenAI Math selection record in `benchmarks/openai-math-12/SELECTION.md` documents the twelve mathematical areas, source and dependency closure measurements, theorem-hole counts, and fixed Lean/Mathlib revisions. `reference-solutions.json` records the local solution module and target theorem for each selected problem. The reference sources are audit inputs only. They are not supplied to the Bot through the public Workspace.

The checked-in [configuration](../../config/putnambench-12.json) pins:

| Field | Value at this baseline |
|---|---|
| PutnamBench commit | `a635813f5edf297d928f9bd5ef8324a26bdde09c` |
| Lean toolchain | `leanprover/lean4:v4.33.1` |
| Mathlib revision | `0df444a360eaa60ab8c11dca51a86af692955474` |
| Checker | `lean`, version `mvp-1` |
| Environment reference | `putnambench-lean4@a635813f5edf297d928f9bd5ef8324a26bdde09c` |
| Problems | 2025 B1/B4; 2024 B4/B5; 2023 B1/B4; 2022 B5/B6; 2021 B3/B5; 2020 B4; 2019 B6 |

These values identify this configuration; they are not proof that the local checker has already passed preflight. Judge performs its own environment checks. The input formalization is allowed to contain an unsolved marker; a submitted Workspace artifact is a separate file/material and is checked against the Workspace artifact policy.

The benchmark CLI defaults to Kimi K3 through direct Pi, using the proxy IDs `kimi_proxy` and `k3`. The PutnamBench CLI resolves each setting from its flag, then the process environment or `.env`, then the default. It resolves the selected provider's host endpoint and credential from `PI_KIMI_PROXY_BASE_URL` and `PI_KIMI_PROXY_API_KEY` for Kimi, or the equivalent variables for another provider. For either missing value, it reads the selected provider from `models.json` in `PI_CODING_AGENT_DIR` or the default Pi agent directory. The launcher uses that provider entry's headers when present.

The retained benchmark CLI appends `/responses` to the selected upstream base URL on the host. Direct library calls supply an explicit provider/model pair and `modelUpstream` endpoint and headers. [Agent Core](01-agent-core.md) gives the full argv and RPC behavior.

## 4. Startup in execution order

1. **Record the launch.** Resolve the experiment root and directory and reject an existing directory before resolving provider credentials, loading the pinned fixture or attaching the observer. Stage deployment inputs outside the new experiment directory. After validating the fixture and reading repository commit/dirty state, exclusively create the private audit directory; if another launch already created it, return the same diagnostic with instructions to choose a fresh ID. Write `metadata/experiment.json` with environment, protocol, provider/model, paths and start time. The CLI's `experiment_id` is the experiment directory basename; project `runId` is separately generated unless explicitly provided.
2. **Optionally attach an observer.** Skip this entire step by default. Only `--observability` enables it; address/metadata options alone do not. When enabled, reuse a healthy metadata-declared server. Without an explicit metadata override, the server must use the expected observation database. An explicitly configured unavailable server causes an error. Otherwise spawn a detached observer, poll health up to 80 times at 250 ms intervals, then open the observation database and write `metadata/observability.json`. The observer is persistent and is not stopped at project cleanup.

3. **Create project storage.** The runner creates project SQLite, Workspace, report and log directories. Task owns `project.sqlite`; Context and Judge own `context.sqlite` and `judge.sqlite`. Unless an Observation Store is injected, observation tables live in the Task connection. Formal CLI runs inject the separate persistent observation store only with `--observability`; by default they use the project-local database. Separate files do not by themselves establish independently deployed services.
4. **Construct services.** Create Task in the coordinator, then select `serviceDeployment`. Positive-duration runs default to repository-owned independent Context/Judge peers and separate durable files; zero-duration fixtures default to `in-process`. The independent path binds private authenticated HTTP, instance locks, durable commit/launch gates, checker ownership and bounded startup/cleanup. The Judge peer constructs its Lean checker identity from the serialized fixture manifest, including benchmark-specific checker versions such as `openai-math-v1`, so a peer cannot silently fall back to the generic `mvp-1` identity. The compatibility path wires synchronous local domain objects. Both install checker health/result readers and dependency events. Arbitrary external/custom provider overrides remain rejected in timed runs. The legacy `services/builtin/compose.yaml` host is a separate compatibility surface and does not supply this peer protocol.
5. **Create Mission and public input.** Create a Mission with the locked problem identity, target path/source hash, final acceptance checker and optional separate merge checker. Create its distinct public Workspace with the original unsolved file as the initial revision, then wire and reconcile the durable Mission submission store. There is no initial/shared/root Task. Bots later propose ordinary Tasks; the Mission is never taken.
6. **Build the registries and resolve Mathlib Search.** Build the Agent-facing Registry from the Mission-aware providers, then register configured bundles and Mathlib Search. Prefer a configured external URL/provider. Otherwise, if the pinned project's Mathlib source tree exists, register the local source provider. Missing source in a synthetic fixture leaves the capability absent; admission can then reject a Task needing it. Registration does not create a hidden alternative search service. Finally construct the local owner/controller Registry and router.
7. **Optional preparation hook.** Await `prepareProject` with `root: null`, the Mission/public Workspace and domain services. Deterministic callers may seed Tasks through those services; normal runs start with an empty Task pool.
The deployed worker accepts the current `swarm-bot-v1-draft.3` startup contract (or the separate `swarm-solver-v1` contract), validates the complete immutable resource set and rejects older Bot protocol versions before starting Pi. Rebuild the image when changing the host contract; a host-only update fails startup rather than silently using stale guidance.

8. **Create four Core environments.** Each Core receives a registered-Bot adapter, one-worker Runtime, authenticated Bridge, private raw log and observation hooks. Domain state and public Workspace are shared; each Bot has its own Sandbox and guest project. Native Pi read/write/edit/bash and the protected `swarm` CLI are the research tool surface.
9. **Start supervisors under the existing deadline.** Build Task Controller and four identity loops, subscribe to public changes and start independent discovery with the configured first-Bot stagger. The project deadline was fixed before setup; starting the active loop resets only its observation tracker, not the budget. Successors start after prior resource cleanup and do not repeat the initial stagger.

Failures while creating Core environments stop any created Sessions, shut down Runtimes, stop Bridges and close Task Service before rethrowing. Earlier setup failures are not equivalent to a completed project; the batch wrapper can create a fallback report, while the single-project CLI propagates the error.

## 5. Programmatic options and timer precedence

The exported runner accepts the options below in addition to CLI-equivalent `provider`, `model`, `experimentDir`, `reportDir`, `projectParallelism`, `timeboxMs` and `turnTimeoutMs`. Passing an option is configuration, not authorization to spend resources.

| Option | Default and role |
|---|---|
| `taskModel`, `taskOriented` | Removed; supplying either property is rejected, regardless of its value |
| `normalFlow` | No longer selects behavior; the runner fixes normal flow to `true` and does not read this option |
| `runId`, `startedAt` | Random UUID and current time for setup identity/tracker; active-loop timing is set after setup |
| `repositoryCommit`, `repositoryWorktreeDirty` | `null` unless caller/CLI supplies them; report provenance |
| `stopOnSolved` | Retained in option storage for compatibility; it does not change the loop. Accepted Mission plus completed closeout ends the run regardless of this value. |
| `taskTimeboxMs` | No current consumer; the runner creates no initial Task. Bot, Execution and Mission deadlines govern the active path. |
| `botMaxMs` | Run timebox; total lifetime starting before discovery |
| `selectionTimeoutMs` | min(300000, Bot maximum) for library calls; Runtime clamps to the Bot deadline |
| `executionTimeoutMs` | Bot maximum if set, otherwise run timebox; Runtime owns the active Execution deadline |
| `handoffReminderMs` | Effective Execution maximum minus `min(5 min, floor(maximum/10))`, at least 1 ms. Explicit Execution or Bot maximum overrides are reflected; Runtime requires the reminder below the Execution maximum. |
| `handoffTimeoutMs` | Identity-loop ownership wait: `max(executionTimeoutMs, 2 * turnTimeoutMs)` |
| `turnIntervalMs` | `1000`; bound continuation waits at most 100 ms before its next turn, while periodic scheduling also checks this interval |
| `pollMs` | `5000`; outer repair/observation wake fallback |
| `controllerShortlistLimit` | `16`; bounded eligible list passed to Controller/identity loops |
| `controllerSweepIntervalMs` | `0`; avoid a second Controller timer because the outer loop already repairs |
| `maxStartupAttempts` | `3`; identity-loop take/startup attempt budget |
| `maxTakeRescans` | Runner and IdentityTaskLoop both use this key; default `1`, accepted range 0–10. It bounds immediate rescans after a structured take conflict. |
| `identityLoopIdleBackoffMs` | `5000`; fallback wake when no durable event arrives |
| `heartbeatMs`, `watchdogIntervalMs`, `executionTimeoutSweepMs` | Each `10000`; independent timers |
| `watchdogTimeoutMs` | Runtime default `120000`; productivity/recovery interpretation in [02](02-execution.md) |
| `cleanupGraceMs` | `30000`; one absolute grace shared by all Core, Controller, identity and background joins; must be finite and positive |
| `checker`, `leanCommand`, `checkerTimeoutMs` | Inject checker or use LeanChecker, command `lake`, timeout `120000` capped by the locked deployment when in use |
| `maxInfrastructureRetries` | Forwarded to JudgeService; see exact Judge defaults in [04](04-services.md) |
| `command` | Agent command defaults to `pi` and accepts an explicit executable path ending in `/pi` |
| `observationStore` | Inject persistent observation store; otherwise project-local storage |
| `prepareProject` | Injected deterministic preparation hook after Mission/Workspace creation and before Core construction; receives `root: null`. Ordinary runs do not seed a fixed Task pool. |
| `serviceDeployment` | `independent` for positive-duration runs; `in-process` for zero-duration fixtures. Only those two repository-owned compositions are accepted. |
| `serviceRegistry` | Inject full Agent-facing registry; skips built-in bundle and Mathlib auto-registration; local owner/controller router still exists |
| `serviceEndpoints` | Built-in provider endpoint/token map; otherwise use `SWARMENV_{TASK,CONTEXT,JUDGE,CATALOG}_SERVICE_URL` and corresponding `_TOKEN` variables |
| `customServices` | Additional registered providers when building the default registry |
| `serviceBundles`, `serviceBundleRoot` | Bundle directories and optional containing-root constraint; relative bundle paths resolve against the working directory, not against `serviceBundleRoot`. Load manifest plus documentation. |
| `serviceBundleEndpoints`, `serviceBundleAdapters` | Override per-service HTTP endpoint or supply an adapter; unsupported transport without adapter throws |
| `mathlibSearchUrl`, `mathlibSearchToken` | External search URL/token, otherwise `SWARMENV_MATHLIB_SEARCH_URL` / `_TOKEN` |
| `mathlibSearchSourceRoot` | Otherwise `MATHLIB_SEARCH_SOURCE_ROOT` or `<lean project>/.lake/packages/mathlib/Mathlib` |
| `mathlibRevision`, `leanVersion` | Otherwise the fixture's pinned revision/toolchain; provider metadata |
| `sandbox` | Enabled only when `sandbox.enabled === true`; exact settings below |
| `requireThirdPartySandbox` | CLI sets `true`; affects classification of provider startup failures. The current runner requires enabled OpenSandbox structurally even for direct library calls; zero-duration fixtures use controlled endpoints |

Finish cleanup uses Runtime defaults `finishCleanupRetryMs=1000` and `maxFinishCleanupRetries=3`; retries back off exponentially up to 30 seconds, preserve ownership on exhaustion, and are cancelled on shutdown. The runner does not pass every Runtime constructor option through. For example `maxCompactions=3`, `handoffWindowRatio=0.8` and compaction checkpoint reminders use Runtime defaults here; assigning similarly named fields on runner options does not configure them.

Sandbox settings are `image` (required when enabled), provider `opensandbox`, `commandTimeoutMs=120000`, `maxOutputBytes=1048576`, and `preflightTimeoutMs=20000`. The `run-putnambench-benchmark.mjs` CLI sets `requireThirdPartySandbox=true` and rejects a disabled sandbox or any provider other than OpenSandbox before creating Tasks or Agents. The OpenSandbox provider additionally accepts `lifecycleBaseUrl` (or `SWARMENV_OPENSANDBOX_URL`), optional `endpointHost` (or `SWARMENV_OPENSANDBOX_ENDPOINT_HOST` when a local Docker server advertises an internal address that must be reached through its published host port), `apiKey`/`OPEN_SANDBOX_API_KEY`, `execdToken`/`SWARMENV_EXECD_ACCESS_TOKEN`, `resourceLimits`, `environment`, `agentEnvironment`, `secretEnvironment`, `volumes`, `execdPort=44772`, `workerPort=44100`, `workerCommand`, `foregroundSession=false`, `bridgeHost` and `bridgeUrl`. `bridgeUrl` is optional for loopback-only test doubles; when workers must call the controller Bridge over a provider network, bind `bridgeHost` to a reachable interface and set a public URL template such as `http://172.17.0.1:{port}`. `agentEnvironment` supplies explicitly allowed routing/version fields, the optional checker-call CLI HTTP allowance and the Bot's Bridge URL. Registered Bot launch strips Service discovery/individual Service URLs and global Service bearer tokens; the child receives its scoped Bridge token and, for timed runs, only a revocable local model-gateway credential (see the metered model section below). Worker/controller secrets remain outside the child environment. A fresh provider Sandbox belongs to each Bot before any E exists; the same Sandbox and Pi continue through its sole successful take. The guest project `/workspace/project` starts empty and protected, and take copies the complete pinned public tree before activation/grant. Pi private session/cache state lives under `/workspace/runtime`; no host Workspace is mounted. The image recipe at [services/opensandbox-agent/Dockerfile](../../services/opensandbox-agent/Dockerfile) carries the pinned Pi package, Responses model catalog for `kimi_proxy/k3` and the explicit `gpt_proxy` alternatives, Bash, Git, CLI and the versioned system/four-skill resources. Repository extension code is present for compatibility but is disabled for registered Bots. The local gateway token and base URL are supplied at runtime through Pi environment interpolation; no provider binary or credential is baked into the image. [Workspace and continuity](05-workspace-continuity.md) describes the container boundaries and detached-job timeout limitation. The shipped Dockerfiles for HTTP services are deployment recipes; they are not a preconfigured Lean/Sandbox experiment environment.

Sandbox preflight sends a bounded authenticated GET to the OpenSandbox lifecycle list endpoint before the experiment row. A successful response verifies API access. The built-image worker and disk probes in the [benchmark runbook](../operations/benchmark.md) exercise the local image and host quota setup before a formal launch. The live Bot startup also checks its deployed worker and per-Bot isolation. Scoped provider reconciliation runs after Core Runtime construction and before any Bot launch, with the experiment already registered. Unattributable preflight events are omitted; registered reconciliation and subsequent lifecycle evidence are recorded. A failed preflight is still surfaced before any Task or Agent is created.

For a Seymour comparison with native Agensh, the optional [Seymour image layer](../../services/opensandbox-agent/Dockerfile.seymour) adds the same `lean-check` command to a selected SwarmEnv worker image. The operator supplies named build contexts for the locked Lean `bin` and `lib` directories, the numbered public compiled dependencies, the exported public Mathlib source and the directory containing `seymour-lean-check`. The layer installs toolchain and library inputs under `/opt/lean` and `/opt/lean-libraries` and exposes the source at `/opt/mathlib-source/Mathlib`. After take, `lean-check --swarmenv-workspace PATH.lean` enumerates Lean files from the fixed worker project directory without relying on Git metadata. It validates the module root and sources, copies the selected project inputs to private scratch under the Bot's existing `TMPDIR` quota, and runs the same offline build command. It returns the compiler exit status or an input error, with temporary files removed when the command settles. Submission uses the host's locked final checker and immutable main tree. Record the selected image ID and probe it under the Bot UID before launch.

## 6. The active outer loop

Each identity loop owns discovery, Agent choice, take/bind and waiting for its Execution to release. The runner's `onTake` callback binds the existing Pi Session with no additional initial prompt. A continuation promise waits for settling, then keeps sending bound turns while that Execution is `RUNNING`. `turnInFlight`, `boundTurnPromise`, current Session identity and release checks prevent an ordinary repair tick from opening a second overlapping turn.

Task mutations notify subscribers after commit. The Controller reconciles readiness and signals idle identities; the outer loop wakes on that event or its five-second fallback. It samples available Tasks and physical idle Cores, releases terminal Executions, reconciles Controller state and starts an eligible bound follow-up. It does not choose a proof route. A persisted accepted Mission blocks new research admission immediately. The acceptance callback and outer-loop fallback enter the same bounded closeout, stop discovery/Controller, and notify existing active Executions.

Closeout ends at the earlier original Mission deadline or acceptance plus `missionCloseoutMs` (default 30 seconds). Active Executions may save, publish and finish under their existing hard deadlines; when none remain, cleanup starts immediately. Already accepted work remains tracked until it actually settles. The historical `stopOnSolved` option does not create a second acceptance policy or permit research beyond this closeout. [03](03-mission-task.md) describes persisted authority and callback retry ordering.

Heartbeat runs only for a durable `RUNNING` Execution with an active Runtime process. It avoids changing versions during `CREATED`→`RUNNING` preparation. Watchdog and Execution-timeout sweeps are separately serialized so a slow sweep cannot overlap itself. Their errors are recorded, and recovery/timeouts can wake identities. [02](02-execution.md) describes which conditions trigger fencing, restart and continuation.

`readyTimeoutMs` can independently bound initial Bot readiness; absent this option, initial readiness retains the legacy `turnTimeoutMs ?? 30000` fallback. `runTurn` bounds readiness and prompt RPC acknowledgement to at most 30 seconds, then uses the requested turn timeout for settling unless the tool response was already handled. Discovery settling uses at least 180 seconds. Some bound-continuation calls default to 30 seconds when a direct library caller omitted `turnTimeoutMs`, even though the outer runner's local default is nine minutes. These distinct bounds must not be collapsed into a single timeout setting.

Each admitted discovery or bound continuation owns a unique in-memory turn token tied to its Session and, after a take begins, its Execution. The parallelism tracker still rejects a second active Agent turn on the same Core; ownership is installed only after that admission succeeds. Discovery admits its turn inside its error/finalization scope and sets reservation flags only after successful admission. A failed begin therefore cannot leave a newly reserved Core or replace another turn's owner. Settling or closing the discovery transport ends its own turn even when Runtime is still rolling back a `CREATED` Execution. A failed preparation does not need a successful bound-turn callback to retire that transport interval. The initial bound waiter also settles the captured initial owner before starting continuation turns. A matching Execution release can retire the current owner only when Core Task/Execution and Session still match. Every delayed `finally` ends only its captured owner and changes reservation flags only for its current Session without a successor owner. The Bridge release callback delegates to `recordCoreExecutionRelease`: a historical Execution release still updates that Execution's latency and emits `execution_released`, but only a matching current Task/Execution may emit Core `IDLE`, change the tracker state or clear current Core binding. Old release/transport completion cannot end or unreserve a newer turn. These tokens are local ordering guards; durable Bot, Execution, fencing, physical-stop and Mission acceptance authority remain with Runtime and the services.

## 7. Shutdown and report behavior

Shutdown runs after the active loop exits:

1. Clear heartbeat/watchdog/timeout timers and retain their in-flight promises for cleanup; do not join them before issuing stop.
2. Unsubscribe Task events, stop new wake requests, abort/stop identity loops, and begin Controller stop. A suspended Controller cannot subsequently signal another Bot.
3. Mark every Core stopping. Concurrently stop Runtime, Bridge transport, Sessions and startup; join turns and pending handlers. Runtime persists closing intent before joining startup and cleans a late arriving Session. Bridge no longer waits for deferred lifecycle work before closing HTTP admission.
4. All joins share `cleanupGraceMs` (default 30 seconds) measured from the start of finalization. Each pending component receives a typed timeout and, where applicable, a Core ID. A failed sibling does not bypass other pending joins. There are no extra per-turn or per-Core grace periods. Owner/capacity release remains conditional on Runtime-confirmed physical stop, not the reporting timeout.
5. Read only an already recorded Mission submission within the remaining allowance; never create a synthetic operator verdict from report fields. Build/write the report and final observations. Pending cleanup makes the run invalid and is recorded explicitly. Keep all owned stores needed by tracked late cleanup open until it settles; otherwise close them after writing. The CLI writes `aggregate-report.json` and experiment metadata. Fresh-process reconciliation uses durable registered Bot create/cleanup state and scoped provider evidence; it does not revive private Pi sessions.

The runner verifies the fixture and model configuration, checks the locked verifier and OpenSandbox endpoint, initializes the independent services, Workspace, gateway and Bridges, and reconciles provider state before starting the Mission clock. Once ready, it records one start, fixes the absolute deadline at start plus `timeboxMs`, then starts the Task controller and admits the first Bot. Runtime admission, model requests, Mission submissions, readiness tracking and reports share that boundary. Each batch project gets its own full window. Before the CLI launch, the operator runs the image contract and disk quota probes against the deployment image. Provisioning a live Bot repeats worker, catalog and quota attestations on that specific sandbox. A live attestation failure invalidates the admitted run with reason `bot_startup_contract`; other Cores may already have performed work. Per-Bot provisioning, protocol readiness, stagger, discovery, inference and checks requested during work consume it. Project reports expose `setup_started_at`, `setup_elapsed_ms`, `started_at`, and the configured window as `deadline_ms`. `elapsed_ms` runs from admission through report snapshot, including cleanup. Polling and awaited orchestration use the remaining Mission allowance. A shared cleanup grace and any retained unknown external-operation tails can extend wall-clock completion, so `timeboxMs` is not a guarantee that all host processes have already disappeared. A code exception still runs `finally` cleanup but can propagate before a normal project report is built. Batch execution catches such errors per problem and writes an invalid `project_runner_error` report; a direct single-project call does not receive that batch fallback. Abrupt process/host termination is not a guaranteed complete-report path.

## 8. On-disk outputs

| Location | Contents and interpretation |
|---|---|
| `<experiment>/metadata/experiment.json` | CLI launch/protocol snapshot; final status/counts only written if the CLI reaches finalization |
| `<experiment>/metadata/observability.json` | Persistent observer address/database metadata, only with `--observability` |
| `<experiment>/state/projects/<problem>/project.sqlite` | Task, Bot and Execution records, Mission coordination and local Workspace request state; observations only when no external store was injected |
| `<experiment>/state/projects/<problem>/model-budget.sqlite` | Model admissions, request identity, usage and budget settlement |
| `<experiment>/state/projects/<problem>/mission-workspace/` | Public Mission repository/index and immutable saved revisions |
| `<experiment>/state/projects/<problem>/context.sqlite` | Immutable Material, corrections, usage and Context receipts |
| `<experiment>/state/projects/<problem>/judge.sqlite` | Diagnostic Judge requests, checker preflights and results |
| `<experiment>/workspaces/projects/<problem>/<execution>/` | Private Execution Workspace and lineage metadata; reusable Core process directories also live below the project Workspace root |
| `<experiment>/state/projects/<problem>/judge-work/` | Independent checker work products |
| `<experiment>/logs/projects/<problem>/agents/core-N.ndjson` | Private raw Pi transport evidence, including repository-sent prompt messages |
| `<experiment>/logs/projects/<problem>/services/`, `bridge/`, `runtime/`, `judge/` | Component evidence with the visibility/sanitization of each logger |
| `<experiment root>/.observability/observability.sqlite` | Shared CLI observation projection, only with `--observability`; otherwise the runner uses its project-local database |
| `<report root>/<problem>/report.json`, `<report root>/aggregate-report.json` | Exported reports; counts and projections are explained in [06](06-observability-experiments.md) |

The top-level ignored `experiments/` raw evidence directory and committed `docs/experiments/` report directory have different purposes. Raw conversations and proof source are not copied into the implementation manual.

## 9. Fixture, service and frontend boundaries

Deterministic library tests use in-process adapters and explicit bounded fixtures; they are separate from the production benchmark CLI and do not represent a live provider run.


Built-in and Mathlib service launchers use HTTP manifests and role/binding enforcement. Built-in invocation requires actor-bound principals; Mathlib Search retains optional bearer authentication. Each handles SIGINT/SIGTERM shutdown. Timed runs default to service-owned separate state and independently hosted Context/Judge peers with the durable coordinator protocol. The explicit in-process mode retains synchronous lifecycle APIs. Legacy independently hosted HTTP mutation without either authority composition fails closed. The built-in image installs production dependencies with scripts disabled; it does not install Lean. Mathlib Search needs an external upstream or a mounted source tree. Full host settings and request behavior are in [04](04-services.md).

The dashboard's maintained source is `src/observability/client/`; Vite builds it to `src/observability/public/` with `app.js` and `styles.css` names. The observer serves these generated assets. Development proxies `/api` to `127.0.0.1:8787`. `components.json` configures the UI component generator, not runtime scheduling. `package.json` pins the Pi package and records Node's minimum version; `package-lock.json` pins dependency resolution. `npm test` uses serial Node tests. Its pretest hook first runs the offline `npm run docs:check` gate, then builds the UI. `npm run docs:generate` refreshes the prompt, API/storage and source-fingerprint references; `docs:check` only verifies them and local links.

## Source and verification map

Sources: [benchmark CLI](../../scripts/run-putnambench-benchmark.mjs), [runner](../../src/benchmark/putnam-runner.js), [locked config](../../config/putnambench-12.json), [parallelism tracker](../../src/benchmark/parallelism.js), [observer launcher](../../scripts/serve-observability.mjs), [service launcher](../../scripts/service-host.mjs), [search launcher](../../scripts/mathlib-search-service.mjs), [Vite config](../../src/observability/vite.config.js), [package scripts](../../package.json).

Relevant deterministic tests: [benchmark CLI](../../test/benchmark-cli.test.js), [orchestration](../../test/orchestration-roles.test.js), [parallelism](../../test/parallelism.test.js), [observation server](../../test/observability-server.test.js). Real provider/Lean acceptance still requires separate version-bound evidence.

### Phase 02 migration and comparison labels

The discovery path gives each Core the same autonomous local-Task selection instructions. Historical reports preserve the old labels and actual actions. New reports record the fixed per-project Core count, project-level parallelism, and observed proposal, take and parallel execution events.

### Registered Bot startup and cleanup accounting

The Runner's `initialBotStaggerMs` option sets the interval between first-Bot eligibility times. Its programmatic default is zero. The formal CLI defaults `--initial-bot-stagger-ms` to 60,000 ms and accepts a nonnegative timer-safe integer. Explicit zero is valid. The default staggered four-Core profile uses 60,000 ms, so Core 1 is eligible at orchestration start and Cores 2–4 at 60, 120 and 180 seconds later. These are earliest times, subject to ordinary runtime admission and operating delays. The waiting time belongs to the existing run timebox. No Bot or sandbox is created for a delayed Core before eligibility. No Core waits for another Core to take or finish, and successors follow ordinary cleanup and bounded rediscovery without first-start staggering. Mission acceptance, run stop or deadline prevent first launches still waiting.

Each Core startup now calls `Runtime.startBot` with the shared Mission, its Core ID, `selectionTimeoutMs` (default min(300,000 ms, Bot maximum)), `maxLifetimeMs` from `botMaxMs` (default run timebox), and readiness timeout (`readyTimeoutMs ?? turnTimeoutMs ?? 30_000`). The adapter factory receives the newly persisted Bot and provider-ID callback; the Bridge rotates identity/token before worker launch. Core records retain `botId` for discovery-result interpretation. After a durable selection-budget exit or unbound Bot hard-budget stop, the identity loop waits for a relevant public change or a bounded fresh-discovery fallback, normally 30 seconds. This fallback requires an open Mission with time remaining and a Core whose prior Bot resources have closed. An empty turn follows ordinary discovery-incomplete handling. Cleanup is complete only when active processes, retained Sessions, pending Bot IDs and adapter/startup cleanup are all empty. These checks use the shared whole-run cleanup grace above; no separate per-join grace extends it.

A typed `BOT_STARTUP_CONTRACT` from timed OpenSandbox Bot startup records the
Core ID, error code and `bot_startup_contract` class, blocks further discovery
and startup across that project, and wakes the project supervisor. The
supervisor runs normal cleanup, including joining in-flight startup and
releasing per-Bot Sandbox and model access. The project report records
`run.startup_failure`, `run.stop_reason=bot_startup_contract`,
`run.protocol_valid=false`, and the matching invalid audit reason. The aggregate
includes the project stop reason. The CLI saves the reports, sets metadata
status to `startup_failed`, and exits 1. A concurrent operator stop keeps its
existing status and exit code. Retryable startup errors retain the existing
retry/replacement policy. The project uses the normal lifecycle for a Bot
that was already running when a later startup fails.

The run manifest and aggregate protocol record the configured interval as `initial_bot_stagger_ms`. The run manifest, aggregate protocol and project report record Bot, selection and Execution maximums separately in milliseconds. A 30-minute single-project configuration can set `--timebox-ms 1800000 --bot-max-ms 600000 --initial-bot-stagger-ms 60000 --selection-timeout-ms 120000`; this is configuration syntax, not evidence of an executed or accepted experiment. Existing finalization grace is additional to the research timebox and retained cleanup remains visible on failure.

The Agent image requires util-linux `setpriv` and the trusted project helper adjacent to the worker. Guest Pi cwd is `/workspace/project`; its Session and expanded model catalog live under `/workspace/runtime`. The worker must run as root to reserve/protect those directories and drop Pi to UID/GID 10001. Mounts must not populate the new project or replace protected parent directories. These image changes require rebuilding the pinned experiment image before provider preflight; the prior image tag alone is not new-code evidence.


The registered Bot adapter always uses the immutable `bot-contract/system.txt` addendum and four explicit skill files from the image. The direct adapter validates the selected system text against that contract. Rebuild the image for changes to these files: their expected SHA-256 values are transmitted at worker startup and stale images fail before Pi launches. The Dockerfile normalizes resource modes to root-writable, other-readable files and traversable directories. The raw version manifest records protocol version, body/resource hashes, skill descriptors and native tool names. No provider/model configuration is changed by this prompt migration; live provider compatibility must be verified separately.

Worker startup claims the single start slot before awaiting resource reads. All five unique resources must match the supported protocol and pinned hashes, be root-owned/readable to the Bot, and sit under protected traversable parent directories. The worker returns a verified protocol/resource receipt. Manager validates this receipt before publishing started state, so an older worker that ignores resources is rejected and the Bot lifecycle cleans up its Sandbox. Concurrent starts cannot launch a second Pi. The worker sends a typed HTTP 400 rejection for a deterministic image resource, quota or catalog violation. The manager recognizes that type only on the authenticated worker start request. It also emits the type when its own pinned startup checks or the returned receipt fail. Generic provider HTTP errors and endpoint discovery retain their separate errors and ordinary recovery.


## Final-tree acceptance configuration

A positive-duration Putnam run requires `final_tree_checker` in its trusted host configuration. It contains the fixed checker identity, toolchain/library/exporter paths and `artifactLock`; the loader verifies full mounted artifacts, pinned sources, isolated Lean version and actual cgroup limits before provider creation or model startup. The lock-generating tool takes the trusted build configuration and source checkout paths, verifies the fixed source revisions, and stores only the local deployment lock at the requested local path. A changed verifier, harness, dependency or executable requires regenerating and validating the lock. The final environment identity includes its digest. The diagnostic source checker keeps its separate fixture configuration. Programmatic controlled tests may inject a final-tree adapter explicitly. The CLI accepts the locked deployment.

The `lean-module` development path parses headers with the pinned Lean parser and builds the selected local dependency closure one module at a time. Each build mounts only that source and the immutable transitive dependency artifacts, using the normal cgroup deadline and process cleanup. The new parser/compiler implementation and the mounted base64 encoder participate in the artifact lock. Full project, merge and Mission checks retain their independent full-build paths; a module receipt cannot substitute for them.

The module checker retains a process-local, Mission-separated artifact cache bounded by `moduleCacheBytes` (128 MiB default, up to 1 GiB). Keys include the module source, recursive dependency keys and locked checker environment/options. A cache miss compiles in a fresh namespace, then validates the resulting artifacts in a separate namespace before admitting immutable bytes to the host-owned LRU. A hit reuses that previously validated artifact and its warnings; it is not a newly executed proof check. Source-only caching does not promise to rerun metaprograms that observe time or other nondeterministic external state. Candidate precompiled files never populate the cache. The existing artifact lock now covers `lean-module-checker.js`, `lean-module-build.lean`, `lean-module-verify.lean` and the mounted base64 encoder. The system `mkdir` and `base64` executables may be symlinks only into the existing read-only host library mounts; the lock records both the invoked path/link and canonical target bytes. Renew the deployment lock after changing these inputs; its environment identity separates old cached artifacts.

The build driver enables normal imported Lean extensions, reads the fixed source and calls `Elab.runFrontend`. Only a successful returned Environment receives the module-specific completion definition containing the source/dependency/environment key; the driver then serializes that Environment. Exit zero or a nonempty output alone is insufficient for a PASS; the separate verifier must also accept the artifact. The independent verifier loads the resulting olean parts and fixed dependencies with candidate extensions/initializers disabled, checks the expected completion definition and replays the current module's safe declarations into the imported environment. It does not recheck the whole Mathlib library. Lean's replay intentionally skips unsafe/partial program constants; newly declared axioms are reported as warnings, and frontend `sorry` warnings remain visible. Damaged, missing or mismatched artifacts return scoped ERROR and are not cached. A failed build does not consume another request's cached result.

The independent module verification driver and final-tree proof driver scope `linter.deprecated=false` to their host-owned `main` declarations. This keeps the replay API compatible with Lean 4.33.1 and 4.34.1 while preventing compiler deprecation warnings from prefixing the module driver's single JSON receipt or the final driver's exact success marker. The JavaScript receipt parser remains strict; arbitrary extra stdout, malformed receipts and artifact verification failures remain errors. This option does not suppress candidate source diagnostics or change replay, completion checks or acceptance. Driver changes require a fresh artifact lock.

This is development diagnostic validation under Lean's ordinary frontend/metaprogram trust assumptions. The completion definition is not a cryptographic attestation against code intentionally forging the driver protocol or compromising the compiler process. Independent artifact replay also does not establish the intended meaning of an arbitrary new theorem. The local receipt remains mathematically unassessed and cannot satisfy full Workspace delivery, merge or Mission acceptance. The final fixed-target/type/axiom/portable-kernel path is unchanged. These distinctions follow the [Lean proof-validation guidance](https://lean-lang.org/doc/reference/latest/ValidatingProofs/); arbitrary in-process native attacks are not claimed to be prevented by the local diagnostic path.

Lean diagnostics distinguish compiler source rejection from incomplete checking. A Lake worker exiting with code 1 and mapped ordinary source error headers returns `FAIL` with up to eight bounded source diagnostics. Located Lean deterministic heartbeat timeout, maximum recursion depth and panic headers instead return `ERROR`, retaining the bounded diagnostic and source location. JSON error records also recognize Lean's `runtime.maxRecDepth` tag through nested tags. For plain output, only a leading known `Tactic … failed with a nested error:` envelope is unwrapped, up to eight levels; the project stream retains the original located error while reading its immediate nested continuation across chunks. Arbitrary resource words later in a goal or ordinary error body do not trigger this classification. `lean_resource_limit` and `lean_panic` identify these cases; their compiler process completed, their mathematical outcome remains `unassessed`, and `retryable=false` discourages repeating unchanged input. Explicit memory/runtime failure headers retain `ERROR` with `checker_memory_limit` or `checker_runtime_failure`. These codes and retry guidance pass through the source/project adapter, Judge result and Agent feedback using the existing evidence fields and result classes. For these diagnosed completed invocations, Judge preserves the nonretryable guidance instead of declaring the checker unavailable and replacing it with the infrastructure retry gate. The same preservation applies to `module_verification_failed`: independent module artifact validation completed and rejected the candidate bytes, so the result stays `ERROR`/`unassessed` with `retryable=false`, no cache insertion and no checker-health degradation. A corrected revision remains eligible for normal checking. Actual process/infrastructure failures keep that gate. No new database result class is introduced.

The collector parses complete streamed headers, including headers split across chunks or emitted after the retained stderr prefix. It does not classify ordinary words in source paths, quoted terms or goal contexts. The direct source diagnostic adapter likewise examines located error headers; the non-project final export path examines JSON error records. Abnormal worker exit codes, process signals, launch failures and unknown build failures remain infrastructure errors without being guessed to be OOM; external wallclock deadline expiry retains its distinct timeout flag. This feedback classification does not change Lean resource defaults, proof acceptance, kernel replay or the final-tree trust boundary. Existing experiment records are not reclassified.

The retained CLI resolves `--checker-timeout-ms` into `checkerTimeoutMs`. The runner clips that source-check bound to the locked verifier timeout. A host library composition can independently supply `readyTimeoutMs`, `turnTimeoutMs` and `sandbox.agentEnvironment.SWARMENV_CLI_CHECK_REQUEST_TIMEOUT_MS`. The Bot-facing CLI reads the latter only for `workspace_check`, `workspace_merge` and `mission_submit`, with an explicit `--timeout-ms` taking precedence. Its ordinary request default is 30 seconds. These settings have independent transport, admission and checker effects. A response timeout remains unknown and does not cancel an admitted check.

The trusted `final_tree_checker.timeoutMs` field defaults to 120,000 ms and participates in the artifact lock. Renew the lock after changing it. Mission coordination takes the verifier timeout and clips it to the remaining Mission deadline. The source diagnostic process bound is the smaller of `checkerTimeoutMs` and the locked timeout when using the locked adapter. The launch manifest and aggregate protocol record the resolved source and final bounds as `source_checker_timeout_ms` and `final_tree_checker_timeout_ms`; the project report includes the effective source process bound under `judge_check_budget.process_timeout_ms` and the verified final-tree bound under `run.final_tree_checker.timeout_ms`.

`mission_coordination_permissions` is an explicit allowlist from `unsupersede`, `task_cancel`, `task_dependency_replace`, `mission_submit`; omitted means no grants in general compositions; positive-duration validation requires an explicit `mission_submit` grant. Runtime freezes the list at Bot registration. The research Bot cannot change it. The historical `task_cancel` spelling remains accepted for configuration compatibility; it grants no additional permission. Cancellation now uses ordinary UNBOUND authority plus Task ownership/version guards, including when that legacy grant is absent. The runner always stops new research after trusted Mission acceptance; an older stop-on-solved flag cannot override the accepted Mission lifecycle. `maxInfrastructureRetries` caps final acceptance infrastructure retries and defaults to zero; exact scientific outcomes reuse their original result. Per-Bot, selection, E and run timeboxes continue to bound work independently.

## Host-gated model access and concrete network deployment

The positive-duration benchmark CLI requires a host-only Responses endpoint and credential and resolves them from the selected provider settings and host environment. The library Runner requires an injected `modelUpstream` object; gateway construction validates its fixed endpoint but trusts its host-supplied headers, allowing controlled local endpoints without authentication. It does not independently verify that those headers authenticate to a real provider. It passes only a gateway URL and a random revocable Bot credential to Pi. The selected direct Pi command, provider, Responses API, model and credential placeholders must match the Agent image catalog. Zero-duration diagnostics can keep their explicitly injected compatibility composition.

With no `model_budget`, the gateway runs in time-bounded mode. Optional trusted `model_gateway` configuration (or `options.modelGateway`) sets `host`, `advertiseHost`, `port`, `requestTimeoutMs` and `maxOutputTokens`. The default bind host is the Sandbox Bridge bind host (loopback if omitted), and the public Bridge hostname is used for advertising when supplied. The port is ephemeral by default. Each upstream POST is limited to 120,000 ms and a 32,768-token requested output cap by default. The hard cutoff is set at admission from the earliest applicable request, Mission, Bot, selection, Execution and closeout deadline, and can tighten during the request. For Execution work and closeout, the gateway checks durable Bot ownership, Execution state and fence at the current lease deadline or at most once a second. A heartbeat that extends the same lease keeps the same upstream request running. Expiration, loss of authority or failure to read Task state cancels it. Revoking the Bot credential aborts its active requests immediately. The attempt keeps its original hard deadline in SQLite and records uncertain usage if the upstream stream ends without trusted terminal usage. This mode needs no total currency allowance, rate, or upstream retry accounting contract. Local entry times and cancellation bound the work this process admits and waits for. They do not establish upstream cancellation or a maximum bill.

The gateway fixes endpoint, model and optional service tier, disables redirects, background execution and server-side conversation references, and accepts local text/function tool traffic. It refuses hosted tools and remote tool-schema references. Pi may replay an upstream reasoning item with `content: []` alongside its summary and encrypted content; this empty field is accepted unchanged. Nonempty reasoning content and unknown fields remain rejected. Compatibility is tested through two actual Pi/SSE turns so provider output must survive the next request, not only the first request. Current Task authority determines whether the Bot can dispatch in selection, work or closeout. Under that authority, the gateway records the attempt in `model-budget.sqlite` before dispatch and preserves its stable ID for receipt replay. A different payload cannot reuse the same ID, and an unidentified request is a separate upstream attempt. Bot stop revokes its token before Pi cleanup. Run cleanup aborts active streams and joins the gateway before closing its private database.

When an upstream HTTP response arrives, the gateway writes host-only diagnostics into the corresponding `responses_timed_attempts` or `responses_budget_attempts` row before accepting its stream: `upstream_status`, `upstream_content_type_valid`, `upstream_body_present`, `upstream_rejection_kind` and `upstream_retry_after_seconds`. The existing validated `upstream_request_id` remains available for provider-side correlation. Rejection classification first checks for non-2xx status (`non_2xx`), then a missing body (`missing_body`), then a content type other than SSE (`invalid_content_type`); the independent presence/format flags preserve overlapping failures. Accepted SSE responses have no rejection kind. Retry-After retains only one to five ASCII decimal digits representing 0–86,400 seconds; HTTP dates, larger values and arbitrary text are discarded as NULL. These values are diagnostic only and do not schedule retries. No raw response body, raw content type or other response header is stored in these fields. Bot errors remain sanitized: upstream 429 maps to 429 and other HTTP/format rejections map to 502 with `upstream_rejected`. The durable attempt still records `reason = upstream_http_error` and unknown usage, retaining any financial reservation. Transport errors without an HTTP response leave these diagnostic fields NULL. Gateway construction adds nullable columns to existing attempt tables; historical NULL values mean unavailable evidence and are not reconstructed. This captures future observations and cannot recover previously discarded upstream status or error details.

In time-bounded mode, the report's `model_budget` field identifies `mode: time_bounded`, policy digest, the request/output limits and observed usage. It reports how many attempts supplied terminal usage and how many are pending or unknown. Token totals cover only valid observed usage. With no observed usage they are null. Costs and cost units are null. Stored attempts follow the same rule and never record an assumed financial reservation. Counts reflect persisted ledger state: rows left pending by a process crash remain pending in the persisted counts; retry admission rejects an elapsed pending request as `request_unknown` without rewriting that row. Neither the persisted state nor a local deadline proves whether the upstream completed or billed the request.

The optional `model_budget` (or `options.modelBudget`) selects financial mode. It still requires `contract` with `maxInputTokens`, `maxOutputTokens`, `maxFanout`, `inputCostPerToken`, `outputCostPerToken`, `fixedAttemptCost`, `costUnit`, `requestTimeoutMs` and `boundEvidence`. Rates use integer units of the named currency or billing unit and bounds cover retry fanout. The Mission, Bot, selection and closeout `limits` each explicitly bound requests, input/output tokens and cost. Mission work preserves the closeout reserve. Admission reserves worst-case token and cost exposure before dispatch and durable policy pins prevent a changed policy within the same ledger. Trusted terminal usage can settle the provable difference. Unconfirmed completion keeps the upper bound. Reports keep the existing policy digest, limits, billing unit and accounted upper bounds.

Timed runs also require `sandbox_network.mode = "local-docker"` (or the equivalent `options.sandbox.networkIsolation`). The supported deployment uses local Docker bridge containers and operator access to Docker plus `sudo -n`, `nsenter`, `mount` and native `nft`. It does not elevate the Bot or worker capabilities. Before Pi starts, the adapter verifies the container's canonical Mission/Bot/resource labels, process/cgroup identity and network namespace. It pins that namespace in a root-private temporary mount and confines all firewall changes to the verified pin. The rules use the trusted worker's UID in the container user namespace and verify its immutable host mapping; both are recorded. The native nftables inet output chain uses priority -150 and is read back exactly. IPv4 permits only the fixed Bridge and model-gateway address/port pairs; IPv6 and all other Bot-originated traffic, including local management ports, are rejected. Both destinations must be concrete non-loopback IPv4 URLs; DNS and additional external destinations are unsupported in this deployment. Root provider control remains separate. The pin is unmounted after policy readback; the policy remains with the sandbox namespace and vanishes with it. Any missing capability, mismatch or failed verification blocks Pi startup and enters normal sandbox cleanup.

After setup and reconciliation, the runner fixes one absolute research deadline for scheduling, model admission and final acceptance. The report records setup duration separately. Sandbox creation carries a finite Provider TTL as an additional cleanup bound, while Runtime's Bot/Execution timers and explicit confirmed deletion remain authoritative for Core release. A TTL timestamp alone is not proof of deletion.

Use `SIGINT` or `SIGTERM` on the benchmark CLI process to request a graceful stop. An accepted stop wakes orchestration and ends new model admission. Interrupted projects report `stop_reason: operator_stop` and remain invalid. An interruption while waiting for the persistent observer to become healthy allows the CLI to write the stop report without a live observation connection. Project reports preserve evidence already recorded. Once a project fixes its outcome, a signal during cleanup or report output leaves the outcome intact. The aggregate, experiment metadata and CLI exit status all use the project outcomes. When at least one project was interrupted, metadata records `operator_stopped` and the signal, and the CLI exits with status 130 for `SIGINT` or 143 for `SIGTERM` after cleanup. If cleanup is still pending after its grace, the CLI writes the report and holds the private stores until cleanup confirms settlement.

Timed runs also require `sandbox_disk` (or `options.sandbox.diskIsolation`) with `mode = "local-docker-tmpfs-landlock"` and explicit integer `bytes` and `inodes`. The host accepts 16 MiB to 4 GiB in 4096-byte increments and 1,024 to 262,144 inodes. The operator needs local Docker access plus passwordless `sudo` for the Python namespace helper. The kernel needs Landlock ABI 5 or later. Configuration alone is insufficient. The worker must return exact byte and inode counts and the SHA-256 of the same image model-catalog bytes it uses to configure Pi. Startup fails if the worker omits either attestation. [Execution](02-execution.md)

Timed runs expose pinned repository-owned Task/Context/Judge/catalog and local Mathlib search. Context/Judge default to independently supervised peers; Task/Mission/Workspace and catalog remain local to the coordinator. A remote built-in endpoint, arbitrary custom registry/service/bundle or HTTP Mathlib provider rejects positive-duration startup: readiness is not a verified finite billing contract. Explicit zero-duration diagnostics can test these adapters; that does not approve them for this experiment.

### Owner-local manual Mission review

For a Mission with no executable checker, trusted local composition may pass `manualReview: { checkerVersion, environmentRef, timeoutMs }` to `createMissionCoordination` or the submission store. Use an owner-private database connection, set the fixed acceptance check to `manual-operator` with the same version and environment, and set a finite positive wait. The Mission run deadline still caps the wait. This is a separate configuration choice. Timed PutnamBench runs still require their locked executable checker.

Run `node scripts/review-mission.mjs show DB MISSION SUBMISSION` as the database owner to retrieve the fixed manifest. After reviewing it, run `node scripts/review-mission.mjs decide DB MISSION SUBMISSION FINGERPRINT PASS|FAIL REQUEST_ID "REASON"`. Use a canonical directory readable only by its owner and an owner-private regular database file and sidecars. The command rejects symbolic links and opens the existing database only. It is absent from the Bot/Bridge catalog. Keep review output with owner-private audit evidence.

The review command displays identities and acceptance criteria. To inspect the fixed Workspace bytes, open the trusted Workspace repository for the manifest's `workspace_id`. Check that `git rev-parse "$COMMIT^{tree}"` equals the displayed `git_tree`, then read blobs with `git show "$COMMIT:$PATH_IN_WORKSPACE"`. Use the displayed commit throughout the review. A trusted in-process operator can also call `MissionWorkspace.exportRevision` with the displayed revision and verify its returned commit, tree and content hash before reading `files`. Resolve each displayed Material with the owner-side Context service's exact `getMaterial(materialId, { verifyIntegrity: true })` and check the Mission, version and content hash before reviewing its body. Use the decision manifest's captured relation version, dispute state and active successor IDs when evaluating the submission because live correction state can change after admission.

### Local checker admission budgets

`judge_mission_budget` (or `options.judgeMissionBudget`) accepts trusted `maxConcurrent` (default 4, integer 1–64), `maxQueued` (default 8, integer 0–1024), and `queueWaitMs` (default 120000, integer 1–2147483647). Ordinary checks have no cumulative quota; omitted/null `maxRequests` is accepted for compatibility, while a finite legacy setting is rejected explicitly rather than silently enforcing an old cap. A fixed persisted Mission policy cannot change mid-run; old finite Mission policies are preserved and require a fresh Mission for the new policy. A newly admitted request reserves at most one preflight; its source phase permits one process for full-project/single-file checks or the bounded serial module plan described below. The project report's `judge_check_budget` includes running/queued/admitted counts, retries, cached aliases, process starts, queue capacity/deadline and null cumulative/process-total bounds. Exact same-ID replays do not increment a counter. Queue waiting never extends the Mission or Execution deadline. The independent launcher sizes its HTTP deadline to at least the configured queue wait plus two checker timeouts and 30 seconds of transport margin (or the prior four-timeout margin if larger). The combined HTTP deadline must itself fit a positive timer-safe integer (at most 2147483647 ms); the independent launcher rejects overflow before creating directories or starting peer processes. Thus the largest individual queue value is not necessarily deployable with a positive checker allowance. The default standalone RemoteJudgeService deadline remains 300 seconds; external deployers must choose a deadline covering their configured queue and checker durations. Separate merge checks and final Mission acceptance retain their own policies; ordinary queue capacity does not expand them.


Ordinary module checks use the same configured request concurrency, queue and checker timeout as full project checks. Their source phase supports a bounded serial plan: Judge derives `2 × N + 1` launch callbacks from the canonical fixed snapshot's `N` Lean files (excluding root `lakefile.lean`), for header parsing plus compile/independent-validation work. This is not a new configurable Agent budget. Each launch has fresh lifecycle/fencing authority and an atomic actual-process count; overlapping callbacks and launches above the fixed limit are refused. `source_process_starts` can therefore exceed the number of module check requests. Full project/single-file source phases and each preflight remain single-launch. The whole source sequence shares one existing checker slot and one source deadline, and prior descendants/cgroup cleanup must finish before a later launch. Queue, Mission, Execution and transport deadlines remain unchanged. This admission extension alone makes no claim that module artifacts meet the independent trusted-validation contract.

`mission_final_check_budget` accepts trusted `maxChecks` and `maxConcurrent`, defaulting to four and one. These govern the separate machine submission verifier. The report's `mission_final_check_budget` records configured and actual admissions. Both budgets retain unresolved active reservations across process restart. The normal benchmark shares each project Judge database across its four Cores. An explicitly configured merge policy is independent of final acceptance.

## Whole-Workspace Lean project checking

The trusted final-tree deployment accepts `projectChecks: true` (default false). It cannot be combined with nonempty `localModules`. This flag participates in the artifact lock configuration; regenerate the lock after enabling it or changing the verifier source. In project mode the runner connects the locked adapter to ordinary Judge checks and to checks of the combined tree before a Workspace merge. Ordinary Judge requests use the configured Mission diagnostic policy (no cumulative quota; default 4 active / 8 queued / 120-second queue wait). Merge calls the project checker directly and has one retained slot per Runtime/Core, independently of ordinary Judge admission. Final acceptance uses its separate submission budget (default 4 attempts / 1 active). These are separate admission pools, not a global compiler concurrency cap. All remain bounded by their lifecycle and Mission deadlines.

No new dependency is downloaded at check time. The configured, locked library roots become synthetic offline Lake path dependencies; the toolchain and library artifact fingerprints cover the executable inputs. Project source roots derive from the fixed target path, not a caller flag. See [Services](04-services.md#locked-lake-project-preparation-and-compilation) for module coverage, build outputs and error handling. Rebuild the Agent image after changing CLI help or the Workspace skill; the benchmark verifies their hashes before starting a Bot.

Independent deployment additionally writes private `judge-peer-config.json` (including its coordinator credential), per-service `*.instance-lock` files, and `judge-checker-resources.ndjson` under project state. These are operator-owned deployment/recovery evidence, never Bot/public output.

## FLT10 preparation and checker deployment

The current tree retains the fixed FLT inputs and checker deployment readers.
The retired operator preparation commands and their source-building procedure
are preserved in the [research preparation scripts](https://github.com/LuNa-shi/SwarmEnv/tree/dc011003fa0354a881b7a3ba9ba901fe36cbcac9/scripts/benchmarks).
`scripts/benchmarks/build_flt10_statement_graph.py` remains available to the
retained fixture regression. It indexes committed source modules and rejects
untracked or ignored modules from the graph. Runtime loading and final checking
consume pinned existing manifests and compiled projections.

The generated source and cut identities must match the tracked
`benchmarks/flt10/projection-contract.json`. Existing public context shards and manifests
cover the ten inputs; each problem is bound to its context manifest SHA-256.
The deployment config is a private setup input. Supply the existing sandbox,
model gateway, Mission grant and ordinary Judge policies from the approved local
deployment. Use one checkpoint-specific `final_tree_checker` per selected run,
with `benchmarkProfile=flt10-dag-v1`, `checkpoint`, `projectionRoot`, and that
projection's `lib` alongside the pinned Mathlib package libraries. Do not include
other checkpoints or the original full FLT build directory. Mathlib search uses
`MATHLIB_SEARCH_SOURCE_ROOT` pointing only at the same Mathlib source tree.

The artifact-lock creator recognizes only the legacy default profile and the
FLT profile. The latter pins the separate Mathlib and FLT source revisions,
checks source cleanliness, verifies safe projected source bytes against the
tracked contract and rejects extra/missing compiled modules in the projection.
The lock fingerprints all mounted artifacts plus the FLT contract. Launch checks
these fingerprints and the normal cgroup/toolchain requirements again. Unknown
profiles or altered artifacts fail before any research execution. Comparator,
lean4export, namespace isolation, theorem-type comparison, axiom policy and kernel
replay are unchanged. FLT additionally fixes the original source prefix before
its single terminal `sorry`, rejecting changed imports or statement before final
checking. Ordinary diagnostics still report source errors separately from final
Mission acceptance.

The existing CLI accepts `--benchmark-root` as a clearer alias of
`--putnambench-root`; its entry script remains `run-putnambench-benchmark.mjs` for
compatibility. Metadata records `benchmark` and `fixture_commit` in addition to
legacy Putnam fields. Select a problem explicitly, use four Cores and project
parallelism one for the first Q10/Q20 observations, and give each run a fresh
EXP ID. Time limits and paid-run authorization are owned by Issue #133.
The ordinary shutdown, peer cleanup, checker ownership and reporting paths
remain the same as other Swarm benchmark runs.

The final FLT source restriction scans all submitted `.lean` files for
incomplete proofs, unsafe/native bypass and elaborator/diagnostic constructs
(including `run_tac`, `trace_state`, `#eval`, `#check` and `#print`). This is a
lexical final-delivery policy outside Lean comments, in addition to
kernel replay; ordinary development diagnostics retain their existing behavior.

The complete graph remains regular public Workspace input, not a cached image
asset. For registered Bots, `OpenSandboxManager.syncWorkspace` validates each
manifest path and source digest, enforces the existing 2 MiB/file and 16 MiB/tree
bounds, then sends the full base64 file map through the authenticated worker
`/project/prepare` endpoint. This removes the serial shell invocation for every
64 KiB segment without changing the public input snapshot or checker. Historical
unregistered callers retain the bounded shell-copy path.

The worker accepts at most 32 MiB of JSON at this endpoint, reuses the existing
project-install decoder to reject malformed base64, unsafe paths, collisions
and excess decoded bytes, and compares the complete map to the pinned manifest
before writing. A new bulk input requires an empty root-owned project directory.
Files are created exclusively with root-only read permission; partial write
failure removes that attempt's input. The worker then checks the on-disk tree
and makes it root-owned/read-only as before. Matching preparation replays are
idempotent; another input/Execution, or preparation after activation, is rejected.
The ordinary grant still occurs only after durable Execution activation. Old
manifest-only preparation remains executable for the legacy copy composition.

The initial Q10 observation exposed both transfer latency and a slow-binding
lifecycle defect; see [EXP-20261116-09](../experiments/EXP-20261116-09-flt-q10-1h.md).
The subsequent repair keeps the preparation lease alive and preserves the
current discovery turn's settlement cursor across binding, as described in
[Execution](02-execution.md). Neither resource budgets nor the core Swarm
organization algorithm change. Tests and subsequent reports distinguish the
repair's verification from the original blocked observation.

## Root-only FLT Workspace tasks

The retained `flt10-subtree-v1` loader and checker consume an existing fixed
public fixture and trusted deployment. Its public inputs comprise the root
theorem, reduced statement foundation, neutral instructions, license, applicable
source notices and public context manifest. The trusted deployment supplies
`source/`, `lib/` and `foundation-manifest.json`. Private extraction facts and
reference proofs remain operator evidence outside Bot inputs. The retired
extraction CLI and its preparation procedure are preserved in the research
preparation scripts linked above.

The loader accepts a safe configured benchmark identifier and 1–1000 problems,
with explicit Lean declaration names where needed. `instructions_path`, when
present, must be under `benchmark/` without traversal; the Mission goal directs
the Bot to read it through Workspace. Existing fixture checkout/digest checks
and context byte/path/hash limits remain. `lean_project_subdir` selects a safe
repository-relative directory containing `lean-toolchain`, so fixtures whose
Lean project is nested under a repository root use the same locked project root
for loading and checker preflight. Benchmark-specific coordination code is not
inserted into the Core loop.

`config/openai-math-12.json` pins twelve medium-scope OpenAI Math challenge
modules to commit `4eaee87548250b2682affda7d05d947c05554bae`, Lean 4.34.1 and
the recorded Mathlib revision. Its source-only validation is independent of the
trusted final-tree deployment. The `openai-math-v1` final-check profile uses
the matching Lean, Comparator, Lean4Export and Mathlib pins, requires complete
project coverage, and still requires an operator-created artifact lock before
a timed run can start.

The new final-check profile pins FLT/Mathlib revisions, the operator-approved
foundation manifest digest and compiled artifacts. Lock creation verifies the
reduced source inventory and rejects unexpected compiled artifacts. Candidates
can create ordinary project modules and add imports; trusted namespace shadowing
and source-layout restrictions still reject. `requireCompleteProject` rejects
`sorry`, `sorryAx`, `admit` or `axiom` outside comments in submitted Lean files.
The shared source-policy helper is included in the artifact lock. Renew older
locks before startup with the new verifier. The older FLT profile freezes the textual import
prefix. Original theorem/type comparison, transitive axiom checking and kernel
replay still govern final PASS; ordinary project diagnostics remain unchanged.
All existing checker resource limits, deadlines and cleanup apply.

Configs with `validation_required: true` require a private operator receipt
before timed project initialization. Its hash and safe relative path are checked
under `benchmark_validation_root`. A complete-target PASS must attest initial
compilation, statement identity and visibility, and bind the exact target hash,
public context hash and checker artifact-lock SHA plus a final check result ID.
A missing, helper-only, stale or mismatched receipt fails before creating a Bot.
The receipt is trusted operator evidence, not a proof supplied by a research
Agent; the locked deployment is still verified independently afterward. No
receipt is manufactured by preparation: new problems start unvalidated. Private
reference proof source is never a public input or an additional trusted library.

The standalone private-witness creation command was retired during Phase 0005
cleanup. Its original operator procedure is retained at the fixed
[research revision](https://github.com/LuNa-shi/SwarmEnv/blob/dc011003fa0354a881b7a3ba9ba901fe36cbcac9/scripts/validate-benchmark-witness.mjs).
The remaining legacy loader consumes the existing private complete-target receipt.
It still checks the exact target, public context, artifact lock, complete witness
tree and embedded PASS before initialization. The locked final checker continues
to enforce its deployment, resource, deadline and cleanup contracts. Retiring the
operator command supplies no new receipt and does not waive a required receipt.

### Per-deployment checker resources

A trusted `final_tree_checker` may set `resources: { memory_bytes, cpu_percent,
max_tasks }` (all optional positive safe integers) and `projectJobs` (integer
1–256, default 1). Defaults remain 4 GiB, 200 percent CPU and 64 tasks. Unknown
resource fields and invalid values reject before process dispatch. No Agent
payload selects these values. The artifact lock includes supplied overrides;
changing them requires a new lock and complete-witness receipt. Startup reads
back actual cgroup limits, and reports the effective profile and build jobs.
`projectJobs` supplies Lake's `LEAN_NUM_THREADS`; each child compiler retains
`-j1`. Compiler/export/replay stages share the chosen cgroup resource policy.
Swap, termination grace, cleanup ownership and deadline clipping are unchanged.
Research Core count is a separate setting and remains four in the Q20 study.

## Historical continuation (Issue #149)

`--resume-from <finished-experiment> --at <ISO timestamp with timezone>` selects a
historical starting point after the source experiment has ended. Supply one
`--problem` and a fresh `--experiment-dir`. The existing provider, image, fixture,
checker and budget configuration remains required. This mode reconstructs the
public main Workspace and service research data before opening live services, then
starts the normal four-Core Swarm with new Bots and a fresh budget. It does not
require saving a manual snapshot during the source run.

The source stays read-only. The destination retains public Mission/Task/Material
IDs, retires old runtime ownership locally, and records provenance in `resume.json`.
The original problem and final checker identity must match. Missing historical
evidence, an already accepted Mission, an unfinished source, incompatible inputs or
an existing destination fail before new Bot work. History modes, legacy support,
time semantics, operational handoff and verification are described in
[Historical continuation](13-historical-resume.md). Historical reconstruction and service preflight run before the research clock.
The normal admission event starts a full new window for the four Cores. This mode does not combine with Pass@K.

## Independent Pass@K execution (Issue #129)

The existing benchmark CLI accepts `--pass-k K --problem <id>` with integer K from 1 through 4. Omitting it retains the four-Core Swarm protocol and its existing defaults. K=1 and K=4 use the same `runPassK` composition; each attempt invokes `runBenchmarkProject` with explicit `agentMode: solver`, one Core, a distinct run ID and positive attempt index. This is not a second runtime or checker. The CLI retains pinned-fixture verification, model routing, private audit retention and the existing production startup gates. Positive-duration solver attempts inherit the same independent Context/Judge deployment and current ordinary-check policy as Swarm (no cumulative quota, default four running/eight queued/120-second queue wait per Mission); Context is controller-only for solvers. Historical EXP05/06 retain their recorded 20/2 policy and do not establish results for this integrated configuration.

Each attempt first prepares its own services and resources. When the final attempt reaches readiness, the runner releases all K attempts with the same start and absolute deadline. Time spent waiting for peers belongs to setup. If preparation fails or the operator stops the group before release, the group starts no work, records a null start and deadline and a zero-length observation window, then joins cleanup. Attempt state, logs, reports and working directories are namespaced by `<problem>-attempt-<index>` while scientific problem identity remains unchanged. Each attempt creates its own Mission and Workspace from the original pinned fixture, then creates exactly one complete-solution Task through Task Service. Bot startup uses the existing registered Bot/sandbox path. The host calls the Bridge's non-HTTP `controlCall(task_take)` seam, which performs ordinary admission, owner checks, binding and Runtime Workspace activation before sending the first solver message. The agent never receives the host control seam or a Task capability.

`runPassK` fixes Bot and Execution maxima to the group timebox, disables initial staggering, and grants only Mission submission coordination. The standard bounded soft-closeout window still applies. Solver mode keeps successful compactions in the same Bot/Session/Execution instead of invoking Swarm's compaction-count rotation; the existing timebox, model request limits and hard deadlines remain authoritative. A completed or interrupted sample cannot spawn a replacement sample: the Core records that its single solver attempt has started. Source errors can be repaired within that same Session. Model/process failures are preserved as errors rather than silently resampled. Shared infrastructure can affect startup and checker queueing; independent Missions do not imply independent hardware.

Within each Mission the agent saves and checks immutable revisions, requests a checked merge, and calls `swarm solution submit`, a CLI alias for Mission submission with an empty explicit Material selection. `swarm solution status` reads that Mission's submission state. The existing final verifier and acceptance callback remain authoritative. Once accepted, the host finishes the actual Task as done through the same protected lifecycle seam, then normal Runtime cleanup stops that Bot. The experiment group keeps its registered observation window even if all attempts have finished, without retaining idle sandboxes or creating more samples. Empty observation time is not agent computation.

At the deadline, ordinary Mission/Execution fencing and bounded cleanup apply. The summary counts only valid attempts with trusted acceptance timestamps within the group window; late acceptance is reported separately. A signal stops active runs and the remaining observation wait (checked at most once per second). Startup exceptions receive unavailable-project reports. The group joins all attempts and reports settlement time beyond the window separately. Raw state and prompts stay under the existing managed private audit directory.

The aggregate report adds `pass_k` with K, fixed start/deadline, observation and settlement durations, operator stop, per-attempt validity/acceptance, and first successful acceptance latency. The legacy project report retains its scientific problem ID and records the attempt index and absolute acceptance time. Costs remain in each attempt's existing model/Judge evidence; identical per-attempt budgets imply K-fold possible total usage, not an equal-total-budget comparison.

For programmable Core child control, a host Profile grants individual operations through `services: { bot: ['spawn', 'get', 'send', 'stop'] }` and separately lists target roles in `spawnProfiles`. Core validates the target names against the frozen Profiles. Dynamic child creation takes all resource and capability defaults from its target Profile and receives no parent secretEnv or Service bindings; Bot-facing input cannot override host resource fields. [Built-in Bot control](15-core-runtime.md#built-in-bot-control) describes the actual entry and recovery path.

Core injects `SWARMENV_BRIDGE_CONTRACT_VERSION=2` with its Bridge URL and bearer credential. It is a nonsecret wire-format hint for the installed CLI, not Profile configuration or an authorization grant. Built-in commands use explicit v2 Service IDs on that connection; the legacy Bridge omits the hint and retains its single operation-only delivery. Host Profile/secretEnv validation reserves all `SWARMENV_` keys.

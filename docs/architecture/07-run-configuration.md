# 07. Launch, configuration, the outer loop and finalization

This chapter describes how the repository actually composes a run. It covers the benchmark CLI and exported runner, the smaller fixture paths, optional service deployments and the UI build. Domain state transitions remain in [02](02-execution.md) and [03](03-mission-task.md); full prompt and tool bodies are in [08](08-prompts.md) and [10](10-service-api-reference.md).

## 1. Entry points and execution modes

| Entry | What it executes |
|---|---|
| `scripts/run-putnambench-benchmark.mjs` | Real benchmark launcher: validates locked input, creates run metadata/observer, invokes one project or a bounded batch, writes aggregate output |
| `runBenchmarkProject(problem, config, options)` | Four Core lanes for one problem; the caller can inject adapters/checkers for deterministic tests |
| `runBenchmarkBatch(problems, config, options)` | Worker pool across isolated projects; each project still has four lanes; a project error becomes a sanitized fallback report |
| `scripts/service-host.mjs` | Separately hosted built-in Task, Context, Judge or Catalog provider |
| `scripts/mathlib-search-service.mjs` | Optional HTTP Mathlib Search provider |
| `scripts/serve-observability.mjs` | Persistent observation/dashboard server, including report import and multi-root discovery |
| `scripts/analyze-experiment.mjs` | Offline reconstruction of an existing run; does not execute a new research experiment |
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
| `--timebox-ms` | `3600000`; positive finite execution-loop duration per project |
| `--bot-max-ms` | Defaults to run timebox; timer-safe integer of at least 2 ms; total Bot lifetime including startup/discovery/preparation |
| `--selection-timeout-ms` | Defaults to min(300000, Bot maximum); timer-safe integer of at least 2 ms, clamped to Bot/run deadline |
| `--execution-timeout-ms` | Defaults to Bot maximum; timer-safe integer of at least 2 ms; active Execution cap intersects Task/Bot/run limits |
| `--turn-timeout-ms` | `540000`; per-turn settling bound, separate from the overall project deadline |
| `--checker-timeout-ms` | `120000`; timer-safe positive integer for each Lean source diagnostic process, subject to the locked checker timeout |
| `--task-model` | Rejected; the benchmark has one flat Mission Task model |
| `--normal-flow` | Rejected; the flat Mission Task contract is always used |
| `--provider` | `PI_PROVIDER`, then `NUROUTER_PI_PROVIDER`, otherwise `gpt_proxy`; empty values are rejected |
| `--model` | `PI_MODEL`, then `NUROUTER_PI_MODEL`, otherwise `gpt-6.1-sol`; empty values are rejected |
| `--experiment-root` | `experiments` |
| `--experiment-dir` | `experiments/putnambench-runs/run-<startup timestamp>`; resolved path must be strictly below experiment root |
| `--report-dir` | `reports/putnambench-runs/run-<startup timestamp>` |
| `--observability-host` | `0.0.0.0` when the benchmark launches its observer |
| `--observability-port` | `8787` |
| `--observability-advertise-host` | Absent: attempt `tailscale ip -4`, otherwise no override |
| `--observability-metadata` | `SWARMENV_OBSERVABILITY_METADATA`, otherwise look under the experiment root |
| `--help`, `-h` | Print usage and exit before requiring benchmark arguments |

Unknown options throw. Numeric flags are converted with `Number`; only the explicit validations above and downstream constructors apply. The CLI has no Sandbox flags: it builds its required OpenSandbox configuration from `SWARMENV_SANDBOX_ENABLED` (the literal string `true` enables it), `SWARMENV_SANDBOX_PROVIDER` (default `opensandbox`), `SWARMENV_SANDBOX_IMAGE`, `SWARMENV_OPENSANDBOX_URL`, optional endpoint/Bridge host variables and the selected provider settings. A disabled or non-OpenSandbox deployment is rejected. Stop-on-solve, custom adapters and the remaining Runtime timers are programmatic options.

The exported runner and CLI both construct the flat Mission Task model with four independent Core loops per project. The old parallel-mode selector is retired and an explicit request for it fails. `projectParallelism` controls how many separate projects run at the same time. Reports record the actual settings and observed Core/Execution overlap.

## 3. Locked input and environment

`loadBenchmarkConfig` requires exactly twelve problem entries, checks duplicate IDs and safe ID spelling, reads each source file, rejects paths escaping the checkout and input filenames containing `solution` or `candidate`, and requires an unsolved `sorry` marker. The CLI requires HEAD to match the full `putnambench_commit` at the repository root. Each source must be a regular file at its configured path without symlink substitution, and its worktree bytes must equal the regular-file Git blob from that commit. Source SHA-256 covers the exact bytes, including BOM and trailing newlines. The timed runner repeats this verification for the selected problem and rejects source, hash, or path arguments that differ from the verified fixture. It chooses the checkout's `lean4/` project if its `lean-toolchain` exists, otherwise the checkout root. These checks apply before selecting a single pilot problem.

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

Direct Pi routing uses `PI_PROVIDER` and `PI_MODEL` (with the older `NUROUTER_PI_*` names retained as compatibility fallbacks). The CLI defaults to the native `gpt_proxy` provider and direct `pi`; `PI_GPT_PROXY_BASE_URL` and secret `PI_GPT_PROXY_API_KEY` configure the compatible endpoint through the image models catalog. The launcher can read only the selected provider's endpoint/key from `models.json` in `PI_CODING_AGENT_DIR` or the default Pi agent directory, with the explicit provider environment variables taking precedence. The route resolver also accepts `kimi_proxy`, `openai`, `openai-codex` and the NuRouter-specific `kimi` route when explicitly selected; the deployment must supply a compatible command/image. Direct library calls do not inherit the CLI's fallback provider/model values. [Agent Core](01-agent-core.md) gives the full argv and RPC behavior.

## 4. Startup in execution order

1. **Record the launch.** Resolve directories, load locked inputs and record repository commit/dirty state. Write `metadata/experiment.json` with environment, protocol, provider/model, paths and start time. The CLI's `experiment_id` is the experiment directory basename; project `runId` is separately generated unless explicitly provided.
2. **Attach an observer.** Reuse a healthy metadata-declared server. Without an explicit metadata override, the server must use the expected observation database. An explicitly configured unavailable server causes an error. Otherwise spawn a detached observer, poll health up to 80 times at 250 ms intervals, then open the observation database and write `metadata/observability.json`. The observer is persistent and is not stopped at project cleanup.
3. **Create project storage.** The runner creates project SQLite, Workspace, report and log directories. Task, Context and Judge share the project database. Unless an Observation Store is injected, observation tables can live in that same connection. CLI runs inject the separate persistent store.
4. **Construct services.** Wire Context to Task Service, Judge health lookup to Task Service, and Judge dependency events back to Task Service. Create LeanChecker unless a checker was injected. Build the Agent-facing capability registry from local providers, configured HTTP endpoints and optional bundles. Keep a second local registry/router for synchronous owner/controller transactions.
   The checked-in `services/builtin/compose.yaml` starts Task, Context, Judge and Catalog as separate HTTP processes with independent stateful volumes; the runner still uses in-process services unless its deployment supplies external endpoints and an integration path for controller transactions.
5. **Resolve Mathlib Search.** Prefer a configured external URL/provider. Otherwise, if the pinned project's Mathlib source tree exists, register the local source provider. Missing source in a synthetic fixture leaves the capability absent; admission can then reject a Task needing it. Registration does not create a hidden alternative search service.
6. **Create the responsibility.** The runner creates a Mission and its first/shared proof Task. The Task contains the goal, instructions, completion contract, source hash and formal source in Workspace metadata, including proof-relevant Material consumption and a final checked Workspace artifact. Full instruction variants appear in [08](08-prompts.md).
7. **Optional preparation hook.** Await `prepareProject` for deterministic callers to seed Tasks through the same services before Agent startup. Normal benchmark code does not pre-create a fixed research Task pool.
8. **Create four Core environments.** Each Core receives an adapter, one-worker Runtime, shared project Workspace root, lane-specific Bridge, raw Agent log and sanitized observation hooks. Flat profiles omit Runtime's duplicate `task_finish`/`task_finish(outcome=blocked)` aliases. Sandbox tools are exposed only when Sandbox is enabled. Start Bridges and pass their endpoint/token environment into the respective Agent process.
9. **Create supervisors and start the clock.** Build Task Controller and four identity loops, subscribe to post-commit Task events, reconcile readiness and start loop supervisors. Reset the parallelism tracker at execution-loop start. Flat Runtime deadlines use this common run deadline. The Pi Session is launched when a loop actually needs it.

Failures while creating Core environments stop any created Sessions, shut down Runtimes, stop Bridges and close Task Service before rethrowing. Earlier setup failures are not equivalent to a completed project; the batch wrapper can create a fallback report, while the single-project CLI propagates the error.

## 5. Programmatic options and timer precedence

The exported runner accepts the options below in addition to CLI-equivalent `provider`, `model`, `experimentDir`, `reportDir`, `projectParallelism`, `timeboxMs` and `turnTimeoutMs`. Passing an option is configuration, not authorization to spend resources.

| Option | Default and role |
|---|---|
| `taskModel`, `taskOriented` | Removed; supplying either property is rejected, regardless of its value |
| `normalFlow` | No longer selects behavior; the runner fixes normal flow to `true` and does not read this option |
| `runId`, `startedAt` | Random UUID and current time for setup identity/tracker; active-loop timing is set after setup |
| `repositoryCommit`, `repositoryWorktreeDirty` | `null` unless caller/CLI supplies them; report provenance |
| `stopOnSolved` | Only literal `true` enables early exit; otherwise continue toward the deadline |
| `taskTimeboxMs` | Flat initial Task timebox: run timebox unless supplied |
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
| `command`, `account`, `group`, `extensionPath` | Override command and routing; runner command defaults to `pi`. Top-level `extensionPath` applies to the local compatibility adapter; registered OpenSandbox Bots reject custom Service-tool extensions and use four native tools |
| `agentAdapterFactory` | Caller-supplied compatibility adapter factory when an OpenSandbox manager is not selected; used for controlled tests, not an extra Agent-selection process |
| `observationStore` | Inject persistent observation store; otherwise project-local storage |
| `prepareProject` | Awaited preparation hook after initial Task creation and before Core construction |
| `serviceRegistry` | Inject full Agent-facing registry; skips built-in bundle and Mathlib auto-registration; local owner/controller router still exists |
| `serviceEndpoints` | Built-in provider endpoint/token map; otherwise use `SWARMENV_{TASK,CONTEXT,JUDGE,CATALOG}_SERVICE_URL` and corresponding `_TOKEN` variables |
| `customServices` | Additional registered providers when building the default registry |
| `serviceBundles`, `serviceBundleRoot` | Bundle directories and optional containing-root constraint; relative bundle paths resolve against the working directory, not against `serviceBundleRoot`. Load manifest plus documentation. |
| `serviceBundleEndpoints`, `serviceBundleAdapters` | Override per-service HTTP endpoint or supply an adapter; unsupported transport without adapter throws |
| `mathlibSearchUrl`, `mathlibSearchToken` | External search URL/token, otherwise `SWARMENV_MATHLIB_SEARCH_URL` / `_TOKEN` |
| `mathlibSearchSourceRoot` | Otherwise `MATHLIB_SEARCH_SOURCE_ROOT` or `<lean project>/.lake/packages/mathlib/Mathlib` |
| `mathlibRevision`, `leanVersion` | Otherwise the fixture's pinned revision/toolchain; provider metadata |
| `sandbox` | Enabled only when `sandbox.enabled === true`; exact settings below |
| `requireThirdPartySandbox` | CLI sets `true`: require enabled OpenSandbox. Direct library calls can omit it for explicitly configured compatibility fixtures |

Finish cleanup uses Runtime defaults `finishCleanupRetryMs=1000` and `maxFinishCleanupRetries=3`; retries back off exponentially up to 30 seconds, preserve ownership on exhaustion, and are cancelled on shutdown. The runner does not pass every Runtime constructor option through. For example `maxRecoveryAttempts=1`, `maxCompactions=3`, `handoffWindowRatio=0.8` and compaction checkpoint reminders use Runtime defaults here; assigning similarly named fields on runner options does not configure them.

Sandbox settings are `image` (required when enabled), provider `opensandbox`, `commandTimeoutMs=120000`, `maxOutputBytes=1048576`, and `preflightTimeoutMs=20000`. The `run-putnambench-benchmark.mjs` CLI sets `requireThirdPartySandbox=true` and rejects a disabled sandbox or any provider other than OpenSandbox before creating Tasks or Agents. The OpenSandbox provider additionally accepts `lifecycleBaseUrl` (or `SWARMENV_OPENSANDBOX_URL`), optional `endpointHost` (or `SWARMENV_OPENSANDBOX_ENDPOINT_HOST` when a local Docker server advertises an internal address that must be reached through its published host port), `apiKey`/`OPEN_SANDBOX_API_KEY`, `execdToken`/`SWARMENV_EXECD_ACCESS_TOKEN`, `resourceLimits`, `environment`, `agentEnvironment`, `secretEnvironment`, `volumes`, `execdPort=44772`, `workerPort=44100`, `workerCommand`, `foregroundSession=false`, `bridgeHost` and `bridgeUrl`. `bridgeUrl` is optional for loopback-only test doubles; when workers must call the controller Bridge over a provider network, bind `bridgeHost` to a reachable interface and set a public URL template such as `http://172.17.0.1:{port}`. `agentEnvironment` supplies explicitly allowed routing/version fields and the Bot's Bridge URL. Registered Bot launch strips Service discovery/individual Service URLs and global Service bearer tokens; the child receives its scoped Bridge token and, for timed runs, only a revocable local model-gateway credential (see the metered model section below). Worker/controller secrets remain outside the child environment. A fresh provider Sandbox belongs to each Bot before any E exists; the same Sandbox and Pi continue through its sole successful take. The guest project `/workspace/project` starts empty and protected, and take copies the complete pinned public tree before activation/grant. Pi private session/cache state lives under `/workspace/runtime`; no host Workspace is mounted. The image recipe at [services/opensandbox-agent/Dockerfile](../../services/opensandbox-agent/Dockerfile) carries the pinned Pi package, direct `gpt_proxy` model catalog, Bash, Git, CLI and the versioned system/four-skill resources. Repository extension code is present for compatibility but is disabled for registered Bots. The local gateway token and base URL are supplied at runtime through Pi environment interpolation; no provider binary or credential is baked into the image. [Workspace and continuity](05-workspace-continuity.md) describes the container boundaries and detached-job timeout limitation. The shipped Dockerfiles for HTTP services are deployment recipes; they are not a preconfigured Lean/Sandbox experiment environment.

Sandbox preflight precedes the experiment row. Scoped provider reconciliation runs after Core Runtime construction and before any Bot launch, with the experiment already registered. Unattributable preflight events are omitted; registered reconciliation and subsequent lifecycle evidence are recorded. A failed preflight is still surfaced before any Task or Agent is created.

## 6. The active outer loop

Each identity loop owns discovery, Agent choice, take/bind and waiting for its Execution to release. The runner's `onTake` callback binds the existing Pi Session with no additional initial prompt. A continuation promise waits for settling, then keeps sending bound turns while that Execution is `RUNNING`. `turnInFlight`, `boundTurnPromise`, current Session identity and release checks prevent an ordinary repair tick from opening a second overlapping turn.

Task mutations notify subscribers after commit. The Controller reconciles readiness and signals idle identities; the outer loop wakes on that event or its five-second fallback. It samples available Tasks and physical idle Cores, releases terminal Executions, reconciles Controller state and starts an eligible bound follow-up. It does not choose a proof route. A persisted accepted Mission blocks new research admission immediately. The acceptance callback and outer-loop fallback enter the same bounded closeout, stop discovery/Controller, and notify existing active Executions.

Closeout ends at the earlier original Mission deadline or acceptance plus `missionCloseoutMs` (default 30 seconds). Active Executions may save, publish and finish under their existing hard deadlines; when none remain, cleanup starts immediately. Already accepted work remains tracked until it actually settles. The historical `stopOnSolved` option does not create a second acceptance policy or permit research beyond this closeout. [03](03-mission-task.md) describes persisted authority and callback retry ordering.

Heartbeat runs only for a durable `RUNNING` Execution with an active Runtime process. It avoids changing versions during `CREATED`→`RUNNING` preparation. Watchdog and Execution-timeout sweeps are separately serialized so a slow sweep cannot overlap itself. Their errors are recorded, and recovery/timeouts can wake identities. [02](02-execution.md) describes which conditions trigger fencing, restart and continuation.

`runTurn` bounds readiness and prompt RPC acknowledgement to at most 30 seconds, then uses the requested turn timeout for settling unless the tool response was already handled. Discovery settling uses at least 180 seconds. Some bound-continuation calls default to 30 seconds when a direct library caller omitted `turnTimeoutMs`, even though the outer runner's local default is nine minutes. These distinct bounds must not be collapsed into a single timeout setting.

## 7. Shutdown and report behavior

Shutdown runs after the active loop exits:

1. Clear heartbeat/watchdog/timeout timers and retain their in-flight promises for cleanup; do not join them before issuing stop.
2. Unsubscribe Task events, stop new wake requests, abort/stop identity loops, and begin Controller stop. A suspended Controller cannot subsequently signal another Bot.
3. Mark every Core stopping. Concurrently stop Runtime, Bridge transport, Sessions and startup; join turns and pending handlers. Runtime persists closing intent before joining startup and cleans a late arriving Session. Bridge no longer waits for deferred lifecycle work before closing HTTP admission.
4. All joins share `cleanupGraceMs` (default 30 seconds) measured from the start of finalization. Each pending component receives a typed timeout and, where applicable, a Core ID. A failed sibling does not bypass other pending joins. There are no extra per-turn or per-Core grace periods. Owner/capacity release remains conditional on Runtime-confirmed physical stop, not the reporting timeout.
5. Read only an already recorded Mission submission within the remaining allowance; never create a synthetic operator verdict from report fields. Build/write the report and final observations. Pending cleanup makes the run invalid and is recorded explicitly. Keep the shared authority database open until tracked late cleanup settles; otherwise close it after writing. The CLI writes `aggregate-report.json` and experiment metadata. Fresh-process reconciliation uses durable registered Bot create/cleanup state and scoped provider evidence; it does not revive private Pi sessions.

The Mission timebox is fixed before project setup, including artifact and environment preflight; entering the active loop does not reset that absolute deadline. The report separately measures the active-loop elapsed interval. Polling and awaited orchestration use the remaining Mission allowance. A shared cleanup grace and any retained unknown external-operation tails can extend wall-clock completion, so `timeboxMs` is not a guarantee that all host processes have already disappeared. A code exception still runs `finally` cleanup but can propagate before a normal project report is built. Batch execution catches such errors per problem and writes an invalid `project_runner_error` report; a direct single-project call does not receive that batch fallback. Abrupt process/host termination is not a guaranteed complete-report path.

## 8. On-disk outputs

| Location | Contents and interpretation |
|---|---|
| `<experiment>/metadata/experiment.json` | CLI launch/protocol snapshot; final status/counts only written if the CLI reaches finalization |
| `<experiment>/metadata/observability.json` | Persistent observer address/database metadata |
| `<experiment>/state/projects/<problem>/project.sqlite` | Task, Bot and Execution records, Mission coordination, local Workspace request state and observations |
| `<experiment>/state/projects/<problem>/context.sqlite` | Immutable Material, corrections, usage and Context receipts |
| `<experiment>/state/projects/<problem>/judge.sqlite` | Diagnostic Judge requests, checker preflights and results |
| `<experiment>/workspaces/projects/<problem>/<execution>/` | Private Execution Workspace and lineage metadata; reusable Core process directories also live below the project Workspace root |
| `<experiment>/state/projects/<problem>/judge-work/` | Independent checker work products |
| `<experiment>/logs/projects/<problem>/agents/core-N.ndjson` | Private raw Pi transport evidence, including repository-sent prompt messages |
| `<experiment>/logs/projects/<problem>/services/`, `bridge/`, `runtime/`, `judge/` | Component evidence with the visibility/sanitization of each logger |
| `<experiment root>/.observability/observability.sqlite` | Default persistent CLI observation projection |
| `<report root>/<problem>/report.json`, `<report root>/aggregate-report.json` | Exported reports; counts and projections are explained in [06](06-observability-experiments.md) |

The top-level ignored `experiments/` raw evidence directory and committed `docs/experiments/` report directory have different purposes. Raw conversations and proof source are not copied into the implementation manual.

## 9. Fixture, service and frontend boundaries

Deterministic library tests use in-process adapters and explicit bounded fixtures; they are separate from the production benchmark CLI and do not represent a live provider run.

`--real-agent` probes local Node/NuRouter/Pi/Lean/Lake commands and provider/model routing before launch. It returns `BLOCKED` for missing prerequisites and `FAILED_TO_LAUNCH` for missing root/input. The real-probe environment metadata fields are `SWARMENV_IMPLEMENTATION_COMMIT`, `SWARMENV_WORKTREE_DIRTY`, `SWARMENV_WORKTREE_STATUS`, `SWARMENV_TIMEBOX_MS`, `SWARMENV_PUTNAMBENCH_ROOT`; they record caller context and do not themselves prove it.

Built-in and Mathlib service launchers use HTTP manifests, role/binding enforcement and optional bearer tokens. Each handles SIGINT/SIGTERM shutdown. The normal runner uses service-owned separate state with co-located synchronous lifecycle APIs. Independently hosted HTTP Context/Judge mutation without that authority composition fails closed. The built-in image installs production dependencies with scripts disabled; it does not install Lean. Mathlib Search needs an external upstream or a mounted source tree. Full host settings and request behavior are in [04](04-services.md).

The dashboard's maintained source is `src/observability/client/`; Vite builds it to `src/observability/public/` with `app.js` and `styles.css` names. The observer serves these generated assets. Development proxies `/api` to `127.0.0.1:8787`. `components.json` configures the UI component generator, not runtime scheduling. `package.json` pins the Pi package and records Node's minimum version; `package-lock.json` pins dependency resolution. `npm test` uses serial Node tests. Its pretest hook first runs the offline `npm run docs:check` gate, then builds the UI. `npm run docs:generate` refreshes the prompt, API/storage and source-fingerprint references; `docs:check` only verifies them and local links.

## Source and verification map

Sources: [benchmark CLI](../../scripts/run-putnambench-benchmark.mjs), [runner](../../src/benchmark/putnam-runner.js), [locked config](../../config/putnambench-12.json), [parallelism tracker](../../src/benchmark/parallelism.js), [observer launcher](../../scripts/serve-observability.mjs), [service launcher](../../scripts/service-host.mjs), [search launcher](../../scripts/mathlib-search-service.mjs), [Vite config](../../src/observability/vite.config.js), [package scripts](../../package.json).

Relevant deterministic tests: [flat benchmark CLI](../../test/flat-only-cli.test.js), [orchestration](../../test/orchestration-roles.test.js), [parallelism](../../test/parallelism.test.js), [observation server](../../test/observability-server.test.js). Real provider/Lean acceptance still requires separate version-bound evidence.

### Phase 02 migration and comparison labels

The discovery path gives each Core the same autonomous local-Task selection instructions. Historical reports preserve the old labels and actual actions. New reports record the fixed per-project Core count, project-level parallelism, and observed proposal, take and parallel execution events.

### Registered Bot startup and cleanup accounting

The Runner's `initialBotStaggerMs` option sets the interval between first-Bot eligibility times. Its programmatic default is zero. The formal CLI defaults `--initial-bot-stagger-ms` to 60,000 ms and accepts a nonnegative timer-safe integer. Explicit zero is valid. The default staggered four-Core profile uses 60,000 ms, so Core 1 is eligible at orchestration start and Cores 2–4 at 60, 120 and 180 seconds later. These are earliest times, subject to ordinary runtime admission and operating delays. The waiting time belongs to the existing run timebox. No Bot or sandbox is created for a delayed Core before eligibility. No Core waits for another Core to take or finish, and successors follow ordinary cleanup and bounded rediscovery without first-start staggering. Mission acceptance, run stop or deadline prevent first launches still waiting.

Each Core startup now calls `Runtime.startBot` with the shared Mission, its Core ID, `selectionTimeoutMs` (default min(300,000 ms, Bot maximum)), `maxLifetimeMs` from `botMaxMs` (default run timebox), and readiness timeout (`turnTimeoutMs`, default 30,000 ms). The adapter factory receives the newly persisted Bot and provider-ID callback; the Bridge rotates identity/token before worker launch. Core records retain `botId` for discovery-result interpretation. After a durable selection-budget exit or unbound Bot hard-budget stop, the identity loop waits for a relevant public change or a bounded fresh-discovery fallback, normally 30 seconds. This fallback requires an open Mission with time remaining and a Core whose prior Bot resources have closed. An empty turn follows ordinary discovery-incomplete handling. Cleanup is complete only when active processes, retained Sessions, pending Bot IDs and adapter/startup cleanup are all empty. These checks use the shared whole-run cleanup grace above; no separate per-join grace extends it.

The run manifest and aggregate protocol record the configured interval as `initial_bot_stagger_ms`. The run manifest, aggregate protocol and project report record Bot, selection and Execution maximums separately in milliseconds. A 30-minute single-project configuration can set `--timebox-ms 1800000 --bot-max-ms 600000 --initial-bot-stagger-ms 60000 --selection-timeout-ms 120000`; this is configuration syntax, not evidence of an executed or accepted experiment. Existing finalization grace is additional to the research timebox and retained cleanup remains visible on failure.

The Agent image requires util-linux `setpriv` and the trusted project helper adjacent to the worker. Guest Pi cwd is `/workspace/project`; its Session and expanded model catalog live under `/workspace/runtime`. The worker must run as root to reserve/protect those directories and drop Pi to UID/GID 10001. Mounts must not populate the new project or replace protected parent directories. These image changes require rebuilding the pinned experiment image before provider preflight; the prior image tag alone is not new-code evidence.


The registered Bot adapter always uses the immutable `bot-contract/system.txt` addendum and four explicit skill files from the image. `sandbox.systemPrompt` and `sandbox.extensionPath` are no longer selected by the benchmark runner. The direct adapter rejects alternate system text or Service-tool extensions. Rebuild the image for changes to these files: their expected SHA-256 values are transmitted at worker startup and stale images fail before Pi launches. The Dockerfile normalizes resource modes to root-writable, other-readable files and traversable directories. The raw version manifest records protocol version, body/resource hashes, skill descriptors and native tool names. No provider/model configuration is changed by this prompt migration; live provider compatibility must be verified separately.

Worker startup claims the single start slot before awaiting resource reads. All five unique resources must match the supported protocol and pinned hashes, be root-owned/readable to the Bot, and sit under protected traversable parent directories. The worker returns a verified protocol/resource receipt. Manager validates this receipt before publishing started state, so an older worker that ignores resources is rejected and the Bot lifecycle cleans up its Sandbox. Concurrent starts cannot launch a second Pi.


## Final-tree acceptance configuration

A positive-duration Putnam run requires `final_tree_checker` in its trusted host configuration. It contains the fixed checker identity, toolchain/library/exporter paths and `artifactLock`; the loader verifies full mounted artifacts, pinned sources, isolated Lean version and actual cgroup limits before provider creation or model startup. The lock-generating tool takes the trusted build configuration and source checkout paths, verifies the fixed source revisions, and stores only the local deployment lock at the requested local path. A changed verifier, harness, dependency or executable requires regenerating and validating the lock. The final environment identity includes its digest. The diagnostic source checker keeps its separate fixture configuration. Programmatic controlled tests may inject a final-tree adapter explicitly. The CLI accepts the locked deployment.

The trusted `final_tree_checker.timeoutMs` field defaults to 120,000 ms and participates in the artifact lock. Renew the lock after changing it. Mission coordination takes the verifier timeout and clips it to the remaining Mission deadline. The source diagnostic process bound is the smaller of `checkerTimeoutMs` and the locked timeout when using the locked adapter. The launch manifest and aggregate protocol record the resolved source and final bounds as `source_checker_timeout_ms` and `final_tree_checker_timeout_ms`; the project report includes the effective source process bound under `judge_check_budget.process_timeout_ms` and the verified final-tree bound under `run.final_tree_checker.timeout_ms`.

`mission_coordination_permissions` is an explicit allowlist from `unsupersede`, `task_cancel`, `task_dependency_replace`, `mission_submit`; omitted means no grants. Runtime freezes the list at Bot registration. The research Bot cannot change it. The runner always stops new research after trusted Mission acceptance; an older stop-on-solved flag cannot override the accepted Mission lifecycle. `maxInfrastructureRetries` caps final acceptance infrastructure retries and defaults to zero; exact scientific outcomes reuse their original result. Per-Bot, selection, E and run timeboxes continue to bound work independently.

## Host-gated model access and concrete network deployment

The positive-duration benchmark CLI requires a host-only Responses endpoint and credential and resolves them from the selected provider settings and host environment. The library Runner requires an injected `modelUpstream` object; gateway construction validates its fixed endpoint but trusts its host-supplied headers, allowing controlled local endpoints without authentication. It does not independently verify that those headers authenticate to a real provider. It passes only a gateway URL and a random revocable Bot credential to Pi. The selected direct Pi command, provider, Responses API, model and credential placeholders must match the Agent image catalog. Zero-duration diagnostics can keep their explicitly injected compatibility composition.

With no `model_budget`, the gateway runs in time-bounded mode. Optional trusted `model_gateway` configuration (or `options.modelGateway`) sets `host`, `advertiseHost`, `port`, `requestTimeoutMs` and `maxOutputTokens`. The default bind host is the Sandbox Bridge bind host (loopback if omitted), and the public Bridge hostname is used for advertising when supplied. The port is ephemeral by default. Each upstream POST is limited to 120,000 ms and a 32,768-token requested output cap by default. The hard cutoff is set at admission from the earliest applicable request, Mission, Bot, selection, Execution and closeout deadline, and can tighten during the request. For Execution work and closeout, the gateway checks durable Bot ownership, Execution state and fence at the current lease deadline or at most once a second. A heartbeat that extends the same lease keeps the same upstream request running. Expiration, loss of authority or failure to read Task state cancels it. Revoking the Bot credential aborts its active requests immediately. The attempt keeps its original hard deadline in SQLite and records uncertain usage if the upstream stream ends without trusted terminal usage. This mode needs no total currency allowance, rate, or upstream retry accounting contract. Local entry times and cancellation bound the work this process admits and waits for. They do not establish upstream cancellation or a maximum bill.

The gateway fixes endpoint, model and optional service tier, disables redirects, background execution and server-side conversation references, and accepts local text/function tool traffic. It refuses hosted tools and remote tool-schema references. Pi may replay an upstream reasoning item with `content: []` alongside its summary and encrypted content; this empty field is accepted unchanged. Nonempty reasoning content and unknown fields remain rejected. Compatibility is tested through two actual Pi/SSE turns so provider output must survive the next request, not only the first request. Current Task authority determines whether the Bot can dispatch in selection, work or closeout. Under that authority, the gateway records the attempt in `model-budget.sqlite` before dispatch and preserves its stable ID for receipt replay. A different payload cannot reuse the same ID, and an unidentified request is a separate upstream attempt. Bot stop revokes its token before Pi cleanup. Run cleanup aborts active streams and joins the gateway before closing its private database.

In time-bounded mode, the report's `model_budget` field identifies `mode: time_bounded`, policy digest, the request/output limits and observed usage. It reports how many attempts supplied terminal usage and how many are pending or unknown. Token totals cover only valid observed usage. With no observed usage they are null. Costs and cost units are null. Stored attempts follow the same rule and never record an assumed financial reservation. Counts reflect persisted ledger state: rows left pending by a process crash remain pending in the persisted counts; retry admission rejects an elapsed pending request as `request_unknown` without rewriting that row. Neither the persisted state nor a local deadline proves whether the upstream completed or billed the request.

The optional `model_budget` (or `options.modelBudget`) selects financial mode. It still requires `contract` with `maxInputTokens`, `maxOutputTokens`, `maxFanout`, `inputCostPerToken`, `outputCostPerToken`, `fixedAttemptCost`, `costUnit`, `requestTimeoutMs` and `boundEvidence`. Rates use integer units of the named currency or billing unit and bounds cover retry fanout. The Mission, Bot, selection and closeout `limits` each explicitly bound requests, input/output tokens and cost. Mission work preserves the closeout reserve. Admission reserves worst-case token and cost exposure before dispatch and durable policy pins prevent a changed policy within the same ledger. Trusted terminal usage can settle the provable difference. Unconfirmed completion keeps the upper bound. Reports keep the existing policy digest, limits, billing unit and accounted upper bounds.

Timed runs also require `sandbox_network.mode = "local-docker"` (or the equivalent `options.sandbox.networkIsolation`). The supported deployment uses local Docker bridge containers and operator access to Docker plus `sudo -n`, `nsenter`, `mount` and native `nft`. It does not elevate the Bot or worker capabilities. Before Pi starts, the adapter verifies the container's canonical Mission/Bot/resource labels, process/cgroup identity and network namespace. It pins that namespace in a root-private temporary mount and confines all firewall changes to the verified pin. The rules use the trusted worker's UID in the container user namespace and verify its immutable host mapping; both are recorded. The native nftables inet output chain uses priority -150 and is read back exactly. IPv4 permits only the fixed Bridge and model-gateway address/port pairs; IPv6 and all other Bot-originated traffic, including local management ports, are rejected. Both destinations must be concrete non-loopback IPv4 URLs; DNS and additional external destinations are unsupported in this deployment. Root provider control remains separate. The pin is unmounted after policy readback; the policy remains with the sandbox namespace and vanishes with it. Any missing capability, mismatch or failed verification blocks Pi startup and enters normal sandbox cleanup.

The run uses one original absolute deadline through setup, scheduling, model admission and final acceptance. Initialization cannot silently extend the timebox. Sandbox creation carries a finite Provider TTL as an additional cleanup bound, while Runtime's Bot/Execution timers and explicit confirmed deletion remain authoritative for Core release. A TTL timestamp alone is not proof of deletion.

Use `SIGINT` or `SIGTERM` on the benchmark CLI process to request a graceful stop. An accepted stop wakes orchestration and ends new model admission. Interrupted projects report `stop_reason: operator_stop` and remain invalid. An interruption while waiting for the persistent observer to become healthy allows the CLI to write the stop report without a live observation connection. Project reports preserve evidence already recorded. Once a project fixes its outcome, a signal during cleanup or report output leaves the outcome intact. The aggregate, experiment metadata and CLI exit status all use the project outcomes. When at least one project was interrupted, metadata records `operator_stopped` and the signal, and the CLI exits with status 130 for `SIGINT` or 143 for `SIGTERM` after cleanup. If cleanup is still pending after its grace, the CLI writes the report and holds the private stores until cleanup confirms settlement.

Timed runs also require `sandbox_disk` (or `options.sandbox.diskIsolation`) with `mode = "local-docker-tmpfs-landlock"` and explicit integer `bytes` and `inodes`. The host accepts 16 MiB to 4 GiB in 4096-byte increments and 1,024 to 262,144 inodes. The operator needs local Docker access plus passwordless `sudo` for the Python namespace helper. The kernel needs Landlock ABI 5 or later. Configuration alone is insufficient. The worker must return exact byte and inode counts and the SHA-256 of the same image model-catalog bytes it uses to configure Pi. Startup fails if the worker omits either attestation. [Execution](02-execution.md)

Timed runs expose the pinned co-located Task/Context/Judge/catalog and local Mathlib search composition. A remote built-in endpoint, arbitrary custom registry/service/bundle or HTTP Mathlib provider rejects positive-duration startup: readiness is not a verified finite billing contract. Explicit zero-duration diagnostics can test these adapters; that does not approve them for this experiment.

### Owner-local manual Mission review

For a Mission with no executable checker, trusted local composition may pass `manualReview: { checkerVersion, environmentRef, timeoutMs }` to `createMissionCoordination` or the submission store. Use an owner-private database connection, set the fixed acceptance check to `manual-operator` with the same version and environment, and set a finite positive wait. The Mission run deadline still caps the wait. This is a separate configuration choice. Timed PutnamBench runs still require their locked executable checker.

Run `node scripts/review-mission.mjs show DB MISSION SUBMISSION` as the database owner to retrieve the fixed manifest. After reviewing it, run `node scripts/review-mission.mjs decide DB MISSION SUBMISSION FINGERPRINT PASS|FAIL REQUEST_ID "REASON"`. Use a canonical directory readable only by its owner and an owner-private regular database file and sidecars. The command rejects symbolic links and opens the existing database only. It is absent from the Bot/Bridge catalog. Keep review output with owner-private audit evidence.

The review command displays identities and acceptance criteria. To inspect the fixed Workspace bytes, open the trusted Workspace repository for the manifest's `workspace_id`. Check that `git rev-parse "$COMMIT^{tree}"` equals the displayed `git_tree`, then read blobs with `git show "$COMMIT:$PATH_IN_WORKSPACE"`. Use the displayed commit throughout the review. A trusted in-process operator can also call `MissionWorkspace.exportRevision` with the displayed revision and verify its returned commit, tree and content hash before reading `files`. Resolve each displayed Material with the owner-side Context service's exact `getMaterial(materialId, { verifyIntegrity: true })` and check the Mission, version and content hash before reviewing its body. Use the decision manifest's captured relation version, dispute state and active successor IDs when evaluating the submission because live correction state can change after admission.

### Local checker admission budgets

`judge_mission_budget` (or `options.judgeMissionBudget`) accepts trusted `maxRequests` and `maxConcurrent` values, defaulting to 20 and 2. A newly admitted request reserves at most one preflight and one source process. The project report's `judge_check_budget` records configured limits, admitted and active requests, retries, cached request aliases, launches by phase and the aggregate bound of twice the request cap times the diagnostic process timeout. The bound describes capped process execution time, with cleanup wait reported separately. Exact same-ID replays do not increment a counter.

`mission_final_check_budget` accepts trusted `maxChecks` and `maxConcurrent`, defaulting to four and one. These govern the separate machine submission verifier. The report's `mission_final_check_budget` records configured and actual admissions. Both budgets retain unresolved active reservations across process restart. The normal benchmark shares each project Judge database across its four Cores. An explicitly configured merge policy is independent of final acceptance.

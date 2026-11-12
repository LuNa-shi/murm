# 07. Launch, configuration, the outer loop and finalization

This chapter describes how the repository actually composes a run. It covers the benchmark CLI and exported runner, the smaller fixture paths, optional service deployments and the UI build. Domain state transitions remain in [02](02-execution.md) and [03](03-mission-task.md); full prompt and tool bodies are in [08](08-prompts.md) and [10](10-service-api-reference.md).

## 1. Entry points and execution modes

| Entry | What it executes |
|---|---|
| `scripts/run-putnambench-benchmark.mjs` | Real benchmark launcher: validates locked input, creates run metadata/observer, invokes one project or a bounded batch, writes aggregate output |
| `runBenchmarkProject(problem, config, options)` | Four Core lanes for one problem; the caller can inject adapters/checkers for deterministic tests |
| `runBenchmarkBatch(problems, config, options)` | Worker pool across isolated projects; each project still has four lanes; a project error becomes a sanitized fallback report |
| `scripts/run-mvp-fixture.mjs` | Deterministic controlled fixture by default; `--real-agent` selects a real one-Core repair probe; `--keep` retains temporary evidence |
| `scripts/service-host.mjs` | Separately hosted built-in Task, Context, Judge or Catalog provider |
| `scripts/mathlib-search-service.mjs` | Optional HTTP Mathlib Search provider |
| `scripts/serve-observability.mjs` | Persistent observation/dashboard server, including report import and multi-root discovery |
| `scripts/analyze-experiment.mjs` | Offline reconstruction of an existing run; does not execute a new research experiment |
| `src/index.js` | Public JavaScript exports, including generic Runtime/SDK and compatibility fixture APIs |

These entry points have different contracts. The fixture's supplied invalid and repaired Candidates test an integration flow; they do not implement the benchmark's no-solution-input protocol or establish autonomous research ability.

A programmatic project call must supply at least one of `experimentDir` or `reportDir`: the implementation resolves `experimentDir ?? reportDir` as its experiment root, then uses `reportDir ?? <experiment root>/reports` for reports. Unlike the CLI, a bare library call does not invent a timestamped output directory. The caller must also pass the prepared problem/configuration expected by the runner; input validation by the CLI is not automatically repeated as a separate checkout-verification step inside `runBenchmarkProject`.

## 2. Benchmark CLI: every flag and its actual default

Arguments accept `--name value` or `--name=value`, except the boolean `--normal-flow`. The launcher first loads `.env` from the working directory, ignoring blank/comment lines and preserving existing environment values. Values are simple trimmed strings with surrounding quotes removed; this is not a general shell/dotenv interpreter.

| Flag | Default / behavior |
|---|---|
| `--problems` | Required JSON configuration path |
| `--putnambench-root` | Required locked PutnamBench checkout |
| `--problem` | Absent: run all configured problems; otherwise select one matching ID after validating the full configuration |
| `--cores` | `4`; CLI rejects any other value |
| `--project-parallelism` | `1`; positive integer; batch concurrency is capped at the problem count |
| `--timebox-ms` | `3600000`; positive finite execution-loop duration per project |
| `--turn-timeout-ms` | `540000`; per-turn settling bound, not the overall project deadline |
| `--parallel-mode` | `semantic`; accepts `direct`, `semantic`, `root-only` |
| `--task-model` | Rejected; the benchmark has one flat Mission Task model |
| `--normal-flow` | Rejected; the flat Mission Task contract is always used |
| `--provider` | `NUROUTER_PI_PROVIDER`; required |
| `--model` | `NUROUTER_PI_MODEL`; required |
| `--experiment-root` | `experiments` |
| `--experiment-dir` | `experiments/putnambench-runs/run-<startup timestamp>`; resolved path must be strictly below experiment root |
| `--report-dir` | `reports/putnambench-runs/run-<startup timestamp>` |
| `--observability-host` | `0.0.0.0` when the benchmark launches its observer |
| `--observability-port` | `8787` |
| `--observability-advertise-host` | Absent: attempt `tailscale ip -4`, otherwise no override |
| `--observability-metadata` | `SWARMENV_OBSERVABILITY_METADATA`, otherwise look under the experiment root |
| `--help`, `-h` | Print usage and exit before requiring benchmark arguments |

Unknown options throw. Numeric flags are converted with `Number`; only the explicit validations above and downstream constructors apply. The CLI does not have flags for Sandbox, stop-on-solve, custom adapters or all Runtime timers; those are programmatic options.

The exported runner and CLI both construct the flat Mission Task model. `parallelMode` remains a treatment choice (`direct`, `semantic` or `root-only`); it does not select a second Task model. Removed `taskModel` and `normalFlow` options are rejected by the CLI. Record the actual treatment and resource options rather than inferring them from historical names.

## 3. Locked input and environment

`loadBenchmarkConfig` requires exactly twelve problem entries, checks duplicate IDs and safe ID spelling, reads each source file, rejects paths escaping the checkout and input filenames containing `solution` or `candidate`, and requires an unsolved `sorry` marker. The CLI enables verification that the checkout HEAD equals `putnambench_commit`. Source SHA-256 values are calculated from the actual text. It chooses the checkout's `lean4/` project if its `lean-toolchain` exists, otherwise the checkout root. These checks apply before selecting a single pilot problem.

The checked-in [configuration](../../config/putnambench-12.json) pins:

| Field | Value at this baseline |
|---|---|
| PutnamBench commit | `a635813f5edf297d928f9bd5ef8324a26bdde09c` |
| Lean toolchain | `leanprover/lean4:v4.33.1` |
| Mathlib revision | `0df444a360eaa60ab8c11dca51a86af692955474` |
| Checker | `lean`, version `mvp-1` |
| Environment reference | `putnambench-lean4@a635813f5edf297d928f9bd5ef8324a26bdde09c` |
| Problems | 2025 B1/B4; 2024 B4/B5; 2023 B1/B4; 2022 B5/B6; 2021 B3/B5; 2020 B4; 2019 B6 |

These values identify this configuration; they are not proof that the local checker has already passed preflight. Judge performs its own environment checks. The input formalization is allowed to contain an unsolved marker; a submitted Candidate is a separate file/material and is checked against the Candidate policy.

Direct Pi routing uses `PI_PROVIDER` and `PI_MODEL` (with the older `NUROUTER_PI_*` names retained as compatibility fallbacks). Issue 119 defaults to the native `gpt_proxy` provider and direct `pi`; `PI_GPT_PROXY_BASE_URL` and secret `PI_GPT_PROXY_API_KEY` configure the compatible endpoint through the image models catalog. The compatibility adapter still accepts `openai`, `openai-codex` and `kimi` when explicitly selected. [Agent Core](01-agent-core.md) gives the full argv and RPC behavior.

## 4. Startup in execution order

1. **Record the launch.** Resolve directories, load locked inputs and record repository commit/dirty state. Write `metadata/experiment.json` with environment, protocol, provider/model, paths and start time. The CLI's `experiment_id` is the experiment directory basename; project `runId` is separately generated unless explicitly provided.
2. **Attach an observer.** Reuse a healthy metadata-declared server. Without an explicit metadata override, the server must use the expected observation database. An explicitly configured unavailable server causes an error. Otherwise spawn a detached observer, poll health up to 80 times at 250 ms intervals, then open the observation database and write `metadata/observability.json`. The observer is persistent and is not stopped at project cleanup.
3. **Create project storage.** The runner creates project SQLite, Workspace, report and log directories. Task, Context and Judge share the project database. Unless an Observation Store is injected, observation tables can live in that same connection. CLI runs inject the separate persistent store.
4. **Construct services.** Wire Context to Task Service, Judge health lookup to Task Service, and Judge dependency events back to Task Service. Create LeanChecker unless a checker was injected. Build the Agent-facing capability registry from local providers, configured HTTP endpoints and optional bundles. Keep a second local registry/router for synchronous owner/controller transactions.
   The checked-in `services/builtin/compose.yaml` starts Task, Context, Judge and Catalog as separate HTTP processes with independent stateful volumes; the runner still uses in-process services unless its deployment supplies external endpoints and an integration path for controller transactions.
5. **Resolve Mathlib Search.** Prefer a configured external URL/provider. Otherwise, if the pinned project's Mathlib source tree exists, register the local source provider. Missing source in a synthetic fixture leaves the capability absent; admission can then reject a Task needing it. Registration does not create a hidden alternative search service.
6. **Create the responsibility.** The runner creates a Mission and its first/shared proof Task. The Task contains the goal, instructions, completion contract, source hash and formal source in Workspace metadata, including proof-relevant Material consumption and a final checked Candidate. Full instruction variants appear in [08](08-prompts.md).
7. **Optional preparation hook.** Await `prepareProject` for deterministic callers to seed Tasks through the same services before Agent startup. Normal benchmark code does not pre-create a fixed research Task pool.
8. **Create four Core environments.** Each Core receives an adapter, one-worker Runtime, shared project Workspace root, lane-specific Bridge, raw Agent log and sanitized observation hooks. Flat profiles omit Runtime's duplicate `task_complete`/`task_block` aliases. Sandbox tools are exposed only when Sandbox is enabled. Start Bridges and pass their endpoint/token environment into the respective Agent process.
9. **Create supervisors and start the clock.** Build Task Controller and four identity loops, subscribe to post-commit Task events, reconcile readiness and start loop supervisors. Reset the parallelism tracker at execution-loop start. Flat Runtime deadlines use this common run deadline. The Pi Session is launched when a loop actually needs it.

Failures while creating Core environments stop any created Sessions, shut down Runtimes, stop Bridges and close Task Service before rethrowing. Earlier setup failures are not equivalent to a completed project; the batch wrapper can create a fallback report, while the single-project CLI propagates the error.

## 5. Programmatic options and timer precedence

The exported runner accepts the options below in addition to CLI-equivalent `provider`, `model`, `parallelMode`, `taskModel`, `normalFlow`, `experimentDir`, `reportDir`, `projectParallelism`, `timeboxMs` and `turnTimeoutMs`. Passing an option is configuration, not authorization to spend resources.

| Option | Default and role |
|---|---|
| `taskOriented` | `true` selects flat only when `taskModel` is absent |
| `runId`, `startedAt` | Random UUID and current time for setup identity/tracker; active-loop timing is set after setup |
| `repositoryCommit`, `repositoryWorktreeDirty` | `null` unless caller/CLI supplies them; report provenance |
| `stopOnSolved` | Only literal `true` enables early exit; otherwise continue toward the deadline |
| `taskTimeboxMs` | Flat initial Task timebox: run timebox unless supplied |
| `executionTimeoutMs` | Run timebox; Runtime owns the active Execution deadline |
| `handoffReminderMs` | Run `timeboxMs` minus `min(5 min, floor(timeboxMs/10))`, at least 1 ms. This default is not recalculated from an explicit `executionTimeoutMs` override; Runtime requires it below execution timeout. |
| `handoffTimeoutMs` | Identity-loop ownership wait: `max(executionTimeoutMs, 2 * turnTimeoutMs)` |
| `turnIntervalMs` | `1000`; bound continuation waits at most 100 ms before its next turn, while periodic scheduling also checks this interval |
| `pollMs` | `5000`; outer repair/observation wake fallback |
| `controllerShortlistLimit` | `16`; bounded claimable list passed to Controller/identity loops |
| `controllerSweepIntervalMs` | `0`; avoid a second Controller timer because the outer loop already repairs |
| `maxStartupAttempts` | `3`; identity-loop take/startup attempt budget |
| `maxTakeRescans` | Runner passes this key with default `1`, but `IdentityTaskLoop` consumes `maxClaimRescans`; this option is currently ineffective and the loop keeps its own default of one rescan. |
| `identityLoopIdleBackoffMs` | `5000`; fallback wake when no durable event arrives |
| `heartbeatMs`, `watchdogIntervalMs`, `executionTimeoutSweepMs` | Each `10000`; independent timers |
| `watchdogTimeoutMs` | Runtime default `120000`; productivity/recovery interpretation in [02](02-execution.md) |
| `identityLoopStopGraceMs` | `15000`; wait before continuing finalization with a recorded supervisor-stop timeout |
| `checker`, `leanCommand`, `checkerTimeoutMs` | Inject checker or use LeanChecker, command `lake`, timeout `120000` |
| `maxInfrastructureRetries` | Forwarded to JudgeService; see exact Judge defaults in [04](04-services.md) |
| `command`, `account`, `group`, `extensionPath` | Override adapter command, route identity and SwarmEnv extension location |
| `agentAdapterFactory` | Caller-supplied adapter factory; used for controlled tests, not an extra Agent-selection process |
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

The runner does not pass every Runtime constructor option through. For example `maxRecoveryAttempts=1`, `maxCompactions=3`, `handoffWindowRatio=0.8` and compaction checkpoint reminders use Runtime defaults here; assigning similarly named fields on runner options does not configure them.

Sandbox settings are `image` (required when enabled), optional `provider` (the compatibility default is `docker`; Issue 119 uses `opensandbox`), `commandTimeoutMs=120000`, `maxOutputBytes=1048576`, and `preflightTimeoutMs=20000`. The `run-putnambench-benchmark.mjs` CLI sets `requireThirdPartySandbox=true` and rejects a disabled sandbox or any provider other than OpenSandbox before creating Tasks or Agents; deterministic library fixtures must opt into their compatibility provider explicitly. The OpenSandbox provider additionally accepts `lifecycleBaseUrl` (or `SWARMENV_OPENSANDBOX_URL`), optional `endpointHost` (or `SWARMENV_OPENSANDBOX_ENDPOINT_HOST` when a local Docker server advertises an internal address that must be reached through its published host port), `apiKey`/`OPEN_SANDBOX_API_KEY`, `execdToken`/`SWARMENV_EXECD_ACCESS_TOKEN`, `entrypoint`, `resourceLimits`, `environment`, `agentEnvironment`, `secretEnvironment`, `volumes`, `execdPort=44772`, `workerPort=44100`, `workerCommand`, `foregroundSession=true` (the runner default), `bridgeHost` and `bridgeUrl`. `bridgeUrl` is optional for loopback-only test doubles; when workers must call the controller Bridge over a provider network, bind `bridgeHost` to a reachable interface and set a public URL template such as `http://172.17.0.1:{port}`. `agentEnvironment` is the explicit public configuration passed to the worker (`SWARMENV_BRIDGE_URL`, `SWARMENV_*_SERVICE_URL`, endpoint discovery and routing/version fields); `secretEnvironment` is the explicit bearer/provider-key allow-list passed only in the authenticated `/start` request and includes `SWARMENV_BRIDGE_TOKEN` when supplied by Runtime. It creates a provider sandbox per Execution and never mounts the host Workspace; the runner enables clean preparation and the Agent adapter copies bounded initial Task files into the guest `/workspace`. The image creates `/workspace` explicitly so the provider command cwd is present before the first sync. The image recipe at [services/opensandbox-agent/Dockerfile](../../services/opensandbox-agent/Dockerfile) carries the pinned Pi package, direct `gpt_proxy` model catalog, Bash, Git, CLI and repository extension source. The API key and base URL are supplied at runtime through Pi environment interpolation; no provider binary or credential is baked into the image. The compatibility Docker provider retains `imageDigest`, `allowedReadOnlyRoots=[]`, `network='none'`, `user='1000:1000'`, `memory='2g'`, `cpus=2` and `pidsLimit=256`. [Workspace and continuity](05-workspace-continuity.md) describes the container boundaries and detached-job timeout limitation. The shipped Dockerfiles for HTTP services are deployment recipes; they are not a preconfigured Lean/Sandbox experiment environment.

Sandbox preflight runs before the project database and observation store are created. Provider events emitted during that short window are intentionally not persisted because the logger uses a nullable store; once project setup completes, later lifecycle events are recorded in the experiment observation stream. A failed preflight is still surfaced before any Task or Agent is created.

## 6. The active outer loop

Each identity loop owns discovery, Agent choice, claim/bind and waiting for its Execution to release. The runner's `onClaim` callback binds the existing Pi Session with no additional initial prompt. A continuation promise waits for settling, then keeps sending bound turns while that Execution is `RUNNING`. `turnInFlight`, `boundTurnPromise`, current Session identity and release checks prevent an ordinary repair tick from opening a second overlapping turn.

Task mutations notify subscribers after commit. The Controller reconciles readiness and signals idle identities; the outer loop wakes on that event or its five-second fallback. It samples available Tasks and physical idle lanes, releases terminal Executions, reconciles Controller state and starts an eligible bound follow-up. It does not choose a proof route. After `solvedAt` is recorded, the loop stops scheduling new ordinary bound work; without `stopOnSolved`, the enclosing timebox can still continue.

That solved-time guard belongs to the outer repair loop. Already-running `onClaim` continuations and identity-loop supervisors are not cancelled merely by assigning `solvedAt`; their own Execution-release/stop conditions still apply until finalization. Setting `stopOnSolved:true` causes the outer loop to leave and run cleanup rather than serving as a separate instantaneous cancellation broadcast.

Heartbeat runs only for a durable `RUNNING` Execution with an active Runtime process. It avoids changing versions during `CREATED`→`RUNNING` preparation. Watchdog and Execution-timeout sweeps are separately serialized so a slow sweep cannot overlap itself. Their errors are recorded, and recovery/timeouts can wake identities. [02](02-execution.md) describes which conditions trigger fencing, restart and continuation.

`runTurn` bounds readiness and prompt RPC acknowledgement to at most 30 seconds, then uses the requested turn timeout for settling unless the tool response was already handled. Discovery settling uses at least 180 seconds. Some bound-continuation calls default to 30 seconds when a direct library caller omitted `turnTimeoutMs`, even though the outer runner's local default is nine minutes. These distinct bounds must not be collapsed into a single timeout setting.

## 7. Shutdown and report behavior

Shutdown runs after the active loop exits:

1. Clear heartbeat/watchdog/timeout timers and await any in-flight sweeps.
2. Unsubscribe Task events, stop Controller, abort/stop identity loops, and wait up to the identity-loop stop grace. Record `IDENTITY_LOOP_STOP_TIMEOUT` if necessary.
3. Clean Core lanes concurrently. Stop Bridge first so deferred tool-result lifecycle work drains while Runtime is still available.
4. Ask Runtime to shut down with `benchmark_deadline_cleanup`; wait up to 30 seconds. If it does not settle, record `RUNTIME_SHUTDOWN_TIMEOUT` and force-fence matching active Executions.
5. Stop all known Sessions. Drain turn and bound-turn promises with five-second grace each, and Runtime pending work with ten-second grace. Record capacity as idle. These are several local bounds, not a single strict wall-clock cleanup deadline.
6. Build the project report, append final observation, finish the observation experiment and write `<report root>/<problem id>/report.json`; close Task Service. The CLI closes its observation connection, writes `aggregate-report.json`, and updates experiment metadata with counts and validity.

The active timebox starts after setup, the polling fallback can cross its boundary, and cleanup adds time. External execution allowances therefore need to account for more than `timeboxMs`. A code exception still runs `finally` cleanup but can propagate before a normal project report is built. Batch execution catches such errors per problem and writes an invalid `project_runner_error` report; a direct single-project call does not receive that batch fallback. Abrupt process/host termination is not a guaranteed complete-report path.

## 8. On-disk outputs

| Location | Contents and interpretation |
|---|---|
| `<experiment>/metadata/experiment.json` | CLI launch/protocol snapshot; final status/counts only written if the CLI reaches finalization |
| `<experiment>/metadata/observability.json` | Persistent observer address/database metadata |
| `<experiment>/state/projects/<problem>/project.sqlite` | Authoritative Task/Execution, Context and Judge records |
| `<experiment>/workspaces/projects/<problem>/<execution>/` | Private Execution Workspace and lineage metadata; reusable Core process directories also live below the project Workspace root |
| `<experiment>/state/projects/<problem>/judge-work/` | Independent checker work products |
| `<experiment>/logs/projects/<problem>/agents/core-N.ndjson` | Private raw Pi transport evidence, including repository-sent prompt messages |
| `<experiment>/logs/projects/<problem>/services/`, `bridge/`, `runtime/`, `judge/` | Component evidence with the visibility/sanitization of each logger |
| `<experiment root>/.observability/observability.sqlite` | Default persistent CLI observation projection |
| `<report root>/<problem>/report.json`, `<report root>/aggregate-report.json` | Exported reports; counts and projections are explained in [06](06-observability-experiments.md) |

The top-level ignored `experiments/` raw evidence directory and committed `docs/experiments/` report directory have different purposes. Raw conversations and proof source are not copied into the implementation manual.

## 9. Fixture, service and frontend boundaries

The deterministic `ScriptExecutor` uses scripted Sessions and a supplied checker, with an explicit healthy deterministic preflight shim. It proposes/claims a legacy-style Task, publishes an invalid Candidate, checks it, resumes after waiting, publishes a repaired Candidate and applies PASS. The fixture launcher uses a temporary directory and deletes it unless `--keep` is set.

`--real-agent` probes local Node/NuRouter/Pi/Lean/Lake commands and provider/model routing before launch. It returns `BLOCKED` for missing prerequisites and `FAILED_TO_LAUNCH` for missing root/input. Its first Candidate is intentionally derived by changing a valid fixture's `ring` to `rfl`; this probes diagnostic consumption and repair. It is not a benchmark run with only an unsolved problem as input. The real-probe environment metadata fields are `SWARMENV_IMPLEMENTATION_COMMIT`, `SWARMENV_WORKTREE_DIRTY`, `SWARMENV_WORKTREE_STATUS`, `SWARMENV_TIMEBOX_MS`, `SWARMENV_PUTNAMBENCH_ROOT`; they record caller context and do not themselves prove it.

Built-in and Mathlib service launchers use HTTP manifests, role/binding enforcement and optional bearer tokens. Each handles SIGINT/SIGTERM shutdown. Separate Task/Context processes need a shared mounted database for compatible state. The built-in image installs production dependencies with scripts disabled; it does not install Lean. Mathlib Search needs an external upstream or a mounted source tree. Full host settings and request behavior are in [04](04-services.md).

The dashboard's maintained source is `src/observability/client/`; Vite builds it to `src/observability/public/` with `app.js` and `styles.css` names. The observer serves these generated assets. Development proxies `/api` to `127.0.0.1:8787`. `components.json` configures the UI component generator, not runtime scheduling. `package.json` pins the Pi package and records Node's minimum version; `package-lock.json` pins dependency resolution. `npm test` uses serial Node tests. Its pretest hook first runs the offline `npm run docs:check` gate, then builds the UI. `npm run docs:generate` refreshes the prompt, API/storage and source-fingerprint references; `docs:check` only verifies them and local links.

## Source and verification map

Sources: [benchmark CLI](../../scripts/run-putnambench-benchmark.mjs), [runner](../../src/benchmark/putnam-runner.js), [locked config](../../config/putnambench-12.json), [parallelism tracker](../../src/benchmark/parallelism.js), [fixture launcher](../../scripts/run-mvp-fixture.mjs), [script fixture](../../src/e2e/script-executor.js), [real probe](../../src/e2e/real-agent-path.js), [observer launcher](../../scripts/serve-observability.mjs), [service launcher](../../scripts/service-host.mjs), [search launcher](../../scripts/mathlib-search-service.mjs), [Vite config](../../src/observability/vite.config.js), [package scripts](../../package.json).

Relevant deterministic tests: [flat benchmark CLI](../../test/flat-only-cli.test.js), [orchestration](../../test/orchestration-roles.test.js), [parallelism](../../test/parallelism.test.js), [end-to-end fixtures](../../test/e2e.test.js), [observation server](../../test/observability-server.test.js). Real provider/Lean acceptance still requires separate version-bound evidence.

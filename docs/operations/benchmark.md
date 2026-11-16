# Benchmark environment and operation

> Type: Operations · Status: Verify commands against current source before use · Updated 2026-11-11

SwarmEnv currently uses PutnamBench, Lean/Mathlib and multi-Core runs to test collaboration mechanisms. `scripts/run-putnambench-benchmark.mjs` is the existing benchmark entry. The current CLI, `config/`, `fixtures/` and `src/benchmark/` are authoritative for supported arguments and actual behavior.

## Before a formal run

1. Confirm the **human-approved GitHub Issue** and its authorized experiment plan, input configuration, resource/cost allowance and stopping conditions. The Issue is the only requirements and approval source.
2. Register a formal [Experiment ID](../experiments/INDEX.md) before execution; ordinary deterministic tests and in-scope diagnostic probes do not require formal registration.
3. Pin clean code commit, PutnamBench/Lean/Mathlib revisions, provider/model, prompt/profile/schema identities, Core count and total budget. Do not alter the baseline or checker silently.
4. Use ignored local `.env` or process environment for credentials. `.env.example` contains nonsecret examples only; never publish secret values or raw Agent conversations.
5. Keep raw evidence in ignored `experiments/`. Only reviewed sanitized summaries belong in `docs/experiments/`. If inputs are unavailable, report BLOCKED rather than silently substituting.

## Build and check the exact worker image

Run the following from the clean worktree at the approved commit. Set `worker_image`
to a new explicit tag for this build. Run both probes against the same image that
the OpenSandbox deployment will start, on the host where its Docker storage
and project quotas are configured.

~~~sh
docker build -f services/opensandbox-agent/Dockerfile -t "$worker_image" .
SWARMENV_TEST_AGENT_IMAGE="$worker_image" node --test test/opensandbox-image-contract.test.js
node test-support/bot-disk-probe.mjs "$worker_image"
~~~

The worker contract probe runs the built image without external networking and
checks the fixed model catalog, pinned resource hashes, ownership and the worker
startup receipt. It invokes Pi and CLI help/version commands without contacting
a model. Confirm the built-image test passed. Without the image environment
variable it is skipped. The disk probe runs a disposable offline worker and
exercises byte and inode limits and write restrictions for child processes.
Successful probes allow you to use this image for launch. The CLI's OpenSandbox
preflight is a separate lifecycle API listing request. It verifies provider
reachability and access. The live Bot startup then validates the deployed
worker and verifies per-Bot isolation before discovery.

## Launch an approved run

Set the shell variables below from the approved plan. Use a clean pinned worktree
and a fresh `experiment_id` for every formal attempt. The trusted deployment
JSON supplied as `deployment_config` includes the pinned fixture, final-tree
checker and artifact lock, Mission grant, and sandbox network and disk settings.
Keep machine-specific configuration, artifact locks, and runner stdout/stderr in
a separate private staging directory. For example, use
`experiments/.launch/$experiment_id` with mode 0700. Keep
`experiments/$experiment_id` absent until the CLI creates it with the private
audit marker. Use the same ID for a fresh sanitized report directory under
`reports/`. Preserve earlier attempt evidence when retrying.

The example uses the Issue #127 one-hour single-project profile with
four Cores, one-minute initial staggering, a 30-minute Bot lifetime, a
six-minute selection limit and a three-minute source checker process limit.
Set the environment for the authorized provider and OpenSandbox deployment
before launch. This command keeps the selected values explicit.

~~~sh
set -e
launch_staging="experiments/.launch/$experiment_id"
(umask 077; mkdir -p "$launch_staging")
test ! -e "experiments/$experiment_id"
test ! -e "reports/$experiment_id"
SWARMENV_SANDBOX_ENABLED=true SWARMENV_SANDBOX_IMAGE="$worker_image" \
  node scripts/run-putnambench-benchmark.mjs \
  --problems "$deployment_config" \
  --putnambench-root "$putnambench_root" \
  --problem "$approved_problem" --cores 4 --project-parallelism 1 \
  --provider "$approved_provider" --model "$approved_model" \
  --experiment-root experiments --experiment-dir "experiments/$experiment_id" \
  --report-dir "reports/$experiment_id" \
  --timebox-ms 3600000 --initial-bot-stagger-ms 60000 \
  --bot-max-ms 1800000 --selection-timeout-ms 360000 \
  --execution-timeout-ms 1800000 --checker-timeout-ms 180000 \
  >"$launch_staging/runner.log" 2>&1
~~~

The staging directory sits outside managed audit retention. Remove machine-specific
staging inputs and launcher logs when they are no longer needed.
`--task-model` and `--normal-flow` are retired. See the
[experiment workflow](../workflows/experiment.md) for reporting and the
[built-in services](../../services/builtin/README.md) and
[Mathlib Search](../../services/mathlib-search/README.md) for service deployment.

A permanent `INVALID_CONTRACT` during Bot startup stops that project, closes
its resources and saves an invalid report with `stop_reason=bot_startup_contract`
and the affected Core and error code in `run.startup_failure`. For this stop
reason the CLI records `startup_failed` and exits 1 after saving the reports.
Check the probe results and compare the image actually used by OpenSandbox with
the probed image before retrying under a fresh ID. Retryable startup errors use
the normal bounded retry and Bot replacement flow.

Keep the CLI's default nine-minute turn settling wait for this profile so a
single discovery turn can use its six-minute window. This wait also gives a
long diagnostic call time to return. The separate model request limit still
applies.

Set `final_tree_checker.timeoutMs` to `300000` in the trusted deployment to give
final acceptance five minutes. The timeout is part of the artifact lock. From
the repository root, run the artifact lock tool with the checker configuration
object and the same approved source checkout paths.

~~~sh
node scripts/lock-final-tree-checker.mjs <checker-config.json> <approved-source-checkouts.json> <new-lock.json>
~~~

Point `final_tree_checker.artifactLock` at the new local lock. Startup verifies that the
lock matches the host configuration and artifacts. A shorter locked timeout also
caps the source process budget.

`--timeout-ms` on a `swarm` command controls client waiting. An ordinary check
can include both a preflight and a Lean process. To allow both three-minute
phases plus 30 seconds of margin, set `swarm judge check ... --timeout-ms 390000`.
If a response is lost, query the original check by request key or repeat the
exact same request with its original ID. Mission submission returns a pending receipt while the verifier
runs. Query the original submission for its final result.

For configured project merge checks, use `swarm workspace merge --from R --request-id ID --timeout-ms 210000`. A lost response is an unknown outcome: replay the exact same request to recover its result. Merge checks have one retained slot per Core Runtime; they are separate from ordinary Judge and final-submission admission limits.

# Benchmark environment and operation

> Type: Operations · Status: Verify commands against current source before use · Updated 2026-11-16

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

~~~bash
set -euo pipefail
git archive HEAD package.json package-lock.json scripts src services/opensandbox-agent |
  docker build -f services/opensandbox-agent/Dockerfile -t "$worker_image" -
worker_image_id="$(docker image inspect --format '{{.Id}}' "$worker_image")"
SWARMENV_TEST_AGENT_IMAGE="$worker_image_id" node --test test/opensandbox-image-contract.test.js
node test-support/bot-disk-probe.mjs "$worker_image_id"
~~~

The build context contains only committed image inputs. Do not send the whole
checkout to the builder: ignored credentials, raw experiment evidence and host
dependencies are not image inputs.

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
before launch. In particular, set `opensandbox_url` to the lifecycle API,
`endpoint_host` to the host used to reach its published worker ports, and
`bridge_host` to a concrete IPv4 address reachable from the Bot containers.
`bridge_public_url` must contain the literal `{port}` placeholder, for example
`http://172.17.0.1:{port}` on a host using that Docker bridge address. The
deployment JSON's model gateway must advertise a similarly reachable,
non-loopback IPv4 address. Use the actual site values; Docker bridge addresses
are not portable defaults. See [run configuration](../architecture/07-run-configuration.md)
for the OpenSandbox, network isolation and observability setup.
Set `observability_metadata` to the verified observation server metadata file.
This command keeps the selected values explicit and rejects image retagging
after the successful probes.

~~~sh
set -e
test "$(docker image inspect --format '{{.Id}}' "$worker_image")" = "$worker_image_id"
launch_staging="experiments/.launch/$experiment_id"
(umask 077; mkdir -p "$launch_staging")
test ! -e "experiments/$experiment_id"
test ! -e "reports/$experiment_id"
SWARMENV_SANDBOX_ENABLED=true SWARMENV_SANDBOX_PROVIDER=opensandbox \
  SWARMENV_SANDBOX_IMAGE="$worker_image" \
  SWARMENV_OPENSANDBOX_URL="$opensandbox_url" \
  SWARMENV_OPENSANDBOX_ENDPOINT_HOST="$endpoint_host" \
  SWARMENV_BRIDGE_HOST="$bridge_host" \
  SWARMENV_BRIDGE_PUBLIC_URL="$bridge_public_url" \
  node scripts/run-putnambench-benchmark.mjs \
  --problems "$deployment_config" \
  --putnambench-root "$putnambench_root" \
  --problem "$approved_problem" --cores 4 --project-parallelism 1 \
  --provider "$approved_provider" --model "$approved_model" \
  --observability-metadata "$observability_metadata" \
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

### Long-run supervision

Keep the research runner and its observer in separate service units or
containers. The observer attaches to an already-running runner PID and performs
read-only SQLite polling; it must not be the runner's parent process. A failed
observer must not stop the runner, and a runner stop must not be inferred from
an observer logging or database-read error. Use
`scripts/experiment-supervisor.py` for the observer and start it only after the
runner service is healthy. The observer's `--self-test` is a fast regression
probe for descriptor leaks before a formal run.

The observer is deliberately not a second experiment engine. It records status
snapshots and observation-error events, while the benchmark runner owns Bot,
Judge, Workspace and Mission lifecycle. Do not use a shared `KillMode=mixed`
service whose main process is the observer: systemd would kill the research
runner when the observer exits.

For a systemd user deployment, launch the runner unit first and obtain its
main PID, then launch the observer as a second unit. For example (replace the
paths and unit names with the run's pinned values):

```bash
systemd-run --user --unit=swarmenv-q20-runner \
  --property=KillMode=control-group \
  /usr/bin/node /absolute/SwarmEnv/scripts/run-putnambench-benchmark.mjs ...
for attempt in $(seq 1 40); do
  candidate_pid="$(systemctl --user show swarmenv-q20-runner --value --property=MainPID)"
  if systemctl --user is-active --quiet swarmenv-q20-runner && [ "${candidate_pid:-0}" -gt 0 ]; then
    candidate_starttime="$(/usr/bin/python3 /absolute/SwarmEnv/scripts/experiment-supervisor.py --print-starttime "$candidate_pid")" || true
    current_pid="$(systemctl --user show swarmenv-q20-runner --value --property=MainPID)"
    if systemctl --user is-active --quiet swarmenv-q20-runner && [ "$current_pid" = "$candidate_pid" ] && [ -n "${candidate_starttime:-}" ]; then
      runner_pid="$candidate_pid"
      runner_starttime="$candidate_starttime"
      break
    fi
  fi
  sleep 0.25
done
test "${runner_pid:-0}" -gt 0
test -n "${runner_starttime:-}"
systemd-run --user --unit=swarmenv-q20-observer --collect \
  --property=KillMode=process \
  /usr/bin/python3 /absolute/SwarmEnv/scripts/experiment-supervisor.py \
  --pid "$runner_pid" --pid-starttime "$runner_starttime" \
  --project-dir /absolute/experiment/project \
  --log /absolute/experiment/supervision.ndjson
```

The bounded readiness loop rejects a zero `MainPID`, and the captured process
start time is checked again at observer attach and on every poll. The observer
unit is allowed to finish when the runner PID disappears or its timebox is
reached. Inspect the runner unit's result independently; an
`observer_log_error`, `observation_error` or observer exit is not a runner
failure. If the observer is killed, the runner unit must remain active. The
operator must not wrap both commands in one `KillMode=mixed` service or use a
parent script that starts the runner and waits for it.

This observer is a health and lifecycle projection only. It is deliberately
not the authoritative progress report: Mission submission/acceptance,
Workspace revisions, complete Task/Execution/Material lineage, checker
receipts and terminal cleanup remain in the runner's stores and the existing
observability/audit analysis. A status snapshot therefore cannot be counted as
Mission progress or acceptance.

A typed `BOT_STARTUP_CONTRACT` during Bot startup stops that project, closes
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

## Pass@K baseline

Use the same verified deployment, exact-image probes and CLI startup procedure, adding `--pass-k 1` or `--pass-k 4` and selecting one `--problem`. Register each condition separately and use fresh experiment/report directories. `--timebox-ms 3600000` gives the group its one-hour observation window. The option sets simultaneous initial starts, one Core per independent Mission and a single complete-solution Bot attempt per Mission. Each uses the original fixture and restricted solver tools; no Task or Material capability is granted to the agent. K=4 has four independent per-Mission budgets and can use four times the total resources of K=1.

Do not interpret a retained full group window as continuous active computation: accepted Missions may clean up early while other attempts continue. Inspect `pass_k`, each attempt report, model-budget evidence and physical cleanup. Late results, startup failures and unknown costs remain explicit. Omitting `--pass-k` preserves the existing Swarm invocation and behavior.

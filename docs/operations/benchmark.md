# Benchmark environment and operation

> Type: Operations · Status: Verify commands against current source before use · Updated 2026-11-11

SwarmEnv currently uses PutnamBench, Lean/Mathlib and multi-Core runs to test collaboration mechanisms. `scripts/run-putnambench-benchmark.mjs` is the existing benchmark entry. The current CLI, `config/`, `fixtures/` and `src/benchmark/` are authoritative for supported arguments and actual behavior.

## Before a formal run

1. Confirm the **human-approved GitHub Issue** and its authorized experiment plan, input configuration, resource/cost allowance and stopping conditions. The Issue is the only requirements and approval source.
2. Register a formal [Experiment ID](../experiments/INDEX.md) before execution; ordinary deterministic tests and in-scope diagnostic probes do not require formal registration.
3. Pin clean code commit, PutnamBench/Lean/Mathlib revisions, provider/model, prompt/profile/schema identities, Core count and total budget. Do not alter the baseline or checker silently.
4. Use ignored local `.env` or process environment for credentials. `.env.example` contains nonsecret examples only; never publish secret values or raw Agent conversations.
5. Keep raw evidence in ignored `experiments/`. Only reviewed sanitized summaries belong in `docs/experiments/`. If inputs are unavailable, report BLOCKED rather than silently substituting.

## Entry-point illustration (not an executable approved plan)

~~~sh
node scripts/run-putnambench-benchmark.mjs \
  --problems config/putnambench-12.json \
  --putnambench-root /path/to/PutnamBench \
  --problem putnam_2025_b1 \
  --cores 4 \
  --timebox-ms <approved-ms> \
  --provider <approved-provider> \
  --model <approved-model> \
  --experiment-dir experiments/<registered-id>
~~~

In the stacked cleanup branch, the benchmark runner uses Mission-scoped Tasks exclusively: `--task-model` and `--normal-flow` are no longer accepted. Check every option against the actual script and approved Issue before use; the example's model-independent placeholders, Core count and problem are not defaults for future research. Use the [experiment workflow](../workflows/experiment.md) for reporting. Built-in and Mathlib service deployment references: [built-in services](../../services/builtin/README.md) and [Mathlib Search](../../services/mathlib-search/README.md).

For a one-hour single-project run with a 30-minute Bot lifetime, six minutes for
selection and three minutes for each ordinary Lean diagnostic process, use
these options together.

~~~sh
--timebox-ms 3600000 --bot-max-ms 1800000 --selection-timeout-ms 360000 \
--execution-timeout-ms 1800000 --checker-timeout-ms 180000
~~~

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

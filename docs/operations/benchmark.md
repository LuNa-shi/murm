# Benchmark environment and operation

> Type: Operations · Status: Verify commands against current source before use · Updated 2026-11-11

SwarmEnv currently uses PutnamBench, Lean/Mathlib and multi-Core runs to test collaboration mechanisms. `scripts/run-putnambench-benchmark.mjs` is the existing benchmark entry. The current CLI, `config/`, `fixtures/` and `src/benchmark/` are authoritative for supported arguments and actual behavior.

## Before a formal run

1. Confirm the **human-approved GitHub Issue** and its authorized experiment plan, input configuration, resource/cost allowance and stopping conditions. A separate Phase document is not required.
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
  --task-model flat \
  --timebox-ms <approved-ms> \
  --provider <approved-provider> \
  --model <approved-model> \
  --experiment-dir experiments/<registered-id>
~~~

Until the stacked Legacy cleanup is accepted, the current CLI default is `--task-model legacy`; pass `--task-model flat` explicitly for experiments using the reviewed architecture. Once the cleanup lands this argument is removed, not required. Check every option against the actual script and approved Issue before use; the example's model-independent placeholders, Core count and problem are not defaults for future research. Use the [experiment workflow](../workflows/experiment.md) for reporting. Built-in and Mathlib service deployment references: [built-in services](../../services/builtin/README.md) and [Mathlib Search](../../services/mathlib-search/README.md).

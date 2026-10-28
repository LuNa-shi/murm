# Issue #82 real-Agent evidence

Issue #82 fixes a stale wake deduplication path in the Core admission loop. A
Core that completed a retryable selection attempt now exposes a new
`idle_generation`; the Task Controller includes that epoch in its signal key.
Selection failure and invalid selection return to the same bounded retry path
through an immediate daemon wake. Intentional selection deferral and bounded
selection exhaustion remain deduplicated/backed off.

The implementation under test is commit
`fa33ca8bda833704a601d029f1f9632bd11e159e`. The worktree was clean at launch.
The locked PutnamBench checkout was clean at commit
`a635813f5edf297d928f9bd5ef8324a26bdde09c`, with Lean project root
`/home/ubuntu/PutnamBench/lean4`. The validated local route was
`openai-codex` / `gpt-6.1-sol`; no credential values or raw Agent output are
recorded here.

Deterministic validation completed with **224/224** tests passing and
`git diff --check` clean. The real-Agent readiness probe returned
`READY_TO_LAUNCH` for Node, NuRouter, Pi, Lean, and Lake.

The 10-minute canary used four Cores, semantic mode, and the locked
`putnam_2025_b1` fixture. Its sanitized report recorded
`protocol_valid=true`, `audit.invalid=false`, and zero analyzer warnings.
For the retryable handoff path, the measured `IDLE` to next `DISCOVERING`
latencies were 33--81 ms; the remaining approximately 5-second gaps were
`no_claimable_task` fallback waits.

The completed two-hour run used the same fixture, route, four Cores, and exact
clean commit. Its sanitized report and metadata are kept in the ignored local
directory:

- `experiments/exp-20261028-issue82-full-2h-fa33ca8/metadata/experiment.json`
- `experiments/exp-20261028-issue82-full-2h-fa33ca8/analysis/runner-report/aggregate-report.json`
- `experiments/exp-20261028-issue82-full-2h-fa33ca8/analysis/runner-report/putnam_2025_b1/report.json`
- `experiments/exp-20261028-issue82-full-2h-fa33ca8/analysis/experiment-analysis.md`
- `experiments/exp-20261028-issue82-full-2h-fa33ca8/analysis/semantic-review.md`

The run completed its 7,200,000 ms timebox with
`protocol_valid=true`, `audit.invalid=false`, and `made_progress=true`.
It measured 17,909,568 ms of Agent RUNNING time over 28,805,740 ms of
four-Core capacity (62.17% wall utilization), with an eligible-window mean of
3.458 active Cores. It recorded 62 claims, 75 Materials, 35 durable Material
consumptions, and three checker candidates. There were no tool protocol errors,
invalid wait attempts, watchdog errors, or FENCED tool errors. The run saw
three invalid-selection events: the first two retried promptly; the final
bounded attempt entered the configured 30-second cooldown, as intended.

The reproducible full acceptance command is:

```sh
env NUROUTER_PI_PROVIDER=openai-codex \
    NUROUTER_PI_MODEL=gpt-6.1-sol \
    SWARMENV_IMPLEMENTATION_COMMIT=fa33ca8bda833704a601d029f1f9632bd11e159e \
    SWARMENV_WORKTREE_DIRTY=false \
    SWARMENV_WORKTREE_STATUS=clean \
    SWARMENV_PUTNAMBENCH_ROOT=/home/ubuntu/PutnamBench/lean4 \
    SWARMENV_TIMEBOX_MS=7200000 \
    timeout 9000s node scripts/run-putnambench-benchmark.mjs \
      --problems config/putnambench-12.json \
      --problem putnam_2025_b1 \
      --putnambench-root /home/ubuntu/PutnamBench \
      --cores 4 \
      --project-parallelism 1 \
      --timebox-ms 7200000 \
      --turn-timeout-ms 540000 \
      --parallel-mode semantic \
      --experiment-root experiments \
      --experiment-dir experiments/exp-20261028-issue82-full-2h-fa33ca8 \
      --report-dir experiments/exp-20261028-issue82-full-2h-fa33ca8/analysis/runner-report \
      --observability-host 127.0.0.1 \
      --observability-port 8894
```

The real-Agent run did not solve the mathematical problem. It is acceptance
evidence for the Core wake/lifecycle path and protocol validity, not a claim of
mathematical solve-rate improvement.

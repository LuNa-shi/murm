# Issue #70 real-Agent acceptance evidence

The issue-70 implementation and its acceptance run use the dedicated worktree
`/home/ubuntu/SwarmEnv/.worktrees/issue-70-task-admission`. The accepted fix is
commit `3b17dd83a86cefead9a4ad8922fd84ff2d91bfcd`; the worktree was clean at
launch. The locked PutnamBench checkout was clean at commit
`a635813f5edf297d928f9bd5ef8324a26bdde09c`. The route was the previously
validated local `openai-codex` route with model `gpt-6.1-sol`; the route
exception is recorded in [Issue #70](https://github.com/LuNa-shi/SwarmEnv/issues/70#issuecomment-6465180815).
No credential values are stored in the repository or reports.

The deterministic suite passes **222/222**, and `git diff --check` is clean.
The real-Agent readiness probe for the implementation commit returned
`READY_TO_LAUNCH`; Node, NuRouter, Pi, Lean, and Lake were available, and no
secret values were recorded.

The reproducible two-hour semantic rerun uses four Cores, the locked
`putnam_2025_b1` project, and keeps all run/report state below `experiments/`:

```sh
env NUROUTER_PI_PROVIDER=openai-codex \
    NUROUTER_PI_MODEL=gpt-6.1-sol \
    SWARMENV_IMPLEMENTATION_COMMIT=3b17dd83a86cefead9a4ad8922fd84ff2d91bfcd \
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
      --experiment-dir experiments/exp-20261027-issue70-fix-2h-r2-3b17dd8-codex \
      --report-dir experiments/exp-20261027-issue70-fix-2h-r2-3b17dd8-codex/analysis/runner-report \
      --observability-host 127.0.0.1 \
      --observability-port 8893
```

The canonical sanitized aggregate export for the completed run is at
`experiments/exp-20261027-issue70-fix-2h-r2-3b17dd8-codex/analysis/aggregate-report.json`;
the operator summary and independent semantic review are in the same ignored
`analysis/` directory. The original runner output remains local and ignored;
it is not part of the review or publication surface.
The run metadata is in
`experiments/exp-20261027-issue70-fix-2h-r2-3b17dd8-codex/metadata/experiment.json`.
The metadata records `status: completed`, `valid_for_analysis: true`, the
exact implementation commit above, `repository_worktree_dirty: false`, and a
completed 7,200,000 ms timebox. The sanitized semantic analysis is kept under
the experiment's ignored `analysis/` directory; raw transcripts, proof source,
credentials, stdout, and stderr are not exported.

The final run is protocol-valid and made progress: `protocol_valid=true`,
`audit.invalid=false`, `solved=false`, and `deadline_reached=true`. It recorded
95 child Tasks, 76 claims, 90 Materials, 78 Workspace writes, 56 accepted
Tasks, and one checker candidate with a source-level `PASS`. There were 32
recoverable Service errors (`NOT_ALLOWED`, `INVALID_CONTRACT`,
`STALE_VERSION`, and one `TypeError`), zero tool protocol errors, zero invalid
wait attempts, and no `FENCED` tool errors. The 19 FENCED terminal Executions
were normal dependency-blocking lifecycle outcomes; the sanitized trajectory
shows those Cores returning to IDLE and being reused.

The parallelism report measured 23,634,033 ms of Agent RUNNING time out of
28,802,244 ms of four-Core capacity: **82.06% wall utilization**, mean active
Core count **3.282/4**, and maximum 4. During the eligible windows, mean active
Core count was **3.345/4**. The run reached 4-Core concurrency for 3,200,173
ms, and all four Core lanes were reused across many independent child Tasks.
The run was not mathematically solved, so the evidence establishes lifecycle,
capacity, and checker-path health rather than a Putnam proof result.

The trajectory explains the regression that motivated this fix. Comparable
valid two-hour runs on the same fixture and semantic mode measured 45.1%
(`b05d432`), 37.6% (`c96a92d`), 45.6% (`d9ff9fe`), 16.4% (`4b31af9`), and
26.7% (`c5a744b`) wall utilization. The apparent 64.4% (`c9bae6a`) and 61.8%
(`c565735`) runs were diagnostic-only because their evidence violated the
candidate/tool boundary. Several of the low-utilization valid runs contained
repeated `FENCED` Workspace feedback after Agent `block_execution` attempts;
the final run has no such feedback loop.

The repaired order is now:

```text
save Workspace revision/checkpoint
  -> durable Task Service block_task transition
  -> physical Workspace fence
  -> stop Session and release Workspace/Core
```

If `block_task` is rejected, the Execution remains RUNNING with the same
fencing version and the original Agent can still write its Workspace. The
regression test `rejected execution_block does not fence the Workspace before
the Task transition commits` covers both read and write access after a
rejected transition. The final two-hour run's 82.06% utilization and absence
of FENCED tool errors are consistent with this lifecycle fix. The comparison
is evidence across successive iterations rather than a controlled
single-variable benchmark, so it should not be read as a mathematical or
causal proof beyond the observed error disappearance and capacity recovery.

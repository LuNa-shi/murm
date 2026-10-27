# Issue #70 real-Agent acceptance evidence

The current implementation is commit
`b05d4329b895a96244e510a19fd66fde91e6c11d` in the dedicated Issue worktree.
The worktree was clean for the deterministic checks, readiness probe, and
acceptance run. The locked PutnamBench checkout was clean at commit
`a635813f5edf297d928f9bd5ef8324a26bdde09c`.

The local route was `openai-codex` with model `gpt-6.1-sol`, loaded from the
ignored worktree `.env`. No credential values are stored in the repository or
the reports. Deterministic validation completed with `npm test` at **207/207
passing** and `git diff --check` clean. The readiness probe for the exact
implementation SHA returned `READY_TO_LAUNCH`; its environment checks found
Node, NuRouter, Pi, Lean, and Lake, and recorded no secret values.

The latest real-Agent run is a complete single-project semantic acceptance
run. Limiting the command to `putnam_2025_b1` keeps the two-hour timebox tied
to one report instead of starting another two-hour project from the 12-problem
batch after the first one finishes:

```sh
env SWARMENV_IMPLEMENTATION_COMMIT=b05d4329b895a96244e510a19fd66fde91e6c11d \
    SWARMENV_WORKTREE_DIRTY=false \
    SWARMENV_WORKTREE_STATUS=clean \
    SWARMENV_PUTNAMBENCH_ROOT=/home/ubuntu/PutnamBench/lean4 \
    SWARMENV_TIMEBOX_MS=7200000 \
    timeout 7500s node scripts/run-putnambench-benchmark.mjs \
      --problems config/putnambench-12.json \
      --problem putnam_2025_b1 \
      --putnambench-root /home/ubuntu/PutnamBench \
      --cores 4 \
      --project-parallelism 1 \
      --timebox-ms 7200000 \
      --turn-timeout-ms 540000 \
      --parallel-mode semantic \
      --experiment-root /tmp/swarmenv-issue70-b05d432-2h \
      --experiment-dir /tmp/swarmenv-issue70-b05d432-2h/putnambench-runs/issue70-b05d432-b1-2h \
      --report-dir /tmp/swarmenv-issue70-b05d432-2h/reports/issue70-b05d432-b1-2h \
      --observability-host 127.0.0.1 \
      --observability-port 8816
```

The sanitized aggregate report is at
`/tmp/swarmenv-issue70-b05d432-2h/reports/issue70-b05d432-b1-2h/aggregate-report.json`;
the per-project report is in its `putnam_2025_b1/report.json` child. Metadata
records `status: completed`, `valid_for_analysis: true`, the exact
implementation commit above, `repository_worktree_dirty: false`, and
`ended_at: 2026-10-27T10:16:27.085Z`. The project elapsed time was
7,203,058 ms against the 7,200,000 ms deadline, with 131 ms cleanup.

A repository-local sanitized operator summary and semantic review are kept at
`experiments/exp-20261027-issue70-b1-2h-b05d432/analysis/`. That directory is
ignored; raw state remains local and is not committed. The `/tmp` paths above
are the exact paths used by the completed run and are retained for local
reruns and report verification.

The run is protocol-valid and made progress: `protocol_valid=true`,
`audit.invalid=false`, `solved=false`, and `deadline_reached=true`. The
unsolved result is a mathematical outcome; it does not invalidate the
runtime evidence. The run recorded 40 claims/starts (36 child and 4 root), 29
accepts, 58 Materials, and 10 candidate/check pairs. Checker results had 7
source-level failures, zero infrastructure failures, and zero unassessed
checks. There were 1,496 heartbeats with no heartbeat errors, no watchdog
recovery or error, no execution-timeout error, no invalid waits, and no tool
protocol errors. Fifteen ordinary Service errors were recorded as Agent
feedback; they did not invalidate the protocol. Raw transcripts and proof
contents were not exported.

The final sanitized database state was 32 `DONE` Tasks and 2 `BLOCKED` Tasks;
all 32 latest Executions were `SUCCEEDED` and 8 prior terminal attempts were
`FENCED`. There were no active Executions, duplicate active Task/Core owners,
or `BLOCKED` Tasks with an active Execution. The DONE audit found 29 research
contracts with matching required Materials and 3 proof contracts with matching
candidate plus `APPLIED/PASS` CheckResults; all 32 had a successful latest
Execution and Workspace revision. The arbitrary business keys kept in
`acceptance_conditions_json` remain metadata and are not independently
interpreted by TaskService, so this audit does not claim semantic proof of
those keys.

Collaboration exercised 3 branch groups, 12 required-subtask groups, 25
required-subtask additions, 7 typed block/checkpoint transitions, and one
evidence-linked rework Task. One sanitized `daemon_runtime_failed` event on a
Core was followed by Session close and Execution release with no residue. The
queue drained naturally before the deadline; the remaining two Tasks were
typed blocked dependencies.

The authoritative parallelism report measured 12,989,675 ms of Agent time out
of 28,812,232 ms of four-Core capacity: 45.08% wall utilization, mean active
Core count 1.803/4, and maximum 4. In windows with at least four eligible
Tasks, mean active count was 3.102/4 over 2,787,234 ms. Ready work was present
for 3,015,834 ms, with 2,908,939 ms counted as ready-unassigned by the tracker;
this shows demand and substantial eligible-window concurrency, while the
wall-average remains modest. All four Cores were reused, with 8/11/11/10
claims. The tracker recorded zero Agent-side claim conflicts; observability
recorded bounded Daemon claim conflicts and releases. There is no paired
pre-change baseline, so the evidence supports real parallel reuse and clean
release, but not a causal claim of improvement over the previous system.

The preceding `c9bae6a` run exposed a genuine invalid candidate placeholder and
was diagnostic-only. The current prompt/runtime change keeps the locked
formalization read-only, requires a separate candidate file, and tells the
Agent to block rather than submit the input file when no honest candidate is
ready. The new two-hour run is the valid sanitized acceptance evidence for
the current implementation commit.

# Issue 60 real-Agent evidence

This evidence records the clean implementation commit used for the final
runtime check. The run did not solve the PutnamBench problem because every
unbound Pi session exited during its first prompt, before a Task claim. The
report therefore separates a valid runtime protocol from the absence of
mathematical progress.

## Fixed inputs

- SwarmEnv implementation commit: `e7f4e144d447651892da86f3d1f4997af24f520a`
- SwarmEnv worktree: clean (`repository_worktree_dirty=false`)
- PutnamBench checkout: `/home/ubuntu/PutnamBench`
- PutnamBench commit: `a635813f5edf297d928f9bd5ef8324a26bdde09c`
- Lean project root: `/home/ubuntu/PutnamBench/lean4`
- Problem: `putnam_2025_b1`
- Cores: 4
- Provider/model: `openai` / `gpt-6.1-sol`
- Toolchain probe: `READY_TO_LAUNCH`; Node `v24.21.0`, NuRouter `0.2.14`, Pi
  `1.4.0`, Lean `4.33.1`, and Lake `5.0.0` were available. The probe recorded
  no secret values.

The deterministic validation for this commit was `npm test` (152/152 passing)
followed by `git diff --check`.

## Final short run

The short run was allowed to reach its own deadline so that it produced a
complete sanitized report:

- Sanitized report:
  `experiments/exp-20261025-issue60-r9/analysis/experiment-analysis.md`
- Aggregate report:
  `experiments/exp-20261025-issue60-r9/analysis/aggregate-report.json`
- Project report:
  `experiments/exp-20261025-issue60-r9/analysis/putnam_2025_b1/report.json`
- Timebox: 120 seconds; observed elapsed time: 120464 ms
- `protocol_valid=true`, `audit.invalid=false`
- `solved=false`, `made_progress=false`
- Root Task remained `OPEN`; no Execution was created and `claim_count=0`
- `ready_work_ms=120460`, `ready_unassigned_ms=0`, and
  `max_active_core_count=0`
- Scheduler: 12 startup attempts, 12 startup failures, four bounded startup
  exhaustions, zero successful dispatches, and zero duplicate suppressions
- The observation stream recorded 12 session starts and 12 session closes, with
  no claim, wait, resume, checker, or material events

The sanitized report contains no raw transcript, proof contents, credentials,
or unredacted process output. The result is an environment/provider-session
blocker after a `READY_TO_LAUNCH` command probe; it is not evidence that the
problem is mathematically unsolved.

## Diagnostic two-hour attempt

The same clean commit and fixed inputs were used for the two-hour command
below. After the four Cores each completed three bounded startup attempts, the
run had no remaining eligible capacity or Agent work, so it was stopped rather
than leaving an idle process for the rest of the timebox. Its ignored
experiment directory is retained locally at
`experiments/exp-20261025-issue60-r8/`; it is not acceptance evidence because
it was terminated before the deadline and has no final report.

```bash
NUROUTER_PI_PROVIDER=openai NUROUTER_PI_MODEL=gpt-6.1-sol \
timeout 7500s node scripts/run-putnambench-benchmark.mjs \
  --problems config/putnambench-12.json \
  --putnambench-root /home/ubuntu/PutnamBench \
  --problem putnam_2025_b1 \
  --cores 4 --project-parallelism 1 \
  --timebox-ms 7200000 --turn-timeout-ms 540000 \
  --experiment-root experiments/exp-20261025-issue60-r8 \
  --experiment-dir experiments/exp-20261025-issue60-r8/run \
  --report-dir experiments/exp-20261025-issue60-r8/analysis \
  --observability-host 127.0.0.1 --observability-port 8805
```
## Exact rerun command

After the local provider/Pi route can complete the first prompt, rerun the
full acceptance timebox from a clean checkout at the implementation commit:

```bash
git checkout --detach e7f4e144d447651892da86f3d1f4997af24f520a
NUROUTER_PI_PROVIDER=openai NUROUTER_PI_MODEL=gpt-6.1-sol \
timeout 7500s node scripts/run-putnambench-benchmark.mjs \
  --problems config/putnambench-12.json \
  --putnambench-root /home/ubuntu/PutnamBench \
  --problem putnam_2025_b1 \
  --cores 4 --project-parallelism 1 \
  --timebox-ms 7200000 --turn-timeout-ms 540000 \
  --experiment-root experiments/exp-20261025-issue60-r10 \
  --experiment-dir experiments/exp-20261025-issue60-r10/run \
  --report-dir experiments/exp-20261025-issue60-r10/analysis \
  --observability-host 127.0.0.1 --observability-port 8807
```

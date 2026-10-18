# Final-code four-core pilot

This is the acceptance run against the final code on this branch. It ran one
PutnamBench problem with one root Task, four proof child Tasks, and four
reusable core slots. The worker claim path excludes the root controller when a
`root_id` is supplied.

- Problem: `putnam_2025_b1`
- Cores: `4`
- Timebox: `300000 ms`
- Project parallelism: `1`
- PutnamBench checkout: `/home/ubuntu/PutnamBench`
- PutnamBench commit: `a635813f5edf297d928f9bd5ef8324a26bdde09c`
- Lean toolchain: `leanprover/lean4:v4.33.1`
- Mathlib revision: `0df444a360eaa60ab8c11dca51a86af692955474`
- Local dependency preparation: `lake exe cache get` and `lake build` passed
- Provider/model: recorded in `metadata/experiment.json`

The exact command was:

```sh
set -a; . ./.env.example; set +a
export PATH="$HOME/.elan/bin:$PATH"
node scripts/run-putnambench-benchmark.mjs \
  --problems config/putnambench-12.json \
  --putnambench-root /home/ubuntu/PutnamBench \
  --problem putnam_2025_b1 \
  --cores 4 \
  --project-parallelism 1 \
  --timebox-ms 300000 \
  --turn-timeout-ms 120000 \
  --experiment-dir experiments/putnambench-4core-2026-10-18-pilot-real-v2 \
  --report-dir reports/putnambench-4core-2026-10-18-pilot-real-v2
```

The run completed with exit code 0 and produced an unsolved, valid result:
seven candidates were checked by the local Lean checker, no cheating flags
were raised, and the report contains no candidate/proof contents or raw
stdout/stderr. The sanitized report is separate from raw evidence at
[`reports/putnambench-4core-2026-10-18-pilot-real-v2`](../../reports/putnambench-4core-2026-10-18-pilot-real-v2/).

The raw experiment contains SQLite task/execution state, per-service and
per-core NDJSON logs, Pi session records, checker records, and execution
workspaces. The final audit found one root Task, four child Tasks, one root
controller Execution, four worker Executions, four workspace revisions, 19
Materials, seven Lean checks, and heartbeats from all four cores. Worker
leases were released when the timebox ended: worker Executions are `FAILED`
because their turns timed out, while the controller is `FENCED` and Tasks
remain retryable `OPEN` work.

The agent-facing bridge records successful reads/publications/submissions and
also records failed child-task requests with their error code. A child Task is
created only when the parent Execution supplies a unique
`child_creation_key`; the initial four direct children in this run were
created by the root scheduler before the slots claimed them.

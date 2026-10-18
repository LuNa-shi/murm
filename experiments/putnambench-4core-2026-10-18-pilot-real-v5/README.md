# Clean-commit four-core acceptance run

This is the final acceptance run for the reusable core-slot and durable
experiment evidence change. It was executed from clean commit
`f13eb4357bf62e3e58e7093d946a0a9f44e9594e` with a real local NuRouter Agent
Core and the locally built PutnamBench Lean environment.

- Problem: `putnam_2025_b1`
- Cores: `4`
- Timebox: `300000 ms`
- Turn timeout: `120000 ms`
- Project parallelism: `1`
- PutnamBench checkout: `/home/ubuntu/PutnamBench`
- PutnamBench commit: `a635813f5edf297d928f9bd5ef8324a26bdde09c`
- Lean toolchain: `leanprover/lean4:v4.33.1`
- Mathlib revision: `0df444a360eaa60ab8c11dca51a86af692955474`
- Local dependency preparation: `lake exe cache get` and `lake build` passed
- Worktree at start: clean
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
  --experiment-dir experiments/putnambench-4core-2026-10-18-pilot-real-v5 \
  --report-dir reports/putnambench-4core-2026-10-18-pilot-real-v5
```

The process exited 0 with a valid unsolved result: six candidate checks ran in
the local Lean checker, all cheating flags were clear, and the sanitized
report contains no candidate/proof contents or raw stdout/stderr. The report
is separate from raw evidence at
[`reports/putnambench-4core-2026-10-18-pilot-real-v5`](../../reports/putnambench-4core-2026-10-18-pilot-real-v5/).

The raw experiment contains SQLite task/execution state, service logs,
per-core Runtime/Bridge/Agent logs, checker logs, Pi sessions, checkpoints,
workspace revisions, and workspace files. The audit found one root Task, four
direct child Tasks, one root controller Execution, four worker Executions, 17
Materials, four workspace revisions, six Lean checks, and heartbeats from all
four cores. Worker leases were released at the deadline: worker Executions are
`FAILED` after their turns timed out, the controller is `FENCED`, and the Tasks
remain retryable `OPEN` work.

The initial four direct children were created by the root scheduler before the
slots claimed them. Parent Executions can create further direct children using
`create_child_task` with a unique `child_creation_key`; those children enter the
same root queue. Bridge logs retain a start/complete record for successful and
failed calls, including the child-task validation path.

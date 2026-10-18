# Valid four-core pilot

This is the acceptance run for the reusable core-slot and durable-evidence
change. It ran one PutnamBench problem with one root Task and four workers
claiming child Tasks from the same queue.

- Problem: `putnam_2025_b1`
- Cores: `4`
- Timebox: `600000 ms`
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
  --timebox-ms 600000 \
  --turn-timeout-ms 120000 \
  --experiment-dir experiments/putnambench-4core-2026-10-18-pilot-real \
  --report-dir reports/putnambench-4core-2026-10-18-pilot-real
```

The run completed with exit code 0 and produced an unsolved, valid result:
the four agents generated six candidates, all six were checked by the local
Lean checker and failed, and no cheating flags were raised. The report is
separate from raw evidence at
[`reports/putnambench-4core-2026-10-18-pilot-real`](../../reports/putnambench-4core-2026-10-18-pilot-real/).

The raw experiment contains the SQLite task/execution state, per-service and
per-core NDJSON logs, Pi session records, checker records, and execution
workspaces. It is intentionally ignored by Git but remains on disk for audit.
The report contains hashes, statuses, diagnostic classes, and counts; it does
not export formal source, candidate/proof contents, or raw stdout/stderr.

The lifecycle audit found one root Task, four child Tasks, one controller
Execution, four worker Executions, task-owned workspace URIs, workspace
revisions, checkpoints, 19 Materials, and heartbeats from all four cores.
Worker leases were released when the timebox ended; the worker Executions are
`FAILED` because their individual turns timed out, while the controller was
`FENCED` during cleanup and the Tasks remain retryable `OPEN` work.

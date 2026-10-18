# Final-code four-core acceptance run

This is the shortest final-code acceptance run for the reusable core-slot and
durable-evidence change. It ran one PutnamBench problem with one root Task,
four proof child Tasks, and four core slots against the locally built Lean
environment.

- Problem: `putnam_2025_b1`
- Cores: `4`
- Timebox: `120000 ms`
- Project parallelism: `1`
- PutnamBench checkout: `/home/ubuntu/PutnamBench`
- PutnamBench commit: `a635813f5edf297d928f9bd5ef8324a26bdde09c`
- Lean toolchain: `leanprover/lean4:v4.33.1`
- Mathlib revision: `0df444a360eaa60ab8c11dca51a86af692955474`
- Local dependency preparation: `lake exe cache get` and `lake build` passed
- Provider/model: recorded in `metadata/experiment.json`

The run completed with exit code 0 and produced an unsolved, valid result:
two candidates reached the local Lean checker, no cheating flags were raised,
and the report contains no candidate/proof contents or raw stdout/stderr. The
sanitized report is separate from raw evidence at
[`reports/putnambench-4core-2026-10-18-pilot-real-v3`](../../reports/putnambench-4core-2026-10-18-pilot-real-v3/).

The raw experiment contains SQLite task/execution state, per-service and
per-core NDJSON logs, Pi session records, checker records, and execution
workspaces. The final audit found one root Task, four child Tasks, one root
controller Execution, four worker Executions, four workspace revisions, seven
Materials, two Lean checks, and heartbeats from all four cores. Worker leases
were released when the timebox ended: worker Executions are `FAILED` because
their turns timed out, while the controller is `FENCED` and Tasks remain
retryable `OPEN` work.

Bridge logs have matching start/complete records for every call, including
failed child-task requests. The initial four direct children in this run were
created by the root scheduler before the slots claimed them; a parent-created
subtask must provide a unique `child_creation_key` and is then queued for a
later claim.

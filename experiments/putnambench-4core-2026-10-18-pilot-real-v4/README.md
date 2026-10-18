# Clean-commit four-core lifecycle smoke run

This run was executed from clean commit `5b7c18b93e4692bbd4da0f40a3413ba89a6c1b55`.
It verifies the queue, workspace, Material, and release lifecycle against the
committed code before the longer final acceptance run.

- Problem: `putnam_2025_b1`
- Cores: `4`
- Timebox: `120000 ms`
- Project parallelism: `1`
- PutnamBench commit: `a635813f5edf297d928f9bd5ef8324a26bdde09c`
- Lean toolchain: `leanprover/lean4:v4.33.1`
- Mathlib revision: `0df444a360eaa60ab8c11dca51a86af692955474`
- Local dependency preparation: `lake exe cache get` and `lake build` passed
- Worktree at start: clean

The process exited 0 with a valid unsolved result and no cheating flags. The
short window produced three Materials and no candidate reached the checker;
the longer v5 run records the checker path. SQLite contains one root Task,
four child Tasks, one root controller Execution, four worker Executions, and
four workspace revisions. All four worker Executions released their leases
and ended `FAILED` after the short turn window; the controller ended `FENCED`
and Tasks remain retryable `OPEN` work.

Raw evidence is under this experiment's ignored `state/`, `logs/`, and
`workspaces/` directories. The sanitized report is at
[`reports/putnambench-4core-2026-10-18-pilot-real-v4`](../../reports/putnambench-4core-2026-10-18-pilot-real-v4/).

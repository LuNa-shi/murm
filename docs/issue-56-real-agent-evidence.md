# Issue #56 real-Agent acceptance evidence

This is a sanitized acceptance record for the Task Service parallel-work
semantics implementation.

## Clean implementation and fixture

- implementation commit: `232e1bae37ee646956921afa62c0d6a7f6dd824c`
- implementation worktree: clean (`git status --porcelain` was empty)
- fixture: `putnam-1966-a1`
- PutnamBench commit: `a635813f5edf297d928f9bd5ef8324a26bdde09c`
- locked problem file: `lean4/src/putnam_1966_a1.lean`
- Lean project root: `/home/ubuntu/PutnamBench/lean4`
- Lean toolchain: `leanprover/lean4:v4.33.1`
- Mathlib: `0df444a360eaa60ab8c11dca51a86af692955474`
- checker: `lean`, version `mvp-1`

The local checkout at `/home/ubuntu/PutnamBench` matched the locked commit.
The sanitized probe saw `nurouter`, `pi`, `lean`, and `lake` available, and did
not record any secret value.

## Probe result

The required real-Agent probe was run from the clean implementation commit:

```text
node scripts/run-mvp-fixture.mjs --real-agent
```

Result: `BLOCKED` (process exit code `1`). The worktree had no
`NUROUTER_PI_PROVIDER` or `NUROUTER_PI_MODEL`, so the probe did not launch a
Provider, Agent Session, Core, or benchmark timebox. No branch/subtask
timeline, overlap, completion result, or baseline comparison can be claimed
from this attempt. The result is an environment blocker, not evidence that
the Task semantics failed.

Once the route is supplied through the local ignored `.env` or the process
environment, rerun the same command from this commit. For the full benchmark
comparison, use the locked PutnamBench input with four Cores and the same
timebox and budget for the parallel and Root-only baseline runs; publish only
the sanitized report fields.

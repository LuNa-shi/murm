# Issue #56 real-Agent acceptance evidence

This is a sanitized acceptance record for the Task Service parallel-work
semantics implementation. The deterministic implementation checks pass, but
the final real-Agent gate is blocked by Provider authentication before any
Agent turn or Task claim.

## Clean implementation and fixture

- implementation commit: `0dd0df353a418b8bc6620599b80f3c078cd5fead`
- implementation worktree: clean (`git status --porcelain` was empty before each run)
- fixture problem: `putnam_2025_b1`
- locked problem file: `lean4/src/putnam_2025_b1.lean`
- PutnamBench checkout: `/home/ubuntu/PutnamBench`
- PutnamBench commit: `a635813f5edf297d928f9bd5ef8324a26bdde09c`
- Lean project root: `/home/ubuntu/PutnamBench/lean4`
- Lean toolchain: `leanprover/lean4:v4.33.1`
- Mathlib: `0df444a360eaa60ab8c11dca51a86af692955474`
- checker: `lean`, version `mvp-1`
- environment: `putnambench-lean4@a635813f5edf297d928f9bd5ef8324a26bdde09c`
- route: provider `openai`, model `gpt-6.1-sol`
- Core count: `4`
- timebox: `3600000 ms`
- no `.env` was present in either the main checkout or this worktree; the
  route was supplied explicitly in the process environment

The local PutnamBench checkout matched the locked commit. `node`, `nurouter`,
`pi`, `lean`, and `lake` were available. No secret value was recorded.

## Probe

The required probe was run from the clean implementation commit with the
route selected explicitly:

```text
env NUROUTER_PI_PROVIDER=openai NUROUTER_PI_MODEL=gpt-6.1-sol \
  node scripts/run-mvp-fixture.mjs --real-agent
```

The sanitized probe prerequisites reported `READY_TO_LAUNCH` and all required
executables were available. The controlled legacy fixture path then returned
`RPC_ERROR`/`real_agent_path_error`; it did not record secrets or constitute a
benchmark acceptance run.

An additional RPC health check using the same provider/model reached the Pi
session and received a Provider authentication error on the first prompt. No
credential values were printed or persisted. The environment therefore cannot
complete a real Agent turn until valid local authentication is supplied.

## Final semantic and Root-only runs

Both runs used the same problem, checkout, model, Core count, timebox, and
checker. They were launched concurrently from the exact clean implementation
commit.

Semantic treatment:

```text
env NUROUTER_PI_PROVIDER=openai NUROUTER_PI_MODEL=gpt-6.1-sol \
  node scripts/run-putnambench-benchmark.mjs \
  --problems config/putnambench-12.json \
  --putnambench-root /home/ubuntu/PutnamBench \
  --problem putnam_2025_b1 --cores 4 --project-parallelism 1 \
  --timebox-ms 3600000 --parallel-mode semantic \
  --experiment-dir experiments/issue56-semantic-1h-final-20261025-r3 \
  --report-dir reports/issue56-semantic-1h-final-20261025-r3 \
  --observability-host 127.0.0.1 --observability-port 8798
```

Report: `reports/issue56-semantic-1h-final-20261025-r3/putnam_2025_b1/report.json`

Root-only control:

```text
env NUROUTER_PI_PROVIDER=openai NUROUTER_PI_MODEL=gpt-6.1-sol \
  node scripts/run-putnambench-benchmark.mjs \
  --problems config/putnambench-12.json \
  --putnambench-root /home/ubuntu/PutnamBench \
  --problem putnam_2025_b1 --cores 4 --project-parallelism 1 \
  --timebox-ms 3600000 --parallel-mode root-only \
  --experiment-dir experiments/issue56-root-only-1h-final-20261025-r3 \
  --report-dir reports/issue56-root-only-1h-final-20261025-r3 \
  --observability-host 127.0.0.1 --observability-port 8799
```

Report: `reports/issue56-root-only-1h-final-20261025-r3/putnam_2025_b1/report.json`

The report comparison is:

| sanitized field | semantic | Root-only |
| --- | ---: | ---: |
| implementation commit | `0dd0df3...` | `0dd0df3...` |
| worktree dirty | `false` | `false` |
| elapsed | `3604772 ms` | `3604770 ms` |
| `protocol_valid` / audit invalid | `true` / `false` | `true` / `false` |
| made progress / solved | `false` / `false` | `false` / `false` |
| Task count / child Tasks | `1 / 0` | `1 / 0` |
| claim count | `0` | `0` |
| structure operations | none | none |
| readiness samples / observed interval | `720 / READY` | `720 / READY` |
| ready work / ready unassigned | `3598367 / 3598367 ms` | `3598362 / 3598362 ms` |
| Agent-time utilization | `0` | `0` |

Each of the four Core summaries contains one sanitized `RPC_ERROR` before its
first turn; no Core claimed a Task, wrote a Workspace, read Material, or
performed a structure operation. `protocol_valid=true` here means that no
protocol or boundary violation was observed; it does not mean that the
real-Agent acceptance succeeded.

## Conclusion and rerun

These runs are environment-blocked before Agent work and are diagnostic-only.
They provide no evidence about mathematical solving, branch/subtask overlap,
Task completion, or a semantic-vs-Root-only speedup. Once valid local Provider
authentication is available, rerun the two exact commands above from
`0dd0df353a418b8bc6620599b80f3c078cd5fead` with a clean worktree. A later
documentation-only commit that records the resulting report paths does not
change the implementation and does not require another run.

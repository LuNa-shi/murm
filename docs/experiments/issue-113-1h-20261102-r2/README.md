# Issue #113 1h lifecycle and capability pilot

This directory contains the sanitized analysis for the first one-hour pilot
after the lifecycle-owner and local Mathlib capability fixes.

| Field | Value |
|---|---|
| Experiment | `issue-113-1h-20261102-r2` |
| Implementation commit | `17ee6d002d28de35a4ff8550b1ec1d86f3b45279` |
| PutnamBench commit | `a635813f5edf297d928f9bd5ef8324a26bdde09c` |
| Fixture | `putnam_2025_b1` |
| Provider/model | `openai-codex` / `gpt-6.1-sol` |
| Cores / timebox | 4 / 3,600,000 ms |
| Mode | `semantic` / `flat` / `normal-flow` |
| Status | completed; `protocol_valid=true`; `solved=false`; `invalid=false` |

The run produced 4 Tasks, 62 Executions, 98 Materials, 49 consumptions, and 7
checker-bound candidates. All 7 checks were completed Lean source failures; no
checker infrastructure failure or PASS occurred. The owner identity fix was
observed in real handoff/block lifecycle records, and the local
`mathlib_search` capability was present in the real Agent tool profile. The
remaining issue is contribution quality: many short proof handoffs repeated
the same unresolved geometric responsibility without a new candidate, check,
Workspace route, or downstream decision.

The full evidence-first report is [experiment-analysis.md](analysis/experiment-analysis.md).
It is a sanitized projection and does not include credentials, raw transcripts,
proof/candidate source, stdout/stderr, or unrestricted private paths.

## Rerun command

Run from a clean checkout at the implementation commit, with the ignored local
`.env` copied into the worktree and the locked PutnamBench checkout available:

```sh
set -a; source .env; set +a
export PATH="/home/ubuntu/.elan/bin:$PATH" \
  SWARMENV_PUTNAMBENCH_ROOT=/home/ubuntu/PutnamBench/lean4 \
  SWARMENV_IMPLEMENTATION_COMMIT=$(git rev-parse HEAD) \
  SWARMENV_WORKTREE_DIRTY=false SWARMENV_WORKTREE_STATUS=clean
timeout 3900s node scripts/run-putnambench-benchmark.mjs \
  --problems config/putnambench-12.json \
  --putnambench-root /home/ubuntu/PutnamBench \
  --problem putnam_2025_b1 --cores 4 --project-parallelism 1 \
  --task-model flat --timebox-ms 3600000 --turn-timeout-ms 540000 \
  --parallel-mode semantic --normal-flow \
  --experiment-root experiments \
  --experiment-dir experiments/issue-113-1h-20261102-r2 \
  --report-dir experiments/issue-113-1h-20261102-r2/analysis/runner-report \
  --observability-host 127.0.0.1 --observability-port 8897
```

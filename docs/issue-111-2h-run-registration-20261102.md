# Issue #111 two-hour run registration

Registered before launch.

## Exact implementation

- Run HEAD: the documentation commit immediately above `0bc87896236a6a221c67afba434d13591306bf81` (recorded at launch in the report)
- Code implementation under test: `0bc87896236a6a221c67afba434d13591306bf81`;
  later commits in this run are documentation-only.
- Worktree: `/home/ubuntu/SwarmEnv/.worktrees/issue-111-task-centric-phase1`
- Worktree status at registration: clean (`git status --porcelain` empty).
- Deterministic baseline: `npm test` 313/313 at the implementation commit.

## Fixed inputs and environment

| Item | Value |
| --- | --- |
| Problem | `putnam_2025_b1` from `config/putnambench-12.json` |
| PutnamBench commit | `a635813f5edf297d928f9bd5ef8324a26bdde09c` |
| Lean project root | `/home/ubuntu/PutnamBench/lean4` |
| Provider / model | local ignored `.env`: `openai-codex` / `gpt-6.1-sol` |
| Cores / project parallelism | 4 / 1 |
| Timebox | 7,200,000 ms |
| Parallel mode | `semantic`, `--normal-flow` |
| Compaction | max 3 successful compactions; handoff at current window ratio >= 0.8 |
| Window measurement | Pi `get_state` / `get_session_stats` `contextUsage`; never cumulative tokens |
| Checker | locked Lean fixture, `a635813…`, `mvp-1` |
| Judge | existing Lean checker; no relaxation |
| Experiment dir | `experiments/issue-111-2h-20261102` |
| Report dir | `experiments/issue-111-2h-20261102/analysis/runner-report` |
| Observability | `127.0.0.1:8894` |

## Exact command

```sh
set -a; source .env; set +a
export PATH="/home/ubuntu/.elan/bin:$PATH" \
  SWARMENV_PUTNAMBENCH_ROOT=/home/ubuntu/PutnamBench/lean4 \
  SWARMENV_IMPLEMENTATION_COMMIT=$(git rev-parse HEAD) \
  SWARMENV_WORKTREE_DIRTY=false SWARMENV_WORKTREE_STATUS=clean
timeout 7500s node scripts/run-putnambench-benchmark.mjs \
  --problems config/putnambench-12.json \
  --putnambench-root /home/ubuntu/PutnamBench \
  --problem putnam_2025_b1 --cores 4 --project-parallelism 1 \
  --timebox-ms 7200000 --parallel-mode semantic --normal-flow \
  --experiment-root experiments \
  --experiment-dir experiments/issue-111-2h-20261102 \
  --report-dir experiments/issue-111-2h-20261102/analysis/runner-report \
  --observability-host 127.0.0.1 --observability-port 8894
```

## Allowed variation and judgment

- This single treatment run is a mechanism/coverage observation, not a
  statistical comparison. A matched pre-Issue baseline run is still required
  for a before/after claim; until then comparative statements are
  **INCONCLUSIVE**.
- No prompt/schema change is made for this run beyond the implementation under
  test. No hidden budget, no threshold adjustment after the fact.
- Core phenomena to look for: A01–A03 (same-Execution FAIL→revision→check),
  B01/B03/B04 (shared Mission, same-Core continuation), B08 (checkpoint/handoff
  and file lineage), C01 (feedback changes action). Missing events are recorded
  as uncovered, not as PASS.
- A two-hour non-solve does not by itself negate mechanism fixes; a solve is
  reported as the final mathematical result separately.
- Raw logs/state stay under the ignored experiment directory. Public summaries
  use sanitized Task/Execution/Material/commit/CheckResult identifiers only.
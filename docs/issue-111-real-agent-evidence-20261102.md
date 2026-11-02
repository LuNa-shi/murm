# Issue #111 real-Agent evidence

This is a sanitized record for the implementation commit used by the Issue
#111 acceptance attempt. It contains no Agent transcript, proof source,
credential, stdout, or stderr.

## Fixed inputs

- Implementation commit: `d20363c6f1814e09615402d369abbfb2e176cbb6`
- Worktree: `/home/ubuntu/SwarmEnv/.worktrees/issue-111-task-centric-phase1`
- Worktree state at launch: clean (`git status --porcelain` was empty)
- PutnamBench commit: `a635813f5edf297d928f9bd5ef8324a26bdde09c`
- Lean project root: `/home/ubuntu/PutnamBench/lean4`
- Locked toolchain: `leanprover/lean4:v4.33.1`
- Mathlib revision: `0df444a360eaa60ab8c11dca51a86af692955474`
- Checker: `lean`, version `mvp-1`
- Default target route: `openai` / `gpt-6.1-sol`
- Local `.env` route: `openai-codex` / `gpt-6.1-sol`

The required local variables were present in the ignored worktree `.env`; no
secret values were recorded. Node, NuRouter, Pi, Lean, and Lake were all
available in the readiness probe.

## Deterministic validation

The final implementation passed:

```text
npm test                         301/301
node --test test/phase1-s3.test.js 5/5
git diff --check                 clean
```

The S3 test was also repeated five times after the checkpoint queue fix. The
implementation includes canonical Task supply, shared Mission admission,
same-Execution Judge feedback, Progress checkpoint/handoff, per-Execution
feedback receipts, and bounded compaction identity rotation.

## Real-Agent probes

The final corrected probe below used the clean implementation commit above and
the locked PutnamBench revision. Earlier route diagnostics were run before the
final implementation commit and are identified as such; none is acceptance
evidence for the two-hour benchmark.

1. A preliminary explicit default `openai` route, run against an earlier clean
   implementation commit, returned a sanitized `READY_TO_LAUNCH` preflight
   followed by `RPC_ERROR / real_agent_path_error` before a usable Agent turn.
2. A preliminary copied local `.env` route omitted
   `SWARMENV_PUTNAMBENCH_ROOT`; its checker preflight was unavailable. This was
   diagnostic-only and was corrected before the final probe.
3. The final corrected local `.env` route on the implementation commit above
   returned `READY_TO_LAUNCH` with all required tools and the locked project
   root, then ended as `FAILED` with `RPC_ERROR / timeout` while Task and
   Execution remained `RUNNING`; no Material or CheckResult was produced. No
   two-hour benchmark was started, so the real acceptance gate is **BLOCKED**
   by the local Agent route/turn availability.

The corrected controlled probe command is:

```sh
set -a; source .env; set +a
export SWARMENV_PUTNAMBENCH_ROOT=/home/ubuntu/PutnamBench/lean4 \
  SWARMENV_IMPLEMENTATION_COMMIT=d20363c6f1814e09615402d369abbfb2e176cbb6 \
  SWARMENV_WORKTREE_DIRTY=false SWARMENV_WORKTREE_STATUS=clean
timeout 420s node scripts/run-mvp-fixture.mjs --real-agent
```

Once the probe can complete a real Agent turn, the Issue's two-hour run must
be launched from the same clean implementation commit with four Cores, the
same provider/model, and the locked checker. The canonical benchmark shape is:

```sh
set -a; source .env; set +a
export SWARMENV_PUTNAMBENCH_ROOT=/home/ubuntu/PutnamBench/lean4 \
  SWARMENV_IMPLEMENTATION_COMMIT=d20363c6f1814e09615402d369abbfb2e176cbb6 \
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

No mathematical solve, orchestration improvement, or real compaction
rotation claim is made from the blocked probes.

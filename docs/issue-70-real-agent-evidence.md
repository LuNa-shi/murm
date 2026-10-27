# Issue #70 real-Agent acceptance evidence

The implementation tested below is commit
`4fd9c55e7b86ffbf2d49f6baf70be95a3c1b2f47`. The Issue worktree was clean for
the deterministic checks and the real-Agent probes. The commit is the current
code head of PR #73; later documentation-only commits do not change it.

The locked fixture is `putnam-1966-a1`, using PutnamBench commit
`a635813f5edf297d928f9bd5ef8324a26bdde09c` and Lean project root
`/home/ubuntu/PutnamBench/lean4`. The local route was loaded from the ignored
worktree `.env` as `openai-codex` with model `gpt-6.1-sol`; no credential value
is stored in the repository or report.

Deterministic validation completed with `npm test` at **205/205 passing** and
`git diff --check` clean. The added regression covers both plain-text artifact
content and the source-wrapped artifact shape emitted by the local Agent route;
the bridge regression covers releasing the original Task/Execution binding when
Runtime handoff fails.

The remote PR content before `081d2aa` was tested directly at commit
`59328908f2d0e17a2e73a19442209151269b10f1`. Its deterministic suite passed
203/203, but its real-Agent fixture path failed after the Agent published an
artifact whose content was `{source: ...}`. The Judge correctly rejected that
shape as non-checkable input, so the fixture stopped with one Material and one
CheckResult. This was a PR-path compatibility defect, not an authentication
failure.

The fix normalizes only at the Judge boundary: a Material may retain either a
plain source string or a `{source: string}` content object, while the checker
always receives the complete Lean source text. The prompt now asks for the
plain-string form, and the compatibility test rejects unrelated object shapes.

The source-wrapper fix was then run through the one-Core real-Agent fixture
using a 600,000 ms Agent-turn limit at implementation commit `081d2aa`. Its
sanitized report is retained at
`experiments/exp-20261026-issue70-real-agent-probe-openai-codex-r3/analysis/probe.json`.
The report records:

- probe status `READY_TO_LAUNCH`;
- implementation commit `081d2aa904920572b464b0713397fbb9096a7e50`;
- clean worktree, fixture commit, and Lean project root;
- provider `openai-codex`, model `gpt-6.1-sol`, and `secret_values_recorded: false`;
- two artifact Materials and two CheckResults in one Execution;
- first CheckResult `source_failure`/`FAIL`, followed by a second `PASS`;
- the diagnostic was delivered, the revised Material changed the reported
  source location, and no wait/restart handoff occurred.

After that one-Core success, a clean four-Core semantic attempt was started at
`081d2aa` with the locked 12-problem configuration. It exposed a separate
handoff cleanup defect: a failed Runtime bind left a stale Core Execution
identity, producing roughly 100,000 reconciliations and 1.2 GB of audit logs in
under five minutes. The run was stopped before any acceptance report was
written. `4fd9c55` fixes that path by delivering the original binding to the
Bridge release hook before surfacing the handoff error; the regression and a
short real-route smoke both pass after the fix.

The required four-Core semantic benchmark with a 7,200,000 ms timebox remains
outstanding. The exact clean rerun command is:

```sh
env NUROUTER_PI_PROVIDER=openai-codex \
    NUROUTER_PI_MODEL=gpt-6.1-sol \
    SWARMENV_IMPLEMENTATION_COMMIT=4fd9c55e7b86ffbf2d49f6baf70be95a3c1b2f47 \
    SWARMENV_WORKTREE_DIRTY=false \
    SWARMENV_WORKTREE_STATUS=clean \
    SWARMENV_PUTNAMBENCH_ROOT=/home/ubuntu/PutnamBench/lean4 \
    SWARMENV_TIMEBOX_MS=7200000 \
    timeout 7500s node scripts/run-putnambench-benchmark.mjs \
      --problems config/putnambench-12.json \
      --putnambench-root /home/ubuntu/PutnamBench \
      --cores 4 \
      --timebox-ms 7200000 \
      --parallel-mode semantic \
      --observability-host 127.0.0.1 \
      --observability-port 8810
```

The full acceptance report must repeat the exact implementation commit and a
clean worktree. The one-Core fixture result and the short smoke are diagnostic
and route/lifecycle validation evidence; they do not replace that four-Core
run.

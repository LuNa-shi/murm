# Issue #70 real-Agent acceptance evidence

The implementation tested below is commit
`081d2aa904920572b464b0713397fbb9096a7e50`. The Issue worktree was clean for
the deterministic checks and the real-Agent probe. The commit is the current
head of PR #73.

The locked fixture is `putnam-1966-a1`, using PutnamBench commit
`a635813f5edf297d928f9bd5ef8324a26bdde09c` and Lean project root
`/home/ubuntu/PutnamBench/lean4`. The local route was loaded from the ignored
worktree `.env` as `openai-codex` with model `gpt-6.1-sol`; no credential value
is stored in the repository or report.

Deterministic validation completed with `npm test` at **204/204 passing** and
`git diff --check` clean. The added regression covers both plain-text artifact
content and the source-wrapped artifact shape emitted by the local Agent route.

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

The exact PR head was then run through the one-Core real-Agent fixture using a
600,000 ms Agent-turn limit. Its sanitized report is retained at
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

This proves the local Pi route and the PR's candidate feedback path. It is not
the full Issue acceptance run: the required four-Core semantic benchmark with
a 7,200,000 ms timebox remains outstanding. The exact rerun command is:

```sh
env NUROUTER_PI_PROVIDER=openai-codex \
    NUROUTER_PI_MODEL=gpt-6.1-sol \
    SWARMENV_IMPLEMENTATION_COMMIT=081d2aa904920572b464b0713397fbb9096a7e50 \
    SWARMENV_WORKTREE_DIRTY=false \
    SWARMENV_WORKTREE_STATUS=clean \
    SWARMENV_PUTNAMBENCH_ROOT=/home/ubuntu/PutnamBench/lean4 \
    SWARMENV_TIMEBOX_MS=7200000 \
    timeout 7500s node scripts/run-putnambench-benchmark.mjs \
      --problems config/putnambench-12.json \
      --putnambench-root /home/ubuntu/PutnamBench/lean4 \
      --cores 4 \
      --timebox-ms 7200000 \
      --parallel-mode semantic
```

The full acceptance report must repeat the exact implementation commit and a
clean worktree. The one-Core fixture result above is diagnostic and route
validation evidence; it does not replace that four-Core run.

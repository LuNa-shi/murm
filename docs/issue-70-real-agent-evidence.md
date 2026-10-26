# Issue #70 real-Agent acceptance evidence

The deterministic implementation is pinned to commit
`6ab27c709cd1129e00e3474ff9c8bb4545d25b1d`. At the time of the probe,
`git status --porcelain` was empty.

The locked benchmark fixture is `putnam-1966-a1`, using PutnamBench commit
`a635813f5edf297d928f9bd5ef8324a26bdde09c` and Lean project root
`/home/ubuntu/PutnamBench/lean4`. The intended acceptance run uses four Cores,
the `semantic` mode, the `openai` provider, `gpt-6.1-sol`, and a 7,200,000 ms
timebox.

The required readiness probe was run from this worktree with:

```sh
node scripts/run-mvp-fixture.mjs --real-agent
```

The sanitized probe report was written to
`/tmp/swarmenv-issue70-real-agent-probe.json`. It returned `BLOCKED` because
`NUROUTER_PI_PROVIDER` and `NUROUTER_PI_MODEL` were absent. Node, NuRouter,
Pi, Lean, and Lake were available; no secret values were recorded. The
two-hour Agent run was therefore not launched, and there is no runtime result
to interpret as acceptance evidence.

After the route is configured, the exact rerun command is:

```sh
NUROUTER_PI_PROVIDER=openai \
NUROUTER_PI_MODEL=gpt-6.1-sol \
SWARMENV_IMPLEMENTATION_COMMIT=6ab27c709cd1129e00e3474ff9c8bb4545d25b1d \
SWARMENV_WORKTREE_DIRTY=false \
SWARMENV_WORKTREE_STATUS=clean \
SWARMENV_TIMEBOX_MS=7200000 \
node scripts/run-putnambench-benchmark.mjs \
  --problems config/putnambench-12.json \
  --putnambench-root /home/ubuntu/PutnamBench/lean4 \
  --cores 4 \
  --timebox-ms 7200000 \
  --parallel-mode semantic
```

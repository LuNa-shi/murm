# Issue #70 real-Agent acceptance evidence

The readiness probe below was run against implementation commit
`6ab27c709cd1129e00e3474ff9c8bb4545d25b1d`. At the time of that probe,
`git status --porcelain` was empty. The current branch contains additional
lifecycle and Controller changes after that probe; those changes have not had
the two-hour run, so this document does not present the old probe as current
acceptance evidence.

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

Deterministic validation for implementation commit
`4c5bf1f35cd119f83914dffc30e454ea6ab3a39b` completed with `npm test` at
194/194 passing and `git diff --check` clean. These checks validate the local
Task Controller, Core Daemon, Runtime, lifecycle, selection, and migration
paths; they do not substitute for the required real-Agent run.

After the route is configured, the exact rerun command is:

```sh
NUROUTER_PI_PROVIDER=openai \
NUROUTER_PI_MODEL=gpt-6.1-sol \
SWARMENV_IMPLEMENTATION_COMMIT=4c5bf1f35cd119f83914dffc30e454ea6ab3a39b \
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

The command is pinned to the current implementation commit
`4c5bf1f35cd119f83914dffc30e454ea6ab3a39b`; a later documentation-only commit
must not change that value. A successful acceptance report must repeat the
same implementation commit; the current result remains environment-blocked
until the route variables are available and the probe is rerun.

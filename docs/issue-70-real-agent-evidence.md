# Issue #70 real-Agent acceptance evidence

The historical readiness probe below was run against implementation commit
`6ab27c709cd1129e00e3474ff9c8bb4545d25b1d`. At the time of that probe,
`git status --porcelain` was empty. It remains historical because later
lifecycle and Controller changes require a fresh clean-commit run.

The locked benchmark fixture is `putnam-1966-a1`, using PutnamBench commit
`a635813f5edf297d928f9bd5ef8324a26bdde09c` and Lean project root
`/home/ubuntu/PutnamBench/lean4`. The intended acceptance run uses four Cores,
the `semantic` mode, the `openai` provider, `gpt-6.1-sol`, and a 7,200,000 ms
timebox.

The required readiness probe was run from this worktree with:

```sh
node scripts/run-mvp-fixture.mjs --real-agent
```

The current clean-commit readiness probe was run with the same command at
implementation commit `c6721c199c28f4318e975a3d279691d04decd4db`, with an
empty `git status --porcelain`. Its sanitized report is retained at
`experiments/exp-20261026-issue70-readiness/analysis/preflight.json` (the
analysis directory is ignored as required for local experiment state). It
returned `BLOCKED` because `NUROUTER_PI_PROVIDER` and
`NUROUTER_PI_MODEL` were absent. Node, NuRouter, Pi, Lean, and Lake were
available; no secret values were recorded. The probe stopped before creating
an Experiment, so the report's experiment identity fields are null. The
two-hour Agent run was therefore not launched, and there is no runtime result
to interpret as acceptance evidence.

Deterministic validation for implementation commit
`c6721c199c28f4318e975a3d279691d04decd4db` completed with `npm test` at
203/203 passing and `git diff --check` clean. These checks validate the local
Task Controller, Core Daemon, Runtime, lifecycle, selection, typed dependency,
report, and migration paths; they do not substitute for the required
real-Agent run.

The retained probe is bound to the exact clean implementation commit above;
the probe itself reports a null implementation field because it stopped
before benchmark launch. Its versions were Node `v24.21.0`, NuRouter
`0.2.14`, Pi `1.4.0`, Lean `4.33.1`, and Lake `5.0.0`.

After the route is configured, the exact rerun command is:

```sh
NUROUTER_PI_PROVIDER=openai \
NUROUTER_PI_MODEL=gpt-6.1-sol \
SWARMENV_IMPLEMENTATION_COMMIT=c6721c199c28f4318e975a3d279691d04decd4db \
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
`c6721c199c28f4318e975a3d279691d04decd4db`; a later documentation-only commit
must not change that value. A successful acceptance report must repeat the
same implementation commit; the current result remains environment-blocked
until the route variables are available and the probe is rerun.

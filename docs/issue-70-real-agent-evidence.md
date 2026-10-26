# Issue #70 real-Agent acceptance evidence

The implementation under acceptance review is commit
`c6721c199c28f4318e975a3d279691d04decd4db`. The worktree was clean when the
runtime probes below were launched. Later documentation-only commits do not
change that implementation identity.

The locked benchmark fixture is `putnam-1966-a1`, using PutnamBench commit
`a635813f5edf297d928f9bd5ef8324a26bdde09c` and Lean project root
`/home/ubuntu/PutnamBench/lean4`. The intended acceptance run uses four Cores,
the `semantic` mode, the `openai` provider, `gpt-6.1-sol`, and a 7,200,000 ms
timebox.

Deterministic validation for the implementation completed with `npm test` at
203/203 passing and `git diff --check` clean. These checks cover the Task
Controller, Core Daemon, Runtime, lifecycle, selection, typed dependency,
report, and migration paths. They do not substitute for the required
real-Agent run.

The first readiness probe used the worktree's normal environment and returned
`BLOCKED` because `NUROUTER_PI_PROVIDER` and `NUROUTER_PI_MODEL` were absent.
Node, NuRouter, Pi, Lean, and Lake were available; no secret values were
recorded. That report is retained at
`experiments/exp-20261026-issue70-readiness/analysis/preflight.json`.

The readiness check was then repeated with the route supplied explicitly in
the process environment, as permitted by the repository run agreement:

```sh
NUROUTER_PI_PROVIDER=openai \
NUROUTER_PI_MODEL=gpt-6.1-sol \
node --input-type=module -e \
  'import { probeRealAgentConfig } from "./src/index.js"; console.log(JSON.stringify(await probeRealAgentConfig({ env: process.env }), null, 2));'
```

That probe returned `READY_TO_LAUNCH` with Node `v24.21.0`, NuRouter
`0.2.14`, Pi `1.4.0`, Lean `4.33.1`, and Lake `5.0.0`. The local fixture
probe was subsequently run with the same explicit route and with the exact
implementation metadata attached. Its sanitized report is retained at
`experiments/exp-20261026-issue70-real-agent-probe-explicit-metadata/analysis/probe.json`.
The report records the clean implementation commit, the locked fixture and
tool versions, and:

- probe status: `READY_TO_LAUNCH`;
- run status: `FAILED`, code `RPC_ERROR`, before any Material or CheckResult;
- no Agent turn or two-hour acceptance run started;
- `secret_values_recorded: false`.

A separate sanitized protocol diagnostic in the same ignored analysis
directory shows that `get_state`, auto-compaction, and auto-retry succeeded,
while the first `prompt` RPC was rejected with an `auth_or_credential`
classification. The read-only command
`pi auth check --provider openai --model gpt-6.1-sol --json --no-refresh`
returned `not_ready` with `credentials_not_configured`. No response text,
credentials, transcript, or proof content was retained. This identifies the
remaining blocker as the active provider authentication/credential route after
local readiness, rather than a missing binary or a Task Controller lifecycle
result.

After the provider route is authenticated, the exact acceptance command is:

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

The acceptance report from that command must repeat
`c6721c199c28f4318e975a3d279691d04decd4db` and a clean worktree. The required
two-hour run remains outstanding until the provider authentication route is
available; the current `RPC_ERROR` result is diagnostic evidence, not
acceptance evidence.

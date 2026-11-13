# EXP-20261112-07: Single-problem Issue #122 acceptance run

Status: BLOCKED
Approved GitHub Issue: [Issue #122](https://github.com/LuNa-shi/SwarmEnv/issues/122)
Experiment ID: `EXP-20261112-07`
Repeat of / comparison to: `EXP-20261112-06` (short smoke confirmed clean claim normalization)

## Setup (record before the run)

| Item | Fixed value or reference |
|---|---|
| Scope | One locked problem, `putnam_2025_b1`, four Core lanes, one complete 3,600,000 ms timebox. |
| Implementation commit | `7ceda2f`; modern Mission claims normalize legacy resume spelling to a clean Execution Workspace. |
| Problem/config | `config/putnambench-12.json`, PutnamBench commit `a635813f5edf297d928f9bd5ef8324a26bdde09c`. |
| Provider/model | `gpt_proxy` / `gpt-6.1-sol`; OpenSandbox `release-1.2.0`, image `swarmenv/agent:issue122`. |
| Protocol | 4 Cores, `--problem putnam_2025_b1`, `--timebox-ms 3600000`, `--parallel-mode semantic`, `--project-parallelism 1`. |
| Raw evidence | Ignored `experiments/EXP-20261112-07/`, `reports/EXP-20261112-07/`, PID file and runner log. |

Detached command:

```bash
setsid env \
  SWARMENV_SANDBOX_ENABLED=true \
  SWARMENV_SANDBOX_PROVIDER=opensandbox \
  SWARMENV_SANDBOX_IMAGE=swarmenv/agent:issue122 \
  SWARMENV_OPENSANDBOX_URL=http://127.0.0.1:8080 \
  SWARMENV_BRIDGE_HOST=172.17.0.1 \
  SWARMENV_BRIDGE_PUBLIC_URL='http://172.17.0.1:{port}' \
  nohup node scripts/run-putnambench-benchmark.mjs \
    --problems config/putnambench-12.json \
    --putnambench-root /home/ubuntu/PutnamBench \
    --problem putnam_2025_b1 \
    --cores 4 \
    --project-parallelism 1 \
    --timebox-ms 3600000 \
    --parallel-mode semantic \
    --experiment-root experiments \
    --experiment-dir experiments/EXP-20261112-07 \
    --report-dir reports/EXP-20261112-07 \
    --observability-port 8822 \
    --provider gpt_proxy \
    --model gpt-6.1-sol \
    > experiments/EXP-20261112-07-runner.log 2>&1 < /dev/null &
echo $! > experiments/EXP-20261112-07.pid
```

## Results

The detached run started at `2026-11-13T05:51:32Z` and was stopped after about six
minutes because it entered a deterministic recovery loop. One project and four Core
lanes were used. The provider URL was valid and `task_take` was recorded with
`workspace_selection.mode: clean`; five Execution attempts on core-4 then ended as
`FENCED` with `terminal_reason: recovery_exhausted` after `process_error`. Runtime
recorded repeated `sandbox_sync_error` with `NOT_ALLOWED` while stopping those
sandboxes. No Material publication, Judge check, candidate, or Mission completion
was recorded. The runner and all `swarmenv/agent:issue122` containers were stopped;
raw logs and SQLite state remain under the ignored experiment directory. No final
project report was produced.

## Analysis

This run supports only bounded infrastructure observations: OpenSandbox/provider
startup, authenticated Task claim, clean Workspace selection, and durable recovery
records. It does not support the one-hour acceptance claim. The failure is distinct
from the earlier Invalid URL and resume-mode defects, and exposes an unresolved
Runtime/provider process lifecycle problem. The implementation also still does not
show a Bot-created proposal from a genuinely zero Task Mission: the benchmark owner
created the locked workload after recording the zero-task event.

## Next steps

- Agent recommendation: analyze the report after the one-hour boundary and cleanup.
- Within-Issue work already authorized: bounded diagnosis and retest of protocol failures.
- New scope or resource request: return to Issue #122.

## Evidence and limitations

The run is intentionally scoped to one problem so one complete hour produces a
single coherent evidence set. It does not claim a 12-problem quality estimate.

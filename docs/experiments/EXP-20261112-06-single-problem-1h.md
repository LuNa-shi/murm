# EXP-20261112-06: Single-problem Issue #122 acceptance run

Status: REGISTERED
Approved GitHub Issue: [Issue #122](https://github.com/LuNa-shi/SwarmEnv/issues/122)
Experiment ID: `EXP-20261112-06`
Repeat of / comparison to: `EXP-20261112-05` (stopped after clean-workspace inspection)

## Setup (record before the run)

| Item | Fixed value or reference |
|---|---|
| Scope | One locked problem, `putnam_2025_b1`, four Core lanes, one complete 3,600,000 ms timebox. |
| Implementation commit | `9ac4012`; modern Mission claims normalize legacy resume spelling to a clean Execution Workspace. |
| Problem/config | `config/putnambench-12.json`, PutnamBench commit `a635813f5edf297d928f9bd5ef8324a26bdde09c`. |
| Provider/model | `gpt_proxy` / `gpt-6.1-sol`; OpenSandbox `release-1.2.0`, image `swarmenv/agent:issue122`. |
| Protocol | 4 Cores, `--problem putnam_2025_b1`, `--timebox-ms 3600000`, `--parallel-mode semantic`, `--project-parallelism 1`. |
| Raw evidence | Ignored `experiments/EXP-20261112-06/`, `reports/EXP-20261112-06/`, PID file and runner log. |

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
    --experiment-dir experiments/EXP-20261112-06 \
    --report-dir reports/EXP-20261112-06 \
    --observability-port 8822 \
    --provider gpt_proxy \
    --model gpt-6.1-sol \
    > experiments/EXP-20261112-06-runner.log 2>&1 < /dev/null &
echo $! > experiments/EXP-20261112-06.pid
```

## Results

Pending execution. Record actual start/end, protocol validity, public Workspace ID and
revision, Mission submission state, Task/Execution/Material/Judge evidence, cleanup,
and exact observed timebox after the run.

## Analysis

Pending execution. Protocol validity and engineering contract evidence remain
separate from proof quality or research benefit.

## Next steps

- Agent recommendation: analyze the report after the one-hour boundary and cleanup.
- Within-Issue work already authorized: bounded diagnosis and retest of protocol failures.
- New scope or resource request: return to Issue #122.

## Evidence and limitations

The run is intentionally scoped to one problem so one complete hour produces a
single coherent evidence set. It does not claim a 12-problem quality estimate.

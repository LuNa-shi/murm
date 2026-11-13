# EXP-20261112-05: Single-problem Issue #122 acceptance run

Status: BLOCKED
Approved GitHub Issue: [Issue #122](https://github.com/LuNa-shi/SwarmEnv/issues/122)
Experiment ID: `EXP-20261112-05`
Repeat of / comparison to: `EXP-20261112-04` (stopped after clean-workspace fix)

## Setup (record before the run)

| Item | Fixed value or reference |
|---|---|
| Scope | One locked problem, `putnam_2025_b1`, four Core lanes, one complete 3,600,000 ms timebox. |
| Implementation commit | `be3d1d5`; modern Mission claims explicitly start with a clean Execution Workspace. |
| Problem/config | `config/putnambench-12.json`, PutnamBench commit `a635813f5edf297d928f9bd5ef8324a26bdde09c`. |
| Provider/model | `gpt_proxy` / `gpt-6.1-sol`; OpenSandbox `release-1.2.0`, image `swarmenv/agent:issue122`. |
| Protocol | 4 Cores, `--problem putnam_2025_b1`, `--timebox-ms 3600000`, `--parallel-mode semantic`, `--project-parallelism 1`. |
| Raw evidence | Ignored `experiments/EXP-20261112-05/`, `reports/EXP-20261112-05/`, PID file and runner log. |

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
    --experiment-dir experiments/EXP-20261112-05 \
    --report-dir reports/EXP-20261112-05 \
    --observability-port 8821 \
    --provider gpt_proxy \
    --model gpt-6.1-sol \
    > experiments/EXP-20261112-05-runner.log 2>&1 < /dev/null &
echo $! > experiments/EXP-20261112-05.pid
```

## Results

The detached process started and reached a live Task/Execution with four OpenSandbox
sandboxes, but the run was stopped during the first minute after inspection found that
Agent `task_take` still sent `workspace_mode: resume`. The process and four sandboxes
were then stopped and removed. No final project report was produced. This run is
therefore blocked and is not acceptance evidence.

## Analysis

The provider path remained healthy, but the modern Workspace contract was not yet
observable at the claim boundary. The run cannot support conclusions about proof
quality, Mission submission, or one-hour behavior. The follow-up fix normalizes modern
claims to `clean` unless explicit recovery lineage is supplied.

## Next steps

- Agent recommendation: analyze the report after the one-hour boundary and cleanup.
- Within-Issue work already authorized: bounded diagnosis and retest of protocol failures.
- New scope or resource request: return to Issue #122.

## Evidence and limitations

The run is intentionally scoped to one problem so one complete hour produces a
single coherent evidence set. It does not claim a 12-problem quality estimate.

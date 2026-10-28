# Benchmark environment

Real Agent Core experiments require the NuRouter route to be explicit in the
shell. The repository records the non-secret route defaults in
[`.env.example`](../.env.example):

```dotenv
NUROUTER_PI_PROVIDER=openai
NUROUTER_PI_MODEL=gpt-6.1-sol
```

The current shell did not have either variable set when the previous benchmark
was started. Load a local `.env` before running a real experiment:

```sh
cp .env.example .env
set -a
. ./.env
set +a
```

`.env` is ignored by Git. Do not put API keys, bearer tokens, or other
credentials in `.env.example`, experiment metadata, Task records, Material,
CheckResult, or benchmark reports.

PutnamBench and its Lean dependencies are also local inputs to a real run. The
checkout and dependency revisions used by a run must be pinned and recorded in
the experiment metadata:

```sh
git clone https://github.com/trishullab/PutnamBench.git /home/ubuntu/PutnamBench
git -C /home/ubuntu/PutnamBench checkout --detach <putnambench-commit>
curl --proto '=https' --tlsv1.2 -sSf https://elan.lean-lang.org/elan-init.sh | sh -s -- -y --default-toolchain none
export PATH="$HOME/.elan/bin:$PATH"
elan toolchain install leanprover/lean4:v4.33.1
elan default leanprover/lean4:v4.33.1
(cd /home/ubuntu/PutnamBench/lean4 && lake exe cache get && lake build)
```

The exact toolchain comes from `PutnamBench/lean4/lean-toolchain`; the Mathlib
revision comes from its Lake lockfile. A run is valid only after the checkout
and the complete local `lake build` succeed. The benchmark runner passes the
local Lean project to the Judge and does not download dependencies during an
experiment.

The benchmark CLI now uses a repository-local experiment directory and a
separate report directory by default. For a named run, pass both explicitly:

```sh
node scripts/run-putnambench-benchmark.mjs \
  --problems config/putnambench-12.json \
  --putnambench-root /path/to/PutnamBench \
  --cores 4 \
  --project-parallelism 3 \
  --timebox-ms 3600000 \
  --experiment-dir experiments/putnambench-4core-YYYY-MM-DD-run \
  --report-dir reports/putnambench-4core-YYYY-MM-DD-run
```

Every `--experiment-dir` must be below `experiments/`. The runner reuses the
persistent observation server backed by
`experiments/.observability/observability.sqlite`; it does not stop that
server when the benchmark ends. To expose the UI to a workstation in the same
Tailscale network, use `--observability-host 0.0.0.0` and advertise the server
Tailscale address with `--observability-advertise-host`. When the runner is
started from another checkout, set
`SWARMENV_OBSERVABILITY_METADATA=/absolute/path/to/experiments/.observability/public-server.json`
to force reuse of the single long-lived service rather than starting another
port.

Every experiment directory should contain, at minimum:

- the repository commit used by the runner;
- the pinned PutnamBench commit;
- the route and model names, without credentials;
- the exact protocol parameters;
  - durable `logs/` for each service, bridge, Runtime, Judge, and Agent Core;
  - durable `state/` with SQLite and execution state;
  - durable `workspaces/` for task input and execution files.

The separate report directory contains the sanitized aggregate result and
per-problem solved status, candidate/check counts, and audit status.

Raw SQLite databases, Pi sessions, candidate source, proof text, stdout, and
stderr remain persistent under `experiments/<id>/`, but are ignored by Git.
They are evidence for local audit and recovery. Reports are the shareable
surface and never export those fields.

The completed 12-problem baseline is recorded in
[`experiments/putnambench-4core-2026-10-18-rerun`](../experiments/putnambench-4core-2026-10-18-rerun/).
The final-code four-core acceptance run is recorded in
[`experiments/putnambench-4core-2026-10-18-pilot-real-v5`](../experiments/putnambench-4core-2026-10-18-pilot-real-v5/),
with its sanitized report in
[`reports/putnambench-4core-2026-10-18-pilot-real-v5`](../reports/putnambench-4core-2026-10-18-pilot-real-v5/).

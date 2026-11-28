# TaskPool Harness

## Run from your project

```sh
cd my-project
murm --harness taskpool --prompt "Inspect this project and explain how to verify it"
```

TaskPool creates the Mission and its Workspace in the Run directory. The prompt is the Mission goal. Discovery starts from the read-only project and execution uses the Workspace revision selected when it takes a Task.

After installing the built tarball, configure the model route, compatible Worker image and other runtime resources described below. A JavaScript config can also be supplied with `--config`. The common command saves its outputs outside the input directory by default.


Configure `MURM_MODEL_URL` (or `MURM_TASKPOOL_MODEL_URL`), or supply a config module with `image`, `sandbox`, `models` and optional `connection` and `executor`. The default pool places two Agents within a 120-second work window, with 30 seconds for close. Use `capacity`, `workTimeoutMs` and `closeTimeoutMs` in the configuration to change these limits.

See the [mechanism guide](../../docs/en/harnesses/taskpool.md) for Task leases and Workspace publication.

## Owned services and deployment

The project entry creates Task and Context SQLite stores, the Mission Workspace
and per-Agent working directories under its run output. It registers the
example's coordination Services with the Runtime. You do not need to start the
standalone Task/Context/Judge/Catalog Compose recipe for this path.

Optional Mathlib search and Lean checking are explicit domain integrations;
configure them only for workloads that need them. Their dependencies are not
requirements of the ordinary project command. The older standalone service-host
recipe has documented readiness/coordination limits and is not the default
TaskPool deployment.

From this example directory after building at the checkout root:

```sh
node ../../dist/scripts/murm.js --harness taskpool \
  --cwd /absolute/path/to/project --prompt 'Implement the requested change and verify it'
```

The common `MURM_MODEL_*`, `MURM_EXECUTOR` and Sandbox environment settings take
precedence over scoped TaskPool settings. The default Worker image is resolved
for the executor; an explicit `MURM_TASKPOOL_IMAGE` is optional.

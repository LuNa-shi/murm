# TaskPool Harness

## Run from your project

```sh
cd my-project
murm --harness taskpool --prompt "Inspect this project and explain how to verify it"
```

TaskPool creates the Mission and its Workspace in the Run directory. The prompt is the Mission goal. Discovery starts from the read-only project and execution uses the Workspace revision selected when it takes a Task.

After installing the built tarball, configure the model route, compatible Worker image and other runtime resources described below. A JavaScript config can also be supplied with `--config`. The common command saves its outputs outside the input directory by default.


Configure `MURM_TASKPOOL_IMAGE` and `MURM_TASKPOOL_MODEL_URL`, or supply a config module with `image`, `sandbox`, `models` and optional `connection` and `executor`. The default pool places two Agents within a 120-second work window, with 30 seconds for close. Use `capacity`, `workTimeoutMs` and `closeTimeoutMs` in the configuration to change these limits.

See the [mechanism guide](../../docs/en/harnesses/taskpool.md) for Task leases and Workspace publication.

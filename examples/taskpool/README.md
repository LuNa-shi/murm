# TaskPool Harness

## Run the project example

Use Node.js 22.19 or newer on Linux. Set `MURM_ARCHIVE` to the absolute path of
the SDK tarball built from this revision. The published v0.2.0 archive predates
the project author API used here. See [SDK preparation](../README.md#run-an-example-from-its-directory)
for the pack command, Sandbox setup and model configuration.

From this example directory:

```sh
npm install --no-save "$MURM_ARCHIVE"
npm run check
npm run build
npm run start -- --cwd /absolute/path/to/project \
  --prompt 'Implement the requested change and verify it'
```

TaskPool creates the Mission and its Workspace in the run directory. The prompt
becomes the Mission goal. Agents discover work from a read-only tree and receive
the selected Workspace revision when they take a Task. The final
`project-run.json` points to the TaskPool report and any artifacts. Check the
report for publication, retained Workspace state and cleanup receipts.

Configure `MURM_MODEL_URL` (or `MURM_TASKPOOL_MODEL_URL`), or supply a config module with `image`, `sandbox`, `models` and optional `connection` and `executor`. The default pool places two Agents within a 120-second work window, with 30 seconds for close. Use `capacity`, `workTimeoutMs` and `closeTimeoutMs` in the configuration to change these limits.

See the [mechanism guide](../../docs/en/harnesses/taskpool.md) for Task leases and Workspace publication.

## Owned services and deployment

The project entry creates Task and Context SQLite stores, the Mission Workspace
and per-Agent working directories under its run output. It registers the
example's coordination Services with the Runtime. You do not need to start the
[standalone Task/Context/Judge/Catalog Compose recipe](deploy/service-hosts/README.md) for this path.

Optional Mathlib search and Lean checking are explicit domain integrations;
configure them only for workloads that need them. Their dependencies are not
requirements of the ordinary project command. The older standalone service-host
recipe has documented readiness/coordination limits and is not the default
TaskPool deployment.

The common `MURM_MODEL_*`, `MURM_EXECUTOR` and Sandbox environment settings take
precedence over scoped TaskPool settings. The default Worker image is resolved
for the executor; an explicit `MURM_TASKPOOL_IMAGE` is optional.

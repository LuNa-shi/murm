# Lead-Worker Harness

A Lead assigns work through a local SQLite Board and integrates Workers' Git
output. Every member has a separate Sandbox, Session and scoped Git identity.
The example owns its coordination Services and per-run identities; you supply
the Gitea facility and the common OpenSandbox/model infrastructure.

## Prepare and configure

Configure the
common `MURM_MODEL_URL`, `MURM_MODEL_TOKEN`, `MURM_MODEL_PROVIDER`,
`MURM_MODEL_ID` and optional `MURM_EXECUTOR`. Pi is the default executor;
Codex requires an explicit model ID. Scoped `MURM_LEAD_WORKER_MODEL_*` and
`MURM_LEAD_WORKER_EXECUTOR` variables remain fallbacks.

Supply these example dependencies:

| Setting | Purpose |
| --- | --- |
| `MURM_LEAD_WORKER_GITEA_ORIGIN` | Gitea origin reachable from the host and Agent network. |
| `MURM_LEAD_WORKER_GITEA_OWNER` | Owner of the retained per-run repository. |
| `MURM_LEAD_WORKER_GITEA_ADMIN_TOKEN` | Host credential permitted to create scoped accounts and repositories. |
| `MURM_LEAD_WORKER_TEAM` | Optional `static` (default) or `dynamic` project team. |
| `MURM_LEAD_WORKER_CHECKING_IMAGE` | Immutable local Docker image ID for dynamic checking; falls back to the selected Worker image. |

The Git Profiles require an enforced endpoint allowlist. The current default
therefore retains strict local Docker isolation, including a 64 MiB/4,096-inode
project quota. The default API Provider does not advertise this capability.
Follow [the strict-host prerequisites](../../docs/architecture/16-pi-opensandbox-backend.md)
or supply a compatible provider through trusted run configuration. The default
team has one Lead and two Workers, a 120-second work window and a separate
30-second close wait. `--config` can supply other supported settings.

Check the Gitea origin at `/api/v1/version` before running. In dynamic mode the
example starts and probes its checker containers, then removes those it owns on
confirmed close. Keep shared Gitea data on the persistent storage managed by
your Gitea deployment.

## Run a project

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
  --prompt 'Delegate implementation and verify the integrated result'
```

With the CLI installed, the equivalent entry is:

```sh
cd my-project
murm --harness lead-worker --prompt 'Implement the requested change and verify it'
```

The directory seeds the team repository and member files; the prompt is the
Lead's goal. This path creates its own run ID and needs no workload file.
Dynamic project mode lets the Lead create a checking Service/Profile and change
member grants through the same Board and Git project. It requires local Docker
for the example-owned checker containers; default `murm setup` does not deploy
Gitea or those application services.

Read the final report for business, export and cleanup status. A failed export
or uncertain stop can retain a Sandbox and dependent identities for
reconciliation. The shared repository and Board remain available for inspection.
Project correctness needs independent evaluation of the delivered files.

See the [mechanism guide](../../docs/en/harnesses/lead-worker.md),
[implementation manual](../../docs/architecture/20-lead-worker-harness.md) and
[dynamic-team design](../../docs/designs/dynamic-lead-worker.md).

## Fixed-team verification

The staged text report and dynamic Orders workload have dedicated launchers,
fixtures and verification at [Lead–Worker Orders](../../benchmarks/lead-worker-orders/README.md).

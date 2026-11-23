# Observability operation and data boundaries

> Type: Operations · Status: Current reference; verify flags against source · Updated 2026-11-11

`scripts/serve-observability.mjs` starts the observation service. `src/observability/` implements event ingestion, storage and queries; current source and tests take precedence over historical deployment notes. The UI provides Experiment lists, Core timelines, Execution interactions, Task/Material views and Service diagnostics.

The server reads registered SQLite event stores and serves live Server-Sent Events. Its historical report-import flags have been retired. Before starting or redeploying the service, verify the current CLI, listener address, database path, and external access controls. Never expose raw Agent conversations, candidate/proof source, credentials or private file paths on a public dashboard.

`experiments/.observability/` contains ignored local shared observation state. Preserve each experiment's observation metadata and tested code commit. Event summaries can help locate an operational issue but are not authoritative Task, Context, Judge or Runtime state, and they cannot establish useful research from utilization or Material counts alone. See [Architecture 06](../architecture/06-observability-experiments.md).

Review and reporting follow the [experiment workflow](../workflows/experiment.md), linked to the relevant human-approved GitHub Issue. A dashboard does not independently declare experimental or research success.

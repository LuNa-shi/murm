# Built-in service deployment

Positive-duration benchmark runs default to repository-owned independent Context
and Judge processes. Task, Mission and Workspace remain one coordinator. Each
peer owns its own SQLite database and exchanges authenticated private HTTP
commands with the coordinator; it never opens the Task database.

`startIndependentServices` in `src/sdk/independent-services.js` starts the peers
under exclusive instance locks, provisions credentials and pinned checker
configuration, records endpoints/PIDs, and owns shutdown. Judge startup verifies
the complete artifact lock and resource profile before becoming ready. Context
writes use durable Task-owned gates; Judge admission and process starts use
short authorized phases. Restart reconciles receipts and interrupted work.
The production checker ledger supports cleanup even after Judge process loss.
See the complete [deployment and recovery contract](../../docs/architecture/04-services.md#independent-contextjudge-deployment)
and [runner configuration](../../docs/architecture/07-run-configuration.md).

`context-service-peer.mjs` and `judge-service-peer.mjs` are the peer entrypoints.
The Judge container entrypoint `judge-peer-entrypoint.sh` supplies its mandatory
instance lock. A separately operated deployment must provide its own process
supervision, private endpoints, credentials, artifact mounts, and systemd/cgroup
access; merely exposing a port does not establish those guarantees.

## Compatibility standalone hosts

`npm run service:builtin` and `compose.yaml` retain the older generic
Task/Context/Judge/Catalog HTTP hosts. These are useful for manifest, read and
transport compatibility tests. They do **not** compose the new durable coordinator
protocol. Lifecycle-sensitive writes without local Task authority fail closed;
a healthy HTTP endpoint or a mounted checker fixture does not make this compose
file a supported positive-duration research deployment.

The generic host selects its service with `SWARMENV_SERVICE_ID`, database with
`SWARMENV_SERVICE_DATABASE`, and advertised address with
`SWARMENV_SERVICE_PUBLIC_URL`. Configure `SWARMENV_SERVICE_TOKEN` to authenticate
that host. `/healthz`, `/readyz`, `/v1/manifest` and named `/v1/<operation>` routes
are retained. Its legacy isolated mode requires configured dependency endpoints
and fails unavailable dependencies instead of opening their databases. The
explicit in-process benchmark compatibility option remains available for tests
and previously supported local compositions.

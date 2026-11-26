# Built-in service deployment

A trusted host can explicitly compose repository-owned independent Context
and Judge processes through `startIndependentServices`. Its Task, Mission and
Workspace authority remains in the coordinator. Each
peer owns its own SQLite database and exchanges authenticated private HTTP
commands with the coordinator; it never opens the Task database.

`startIndependentServices` in `src/sdk/independent-services.ts` starts the peers
under exclusive instance locks, provisions credentials and pinned checker
configuration, records endpoints/PIDs, and owns shutdown. Judge startup verifies
the complete artifact lock and resource profile before becoming ready. Context
writes use durable Task-owned gates; Judge admission and process starts use
short authorized phases. Restart reconciles receipts and interrupted work.
The production checker ledger supports cleanup even after Judge process loss.
See the complete [deployment and recovery contract](../../docs/architecture/04-services.md#independent-contextjudge-deployment)
and [host configuration](../../docs/architecture/07-run-configuration.md).

`dist/scripts/context-service-peer.js` and `dist/scripts/judge-service-peer.js` are the peer entrypoints.
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


## Host configuration and authentication

Choose `MURM_SERVICE_ID` from `task`, `context`, `judge`, `catalog`. The host
binds `0.0.0.0:8787` by default; set `MURM_SERVICE_HOST` and
`MURM_SERVICE_PORT` to override it. `MURM_SERVICE_PUBLIC_URL` is the
address advertised to clients. `MURM_SERVICE_DATABASE` defaults to
`./data/<service>.sqlite`.

Every host exposes public `/healthz`, `/readyz` and `/v1/manifest` routes, plus
named POST `/v1/<operation>` routes. Invocation requires
`MURM_SERVICE_PRINCIPALS`, a JSON array of operator-provisioned credentials:
each entry has `token`, `actor_ref`, `role` (`bound` or `recovery`) and optionally
an `operations` allowlist. The request bearer, envelope actor and role must
match the principal. The default empty array denies all invocations. The old
single `MURM_SERVICE_TOKEN` does not configure built-in host authentication.
Keep actual credential values in private deployment configuration.

For an operator-configured principal array already exported in the environment:

```sh
MURM_SERVICE_ID=task \
MURM_SERVICE_HOST=127.0.0.1 \
MURM_SERVICE_DATABASE=/var/lib/murm/task.sqlite \
MURM_SERVICE_PUBLIC_URL=http://127.0.0.1:8787 \
npm run service:builtin
```

Client endpoint configuration uses `MURM_{TASK,CONTEXT,JUDGE,CATALOG}_SERVICE_URL`
and its matching `_SERVICE_TOKEN`; those client credentials must match a
principal on the target host. The Registry can also receive explicit
`serviceEndpoints`. A registered Agent remains scoped to its durable Mission and
Execution; a bearer token cannot assign another Task owner.

## Composition and readiness limits

With `MURM_SERVICE_ISOLATED=false` (default), the script constructs Task,
Context and Judge on its selected database even when it exposes only one
provider. Distinct host database paths do not share domain state automatically.
Context gets a local Task authority and can report ready. Judge is not wired
to Task authority by this standalone script, so its readiness and data routes
remain unavailable even with a valid fixture manifest.

With `MURM_SERVICE_ISOLATED=true`, each stateful host opens only its own
database and Catalog opens none. Standalone Task and Context have no cross-domain writer. Context needs
Task's Mission authority and lifecycle transaction, so isolated Context reports
not ready and rejects data operations with `SERVICE_NOT_READY`. Judge likewise
requires a local Task lifecycle authority and trusted Workspace input. These
checks deliberately prevent an HTTP caller from bypassing finish/stop fencing.
Health, manifest availability and a running container do not establish usable
Context/Judge operations or a complete research deployment.

The checked-in [Compose file](compose.yaml) selects isolated mode, separate
Task/Context/Judge volumes and a stateless Catalog. Its host ports default to
8781–8784; override with `MURM_{TASK,CONTEXT,JUDGE,CATALOG}_PORT`.
Per-service principal arrays use `MURM_<SERVICE>_SERVICE_PRINCIPALS`.
`docker compose -f deploy/builtin-services/compose.yaml up --build -d` starts those
hosts with the limitations above. The generic Compose recipe does not use the
repository-owned independent peer protocol described above. The dedicated
benchmark launcher has been retired; a consuming host owns peer composition.

## Checker assets and shutdown

`MURM_JUDGE_FIXTURE_MANIFEST` accepts inline JSON or a mounted manifest
path. `MURM_LEAN_COMMAND` defaults to `lake`, and
`MURM_JUDGE_WORK_ROOT` selects private checker output. The host image does
not install Lean or its locked dependencies. The container entrypoint supports
`MURM_JUDGE_PREBUILD=true`, a mounted `MURM_JUDGE_PROJECT_ROOT` and a
`MURM_JUDGE_PREBUILD_KEY`: a successful build records the key in the volume,
and the same key skips rebuilding. These assets do not repair the missing
lifecycle authority. Readiness does not execute Lean preflight.

SIGINT/SIGTERM stops HTTP admission and closes domain services and the database.
When a host composes the independent peers, admission, checker cleanup and
deferred database close are owned by that coordinator. See [Services](../../docs/architecture/04-services.md)
and [Run configuration](../../docs/architecture/07-run-configuration.md) for the
complete current path, including its failure and cleanup boundaries.

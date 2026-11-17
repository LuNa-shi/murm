# Built-in Service host

`scripts/service-host.mjs` exposes Task, Context, Judge or Catalog through the
Service Manifest and JSON HTTP host. At the reviewed `755c72e` baseline this is
a standalone compatibility/operator surface. The positive-duration benchmark
uses Task, Context and Judge in one coordinator process with three databases;
it rejects external service overrides. Configuring HTTP endpoints alone does
not supply the lifecycle authorization needed by Context and Judge.

## Host configuration and authentication

Choose `SWARMENV_SERVICE_ID` from `task`, `context`, `judge`, `catalog`. The host
binds `0.0.0.0:8787` by default; set `SWARMENV_SERVICE_HOST` and
`SWARMENV_SERVICE_PORT` to override it. `SWARMENV_SERVICE_PUBLIC_URL` is the
address advertised to clients. `SWARMENV_SERVICE_DATABASE` defaults to
`./data/<service>.sqlite`.

Every host exposes public `/healthz`, `/readyz` and `/v1/manifest` routes, plus
named POST `/v1/<operation>` routes. Invocation requires
`SWARMENV_SERVICE_PRINCIPALS`, a JSON array of operator-provisioned credentials:
each entry has `token`, `actor_ref`, `role` (`bound` or `recovery`) and optionally
an `operations` allowlist. The request bearer, envelope actor and role must
match the principal. The default empty array denies all invocations. The old
single `SWARMENV_SERVICE_TOKEN` does not configure built-in host authentication.
Keep actual credential values in private deployment configuration.

For an operator-configured principal array already exported in the environment:

```sh
SWARMENV_SERVICE_ID=task \
SWARMENV_SERVICE_HOST=127.0.0.1 \
SWARMENV_SERVICE_DATABASE=/var/lib/swarmenv/task.sqlite \
SWARMENV_SERVICE_PUBLIC_URL=http://127.0.0.1:8787 \
npm run service:builtin
```

Client endpoint configuration uses `SWARMENV_{TASK,CONTEXT,JUDGE,CATALOG}_SERVICE_URL`
and its matching `_SERVICE_TOKEN`; those client credentials must match a
principal on the target host. The Registry can also receive explicit
`serviceEndpoints`. A registered Bot remains scoped to its durable Mission and
Execution; a bearer token cannot assign another Task owner.

## Composition and readiness limits

With `SWARMENV_SERVICE_ISOLATED=false` (default), the script constructs Task,
Context and Judge on its selected database even when it exposes only one
provider. Distinct host database paths do not share domain state automatically.
Context gets a local Task authority and can report ready. Judge is not wired
to Task authority by this standalone script, so its readiness and data routes
remain unavailable even with a valid fixture manifest.

With `SWARMENV_SERVICE_ISOLATED=true`, each stateful host opens only its own
database and Catalog opens none. Task can use the configured Context HTTP
proxy. The historical HTTP domain proxy does not implement Context's required
`materialScope` and lifecycle writer seam; isolated Context therefore reports
not ready and rejects data operations with `SERVICE_NOT_READY`. Judge likewise
requires a local Task lifecycle authority and trusted Workspace input. These
checks deliberately prevent an HTTP caller from bypassing finish/stop fencing.
Health, manifest availability and a running container do not establish usable
Context/Judge operations or a complete research deployment.

The checked-in [Compose file](compose.yaml) selects isolated mode, separate
Task/Context/Judge volumes and a stateless Catalog. Its host ports default to
8781–8784; override with `SWARMENV_{TASK,CONTEXT,JUDGE,CATALOG}_PORT`.
Per-service principal arrays use `SWARMENV_<SERVICE>_SERVICE_PRINCIPALS`.
`docker compose -f services/builtin/compose.yaml up --build -d` starts those
hosts with the limitations above; it is not the normal benchmark launch path.
The independent-service implementation tracked in
[Issue #130](https://github.com/LuNa-shi/SwarmEnv/issues/130) is outside this
reviewed main revision.

## Checker assets and shutdown

`SWARMENV_JUDGE_FIXTURE_MANIFEST` accepts inline JSON or a mounted manifest
path. `SWARMENV_LEAN_COMMAND` defaults to `lake`, and
`SWARMENV_JUDGE_WORK_ROOT` selects private checker output. The host image does
not install Lean or its locked dependencies. The container entrypoint supports
`SWARMENV_JUDGE_PREBUILD=true`, a mounted `SWARMENV_JUDGE_PROJECT_ROOT` and a
`SWARMENV_JUDGE_PREBUILD_KEY`: a successful build records the key in the volume,
and the same key skips rebuilding. These assets do not repair the missing
lifecycle authority. Readiness does not execute Lean preflight.

SIGINT/SIGTERM stops HTTP admission and closes domain services and the database.
For the supported benchmark composition, admission, checker cleanup and deferred
database close are owned by the coordinator. See [Services](../../docs/architecture/04-services.md)
and [Run configuration](../../docs/architecture/07-run-configuration.md) for the
complete current path, including its failure and cleanup boundaries.

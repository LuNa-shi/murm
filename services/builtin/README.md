# Built-in Service host

Task, Context, Judge, and Catalog use the same Service Manifest and JSON HTTP
host as user-defined providers. Run one process per service and register the
advertised URL with `createBuiltinServiceRegistry({ serviceEndpoints })`:

```sh
SWARMENV_SERVICE_ID=task \
SWARMENV_SERVICE_DATABASE=/var/lib/swarmenv/task.sqlite \
SWARMENV_SERVICE_PUBLIC_URL=http://task:8787 \
npm run service:builtin
```

The container image can host any one of the four services by changing
`SWARMENV_SERVICE_ID` to `task`, `context`, `judge`, or `catalog`. Mount a
durable volume for the SQLite database and set the public URL to the address
reachable by the Runtime. Every host exposes `/healthz`, `/readyz`,
`/v1/manifest`, and the named `/v1/<operation>` routes; authorization is
enabled when `SWARMENV_SERVICE_TOKEN` is set.

Set `SWARMENV_SERVICE_ISOLATED=true` for the Issue 119 deployment shape. In
that mode the process opens only its own service database and uses configured
HTTP endpoints for the small cross-domain reads/writes needed by the existing
synchronous domain handlers. `SWARMENV_CONTEXT_SERVICE_URL` supplies the
Context endpoint to Task, and `SWARMENV_TASK_SERVICE_URL` supplies the Task
endpoint to Context/Judge. If a required dependency endpoint is absent, the
affected operation returns a typed service-unavailable error instead of
silently opening a second local database.

For a four-process local deployment, use
[`compose.yaml`](compose.yaml):

```sh
docker compose -f services/builtin/compose.yaml up --build -d
```

Task, Context and Judge receive separate named volumes; Catalog is stateless
and discovers the other three through their service names. The published host
ports default to 8781–8784 and can be overridden with
`SWARMENV_{TASK,CONTEXT,JUDGE,CATALOG}_PORT`. Set `SWARMENV_SERVICE_TOKEN` to
require one bearer token on every service. Judge starts with a healthy HTTP
surface but reports checker input unavailable until
`SWARMENV_JUDGE_FIXTURE_MANIFEST` points to a pinned manifest mounted inside
the container together with its locked checker project and toolchain.

The Judge checker can be prebuilt once into its persistent service volume:

```sh
SWARMENV_JUDGE_PREBUILD=true \
SWARMENV_JUDGE_PROJECT_ROOT=/checker \
SWARMENV_JUDGE_PREBUILD_KEY=putnam-a1-v4.33.1 \
SWARMENV_JUDGE_FIXTURE_MANIFEST=/etc/swarmenv/fixture.json \
docker compose -f services/builtin/compose.yaml up --build -d judge
```

The deployment must mount the locked project at `/checker` and the matching
Lean toolchain at the configured path before enabling this option. The entry
point writes a key into the Judge volume after a successful build; later
restarts with the same key skip the build. Changing the fixture or toolchain
requires a new key.

The HTTP boundary is independent even when local deployments mount one SQLite
volume. A production deployment can replace the domain handler's persistence
with its own store without changing the Agent-facing manifest or SDK flow.

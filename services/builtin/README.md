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

The HTTP boundary is independent even when local deployments mount one SQLite
volume. A production deployment can replace the domain handler's persistence
with its own store without changing the Agent-facing manifest or SDK flow.

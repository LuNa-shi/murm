# SwarmEnv

SwarmEnv is a local-first runtime for durable, checkable agent swarm tasks.

## Experiment and observation runtime

All live experiment evidence must be created below the repository's
`experiments/` directory. Use one child directory per experiment, for example:

```text
experiments/
  putnambench-runs/run-<id>/
    metadata/
    logs/
    state/
    workspaces/
  .observability/
    observability.sqlite
    public-server.json
```

`experiments/.observability/` is reserved for the shared observation database
and the persistent observation server metadata. Reports remain in the separate
`reports/` directory. The benchmark runner reuses the healthy server described
by `public-server.json` (with `server.json` retained as a legacy fallback)
before creating the root Task and closes only its own database
handle when the experiment ends. The observation server stays online for later
runs; it is one fixed service and one fixed port for the whole experiment root.

Start the server manually when no benchmark runner is active:

```sh
node scripts/serve-observability.mjs \
  --root experiments \
  --scan-root /home/ubuntu/SwarmEnv-worktrees \
  --metadata experiments/.observability/public-server.json \
  --host 0.0.0.0 \
  --advertise-host "$(tailscale ip -4)" \
  --port 8787
```

The normal benchmark command reuses the same persistent server automatically.
If a runner is launched from another checkout, point it at the shared service
metadata instead of allowing a second daemon to be started:

```sh
export SWARMENV_OBSERVABILITY_METADATA=/absolute/path/to/experiments/.observability/public-server.json
```

Use the same metadata path for the fixed public service (for example,
`public-server.json`). A second server pointed at that metadata exits after
reporting the healthy existing service instead of claiming another port.

The dashboard opens one server-sent event stream for the Experiment registry.
When a runner registers a new Experiment, the open page receives the new
summary and keeps the current selection without a page reload or a browser
polling loop. If an edge proxy buffers SSE, the browser switches to a long
change request that waits for a registry revision or a 25-second timeout; it
does not run a four-second polling timer. The server is read-only from the
HTTP API; explicit process management or `SIGTERM` is required to stop it.

Repeat `--root` for additional explicit experiment roots, or use
`--scan-root` for a directory whose immediate worktree children each contain
an `experiments/` directory. When `--root` points at `<repository>/experiments`,
the server also discovers the conventional `<repository>/.worktrees` and
`<repository>/.worktree` roots automatically; an explicit `--scan-root` remains
useful for worktrees stored elsewhere. The server discovers each root's shared
`.observability/observability.sqlite` and bounded nested per-experiment databases,
then presents them through the same registry and detail routes.

On the current server the daemon is installed as the user service
`swarmenv-observability.service` with automatic restart and login persistence:

```sh
systemctl --user status swarmenv-observability.service
```

When the server and browser are on different machines in the same Tailscale
network, open:

```text
http://<server-tailscale-ip>:8787/
```

For the current server host, `tailscale ip -4` reports `100.78.32.56`, so the
current operator URL is `http://100.78.32.56:8787/` while the Tailscale node is
online. Do not put credentials or provider tokens in experiment metadata,
observation payloads, or reports.

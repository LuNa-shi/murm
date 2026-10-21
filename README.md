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
    server.json
```

`experiments/.observability/` is reserved for the shared observation database
and the persistent observation server metadata. Reports remain in the separate
`reports/` directory. The benchmark runner starts or reuses the observation
server before creating the root Task and closes only its own database handle
when the experiment ends. The observation server stays online for later runs.

Start the server manually when no benchmark runner is active:

```sh
node scripts/serve-observability.mjs \
  --root experiments \
  --host 0.0.0.0 \
  --advertise-host "$(tailscale ip -4)" \
  --port 8787
```

The normal benchmark command starts the same persistent server automatically.
The browser polls the experiment registry and shows a newly started run in an
already open tab. The server is read-only from the HTTP API; explicit process
management or `SIGTERM` is required to stop it.

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

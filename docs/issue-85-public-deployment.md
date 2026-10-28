# Issue 85 public deployment

The persistent observability service was deployed from implementation commit
`5d0bdef12fd2db2c0f3b305365dc6fadae81b3e9` on 2026-10-28.

The user service `swarmenv-observability.service` now runs the detached live
checkout at `/home/ubuntu/SwarmEnv-live` on the single public origin port
8787. It owns the primary `/home/ubuntu/SwarmEnv/experiments` root and scans
`/home/ubuntu/SwarmEnv-worktrees` for worktree `experiments/` roots. The
service writes its canonical metadata to
`/home/ubuntu/SwarmEnv/experiments/.observability/public-server.json`.

The old `swarmenv-observability-dashboard.service` on port 8788 is disabled,
and all detached `serve-observability.mjs` processes except the fixed 8787
service were stopped. The public edge unit now depends on the fixed service
and the Cloudflare quick proxy origin is `http://127.0.0.1:8787`.

The operator URL is:

```text
https://swarmenv-observability.nustar.work/
```

Sanitized verification after deployment:

- `https://swarmenv-observability.nustar.work/health` returned HTTP 200 with `{"ok":true,"service":"swarmenv-observability"}`.
- The public `app.js` contains `/api/experiments/stream` and `/api/experiments/changes?since=` and contains zero `setInterval(` calls.
- `https://swarmenv-observability.nustar.work/api/experiments/changes?since=probe` returned HTTP 200 with a registry revision and the current experiment summaries.
- The local origin `http://127.0.0.1:8787/api/experiments/stream` returned the initial `experiments` SSE event. The quick tunnel buffers an open SSE body, so the browser falls back to the long change request for that edge while retaining SSE for direct origins.

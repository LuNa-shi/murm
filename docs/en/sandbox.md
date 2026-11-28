---
title: Sandboxes
description: How murm isolates every Agent through OpenSandbox or a custom Sandbox Provider, and how to configure createSandbox() connection defaults and resource limits.
section: CORE BUILDING BLOCKS
order: 3
---

Each Agent runs in an OpenSandbox environment with a private `/workspace/project`. The root Worker supervises Pi, Codex or an image-installed executor, verifies file transfers and exports its Session and artifacts after confirmed stop.

## Local setup

```sh
murm setup --mode local
murm doctor --smoke
```

Setup prepares pinned OpenSandbox 1.2.1 components and a compatible Worker image, then saves the connection. It prefers published Worker images. Development builds can set `MURM_BUILD_WORKER=1`. The Worker handshake is `murm-core-v2`, so an older image receives a version mismatch error.

## Connect to an existing service

```sh
export OPEN_SANDBOX_API_KEY='<operator-provided-key>'
murm setup --mode existing --endpoint https://sandbox.example.net \
  --public-url https://runtime.example.net/murm
murm doctor --smoke
```

Existing mode verifies management authentication and saves the connection without creating a Sandbox. The explicit smoke allocates and cleans one resource to check Controller-to-Worker access, the callback, file export and deletion. The remote operator supplies the Worker image. This Controller needs Node and network access. Use TLS or a trusted private network for credentials.

## Configure the SDK

```ts
import { createSandbox } from '@luna-shi/murm';

const sandbox = createSandbox(); // setup connection defaults
const remote = createSandbox({
  endpoint: 'https://sandbox.example.net',
  apiKey: process.env.OPEN_SANDBOX_API_KEY,
  resourceLimits: { cpu: '2', memory: '2Gi' },
  timeoutSeconds: 3600,
});
```

Explicit SDK or CLI settings override environment values, saved connection, then local defaults. Connection settings live in the owner-only user configuration. The factory snapshots configuration. Allocation begins at `runtime.spawn()`.

Pass `connection: { publicUrl: 'https://runtime.example.net/murm' }` to Runtime for a single reachable callback. `bindHost` and `bindPort` are advanced listener settings. Reverse-proxy prefixes are preserved. The doctor report lists the configured callback origin. If the Sandbox cannot reach the Runtime, the smoke check points to the callback address, listener port and proxy routes. Configure OpenSandbox to publish reachable endpoint addresses and headers.

## Resource and migration boundaries

| Setting or capability | Current behavior |
| --- | --- |
| CPU and memory | Official SDK resource fields, checked against actual guest cgroups. |
| `timeoutSeconds` | Creation lifetime, default 3,600 seconds. Live Runtime renews owned running, idle and retained resources. |
| Required export failure | Keeps Sandbox and Slot with actual `expiresAt`. Close attempts a five-minute retention window and reports `retain-at-risk` when unconfirmed. Retry stop to resume export and cleanup. |
| `lifecycleBaseUrl` | Migration alias for `endpoint`; conflicting values fail. Alias removal is planned for the next breaking release. |
| `isolation.network: 'api'` | Transitional redundant selection, planned for removal in the next breaking release. |
| `local-docker`, exact Workspace bytes/inodes | Rejected before allocation with migration guidance. Choose a trusted Provider with the required verified storage contract. |
| File `maxBytes` / `maxEntries` | Transfer and memory budgets, independently configured through `filePolicy`. |
| Live shared workspace | Built-in Provider rejects before creation. Use explicit file or Service handoff, or a custom Provider with verified shared access. |
| `endpointHost` | Rejected. Correct endpoint publication in OpenSandbox. |
| `useServerProxy` | Explicit compatibility for existing deployments, following upstream maintenance status. New deployments should publish reachable endpoints. |
| Separate callback URLs and `{port}` templates | Migrate to one `connection.publicUrl` and optional fixed `bindPort`. Equal legacy URLs are accepted until the next breaking release. |

The optional `egressMode: 'dns+nft'` declares an administrator-prepared packet-policy deployment. Profile IPv4 HTTP(S) origins compile to exact IP/TCP-port rules and the Runtime callback is included. The Runtime rejects a missing deployment capability before allocation. Before Agent startup it checks that the sidecar reports dns+nft and the requested allowlist. Verify actual packet denial with the deployment. Administrator deny policy can still block a destination.

## Worker images

`workerImageFor(executor)` selects the matching executor variant. `DEFAULT_WORKER_IMAGE` selects the combined image. Extend the image and set `Profile.image` when an Agent needs additional toolchains. Keep the package, Worker protocol and executor versions aligned.

Custom integrations use `createSandbox({ provider, timeoutSeconds })` and retain the public `SandboxProvider` contract. Administrator recipes and version pins are in the deployment guide.

[Runtime](runtime.md) · [Host Gateway](gateway.md) · [Deployment](../../deploy/README.md)

## Kubernetes deployment

Use one OpenSandbox cluster endpoint and a stable Runtime callback. Kubernetes schedules Sandbox Pods across prepared worker nodes. Persistent ownership supports same-host, same-boot recovery under an exclusive writer; automatic cross-node Controller takeover is unavailable. Cluster acceptance ran real Sandbox workloads at sizes 2 and 8 on two worker VMs. Tiers 32, 128 and 1,024 passed local mock Agent API checks for the Sandbox lifecycle. See [Runtime](runtime.md) · [Deployment](../../deploy/opensandbox-kubernetes/README.md)

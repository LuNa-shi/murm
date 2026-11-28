# Common runtime deployment

This directory contains the shared OpenSandbox configuration and Worker image
recipe. Coordination Services belong to the examples that use them. Installing
the SDK does not require a global Task/Context/Judge/Catalog deployment.

## What setup prepares

| Component | Ownership | Normal user action |
| --- | --- | --- |
| OpenSandbox Lifecycle service | Your deployment, or the local service created by `murm setup --mode local`. | Connect to an existing authenticated service, or let local setup prepare it. |
| murm Worker image | Versioned image built by the release workflow. | Local setup reuses a compatible cached Worker or pulls the published executor variant. `MURM_BUILD_WORKER=1` enables a development recipe build. An existing service operator prepares the selected reference. |
| Runtime Bridge, model gateway and built-in `agent` Service | Created by each Runtime. | Configure the Runtime; these have no separate service container to deploy. |
| TaskPool, Subagents, Lead-Worker and Substrate Services | Their respective example. | The example creates its owned in-process Services/stores. Follow that example's README for extra facilities. |
| PeerMesh facilities and optional integrations | The application/operator. | Supply the endpoints and credentials listed by the selected example. Setup does not provision them. |

`murm doctor` checks the selected setup/configuration. `murm setup --mode local` additionally
prepares infrastructure and runs its bounded smoke check. Existing mode verifies authentication and saves connection settings. `murm doctor --smoke` verifies bidirectional connectivity with a temporary Sandbox. Neither command
establishes that a real model completed an application task. See
[Quickstart](../docs/en/quickstart.md) for the commands and editable configuration.

## Image and configuration paths

- [`opensandbox/config.toml`](opensandbox/config.toml) is the common local provider configuration.
- [`worker/Dockerfile`](worker/Dockerfile) builds the Worker, executor CLIs and
  agent-side `swarm` command. [`worker/pi-models.json`](worker/pi-models.json) is
  the bundled Pi model catalog.
- [The release workflow](../.github/workflows/release.yml) builds versioned images
  at `ghcr.io/luna-shi/murm-worker`, including executor-specific variants.
  Select `MURM_EXECUTOR`, and override `MURM_WORKER_IMAGE` only when choosing a
  compatible custom image. Custom executor adapters supply their own image.
- An explicitly configured custom image is pulled when absent; setup does not
  silently rebuild a different image under that reference.

For development or an explicit custom build, run from the checkout/package root:

```sh
docker build -f deploy/worker/Dockerfile -t murm-worker:local .
```

The release workflow publishes Worker variants. The optional TaskPool and Mathlib
Search images use the source build recipes below.

## Optional example deployments

The [Task/Context/Judge/Catalog standalone recipe](../examples/taskpool/deploy/service-hosts/README.md) is a compatibility host for the
TaskPool domain. Its isolated Context/Judge processes do not implement the
complete coordinator protocol; see its README before using it. [Mathlib search](../examples/services/mathlib-search/README.md)
is a separately configured optional Service for Lean workloads. Neither is part
of default SDK setup. PeerMesh's MySQL database is a different dependency used
by the upstream Board.

## Administrator connection and policy

The local recipe pins stable OpenSandbox 1.2.1 Server, Execd and Egress digests. Its reviewed source revision is `db708c218771a8d311356f0e96552c15df6e097a`. The official SDK dependency is exactly `@alibaba-group/opensandbox@1.2.1` in the shrinkwrap. Local setup configures `dns+nft`, an authenticated loopback Lifecycle server, published data-plane endpoints and a compatible `murm-core-v2` Worker. Inspect `murm doctor --smoke` for the actual selected executor and verified export/delete result.

```sh
export OPEN_SANDBOX_API_KEY='<operator-provided-key>'
murm setup --mode existing --endpoint https://sandbox.example.net \
  --public-url https://runtime.example.net/murm
murm doctor --smoke
```

The operator must publish SDK endpoints reachable by the Controller and permit Sandbox callbacks to the single Runtime listener. Retain endpoint headers through proxies. Configure TLS or a trusted private network. The explicit deprecated server-proxy option exists for compatible deployments, with upstream maintenance limitations. Endpoint host rewriting receives a migration error.

Profile IP/port restrictions require actual packet-policy enforcement. `dns+nft` adds exact TCP ports for IPv4 targets and the Runtime callback. Platform deny policy remains authoritative. Verify allowed IP/port, the same IP at another port, unauthorized destinations and management access independently. DNS-only egress cannot establish that guarantee. Setup's deployment mode and authentication smoke supply narrower observations than a full policy matrix.

Built-in Runtime rejects legacy exact Workspace byte/inode requests and live shared mounts before creating resources. File transfer budgets remain configured through `filePolicy`. A trusted custom Provider can offer additional measured storage capabilities. Volume capacity, writable-layer quota and file-transfer limits have distinct scopes.

To uninstall a setup-managed service, first close all Runtimes using it and independently confirm their Sandbox deletions or retained ownership. Use Docker to inspect and remove the exact `murm-opensandbox-<port>` service created by setup. Its owner-labelled state directory and saved user connection should be removed only when no retained resources depend on them. Never delete shared or externally operated volumes as part of individual Agent cleanup. A saved connection can be replaced through `murm setup --mode existing`.

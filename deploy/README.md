# Common runtime deployment

This directory contains the shared OpenSandbox configuration and Worker image
recipe. Coordination Services belong to the examples that use them. Installing
the SDK does not require a global Task/Context/Judge/Catalog deployment.

## What setup prepares

| Component | Ownership | Normal user action |
| --- | --- | --- |
| OpenSandbox Lifecycle service | Your deployment, or the local service created by `murm setup --mode local`. | Connect to an existing authenticated service, or let local setup prepare it. |
| murm Worker image | Versioned image built by the release workflow. | Setup checks the local cache, pulls a compatible official image, and falls back to a source build when preparing the default image. |
| Runtime Bridge, model gateway and built-in `agent` Service | Created by each Runtime. | Configure the Runtime; these have no separate service container to deploy. |
| TaskPool, Subagents, Lead-Worker and Substrate Services | Their respective example. | The example creates its owned in-process Services/stores. Follow that example's README for extra facilities. |
| PeerMesh facilities and optional integrations | The application/operator. | Supply the endpoints and credentials listed by the selected example. Setup does not provision them. |

`murm doctor` checks the selected setup/configuration. `murm setup` additionally
prepares infrastructure and runs its bounded smoke check. Neither command
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

A Worker Dockerfile is a maintainer/customization recipe. Normal installation
uses the published image when it is available. This repository's release
workflow does not publish a generic built-in-services or Mathlib-search image.

## Optional example deployments

The [Task/Context/Judge/Catalog standalone recipe](../examples/taskpool/deploy/service-hosts/README.md) is a compatibility host for the
TaskPool domain. Its isolated Context/Judge processes do not implement the
complete coordinator protocol; see its README before using it. [Mathlib search](../examples/services/mathlib-search/README.md)
is a separately configured optional Service for Lean workloads. Neither is part
of default SDK setup. PeerMesh's MySQL database is a different dependency used
by the upstream Board.

Strict local Docker isolation remains an explicit configuration that needs
additional host capabilities. PeerMesh and Lead-Worker currently select it to
enforce their Git network allowlist. A successful default setup does not by
itself satisfy those example-specific requirements.

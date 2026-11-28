---
title: Quickstart
description: Prepare Linux prerequisites, install murm, initialize OpenSandbox and the Worker image, and run your first multi-agent example.
section: GET STARTED
order: 1
---

`murm` ships its CLI and TypeScript SDK in one package and runs Agents inside [OpenSandbox](sandbox.md) containers. You can run OpenSandbox locally with Docker Engine or connect to an existing OpenSandbox service.

## Prerequisites

| Dependency | Requirement | Verify |
| --- | --- | --- |
| **Linux** | Controller host (e.g., Ubuntu / Debian) | `uname -s` |
| **Node.js & npm** | `>= 22.19` (install LTS from [nodejs.org](https://nodejs.org/en/download); Ubuntu 24.04 and Debian 13 repos ship older versions) | `node --version` |
| **Git & curl** | Required by the installer and workspace tools | `git --version` |
| **Docker Engine** | Required for local OpenSandbox only; skip when using an existing service ([install guide](https://docs.docker.com/engine/install/)) | `docker info` |

On Ubuntu or Debian, install the system packages in one step (drop `docker.io` and `systemctl` if Docker is already installed or you are connecting to a remote service):

```bash
sudo apt-get update && sudo apt-get install -y docker.io git curl ca-certificates
sudo systemctl enable --now docker.service
```

> **Docker permissions:** run `docker info` as the user who will run `murm`. If access to the Docker socket is denied, have your host administrator grant access and sign in again after the group change ([the `docker` group grants root-equivalent access](https://docs.docker.com/engine/install/linux-postinstall/)).

## 1. Install murm

### Option A: Install the latest release

```bash
curl -fsSL https://luna-shi.github.io/murm/install.sh | sh
```

The installer writes to your npm global prefix when writable, or falls back to `$HOME/.local`. If it prints an `export PATH=...` command, run it in your current shell before invoking `murm`.

> **Release note:** the public installer downloads the latest GitHub Release. **v0.2.0** still requires the legacy host setup (local rootful Docker, Landlock ABI 5+, and non-interactive sudo rules — Ubuntu 24.04's default 6.8 kernel does not meet this requirement; follow the [v0.2.0 host setup guide](https://github.com/LuNa-shi/murm/blob/v0.2.0/docs/en/quickstart.md#1-prerequisites-execution-host) before Step 2). To use the default OpenSandbox API mode with only the prerequisites above, install from source below.

<details>
<summary>Install the release directly with npm (without install.sh)</summary>

```bash
npm install -g --prefix "$HOME/.local" --ignore-scripts --allow-remote=root \
  https://github.com/LuNa-shi/murm/releases/latest/download/luna-shi-murm.tgz
export PATH="$HOME/.local/bin:$PATH"
```

</details>

### Option B: Build and install from source (`main`)

Run these commands from the repository root. `npm ci` installs dependencies, `npm pack` compiles and packages the tarball, and `npm install -g` installs the `murm` binary into `$HOME/.local/bin`:

```bash
git clone https://github.com/LuNa-shi/murm.git && cd murm
npm ci --no-audit --no-fund
pack_dir=$(mktemp -d)
npm pack --pack-destination "$pack_dir"
npm install -g --prefix "$HOME/.local" --ignore-scripts "$pack_dir"/*.tgz
export PATH="$HOME/.local/bin:$PATH"
```

Keep the candidate tarball if you want to install the same SDK in an [independent example project](../../examples/README.md).

## 2. Prepare OpenSandbox and the Worker

```bash
murm setup
```

With a saved or configured endpoint, setup verifies and reuses that connection. Otherwise it prepares a local service on `127.0.0.1:8080`. Local setup pulls pinned Server, Execd and Egress 1.2.1 images, prepares a compatible Worker, and runs a bounded smoke check of Service calls, model traffic, files, export and deletion using a controlled model response. Wait for `"ok": true` and `"infrastructure": "ready"` for that local probe.

Published Worker images are preferred. When developing a candidate whose Worker protocol has changed, run `MURM_BUILD_WORKER=1 murm setup --mode local` to build from the installed package's recipe. This tree uses `murm-core-v2`; an older image receives a mismatch diagnostic. Local builds require access to the Node base image, Debian repositories and npm. An explicitly configured `MURM_WORKER_IMAGE` must already be compatible.

### Connect to an existing OpenSandbox

```bash
export OPEN_SANDBOX_API_KEY='<operator-provided-key>'
murm setup --mode existing --endpoint https://sandbox.example.net \
  --public-url https://runtime.example.net/murm
murm doctor --smoke
```

Existing setup verifies authentication and saves the endpoint, key and callback in owner-only user configuration. The remote Controller needs Node and network access. Its operator prepares a matching Worker image on the service. `doctor` performs a read-only configuration and Lifecycle check. `doctor --smoke` allocates a temporary Sandbox and verifies Controller-to-Worker and Sandbox-to-Runtime traffic before confirming export and deletion. An unavailable saved remote connection produces an error for that connection.

`connection.publicUrl` is one callback address for Bridge and model requests. A reverse proxy should forward that path prefix to the Runtime's `bindHost` and fixed `bindPort`. Local setup discovers its reachable host and available port. Details and legacy configuration migration are in [Sandboxes](sandbox.md) and [Host Gateway](gateway.md).

### Diagnose image availability

Setup reports the failed image reference and a retry command. Verify registry access from the selected Docker engine or ask an administrator to preload the pinned images. For offline use, transfer an image with `docker save` and `docker load`, then set `MURM_WORKER_IMAGE` to its compatible reference. A development build can use the packaged Dockerfile.

```bash
docker build -f deploy/worker/Dockerfile -t murm-worker:local .
export MURM_WORKER_IMAGE=murm-worker:local
murm setup --mode local
```

## 3. Run your first example

Export any streaming OpenAI Responses-compatible endpoint and API key (OpenAI shown below), then run the built-in `subagents` Harness in a fresh directory:

```bash
export MURM_MODEL_URL='https://api.openai.com/v1/responses'
export MURM_MODEL_ID='gpt-5-mini'
export MURM_MODEL_TOKEN='<your-api-key>'

mkdir -p murm-first-example && cd murm-first-example
printf '# Hello from murm\n' > README.md
murm --harness subagents --prompt 'Read README.md and report its heading.' --output-dir ./runs
```

See the [CLI Reference](reference/cli.md) for other model providers and executor options (such as Codex).

## 4. Inspect the run in Trace Viewer

```bash
murm trace --root ./runs --port 8787 --open
```

Over SSH, `murm trace` automatically prints a copy-pasteable `ssh -N -L` port-forwarding command (if you connect via an SSH alias, custom port, or jump host, reuse the same connection flags).

## Next steps

- [Core Concepts](concepts.md) — understand the six building blocks in two minutes.
- [Choose a Harness](harnesses/index.md) — compare all five built-in multi-agent patterns.
- [Build a Swarm Harness](build-your-harness.md) — write your own coordination loop with the [TypeScript SDK](reference/api.md).

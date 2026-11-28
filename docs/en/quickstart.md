---
title: Quickstart
description: Prepare Linux prerequisites, install murm, initialize OpenSandbox and the Worker image, and run your first multi-agent example.
section: GET STARTED
order: 1
---

To write an application with an installed SDK archive, follow [Build your first SDK Harness](first-harness.md).

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

## 2. Set up OpenSandbox & build the Worker

```bash
murm setup
```

`murm setup` walks through three stages automatically (allow a few minutes on a fresh machine while images are pulled and built):

1. **Starts local OpenSandbox:** pulls the pinned OpenSandbox server and Execd images and launches a managed instance on `127.0.0.1:8080`.
2. **Prepares the Worker image:** reuses a compatible local Docker cache when present, or builds the selected executor from the bundled `deploy/worker/Dockerfile` (default: Pi; requires the Node base image, Debian packages, and npm).
3. **Runs an end-to-end smoke probe:** starts a temporary sandbox and verifies the Service Bridge, Model Gateway, file export, and deletion using a local test response (no model API key needed).

Wait for `"infrastructure": "ready"` and `"ok": true` in the output. If a check fails, resolve the reported issue and rerun `murm setup`. Later, run `murm doctor` for a fast Lifecycle check or `murm doctor --smoke` to rerun the full probe.

<details>
<summary>Connect to an existing OpenSandbox service</summary>

Export the service endpoint, controller callback host, and the operator's `MURM_LIFECYCLE_TOKEN` (the controller must reach Lifecycle and Worker endpoints, and Workers must reach the controller's Bridge and Model Gateway):

```bash
export MURM_LIFECYCLE_URL='https://sandbox.example.net/v1'
export MURM_LIFECYCLE_TOKEN='<your-lifecycle-token>'
export MURM_ADVERTISE_HOST='controller.internal.example.net'
murm setup --mode existing
```

Ask the service operator to pre-load a compatible Worker image if the remote engine cannot pull it. See [Sandboxes](sandbox.md) and [Host Gateway](gateway.md) for proxy routing and HTTPS callbacks.

</details>

<details>
<summary>Troubleshoot image pull or Worker build failures</summary>

- **OpenSandbox server or Execd pull failure:** setup prints the exact failing image digest and a `docker pull` command to retry in the same Docker context. On restricted networks, configure a [Docker daemon proxy](https://docs.docker.com/engine/daemon/proxy/), have an administrator pre-load the pinned references, or connect to an existing OpenSandbox service.
- **Local Worker build failure:** verify Docker access to the Node base image, Debian packages, and npm, or run the manual `docker build` command shown in the error report. Explicitly configured registry images can still be pulled when absent from the cache.
- **Build the default Pi Worker from a trusted mirror** (replace `registry.example.net` with your mirror):

```bash
(
  cd "$(dirname "$(readlink -f "$(command -v murm)")")/../.." &&
    docker build -f deploy/worker/Dockerfile -t murm-worker:local \
      --build-arg WORKER_EXECUTOR=pi \
      --build-arg NODE_IMAGE=registry.example.net/library/node:22.19.0-bookworm-slim .
) &&
  export MURM_WORKER_IMAGE=murm-worker:local &&
  murm setup
```

- **Transfer a Worker offline:** on a machine with registry access and the same CPU architecture, run `docker save -o worker.tar IMAGE`, copy the archive, and run `docker load -i worker.tar` in the target Docker context. If the loaded tag differs from the default, keep `export MURM_WORKER_IMAGE=IMAGE` set for both `murm setup` and your runs.

</details>

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

---
title: Quickstart
description: Install murm on Linux, verify OpenSandbox, and run your first Subagents example.
section: GET STARTED
order: 1
---

The murm CLI and SDK ship in one package. OpenSandbox runs the Agents. You can use a local Docker Engine or connect to an OpenSandbox service your team already operates.

## 1. Install murm

On Linux, you need [Node.js 22.19 or later with npm](https://nodejs.org/en/download) and Git. Check `node --version` before installing. Some distribution repositories, including Ubuntu 24.04 and Debian 13, ship an older Node.js by default. Use a current LTS from the Node.js download page on those systems.

For a local OpenSandbox, also install [Docker Engine](https://docs.docker.com/engine/install/) if it is missing. On Ubuntu or Debian, the distribution packages for Docker, Git, and curl can be installed together:

```bash
sudo apt-get update
sudo apt-get install -y docker.io git curl ca-certificates
sudo systemctl enable --now docker.service
```

For local OpenSandbox, run `docker info` as the user who will run murm. If access to the system socket is denied, have the host administrator grant access and sign in again after a group change. The [Docker group grants root-equivalent access](https://docs.docker.com/engine/install/linux-postinstall/). If Docker is already installed or you are using a shared OpenSandbox service, Ubuntu and Debian users can install just the client tools with `sudo apt-get update && sudo apt-get install -y git curl ca-certificates`.

```bash
curl -fsSL https://luna-shi.github.io/murm/install.sh | sh
```

The installer uses your npm global prefix if writable, or `$HOME/.local` otherwise. If it prints a `PATH` command, run it in your current shell before calling `murm`. For a direct npm install into your home directory:

```bash
npm install -g --prefix "$HOME/.local" --ignore-scripts --allow-remote=root \
  https://github.com/LuNa-shi/murm/releases/latest/download/luna-shi-murm.tgz
export PATH="$HOME/.local/bin:$PATH"
```

The public installer downloads the latest GitHub Release. **v0.2.0** additionally requires a local rootful engine, Landlock ABI 5+, host tools, and non-interactive sudo rules. Follow the [v0.2.0 host setup guide](https://github.com/LuNa-shi/murm/blob/v0.2.0/docs/en/quickstart.md#1-prerequisites-execution-host) before Step 2 when using that release. Ubuntu 24.04's default 6.8 kernel did not meet its Landlock requirement in testing. The current source's default OpenSandbox API mode uses the requirements above.

<details>
<summary>Install an unreleased candidate from a murm checkout</summary>

Run these commands at the root of the checkout:

```bash
npm ci --no-audit --no-fund
pack_dir=$(mktemp -d)
npm pack --pack-destination "$pack_dir"
npm install -g --prefix "$HOME/.local" --ignore-scripts "$pack_dir"/*.tgz
export PATH="$HOME/.local/bin:$PATH"
```

</details>

## 2. Verify OpenSandbox

```bash
murm setup
```

With the current source's defaults, this starts a managed OpenSandbox on `127.0.0.1:8080`, prepares the selected Worker, then starts a real temporary sandbox, checks the Bridge, Model Gateway, and file export, and confirms deletion. Wait for `"infrastructure": "ready"` and `"ok": true` in the setup report. This probe uses a local test response and needs no model API key. Initial setup downloads images and can take several minutes. Repeat the same command after correcting a failure.

<details>
<summary>Connect to an existing OpenSandbox service</summary>

Use a CLI built from the current source or a release that supports `murm setup --mode existing`. Configure the endpoint and supply the operator's Lifecycle API key through `MURM_LIFECYCLE_TOKEN` in your shell. The controller needs access to the Lifecycle and Worker endpoints. Workers need access to the controller's Bridge and Model Gateway. Ask the service operator to make a compatible Worker image available if the engine cannot pull it.

```bash
export MURM_LIFECYCLE_URL='https://sandbox.example.net/v1'
export MURM_ADVERTISE_HOST='controller.internal.example.net'
murm setup --mode existing
```

See [Sandboxes](sandbox.md) and [Host Gateway](gateway.md) for proxy routing and HTTPS callbacks.

</details>

<details>
<summary>Recover from an image pull failure</summary>

- **OpenSandbox server or Execd.** The local setup in the current source reports the failing image and its exact digest. Retry the displayed `docker pull` command in the same Docker context. If access is restricted, configure the [Docker daemon proxy](https://docs.docker.com/engine/daemon/proxy/) or ask your administrator to make those pinned references available. You can also use an existing OpenSandbox service. The murm Worker Dockerfile does not supply the OpenSandbox server or Execd.
- **murm Worker.** Local setup uses a compatible cached image first, then tries the selected release tag. If the default pull fails, it builds the selected executor from the installed package's `deploy/worker/Dockerfile`. The build still needs a Node base image, Debian packages and npm dependencies. Check those sources and retry setup, or run the build command printed in the failure report from the installed package directory or matching checkout. The Dockerfile accepts `--build-arg NODE_IMAGE=<trusted-mirror-reference>` for the same Node base image in a mirror.
- **Transfer a Worker from another machine.** On a machine with access to the registries, pull or build a compatible Worker for the target Docker Engine's CPU architecture and run `docker save -o worker.tar IMAGE`. Copy the archive and run `docker load -i worker.tar` in the target Docker context. If the imported tag differs from the selected default, export `MURM_WORKER_IMAGE=IMAGE` before setup and keep it set for the example. With an existing service, the Worker must be available on that service's engine.

To skip the GHCR pull and build the default Pi Worker yourself from a package built from the current source:

```bash
(
  cd "$(dirname "$(readlink -f "$(command -v murm)")")/../.." &&
    docker build -f deploy/worker/Dockerfile -t murm-worker:local --build-arg WORKER_EXECUTOR=pi .
) &&
  export MURM_WORKER_IMAGE=murm-worker:local &&
  murm setup
```

</details>

For a quick Lifecycle check later, run `murm doctor`. Use `murm doctor --smoke` to repeat the full infrastructure probe.

## 3. Run your first example

For the example you need a model endpoint and an API key that can use the selected model. The example uses OpenAI Responses. Set your key as `MURM_MODEL_TOKEN` in your shell, then run:

```bash
export MURM_MODEL_URL='https://api.openai.com/v1/responses'
export MURM_MODEL_ID='gpt-5-mini'

mkdir -p murm-first-example
cd murm-first-example
printf '# Hello from murm\n' > README.md
murm --harness subagents --prompt 'Read README.md and report its heading.' --output-dir ./runs
```

Look for the result in the terminal, then open the run in Trace Viewer:

```bash
murm trace --root ./runs --port 8787 --open
```

Over SSH, the Viewer prints a port-forwarding command to run on your laptop. If you connected using an SSH alias, mapped port, or jump host, use the same connection settings in that command.

For a different provider, set `MURM_MODEL_URL` to its streaming Responses URL and choose a model your key can access. The [CLI Reference](reference/cli.md) covers configuration and executor selection.

## Next steps

- [Choose a Harness](harnesses/index.md) to try another coordination pattern.
- [Build a Swarm Harness](build-your-harness.md) using the [TypeScript SDK](reference/api.md).

---
title: Quickstart
description: Install @luna-shi/murm on Linux, start or connect to OpenSandbox, and run your first multi-agent Harness in minutes.
section: GET STARTED
order: 1
---

`@luna-shi/murm` bundles the CLI, TypeScript SDK, and built-in Trace Viewer in one package. Every Agent runs inside an isolated container powered by the open-source **OpenSandbox** runtime.

**Prerequisites**: a Linux machine with **Node.js 22.19+** and **Docker** for the default one-command local setup (if your team already runs a shared OpenSandbox service, the Controller only needs Node.js).

## 1. Install `murm`

Install the published CLI globally from the latest [GitHub Release](https://github.com/LuNa-shi/murm/releases):

```bash
curl -fsSL https://luna-shi.github.io/murm/install.sh | sh
```

Or install directly with npm:

```bash
npm install -g --ignore-scripts --allow-remote=root \
  https://github.com/LuNa-shi/murm/releases/latest/download/luna-shi-murm.tgz
```

<details>
<summary>Testing unreleased changes from a source checkout? Expand to build and install a local tarball</summary>

### Install a candidate from a checkout

```bash
npm ci --no-audit --no-fund
pack_dir=$(mktemp -d)
npm pack --pack-destination "$pack_dir"
npm install -g --prefix "$HOME/.local" --ignore-scripts "$pack_dir"/*.tgz
export PATH="$HOME/.local/bin:$PATH"
```

</details>

## 2. Initialize OpenSandbox

By default, set up a managed local OpenSandbox service and Worker image on your machine with one command:

```bash
murm setup --mode local
```

This checks your Docker environment, starts a managed OpenSandbox server on `127.0.0.1:8080`, generates an owner-only Lifecycle key when needed, and prepares the Worker image. If Docker is missing, setup prints distribution-specific install instructions.

### Verify readiness

```bash
# Fast config & Lifecycle auth check
murm doctor

# Live end-to-end smoke test (boots a real Worker and checks Bridge, gateway, files, and cleanup)
murm doctor --smoke
```

<details>
<summary>Connect to an existing remote OpenSandbox service (optional)</summary>

If your team already runs a shared OpenSandbox service, point the Controller at it (ensure the Controller can reach the Lifecycle/Worker endpoints and Workers can reach your Controller's Bridge and Model Gateway):

```bash
export MURM_LIFECYCLE_URL='https://sandbox.example.net/v1'
export MURM_ADVERTISE_HOST='controller.internal.example.net'
# Set MURM_LIFECYCLE_TOKEN from your service operator in your trusted environment
murm setup --mode existing
```

> Need proxy routing (`sandbox.endpointHost` / `sandbox.useServerProxy`) or HTTPS callback templates? See [Sandboxes](sandbox.md) and [Host Gateway](gateway.md).

</details>

<details>
<summary>Enable strict local isolation (optional: tmpfs quotas, live shared mounts, UID firewall allowlists)</summary>

The default OpenSandbox API policy provides container isolation, authenticated management, and verified CPU/memory limits.

When your deployment requires **measured `tmpfs` disk quotas, live shared mounts, or local UID egress allowlists**, opt in to `local-docker` via `createSandbox()` (requires same-host rootful Docker, Linux namespaces, and Landlock ABI 5+; see [Sandboxes](sandbox.md)):

```ts
isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } }
```

</details>

## 3. Configure your model and run your first Harness

Point `murm` at any streaming **OpenAI Responses-compatible endpoint (`/v1/responses`)** (credentials stay on the host Model Gateway; Pi also supports **Chat Completions** via project configuration):

```bash
export MURM_MODEL_URL='https://api.openai.com/v1/responses'
export MURM_MODEL_TOKEN='sk-...'

# Optional: defaults to Pi (provider: openai, model: gpt-5.4). Override anytime:
# export MURM_MODEL_PROVIDER='openai'
# export MURM_MODEL_ID='gpt-4.1'
# export MURM_EXECUTOR='codex'
```

Run the built-in `Subagents` Harness against any project directory:

```bash
cd my-project
murm --harness subagents --prompt "Inspect the tests and explain or fix any failures"
```

> You can also run bare `murm` to start an interactive session in the current directory, or scaffold an editable starter project with `murm init --template subagents --dir ./my-harness`.

Inspect the run timeline, Service handoffs, and exported files in the built-in **Trace Viewer**:

```bash
murm trace --root ./runs --port 8787 --open
```

When started inside an SSH session on a remote Linux host, `murm trace` prints the exact `ssh -N -L` forwarding command to paste on your laptop.

## 4. Using the TypeScript SDK in your own project

Install `@luna-shi/murm` in any Node.js 22.19+ project (Node 22.19+ executes `.ts` files natively):

```bash
mkdir my-swarm && cd my-swarm
npm init -y && npm pkg set type=module
npm install --ignore-scripts --allow-remote=root \
  https://github.com/LuNa-shi/murm/releases/download/v0.2.0/luna-shi-murm-0.2.0.tgz
```

> Testing from a source checkout? Install the local `.tgz` packed in Step 1 instead. For a minimal two-Agent handoff script, see [`examples/bridge-services/handoff.ts`](https://github.com/LuNa-shi/murm/blob/main/examples/bridge-services/handoff.ts).

## Next steps

- **[Core Concepts](concepts.md)** — understand how the 6 building blocks fit together in 2 minutes.
- **[Build a Swarm Harness](build-your-harness.md)** — build a 3-researcher parallel Research Swarm step by step.
- **[Choose a Harness](harnesses/index.md)** — compare `Subagents`, `TaskPool`, `PeerMesh`, `Substrate`, and `Lead-Worker`.
- **[CLI Reference](reference/cli.md)** · **[SDK & API Reference](reference/api.md)** — full flags, executor selection, model protocols, and `filePolicy` budgets.

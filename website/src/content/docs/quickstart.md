---
title: Quick Start
description: Prepare the local sandbox environment, launch your first multi-agent harness, and inspect the recorded run directory.
section: GETTING STARTED
order: 1
---

## What you need before starting

In `murm`, every **Agent** runs inside an isolated Docker container (**Sandbox**) so concurrent edits and shell commands never interfere with each other or the host machine. Before running a harness, prepare two things:

1. **Sandbox runtime**: A local OpenSandbox instance (Docker provider) and a single **standard sandbox image** bundling `Pi 1.3.0`, the `swarm` CLI, and the lightweight Worker supervisor. Build it once; every Harness reuses the same image.
2. **Model endpoint**: Any `/v1/responses`-compatible model endpoint (built-in example configs use `kimi_proxy/k3`). API keys stay strictly on the host and never enter a container.

## 1. Clone and build

Make sure **Node.js `>= 22.19.0`** and Docker are installed, then build the repository:

```bash
git clone https://github.com/LuNa-shi/SwarmEnv.git
cd SwarmEnv
npm ci
npm run build
```

Build the standard sandbox image once:

```bash
docker build -f services/opensandbox-agent/Dockerfile -t murm-worker:local .
```

Start a local OpenSandbox daemon with the repository’s project-limit support (default endpoint `http://127.0.0.1:8080/v1`). Follow the [OpenSandbox host setup](https://github.com/LuNa-shi/SwarmEnv/blob/f98eb71d0eac61ac99a1b98a9d04ef353f781fec/docs/architecture/16-pi-opensandbox-backend.md).

## 2. Run your first multi-agent harness: interactive Subagents

Start with **[Subagents](../harnesses/subagents/)**. You give a high-level goal to `/root`, and `/root` breaks the task down, spawns named child agents in parallel, exchanges messages, and integrates the results.

```bash
worker_image=$(docker image inspect murm-worker:local --format '{{.Id}}')
export MURM_SUBAGENTS_IMAGE="$worker_image"
export MURM_SUBAGENTS_MODEL_URL='https://your-model-endpoint/v1/responses'
export MURM_SUBAGENTS_MODEL_TOKEN='your-bearer-token'

# One-shot task
node dist/examples/subagents/main.js \
  dist/examples/subagents/config.js \
  'Inspect this workspace, split into two independent research subtasks, and synthesize a concrete plan.'

# Interactive session (add follow-ups anytime, /status to inspect team, /exit to close)
node dist/examples/subagents/main.js \
  dist/examples/subagents/config.js --interactive
```

If containers reach your host bridge at an IPv4 address other than `172.17.0.1`, set `MURM_SUBAGENTS_ADVERTISE_HOST` to that address.

## 3. Inspect the recorded Run directory

When a run completes, the Runtime persists a private archive under `./subagents-runs/<runtimeId>/`:

- `runtime.json` — effective configuration, stop receipts, and cleanup verification;
- `evidence.jsonl` — ordered lifecycle, input delivery, and event timeline;
- `service-calls.jsonl` — every validated Service call with caller identity, inputs, outputs, and latency;
- `model-trace/<attemptId>/` — raw model requests, streaming responses, and outcomes;
- `<agentId>/session/` — full native Pi session JSONL archives;
- `<agentId>/artifacts/files/` — exported files declared by `collect`.

Core redacts registered credentials in traces. Run records can still contain prompt, project, and Session data. Keep the archive private.

## 4. Minimal custom-Service example: Notes

If you want the smallest possible reference before authoring your own Harness (2 agents, 1 in-process Service, zero external servers), run **Notes**:

```bash
export MURM_NOTES_IMAGE="$worker_image"
export MURM_NOTES_MODEL_URL='https://your-model-endpoint/v1/responses'
export MURM_NOTES_MODEL_TOKEN='your-bearer-token'

node dist/examples/notes/main.js \
  dist/examples/notes/config.js > notes-result.json
```

`writer` publishes a finding through the `notes` Service, `reader` fetches and verifies it across two turns in the same persistent session, and the host exports and checks the resulting file. See [examples/notes/main.ts](https://github.com/LuNa-shi/SwarmEnv/blob/f98eb71d0eac61ac99a1b98a9d04ef353f781fec/examples/notes/main.ts).

## 5. Use `@murm/core` in your own project

To import the runtime package outside this repository:

```bash
repo=/absolute/path/to/SwarmEnv
mkdir my-murm-harness && cd my-murm-harness
npm pack "$repo" --pack-destination .
npm init -y && npm pkg set type=module
npm install --omit=dev --ignore-scripts ./murm-core-0.2.0.tgz
```

Three public entrypoints are available: `@murm/core`, `@murm/core/services`, and `@murm/core/backends/pi-opensandbox`.

## Where to go next

| Goal | Read next |
| --- | --- |
| Build a crisp mental model of the six core abstractions | [Core Concepts](../concepts/) |
| Trace how the host, containers, Bridge, and Model Gateway connect | [System Architecture](../architecture/) |
| Compare five built-in multi-agent harnesses | [Five Topologies Overview](../harnesses/) |
| Build your own Service and Harness from scratch | [Build Your Own Harness](../build-your-harness/) |

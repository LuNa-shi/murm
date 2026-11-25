---
title: Quick Start
description: Prepare the local sandbox environment, launch your first multi-agent collaboration session, and inspect the recorded run directory.
section: GETTING STARTED
order: 1
---

## What you need before starting

In `murm`, every **Agent** runs inside an isolated Docker container (**Sandbox**) so concurrent edits and shell commands never interfere with each other or the host machine. Before running an example, prepare two things:

1. **Sandbox runtime**: A local OpenSandbox instance (Docker provider) and a single **standard sandbox image** bundling `Pi 1.3.0`, the `swarm` CLI, and the lightweight Worker supervisor. Build it once; every Program reuses the same image.
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

Start your local OpenSandbox daemon (default endpoint `http://127.0.0.1:8080/v1`).

## 2. Run your first multi-agent session: interactive Subagents

Start with **[Subagents](../programs/subagents/)**. You give a high-level goal to `/root`, and `/root` breaks the task down, spawns named child agents in parallel, exchanges messages, and integrates the results.

```bash
export SWARMENV_SUBAGENTS_IMAGE='murm-worker:local'
export SWARMENV_SUBAGENTS_MODEL_URL='https://your-model-endpoint/v1/responses'
export SWARMENV_SUBAGENTS_MODEL_TOKEN='your-bearer-token'

# One-shot task
node dist/examples/subagents-environment/main.js \
  dist/examples/subagents-environment/config.js \
  'Inspect this workspace, split into two independent research subtasks, and synthesize a concrete plan.'

# Interactive session (add follow-ups anytime, /status to inspect team, /exit to close)
node dist/examples/subagents-environment/main.js \
  dist/examples/subagents-environment/config.js --interactive
```

If containers reach your host bridge at an IPv4 address other than `172.17.0.1`, set `SWARMENV_SUBAGENTS_ADVERTISE_HOST` to that address.

## 3. Inspect the recorded Run directory

When a run completes, the Runtime persists a redacted, structured archive under `./subagents-runs/<runId>/`:

- `runtime.json` — effective configuration, stop receipts, and cleanup verification;
- `evidence.jsonl` — ordered lifecycle, input delivery, and event timeline;
- `service-calls.jsonl` — every validated Service call with caller identity, inputs, outputs, and latency;
- `model-trace/<attemptId>/` — raw model requests, streaming responses, and outcomes;
- `bots/<agentId>/session/` — full native Pi session JSONL archives;
- `bots/<agentId>/artifacts/files/` — exported files declared by `collect`.

## 4. Minimal custom-Service example: Notes

If you want the smallest possible reference before authoring your own Program (2 agents, 1 in-process Service, zero external servers), run **Notes**:

```bash
export SWARMENV_NOTES_IMAGE='murm-worker:local'
export SWARMENV_NOTES_MODEL_URL='https://your-model-endpoint/v1/responses'
export SWARMENV_NOTES_MODEL_TOKEN='your-bearer-token'

node dist/examples/notes-environment/main.js \
  dist/examples/notes-environment/config.js > notes-result.json
```

`writer` publishes a finding through the `notes` Service, `reader` fetches and verifies it across two turns in the same persistent session, and the host exports and checks the resulting file. See [examples/notes-environment/main.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/examples/notes-environment/main.ts).

## 5. Use `@swarmenv/core` in your own project

To import the runtime package outside this repository:

```bash
repo=/absolute/path/to/SwarmEnv
mkdir my-murm-program && cd my-murm-program
npm pack "$repo" --pack-destination .
npm init -y && npm pkg set type=module
npm install --omit=dev --ignore-scripts ./swarmenv-core-0.2.0.tgz
```

Three public entrypoints are available: `@swarmenv/core`, `@swarmenv/core/services`, and `@swarmenv/core/backends/pi-opensandbox`.

## Where to go next

| Goal | Read next |
| --- | --- |
| Build a crisp mental model of the six core abstractions | [Core Concepts](../concepts/) |
| Trace how the host, containers, Bridge, and Model Gateway connect | [System Architecture](../architecture/) |
| Compare five built-in multi-agent topologies | [Five Topologies Overview](../programs/) |
| Build your own Service and Program from scratch | [Build Your Own Program](../build-your-program/) |

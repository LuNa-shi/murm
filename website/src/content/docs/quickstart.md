---
title: Quickstart
description: Prepare the local sandbox environment, run your first multi-agent harness, inspect its recorded archive, and install @murm/core in a standalone project.
section: GET STARTED
order: 1
---

In `murm`, every agent runs inside an isolated Docker container (**Sandbox**) supervised by a lightweight Worker process, while your **Harness** runs on the host in Node.js.

Before running a harness, make sure you have:

- **Node.js `>= 22.19.0`** and **Docker** installed locally.
- **Local OpenSandbox** (Docker provider) running with Core project-limit support (default lifecycle endpoint: `http://127.0.0.1:8080/v1`). See [OpenSandbox backend details](https://github.com/LuNa-shi/SwarmEnv/blob/main/docs/architecture/16-pi-opensandbox-backend.md).
- **A `/v1/responses`-compatible model endpoint** (the shipped examples target `kimi_proxy/k3`; upstream credentials remain on the host and never enter a container).

## 1. Clone, build, and prepare the worker image

Clone the repository and compile TypeScript sources into `dist/`:

```bash
git clone https://github.com/LuNa-shi/SwarmEnv.git
cd SwarmEnv
npm ci
npm run build
```

Build the standard worker image once. It bundles **Pi `1.3.0`**, the `swarm` CLI, and the container Worker supervisor. Every built-in and custom Harness reuses this image:

```bash
docker build -f services/opensandbox-agent/Dockerfile -t murm-worker:local .
worker_image=$(docker image inspect murm-worker:local --format '{{.Id}}')
```

> Using the immutable image ID (`sha256:...`) from `docker image inspect` ensures every spawned agent resolves the exact same container image and records its digest in `runtime.json`.

## 2. Run your first Harness: Notes

Start with **[Notes](https://github.com/LuNa-shi/SwarmEnv/tree/main/examples/notes)** — the smallest end-to-end multi-agent harness (two agents, one custom in-process `notes` Service, zero external databases or chat servers).

`writer` publishes a seeded source fact via `swarm notes put`, `reader` fetches it via `swarm notes get` and writes `review.md`, then copies `review.md` to `followup.md` in a second turn on the same persistent session. The host verifies the Service records and checks both archived files after stopping `reader`.

```bash
export MURM_NOTES_IMAGE="$worker_image"
export MURM_NOTES_MODEL_URL='https://your-model-endpoint/v1/responses'
export MURM_NOTES_MODEL_TOKEN='your-bearer-token'

node dist/examples/notes/main.js dist/examples/notes/config.js > notes-result.json
```

If containers reach your host bridge on an IPv4 address other than `172.17.0.1`, also export `MURM_NOTES_ADVERTISE_HOST=<host-ipv4>`. Optional lifecycle settings use `MURM_NOTES_LIFECYCLE_URL`, `MURM_NOTES_ENDPOINT_HOST`, and `MURM_NOTES_LIFECYCLE_TOKEN`.

## 3. Inspect the saved Run and receipts

The CLI prints a JSON summary containing `runtimeId` and `reportPath`. Read both the Harness report and Core Runtime summary without loading model credentials:

```bash
runtime_id=$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync("notes-result.json","utf8")).runtimeId)')
run_dir=$(node -e 'const fs=require("node:fs"),p=require("node:path"); console.log(p.dirname(JSON.parse(fs.readFileSync("notes-result.json","utf8")).reportPath))')

node dist/examples/notes/main.js --result "$run_dir" --runtime-id "$runtime_id"
```

With the default config, each run creates a private (`0700`) directory under `./notes-runs/<runtimeId>/`:

```text
notes-runs/<runtimeId>/
├── runtime.json                 # Effective config, stop receipts, cleanup status
├── harness-report.json          # Business outcome, Notes state, verifiedFiles
├── evidence.jsonl               # Ordered lifecycle, input, and event timeline
├── service-calls.jsonl          # Every validated Service call and result
├── model-trace/<attemptId>/     # Request JSON, raw stream response, result metadata
└── <agentId>/
    ├── session/                 # Native Pi JSONL conversation archive
    └── artifacts/files/         # Exported review.md and followup.md
```

## 4. Try an interactive multi-agent team: Subagents

Once Notes succeeds, launch **[Subagents](../harnesses/subagents/)** to see recursive delegation, context forking, and live mailbox messaging in action. Give `/root` a task; it decomposes the work, spawns named children in parallel, exchanges messages, and integrates results.

```bash
export MURM_SUBAGENTS_IMAGE="$worker_image"
export MURM_SUBAGENTS_MODEL_URL='https://your-model-endpoint/v1/responses'
export MURM_SUBAGENTS_MODEL_TOKEN='your-bearer-token'

# One-shot task
node dist/examples/subagents/main.js \
  dist/examples/subagents/config.js \
  'Inspect this workspace, split into two independent subtasks, and synthesize a concrete plan.'

# Interactive session (send follow-ups anytime, /status to inspect team, /exit to close)
node dist/examples/subagents/main.js \
  dist/examples/subagents/config.js --interactive
```

Default limits are 4 live agents (`MURM_SUBAGENTS_MAX_AGENTS`) and depth 3 (`MURM_SUBAGENTS_MAX_DEPTH`).

## 5. Install `@murm/core` in your own project

To build a Harness outside the `SwarmEnv` checkout, pack the distributable tarball and install it in an independent directory:

```bash
repo=/absolute/path/to/SwarmEnv
mkdir my-harness && cd my-harness
npm pack "$repo" --pack-destination .
npm init -y
npm pkg set type=module
npm install --omit=dev --ignore-scripts ./murm-core-0.2.0.tgz
```

Your project can now import the three public entry points:

```ts
import { createRuntime } from '@murm/core';
import { ServiceRegistry, createInProcessAdapter, createHttpJsonAdapter } from '@murm/core/services';
import { createPiOpenSandboxBackend } from '@murm/core/backends/pi-opensandbox';
```

## Next steps

| Goal | Read next |
| --- | --- |
| Understand the Harness, Runtime, Sandbox, Service, and Trace mental model | [How murm Works](../concepts/) |
| Inspect host/container trust boundaries, Bridge validation, and Model Gateway | [System Architecture](../architecture/) |
| Walk through `spawn`, unified `send`, file handoffs, `interrupt`, and `close` | [Anatomy of a Run](../run-lifecycle/) |
| Write your own shared Service and host control loop from scratch | [Build Your Own Harness](../build-your-harness/) |
| Compare all five built-in topologies | [Five Topologies Overview](../harnesses/) |

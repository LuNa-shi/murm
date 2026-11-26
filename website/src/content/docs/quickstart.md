---
title: Quickstart
description: Run the Subagents example from a source checkout.
section: GET STARTED
order: 1
---

## 1. Clone and build

Use Node.js 22.19 or newer and npm on the same Linux host as rootful Docker Engine. The example needs a local OpenSandbox provider and a compatible Worker image. [Host requirements](https://github.com/LuNa-shi/murm/blob/main/docs/architecture/07-run-configuration.md#host-checks-and-checkout-preparation)

```bash
git clone https://github.com/LuNa-shi/murm.git
cd murm
npm ci
npm run build
```

If the host still needs OpenSandbox or the Worker, run `./scripts/setup` from the checkout root in place of the install and build commands. It builds the checkout, prepares the infrastructure, and verifies a real Sandbox with a local model endpoint. Use `worker.id` from the setup output for the image below.

## 2. Configure the example

Create `examples/subagents/.env` with your Worker image ID and a streaming `/v1/responses` endpoint that accepts `k3` and supports tool calls. Fill in the token if your endpoint requires bearer authentication.

```bash
MURM_SUBAGENTS_IMAGE="sha256:<your-worker-image-id>"
MURM_SUBAGENTS_MODEL_URL="https://your-gateway.example/v1/responses"
MURM_SUBAGENTS_MODEL_TOKEN=""
```

The example defaults to a local OpenSandbox lifecycle URL of `http://127.0.0.1:8080/v1`. The example README lists the overrides for a different port or lifecycle token. [Subagents configuration](https://github.com/LuNa-shi/murm/blob/main/examples/subagents/README.md#run-from-the-checkout)

## 3. Run a task

```bash
cd examples/subagents
node --env-file=.env ../../dist/examples/subagents/main.js \
  ../../dist/examples/subagents/config.js \
  'Suggest two checks to make before merging a pull request.'
```

The example waits for Root's reply, closes the team, and reports the path to `subagents-runs/<runtimeId>/harness-report.json`. The report contains the result and Sandbox cleanup receipts. Edit `main.ts` or `config.ts` here, then rebuild from the checkout root to try your changes.

Keep the Run directory private. It can contain model requests, Service calls, and archived Sessions.

## 4. Try a custom Service or install Core in another project

The [Notes example](https://github.com/LuNa-shi/murm/tree/main/examples/notes) shows how two Agents use a custom Service to hand off a fact and verify the files saved by the reader. Its README walks through running the example from a packaged Core install and inspecting a saved Run offline.

To install the same package in your own project, set `repo` to your absolute checkout path:

```bash
repo=/absolute/path/to/murm
mkdir my-harness
cd my-harness
npm pack "$repo" --pack-destination .
npm init -y
npm pkg set type=module
npm install --omit=dev --ignore-scripts ./murm-core-0.2.0.tgz
```

```ts
import { createRuntime } from '@murm/core';
import { ServiceRegistry } from '@murm/core/services';
import { createOpenSandboxBackend } from '@murm/core/backends/opensandbox';
```

## Where to go next

| Goal | Read next |
| --- | --- |
| Understand what a Harness composes | [Core Concepts](../concepts/) |
| Trace the Host, Worker, Bridge and Model Gateway | [System Architecture](../architecture/) |
| Read the lifecycle from spawn to teardown | [Anatomy of a Run](../run-lifecycle/) |
| Compare Agent coordination patterns | [Five Topologies](../harnesses/) |
| Implement a custom Service and Harness | [Build Your Own Harness](../build-your-harness/) |

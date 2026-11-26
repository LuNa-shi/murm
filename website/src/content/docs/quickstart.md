---
title: Quick Start
description: Run the Subagents example from a source checkout.
section: GETTING STARTED
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

## Where to go next

| Goal | Read next |
| --- | --- |
| Understand what a Harness composes | [Core Concepts](../concepts/) |
| Trace the Host, Worker, Bridge and Model Gateway | [System Architecture](../architecture/) |
| Compare Agent coordination patterns | [Five Topologies](../harnesses/) |
| Implement a custom Service and Harness | [Build Your Own Harness](../build-your-harness/) |

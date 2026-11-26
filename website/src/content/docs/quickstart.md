---
title: Quick Start
description: Prepare a local Sandbox and install an editable Subagents project with one command.
section: GETTING STARTED
order: 1
---

## 1. Prepare a local Subagents project

Use Node.js 22.19 or newer and npm on the same Linux host as rootful Docker Engine. The host needs Landlock ABI 5 or newer and noninteractive permission for the namespace, nftables and workspace mount operations. The setup command checks these capabilities before packaging or building. [Host requirements and diagnosis](https://github.com/LuNa-shi/murm/blob/main/docs/architecture/07-run-configuration.md#local-setup-and-doctor)

```bash
git clone https://github.com/LuNa-shi/murm.git
cd murm
./scripts/setup --template subagents --dir ../my-murm
cd ../my-murm
```

Setup installs locked dependencies, reuses a compatible Worker image or builds one, and reuses or starts the local OpenSandbox service. It verifies a real Sandbox, an Agent Service call, a controlled local Responses round trip, file write and read, artifact export and Sandbox deletion. The first run may need to download images and dependencies. Later runs reuse compatible infrastructure and preserve edits to the generated files.

The project contains editable `main.js`, `config.js` and `.env` files and its own installed Core package. If you already installed the candidate and have `murm` on your path, run `murm setup --template subagents --dir ./my-murm`.

## 2. Configure a model and run Subagents

In the generated `.env`, set `MURM_SUBAGENTS_MODEL_URL` to a streaming `/v1/responses` endpoint that accepts `k3` and supports tool calls. Set `MURM_SUBAGENTS_MODEL_TOKEN` if the endpoint requires a bearer token. The token stays on the host.

```bash
npm run doctor
npm start
```

Enter a task for Root. Root can start child Agents, assign work, and combine their results. Use `/status` to inspect the team or `/exit` to close the Run. To run a single task, pass it after the config path.

```bash
node main.js config.js 'Split this task into two independent subtasks and combine the results.'
```

Doctor checks the configured host, image and OpenSandbox profile. Run `npm run doctor -- --smoke` to repeat the temporary end-to-end infrastructure probe. The output reports infrastructure, model configuration and real-model verification separately. Setup and doctor use the local controlled endpoint for their probe. [Subagents configuration and controls](https://github.com/LuNa-shi/murm/blob/main/examples/subagents/README.md)

## 3. Inspect the Run

The generated project writes private records under `subagents-runs/<runtimeId>/`.

- `harness-report.json` records the task result and cleanup receipts.
- `runtime.json` and `evidence.jsonl` record Runtime state and ordered events.
- `service-calls.jsonl` and `model-trace/` record Service calls and model requests.
- Agent directories contain archived Sessions and any files requested for export.

Run records can include prompts, project contents and Session data. Keep the directory private.

## Where to go next

| Goal | Read next |
| --- | --- |
| Understand what a Harness composes | [Core Concepts](../concepts/) |
| Trace the Host, Worker, Bridge and Model Gateway | [System Architecture](../architecture/) |
| Compare Agent coordination patterns | [Five Topologies](../harnesses/) |
| Implement a custom Service and Harness | [Build Your Own Harness](../build-your-harness/) |

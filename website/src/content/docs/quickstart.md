---
title: Quick Start
description: Prepare the host, initialize an editable Subagents project, and open an interactive session.
section: GETTING STARTED
order: 1
---

## 1. Prepare the host

Use Node.js 22.19 or newer and npm on the same Linux host as rootful Docker Engine. The host needs Landlock ABI 5 or newer and noninteractive permission for the namespace, nftables and workspace mount operations. The setup command checks these capabilities before packaging or building. [Host requirements and diagnosis](https://github.com/LuNa-shi/murm/blob/main/docs/architecture/07-run-configuration.md#local-setup-and-doctor)

```bash
git clone https://github.com/LuNa-shi/murm.git
cd murm
./scripts/setup
```

Setup installs locked checkout dependencies, reuses a compatible Worker image or builds one, and reuses or starts the local OpenSandbox service. It verifies a real Sandbox, an Agent Service call, a controlled local Responses round trip, file write and read, artifact export and Sandbox deletion. The first run may need to download images and dependencies. If you already have the installed binary on your PATH, run `murm setup`. Use `murm doctor` to recheck the host.

## 2. Initialize a project

```bash
node dist/scripts/murm.js init --template subagents --dir ../my-murm
cd ../my-murm
```

With `murm` on your PATH, use `murm init --template subagents --dir ./my-murm`. The `--dir` argument selects where to create the project. Each project has editable `main.js`, `config.js` and `.env` files and its own installed Core package. Repeating init preserves project edits.

## 3. Configure a model and open the session

In the generated `.env`, set `MURM_SUBAGENTS_MODEL_URL` to a streaming `/v1/responses` endpoint that accepts `k3` and supports tool calls. Set `MURM_SUBAGENTS_MODEL_TOKEN` if the endpoint requires a bearer token. The token stays on the host.

```bash
murm
```

If you used the checkout commands, `npm start` resolves the installed project-local binary. Enter a task for Root. Root can start child Agents, assign work, and combine their results. Use `/status` to inspect the team or `/exit` to close the Run. To run a single task, pass it after the config path.

```bash
node main.js config.js 'Split this task into two independent subtasks and combine the results.'
```

Run `npm run doctor` from the project to check its configuration. Add `-- --smoke` to repeat the temporary end-to-end infrastructure probe. Project diagnosis reports infrastructure, model configuration and real-model verification separately. The probe uses the local controlled endpoint. [Subagents configuration and controls](https://github.com/LuNa-shi/murm/blob/main/examples/subagents/README.md)

## 4. Inspect the Run

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

---
title: Quickstart
description: Run a complete two-Agent Service handoff using the public TypeScript SDK.
section: GET STARTED
order: 1
---

This guide runs the [Messages handoff](https://github.com/LuNa-shi/murm/tree/main/examples/bridge-services). The host seeds a value into one Agent's workspace. That Agent publishes it through a Service; a second Agent retrieves it and writes `received.txt`. The host checks the exported file and saves a report.

## 1. Prepare the checkout and execution host

Use Node.js **22.19 or newer**, npm, and a Linux host with rootful Docker Engine. The current backend also needs an OpenSandbox Lifecycle API on that host and a compatible murm Worker image containing `jq`.

```bash
git clone https://github.com/LuNa-shi/murm.git
cd murm
npm ci
npm run build
```

If you still need to prepare OpenSandbox and the Worker image, run `./scripts/setup` from the checkout root. The setup command builds the checkout, prepares the local infrastructure, and probes a real Sandbox using a local model endpoint. Use the resulting Worker image ID below. See the [host setup reference](https://github.com/LuNa-shi/murm/blob/main/docs/architecture/07-run-configuration.md#host-checks-and-checkout-preparation) for the host checks and configuration.

## 2. Configure the model and Worker

Set a Worker image name or ID and the full URL of an OpenAI Responses-compatible streaming endpoint. These variables are read by [`handoff-config.ts`](https://github.com/LuNa-shi/murm/blob/main/examples/bridge-services/handoff-config.ts).

```bash
export MURM_SDK_IMAGE='your-worker-image'
export MURM_SDK_MODEL_URL='https://your-gateway.example/v1/responses'
export MURM_SDK_MODEL_TOKEN='your-token-if-required'
```

The example defaults to Pi with provider `kimi_proxy` and model `k3`. Set `MURM_SDK_MODEL_PROVIDER` and `MURM_SDK_MODEL_ID` for a different model supported by your Worker. To use the Codex executor, also set `MURM_SDK_EXECUTOR=codex`; then `MURM_SDK_MODEL_ID` is required and the provider defaults to `openai`.

The local defaults are `http://127.0.0.1:8080/v1` for OpenSandbox and `172.17.0.1` for the host address visible from the Sandbox. Override them with `MURM_SDK_LIFECYCLE_URL` and `MURM_SDK_ADVERTISE_HOST` when needed. The [example README](https://github.com/LuNa-shi/murm/blob/main/examples/bridge-services/README.md#run-the-typescript-handoff) lists the lifecycle token, endpoint host, output directory, and external Messages Service options.

## 3. Run the handoff

From the checkout root:

```bash
node dist/examples/bridge-services/handoff.js
```

The program prints event kinds to stderr. Its final stdout line is a JSON record containing the handoff identity, original submission request IDs, and report. By default, the report is saved at:

```text
handoff-runs/<runtimeId>/handoff-report.json
```

The handoff uses only public package imports. Open [`handoff.ts`](https://github.com/LuNa-shi/murm/blob/main/examples/bridge-services/handoff.ts) to follow the complete sequence: create the Service and Runtime, begin observation, run each role, check Service operations and execution completion, and call `finalizeRun` with an exported-file check.

## 4. Inspect the result

A successful result has all of the following:

| Report field | Expected value | What it establishes |
| --- | --- | --- |
| `business.status` | `completed` | The expected Messages operations and Agent executions were observed |
| `artifactVerification.status` | `passed` | The reader's exported file matches the host's original value |
| `coreClose.status` | `complete` | Core confirmed its cleanup |
| `reportSaveFailure` | `null` | The finalization report was saved |

The example exits nonzero if any required condition fails. Keep uncertain send request IDs and pending cleanup identities when investigating a failed Run. Run archives also include private prompts, Service calls, and native sessions.

## 5. Use the same SDK in your own project

The current `@murm/core` package is installed from a checkout or tarball. From the checkout root, build a tarball:

```bash
npm pack --pack-destination /tmp
```

In a new directory outside the checkout, install it and copy the example sources:

```bash
mkdir my-harness
cd my-harness
npm init -y
npm pkg set type=module
npm install --save-exact /tmp/murm-core-0.2.0.tgz
npm install -D typescript @types/node
cp node_modules/@murm/core/examples/bridge-services/{handoff.ts,handoff-config.ts,messages.ts,tsconfig.handoff.json} .
npx tsc --project tsconfig.handoff.json
node build/handoff.js
```

Keep the model and infrastructure environment variables from step 2 in this shell. Package installation supplies the SDK and example source; the execution host still provides Docker, OpenSandbox, and the Worker image. `murm init` is optional for this TypeScript workflow.

## Continue from here

Read [Use the SDK](sdk.md) for the public interfaces and lifecycle. Then [Build Your Own Harness](build-your-harness.md) explains how to change the Service contract and collaboration policy. For recursive delegation, follow the [Subagents guide](harnesses/subagents.md) and its own configuration recipe. The [Harness comparison](harnesses/index.md) covers the other mechanisms.
